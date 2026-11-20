//! Reference laps from the Xpeed server, for the panel's "delta to the reference" card: the fastest lap on the board as the
//! person sees it (`kind=best`) and the person's own fastest (`kind=personal`), each as the time the lap had reached at every
//! 5 m (`GET /api/sim/reference`, contract in `ENVIO-DE-VOLTAS.md`, section 2e).
//!
//! A thread of its own, looked after by the supervisor like the heartbeat, asks for both kinds when the game, the track or the
//! car of the live reading changes (once it has stayed so for a moment) and then every 10 minutes while they stay. Only a paired
//! computer asks, with the device key, over the address the pairing kept (HTTPS, as `config.rs` requires). What came is kept
//! under `references\<sha256 of game|track|variant|car|kind>.json` in Xpeed Companion's folder, exactly as received, so the
//! card works offline and the next ask can say `If-None-Match`. The only laps that ever come are the ones the leaderboard
//! already shows. A failure is a quiet retry with the waits of the heartbeat (30 s doubling to 5 min, or the server's own
//! `Retry-After`); a refused key ends the thread (the uploader says so to the person); a lap the server no longer has is
//! forgotten, here too. Nothing here ever waits for, or blocks, the reading of a game or the panel.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::config::Config;
use crate::heartbeat::Hooks;
use crate::net::{self, ReferenceAnswer, ReferenceRequest, SendError};
use crate::outbox::Backoff;
use crate::status::Shared;
use crate::supervisor::{self, supervise, Policy};

/// How often the references are asked for again while nothing changes.
pub const EVERY: Duration = Duration::from_secs(600);
/// How long a new game, track and car must stay the same before they are asked for (a menu or a flicker asks nothing).
pub const SETTLE: Duration = Duration::from_secs(3);
/// How often the thread looks at what the panel shows.
pub const POLL: Duration = Duration::from_secs(2);
/// The most points a reference may have (a point every 5 m: 100 km); a longer answer is not one.
const MAX_POINTS: usize = 20_000;

/// Which lap a reference is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// The fastest lap on the board as the person sees it (or, with none there, the person's own).
    Best,
    /// The person's own fastest lap.
    Personal,
}

impl Kind {
    /// The word the server uses.
    fn word(self) -> &'static str {
        match self {
            Kind::Best => "best",
            Kind::Personal => "personal",
        }
    }

    fn of(word: &str) -> Option<Kind> {
        match word {
            "best" => Some(Kind::Best),
            "personal" => Some(Kind::Personal),
            _ => None,
        }
    }
}

/// One reference lap: the time it had reached at every `step_m` metres from the line.
#[derive(Clone, Debug, PartialEq)]
pub struct Reference {
    /// The kind of the lap that came (a `best` that fell back to the person's own says `Personal`).
    pub kind: Kind,
    pub lap_id: String,
    pub time_ms: u32,
    /// The public name of the driver; `None` for the person's own lap.
    pub driver: Option<String>,
    pub step_m: f64,
    /// The time in milliseconds at 0 m, `step_m`, 2 × `step_m` ...
    pub points: Vec<u32>,
}

impl Reference {
    /// The time in seconds the lap had reached `dist_m` metres from the line, between the two points round it. `None` before the
    /// line, past the last point, or for a trace with nothing in it.
    pub fn time_at(&self, dist_m: f64) -> Option<f64> {
        if !dist_m.is_finite() || dist_m < 0.0 || !self.step_m.is_finite() || self.step_m <= 0.0 {
            return None;
        }
        let at = dist_m / self.step_m;
        let index = at.floor();
        let here = f64::from(*self.points.get(index as usize)?);
        match self.points.get(index as usize + 1) {
            Some(&next) => Some((here + (f64::from(next) - here) * (at - index)) / 1000.0),
            // The last point: exactly there, and no farther.
            None => (at == index).then_some(here / 1000.0),
        }
    }

