//! Playing a capture (`capture.rs`) back through the same code the live game goes through.
//!
//! A `Player` reads a `.xcap` and puts the recorded memories (or datagrams, or Le Mans Ultimate's buffer) back, one
//! reading at a time, in front of the reader that was recorded: the real one, with its parsing and its state. What comes
//! out is what the reader gave while the person drove: `Frame`s (`ReplaySource` is a `Source`, so anything that takes a
//! live reader takes a capture), which `run` feeds to the lap cutter, the panel's tracker and the data checks
//! (`sanity`), exactly as the engine does with a game. A capture of a few minutes of driving is thereby a regression
//! test of every convention a reader has to guess.
//!
//! Time. The frames carry the recorded time (`Frame::clock_s`), not the time the replay runs at, so the lap cutter sees
//! the drive as it was; `Pace::Fast` (the default, and what tests use) plays as fast as the readers parse and
//! `Pace::Realtime` waits for each reading's moment. What a reader decides by the wall clock (a memory that stopped
//! changing for 30 s is a game that closed) is not replayed in `Fast`: no time passes.
//!
//! Fixtures. `fixtures/*.xcap` are real captures committed to the repository, each with an optional
//! `fixtures/NAME.expect.json` saying what the replay must give (`Expect`). One test replays them all
//! (`fixtures/README.md` says how to record one).

use std::collections::VecDeque;
use std::path::Path;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::capture::{Header, Kind, Reader, Record, TICK};
use crate::game::{Caps, Frame, Source};
use crate::lapfile::Lap;
use crate::lmu::layout::LAYOUT_SIZE;
use crate::lmu::snapshot::Snapshot;
use crate::sanity::Finding;
use crate::shm::{install_replay, ReplayGuard, ReplayMemory};
use crate::util::clock;

/// A UDP reader that can be handed a datagram instead of reading a socket. The reader's own decoder does the work.
pub trait Datagrams: Source {
    /// One datagram, received at `clock_s` of the capture: the frame it makes, if it makes one.
    fn feed(&mut self, data: &[u8], clock_s: f64) -> Option<Frame>;
}

/// How fast a replay goes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Pace {
    /// As fast as the readers parse.
    Fast,
    /// At the recorded time, times `speed` (1.0 is as it was driven).
    Realtime(f64),
}

enum Input {
    Memory(Box<dyn Source>),
    Datagrams(Box<dyn Datagrams>),
    /// Le Mans Ultimate: the recorded ranges rebuild the buffer its snapshots are read from.
    Lmu(Vec<u8>),
}

/// What one recorded reading gave.
pub enum Out {
    Frames(Vec<Frame>),
    Lmu(Box<Snapshot>),
}

pub struct Step {
    /// When the reading finished, in milliseconds since the capture began.
    pub t_ms: u64,
    pub out: Out,
}

/// A capture being played. It puts the recorded memories where the readers of this thread open them (`shm`), so it lives
/// and is used on one thread.
pub struct Player {
    reader: Reader,
    memory: Arc<Mutex<ReplayMemory>>,
    _guard: ReplayGuard,
    input: Input,
    /// The tick that starts the next reading.
    held: Option<Record>,
    pace: Pace,
    began: Option<(Instant, u64)>,
    pub ticks: u64,
}

impl Player {
    pub fn new(mut reader: Reader, pace: Pace) -> Result<Player, String> {
        let memory = Arc::new(Mutex::new(ReplayMemory::default()));
        let guard = install_replay(memory.clone());
        let lmu = reader.header.family == "lmu";
        let mut buffer = if lmu { vec![0u8; LAYOUT_SIZE] } else { Vec::new() };
        // What was recorded before the first reading: the memories the reader opened and what it read while opening.
        let mut held = None;
        let mut ignored = Vec::new();
        while let Some(record) = reader.next_record() {
            if record.stream == TICK {
                held = Some(record);
                break;
            }
            apply(&reader, &memory, &mut buffer, &mut ignored, record);
        }
        let header = reader.header.clone();
        let input = if lmu {
            Input::Lmu(buffer)
        } else {
            match crate::games::open_for_replay(&header.family, &header.game) {
                Some(crate::games::Replayable::Memory(source)) => Input::Memory(source),
                Some(crate::games::Replayable::Datagrams(source)) => Input::Datagrams(source),
                None => {
                    return Err(format!(
                        "the reader of {:?} ({}) cannot open from this capture: the capture does not hold what it needs to \
                         start, or this build has no reader of that family",
                        header.game, header.family
                    ))
                }
            }
        };
        Ok(Player {
            reader,
            memory,
            _guard: guard,
            input,
            held,
            pace,
            began: None,
            ticks: 0,
        })
    }

    pub fn header(&self) -> &Header {
        &self.reader.header
    }

    /// Why the capture ended early, if it did (a cut file).
    pub fn problem(&self) -> Option<&str> {
        self.reader.problem()
    }

    /// The reader being replayed (not for Le Mans Ultimate, which has none).
    fn source(&self) -> Option<&dyn Source> {
        match &self.input {
            Input::Memory(s) => Some(s.as_ref()),
            Input::Datagrams(d) => Some(d.as_ref() as &dyn Source),
            Input::Lmu(_) => None,
        }
    }

