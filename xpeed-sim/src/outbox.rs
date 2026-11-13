//! Sending the laps in a folder, and remembering which ones went.
//!
//! The folder of laps *is* the queue: a lap is pending while it is there and `.xpeed-upload.json`, next to it,
//! does not list it as sent or refused. If the computer shuts down halfway, the next run goes on from there.
//! No lap file is ever deleted, moved or changed by sending.
//!
//! Track layouts have an outbox of their own, `tracks/` inside the laps folder (filled by `tracks::auto`). A layout
//! is known by its track, so its file is rewritten when the game's files change: `.xpeed-tracks.json`, in that folder,
//! keeps the track key and a hash of the bytes of each file sent or refused, and a file whose bytes differ from what
//! was recorded is pending again. The same rules as laps apply (HTTPS only, the same waits after a failure).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::config::Config;
use crate::lapfile;
use crate::net::{self, SendError, Sent, MAX_TRACK_UPLOAD_BYTES, MAX_UPLOAD_BYTES};
use crate::status::Cloud;
use crate::supervisor::{self, supervise, Health, Policy};
use crate::tracks::{self, auto};

const STATE_FILE: &str = ".xpeed-upload.json";
const TRACK_STATE_FILE: &str = ".xpeed-tracks.json";

/// What was already done with the laps of a folder, for one server.
#[derive(Debug, Default, PartialEq)]
pub struct State {
    server: String,
    sent: BTreeSet<String>,
    rejected: BTreeMap<String, String>,
}

impl State {
    /// A missing, damaged or other-server state starts empty: at worst a lap goes twice, and the server
    /// recognizes a lap it already has.
    pub fn load(dir: &Path, server: &str) -> State {
        let fresh = || State {
            server: server.to_owned(),
            ..State::default()
        };
        let Ok(text) = std::fs::read_to_string(dir.join(STATE_FILE)) else {
            return fresh();
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return fresh();
        };
        if value.get("server").and_then(Value::as_str) != Some(server) {
            return fresh();
        }
        let sent = value
            .get("sent")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let rejected = value
            .get("rejected")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(name, why)| Some((name.clone(), why.as_str()?.to_owned())))
            .collect();
        State {
            server: server.to_owned(),
            sent,
            rejected,
        }
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        let body = serde_json::to_string_pretty(&json!({
            "server": self.server,
            "sent": self.sent,
            "rejected": self.rejected,
        }))
        .map_err(|e| e.to_string())?;
        let (path, partial) = (dir.join(STATE_FILE), dir.join(format!("{STATE_FILE}.part")));
        std::fs::write(&partial, body + "\n").map_err(|e| format!("cannot write {}: {e}", partial.display()))?;
        std::fs::rename(&partial, &path).map_err(|e| format!("cannot write {}: {e}", path.display()))
    }

    fn done(&self, name: &str) -> bool {
        self.sent.contains(name) || self.rejected.contains_key(name)
    }
}

/// The lap files in the folder, oldest first. A `.part` file (still being written) is not a lap file yet.
fn lap_files(dir: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    let mut found: Vec<_> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let modified = entry.metadata().and_then(|m| m.modified()).ok();
            name.ends_with(".xlap.gz").then(|| (modified, name, entry.path()))
        })
        .collect();
    found.sort();
    Ok(found.into_iter().map(|(_, name, path)| (name, path)).collect())
}

/// How many laps in `dir` have not been sent to `server` (nor refused by it). Only looks; nothing is changed.
#[cfg(any(windows, test))]
pub fn count_pending_laps(dir: &Path, server: &str) -> usize {
    let state = State::load(dir, server);
    lap_files(dir).map_or(0, |files| files.iter().filter(|(name, _)| !state.done(name)).count())
}

/// What the server would refuse anyway, found here so that a file that is not a lap never leaves the computer.
fn check_file(bytes: &[u8], max_bytes: usize) -> Result<(), String> {
    if bytes.len() > max_bytes {
        return Err(format!(
            "it is {} MB; the server takes up to {} MB",
            bytes.len().div_ceil(1 << 20),
            max_bytes >> 20
        ));
    }
    lapfile::gunzip(bytes, lapfile::MAX_UNPACKED)
        .map(|_| ())
        .map_err(|error| format!("it is not a valid lap file: {error}"))
}

