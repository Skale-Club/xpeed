//! Assetto Corsa: the AI's ideal line (`ai/fast_lane.ai`) and the pit lane (`ai/pit_lane.ai`) of a track layout.
//!
//! The `.ai` format is binary and Kunos never published it. What is written here was read from the 535 installed files
//! and checked against two community descriptions (the parser of AssettoServer, `FastLaneParser.cs`, and the thread
//! "Extract AI pit/fast lanes" on assettocorsamods.net; the URLs are in the document `FORMATO-DE-PISTA.md`). Little-endian:
//!
//! ```text
//! 0    i32      version, 7 (an unused layout keeps a 12-byte stub with version 3)
//! 4    i32      N, the number of points
//! 8    i32 x2   lap time and sample count, always 0 in the files seen
//! 16   N x 20   point: f32 x, y, z, f32 distance along the line (metres), i32 index (0, 1, 2, ...)
//! ..   i32      N again
//! ..   N x 72   detail, 18 x f32: speed, gas, brake, lateral g, radius, SIDE LEFT, SIDE RIGHT, camber, direction,
//!               normal (3), length, forward vector (3), tag, grade. Only the two sides are used here: the other
//!               fields are not the same in every file (in the ones Kunos made, "length" is the distance to the
//!               previous point and the forward vector is the direction of travel; in many mods' files they are not)
//! ..   rest     a lookup grid for the game's own use (cell lists); not read here
//! ```
//!
//! The two side values are the distances from the line to the left and to the right edge of the road. The line is the
//! racing line, so it is not in the middle: `fast_lane.ai` is turned into a centre line by moving each point to the
//! middle between its two edges (`to_edges_midpoint`), and the original line is kept as the `fast` line.

use std::path::{Path, PathBuf};

use super::*;

const POINT_BYTES: usize = 20;
const DETAIL_BYTES: usize = 72;
const HEADER_BYTES: usize = 16;
pub const SOURCE: &str = "fast_lane.ai";

/// How far the whole stored distance may be from the sum of the straight pieces between the points.
const DIST_RATIO: (f64, f64) = (0.95, 1.05);
/// A track whose first and last points are this close is a closed loop (AssettoServer uses 50 m, the files seen have a
/// gap of 1.5 m or more than 80 m).
const CLOSED_GAP_M: f64 = 20.0;
/// How far the length computed from the points may be from the length in `ui_track.json`.
const UI_LENGTH_TOLERANCE: f64 = 0.05;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AiPoint {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub dist: f32,
    pub side_left: f32,
    pub side_right: f32,
    /// The point's own length field: the distance to the previous point.
    pub length: f32,
}

fn f32_at(bytes: &[u8], at: usize) -> f32 {
    f32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}
fn i32_at(bytes: &[u8], at: usize) -> i32 {
    i32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Reads a `.ai` file. Only structure is checked here (sizes, version, indices); `analyse` checks the geometry.
pub fn parse_ai(bytes: &[u8]) -> Result<Vec<AiPoint>, Refusal> {
    if bytes.len() < HEADER_BYTES {
        return refuse(
            "ai_stub",
            format!(
                "only {} bytes: an empty placeholder, not a line (the game ships these for layouts without AI)",
                bytes.len()
            ),
        );
    }
    let version = i32_at(bytes, 0);
    if version != 7 {
        return refuse("ai_version", format!("version {version}, only version 7 is known"));
    }
    let n = i32_at(bytes, 4);
    if n <= 0 {
        return refuse("ai_empty", format!("{n} points"));
    }
    let n = n as usize;
    if n > MAX_POINTS {
        return refuse("ai_too_many", format!("{n} points, more than the {MAX_POINTS} allowed"));
    }
    let details_at = HEADER_BYTES + n * POINT_BYTES;
    let need = details_at + 4 + n * DETAIL_BYTES;
    if bytes.len() < need {
        return refuse(
            "ai_truncated",
            format!("{} bytes but {n} points need at least {need}: the file is cut short", bytes.len()),
        );
    }
    if i32_at(bytes, details_at) as usize != n {
        return refuse("ai_counts", "the point count and the detail count differ");
    }
    let mut points = Vec::with_capacity(n);
    for i in 0..n {
        let p = HEADER_BYTES + i * POINT_BYTES;
        if i32_at(bytes, p + 16) != i as i32 {
            return refuse(
                "ai_index",
                format!("point {i} has index {}: the points are not in order", i32_at(bytes, p + 16)),
            );
        }
        let d = details_at + 4 + i * DETAIL_BYTES;
        points.push(AiPoint {
            x: f32_at(bytes, p),
            y: f32_at(bytes, p + 4),
            z: f32_at(bytes, p + 8),
            dist: f32_at(bytes, p + 12),
            side_left: f32_at(bytes, d + 5 * 4),
            side_right: f32_at(bytes, d + 6 * 4),
            length: f32_at(bytes, d + 12 * 4),
        });
    }
    Ok(points)
}

/// What the points of one line say about themselves.
#[derive(Debug, Clone, PartialEq)]
pub struct Geometry {
    pub points: usize,
    /// Sum of the straight pieces between consecutive points, metres.
    pub chord_m: f64,
    /// The last stored distance, metres.
    pub stored_m: f64,
    /// Distance between the last and the first point, metres.
    pub gap_m: f64,
    pub closed: bool,
    /// The length of one lap: the stored distance plus the closing piece when the line is closed.
    pub length_m: f64,
    /// Share of points whose length field matches the distance to the previous point.
    pub length_field_share: f64,
}

/// Checks that a line is a line: finite numbers, distances that start at 0 and never go back and that agree with the
/// positions, a length field that agrees with the positions, and works out whether it closes.
pub fn analyse(points: &[AiPoint]) -> Result<Geometry, Refusal> {
    let n = points.len();
    if n < 10 {
        return refuse("ai_too_short", format!("{n} points"));
    }
    for (i, p) in points.iter().enumerate() {
        if ![p.x, p.y, p.z, p.dist].iter().all(|v| v.is_finite()) {
            return refuse(
                "ai_not_finite",
                format!("point {i} has a position or distance that is not a number"),
            );
        }
    }
    if points[0].dist.abs() > 0.5 {
        return refuse(
            "ai_dist_start",
            format!("the distance starts at {:.1} instead of 0", points[0].dist),
        );
    }
    let mut chord_m = 0.0;
    let mut length_hits = 0usize;
    for (i, pair) in points.windows(2).enumerate() {
        let (a, b) = (&pair[0], &pair[1]);
        if b.dist < a.dist {
            return refuse("ai_dist_back", format!("the distance goes back at point {}", i + 1));
        }
        let (dx, dy, dz) = (f64::from(b.x - a.x), f64::from(b.y - a.y), f64::from(b.z - a.z));
        let c = (dx * dx + dy * dy + dz * dz).sqrt();
        chord_m += c;
        if (f64::from(b.length) - c).abs() <= 0.05 + 0.02 * c {
            length_hits += 1;
        }
    }
    let stored_m = f64::from(points[n - 1].dist);
    if stored_m <= 0.0 {
        return refuse(
            "ai_dist_zero",
            "every stored distance is 0, so the file cannot say where along the lap a point is",
        );
    }
    let ratio = stored_m / chord_m.max(1e-9);
    if !(DIST_RATIO.0..=DIST_RATIO.1).contains(&ratio) {
        return refuse(
            "ai_dist_mismatch",
            format!(
                "the stored distance {stored_m:.0} m is {:.0}% of the {chord_m:.0} m the points add up to",
                ratio * 100.0
            ),
        );
    }
    let length_field_share = length_hits as f64 / (n - 1) as f64;
    let (first, last) = (&points[0], &points[n - 1]);
    let gap_m = f64::from(first.x - last.x).hypot(f64::from(first.z - last.z));
    let closed = gap_m <= CLOSED_GAP_M;
    let length_m = if closed { stored_m + gap_m } else { stored_m };
    if !(100.0..=MAX_LENGTH_M).contains(&length_m) {
        return refuse("ai_length", format!("a length of {length_m:.0} m is not a track"));
    }
    Ok(Geometry {
        points: n,
        chord_m,
        stored_m,
        gap_m,
        closed,
        length_m,
        length_field_share,
    })
}

// ---------------------------------------------------------------------------------------------
// What the game says about the same track elsewhere
// ---------------------------------------------------------------------------------------------

/// `data/map.ini`: how the game's own map picture is laid over the world.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MapIni {
    pub width: f64,
    pub height: f64,
    pub margin: f64,
    pub scale: f64,
    pub x_offset: f64,
    pub z_offset: f64,
}