    pub fn game_id(&self) -> &'static str {
        self.source().map_or("lmu", Source::game_id)
    }

    pub fn game_name(&self) -> &'static str {
        self.source().map_or("Le Mans Ultimate", Source::game_name)
    }

    fn wait_for(&mut self, t_ms: u64) {
        if let Pace::Realtime(speed) = self.pace {
            let (start, first) = *self.began.get_or_insert((Instant::now(), t_ms));
            let due = start + Duration::from_secs_f64(t_ms.saturating_sub(first) as f64 / 1000.0 / speed.max(0.001));
            if let Some(wait) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
        }
    }

    /// Plays the next recorded reading. `None` at the end of the capture.
    pub fn step(&mut self) -> Option<Step> {
        let tick = self.held.take()?;
        let mut last_t = tick.t_ms;
        let mut datagrams: Vec<(u64, Vec<u8>)> = Vec::new();
        let mut buffer = match &mut self.input {
            Input::Lmu(b) => std::mem::take(b),
            _ => Vec::new(),
        };
        while let Some(record) = self.reader.next_record() {
            if record.stream == TICK {
                self.held = Some(record);
                break;
            }
            last_t = record.t_ms;
            apply(&self.reader, &self.memory, &mut buffer, &mut datagrams, record);
        }
        self.ticks += 1;
        self.wait_for(last_t);
        let seconds = |t: u64| t as f64 / 1000.0;
        let out = match &mut self.input {
            Input::Memory(source) => Out::Frames(
                source
                    .next(Duration::ZERO)
                    .map(|mut frame| {
                        frame.clock_s = seconds(last_t);
                        frame
                    })
                    .into_iter()
                    .collect(),
            ),
            Input::Datagrams(source) => Out::Frames(
                datagrams
                    .iter()
                    .filter_map(|(t, bytes)| {
                        source.feed(bytes, seconds(*t)).map(|mut frame| {
                            frame.clock_s = seconds(*t);
                            frame
                        })
                    })
                    .collect(),
            ),
            Input::Lmu(slot) => {
                let snapshot = Snapshot::from_memory(&buffer);
                *slot = buffer;
                Out::Lmu(Box::new(snapshot))
            }
        };
        Some(Step { t_ms: last_t, out })
    }
}

/// Puts one recorded record where the reader will find it.
fn apply(reader: &Reader, memory: &Mutex<ReplayMemory>, lmu: &mut [u8], datagrams: &mut Vec<(u64, Vec<u8>)>, record: Record) {
    let lock = || memory.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    match reader.kind(record.stream) {
        Kind::Open(name) => {
            let len = record.bytes.get(..8).map_or(0, |b| u64::from_le_bytes(b.try_into().unwrap()));
            lock().open(name, len as usize);
        }
        Kind::Mem { name, at, .. } => lock().set(name, *at, record.bytes),
        Kind::Udp => datagrams.push((record.t_ms, record.bytes)),
        Kind::Lmu { at, .. } => {
            if let Some(room) = at.checked_add(record.bytes.len()).and_then(|end| lmu.get_mut(*at..end)) {
                room.copy_from_slice(&record.bytes);
            }
        }
        Kind::Tick | Kind::Other => {}
    }
}

/// A capture as a `Source`: the frames the reader gave, in order, at the recorded time. Not for Le Mans Ultimate, whose
/// laps are made from snapshots (`run`).
pub struct ReplaySource {
    player: Player,
    queue: VecDeque<Frame>,
    over: bool,
}

// The form of a capture that anything taking a live reader can take; the command and the harness use `Player` directly.
#[cfg_attr(not(test), allow(dead_code))]
impl ReplaySource {
    pub fn new(reader: Reader, pace: Pace) -> Result<ReplaySource, String> {
        let player = Player::new(reader, pace)?;
        if player.source().is_none() {
            return Err("Le Mans Ultimate has no frames of this kind; use `run`".into());
        }
        Ok(ReplaySource {
            player,
            queue: VecDeque::new(),
            over: false,
        })
    }
}

impl Source for ReplaySource {
    fn game_id(&self) -> &'static str {
        self.player.game_id()
    }

    fn game_name(&self) -> &'static str {
        self.player.game_name()
    }

    /// The next frame, at its recorded time (the timeout is not used: the capture says when). `None` at the end.
    fn next(&mut self, _timeout: Duration) -> Option<Frame> {
        loop {
            if let Some(frame) = self.queue.pop_front() {
                return Some(frame);
            }
            match self.player.step() {
                Some(Step {
                    out: Out::Frames(frames), ..
                }) => self.queue.extend(frames),
                Some(_) => {}
                None => {
                    self.over = true;
                    return None;
                }
            }
        }
    }

    fn alive(&self) -> bool {
        !self.over
    }

    fn listens(&self) -> bool {
        self.player.source().is_some_and(Source::listens)
    }

    fn caps(&self) -> Caps {
        self.player.source().map_or(Caps::NONE, Source::caps)
    }

    fn finish_lap(&self, lap: &mut Lap) {
        finish_lap(&self.player, &crate::lmu::source::Framer::default(), lap);
    }
}

// ---- running the whole pipeline -------------------------------------------------------------------------------

/// A lap the pipeline cut, with what the data checks said of it.
pub struct LapResult {
    pub lap: Lap,
    pub findings: Vec<Finding>,
}

pub struct Report {
    pub header: Header,
    /// Frames the reader gave (for Le Mans Ultimate, telemetry updates).
    pub frames: u64,
    /// Recorded readings played.
    pub ticks: u64,
    /// The length of the capture, in seconds.
    pub duration_s: f64,
    pub laps: Vec<LapResult>,
    /// Set when the capture file ended before its end.
    pub problem: Option<String>,
}

