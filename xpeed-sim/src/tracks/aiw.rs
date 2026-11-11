//! rFactor 1 engine games (Stock Car Extreme): the `.AIW` file of a track.
//!
//! A text file. After the grid, teleport and pit sections comes `[Waypoint]`, with a few header lines (`lap_length`,
//! `number_waypoints`, ...) and then one block of lines per waypoint. The ones read here:
//!
//! ```text
//! wp_pos=(x,y,z)            the waypoint, in the game's world
//! wp_perp=(x,y,z)           unit vector across the road, to the driver's LEFT
//! wp_width=(a,b,c,d)        metres from the waypoint, along wp_perp: road left, road right, far left, far right
//! wp_path=(dry,wet)         metres from the waypoint along wp_perp where the dry (ideal) line and the wet line run
//! wp_score=(sector,dist)    distance into the lap, metres
//! WP_PTRS=(prev,next,branch,path of branch)   waypoint numbers (the order of the blocks in the file)
//! wp_branchID=(n)           0 the main path, 1.. the pit lane paths, and one number for each pit stall
//! wp_bitfields=(n)          bit 1: not a path waypoint (a pit stall, a garage spot)
//! ```
//!
//! The format is the one of the game's track editor; the lines are described by its own comments in the files
//! (`// road left, road right, far left, far right`, `// 0 = main, 1...whatever pit lanes`).
//!
//! The waypoints of the main path are not always in the middle of the road: they are moved to the middle between the
//! two edges (`to_edges_midpoint`), and the dry line (the waypoint plus `wp_path[0]` along `wp_perp`) is the `fast` line.

use super::*;
use std::path::{Path, PathBuf};

