//! Cutting the stream of frames into laps.
//!
//! Telemetry (100 Hz) gives time, speed and the pedals; the lap's distance and its official time
//! come from scoring (a few updates per second). So:
//!
//! * a lap runs from one change of the game's lap number to the next, and `t` is the time since the
//!   lap started, taken from the game's own `lap_start_et` (no drift);
//! * `dist` is integrated from speed between scoring updates and re-anchored on each one, except
//!   when scoring and telemetry disagree about which side of the finish line they are on;
//! * a finished lap waits for the scoring update that carries its official time. If that never
//!   comes, it is written anyway, with the telemetry duration and `valid: false`;
//! * a lap is kept only if it was seen from its start (no joining mid-lap), is at least 5 seconds
//!   long and has at least 50 samples.
//!
//! `valid` is a judgement from what the game gives: the official time must match the telemetry
//! duration, and the car must not have been in the pits during the lap. It is NOT the game's own
//! "lap counts" verdict (track limits are not visible in the data we read); see
//! `docs/telemetria-virtual-2026-11-10/LMU-TELEMETRIA.md`.

use crate::lapfile::{Channel, Lap, STANDARD_UNITS};
use crate::lmu::snapshot::{PlayerTelemetry, ScoringFrame, VehicleScoring};
use crate::util::iso_utc;

pub const MIN_SAMPLES: usize = 50;
pub const MIN_LAP_SECONDS: f64 = 5.0;
/// How long a finished lap waits for its official time.
const MAX_PENDING_SECONDS: f64 = 3.0;
/// A longer silence between two telemetry frames (a pause, a menu) is not integrated into distance.
const MAX_GAP_SECONDS: f64 = 0.25;
/// A first frame later than this into a lap means we joined mid-lap.
const PARTIAL_START_SECONDS: f64 = 1.5;
const LAP_START_MATCH_SECONDS: f64 = 0.05;
const LAP_TIME_MATCH_SECONDS: f64 = 0.5;

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

struct LapInProgress {
    number: i32,
    lap_start_et: f64,
    first_t: f64,
    first_wall_ms: i64,
    columns: Columns,
    partial: bool,
    touched_pits: bool,
}

struct Closed {
    lap: LapInProgress,
    new_lap_start_et: f64,
    closed_et: f64,
    track_name: String,
    car_name: String,
    car_class: Option<String>,
    track_length_m: Option<f64>,
}

#[derive(Default)]
pub struct Recorder {
    current: Option<LapInProgress>,
    closed: Option<Closed>,
    dist: f64,
    last_et: f64,
    last_speed: f64,
    last_et_seen: f64,
    in_pits: bool,
    track_length_m: Option<f64>,
    car_class: Option<String>,
    track: String,
    car: String,
}

fn ms(seconds: f64) -> u32 {
    (seconds * 1000.0).round().max(0.0) as u32
}

impl Recorder {
    pub fn new() -> Self {
        Self::default()
    }

    /// A scoring update. Returns the laps it finished.
    pub fn on_scoring(&mut self, frame: &ScoringFrame) -> Vec<Lap> {
        let mut done = Vec::new();
        if frame.session.track_length_m > 0.0 {
            self.track_length_m = Some(frame.session.track_length_m);
        }
        let Some(player) = &frame.player else { return done };
        if !player.vehicle_class.is_empty() {
            self.car_class = Some(player.vehicle_class.clone());
        }
        self.in_pits = player.in_pits;
        if self.current.is_some() {
            if player.in_pits {
                if let Some(current) = &mut self.current {
                    current.touched_pits = true;
                }
            }
            self.anchor_distance(player, frame.session.current_et);
        }
        let confirms = self
            .closed
            .as_ref()
            .is_some_and(|closed| (player.lap_start_et - closed.new_lap_start_et).abs() < LAP_START_MATCH_SECONDS);
        if confirms {
            done.extend(self.finish_closed(Some(player)));
        }
        done
    }