/// Plays the whole capture through the lap cutter, the panel's tracker and the data checks, as the engine does a game.
/// Le Mans Ultimate's snapshots go through its `Framer` (what `LmuSource` does live), so its laps are cut by the same
/// `LapCutter` as every other game's.
pub fn run(player: &mut Player) -> Report {
    use crate::lapcut::LapCutter;
    use crate::lmu::source::Framer;
    let header = player.header().clone();
    let mut laps: Vec<Lap> = Vec::new();
    let (mut frames, mut last_t) = (0u64, 0u64);
    let mut cutter = LapCutter::new(player.game_id());
    let mut tracker = crate::dash::Tracker::default();
    let mut framer = Framer::default();
    while let Some(step) = player.step() {
        last_t = step.t_ms;
        let wall_ms = header.started_unix_ms + step.t_ms as i64;
        let list: Vec<Frame> = match step.out {
            Out::Frames(list) => list,
            Out::Lmu(snapshot) => {
                let snapshot = *snapshot;
                framer.frame(snapshot.telemetry.as_ref(), snapshot.scoring).into_iter().collect()
            }
        };
        for frame in list {
            frames += 1;
            // One door can serve several games (F1): its laps start over under the game's own id.
            let game = player.game_id();
            if cutter.game() != game {
                cutter = LapCutter::new(game);
            }
            tracker.on_game_frame(game, player.game_name(), &frame, wall_ms);
            for mut lap in cutter.on_frame(&frame, wall_ms) {
                finish_lap(player, &framer, &mut lap);
                laps.push(lap);
            }
        }
    }
    // The capture ended like a game that closed: what still waited for its time is written as it stands.
    let end_ms = header.started_unix_ms + last_t as i64;
    for mut lap in cutter.finish(end_ms) {
        finish_lap(player, &framer, &mut lap);
        laps.push(lap);
    }
    let laps = laps
        .into_iter()
        .map(|lap| {
            let findings = crate::sanity::check(&lap);
            LapResult { lap, findings }
        })
        .collect();
    Report {
        header,
        frames,
        ticks: player.ticks,
        duration_s: last_t as f64 / 1000.0,
        laps,
        problem: player.problem().map(str::to_owned),
    }
}

/// The reader's last touch on a finished lap (`Source::finish_lap`).
fn finish_lap(player: &Player, framer: &crate::lmu::source::Framer, lap: &mut Lap) {
    match player.source() {
        Some(source) => source.finish_lap(lap),
        // Le Mans Ultimate (what `LmuSource::finish_lap` does): the sectors scoring gave for the lap.
        None => {
            if lap.sectors_ms.is_none() {
                lap.sectors_ms = framer.sectors_of(lap);
            }
        }
    }
}

// ---- what a replay must give ----------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Clockwise,
    CounterClockwise,
}

impl Direction {
    fn word(self) -> &'static str {
        match self {
            Direction::Clockwise => "clockwise",
            Direction::CounterClockwise => "counter_clockwise",
        }
    }
}

/// What a replay must give, from `NAME.expect.json` next to the capture. Every key is optional:
///
/// ```json
/// {
///   "laps": 3,                       // laps cut (default: at least one)
///   "valid": 2,                      // of them valid
///   "allow": ["dist_vs_track"],      // sanity finding ids that are known and accepted (default: none)
///   "steer": "right_positive",       // steering right is positive ("right_negative" for a game that does the opposite)
///   "clutch": "released_0",          // the clutch is 0 when released ("released_1", or "none" for a car without one)
///   "map_direction": "clockwise",    // the way the circuit is driven, seen from above with x east and z north
///   "notes": "free text"
/// }
/// ```
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Expect {
    pub laps: Option<usize>,
    pub valid: Option<usize>,
    pub allow: Vec<String>,
    /// `Some(true)`: steering right is positive.
    pub steer_right_positive: Option<bool>,
    pub clutch: Option<Clutch>,
    pub map_direction: Option<Direction>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Clutch {
    ReleasedZero,
    ReleasedOne,
    None,
}

impl Expect {
    pub fn parse(text: &str) -> Result<Expect, String> {
        let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
        let object = v.as_object().ok_or("not a JSON object")?;
        let mut expect = Expect::default();
        for (key, value) in object {
            let count = || {
                value
                    .as_u64()
                    .map(|n| n as usize)
                    .ok_or_else(|| format!("{key} must be a whole number"))
            };
            let word = || value.as_str().ok_or_else(|| format!("{key} must be a word"));
            match key.as_str() {
                "laps" => expect.laps = Some(count()?),
                "valid" => expect.valid = Some(count()?),
                "allow" => {
                    let list = value.as_array().ok_or("allow must be a list of finding ids")?;
                    for id in list {
                        expect
                            .allow
                            .push(id.as_str().ok_or("allow must be a list of finding ids")?.to_owned());
                    }
                }
                "steer" => {
                    expect.steer_right_positive = Some(match word()? {
                        "right_positive" => true,
                        "right_negative" => false,
                        other => return Err(format!("steer is right_positive or right_negative, not {other:?}")),
                    })
                }
                "clutch" => {
                    expect.clutch = Some(match word()? {
                        "released_0" => Clutch::ReleasedZero,
                        "released_1" => Clutch::ReleasedOne,
                        "none" => Clutch::None,
                        other => return Err(format!("clutch is released_0, released_1 or none, not {other:?}")),
                    })
                }
                "map_direction" => {
                    expect.map_direction = Some(match word()? {
                        "clockwise" => Direction::Clockwise,
                        "counter_clockwise" => Direction::CounterClockwise,
                        other => return Err(format!("map_direction is clockwise or counter_clockwise, not {other:?}")),
                    })
                }
                "notes" => {}
                other => {
                    return Err(format!(
                        "unknown key {other:?} (laps, valid, allow, steer, clutch, map_direction, notes)"
                    ))
                }
            }
        }
        Ok(expect)
    }
}

/// What the laps of a replay show about the conventions a reader guesses.
#[derive(Debug, Default)]
pub struct Metrics {
    /// How well steering right goes with a right turn of the path, -1 to 1 (mean over the laps that can tell).
    pub steer_correlation: Option<f64>,
    /// The median clutch while the car is on the throttle at speed in a gear, and how many samples it is of.
    pub clutch_at_speed: Option<(f32, usize)>,
    /// Whether the lap gave any clutch value at all.
    pub has_clutch: bool,
    /// The way each lap goes round, from its path.
    pub directions: Vec<(u32, Direction)>,
}

fn column<'a>(lap: &'a Lap, id: &str) -> Option<&'a [f32]> {
    lap.channels.iter().find(|c| c.id == id).map(|c| c.values.as_slice())
}