    /// The time on this lap less the reference's at the same distance, in seconds (negative: faster). `None` where `time_at` is.
    pub fn delta(&self, dist_m: f64, lap_time_s: f64) -> Option<f64> {
        if !lap_time_s.is_finite() {
            return None;
        }
        self.time_at(dist_m).map(|reference| lap_time_s - reference)
    }
}

/// What is known for the game, track and car being driven: either kind may be missing.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct References {
    pub track: String,
    pub car: String,
    pub best: Option<Reference>,
    pub personal: Option<Reference>,
}

/// What a reference is asked for: the server's game id, the track and the car as the game names them, and the layout when known.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    pub game: String,
    pub track: String,
    pub car: String,
    pub variant: Option<String>,
}

impl Key {
    /// The file name of a kind's answer in the cache.
    fn file_name(&self, kind: Kind) -> String {
        let text = format!(
            "{}|{}|{}|{}|{}",
            self.game,
            self.track,
            self.variant.as_deref().unwrap_or(""),
            self.car,
            kind.word()
        );
        format!("{}.json", net::sha256_hex(text.as_bytes()))
    }
}

/// A name the server takes for a track or a car: 1 to 120 characters, no control characters.
fn askable(text: &str) -> bool {
    (1..=120).contains(&text.encode_utf16().count()) && !text.chars().any(char::is_control)
}

/// An id that can sit in a header and a file: letters, digits, `-` and `_`.
fn plain_id(text: &str) -> bool {
    (1..=64).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The reference in an answer's body, or nothing for anything that is not one (the wrong shape, no points, points that go
/// backwards, a time or a step that is not a number).
pub fn parse(body: &str) -> Option<Reference> {
    let value: Value = serde_json::from_str(body).ok()?;
    let kind = Kind::of(value.get("kind")?.as_str()?)?;
    let lap_id = value.get("lapId")?.as_str().filter(|id| plain_id(id))?.to_owned();
    let time_ms = u32::try_from(value.get("timeMs")?.as_u64()?).ok().filter(|t| *t > 0)?;
    let step_m = value.get("stepM")?.as_f64().filter(|s| s.is_finite() && *s > 0.0 && *s <= 100.0)?;
    let driver = value
        .get("driver")
        .and_then(Value::as_str)
        .map(|name| name.chars().filter(|c| !c.is_control()).take(60).collect::<String>())
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty());
    let raw = value.get("points")?.as_array()?;
    if raw.len() < 2 || raw.len() > MAX_POINTS {
        return None;
    }
    let mut points: Vec<u32> = Vec::with_capacity(raw.len());
    for point in raw {
        let ms = u32::try_from(point.as_u64()?).ok()?;
        if points.last().is_some_and(|last| ms < *last) {
            return None;
        }
        points.push(ms);
    }
    Some(Reference {
        kind,
        lap_id,
        time_ms,
        driver,
        step_m,
        points,
    })
}

// The cache.

fn cached_path(dir: &Path, key: &Key, kind: Kind) -> PathBuf {
    dir.join(key.file_name(kind))
}

/// What the cache holds for a kind: the body as it came and the reference in it. A file that is not a reference is none.
fn read_cached(dir: &Path, key: &Key, kind: Kind) -> Option<Reference> {
    parse(&std::fs::read_to_string(cached_path(dir, key, kind)).ok()?)
}

/// Keeps an answer as it came (through a `.part` file, so a cut write never replaces a good copy).
fn keep(dir: &Path, key: &Key, kind: Kind, body: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = cached_path(dir, key, kind);
    let part = path.with_extension("json.part");
    std::fs::write(&part, body)?;
    std::fs::rename(&part, path)
}

fn forget(dir: &Path, key: &Key, kind: Kind) {
    let _ = std::fs::remove_file(cached_path(dir, key, kind));
}

