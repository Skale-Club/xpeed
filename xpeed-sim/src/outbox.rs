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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::config::Config;
use crate::lapfile;
use crate::net::{self, FileError, SendError, Sent, MAX_TRACK_UPLOAD_BYTES, MAX_UPLOAD_BYTES};
use crate::status::Cloud;
use crate::supervisor::{self, supervise, Health, Policy};
use crate::tracks::{self, auto};

const STATE_FILE: &str = ".xpeed-upload.json";
const TRACK_STATE_FILE: &str = ".xpeed-tracks.json";

/// The version of the layout of `.xpeed-upload.json`. Version 1 (no `format` field) had `server`, `sent` and
/// `rejected`; version 2 adds `companion` and `rejected_meta`. Older files load as they are.
const STATE_FORMAT: u64 = 2;
/// A `.part` file left by a lap that could not be written is cleaned after this long.
pub const STALE_PART_AGE: Duration = Duration::from_secs(3600);
const LAP_EXTENSION: &str = ".xlap.gz";
const PART_SUFFIX: &str = ".xlap.gz.part";

/// What a lap file looked like when it was looked at: its size and its last change, in milliseconds since 1970.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Print {
    size: u64,
    modified_ms: Option<u64>,
}

impl Print {
    fn of(metadata: &std::fs::Metadata) -> Print {
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .and_then(|d| u64::try_from(d.as_millis()).ok());
        Print {
            size: metadata.len(),
            modified_ms,
        }
    }
}

/// What is known about a lap the server refused for good (or that was never worth sending): the Companion version
/// that decided, the server's code, and what the file looked like then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub companion: String,
    pub code: Option<String>,
    print: Option<Print>,
}

/// What was already done with the laps of a folder, for one server.
#[derive(Debug, Default, PartialEq)]
pub struct State {
    server: String,
    /// The Companion version that last worked on this folder (`None` for a file from before it was recorded).
    companion: Option<String>,
    sent: BTreeSet<String>,
    rejected: BTreeMap<String, String>,
    refusals: BTreeMap<String, Refusal>,
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
        let refusals = value
            .get("rejected_meta")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(name, entry)| {
                let companion = entry.get("companion")?.as_str()?.to_owned();
                let code = entry.get("code").and_then(Value::as_str).map(str::to_owned);
                let print = entry.get("size").and_then(Value::as_u64).map(|size| Print {
                    size,
                    modified_ms: entry.get("modified_ms").and_then(Value::as_u64),
                });
                Some((name.clone(), Refusal { companion, code, print }))
            })
            .collect();
        State {
            server: server.to_owned(),
            companion: value.get("companion").and_then(Value::as_str).map(str::to_owned),
            sent,
            rejected,
            refusals,
        }
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        let meta: serde_json::Map<String, Value> = self
            .refusals
            .iter()
            .map(|(name, refusal)| {
                let mut entry = json!({ "companion": refusal.companion });
                if let Some(code) = &refusal.code {
                    entry["code"] = json!(code);
                }
                if let Some(print) = refusal.print {
                    entry["size"] = json!(print.size);
                    if let Some(ms) = print.modified_ms {
                        entry["modified_ms"] = json!(ms);
                    }
                }
                (name.clone(), entry)
            })
            .collect();
        let body = serde_json::to_string_pretty(&json!({
            "format": STATE_FORMAT,
            "server": self.server,
            "companion": self.companion,
            "sent": self.sent,
            "rejected": self.rejected,
            "rejected_meta": meta,
        }))
        .map_err(|e| e.to_string())?;
        let (path, partial) = (dir.join(STATE_FILE), dir.join(format!("{STATE_FILE}.part")));
        std::fs::write(&partial, body + "\n").map_err(|e| format!("cannot write {}: {e}", partial.display()))?;
        std::fs::rename(&partial, &path).map_err(|e| format!("cannot write {}: {e}", path.display()))
    }

    fn done(&self, name: &str) -> bool {
        self.sent.contains(name) || self.rejected.contains_key(name)
    }

    /// Who refused this lap and with which code, if it was refused (a state from before this was recorded has none).
    #[cfg(test)]
    pub fn refusal(&self, name: &str) -> Option<&Refusal> {
        self.refusals.get(name)
    }

    /// The Companion version that last worked on the folder.
    #[cfg(test)]
    pub fn companion(&self) -> Option<&str> {
        self.companion.as_deref()
    }

    fn refuse(&mut self, name: &str, why: String, refusal: Refusal) {
        self.rejected.insert(name.to_owned(), why);
        self.refusals.insert(name.to_owned(), refusal);
    }

    /// Back to pending: forgets that the lap was refused. Returns whether it was.
    fn requeue(&mut self, name: &str) -> bool {
        self.refusals.remove(name);
        self.rejected.remove(name).is_some()
    }
}

