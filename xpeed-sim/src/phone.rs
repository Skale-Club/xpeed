//! The phone view's sender: while a game is live, the panel the PC draws is also sent, as data, to the Xpeed server
//! (`POST /api/sim/live`, contract in `ENVIO-DE-VOLTAS.md`, section 2f), which relays it to the person's phone (a page of the Xpeed
//! app). Off unless the person switches "Show the panel on my phone" on in the tray menu.
//!
//! A frame is the dashboard in use, its rows as the widget ids of the catalog (the cards the game can fill, the pairs as the
//! dashboard defines them) and the same model the panel draws, as JSON. How a frame is built lives next to the panel's model
//! (`panel::Relay`); this file decides when to send, sends, and looks after the failures.
//!
//! A thread of its own, looked after by the supervisor like the heartbeat, builds and sends a frame about ten times a second while
//! the last answer said a phone is watching, and every two seconds otherwise (that slow frame is how the server learns, and tells
//! back, that a phone opened the page). With no game live nothing is sent. The connection is kept between frames. A refused key ends
//! the thread (the uploader says so to the person); a frame the server will not take is skipped; a rate limit waits as long as the
//! server says; anything else is a retry after 1, 2, 5, then 10 seconds, until it works. One line in the log when sending starts to
//! fail and one when it works again; never the key and never a frame. Nothing here ever waits for, or blocks, the reading of a
//! game or the panel.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::config::Config;
use crate::heartbeat::Hooks;
use crate::net::{self, SendError};
use crate::status::Shared;
use crate::supervisor::{self, supervise, Policy};

/// The time between frames while a phone is watching.
pub const FAST: Duration = Duration::from_millis(100);
/// The time between frames while none is: the server's answer to each says whether one has opened the page.
pub const SLOW: Duration = Duration::from_secs(2);
/// How often the thread looks for a game to show while there is none.
pub const IDLE: Duration = Duration::from_millis(500);
/// The waits after a failure, one more each time it fails again.
pub const WAITS: [Duration; 4] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
];
/// The most a frame may weigh (the server refuses more).
pub const MAX_BYTES: usize = 64 * 1024;
/// The longest the thread waits before it looks at whether it was told to stop.
const LOOK: Duration = Duration::from_millis(250);

/// What the phone gets of the panel, before it is a frame on the wire.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    /// The game's id, as the server knows it (`lmu`, `ac`...).
    pub game: String,
    /// The dashboard in use: `race`, `qualifying`, `practice` or `time_trial`.
    pub dashboard: &'static str,
    /// The rows of the phone's layout, each the widget ids of its cards, left to right.
    pub rows: Vec<Vec<&'static str>>,
    /// The panel's dashboard model, as JSON.
    pub model: Value,
}

/// Builds the frame for what the panel shows now, or nothing when no game is live.
pub type Build = Arc<dyn Fn(&Shared) -> Option<Frame> + Send + Sync>;