/// Twice the signed area of the path (x east, z north): positive is counter-clockwise.
fn signed_area(x: &[f32], z: &[f32]) -> f64 {
    let points: Vec<(f64, f64)> = x
        .iter()
        .zip(z)
        .filter(|(x, z)| x.is_finite() && z.is_finite())
        .map(|(x, z)| (f64::from(*x), f64::from(*z)))
        .collect();
    let mut area = 0.0;
    for (i, (ax, az)) in points.iter().enumerate() {
        let (bx, bz) = points[(i + 1) % points.len()];
        area += ax * bz - bx * az;
    }
    area
}

pub fn metrics(laps: &[LapResult]) -> Metrics {
    let mut m = Metrics::default();
    let mut correlations = Vec::new();
    let mut clutch_samples: Vec<f32> = Vec::new();
    for result in laps {
        let lap = &result.lap;
        let (x, z) = (column(lap, "x"), column(lap, "z"));
        if let (Some(steer), Some(x), Some(z)) = (column(lap, "steer"), x, z) {
            correlations.extend(crate::sanity::steer_turn_correlation(steer, x, z));
        }
        if let (Some(x), Some(z)) = (x, z) {
            let whole = lap.in_lap != Some(true) && lap.out_lap != Some(true);
            let area = signed_area(x, z);
            if whole && area != 0.0 {
                let direction = if area > 0.0 {
                    Direction::CounterClockwise
                } else {
                    Direction::Clockwise
                };
                m.directions.push((lap.lap_number, direction));
            }
        }
        if let Some(clutch) = column(lap, "clutch") {
            m.has_clutch |= clutch.iter().any(|c| c.is_finite());
            let speed = column(lap, "speed");
            let throttle = column(lap, "throttle");
            let gear = column(lap, "gear");
            for (i, c) in clutch.iter().enumerate() {
                let at = |col: Option<&[f32]>| col.and_then(|v| v.get(i)).copied();
                let moving = at(speed).is_some_and(|s| s > 15.0);
                let on_throttle = at(throttle).is_some_and(|t| t > 0.5);
                let in_gear = at(gear).is_none_or(|g| g >= 2.0);
                if c.is_finite() && moving && on_throttle && in_gear {
                    clutch_samples.push(*c);
                }
            }
        }
    }
    if !correlations.is_empty() {
        m.steer_correlation = Some(correlations.iter().sum::<f64>() / correlations.len() as f64);
    }
    if !clutch_samples.is_empty() {
        clutch_samples.sort_by(f32::total_cmp);
        m.clutch_at_speed = Some((clutch_samples[clutch_samples.len() / 2], clutch_samples.len()));
    }
    m
}

/// How far a steering correlation must be from zero to be believed one way or the other.
const STEER_SURE: f64 = 0.3;

