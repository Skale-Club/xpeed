//! What the panel shows while someone drives: the latest reading of the car, and the gap to the best lap of this run
//! (the delta). Every game's frames come through here (Le Mans Ultimate's are turned into the same `Frame` first), so
//! the panel does not need to know which game it is. Pure, so it is tested without a screen.

use std::sync::Arc;

use crate::game::{Frame, Tyre};
use crate::lmu::snapshot::{PlayerTelemetry, ScoringFrame};
use crate::maps::Store;

/// Le Mans Ultimate's two streams as one `Frame`, for the panel only (its laps are cut by `recorder.rs`).
///
/// Scoring comes a few times a second; the distance is carried forward from it at the car's speed, as the recorder
/// does. Just after the line the scoring can still show the end of the last lap: that distance is not given until
/// the scoring catches up, so the new lap is not taken as joined midway.
pub fn lmu_frame(t: &PlayerTelemetry, scoring: Option<&ScoringFrame>) -> Frame {
    let mut frame = Frame::empty();
    let speed = t.speed_ms();
    frame.driving = scoring.is_none_or(|s| s.session.in_realtime);
    frame.lap = t.lap_number;
    let lap_time = t.elapsed_time - t.lap_start_et;
    frame.lap_time_s = (0.0..=86_400.0).contains(&lap_time).then_some(lap_time);
    frame.speed_ms = speed as f32;
    frame.rpm = t.rpm as f32;
    frame.gear = t.gear as f32;
    // `mMaxGears`: maximum forward gears; 0 is unset.
    frame.gears = (t.max_gears > 0).then_some(t.max_gears);
    frame.throttle = t.throttle as f32;
    frame.brake = t.brake as f32;
    frame.clutch = t.clutch as f32;
    frame.steer = t.steering as f32;
    frame.fuel_l = t.fuel_l as f32;
    // The car's place in the world, for the track map; a reading that is not finite or absurd is not given.
    let place = |v: f64| if v.is_finite() && v.abs() <= 1.0e7 { v as f32 } else { f32::NAN };
    (frame.x, frame.y, frame.z) = (place(t.pos[0]), place(t.pos[1]), place(t.pos[2]));
    let tyres: [Tyre; 4] = std::array::from_fn(|i| {
        let w = &t.wheels[i];
        let kelvin = w.temperature_k.iter().sum::<f64>() / 3.0;
        Tyre {
            brake_c: if w.brake_temp_c > 0.0 && w.brake_temp_c <= 2000.0 {
                w.brake_temp_c as f32
            } else {
                f32::NAN
            },
            temp_c: if (200.0..=600.0).contains(&kelvin) {
                (kelvin - 273.15) as f32
            } else {
                f32::NAN
            },
            pressure_kpa: if w.pressure_kpa > 0.0 && w.pressure_kpa <= 1000.0 {
                w.pressure_kpa as f32
            } else {
                f32::NAN
            },
            left: if (0.0..=1.0).contains(&w.wear) && w.wear > 0.0 {
                w.wear as f32
            } else {
                f32::NAN
            },
        }
    });
    frame.tyres = tyres.iter().any(Tyre::known).then_some(tyres);
    frame.car = t.vehicle_name.clone();
    frame.track = t.track_name.clone();
    if let Some(s) = scoring {
        let length = (s.session.track_length_m > 0.0).then_some(s.session.track_length_m);
        frame.track_length_m = length;
        if !s.session.track_name.is_empty() {
            frame.track = s.session.track_name.clone();
        }
        if let Some(player) = &s.player {
            frame.in_pits = player.in_pits;
            frame.car_class = (!player.vehicle_class.is_empty()).then(|| player.vehicle_class.clone());
            frame.last_lap_s = (player.last_lap_time > 0.0).then_some(player.last_lap_time);
            let lag = (t.elapsed_time - s.session.current_et).clamp(0.0, 1.0);
            let dist = player.lap_dist + speed * lag;
            let stale_from_last_lap = length.is_some_and(|l| lap_time < 10.0 && dist > l * 0.5);
            frame.dist_m = (dist.is_finite() && dist >= 0.0 && !stale_from_last_lap).then_some(dist);
        }
    }
    frame
}

