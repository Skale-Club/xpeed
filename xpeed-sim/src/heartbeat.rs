//! The heartbeat: while Xpeed Companion runs and this computer is connected to an account, it tells the server so, once a
//! minute and at once when a game connects or goes away. The site shows a computer as Online by this (until now it only knew
//! of a computer when it sent a lap, so one that was running but had not finished a lap for hours looked switched off).
//!
//! What goes: the version of this program, what it is doing (`idle`, `waiting` for a game, `connected` to one), the id of
//! that game, and how many laps are waiting to be sent. Nothing else: no name, no path, no account, no laps. The contract is
//! `docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md`, section 2c.
//!
//! The heartbeat has a thread of its own, looked after by the supervisor like the uploader, and never touches the reading of the
//! games: it only looks at the shared status and sends a request of a few dozen bytes (fine during a game). A failure is a quiet
//! retry with the waits of the uploader (30 s doubling to 5 min); a key the server refuses ends the heartbeat (the uploader says so
//! to the person); an unpaired computer does not start one.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::config::Config;
use crate::net::{self, SendError};
use crate::outbox::{count_pending_laps, Backoff};
use crate::status::{Game, Shared};
use crate::supervisor::{self, supervise, Health, Policy};

/// The version the server is told.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// How often a heartbeat goes when nothing changes. The site calls a computer online when it heard from it in the last 3 minutes.
pub const EVERY: Duration = Duration::from_secs(60);
/// The least time between two tries, so a game that flickers does not make a request each time.
pub const MIN_GAP: Duration = Duration::from_secs(5);
/// A count of waiting laps above this is sent as this (the server caps it too).
pub const MAX_PENDING: usize = 1_000_000;

/// What Xpeed Companion is doing, in the words the server stores.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// Reading is paused by the person.
    Idle,
    /// Running, waiting for a game to share data.
    Waiting,
    /// A game is sharing data (connected, or recording a lap).
    Connected,
}

impl State {
    pub fn word(self) -> &'static str {
        match self {
            State::Idle => "idle",
            State::Waiting => "waiting",
            State::Connected => "connected",
        }
    }
}

/// What a heartbeat says about the program: the state and the game it is about. A change in either is worth a heartbeat right away.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct View {
    pub state: State,
    /// The game's id (`ac`, `ams2`, `lmu`...) while connected, else none.
    pub game: Option<&'static str>,
}

impl View {
    /// Nothing is connected: the state before any reader has said anything.
    pub const WAITING: View = View {
        state: State::Waiting,
        game: None,
    };
}