/// What is wrong with the replay, against what is expected: one line each. Empty when it is as expected.
pub fn verify(report: &Report, expect: &Expect) -> Vec<String> {
    let mut problems = Vec::new();
    if let Some(problem) = &report.problem {
        problems.push(format!("the capture file is cut: {problem}"));
    }
    match expect.laps {
        Some(n) if report.laps.len() != n => problems.push(format!("expected {n} laps, the replay cut {}", report.laps.len())),
        None if report.laps.is_empty() => problems.push("the replay cut no lap".into()),
        _ => {}
    }
    if let Some(n) = expect.valid {
        let valid = report.laps.iter().filter(|l| l.lap.valid).count();
        if valid != n {
            problems.push(format!("expected {n} valid laps, there are {valid}"));
        }
    }
    for result in &report.laps {
        for finding in &result.findings {
            if !expect.allow.iter().any(|id| id == finding.id) {
                problems.push(format!(
                    "lap {}: data check {}: {}",
                    result.lap.lap_number, finding.id, finding.detail
                ));
            }
        }
    }
    let m = metrics(&report.laps);
    if let Some(right_positive) = expect.steer_right_positive {
        match m.steer_correlation {
            None => problems.push("cannot judge the steering: no lap has steering and a path to compare".into()),
            Some(r) if right_positive && r < STEER_SURE => problems.push(format!(
                "expected steering right to be positive, but the steering goes against the path (correlation {r:.2})"
            )),
            Some(r) if !right_positive && r > -STEER_SURE => problems.push(format!(
                "expected steering right to be negative, but the steering goes with the path (correlation {r:.2})"
            )),
            _ => {}
        }
    }
    match (expect.clutch, m.clutch_at_speed) {
        (Some(Clutch::None), _) if m.has_clutch => problems.push("expected a car with no clutch, but the replay has clutch values".into()),
        (Some(Clutch::ReleasedZero), Some((c, n))) if c >= 0.2 => problems.push(format!(
            "expected the clutch to be 0 when released, but it reads {c:.2} (median of {n} samples at speed on the throttle)"
        )),
        (Some(Clutch::ReleasedOne), Some((c, n))) if c <= 0.8 => problems.push(format!(
            "expected the clutch to be 1 when released, but it reads {c:.2} (median of {n} samples at speed on the throttle)"
        )),
        (Some(Clutch::ReleasedZero | Clutch::ReleasedOne), None) => {
            problems.push("cannot judge the clutch: no samples at speed on the throttle with a clutch value".into())
        }
        _ => {}
    }
    if let Some(want) = expect.map_direction {
        if m.directions.is_empty() {
            problems.push("cannot judge the map direction: no whole lap with a path".into());
        }
        for (lap, got) in &m.directions {
            if *got != want {
                problems.push(format!(
                    "lap {lap}: expected the circuit {}, the path goes {}",
                    want.word(),
                    got.word()
                ));
            }
        }
    }
    problems
}

/// The sidecar of a capture: `a/b.xcap` has `a/b.expect.json`.
pub fn sidecar_of(capture: &Path) -> std::path::PathBuf {
    let name = capture.file_name().and_then(|n| n.to_str()).unwrap_or("capture");
    let stem = name.strip_suffix(".xcap").unwrap_or(name);
    capture.with_file_name(format!("{stem}.expect.json"))
}

fn load_expect(path: &Path) -> Result<Option<Expect>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Expect::parse(&text).map(Some).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Replays a capture file in memory-light streaming, fast.
pub fn replay_file(path: &Path, pace: Pace) -> Result<Report, String> {
    let reader = Reader::from_file(path)?;
    let mut player = Player::new(reader, pace)?;
    Ok(run(&mut player))
}

// ---- the command ----------------------------------------------------------------------------------------------

fn distance_text(lap: &Lap) -> String {
    let dist = lap
        .channels
        .iter()
        .find(|c| c.id == "dist")
        .and_then(|c| c.values.iter().rev().copied().find(|v| v.is_finite()));
    match (dist, lap.track_length_m) {
        (Some(d), Some(l)) if l > 0.0 => format!("{d:.0} m of {l:.0} m ({:+.1}%)", (f64::from(d) - l) / l * 100.0),
        (Some(d), _) => format!("{d:.0} m (no track length)"),
        _ => "-".into(),
    }
}

/// The text the `replay` command prints.
pub fn render(report: &Report, expect: Option<&Expect>) -> String {
    use std::fmt::Write;
    let h = &report.header;
    let mut out = String::new();
    let _ = writeln!(
        out,
        "{} ({}), captured by Xpeed Companion {} at {}{}",
        h.game,
        h.family,
        h.companion,
        h.started_at,
        h.game_build.as_ref().map_or(String::new(), |b| format!(", game build {b}"))
    );
    let _ = writeln!(
        out,
        "{:.1} s, {} readings, {} frames, {} laps cut",
        report.duration_s,
        report.ticks,
        report.frames,
        report.laps.len()
    );
    if let Some(problem) = &report.problem {
        let _ = writeln!(out, "WARNING: the file is cut: {problem}");
    }
    if !report.laps.is_empty() {
        let _ = writeln!(
            out,
            "{:>4}  {:<9}  {:<5}  {:>7}  {:<30}  data checks",
            "lap", "time", "valid", "samples", "distance"
        );
    }
    for r in &report.laps {
        let lap = &r.lap;
        let flags = [(lap.out_lap, " out"), (lap.in_lap, " in")]
            .iter()
            .filter(|(on, _)| *on == Some(true))
            .map(|(_, w)| *w)
            .collect::<String>();
        let checks = if r.findings.is_empty() {
            "none".to_owned()
        } else {
            r.findings
                .iter()
                .map(|f| format!("{} ({})", f.id, f.detail))
                .collect::<Vec<_>>()
                .join("; ")
        };
        let _ = writeln!(
            out,
            "{:>4}  {:<9}  {:<5}  {:>7}  {:<30}  {}{}",
            lap.lap_number,
            clock(lap.time_ms),
            if lap.valid { "yes" } else { "no" },
            lap.sample_count(),
            distance_text(lap),
            checks,
            flags
        );
    }
    let m = metrics(&report.laps);
    if let Some(r) = m.steer_correlation {
        let _ = writeln!(
            out,
            "steering: correlation with the path {r:+.2} ({})",
            if r >= STEER_SURE {
                "right is positive"
            } else if r <= -STEER_SURE {
                "right is NEGATIVE"
            } else {
                "unclear"
            }
        );
    }
    match m.clutch_at_speed {
        Some((c, n)) => {
            let _ = writeln!(out, "clutch: median {c:.2} at speed on the throttle ({n} samples)");
        }
        None if m.has_clutch => {
            let _ = writeln!(out, "clutch: values, but none at speed on the throttle");
        }
        None => {
            let _ = writeln!(out, "clutch: not given");
        }
    }
    if !m.directions.is_empty() {
        let words: Vec<&str> = m.directions.iter().map(|(_, d)| d.word()).collect();
        let _ = writeln!(out, "path: {}", words.join(", "));
    }
    match expect {
        Some(expect) => {
            let problems = verify(report, expect);
            if problems.is_empty() {
                let _ = writeln!(out, "expectations: all met");
            } else {
                let _ = writeln!(out, "expectations: {} not met", problems.len());
                for p in problems {
                    let _ = writeln!(out, "  - {p}");
                }
            }
        }
        None => {
            let _ = writeln!(out, "expectations: none (no .expect.json next to the capture)");
        }
    }
    out
}

