//! Le Mans Ultimate as a `Source`: its two streams (telemetry at 100 Hz, scoring a few times a second) become `Frame`s,
//! one per telemetry update, so the laps go through `LapCutter` and the panel through `Tracker` like every other game's.
//!
//! `Framer` is the part with no memory mapping in it (so it is tested without a game); `LmuSource` puts a `LmuReader`
//! in front of it. What this adds to `dash::lmu_frame`, which is a pure function of one telemetry update and the last
//! scoring:
//!
//! * the distance is the scoring's, carried forward at the car's speed between scoring updates; when scoring has already
//!   wrapped to the new lap while telemetry is still on the old one, the distance goes on from the last one instead of
//!   falling back to the start;
//! * the official time of the last lap is given only once scoring has caught up with the lap telemetry is in (its lap
//!   start is the same). Scoring lags the line by up to a few hundred milliseconds and, until it catches up, still shows
//!   the time of the lap before: handing that over would be taken as the time of the lap that just ended;
//! * the sectors: scoring gives those of the last lap (`last_sector1`, and `last_sector2` up to the end of the second),
//!   which belong to the lap that was just closed, so `finish_lap` puts them on that lap when its official time is the
//!   one scoring shows.

use crate::game::Frame;
use crate::lapfile::Lap;
use crate::lmu::snapshot::{PlayerTelemetry, ScoringFrame};

/// Scoring's lap start and telemetry's agree within this when scoring has caught up with the lap.
const LAP_START_MATCH_SECONDS: f64 = 0.05;
/// The official time and the telemetry's own agree within this (the cutter's `valid` rule).
const OFFICIAL_MATCH_SECONDS: f64 = 0.5;
/// A scoring distance this much (of the track's length) behind the last one, on the same lap, is the wrap at the line.
const WRAP_SHARE: f64 = 0.5;
/// The most carried forward over the finish line from the last distance.
const CARRY_MAX_SECONDS: f64 = 0.25;

fn ms(seconds: f64) -> u32 {
    (seconds * 1000.0).round().max(0.0) as u32
}

/// Turns the game's two streams into frames.
#[derive(Default)]
pub struct Framer {
    scoring: Option<ScoringFrame>,
    /// The lap number, the distance and the session clock of the last frame that had a distance.
    last: Option<(i32, f64, f64)>,
}

impl Framer {
    /// One update of the game: a telemetry reading (the player's car, when there is one) and a scoring update (when it
    /// came with this one). A frame is made for each telemetry reading.
    pub fn frame(&mut self, telemetry: Option<&PlayerTelemetry>, scoring: Option<ScoringFrame>) -> Option<Frame> {
        if let Some(scoring) = scoring {
            self.scoring = Some(scoring);
        }
        let t = telemetry?;
        let mut frame = crate::dash::lmu_frame(t, self.scoring.as_ref());
        let player = self.scoring.as_ref().and_then(|s| s.player.as_ref());
        if player.is_some_and(|p| (p.lap_start_et - t.lap_start_et).abs() > LAP_START_MATCH_SECONDS) {
            frame.last_lap_s = None;
        }
        match (frame.dist_m, self.last) {
            (Some(dist), Some((lap, before, et))) if lap == t.lap_number => {
                let wrapped = frame.track_length_m.is_some_and(|length| before - dist > length * WRAP_SHARE);
                if wrapped {
                    let carried = before + t.speed_ms() * (t.elapsed_time - et).clamp(0.0, CARRY_MAX_SECONDS);
                    frame.dist_m = Some(carried);
                }
            }
            _ => {}
        }
        self.last = frame.dist_m.map(|d| (t.lap_number, d, t.elapsed_time));
        Some(frame)
    }

    /// The first two sector times of `lap`, as scoring gives them for the last lap, when scoring's time for the last lap
    /// is this lap's official time; `None` otherwise (a lap written with the time measured here, or sectors that do not
    /// make sense).
    pub fn sectors_of(&self, lap: &Lap) -> Option<Vec<u32>> {
        let player = self.scoring.as_ref()?.player.as_ref()?;
        let time = player.last_lap_time;
        if time <= 0.0 || (i64::from(ms(time)) - i64::from(lap.time_ms)).abs() > 1 {
            return None;
        }
        // Only a lap whose official time agrees with the telemetry's clock has sectors (the cutter's rule everywhere).
        let measured = f64::from(lap.channels.iter().find(|c| c.id == "t")?.values.last().copied()?);
        if (time - measured).abs() > OFFICIAL_MATCH_SECONDS {
            return None;
        }
        let (first, through_second) = (player.last_sector1, player.last_sector2);
        (first > 0.0 && through_second > first && time > through_second)
            .then(|| vec![ms(first), ms(through_second - first), ms(time - through_second)])
    }
}

#[cfg(windows)]
pub use reader::LmuSource;

