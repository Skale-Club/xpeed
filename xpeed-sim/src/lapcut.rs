//! Cutting the frames of any game (see `game.rs`) into laps.
//!
//! * A lap runs from one change of the game's lap number (up by one) to the next.
//! * `t` is the time on the lap on the game's own clock when it gives one (no drift), else the time since the lap's
//!   first frame; `dist` is the game's distance on the lap when it gives one, else the integral of the speed.
//! * A finished lap waits a few seconds for the game's official time of the last lap. If it never comes (or the game
//!   gives none), the lap is written with the time measured here and `valid: false`.
//! * A lap is kept only if it was seen from its start (no joining mid-lap), is at least 5 seconds long and has at
//!   least 50 samples.
//! * `valid` is a judgement from what the game gives: the official time matches the measured duration, the car was
//!   never in the pits, and the game did not call the lap invalid (when it says anything about that).
//! * Version 2 of the lap file (see `lapfile.rs`) adds what the cutter knows around the lap:
//!   - the session id: one per game session, made when the first frame comes and again whenever the session ends (the
//!     track or the car changes, the kind of session changes, the lap number goes back or the lap clock jumps back: a
//!     restart). A cutter is made again when a game is opened again, which starts a session as well. Every lap cut
//!     from the frames of one session carries that session's id, including a lap that finishes after the next begins;
//!   - the out lap and the in lap, from the pit flag of the frames: a lap whose first frame is in the pits is an out
//!     lap, a lap whose last frame is in the pits is an in lap. A lap that goes through the pits and is back on the
//!     track before the line is neither (it is not `valid` either);
//!   - the sector times, when the frames carry the first two (`Frame::sectors_ms`): the third is the official lap time
//!     minus them, and only a lap whose official time came (and matches the clock) gets sectors;
//!   - the weather, the temperatures and the tyre compound, as the game last said them during the lap, and the
//!     channels of `extra.rs`.
//!
//! The Le Mans Ultimate reader has its own cutter (`recorder.rs`) because its distance and times come from a second
//! stream; everything else goes through this one.

use crate::extra::Extras;
use crate::game::Frame;
use crate::lapfile::{Channel, Lap, SessionKind, STANDARD_UNITS};
use crate::util::{iso_utc, new_session_id};

pub const MIN_SAMPLES: usize = 50;
pub const MIN_LAP_SECONDS: f64 = 5.0;
/// How long a finished lap waits for its official time.
const MAX_PENDING_SECONDS: f64 = 3.0;
/// A longer silence between two frames is not integrated into distance.
const MAX_GAP_SECONDS: f64 = 0.5;
/// A first frame later than this into a lap means we joined mid-lap.
const PARTIAL_START_SECONDS: f64 = 1.5;
/// Without a lap clock, a first frame further than this along the lap means we joined mid-lap.
const PARTIAL_START_METRES: f64 = 60.0;
const LAP_TIME_MATCH_SECONDS: f64 = 0.5;

struct Meta {
    game: &'static str,
    car: String,
    car_class: Option<String>,
    track: String,
    track_variant: Option<String>,
    track_length_m: Option<f64>,
}

#[derive(Default)]
struct Columns {
    t: Vec<f32>,
    dist: Vec<f32>,
    speed: Vec<f32>,
    rpm: Vec<f32>,
    gear: Vec<f32>,
    throttle: Vec<f32>,
    brake: Vec<f32>,
    clutch: Vec<f32>,
    steer: Vec<f32>,
    x: Vec<f32>,
    y: Vec<f32>,
    z: Vec<f32>,
    fuel: Vec<f32>,
}

/// What a game session is to the cutter: the id its laps carry and its kind (when the game says).
struct Session {
    id: String,
    kind: Option<SessionKind>,
}