/// A game id the server takes: a lower case letter, then letters, digits and `_`, up to 32 in all.
pub fn valid_game(id: &str) -> bool {
    let mut chars = id.chars();
    let first = chars.next().is_some_and(|c| c.is_ascii_lowercase());
    first && id.len() <= 32 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// The body of one request, or nothing when the frame is too big to send.
pub fn body(seq: u64, sent_at_ms: i64, frame: &Frame) -> Option<String> {
    let text = json!({
        "v": 1,
        "seq": seq,
        "sentAt": sent_at_ms,
        "game": frame.game,
        "dashboard": frame.dashboard,
        "rows": frame.rows,
        "model": frame.model,
    })
    .to_string();
    (text.len() <= MAX_BYTES).then_some(text)
}

// When.

/// When the next frame is due, as plain numbers: times are milliseconds on a clock that only goes forward, so the tests move the
/// clock by hand.
#[derive(Clone)]
pub struct Schedule {
    fast: u64,
    slow: u64,
    idle: u64,
    waits: [u64; 4],
    next_at: u64,
    /// How many tries in a row have failed.
    failures: usize,
}

impl Schedule {
    pub fn new(fast: Duration, slow: Duration, idle: Duration, waits: [Duration; 4]) -> Schedule {
        Schedule {
            fast: fast.as_millis() as u64,
            slow: slow.as_millis() as u64,
            idle: idle.as_millis() as u64,
            waits: waits.map(|wait| wait.as_millis() as u64),
            next_at: 0,
            failures: 0,
        }
    }

    pub fn standard() -> Schedule {
        Schedule::new(FAST, SLOW, IDLE, WAITS)
    }

    pub fn due(&self, now: u64) -> bool {
        now >= self.next_at
    }

    /// How long until the next frame is due.
    pub fn wait(&self, now: u64) -> Duration {
        Duration::from_millis(self.next_at.saturating_sub(now))
    }

    /// A frame that began at `started` was taken and the answer came at `now`: the next one is a period after `started` (a slow
    /// answer is never followed by a burst to catch up), the period of the fast pace while phones are watching.
    pub fn sent(&mut self, started: u64, now: u64, viewers: u32) {
        self.failures = 0;
        let period = if viewers > 0 { self.fast } else { self.slow };
        self.next_at = (started + period).max(now);
    }

    /// There was no game to show: look again soon. The next frame goes at once, to learn whether a phone is watching.
    pub fn nothing_to_send(&mut self, now: u64) {
        self.next_at = now + self.idle;
    }

    /// The frame was not sent (too big, or refused for good): the next one is a slow period away.
    pub fn skipped(&mut self, now: u64) {
        self.next_at = now + self.slow;
    }

    /// The frame did not go: try again after the server's own wait if it gave one, else after a wait that grows with each failure.
    pub fn failed(&mut self, now: u64, after: Option<Duration>) {
        let backoff = self.waits[self.failures.min(self.waits.len() - 1)];
        self.failures += 1;
        self.next_at = now + after.map_or(backoff, |wait| wait.as_millis() as u64);
    }
}

/// Which lines the log gets: one when sending starts to fail and one when it works again, one when the server will not take a frame
/// and one for a frame that is too big, never one for each try.
#[derive(Debug, Default)]
pub struct Notes {
    failing: bool,
    refused: bool,
    too_big: bool,
}

impl Notes {
    pub fn success(&mut self) -> Option<String> {
        self.refused = false;
        self.too_big = false;
        if !self.failing {
            return None;
        }
        self.failing = false;
        Some("phone view: the panel reaches the server again.".into())
    }

    pub fn failure(&mut self, reason: &str) -> Option<String> {
        if self.failing {
            return None;
        }
        self.failing = true;
        Some(format!("phone view: could not send the panel ({reason}); trying again quietly."))
    }

    /// The server refused a frame it will never take (not the key: that ends the thread).
    pub fn refused(&mut self, reason: &str) -> Option<String> {
        if self.refused {
            return None;
        }
        self.refused = true;
        Some(format!("phone view: the server did not take a frame ({reason}); skipping."))
    }

    /// The frame is bigger than the server takes.
    pub fn too_big(&mut self) -> Option<String> {
        if self.too_big {
            return None;
        }
        self.too_big = true;
        Some(format!("phone view: a frame is over {} KB; skipping it.", MAX_BYTES / 1024))
    }
}

// Sending.

enum Message {
    Stop,
}

/// What one try came to.
enum Step {
    /// No game to show.
    Idle,
    TooBig,
    /// Taken; this many phones are watching.
    Sent(u32),
    /// The server refused the key.
    Unauthorized,
    Refused(String),
    Later(String, Option<Duration>),
}

fn send_one(agent: &ureq::Agent, config: &Config, shared: &Shared, build: &Build, seq: &AtomicU64) -> Step {
    let Some(frame) = build(shared) else {
        return Step::Idle;
    };
    let Some(text) = body(seq.fetch_add(1, Ordering::SeqCst), crate::util::now_ms(), &frame) else {
        return Step::TooBig;
    };
    match net::post_live(agent, config, &text) {
        Ok(viewers) => Step::Sent(viewers),
        Err(SendError::Unauthorized) => Step::Unauthorized,
        Err(SendError::Rejected(reason)) => Step::Refused(reason),
        Err(SendError::Later { reason, after }) => Step::Later(reason, after),
    }
}

/// The thread that sends the panel to the phone view. Dropping it tells the thread to finish (a request in flight is not waited for).
pub struct Worker {
    tx: mpsc::Sender<Message>,
    stop: Arc<AtomicBool>,
}

fn run_loop(
    config: &Config,
    shared: &Shared,
    hooks: &Hooks,
    build: &Build,
    seq: &AtomicU64,
    rx: &mpsc::Receiver<Message>,
    mut schedule: Schedule,
) {
    let agent = net::live_agent();
    let started = Instant::now();
    let clock = || started.elapsed().as_millis() as u64;
    let mut notes = Notes::default();
    let say = |line: Option<String>| {
        if let Some(line) = line {
            (hooks.say)(line);
        }
    };
    loop {
        let begun = clock();
        if schedule.due(begun) {
            match send_one(&agent, config, shared, build, seq) {
                Step::Idle => {
                    schedule.nothing_to_send(clock());
                    shared.set_phone_viewers(0);
                }
                Step::TooBig => {
                    schedule.skipped(clock());
                    shared.set_phone_viewers(0);
                    say(notes.too_big());
                }
                Step::Sent(viewers) => {
                    schedule.sent(begun, clock(), viewers);
                    shared.set_phone_viewers(viewers);
                    say(notes.success());
                }
                Step::Unauthorized => {
                    shared.set_phone_viewers(0);
                    (hooks.say)("phone view: the server no longer accepts this computer's key; stopping (pair again).".into());
                    return;
                }
                Step::Refused(reason) => {
                    schedule.skipped(clock());
                    shared.set_phone_viewers(0);
                    say(notes.refused(&reason));
                }
                Step::Later(reason, after) => {
                    schedule.failed(clock(), after);
                    shared.set_phone_viewers(0);
                    say(notes.failure(&reason));
                }
            }
        }
        match rx.recv_timeout(schedule.wait(clock()).min(LOOK)) {
            Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => {
                shared.set_phone_viewers(0);
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

impl Worker {
    /// Starts the thread, or not: an unpaired computer (no connection, or one with no server or no key) sends nothing.
    pub fn start_if_paired(config: Option<Config>, shared: Arc<Shared>, hooks: Hooks, build: Build) -> Option<Worker> {
        Worker::start_with(config, shared, hooks, build, Schedule::standard())
    }

    /// The same with the times of `schedule` (the tests use short ones).
    fn start_with(config: Option<Config>, shared: Arc<Shared>, hooks: Hooks, build: Build, schedule: Schedule) -> Option<Worker> {
        let config = config.filter(|c| !c.server.is_empty() && !c.token.is_empty())?;
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        // Kept across a restart by the supervisor: the numbers only go up for as long as this thread lives.
        let seq = AtomicU64::new(0);
        std::thread::spawn(move || {
            supervise(
                supervisor::title(supervisor::LIVE),
                &Policy::default(),
                &|| stopped.load(Ordering::SeqCst),
                &|line| (hooks.say)(line),
                &|health| (hooks.worker)(health),
                || run_loop(&config, &shared, &hooks, &build, &seq, &rx, schedule.clone()),
            );
        });
        Some(Worker { tx, stop })
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Message::Stop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stub::{Recorded, Reply, Stub};
    use std::sync::atomic::AtomicU32;
    use std::sync::Mutex;

    fn config_for(url: &str) -> Config {
        Config {
            server: url.into(),
            token: "xpd_test".into(),
            device_name: "RIG".into(),
            account: None,
            auto_update: true,
            phone_view: true,
        }
    }

    fn frame() -> Frame {
        Frame {
            game: "lmu".into(),
            dashboard: "race",
            rows: vec![vec!["times"], vec!["session", "flag"]],
            model: json!({ "gear": { "text": "3" }, "speed": { "text": "212" } }),
        }
    }

    fn quick() -> Schedule {
        Schedule::new(
            Duration::from_millis(20),
            Duration::from_millis(300),
            Duration::from_millis(20),
            [100, 200, 400, 800].map(Duration::from_millis),
        )
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let started = Instant::now();
        while !done() {
            assert!(started.elapsed() < Duration::from_secs(10), "gave up waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_game_id_is_what_the_server_takes() {
        for good in ["lmu", "ac", "f124", "wreckfest2", "a_b"] {
            assert!(valid_game(good), "{good}");
        }
        for bad in ["", "LMU", "2k", "_a", "a-b", "a b", "é", &"a".repeat(33)] {
            assert!(!valid_game(bad), "{bad}");
        }
        assert!(valid_game(&"a".repeat(32)));
    }

    #[test]
    fn the_body_carries_the_contract_and_a_frame_over_64_kb_is_not_sent() {
        let text = body(7, 1_763_550_000_000, &frame()).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["v"], 1);
        assert_eq!(value["seq"], 7);
        assert_eq!(value["sentAt"], 1_763_550_000_000_i64);
        assert_eq!(value["game"], "lmu");
        assert_eq!(value["dashboard"], "race");
        assert_eq!(value["rows"], json!([["times"], ["session", "flag"]]));
        assert_eq!(value["model"]["gear"]["text"], "3");
        let mut big = frame();
        big.model = json!({ "pad": "x".repeat(MAX_BYTES) });
        assert_eq!(body(0, 0, &big), None);
        // Just under the limit goes.
        let mut empty = frame();
        empty.model = json!({ "pad": "" });
        let overhead = body(0, 0, &empty).unwrap().len();
        big.model = json!({ "pad": "x".repeat(MAX_BYTES - overhead) });
        assert_eq!(body(0, 0, &big).map(|t| t.len()), Some(MAX_BYTES));
        big.model = json!({ "pad": "x".repeat(MAX_BYTES - overhead + 1) });
        assert_eq!(body(0, 0, &big), None);
    }

    #[test]
    fn a_frame_every_two_seconds_without_viewers_and_ten_a_second_with_them() {
        let mut schedule = Schedule::standard();
        assert!(schedule.due(0), "the first frame goes at once");
        schedule.sent(0, 30, 0);
        assert!(!schedule.due(1_999));
        assert!(schedule.due(2_000), "2 s after the one before, not after its answer");
        // A phone opens the page: the answer says so, and the pace is 100 ms.
        schedule.sent(2_000, 2_030, 1);
        assert!(!schedule.due(2_099));
        assert!(schedule.due(2_100));
        schedule.sent(2_100, 2_130, 2);
        assert_eq!(schedule.wait(2_130), Duration::from_millis(70));
        // A slow answer is not followed by a burst: the next is due as soon as it came.
        schedule.sent(2_200, 2_650, 2);
        assert!(schedule.due(2_650));
        assert_eq!(schedule.wait(2_650), Duration::ZERO);
        // The last phone closes the page.
        schedule.sent(2_650, 2_680, 0);
        assert!(!schedule.due(4_649));
        assert!(schedule.due(4_650));
    }

    #[test]
    fn with_no_game_nothing_is_sent_and_it_is_looked_for_again_soon() {
        let mut schedule = Schedule::standard();
        schedule.sent(0, 10, 3);
        schedule.nothing_to_send(1_000);
        assert!(!schedule.due(1_499));
        assert!(schedule.due(1_500));
        schedule.skipped(1_500);
        assert!(!schedule.due(3_499));
        assert!(schedule.due(3_500), "a frame that was not sent waits a slow period");
    }

    #[test]
    fn a_failure_waits_1_2_5_then_10_seconds_or_what_the_server_says_and_working_resets_it() {
        let mut schedule = Schedule::standard();
        let mut now = 0;
        for wait in [1_000, 2_000, 5_000, 10_000, 10_000, 10_000] {
            schedule.failed(now, None);
            assert!(!schedule.due(now + wait - 1), "{wait}");
            assert!(schedule.due(now + wait), "{wait}");
            now += wait;
        }
        schedule.sent(now, now + 20, 0);
        schedule.failed(now + 2_000, None);
        assert!(schedule.due(now + 3_000) && !schedule.due(now + 2_999), "back to the first wait");
        // Its own wait, longer or shorter than the backoff.
        schedule.failed(0, Some(Duration::from_secs(30)));
        assert!(!schedule.due(29_999));
        assert!(schedule.due(30_000));
        schedule.failed(0, Some(Duration::from_secs(1)));
        assert!(schedule.due(1_000));
    }

    #[test]
    fn the_log_says_when_sending_starts_to_fail_and_when_it_works_again_and_nothing_else() {
        let mut notes = Notes::default();
        assert_eq!(notes.success(), None);
        assert!(notes
            .failure("cannot reach the server")
            .unwrap()
            .contains("cannot reach the server"));
        assert_eq!(notes.failure("again"), None);
        assert!(notes.success().is_some());
        assert_eq!(notes.success(), None);
        assert!(notes.too_big().unwrap().contains("64 KB"));
        assert_eq!(notes.too_big(), None);
        assert!(notes.refused("refused (413)").is_some());
        assert_eq!(notes.refused("refused (413)"), None);
        assert_eq!(notes.success(), None, "a skipped frame is not a failure to recover from");
        assert!(notes.too_big().is_some(), "said again after sending worked");
    }

    /// What a worker test needs: the shared state, the lines the log got, the hooks, and a switch for a live game.
    struct Rig {
        shared: Arc<Shared>,
        lines: Arc<Mutex<Vec<String>>>,
        hooks: Hooks,
        live: Arc<AtomicBool>,
        build: Build,
    }

    fn rig() -> Rig {
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = lines.clone();
        let live = Arc::new(AtomicBool::new(true));
        let on = live.clone();
        Rig {
            shared: Shared::new(true),
            lines,
            hooks: Hooks {
                say: Arc::new(move |line| seen.lock().unwrap().push(line)),
                worker: Arc::new(|_| {}),
            },
            live,
            build: Arc::new(move |_| on.load(Ordering::SeqCst).then(frame)),
        }
    }

    fn start(rig: &Rig, stub: &Stub) -> Worker {
        Worker::start_with(
            Some(config_for(&stub.url)),
            rig.shared.clone(),
            rig.hooks.clone(),
            rig.build.clone(),
            quick(),
        )
        .expect("paired")
    }

    fn make(rig: &Rig, config: Option<Config>) -> Option<Worker> {
        Worker::start_with(config, rig.shared.clone(), rig.hooks.clone(), rig.build.clone(), quick())
    }

    fn posts(stub: &Stub) -> Vec<Recorded> {
        stub.requests().into_iter().filter(|r| r.path == "/api/sim/live").collect()
    }

    fn said(rig: &Rig) -> Vec<String> {
        rig.lines.lock().unwrap().clone()
    }

    #[test]
    fn a_frame_goes_with_the_device_key_and_the_pace_follows_the_viewers_the_server_counts() {
        let viewers = Arc::new(AtomicU32::new(0));
        let counted = viewers.clone();
        let stub = Stub::start(move |_: &Recorded| {
            let n = counted.load(Ordering::SeqCst);
            Reply::new(200, &format!(r#"{{"viewers":{n}}}"#))
        });
        let rig = rig();
        let worker = start(&rig, &stub);
        wait_until("the first frame", || !posts(&stub).is_empty());
        let first = posts(&stub).remove(0);
        assert_eq!(first.method, "POST");
        assert_eq!(first.headers["authorization"], "Bearer xpd_test");
        assert_eq!(first.headers["content-type"], "application/json");
        let value: Value = serde_json::from_slice(&first.body).unwrap();
        assert_eq!((value["v"].as_i64(), value["seq"].as_i64()), (Some(1), Some(0)));
        assert_eq!(value["game"], "lmu");
        assert_eq!(value["rows"], json!([["times"], ["session", "flag"]]));
        assert!(value["sentAt"].as_i64().unwrap() > 1_700_000_000_000);
        // No phone: one every 300 ms here, not one every 20.
        std::thread::sleep(Duration::from_millis(1_000));
        let slow = posts(&stub).len();
        assert!((2..=6).contains(&slow), "{slow} frames in a second without viewers");
        assert_eq!(rig.shared.phone_viewers(), 0);
        // A phone opens the page: the next answer says so and the pace picks up.
        viewers.store(1, Ordering::SeqCst);
        wait_until("the viewers", || rig.shared.phone_viewers() == 1);
        let before = posts(&stub).len();
        wait_until("a fast pace", || posts(&stub).len() >= before + 10);
        // The numbers only go up, from 0, one a frame.
        let seqs: Vec<i64> = posts(&stub)
            .iter()
            .map(|r| serde_json::from_slice::<Value>(&r.body).unwrap()["seq"].as_i64().unwrap())
            .collect();
        assert_eq!(seqs, (0..seqs.len() as i64).collect::<Vec<_>>());
        // It closes again.
        viewers.store(0, Ordering::SeqCst);
        wait_until("no viewers", || rig.shared.phone_viewers() == 0);
        drop(worker);
        assert!(said(&rig).is_empty(), "{:?}", said(&rig));
    }

    #[test]
    fn nothing_is_sent_without_a_live_game_and_sending_starts_when_one_comes_and_stops_with_the_worker() {
        let stub = Stub::start(|_: &Recorded| Reply::new(200, r#"{"viewers":1}"#));
        let rig = rig();
        rig.live.store(false, Ordering::SeqCst);
        let worker = start(&rig, &stub);
        std::thread::sleep(Duration::from_millis(400));
        assert!(posts(&stub).is_empty(), "no game, no frame");
        rig.live.store(true, Ordering::SeqCst);
        wait_until("a frame", || !posts(&stub).is_empty());
        wait_until("the viewers", || rig.shared.phone_viewers() == 1);
        rig.live.store(false, Ordering::SeqCst);
        wait_until("no viewers", || rig.shared.phone_viewers() == 0);
        let sent = posts(&stub).len();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(posts(&stub).len(), sent, "the game closed: nothing more");
        rig.live.store(true, Ordering::SeqCst);
        wait_until("a frame again", || posts(&stub).len() > sent);
        drop(worker);
        std::thread::sleep(Duration::from_millis(100));
        let stopped = posts(&stub).len();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(posts(&stub).len(), stopped, "switched off: nothing more");
        assert_eq!(rig.shared.phone_viewers(), 0);
    }

    #[test]
    fn an_unpaired_computer_starts_no_worker_and_sends_nothing() {
        let stub = Stub::start(|_: &Recorded| Reply::new(200, r#"{"viewers":0}"#));
        let rig = rig();
        assert!(make(&rig, None).is_none(), "no pairing, no thread");
        for broken in [
            Config {
                server: String::new(),
                ..config_for(&stub.url)
            },
            Config {
                token: String::new(),
                ..config_for(&stub.url)
            },
        ] {
            assert!(make(&rig, Some(broken)).is_none());
        }
        std::thread::sleep(Duration::from_millis(100));
        assert!(posts(&stub).is_empty());
    }

    #[test]
    fn a_refused_key_stops_the_worker_and_says_so_once_without_the_key() {
        let stub = Stub::start(|_: &Recorded| Reply::new(401, r#"{"error":"unauthorized","retryable":false}"#));
        let rig = rig();
        let worker = start(&rig, &stub);
        wait_until("the line", || !said(&rig).is_empty());
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(posts(&stub).len(), 1, "no second frame after a refusal");
        let lines = said(&rig);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("no longer accepts") && !lines[0].contains("xpd_test"));
        assert_eq!(rig.shared.phone_viewers(), 0);
        drop(worker);
    }

    #[test]
    fn a_rate_limit_waits_as_long_as_the_server_says() {
        let times = Arc::new(Mutex::new(Vec::<Instant>::new()));
        let noted = times.clone();
        let stub = Stub::start(move |_: &Recorded| {
            let mut times = noted.lock().unwrap();
            times.push(Instant::now());
            if times.len() == 1 {
                Reply::new(429, r#"{"error":"too_many_requests","retryable":true}"#).header("Retry-After", "1")
            } else {
                Reply::new(200, r#"{"viewers":0}"#)
            }
        });
        let rig = rig();
        let worker = start(&rig, &stub);
        wait_until("the second frame", || posts(&stub).len() >= 2);
        let times = times.lock().unwrap().clone();
        assert!(
            times[1].duration_since(times[0]) >= Duration::from_millis(950),
            "the second came after {:?}",
            times[1].duration_since(times[0])
        );
        drop(worker);
        let lines = said(&rig);
        assert_eq!(lines.len(), 2, "one when it started to fail, one when it worked again: {lines:?}");
        assert!(lines[0].contains("429") && lines[1].contains("again"));
    }

    #[test]
    fn a_failing_server_is_tried_again_after_growing_waits_with_one_line_for_failing_and_one_for_recovering() {
        let times = Arc::new(Mutex::new(Vec::<Instant>::new()));
        let healthy = Arc::new(AtomicBool::new(false));
        let (noted, well) = (times.clone(), healthy.clone());
        let stub = Stub::start(move |_: &Recorded| {
            noted.lock().unwrap().push(Instant::now());
            if well.load(Ordering::SeqCst) {
                Reply::new(200, r#"{"viewers":0}"#)
            } else {
                Reply::new(503, r#"{"error":"unavailable","retryable":true}"#)
            }
        });
        let rig = rig();
        let worker = start(&rig, &stub);
        wait_until("four tries", || posts(&stub).len() >= 4);
        let at = times.lock().unwrap().clone();
        let gap = |i: usize| at[i + 1].duration_since(at[i]);
        assert!(gap(0) >= Duration::from_millis(90), "{:?}", gap(0));
        assert!(gap(1) >= Duration::from_millis(190), "{:?}", gap(1));
        assert!(gap(2) >= Duration::from_millis(390), "{:?}", gap(2));
        assert_eq!(said(&rig).len(), 1, "one line for the whole failure: {:?}", said(&rig));
        healthy.store(true, Ordering::SeqCst);
        wait_until("the recovery line", || said(&rig).len() == 2);
        drop(worker);
        let lines = said(&rig);
        assert!(lines[0].contains("503") && lines[1].contains("again"), "{lines:?}");
        assert!(lines.iter().all(|line| !line.contains("xpd_test")));
    }

    #[test]
    fn a_frame_the_server_says_is_too_big_is_said_once_and_sending_goes_on() {
        let stub = Stub::start(|_: &Recorded| Reply::new(413, r#"{"error":"too_large","retryable":false}"#));
        let rig = rig();
        let worker = start(&rig, &stub);
        wait_until("three frames", || posts(&stub).len() >= 3);
        drop(worker);
        let lines = said(&rig);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("413") && !lines[0].contains("xpd_test"));
    }

    #[test]
    fn a_frame_over_the_limit_is_not_sent_and_is_said_once() {
        let stub = Stub::start(|_: &Recorded| Reply::new(200, r#"{"viewers":0}"#));
        let mut rig = rig();
        rig.build = Arc::new(|_| {
            Some(Frame {
                model: json!({ "pad": "x".repeat(MAX_BYTES) }),
                ..frame()
            })
        });
        let worker = start(&rig, &stub);
        wait_until("the line", || !said(&rig).is_empty());
        std::thread::sleep(Duration::from_millis(700));
        drop(worker);
        assert!(posts(&stub).is_empty());
        assert_eq!(said(&rig).len(), 1, "{:?}", said(&rig));
    }
}