/// One picture of the car for the panel. Values the game does not give are `NaN` or `None`, like in `Frame`.
#[derive(Clone, Debug, PartialEq)]
pub struct Live {
    pub game: &'static str,
    pub track: String,
    pub car: String,
    pub driving: bool,
    pub in_pits: bool,
    pub lap: i32,
    pub lap_time_s: Option<f64>,
    /// `Some(false)` when the game says the lap being driven will not count.
    pub lap_valid: Option<bool>,
    pub last_lap_s: Option<f64>,
    /// The best complete lap seen in this run on this track with this car.
    pub best_lap_s: Option<f64>,
    /// Time on this lap minus the best lap's time at the same distance (negative: faster).
    pub delta_s: Option<f64>,
    pub dist_m: Option<f64>,
    pub track_length_m: Option<f64>,
    pub speed_ms: f32,
    pub rpm: f32,
    /// The highest RPM seen in this run with this car: the top of the rev bar (the games do not all give the limit).
    pub rpm_top: f32,
    pub gear: f32,
    /// How many forward gears the car has: the game's own count, else the top gear seen to be left (see `Tracker`).
    pub gears: Option<u8>,
    pub throttle: f32,
    pub brake: f32,
    pub clutch: f32,
    pub steer: f32,
    pub fuel_l: f32,
    /// Front left to rear right, when the game gives them.
    pub tyres: Option<[Tyre; 4]>,
    /// The track as the car has driven it (the best lap's path, or the first full lap's until there is a best one),
    /// in the game's x and z; shared, as it changes once a lap at most.
    pub map: Option<Arc<Vec<(f32, f32)>>>,
    /// Where the car is now, in the same x and z.
    pub pos: Option<(f32, f32)>,
    /// `map` is a whole lap (or the real layout), a closed shape. When false it is the path driven so far, an open
    /// line, and may hold jumps (`MAP_JUMP_METRES`) the drawing must not join.
    pub map_complete: bool,
    /// When this reading arrived (Unix ms), so the panel can tell a stale one.
    pub at_ms: i64,
}

/// A lap's time at each distance it was seen at, in order of distance.
type Profile = Vec<(f64, f64)>;
/// A lap's path, (x, z) every few metres.
type Path = Vec<(f32, f32)>;

/// Keeps what the delta needs: the lap being driven, and the best one so far.
#[derive(Default)]
pub struct Tracker {
    /// Track, car and layout the best lap belongs to; a change starts over.
    key: Option<(String, String, Option<String>)>,
    /// Where maps are kept between sessions; none in tests and the demo.
    store: Option<Store>,
    /// The map is the real layout the game's files gave: laps do not replace it.
    map_is_layout: bool,
    lap: i32,
    current: Profile,
    /// Seen from the line: a lap joined midway has no delta and cannot become the best.
    current_from_line: bool,
    /// A lap that just ended and waits for the game's official time, with its path.
    finished: Option<(Profile, Path, Option<f64>)>,
    /// The current lap's path (x, z), a point every few metres.
    path: Path,
    /// The current lap's path has a jump in it (a restart, the pits, a teleport): it is not a lap's map.
    path_jumped: bool,
    /// The path shown as the map.
    map: Option<Arc<Path>>,
    best: Option<(f64, Profile)>,
    /// The official time of the last lap as the previous reading showed it.
    official: Option<f64>,
    rpm_top: f32,
    /// The highest forward gear seen with this car, and whether the car was seen in a lower one afterwards.
    top_gear: u8,
    top_gear_left: bool,
}

/// A first reading further than this from the line means the lap was joined midway.
const FROM_LINE_METRES: f64 = 50.0;
/// The map keeps a point every this many metres of the car's path.
const MAP_STEP_METRES: f32 = 4.0;
/// Two points of the path further apart than this are not one drive (points are kept every `MAP_STEP_METRES`): a
/// restart, a return to the pits or a teleport. The map is not drawn across it, and such a lap is not a map.
pub const MAP_JUMP_METRES: f32 = 40.0;
/// A path shorter than this is not a map yet.
const MAP_MIN_POINTS: usize = 30;
/// A finished lap must cover this share of the track (when its length is known) to be a full lap.
const FULL_LAP_SHARE: f64 = 0.9;