/// The view of what every game reader says (`(id, state)`, by id) and whether the person paused reading. Paused beats everything; a
/// game that is recording or connected makes it `Connected` (recording first); a game that is open but shares nothing, or that this
/// build cannot read, is still waiting.
pub fn view_of<'a>(games: impl IntoIterator<Item = (&'a &'static str, &'a Game)>, paused: bool) -> View {
    if paused {
        return View {
            state: State::Idle,
            game: None,
        };
    }
    let mut best: Option<(u8, &'static str)> = None;
    for (id, game) in games {
        let rank = match game {
            Game::Recording(_) => 2,
            Game::Connected => 1,
            _ => 0,
        };
        // The first of the highest rank (the games come in order of id), so the same readings always give the same answer.
        if rank > 0 && best.is_none_or(|(top, _)| rank > top) {
            best = Some((rank, *id));
        }
    }
    match best {
        Some((_, id)) => View {
            state: State::Connected,
            game: Some(id),
        },
        None => View::WAITING,
    }
}

/// The body of a heartbeat: exactly these four fields. `pending` is the number of laps waiting to be sent.
pub fn payload(version: &str, view: &View, pending: usize) -> String {
    json!({
        "version": version,
        "state": view.state.word(),
        "game": view.game,
        "pendingLaps": pending.min(MAX_PENDING),
    })
    .to_string()
}

/// When the next heartbeat is due, as plain numbers: times are milliseconds on any clock that only goes forward, so the tests move
/// the clock by hand.
#[derive(Clone)]
pub struct Schedule {
    every: u64,
    min_gap: u64,
    backoff: Backoff,
    /// What the last heartbeat the server took said, and when.
    last_ok: Option<(u64, View)>,
    last_try: Option<u64>,
    /// The last try failed: the next one is due as soon as the wait is over, whatever the view.
    retrying: bool,
    not_before: u64,
    delay: Duration,
}

impl Schedule {
    pub fn new(every: Duration, min_gap: Duration, backoff: Backoff) -> Schedule {
        Schedule {
            every: every.as_millis() as u64,
            min_gap: min_gap.as_millis() as u64,
            backoff,
            last_ok: None,
            last_try: None,
            retrying: false,
            not_before: 0,
            delay: backoff.base,
        }
    }

    /// The schedule of a running program.
    pub fn standard() -> Schedule {
        Schedule::new(EVERY, MIN_GAP, Backoff::default())
    }

    /// Whether a heartbeat should go now, when the program looks like `view`: the first one at the start, then one every
    /// minute, one when the view changed (not twice within `min_gap`), and a retry once the wait after a failure is over.
    pub fn due(&self, now: u64, view: &View) -> bool {
        if now < self.not_before {
            return false;
        }
        let Some((at, said)) = self.last_ok else { return true };
        if self.retrying || now.saturating_sub(at) >= self.every {
            return true;
        }
        *view != said && self.gap_left(now) == 0
    }

    fn gap_left(&self, now: u64) -> u64 {
        self.last_try.map_or(0, |at| (at + self.min_gap).saturating_sub(now))
    }

    /// How long until `due` can say yes (for the thread to sleep; a message about a change wakes it sooner).
    pub fn wait(&self, now: u64, view: &View) -> Duration {
        let hold = self.not_before.saturating_sub(now);
        let ms = match self.last_ok {
            None => hold,
            Some(_) if self.retrying => hold,
            Some((at, said)) => {
                let periodic = (at + self.every).saturating_sub(now);
                let soon = if *view != said { self.gap_left(now) } else { periodic };
                soon.min(periodic).max(hold)
            }
        };
        Duration::from_millis(ms)
    }

    /// A heartbeat went and the server took it.
    pub fn sent(&mut self, now: u64, view: View) {
        self.last_ok = Some((now, view));
        self.last_try = Some(now);
        self.retrying = false;
        self.not_before = 0;
        self.delay = self.backoff.base;
    }

    /// A heartbeat did not go: try again after the server's own wait if it gave one, else after a wait that doubles (30 s up to 5 min).
    pub fn failed(&mut self, now: u64, after: Option<Duration>) {
        let wait = after.unwrap_or(self.delay).max(self.backoff.base);
        self.delay = (self.delay * 2).min(self.backoff.max);
        self.last_try = Some(now);
        self.retrying = true;
        self.not_before = now + wait.as_millis() as u64;
    }
}

/// Which lines the log gets: one when the server first hears the program (or hears it again after a failure) and one when a failure
/// starts, never one for each minute.
#[derive(Debug, Default)]
pub struct Notes {
    failing: bool,
    heard: bool,
}

impl Notes {
    pub fn success(&mut self) -> Option<String> {
        if self.heard && !self.failing {
            return None;
        }
        let again = self.failing;
        self.heard = true;
        self.failing = false;
        Some(if again {
            "heartbeat: the server hears this computer again.".into()
        } else {
            "heartbeat: the server hears this computer.".into()
        })
    }

    pub fn failure(&mut self, reason: &str) -> Option<String> {
        if self.failing {
            return None;
        }
        self.failing = true;
        Some(format!("heartbeat: could not reach the server ({reason}); trying again quietly."))
    }
}

/// Where the heartbeat thread reports to: lines for the log, and how the thread itself stands (it is restarted when it panics).
#[derive(Clone)]
pub struct Hooks {
    pub say: Arc<dyn Fn(String) + Send + Sync>,
    pub worker: Arc<dyn Fn(Health) + Send + Sync>,
}

enum Message {
    /// The state may have changed: look at it.
    Wake,
    Stop,
}

/// The thread that sends heartbeats. Dropping it tells the thread to finish (a request in flight is not waited for).
pub struct Heartbeat {
    tx: mpsc::Sender<Message>,
    stop: Arc<AtomicBool>,
}

/// One pass of the loop's decision, apart from the thread so a test can drive it with a clock it moves by hand: sends if a heartbeat is
/// due and updates the schedule. Returns `Err(())` when the server refused the key (the loop ends).
pub fn tick(
    schedule: &mut Schedule,
    notes: &mut Notes,
    now: u64,
    view: View,
    send: &mut dyn FnMut(&View) -> Result<(), SendError>,
    say: &dyn Fn(String),
) -> Result<(), ()> {
    if !schedule.due(now, &view) {
        return Ok(());
    }
    match send(&view) {
        Ok(()) => {
            schedule.sent(now, view);
            if let Some(line) = notes.success() {
                say(line);
            }
        }
        Err(SendError::Unauthorized) => {
            say("heartbeat: the server no longer accepts this computer's key; stopping (pair again).".into());
            return Err(());
        }
        // Not worth giving up on either way: the server may be busy, older, or briefly wrong.
        Err(SendError::Rejected(reason)) => {
            schedule.failed(now, Some(Duration::from_secs(300)));
            if let Some(line) = notes.failure(&reason) {
                say(line);
            }
        }
        Err(SendError::Later { reason, after }) => {
            schedule.failed(now, after);
            if let Some(line) = notes.failure(&reason) {
                say(line);
            }
        }
    }
    Ok(())
}

fn run_loop(dir: &std::path::Path, config: &Config, shared: &Shared, hooks: &Hooks, rx: &mpsc::Receiver<Message>, mut schedule: Schedule) {
    let agent = net::heartbeat_agent();
    let started = Instant::now();
    let clock = || started.elapsed().as_millis() as u64;
    let mut notes = Notes::default();
    loop {
        let view = shared.heartbeat_view();
        let mut send = |view: &View| {
            let pending = count_pending_laps(dir, &config.server);
            net::send_heartbeat(&agent, config, &payload(VERSION, view, pending))
        };
        if tick(&mut schedule, &mut notes, clock(), view, &mut send, &|line| (hooks.say)(line)).is_err() {
            return;
        }
        // Never a busy loop: at least a moment between two looks, whatever the schedule says.
        let wait = schedule.wait(clock(), &shared.heartbeat_view()).max(Duration::from_millis(50));
        match rx.recv_timeout(wait) {
            Ok(Message::Wake) | Err(RecvTimeoutError::Timeout) => {}
            Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

impl Heartbeat {
    /// Starts the thread, or not: an unpaired computer (no connection, or one with no server or no key) sends nothing.
    pub fn start_if_paired(config: Option<Config>, dir: PathBuf, shared: Arc<Shared>, hooks: Hooks) -> Option<Heartbeat> {
        Heartbeat::start_with(config, dir, shared, hooks, Schedule::standard())
    }

    /// The same with the times of `schedule` (the tests use short ones).
    fn start_with(config: Option<Config>, dir: PathBuf, shared: Arc<Shared>, hooks: Hooks, schedule: Schedule) -> Option<Heartbeat> {
        let config = config.filter(|c| !c.server.is_empty() && !c.token.is_empty())?;
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        std::thread::spawn(move || {
            supervise(
                supervisor::title(supervisor::HEARTBEAT),
                &Policy::default(),
                &|| stopped.load(Ordering::SeqCst),
                &|line| (hooks.say)(line),
                &|health| (hooks.worker)(health),
                || run_loop(&dir, &config, &shared, &hooks, &rx, schedule.clone()),
            );
        });
        Some(Heartbeat { tx, stop })
    }

    /// The state may have changed (a game connected or went away, reading was paused or resumed).
    pub fn wake(&self) {
        let _ = self.tx.send(Message::Wake);
    }
}

impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Message::Stop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stub::{Recorded, Reply, Stub};
    use serde_json::Value;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    const MIN: u64 = 60_000;

    fn connected(game: &'static str) -> View {
        View {
            state: State::Connected,
            game: Some(game),
        }
    }

    fn standard() -> Schedule {
        Schedule::standard()
    }

    /// The times of a running heartbeat, a thousand times faster (a tenth of a second where it is a minute).
    fn quick() -> Schedule {
        Schedule::new(
            Duration::from_secs(60),
            Duration::from_millis(50),
            Backoff {
                base: Duration::from_millis(100),
                max: Duration::from_millis(400),
            },
        )
    }

    #[test]
    fn the_payload_has_exactly_the_four_fields_and_nothing_personal() {
        let body: Value = serde_json::from_str(&payload("0.7.0", &connected("ams2"), 3)).unwrap();
        assert_eq!(
            body,
            json!({ "version": "0.7.0", "state": "connected", "game": "ams2", "pendingLaps": 3 })
        );
        let waiting: Value = serde_json::from_str(&payload("0.7.0", &View::WAITING, 0)).unwrap();
        assert_eq!(
            waiting,
            json!({ "version": "0.7.0", "state": "waiting", "game": null, "pendingLaps": 0 })
        );
        let idle = View {
            state: State::Idle,
            game: None,
        };
        assert_eq!(serde_json::from_str::<Value>(&payload("0.7.0", &idle, 1)).unwrap()["state"], "idle");
        // The keys are the contract: a field added by mistake (a name, a path) would show here.
        let keys: Vec<String> = body.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["game", "pendingLaps", "state", "version"]);
        // A pile of laps is capped like the server caps it, and the running version is the one in Cargo.toml.
        let huge: Value = serde_json::from_str(&payload(VERSION, &View::WAITING, usize::MAX)).unwrap();
        assert_eq!(huge["pendingLaps"], MAX_PENDING);
        assert_eq!(huge["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn the_state_is_what_the_readers_say() {
        let say = |games: &[(&'static str, Game)], paused: bool| {
            let map: BTreeMap<&'static str, Game> = games.iter().cloned().collect();
            view_of(&map, paused)
        };
        assert_eq!(say(&[], false), View::WAITING);
        assert_eq!(say(&[("ac", Game::Waiting), ("ams2", Game::Waiting)], false), View::WAITING);
        // Open but sharing nothing, or a game this build cannot read: still waiting for a game.
        assert_eq!(
            say(&[("ac", Game::Silent), ("f1", Game::Loading), ("lmu", Game::Unsupported)], false),
            View::WAITING
        );
        assert_eq!(say(&[("ac", Game::Connected)], false), connected("ac"));
        assert_eq!(
            say(&[("ac", Game::Waiting), ("ams2", Game::Recording(4))], false),
            connected("ams2")
        );
        // Recording beats connected; among equals the first id wins, so the same readings always say the same thing.
        assert_eq!(
            say(&[("ac", Game::Connected), ("ams2", Game::Recording(1))], false),
            connected("ams2")
        );
        assert_eq!(say(&[("ac", Game::Connected), ("ams2", Game::Connected)], false), connected("ac"));
        // Paused by the person beats everything, and names no game.
        let idle = View {
            state: State::Idle,
            game: None,
        };
        assert_eq!(say(&[("ac", Game::Recording(2))], true), idle);
        assert_eq!(say(&[], true), idle);
        // A game the reader paused (reading is off) is not connected.
        assert_eq!(say(&[("ac", Game::Paused)], false), View::WAITING);
    }

    #[test]
    fn the_first_heartbeat_goes_at_the_start_and_then_one_every_minute() {
        let mut schedule = standard();
        let view = View::WAITING;
        assert!(schedule.due(0, &view), "at the start");
        schedule.sent(0, view);
        for now in [1, 5_000, 30_000, MIN - 1] {
            assert!(!schedule.due(now, &view), "{now} ms: not yet");
        }
        assert!(schedule.due(MIN, &view), "a minute after the last one");
        schedule.sent(MIN + 120, view);
        assert!(!schedule.due(2 * MIN, &view), "the minute counts from the last one that was taken");
        assert!(schedule.due(2 * MIN + 120, &view));
    }

    #[test]
    fn how_long_to_sleep_is_the_time_to_the_next_one() {
        let mut schedule = standard();
        assert_eq!(schedule.wait(0, &View::WAITING), Duration::ZERO, "the first one is due");
        schedule.sent(1_000, View::WAITING);
        assert_eq!(schedule.wait(1_000, &View::WAITING), Duration::from_secs(60));
        assert_eq!(schedule.wait(31_000, &View::WAITING), Duration::from_secs(30));
        assert_eq!(schedule.wait(70_000, &View::WAITING), Duration::ZERO, "overdue");
        // A change shows within the gap, never later than the minute.
        assert_eq!(schedule.wait(1_500, &connected("ac")), Duration::from_millis(4_500));
        assert_eq!(schedule.wait(7_000, &connected("ac")), Duration::ZERO);
    }

    #[test]
    fn a_change_of_game_state_goes_at_once_but_not_twice_within_the_gap() {
        let mut schedule = standard();
        schedule.sent(10_000, View::WAITING);
        // A game connects 1 s later: it is a change, but the gap since the last try is not over.
        assert!(!schedule.due(11_000, &connected("ams2")), "within the gap of the last one");
        assert!(schedule.due(15_000, &connected("ams2")), "5 s after the last one: it goes");
        schedule.sent(15_000, connected("ams2"));
        // Nothing changed since: nothing to send until the minute is over.
        assert!(!schedule.due(16_000, &connected("ams2")));
        assert!(!schedule.due(40_000, &connected("ams2")));
        // The game closes: a change again, and a flicker back right after waits its turn.
        assert!(schedule.due(20_000, &View::WAITING));
        schedule.sent(20_000, View::WAITING);
        assert!(!schedule.due(21_000, &connected("ams2")));
        assert!(schedule.due(25_000, &connected("ams2")));
        // Another game is a change too.
        schedule.sent(25_000, connected("ams2"));
        assert!(schedule.due(30_000, &connected("ac")));
    }

    #[test]
    fn a_failure_waits_like_the_uploader_does_and_a_success_starts_over() {
        let mut schedule = standard();
        let view = View::WAITING;
        schedule.sent(0, view);
        // The minute is over, the server does not answer: 30 s, 60 s, 120 s, 240 s, then 300 s at most.
        let mut now = MIN;
        let mut waits = Vec::new();
        for _ in 0..6 {
            assert!(schedule.due(now, &view));
            schedule.failed(now, None);
            let next = (now..now + 400_000).find(|t| schedule.due(*t, &view)).unwrap();
            waits.push((next - now) / 1000);
            assert_eq!(schedule.wait(now, &view), Duration::from_millis(next - now));
            now = next;
        }
        assert_eq!(waits, [30, 60, 120, 240, 300, 300]);
        // Not even a change of state goes during the wait.
        schedule.failed(now, None);
        assert!(!schedule.due(now + 6_000, &connected("ac")));
        // The server asked for a longer wait: that is the wait; a shorter one is not trusted below the base.
        schedule.failed(now, Some(Duration::from_secs(600)));
        assert!(!schedule.due(now + 599_000, &view) && schedule.due(now + 600_000, &view));
        schedule.failed(now, Some(Duration::from_secs(1)));
        assert!(!schedule.due(now + 29_000, &view) && schedule.due(now + 30_000, &view));
        // The server took one: the waits start from 30 s again and the usual minute runs.
        schedule.sent(now + 30_000, view);
        schedule.failed(now + 30_000 + MIN, None);
        assert!(!schedule.due(now + 30_000 + MIN + 29_000, &view));
        assert!(schedule.due(now + 30_000 + MIN + 30_000, &view));
    }

    #[test]
    fn the_log_gets_a_line_on_the_first_success_and_the_first_success_after_a_failure_only() {
        let mut notes = Notes::default();
        assert!(notes.success().unwrap().contains("hears this computer."), "the first");
        for _ in 0..30 {
            assert_eq!(notes.success(), None, "not one a minute");
        }
        let failure = notes.failure("cannot reach the server").unwrap();
        assert!(failure.contains("cannot reach the server") && failure.contains("quietly"));
        assert_eq!(
            notes.failure("cannot reach the server"),
            None,
            "one line for the whole failure, not one per try"
        );
        assert!(notes.success().unwrap().contains("again"), "back after a failure");
        assert_eq!(notes.success(), None);
        // A failure before the very first success is a line too, and the first success after it says "again".
        let mut fresh = Notes::default();
        assert!(fresh.failure("x").is_some());
        assert!(fresh.success().unwrap().contains("again"));
    }

    #[test]
    fn a_refused_key_ends_the_heartbeat_and_a_failure_does_not() {
        let (mut schedule, mut notes) = (standard(), Notes::default());
        let lines = Mutex::new(Vec::new());
        let say = |line: String| lines.lock().unwrap().push(line);
        let sent = Mutex::new(0);
        let mut outcomes = vec![
            Ok(()),
            Err(SendError::Later {
                reason: "cannot reach the server".into(),
                after: None,
            }),
            Err(SendError::Rejected("the server refused the heartbeat (400)".into())),
            Ok(()),
            Err(SendError::Unauthorized),
        ]
        .into_iter();
        let mut send = |_: &View| {
            *sent.lock().unwrap() += 1;
            outcomes.next().unwrap()
        };
        let view = View::WAITING;
        assert_eq!(tick(&mut schedule, &mut notes, 0, view, &mut send, &say), Ok(()));
        assert_eq!(
            tick(&mut schedule, &mut notes, 10_000, view, &mut send, &say),
            Ok(()),
            "not due: nothing was sent"
        );
        assert_eq!(*sent.lock().unwrap(), 1);
        assert_eq!(
            tick(&mut schedule, &mut notes, MIN, view, &mut send, &say),
            Ok(()),
            "a failure carries on"
        );
        assert_eq!(
            tick(&mut schedule, &mut notes, MIN + 10_000, view, &mut send, &say),
            Ok(()),
            "in the wait: nothing is sent"
        );
        assert_eq!(*sent.lock().unwrap(), 2);
        assert_eq!(
            tick(&mut schedule, &mut notes, MIN + 30_000, view, &mut send, &say),
            Ok(()),
            "a refusal of the heartbeat is a later try"
        );
        assert_eq!(tick(&mut schedule, &mut notes, MIN + 330_000, view, &mut send, &say), Ok(()));
        assert_eq!(
            tick(&mut schedule, &mut notes, 3 * MIN + 330_000, view, &mut send, &say),
            Err(()),
            "the key is refused: it ends"
        );
        let lines = lines.lock().unwrap();
        assert_eq!(lines.len(), 4, "{lines:?}");
        assert!(lines[0].contains("hears this computer."));
        assert!(lines[1].contains("could not reach the server"));
        assert!(lines[2].contains("again"));
        assert!(
            lines[3].contains("no longer accepts") && !lines.iter().any(|l| l.contains("xpd_")),
            "the key is never in a line"
        );
    }

    fn config_for(url: &str) -> Config {
        Config {
            server: url.into(),
            token: "xpd_hb_secret".into(),
            device_name: "MY RIG".into(),
            account: Some("someone@example.com".into()),
            auto_update: true,
        }
    }

    fn recording_hooks() -> (Hooks, Arc<Mutex<Vec<String>>>) {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let seen = lines.clone();
        (
            Hooks {
                say: Arc::new(move |line| seen.lock().unwrap().push(line)),
                worker: Arc::new(|_| {}),
            },
            lines,
        )
    }

    fn heartbeats(stub: &Stub) -> Vec<Recorded> {
        stub.requests().into_iter().filter(|r| r.path == "/api/sim/heartbeat").collect()
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let started = Instant::now();
        while !done() {
            assert!(started.elapsed() < Duration::from_secs(10), "gave up waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn the_real_request_carries_the_key_and_only_the_four_fields() {
        let stub = Stub::start(|_: &Recorded| Reply::new(200, r#"{"ok":true}"#));
        let config = config_for(&stub.url);
        let agent = net::heartbeat_agent();
        net::send_heartbeat(&agent, &config, &payload("0.7.0", &connected("ams2"), 2)).unwrap();
        let seen = heartbeats(&stub);
        assert_eq!(seen.len(), 1);
        assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("POST", "/api/sim/heartbeat"));
        assert_eq!(
            seen[0].headers.get("authorization").map(String::as_str),
            Some("Bearer xpd_hb_secret")
        );
        assert_eq!(seen[0].headers.get("content-type").map(String::as_str), Some("application/json"));
        assert_eq!(seen[0].headers.get("user-agent"), Some(&format!("xpeed-companion/{VERSION}")));
        let text = String::from_utf8(seen[0].body.clone()).unwrap();
        assert!(
            !text.contains("MY RIG") && !text.contains("someone@example.com") && !text.contains("xpd_hb_secret"),
            "nothing personal: {text}"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            json!({ "version": "0.7.0", "state": "connected", "game": "ams2", "pendingLaps": 2 })
        );
    }

    #[test]
    fn what_the_server_says_decides_what_happens_next() {
        let answer = |status: u16, after: Option<&str>| {
            let reply_status = status;
            let retry = after.map(str::to_owned);
            let stub = Stub::start(move |_: &Recorded| {
                let reply = Reply::new(reply_status, r#"{"error":"x","retryable":true}"#);
                match &retry {
                    Some(seconds) => reply.header("Retry-After", seconds),
                    None => reply,
                }
            });
            let result = net::send_heartbeat(&net::heartbeat_agent(), &config_for(&stub.url), "{}");
            drop(stub);
            result
        };
        assert_eq!(answer(200, None), Ok(()));
        assert_eq!(answer(401, None), Err(SendError::Unauthorized), "revoked, like a lap");
        assert_eq!(answer(403, None), Err(SendError::Unauthorized));
        assert!(matches!(answer(400, None), Err(SendError::Rejected(why)) if why.contains("refused the heartbeat")));
        assert!(matches!(answer(413, None), Err(SendError::Rejected(_))));
        // An older server has no such route: a slow, quiet retry.
        assert!(matches!(answer(404, None), Err(SendError::Later { after: Some(a), .. }) if a == Duration::from_secs(300)));
        assert!(matches!(answer(405, None), Err(SendError::Later { .. })));
        assert!(matches!(answer(429, Some("45")), Err(SendError::Later { after: Some(a), .. }) if a == Duration::from_secs(45)));
        assert!(matches!(answer(503, Some("10")), Err(SendError::Later { after: Some(a), .. }) if a == Duration::from_secs(10)));
        assert!(matches!(answer(500, None), Err(SendError::Later { after: None, .. })));
        assert!(
            matches!(answer(302, None), Err(SendError::Later { reason, .. }) if reason.contains("moved")),
            "no redirects: the key never follows one"
        );
        // Nobody listening: a network problem, a later try.
        let gone = {
            let stub = Stub::start(|_: &Recorded| Reply::new(200, ""));
            let url = stub.url.clone();
            drop(stub);
            net::send_heartbeat(&net::heartbeat_agent(), &config_for(&url), "{}")
        };
        assert!(matches!(gone, Err(SendError::Later { after: None, .. })), "{gone:?}");
    }

    #[test]
    fn nothing_goes_when_the_computer_is_not_paired() {
        let stub = Stub::start(|_: &Recorded| Reply::new(200, r#"{"ok":true}"#));
        let shared = Shared::new(false);
        let (hooks, _) = recording_hooks();
        let dir = crate::config::scratch_dir("hb-unpaired");
        assert!(
            Heartbeat::start_if_paired(None, dir.clone(), shared.clone(), hooks.clone()).is_none(),
            "no pairing, no thread"
        );
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
            assert!(Heartbeat::start_if_paired(Some(broken), dir.clone(), shared.clone(), hooks.clone()).is_none());
        }
        // State changes with no heartbeat to wake are harmless, and nothing reached the server.
        shared.set_game("ac", "Assetto Corsa", Game::Connected);
        shared.set_paused(true);
        std::thread::sleep(Duration::from_millis(200));
        assert!(stub.requests().is_empty(), "{:?}", stub.requests());
    }

    #[test]
    fn a_running_heartbeat_sends_at_the_start_and_again_when_a_game_connects_or_goes() {
        let stub = Stub::start(|_: &Recorded| Reply::new(200, r#"{"ok":true}"#));
        let shared = Shared::new(true);
        let (hooks, lines) = recording_hooks();
        let dir = crate::config::scratch_dir("hb-live");
        // Two laps waiting: the count goes with it.
        for name in ["a.xlap.gz", "b.xlap.gz"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let beat = Heartbeat::start_with(Some(config_for(&stub.url)), dir, shared.clone(), hooks, quick()).expect("paired");
        shared.set_heartbeat(Some(beat));
        wait_until("the first heartbeat", || !heartbeats(&stub).is_empty());
        let body = |n: usize| serde_json::from_slice::<Value>(&heartbeats(&stub)[n].body).unwrap();
        assert_eq!(
            body(0),
            json!({ "version": VERSION, "state": "waiting", "game": null, "pendingLaps": 2 })
        );
        // A game connects: it goes without waiting for the minute (after the short gap that spares a flicker).
        shared.set_game("ams2", "Automobilista 2", Game::Connected);
        wait_until("the heartbeat for the game", || heartbeats(&stub).len() >= 2);
        assert_eq!(body(1)["state"], "connected");
        assert_eq!(body(1)["game"], "ams2");
        // Recording a lap is no change to say anything about; the game closing is.
        shared.set_game("ams2", "Automobilista 2", Game::Recording(1));
        shared.set_game("ams2", "Automobilista 2", Game::Waiting);
        wait_until("the heartbeat for the game closing", || heartbeats(&stub).len() >= 3);
        assert_eq!(body(2)["state"], "waiting");
        assert_eq!(body(2)["game"], Value::Null);
        // Pausing reading is a change too.
        shared.set_paused(true);
        wait_until("the heartbeat for the pause", || heartbeats(&stub).len() >= 4);
        assert_eq!(body(3)["state"], "idle");
        // That is all: four in this short run, so not one a moment, and the log has the one line of the first success.
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(heartbeats(&stub).len(), 4);
        let said = lines.lock().unwrap().clone();
        assert_eq!(
            said,
            ["heartbeat: the server hears this computer."],
            "one line, not one per heartbeat"
        );
        shared.set_heartbeat(None);
    }

    #[test]
    fn a_server_that_refuses_the_key_ends_it_and_one_that_does_not_know_the_route_is_left_alone() {
        let stub = Stub::start(|_: &Recorded| Reply::new(401, r#"{"error":"unauthorized","retryable":false}"#));
        let shared = Shared::new(true);
        let (hooks, lines) = recording_hooks();
        let dir = crate::config::scratch_dir("hb-refused");
        let beat = Heartbeat::start_with(Some(config_for(&stub.url)), dir.clone(), shared.clone(), hooks, quick()).expect("paired");
        shared.set_heartbeat(Some(beat));
        wait_until("the refusal", || !lines.lock().unwrap().is_empty());
        assert!(lines.lock().unwrap()[0].contains("no longer accepts"));
        // The thread has finished: waking it again sends nothing more.
        shared.set_game("ac", "Assetto Corsa", Game::Connected);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(heartbeats(&stub).len(), 1, "stopped after the refusal");
        shared.set_heartbeat(None);

        let old = Stub::start(|_: &Recorded| Reply::new(404, r#"{"error":"not_found"}"#));
        let (hooks, lines) = recording_hooks();
        let beat = Heartbeat::start_with(Some(config_for(&old.url)), dir, shared.clone(), hooks, quick()).expect("paired");
        shared.set_heartbeat(Some(beat));
        wait_until("the first try", || !heartbeats(&old).is_empty());
        wait_until("its line", || !lines.lock().unwrap().is_empty());
        shared.set_game("ams2", "Automobilista 2", Game::Connected);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(heartbeats(&old).len(), 1, "an older server is asked once, then not for minutes");
        assert_eq!(lines.lock().unwrap().len(), 1);
        assert!(lines.lock().unwrap()[0].contains("does not take heartbeats"));
        shared.set_heartbeat(None);
    }

    /// The ids the server accepts for a game: a lowercase letter, then letters, digits and `_`, 32 at most (api/sim/heartbeat.ts).
    #[cfg(windows)]
    #[test]
    fn every_game_id_is_one_the_server_accepts() {
        let valid = |id: &str| {
            id.len() <= 32
                && id.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        };
        let mut ids: Vec<&str> = vec!["lmu"];
        for reader in crate::games::READERS {
            ids.extend(reader.ids.iter().copied());
        }
        assert!(ids.len() > 10);
        for id in ids {
            assert!(valid(id), "{id}");
        }
    }
}
