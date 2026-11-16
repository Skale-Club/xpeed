//! Error reports to Xpeed's own server (and to nobody else): when Xpeed Companion panics, or a worker keeps failing, the owner of the
//! site learns of it from the Problems section of the admin page instead of from a person who writes in.
//!
//! * A panic (see `supervisor::install_panic_hook`) and a worker that was restarted three times or more (`supervisor::supervise`)
//!   are written, one JSON line each, to `error-reports.jsonl` in Companion's own folder (at most 5 are kept, the newest).
//!   Writing a line is all that happens while things are going wrong: nothing touches the network from a panic.
//! * Companion connected to an account sends the waiting lines to `POST /api/sim/companion-errors` with the device key (like the
//!   heartbeat) and deletes the ones the server took: at once when a report is written (on a thread of its own, started after the line
//!   is in the file, never from inside the panic's own work), and again at the next start. A server that is busy, older, or
//!   unreachable leaves them for the next start; one that refuses a line for good (it is not a report) drops it.
//! * The file is written whole to a side file and renamed over the real one, and one lock covers every read-modify-write: two panics
//!   at once (two threads) cannot lose each other's line, and a crash halfway through never leaves half a file.
//!
//! What goes: the version, the worker, the message, a trimmed backtrace, the operating system and architecture ("windows x86_64"), the
//! time. Windows account names in paths are replaced by `[user]` here, before anything is written (the server scrubs again). No
//! name, no laps, no files, no key. The contract is in `api/sim/companion-errors.ts`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::config::Config;
use crate::net::{self, SendError};
use crate::util::{iso_utc, lock, now_ms};

/// The file of reports that wait to be sent.
pub const FILE: &str = "error-reports.jsonl";
/// How many reports wait at most (the newest are kept).
pub const KEEP: usize = 5;
const MAX_MESSAGE: usize = 500;
const MAX_BACKTRACE: usize = 4000;
const VERSION: &str = env!("CARGO_PKG_VERSION");

static DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
/// Who sends the reports as they are written (set when Companion is connected to an account), and how it says what it did.
type Say = Arc<dyn Fn(String) + Send + Sync>;
static SENDER: Mutex<Option<(Config, Say)>> = Mutex::new(None);
/// A sending thread is running: one is enough, it looks at the file again before it stops.
static SENDING: AtomicBool = AtomicBool::new(false);
/// Held while the file is read, changed and written.
static WRITING: Mutex<()> = Mutex::new(());
/// Makes the names of the side files different.
static SIDE: AtomicU64 = AtomicU64::new(0);

/// Where the reports wait (Companion's own folder). Until this is called, `record` does nothing (tests, and commands with no folder).
pub fn init(dir: PathBuf) {
    *lock(&DIR) = Some(dir);
}

/// Replaces the account name in a Windows or Unix home path (`C:\Users\Name\...`, `/home/name/...`) by `[user]`.
pub fn scrub_paths(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    'scan: while !rest.is_empty() {
        for marker in ["\\Users\\", "/Users/", "/home/", "\\users\\"] {
            if let Some(after) = rest.strip_prefix(marker) {
                out.push_str(marker);
                out.push_str("[user]");
                let name_end = after.find(['\\', '/', ' ', '\'', '"', ':', ')']).unwrap_or(after.len());
                rest = &after[name_end..];
                continue 'scan;
            }
        }
        let mut chars = rest.chars();
        if let Some(c) = chars.next() {
            out.push(c);
        }
        rest = chars.as_str();
    }
    out
}