impl Tracker {
    /// A tracker that keeps each track's map on disk and starts from it (see `maps.rs`).
    pub fn stored(store: Store) -> Tracker {
        Tracker {
            store: Some(store),
            ..Tracker::default()
        }
    }

    pub fn on_frame(&mut self, game: &'static str, frame: &Frame, at_ms: i64) -> Live {
        let key = (frame.track.clone(), frame.car.clone(), frame.track_variant.clone());
        if self.key.as_ref() != Some(&key) {
            *self = Tracker {
                key: Some(key),
                lap: frame.lap,
                store: self.store.take(),
                ..Tracker::default()
            };
            // A track seen before has its map from the first frame (the real layout when there is one).
            if let (Some(store), false) = (&self.store, frame.track.is_empty()) {
                if let Some(path) = store.start(&frame.track, frame.track_variant.as_deref()) {
                    self.map_is_layout = store.layout(&frame.track, frame.track_variant.as_deref()).is_some();
                    self.map = Some(Arc::new(path));
                }
            }
        }
        if frame.lap != self.lap {
            self.look_for_layout();
            // The lap ended: keep it until its official time shows (it can come a moment after the new lap starts),
            // with the official time that was showing while it was driven (the one before it).
            let done = std::mem::take(&mut self.current);
            let jumped = std::mem::take(&mut self.path_jumped);
            let done_path = if jumped { Vec::new() } else { std::mem::take(&mut self.path) };
            self.path.clear();
            let full = self.current_from_line && is_full(&done, frame.track_length_m);
            if full && self.map.is_none() && done_path.len() >= MAP_MIN_POINTS {
                self.keep_map(done_path.clone());
            }
            self.finished = full.then_some((done, done_path, self.official));
            self.lap = frame.lap;
            self.current_from_line = false;
        }
        if let Some((profile, path, official_before)) = self.finished.take() {
            match frame.last_lap_s {
                // A new official time: it belongs to the lap that just ended.
                Some(time) if Some(time) != official_before => self.offer_best(time, profile, path),
                _ => self.finished = Some((profile, path, official_before)),
            }
        }
        if frame.driving && frame.x.is_finite() && frame.z.is_finite() {
            let here = (frame.x, frame.z);
            let far_enough = self
                .path
                .last()
                .is_none_or(|&(x, z)| (x - here.0).hypot(z - here.1) >= MAP_STEP_METRES);
            if far_enough {
                if self
                    .path
                    .last()
                    .is_some_and(|&(x, z)| (x - here.0).hypot(z - here.1) > MAP_JUMP_METRES)
                {
                    self.path_jumped = true;
                }
                self.path.push(here);
            }
        }
        self.official = frame.last_lap_s;
        if frame.driving {
            if let (Some(dist), Some(t)) = (frame.dist_m, frame.lap_time_s) {
                if self.current.is_empty() {
                    self.current_from_line = dist <= FROM_LINE_METRES;
                }
                if self.current.last().is_none_or(|&(d, _)| dist > d) {
                    self.current.push((dist, t));
                }
            }
        }
        if frame.rpm.is_finite() && frame.rpm > self.rpm_top {
            self.rpm_top = frame.rpm;
        }
        self.see_gear(frame.gear);
        let delta_s = match (&self.best, frame.dist_m, frame.lap_time_s) {
            (Some((_, best)), Some(dist), Some(t)) if self.current_from_line && frame.driving => {
                time_at(best, dist).map(|best_t| t - best_t)
            }
            _ => None,
        };
        Live {
            game,
            track: frame.track.clone(),
            car: frame.car.clone(),
            driving: frame.driving,
            in_pits: frame.in_pits,
            lap: frame.lap,
            lap_time_s: frame.lap_time_s,
            lap_valid: frame.lap_valid,
            last_lap_s: frame.last_lap_s,
            best_lap_s: self.best.as_ref().map(|(t, _)| *t),
            delta_s,
            dist_m: frame.dist_m,
            track_length_m: frame.track_length_m,
            speed_ms: frame.speed_ms,
            rpm: frame.rpm,
            rpm_top: self.rpm_top,
            gear: frame.gear,
            gears: frame.gears.or_else(|| self.top_gear_left.then_some(self.top_gear)),
            throttle: frame.throttle,
            brake: frame.brake,
            clutch: frame.clutch,
            steer: frame.steer,
            fuel_l: frame.fuel_l,
            tyres: frame.tyres,
            map: self
                .map
                .clone()
                .or_else(|| (self.path.len() >= MAP_MIN_POINTS).then(|| Arc::new(self.path.clone()))),
            map_complete: self.map.is_some(),
            pos: (frame.x.is_finite() && frame.z.is_finite()).then_some((frame.x, frame.z)),
            at_ms,
        }
    }

