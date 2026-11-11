//! Track layout files (`.xtrk`): the real shape of a circuit, as the game itself describes it.
//!
//! A lap file holds the line one car drove. A track file holds the track: the centre line, how wide the road is on each
//! side of it (so its edges can be drawn), the game's ideal line and the pit lane. The byte layout is written down in
//! `docs/telemetria-virtual-2026-11-10/FORMATO-DE-PISTA.md`; the test `writes_the_golden_track_byte_for_byte` checks this
//! writer against the 564-byte vector in that document, so the two cannot drift apart unnoticed.
//!
//! Uncompressed layout, little-endian: `XTRK`, u16 version, u16 flags, u32 header length (a multiple of 4), the JSON
//! header padded with spaces, then the float32 columns of every section in the order the header lists them.
//!
//! Where the data comes from (only read, never written, and kept on the person's computer):
//!
//! * `ac`  Assetto Corsa: `ai/fast_lane.ai` and `ai/pit_lane.ai` of a track layout ([`ac`]);
//! * `sce` Stock Car Extreme, and any rFactor 1 engine game: the `.AIW` file of a track ([`aiw`]).
//!
//! The files are made by hand with `track-dump` ([`dump`]), and by themselves while the person drives ([`auto`]): the
//! layout of each track a game is on goes to the server once (and again when the game's files change).

use std::fmt;
use std::io::{Read, Write};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

pub mod ac;
pub mod aiw;
pub mod auto;
pub mod dump;
pub mod preview;

pub const MAGIC: &[u8; 4] = b"XTRK";
pub const VERSION: u16 = 1;
const PREAMBLE: usize = 12;
/// Most points in one section. The longest real track found is 66468 points (a 50 km hill climb).
pub const MAX_POINTS: usize = 200_000;
pub const MAX_UNPACKED: usize = 64 * 1024 * 1024;
const MAX_HEADER: usize = 64 * 1024;
/// The most a road can be wide on one side, in metres. Anything above is a measuring error, not a road.
pub const MAX_SIDE_M: f32 = 200.0;
/// How far apart the first and last point of a track that says it is closed may be, in metres.
pub const MAX_CLOSE_GAP_M: f64 = 50.0;
pub const MAX_LENGTH_M: f64 = 100_000.0;

pub const CENTERLINE: Section = Section {
    id: "centerline",
    channels: &["x", "y", "z", "dist", "left", "right"],
};
pub const FAST: Section = Section {
    id: "fast",
    channels: &["x", "z"],
};
pub const PITLANE: Section = Section {
    id: "pitlane",
    channels: &["x", "z", "left", "right"],
};
const SECTIONS: [Section; 3] = [CENTERLINE, FAST, PITLANE];

#[derive(Clone, Copy)]
pub struct Section {
    pub id: &'static str,
    pub channels: &'static [&'static str],
}

/// The centre line: where the middle of the road runs, with the road's width on each side of it.
#[derive(Debug, Clone, Default)]
pub struct Centerline {
    pub x: Vec<f32>,
    pub y: Vec<f32>,
    pub z: Vec<f32>,
    /// Metres along the lap, as the game counts them (from the start line).
    pub dist: Vec<f32>,
    /// Metres from the centre line to the left edge of the road. NaN when unknown (then `right` is NaN too).
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

/// The game's ideal line: one point for each point of the centre line.
#[derive(Debug, Clone, Default)]
pub struct Fast {
    pub x: Vec<f32>,
    pub z: Vec<f32>,
}

/// The pit lane: the path the game sends cars along, with the width on each side of that path when known.
#[derive(Debug, Clone, Default)]
pub struct Pitlane {
    pub x: Vec<f32>,
    pub z: Vec<f32>,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct Track {
    pub game: String,
    pub name: String,
    pub variant: Option<String>,
    /// A human name for the track, when the game ships one.
    pub title: Option<String>,
    /// The length of one lap (or of the whole road when it is not closed), in metres.
    pub length_m: Option<f64>,
    /// Which file the data came from: `fast_lane.ai`, `aiw`, ...
    pub source: String,
    /// Which axes the numbers are on; always the game's own world, the same one its telemetry reports.
    pub frame: String,
    pub closed: bool,
    /// What the centre line is: `edges_midpoint` (the middle between the edges) or `game_line` (the game's own line).
    pub center_kind: String,
    pub centerline: Centerline,
    pub fast: Option<Fast>,
    pub pitlane: Option<Pitlane>,
}

#[derive(Debug)]
pub struct TrackError {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for TrackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}
impl std::error::Error for TrackError {}

fn err<T>(code: &'static str, message: impl Into<String>) -> Result<T, TrackError> {
    Err(TrackError {
        code,
        message: message.into(),
    })
}

/// Why an extractor will not turn a game file into a track: the file is damaged, is not what it claims to be, or
/// disagrees with what the game says about the same track. Never a panic.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

pub fn refuse<T>(code: &'static str, message: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal {
        code,
        message: message.into(),
    })
}