/// The value of `KEY=number` in an ini text (first match, case-insensitive key).
fn ini_number(text: &str, key: &str) -> Option<f64> {
    text.lines().find_map(|line| {
        let (k, v) = line.split_once('=')?;
        if !k.trim().eq_ignore_ascii_case(key) {
            return None;
        }
        let v = v.split([';', '/']).next()?.trim();
        v.parse::<f64>().ok().filter(|n| n.is_finite())
    })
}

pub fn parse_map_ini(text: &str) -> Option<MapIni> {
    let map = MapIni {
        width: ini_number(text, "WIDTH")?,
        height: ini_number(text, "HEIGHT")?,
        margin: ini_number(text, "MARGIN").unwrap_or(0.0),
        scale: ini_number(text, "SCALE_FACTOR")?,
        x_offset: ini_number(text, "X_OFFSET")?,
        z_offset: ini_number(text, "Z_OFFSET")?,
    };
    (map.width > 0.0 && map.height > 0.0 && map.scale > 0.0).then_some(map)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MapFit {
    /// Share of the line's points that fall inside the map picture.
    pub inside: f64,
    /// Width and height of the line on the map, as a share of the map's drawable area (1 when they fill it).
    pub extent_x: f64,
    pub extent_z: f64,
}

impl MapFit {
    pub fn fits(&self) -> bool {
        self.inside >= 0.95 && (0.8..=1.25).contains(&self.extent_x) && (0.8..=1.25).contains(&self.extent_z)
    }
}

/// Lays the line over the game's map picture the way the game does (`pixel = (world + offset) / scale`, x across, z
/// down). The game draws the car on that picture from the same world numbers the telemetry gives, so a line that
/// fills the picture is in the telemetry's frame.
pub fn map_fit(points: &[AiPoint], map: &MapIni) -> MapFit {
    let px = |p: &AiPoint| (f64::from(p.x) + map.x_offset) / map.scale;
    let pz = |p: &AiPoint| (f64::from(p.z) + map.z_offset) / map.scale;
    let inside = points
        .iter()
        .filter(|p| (0.0..=map.width).contains(&px(p)) && (0.0..=map.height).contains(&pz(p)))
        .count();
    let span = |f: &dyn Fn(&AiPoint) -> f64| {
        let (lo, hi) = points
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(f(p)), hi.max(f(p))));
        hi - lo
    };
    MapFit {
        inside: inside as f64 / points.len().max(1) as f64,
        extent_x: span(&px) / (map.width - 2.0 * map.margin).max(1.0),
        extent_z: span(&pz) / (map.height - 2.0 * map.margin).max(1.0),
    }
}