    /// Remembers the highest forward gear. It only counts as the car's top gear once the car has been seen in a lower
    /// one after it: just reaching a gear says nothing about whether there is another above it.
    fn see_gear(&mut self, gear: f32) {
        if !gear.is_finite() || !(1.0..=30.0).contains(&gear.round()) {
            return;
        }
        let g = gear.round() as u8;
        if g > self.top_gear {
            self.top_gear = g;
            self.top_gear_left = false;
        } else if g < self.top_gear {
            self.top_gear_left = true;
        }
    }

    fn offer_best(&mut self, time: f64, profile: Profile, path: Path) {
        if self.best.as_ref().is_none_or(|(best, _)| time < *best) {
            self.best = Some((time, profile));
            if path.len() >= MAP_MIN_POINTS && !self.map_is_layout {
                self.keep_map(path);
            }
        }
    }

    /// Makes `path` the map and saves it for this track, so the next session starts with it.
    fn keep_map(&mut self, path: Path) {
        if let (Some(store), Some((track, _, variant))) = (&self.store, &self.key) {
            if let Err(error) = store.save(track, variant.as_deref(), &path) {
                crate::applog::line(&format!("Cannot keep the map of {track}: {error}"));
            }
        }
        self.map = Some(Arc::new(path));
    }

    /// The layout is built a moment after the game says its track: take it once it is there.
    fn look_for_layout(&mut self) {
        if self.map_is_layout {
            return;
        }
        if let (Some(store), Some((track, _, variant))) = (&self.store, &self.key) {
            if let Some(path) = store.layout(track, variant.as_deref()) {
                self.map = Some(Arc::new(path));
                self.map_is_layout = true;
            }
        }
    }
}

/// From near the line to (when the length is known) most of the way round.
fn is_full(profile: &Profile, length: Option<f64>) -> bool {
    let (Some(first), Some(last)) = (profile.first(), profile.last()) else {
        return false;
    };
    first.0 <= FROM_LINE_METRES && length.is_none_or(|length| last.0 >= length * FULL_LAP_SHARE)
}