    /// Scoring knows where the car is on the track; the integral of speed only knows how far it moved.
    fn anchor_distance(&mut self, player: &VehicleScoring, scoring_et: f64) {
        let across_the_line = self
            .track_length_m
            .is_some_and(|length| (player.lap_dist - self.dist).abs() > length * 0.5);
        if across_the_line {
            return;
        }
        // The scoring update is a little older than the last telemetry frame: add what the car moved since.
        let lag = (self.last_et_seen - scoring_et).clamp(0.0, 0.5);
        self.dist = player.lap_dist + self.last_speed * lag;
        self.last_et = self.last_et_seen;
    }

    /// A telemetry frame of the player's car. Returns the laps it finished (rarely: see `finish_closed`).
    pub fn on_telemetry(&mut self, t: &PlayerTelemetry, wall_ms: i64) -> Vec<Lap> {
        let mut done = Vec::new();
        let et = t.elapsed_time;

        // A new track or car, or the session clock going back: what we have belongs to something else.
        let changed = (!self.track.is_empty() && self.track != t.track_name) || (!self.car.is_empty() && self.car != t.vehicle_name);
        if changed || et + 1.0 < self.last_et_seen {
            self.current = None;
            self.closed = None;
        }
        self.track = t.track_name.clone();
        self.car = t.vehicle_name.clone();
        self.last_et_seen = et;

        if self
            .closed
            .as_ref()
            .is_some_and(|closed| et - closed.closed_et > MAX_PENDING_SECONDS)
        {
            done.extend(self.finish_closed(None));
        }

        if self.current.as_ref().is_some_and(|current| current.number != t.lap_number) {
            if let Some(old) = self.current.take() {
                // A lap still waiting for its time is written without it.
                done.extend(self.finish_closed(None));
                self.closed = Some(Closed {
                    lap: old,
                    new_lap_start_et: t.lap_start_et,
                    closed_et: et,
                    track_name: t.track_name.clone(),
                    car_name: t.vehicle_name.clone(),
                    car_class: self.car_class.clone(),
                    track_length_m: self.track_length_m,
                });
            }
        }

        if self.current.is_none() {
            let into_lap = et - t.lap_start_et;
            self.current = Some(LapInProgress {
                number: t.lap_number,
                lap_start_et: t.lap_start_et,
                first_t: into_lap,
                first_wall_ms: wall_ms,
                columns: Columns::default(),
                partial: into_lap > PARTIAL_START_SECONDS,
                touched_pits: self.in_pits,
            });
            self.dist = 0.0;
            self.last_et = t.lap_start_et;
        }

        let speed = t.speed_ms();
        let dt = et - self.last_et;
        if dt > 0.0 && dt <= MAX_GAP_SECONDS {
            self.dist += speed * dt;
        }
        self.last_et = et;
        self.last_speed = speed;

        let Some(current) = self.current.as_mut() else { return done };
        let columns = &mut current.columns;
        // Distance never goes backwards inside a lap, whatever scoring says.
        let dist = columns.dist.last().map_or(self.dist, |&last| self.dist.max(f64::from(last)));
        columns.t.push((et - t.lap_start_et) as f32);
        columns.dist.push(dist as f32);
        columns.speed.push(speed as f32);
        columns.rpm.push(t.rpm as f32);
        columns.gear.push(t.gear as f32);
        columns.throttle.push(t.throttle as f32);
        columns.brake.push(t.brake as f32);
        columns.clutch.push(t.clutch as f32);
        columns.steer.push(t.steering as f32);
        columns.x.push(t.pos[0] as f32);
        columns.y.push(t.pos[1] as f32);
        columns.z.push(t.pos[2] as f32);
        columns.fuel.push(t.fuel_l as f32);
        done
    }

