//! Sending the laps in a folder, and remembering which ones went.
//!
//! The folder of laps *is* the queue: a lap is pending while it is there and `.xpeed-upload.json`, next to it,
//! does not list it as sent or refused. If the computer shuts down halfway, the next run goes on from there.
//! No lap file is ever deleted, moved or changed by sending.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::config::Config;
use crate::lapfile;
use crate::net::{self, SendError, Sent, MAX_UPLOAD_BYTES};
use crate::status::Cloud;

const STATE_FILE: &str = ".xpeed-upload.json";

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
}

impl Observer {
    /// For the command line: lines go to the terminal, the rest is not needed.
    pub fn console() -> Observer {
        Observer {
            say: Arc::new(|line| println!("{line}")),
            cloud: Arc::new(|_| {}),
            sent: Arc::new(|_| {}),
        }
    }

    #[cfg(test)]
    pub fn silent() -> Observer {
        Observer {
            say: Arc::new(|_| {}),
            cloud: Arc::new(|_| {}),
            sent: Arc::new(|_| {}),
        }
    }
}

enum Message {
    Wake,
    Stop,
}

/// Sends laps from a thread of its own, so that a slow network never makes the recorder miss a sample.
pub struct Uploader {
    tx: mpsc::Sender<Message>,
}

impl Uploader {
    pub fn start(dir: PathBuf, config: Config, backoff: Backoff, observer: Observer) -> Uploader {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let agent = net::agent();
            let mut delay = backoff.base;
            loop {
                let report = upload_pending(&dir, &config, &agent, &mut |line| (observer.say)(line));
                if report.sent + report.duplicates > 0 {
                    (observer.sent)(report.sent + report.duplicates);
                }
                let wait = match report.stopped {
                    Some(Stop::Unauthorized) => {
                        (observer.say)("The server no longer accepts this computer's key. Pair again; laps are still saved here and will be sent after that.".into());
                        (observer.cloud)(Cloud::Refused);
                        return;
                    }
                    Some(Stop::Later { reason, after }) => {
                        let wait = after.unwrap_or(delay).max(backoff.base);
                        delay = (delay * 2).min(backoff.max);
                        (observer.say)(format!(
                            "Could not send now: {reason}. {} lap(s) waiting; trying again in {} s.",
                            report.left,
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
        });
        Uploader { tx }
    }

    /// A new lap was saved: look at the folder now.
    pub fn wake(&self) {
        let _ = self.tx.send(Message::Wake);
    }
}

/// Dropping the uploader tells its thread to finish. The thread is not waited for: a request in flight must not
/// hold up the end of the program, and nothing is lost, because the laps stay in the folder.
impl Drop for Uploader {
    fn drop(&mut self) {
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