/// A check that left and right are the sides this module believes. A racing line runs close to the inside edge at the
/// apex of a corner, so at the sharpest corners the side that is the shorter one should be the side the corner turns to.
/// Returns the share of the sharpest corners where that holds (in 462 installed tracks the mean is 0.81 and 428 of them are
/// above 0.6), or `None` when there are too few corners with measured sides to tell.
pub fn side_agreement(points: &[AiPoint], closed: bool) -> Option<f64> {
    let n = points.len();
    if n < 30 {
        return None;
    }
    let spacing = points.last()?.dist as f64 / n as f64;
    let k = ((15.0 / spacing.max(0.05)).round() as usize).clamp(2, n / 4);
    let mut corners: Vec<(f64, bool)> = Vec::new();
    for i in 0..n {
        let (a, c) = if closed {
            ((i + n - k) % n, (i + k) % n)
        } else if i >= k && i + k < n {
            (i - k, i + k)
        } else {
            continue;
        };
        let (p0, p1, p2) = (&points[a], &points[i], &points[c]);
        let (v1x, v1z) = (f64::from(p1.x - p0.x), f64::from(p1.z - p0.z));
        let (v2x, v2z) = (f64::from(p2.x - p1.x), f64::from(p2.z - p1.z));
        let angle = (v1x * v2z - v1z * v2x).atan2(v1x * v2x + v1z * v2z);
        let (l, r) = (points[i].side_left, points[i].side_right);
        if angle.abs() > 0.1 && l.is_finite() && r.is_finite() && l > 0.0 && r > 0.0 && (l - r).abs() > 0.05 {
            // A positive angle turns to the right with x across and z down; the line is nearer the right edge when left is the longer side.
            corners.push((angle.abs(), (angle > 0.0) == (l > r)));
        }
    }
    corners.sort_by(|a, b| b.0.total_cmp(&a.0));
    corners.truncate((n / 20).max(5));
    (corners.len() >= 5).then(|| corners.iter().filter(|c| c.1).count() as f64 / corners.len() as f64)
}

/// The text value of a `"key": "value"` (or `"key": 123`) pair in a JSON text, without parsing the rest: the track
/// files are written by hand and many are not valid JSON.
pub fn json_field(text: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{key}\"");
    let at = text.find(&pattern)? + pattern.len();
    let rest = text[at..].trim_start().strip_prefix(':')?.trim_start();
    if let Some(quoted) = rest.strip_prefix('"') {
        let end = quoted.find('"')?;
        Some(quoted[..end].trim().to_owned())
    } else {
        let end = rest.find([',', '}', '\n', '\r']).unwrap_or(rest.len());
        let value = rest[..end].trim();
        (!value.is_empty() && value != "null").then(|| value.to_owned())
    }
}

/// The length a `ui_track.json` gives (`"5793"`, `"5.793 km"`, `"5.793m"` for 5793 m, `"2.5 miles"`), in metres.
pub fn parse_ui_length(text: &str) -> Option<f64> {
    let s: String = text
        .trim()
        .trim_start_matches('~')
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    let digits = s.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == ',')).unwrap_or(s.len());
    let (number, unit) = s.split_at(digits);
    if number.is_empty() || !number.chars().next()?.is_ascii_digit() {
        return None;
    }
    let value = |t: &str| t.replace(',', ".").parse::<f64>().ok();
    let metres = if unit.starts_with("km") {
        value(number)? * 1000.0
    } else if unit.starts_with("mi") {
        value(number)? * 1609.344
    } else {
        // Metres, written as 5793, 5793.5 or 5.793 / 5,793 (a thousands separator: groups of exactly three digits).
        let groups: Vec<&str> = number.split(['.', ',']).collect();
        if groups.len() > 1 && groups[0].len() <= 3 && groups[1..].iter().all(|g| g.len() == 3) {
            groups.concat().parse::<f64>().ok()?
        } else {
            value(number)?
        }
    };
    (metres.is_finite() && metres > 0.0).then_some(metres)
}

/// What the game's other files say about the layout (all optional).
#[derive(Debug, Clone, Default)]
pub struct Outside {
    pub ui_title: Option<String>,
    pub ui_length_raw: Option<String>,
    pub map: Option<MapIni>,
}

/// Where a layout lives and what it is called.
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    /// The folder with `ai/` and `data/` in it.
    pub dir: PathBuf,
    /// The track's folder name, which is what the game reports as the track.
    pub track: String,
    /// The layout's folder name, which is what the game reports as the track configuration (none for a track without layouts).
    pub variant: Option<String>,
    /// The folder of `fast_lane.ai`: `ai`, or a sub-folder of it (a backup copy the game never reads).
    pub ai_dir: PathBuf,
}