/// What the state says about the laps now in a folder; the heartbeat can show it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Counts {
    /// Lap files not sent and not refused (this includes laps waiting for room on the account).
    pub pending: usize,
    /// Lap files the server refused for good, or that are not valid laps.
    pub rejected: usize,
    /// Lap files the server has.
    pub sent: usize,
}

/// How many laps in `dir` are pending, refused and sent for `server`. Only looks (names, no file is opened).
pub fn lap_counts(dir: &Path, server: &str) -> Counts {
    let state = State::load(dir, server);
    let mut counts = Counts::default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return counts;
    };
    for entry in entries.filter_map(Result::ok) {
        let Some(name) = entry.file_name().to_str().filter(|n| n.ends_with(LAP_EXTENSION)).map(str::to_owned) else {
            continue;
        };
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        if state.sent.contains(&name) {
            counts.sent += 1;
        } else if state.rejected.contains_key(&name) {
            counts.rejected += 1;
        } else {
            counts.pending += 1;
        }
    }
    counts
}

/// How many laps in `dir` have not been sent to `server` (nor refused by it). Only looks; nothing is changed.
pub fn count_pending_laps(dir: &Path, server: &str) -> usize {
    lap_counts(dir, server).pending
}

/// A lap file found in the folder.
struct Listed {
    name: String,
    path: PathBuf,
    print: Print,
    /// New, or different from the last time the index looked.
    changed: bool,
}

/// What the uploader remembers between passes, so that a pass only works on laps that are new, changed or due: the size
/// and last change of every lap file seen, and the laps waiting for room on the account (not kept on disk, so a new
/// start of the Companion asks again at once).
#[derive(Default)]
pub struct Index {
    known: BTreeMap<String, Print>,
    waiting: BTreeMap<String, Instant>,
    /// Lap files opened and read (to be checked or sent), for the tests.
    reads: usize,
}

impl Index {
    pub fn new() -> Index {
        Index::default()
    }

    /// How many lap files were opened and read since this index was made.
    #[cfg(test)]
    pub fn reads(&self) -> usize {
        self.reads
    }

    /// The lap files in the folder, oldest first. A `.part` file (still being written) is not a lap file yet.
    fn scan(&mut self, dir: &Path) -> Result<Vec<Listed>, String> {
        let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
        let mut found: Vec<(Option<SystemTime>, Listed)> = Vec::new();
        for entry in entries.filter_map(Result::ok) {
            let Some(name) = entry.file_name().into_string().ok().filter(|n| n.ends_with(LAP_EXTENSION)) else {
                continue;
            };
            let Ok(metadata) = entry.metadata() else { continue };
            if !metadata.is_file() {
                continue;
            }
            let print = Print::of(&metadata);
            let changed = self.known.get(&name) != Some(&print);
            found.push((
                metadata.modified().ok(),
                Listed {
                    name,
                    path: entry.path(),
                    print,
                    changed,
                },
            ));
        }
        found.sort_by(|a, b| (a.0, &a.1.name).cmp(&(b.0, &b.1.name)));
        let listed: Vec<Listed> = found.into_iter().map(|(_, l)| l).collect();
        self.known = listed.iter().map(|l| (l.name.clone(), l.print)).collect();
        self.waiting.retain(|name, _| self.known.contains_key(name));
        Ok(listed)
    }
}

