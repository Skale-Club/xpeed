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
//!
//! The Le Mans Ultimate reader has its own cutter (`recorder.rs`) because its distance and times come from a second
//! stream; everything else goes through this one.

use crate::game::Frame;
use crate::lapfile::{Channel, Lap, STANDARD_UNITS};
use crate::util::iso_utc;

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

struct InProgress {
    number: i32,
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
        }
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
        // A new car or track: what was being driven is over.
        if let Some(cur) = &self.current {
            if (!frame.car.is_empty() && frame.car != cur.meta.car) || (!frame.track.is_empty() && frame.track != cur.meta.track) {
                self.current = None;
            }
        }
        if let Some(cur) = &self.current {
            // The lap clock jumping back on the same lap is a restart of the session.
            let restarted =
                frame.lap == cur.number && matches!((frame.lap_time_s, cur.last_lap_time), (Some(now), Some(before)) if now + 1.0 < before);
            if frame.lap < cur.number || frame.lap > cur.number + 1 || restarted {
                self.current = None;
            }
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
        InProgress {
            number: frame.lap,
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
        lap.called_invalid |= frame.lap_valid == Some(false);
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
            sectors_ms: None,
            started_at: iso_utc(lap.first_wall_ms),
            sample_rate_hz: rate.clamp(0.1, 1000.0),
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
        let mut done = Vec::new();
        let mut clock = start;
        let n = (seconds * 20.0) as usize;
        for i in 0..n {
            let lap_t = lap_t0 + i as f64 / 20.0;
            done.extend(cutter.on_frame(
                &frame(clock, lap, Some(lap_t), last, Some(lap_t * 50.0)),
                1_794_312_000_000 + (clock * 1000.0) as i64,
            ));
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
}