/// A short text a game gave, kept only if it is one the lap file takes: no control characters, cut to `max`
/// characters, trimmed; `None` when nothing is left.
fn label(text: &str, max: usize) -> Option<String> {
    let cleaned: String = text.chars().filter(|c| *c as u32 > 0x1f && *c as u32 != 0x7f).collect();
    let cleaned: String = cleaned.trim().chars().take(max).collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// A temperature rounded to a tenth of a degree, when it is one the lap file takes.
fn degrees(c: f32) -> Option<f64> {
    let tenth = (f64::from(c) * 10.0).round() / 10.0;
    (c.is_finite() && (-100.0..=200.0).contains(&tenth)).then_some(tenth)
}

struct InProgress {
    number: i32,
    session: String,
    session_kind: Option<SessionKind>,
    started_in_pits: bool,
    last_in_pits: bool,
    sectors: [Option<u32>; 2],
    weather: Option<String>,
    air_temp_c: Option<f64>,
    track_temp_c: Option<f64>,
    tyre_compound: Option<String>,
    extras: Extras,
    first_clock: f64,
    first_wall_ms: i64,
    /// The official time showing when the lap began (the one before it): a different one means this lap's has come.
    official_at_start: Option<f64>,
    partial: bool,
    touched_pits: bool,
    called_invalid: bool,
    columns: Columns,
    meta: Meta,
    last_clock: f64,
    last_lap_time: Option<f64>,
    dist: f64,
}

struct Pending {
    lap: InProgress,
    closed_clock: f64,
}

pub struct LapCutter {
    game: &'static str,
    current: Option<InProgress>,
    pending: Option<Pending>,
    /// The session being driven; `None` until the first frame, and after one ends.
    session: Option<Session>,
}

fn ms(seconds: f64) -> u32 {
    (seconds * 1000.0).round().max(0.0) as u32
}

impl LapCutter {
    pub fn new(game: &'static str) -> LapCutter {
        LapCutter {
            game,
            current: None,
            pending: None,
            session: None,
        }
    }

    /// The game id its laps are written with.
    pub fn game(&self) -> &'static str {
        self.game
    }

    /// Feeds one frame and returns the laps that are now complete (usually none).
    pub fn on_frame(&mut self, frame: &Frame, wall_ms: i64) -> Vec<Lap> {
        let mut done = Vec::new();
        if let Some(lap) = self.settle_pending(frame) {
            done.push(lap);
        }
        if !frame.driving {
            return done;
        }
        // A new car or track: what was being driven is over, and so is its session.
        if let Some(cur) = &self.current {
            if (!frame.car.is_empty() && frame.car != cur.meta.car) || (!frame.track.is_empty() && frame.track != cur.meta.track) {
                self.current = None;
                self.session = None;
            }
        }
        if let Some(cur) = &self.current {
            // The lap clock jumping back on the same lap is a restart of the session, and so is the lap number going
            // back. A lap number that jumps ahead only means frames were missed: the lap is lost, the session goes on.
            let restarted =
                frame.lap == cur.number && matches!((frame.lap_time_s, cur.last_lap_time), (Some(now), Some(before)) if now + 1.0 < before);
            if frame.lap < cur.number || restarted {
                self.session = None;
            }
            if frame.lap < cur.number || frame.lap > cur.number + 1 || restarted {
                self.current = None;
            }
        }
        // Another kind of session (practice, then qualifying) is another session.
        if let (Some(session), Some(kind)) = (&mut self.session, frame.session_kind) {
            match session.kind {
                Some(before) if before != kind => {
                    self.current = None;
                    self.session = None;
                }
                None => session.kind = Some(kind),
                _ => {}
            }
        }
        if self.session.is_none() {
            self.session = Some(Session {
                id: new_session_id(),
                kind: frame.session_kind,
            });
        }
        match self.current.take() {
            Some(cur) if frame.lap == cur.number + 1 => {
                self.pending = Some(Pending {
                    lap: cur,
                    closed_clock: frame.clock_s,
                });
                self.current = Some(self.start(frame, wall_ms, false));
            }
            Some(cur) => self.current = Some(cur),
            None => {
                let first = self.start(frame, wall_ms, true);
                self.current = Some(first);
            }
        }
        if let Some(lap) = self.current.as_mut() {
            Self::add_sample(lap, frame);
        }
        done
    }

    fn start(&self, frame: &Frame, wall_ms: i64, joined: bool) -> InProgress {
        let partial = joined
            && match frame.lap_time_s {
                Some(t) => t > PARTIAL_START_SECONDS,
                None => frame.dist_m.is_none_or(|d| d > PARTIAL_START_METRES),
            };
        let session = self.session.as_ref();
        InProgress {
            number: frame.lap,
            session: session.map_or_else(new_session_id, |s| s.id.clone()),
            session_kind: session.and_then(|s| s.kind),
            started_in_pits: frame.in_pits,
            last_in_pits: frame.in_pits,
            sectors: [None; 2],
            weather: None,
            air_temp_c: None,
            track_temp_c: None,
            tyre_compound: None,
            extras: Extras::default(),
            first_clock: frame.clock_s,
            first_wall_ms: wall_ms,
            official_at_start: frame.last_lap_s.filter(|o| *o > 0.0),
            partial,
            touched_pits: false,
            called_invalid: false,
            columns: Columns::default(),
            meta: Meta {
                game: self.game,
                car: frame.car.clone(),
                car_class: frame.car_class.clone(),
                track: frame.track.clone(),
                track_variant: frame.track_variant.clone(),
                track_length_m: frame.track_length_m,
            },
            last_clock: frame.clock_s,
            last_lap_time: None,
            dist: 0.0,
        }
    }

    fn add_sample(lap: &mut InProgress, frame: &Frame) {
        let t = frame.lap_time_s.unwrap_or(frame.clock_s - lap.first_clock);
        let dt = (frame.clock_s - lap.last_clock).clamp(0.0, MAX_GAP_SECONDS);
        lap.dist = match frame.dist_m {
            Some(d) => d.max(0.0),
            None => lap.dist + f64::from(frame.speed_ms.max(0.0)) * dt,
        };
        lap.last_clock = frame.clock_s;
        lap.last_lap_time = frame.lap_time_s;
        lap.touched_pits |= frame.in_pits;
        lap.last_in_pits = frame.in_pits;
        lap.called_invalid |= frame.lap_valid == Some(false);
        // What the game last said about the first two sectors, the conditions and the tyres.
        for (kept, now) in lap.sectors.iter_mut().zip(frame.sectors_ms) {
            *kept = now.or(*kept);
        }
        if let Some(text) = frame.weather.as_deref().and_then(|w| label(w, 32)) {
            lap.weather = Some(text);
        }
        if let Some(text) = frame.tyre_compound.as_deref().and_then(|c| label(c, 40)) {
            lap.tyre_compound = Some(text);
        }
        lap.air_temp_c = frame.air_temp_c.and_then(degrees).or(lap.air_temp_c);
        lap.track_temp_c = frame.track_temp_c.and_then(degrees).or(lap.track_temp_c);
        lap.extras.push(frame);
        if lap.meta.track_length_m.is_none() {
            lap.meta.track_length_m = frame.track_length_m;
        }
        let c = &mut lap.columns;
        c.t.push(t as f32);
        c.dist.push(lap.dist as f32);
        c.speed.push(frame.speed_ms);
        c.rpm.push(frame.rpm);
        c.gear.push(frame.gear);
        c.throttle.push(frame.throttle);
        c.brake.push(frame.brake);
        c.clutch.push(frame.clutch);
        c.steer.push(frame.steer);
        c.x.push(frame.x);
        c.y.push(frame.y);
        c.z.push(frame.z);
        c.fuel.push(frame.fuel_l);
    }

    /// Finishes the pending lap when its official time has come, or when waiting any longer is pointless.
    fn settle_pending(&mut self, frame: &Frame) -> Option<Lap> {
        let pending = self.pending.as_ref()?;
        let arrived = match (frame.last_lap_s, pending.lap.official_at_start) {
            (Some(now), Some(before)) => now > 0.0 && (now - before).abs() > 1e-6,
            (Some(now), None) => now > 0.0,
            (None, _) => false,
        };
        let gave_up = frame.clock_s - pending.closed_clock > MAX_PENDING_SECONDS;
        if !arrived && !gave_up {
            return None;
        }
        let pending = self.pending.take()?;
        Self::finish(pending.lap, if arrived { frame.last_lap_s } else { None })
    }

    fn finish(lap: InProgress, official_s: Option<f64>) -> Option<Lap> {
        let samples = lap.columns.t.len();
        let measured = f64::from(lap.columns.t.last().copied().unwrap_or(0.0));
        if lap.partial || samples < MIN_SAMPLES || measured < MIN_LAP_SECONDS {
            return None;
        }
        let matches = official_s.is_some_and(|o| (o - measured).abs() <= LAP_TIME_MATCH_SECONDS);
        let time_s = official_s.filter(|o| *o > 0.0).unwrap_or(measured);
        let valid = matches && !lap.touched_pits && !lap.called_invalid;
        let sectors_ms = match (matches, lap.sectors) {
            // The third sector is what is left of the official time; a lap whose first two do not fit in it has no sectors.
            (true, [Some(first), Some(second)]) => {
                let total = ms(time_s);
                (u64::from(first) + u64::from(second) < u64::from(total)).then(|| vec![first, second, total - first - second])
            }
            _ => None,
        };
        let columns = lap.columns;
        let mut channels = Vec::new();
        let mut push = |id: &str, values: Vec<f32>| {
            // A column the game never gave is left out; a few missing readings stay as NaN.
            if values.iter().any(|v| v.is_finite()) {
                let unit = STANDARD_UNITS.iter().find(|(name, _)| *name == id).map_or("", |(_, unit)| *unit);
                channels.push(Channel {
                    id: id.into(),
                    unit: unit.into(),
                    values,
                });
            }
        };
        push("t", columns.t);
        push("dist", columns.dist);
        push("speed", columns.speed);
        push("rpm", columns.rpm);
        push("gear", columns.gear);
        push("throttle", columns.throttle);
        push("brake", columns.brake);
        push("clutch", columns.clutch);
        push("steer", columns.steer);
        push("x", columns.x);
        push("y", columns.y);
        push("z", columns.z);
        push("fuel", columns.fuel);
        channels.extend(lap.extras.into_channels());
        let rate = if measured > 0.0 { samples as f64 / measured } else { 1.0 };
        Some(Lap {
            game: lap.meta.game.into(),
            track_name: if lap.meta.track.is_empty() {
                "Unknown track".into()
            } else {
                lap.meta.track
            },
            track_variant: lap.meta.track_variant,
            track_length_m: lap.meta.track_length_m.filter(|m| *m > 0.0 && *m <= 100_000.0),
            car_name: if lap.meta.car.is_empty() {
                "Unknown car".into()
            } else {
                lap.meta.car
            },
            car_class: lap.meta.car_class,
            lap_number: lap.number.max(0) as u32,
            time_ms: ms(time_s),
            valid,
            sectors_ms,
            started_at: iso_utc(lap.first_wall_ms),
            sample_rate_hz: rate.clamp(0.1, 1000.0),
            session_id: Some(lap.session),
            session_kind: lap.session_kind,
            weather: lap.weather,
            air_temp_c: lap.air_temp_c,
            track_temp_c: lap.track_temp_c,
            tyre_compound: lap.tyre_compound,
            in_lap: Some(lap.last_in_pits),
            out_lap: Some(lap.started_in_pits),
            channels,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(clock: f64, lap: i32, lap_time: Option<f64>, last: Option<f64>, dist: Option<f64>) -> Frame {
        let mut f = Frame::empty();
        f.clock_s = clock;
        f.driving = true;
        f.lap = lap;
        f.lap_time_s = lap_time;
        f.last_lap_s = last;
        f.dist_m = dist;
        f.speed_ms = 50.0;
        f.rpm = 7000.0;
        f.gear = 4.0;
        f.throttle = 1.0;
        f.brake = 0.0;
        f.car = "Test Car".into();
        f.track = "Test Track".into();
        f
    }

    /// Drives `seconds` of lap `lap` at 20 Hz starting at clock `start`; the lap clock starts at `lap_t0`.
    fn drive(cutter: &mut LapCutter, start: f64, lap: i32, lap_t0: f64, seconds: f64, last: Option<f64>) -> (Vec<Lap>, f64) {
        drive_with(cutter, start, lap, lap_t0, seconds, last, |_, _| {})
    }

    /// `drive`, with `tweak(frame, index)` to say more about each frame (the pits, the sectors, the weather...).
    fn drive_with(
        cutter: &mut LapCutter,
        start: f64,
        lap: i32,
        lap_t0: f64,
        seconds: f64,
        last: Option<f64>,
        tweak: impl Fn(&mut Frame, usize),
    ) -> (Vec<Lap>, f64) {
        let mut done = Vec::new();
        let mut clock = start;
        let n = (seconds * 20.0) as usize;
        for i in 0..n {
            let lap_t = lap_t0 + i as f64 / 20.0;
            let mut f = frame(clock, lap, Some(lap_t), last, Some(lap_t * 50.0));
            tweak(&mut f, i);
            done.extend(cutter.on_frame(&f, 1_794_312_000_000 + (clock * 1000.0) as i64));
            clock += 0.05;
        }
        (done, clock)
    }

    #[test]
    fn cuts_a_lap_when_the_number_goes_up_and_takes_the_official_time() {
        let mut cutter = LapCutter::new("test");
        let (none, clock) = drive(&mut cutter, 0.0, 1, 0.0, 30.0, None);
        assert!(none.is_empty());
        // Lap 2 starts, carrying the official time of lap 1 (30.0 s on the nose).
        let (laps, _) = drive(&mut cutter, clock, 2, 0.0, 1.0, Some(30.0));
        assert_eq!(laps.len(), 1);
        let lap = &laps[0];
        assert_eq!(
            (lap.game.as_str(), lap.lap_number, lap.time_ms, lap.valid),
            ("test", 1, 30_000, true)
        );
        assert_eq!((lap.track_name.as_str(), lap.car_name.as_str()), ("Test Track", "Test Car"));
        let ids: Vec<&str> = lap.channels.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            ["t", "dist", "speed", "rpm", "gear", "throttle", "brake"],
            "columns the game never gave are left out"
        );
        assert_eq!(lap.sample_count(), 600);
        assert!(lap.channel("dist").unwrap().values.windows(2).all(|w| w[1] >= w[0]));
        // The lap is a lap the strict reader accepts.
        assert!(crate::lapfile::gunzip(&crate::lapfile::gzip(lap).unwrap(), crate::lapfile::MAX_UNPACKED).is_ok());
    }

    #[test]
    fn an_official_time_that_disagrees_with_the_clock_is_not_trusted() {
        let mut cutter = LapCutter::new("test");
        let (_, clock) = drive(&mut cutter, 0.0, 1, 0.0, 30.0, None);
        let (laps, _) = drive(&mut cutter, clock, 2, 0.0, 1.0, Some(31.2));
        assert_eq!((laps[0].time_ms, laps[0].valid), (31_200, false));
    }

    #[test]
    fn a_lap_whose_time_never_arrives_is_written_after_a_few_seconds_as_not_valid() {
        let mut cutter = LapCutter::new("test");
        let (_, clock) = drive(&mut cutter, 0.0, 1, 0.0, 30.0, None);
        let (laps, _) = drive(&mut cutter, clock, 2, 0.0, 4.0, None);
        assert_eq!(laps.len(), 1);
        assert_eq!((laps[0].time_ms, laps[0].valid), (29_950, false));
    }

    #[test]
    fn a_lap_joined_in_the_middle_is_thrown_away() {
        let mut cutter = LapCutter::new("test");
        let (_, clock) = drive(&mut cutter, 0.0, 3, 17.0, 13.0, None);
        let (laps, _) = drive(&mut cutter, clock, 4, 0.0, 4.0, Some(30.0));
        assert!(laps.is_empty());
    }

    #[test]
    fn a_lap_through_the_pits_or_called_invalid_by_the_game_is_kept_but_not_valid() {
        for pits in [true, false] {
            let mut cutter = LapCutter::new("test");
            let mut clock = 0.0;
            for i in 0..600 {
                let mut f = frame(clock, 1, Some(i as f64 / 20.0), None, Some(i as f64 * 2.5));
                f.in_pits = pits && i == 300;
                f.lap_valid = Some(!(!pits && i == 100));
                cutter.on_frame(&f, 0);
                clock += 0.05;
            }
            let (laps, _) = drive(&mut cutter, clock, 2, 0.0, 1.0, Some(30.0));
            assert_eq!((laps.len(), laps[0].valid), (1, false), "pits {pits}");
        }
    }

    #[test]
    fn without_a_lap_clock_or_distance_it_measures_both_itself() {
        let mut cutter = LapCutter::new("test");
        let mut clock = 0.0;
        let mut laps = Vec::new();
        // (lap, seconds, the official time showing): joining without a lap clock or a distance counts as joining
        // mid-lap, so lap 1 is not kept; lap 2 is seen from its start.
        for (lap, seconds, last) in [(1, 10, None), (2, 30, Some(10.0)), (3, 3, Some(30.0))] {
            for _ in 0..seconds * 20 {
                laps.extend(cutter.on_frame(&frame(clock, lap, None, last, None), 0));
                clock += 0.05;
            }
        }
        assert_eq!(laps.len(), 1);
        assert_eq!((laps[0].lap_number, laps[0].time_ms, laps[0].valid), (2, 30_000, true));
        let dist = laps[0].channel("dist").unwrap();
        assert!(
            (dist.values.last().unwrap() - 50.0 * 30.0).abs() < 100.0,
            "integrated from the speed: {}",
            dist.values.last().unwrap()
        );
    }

    #[test]
    fn going_back_a_lap_or_to_a_menu_does_not_make_a_lap() {
        let mut cutter = LapCutter::new("test");
        let (_, clock) = drive(&mut cutter, 0.0, 4, 0.0, 20.0, None);
        // The session restarts: lap 1 again.
        let (laps, clock) = drive(&mut cutter, clock, 1, 0.0, 6.0, Some(29.0));
        assert!(laps.is_empty());
        // A menu in between leaves the lap in progress alone.
        let mut menu = frame(clock, 1, Some(6.0), None, None);
        menu.driving = false;
        assert!(cutter.on_frame(&menu, 0).is_empty());
    }

    #[test]
    fn a_different_car_or_track_ends_what_was_being_driven() {
        let mut cutter = LapCutter::new("test");
        let (_, clock) = drive(&mut cutter, 0.0, 1, 0.0, 20.0, None);
        let mut other = frame(clock, 2, Some(0.0), Some(20.0), Some(0.0));
        other.car = "Another Car".into();
        assert!(cutter.on_frame(&other, 0).is_empty());
        let (laps, _) = drive(&mut cutter, clock + 0.05, 2, 0.0, 4.0, Some(20.0));
        assert!(laps.is_empty(), "the lap in progress belonged to the old car");
    }

    #[test]
    fn a_lap_too_short_or_too_thin_is_not_kept() {
        let mut cutter = LapCutter::new("test");
        let (_, clock) = drive(&mut cutter, 0.0, 1, 0.0, 3.0, None);
        let (laps, _) = drive(&mut cutter, clock, 2, 0.0, 4.0, Some(3.0));
        assert!(laps.is_empty());
    }

    // ---- version 2: the session, the pit laps, the sectors, the conditions and the extra channels -------------

    /// Three laps of 30 s (official times 30.0, 30.2, 30.4) cut from frames of one session; returns them, the clock and
    /// the cutter. Each lap's official time arrives with the first frame of the next, so a fourth lap is begun.
    fn three_laps(tweak: impl Fn(&mut Frame, usize) + Copy) -> (Vec<Lap>, f64, LapCutter) {
        let mut cutter = LapCutter::new("test");
        let mut laps = Vec::new();
        let mut clock = 0.0;
        for (lap, last) in [(1, None), (2, Some(30.0)), (3, Some(30.2)), (4, Some(30.4))] {
            let (done, next) = drive_with(&mut cutter, clock, lap, 0.0, 30.0, last, tweak);
            laps.extend(done);
            clock = next;
        }
        (laps, clock, cutter)
    }

    #[test]
    fn every_lap_cut_from_one_session_carries_the_same_session_id() {
        let (laps, _, _) = three_laps(|_, _| {});
        assert_eq!(laps.len(), 3);
        let id = laps[0].session_id.clone().expect("a session id");
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(laps.iter().all(|l| l.session_id.as_deref() == Some(id.as_str())));
        // And it is an id the app's reader takes.
        assert!(crate::lapfile::gunzip(&crate::lapfile::gzip(&laps[0]).unwrap(), crate::lapfile::MAX_UNPACKED).is_ok());
    }

    #[test]
    fn a_restart_of_the_session_makes_a_new_session_id() {
        let mut cutter = LapCutter::new("test");
        let mut laps = Vec::new();
        let mut clock = 0.0;
        for (lap, last) in [(1, None), (2, Some(30.0)), (3, Some(30.2))] {
            let (done, next) = drive(&mut cutter, clock, lap, 0.0, 30.0, last);
            laps.extend(done);
            clock = next;
        }
        assert_eq!(laps.len(), 2, "laps 1 and 2 are cut; lap 3 is still being driven");
        // The player restarts the session: the lap number is 1 again, then lap 2 begins.
        for (lap, last) in [(1, Some(29.0)), (2, Some(30.5))] {
            let (done, next) = drive(&mut cutter, clock, lap, 0.0, 30.0, last);
            laps.extend(done);
            clock = next;
        }
        assert_eq!(laps.len(), 3);
        let (first, second) = (laps[0].session_id.clone().unwrap(), laps[2].session_id.clone().unwrap());
        assert_eq!(
            laps[1].session_id.as_deref(),
            Some(first.as_str()),
            "laps 1 and 2 of the first session"
        );
        assert_ne!(first, second, "the restart is a new session");
        assert_eq!((laps[2].lap_number, laps[2].time_ms), (1, 30_500));
    }

    #[test]
    fn the_lap_clock_jumping_back_on_the_same_lap_is_a_restart_and_a_new_session() {
        let mut cutter = LapCutter::new("test");
        let (_, clock) = drive(&mut cutter, 0.0, 1, 0.0, 20.0, None);
        let before = cutter.session.as_ref().map(|s| s.id.clone()).unwrap();
        // The same lap number, but the lap clock is back near zero.
        let (_, clock) = drive(&mut cutter, clock, 1, 0.0, 10.0, None);
        let after = cutter.session.as_ref().map(|s| s.id.clone()).unwrap();
        assert_ne!(before, after);
        // Frames missed (the lap number jumps ahead by two) lose the lap but not the session.
        let (_, _) = drive(&mut cutter, clock, 3, 0.0, 2.0, Some(30.0));
        assert_eq!(cutter.session.as_ref().map(|s| s.id.clone()), Some(after));
    }

    #[test]
    fn a_new_track_a_new_car_or_a_new_kind_of_session_makes_a_new_session_id() {
        let id_of = |cutter: &LapCutter| cutter.session.as_ref().map(|s| s.id.clone()).unwrap();
        let mut cutter = LapCutter::new("test");
        let (_, clock) = drive_with(&mut cutter, 0.0, 1, 0.0, 10.0, None, |f, _| {
            f.session_kind = Some(SessionKind::Practice)
        });
        let practice = id_of(&cutter);
        assert_eq!(cutter.session.as_ref().unwrap().kind, Some(SessionKind::Practice));
        // The same session, said again: nothing changes.
        let (_, clock) = drive_with(&mut cutter, clock, 1, 10.0, 5.0, None, |f, _| {
            f.session_kind = Some(SessionKind::Practice)
        });
        assert_eq!(id_of(&cutter), practice);
        // A game that says nothing about the kind for a moment does not end the session.
        let (_, clock) = drive(&mut cutter, clock, 1, 15.0, 1.0, None);
        assert_eq!(id_of(&cutter), practice);
        // Qualifying follows practice.
        let (_, clock) = drive_with(&mut cutter, clock, 1, 0.0, 5.0, None, |f, _| {
            f.session_kind = Some(SessionKind::Qualifying)
        });
        let qualifying = id_of(&cutter);
        assert_ne!(practice, qualifying);
        // Another car.
        let mut other_car = frame(clock, 1, Some(5.0), None, Some(250.0));
        other_car.car = "Another Car".into();
        cutter.on_frame(&other_car, 0);
        let other = id_of(&cutter);
        assert_ne!(other, qualifying);
        // Another track.
        let mut other_track = other_car.clone();
        other_track.track = "Another Track".into();
        cutter.on_frame(&other_track, 0);
        assert_ne!(id_of(&cutter), other);
    }

    #[test]
    fn a_cutter_made_again_after_the_game_restarted_makes_a_new_session_id() {
        let (first, _, _) = three_laps(|_, _| {});
        let (second, _, _) = three_laps(|_, _| {});
        assert_ne!(first[0].session_id, second[0].session_id);
    }

    #[test]
    fn a_lap_that_finishes_after_the_next_one_begins_keeps_its_own_session_id() {
        let mut cutter = LapCutter::new("test");
        let (_, clock) = drive(&mut cutter, 0.0, 1, 0.0, 30.0, None);
        let first = cutter.session.as_ref().map(|s| s.id.clone()).unwrap();
        // Lap 2 begins without the official time of lap 1; the track changes before it comes, so lap 1 (pending) is
        // written with the id it was driven under, after the session it belonged to has ended.
        let mut next = frame(clock, 2, Some(0.0), None, Some(0.0));
        cutter.on_frame(&next, 0);
        next.track = "Another Track".into();
        next.clock_s = clock + 0.05;
        cutter.on_frame(&next, 0);
        assert_ne!(cutter.session.as_ref().map(|s| s.id.clone()).unwrap(), first);
        let mut late = frame(clock + 0.1, 2, Some(0.1), Some(30.0), Some(5.0));
        late.track = "Another Track".into();
        let laps = cutter.on_frame(&late, 0);
        assert_eq!(laps.len(), 1);
        assert_eq!(laps[0].session_id, Some(first));
    }

    #[test]
    fn an_out_lap_starts_in_the_pits_and_an_in_lap_ends_in_them() {
        let (laps, _, _) = three_laps(|f, i| {
            // Lap 1 starts in the pits (an out lap); lap 3 ends in them (an in lap). Lap 2 is a flying lap.
            f.in_pits = match f.lap {
                1 => i < 40,
                3 => i >= 560,
                _ => false,
            };
        });
        assert_eq!(laps.len(), 3);
        assert_eq!((laps[0].out_lap, laps[0].in_lap), (Some(true), Some(false)), "lap 1");
        assert_eq!((laps[1].out_lap, laps[1].in_lap), (Some(false), Some(false)), "lap 2");
        assert_eq!((laps[2].out_lap, laps[2].in_lap), (Some(false), Some(true)), "lap 3");
        assert!(
            !laps[0].valid && laps[1].valid && !laps[2].valid,
            "a lap through the pits is not valid either"
        );
    }

    #[test]
    fn a_lap_through_the_pits_that_is_back_on_the_track_before_the_line_is_neither_in_nor_out() {
        let (laps, _, _) = three_laps(|f, i| f.in_pits = f.lap == 2 && (200..260).contains(&i));
        assert_eq!((laps[1].out_lap, laps[1].in_lap, laps[1].valid), (Some(false), Some(false), false));
    }

    #[test]
    fn sectors_are_the_first_two_the_game_gave_and_the_rest_of_the_official_time() {
        let (laps, _, _) = three_laps(|f, i| {
            // The first sector (10.5 s) is done 10.5 s into the lap and the second (9.5 s) 20 s into it.
            f.sectors_ms = [(i >= 210).then_some(10_500), (i >= 400).then_some(9_500)];
        });
        assert_eq!(laps[0].time_ms, 30_000);
        assert_eq!(laps[0].sectors_ms, Some(vec![10_500, 9_500, 10_000]));
        assert_eq!(
            laps[1].sectors_ms,
            Some(vec![10_500, 9_500, 10_200]),
            "the third is what is left of 30.2 s"
        );
        assert_eq!(laps[1].sectors_ms.as_ref().unwrap().iter().sum::<u32>(), laps[1].time_ms);
    }

    #[test]
    fn a_lap_with_only_one_sector_or_sectors_that_leave_no_third_gets_none() {
        let (one, _, _) = three_laps(|f, i| f.sectors_ms = [(i >= 210).then_some(10_500), None]);
        assert!(one.iter().all(|l| l.sectors_ms.is_none()), "only the first sector");
        let (too_long, _, _) = three_laps(|f, i| f.sectors_ms = [(i >= 210).then_some(20_000), (i >= 400).then_some(15_000)]);
        assert!(
            too_long.iter().all(|l| l.sectors_ms.is_none()),
            "20 s and 15 s leave nothing of 30 s"
        );
        let (none, _, _) = three_laps(|_, _| {});
        assert!(none.iter().all(|l| l.sectors_ms.is_none()), "a game that gives none");
    }

    #[test]
    fn a_lap_whose_official_time_never_came_gets_no_sectors() {
        let mut cutter = LapCutter::new("test");
        let tweak = |f: &mut Frame, i: usize| f.sectors_ms = [(i >= 210).then_some(10_500), (i >= 400).then_some(9_500)];
        let (_, clock) = drive_with(&mut cutter, 0.0, 1, 0.0, 30.0, None, tweak);
        let (laps, _) = drive(&mut cutter, clock, 2, 0.0, 4.0, None);
        assert_eq!(laps.len(), 1);
        assert_eq!((laps[0].valid, laps[0].sectors_ms.clone()), (false, None));
    }

    #[test]
    fn the_conditions_and_the_compound_are_what_the_game_last_said_during_the_lap() {
        let (laps, _, _) = three_laps(|f, i| {
            f.session_kind = Some(SessionKind::Race);
            f.weather = Some(if i < 300 { "dry".into() } else { "rain".into() });
            f.air_temp_c = Some(18.04);
            f.track_temp_c = (i > 100).then_some(24.26);
            f.tyre_compound = Some("Soft".into());
        });
        let lap = &laps[0];
        assert_eq!(lap.session_kind, Some(SessionKind::Race));
        assert_eq!(lap.weather.as_deref(), Some("rain"));
        assert_eq!(
            (lap.air_temp_c, lap.track_temp_c),
            (Some(18.0), Some(24.3)),
            "to a tenth of a degree"
        );
        assert_eq!(lap.tyre_compound.as_deref(), Some("Soft"));
        // A game that says none of it leaves the fields out.
        let (bare, _, _) = three_laps(|_, _| {});
        let lap = &bare[0];
        assert_eq!(
            (
                lap.session_kind,
                lap.weather.clone(),
                lap.air_temp_c,
                lap.track_temp_c,
                lap.tyre_compound.clone()
            ),
            (None, None, None, None, None)
        );
    }

    #[test]
    fn text_and_temperatures_the_lap_file_would_refuse_are_cleaned_before_they_get_there() {
        let (laps, _, _) = three_laps(|f, _| {
            f.weather = Some(format!("  {}\nsnow\u{7f}  ", "w".repeat(40)));
            f.tyre_compound = Some("\u{1}\u{2}".into());
            f.air_temp_c = Some(f32::NAN);
            f.track_temp_c = Some(900.0);
        });
        let lap = &laps[0];
        let weather = lap.weather.as_deref().expect("kept, cleaned and cut");
        assert!(
            weather.chars().count() <= 32 && weather.chars().all(|c| c as u32 > 0x1f && c as u32 != 0x7f),
            "{weather:?}"
        );
        assert_eq!(lap.tyre_compound, None, "nothing was left of it");
        assert_eq!((lap.air_temp_c, lap.track_temp_c), (None, None));
        // The strict reader takes the lap.
        assert!(crate::lapfile::gunzip(&crate::lapfile::gzip(lap).unwrap(), crate::lapfile::MAX_UNPACKED).is_ok());
        assert_eq!(label("Semislicks (S)", 40).as_deref(), Some("Semislicks (S)"));
        assert_eq!(label(&"c".repeat(50), 40).map(|t| t.len()), Some(40));
        assert_eq!(label("   ", 40), None);
    }

    #[test]
    fn the_new_channels_are_in_the_lap_when_the_frame_has_the_values() {
        use crate::game::{Drs, Tyre};
        let (laps, _, _) = three_laps(|f, i| {
            let n = i as f32;
            f.tyres = Some([
                Tyre {
                    brake_c: 300.0 + n,
                    temp_c: 80.0 + n / 10.0,
                    pressure_kpa: 190.0,
                    left: 0.9,
                },
                Tyre {
                    brake_c: 310.0,
                    temp_c: 81.0,
                    pressure_kpa: 191.0,
                    left: 0.8,
                },
                Tyre {
                    brake_c: f32::NAN,
                    temp_c: 82.0,
                    pressure_kpa: 192.0,
                    left: f32::NAN,
                },
                Tyre {
                    brake_c: f32::NAN,
                    temp_c: 83.0,
                    pressure_kpa: 193.0,
                    left: f32::NAN,
                },
            ]);
            f.g_lat = Some(1.25);
            f.g_long = Some(-0.5);
            f.state.damage_body = Some(0.25);
            f.state.drs = Some(if i < 100 { Drs::Off } else { Drs::Open });
            f.state.tc_active = Some(i % 2 == 0);
            f.state.abs_active = Some(false);
        });
        let lap = &laps[0];
        let ids: Vec<&str> = lap.channels.iter().map(|c| c.id.as_str()).collect();
        // The 7 channels of version 1 this frame carries, then those of version 2 in the order of the spec; the rear
        // tyres have no brake temperature or tread (NaN all lap), so those columns are not there.
        assert_eq!(
            ids,
            [
                "t",
                "dist",
                "speed",
                "rpm",
                "gear",
                "throttle",
                "brake",
                "tyre_temp_fl",
                "tyre_temp_fr",
                "tyre_temp_rl",
                "tyre_temp_rr",
                "tyre_press_fl",
                "tyre_press_fr",
                "tyre_press_rl",
                "tyre_press_rr",
                "tyre_wear_fl",
                "tyre_wear_fr",
                "brake_temp_fl",
                "brake_temp_fr",
                "g_lat",
                "g_long",
                "damage_body",
                "drs",
                "tc_active",
                "abs_active"
            ]
        );
        let col = |id: &str| lap.channel(id).unwrap();
        assert_eq!(col("tyre_temp_fl").unit, "\u{b0}C");
        assert_eq!(col("tyre_temp_fl").values[10], 81.0);
        assert_eq!(col("brake_temp_fl").values[5], 305.0);
        assert_eq!((col("tyre_press_rr").unit.as_str(), col("tyre_press_rr").values[0]), ("kPa", 193.0));
        assert_eq!(col("tyre_wear_fr").values[0], 0.8);
        assert_eq!((col("g_lat").values[0], col("g_long").values[0]), (1.25, -0.5));
        assert_eq!((col("drs").values[0], col("drs").values[200]), (0.0, 2.0));
        assert_eq!((col("tc_active").values[0], col("tc_active").values[1]), (1.0, 0.0));
        assert!(lap.channels.iter().all(|c| c.values.len() == lap.sample_count()));
        // The reader takes it: every id is a standard one in its unit.
        let back = crate::lapfile::gunzip(&crate::lapfile::gzip(lap).unwrap(), crate::lapfile::MAX_UNPACKED).unwrap();
        assert_eq!(back.channels.len(), lap.channels.len());
    }

    #[test]
    fn the_new_channels_are_absent_when_the_frame_has_no_values() {
        let (laps, _, _) = three_laps(|_, _| {});
        let ids: Vec<&str> = laps[0].channels.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["t", "dist", "speed", "rpm", "gear", "throttle", "brake"], "not zeros: absent");
        // A game that gives only some of them: only those.
        let (some, _, _) = three_laps(|f, _| {
            f.g_lat = Some(0.5);
            f.g_long = Some(0.1);
        });
        let ids: Vec<&str> = some[0].channels.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["t", "dist", "speed", "rpm", "gear", "throttle", "brake", "g_lat", "g_long"]);
    }
}