/// The best lap's time at `dist`, between the two readings around it. `None` past either end.
fn time_at(profile: &Profile, dist: f64) -> Option<f64> {
    let after = profile.partition_point(|&(d, _)| d < dist);
    if after == 0 || after == profile.len() {
        return profile.get(after).filter(|&&(d, _)| d == dist).map(|&(_, t)| t);
    }
    let ((d0, t0), (d1, t1)) = (profile[after - 1], profile[after]);
    Some(t0 + (t1 - t0) * (dist - d0) / (d1 - d0))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame at `dist` metres into lap `lap`, `t` seconds after it began.
    fn at(lap: i32, dist: f64, t: f64, last: Option<f64>) -> Frame {
        let mut frame = Frame::empty();
        frame.driving = true;
        frame.lap = lap;
        frame.dist_m = Some(dist);
        frame.lap_time_s = Some(t);
        frame.last_lap_s = last;
        frame.track = "Monza".into();
        frame.car = "GT3".into();
        frame.track_length_m = Some(1000.0);
        frame.rpm = 5000.0 + dist as f32;
        frame
    }

    /// Drives lap `lap` at a constant `speed` (m/s), ten readings a second; `last` is the official time showing.
    fn drive_lap(tracker: &mut Tracker, lap: i32, speed: f64, last: Option<f64>) -> Vec<Live> {
        let duration = 1000.0 / speed;
        (0..(duration * 10.0) as usize)
            .map(|i| {
                let t = i as f64 / 10.0;
                tracker.on_frame("Test", &at(lap, t * speed, t, last), 0)
            })
            .collect()
    }

    #[test]
    fn no_delta_before_a_best_lap_then_the_gap_to_it() {
        let mut tracker = Tracker::default();
        let first = drive_lap(&mut tracker, 1, 50.0, None);
        assert!(first.iter().all(|l| l.delta_s.is_none() && l.best_lap_s.is_none()));
        // The second lap is slower (40 m/s); its official time for lap 1 (20 s) shows from its start.
        let second = drive_lap(&mut tracker, 2, 40.0, Some(20.0));
        assert_eq!(second[5].best_lap_s, Some(20.0));
        // Halfway: 12.5 s against the best lap's 10 s.
        let halfway = second.iter().find(|l| l.dist_m == Some(500.0)).unwrap();
        assert!((halfway.delta_s.unwrap() - 2.5).abs() < 1e-9, "{:?}", halfway.delta_s);
    }

    #[test]
    fn a_faster_lap_becomes_the_best_and_a_slower_one_does_not() {
        let mut tracker = Tracker::default();
        drive_lap(&mut tracker, 1, 50.0, None);
        drive_lap(&mut tracker, 2, 40.0, Some(20.0));
        let third = drive_lap(&mut tracker, 3, 50.0, Some(25.0));
        assert_eq!(third.last().unwrap().best_lap_s, Some(20.0), "25 s is not better than 20 s");
        let fourth = drive_lap(&mut tracker, 4, 60.0, Some(20.0));
        assert_eq!(fourth.last().unwrap().best_lap_s, Some(20.0));
        let fifth = drive_lap(&mut tracker, 5, 60.0, Some(1000.0 / 60.0));
        assert!(
            (fifth[3].best_lap_s.unwrap() - 1000.0 / 60.0).abs() < 1e-9,
            "the faster lap 4 is the best now"
        );
    }

    #[test]
    fn the_official_time_can_come_a_moment_after_the_new_lap() {
        let mut tracker = Tracker::default();
        drive_lap(&mut tracker, 1, 50.0, None);
        // The first readings of lap 2 still show no last lap; then 20 s shows.
        tracker.on_frame("Test", &at(2, 0.0, 0.0, None), 0);
        tracker.on_frame("Test", &at(2, 5.0, 0.1, None), 0);
        let live = tracker.on_frame("Test", &at(2, 10.0, 0.2, Some(20.0)), 0);
        assert_eq!(live.best_lap_s, Some(20.0));
    }

    #[test]
    fn a_lap_joined_midway_is_not_a_best_lap_and_has_no_delta() {
        let mut tracker = Tracker::default();
        // Joined at 600 m.
        for i in 0..80 {
            tracker.on_frame("Test", &at(1, 600.0 + i as f64 * 5.0, 12.0 + i as f64 * 0.1, None), 0);
        }
        let second = drive_lap(&mut tracker, 2, 50.0, Some(20.0));
        assert!(second.iter().all(|l| l.best_lap_s.is_none() && l.delta_s.is_none()));
    }

    #[test]
    fn another_track_or_car_starts_over() {
        let mut tracker = Tracker::default();
        drive_lap(&mut tracker, 1, 50.0, None);
        drive_lap(&mut tracker, 2, 50.0, Some(20.0));
        let mut other = at(1, 0.0, 0.0, None);
        other.car = "Hypercar".into();
        let live = tracker.on_frame("Test", &other, 0);
        assert_eq!((live.best_lap_s, live.rpm_top), (None, 5000.0));
    }

    #[test]
    fn the_gear_count_is_the_games_or_the_top_gear_seen_once_it_was_left() {
        let mut tracker = Tracker::default();
        let mut frame = at(1, 0.0, 0.0, None);
        let mut gears = |tracker: &mut Tracker, gear: f32, count: Option<u8>| {
            frame.gear = gear;
            frame.gears = count;
            tracker.on_frame("Test", &frame, 0).gears
        };
        // Climbing through the gears says nothing yet: there may be one more above.
        assert_eq!(gears(&mut tracker, 1.0, None), None);
        assert_eq!(gears(&mut tracker, 2.0, None), None);
        assert_eq!(gears(&mut tracker, 6.0, None), None);
        assert_eq!(gears(&mut tracker, 0.0, None), None, "neutral is not a lower gear");
        // Back from 6th to 5th: 6 is the highest seen, and the car has been below it since.
        assert_eq!(gears(&mut tracker, 5.0, None), Some(6));
        assert_eq!(gears(&mut tracker, 6.0, None), Some(6));
        // The game's own count wins.
        assert_eq!(gears(&mut tracker, 6.0, Some(7)), Some(7));
        // Reverse is not a forward gear.
        let mut other = Tracker::default();
        assert_eq!(gears(&mut other, -1.0, None), None);
        assert_eq!(gears(&mut other, f32::NAN, None), None);
    }

    #[test]
    fn another_car_forgets_the_top_gear() {
        let mut tracker = Tracker::default();
        let mut frame = at(1, 0.0, 0.0, None);
        for gear in [4.0, 3.0] {
            frame.gear = gear;
            tracker.on_frame("Test", &frame, 0);
        }
        frame.car = "Other".into();
        assert_eq!(tracker.on_frame("Test", &frame, 0).gears, None);
    }

    #[test]
    fn keeps_the_top_rpm_seen() {
        let mut tracker = Tracker::default();
        let lap = drive_lap(&mut tracker, 1, 50.0, None);
        assert_eq!(lap.last().unwrap().rpm_top, lap.last().unwrap().rpm);
        let mut slow = at(1, 999.5, 19.99, None);
        slow.rpm = 3000.0;
        assert_eq!(tracker.on_frame("Test", &slow, 0).rpm_top, lap.last().unwrap().rpm);
    }

    #[test]
    fn turns_le_mans_ultimate_into_a_frame_and_carries_the_distance_forward() {
        use crate::lmu::snapshot::{SessionScoring, VehicleScoring};
        let t = PlayerTelemetry {
            elapsed_time: 100.4,
            lap_number: 5,
            lap_start_et: 60.0,
            vehicle_name: "Porsche 963".into(),
            track_name: "Sarthe".into(),
            local_vel: [0.0, 0.0, -50.0],
            gear: 5,
            max_gears: 7,
            rpm: 7800.0,
            throttle: 1.0,
            steering: -0.2,
            fuel_l: 40.0,
            ..PlayerTelemetry::default()
        };
        let scoring = ScoringFrame {
            session: SessionScoring {
                track_name: "Circuit de la Sarthe".into(),
                track_length_m: 13_626.0,
                current_et: 100.0,
                in_realtime: true,
                ..SessionScoring::default()
            },
            player: Some(VehicleScoring {
                vehicle_class: "Hypercar".into(),
                lap_dist: 2000.0,
                last_lap_time: 210.5,
                ..VehicleScoring::default()
            }),
        };
        let frame = lmu_frame(&t, Some(&scoring));
        assert!(frame.driving);
        assert_eq!((frame.lap, frame.speed_ms, frame.gear, frame.steer), (5, 50.0, 5.0, -0.2));
        assert_eq!(frame.gears, Some(7));
        assert!((frame.lap_time_s.unwrap() - 40.4).abs() < 1e-9);
        assert!(
            (frame.dist_m.unwrap() - 2020.0).abs() < 1e-9,
            "0.4 s at 50 m/s past the last scoring"
        );
        assert_eq!(frame.last_lap_s, Some(210.5));
        assert_eq!(frame.track, "Circuit de la Sarthe");
        assert_eq!(frame.car_class.as_deref(), Some("Hypercar"));

        // Just over the line, the scoring still shows the end of the last lap.
        let mut just_over = t.clone();
        just_over.lap_start_et = 100.0;
        let mut late = scoring.clone();
        late.player.as_mut().unwrap().lap_dist = 13_600.0;
        assert_eq!(lmu_frame(&just_over, Some(&late)).dist_m, None);
        // Without scoring yet: no distance, and the car counts as driven.
        let alone = lmu_frame(&t, None);
        assert!(alone.driving && alone.dist_m.is_none() && alone.track == "Sarthe");
    }

    #[test]
    fn the_map_is_the_first_full_lap_then_the_best_one_and_shows_where_the_car_is() {
        let mut tracker = Tracker::default();
        let driven = |tracker: &mut Tracker, lap: i32, last: Option<f64>, wobble: f32| {
            let mut out = Vec::new();
            for i in 0..200 {
                let mut frame = at(lap, i as f64 * 5.0, i as f64 * 0.1, last);
                let a = i as f32 / 200.0 * std::f32::consts::TAU;
                (frame.x, frame.z) = (160.0 * a.cos() + wobble, 160.0 * a.sin());
                out.push(tracker.on_frame("Test", &frame, 0));
            }
            out
        };
        let first = driven(&mut tracker, 1, None, 0.0);
        assert!(first[10].map.is_none(), "too few points for a map");
        assert!(
            first[199].map.as_ref().is_some_and(|m| m.len() > 100),
            "the lap being driven, until one is done"
        );
        assert_eq!(
            first[199].pos,
            Some((
                160.0 * (199.0f32 / 200.0 * std::f32::consts::TAU).cos(),
                160.0 * (199.0f32 / 200.0 * std::f32::consts::TAU).sin()
            ))
        );
        let second = driven(&mut tracker, 2, Some(20.0), 50.0);
        assert_eq!(second[0].map.as_ref().unwrap()[0], (160.0, 0.0), "the first full lap is the map");
        let third = driven(&mut tracker, 3, Some(19.0), 0.0);
        assert_eq!(
            third[5].map.as_ref().unwrap()[0],
            (210.0, 0.0),
            "lap 2 (19 s) became the best lap, and its path the map"
        );
        let mut tyred = at(3, 1000.0, 20.0, None);
        tyred.tyres = Some(
            [Tyre {
                brake_c: f32::NAN,
                temp_c: 85.0,
                pressure_kpa: 180.0,
                left: 0.9,
            }; 4],
        );
        assert_eq!(tracker.on_frame("Test", &tyred, 0).tyres.unwrap()[2].temp_c, 85.0);
    }

    #[test]
    fn a_le_mans_ultimate_frame_carries_the_car_position_for_the_map() {
        let t = PlayerTelemetry {
            pos: [120.5, 3.0, -840.25],
            ..PlayerTelemetry::default()
        };
        let frame = lmu_frame(&t, None);
        assert_eq!((frame.x, frame.y, frame.z), (120.5, 3.0, -840.25));
        let mut tracker = Tracker::default();
        assert_eq!(tracker.on_frame("Le Mans Ultimate", &frame, 0).pos, Some((120.5, -840.25)));
        for bad in [f64::NAN, f64::INFINITY, 1.0e12] {
            let t = PlayerTelemetry {
                pos: [bad, 0.0, bad],
                ..PlayerTelemetry::default()
            };
            let frame = lmu_frame(&t, None);
            assert!(frame.x.is_nan() && frame.z.is_nan(), "{bad} is not a position");
        }
    }

    #[test]
    fn a_jump_in_the_path_is_not_a_lap_s_map_and_a_partial_path_is_not_complete() {
        let mut tracker = Tracker::default();
        let drive = |tracker: &mut Tracker, lap: i32, last: Option<f64>, jump_at: Option<usize>| {
            let mut out = Vec::new();
            for i in 0..200 {
                let mut frame = at(lap, i as f64 * 5.0, i as f64 * 0.1, last);
                let a = i as f32 / 200.0 * std::f32::consts::TAU;
                let r = if jump_at.is_some_and(|j| i >= j) { 300.0 } else { 160.0 };
                (frame.x, frame.z) = (r * a.cos(), r * a.sin());
                out.push(tracker.on_frame("Test", &frame, 0));
            }
            out
        };
        let first = drive(&mut tracker, 1, None, Some(100));
        assert!(first.iter().all(|l| !l.map_complete), "a lap being driven is a partial path");
        // Lap 1 had a teleport: it is no map, even though it was a full lap.
        let second = drive(&mut tracker, 2, Some(20.0), None);
        assert!(!second[5].map_complete, "a path with a jump is not taken as the map");
        drive(&mut tracker, 3, Some(20.0), None);
        let fourth = drive(&mut tracker, 4, Some(20.0), None);
        assert!(fourth[0].map_complete, "a clean full lap is");
        assert_eq!(fourth[0].map.as_ref().unwrap()[0], (160.0, 0.0));
    }

    #[test]
    fn a_saved_map_is_offered_at_once_for_its_track_only() {
        let dir = crate::config::scratch_dir("dash-maps");
        let store = || Store {
            maps: dir.join("maps"),
            layouts: dir.join("tracks"),
            game: "lmu",
        };
        let lap = |tracker: &mut Tracker, lap: i32, last: Option<f64>, radius: f32, track: &str| {
            let mut out = Vec::new();
            for i in 0..200 {
                let mut frame = at(lap, i as f64 * 5.0, i as f64 * 0.1, last);
                frame.track = track.into();
                let a = i as f32 / 200.0 * std::f32::consts::TAU;
                (frame.x, frame.z) = (radius * a.cos(), radius * a.sin());
                out.push(tracker.on_frame("Test", &frame, 0));
            }
            out
        };
        let mut first = Tracker::stored(store());
        let one = lap(&mut first, 1, None, 160.0, "Monza");
        assert!(one[0].map.is_none(), "nothing saved yet");
        lap(&mut first, 2, Some(20.0), 210.0, "Monza");
        assert!(
            store().load("Monza", None).is_some_and(|m| m.len() > 100),
            "the first full lap was saved"
        );
        // Lap 2 (19 s) is the best lap once lap 3 shows its time: its path replaces the first, and the file follows.
        lap(&mut first, 3, Some(19.0), 160.0, "Monza");
        assert_eq!(store().load("Monza", None).unwrap()[0], (210.0, 0.0));

        // A new session: the map is there from the first frame, on that track only.
        let mut next = Tracker::stored(store());
        let again = lap(&mut next, 1, None, 50.0, "Monza");
        assert_eq!(again[0].map.as_ref().unwrap()[0], (210.0, 0.0));
        let mut other = Tracker::stored(store());
        assert!(lap(&mut other, 1, None, 50.0, "Spa")[0].map.is_none());
        // Moving to another track on the same tracker drops the old track's map.
        let mut moved = Tracker::stored(store());
        lap(&mut moved, 1, None, 50.0, "Monza");
        assert!(lap(&mut moved, 1, None, 50.0, "Spa")[0].map.is_none());
    }

    #[test]
    fn reads_le_mans_ultimate_tyres_in_celsius_and_leaves_out_what_is_empty() {
        use crate::lmu::snapshot::Wheel;
        let mut t = PlayerTelemetry::default();
        t.wheels[0] = Wheel {
            brake_temp_c: 412.5,
            pressure_kpa: 175.0,
            temperature_k: [358.15, 363.15, 368.15],
            wear: 0.94,
        };
        let frame = lmu_frame(&t, None);
        let tyres = frame.tyres.expect("one wheel is enough");
        assert!((tyres[0].temp_c - 90.0).abs() < 1e-3);
        assert_eq!((tyres[0].pressure_kpa, tyres[0].left), (175.0, 0.94));
        assert_eq!(tyres[0].brake_c, 412.5, "the brake temperature is already Celsius");
        assert!(tyres[1].brake_c.is_nan(), "0 is the header's nothing");
        assert!(!tyres[1].known(), "an empty wheel says nothing");
        // A brake temperature alone is something to show.
        let mut only_brakes = PlayerTelemetry::default();
        only_brakes.wheels[2].brake_temp_c = 350.0;
        let tyres = lmu_frame(&only_brakes, None).tyres.expect("a brake temperature is enough");
        assert!(tyres[2].known() && tyres[2].temp_c.is_nan());
        assert!(lmu_frame(&PlayerTelemetry::default(), None).tyres.is_none());
    }

    #[test]
    fn reads_the_best_lap_between_two_points_and_not_past_its_ends() {
        let profile = vec![(0.0, 0.0), (100.0, 4.0), (200.0, 10.0)];
        assert_eq!(time_at(&profile, 50.0), Some(2.0));
        assert_eq!(time_at(&profile, 150.0), Some(7.0));
        assert_eq!(time_at(&profile, 0.0), Some(0.0));
        assert_eq!(time_at(&profile, 200.0), Some(10.0));
        assert_eq!(time_at(&profile, 250.0), None);
        assert_eq!(time_at(&Vec::new(), 1.0), None);
    }
}
