//! The rivals layer: every car of the session, in one shape for every game (`Frame::field`).
//!
//! A reader that has a per-car array turns it into `Car`s in the units below and hands them to `publish`, which
//! completes what the game did not give (class positions, gaps) in this one place and sorts the cars by position. A
//! reader never computes a class position or a gap itself. The widgets (`relative`, `standings`, `gaps`) read a `Field`
//! from `Live::field`.
//!
//! | `Car` field | Unit and range | Meaning |
//! |-------------|----------------|---------|
//! | `slot` | whole number | the car's index in the game's own array (stable for the session) |
//! | `name` | text | the driver's name as the game gives it |
//! | `class` | text | the class as the game names it; `None` when the game has no classes (or gives only a number it cannot name: then the number) |
//! | `position`, `class_position` | 1.. | the place overall and in the class, 1 is the leader |
//! | `laps_done` | 0.. | laps completed |
//! | `lap_share` | 0 to 1 | how far round the current lap the car is (0 is the line) |
//! | `last_lap_s`, `best_lap_s` | seconds, above 0 | the car's last and best lap |
//! | `gap_ahead_s`, `gap_leader_s` | seconds, 0 or more | the time to the car one place ahead, and to the leader (by the game, else estimated by `complete`) |
//! | `world` | metres, the convention of `Frame::x/y/z` | the car's world position |
//!
//! Readers publish a field at most every `FieldPace::EVERY_S` (a few Hz is all a table needs; the player's own car is read
//! at the full rate).
// The widgets that read these (part C of phase 4) are not built yet, and some fields are filled by only some games.
#![allow(dead_code)]

use std::sync::Arc;

/// One car of the session.
#[derive(Clone, Debug, PartialEq)]
pub struct Car {
    pub slot: u16,
    pub name: String,
    pub class: Option<String>,
    pub position: Option<u16>,
    pub class_position: Option<u16>,
    pub laps_done: Option<i32>,
    /// 0..1 of the current lap.
    pub lap_share: Option<f32>,
    pub in_pits: bool,
    pub last_lap_s: Option<f64>,
    pub best_lap_s: Option<f64>,
    /// To the car one place ahead.
    pub gap_ahead_s: Option<f64>,
    pub gap_leader_s: Option<f64>,
    pub world: Option<[f32; 3]>,
    pub is_player: bool,
}

impl Car {
    /// A car that has a slot and a name and nothing else known.
    pub fn named(slot: u16, name: &str) -> Car {
        Car {
            slot,
            name: name.to_owned(),
            class: None,
            position: None,
            class_position: None,
            laps_done: None,
            lap_share: None,
            in_pits: false,
            last_lap_s: None,
            best_lap_s: None,
            gap_ahead_s: None,
            gap_leader_s: None,
            world: None,
            is_player: false,
        }
    }

    /// How far the car has raced, in laps: the laps done plus the share of the lap. `None` when either is not known.
    fn distance(&self) -> Option<f64> {
        Some(f64::from(self.laps_done?) + f64::from(self.lap_share?))
    }
}

/// Every car of the session at one moment.
#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    pub cars: Vec<Car>,
    /// The game clock (`Frame::clock_s`) when the cars were read.
    pub at_s: f64,
}

impl Field {
    /// The player's own car.
    pub fn player(&self) -> Option<&Car> {
        self.cars.iter().find(|c| c.is_player)
    }
}

/// Decides when a reader publishes a field: at most every `EVERY_S` of the clock it reads frames by.
#[derive(Debug, Default)]
pub struct FieldPace {
    last: Option<f64>,
}

impl FieldPace {
    /// The shortest time between two published fields, in seconds.
    pub const EVERY_S: f64 = 0.2;

    /// True when a field should be read at `clock_s` (and remembers it). A clock that went back (a restart, a new
    /// session) is due at once.
    pub fn due(&mut self, clock_s: f64) -> bool {
        let due = self.last.is_none_or(|last| clock_s < last || clock_s - last >= Self::EVERY_S);
        if due {
            self.last = Some(clock_s);
        }
        due
    }
}

/// A distance round the lap in metres and the lap's length as a share of the lap, 0 to 1. `None` for no known length or
/// a distance that is not a number or is far outside the lap (a little over the line, the length being rounded, is
/// pulled to the end).
pub fn lap_share(dist_m: f64, length_m: f64) -> Option<f32> {
    if !(dist_m.is_finite() && length_m.is_finite() && length_m > 1.0) {
        return None;
    }
    let share = dist_m / length_m;
    (-0.05..=1.05).contains(&share).then(|| share.clamp(0.0, 1.0) as f32)
}