/// What an extractor checked, for the person to read: every number that was compared, and every doubt.
#[derive(Debug, Clone, Default)]
pub struct Report {
    pub notes: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Extracted {
    pub track: Track,
    pub report: Report,
}

pub const CENTER_KINDS: [&str; 2] = ["edges_midpoint", "game_line"];

/// The frame sentence every extractor writes.
pub const FRAME: &str = "game world metres: x and z are the horizontal plane, y is up; the same numbers the game's telemetry reports";

// ---------------------------------------------------------------------------------------------
// Geometry shared by the writers, the preview and the readers of this crate.
// ---------------------------------------------------------------------------------------------

/// The unit vector pointing to the driver's left at every point of a line, in the (x, z) plane.
///
/// Normative (the document says the same): the tangent `t` is the direction from the previous point to the next one (the
/// ends of a line that is not closed use the point itself and its single neighbour); the left unit vector is `(t.z, -t.x)`.
pub fn left_units(x: &[f32], z: &[f32], closed: bool) -> Vec<(f64, f64)> {
    let n = x.len().min(z.len());
    let mut out = Vec::with_capacity(n);
    let mut last = (0.0, -1.0);
    for i in 0..n {
        let (a, b) = if closed {
            ((i + n - 1) % n, (i + 1) % n)
        } else {
            (i.saturating_sub(1), (i + 1).min(n - 1))
        };
        let (tx, tz) = (f64::from(x[b]) - f64::from(x[a]), f64::from(z[b]) - f64::from(z[a]));
        let len = tx.hypot(tz);
        if len > 1e-9 {
            last = (tz / len, -tx / len);
        }
        out.push(last);
    }
    out
}

/// The two edges of a line with widths: `(left x, left z, right x, right z)` for every point, NaN where the width is unknown.
pub fn edges(x: &[f32], z: &[f32], left: &[f32], right: &[f32], closed: bool) -> Vec<[f64; 4]> {
    let units = left_units(x, z, closed);
    (0..units.len())
        .map(|i| {
            let (lx, lz) = units[i];
            let (px, pz) = (f64::from(x[i]), f64::from(z[i]));
            let (l, r) = (f64::from(left[i]), f64::from(right[i]));
            [px + l * lx, pz + l * lz, px - r * lx, pz - r * lz]
        })
        .collect()
}

pub fn path_length(x: &[f32], z: &[f32]) -> f64 {
    (1..x.len().min(z.len()))
        .map(|i| (f64::from(x[i]) - f64::from(x[i - 1])).hypot(f64::from(z[i]) - f64::from(z[i - 1])))
        .sum()
}

/// The widest a side is believed to be when it comes from a game file, in metres. Sides up to 146 m were seen, but 99.8%
/// of the measured points of the installed Assetto Corsa tracks are within 50 m: the rest are gaps in the game's own data.
pub const MAX_BELIEVED_SIDE_M: f32 = 50.0;
/// Below this share of points with a usable width on both sides, a line is given no width at all.
pub const MIN_KNOWN_WIDTH_SHARE: f64 = 0.8;

/// The result of cleaning the side distances a game file gives.
#[derive(Debug, Clone, PartialEq)]
pub struct CleanWidths {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    /// Points that keep a width.
    pub known: usize,
    /// Median of the whole road width (left plus right) over the usable points, 0 when there is none.
    pub median_m: f32,
    /// False when too few points had a usable width (or the median is not a road): every width is then NaN.
    pub kept: bool,
}

/// A side is usable when it is a number above 0 and at most [`MAX_BELIEVED_SIDE_M`]; a point is usable when both its
/// sides are. Games write 0 where they did not measure. A line with too few usable points, or a median width that is
/// not a road (under 1.5 m or over 80 m), gets no width at all instead of a patchy one.
pub fn clean_widths(left: &[f32], right: &[f32]) -> CleanWidths {
    let usable =
        |l: f32, r: f32| l.is_finite() && r.is_finite() && 0.0 < l && l <= MAX_BELIEVED_SIDE_M && 0.0 < r && r <= MAX_BELIEVED_SIDE_M;
    let mut totals: Vec<f32> = left
        .iter()
        .zip(right)
        .filter(|(l, r)| usable(**l, **r))
        .map(|(l, r)| l + r)
        .collect();
    let known = totals.len();
    totals.sort_by(f32::total_cmp);
    let median_m = totals.get(known / 2).copied().unwrap_or(0.0);
    let kept = !left.is_empty() && known as f64 >= MIN_KNOWN_WIDTH_SHARE * left.len() as f64 && (1.5..=80.0).contains(&median_m);
    if kept {
        let (mut l2, mut r2) = (Vec::with_capacity(left.len()), Vec::with_capacity(left.len()));
        for (l, r) in left.iter().zip(right) {
            let ok = usable(*l, *r);
            l2.push(if ok { *l } else { f32::NAN });
            r2.push(if ok { *r } else { f32::NAN });
        }
        CleanWidths {
            left: l2,
            right: r2,
            known,
            median_m,
            kept,
        }
    } else {
        CleanWidths {
            left: vec![f32::NAN; left.len()],
            right: vec![f32::NAN; left.len()],
            known: 0,
            median_m,
            kept,
        }
    }
}

/// Moves a line that the game keeps its widths from (its ideal line or its waypoints, not always in the middle of the
/// road) to the middle between the two edges, where the widths are known. The new widths are equal on both sides.
/// Where the widths are unknown the point stays where the game put it.
pub fn to_edges_midpoint(x: &mut [f32], z: &mut [f32], left: &mut [f32], right: &mut [f32], closed: bool) {
    let units = left_units(x, z, closed);
    for i in 0..units.len() {
        if left[i].is_finite() && right[i].is_finite() {
            let shift = f64::from(left[i] - right[i]) / 2.0;
            x[i] = (f64::from(x[i]) + shift * units[i].0) as f32;
            z[i] = (f64::from(z[i]) + shift * units[i].1) as f32;
            let half = (left[i] + right[i]) / 2.0;
            left[i] = half;
            right[i] = half;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/// A length rounded to the centimetre, so that its text in the header is short and reads back to the same number.
pub fn round_cm(metres: f64) -> f64 {
    (metres * 100.0).round() / 100.0
}

/// A number as JavaScript's `JSON.stringify` writes it: whole numbers without a decimal point.
fn number(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{}", value)
    }
}

/// A JSON string the way `JSON.stringify` writes it.
fn string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn is_game_id(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
        && text.len() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn is_text(text: &str, max: usize) -> bool {
    let n = text.chars().count();
    (1..=max).contains(&n) && !text.chars().any(char::is_control)
}

/// The sections a track has, in the order of the file, with their columns.
fn columns(track: &Track) -> Vec<(Section, usize, Vec<&[f32]>)> {
    let c = &track.centerline;
    let mut out = vec![(CENTERLINE, c.x.len(), vec![&c.x[..], &c.y, &c.z, &c.dist, &c.left, &c.right])];
    if let Some(f) = &track.fast {
        out.push((FAST, f.x.len(), vec![&f.x[..], &f.z]));
    }
    if let Some(p) = &track.pitlane {
        out.push((PITLANE, p.x.len(), vec![&p.x[..], &p.z, &p.left, &p.right]));
    }
    out
}

fn header_json(track: &Track) -> String {
    let mut t = format!("\"name\":{}", string(&track.name));
    if let Some(variant) = &track.variant {
        t.push_str(&format!(",\"variant\":{}", string(variant)));
    }
    if let Some(title) = &track.title {
        t.push_str(&format!(",\"title\":{}", string(title)));
    }
    if let Some(length) = track.length_m {
        t.push_str(&format!(",\"lengthM\":{}", number(length)));
    }
    let sections: Vec<String> = columns(track)
        .iter()
        .map(|(section, count, _)| {
            let channels: Vec<String> = section.channels.iter().map(|c| string(c)).collect();
            format!(
                "{{\"id\":{},\"count\":{count},\"channels\":[{}]}}",
                string(section.id),
                channels.join(",")
            )
        })
        .collect();
    format!(
        "{{\"game\":{},\"track\":{{{t}}},\"source\":{},\"frame\":{},\"closed\":{},\"centerKind\":{},\"sections\":[{}]}}",
        string(&track.game),
        string(&track.source),
        string(&track.frame),
        track.closed,
        string(&track.center_kind),
        sections.join(",")
    )
}

/// Every rule a track file must keep, for what is written and for what is read.
pub fn check(track: &Track) -> Result<(), TrackError> {
    if !is_game_id(&track.game) {
        return err("bad_header", format!("game {:?} is not a valid id", track.game));
    }
    if !is_text(&track.name, 120) {
        return err("bad_header", "the track name needs 1 to 120 characters");
    }
    for (what, value, max) in [("variant", &track.variant, 120), ("title", &track.title, 120)] {
        if let Some(v) = value {
            if !is_text(v, max) {
                return err("bad_header", format!("the track {what} needs 1 to {max} characters"));
            }
        }
    }
    if let Some(length) = track.length_m {
        if !(length.is_finite() && length > 0.0 && length <= MAX_LENGTH_M) {
            return err("bad_header", "lengthM must be above 0 and at most 100000");
        }
    }
    if !is_text(&track.source, 64) || !is_text(&track.frame, 200) {
        return err("bad_header", "source needs 1 to 64 characters and frame 1 to 200");
    }
    if !CENTER_KINDS.contains(&track.center_kind.as_str()) {
        return err("bad_header", format!("centerKind {:?} is not known", track.center_kind));
    }

    let c = &track.centerline;
    let n = c.x.len();
    if !(2..=MAX_POINTS).contains(&n) {
        return err("bad_section", format!("the centre line has 2 to {MAX_POINTS} points, not {n}"));
    }
    if [&c.y, &c.z, &c.dist, &c.left, &c.right].iter().any(|column| column.len() != n) {
        return err("bad_section", "the columns of the centre line differ in length");
    }
    for i in 0..n {
        if ![c.x[i], c.y[i], c.z[i], c.dist[i]].iter().all(|v| v.is_finite()) {
            return err(
                "bad_data",
                format!("centre line point {i} has a position or distance that is not a number"),
            );
        }
        if c.dist[i] < 0.0 || (i > 0 && c.dist[i] < c.dist[i - 1]) {
            return err("bad_data", format!("the distance goes back at centre line point {i}"));
        }
    }
    check_widths("centre line", &c.left, &c.right)?;
    if track.closed {
        let gap = (f64::from(c.x[0]) - f64::from(c.x[n - 1])).hypot(f64::from(c.z[0]) - f64::from(c.z[n - 1]));
        if gap > MAX_CLOSE_GAP_M {
            return err(
                "bad_data",
                format!("the track says it is closed but its ends are {gap:.0} m apart (at most {MAX_CLOSE_GAP_M} m)"),
            );
        }
    }

    if let Some(f) = &track.fast {
        if f.x.len() != n || f.z.len() != n {
            return err("bad_section", "the fast line needs one point for each point of the centre line");
        }
        if f.x.iter().chain(&f.z).any(|v| !v.is_finite()) {
            return err("bad_data", "a fast line point is not a number");
        }
    }
    if let Some(p) = &track.pitlane {
        let m = p.x.len();
        if !(2..=MAX_POINTS).contains(&m) || [&p.z, &p.left, &p.right].iter().any(|column| column.len() != m) {
            return err(
                "bad_section",
                format!("the pit lane has 2 to {MAX_POINTS} points in every column, not {m}"),
            );
        }
        if p.x.iter().chain(&p.z).any(|v| !v.is_finite()) {
            return err("bad_data", "a pit lane point is not a number");
        }
        check_widths("pit lane", &p.left, &p.right)?;
    }
    Ok(())
}

/// A width is known on both sides (a number above 0 and at most [`MAX_SIDE_M`]) or on neither (both NaN).
fn check_widths(what: &str, left: &[f32], right: &[f32]) -> Result<(), TrackError> {
    for (i, (l, r)) in left.iter().zip(right).enumerate() {
        let ok = (l.is_nan() && r.is_nan()) || (0.0 < *l && *l <= MAX_SIDE_M && 0.0 < *r && *r <= MAX_SIDE_M);
        if !ok {
            return err(
                "bad_data",
                format!("{what} point {i}: the widths must both be unknown (NaN) or both above 0 and at most {MAX_SIDE_M}"),
            );
        }
    }
    Ok(())
}

/// Lays a track out as bytes (not yet compressed). Refuses a track the readers would refuse.
pub fn pack(track: &Track) -> Result<Vec<u8>, TrackError> {
    check(track)?;
    let text = header_json(track);
    let header_bytes = text.len().div_ceil(4) * 4;
    if header_bytes > MAX_HEADER {
        return err("bad_header", "the header is too large");
    }
    let sections = columns(track);
    let floats: usize = sections.iter().map(|(s, count, _)| s.channels.len() * count).sum();
    let mut out = Vec::with_capacity(PREAMBLE + header_bytes + floats * 4);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(header_bytes as u32).to_le_bytes());
    out.extend_from_slice(text.as_bytes());
    out.resize(PREAMBLE + header_bytes, b' ');
    for (_, _, cols) in &sections {
        for column in cols {
            for value in *column {
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    if out.len() > MAX_UNPACKED {
        return err("too_large", "the track is too large");
    }
    Ok(out)
}

/// The file as it is stored and sent: the track's bytes, gzip-compressed.
pub fn gzip(track: &Track) -> Result<Vec<u8>, TrackError> {
    let raw = pack(track)?;
    let mut encoder = GzEncoder::new(Vec::with_capacity(raw.len() / 2), Compression::default());
    encoder.write_all(&raw).map_err(|e| TrackError {
        code: "bad_gzip",
        message: e.to_string(),
    })?;
    encoder.finish().map_err(|e| TrackError {
        code: "bad_gzip",
        message: e.to_string(),
    })
}

// ---------------------------------------------------------------------------------------------
// Reading (strict: the bytes come from outside)
// ---------------------------------------------------------------------------------------------

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn text_of(value: &serde_json::Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// Reads bytes laid out by [`pack`]. Every size is checked before any memory is reserved.
pub fn unpack(bytes: &[u8]) -> Result<Track, TrackError> {
    if bytes.len() < PREAMBLE {
        return err("bad_length", "the file is too short");
    }
    if &bytes[0..4] != MAGIC {
        return err("bad_magic", "not a track file");
    }
    if u16_at(bytes, 4) != VERSION {
        return err("bad_version", format!("unsupported track file version {}", u16_at(bytes, 4)));
    }
    if u16_at(bytes, 6) != 0 {
        return err("bad_flags", "unknown flags");
    }
    let header_bytes = u32_at(bytes, 8) as usize;
    if header_bytes == 0 || !header_bytes.is_multiple_of(4) || header_bytes > MAX_HEADER || PREAMBLE + header_bytes > bytes.len() {
        return err("bad_length", "the header length is not valid");
    }
    let header: serde_json::Value = serde_json::from_slice(&bytes[PREAMBLE..PREAMBLE + header_bytes]).map_err(|e| TrackError {
        code: "bad_header",
        message: format!("the header is not valid JSON: {e}"),
    })?;

    let list = header["sections"].as_array().ok_or_else(|| TrackError {
        code: "bad_header",
        message: "sections is missing".into(),
    })?;
    if list.is_empty() || list.len() > SECTIONS.len() {
        return err("bad_section", "a track has 1 to 3 sections");
    }
    // The sections come in the fixed order centerline, fast, pitlane, each at most once.
    let mut counts: Vec<(Section, usize)> = Vec::new();
    let mut next = 0;
    for entry in list {
        let id = entry["id"].as_str().unwrap_or("");
        let at = SECTIONS[next..].iter().position(|s| s.id == id).ok_or_else(|| TrackError {
            code: "bad_section",
            message: format!("section {id:?} is unknown, repeated or out of order"),
        })?;
        let section = SECTIONS[next + at];
        next += at + 1;
        let want: Vec<&str> = section.channels.to_vec();
        let have: Vec<&str> = entry["channels"]
            .as_array()
            .map(|a| a.iter().map(|c| c.as_str().unwrap_or("")).collect())
            .unwrap_or_default();
        if want != have {
            return err("bad_section", format!("section {id} must have the channels {want:?}"));
        }
        let count = entry["count"].as_u64().unwrap_or(0) as usize;
        if !(2..=MAX_POINTS).contains(&count) {
            return err("bad_section", format!("section {id} has 2 to {MAX_POINTS} points, not {count}"));
        }
        counts.push((section, count));
    }
    if counts[0].0.id != CENTERLINE.id {
        return err("bad_section", "the first section must be the centre line");
    }
    let floats: usize = counts.iter().map(|(s, count)| s.channels.len() * count).sum();
    if bytes.len() != PREAMBLE + header_bytes + floats * 4 {
        return err("bad_length", "the file size does not match its header");
    }

    let mut offset = PREAMBLE + header_bytes;
    let mut read = |count: usize| -> Vec<f32> {
        let column = bytes[offset..offset + count * 4]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| f32::from_le_bytes(*chunk))
            .collect();
        offset += count * 4;
        column
    };
    let mut centerline = Centerline::default();
    let mut fast = None;
    let mut pitlane = None;
    for (section, count) in &counts {
        match section.id {
            "centerline" => {
                centerline = Centerline {
                    x: read(*count),
                    y: read(*count),
                    z: read(*count),
                    dist: read(*count),
                    left: read(*count),
                    right: read(*count),
                }
            }
            "fast" => {
                fast = Some(Fast {
                    x: read(*count),
                    z: read(*count),
                })
            }
            _ => {
                pitlane = Some(Pitlane {
                    x: read(*count),
                    z: read(*count),
                    left: read(*count),
                    right: read(*count),
                })
            }
        }
    }

    let t = &header["track"];
    let track = Track {
        game: text_of(&header["game"]).unwrap_or_default(),
        name: text_of(&t["name"]).unwrap_or_default(),
        variant: text_of(&t["variant"]),
        title: text_of(&t["title"]),
        length_m: t["lengthM"].as_f64(),
        source: text_of(&header["source"]).unwrap_or_default(),
        frame: text_of(&header["frame"]).unwrap_or_default(),
        closed: header["closed"].as_bool().ok_or_else(|| TrackError {
            code: "bad_header",
            message: "closed must be true or false".into(),
        })?,
        center_kind: text_of(&header["centerKind"]).unwrap_or_default(),
        centerline,
        fast,
        pitlane,
    };
    check(&track)?;
    Ok(track)
}

/// Reads a track from what was stored. `max_bytes` caps the unzipped size, so a small file that unzips to gigabytes is
/// stopped while it is being read.
pub fn gunzip(bytes: &[u8], max_bytes: usize) -> Result<Track, TrackError> {
    let mut raw = Vec::new();
    let cap = max_bytes.min(MAX_UNPACKED);
    let read = GzDecoder::new(bytes)
        .take(cap as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|_| TrackError {
            code: "bad_gzip",
            message: "the file is not valid gzip data".into(),
        })?;
    if read > cap {
        return err("too_large", "the file is too large once unzipped");
    }
    unpack(&raw)
}

// ---------------------------------------------------------------------------------------------
// What a track holds, in a few lines
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WidthStats {
    pub known: usize,
    pub of: usize,
    pub min: f32,
    pub avg: f32,
    pub max: f32,
}

/// The whole width of the road (left plus right) over the points where it is known.
pub fn width_stats(left: &[f32], right: &[f32]) -> WidthStats {
    let mut stats = WidthStats {
        known: 0,
        of: left.len(),
        min: f32::INFINITY,
        avg: 0.0,
        max: f32::NEG_INFINITY,
    };
    let mut sum = 0.0f64;
    for (l, r) in left.iter().zip(right) {
        if l.is_finite() && r.is_finite() {
            let w = l + r;
            stats.known += 1;
            stats.min = stats.min.min(w);
            stats.max = stats.max.max(w);
            sum += f64::from(w);
        }
    }
    if stats.known > 0 {
        stats.avg = (sum / stats.known as f64) as f32;
    } else {
        stats.min = f32::NAN;
        stats.max = f32::NAN;
    }
    stats
}

impl Track {
    pub fn summary(&self) -> String {
        let c = &self.centerline;
        let n = c.x.len();
        let lap = c.dist.last().copied().unwrap_or(0.0);
        let mut out = String::new();
        out.push_str(&format!(
            "game        {}\ntrack       {}{}{}\nsource      {}\n",
            self.game,
            self.name,
            self.variant.as_ref().map_or(String::new(), |v| format!(" / {v}")),
            self.title.as_ref().map_or(String::new(), |t| format!(" ({t})")),
            self.source
        ));
        out.push_str(&format!(
            "road        {} points, {:.0} m on the game's own distance{}, {}\n",
            n,
            lap,
            self.length_m.map_or(String::new(), |m| format!(" (length {m:.0} m)")),
            if self.closed {
                "closed loop"
            } else {
                "not closed (point to point)"
            }
        ));
        let w = width_stats(&c.left, &c.right);
        if w.known == 0 {
            out.push_str("width       unknown\n");
        } else {
            out.push_str(&format!(
                "width       {:.1} / {:.1} / {:.1} m (min / avg / max of the whole road), known at {} of {} points\n",
                w.min, w.avg, w.max, w.known, w.of
            ));
        }
        out.push_str(&format!(
            "fast line   {}\n",
            self.fast.as_ref().map_or("none".to_owned(), |f| format!("{} points", f.x.len()))
        ));
        match &self.pitlane {
            Some(p) => {
                let pw = width_stats(&p.left, &p.right);
                out.push_str(&format!(
                    "pit lane    {} points, {:.0} m, width {}\n",
                    p.x.len(),
                    path_length(&p.x, &p.z),
                    if pw.known == 0 {
                        "unknown".to_owned()
                    } else {
                        format!("{:.1} m on average", pw.avg)
                    }
                ));
            }
            None => out.push_str("pit lane    none\n"),
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same bytes the document shows, laid out by a separate script (`FORMATO-DE-PISTA.md`).
    const GOLDEN_HEX: &str = include_str!("golden.hex");

    pub(crate) fn golden_track() -> Track {
        Track {
            game: "ac".into(),
            name: "Test Track".into(),
            variant: Some("GP".into()),
            title: None,
            length_m: Some(40.0),
            source: "fast_lane.ai".into(),
            frame: "game world metres, x and z horizontal, y up".into(),
            closed: true,
            center_kind: "edges_midpoint".into(),
            centerline: Centerline {
                x: vec![0.0, 10.0, 10.0, 0.0],
                y: vec![0.0, 0.0, 0.0, 0.0],
                z: vec![0.0, 0.0, 10.0, 10.0],
                dist: vec![0.0, 10.0, 20.0, 30.0],
                left: vec![5.0, 5.0, 5.0, f32::NAN],
                right: vec![5.0, 5.0, 5.0, f32::NAN],
            },
            fast: Some(Fast {
                x: vec![1.0, 9.0, 9.0, 1.0],
                z: vec![1.0, 1.0, 9.0, 9.0],
            }),
            pitlane: Some(Pitlane {
                x: vec![0.0, 10.0],
                z: vec![-8.0, -8.0],
                left: vec![f32::NAN, f32::NAN],
                right: vec![f32::NAN, f32::NAN],
            }),
        }
    }

    pub(crate) fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
    pub(crate) fn from_hex(text: &str) -> Vec<u8> {
        let text = text.trim();
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn writes_the_golden_track_byte_for_byte() {
        let bytes = pack(&golden_track()).unwrap();
        assert_eq!(bytes.len(), 564);
        assert_eq!(hex(&bytes), GOLDEN_HEX.trim());
    }

    #[test]
    fn reads_the_golden_bytes_back() {
        let track = unpack(&from_hex(GOLDEN_HEX)).unwrap();
        assert_eq!(
            (track.game.as_str(), track.name.as_str(), track.variant.as_deref()),
            ("ac", "Test Track", Some("GP"))
        );
        assert_eq!(track.length_m, Some(40.0));
        assert!(track.closed && track.title.is_none());
        assert_eq!(track.centerline.x, vec![0.0, 10.0, 10.0, 0.0]);
        assert_eq!(track.centerline.dist, vec![0.0, 10.0, 20.0, 30.0]);
        assert_eq!(&track.centerline.left[..3], &[5.0, 5.0, 5.0]);
        assert!(track.centerline.left[3].is_nan() && track.centerline.right[3].is_nan());
        assert_eq!(track.fast.as_ref().unwrap().x, vec![1.0, 9.0, 9.0, 1.0]);
        let pit = track.pitlane.as_ref().unwrap();
        assert_eq!((pit.x.clone(), pit.z.clone()), (vec![0.0, 10.0], vec![-8.0, -8.0]));
        assert!(pit.left.iter().all(|v| v.is_nan()));
    }

    #[test]
    fn round_trips_through_bytes_and_gzip() {
        let track = golden_track();
        let bytes = pack(&track).unwrap();
        assert_eq!(pack(&unpack(&bytes).unwrap()).unwrap(), bytes);
        let zipped = gzip(&track).unwrap();
        assert_eq!(&zipped[0..2], &[0x1f, 0x8b]);
        assert_eq!(pack(&gunzip(&zipped, MAX_UNPACKED).unwrap()).unwrap(), bytes);
    }

    #[test]
    fn leaves_out_the_sections_and_fields_that_are_not_given() {
        let mut track = golden_track();
        track.fast = None;
        track.pitlane = None;
        track.variant = None;
        track.length_m = None;
        let bytes = pack(&track).unwrap();
        let text = String::from_utf8_lossy(&bytes).to_string();
        assert!(!text.contains("variant") && !text.contains("lengthM") && !text.contains("pitlane") && !text.contains("\"fast\""));
        let back = unpack(&bytes).unwrap();
        assert!(back.fast.is_none() && back.pitlane.is_none() && back.variant.is_none());
    }

    #[test]
    fn writes_text_the_way_json_stringify_does() {
        assert_eq!(string("a\"b\\c\n\u{1}é"), "\"a\\\"b\\\\c\\n\\u0001é\"");
        assert_eq!(number(40.0), "40");
        assert_eq!(number(99.5), "99.5");
    }

    #[test]
    fn refuses_files_that_are_not_well_formed() {
        let good = from_hex(GOLDEN_HEX);
        assert_eq!(unpack(&good[..5]).unwrap_err().code, "bad_length");
        let mut magic = good.clone();
        magic[0] = b'Y';
        assert_eq!(unpack(&magic).unwrap_err().code, "bad_magic");
        let mut version = good.clone();
        version[4] = 2;
        assert_eq!(unpack(&version).unwrap_err().code, "bad_version");
        let mut flags = good.clone();
        flags[6] = 1;
        assert_eq!(unpack(&flags).unwrap_err().code, "bad_flags");
        assert_eq!(unpack(&good[..good.len() - 4]).unwrap_err().code, "bad_length");
        let mut extra = good.clone();
        extra.push(0);
        assert_eq!(unpack(&extra).unwrap_err().code, "bad_length");
        assert_eq!(gunzip(&[1, 2, 3, 4], MAX_UNPACKED).unwrap_err().code, "bad_gzip");
        // A header length that is not a multiple of 4, or longer than the file.
        let mut odd = good.clone();
        odd[8] = 0x5d;
        assert_eq!(unpack(&odd).unwrap_err().code, "bad_length");
        let mut huge = good.clone();
        huge[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(unpack(&huge).unwrap_err().code, "bad_length");
    }

    /// A file whose header says what the test needs, with the columns the header asks for (all zeros).
    fn file_with_header(header: &str, floats: usize) -> Vec<u8> {
        let padded = header.len().div_ceil(4) * 4;
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(padded as u32).to_le_bytes());
        out.extend_from_slice(header.as_bytes());
        out.resize(PREAMBLE + padded, b' ');
        out.resize(PREAMBLE + padded + floats * 4, 0);
        out
    }

    const CENTER_ONLY: &str = r#"{"game":"ac","track":{"name":"T"},"source":"s","frame":"f","closed":false,"centerKind":"game_line","sections":[{"id":"centerline","count":COUNT,"channels":["x","y","z","dist","left","right"]}]}"#;

    #[test]
    fn never_panics_when_any_byte_of_a_good_file_is_changed() {
        let good = from_hex(GOLDEN_HEX);
        for at in 0..good.len() {
            for value in [0x00, 0xff, 0x7f, 0x80, 0x20] {
                let mut bytes = good.clone();
                bytes[at] = value;
                let _ = unpack(&bytes);
            }
        }
        for len in 0..good.len() {
            let _ = unpack(&good[..len]);
        }
    }

    #[test]
    fn refuses_absurd_counts_before_reserving_memory() {
        // Four billion points: refused from the header alone (the file is a few hundred bytes).
        for count in ["4294967295", "200001", "1", "0", "-3"] {
            let bytes = file_with_header(&CENTER_ONLY.replace("COUNT", count), 6);
            assert_eq!(unpack(&bytes).unwrap_err().code, "bad_section", "count {count}");
        }
        // A count that is allowed but whose columns are missing from the file.
        let bytes = file_with_header(&CENTER_ONLY.replace("COUNT", "100"), 6);
        assert_eq!(unpack(&bytes).unwrap_err().code, "bad_length");
        // ...and one that fits is read (all zeros: a flat line at the origin that never moves, whose widths are zero).
        let ok = file_with_header(&CENTER_ONLY.replace("COUNT", "2"), 12);
        assert_eq!(unpack(&ok).unwrap_err().code, "bad_data");
    }

    #[test]
    fn refuses_sections_that_are_unknown_repeated_or_out_of_order() {
        let c = r#"{"id":"centerline","count":2,"channels":["x","y","z","dist","left","right"]}"#;
        let f = r#"{"id":"fast","count":2,"channels":["x","z"]}"#;
        let wrap = |sections: &str| {
            format!(
                r#"{{"game":"ac","track":{{"name":"T"}},"source":"s","frame":"f","closed":false,"centerKind":"game_line","sections":[{sections}]}}"#
            )
        };
        for sections in [
            format!("{f},{c}"),
            format!("{c},{c}"),
            format!("{c},{f},{f}"),
            r#"{"id":"centerline","count":2,"channels":["x","z"]}"#.to_owned(),
            r#"{"id":"walls","count":2,"channels":["x","z"]}"#.to_owned(),
            String::new(),
        ] {
            let bytes = file_with_header(&wrap(&sections), 40);
            assert_eq!(unpack(&bytes).unwrap_err().code, "bad_section", "{sections}");
        }
    }

    #[test]
    fn refuses_a_header_that_is_not_json_or_lacks_fields() {
        let bytes = file_with_header("not json at all", 0);
        assert_eq!(unpack(&bytes).unwrap_err().code, "bad_header");
        let bytes = file_with_header(r#"{"game":"ac"}"#, 0);
        assert_eq!(unpack(&bytes).unwrap_err().code, "bad_header");
    }

    #[test]
    fn refuses_tracks_with_bad_values() {
        let nan = |edit: &dyn Fn(&mut Track)| {
            let mut track = golden_track();
            edit(&mut track);
            track
        };
        let cases: Vec<(&str, Track)> = vec![
            ("NaN position", nan(&|t| t.centerline.x[1] = f32::NAN)),
            ("infinite height", nan(&|t| t.centerline.y[1] = f32::INFINITY)),
            ("NaN distance", nan(&|t| t.centerline.dist[2] = f32::NAN)),
            ("distance goes back", nan(&|t| t.centerline.dist[2] = 5.0)),
            ("negative distance", nan(&|t| t.centerline.dist[0] = -1.0)),
            ("one side unknown", nan(&|t| t.centerline.left[0] = f32::NAN)),
            ("negative width", nan(&|t| t.centerline.left[0] = -2.0)),
            ("zero width", nan(&|t| t.centerline.right[0] = 0.0)),
            ("absurd width", nan(&|t| t.centerline.left[0] = 500.0)),
            (
                "fast line too short",
                nan(&|t| {
                    t.fast.as_mut().unwrap().x.pop();
                }),
            ),
            ("NaN fast point", nan(&|t| t.fast.as_mut().unwrap().z[0] = f32::NAN)),
            ("NaN pit point", nan(&|t| t.pitlane.as_mut().unwrap().x[0] = f32::NAN)),
            (
                "one pit point",
                nan(&|t| {
                    *t.pitlane.as_mut().unwrap() = Pitlane {
                        x: vec![0.0],
                        z: vec![0.0],
                        left: vec![f32::NAN],
                        right: vec![f32::NAN],
                    }
                }),
            ),
            ("pit width half known", nan(&|t| t.pitlane.as_mut().unwrap().left[0] = 2.0)),
            ("closed but ends 100 m apart", nan(&|t| t.centerline.x[3] = 100.0)),
            ("bad game id", nan(&|t| t.game = "Assetto Corsa".into())),
            ("empty name", nan(&|t| t.name = String::new())),
            ("long name", nan(&|t| t.name = "x".repeat(121))),
            ("zero length", nan(&|t| t.length_m = Some(0.0))),
            ("NaN length", nan(&|t| t.length_m = Some(f64::NAN))),
            ("unknown centre kind", nan(&|t| t.center_kind = "middle".into())),
            (
                "one point",
                nan(&|t| {
                    t.centerline = Centerline {
                        x: vec![0.0],
                        y: vec![0.0],
                        z: vec![0.0],
                        dist: vec![0.0],
                        left: vec![1.0],
                        right: vec![1.0],
                    }
                }),
            ),
        ];
        for (what, track) in cases {
            assert!(pack(&track).is_err(), "the writer should refuse: {what}");
        }
        // The reader refuses the same things when they come from outside: patch a good file's NaN into a position.
        let mut bytes = from_hex(GOLDEN_HEX);
        let header = u32_at(&bytes, 8) as usize;
        let first_x = PREAMBLE + header;
        bytes[first_x..first_x + 4].copy_from_slice(&f32::NAN.to_le_bytes());
        assert_eq!(unpack(&bytes).unwrap_err().code, "bad_data");
        // An open track may have ends far apart.
        let mut open = golden_track();
        open.closed = false;
        open.centerline.x[3] = 100.0;
        assert!(pack(&open).is_ok());
    }

    #[test]
    fn stops_a_small_file_that_unzips_to_something_huge() {
        let n = 150_000;
        let line = Centerline {
            x: (0..n).map(|i| i as f32).collect(),
            y: vec![0.0; n],
            z: vec![0.0; n],
            dist: (0..n).map(|i| i as f32).collect(),
            left: vec![5.0; n],
            right: vec![5.0; n],
        };
        let mut track = golden_track();
        track.closed = false;
        track.centerline = line;
        track.fast = None;
        track.pitlane = None;
        let zipped = gzip(&track).unwrap();
        assert!(zipped.len() < 1_500_000);
        assert_eq!(gunzip(&zipped, 1024 * 1024).unwrap_err().code, "too_large");
        assert!(gunzip(&zipped, MAX_UNPACKED).is_ok());
    }

    #[test]
    fn left_is_the_drivers_left_in_the_documented_plane() {
        // Heading to +x: left is (0, -1). Heading to +z: left is (1, 0). The ends of an open line use one neighbour.
        let units = left_units(&[0.0, 1.0, 2.0], &[0.0, 0.0, 0.0], false);
        assert!(units.iter().all(|(lx, lz)| lx.abs() < 1e-9 && (lz + 1.0).abs() < 1e-9));
        let units = left_units(&[0.0, 0.0, 0.0], &[0.0, 1.0, 2.0], false);
        assert!(units.iter().all(|(lx, lz)| (lx - 1.0).abs() < 1e-9 && lz.abs() < 1e-9));
        let e = edges(&[0.0, 1.0, 2.0], &[0.0, 0.0, 0.0], &[3.0; 3], &[2.0; 3], false);
        assert_eq!(e[1], [1.0, -3.0, 1.0, 2.0]);
    }

    #[test]
    fn summarises_a_track() {
        let text = golden_track().summary();
        assert!(text.contains("4 points") && text.contains("closed loop") && text.contains("10.0 / 10.0 / 10.0 m"));
        assert!(text.contains("known at 3 of 4 points") && text.contains("pit lane    2 points, 10 m, width unknown"));
        assert_eq!(width_stats(&[f32::NAN], &[f32::NAN]).known, 0);
    }
}
