//! The one place that says what a believable raw value is, for every reader (the games in `games/` and Le Mans
//! Ultimate in `lmu/`): one tolerance per kind of value, so two games never judge the same pedal or tyre differently.
//!
//! Every function here answers `NaN` (or `None`) for "the game did not give it": a value that is not a number, that
//! is far outside what the thing can be, or that is the game's own "not available" marker. A value a little outside
//! its range is a rounding or a calibration, and is pulled into it (a pedal, the wheel); a value far outside is a
//! different unit or a moved layout, and is dropped, never pinned to an end.
//!
//! The ranges, in one table (the unit is the one of the `Frame`):
//!
//! | what | accepted | out of range | in range |
//! |------|----------|--------------|----------|
//! | pedal (`pedal`) | -0.5 ..= 1.5 | not given | clamped to 0..1 |
//! | steering (`steer`) | -1.5 ..= 1.5 | not given | clamped to -1..1 |
//! | lap and sector times (`seconds`, `seconds_ms`) | 0 (or above 0) ..= 86 400 s | not given | as they are |
//! | tyre temperature (`tyre_c`) | -50 ..= 400 C, never exactly 0 | not given | as it is |
//! | brake temperature (`brake_c`) | above 0 ..= 2000 C | not given | as it is |
//! | coolant temperature (`water_c`) | -50 ..= 400 C, never exactly 0 | not given | as it is |
//! | oil temperature (`oil_c`) | -50 ..= 400 C, never exactly 0 | not given | as it is |
//! | tyre pressure (`pressure_kpa`) | above 0 ..= 1000 kPa | not given | as it is |
//! | gear (`gear`) | -1 ..= 30 | not given | as it is |
//! | world position (`position`) | -1e7 ..= 1e7 m | not given | as it is |
//!
//! "Never exactly 0" for the temperatures is the memory of a game that has not written yet (every temperature header
//! that has an "unset" says 0 or -1); a real reading is never exactly 0.0. A packet that is never zeroed (Forza's)
//! uses `tyre_reading_c`, where 0 C is a reading.

use std::time::Duration;
use std::time::Instant;

/// A float that is a number; anything else is "not given".
pub fn finite(v: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        f32::NAN
    }
}

/// A float inside `lo..=hi`; anything else (not a number, infinite, outside) is "not given".
pub fn within(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_finite() && (lo..=hi).contains(&v) {
        v
    } else {
        f32::NAN
    }
}

/// How far outside its range a pedal or the wheel may read and still be believed (and pulled in): a calibration that
/// reads 1.02, a pedal at -0.01. The games' own "not available" is -1.0, which is further out than this.
pub const SLACK: f32 = 0.5;

/// A pedal, 0..1, 1 = pressed. A hair outside the range is pulled into it, far outside (or not a number, or the
/// game's -1.0 for "not available") is "not given".
pub fn pedal(v: f32) -> f32 {
    if v.is_finite() && (-SLACK..=1.0 + SLACK).contains(&v) {
        v.clamp(0.0, 1.0)
    } else {
        f32::NAN
    }
}

/// The wheel, -1..1, +1 = full right. A hair outside the range is pulled into it, far outside (degrees, say) is "not
/// given".
pub fn steer(v: f32) -> f32 {
    if v.is_finite() && v.abs() <= 1.0 + SLACK {
        v.clamp(-1.0, 1.0)
    } else {
        f32::NAN
    }
}

/// The longest time a lap or a sector can be, in seconds: a day. Longer is garbage or a "none yet" marker.
pub const MAX_SECONDS: f64 = 86_400.0;

/// A time the game gave in seconds. `allow_zero`: whether 0 is a time (the lap in progress at its very start) or "no
/// time yet" (the last lap before there is one).
pub fn seconds(v: f32, allow_zero: bool) -> Option<f64> {
    let v = f64::from(v);
    (v.is_finite() && v <= MAX_SECONDS && if allow_zero { v >= 0.0 } else { v > 0.0 }).then_some(v)
}

/// A time the game gave in milliseconds, as seconds, with the same cap as `seconds`. Negative is "none", and so is
/// a huge value such as `i32::MAX`.
pub fn seconds_ms(ms: impl Into<i64>, allow_zero: bool) -> Option<f64> {
    let ms = ms.into();
    let lo = i64::from(!allow_zero);
    (lo..=(MAX_SECONDS as i64) * 1000).contains(&ms).then(|| ms as f64 / 1000.0)
}