#[cfg(windows)]
mod reader {
    use std::time::Duration;

    use super::Framer;
    use crate::game::{Caps, Frame, Source};
    use crate::lapfile::Lap;
    use crate::lmu::reader::LmuReader;
    use crate::lmu::snapshot::LMU_CAPS;

    /// An open door into Le Mans Ultimate's shared memory.
    pub struct LmuSource {
        reader: LmuReader,
        framer: Framer,
        timed_out: bool,
    }

    impl LmuSource {
        pub fn new(reader: LmuReader) -> LmuSource {
            LmuSource {
                reader,
                framer: Framer::default(),
                timed_out: false,
            }
        }

        /// True when the last `next` waited its whole time and the game wrote nothing (as opposed to a reading that gave
        /// no frame, such as a scoring update alone). The engine counts these to tell a menu from a game that is gone.
        pub fn timed_out(&self) -> bool {
            self.timed_out
        }
    }

    impl Source for LmuSource {
        fn game_id(&self) -> &'static str {
            "lmu"
        }

        fn game_name(&self) -> &'static str {
            "Le Mans Ultimate"
        }

        fn next(&mut self, timeout: Duration) -> Option<Frame> {
            self.timed_out = !self.reader.wait_frame(timeout.as_millis().min(u128::from(u32::MAX)) as u32);
            if self.timed_out {
                return None;
            }
            let snapshot = self.reader.read()?;
            self.framer.frame(snapshot.telemetry.as_ref(), snapshot.scoring)
        }

        /// The memory stays mapped while the game is closed; whether the game still runs is the engine's to look at when
        /// it has been quiet (`engine::lmu_quiet_action`).
        fn alive(&self) -> bool {
            true
        }

        fn caps(&self) -> Caps {
            LMU_CAPS
        }

        fn finish_lap(&self, lap: &mut Lap) {
            if lap.sectors_ms.is_none() {
                lap.sectors_ms = self.framer.sectors_of(lap);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::Phase;
    use crate::lapcut::LapCutter;
    use crate::lapfile::SessionKind;
    use crate::lmu::snapshot::{SessionScoring, VehicleScoring};

    const TRACK: &str = "Test Ring";
    const CAR: &str = "Test Car #1";
    const LENGTH: f64 = 3000.0;
    const SPEED: f64 = 50.0; // 60 s for 3000 m

    fn telemetry(et: f64, lap: i32, lap_start: f64, speed: f64) -> PlayerTelemetry {
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

    /// Scoring with the player in the car (`game_phase` 5 is green).
    fn scoring(et: f64, lap_dist: f64, lap_start: f64, last_lap: f64, pits: bool) -> ScoringFrame {
        ScoringFrame {
            session: SessionScoring {
                track_name: TRACK.into(),
                track_length_m: LENGTH,
                current_et: et,
                num_vehicles: 1,
                in_realtime: true,
                game_phase: 5,
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

    /// What the engine does with the game: frames into a cutter, finished laps through `finish_lap`.
    struct Rig {
        framer: Framer,
        cutter: Option<LapCutter>,
        /// The time of the last lap that scoring says in the updates `drive` sends.
        last_lap: f64,
    }

    impl Rig {
        fn new() -> Rig {
            Rig {
                framer: Framer::default(),
                cutter: Some(LapCutter::new("lmu")),
                last_lap: 0.0,
            }
        }

        /// One telemetry update, with the scoring update that came with it, if any. Returns the laps it finished.
        fn update(&mut self, t: &PlayerTelemetry, scoring: Option<ScoringFrame>) -> Vec<Lap> {
            let wall = 1_700_000_000_000 + (t.elapsed_time * 1000.0) as i64;
            let mut out = Vec::new();
            if let Some(frame) = self.framer.frame(Some(t), scoring) {
                for mut lap in self.cutter.as_mut().unwrap().on_frame(&frame, wall) {
                    if lap.sectors_ms.is_none() {
                        lap.sectors_ms = self.framer.sectors_of(&lap);
                    }
                    out.push(lap);
                }
            }
            out
        }

        /// What the engine does when the source goes away.
        fn close(&mut self) -> Vec<Lap> {
            self.cutter.take().map(|c| c.finish(0)).unwrap_or_default()
        }

        /// Drives `seconds` at 100 Hz from `from`, with a scoring update (sent before the reading) every 0.2 s when
        /// `with_scoring`; `pits(seconds into the lap)` says what scoring shows.
        fn drive(&mut self, from: f64, seconds: f64, lap: i32, lap_start: f64, with_scoring: bool, pits: impl Fn(f64) -> bool) -> Vec<Lap> {
            let mut done = Vec::new();
            for i in 0..(seconds * 100.0).round() as i32 {
                let et = from + f64::from(i) * 0.01;
                let s = (with_scoring && i % 20 == 0).then(|| {
                    let dist = ((et - lap_start) * SPEED).clamp(0.0, LENGTH - 1.0);
                    scoring(et, dist, lap_start, self.last_lap, pits(et - lap_start))
                });
                done.extend(self.update(&telemetry(et, lap, lap_start, SPEED), s));
            }
            done
        }

        /// One whole lap of 60 s that began at `start` (`resume`: right after the readings this method sent for the lap
        /// before it, else from `start` itself), then the first frame of the next lap, the scoring update with the time
        /// of the lap, and the readings that follow it.
        fn lap_then_confirmation(&mut self, start: f64, resume: bool, lap: i32, pits: bool, official: f64) -> Vec<Lap> {
            let from = if resume { start + 0.03 } else { start };
            let mut done = self.drive(from, 60.0 - (from - start), lap, start, true, |_| pits);
            done.extend(self.update(&telemetry(start + 60.0, lap + 1, start + 60.0, SPEED), None));
            done.extend(self.update(
                &telemetry(start + 60.01, lap + 1, start + 60.0, SPEED),
                Some(scoring(start + 60.01, 0.5, start + 60.0, official, false)),
            ));
            done.extend(self.update(&telemetry(start + 60.02, lap + 1, start + 60.0, SPEED), None));
            done
        }
    }

    #[test]
    fn records_a_whole_lap_with_the_official_time_and_sectors() {
        let mut rig = Rig::new();
        let done = rig.lap_then_confirmation(100.0, false, 1, false, 60.0);
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
        assert_eq!(lap.sample_count(), 6000);
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
        let mut rig = Rig::new();
        let lap = rig.lap_then_confirmation(100.0, false, 1, false, 60.0).remove(0);
        let back = crate::lapfile::gunzip(&crate::lapfile::gzip(&lap).unwrap(), crate::lapfile::MAX_UNPACKED).unwrap();
        assert_eq!(back, lap);
    }

    #[test]
    fn a_lap_through_the_pits_is_kept_but_not_valid() {
        let mut rig = Rig::new();
        let done = rig.lap_then_confirmation(100.0, false, 1, true, 60.0);
        assert_eq!(done.len(), 1);
        assert!(!done[0].valid);
        assert_eq!(done[0].time_ms, 60_000);
    }

    #[test]
    fn a_lap_scoring_gives_no_time_for_is_written_but_not_valid() {
        // The game reports -1 for the last lap time: there is no official time to trust. The lap waits, then is written
        // with the time measured from the telemetry.
        let mut rig = Rig::new();
        let mut done = rig.lap_then_confirmation(100.0, false, 1, false, -1.0);
        assert!(done.is_empty(), "it is waiting for a time");
        done.extend(rig.drive(160.03, 3.1, 2, 160.0, true, |_| false));
        assert_eq!(done.len(), 1);
        assert!(!done[0].valid && done[0].time_ms == 59_990 && done[0].sectors_ms.is_none());
    }

    #[test]
    fn a_lap_whose_time_never_arrives_is_written_after_a_few_seconds() {
        let mut rig = Rig::new();
        let mut done = rig.drive(100.0, 60.0, 1, 100.0, true, |_| false);
        done.extend(rig.update(&telemetry(160.0, 2, 160.0, SPEED), None));
        assert!(done.is_empty(), "it is still waiting for the scoring update that carries the time");
        // No scoring update follows. Three seconds of the next lap later it is written with the telemetry duration.
        let late = rig.drive(160.01, 3.1, 2, 160.0, false, |_| false);
        assert_eq!(late.len(), 1);
        assert!(!late[0].valid && late[0].time_ms == 59_990 && late[0].sectors_ms.is_none());
    }

    #[test]
    fn scoring_that_still_shows_the_lap_before_is_not_taken_as_the_time_of_the_lap_that_ended() {
        // Lap 1 officially took 61.0 s; lap 2 (60 s) closes while scoring still shows 61.0 for the lap before it, and
        // only a moment later catches up with 60.0. The 61.0 must not become lap 2's time.
        let mut rig = Rig::new();
        rig.lap_then_confirmation(100.0, false, 1, false, 61.0);
        let mut done = rig.drive(160.03, 59.97, 2, 160.0, true, |_| false);
        // Telemetry rolls over to lap 3; scoring, a few updates behind, still says lap 2 is being driven and shows 61.0.
        done.extend(rig.update(&telemetry(220.0, 3, 220.0, SPEED), None));
        done.extend(rig.update(&telemetry(220.1, 3, 220.0, SPEED), Some(scoring(220.1, 2990.0, 160.0, 61.0, false))));
        assert!(done.is_empty(), "no time yet");
        // Scoring catches up: it is on lap 3 and shows 60.0.
        done.extend(rig.update(&telemetry(220.2, 3, 220.0, SPEED), Some(scoring(220.2, 3.0, 220.0, 60.0, false))));
        done.extend(rig.update(&telemetry(220.21, 3, 220.0, SPEED), None));
        assert_eq!(done.len(), 1);
        assert_eq!((done[0].lap_number, done[0].time_ms, done[0].valid), (2, 60_000, true));
    }

    #[test]
    fn two_laps_with_the_same_official_time_to_the_millisecond_are_both_written_with_it() {
        // Scoring catches up with each new lap at once, so the time showing at the start of a lap is already the one
        // before it, and the same number twice running cannot be told from a time that has not come yet.
        let mut rig = Rig::new();
        let mut done = rig.drive(100.0, 60.0, 1, 100.0, true, |_| false);
        rig.last_lap = 60.0;
        for lap in 2..=3 {
            let start = 100.0 + 60.0 * f64::from(lap - 1);
            done.extend(rig.update(&telemetry(start, lap, start, SPEED), Some(scoring(start, 0.0, start, 60.0, false))));
            done.extend(rig.drive(start + 0.01, 59.99, lap, start, true, |_| false));
        }
        // Lap 3 is left running for a few seconds more: lap 2 closed at 220.0 and waits for a time that does not change.
        done.extend(rig.drive(280.0, 3.5, 4, 280.0, true, |_| false));
        let laps: Vec<_> = done.iter().filter(|l| l.lap_number <= 2).collect();
        assert_eq!(laps.len(), 2, "{done:?}");
        assert!(laps.iter().all(|l| l.time_ms == 60_000 && l.valid), "{laps:?}");
    }

    #[test]
    fn an_official_time_that_disagrees_with_the_telemetry_is_not_trusted() {
        let mut rig = Rig::new();
        let done = rig.lap_then_confirmation(100.0, false, 1, false, 71.234);
        assert_eq!(done.len(), 1);
        assert!(!done[0].valid);
        assert!(done[0].sectors_ms.is_none());
        assert_eq!(
            done[0].time_ms, 71_234,
            "the game's time is what it is; it is only not called valid"
        );
    }

    #[test]
    fn a_lap_joined_in_the_middle_is_thrown_away() {
        let mut rig = Rig::new();
        // We start listening 30 s into a lap that began at 100.
        let mut done = rig.drive(130.0, 30.0, 1, 100.0, true, |_| false);
        done.extend(rig.update(&telemetry(160.0, 2, 160.0, SPEED), None));
        done.extend(rig.update(&telemetry(160.01, 2, 160.0, SPEED), Some(scoring(160.01, 0.5, 160.0, 60.0, false))));
        done.extend(rig.update(&telemetry(160.02, 2, 160.0, SPEED), None));
        assert!(done.is_empty());
        // The lap that follows is whole and is kept.
        let mut done = rig.drive(160.03, 59.97, 2, 160.0, true, |_| false);
        done.extend(rig.update(&telemetry(220.0, 3, 220.0, SPEED), None));
        done.extend(rig.update(&telemetry(220.01, 3, 220.0, SPEED), Some(scoring(220.01, 0.5, 220.0, 60.0, false))));
        done.extend(rig.update(&telemetry(220.02, 3, 220.0, SPEED), None));
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].lap_number, 2);
    }

    #[test]
    fn a_new_car_or_track_throws_away_the_lap_in_progress() {
        let mut rig = Rig::new();
        rig.drive(100.0, 30.0, 1, 100.0, true, |_| false);
        // Both streams name the other track.
        let mut elsewhere = scoring(130.0, 1500.0, 100.0, 0.0, false);
        elsewhere.session.track_name = "Another Ring".into();
        let mut t = telemetry(130.0, 1, 100.0, SPEED);
        t.track_name = "Another Ring".into();
        assert!(rig.update(&t, Some(elsewhere)).is_empty());
        let mut done = Vec::new();
        for i in 1..2000 {
            let mut t = telemetry(130.0 + f64::from(i) * 0.01, 1, 100.0, SPEED);
            t.track_name = "Another Ring".into();
            done.extend(rig.update(&t, None));
        }
        done.extend(rig.update(&telemetry(160.0, 2, 160.0, SPEED), None));
        assert!(done.is_empty(), "the lap that began on the other track must not be written");
    }

    #[test]
    fn the_session_clock_going_back_throws_away_the_lap_in_progress() {
        let mut rig = Rig::new();
        rig.drive(500.0, 30.0, 4, 500.0, true, |_| false);
        // The player restarted the session: the clock is at 10 again.
        let mut done = rig.drive(10.0, 60.0, 1, 10.0, true, |_| false);
        done.extend(rig.update(&telemetry(70.0, 2, 70.0, SPEED), None));
        done.extend(rig.update(&telemetry(70.01, 2, 70.0, SPEED), Some(scoring(70.01, 0.5, 70.0, 60.0, false))));
        done.extend(rig.update(&telemetry(70.02, 2, 70.0, SPEED), None));
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].lap_number, 1);
        assert_eq!(done[0].sample_count(), 6000);
    }

    #[test]
    fn scoring_corrects_a_speed_that_reads_low() {
        // The speed we read is 5% under the truth: carrying the distance on alone would end 150 m short.
        let mut rig = Rig::new();
        let mut done = Vec::new();
        for i in 0..6000 {
            let et = 100.0 + f64::from(i) * 0.01;
            let s = (i % 20 == 0).then(|| scoring(et, ((et - 100.0) * SPEED).min(LENGTH - 1.0), 100.0, 0.0, false));
            done.extend(rig.update(&telemetry(et, 1, 100.0, SPEED * 0.95), s));
        }
        done.extend(rig.update(&telemetry(160.0, 2, 160.0, SPEED), None));
        done.extend(rig.update(&telemetry(160.01, 2, 160.0, SPEED), Some(scoring(160.01, 0.5, 160.0, 60.0, false))));
        done.extend(rig.update(&telemetry(160.02, 2, 160.0, SPEED), None));
        let lap = &done[0];
        let dist = &lap.channel("dist").unwrap().values;
        assert!(
            (f64::from(dist[dist.len() - 1]) - 3000.0).abs() < 12.0,
            "ended at {}",
            dist[dist.len() - 1]
        );
    }

    #[test]
    fn without_a_distance_from_scoring_the_distance_is_the_integral_of_speed() {
        // Scoring with no player in it: the phase is known (driving), the distance is not given.
        let mut rig = Rig::new();
        let mut alone = scoring(100.0, 0.0, 100.0, 0.0, false);
        alone.player = None;
        let mut done = Vec::new();
        for i in 0..6000 {
            let s = (i == 0).then(|| alone.clone());
            done.extend(rig.update(&telemetry(100.0 + f64::from(i) * 0.01, 1, 100.0, SPEED), s));
        }
        done.extend(rig.update(&telemetry(160.0, 2, 160.0, SPEED), None));
        done.extend(rig.drive(160.01, 3.1, 2, 160.0, false, |_| false));
        let dist = &done[0].channel("dist").unwrap().values;
        assert!((f64::from(dist[dist.len() - 1]) - 3000.0).abs() < 1.0, "{}", dist[dist.len() - 1]);
    }

    #[test]
    fn a_scoring_update_across_the_finish_line_does_not_move_the_distance_back() {
        let mut rig = Rig::new();
        rig.drive(100.0, 59.0, 1, 100.0, true, |_| false);
        // Scoring already wrapped to the new lap (distance near 0) while telemetry still reports the old lap.
        let mut done = Vec::new();
        for i in 0..100 {
            let et = 159.0 + f64::from(i) * 0.01;
            let s = (i == 0).then(|| scoring(et, 5.0, 159.5, 0.0, false));
            done.extend(rig.update(&telemetry(et, 1, 100.0, SPEED), s));
        }
        done.extend(rig.update(&telemetry(160.0, 2, 160.0, SPEED), None));
        done.extend(rig.update(&telemetry(160.01, 2, 160.0, SPEED), Some(scoring(160.01, 0.5, 160.0, 60.0, false))));
        done.extend(rig.update(&telemetry(160.02, 2, 160.0, SPEED), None));
        assert_eq!(done.len(), 1);
        let dist = &done[0].channel("dist").unwrap().values;
        assert!(dist[dist.len() - 1] > 2900.0, "distance fell to {}", dist[dist.len() - 1]);
        assert!(dist.windows(2).all(|w| w[1] >= w[0]));
    }

    #[test]
    fn a_pause_is_not_driven_as_distance_and_keeps_the_lap() {
        let mut rig = Rig::new();
        rig.drive(100.0, 10.0, 1, 100.0, true, |_| false);
        // The game is paused (phase 9) for two minutes: telemetry goes on, none of it is the lap.
        let mut paused = scoring(110.0, 500.0, 100.0, 0.0, false);
        paused.session.game_phase = 9;
        let frame = rig.framer.frame(Some(&telemetry(110.0, 1, 100.0, SPEED)), Some(paused)).unwrap();
        assert_eq!(frame.phase, Phase::Paused);
        for i in 0..1200 {
            let f = rig
                .framer
                .frame(Some(&telemetry(110.0 + f64::from(i) * 0.1, 1, 100.0, SPEED)), None)
                .unwrap();
            assert!(rig.cutter.as_mut().unwrap().on_frame(&f, 0).is_empty());
        }
        // Back in the car, on the same lap (the game's clock ran through the pause, so the lap clock says 180 s).
        let done = rig.drive(230.0, 50.0, 1, 100.0, true, |_| false);
        assert!(done.is_empty());
        let mut done = rig.update(&telemetry(280.0, 2, 280.0, SPEED), None);
        done.extend(rig.update(&telemetry(280.01, 2, 280.0, SPEED), Some(scoring(280.01, 0.5, 280.0, 180.0, false))));
        done.extend(rig.update(&telemetry(280.02, 2, 280.0, SPEED), None));
        assert_eq!(done.len(), 1);
        // 10 s before the pause and 50 s after it: the 120 s of pause are not samples (the old recorder took them in
        // as a gap, which it did not integrate).
        assert_eq!(done[0].sample_count(), 6000);
        assert!(done[0].valid && done[0].time_ms == 180_000);
    }

    #[test]
    fn the_garage_and_the_monitor_are_not_laps() {
        let mut rig = Rig::new();
        // In the monitor (not in realtime): the game still writes telemetry for 2 s.
        let mut garage = scoring(100.0, 0.0, 100.0, 0.0, false);
        garage.session.in_realtime = false;
        let first = rig.framer.frame(Some(&telemetry(100.0, 1, 100.0, SPEED)), Some(garage)).unwrap();
        assert_eq!((first.phase, first.driving), (Phase::Garage, false));
        for i in 1..200 {
            let f = rig
                .framer
                .frame(Some(&telemetry(100.0 + f64::from(i) * 0.01, 1, 100.0, SPEED)), None)
                .unwrap();
            assert!(!f.driving);
            assert!(rig.cutter.as_mut().unwrap().on_frame(&f, 0).is_empty());
        }
        // Driving: the lap is cut from the driving frames only.
        let mut done = rig.drive(102.0, 58.0, 1, 102.0, true, |_| false);
        done.extend(rig.update(&telemetry(160.0, 2, 160.0, SPEED), None));
        done.extend(rig.update(&telemetry(160.01, 2, 160.0, SPEED), Some(scoring(160.01, 0.5, 160.0, 58.0, false))));
        done.extend(rig.update(&telemetry(160.02, 2, 160.0, SPEED), None));
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].sample_count(), 5800);
        assert!(done[0].channel("t").unwrap().values[0] < 0.02);
    }

    #[test]
    fn a_lap_that_is_too_short_or_too_thin_is_not_kept() {
        let mut rig = Rig::new();
        let mut done = rig.drive(100.0, 3.0, 1, 100.0, true, |_| false);
        done.extend(rig.update(&telemetry(103.0, 2, 103.0, SPEED), None));
        done.extend(rig.update(&telemetry(103.01, 2, 103.0, SPEED), Some(scoring(103.01, 0.5, 103.0, 3.0, false))));
        done.extend(rig.update(&telemetry(103.02, 2, 103.0, SPEED), None));
        assert!(done.is_empty());
    }

    #[test]
    fn what_still_waits_for_its_time_is_written_when_the_source_closes() {
        let mut rig = Rig::new();
        let mut done = rig.drive(100.0, 60.0, 1, 100.0, true, |_| false);
        done.extend(rig.update(&telemetry(160.0, 2, 160.0, SPEED), None));
        assert!(done.is_empty());
        let flushed = rig.close();
        assert_eq!(flushed.len(), 1);
        assert!(!flushed[0].valid && flushed[0].lap_number == 1 && flushed[0].time_ms == 59_990);
    }

    #[test]
    fn a_name_the_game_leaves_empty_is_written_as_unknown() {
        let mut rig = Rig::new();
        let mut done = Vec::new();
        for lap in [1, 2] {
            let start = 100.0 + f64::from(lap - 1) * 60.0;
            for i in 0..6000 {
                let et = start + f64::from(i) * 0.01;
                let mut t = telemetry(et, lap, start, SPEED);
                t.vehicle_name = String::new();
                t.track_name = String::new();
                let s = (i % 20 == 0).then(|| {
                    let mut s = scoring(
                        et,
                        ((et - start) * SPEED).min(LENGTH - 1.0),
                        start,
                        if lap == 2 { 60.0 } else { 0.0 },
                        false,
                    );
                    s.session.track_name = String::new();
                    s
                });
                done.extend(rig.update(&t, s));
            }
        }
        done.extend(rig.update(&telemetry(220.0, 3, 220.0, SPEED), None));
        let lap = done.first().expect("a lap");
        assert_eq!((lap.track_name.as_str(), lap.car_name.as_str()), ("Unknown track", "Unknown car"));
        assert!(crate::lapfile::gunzip(&crate::lapfile::gzip(lap).unwrap(), crate::lapfile::MAX_UNPACKED).is_ok());
    }

    #[test]
    fn a_track_length_that_is_not_one_is_left_out() {
        let mut rig = Rig::new();
        let mut done = Vec::new();
        for i in 0..6000 {
            let et = 100.0 + f64::from(i) * 0.01;
            let s = (i % 20 == 0).then(|| {
                let mut s = scoring(et, ((et - 100.0) * SPEED).min(LENGTH - 1.0), 100.0, 0.0, false);
                s.session.track_length_m = 5_000_000.0;
                s
            });
            done.extend(rig.update(&telemetry(et, 1, 100.0, SPEED), s));
        }
        done.extend(rig.update(&telemetry(160.0, 2, 160.0, SPEED), None));
        done.extend(rig.drive(160.01, 3.1, 2, 160.0, false, |_| false));
        assert_eq!(done[0].track_length_m, None);
    }

    // ---- version 2: the session, the pit laps and the extra channels -------------------------------------------

    #[test]
    fn every_lap_of_a_session_carries_one_session_id_and_a_restart_makes_a_new_one() {
        let mut rig = Rig::new();
        let first = rig.lap_then_confirmation(100.0, false, 1, false, 60.0).remove(0);
        let second = rig.lap_then_confirmation(160.0, true, 2, false, 60.0).remove(0);
        let id = first.session_id.clone().expect("a session id");
        assert_eq!(id.len(), 32);
        assert_eq!(second.session_id.as_deref(), Some(id.as_str()), "the same session");
        // The player restarts the session: the game's clock is back at 10.
        let after = rig.lap_then_confirmation(10.0, false, 1, false, 60.0).remove(0);
        assert_ne!(after.session_id, Some(id));
        // The strict reader takes it.
        assert!(crate::lapfile::gunzip(&crate::lapfile::gzip(&after).unwrap(), crate::lapfile::MAX_UNPACKED).is_ok());
    }

    #[test]
    fn a_new_session_of_the_game_or_a_new_track_makes_a_new_session_id() {
        let mut rig = Rig::new();
        let first = rig.lap_then_confirmation(100.0, false, 1, false, 60.0).remove(0);
        assert_eq!(
            first.session_kind,
            Some(SessionKind::Practice),
            "the game's session 0 is the test day"
        );
        // The game moves to its next session (qualifying: number 5): scoring says so.
        let mut next = scoring(160.05, 10.0, 160.0, 59.0, false);
        next.session.session = 5;
        let mut done = rig.update(&telemetry(160.05, 2, 160.0, SPEED), Some(next.clone()));
        for i in 0..6000 {
            let et = 160.06 + f64::from(i) * 0.01;
            let s = (i % 20 == 0).then(|| {
                let mut s = scoring(et, ((et - 160.0) * SPEED).min(LENGTH - 1.0), 160.0, 59.0, false);
                s.session.session = 5;
                s
            });
            done.extend(rig.update(&telemetry(et, 2, 160.0, SPEED), s));
        }
        let mut closing = scoring(220.07, 0.5, 220.06, 60.0, false);
        closing.session.session = 5;
        done.extend(rig.update(&telemetry(220.06, 3, 220.06, SPEED), None));
        done.extend(rig.update(&telemetry(220.07, 3, 220.06, SPEED), Some(closing)));
        done.extend(rig.update(&telemetry(220.08, 3, 220.06, SPEED), None));
        // Lap 2 was joined 0.05 s into it, so it is kept, in a session of its own.
        let qualifying = done.last().expect("a lap of the new session");
        assert_eq!(qualifying.session_kind, Some(SessionKind::Qualifying));
        assert_ne!(qualifying.session_id, first.session_id);
    }

    #[test]
    fn an_out_lap_starts_in_the_pits_and_an_in_lap_ends_in_them() {
        let mut rig = Rig::new();
        // Lap 1: the car sits in the pits for the first 2 s. Lap 2: never. Lap 3: in the pits for the last 2 s.
        let mut laps = rig.drive(100.0, 60.0, 1, 100.0, true, |t| t < 2.0);
        laps.extend(rig.drive(160.0, 60.0, 2, 160.0, true, |_| false));
        laps.extend(rig.drive(220.0, 60.0, 3, 220.0, true, |t| t >= 58.0));
        laps.extend(rig.update(&telemetry(280.0, 4, 280.0, SPEED), None));
        laps.extend(rig.update(&telemetry(280.01, 4, 280.0, SPEED), Some(scoring(280.01, 0.5, 280.0, 60.0, false))));
        laps.extend(rig.update(&telemetry(280.02, 4, 280.0, SPEED), None));
        assert_eq!(laps.len(), 3, "{}", laps.len());
        assert_eq!((laps[0].out_lap, laps[0].in_lap), (Some(true), Some(false)));
        assert_eq!((laps[1].out_lap, laps[1].in_lap), (Some(false), Some(false)));
        assert_eq!((laps[2].out_lap, laps[2].in_lap), (Some(false), Some(true)));
        assert!(!laps[0].valid && !laps[2].valid, "through the pits: not valid");
    }

    fn wheel(brake: f64, kpa: f64, kelvin: f64, wear: f64) -> crate::lmu::snapshot::Wheel {
        crate::lmu::snapshot::Wheel {
            brake_temp_c: brake,
            pressure_kpa: kpa,
            temperature_k: [kelvin; 3],
            wear,
        }
    }

    #[test]
    fn the_new_channels_are_in_the_lap_when_the_game_gives_the_values_and_absent_when_it_does_not() {
        // Nothing about the tyres, the brakes or the wing; the dents and the aids' lights are always given.
        let mut rig = Rig::new();
        let bare = rig.lap_then_confirmation(100.0, false, 1, false, 60.0).remove(0);
        let ids: Vec<&str> = bare.channels.iter().map(|c| c.id.as_str()).collect();
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
                "clutch",
                "steer",
                "x",
                "y",
                "z",
                "fuel",
                "damage_body",
                "tc_active",
                "abs_active"
            ]
        );
        assert!(bare.channel("damage_body").unwrap().values.iter().all(|v| *v == 0.0));
        // With the four wheels, the rear wing and a dent.
        let mut rig = Rig::new();
        let mut laps = Vec::new();
        for i in 0..6000 {
            let et = 100.0 + f64::from(i) * 0.01;
            let mut t = telemetry(et, 1, 100.0, SPEED);
            t.wheels = [
                wheel(400.0, 180.0, 350.0, 0.9),
                wheel(410.0, 181.0, 351.0, 0.8),
                wheel(300.0, 190.0, 352.0, 0.7),
                wheel(310.0, 191.0, 353.0, 0.6),
            ];
            t.rear_flap_activated = i >= 3000;
            t.rear_flap_legal = 2;
            t.dents[0] = 2;
            t.abs_active = i % 2 == 0;
            let s = (i % 20 == 0).then(|| scoring(et, ((et - 100.0) * SPEED).min(LENGTH - 1.0), 100.0, 0.0, false));
            laps.extend(rig.update(&t, s));
        }
        laps.extend(rig.update(&telemetry(160.0, 2, 160.0, SPEED), None));
        laps.extend(rig.update(&telemetry(160.01, 2, 160.0, SPEED), Some(scoring(160.01, 0.5, 160.0, 60.0, false))));
        laps.extend(rig.update(&telemetry(160.02, 2, 160.0, SPEED), None));
        let lap = &laps[0];
        let col = |id: &str| lap.channel(id).unwrap_or_else(|| panic!("no {id}"));
        assert_eq!(col("brake_temp_fl").values[0], 400.0);
        assert_eq!(col("brake_temp_rr").values[0], 310.0);
        assert_eq!((col("tyre_press_fr").values[0], col("tyre_press_fr").unit.as_str()), (181.0, "kPa"));
        assert!((col("tyre_temp_fl").values[0] - 76.85).abs() < 0.01, "350 K in Celsius");
        assert_eq!(col("tyre_wear_rl").values[0], 0.7);
        assert_eq!((col("drs").values[0], col("drs").values[4000]), (1.0, 2.0), "allowed, then open");
        assert_eq!(col("damage_body").values[0], 2.0 / 16.0);
        assert_eq!((col("abs_active").values[0], col("abs_active").values[1]), (1.0, 0.0));
        assert!(lap.channels.iter().all(|c| c.values.len() == lap.sample_count()));
        assert!(lap.channel("g_lat").is_none(), "this reader has no G: absent, not zero");
        // The strict reader takes the lap.
        assert!(crate::lapfile::gunzip(&crate::lapfile::gzip(lap).unwrap(), crate::lapfile::MAX_UNPACKED).is_ok());
    }

    #[test]
    fn weather_temperatures_and_compound_are_not_written_for_this_game_yet() {
        let mut rig = Rig::new();
        let lap = rig.lap_then_confirmation(100.0, false, 1, false, 60.0).remove(0);
        assert_eq!(
            (lap.weather.clone(), lap.air_temp_c, lap.track_temp_c, lap.tyre_compound.clone()),
            (None, None, None, None)
        );
    }

    /// Not a check: writes a real lap to the file named by `XPEED_SAMPLE_LAP`, so another program (the
    /// app's reader) can be pointed at what this source produces. Run it with
    /// `XPEED_SAMPLE_LAP=sample.xlap.gz cargo test writes_a_sample_lap -- --ignored`.
    #[test]
    #[ignore]
    fn writes_a_sample_lap_to_disk() {
        let path = std::env::var("XPEED_SAMPLE_LAP").expect("set XPEED_SAMPLE_LAP to the file to write");
        let mut rig = Rig::new();
        let lap = rig.lap_then_confirmation(100.0, false, 1, false, 60.0).remove(0);
        std::fs::write(path, crate::lapfile::gzip(&lap).unwrap()).unwrap();
    }
}