/// A thread or worker name as the server accepts it: lower case letters, digits and `-`, starting with a letter; "main" when nothing is left.
pub fn worker_id(name: &str) -> String {
    let mut id: String = name
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    id = id.trim_matches('-').to_owned();
    if !id.chars().next().is_some_and(|c| c.is_ascii_lowercase()) {
        id = format!("w{id}");
    }
    id.truncate(32);
    if id == "w" {
        "main".to_owned()
    } else {
        id
    }
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The operating system and architecture, e.g. `windows x86_64`: the family, never the exact build or the computer.
pub fn os_family() -> String {
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

/// The body of one report. `message` and `backtrace` are cleaned of account names and cut to size.
pub fn report_json(worker: &str, message: &str, backtrace: &str, at_ms: i64) -> Value {
    json!({
        "version": VERSION,
        "worker": worker_id(worker),
        "message": clip(&scrub_paths(message).replace(['\r', '\n'], " "), MAX_MESSAGE),
        "backtrace": clip(&scrub_paths(backtrace), MAX_BACKTRACE),
        "os": os_family(),
        "at": iso_utc(at_ms),
    })
}

fn waiting_lines(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join(FILE))
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Writes the lines whole to a side file and renames it over the real one (a rename replaces the file in one step).
fn write_lines(dir: &Path, lines: &[String]) {
    let path = dir.join(FILE);
    if lines.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    let _ = std::fs::create_dir_all(dir);
    let side = dir.join(format!("{FILE}.{}.{}.tmp", std::process::id(), SIDE.fetch_add(1, Ordering::SeqCst)));
    let written = std::fs::File::create(&side).and_then(|mut file| {
        writeln!(file, "{}", lines.join("\n"))?;
        file.sync_all()
    });
    if written.is_err() || std::fs::rename(&side, &path).is_err() {
        let _ = std::fs::remove_file(&side);
    }
}

/// Runs `change` with the file's lock. A thread that panics inside `record_in` (and so holds the lock) and is then asked for a
/// report by its own panic hook must not wait for itself: after half a second the change goes on without the lock.
fn with_file_lock<R>(change: impl FnOnce() -> R) -> R {
    let until = Instant::now() + Duration::from_millis(500);
    loop {
        match WRITING.try_lock() {
            Ok(_guard) => return change(),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                let _guard = poisoned.into_inner();
                return change();
            }
            Err(std::sync::TryLockError::WouldBlock) if Instant::now() < until => std::thread::sleep(Duration::from_millis(2)),
            Err(std::sync::TryLockError::WouldBlock) => return change(),
        }
    }
}

/// Appends a report to the file in `dir`, keeping the newest `KEEP`. Never fails and never panics: it runs while something is already wrong.
pub fn record_in(dir: &Path, worker: &str, message: &str, backtrace: &str) {
    let line = report_json(worker, message, backtrace, now_ms()).to_string();
    with_file_lock(|| {
        let mut lines = waiting_lines(dir);
        lines.push(line);
        if lines.len() > KEEP {
            lines.drain(..lines.len() - KEEP);
        }
        write_lines(dir, &lines);
    });
}

/// `record_in` for the folder given to `init` (nothing before that), and then the report goes to the server at once when this
/// computer is connected.
pub fn record(worker: &str, message: &str, backtrace: &str) {
    let dir = lock(&DIR).clone();
    if let Some(dir) = dir {
        record_in(&dir, worker, message, backtrace);
        send_now();
    }
}

/// How many reports wait in `dir`.
pub fn waiting(dir: &Path) -> usize {
    waiting_lines(dir).len()
}

/// Sends every waiting report, oldest first, and removes the ones the server took (or refused for good). Stops at the first problem that
/// may pass (the rest wait for the next start) and when the server no longer accepts the key. Answers how many the server took.
pub fn send_waiting(agent: &ureq::Agent, config: &Config, dir: &Path, say: &dyn Fn(String)) -> usize {
    let lines = waiting_lines(dir);
    let mut sent = 0;
    // The lines the server took or refused for good: the file loses exactly these, so a report written while this runs stays.
    let mut done: Vec<&String> = Vec::new();
    for line in &lines {
        match net::send_error_report(agent, config, line) {
            Ok(()) => {
                sent += 1;
                done.push(line);
            }
            Err(SendError::Rejected(reason)) => {
                say(format!("an error report was refused for good, dropped: {reason}"));
                done.push(line);
            }
            Err(SendError::Unauthorized) => {
                say("error reports: the server no longer accepts this computer's key; they wait.".into());
                break;
            }
            Err(SendError::Later { reason, .. }) => {
                say(format!("error reports: not sent now ({reason}); they wait for the next start."));
                break;
            }
        }
    }
    if !done.is_empty() {
        with_file_lock(|| {
            let mut left = waiting_lines(dir);
            for line in done {
                if let Some(at) = left.iter().position(|l| l == line) {
                    left.remove(at);
                }
            }
            write_lines(dir, &left);
        });
    }
    sent
}

/// Sends what waits, once, on a thread of its own (a slow network must never delay anything). Nothing waiting: no thread, no request.
pub fn send_in_background(config: Config, say: Arc<dyn Fn(String) + Send + Sync>) {
    if config.server.is_empty() || config.token.is_empty() {
        *lock(&SENDER) = None;
        return;
    }
    // From now on a report written by a panic goes at once (`record`), not only at the next start.
    *lock(&SENDER) = Some((config, say));
    send_now();
}

/// Sends what waits, on a thread of its own, when this computer is connected and something waits. One thread at a time: a report
/// written while it sends is picked up by it before it stops. Never blocks and never panics (it is called from the panic hook).
fn send_now() {
    let (Some(dir), Some((config, say))) = (lock(&DIR).clone(), lock(&SENDER).clone()) else {
        return;
    };
    if waiting(&dir) == 0 || SENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let started = std::thread::Builder::new().name("error-report-sender".into()).spawn(move || {
        // Whatever happens in here, the next report may start a thread again.
        struct Done;
        impl Drop for Done {
            fn drop(&mut self) {
                SENDING.store(false, Ordering::SeqCst);
            }
        }
        let _done = Done;
        let agent = net::heartbeat_agent();
        let mut total = 0;
        loop {
            let sent = send_waiting(&agent, &config, &dir, &*say);
            total += sent;
            // Went well and more came meanwhile: once more. Anything else waits for the next start.
            if sent == 0 || waiting(&dir) == 0 {
                break;
            }
        }
        if total > 0 {
            say(format!("sent {total} error report(s) to Xpeed"));
        }
    });
    if started.is_err() {
        SENDING.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stub::{Recorded, Reply, Stub};

    /// The tests that set the folder and the sender everybody shares take turns.
    static GLOBALS: Mutex<()> = Mutex::new(());

    fn config_for(url: &str) -> Config {
        Config {
            server: url.to_owned(),
            token: "xpd_testkey".into(),
            device_name: "TEST PC".into(),
            account: None,
            auto_update: true,
        }
    }

    #[test]
    fn account_names_in_paths_never_stay_in_a_report() {
        assert_eq!(
            scrub_paths(r"panicked at C:\Users\Vanildo\.cargo\registry\src\x.rs:10:5"),
            r"panicked at C:\Users\[user]\.cargo\registry\src\x.rs:10:5"
        );
        assert_eq!(
            scrub_paths("/home/maria/work/a.rs and /Users/joao/b.rs"),
            "/home/[user]/work/a.rs and /Users/[user]/b.rs"
        );
        assert_eq!(
            scrub_paths("src/engine.rs:10:5"),
            "src/engine.rs:10:5",
            "a relative path is left alone"
        );
        assert_eq!(scrub_paths("naïve ünïcode stays whole"), "naïve ünïcode stays whole");
        let body = report_json("uploader", r"failed in C:\Users\Vanildo\x.rs", r"0: C:\Users\Vanildo\y.rs", 0);
        assert!(!body.to_string().contains("Vanildo"), "{body}");
    }

    #[test]
    fn the_worker_is_named_the_way_the_server_accepts() {
        assert_eq!(worker_id("game readers"), "game-readers");
        assert_eq!(worker_id("heartbeat sender"), "heartbeat-sender");
        assert_eq!(worker_id("<unnamed>"), "unnamed");
        assert_eq!(worker_id(""), "main");
        assert_eq!(worker_id("123"), "w123");
        assert!(worker_id(&"x".repeat(80)).len() <= 32);
    }

    #[test]
    fn a_report_has_exactly_the_fields_of_the_contract_and_is_cut_to_size() {
        let body = report_json("recorder", &"m".repeat(2000), &"b".repeat(9000), 1_763_200_000_000);
        let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["at", "backtrace", "message", "os", "version", "worker"]);
        assert_eq!(body["version"], VERSION);
        assert_eq!(body["worker"], "recorder");
        assert_eq!(body["message"].as_str().unwrap().len(), MAX_MESSAGE);
        assert_eq!(body["backtrace"].as_str().unwrap().len(), MAX_BACKTRACE);
        assert!(body["os"].as_str().unwrap().contains(std::env::consts::OS));
        assert_eq!(body["at"], "2025-11-15T09:46:40.000Z");
        let one_line = report_json("w", "first\nsecond\r\nthird", "", 0);
        assert_eq!(one_line["message"], "first second  third");
    }

    #[test]
    fn only_the_newest_five_wait_and_nothing_is_written_before_init() {
        let _turn = lock(&GLOBALS);
        let dir = crate::config::scratch_dir("crash-keep");
        for n in 0..8 {
            record_in(&dir, "uploader", &format!("failure number {n}"), "");
        }
        let lines = waiting_lines(&dir);
        assert_eq!(lines.len(), KEEP);
        assert!(
            lines[0].contains("failure number 3") && lines[4].contains("failure number 7"),
            "{lines:?}"
        );
        // `record` knows no folder until `init` ran (the tests of the supervisor panic on purpose and must leave no file behind).
        assert!(lock(&DIR).is_none());
        record("uploader", "nowhere to go", "");
        assert_eq!(waiting(&dir), KEEP);
    }

    #[test]
    fn waiting_reports_go_to_the_server_with_the_device_key_and_are_then_removed() {
        let stub = Stub::start(|_: &Recorded| Reply::new(200, r#"{"ok":true}"#));
        let dir = crate::config::scratch_dir("crash-send");
        record_in(&dir, "uploader", "uploader restarted 3 times in 10 minutes: boom", "");
        record_in(
            &dir,
            "main",
            "panicked at src/engine.rs:10:5: index out of bounds",
            "0: engine::run",
        );
        let lines = Arc::new(Mutex::new(Vec::new()));
        let said = lines.clone();
        let sent = send_waiting(&net::heartbeat_agent(), &config_for(&stub.url), &dir, &move |line| {
            lock(&said).push(line)
        });
        assert_eq!(sent, 2);
        assert_eq!(waiting(&dir), 0, "taken: nothing waits");
        assert!(!dir.join(FILE).exists());
        let seen = stub.requests();
        assert_eq!(seen.len(), 2);
        for request in &seen {
            assert_eq!(request.method, "POST");
            assert_eq!(request.path, "/api/sim/companion-errors");
            assert_eq!(request.headers.get("authorization").map(String::as_str), Some("Bearer xpd_testkey"));
        }
        let first: Value = serde_json::from_slice(&seen[0].body).unwrap();
        assert_eq!(first["worker"], "uploader");
        assert_eq!(first["version"], VERSION);
        // Nothing waits any more: no request, and no thread at all.
        send_in_background(config_for(&stub.url), Arc::new(|_| {}));
        assert_eq!(stub.requests().len(), 2);
        *lock(&SENDER) = None;
    }

    #[test]
    fn two_panics_at_once_do_not_lose_a_report() {
        let dir = crate::config::scratch_dir("crash-race");
        std::thread::scope(|scope| {
            for thread in 0..4 {
                let dir = &dir;
                scope.spawn(move || {
                    for n in 0..KEEP {
                        record_in(dir, &format!("worker-{thread}"), &format!("thread {thread} failure {n}"), "");
                    }
                });
            }
        });
        let lines = waiting_lines(&dir);
        assert_eq!(lines.len(), KEEP, "the newest five of twenty, every one whole: {lines:?}");
        for line in &lines {
            assert!(serde_json::from_str::<Value>(line).is_ok(), "whole line: {line}");
        }
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no side file stays: {leftovers:?}");
    }

    #[test]
    fn a_report_written_while_the_others_are_sent_stays_and_is_not_lost() {
        let dir = crate::config::scratch_dir("crash-during");
        let during = dir.clone();
        let stub = Stub::start(move |request: &Recorded| {
            // While the server answers the first report, another one is written.
            if String::from_utf8_lossy(&request.body).contains("first failure") {
                record_in(&during, "late", "written while sending", "");
            }
            Reply::new(200, r#"{"ok":true}"#)
        });
        record_in(&dir, "uploader", "first failure", "");
        assert_eq!(send_waiting(&net::heartbeat_agent(), &config_for(&stub.url), &dir, &|_| {}), 1);
        let left = waiting_lines(&dir);
        assert_eq!(left.len(), 1, "{left:?}");
        assert!(left[0].contains("written while sending"));
    }

    #[test]
    fn a_report_goes_to_the_server_as_soon_as_it_is_written_when_connected() {
        let _turn = lock(&GLOBALS);
        let stub = Stub::start(|_: &Recorded| Reply::new(200, r#"{"ok":true}"#));
        let dir = crate::config::scratch_dir("crash-now");
        init(dir.clone());
        // Not connected yet: the line waits (the next start sends it).
        record("uploader", "marker-one restarted 3 times in 10 minutes", "");
        // (Other tests of the program may panic on purpose while this runs and write to the same folder: only the lines with
        // the marker are counted.)
        let mine = |stub: &Stub| {
            stub.requests()
                .iter()
                .filter(|r| String::from_utf8_lossy(&r.body).contains("marker-"))
                .count()
        };
        assert!(waiting_lines(&dir).iter().any(|l| l.contains("marker-one")));
        assert_eq!(mine(&stub), 0, "nobody to send to yet");
        // Connected: what waits goes now, and so does the next one.
        send_in_background(config_for(&stub.url), Arc::new(|_| {}));
        let wait_for = |want: usize| {
            let started = Instant::now();
            while mine(&stub) < want && started.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(20));
            }
            mine(&stub)
        };
        assert_eq!(wait_for(1), 1);
        record("recorder", "marker-two panicked at src/x.rs:1:1", "0: x");
        assert_eq!(wait_for(2), 2, "sent at once, not at the next start");
        *lock(&DIR) = None;
        *lock(&SENDER) = None;
    }

    #[test]
    fn a_server_that_cannot_take_them_now_leaves_them_for_the_next_start() {
        for status in [500u16, 503, 429, 404, 401] {
            let stub = Stub::start(move |_: &Recorded| Reply::new(status, r#"{"error":"nope","retryable":true}"#));
            let dir = crate::config::scratch_dir("crash-later");
            record_in(&dir, "recorder", "one", "");
            record_in(&dir, "recorder", "two", "");
            let sent = send_waiting(&net::heartbeat_agent(), &config_for(&stub.url), &dir, &|_| {});
            assert_eq!(sent, 0, "{status}");
            assert_eq!(waiting(&dir), 2, "{status}: both still wait");
            assert_eq!(stub.requests().len(), 1, "{status}: it stops at the first problem");
        }
        // Nobody listening at all.
        let gone = {
            let stub = Stub::start(|_: &Recorded| Reply::new(200, ""));
            let url = stub.url.clone();
            drop(stub);
            url
        };
        let dir = crate::config::scratch_dir("crash-gone");
        record_in(&dir, "recorder", "one", "");
        assert_eq!(send_waiting(&net::heartbeat_agent(), &config_for(&gone), &dir, &|_| {}), 0);
        assert_eq!(waiting(&dir), 1);
    }

    #[test]
    fn a_report_the_server_refuses_for_good_is_dropped_so_it_is_not_sent_forever() {
        let stub = Stub::start(|request: &Recorded| {
            if String::from_utf8_lossy(&request.body).contains("bad one") {
                Reply::new(400, r#"{"error":"invalid_message","retryable":false}"#)
            } else {
                Reply::new(200, r#"{"ok":true}"#)
            }
        });
        let dir = crate::config::scratch_dir("crash-refused");
        record_in(&dir, "recorder", "bad one", "");
        record_in(&dir, "recorder", "good one", "");
        assert_eq!(send_waiting(&net::heartbeat_agent(), &config_for(&stub.url), &dir, &|_| {}), 1);
        assert_eq!(waiting(&dir), 0);
        assert_eq!(stub.requests().len(), 2);
    }
}