fn name_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Works out the track and the layout from the folder of a `fast_lane.ai` (`.../<track>/<layout>/ai`, or
/// `.../<track>/ai` for a track with one layout, or a sub-folder of `ai` holding a copy).
pub fn layout_of_ai_dir(ai_dir: &Path) -> Option<Layout> {
    let mut dir = ai_dir.to_path_buf();
    // A copy kept in a sub-folder: climb to the folder called `ai`.
    for _ in 0..2 {
        if name_of(&dir).eq_ignore_ascii_case("ai") {
            break;
        }
        dir = dir.parent()?.to_path_buf();
    }
    if !name_of(&dir).eq_ignore_ascii_case("ai") {
        return None;
    }
    let layout_dir = dir.parent()?.to_path_buf();
    let above = layout_dir.parent()?.to_path_buf();
    // Is the folder above a track (holding a `ui` folder with a folder for this layout in it, or layouts of its own),
    // or is this folder the track itself?
    let is_layout = above.join("ui").join(name_of(&layout_dir)).is_dir()
        || (above.join("ui").is_dir() && !layout_dir.join("ui").is_dir() && !name_of(&above).eq_ignore_ascii_case("tracks"));
    let (track, variant) = if is_layout {
        (name_of(&above), Some(name_of(&layout_dir)))
    } else {
        (name_of(&layout_dir), None)
    };
    Some(Layout {
        dir: layout_dir,
        track,
        variant,
        ai_dir: ai_dir.to_path_buf(),
    })
}

/// The `ui_track.json` and `map.ini` of a layout, as far as they exist and can be read.
pub fn read_outside(layout: &Layout) -> Outside {
    let track_dir = if layout.variant.is_some() {
        layout.dir.parent().map(Path::to_path_buf).unwrap_or_else(|| layout.dir.clone())
    } else {
        layout.dir.clone()
    };
    let mut candidates = Vec::new();
    if let Some(v) = &layout.variant {
        candidates.push(track_dir.join("ui").join(v).join("ui_track.json"));
    }
    candidates.push(track_dir.join("ui").join("ui_track.json"));
    let text = candidates
        .iter()
        .find_map(|p| std::fs::read(p).ok())
        .map(|b| String::from_utf8_lossy(&b).trim_start_matches('\u{feff}').to_owned());
    Outside {
        ui_title: text.as_deref().and_then(|t| json_field(t, "name")).filter(|n| is_text(n, 120)),
        ui_length_raw: text.as_deref().and_then(|t| json_field(t, "length")),
        map: std::fs::read_to_string(layout.dir.join("data").join("map.ini"))
            .ok()
            .and_then(|t| parse_map_ini(&t)),
    }
}

// ---------------------------------------------------------------------------------------------
// From the files to a track
// ---------------------------------------------------------------------------------------------

/// How far the pit lane may be from the track's line before it is thought to belong to another layout, in metres.
const PIT_MAX_DISTANCE_M: f64 = 300.0;

/// Turns the bytes of `fast_lane.ai` (and, when there is one, `pit_lane.ai`) into a track. `outside` is what the
/// game's other files say about the same layout; it is how the result is cross-checked.
pub fn extract_bytes(fast: &[u8], pit: Option<&[u8]>, track: &str, variant: Option<&str>, outside: &Outside) -> Result<Extracted, Refusal> {
    let points = parse_ai(fast)?;
    let geometry = analyse(&points)?;
    let mut report = Report::default();
    let n = points.len();
    report.notes.push(format!(
        "{n} points, {:.1} m by stored distance, {:.1} m by the points, closing gap {:.1} m ({}), length field matches at {:.1}% of the points",
        geometry.stored_m,
        geometry.chord_m,
        geometry.gap_m,
        if geometry.closed { "closed loop" } else { "not closed" },
        geometry.length_field_share * 100.0
    ));

    // Two checks against what the game says elsewhere. One that holds is enough; a track that fails every check it
    // can be given is refused (its file or its metadata belongs to another layout), one that cannot be checked at all
    // is accepted and says so.
    let ui_length = outside.ui_length_raw.as_deref().and_then(parse_ui_length);
    let ui_ok = ui_length.map(|ui| {
        let error = (geometry.length_m - ui).abs() / ui;
        report.notes.push(format!(
            "ui_track.json says {ui:.0} m, the points give {:.0} m ({:+.1}%)",
            geometry.length_m,
            (geometry.length_m - ui) / ui * 100.0
        ));
        error <= UI_LENGTH_TOLERANCE
    });
    let map_fit_result = outside.map.map(|m| map_fit(&points, &m));
    let map_ok = map_fit_result.map(|fit| {
        report.notes.push(format!(
            "on the game's map picture {:.0}% of the points are inside and the line spans {:.0}% x {:.0}% of the drawable area",
            fit.inside * 100.0,
            fit.extent_x * 100.0,
            fit.extent_z * 100.0
        ));
        fit.fits()
    });
    match (ui_ok, map_ok) {
        (Some(false), Some(false)) | (Some(false), None) | (None, Some(false)) => {
            return refuse(
                "ai_not_confirmed",
                format!(
                    "the line does not agree with the game's own data for this layout (ui_track.json: {}; map.ini: {}); it may belong to another layout",
                    match ui_ok {
                        Some(false) => "length differs by more than 5%",
                        Some(true) => "length agrees",
                        None => "no length",
                    },
                    match map_ok {
                        Some(false) => "the line does not fit the map picture",
                        Some(true) => "fits the map picture",
                        None => "no map",
                    }
                ),
            );
        }
        (Some(false), Some(true)) => report
            .warnings
            .push("ui_track.json gives another length, but the line fits the game's map picture".into()),
        (Some(true), Some(false)) => report
            .warnings
            .push("the length agrees with ui_track.json, but the line does not fit the game's map picture".into()),
        (None, None) => report
            .warnings
            .push("nothing to check the line against (no length in ui_track.json, no map.ini)".into()),
        _ => {}
    }

    // Widths.
    let raw_left: Vec<f32> = points.iter().map(|p| p.side_left).collect();
    let raw_right: Vec<f32> = points.iter().map(|p| p.side_right).collect();
    let widths = clean_widths(&raw_left, &raw_right);
    if widths.kept {
        report.notes.push(format!(
            "widths known at {} of {n} points, median whole-road width {:.1} m",
            widths.known, widths.median_m
        ));
        match side_agreement(&points, geometry.closed) {
            Some(share) if share >= 0.35 => report.notes.push(format!("at the sharpest corners the line is nearer the inside edge in {:.0}% of them (the sides are taken as right when this is 35% or more)", share * 100.0)),
            Some(share) => report.warnings.push(format!(
                "at the sharpest corners the line is nearer the inside edge in only {:.0}% of them: left and right may be the other way round in this file",
                share * 100.0
            )),
            None => {}
        }
    } else {
        report.warnings.push(format!(
            "no usable road width ({} of {n} points have both sides measured, median {:.1} m): the track has a centre line only",
            widths.known, widths.median_m
        ));
    }

    let mut x: Vec<f32> = points.iter().map(|p| p.x).collect();
    let y: Vec<f32> = points.iter().map(|p| p.y).collect();
    let mut z: Vec<f32> = points.iter().map(|p| p.z).collect();
    let fast = Fast {
        x: x.clone(),
        z: z.clone(),
    };
    let (mut left, mut right) = (widths.left, widths.right);
    if widths.kept {
        to_edges_midpoint(&mut x, &mut z, &mut left, &mut right, geometry.closed);
    }
    let dist: Vec<f32> = points.iter().map(|p| p.dist).collect();

    let pitlane = match pit {
        Some(bytes) => match extract_pit(bytes, &fast) {
            Ok((pit, note)) => {
                report.notes.push(note);
                Some(pit)
            }
            Err(why) => {
                report.warnings.push(format!("pit lane left out: {why}"));
                None
            }
        },
        None => {
            report.warnings.push("no pit_lane.ai".into());
            None
        }
    };

    let result = Track {
        game: "ac".into(),
        name: track.to_owned(),
        variant: variant.map(str::to_owned),
        title: outside.ui_title.clone(),
        length_m: Some(round_cm(geometry.length_m)),
        source: SOURCE.into(),
        frame: FRAME.into(),
        closed: geometry.closed,
        center_kind: if widths.kept { "edges_midpoint" } else { "game_line" }.into(),
        centerline: Centerline {
            x,
            y,
            z,
            dist,
            left,
            right,
        },
        fast: Some(fast),
        pitlane,
    };
    check(&result).map_err(|e| Refusal {
        code: "track_invalid",
        message: e.message,
    })?;
    Ok(Extracted { track: result, report })
}

fn extract_pit(bytes: &[u8], main: &Fast) -> Result<(Pitlane, String), String> {
    let points = parse_ai(bytes).map_err(|r| r.to_string())?;
    if points.len() < 2 {
        return Err("fewer than 2 points".into());
    }
    if points.iter().any(|p| ![p.x, p.z, p.dist].iter().all(|v| v.is_finite())) {
        return Err("a point is not a number".into());
    }
    let (x, z): (Vec<f32>, Vec<f32>) = points.iter().map(|p| (p.x, p.z)).unzip();
    let length = path_length(&x, &z);
    if length < 20.0 {
        return Err(format!("only {length:.0} m long"));
    }
    // The pit lane must lie by the road: every point near some point of the line, or the file is of another layout.
    let far = (0..x.len())
        .map(|i| {
            (0..main.x.len())
                .map(|j| (f64::from(x[i]) - f64::from(main.x[j])).hypot(f64::from(z[i]) - f64::from(main.z[j])))
                .fold(f64::INFINITY, f64::min)
        })
        .fold(0.0, f64::max);
    if far > PIT_MAX_DISTANCE_M {
        return Err(format!("a point is {far:.0} m from the track's line: it belongs to another layout"));
    }
    let widths = clean_widths(
        &points.iter().map(|p| p.side_left).collect::<Vec<_>>(),
        &points.iter().map(|p| p.side_right).collect::<Vec<_>>(),
    );
    let note = format!(
        "pit lane: {} points, {length:.0} m, at most {far:.0} m from the line, width {}",
        x.len(),
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

/// Reads the files of a layout and extracts its track.
pub fn extract(layout: &Layout) -> Result<Extracted, Refusal> {
    let fast_path = layout.ai_dir.join(SOURCE);
    let fast = std::fs::read(&fast_path).map_err(|e| Refusal {
        code: "io",
        message: format!("cannot read {}: {e}", fast_path.display()),
    })?;
    let pit = std::fs::read(layout.ai_dir.join("pit_lane.ai")).ok();
    extract_bytes(
        &fast,
        pit.as_deref(),
        &layout.track,
        layout.variant.as_deref(),
        &read_outside(layout),
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A `.ai` file laid out byte by byte: a circle (or an arc) of `n` points seen from above, the line `offset` metres
    /// to the left of the middle of a road that is `left` + `right` wide.
    pub(crate) fn synthetic(n: usize, radius: f64, arc: f64, left: f32, right: f32) -> Vec<u8> {
        let mut pts = Vec::new();
        for i in 0..n {
            let a = arc * i as f64 / n as f64;
            // Clockwise seen with x across and z down, like a circuit that turns right.
            pts.push((radius * a.cos(), 3.0 + i as f64 * 0.001, radius * a.sin()));
        }
        let mut dist = vec![0.0f64];
        for i in 1..n {
            let d = ((pts[i].0 - pts[i - 1].0).powi(2) + (pts[i].1 - pts[i - 1].1).powi(2) + (pts[i].2 - pts[i - 1].2).powi(2)).sqrt();
            dist.push(dist[i - 1] + d);
        }
        let mut out = Vec::new();
        for v in [7i32, n as i32, 0, 0] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for (i, p) in pts.iter().enumerate() {
            for v in [p.0 as f32, p.1 as f32, p.2 as f32, dist[i] as f32] {
                out.extend_from_slice(&v.to_le_bytes());
            }
            out.extend_from_slice(&(i as i32).to_le_bytes());
        }
        out.extend_from_slice(&(n as i32).to_le_bytes());
        for i in 0..n {
            let prev = if i == 0 { n - 1 } else { i - 1 };
            let chord = ((pts[i].0 - pts[prev].0).powi(2) + (pts[i].1 - pts[prev].1).powi(2) + (pts[i].2 - pts[prev].2).powi(2)).sqrt();
            let mut detail = [0.0f32; 18];
            detail[5] = left;
            detail[6] = right;
            detail[12] = chord as f32;
            for v in detail {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        // The lookup grid the game appends: not read.
        out.extend_from_slice(&[1, 0, 0, 0, 9, 9, 9, 9]);
        out
    }

    fn circle() -> Vec<u8> {
        synthetic(600, 100.0, std::f64::consts::TAU, 9.0, 3.0)
    }

    #[test]
    fn decodes_a_synthetic_circle_into_a_closed_track_with_a_centre_line() {
        let found = extract_bytes(&circle(), None, "circle", Some("gp"), &Outside::default()).unwrap();
        let t = &found.track;
        assert!(t.closed && t.pitlane.is_none() && t.fast.is_some());
        assert_eq!(
            (t.game.as_str(), t.name.as_str(), t.variant.as_deref(), t.center_kind.as_str()),
            ("ac", "circle", Some("gp"), "edges_midpoint")
        );
        let length = t.length_m.unwrap();
        assert!((length - 628.3).abs() < 1.0, "{length}");
        // The ideal line has 9 m to the left edge and 3 m to the right (it hugs the inside of a right-hand circle): the
        // middle of the road is 3 m to the left of it. The line turns clockwise seen with z down, i.e. to the right, so
        // left points outside the circle and the middle of the road is 3 m outside the line: radius 103 m.
        let c = &t.centerline;
        let radius = f64::from(c.x[10]).hypot(f64::from(c.z[10]));
        assert!((radius - 103.0).abs() < 0.2, "{radius}");
        assert!(c.left.iter().chain(&c.right).all(|v| (*v - 6.0).abs() < 1e-4));
        let fast = t.fast.as_ref().unwrap();
        assert!((f64::from(fast.x[10]).hypot(f64::from(fast.z[10])) - 100.0).abs() < 0.01);
        assert!(c.dist[0] == 0.0 && c.dist[599] > 600.0);
        assert!(pack(t).is_ok());
    }

    #[test]
    fn checks_that_left_and_right_are_the_sides_the_line_hugs_in_corners() {
        // Hugging the inside of a right-hand circle means the right edge is the near one.
        let right_way = parse_ai(&synthetic(600, 100.0, std::f64::consts::TAU, 9.0, 3.0)).unwrap();
        assert!(side_agreement(&right_way, true).unwrap() > 0.99);
        let swapped = parse_ai(&synthetic(600, 100.0, std::f64::consts::TAU, 3.0, 9.0)).unwrap();
        assert!(side_agreement(&swapped, true).unwrap() < 0.01);
        let found = extract_bytes(
            &synthetic(600, 100.0, std::f64::consts::TAU, 3.0, 9.0),
            None,
            "c",
            None,
            &Outside::default(),
        )
        .unwrap();
        assert!(found.report.warnings.iter().any(|w| w.contains("the other way round")));
        // A straight-ish arc or equal sides give no verdict.
        let equal = parse_ai(&synthetic(600, 100.0, std::f64::consts::TAU, 6.0, 6.0)).unwrap();
        assert_eq!(side_agreement(&equal, true), None);
        assert_eq!(side_agreement(&right_way[..10], false), None);
    }

    #[test]
    fn an_arc_that_does_not_come_back_is_an_open_track() {
        let bytes = synthetic(400, 500.0, 1.5, 6.0, 6.0);
        let found = extract_bytes(&bytes, None, "arc", None, &Outside::default()).unwrap();
        assert!(!found.track.closed);
        assert!((found.track.length_m.unwrap() - 750.0).abs() < 5.0);
    }

    #[test]
    fn unmeasured_widths_leave_a_centre_line_only() {
        let bytes = synthetic(600, 100.0, std::f64::consts::TAU, 0.0, 0.0);
        let found = extract_bytes(&bytes, None, "c", None, &Outside::default()).unwrap();
        assert_eq!(found.track.center_kind, "game_line");
        assert!(found.track.centerline.left.iter().all(|v| v.is_nan()));
        assert!(found.report.warnings.iter().any(|w| w.contains("no usable road width")));
    }

    #[test]
    fn refuses_what_is_not_a_line() {
        let good = circle();
        let code = |bytes: &[u8]| extract_bytes(bytes, None, "t", None, &Outside::default()).unwrap_err().code;
        // The 12-byte placeholder the game ships for layouts without AI.
        assert_eq!(code(&[3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "ai_stub");
        assert_eq!(code(&[]), "ai_stub");
        assert_eq!(code(&good[..good.len() / 2]), "ai_truncated");
        assert_eq!(code(&good[..HEADER_BYTES + 5]), "ai_truncated");
        let mut version = good.clone();
        version[0] = 6;
        assert_eq!(code(&version), "ai_version");
        let mut empty = good.clone();
        empty[4..8].copy_from_slice(&0i32.to_le_bytes());
        assert_eq!(code(&empty), "ai_empty");
        let mut negative = good.clone();
        negative[4..8].copy_from_slice(&(-5i32).to_le_bytes());
        assert_eq!(code(&negative), "ai_empty");
        let mut huge = good.clone();
        huge[4..8].copy_from_slice(&i32::MAX.to_le_bytes());
        assert_eq!(code(&huge), "ai_too_many");
        let mut counts = good.clone();
        let at = HEADER_BYTES + 600 * POINT_BYTES;
        counts[at..at + 4].copy_from_slice(&599i32.to_le_bytes());
        assert_eq!(code(&counts), "ai_counts");
        let mut index = good.clone();
        index[HEADER_BYTES + 5 * POINT_BYTES + 16] = 99;
        assert_eq!(code(&index), "ai_index");
        let mut nan = good.clone();
        nan[HEADER_BYTES + 7 * POINT_BYTES..HEADER_BYTES + 7 * POINT_BYTES + 4].copy_from_slice(&f32::NAN.to_le_bytes());
        assert_eq!(code(&nan), "ai_not_finite");
        let mut back = good.clone();
        let d = HEADER_BYTES + 100 * POINT_BYTES + 12;
        back[d..d + 4].copy_from_slice(&1.0f32.to_le_bytes());
        assert_eq!(code(&back), "ai_dist_back");
        let mut start = good.clone();
        start[HEADER_BYTES + 12..HEADER_BYTES + 16].copy_from_slice(&50.0f32.to_le_bytes());
        assert_eq!(code(&start), "ai_dist_start");
        // Every stored distance zero (a file seen in the wild).
        let mut zero = good.clone();
        for i in 0..600 {
            let d = HEADER_BYTES + i * POINT_BYTES + 12;
            zero[d..d + 4].copy_from_slice(&0.0f32.to_le_bytes());
        }
        assert_eq!(code(&zero), "ai_dist_zero");
        // A distance that is twice what the points add up to.
        let mut double = good.clone();
        for i in 0..600 {
            let d = HEADER_BYTES + i * POINT_BYTES + 12;
            let v = f32_at(&double, d) * 2.0;
            double[d..d + 4].copy_from_slice(&v.to_le_bytes());
        }
        assert_eq!(code(&double), "ai_dist_mismatch");
        // Ten metres is not a track.
        assert_eq!(code(&synthetic(50, 1.0, std::f64::consts::TAU, 3.0, 3.0)), "ai_length");
    }

    #[test]
    fn never_panics_on_truncations_of_a_good_file() {
        let good = circle();
        for len in (0..good.len()).step_by(37) {
            let _ = extract_bytes(&good[..len], Some(&good[..len / 2]), "t", None, &Outside::default());
        }
    }

    #[test]
    fn the_length_in_ui_track_json_and_the_map_picture_confirm_or_refuse() {
        let bytes = circle();
        let outside = |length: Option<&str>, map: Option<MapIni>| Outside {
            ui_title: Some("Circle".into()),
            ui_length_raw: length.map(str::to_owned),
            map,
        };
        // The circle spans -100..100 on both axes: a map picture of 240 x 240 pixels with 20 of margin and the same offset.
        let map = MapIni {
            width: 240.0,
            height: 240.0,
            margin: 20.0,
            scale: 1.0,
            x_offset: 120.0,
            z_offset: 120.0,
        };
        let wrong_map = MapIni { x_offset: 900.0, ..map };
        let ok = |l, m| extract_bytes(&bytes, None, "c", None, &outside(l, m));
        assert!(ok(Some("628"), Some(map))
            .unwrap()
            .report
            .warnings
            .iter()
            .all(|w| w.contains("no pit_lane")));
        assert!(ok(Some("0.63 km"), None).is_ok());
        assert!(ok(None, Some(map)).is_ok());
        assert_eq!(ok(Some("3000"), None).unwrap_err().code, "ai_not_confirmed");
        assert_eq!(ok(None, Some(wrong_map)).unwrap_err().code, "ai_not_confirmed");
        assert_eq!(ok(Some("3000"), Some(wrong_map)).unwrap_err().code, "ai_not_confirmed");
        // One of the two is enough, and the other is a warning.
        assert!(ok(Some("3000"), Some(map))
            .unwrap()
            .report
            .warnings
            .iter()
            .any(|w| w.contains("another length")));
        assert!(ok(Some("628"), Some(wrong_map))
            .unwrap()
            .report
            .warnings
            .iter()
            .any(|w| w.contains("does not fit")));
        // A length that cannot be read is no evidence either way.
        assert!(ok(Some("long"), None).is_ok());
        assert_eq!(ok(Some("628"), None).unwrap().track.title.as_deref(), Some("Circle"));
    }

    #[test]
    fn reads_the_lengths_people_write() {
        for (text, metres) in [
            ("5793", 5793.0),
            ("5793m", 5793.0),
            ("5793 m", 5793.0),
            ("5.027m", 5027.0),
            ("5,027 m", 5027.0),
            ("5.793 km", 5793.0),
            ("5.8km", 5800.0),
            ("12,5 km", 12500.0),
            ("2.5 miles", 4023.36),
            ("~1540m", 1540.0),
            ("1540.5m", 1540.5),
            ("50km", 50000.0),
        ] {
            let got = parse_ui_length(text).unwrap_or(0.0);
            assert!((got - metres).abs() < 0.01, "{text:?} gave {got}");
        }
        for text in ["", "long", "-5", "km", "0", "  "] {
            assert_eq!(parse_ui_length(text), None, "{text:?}");
        }
    }

    #[test]
    fn reads_fields_out_of_json_that_is_not_quite_json() {
        let text =
            "{\n  \"name\": \"Monza\",\n  \"length\": \"5793\",\n  \"width\": 12,\n  \"pitboxes\": null,\n  \"bad\": \"tab\there\"\n";
        assert_eq!(json_field(text, "name").as_deref(), Some("Monza"));
        assert_eq!(json_field(text, "length").as_deref(), Some("5793"));
        assert_eq!(json_field(text, "width").as_deref(), Some("12"));
        assert_eq!(json_field(text, "pitboxes"), None);
        assert_eq!(json_field(text, "missing"), None);
    }

    #[test]
    fn reads_map_ini() {
        let text = "[PARAMETERS]\nWIDTH=927.422\nHEIGHT=1575.82\nMARGIN=20\nSCALE_FACTOR=1.4\nX_OFFSET=232.866\nZ_OFFSET=1297.7\nDRAWING_SIZE=10\n";
        let map = parse_map_ini(text).unwrap();
        assert_eq!((map.width, map.margin, map.scale, map.z_offset), (927.422, 20.0, 1.4, 1297.7));
        assert_eq!(parse_map_ini("WIDTH=1\n"), None);
        assert_eq!(parse_map_ini("WIDTH=0\nHEIGHT=1\nSCALE_FACTOR=1\nX_OFFSET=0\nZ_OFFSET=0\n"), None);
    }

    #[test]
    fn the_pit_lane_is_kept_when_it_lies_by_the_road_and_left_out_when_not() {
        let main = circle();
        // Pit lane: an arc of 30 m along the outside of the circle, 6 m wide.
        let near = synthetic(40, 105.0, 0.3, 3.0, 3.0);
        let found = extract_bytes(&main, Some(&near), "c", None, &Outside::default()).unwrap();
        let pit = found.track.pitlane.as_ref().expect("a pit lane near the road is kept");
        assert_eq!(pit.x.len(), 40);
        assert!(pit.left.iter().all(|v| (*v - 3.0).abs() < 1e-5));
        // Another layout's pit lane: 2 km away.
        let far = synthetic(40, 2000.0, 0.05, 3.0, 3.0);
        let found = extract_bytes(&main, Some(&far), "c", None, &Outside::default()).unwrap();
        assert!(found.track.pitlane.is_none());
        assert!(found.report.warnings.iter().any(|w| w.contains("another layout")));
        // A pit lane that is a stub or damaged is left out, never a failure of the track.
        let found = extract_bytes(&main, Some(&[3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "c", None, &Outside::default()).unwrap();
        assert!(found.track.pitlane.is_none());
    }

    #[test]
    fn finds_the_track_and_the_layout_from_a_folder() {
        let root = std::env::temp_dir().join(format!("xpeed-ac-layout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let make = |p: &str| std::fs::create_dir_all(root.join(p)).unwrap();
        make("tracks/monza/ai");
        make("tracks/monza/ui");
        make("tracks/ks_x/gp/ai");
        make("tracks/ks_x/ui/gp");
        make("tracks/ks_x/gp/ai/old");
        let single = layout_of_ai_dir(&root.join("tracks/monza/ai")).unwrap();
        assert_eq!((single.track.as_str(), single.variant.clone()), ("monza", None));
        let multi = layout_of_ai_dir(&root.join("tracks/ks_x/gp/ai")).unwrap();
        assert_eq!((multi.track.as_str(), multi.variant.as_deref()), ("ks_x", Some("gp")));
        let backup = layout_of_ai_dir(&root.join("tracks/ks_x/gp/ai/old")).unwrap();
        assert_eq!((backup.track.as_str(), backup.variant.as_deref()), ("ks_x", Some("gp")));
        assert_eq!(layout_of_ai_dir(&root.join("tracks")), None);
        std::fs::write(
            root.join("tracks/ks_x/ui/gp/ui_track.json"),
            "\u{feff}{\"name\": \"X GP\", \"length\": \"4.5 km\"}",
        )
        .unwrap();
        let outside = read_outside(&multi);
        assert_eq!(
            (outside.ui_title.as_deref(), outside.ui_length_raw.as_deref()),
            (Some("X GP"), Some("4.5 km"))
        );
        assert_eq!(read_outside(&single).ui_length_raw, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Every `fast_lane.ai` of the installed game, checked and tallied. Run it with
    /// `cargo test -- --ignored --nocapture validates_every_installed_ac_track`; it does nothing when the game is not installed.
    #[test]
    #[ignore = "reads the installed game; run by hand"]
    fn validates_every_installed_ac_track() {
        use std::collections::BTreeMap;
        let Some(root) = crate::tracks::dump::game_folders("XPEED_AC_DIR", "assettocorsa", "content/tracks")
            .into_iter()
            .find(|p| p.is_dir())
        else {
            eprintln!("Assetto Corsa is not installed here: nothing to validate");
            return;
        };
        fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() && depth > 0 {
                    walk(&p, depth - 1, out);
                } else if p.file_name().is_some_and(|n| n == SOURCE) {
                    out.push(p);
                }
            }
        }
        let mut files = Vec::new();
        walk(&root, 4, &mut files);
        files.sort();
        let (mut accepted, mut backups_accepted, mut backups) = (0usize, 0usize, 0usize);
        let mut refused: BTreeMap<&'static str, Vec<String>> = BTreeMap::new();
        let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
        let (mut closed, mut open, mut with_pit, mut no_width, mut warned) = (0, 0, 0, 0, 0);
        let (mut widest, mut narrowest) = (0.0f32, f32::MAX);
        for file in &files {
            let ai_dir = file.parent().unwrap().to_path_buf();
            let Some(layout) = layout_of_ai_dir(&ai_dir) else { continue };
            let is_backup = !name_of(&ai_dir).eq_ignore_ascii_case("ai");
            backups += usize::from(is_backup);
            let label = format!(
                "{}/{}{}",
                layout.track,
                layout.variant.as_deref().unwrap_or("-"),
                if is_backup {
                    format!(" [{}]", name_of(&ai_dir))
                } else {
                    String::new()
                }
            );
            match extract(&layout) {
                Ok(found) => {
                    let t = &found.track;
                    // What is accepted must be a valid track file that reads back the same.
                    let bytes = pack(t).unwrap_or_else(|e| panic!("{label}: accepted but not writable: {e}"));
                    let again = pack(&unpack(&bytes).unwrap()).unwrap();
                    let first = bytes.iter().zip(&again).position(|(a, b)| a != b);
                    assert!(
                        bytes == again,
                        "{label}: reads back differently ({} and {} bytes, first difference at {first:?})",
                        bytes.len(),
                        again.len()
                    );
                    accepted += 1;
                    backups_accepted += usize::from(is_backup);
                    if t.closed {
                        closed += 1
                    } else {
                        open += 1
                    }
                    with_pit += usize::from(t.pitlane.is_some());
                    no_width += usize::from(t.center_kind == "game_line");
                    warned += usize::from(!found.report.warnings.is_empty());
                    for warning in &found.report.warnings {
                        *kinds.entry(warning.chars().take(48).collect::<String>()).or_default() += 1usize;
                        if warning.contains("the other way round") {
                            eprintln!("  sides doubtful: {label}: {}", &warning[..warning.find(':').unwrap_or(0)]);
                        }
                    }
                    let w = width_stats(&t.centerline.left, &t.centerline.right);
                    if w.known > 0 {
                        widest = widest.max(w.max);
                        narrowest = narrowest.min(w.min);
                    }
                }
                Err(refusal) => refused
                    .entry(refusal.code)
                    .or_default()
                    .push(format!("{label}: {}", refusal.message)),
            }
        }
        let refused_total: usize = refused.values().map(Vec::len).sum();
        eprintln!(
            "\nfast_lane.ai files: {}  (of which {backups} are backup copies in a sub-folder of ai/)",
            accepted + refused_total
        );
        eprintln!(
            "ACCEPTED: {accepted} ({backups_accepted} of them backups)  closed {closed}, open {open}, with pit lane {with_pit}, no road width {no_width}, with warnings {warned}"
        );
        eprintln!("whole-road width over the accepted tracks: {narrowest:.1} m (narrowest point) to {widest:.1} m (widest point)");
        for (kind, count) in &kinds {
            eprintln!("  warning x{count}: {kind}");
        }
        eprintln!("REFUSED: {refused_total}");
        for (code, list) in &refused {
            eprintln!("  {code}: {}", list.len());
            for line in list {
                eprintln!("      {line}");
            }
        }
        assert!(narrowest > 0.0 || accepted == no_width);
    }
}