#[derive(Debug, PartialEq)]
pub enum Stop {
    /// The device key was refused: pair again.
    Unauthorized,
    /// A problem that may pass; the laps that were not sent are still pending.
    Later { reason: String, after: Option<Duration> },
}

#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub sent: u32,
    pub duplicates: u32,
    pub rejected: u32,
    /// Laps still pending when the pass ended.
    pub left: usize,
    pub stopped: Option<Stop>,
}

/// Sends every pending lap of `dir`, one at a time. A lap the server refuses for good is marked and skipped;
/// anything that may pass, or a refused key, ends the pass and leaves the rest pending.
pub fn upload_pending(dir: &Path, config: &Config, agent: &ureq::Agent, say: &mut dyn FnMut(String)) -> Report {
    let mut report = Report::default();
    let files = match lap_files(dir) {
        Ok(files) => files,
        Err(reason) => {
            return Report {
                stopped: Some(Stop::Later { reason, after: None }),
                ..report
            }
        }
    };
    let mut state = State::load(dir, &config.server);
    let mut pending: Vec<_> = files.into_iter().filter(|(name, _)| !state.done(name)).collect();
    pending.reverse(); // pop() takes the oldest
    let mut warned_about_state = false;

    while let Some((name, path)) = pending.pop() {
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                // Not ours to decide: a file that cannot be read now may be fine in a minute.
                say(format!("Cannot read {name}: {error}; it stays pending."));
                report.left += 1;
                continue;
            }
        };
        let outcome = match check_file(&bytes, MAX_UPLOAD_BYTES) {
            Ok(()) => net::send_lap(agent, config, &bytes),
            Err(why) => Err(SendError::Rejected(why)),
        };
        match outcome {
            Ok(sent) => {
                state.sent.insert(name.clone());
                if sent == Sent::Duplicate {
                    report.duplicates += 1;
                    say(format!("The server already had {name}."));
                } else {
                    report.sent += 1;
                    say(format!("Sent {name}."));
                }
            }
            Err(SendError::Rejected(why)) => {
                state.rejected.insert(name.clone(), why.clone());
                report.rejected += 1;
                say(format!("Not sending {name}: {why}"));
            }
            Err(SendError::Unauthorized) => {
                report.left += pending.len() + 1;
                report.stopped = Some(Stop::Unauthorized);
                break;
            }
            Err(SendError::Later { reason, after }) => {
                report.left += pending.len() + 1;
                report.stopped = Some(Stop::Later { reason, after });
                break;
            }
        }
        if let Err(problem) = state.save(dir) {
            if !warned_about_state {
                say(format!("{problem}; laps already sent may be offered to the server again."));
                warned_about_state = true;
            }
        }
    }
    report
}

/// What became of one track layout file: the track it holds, the hash of the bytes that went (or were refused), and why
/// it was refused.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackDone {
    pub key: String,
    pub hash: String,
    pub why: Option<String>,
}

/// What was already done with the track layouts of the outbox, for one server, by file name.
#[derive(Debug, Default, PartialEq)]
pub struct TrackState {
    server: String,
    done: BTreeMap<String, TrackDone>,
}