pub const SOURCE: &str = "aiw";
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// How far the length of the waypoints may be from the `lap_length` the file states.
const LENGTH_TOLERANCE: f64 = 0.01;
const PIT_MAX_DISTANCE_M: f64 = 300.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Waypoint {
    pub pos: [f64; 3],
    pub perp: [f64; 3],
    /// Road left, road right, far left, far right.
    pub width: [f64; 4],
    /// Where the dry line runs across the road, metres along `perp`.
    pub dry: Option<f64>,
    /// Distance into the lap, metres.
    pub score: Option<f64>,
    pub prev: i64,
    pub next: i64,
    pub branch: i64,
    pub bitfields: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Aiw {
    pub lap_length: Option<f64>,
    pub number_waypoints: Option<usize>,
    pub waypoints: Vec<Waypoint>,
}

/// The numbers in `(a, b, c)` of a line's value, ignoring a trailing `// comment`.
fn values(value: &str) -> Option<Vec<f64>> {
    let value = value.split("//").next()?.trim();
    let inner = match (value.find('('), value.rfind(')')) {
        (Some(open), Some(close)) if close > open => &value[open + 1..close],
        (None, None) => value,
        _ => return None,
    };
    let numbers: Option<Vec<f64>> = inner
        .split(',')
        .map(|part| part.trim().parse::<f64>().ok().filter(|n| n.is_finite()))
        .collect();
    numbers.filter(|n| !n.is_empty())
}

fn exactly<const N: usize>(value: &str) -> Option<[f64; N]> {
    values(value)?.try_into().ok()
}

fn whole(n: f64) -> Option<i64> {
    (n.fract() == 0.0 && n.abs() < 1e9).then_some(n as i64)
}

#[derive(Default)]
struct Building {
    pos: Option<[f64; 3]>,
    perp: Option<[f64; 3]>,
    width: Option<[f64; 4]>,
    dry: Option<f64>,
    score: Option<f64>,
    ptrs: Option<[f64; 4]>,
    branch: Option<f64>,
    bitfields: Option<f64>,
}

impl Building {
    fn finish(self, index: usize) -> Result<Waypoint, Refusal> {
        let missing = |what: &str| Refusal {
            code: "aiw_field",
            message: format!("waypoint {index} has no valid {what}"),
        };
        let ptrs = self.ptrs.ok_or_else(|| missing("WP_PTRS"))?;
        let int = |n: f64, what: &str| whole(n).ok_or_else(|| missing(what));
        Ok(Waypoint {
            pos: self.pos.ok_or_else(|| missing("wp_pos"))?,
            perp: self.perp.ok_or_else(|| missing("wp_perp"))?,
            width: self.width.ok_or_else(|| missing("wp_width"))?,
            dry: self.dry,
            score: self.score,
            prev: int(ptrs[0], "WP_PTRS")?,
            next: int(ptrs[1], "WP_PTRS")?,
            branch: int(self.branch.unwrap_or(0.0), "wp_branchID")?,
            bitfields: int(self.bitfields.unwrap_or(0.0), "wp_bitfields")?,
        })
    }
}

/// Reads the `[Waypoint]` section of an AIW text.
pub fn parse_aiw(text: &str) -> Result<Aiw, Refusal> {
    let mut in_waypoints = false;
    let mut lap_length = None;
    let mut number_waypoints = None;
    let mut waypoints: Vec<Waypoint> = Vec::new();
    let mut current: Option<Building> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_waypoints = line.split(']').next().is_some_and(|s| s.eq_ignore_ascii_case("[waypoint"));
            continue;
        }
        if !in_waypoints {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim().to_ascii_lowercase();
        if key == "wp_pos" {
            if let Some(done) = current.take() {
                waypoints.push(done.finish(waypoints.len())?);
            }
            if waypoints.len() >= MAX_POINTS {
                return refuse("aiw_too_many", format!("more than {MAX_POINTS} waypoints"));
            }
            current = Some(Building::default());
        }
        match (current.as_mut(), key.as_str()) {
            (None, "lap_length") => lap_length = values(value).map(|v| v[0]),
            (None, "number_waypoints") => number_waypoints = values(value).and_then(|v| whole(v[0])).and_then(|n| usize::try_from(n).ok()),
            (Some(w), "wp_pos") => w.pos = exactly::<3>(value),
            (Some(w), "wp_perp") => w.perp = exactly::<3>(value),
            (Some(w), "wp_width") => w.width = exactly::<4>(value),
            (Some(w), "wp_path") => w.dry = values(value).map(|v| v[0]),
            (Some(w), "wp_score") => w.score = exactly::<2>(value).map(|v| v[1]),
            (Some(w), "wp_ptrs") => w.ptrs = exactly::<4>(value),
            (Some(w), "wp_branchid") => w.branch = values(value).map(|v| v[0]),
            (Some(w), "wp_bitfields") => w.bitfields = values(value).map(|v| v[0]),
            _ => {}
        }
    }
    if let Some(done) = current.take() {
        waypoints.push(done.finish(waypoints.len())?);
    }
    if waypoints.is_empty() {
        return refuse("aiw_empty", "no waypoints in a [Waypoint] section");
    }
    Ok(Aiw {
        lap_length,
        number_waypoints,
        waypoints,
    })
}

/// Follows `next` pointers from `start` through the waypoints `accept` allows. Returns the chain and whether it came
/// back to `start` (a loop).
fn follow(waypoints: &[Waypoint], start: usize, accept: &dyn Fn(&Waypoint) -> bool) -> (Vec<usize>, bool) {
    let mut chain = vec![start];
    let mut seen = vec![false; waypoints.len()];
    seen[start] = true;
    let mut at = start;
    loop {
        let next = waypoints[at].next;
        let Ok(next) = usize::try_from(next) else { return (chain, false) };
        if next >= waypoints.len() || !accept(&waypoints[next]) {
            return (chain, false);
        }
        if next == start {
            return (chain, true);
        }
        if seen[next] {
            return (chain, false);
        }
        seen[next] = true;
        chain.push(next);
        at = next;
    }
}

fn is_path(w: &Waypoint) -> bool {
    w.bitfields & 1 == 0
}