/// What the cache holds for `key`, for the panel to show before (or without) a word from the server.
pub fn load(dir: &Path, key: &Key) -> References {
    References {
        track: key.track.clone(),
        car: key.car.clone(),
        best: read_cached(dir, key, Kind::Best),
        personal: read_cached(dir, key, Kind::Personal),
    }
}

// Asking.

/// What one round of asking came to.
#[derive(Debug, Default)]
pub struct Pass {
    pub references: References,
    /// Why a request did not work, and how long the server said to wait, when it did.
    pub failure: Option<(String, Option<Duration>)>,
    /// The server refused the key: nothing more can be asked until the computer is paired again.
    pub unauthorized: bool,
}

/// Asks for both kinds of `key`, with `If-None-Match` from the cache, and keeps what came. What could not be asked for is what
/// the cache held.
pub fn refresh(dir: &Path, config: &Config, agent: &ureq::Agent, key: &Key) -> Pass {
    let mut pass = Pass {
        references: References {
            track: key.track.clone(),
            car: key.car.clone(),
            ..References::default()
        },
        ..Pass::default()
    };
    fn fail(pass: &mut Pass, reason: String, after: Option<Duration>) {
        let after = pass.failure.as_ref().and_then(|(_, kept)| *kept).max(after);
        pass.failure = Some((reason, after));
    }
    for kind in [Kind::Best, Kind::Personal] {
        let cached = read_cached(dir, key, kind);
        let etag = cached.as_ref().map(|reference| format!("\"{}\"", reference.lap_id));
        let request = ReferenceRequest {
            game: &key.game,
            track: &key.track,
            car: &key.car,
            variant: key.variant.as_deref(),
            kind: kind.word(),
            etag: etag.as_deref(),
        };
        let found = match net::get_reference(agent, config, &request) {
            Ok(ReferenceAnswer::Body(body)) => match parse(&body) {
                Some(reference) => {
                    // Not being able to keep it only means no offline copy.
                    let _ = keep(dir, key, kind, &body);
                    Some(reference)
                }
                None => {
                    fail(&mut pass, "the server answered a reference lap this app does not understand".into(), None);
                    cached
                }
            },
            Ok(ReferenceAnswer::Unchanged) => cached,
            Ok(ReferenceAnswer::Missing) => {
                forget(dir, key, kind);
                None
            }
            Err(SendError::Unauthorized) => {
                pass.unauthorized = true;
                cached
            }
            Err(SendError::Rejected(reason)) => {
                fail(&mut pass, reason, Some(EVERY));
                cached
            }
            Err(SendError::Later { reason, after }) => {
                fail(&mut pass, reason, after);
                cached
            }
        };
        match kind {
            Kind::Best => pass.references.best = found,
            Kind::Personal => pass.references.personal = found,
        }
        if pass.unauthorized {
            break;
        }
    }
    pass
}

// When.

/// When the next ask is due, as plain numbers: times are milliseconds on a clock that only goes forward, so the tests move the
/// clock by hand.
#[derive(Clone)]
pub struct Schedule {
    every: u64,
    settle: u64,
    poll: Duration,
    backoff: Backoff,
    /// What is being served, and what has been seen for a moment and since when.
    current: Option<Key>,
    candidate: Option<(Key, u64)>,
    next_at: u64,
    delay: Duration,
}

impl Schedule {
    pub fn new(every: Duration, settle: Duration, poll: Duration, backoff: Backoff) -> Schedule {
        Schedule {
            every: every.as_millis() as u64,
            settle: settle.as_millis() as u64,
            poll,
            backoff,
            current: None,
            candidate: None,
            next_at: 0,
            delay: backoff.base,
        }
    }

    pub fn standard() -> Schedule {
        Schedule::new(EVERY, SETTLE, POLL, Backoff::default())
    }

