//! Automatic sanity checks on a finished lap, run before it is saved.
//!
//! Three real bugs of the Assetto Corsa EVO reader (an inverted clutch, a mirrored map, a lap clock that repeated for
//! 38% of the samples) were found only because the owner drove and a person looked at the file. These checks look
//! for that kind of defect in every lap, by themselves. Each one is a pure function of the lap; a finding has a stable
//! id (the ids go into the lap header's `checks` and, on the server, into the Problems page) and a short English detail
//! for the log. A finding never stops a lap from being saved: it says that the reader that produced it needs a look.
//!
//! Convention used by the map check: `x` is east, `z` is north, `y` is up; steering `+1` is right. Seen from above a
//! right turn is clockwise, so the cross product of two successive segments of the path is negative in a right turn.

use crate::lapfile::{Lap, Recorder};

/// One thing the checks did not like about a lap.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    /// Stable id: lower case letters, digits and `_` (it is a channel-like id in the header).
    pub id: &'static str,
    /// What was found, with the numbers, in a short English sentence.
    pub detail: String,
}

/// Every id `check` can report, in the order it reports them.
#[cfg(test)]
pub const IDS: &[&str] = &[
    "t_repeats",
    "t_gap",
    "dist_vs_track",
    "dist_backwards",
    "clutch_stuck",
    "pedal_range",
    "steer_range",
    "speed_range",
    "position_jump",
    "map_mirrored",
    "nan_share",
    "sample_rate",
];

/// A time that does not increase is normal for a few samples (a duplicated frame); more than this share is not.
const T_REPEAT_SHARE: f64 = 0.01;
/// The longest gap between two samples, in seconds.
const T_GAP_S: f32 = 2.0;
/// How far the final distance may be from the track length.
const DIST_TOLERANCE: f64 = 0.03;
/// How far the distance may go back from one sample to the next, in metres.
const DIST_BACK_M: f32 = 5.0;
/// Speed bounds in m/s (540 km/h).
const SPEED_MAX: f32 = 150.0;
/// A jump of the position between two samples, in metres, at a speed below `JUMP_SPEED_MAX`.
const JUMP_M: f32 = 50.0;
const JUMP_SPEED_MAX: f32 = 100.0;
/// Lowest sample rate a lap is useful at.
const MIN_RATE_HZ: f64 = 20.0;
/// The share of NaN above which a channel is called empty.
const NAN_SHARE: f64 = 0.2;
/// Pedals and steering may be a little outside their range (float rounding) without being wrong.
const RANGE_SLACK: f32 = 1e-3;
/// How far the path must move between the points the map check compares, in metres.
const MIN_STEP_M: f64 = 3.0;
/// Correlation of steering with the turning of the path below which the map is called mirrored.
const MIRRORED_BELOW: f64 = -0.3;

fn column<'a>(lap: &'a Lap, id: &str) -> Option<&'a [f32]> {
    lap.channels.iter().find(|c| c.id == id).map(|c| c.values.as_slice())
}

fn percent(share: f64) -> String {
    format!("{:.0}%", share * 100.0)
}

/// Runs every check on a lap. Empty when the lap looks right.
pub fn check(lap: &Lap) -> Vec<Finding> {
    let mut out = Vec::new();
    let mut add = |id: &'static str, detail: String| out.push(Finding { id, detail });
    let t = column(lap, "t");
    let dist = column(lap, "dist");
    let speed = column(lap, "speed");

    if let Some(t) = t {
        if let Some(detail) = t_repeats(t) {
            add("t_repeats", detail);
        }
        if let Some(detail) = t_gap(t) {
            add("t_gap", detail);
        }
    }
    if let Some(dist) = dist {
        if let Some(detail) = dist_vs_track(lap, dist) {
            add("dist_vs_track", detail);
        }
        if let Some(detail) = dist_backwards(dist) {
            add("dist_backwards", detail);
        }
    }
    if let Some(detail) = clutch_stuck(column(lap, "clutch"), column(lap, "throttle"), speed) {
        add("clutch_stuck", detail);
    }
    if let Some(detail) = out_of_range(lap, &["throttle", "brake", "clutch"], 0.0, 1.0) {
        add("pedal_range", detail);
    }
    if let Some(detail) = out_of_range(lap, &["steer"], -1.0, 1.0) {
        add("steer_range", detail);
    }
    if let Some(speed) = speed {
        if let Some(detail) = speed_range(speed) {
            add("speed_range", detail);
        }
    }
    if let (Some(x), Some(z)) = (column(lap, "x"), column(lap, "z")) {
        if let Some(detail) = position_jump(x, z, speed) {
            add("position_jump", detail);
        }
        if let Some(steer) = column(lap, "steer") {
            if let Some(detail) = map_mirrored(steer, x, z) {
                add("map_mirrored", detail);
            }
        }
    }
    if let Some(detail) = nan_share(lap) {
        add("nan_share", detail);
    }
    if lap.sample_rate_hz < MIN_RATE_HZ {
        add(
            "sample_rate",
            format!("the sample rate is {:.1} Hz, below {MIN_RATE_HZ} Hz", lap.sample_rate_hz),
        );
    }
    out
}