/// Completes a field the reader has filled with what its game gives and publishes it: see `complete`.
pub fn publish(cars: Vec<Car>, at_s: f64, track_length_m: Option<f64>) -> Arc<Field> {
    let mut field = Field { cars, at_s };
    complete(&mut field, track_length_m);
    Arc::new(field)
}

/// The middle of the best laps known in the field, for a car with no lap time of its own.
fn median_best(field: &Field) -> Option<f64> {
    let mut bests: Vec<f64> = field
        .cars
        .iter()
        .filter_map(|c| c.best_lap_s)
        .filter(|b| b.is_finite() && *b > 0.0)
        .collect();
    bests.sort_by(f64::total_cmp);
    bests.get(bests.len() / 2).copied()
}

/// How long a lap of this car takes, for turning a distance into a time: its best, else its last, else the field's
/// median best.
fn reference_lap(car: &Car, median: Option<f64>) -> Option<f64> {
    [car.best_lap_s, car.last_lap_s, median]
        .into_iter()
        .flatten()
        .find(|t| t.is_finite() && *t > 0.0)
}

/// Fills in what a game did not give, in one place for every reader.
///
/// * The cars are sorted by position (a car with no position last; cars of equal position keep their order).
/// * A car with a class and a position and no class position gets the place among the cars of its class; a car with no
///   class gets none.
/// * When no car has a gap (the game gives none), the gaps are estimated from how far each car has raced (laps done
///   plus the share of the lap): the difference to the car ahead, and to the leader, times a reference lap (the car's
///   best, else its last, else the field's median best). Never negative; `None` when it cannot be told. The leader's
///   gap to the leader is 0.
///
/// `_track_length_m` is kept for the readers' common call; a lap share is already a fraction, so nothing here needs it yet.
pub fn complete(field: &mut Field, _track_length_m: Option<f64>) {
    field.cars.sort_by_key(|c| c.position.unwrap_or(u16::MAX));
    class_positions(field);
    if field.cars.iter().all(|c| c.gap_ahead_s.is_none() && c.gap_leader_s.is_none()) {
        estimate_gaps(field);
    } else if field.cars.iter().all(|c| c.gap_leader_s.is_none()) {
        leader_gaps_from_ahead(field);
    }
}

/// A game that gives only the gap to the car ahead (RaceRoom): the gap to the leader is their sum down the order, while
/// every link is known; one missing link leaves every car behind it without one.
fn leader_gaps_from_ahead(field: &mut Field) {
    let mut sum = Some(0.0);
    for car in field.cars.iter_mut().skip(1) {
        if car.position.is_none() {
            break;
        }
        sum = sum.zip(car.gap_ahead_s).map(|(total, gap)| total + gap);
        car.gap_leader_s = sum;
    }
}

fn class_positions(field: &mut Field) {
    let places: Vec<(Option<String>, Option<u16>)> = field.cars.iter().map(|c| (c.class.clone(), c.position)).collect();
    for car in field.cars.iter_mut().filter(|c| c.class_position.is_none()) {
        let (Some(class), Some(position)) = (&car.class, car.position) else {
            continue;
        };
        let ahead = places
            .iter()
            .filter(|(other, place)| other.as_ref() == Some(class) && place.is_some_and(|p| p < position))
            .count();
        car.class_position = u16::try_from(ahead + 1).ok();
    }
}

fn estimate_gaps(field: &mut Field) {
    let median = median_best(field);
    // The cars are sorted by position: the first one with a position and a distance is the leader, and the car "ahead" of
    // each is the nearest one before it in the order that has a distance.
    let leader = field.cars.iter().find(|c| c.position.is_some()).and_then(Car::distance);
    let mut ahead: Option<f64> = None;
    for car in field.cars.iter_mut() {
        let (Some(_), Some(here)) = (car.position, car.distance()) else {
            continue;
        };
        let reference = reference_lap(car, median);
        let seconds = |from: Option<f64>| {
            let (from, reference) = (from?, reference?);
            Some(((from - here) * reference).max(0.0))
        };
        car.gap_leader_s = seconds(leader);
        car.gap_ahead_s = seconds(ahead);
        ahead = Some(here);
    }
}