    /// The key to ask for now, if it is time: a new one once it has stayed the same for the settling time, the one being served
    /// when its next ask is due. Nothing to look at (no game, no track) asks nothing and forgets nothing.
    pub fn due(&mut self, now: u64, seen: Option<&Key>) -> Option<Key> {
        let key = seen?;
        if self.current.as_ref() == Some(key) {
            self.candidate = None;
            return (now >= self.next_at).then(|| key.clone());
        }
        let since = match &self.candidate {
            Some((candidate, since)) if candidate == key => *since,
            _ => {
                self.candidate = Some((key.clone(), now));
                now
            }
        };
        if now.saturating_sub(since) < self.settle {
            return None;
        }
        self.candidate = None;
        self.current = Some(key.clone());
        self.delay = self.backoff.base;
        self.next_at = now;
        Some(key.clone())
    }

    /// The ask worked: the next one is a whole interval away.
    pub fn done(&mut self, now: u64) {
        self.next_at = now + self.every;
        self.delay = self.backoff.base;
    }

    /// The ask did not work: try again after the server's own wait if it gave one, else after a wait that doubles.
    pub fn failed(&mut self, now: u64, after: Option<Duration>) {
        let wait = after.unwrap_or(self.delay).max(self.backoff.base);
        self.delay = (self.delay * 2).min(self.backoff.max);
        self.next_at = now + wait.as_millis() as u64;
    }
}

/// Which lines the log gets: one when asking starts to fail and one when it works again, never one for each try.
#[derive(Debug, Default)]
pub struct Notes {
    failing: bool,
}

impl Notes {
    pub fn success(&mut self) -> Option<String> {
        if !self.failing {
            return None;
        }
        self.failing = false;
        Some("references: reference laps come through again.".into())
    }

    pub fn failure(&mut self, reason: &str) -> Option<String> {
        if self.failing {
            return None;
        }
        self.failing = true;
        Some(format!("references: could not get a reference lap ({reason}); trying again quietly."))
    }
}

/// The key of what the panel shows now: the game the heartbeat says is connected, and the track and car of the live reading.
fn key_of(shared: &Shared) -> Option<Key> {
    let game = shared.heartbeat_view().game?;
    let live = shared.live()?;
    (askable(&live.track) && askable(&live.car)).then(|| Key {
        game: game.to_owned(),
        track: live.track,
        car: live.car,
        variant: None,
    })
}

enum Message {
    Stop,
}

/// The thread that fetches reference laps. Dropping it tells the thread to finish (a request in flight is not waited for).
pub struct Worker {
    tx: mpsc::Sender<Message>,
    stop: Arc<AtomicBool>,
}