fn t_repeats(t: &[f32]) -> Option<String> {
    let pairs = t.windows(2).filter(|w| !w[0].is_nan() && !w[1].is_nan()).count();
    let flat = t.windows(2).filter(|w| !w[0].is_nan() && !w[1].is_nan() && w[1] <= w[0]).count();
    if pairs == 0 {
        return None;
    }
    let share = flat as f64 / pairs as f64;
    (share > T_REPEAT_SHARE).then(|| {
        format!(
            "the time does not increase on {} of the samples ({flat} of {pairs})",
            percent(share)
        )
    })
}

fn t_gap(t: &[f32]) -> Option<String> {
    let worst = t
        .windows(2)
        .map(|w| w[1] - w[0])
        .filter(|step| !step.is_nan())
        .fold(f32::MIN, f32::max);
    (worst > T_GAP_S).then(|| format!("the time jumps by {worst:.1} s between two samples"))
}

fn last_finite(values: &[f32]) -> Option<f32> {
    values.iter().rev().copied().find(|v| v.is_finite())
}

fn dist_vs_track(lap: &Lap, dist: &[f32]) -> Option<String> {
    // A lap that starts or ends in the pit lane does not run the whole track.
    if lap.in_lap == Some(true) || lap.out_lap == Some(true) {
        return None;
    }
    let length = lap.track_length_m.filter(|l| *l > 0.0)?;
    let last = f64::from(last_finite(dist)?);
    let off = (last - length).abs() / length;
    (off > DIST_TOLERANCE).then(|| format!("the lap covers {last:.0} m on a track of {length:.0} m ({} off)", percent(off)))
}

fn dist_backwards(dist: &[f32]) -> Option<String> {
    let worst = dist
        .windows(2)
        .map(|w| w[0] - w[1])
        .filter(|back| !back.is_nan())
        .fold(f32::MIN, f32::max);
    (worst > DIST_BACK_M).then(|| format!("the distance goes back by {worst:.1} m between two samples"))
}

/// A clutch that stays down while the car is flat out at speed: the pedal reads the wrong way round.
fn clutch_stuck(clutch: Option<&[f32]>, throttle: Option<&[f32]>, speed: Option<&[f32]>) -> Option<String> {
    let (clutch, throttle, speed) = (clutch?, throttle?, speed?);
    let n = clutch.len().min(throttle.len()).min(speed.len());
    if n == 0 {
        return None;
    }
    let down = clutch[..n].iter().filter(|c| **c >= 0.95).count() as f64 / n as f64;
    let flat_out = (0..n).filter(|i| throttle[*i] >= 0.9 && speed[*i] > 30.0).count() as f64 / n as f64;
    (down > 0.9 && flat_out >= 0.05).then(|| {
        format!(
            "the clutch reads fully pressed on {} of the samples while the car is at full throttle at speed (the pedal is probably inverted)",
            percent(down)
        )
    })
}

fn out_of_range(lap: &Lap, ids: &[&str], low: f32, high: f32) -> Option<String> {
    let mut found = Vec::new();
    for id in ids {
        let Some(values) = column(lap, id) else { continue };
        let bad = values
            .iter()
            .filter(|v| **v < low - RANGE_SLACK || **v > high + RANGE_SLACK)
            .count();
        if bad > 0 {
            found.push(format!("{id} ({bad} samples)"));
        }
    }
    (!found.is_empty()).then(|| format!("outside {low} to {high}: {}", found.join(", ")))
}