/// Removes the `name.xlap.gz.part` files that a failed write left behind (the app writes a lap to that name and renames
/// it; one that is older than `older_than` is not being written any more). Only files named that way go: no lap file,
/// and no other file, is ever touched. Each removal is told. Returns how many went.
pub fn clean_stale_parts(dir: &Path, older_than: Duration, say: &mut dyn FnMut(String)) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let Some(name) = entry.file_name().into_string().ok() else {
            continue;
        };
        // `x.xlap.gz.part` and nothing shorter: there must be a lap's name in front of the suffix.
        if name.len() <= PART_SUFFIX.len() || !name.ends_with(PART_SUFFIX) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else { continue };
        if !metadata.is_file() {
            continue;
        }
        let age = metadata.modified().ok().and_then(|t| t.elapsed().ok());
        if age.is_none_or(|age| age < older_than) {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => {
                removed += 1;
                say(format!("Removed {name}: a lap that could not be written was left half done."));
            }
            Err(error) => say(format!("Could not remove {name}: {error}")),
        }
    }
    removed
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
    /// Laps still pending when the pass ended (this includes the ones waiting for room on the account).
    pub left: usize,
    /// Of `left`, the laps the server said the account has no room for: they are offered again later, not now.
    pub waiting_for_room: usize,
    /// The soonest those laps are due again.
    pub next_try: Option<Duration>,
    /// Laps put back to pending because they were refused by an older version of the Companion, or changed on disk.
    pub requeued: u32,
    pub stopped: Option<Stop>,
}

/// Sends every pending lap of `dir`, one at a time. A lap the server refuses for good is marked and skipped;
/// anything that may pass, or a refused key, ends the pass and leaves the rest pending. A fresh index each time: the
/// worker that keeps one between passes is [`upload_pending_with`].
pub fn upload_pending(dir: &Path, config: &Config, agent: &ureq::Agent, say: &mut dyn FnMut(String)) -> Report {
    upload_pending_with(
        dir,
        config,
        agent,
        say,
        &mut Index::new(),
        env!("CARGO_PKG_VERSION"),
        Instant::now(),
    )
}