fn temperature(v: f32, lo: f32, hi: f32) -> f32 {
    if v != 0.0 {
        within(v, lo, hi)
    } else {
        f32::NAN
    }
}

/// A tyre's temperature in Celsius, for a game whose own "not given" was already taken out (a UDP packet that is
/// not zeroed): the range only, so a real 0 C is a reading.
pub fn tyre_reading_c(v: f32) -> f32 {
    within(v, -50.0, 400.0)
}

/// A tyre's temperature in Celsius, from a memory that holds 0 until the game writes it: exactly 0 is "not given".
pub fn tyre_c(v: f32) -> f32 {
    temperature(v, -50.0, 400.0)
}

/// A brake disc's temperature in Celsius (carbon brakes run past 500). Above 0 only: a disc is never colder than
/// the day, and every game that gives the temperature also writes 0 or -1 for "none".
pub fn brake_c(v: f32) -> f32 {
    if v > 0.0 {
        within(v, 0.0, 2000.0)
    } else {
        f32::NAN
    }
}

/// The coolant's temperature in Celsius.
pub fn water_c(v: f32) -> f32 {
    temperature(v, -50.0, 400.0)
}

/// The engine oil's temperature in Celsius.
pub fn oil_c(v: f32) -> f32 {
    temperature(v, -50.0, 400.0)
}

/// The mean temperature across a tyre's tread, when the inner, the middle and the outer reading are all believable
/// (`tyre_c`); else "not given" (the caller falls back to the core).
pub fn tread_c(inner: f32, middle: f32, outer: f32) -> f32 {
    let (i, m, o) = (tyre_c(inner), tyre_c(middle), tyre_c(outer));
    (i + m + o) / 3.0
}

/// A tyre's pressure in kPa (above 0: an empty memory says 0).
pub fn pressure_kpa(v: f32) -> f32 {
    if v > 0.0 {
        within(v, 0.0, 1000.0)
    } else {
        f32::NAN
    }
}

/// Pounds per square inch as kPa.
pub const KPA_PER_PSI: f32 = 6.894_757;

/// A gear: -1 reverse, 0 neutral, 1.. forward. The game's raw numbering is each reader's to turn into this.
pub fn gear(g: i32) -> f32 {
    if (-1..=30).contains(&g) {
        g as f32
    } else {
        f32::NAN
    }
}

/// One world coordinate in metres.
pub fn position(v: f32) -> f32 {
    within(v, -1.0e7, 1.0e7)
}

/// Waits `d` without giving the processor away (a sleep is a whole timer tick on Windows, far longer than a struct
/// takes to write).
pub fn spin(d: Duration) {
    let until = Instant::now() + d;
    while Instant::now() < until {
        std::hint::spin_loop();
    }
}