fn speed_range(speed: &[f32]) -> Option<String> {
    let (low, high) = speed
        .iter()
        .filter(|v| !v.is_nan())
        .fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
    (low < 0.0 || high > SPEED_MAX)
        .then(|| format!("the speed goes from {low:.1} to {high:.1} m/s (it must stay within 0 to {SPEED_MAX} m/s)"))
}

fn position_jump(x: &[f32], z: &[f32], speed: Option<&[f32]>) -> Option<String> {
    let n = x.len().min(z.len());
    let mut worst = 0.0f32;
    for i in 1..n {
        let step = (x[i] - x[i - 1]).hypot(z[i] - z[i - 1]);
        if step.is_nan() || step <= JUMP_M {
            continue;
        }
        // Fast enough to really cover that much between two samples? Then it is not a jump.
        let fast = speed.and_then(|s| s.get(i)).is_some_and(|v| *v >= JUMP_SPEED_MAX);
        if !fast {
            worst = worst.max(step);
        }
    }
    (worst > 0.0).then(|| format!("the position jumps by {worst:.0} m between two samples"))
}

/// The correlation of the steering with the turning of the (x, z) path, in -1 to 1, or `None` without enough to judge.
/// Positive: steering right goes with a clockwise (right) turn, as it must. Not centred: a steady right-hand circle
/// (constant steering) counts as a perfect match.
pub fn steer_turn_correlation(steer: &[f32], x: &[f32], z: &[f32]) -> Option<f64> {
    let n = steer.len().min(x.len()).min(z.len());
    // Samples at 100 Hz are a few decimetres apart, too close to read a direction from: keep a point only once the path
    // has moved MIN_STEP_M since the last one, and take the turn at each kept point from its two neighbours.
    let mut kept: Vec<(f64, f64, f64)> = Vec::new();
    for i in 0..n {
        let (px, pz, s) = (f64::from(x[i]), f64::from(z[i]), f64::from(steer[i]));
        if !(px.is_finite() && pz.is_finite() && s.is_finite()) {
            continue;
        }
        if kept.last().is_none_or(|(lx, lz, _)| (px - lx).hypot(pz - lz) >= MIN_STEP_M) {
            kept.push((px, pz, s));
        }
    }
    let (mut st, mut ss, mut tt, mut used) = (0.0f64, 0.0f64, 0.0f64, 0usize);
    for w in kept.windows(3) {
        let (ax, az) = (w[1].0 - w[0].0, w[1].1 - w[0].1);
        let (bx, bz) = (w[2].0 - w[1].0, w[2].1 - w[1].1);
        let (la, lb) = (ax.hypot(az), bx.hypot(bz));
        // The jump of a position that leaps (a respawn) is not a turn.
        if lb > 10.0 * MIN_STEP_M || la > 10.0 * MIN_STEP_M {
            continue;
        }
        // Seen from above with z north, a right turn has a negative cross product: turn right = positive.
        let turn = -(ax * bz - az * bx) / (la * lb);
        let s = w[1].2;
        st += s * turn;
        ss += s * s;
        tt += turn * turn;
        if s.abs() > 0.02 {
            used += 1;
        }
    }
    if used < 30 || ss <= 0.0 || tt <= 0.0 {
        return None;
    }
    Some(st / (ss * tt).sqrt())
}

fn map_mirrored(steer: &[f32], x: &[f32], z: &[f32]) -> Option<String> {
    let r = steer_turn_correlation(steer, x, z)?;
    (r < MIRRORED_BELOW).then(|| format!("steering right turns the path to the left (correlation {r:.2}): the map is probably mirrored"))
}

fn nan_share(lap: &Lap) -> Option<String> {
    let mut found = Vec::new();
    for channel in &lap.channels {
        if !crate::lapfile::STANDARD_UNITS.iter().any(|(id, _)| *id == channel.id) || channel.values.is_empty() {
            continue;
        }
        let share = channel.values.iter().filter(|v| v.is_nan()).count() as f64 / channel.values.len() as f64;
        if share > NAN_SHARE {
            found.push(format!("{} ({})", channel.id, percent(share)));
        }
    }
    (!found.is_empty()).then(|| {
        format!(
            "more than {} of the values are missing in: {}",
            percent(NAN_SHARE),
            found.join(", ")
        )
    })
}