fn run_loop(dir: &Path, config: &Config, shared: &Shared, hooks: &Hooks, rx: &mpsc::Receiver<Message>, mut schedule: Schedule) {
    let agent = net::agent();
    let started = Instant::now();
    let clock = || started.elapsed().as_millis() as u64;
    let mut notes = Notes::default();
    let mut shown: Option<Key> = None;
    loop {
        if let Some(key) = schedule.due(clock(), key_of(shared).as_ref()) {
            // What is on disk first, so a computer that is offline still has its references.
            if shown.as_ref() != Some(&key) {
                shared.set_references(Some(Arc::new(load(dir, &key))));
                shown = Some(key.clone());
            }
            let pass = refresh(dir, config, &agent, &key);
            shared.set_references(Some(Arc::new(pass.references)));
            if pass.unauthorized {
                (hooks.say)("references: the server no longer accepts this computer's key; stopping (pair again).".into());
                return;
            }
            match pass.failure {
                None => {
                    schedule.done(clock());
                    if let Some(line) = notes.success() {
                        (hooks.say)(line);
                    }
                }
                Some((reason, after)) => {
                    schedule.failed(clock(), after);
                    if let Some(line) = notes.failure(&reason) {
                        (hooks.say)(line);
                    }
                }
            }
        }
        match rx.recv_timeout(schedule.poll) {
            Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

impl Worker {
    /// Starts the thread, or not: an unpaired computer (no connection, or one with no server or no key) asks for nothing.
    pub fn start_if_paired(config: Option<Config>, dir: PathBuf, shared: Arc<Shared>, hooks: Hooks) -> Option<Worker> {
        Worker::start_with(config, dir, shared, hooks, Schedule::standard())
    }

    /// The same with the times of `schedule` (the tests use short ones).
    fn start_with(config: Option<Config>, dir: PathBuf, shared: Arc<Shared>, hooks: Hooks, schedule: Schedule) -> Option<Worker> {
        let config = config.filter(|c| !c.server.is_empty() && !c.token.is_empty())?;
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        std::thread::spawn(move || {
            supervise(
                supervisor::title(supervisor::REFERENCES),
                &Policy::default(),
                &|| stopped.load(Ordering::SeqCst),
                &|line| (hooks.say)(line),
                &|health| (hooks.worker)(health),
                || run_loop(&dir, &config, &shared, &hooks, &rx, schedule.clone()),
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
    use crate::config::scratch_dir;
    use crate::status::Game;
    use crate::stub::{Recorded, Reply, Stub};
    use std::sync::Mutex;

    fn key() -> Key {
        Key {
            game: "lmu".into(),
            track: "Test Track".into(),
            car: "Test Car".into(),
            variant: None,
        }
    }

    fn config_for(url: &str) -> Config {
        Config {
            server: url.into(),
            token: "xpd_test".into(),
            device_name: "RIG".into(),
            account: None,
            auto_update: true,
        }
    }

    fn body(kind: &str, lap_id: &str, driver: Option<&str>) -> String {
        serde_json::json!({
            "kind": kind, "lapId": lap_id, "timeMs": 20000, "driver": driver, "recordedAt": "2026-11-10T12:00:00.000Z",
            "stepM": 5, "points": [0, 1000, 2500, 5000]
        })
        .to_string()
    }

    fn reference() -> Reference {
        parse(&body("best", "lap-1", Some("Ana"))).unwrap()
    }

    #[test]
    fn the_time_is_read_between_the_points_and_the_delta_is_this_lap_less_the_reference() {
        let lap = reference();
        assert_eq!(lap.time_at(0.0), Some(0.0));
        assert_eq!(lap.time_at(5.0), Some(1.0), "exactly on a point");
        assert_eq!(lap.time_at(15.0), Some(5.0), "the last point");
        assert!((lap.time_at(7.5).unwrap() - 1.75).abs() < 1e-9, "halfway between 1.0 and 2.5");
        assert_eq!(lap.time_at(-0.1), None, "before the line");
        assert_eq!(lap.time_at(15.1), None, "past the end");
        assert_eq!(lap.time_at(f64::NAN), None);
        assert!((lap.delta(10.0, 2.4).unwrap() + 0.1).abs() < 1e-9, "faster is negative");
        assert!((lap.delta(10.0, 2.6).unwrap() - 0.1).abs() < 1e-9);
        assert_eq!(lap.delta(10.0, f64::NAN), None);
        assert_eq!(lap.delta(99.0, 2.0), None);
        let empty = Reference {
            points: Vec::new(),
            ..lap.clone()
        };
        assert_eq!(empty.time_at(0.0), None);
        let one = Reference { points: vec![0], ..lap };
        assert_eq!(one.time_at(0.0), Some(0.0));
        assert_eq!(one.time_at(1.0), None);
    }

    #[test]
    fn an_answer_is_a_reference_only_when_every_part_is_in_order() {
        let lap = reference();
        assert_eq!((lap.kind, lap.lap_id.as_str(), lap.time_ms, lap.step_m), (Kind::Best, "lap-1", 20_000, 5.0));
        assert_eq!(lap.driver.as_deref(), Some("Ana"));
        assert_eq!(parse(&body("personal", "lap-2", None)).unwrap().driver, None);
        for (what, text) in [
            ("not json", "<html>".to_owned()),
            ("a kind the app does not know", body("fastest", "a", None)),
            ("an id with a quote", body("best", "a\"b", None)),
            ("no points", r#"{"kind":"best","lapId":"a","timeMs":1,"stepM":5,"points":[]}"#.into()),
            ("one point", r#"{"kind":"best","lapId":"a","timeMs":1,"stepM":5,"points":[0]}"#.into()),
            ("points that go back", r#"{"kind":"best","lapId":"a","timeMs":1,"stepM":5,"points":[0,9,4]}"#.into()),
            ("a step of nothing", r#"{"kind":"best","lapId":"a","timeMs":1,"stepM":0,"points":[0,1]}"#.into()),
            ("no time", r#"{"kind":"best","lapId":"a","timeMs":0,"stepM":5,"points":[0,1]}"#.into()),
        ] {
            assert_eq!(parse(&text), None, "{what}");
        }
    }

    #[test]
    fn the_cache_file_is_named_by_the_hash_of_what_was_asked_and_keeps_the_body_as_it_came() {
        let key = key();
        let name = key.file_name(Kind::Best);
        let expected = net::sha256_hex(b"lmu|Test Track||Test Car|best");
        assert_eq!(name, format!("{expected}.json"));
        assert_ne!(name, key.file_name(Kind::Personal));
        let other = Key {
            variant: Some("Short".into()),
            ..key.clone()
        };
        assert_eq!(other.file_name(Kind::Best), format!("{}.json", net::sha256_hex(b"lmu|Test Track|Short|Test Car|best")));
        let dir = scratch_dir("reference-cache").join("references");
        assert_eq!(load(&dir, &key).best, None, "nothing yet");
        let text = body("best", "lap-1", Some("Ana"));
        keep(&dir, &key, Kind::Best, &text).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(&name)).unwrap(), text);
        assert!(!dir.join(format!("{expected}.json.part")).exists());
        let loaded = load(&dir, &key);
        assert_eq!((loaded.track.as_str(), loaded.car.as_str()), ("Test Track", "Test Car"));
        assert_eq!(loaded.best, Some(reference()));
        assert_eq!(loaded.personal, None);
        std::fs::write(dir.join(&name), "damaged").unwrap();
        assert_eq!(load(&dir, &key).best, None, "a file that is not a reference is none");
    }

    #[test]
    fn a_new_key_is_asked_for_once_it_settles_and_the_same_one_every_interval() {
        let mut schedule = Schedule::new(
            Duration::from_secs(600),
            Duration::from_secs(3),
            Duration::from_secs(2),
            Backoff::default(),
        );
        let (a, b) = (key(), Key { car: "Other Car".into(), ..key() });
        assert_eq!(schedule.due(0, None), None, "nothing to look at");
        assert_eq!(schedule.due(1_000, Some(&a)), None, "just seen");
        assert_eq!(schedule.due(2_000, Some(&b)), None, "a flicker to another car starts the settling over");
        assert_eq!(schedule.due(4_000, Some(&a)), None);
        assert_eq!(schedule.due(7_000, Some(&a)), Some(a.clone()), "stayed for 3 s");
        schedule.done(7_000);
        assert_eq!(schedule.due(8_000, Some(&a)), None);
        assert_eq!(schedule.due(606_999, Some(&a)), None);
        assert_eq!(schedule.due(607_000, Some(&a)), Some(a.clone()), "10 minutes later");
        schedule.failed(607_000, None);
        assert_eq!(schedule.due(636_999, Some(&a)), None, "30 s after a failure");
        assert_eq!(schedule.due(637_000, Some(&a)), Some(a.clone()));
        schedule.failed(637_000, None);
        assert_eq!(schedule.due(696_999, Some(&a)), None, "then 60 s");
        assert_eq!(schedule.due(697_000, Some(&a)), Some(a.clone()));
        schedule.failed(697_000, Some(Duration::from_secs(900)));
        assert_eq!(schedule.due(1_596_999, Some(&a)), None, "the server's own wait");
        assert_eq!(schedule.due(1_597_000, Some(&a)), Some(a.clone()));
        // No game for a while, and then the same car: no new ask, only the timer.
        schedule.done(1_597_000);
        assert_eq!(schedule.due(1_600_000, None), None);
        assert_eq!(schedule.due(1_610_000, Some(&a)), None);
        // Another car: asked for at once after the settling.
        assert_eq!(schedule.due(1_611_000, Some(&b)), None);
        assert_eq!(schedule.due(1_615_000, Some(&b)), Some(b));
    }

    #[test]
    fn the_log_says_when_asking_starts_to_fail_and_when_it_works_again_and_nothing_else() {
        let mut notes = Notes::default();
        assert_eq!(notes.success(), None);
        assert!(notes.failure("cannot reach the server").unwrap().contains("cannot reach the server"));
        assert_eq!(notes.failure("again"), None);
        assert!(notes.success().is_some());
        assert_eq!(notes.success(), None);
    }

    fn asks(stub: &Stub) -> Vec<Recorded> {
        stub.requests().into_iter().filter(|r| r.path.starts_with("/api/sim/reference?")).collect()
    }

    fn kind_of(request: &Recorded) -> &'static str {
        if request.path.ends_with("kind=best") {
            "best"
        } else {
            "personal"
        }
    }

    #[test]
    fn asks_for_both_kinds_with_the_device_key_then_says_if_none_match_and_keeps_the_answer() {
        let stub = Stub::start(|request: &Recorded| {
            if request.headers.get("if-none-match").is_some() {
                return Reply::new(304, "");
            }
            let kind = kind_of(request);
            Reply::new(200, &body(kind, if kind == "best" { "lap-1" } else { "lap-2" }, (kind == "best").then_some("Ana")))
        });
        let dir = scratch_dir("reference-pass").join("references");
        let config = config_for(&stub.url);
        let agent = net::agent();
        let pass = refresh(&dir, &config, &agent, &key());
        assert!(pass.failure.is_none() && !pass.unauthorized);
        assert_eq!(pass.references.best.as_ref().map(|r| r.lap_id.as_str()), Some("lap-1"));
        assert_eq!(pass.references.personal.as_ref().map(|r| r.lap_id.as_str()), Some("lap-2"));
        let first = asks(&stub);
        assert_eq!(first.len(), 2);
        assert_eq!(
            first[0].path,
            "/api/sim/reference?game=lmu&track=Test%20Track&car=Test%20Car&kind=best"
        );
        assert_eq!(first[0].headers["authorization"], "Bearer xpd_test");
        assert!(first.iter().all(|r| r.method == "GET" && !r.headers.contains_key("if-none-match")));
        // The second time the kept ids are offered and the server says nothing changed.
        let again = refresh(&dir, &config, &agent, &key());
        assert!(again.failure.is_none());
        assert_eq!(again.references, pass.references, "the cache answers for a 304");
        let all = asks(&stub);
        let second = &all[2..];
        assert_eq!(second[0].headers["if-none-match"], "\"lap-1\"");
        assert_eq!(second[1].headers["if-none-match"], "\"lap-2\"");
        // Offline: the cache alone gives the same.
        drop(stub);
        assert_eq!(load(&dir, &key()).best, pass.references.best);
    }

    #[test]
    fn no_reference_is_remembered_as_none_and_forgets_a_lap_that_is_gone() {
        let dir = scratch_dir("reference-missing").join("references");
        keep(&dir, &key(), Kind::Best, &body("best", "lap-1", None)).unwrap();
        let stub = Stub::start(|_: &Recorded| Reply::new(404, r#"{"error":"no_reference","retryable":false}"#));
        let pass = refresh(&dir, &config_for(&stub.url), &net::agent(), &key());
        assert!(pass.failure.is_none(), "not a failure: it is asked again at the next tick");
        assert_eq!((pass.references.best, pass.references.personal), (None, None));
        assert_eq!(load(&dir, &key()).best, None, "a lap the server no longer serves is not kept");
    }

    #[test]
    fn a_refused_key_stops_and_a_busy_server_is_a_wait_that_keeps_what_is_cached() {
        let dir = scratch_dir("reference-errors").join("references");
        keep(&dir, &key(), Kind::Best, &body("best", "lap-1", None)).unwrap();
        let refused = Stub::start(|_: &Recorded| Reply::new(401, r#"{"error":"unauthorized","retryable":false}"#));
        let pass = refresh(&dir, &config_for(&refused.url), &net::agent(), &key());
        assert!(pass.unauthorized);
        assert_eq!(asks(&refused).len(), 1, "no second request after a refusal");
        assert!(pass.references.best.is_some(), "what was kept still shows");

        let limited = Stub::start(|_: &Recorded| {
            Reply::new(429, r#"{"error":"too_many_requests","retryable":true}"#).header("Retry-After", "42")
        });
        let pass = refresh(&dir, &config_for(&limited.url), &net::agent(), &key());
        let (reason, after) = pass.failure.expect("a failure");
        assert!(reason.contains("429"), "{reason}");
        assert_eq!(after, Some(Duration::from_secs(42)));
        assert!(pass.references.best.is_some());

        let broken = Stub::start(|_: &Recorded| Reply::new(503, r#"{"error":"unavailable","retryable":true}"#));
        let pass = refresh(&dir, &config_for(&broken.url), &net::agent(), &key());
        assert!(pass.failure.is_some() && !pass.unauthorized);
        let garbled = Stub::start(|_: &Recorded| Reply::new(200, "<html>not a lap</html>"));
        let pass = refresh(&dir, &config_for(&garbled.url), &net::agent(), &key());
        assert!(pass.failure.is_some());
        assert!(pass.references.best.is_some(), "a bad answer never replaces the cache");
    }

    fn quick() -> Schedule {
        Schedule::new(
            Duration::from_secs(60),
            Duration::from_millis(100),
            Duration::from_millis(30),
            Backoff {
                base: Duration::from_millis(100),
                max: Duration::from_millis(400),
            },
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
    fn the_worker_publishes_the_references_of_the_live_car_and_never_logs_the_key() {
        let stub = Stub::start(|request: &Recorded| {
            let kind = kind_of(request);
            Reply::new(200, &body(kind, "lap-1", Some("Ana")))
        });
        let shared = Shared::new(true);
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = lines.clone();
        let hooks = Hooks {
            say: Arc::new(move |line| seen.lock().unwrap().push(line)),
            worker: Arc::new(|_| {}),
        };
        let dir = scratch_dir("reference-worker").join("references");
        let worker = Worker::start_with(Some(config_for(&stub.url)), dir, shared.clone(), hooks, quick()).expect("paired");
        std::thread::sleep(Duration::from_millis(300));
        assert!(asks(&stub).is_empty(), "no game and no car: nothing to ask");
        shared.set_game("lmu", "Le Mans Ultimate", Game::Connected);
        let mut live = crate::dash::Tracker::default().on_frame("Le Mans Ultimate", &crate::game::Frame::empty(), 0);
        live.track = "Test Track".into();
        live.car = "Test Car".into();
        shared.offer_live(live.clone());
        wait_until("the references", || shared.live().is_some_and(|l| l.references.is_some_and(|r| r.best.is_some())));
        let published = shared.live().unwrap().references.unwrap();
        assert_eq!(published.best.as_ref().map(|r| r.lap_id.as_str()), Some("lap-1"));
        assert_eq!(asks(&stub).len(), 2);
        // Another car: the old references do not show on it.
        live.car = "Other Car".into();
        live.at_ms += 10;
        shared.offer_live(live);
        assert!(shared.live().unwrap().references.is_none());
        drop(worker);
        assert!(lines.lock().unwrap().iter().all(|line| !line.contains("xpd_test")));
    }
}