    /// Writes the lap waiting for its time, with `scoring` if it has the official time.
    fn finish_closed(&mut self, scoring: Option<&VehicleScoring>) -> Option<Lap> {
        let closed = self.closed.take()?;
        let current = closed.lap;
        let samples = current.columns.t.len();
        let duration = closed.new_lap_start_et - current.lap_start_et;
        if current.partial || samples < MIN_SAMPLES || !(MIN_LAP_SECONDS..86_400.0).contains(&duration) {
            return None;
        }

        let official =
            scoring.filter(|player| player.last_lap_time > 0.0 && (player.last_lap_time - duration).abs() < LAP_TIME_MATCH_SECONDS);
        let time_s = official.map_or(duration, |player| player.last_lap_time);
        let valid = official.is_some() && !current.touched_pits;
        let sectors_ms = official.and_then(|player| {
            let (first, through_second) = (player.last_sector1, player.last_sector2);
            (first > 0.0 && through_second > first && time_s > through_second)
                .then(|| vec![ms(first), ms(through_second - first), ms(time_s - through_second)])
        });

        let t = &current.columns.t;
        let span = f64::from(t[samples - 1]) - f64::from(t[0]);
        let sample_rate_hz = if span > 0.0 {
            ((samples - 1) as f64 / span * 10.0).round() / 10.0
        } else {
            0.0
        };
        let started_ms = current.first_wall_ms - (current.first_t * 1000.0) as i64;

        let columns = current.columns;
        let values = [
            columns.t,
            columns.dist,
            columns.speed,
            columns.rpm,
            columns.gear,
            columns.throttle,
            columns.brake,
            columns.clutch,
            columns.steer,
            columns.x,
            columns.y,
            columns.z,
            columns.fuel,
        ];
        let channels = STANDARD_UNITS
            .iter()
            .zip(values)
            .map(|((id, unit), values)| Channel {
                id: (*id).into(),
                unit: (*unit).into(),
                values,
            })
            .collect();

        Some(Lap {
            game: "lmu".into(),
            track_name: closed.track_name,
            track_variant: None,
            track_length_m: closed.track_length_m,
            car_name: closed.car_name,
            car_class: closed.car_class,
            lap_number: current.number.max(0) as u32,
            time_ms: ms(time_s),
            valid,
            sectors_ms,
            started_at: iso_utc(started_ms),
            sample_rate_hz,
            channels,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lmu::snapshot::SessionScoring;

    const TRACK: &str = "Test Ring";
    const CAR: &str = "Test Car #1";
    const LENGTH: f64 = 3000.0;
    const SPEED: f64 = 50.0; // 60 s for 3000 m

    fn frame(et: f64, lap: i32, lap_start: f64, speed: f64) -> PlayerTelemetry {
        PlayerTelemetry {
            elapsed_time: et,
            delta_time: 0.01,
            lap_number: lap,
            lap_start_et: lap_start,
            vehicle_name: CAR.into(),
            track_name: TRACK.into(),
            local_vel: [0.0, 0.0, -speed],
            gear: 4,
            rpm: 6000.0,
            throttle: 0.8,
            ..PlayerTelemetry::default()
        }
    }

    fn scoring(et: f64, lap_dist: f64, lap_start: f64, last_lap: f64, pits: bool) -> ScoringFrame {
        ScoringFrame {
            session: SessionScoring {
                track_name: TRACK.into(),
                track_length_m: LENGTH,
                current_et: et,
                num_vehicles: 1,
                ..SessionScoring::default()
            },
            player: Some(VehicleScoring {
                vehicle_name: CAR.into(),
                vehicle_class: "Hyper".into(),
                lap_dist,
                lap_start_et: lap_start,
                last_lap_time: last_lap,
                last_sector1: if last_lap > 0.0 { 20.0 } else { 0.0 },
                last_sector2: if last_lap > 0.0 { 41.0 } else { 0.0 },
                in_pits: pits,
                ..VehicleScoring::default()
            }),
        }
    }

    /// Drives `seconds` at 100 Hz from `from`, sending a scoring update every 0.2 s when `with_scoring`.
    fn drive(rec: &mut Recorder, from: f64, seconds: f64, lap: i32, lap_start: f64, with_scoring: bool, pits: bool) -> Vec<Lap> {
        let mut done = Vec::new();
        let steps = (seconds * 100.0).round() as i32;
        for i in 0..steps {
            let et = from + f64::from(i) * 0.01;
            done.extend(rec.on_telemetry(&frame(et, lap, lap_start, SPEED), 1_700_000_000_000 + (et * 1000.0) as i64));
            if with_scoring && i % 20 == 0 {
                let dist = ((et - lap_start) * SPEED).clamp(0.0, LENGTH - 1.0);
                done.extend(rec.on_scoring(&scoring(et, dist, lap_start, 0.0, pits)));
            }
        }
        done
    }

    /// One whole lap of 60 s, then the first frame of the next lap and the scoring update with its time.
    fn lap_then_confirmation(rec: &mut Recorder, start: f64, lap: i32, pits: bool, official: f64) -> Vec<Lap> {
        let mut done = drive(rec, start, 60.0, lap, start, true, pits);
        done.extend(rec.on_telemetry(&frame(start + 60.0, lap + 1, start + 60.0, SPEED), 1_700_000_060_000));
        done.extend(rec.on_scoring(&scoring(start + 60.0, 0.0, start + 60.0, official, false)));
        done
    }

    #[test]
    fn records_a_whole_lap_with_the_official_time_and_sectors() {
        let mut rec = Recorder::new();
        let done = lap_then_confirmation(&mut rec, 100.0, 1, false, 60.0);
        assert_eq!(done.len(), 1);
        let lap = &done[0];
        assert_eq!(
            (lap.game.as_str(), lap.track_name.as_str(), lap.car_name.as_str()),
            ("lmu", TRACK, CAR)
        );
        assert_eq!(lap.car_class.as_deref(), Some("Hyper"));
        assert_eq!(lap.track_length_m, Some(LENGTH));
        assert_eq!(lap.lap_number, 1);
        assert_eq!(lap.time_ms, 60_000);
        assert!(lap.valid);
        assert_eq!(lap.sectors_ms, Some(vec![20_000, 21_000, 19_000]));
        assert_eq!(lap.sample_rate_hz, 100.0);
        assert!((lap.sample_count() as i64 - 6000).abs() <= 2);
        let t = &lap.channel("t").unwrap().values;
        assert!(t[0] < 0.02 && (t[t.len() - 1] - 59.99).abs() < 0.02);
        let dist = &lap.channel("dist").unwrap().values;
        assert!(
            dist[0] < 1.0 && (f64::from(dist[dist.len() - 1]) - 3000.0).abs() < 5.0,
            "ends at {}",
            dist[dist.len() - 1]
        );
        assert!(dist.windows(2).all(|w| w[1] >= w[0]), "distance must not go backwards");
        assert_eq!(lap.channel("speed").unwrap().values[100], 50.0);
        assert_eq!(lap.channel("gear").unwrap().values[0], 4.0);
        // The first frame was at game time 100 s, taken as 1_700_000_100_000 ms of wall clock.
        assert_eq!(lap.started_at, "2023-11-14T22:15:00.000Z");
    }

    #[test]
    fn writes_a_lap_that_the_app_accepts() {
        let mut rec = Recorder::new();
        let lap = lap_then_confirmation(&mut rec, 100.0, 1, false, 60.0).remove(0);
        let back = crate::lapfile::gunzip(&crate::lapfile::gzip(&lap).unwrap(), crate::lapfile::MAX_UNPACKED).unwrap();
        assert_eq!(back, lap);
    }

    #[test]
    fn a_lap_through_the_pits_is_kept_but_not_valid() {
        let mut rec = Recorder::new();
        let done = lap_then_confirmation(&mut rec, 100.0, 1, true, 60.0);
        assert_eq!(done.len(), 1);
        assert!(!done[0].valid);
        assert_eq!(done[0].time_ms, 60_000);
    }

    #[test]
    fn a_lap_scoring_gives_no_time_for_is_written_but_not_valid() {
        // The game reports -1 for the last lap time: there is no official time to trust.
        let mut rec = Recorder::new();
        let done = lap_then_confirmation(&mut rec, 100.0, 1, false, -1.0);
        assert_eq!(done.len(), 1);
        assert!(!done[0].valid && done[0].time_ms == 60_000 && done[0].sectors_ms.is_none());
    }

    #[test]
    fn a_lap_whose_time_never_arrives_is_written_after_a_few_seconds() {
        let mut rec = Recorder::new();
        let mut done = drive(&mut rec, 100.0, 60.0, 1, 100.0, true, false);
        done.extend(rec.on_telemetry(&frame(160.0, 2, 160.0, SPEED), 0));
        assert!(done.is_empty(), "it is still waiting for the scoring update that carries the time");
        // No scoring update follows. Three seconds of the next lap later it is written with the telemetry duration.
        let late = drive(&mut rec, 160.01, 3.1, 2, 160.0, false, false);
        assert_eq!(late.len(), 1);
        assert!(!late[0].valid && late[0].time_ms == 60_000 && late[0].sectors_ms.is_none());
    }

    #[test]
    fn an_official_time_that_disagrees_with_the_telemetry_is_not_trusted() {
        let mut rec = Recorder::new();
        let done = lap_then_confirmation(&mut rec, 100.0, 1, false, 71.234);
        assert_eq!(done.len(), 1);
        assert!(!done[0].valid);
        assert_eq!(done[0].time_ms, 60_000);
    }

    #[test]
    fn a_lap_joined_in_the_middle_is_thrown_away() {
        let mut rec = Recorder::new();
        // We start listening 30 s into a lap that began at 100.
        let mut done = drive(&mut rec, 130.0, 30.0, 1, 100.0, true, false);
        done.extend(rec.on_telemetry(&frame(160.0, 2, 160.0, SPEED), 0));
        done.extend(rec.on_scoring(&scoring(160.0, 0.0, 160.0, 60.0, false)));
        assert!(done.is_empty());
        // The lap that follows is whole and is kept.
        let mut done = drive(&mut rec, 160.01, 59.99, 2, 160.0, true, false);
        done.extend(rec.on_telemetry(&frame(220.0, 3, 220.0, SPEED), 0));
        done.extend(rec.on_scoring(&scoring(220.0, 0.0, 220.0, 60.0, false)));
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].lap_number, 2);
    }

    #[test]
    fn a_new_car_or_track_throws_away_the_lap_in_progress() {
        let mut rec = Recorder::new();
        drive(&mut rec, 100.0, 30.0, 1, 100.0, true, false);
        let mut elsewhere = frame(130.0, 1, 100.0, SPEED);
        elsewhere.track_name = "Another Ring".into();
        assert!(rec.on_telemetry(&elsewhere, 0).is_empty());
        let mut done = drive(&mut rec, 130.01, 20.0, 1, 100.0, false, false);
        done.extend(rec.on_telemetry(&frame(160.0, 2, 160.0, SPEED), 0));
        done.extend(rec.on_scoring(&scoring(160.0, 0.0, 160.0, 60.0, false)));
        assert!(done.is_empty(), "the lap that began on the other track must not be written");
    }

    #[test]
    fn the_session_clock_going_back_throws_away_the_lap_in_progress() {
        let mut rec = Recorder::new();
        drive(&mut rec, 500.0, 30.0, 4, 500.0, true, false);
        // The player restarted the session: the clock is at 10 again.
        let mut done = drive(&mut rec, 10.0, 60.0, 1, 10.0, true, false);
        done.extend(rec.on_telemetry(&frame(70.0, 2, 70.0, SPEED), 0));
        done.extend(rec.on_scoring(&scoring(70.0, 0.0, 70.0, 60.0, false)));
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].lap_number, 1);
        assert_eq!(done[0].sample_count(), 6000);
    }

    #[test]
    fn scoring_corrects_a_speed_that_reads_low() {
        // The speed we read is 5% under the truth: integrating alone would end 150 m short.
        let mut rec = Recorder::new();
        let mut done = Vec::new();
        for i in 0..6000 {
            let et = 100.0 + f64::from(i) * 0.01;
            done.extend(rec.on_telemetry(&frame(et, 1, 100.0, SPEED * 0.95), 0));
            if i % 20 == 0 {
                done.extend(rec.on_scoring(&scoring(et, ((et - 100.0) * SPEED).min(LENGTH - 1.0), 100.0, 0.0, false)));
            }
        }
        done.extend(rec.on_telemetry(&frame(160.0, 2, 160.0, SPEED), 0));
        done.extend(rec.on_scoring(&scoring(160.0, 0.0, 160.0, 60.0, false)));
        let lap = &done[0];
        let dist = &lap.channel("dist").unwrap().values;
        assert!(
            (f64::from(dist[dist.len() - 1]) - 3000.0).abs() < 12.0,
            "ended at {}",
            dist[dist.len() - 1]
        );
    }

    #[test]
    fn without_scoring_the_distance_is_the_integral_of_speed() {
        let mut rec = Recorder::new();
        let mut done = drive(&mut rec, 100.0, 60.0, 1, 100.0, false, false);
        done.extend(rec.on_telemetry(&frame(160.0, 2, 160.0, SPEED), 0));
        done.extend(rec.on_scoring(&scoring(160.0, 0.0, 160.0, 60.0, false)));
        let dist = &done[0].channel("dist").unwrap().values;
        assert!((f64::from(dist[dist.len() - 1]) - 3000.0).abs() < 1.0);
    }

    #[test]
    fn a_scoring_update_across_the_finish_line_does_not_move_the_distance_back() {
        let mut rec = Recorder::new();
        drive(&mut rec, 100.0, 59.0, 1, 100.0, false, false);
        // Scoring already wrapped to the new lap (distance near 0) while telemetry still reports the old lap.
        rec.on_scoring(&scoring(159.0, 5.0, 159.5, 0.0, false));
        let mut done = drive(&mut rec, 159.0, 1.0, 1, 100.0, false, false);
        done.extend(rec.on_telemetry(&frame(160.0, 2, 160.0, SPEED), 0));
        done.extend(rec.on_scoring(&scoring(160.0, 0.0, 160.0, 60.0, false)));
        let dist = &done[0].channel("dist").unwrap().values;
        assert!(dist[dist.len() - 1] > 2900.0, "distance fell to {}", dist[dist.len() - 1]);
        assert!(dist.windows(2).all(|w| w[1] >= w[0]));
    }

    #[test]
    fn a_pause_is_not_driven_as_distance() {
        let mut rec = Recorder::new();
        rec.on_telemetry(&frame(100.0, 1, 100.0, SPEED), 0);
        rec.on_telemetry(&frame(100.01, 1, 100.0, SPEED), 0);
        // The game was paused for two minutes at 50 m/s: that is not 6000 m.
        rec.on_telemetry(&frame(220.0, 1, 100.0, SPEED), 0);
        rec.on_telemetry(&frame(220.01, 1, 100.0, SPEED), 0);
        let dist = &rec.current.as_ref().unwrap().columns.dist;
        assert!(f64::from(dist[dist.len() - 1]) < 10.0);
    }

    /// Not a check: writes a real lap to the file named by `XPEED_SAMPLE_LAP`, so another program (the
    /// app's reader) can be pointed at what this recorder produces. Run it with
    /// `XPEED_SAMPLE_LAP=sample.xlap.gz cargo test writes_a_sample_lap -- --ignored`.
    #[test]
    #[ignore]
    fn writes_a_sample_lap_to_disk() {
        let path = std::env::var("XPEED_SAMPLE_LAP").expect("set XPEED_SAMPLE_LAP to the file to write");
        let mut rec = Recorder::new();
        let lap = lap_then_confirmation(&mut rec, 100.0, 1, false, 60.0).remove(0);
        std::fs::write(path, crate::lapfile::gzip(&lap).unwrap()).unwrap();
    }

    #[test]
    fn a_lap_that_is_too_short_or_too_thin_is_not_kept() {
        let mut rec = Recorder::new();
        let mut done = drive(&mut rec, 100.0, 3.0, 1, 100.0, true, false);
        done.extend(rec.on_telemetry(&frame(103.0, 2, 103.0, SPEED), 0));
        done.extend(rec.on_scoring(&scoring(103.0, 0.0, 103.0, 3.0, false)));
        assert!(done.is_empty());
    }
}