/// The lap as it is saved: stamped with this program and the reader (unless the reader stamped it already, with the
/// game's own version for instance), and with the ids of the checks it failed.
pub fn prepare(lap: &Lap) -> (Lap, Vec<Finding>) {
    let findings = check(lap);
    let mut out = lap.clone();
    if out.recorder.is_none() {
        out.recorder = Some(Recorder::current(&lap.game, None));
    }
    out.checks = findings.iter().map(|f| f.id.to_string()).collect();
    (out, findings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lapfile::Channel;

    const RATE: f64 = 30.0;
    const SPEED: f32 = 40.0;
    const SAMPLES: usize = 1800; // 60 s

    fn channel(id: &str, unit: &str, values: Vec<f32>) -> Channel {
        Channel {
            id: id.into(),
            unit: unit.into(),
            values,
        }
    }

    /// A clean lap: 60 s at 30 Hz and 40 m/s, a path that swings right and left, steering that follows it (steer +1 is
    /// right, clockwise from above), a clutch that is up and a throttle that is mostly down.
    fn clean() -> Lap {
        let mut t = Vec::new();
        let (mut dist, mut x, mut z, mut steer) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let (mut px, mut pz, mut heading) = (0.0f64, 0.0f64, 0.0f64);
        let dt = 1.0 / RATE;
        for i in 0..SAMPLES {
            let time = i as f64 * dt;
            // Turn rate in rad/s: positive turns right (the heading is measured clockwise from north).
            let rate = 0.2 * (time * std::f64::consts::TAU / 20.0).sin();
            heading += rate * dt;
            px += f64::from(SPEED) * heading.sin() * dt;
            pz += f64::from(SPEED) * heading.cos() * dt;
            t.push(time as f32);
            dist.push((f64::from(SPEED) * time) as f32);
            x.push(px as f32);
            z.push(pz as f32);
            steer.push((rate / 0.2) as f32);
        }
        let n = SAMPLES;
        Lap {
            game: "acevo".into(),
            track_name: "Test Ring".into(),
            track_length_m: Some(f64::from(SPEED) * (SAMPLES - 1) as f64 / RATE),
            car_name: "Test Car".into(),
            started_at: "2026-11-16T12:00:00.000Z".into(),
            sample_rate_hz: RATE,
            valid: true,
            channels: vec![
                channel("t", "s", t),
                channel("dist", "m", dist),
                channel("speed", "m/s", vec![SPEED; n]),
                channel("throttle", "ratio", vec![0.95; n]),
                channel("brake", "ratio", vec![0.0; n]),
                channel("clutch", "ratio", vec![0.0; n]),
                channel("steer", "ratio", steer),
                channel("x", "m", x),
                channel("z", "m", z),
            ],
            ..Lap::default()
        }
    }

    fn set(lap: &mut Lap, id: &str, change: impl FnOnce(&mut Vec<f32>)) {
        change(&mut lap.channels.iter_mut().find(|c| c.id == id).unwrap().values);
    }

    fn ids(lap: &Lap) -> Vec<&'static str> {
        check(lap).iter().map(|f| f.id).collect()
    }

    #[test]
    fn a_clean_lap_passes_every_check() {
        assert_eq!(check(&clean()), vec![]);
    }

    #[test]
    fn historical_evo_recordings_keep_their_known_clock_fault_visible() {
        let cases: [&[u8]; 3] = [
            include_bytes!("../fixtures/laps/acevo-real-lap-1.xlap.gz"),
            include_bytes!("../fixtures/laps/acevo-real-lap-2.xlap.gz"),
            include_bytes!("../fixtures/laps/acevo-real-lap-3.xlap.gz"),
        ];
        for bytes in cases {
            let lap = crate::lapfile::gunzip(bytes, crate::lapfile::MAX_UNPACKED).unwrap();
            assert!(check(&lap).iter().any(|finding| finding.id == "t_repeats"));
            let (stamped, findings) = prepare(&lap);
            assert!(findings.iter().any(|finding| finding.id == "t_repeats"));
            assert!(stamped.checks.iter().any(|id| id == "t_repeats"));
        }
    }

    #[test]
    fn every_id_is_a_valid_header_id_and_listed() {
        for id in IDS {
            assert!(id.chars().all(|c| c.is_ascii_lowercase() || c == '_') && id.len() <= 32);
        }
        // Each id of IDS has a test below that makes it fire; this keeps the list and the tests together.
        assert_eq!(IDS.len(), 12);
    }

    #[test]
    fn t_repeats_fires_when_the_clock_stands_still_and_not_for_a_few_repeats() {
        let mut lap = clean();
        // The lap clock repeats a value for most samples: every third one equals the one before.
        set(&mut lap, "t", |t| {
            for i in (3..t.len()).step_by(3) {
                t[i] = t[i - 1];
            }
        });
        assert!(ids(&lap).contains(&"t_repeats"));
        let mut few = clean();
        set(&mut few, "t", |t| t[100] = t[99]);
        assert!(!ids(&few).contains(&"t_repeats"));
    }

    #[test]
    fn t_gap_fires_on_a_step_over_two_seconds() {
        let mut lap = clean();
        set(&mut lap, "t", |t| {
            for v in t.iter_mut().skip(900) {
                *v += 3.0;
            }
        });
        assert!(ids(&lap).contains(&"t_gap"));
        let mut near = clean();
        set(&mut near, "t", |t| {
            for v in t.iter_mut().skip(900) {
                *v += 1.5;
            }
        });
        assert!(!ids(&near).contains(&"t_gap"));
    }

    #[test]
    fn dist_vs_track_compares_the_final_distance_with_the_track_unless_it_is_an_out_or_in_lap() {
        let mut lap = clean();
        lap.track_length_m = Some(lap.track_length_m.unwrap() * 1.1);
        assert!(ids(&lap).contains(&"dist_vs_track"));
        lap.out_lap = Some(true);
        assert!(!ids(&lap).contains(&"dist_vs_track"));
        lap.out_lap = None;
        lap.in_lap = Some(true);
        assert!(!ids(&lap).contains(&"dist_vs_track"));
        let mut near = clean();
        near.track_length_m = Some(near.track_length_m.unwrap() * 1.02);
        assert!(!ids(&near).contains(&"dist_vs_track"));
        let mut unknown = clean();
        unknown.track_length_m = None;
        assert!(!ids(&unknown).contains(&"dist_vs_track"));
    }

    #[test]
    fn dist_backwards_fires_when_the_distance_goes_back_over_five_metres() {
        let mut lap = clean();
        set(&mut lap, "dist", |d| d[1000] -= 20.0);
        assert!(ids(&lap).contains(&"dist_backwards"));
        let mut small = clean();
        set(&mut small, "dist", |d| d[1000] -= 4.0 + 40.0 / 30.0);
        assert!(!ids(&small).contains(&"dist_backwards"));
    }

    #[test]
    fn clutch_stuck_fires_for_an_inverted_pedal_and_not_for_a_clutch_used_to_pull_away() {
        let mut lap = clean();
        set(&mut lap, "clutch", |c| c.iter_mut().for_each(|v| *v = 1.0));
        assert!(ids(&lap).contains(&"clutch_stuck"));
        // Down for the first seconds only (a standing start), up afterwards.
        let mut start = clean();
        set(&mut start, "clutch", |c| c.iter_mut().take(150).for_each(|v| *v = 1.0));
        assert!(!ids(&start).contains(&"clutch_stuck"));
        // Down all the time but never at full throttle at speed: a car that is not being driven, not an inverted pedal.
        let mut parked = clean();
        set(&mut parked, "clutch", |c| c.iter_mut().for_each(|v| *v = 1.0));
        set(&mut parked, "throttle", |c| c.iter_mut().for_each(|v| *v = 0.0));
        assert!(!ids(&parked).contains(&"clutch_stuck"));
    }

    #[test]
    fn pedal_range_and_steer_range_fire_outside_their_range() {
        let mut lap = clean();
        set(&mut lap, "throttle", |c| c[10] = 1.4);
        set(&mut lap, "brake", |c| c[20] = -0.2);
        assert!(ids(&lap).contains(&"pedal_range"));
        let detail = check(&lap).into_iter().find(|f| f.id == "pedal_range").unwrap().detail;
        assert!(detail.contains("throttle") && detail.contains("brake"));
        assert!(!ids(&lap).contains(&"steer_range"));
        let mut steer = clean();
        set(&mut steer, "steer", |c| c[50] = 1.5);
        assert!(ids(&steer).contains(&"steer_range"));
        assert!(!ids(&steer).contains(&"pedal_range"));
        // Rounding noise is not a finding.
        let mut exact = clean();
        set(&mut exact, "throttle", |c| c[10] = 1.0000001);
        set(&mut exact, "steer", |c| c[10] = -1.0);
        assert_eq!(ids(&exact), Vec::<&str>::new());
    }

    #[test]
    fn speed_range_fires_below_zero_and_above_150_m_s() {
        let mut lap = clean();
        set(&mut lap, "speed", |s| s[5] = -0.5);
        assert!(ids(&lap).contains(&"speed_range"));
        let mut fast = clean();
        set(&mut fast, "speed", |s| s[5] = 151.0);
        assert!(ids(&fast).contains(&"speed_range"));
        let mut top = clean();
        set(&mut top, "speed", |s| s[5] = 149.0);
        assert!(!ids(&top).contains(&"speed_range"));
    }

    #[test]
    fn position_jump_fires_on_a_leap_of_the_position_at_a_speed_that_cannot_make_it() {
        let mut lap = clean();
        set(&mut lap, "x", |x| x[700] += 80.0);
        assert!(ids(&lap).contains(&"position_jump"));
        // A step under 50 m (the car covers 1.3 m per sample here) is not one.
        let mut small = clean();
        set(&mut small, "x", |x| {
            for v in x.iter_mut().skip(700) {
                *v += 30.0;
            }
        });
        assert!(!ids(&small).contains(&"position_jump"));
        // At 100 m/s or more the car covers it.
        let mut fast = clean();
        set(&mut fast, "x", |x| x.iter_mut().skip(700).for_each(|v| *v += 80.0));
        set(&mut fast, "speed", |s| s[700] = 120.0);
        assert!(!ids(&fast).contains(&"position_jump"));
    }

    #[test]
    fn map_mirrored_fires_for_a_mirrored_path_and_passes_a_right_hand_circle_driven_with_steer_over_zero() {
        let mut mirrored = clean();
        set(&mut mirrored, "x", |x| x.iter_mut().for_each(|v| *v = -*v));
        assert!(ids(&mirrored).contains(&"map_mirrored"));
        assert!(!ids(&clean()).contains(&"map_mirrored"));

        // A steady circle seen from above going clockwise (a right turn): steer +0.2 all the way round.
        let mut circle = clean();
        let radius = 300.0f64;
        let (mut x, mut z) = (Vec::new(), Vec::new());
        for i in 0..SAMPLES {
            let angle = f64::from(SPEED) * (i as f64 / RATE) / radius;
            x.push((radius * angle.sin()) as f32);
            z.push((radius * angle.cos()) as f32);
        }
        set(&mut circle, "x", |c| *c = x.clone());
        set(&mut circle, "z", |c| *c = z.clone());
        set(&mut circle, "steer", |c| c.iter_mut().for_each(|v| *v = 0.2));
        assert!(steer_turn_correlation(column(&circle, "steer").unwrap(), &x, &z).unwrap() > 0.9);
        assert!(!ids(&circle).contains(&"map_mirrored"));
        // The same circle with the steering the other way round is wrong.
        set(&mut circle, "steer", |c| c.iter_mut().for_each(|v| *v = -0.2));
        assert!(ids(&circle).contains(&"map_mirrored"));
        // Anticlockwise (a left turn) with steer under zero is right.
        let mut left = clean();
        set(&mut left, "x", |c| *c = x.iter().map(|v| -v).collect());
        set(&mut left, "z", |c| *c = z.clone());
        set(&mut left, "steer", |c| c.iter_mut().for_each(|v| *v = -0.2));
        assert!(!ids(&left).contains(&"map_mirrored"));
    }

    #[test]
    fn map_mirrored_says_nothing_without_a_position_or_steering_to_judge() {
        let mut no_steer = clean();
        no_steer.channels.retain(|c| c.id != "steer");
        assert!(!ids(&no_steer).contains(&"map_mirrored"));
        let mut standing = clean();
        set(&mut standing, "x", |x| x.iter_mut().for_each(|v| *v = 0.0));
        set(&mut standing, "z", |x| x.iter_mut().for_each(|v| *v = 0.0));
        assert!(!ids(&standing).contains(&"map_mirrored"));
    }

    #[test]
    fn nan_share_fires_for_a_standard_channel_that_is_mostly_missing() {
        let mut lap = clean();
        set(&mut lap, "brake", |b| b.iter_mut().step_by(2).for_each(|v| *v = f32::NAN));
        lap.channels.push(channel("custom_extra", "x", vec![f32::NAN; SAMPLES]));
        assert!(ids(&lap).contains(&"nan_share"));
        let detail = check(&lap).into_iter().find(|f| f.id == "nan_share").unwrap().detail;
        assert!(detail.contains("brake") && !detail.contains("custom_extra"), "{detail}");
        let mut some = clean();
        set(&mut some, "brake", |b| b.iter_mut().step_by(10).for_each(|v| *v = f32::NAN));
        assert!(!ids(&some).contains(&"nan_share"));
    }

    #[test]
    fn sample_rate_fires_below_20_hz() {
        let mut lap = clean();
        lap.sample_rate_hz = 10.0;
        assert!(ids(&lap).contains(&"sample_rate"));
        lap.sample_rate_hz = 20.0;
        assert!(!ids(&lap).contains(&"sample_rate"));
    }

    #[test]
    fn prepare_stamps_the_lap_and_lists_the_findings_in_the_header() {
        let mut lap = clean();
        set(&mut lap, "clutch", |c| c.iter_mut().for_each(|v| *v = 1.0));
        let (out, findings) = prepare(&lap);
        assert_eq!(out.checks, vec!["clutch_stuck"]);
        assert_eq!(findings.len(), 1);
        let recorder = out.recorder.clone().unwrap();
        assert_eq!((recorder.app.as_str(), recorder.source.as_str()), ("xpeed-companion", "acevo"));
        assert_eq!(recorder.version, env!("CARGO_PKG_VERSION"));
        // A reader's own stamp is kept.
        let mut stamped = clean();
        stamped.recorder = Some(Recorder::current("kunos", Some("0.9.1")));
        assert_eq!(prepare(&stamped).0.recorder.unwrap().game_build.as_deref(), Some("0.9.1"));
        // And the result is a lap the writer takes.
        assert!(crate::lapfile::pack(&out).is_ok());
    }

    /// The three laps of Assetto Corsa EVO recorded by Companion 0.8.1, with its bugs, if they are on this machine.
    /// Run with `cargo test real_evo_laps -- --nocapture` to see the findings.
    #[test]
    fn real_evo_laps_recorded_by_0_8_1_are_caught() {
        let Ok(home) = std::env::var("USERPROFILE") else { return };
        let dir = std::path::Path::new(&home).join("Documents").join("Xpeed Companion").join("Laps");
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        let mut seen = 0;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".xlap.gz") {
                continue;
            }
            // The other laps of the folder (other games, other versions) are only shown, as a look at false alarms.
            let known_bad = name.starts_with("laguna-seca_");
            let bytes = std::fs::read(entry.path()).unwrap();
            let lap = crate::lapfile::gunzip(&bytes, crate::lapfile::MAX_UNPACKED).unwrap();
            let findings = check(&lap);
            println!("{name}");
            if let (Some(st), Some(x), Some(z)) = (column(&lap, "steer"), column(&lap, "x"), column(&lap, "z")) {
                println!("  correlation {:?}", steer_turn_correlation(st, x, z));
            }
            for finding in &findings {
                println!("  {}: {}", finding.id, finding.detail);
            }
            let found: Vec<&str> = findings.iter().map(|f| f.id).collect();
            if known_bad {
                for must in ["t_repeats", "clutch_stuck", "map_mirrored"] {
                    assert!(found.contains(&must), "{name}: {must} should fire, got {found:?}");
                }
                seen += 1;
            }
        }
        println!("{seen} real laps checked");
    }
}