fn dist3(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// Turns the text of an AIW into a track. `name` is what the game calls the track, `title` a nicer name when it has one.
pub fn extract_text(text: &str, name: &str, title: Option<&str>) -> Result<Extracted, Refusal> {
    let aiw = parse_aiw(text)?;
    let wps = &aiw.waypoints;
    let mut report = Report::default();
    if let Some(count) = aiw.number_waypoints {
        if count != wps.len() {
            return refuse(
                "aiw_count",
                format!(
                    "the header says {count} waypoints but the file has {}: it is cut short or edited",
                    wps.len()
                ),
            );
        }
    }
    for (i, w) in wps.iter().enumerate() {
        for p in [w.prev, w.next] {
            if p < -1 || p >= wps.len() as i64 {
                return refuse("aiw_pointer", format!("waypoint {i} points at waypoint {p}, which does not exist"));
            }
        }
    }

    // The main path, from the waypoint nearest the start line.
    let main = |w: &Waypoint| w.branch == 0 && is_path(w);
    let main_count = wps.iter().filter(|w| main(w)).count();
    if main_count < 10 {
        return refuse("aiw_main", format!("only {main_count} waypoints on the main path"));
    }
    let first_in_file = wps.iter().position(main).unwrap_or(0);
    let start = wps
        .iter()
        .enumerate()
        .filter(|(_, w)| main(w) && w.score.is_some())
        .min_by(|a, b| a.1.score.unwrap_or(0.0).total_cmp(&b.1.score.unwrap_or(0.0)))
        .map_or(first_in_file, |(i, _)| i);
    let (chain, closed_loop) = follow(wps, start, &main);
    if (chain.len() as f64) < 0.9 * main_count as f64 {
        return refuse(
            "aiw_chain",
            format!(
                "following the main path from the start line reaches {} of its {main_count} waypoints",
                chain.len()
            ),
        );
    }
    let n = chain.len();
    let pos: Vec<[f64; 3]> = chain.iter().map(|&i| wps[i].pos).collect();
    let mut chord_m = 0.0;
    for k in 1..n {
        chord_m += dist3(&pos[k], &pos[k - 1]);
    }
    let gap_m = dist3(&pos[0], &pos[n - 1]);
    let closed = closed_loop && gap_m <= MAX_CLOSE_GAP_M;
    let length_m = chord_m + if closed { gap_m } else { 0.0 };
    report.notes.push(format!(
        "{n} waypoints on the main path ({} in the file), {length_m:.1} m, {}",
        wps.len(),
        if closed { "closed loop" } else { "not closed" }
    ));
    if !(100.0..=MAX_LENGTH_M).contains(&length_m) {
        return refuse("aiw_length", format!("a length of {length_m:.0} m is not a track"));
    }
    match aiw.lap_length {
        Some(lap) if lap > 0.0 => {
            let error = (length_m - lap).abs() / lap;
            report.notes.push(format!(
                "lap_length says {lap:.1} m, the waypoints give {length_m:.1} m ({:+.2}%)",
                (length_m - lap) / lap * 100.0
            ));
            if error > LENGTH_TOLERANCE {
                return refuse(
                    "aiw_lap_length",
                    format!("the waypoints add up to {length_m:.0} m but lap_length says {lap:.0} m"),
                );
            }
        }
        _ => report.warnings.push("no lap_length to check the waypoints against".into()),
    }

    // The distance along the lap: the game's own score where it gives one, checked against the waypoints.
    let mut dist = Vec::with_capacity(n);
    let s0 = wps[chain[0]].score.unwrap_or(0.0).max(0.0);
    let mut acc = s0;
    for k in 0..n {
        if k > 0 {
            acc += dist3(&pos[k], &pos[k - 1]);
        }
        dist.push(acc);
    }
    let mut worst = 0.0f64;
    let mut scored = 0usize;
    for (k, &i) in chain.iter().enumerate() {
        if let Some(s) = wps[i].score {
            // A score that passes the start line wraps back to 0: compare modulo the lap.
            let lap = length_m.max(1.0);
            let d = (s - dist[k]).rem_euclid(lap);
            worst = worst.max(d.min(lap - d));
            scored += 1;
        }
    }
    if scored > 0 {
        report.notes.push(format!(
            "the game's own distance (wp_score) differs from the waypoints' by at most {worst:.1} m over {scored} waypoints"
        ));
        if worst > 0.02 * length_m + 5.0 {
            return refuse(
                "aiw_score",
                format!("wp_score disagrees with the waypoint positions by {worst:.0} m"),
            );
        }
    }

    // The direction across the road must be the one the format says (to the driver's left), or the widths are on the
    // wrong sides.
    let x: Vec<f32> = pos.iter().map(|p| p[0] as f32).collect();
    let y: Vec<f32> = pos.iter().map(|p| p[1] as f32).collect();
    let z: Vec<f32> = pos.iter().map(|p| p[2] as f32).collect();
    let units = left_units(&x, &z, closed);
    let mut agree = 0.0;
    let mut unit_perp = 0usize;
    for (k, &i) in chain.iter().enumerate() {
        let p = wps[i].perp;
        let len = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
        if (0.9..=1.1).contains(&len) {
            unit_perp += 1;
        }
        agree += (p[0] * units[k].0 + p[2] * units[k].1) / len.max(1e-9);
    }
    let agree = agree / n as f64;
    if (unit_perp as f64) < 0.95 * n as f64 || agree < 0.9 {
        return refuse(
            "aiw_perp",
            format!("wp_perp is not the unit vector to the left of the direction of travel (mean agreement {agree:.2})"),
        );
    }
    report.notes.push(format!(
        "wp_perp points to the driver's left at every point (mean agreement {agree:.3})"
    ));

    // Widths: road left and road right, from the waypoint.
    let raw_left: Vec<f32> = chain.iter().map(|&i| wps[i].width[0] as f32).collect();
    let raw_right: Vec<f32> = chain.iter().map(|&i| wps[i].width[1] as f32).collect();
    let widths = clean_widths(&raw_left, &raw_right);
    if widths.kept {
        report.notes.push(format!(
            "widths known at {} of {n} points, median whole-road width {:.1} m",
            widths.known, widths.median_m
        ));
    } else {
        report.warnings.push(format!(
            "no usable road width ({} of {n} points have both sides measured, median {:.1} m): the track has a centre line only",
            widths.known, widths.median_m
        ));
    }

    // The dry line.
    let fast = if chain.iter().any(|&i| wps[i].dry.is_some_and(|d| d != 0.0)) {
        let (mut fx, mut fz) = (Vec::with_capacity(n), Vec::with_capacity(n));
        for &i in &chain {
            let w = &wps[i];
            let lateral = w.dry.unwrap_or(0.0);
            let len = (w.perp[0].powi(2) + w.perp[2].powi(2)).sqrt().max(1e-9);
            fx.push((w.pos[0] + lateral * w.perp[0] / len) as f32);
            fz.push((w.pos[2] + lateral * w.perp[2] / len) as f32);
        }
        Some(Fast { x: fx, z: fz })
    } else {
        report
            .warnings
            .push("no dry line in the file (wp_path is 0 everywhere): the track has no ideal line".into());
        None
    };

    let (mut cx, mut cz, mut left, mut right) = (x, z, widths.left, widths.right);
    if widths.kept {
        to_edges_midpoint(&mut cx, &mut cz, &mut left, &mut right, closed);
    }

    let pitlane = match extract_pit(wps, &pos) {
        Ok((pit, note)) => {
            report.notes.push(note);
            Some(pit)
        }
        Err(why) => {
            report.warnings.push(format!("pit lane left out: {why}"));
            None
        }
    };

    let track = Track {
        game: "sce".into(),
        name: name.to_owned(),
        variant: None,
        title: title.map(str::to_owned),
        length_m: Some(round_cm(length_m)),
        source: SOURCE.into(),
        frame: FRAME.into(),
        closed,
        center_kind: if widths.kept { "edges_midpoint" } else { "game_line" }.into(),
        centerline: Centerline {
            x: cx,
            y,
            z: cz,
            dist: dist.iter().map(|d| *d as f32).collect(),
            left,
            right,
        },
        fast,
        pitlane,
    };
    check(&track).map_err(|e| Refusal {
        code: "track_invalid",
        message: e.message,
    })?;
    Ok(Extracted { track, report })
}

/// The pit lane: the longest chain of path waypoints that are on a branch other than the main one.
fn extract_pit(wps: &[Waypoint], main_pos: &[[f64; 3]]) -> Result<(Pitlane, String), String> {
    let pit = |w: &Waypoint| w.branch >= 1 && is_path(w);
    let in_pit: Vec<bool> = wps.iter().map(pit).collect();
    let mut best: Vec<usize> = Vec::new();
    for (i, w) in wps.iter().enumerate() {
        let starts_here = in_pit[i] && !(w.prev >= 0 && in_pit.get(w.prev as usize).copied().unwrap_or(false));
        if starts_here {
            let (chain, _) = follow(wps, i, &pit);
            if chain.len() > best.len() {
                best = chain;
            }
        }
    }
    if best.len() < 2 {
        return Err("no pit lane path (no branch other than the main path)".into());
    }
    let x: Vec<f32> = best.iter().map(|&i| wps[i].pos[0] as f32).collect();
    let z: Vec<f32> = best.iter().map(|&i| wps[i].pos[2] as f32).collect();
    let length = path_length(&x, &z);
    if length < 20.0 {
        return Err(format!("only {length:.0} m long"));
    }
    let far = best
        .iter()
        .map(|&i| {
            main_pos
                .iter()
                .map(|m| (m[0] - wps[i].pos[0]).hypot(m[2] - wps[i].pos[2]))
                .fold(f64::INFINITY, f64::min)
        })
        .fold(0.0, f64::max);
    if far > PIT_MAX_DISTANCE_M {
        return Err(format!("a point is {far:.0} m from the main path"));
    }
    let widths = clean_widths(
        &best.iter().map(|&i| wps[i].width[0] as f32).collect::<Vec<_>>(),
        &best.iter().map(|&i| wps[i].width[1] as f32).collect::<Vec<_>>(),
    );
    let note = format!(
        "pit lane: {} waypoints, {length:.0} m, at most {far:.0} m from the main path, width {}",
        best.len(),
        if widths.kept {
            format!("median {:.1} m", widths.median_m)
        } else {
            "unknown".to_owned()
        }
    );
    Ok((
        Pitlane {
            x,
            z,
            left: widths.left,
            right: widths.right,
        },
        note,
    ))
}

/// `TrackName = Interlagos Cafe` from the `.gdb` beside the AIW, when there is one.
pub fn gdb_title(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (k, v) = line.split_once('=')?;
        if !k.trim().eq_ignore_ascii_case("TrackName") {
            return None;
        }
        let v = v.split("//").next()?.trim().to_owned();
        is_text(&v, 120).then_some(v)
    })
}