/// [`upload_pending`] with the index of the worker (so that known laps are not looked at again), the version of the
/// Companion that is running, and the time that counts as now.
///
/// - A lap refused for good by another version of the Companion goes back to pending once (the server recognizes a lap
///   it has, so sending it again is safe), and so does a refused lap whose file changed on disk.
/// - A refusal that is only about room on the account (`quota`) or that the server calls `retryable` leaves the lap
///   pending: the first is offered again after 6 hours (or the server's `Retry-After`), the second ends the pass.
pub fn upload_pending_with(
    dir: &Path,
    config: &Config,
    agent: &ureq::Agent,
    say: &mut dyn FnMut(String),
    index: &mut Index,
    companion: &str,
    now: Instant,
) -> Report {
    let mut report = Report::default();
    let files = match index.scan(dir) {
        Ok(files) => files,
        Err(reason) => {
            return Report {
                stopped: Some(Stop::Later { reason, after: None }),
                ..report
            }
        }
    };
    let mut state = State::load(dir, &config.server);
    let mut warned_about_state = false;
    let save = |state: &State, say: &mut dyn FnMut(String), warned: &mut bool| {
        if let Err(problem) = state.save(dir) {
            if !*warned {
                say(format!("{problem}; laps already sent may be offered to the server again."));
                *warned = true;
            }
        }
    };

    // Refused laps that deserve another look: a new version of the Companion may know better, and a file that
    // changed is a different file.
    let new_version = state.companion.as_deref() != Some(companion);
    let mut requeued = Vec::new();
    for lap in &files {
        if !state.rejected.contains_key(&lap.name) {
            continue;
        }
        let refusal = state.refusals.get(&lap.name);
        let file_changed = lap.changed && refusal.and_then(|r| r.print).is_some_and(|seen| seen != lap.print);
        if new_version || file_changed {
            requeued.push(lap.name.clone());
        }
    }
    for name in &requeued {
        state.requeue(name);
    }
    if !requeued.is_empty() {
        report.requeued = u32::try_from(requeued.len()).unwrap_or(u32::MAX);
        say(format!(
            "{} lap(s) that could not be sent before will be tried again ({}).",
            requeued.len(),
            if new_version {
                "this is a new version of the app"
            } else {
                "their files changed"
            }
        ));
    }
    if new_version || !requeued.is_empty() {
        state.companion = Some(companion.to_owned());
        save(&state, say, &mut warned_about_state);
    }

    let mut pending: Vec<_> = files.into_iter().filter(|lap| !state.done(&lap.name)).collect();
    pending.reverse(); // pop() takes the oldest

    while let Some(lap) = pending.pop() {
        let Listed { name, path, print, .. } = lap;
        if let Some(due) = index.waiting.get(&name).copied().filter(|due| *due > now) {
            report.left += 1;
            report.waiting_for_room += 1;
            let wait = due - now;
            report.next_try = Some(report.next_try.map_or(wait, |soonest| soonest.min(wait)));
            continue;
        }
        index.waiting.remove(&name);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => {
                index.reads += 1;
                bytes
            }
            Err(error) => {
                // Not ours to decide: a file that cannot be read now may be fine in a minute.
                say(format!("Cannot read {name}: {error}; it stays pending."));
                report.left += 1;
                continue;
            }
        };
        let outcome = match check_file(&bytes, MAX_UPLOAD_BYTES) {
            Ok(()) => net::send_lap_detailed(agent, config, &bytes),
            Err(why) => Err(FileError::Rejected { why, code: None }),
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
            Err(FileError::Rejected { why, code }) => {
                let refusal = Refusal {
                    companion: companion.to_owned(),
                    code,
                    print: Some(print),
                };
                state.refuse(&name, why.clone(), refusal);
                report.rejected += 1;
                say(format!("Not sending {name}: {why}"));
            }
            Err(FileError::Deferred { reason, after }) => {
                // The account is full, and so it is for every lap: ask again for all of them after the wait.
                let due = now + after;
                say(format!(
                    "Not sending {name} now: {reason}. It stays here; trying again in {} min.",
                    after.as_secs().div_ceil(60)
                ));
                index.waiting.insert(name.clone(), due);
                report.left += 1;
                report.waiting_for_room += 1;
                for other in pending.drain(..) {
                    index.waiting.insert(other.name, due);
                    report.left += 1;
                    report.waiting_for_room += 1;
                }
                report.next_try = Some(report.next_try.map_or(after, |soonest| soonest.min(after)));
            }
            Err(FileError::Unauthorized) => {
                report.left += pending.len() + 1;
                report.stopped = Some(Stop::Unauthorized);
                break;
            }
            Err(FileError::Later { reason, after }) => {
                report.left += pending.len() + 1;
                report.stopped = Some(Stop::Later { reason, after });
                break;
            }
        }
        save(&state, say, &mut warned_about_state);
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
    let mut index = Index::new();
    clean_stale_parts(dir, STALE_PART_AGE, &mut |line| (observer.say)(line));
    loop {
        let mut report = upload_pending_with(
            dir,
            config,
            &agent,
            &mut |line| (observer.say)(line),
            &mut index,
            env!("CARGO_PKG_VERSION"),
            Instant::now(),
        );
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
                // Nothing left to send: sleep until the recorder saves another lap. Laps waiting for room on the account
                // are asked again when it is time (a lap saved meanwhile wakes the worker sooner).
                let only_waiting = report.left > 0 && report.left == report.waiting_for_room;
                match report.next_try {
                    Some(next) if only_waiting => Some(next.max(backoff.base)),
                    _ => (report.left > 0).then_some(backoff.base),
                }
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