impl TrackState {
    /// Like the laps' state: missing, damaged or another server's starts empty, and at worst a layout goes again (the
    /// server replaces it with the same bytes).
    pub fn load(dir: &Path, server: &str) -> TrackState {
        let mut state = TrackState {
            server: server.to_owned(),
            ..TrackState::default()
        };
        let Some(value) = std::fs::read_to_string(dir.join(TRACK_STATE_FILE))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        else {
            return state;
        };
        if value.get("server").and_then(Value::as_str) != Some(server) {
            return state;
        }
        let text = |entry: &Value, key: &str| entry.get(key).and_then(Value::as_str).map(str::to_owned);
        for (name, entry) in value.get("files").and_then(Value::as_object).into_iter().flatten() {
            if let (Some(key), Some(hash)) = (text(entry, "key"), text(entry, "hash")) {
                let why = text(entry, "rejected");
                state.done.insert(name.clone(), TrackDone { key, hash, why });
            }
        }
        state
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        let files: serde_json::Map<String, Value> = self
            .done
            .iter()
            .map(|(name, done)| {
                let mut entry = json!({ "key": done.key, "hash": done.hash });
                if let Some(why) = &done.why {
                    entry["rejected"] = json!(why);
                }
                (name.clone(), entry)
            })
            .collect();
        let body = serde_json::to_string_pretty(&json!({ "server": self.server, "files": files })).map_err(|e| e.to_string())?;
        let (path, partial) = (dir.join(TRACK_STATE_FILE), dir.join(format!("{TRACK_STATE_FILE}.part")));
        std::fs::write(&partial, body + "\n").map_err(|e| format!("cannot write {}: {e}", partial.display()))?;
        std::fs::rename(&partial, &path).map_err(|e| format!("cannot write {}: {e}", path.display()))
    }

    /// Whether these very bytes of this file were already sent or refused.
    pub fn done(&self, name: &str, hash: &str) -> bool {
        self.done.get(name).is_some_and(|done| done.hash == hash)
    }

    #[cfg(test)]
    pub fn get(&self, name: &str) -> Option<&TrackDone> {
        self.done.get(name)
    }
}

/// The track layout files of the outbox, oldest first (a `.part` file is still being written).
fn track_files(dir: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // No layout was ever built: nothing to send.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("cannot read {}: {error}", dir.display())),
    };
    let mut found: Vec<_> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let modified = entry.metadata().and_then(|m| m.modified()).ok();
            name.ends_with(auto::EXTENSION).then(|| (modified, name, entry.path()))
        })
        .collect();
    found.sort();
    Ok(found.into_iter().map(|(_, name, path)| (name, path)).collect())
}

/// What the server would refuse anyway, found here: a file that is not a track layout never leaves the computer.
/// Gives the track's key.
fn check_track(bytes: &[u8], max_bytes: usize) -> Result<String, String> {
    if bytes.len() > max_bytes {
        return Err(format!(
            "it is {} MB; the server takes up to {} MB",
            bytes.len().div_ceil(1 << 20),
            max_bytes >> 20
        ));
    }
    tracks::gunzip(bytes, tracks::MAX_UNPACKED)
        .map(|track| auto::track_key(&track.game, &track.name, track.variant.as_deref()))
        .map_err(|error| format!("it is not a valid track layout: {error}"))
}

/// Sends every pending track layout of `dir` (the `tracks` outbox), one at a time, with the same rules as
/// [`upload_pending`]: a layout refused for good is marked (until its file changes); anything that may pass, or a
/// refused key, ends the pass.
pub fn upload_tracks(dir: &Path, config: &Config, agent: &ureq::Agent, say: &mut dyn FnMut(String)) -> Report {
    let mut report = Report::default();
    let files = match track_files(dir) {
        Ok(files) => files,
        Err(reason) => {
            return Report {
                stopped: Some(Stop::Later { reason, after: None }),
                ..report
            }
        }
    };
    if files.is_empty() {
        return report;
    }
    let mut state = TrackState::load(dir, &config.server);
    let mut pending = Vec::new();
    for (name, path) in files {
        match std::fs::read(&path) {
            Ok(bytes) => {
                let hash = auto::hash_hex(&bytes);
                if !state.done(&name, &hash) {
                    pending.push((name, bytes, hash));
                }
            }
            Err(error) => {
                say(format!("Cannot read {name}: {error}; it stays pending."));
                report.left += 1;
            }
        }
    }
    pending.reverse(); // pop() takes the oldest
    let mut warned_about_state = false;
    while let Some((name, bytes, hash)) = pending.pop() {
        let (key, outcome) = match check_track(&bytes, MAX_TRACK_UPLOAD_BYTES) {
            Ok(key) => (key, net::send_track(agent, config, &bytes)),
            Err(why) => (String::new(), Err(SendError::Rejected(why))),
        };
        match outcome {
            Ok(sent) => {
                state.done.insert(name.clone(), TrackDone { key, hash, why: None });
                if sent == Sent::Duplicate {
                    report.duplicates += 1;
                } else {
                    report.sent += 1;
                }
                say(format!("Sent the track layout {name}."));
            }
            Err(SendError::Rejected(why)) => {
                say(format!("Not sending the track layout {name}: {why}"));
                state.done.insert(name, TrackDone { key, hash, why: Some(why) });
                report.rejected += 1;
            }
            Err(SendError::Unauthorized) => {
                report.left += pending.len() + 1;
                report.stopped = Some(Stop::Unauthorized);
                break;
            }
            Err(SendError::Later { reason, after }) => {
                report.left += pending.len() + 1;
                report.stopped = Some(Stop::Later { reason, after });
                break;
            }
        }
        if let Err(problem) = state.save(dir) {
            if !warned_about_state {
                say(format!("{problem}; track layouts already sent may be offered to the server again."));
                warned_about_state = true;
            }
        }
    }
    report
}