/// The cars nearest to the player on the track, with the time to each in seconds (positive: ahead of the player on the
/// track, negative: behind), the farthest ahead first, the player at 0 in the middle. At most `ahead` cars ahead and `behind`
/// cars behind. The distance round the lap is the difference of the lap shares, wrapped to half a lap each way, turned into
/// seconds with the player's reference lap (its best, else its last, else the field's median best). A car with no lap share is left
/// out; with no player, no share for it or no lap time to count by, the list is empty.
pub fn relative(field: &Field, ahead: usize, behind: usize) -> Vec<(&Car, f64)> {
    let Some(player) = field.player() else {
        return Vec::new();
    };
    let (Some(mine), Some(lap)) = (player.lap_share, reference_lap(player, median_best(field))) else {
        return Vec::new();
    };
    let mut others: Vec<(&Car, f64)> = field
        .cars
        .iter()
        .filter(|c| !c.is_player)
        .filter_map(|c| {
            let diff = f64::from(c.lap_share?) - f64::from(mine);
            let wrapped = diff - diff.round();
            Some((c, wrapped * lap))
        })
        .collect();
    others.sort_by(|a, b| a.1.total_cmp(&b.1));
    // Ascending seconds: the ones behind first, then the ones ahead.
    let split = others.partition_point(|(_, s)| *s < 0.0);
    let (back, front) = others.split_at(split);
    let mut out: Vec<(&Car, f64)> = front.iter().take(ahead).rev().copied().collect();
    out.push((player, 0.0));
    out.extend(back.iter().rev().take(behind).copied());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gap_to_the_leader_adds_up_the_gaps_ahead() {
        let mut cars = vec![
            car(0, "A", 1, None),
            car(1, "B", 2, None),
            car(2, "C", 3, None),
            car(3, "D", 4, None),
        ];
        cars[1].gap_ahead_s = Some(1.5);
        cars[2].gap_ahead_s = Some(0.25);
        let mut field = Field { cars, at_s: 0.0 };
        complete(&mut field, None);
        let leader: Vec<Option<f64>> = field.cars.iter().map(|c| c.gap_leader_s).collect();
        assert_eq!(leader, vec![None, Some(1.5), Some(1.75), None]);
    }

    fn car(slot: u16, name: &str, position: u16, class: Option<&str>) -> Car {
        Car {
            position: Some(position),
            class: class.map(str::to_owned),
            ..Car::named(slot, name)
        }
    }

    fn raced(mut car: Car, laps: i32, share: f32, best: f64) -> Car {
        car.laps_done = Some(laps);
        car.lap_share = Some(share);
        car.best_lap_s = Some(best);
        car
    }

    fn field(cars: Vec<Car>) -> Field {
        Field { cars, at_s: 10.0 }
    }

    #[test]
    fn the_pace_publishes_at_most_every_200_ms_and_a_clock_that_goes_back_is_due() {
        let mut pace = FieldPace::default();
        assert!(pace.due(100.0), "the first one is due");
        assert!(!pace.due(100.1));
        assert!(!pace.due(100.19));
        assert!(pace.due(100.2));
        assert!(!pace.due(100.3));
        assert!(pace.due(5.0), "a restart sent the clock back");
    }

    #[test]
    fn a_lap_share_is_a_fraction_and_a_wild_distance_is_not_given() {
        assert_eq!(lap_share(2500.0, 5000.0), Some(0.5));
        assert_eq!(lap_share(5010.0, 5000.0), Some(1.0), "a hair over the line is pulled to the end");
        assert_eq!(lap_share(-1.0, 5000.0), Some(0.0));
        assert_eq!(lap_share(9000.0, 5000.0), None);
        assert_eq!(lap_share(100.0, 0.0), None);
        assert_eq!(lap_share(f64::NAN, 5000.0), None);
    }

    #[test]
    fn the_cars_are_sorted_by_position_unknown_last_and_stable() {
        let mut f = field(vec![
            Car::named(0, "no place a"),
            car(1, "third", 3, None),
            car(2, "first", 1, None),
            Car::named(3, "no place b"),
            car(4, "second", 2, None),
        ]);
        complete(&mut f, None);
        let names: Vec<&str> = f.cars.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["first", "second", "third", "no place a", "no place b"]);
    }

    #[test]
    fn class_positions_count_the_cars_of_the_same_class_ahead() {
        // Overall: 1 GT3 a, 2 LMP b, 3 GT3 c, 4 LMP d, 5 no class, 6 GT3 e.
        let mut f = field(vec![
            car(0, "a", 1, Some("GT3")),
            car(1, "b", 2, Some("LMP")),
            car(2, "c", 3, Some("GT3")),
            car(3, "d", 4, Some("LMP")),
            car(4, "none", 5, None),
            car(5, "e", 6, Some("GT3")),
        ]);
        complete(&mut f, None);
        let got: Vec<Option<u16>> = f.cars.iter().map(|c| c.class_position).collect();
        assert_eq!(got, [Some(1), Some(1), Some(2), Some(2), None, Some(3)]);
    }

    #[test]
    fn a_class_position_the_game_gave_is_kept() {
        let mut f = field(vec![
            Car {
                class_position: Some(9),
                ..car(0, "a", 1, Some("GT3"))
            },
            car(1, "b", 2, Some("GT3")),
        ]);
        complete(&mut f, None);
        assert_eq!((f.cars[0].class_position, f.cars[1].class_position), (Some(9), Some(2)));
    }

    #[test]
    fn gaps_are_estimated_from_the_race_distance_and_the_cars_own_lap() {
        // Lap of 100 s. The leader is at 5.50 laps, the second 5.40 (10 s back), the third 5.00 (50 s back, 40 s behind the second).
        let mut f = field(vec![
            raced(car(0, "leader", 1, None), 5, 0.5, 100.0),
            raced(car(1, "second", 2, None), 5, 0.4, 100.0),
            raced(car(2, "third", 3, None), 5, 0.0, 100.0),
        ]);
        complete(&mut f, Some(5000.0));
        let close = |a: Option<f64>, b: f64| a.is_some_and(|a| (a - b).abs() < 1e-3);
        assert_eq!(f.cars[0].gap_ahead_s, None);
        assert!(close(f.cars[0].gap_leader_s, 0.0));
        assert!(close(f.cars[1].gap_ahead_s, 10.0) && close(f.cars[1].gap_leader_s, 10.0));
        assert!(close(f.cars[2].gap_ahead_s, 40.0) && close(f.cars[2].gap_leader_s, 50.0));
    }

    #[test]
    fn a_lapped_car_is_a_whole_lap_behind_and_a_car_in_the_pits_still_has_a_gap() {
        let mut f = field(vec![
            raced(car(0, "leader", 1, None), 7, 0.25, 90.0),
            Car {
                in_pits: true,
                ..raced(car(1, "pitting", 2, None), 7, 0.0, 90.0)
            },
            raced(car(2, "lapped", 3, None), 6, 0.25, 90.0),
        ]);
        complete(&mut f, None);
        let close = |a: Option<f64>, b: f64| a.is_some_and(|a| (a - b).abs() < 1e-3);
        assert!(close(f.cars[1].gap_leader_s, 22.5));
        assert!(close(f.cars[2].gap_ahead_s, 67.5), "{:?}", f.cars[2].gap_ahead_s);
        assert!(close(f.cars[2].gap_leader_s, 90.0));
    }

    #[test]
    fn a_car_without_a_lap_of_its_own_takes_its_last_lap_and_then_the_median_best() {
        let mut slow = raced(car(1, "slow", 2, None), 3, 0.0, 100.0);
        slow.best_lap_s = None;
        slow.last_lap_s = Some(80.0);
        let mut unknown = raced(car(2, "unknown", 3, None), 2, 0.0, 100.0);
        unknown.best_lap_s = None;
        let mut f = field(vec![raced(car(0, "leader", 1, None), 4, 0.0, 100.0), slow, unknown]);
        complete(&mut f, None);
        let close = |a: Option<f64>, b: f64| a.is_some_and(|a| (a - b).abs() < 1e-3);
        assert!(close(f.cars[1].gap_leader_s, 80.0), "its last lap");
        assert!(close(f.cars[2].gap_leader_s, 200.0), "the median best, 100 s");
    }

    #[test]
    fn a_gap_that_cannot_be_told_is_none_and_never_negative() {
        let mut f = field(vec![
            raced(car(0, "leader", 1, None), 3, 0.5, 100.0),
            Car::named(1, "nothing known"),
            // Ahead of the leader on distance (the order and the distance disagree for a moment): zero, not negative.
            raced(car(2, "ahead", 2, None), 3, 0.9, 100.0),
        ]);
        f.cars[1].position = Some(3);
        complete(&mut f, None);
        // Sorted by position: leader, ahead, nothing known.
        assert_eq!(f.cars[2].gap_leader_s, None, "no distance known");
        assert_eq!(f.cars[1].gap_leader_s, Some(0.0), "never negative");
        assert_eq!(f.cars[1].gap_ahead_s, Some(0.0));
        let mut no_lap = field(vec![
            Car {
                laps_done: Some(1),
                lap_share: Some(0.5),
                ..car(0, "a", 1, None)
            },
            Car {
                laps_done: Some(1),
                lap_share: Some(0.2),
                ..car(1, "b", 2, None)
            },
        ]);
        complete(&mut no_lap, None);
        assert_eq!(no_lap.cars[1].gap_leader_s, None, "no lap time to count by");
    }

    #[test]
    fn gaps_the_game_gave_are_left_alone() {
        let mut f = field(vec![
            raced(car(0, "leader", 1, None), 3, 0.5, 100.0),
            Car {
                gap_ahead_s: Some(1.5),
                ..raced(car(1, "second", 2, None), 3, 0.0, 100.0)
            },
        ]);
        complete(&mut f, None);
        // Kept as given; the gap to the leader, which the game did not give, is the gaps ahead added up.
        assert_eq!((f.cars[1].gap_ahead_s, f.cars[1].gap_leader_s), (Some(1.5), Some(1.5)));
        assert_eq!(f.cars[0].gap_leader_s, None);
    }

    fn on_track(slot: u16, share: f32, player: bool) -> Car {
        Car {
            is_player: player,
            ..raced(car(slot, &format!("car {slot}"), slot + 1, None), 2, share, 100.0)
        }
    }

    #[test]
    fn the_relative_list_has_the_cars_nearest_on_track_with_the_player_at_zero() {
        let f = field(vec![
            on_track(0, 0.50, true),
            on_track(1, 0.52, false), // 2 s ahead
            on_track(2, 0.60, false), // 10 s ahead
            on_track(3, 0.47, false), // 3 s behind
            on_track(4, 0.20, false), // 30 s behind
        ]);
        let got: Vec<(u16, i64)> = relative(&f, 2, 1).iter().map(|(c, s)| (c.slot, s.round() as i64)).collect();
        assert_eq!(got, [(2, 10), (1, 2), (0, 0), (3, -3)]);
        let all: Vec<u16> = relative(&f, 9, 9).iter().map(|(c, _)| c.slot).collect();
        assert_eq!(all, [2, 1, 0, 3, 4]);
    }

    #[test]
    fn the_relative_list_wraps_at_the_line() {
        // The player has just passed the line; a car at 0.98 is 2 s behind, one at 0.03 is 2 s ahead... and the other way.
        let f = field(vec![on_track(0, 0.01, true), on_track(1, 0.98, false), on_track(2, 0.04, false)]);
        let got: Vec<(u16, i64)> = relative(&f, 3, 3).iter().map(|(c, s)| (c.slot, s.round() as i64)).collect();
        assert_eq!(got, [(2, 3), (0, 0), (1, -3)]);
        let f = field(vec![on_track(0, 0.99, true), on_track(1, 0.02, false), on_track(2, 0.96, false)]);
        let got: Vec<(u16, i64)> = relative(&f, 3, 3).iter().map(|(c, s)| (c.slot, s.round() as i64)).collect();
        assert_eq!(got, [(1, 3), (0, 0), (2, -3)]);
    }

    #[test]
    fn the_relative_list_is_empty_without_a_player_a_share_or_a_lap_time() {
        let mut f = field(vec![on_track(0, 0.5, false), on_track(1, 0.6, false)]);
        assert!(relative(&f, 2, 2).is_empty(), "no player");
        f.cars[0].is_player = true;
        assert_eq!(relative(&f, 2, 2).len(), 2);
        f.cars[0].lap_share = None;
        assert!(relative(&f, 2, 2).is_empty(), "the player has no share");
        f.cars[0].lap_share = Some(0.5);
        f.cars[0].best_lap_s = None;
        for c in &mut f.cars {
            c.best_lap_s = None;
        }
        assert!(relative(&f, 2, 2).is_empty(), "no lap time to count by");
    }

    #[test]
    fn a_car_with_no_share_is_left_out_of_the_relative_list() {
        let mut f = field(vec![on_track(0, 0.5, true), on_track(1, 0.6, false), on_track(2, 0.4, false)]);
        f.cars[2].lap_share = None;
        let got: Vec<u16> = relative(&f, 3, 3).iter().map(|(c, _)| c.slot).collect();
        assert_eq!(got, [1, 0]);
    }

    #[test]
    fn publish_completes_and_sorts() {
        let field = publish(vec![car(1, "b", 2, Some("X")), car(0, "a", 1, Some("X"))], 3.0, None);
        assert_eq!((field.cars[0].slot, field.cars[1].class_position, field.at_s), (0, Some(2), 3.0));
        assert!(field.player().is_none());
    }
}