/// Two copies, `gap` apart, that are the same: nothing was written between them. A copy that differs from its
/// successor is thrown away and the pair is tried again, up to `attempts` times.
pub fn stable_copy(attempts: usize, mut read: impl FnMut() -> Option<Vec<u8>>, mut gap: impl FnMut()) -> Option<Vec<u8>> {
    for _ in 0..attempts {
        let first = read()?;
        gap();
        let second = read()?;
        if first == second {
            return Some(first);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn same(a: f32, b: f32) -> bool {
        a == b || (a.is_nan() && b.is_nan())
    }

    #[test]
    fn a_pedal_is_pulled_in_when_a_hair_out_and_dropped_when_far_out() {
        for (raw, want) in [
            (0.0, 0.0),
            (0.4, 0.4),
            (1.0, 1.0),
            (1.02, 1.0),
            (-0.01, 0.0),
            (1.5, 1.0),
            (-0.5, 0.0),
            (1.51, f32::NAN),
            (-0.51, f32::NAN),
            (-1.0, f32::NAN),
            (5.0, f32::NAN),
            (f32::NAN, f32::NAN),
            (f32::INFINITY, f32::NAN),
        ] {
            assert!(same(pedal(raw), want), "pedal({raw}) = {} (want {want})", pedal(raw));
        }
    }

    #[test]
    fn the_wheel_has_the_same_tolerance_as_a_pedal() {
        for (raw, want) in [
            (0.0, 0.0),
            (-1.0, -1.0),
            (1.0, 1.0),
            (1.2, 1.0),
            (-1.5, -1.0),
            (1.6, f32::NAN),
            (-90.0, f32::NAN),
            (f32::NAN, f32::NAN),
        ] {
            assert!(same(steer(raw), want), "steer({raw}) = {} (want {want})", steer(raw));
        }
    }

    #[test]
    fn seconds_and_milliseconds_agree_on_one_cap_and_on_zero() {
        assert_eq!(seconds(83.5, false), Some(83.5));
        assert_eq!(seconds(0.0, true), Some(0.0));
        assert_eq!(seconds(0.0, false), None);
        assert_eq!(seconds(-1.0, true), None, "-1 is the games' 'not available'");
        assert_eq!(seconds(86_400.0, false), Some(86_400.0));
        assert_eq!(seconds(86_401.0, false), None);
        assert_eq!(seconds(f32::NAN, true), None);
        assert_eq!(seconds_ms(83_500, false), Some(83.5));
        assert_eq!(seconds_ms(0u32, true), Some(0.0));
        assert_eq!(seconds_ms(0, false), None);
        assert_eq!(seconds_ms(-1, true), None);
        assert_eq!(seconds_ms(86_400_000, false), Some(86_400.0));
        assert_eq!(seconds_ms(86_400_001, false), None);
        assert_eq!(seconds_ms(i32::MAX, true), None, "a 'none yet' marker is not a time");
        assert_eq!(seconds_ms(u32::MAX, true), None);
    }

    #[test]
    fn temperatures_have_a_range_per_kind_and_zero_is_never_given() {
        assert!(same(tyre_c(85.0), 85.0));
        assert!(same(tyre_c(-10.0), -10.0));
        assert!(tyre_c(0.0).is_nan());
        assert!(tyre_c(401.0).is_nan());
        assert!(tyre_c(-51.0).is_nan());
        assert!(tyre_c(f32::NAN).is_nan());
        assert!(same(brake_c(1500.0), 1500.0), "carbon brakes run hot");
        assert!(brake_c(2001.0).is_nan());
        assert!(brake_c(0.0).is_nan() && brake_c(-1.0).is_nan() && brake_c(f32::NAN).is_nan());
        assert!(same(tyre_reading_c(0.0), 0.0), "a packet that is never zeroed: 0 C is a reading");
        assert!(tyre_reading_c(401.0).is_nan());
        assert!(same(water_c(95.0), 95.0));
        assert!(water_c(401.0).is_nan());
        assert!(water_c(0.0).is_nan());
        assert!(same(oil_c(120.0), 120.0));
        assert!(oil_c(0.0).is_nan());
        assert!(same(tread_c(80.0, 90.0, 100.0), 90.0));
        assert!(tread_c(80.0, 0.0, 100.0).is_nan(), "all three points or none");
        assert!(tread_c(80.0, 90.0, f32::NAN).is_nan());
    }

    #[test]
    fn pressure_gear_and_position_have_one_range_each() {
        assert!(same(pressure_kpa(180.0), 180.0));
        assert!(pressure_kpa(0.0).is_nan());
        assert!(pressure_kpa(-1.0).is_nan());
        assert!(pressure_kpa(1000.5).is_nan());
        assert!(pressure_kpa(f32::NAN).is_nan());
        assert_eq!((gear(-1), gear(0), gear(8), gear(30)), (-1.0, 0.0, 8.0, 30.0));
        assert!(gear(-2).is_nan() && gear(31).is_nan());
        assert!(same(position(123_456.0), 123_456.0));
        assert!(same(position(-9.9e6), -9.9e6));
        assert!(position(1.1e7).is_nan() && position(f32::INFINITY).is_nan());
    }

    #[test]
    fn within_and_finite_keep_their_old_meaning() {
        assert!(same(within(5.0, 0.0, 10.0), 5.0) && within(11.0, 0.0, 10.0).is_nan() && within(f32::NAN, 0.0, 1.0).is_nan());
        assert!(same(finite(3.0), 3.0) && finite(f32::INFINITY).is_nan());
    }

    #[test]
    fn a_copy_is_stable_only_when_two_copies_agree() {
        let mut calls = 0;
        let mut gaps = 0;
        let got = stable_copy(
            4,
            || {
                calls += 1;
                Some(vec![calls as u8 / 2 + 1])
            },
            || gaps += 1,
        );
        // Copies 1, 2 differ ([1] against [2]); copies 3, 4 differ ([2] against [3]); no pair agrees in four tries.
        assert_eq!(got, None);
        assert_eq!(gaps, 4, "the copies are taken apart, once per pair");
        assert_eq!(stable_copy(4, || Some(vec![7]), || {}), Some(vec![7]));
        assert_eq!(stable_copy(4, || None, || {}), None);
    }
}