/// The waits between tries while the server cannot take laps: it starts at `base` and doubles up to `max`.
#[derive(Clone, Copy)]
pub struct Backoff {
    pub base: Duration,
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff {
            base: Duration::from_secs(30),
            max: Duration::from_secs(300),
        }
    }
}

/// Where the thread that sends laps reports to: lines of text, how the cloud side stands, and how many laps just went.
#[derive(Clone)]
pub struct Observer {
    pub say: Arc<dyn Fn(String) + Send + Sync>,
    pub cloud: Arc<dyn Fn(Cloud) + Send + Sync>,
    pub sent: Arc<dyn Fn(u32) + Send + Sync>,
    /// How the thread itself stands (it is restarted when it panics, and given up on when it keeps panicking).
    pub worker: Arc<dyn Fn(Health) + Send + Sync>,
}

impl Observer {
    /// For the command line: lines go to the terminal, the rest is not needed.
    pub fn console() -> Observer {
        Observer {
            say: Arc::new(|line| println!("{line}")),
            cloud: Arc::new(|_| {}),
            sent: Arc::new(|_| {}),
            worker: Arc::new(|_| {}),
        }
    }

    #[cfg(test)]
    pub fn silent() -> Observer {
        Observer {
            say: Arc::new(|_| {}),
            cloud: Arc::new(|_| {}),
            sent: Arc::new(|_| {}),
            worker: Arc::new(|_| {}),
        }
    }
}

enum Message {
    Wake,
    Stop,
}

/// Sends laps from a thread of its own, so that a slow network never makes the recorder miss a sample. The thread is
/// supervised: if it panics it is started again (see `supervisor`), and given up on when it keeps panicking.
pub struct Uploader {
    tx: mpsc::Sender<Message>,
    /// Set when the uploader is dropped, so the supervisor does not start the thread's loop again.
    stop: Arc<AtomicBool>,
}