fn file_safe(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect()
}

/// Writes the laps of a replay as lap files, stamped and checked like the ones the app writes.
fn write_laps(dir: &Path, report: &Report) -> Result<usize, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    for r in &report.laps {
        let (lap, _) = crate::sanity::prepare(&r.lap);
        let stamp: String = lap.started_at.chars().filter(char::is_ascii_digit).take(14).collect();
        let name = format!(
            "{}_{}_lap{}_{}.xlap.gz",
            file_safe(&lap.track_name),
            file_safe(&lap.car_name),
            lap.lap_number,
            stamp
        );
        let bytes = crate::lapfile::gzip(&lap).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(&name), bytes).map_err(|e| format!("cannot write {name}: {e}"))?;
    }
    Ok(report.laps.len())
}

pub fn command(file: &Path, laps_out: Option<&Path>, speed: Option<f64>) -> ExitCode {
    let report = match replay_file(file, speed.map_or(Pace::Fast, Pace::Realtime)) {
        Ok(report) => report,
        Err(why) => {
            eprintln!("{why}");
            return ExitCode::from(1);
        }
    };
    let sidecar = sidecar_of(file);
    let expect = match load_expect(&sidecar) {
        Ok(expect) => expect,
        Err(why) => {
            eprintln!("{why}");
            return ExitCode::from(1);
        }
    };
    print!("{}", render(&report, expect.as_ref()));
    if let Some(dir) = laps_out {
        match write_laps(dir, &report) {
            Ok(n) => println!("Wrote {n} lap file(s) to {}", dir.display()),
            Err(why) => {
                eprintln!("{why}");
                return ExitCode::from(1);
            }
        }
    }
    match expect {
        Some(e) if !verify(&report, &e).is_empty() => ExitCode::from(1),
        _ => ExitCode::SUCCESS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::testing::{header, Shared};
    use crate::capture::{lmu_stream, open_stream, Writer};
    use crate::games::kunos::capture_fixture::lap_ms;
    use crate::lmu::layout::*;
    use crate::lmu::snapshot::fake::Memory;
    use crate::lmu::snapshot::{PlayerTelemetry, SessionScoring, VehicleScoring};

    fn reader_of(sink: &Shared) -> Reader {
        Reader::from_bytes(sink.0.lock().unwrap().clone()).unwrap()
    }

    // ---- a synthetic drive of Assetto Corsa, built from the reader's own pages --------------------------------

    fn kunos_report(laps: u32, steer: f32) -> Report {
        let bytes = crate::games::kunos::capture_fixture::synthetic_capture(laps, steer);
        let mut player = Player::new(Reader::from_bytes(bytes).unwrap(), Pace::Fast).unwrap();
        run(&mut player)
    }

    #[test]
    fn a_synthetic_capture_goes_through_the_reader_the_cutter_and_the_checks() {
        let report = kunos_report(3, 0.3);
        assert_eq!((report.header.game.as_str(), report.header.family.as_str()), ("ac", "kunos"));
        assert!(report.problem.is_none());
        assert_eq!(report.frames, 3 * 1000 + 10);
        // Three laps on a 1000 m circle (25, 26 and 27 s); the fourth is begun, which closes the third.
        assert_eq!(report.laps.len(), 3, "{}", render(&report, None));
        for (i, r) in report.laps.iter().enumerate() {
            assert!(r.lap.valid, "{}", render(&report, None));
            assert_eq!(u64::from(r.lap.time_ms), lap_ms(i as u32));
            assert_eq!(r.lap.lap_number, i as u32 + 1);
            assert_eq!(r.lap.sample_count(), 1000);
            assert!(r.findings.is_empty(), "{}", render(&report, None));
        }
        let m = metrics(&report.laps);
        assert!(m.steer_correlation.unwrap() > 0.9, "{m:?}");
        assert!(m.directions.iter().all(|(_, d)| *d == Direction::Clockwise));
        let expect =
            Expect::parse(r#"{"laps": 3, "valid": 3, "steer": "right_positive", "clutch": "none", "map_direction": "clockwise"}"#).unwrap();
        assert_eq!(verify(&report, &expect), Vec::<String>::new());
        assert!(render(&report, Some(&expect)).contains("expectations: all met"));
    }

    #[test]
    fn a_reader_that_got_the_steering_wrong_is_caught() {
        let report = kunos_report(3, -0.3);
        assert!(
            report.laps.iter().all(|r| r.findings.iter().any(|f| f.id == "map_mirrored")),
            "{}",
            render(&report, None)
        );
        let problems = verify(&report, &Expect::parse(r#"{"steer": "right_positive"}"#).unwrap());
        assert!(
            problems.iter().any(|p| p.contains("steering goes against the path")),
            "{problems:?}"
        );
        assert!(problems.iter().any(|p| p.contains("map_mirrored")), "{problems:?}");
        // A game that really steers the other way says so, and the finding is accepted.
        let allowed = Expect::parse(r#"{"steer": "right_negative", "allow": ["map_mirrored"]}"#).unwrap();
        assert_eq!(verify(&report, &allowed), Vec::<String>::new());
    }

    #[test]
    fn what_is_expected_is_checked() {
        let report = kunos_report(2, 0.3);
        let problems = verify(
            &report,
            &Expect::parse(r#"{"laps": 5, "valid": 1, "map_direction": "counter_clockwise", "clutch": "released_0"}"#).unwrap(),
        );
        assert_eq!(problems.len(), 5, "{problems:?}");
        assert!(problems[0].contains("expected 5 laps") && problems[1].contains("expected 1 valid laps, there are 2"));
        assert_eq!(problems.iter().filter(|p| p.contains("path goes clockwise")).count(), 2);
        assert!(problems.iter().any(|p| p.contains("cannot judge the clutch")));
        // With nothing said: a lap must be cut and nothing may be found.
        assert!(verify(&report, &Expect::default()).is_empty());
        let empty = Report {
            laps: Vec::new(),
            ..kunos_report(1, 0.3)
        };
        assert_eq!(verify(&empty, &Expect::default()), ["the replay cut no lap"]);
    }

    #[test]
    fn the_replay_is_a_source_that_gives_the_recorded_frames_at_their_recorded_time() {
        let bytes = crate::games::kunos::capture_fixture::synthetic_capture(1, 0.3);
        let mut source = ReplaySource::new(Reader::from_bytes(bytes).unwrap(), Pace::Fast).unwrap();
        assert_eq!((source.game_id(), source.game_name()), ("ac", "Assetto Corsa"));
        assert!(!source.listens() && source.caps().has(Caps::STEER));
        let first = source.next(Duration::ZERO).unwrap();
        let second = source.next(Duration::ZERO).unwrap();
        assert_eq!((first.clock_s, second.clock_s), (0.0, 0.025));
        assert!(first.driving && first.lap == 1 && (first.speed_ms - 40.0).abs() < 0.01);
        let mut n = 2;
        while source.next(Duration::ZERO).is_some() {
            n += 1;
        }
        assert_eq!(n, 1000 + 10);
        assert!(!source.alive());
    }

    #[test]
    fn a_realtime_replay_waits_for_the_recorded_time() {
        let bytes = crate::games::kunos::capture_fixture::synthetic_capture(1, 0.3);
        // 25 s of driving at 500 times the speed takes 50 ms.
        let started = Instant::now();
        let mut source = ReplaySource::new(Reader::from_bytes(bytes).unwrap(), Pace::Realtime(500.0)).unwrap();
        while source.next(Duration::ZERO).is_some() {}
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(45) && took < Duration::from_secs(5), "{took:?}");
    }

    #[test]
    fn a_capture_of_a_family_with_no_reader_cannot_be_played() {
        let sink = Shared::default();
        Writer::new(sink.clone(), &header("x", "nothing")).unwrap().finish().unwrap();
        let err = Player::new(reader_of(&sink), Pace::Fast).err().unwrap();
        assert!(err.contains("nothing"), "{err}");
    }

    #[test]
    fn a_capture_cut_short_is_played_as_far_as_it_goes_and_said_to_be_cut() {
        let bytes = crate::games::kunos::capture_fixture::synthetic_capture(2, 0.3);
        let cut = bytes[..bytes.len() * 3 / 5].to_vec();
        let mut player = Player::new(Reader::from_bytes(cut).unwrap(), Pace::Fast).unwrap();
        let report = run(&mut player);
        assert!(report.problem.is_some() && report.frames > 100 && report.frames < 2010);
        assert!(verify(&report, &Expect::default()).iter().any(|p| p.contains("cut")));
    }

    #[test]
    fn a_capture_file_with_its_sidecar_is_replayed_and_its_laps_written() {
        let dir = crate::config::scratch_dir("replay");
        let path = dir.join("synthetic-ac.xcap");
        std::fs::write(&path, crate::games::kunos::capture_fixture::synthetic_capture(3, 0.3)).unwrap();
        std::fs::write(
            sidecar_of(&path),
            r#"{"laps": 3, "valid": 3, "steer": "right_positive", "map_direction": "clockwise"}"#,
        )
        .unwrap();
        let report = replay_file(&path, Pace::Fast).unwrap();
        let expect = load_expect(&sidecar_of(&path)).unwrap().unwrap();
        assert_eq!(verify(&report, &expect), Vec::<String>::new());
        let text = render(&report, Some(&expect));
        assert!(
            text.contains("0:25.000") && text.contains("0:27.000") && text.contains("expectations: all met"),
            "{text}"
        );
        let out = dir.join("laps");
        assert_eq!(write_laps(&out, &report).unwrap(), 3);
        let mut files: Vec<_> = std::fs::read_dir(&out).unwrap().map(|e| e.unwrap().path()).collect();
        files.sort();
        assert_eq!(files.len(), 3);
        let lap = crate::lapfile::gunzip(&std::fs::read(&files[0]).unwrap(), crate::lapfile::MAX_UNPACKED).unwrap();
        assert_eq!((lap.game.as_str(), lap.lap_number, lap.time_ms), ("ac", 1, 25_000));
        assert!(lap.recorder.is_some(), "stamped like the app's own laps");
        assert!(replay_file(&dir.join("missing.xcap"), Pace::Fast).is_err());
    }

    // ---- Le Mans Ultimate --------------------------------------------------------------------------------------

    fn lmu_capture() -> Shared {
        let sink = Shared::default();
        let mut w = Writer::new(sink.clone(), &header("lmu", "lmu")).unwrap();
        w.record(0, &open_stream("LMU_Data"), &(LAYOUT_SIZE as u64).to_le_bytes()).unwrap();
        for (i, lap) in [(0u64, 2), (10, 3)] {
            let mut mem = Memory::new();
            let car = PlayerTelemetry {
                lap_number: lap,
                elapsed_time: 100.0 + i as f64,
                vehicle_name: "Car".into(),
                track_name: "Track".into(),
                steering: -0.25,
                ..PlayerTelemetry::default()
            };
            mem.telemetry(0, 1, &car);
            let session = SessionScoring {
                track_name: "Track".into(),
                track_length_m: 5000.0,
                ..SessionScoring::default()
            };
            mem.scoring(&session, &[VehicleScoring::default()], Some(0));
            mem.set_events(&[SME_UPDATE_TELEMETRY, SME_UPDATE_SCORING]);
            w.tick();
            // The ranges the reader copies: the header, the telemetry slot, the scoring.
            let ranges = [
                (0, GENERIC_GAME_VERSION + 4),
                (TELEMETRY_ACTIVE_VEHICLES, 3),
                (TELEMETRY_INFO, TELEM_INFO_SIZE),
                (SCORING_INFO, SCORING_INFO_SIZE),
                (SCORING_VEHICLES, VEHICLE_SCORING_SIZE),
            ];
            for (at, len) in ranges {
                w.record(i * 10, &lmu_stream(at, len), &mem.0[at..at + len]).unwrap();
            }
        }
        w.finish().unwrap();
        sink
    }

    #[test]
    fn a_le_mans_ultimate_capture_rebuilds_the_buffer_and_gives_snapshots() {
        let sink = lmu_capture();
        let mut player = Player::new(reader_of(&sink), Pace::Fast).unwrap();
        assert_eq!((player.game_id(), player.game_name()), ("lmu", "Le Mans Ultimate"));
        let mut laps = Vec::new();
        while let Some(step) = player.step() {
            let Out::Lmu(snapshot) = step.out else { panic!("not a snapshot") };
            let t = snapshot.telemetry.expect("the player's car");
            laps.push((t.lap_number, t.steering));
            assert_eq!(snapshot.scoring.as_ref().unwrap().session.track_length_m, 5000.0);
        }
        assert_eq!(laps, [(2, -0.25), (3, -0.25)]);
        let mut again = Player::new(reader_of(&sink), Pace::Fast).unwrap();
        let report = run(&mut again);
        assert_eq!((report.frames, report.ticks), (2, 2));
        assert!(ReplaySource::new(reader_of(&sink), Pace::Fast).is_err());
    }

    // ---- the fixtures ------------------------------------------------------------------------------------------

    #[test]
    fn a_sidecar_is_named_after_its_capture() {
        assert_eq!(
            sidecar_of(Path::new("a/b/acevo-laguna.xcap")),
            Path::new("a/b/acevo-laguna.expect.json")
        );
    }

    #[test]
    fn a_sidecar_with_a_mistake_is_refused() {
        for bad in [
            "[]",
            "{\"lap\": 3}",
            "{\"laps\": \"3\"}",
            "{\"steer\": \"left\"}",
            "{\"clutch\": 1}",
            "{\"allow\": [3]}",
            "{\"map_direction\": \"up\"}",
            "not json",
        ] {
            assert!(Expect::parse(bad).is_err(), "{bad}");
        }
        let all = Expect::parse(r#"{"laps":2,"valid":1,"allow":["a","b"],"steer":"right_negative","clutch":"released_1","map_direction":"counter_clockwise","notes":"x"}"#).unwrap();
        assert_eq!(
            all,
            Expect {
                laps: Some(2),
                valid: Some(1),
                allow: vec!["a".into(), "b".into()],
                steer_right_positive: Some(false),
                clutch: Some(Clutch::ReleasedOne),
                map_direction: Some(Direction::CounterClockwise),
            }
        );
    }

    /// Every `fixtures/*.xcap` is replayed and must meet its `NAME.expect.json` (laps cut, no data check but the ones
    /// listed, the conventions). With no fixture in the folder this passes: it is the harness.
    #[test]
    fn every_fixture_replays_and_meets_its_expectations() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        names.sort();
        let mut failures = Vec::new();
        for name in &names {
            if let Some(stem) = name.strip_suffix(".expect.json") {
                if !names.iter().any(|n| n == &format!("{stem}.xcap")) {
                    failures.push(format!("{name}: there is no {stem}.xcap for it"));
                }
            }
        }
        for name in names.iter().filter(|n| n.ends_with(".xcap")) {
            let path = dir.join(name);
            let result = replay_file(&path, Pace::Fast).and_then(|report| {
                let expect = load_expect(&sidecar_of(&path))?.unwrap_or_default();
                Ok((verify(&report, &expect), render(&report, Some(&expect))))
            });
            match result {
                Ok((problems, _)) if problems.is_empty() => {}
                Ok((problems, text)) => failures.push(format!("{name}:\n  {}\n{text}", problems.join("\n  "))),
                Err(why) => failures.push(format!("{name}: {why}")),
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