/// Reads an AIW file (and the `.gdb` beside it for the track's title) and extracts its track.
pub fn extract(path: &Path) -> Result<Extracted, Refusal> {
    let io = |e: std::io::Error| Refusal {
        code: "io",
        message: format!("cannot read {}: {e}", path.display()),
    };
    let size = std::fs::metadata(path).map_err(io)?.len();
    if size > MAX_FILE_BYTES {
        return refuse(
            "aiw_too_large",
            format!("{size} bytes is more than the {MAX_FILE_BYTES} an AIW can be"),
        );
    }
    let bytes = std::fs::read(path).map_err(io)?;
    // The files are Windows-1252 text; only ASCII matters for what is read.
    let text: String = bytes.iter().map(|&b| char::from(b)).collect();
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let title = std::fs::read(path.with_extension("gdb"))
        .ok()
        .and_then(|b| gdb_title(&b.iter().map(|&c| char::from(c)).collect::<String>()));
    extract_text(&text, &stem, title.as_deref())
}

/// Every `.aiw` file under a folder, up to three levels down (`GameData/Locations/<place>/<track>/<track>.AIW`).
pub fn list(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if depth > 0 {
                    walk(&p, depth - 1, out);
                }
            } else if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("aiw")) {
                out.push(p);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, 3, &mut out);
    out.sort();
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// An AIW text laid out line by line: a square-ish loop of `n` waypoints on a circle of 100 m (clockwise seen with x
    /// across and z down), 4.55 m apart as in the real files, with a pit lane of 12 waypoints beside it.
    pub(crate) fn synthetic(n: usize, left: f64, right: f64, dry: f64, with_pit: bool) -> String {
        let radius = 100.0;
        let mut text = String::from("//[[gMa1.002f (c)2007    ]] [[            ]]\r\n[Features]\r\nwaypointspan=4.55\r\n\r\n[GRID]\r\nGridIndex=0\r\nPos=(1.0,2.0,3.0)\r\n\r\n[Waypoint]\r\n");
        let total = n + if with_pit { 12 } else { 0 };
        let step = std::f64::consts::TAU * radius / n as f64;
        let lap = step * n as f64;
        text.push_str(&format!("number_waypoints={total}\r\nlap_length={lap:.6}\r\nLaneSpacing=4.50\r\n"));
        let block = |text: &mut String,
                     pos: [f64; 3],
                     perp: [f64; 3],
                     width: [f64; 4],
                     dry: f64,
                     score: f64,
                     ptrs: [i64; 4],
                     branch: i64,
                     bf: i64| {
            text.push_str(&format!(
                "wp_pos=({:.4},{:.4},{:.4})\r\nwp_perp=({:.4},{:.4},{:.4})\r\nwp_normal=(0,1,0)\r\nwp_vect=(1,0,0)\r\nwp_width=({:.3},{:.3},{:.3},{:.3}) // road left, road right, far left, far right\r\nwp_path=({dry:.4},0.0000) // dry, wet\r\nwp_score=(1,{score:.3})\r\nWP_PTRS=({},{},{},{})\r\nwp_branchID=({branch})\r\nwp_bitfields=({bf})\r\n",
                pos[0], pos[1], pos[2], perp[0], perp[1], perp[2], width[0], width[1], width[2], width[3], ptrs[0], ptrs[1], ptrs[2], ptrs[3]
            ));
        };
        // The file starts at waypoint 5 of the lap, as the real ones start somewhere in the middle.
        let shift = 5usize;
        for k in 0..n {
            let lap_index = (k + shift) % n;
            let a = std::f64::consts::TAU * lap_index as f64 / n as f64;
            // Heading (-sin a, cos a); left = (tz, -tx) = (cos a, sin a) points outward.
            let perp = [a.cos(), 0.0, a.sin()];
            block(
                &mut text,
                [radius * a.cos(), 5.0, radius * a.sin()],
                perp,
                [left, right, left + 3.0, right + 3.0],
                dry,
                step * lap_index as f64,
                [(k as i64 + n as i64 - 1) % n as i64, (k as i64 + 1) % n as i64, -1, 0],
                0,
                0,
            );
        }
        if with_pit {
            for k in 0..12 {
                let a = 0.2 + 0.03 * k as f64;
                block(
                    &mut text,
                    [(radius + 14.0) * a.cos(), 5.0, (radius + 14.0) * a.sin()],
                    [a.cos(), 0.0, a.sin()],
                    [4.0, 4.0, 5.0, 5.0],
                    0.0,
                    0.0,
                    [
                        if k == 0 { 0 } else { (n + k - 1) as i64 },
                        if k == 11 { 3 } else { (n + k + 1) as i64 },
                        -1,
                        0,
                    ],
                    1,
                    0,
                );
            }
        }
        text
    }

    #[test]
    fn decodes_a_synthetic_track_starting_at_the_start_line() {
        let text = synthetic(300, 4.0, 10.0, -2.0, true);
        let found = extract_text(&text, "circle", Some("The Circle")).unwrap();
        let t = &found.track;
        assert!(t.closed && t.fast.is_some() && t.pitlane.is_some());
        assert_eq!(
            (t.game.as_str(), t.name.as_str(), t.title.as_deref(), t.center_kind.as_str()),
            ("sce", "circle", Some("The Circle"), "edges_midpoint")
        );
        assert!((t.length_m.unwrap() - 628.3).abs() < 0.1);
        let c = &t.centerline;
        assert_eq!(c.x.len(), 300);
        // The file started at lap point 5, the start line is lap point 0: the first point is the one at angle 0.
        assert!((c.dist[0]).abs() < 0.01);
        assert!(c.dist.windows(2).all(|w| w[1] >= w[0]));
        // Left 4, right 10: the middle of the road is 3 m to the right of the waypoint, i.e. inside the circle.
        let radius = f64::from(c.x[7]).hypot(f64::from(c.z[7]));
        assert!((radius - 97.0).abs() < 0.2, "{radius}");
        assert!(c.left.iter().chain(&c.right).all(|v| (*v - 7.0).abs() < 1e-3));
        // The dry line is 2 m to the right of the waypoint (-2 along the left vector).
        let fast = t.fast.as_ref().unwrap();
        assert!((f64::from(fast.x[7]).hypot(f64::from(fast.z[7])) - 98.0).abs() < 0.01);
        let pit = t.pitlane.as_ref().unwrap();
        assert_eq!(pit.x.len(), 12);
        assert!(pit.left.iter().all(|v| (*v - 4.0).abs() < 1e-4));
        assert!(pack(t).is_ok());
    }

    #[test]
    fn works_without_a_pit_lane_or_widths_or_a_dry_line() {
        let found = extract_text(&synthetic(300, 0.0, 0.0, 0.0, false), "c", None).unwrap();
        assert!(found.track.pitlane.is_none() && found.track.fast.is_none() && found.track.title.is_none());
        assert_eq!(found.track.center_kind, "game_line");
        assert!(found.report.warnings.iter().any(|w| w.contains("no dry line")));
        assert!(found.report.warnings.iter().any(|w| w.contains("no usable road width")));
        assert!(found.report.warnings.iter().any(|w| w.contains("pit lane left out")));
    }

    #[test]
    fn refuses_what_is_not_a_track() {
        let good = synthetic(300, 4.0, 10.0, 0.0, true);
        let code = |text: &str| extract_text(text, "t", None).unwrap_err().code;
        assert_eq!(code(""), "aiw_empty");
        assert_eq!(code("[Waypoint]\nlap_length=100\n"), "aiw_empty");
        assert_eq!(code("[Features]\nwp_pos=(1,2,3)\n"), "aiw_empty");
        // Cut in the middle of a block, or after a few blocks: the header's count gives it away.
        assert!(["aiw_count", "aiw_field"].contains(&code(&good[..good.len() / 2])));
        // A block that lacks a required line.
        let broken = good.replacen("wp_width=", "wp_widht=", 1);
        assert_eq!(code(&broken), "aiw_field");
        // A pointer to a waypoint that does not exist.
        let pointer = good.replacen("WP_PTRS=(299,1,-1,0)", "WP_PTRS=(299,9999,-1,0)", 1);
        assert_eq!(code(&pointer), "aiw_pointer");
        // NaN or text where a number should be.
        assert_eq!(code(&good.replacen("wp_pos=(", "wp_pos=(nan,", 1)), "aiw_field");
        // The length the file states is not the length of its waypoints.
        let lap = good.replacen("lap_length=", "lap_length=9", 1);
        assert_eq!(code(&lap), "aiw_lap_length");
        // Widths on the wrong side: wp_perp pointing to the right.
        let mut flipped = String::new();
        for line in good.lines() {
            if let Some(rest) = line.strip_prefix("wp_perp=(") {
                let v: Vec<f64> = rest.trim_end_matches(')').split(',').map(|s| s.parse().unwrap()).collect();
                flipped.push_str(&format!("wp_perp=({},{},{})\r\n", -v[0], -v[1], -v[2]));
            } else {
                flipped.push_str(line);
                flipped.push_str("\r\n");
            }
        }
        assert_eq!(code(&flipped), "aiw_perp");
        // A score that has nothing to do with the positions.
        let scores = good.replace("wp_score=(1,", "wp_score=(1,9");
        assert_eq!(code(&scores), "aiw_score");
    }

    #[test]
    fn refuses_absurd_sizes_without_reserving_memory() {
        let mut text = String::from("[Waypoint]\n");
        for _ in 0..(MAX_POINTS + 2) {
            text.push_str("wp_pos=(0,0,0)\nwp_perp=(1,0,0)\nwp_width=(1,1,1,1)\nWP_PTRS=(0,0,-1,0)\n");
        }
        assert_eq!(extract_text(&text, "t", None).unwrap_err().code, "aiw_too_many");
    }

    #[test]
    fn never_panics_on_pieces_of_a_good_file() {
        let good = synthetic(120, 4.0, 10.0, 1.0, true);
        for len in (0..good.len()).step_by(53) {
            let _ = extract_text(&good[..len], "t", None);
        }
        // Lines in the wrong order, repeated keys, and garbage.
        let _ = extract_text("[Waypoint]\nWP_PTRS=(1,2\nwp_pos=\nwp_pos=(1)\n=\n", "t", None);
        let _ = extract_text("[Waypoint\nwp_pos=(1,2,3)", "t", None);
    }

    #[test]
    fn a_loop_of_pointers_that_never_closes_on_the_start_is_not_followed_forever() {
        let wps = vec![
            Waypoint {
                pos: [0.0; 3],
                perp: [1.0, 0.0, 0.0],
                width: [1.0; 4],
                dry: None,
                score: None,
                prev: 1,
                next: 1,
                branch: 0,
                bitfields: 0,
            };
            3
        ];
        let mut wps = wps;
        wps[1].next = 2;
        wps[2].next = 1;
        let (chain, closed) = follow(&wps, 0, &|_| true);
        assert_eq!((chain, closed), (vec![0, 1, 2], false));
    }

    /// Every `.AIW` of the installed game, checked and tallied. Run it with
    /// `cargo test -- --ignored --nocapture validates_every_installed_sce_track`; it does nothing when the game is not installed.
    #[test]
    #[ignore = "reads the installed game; run by hand"]
    fn validates_every_installed_sce_track() {
        let Some(root) = crate::tracks::dump::game_folders("XPEED_SCE_DIR", "Stock Car Extreme", "GameData/Locations")
            .into_iter()
            .find(|p| p.is_dir())
        else {
            eprintln!("Stock Car Extreme is not installed here: nothing to validate");
            return;
        };
        let files = list(&root);
        let mut accepted = 0usize;
        let mut refused: Vec<String> = Vec::new();
        let mut warnings: std::collections::BTreeMap<String, usize> = Default::default();
        let (mut with_pit, mut with_fast, mut closed) = (0, 0, 0);
        let (mut shortest, mut longest) = (f64::MAX, 0.0f64);
        let mut widths = (f32::MAX, 0.0f32);
        for file in &files {
            let label = file.strip_prefix(&root).unwrap_or(file).display().to_string();
            match extract(file) {
                Ok(found) => {
                    let t = &found.track;
                    let bytes = pack(t).unwrap_or_else(|e| panic!("{label}: accepted but not writable: {e}"));
                    assert!(pack(&unpack(&bytes).unwrap()).unwrap() == bytes, "{label}: reads back differently");
                    accepted += 1;
                    with_pit += usize::from(t.pitlane.is_some());
                    with_fast += usize::from(t.fast.is_some());
                    closed += usize::from(t.closed);
                    shortest = shortest.min(t.length_m.unwrap_or(0.0));
                    longest = longest.max(t.length_m.unwrap_or(0.0));
                    let w = width_stats(&t.centerline.left, &t.centerline.right);
                    widths = (widths.0.min(w.min), widths.1.max(w.max));
                    for warning in &found.report.warnings {
                        *warnings.entry(warning.chars().take(48).collect()).or_default() += 1;
                    }
                }
                Err(refusal) => refused.push(format!("{label}: {refusal}")),
            }
        }
        eprintln!("\n.AIW files: {}", files.len());
        eprintln!("ACCEPTED: {accepted}  closed {closed}, with ideal line {with_fast}, with pit lane {with_pit}");
        eprintln!(
            "lengths {shortest:.0} m to {longest:.0} m; whole-road width {:.1} m to {:.1} m",
            widths.0, widths.1
        );
        for (kind, count) in &warnings {
            eprintln!("  warning x{count}: {kind}");
        }
        eprintln!("REFUSED: {}", refused.len());
        for line in &refused {
            eprintln!("      {line}");
        }
    }

    #[test]
    fn reads_the_title_from_the_gdb() {
        assert_eq!(
            gdb_title("{\n  TrackName = Interlagos Cafe\n  EventName = x\n").as_deref(),
            Some("Interlagos Cafe")
        );
        assert_eq!(gdb_title("{\n  TrackName = Foo // note\n").as_deref(), Some("Foo"));
        assert_eq!(gdb_title("EventName = x"), None);
    }

    #[test]
    fn reads_values_in_parentheses() {
        assert_eq!(values("(1.5, -2, 3e2) // x"), Some(vec![1.5, -2.0, 300.0]));
        assert_eq!(values("4319.28"), Some(vec![4319.28]));
        assert_eq!(values("(1,"), None);
        assert_eq!(values("(a)"), None);
        assert_eq!(values("(inf)"), None);
        assert_eq!(values("()"), None);
        assert_eq!(exactly::<3>("(1,2)"), None);
    }
}