/// The loop of the uploader's thread, from a fresh start: look at the folders, send what is pending, then wait for a new
/// lap or the next try. It returns when told to stop (or when the server refuses the key).
fn upload_loop(dir: &Path, config: &Config, backoff: Backoff, observer: &Observer, rx: &mpsc::Receiver<Message>) {
    let agent = net::agent();
    let mut delay = backoff.base;
    loop {
        let mut report = upload_pending(dir, config, &agent, &mut |line| (observer.say)(line));
        if report.sent + report.duplicates > 0 {
            (observer.sent)(report.sent + report.duplicates);
        }
        let laps_left = report.left;
        // Laps first: they are what the person is waiting for. Layouts go when the laps could.
        if report.stopped.is_none() {
            let layouts = upload_tracks(&dir.join(auto::TRACKS_DIR), config, &agent, &mut |line| (observer.say)(line));
            report.left += layouts.left;
            report.stopped = layouts.stopped;
        }
        let wait = match report.stopped {
            Some(Stop::Unauthorized) => {
                (observer.say)(
                    "The server no longer accepts this computer's key. Pair again; laps are still saved here and will be sent after that."
                        .into(),
                );
                (observer.cloud)(Cloud::Refused);
                return;
            }
            Some(Stop::Later { reason, after }) => {
                let wait = after.unwrap_or(delay).max(backoff.base);
                delay = (delay * 2).min(backoff.max);
                let layouts = report.left - laps_left;
                (observer.say)(format!(
                    "Could not send now: {reason}. {laps_left} lap(s){} waiting; trying again in {} s.",
                    if layouts > 0 {
                        format!(" and {layouts} track layout(s)")
                    } else {
                        String::new()
                    },
                    wait.as_secs().max(1)
                ));
                (observer.cloud)(Cloud::Waiting(report.left));
                Some(wait)
            }
            None => {
                delay = backoff.base;
                (observer.cloud)(if report.left > 0 {
                    Cloud::Waiting(report.left)
                } else {
                    Cloud::Idle
                });
                // Nothing left to send: sleep until the recorder saves another lap.
                (report.left > 0).then_some(backoff.base)
            }
        };
        let message = match wait {
            Some(wait) => rx.recv_timeout(wait),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match message {
            Ok(Message::Wake) | Err(RecvTimeoutError::Timeout) => {}
            Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

impl Uploader {
    pub fn start(dir: PathBuf, config: Config, backoff: Backoff, observer: Observer) -> Uploader {
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        std::thread::spawn(move || {
            supervise(
                supervisor::title(supervisor::UPLOADER),
                &Policy::default(),
                &|| stopped.load(Ordering::SeqCst),
                &|line| (observer.say)(line),
                &|health| (observer.worker)(health),
                || upload_loop(&dir, &config, backoff, &observer, &rx),
            );
        });
        Uploader { tx, stop }
    }

    /// A new lap (or track layout) was saved: look at the folders now.
    pub fn wake(&self) {
        let _ = self.tx.send(Message::Wake);
    }
}

/// Dropping the uploader tells its thread to finish. The thread is not waited for: a request in flight must not
/// hold up the end of the program, and nothing is lost, because the laps stay in the folder.
impl Drop for Uploader {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Message::Stop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_what_is_not_a_lap_before_it_leaves() {
        assert!(check_file(b"hello", 1024).unwrap_err().contains("not a valid lap file"));
        assert!(check_file(&[0u8; 2048], 1024).unwrap_err().contains("the server takes up to"));
        assert!(check_file(&[], 1024).is_err());
    }

    #[test]
    fn counts_the_laps_that_still_have_to_go() {
        let dir = crate::config::scratch_dir("count-pending");
        let server = "https://a.example";
        assert_eq!(count_pending_laps(&dir.join("missing"), server), 0);
        for name in ["a.xlap.gz", "b.xlap.gz", "c.xlap.gz", "d.xlap.gz.part", "notes.txt"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        assert_eq!(count_pending_laps(&dir, server), 3, "a .part file and other files are not laps");
        let mut state = State::load(&dir, server);
        state.sent.insert("a.xlap.gz".into());
        state.rejected.insert("b.xlap.gz".into(), "bad".into());
        state.save(&dir).unwrap();
        assert_eq!(count_pending_laps(&dir, server), 1);
        assert_eq!(count_pending_laps(&dir, ""), 3, "without a server nothing counts as sent");
    }

    #[test]
    fn state_starts_fresh_when_missing_damaged_or_for_another_server() {
        let dir = crate::config::scratch_dir("state");
        let server = "https://a.example";
        assert_eq!(
            State::load(&dir, server),
            State {
                server: server.into(),
                ..State::default()
            }
        );
        let mut state = State::load(&dir, server);
        state.sent.insert("one.xlap.gz".into());
        state.rejected.insert("two.xlap.gz".into(), "bad".into());
        state.save(&dir).unwrap();
        assert_eq!(State::load(&dir, server), state);
        assert!(State::load(&dir, server).done("two.xlap.gz"));
        assert!(!State::load(&dir, "https://b.example").done("one.xlap.gz"));
        std::fs::write(dir.join(STATE_FILE), "{ damaged").unwrap();
        assert!(!State::load(&dir, server).done("one.xlap.gz"));
    }
}
