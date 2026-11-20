//! Lap files: one lap of one car, every channel sampled at the same moments.
//!
//! The same byte layout the app reads (`docs/telemetria-virtual-2026-11-10/FORMATO-DE-VOLTA.md`,
//! `src/lib/sim/lap-file.ts`). The tests `writes_the_golden_lap_byte_for_byte` and
//! `writes_the_golden_version_2_lap_byte_for_byte` check this writer against the 396-byte (version 1) and
//! 648-byte (version 2) vectors in that spec, so the two programs cannot drift apart unnoticed.
//!
//! Uncompressed layout, little-endian: `XLAP`, u16 version, u16 flags, u32 header length (a
//! multiple of 4), the JSON header padded with spaces, then one float32 column per channel.
//!
//! The writer writes version 2 (the session, the weather, the tyres, in and out lap, and more channels); the reader
//! reads versions 1 and 2.

use std::fmt;
use std::io::{Read, Write};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

pub const MAGIC: &[u8; 4] = b"XLAP";
/// The version new files are written in.
pub const VERSION: u16 = 2;
/// The versions `unpack` reads.
const VERSIONS: [u16; 2] = [1, 2];
const PREAMBLE: usize = 12;
pub const MAX_SAMPLES: usize = 500_000;
pub const MAX_CHANNELS: usize = 128;
pub const MAX_UNPACKED: usize = 64 * 1024 * 1024;
const MAX_HEADER: usize = 64 * 1024;

/// The channels the app knows, each with the one unit it must be stored in.
pub const STANDARD_UNITS: &[(&str, &str)] = &[
    ("t", "s"),
    ("dist", "m"),
    ("speed", "m/s"),
    ("rpm", "rpm"),
    ("gear", "gear"),
    ("throttle", "ratio"),
    ("brake", "ratio"),
    ("clutch", "ratio"),
    ("steer", "ratio"),
    ("x", "m"),
    ("y", "m"),
    ("z", "m"),
    ("fuel", "l"),
    // Version 2. Each is in a file only when the game gives it. The wheels are named fl, fr, rl, rr: front left,
    // front right, rear left, rear right.
    ("tyre_temp_fl", "\u{b0}C"),
    ("tyre_temp_fr", "\u{b0}C"),
    ("tyre_temp_rl", "\u{b0}C"),
    ("tyre_temp_rr", "\u{b0}C"),
    ("tyre_press_fl", "kPa"),
    ("tyre_press_fr", "kPa"),
    ("tyre_press_rl", "kPa"),
    ("tyre_press_rr", "kPa"),
    ("tyre_wear_fl", "ratio"),
    ("tyre_wear_fr", "ratio"),
    ("tyre_wear_rl", "ratio"),
    ("tyre_wear_rr", "ratio"),
    ("brake_temp_fl", "\u{b0}C"),
    ("brake_temp_fr", "\u{b0}C"),
    ("brake_temp_rl", "\u{b0}C"),
    ("brake_temp_rr", "\u{b0}C"),
    ("g_lat", "g"),
    ("g_long", "g"),
    ("damage_body", "ratio"),
    ("drs", "state"),
    ("tc_active", "flag"),
    ("abs_active", "flag"),
];

/// What kind of session the lap was driven in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionKind {
    Practice,
    Qualifying,
    Race,
    Unknown,
}

impl SessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionKind::Practice => "practice",
            SessionKind::Qualifying => "qualifying",
            SessionKind::Race => "race",
            SessionKind::Unknown => "unknown",
        }
    }

    fn parse(text: &str) -> Option<SessionKind> {
        match text {
            "practice" => Some(SessionKind::Practice),
            "qualifying" => Some(SessionKind::Qualifying),
            "race" => Some(SessionKind::Race),
            "unknown" => Some(SessionKind::Unknown),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Channel {
    pub id: String,
    pub unit: String,
    pub values: Vec<f32>,
}

/// Which program and which reader made a lap (the optional `recorder` object of the header). Written only when set, so
/// laps written before it existed, and the golden vectors, are byte for byte what they were.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Recorder {
    /// "xpeed-companion".
    pub app: String,
    /// The Companion's version (`CARGO_PKG_VERSION`).
    pub version: String,
    /// The short git hash the program was built from (`-dirty` with local changes).
    pub build: String,
    /// The reader family (or game id) that produced the lap.
    pub source: String,
    /// The game's own version string, when the reader knows it.
    pub game_build: Option<String>,
    /// Explicit reader coordinate contract, independent of release/build labels.
    pub coordinate_frame: Option<String>,
}

impl Recorder {
    /// This program, reading with `source`. Values the header would refuse (it takes short plain labels) are dropped
    /// or cut, so a stamp never costs a lap.
    pub fn current(source: &str, game_build: Option<&str>) -> Recorder {
        Recorder {
            app: "xpeed-companion".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            build: env!("XPEED_BUILD").into(),
            source: label(source, 32).unwrap_or_else(|| "unknown".into()),
            game_build: game_build.and_then(|text| label(text, 64)),
            coordinate_frame: (source == "acevo").then(|| "acevo-reflected-x-v1".into()),
        }
    }
}

/// The driving aids a lap was driven with (the optional `aids` object of the header, version 2, added without a version
/// bump like `recorder`). Each value is the HIGHEST setting seen at any moment of the lap, so a driver who turned
/// traction control off for the last corner still has TC on for that lap. A field is `None` (and left out of the file)
/// when the game does not give that aid, or did not give it on every moment of the lap: "unknown" is never written as
/// "off". A car without the aid (its maximum is 0) writes 0. The whole object is left out when nothing is known.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Aids {
    /// Highest traction control setting (0 is off), 0 to 100.
    pub tc_max: Option<u8>,
    /// Highest ABS setting, 0 to 100.
    pub abs_max: Option<u8>,
    /// Highest stability control, 0 (off) to 1 (full).
    pub stability: Option<f64>,
    pub auto_shift: Option<bool>,
    pub auto_clutch: Option<bool>,
    pub auto_blip: Option<bool>,
    pub ideal_line: Option<bool>,
}

/// The highest TC or ABS setting a header takes.
pub const MAX_AID_LEVEL: u8 = 100;

impl Aids {
    /// Nothing known: the header leaves the object out.
    pub fn is_empty(&self) -> bool {
        *self == Aids::default()
    }

    fn valid(&self) -> bool {
        self.tc_max.into_iter().chain(self.abs_max).all(|level| level <= MAX_AID_LEVEL)
            && self.stability.is_none_or(|v| v.is_finite() && (0.0..=1.0).contains(&v))
    }

    /// The JSON object text, keys in the one fixed order of the TypeScript writer.
    fn json(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if let Some(level) = self.tc_max {
            parts.push(format!("\"tcMax\":{level}"));
        }
        if let Some(level) = self.abs_max {
            parts.push(format!("\"absMax\":{level}"));
        }
        if let Some(share) = self.stability {
            parts.push(format!("\"stability\":{}", number(share)));
        }
        for (key, value) in [
            ("autoShift", self.auto_shift),
            ("autoClutch", self.auto_clutch),
            ("autoBlip", self.auto_blip),
            ("idealLine", self.ideal_line),
        ] {
            if let Some(on) = value {
                parts.push(format!("\"{key}\":{on}"));
            }
        }
        format!("{{{}}}", parts.join(","))
    }

    /// Reads the object leniently (a wrong type is "not given"): the app checks it strictly, this reader only needs
    /// the laps this program wrote.
    fn from_json(object: &serde_json::Value) -> Option<Aids> {
        let object = object.as_object()?;
        let level = |key: &str| {
            object
                .get(key)
                .and_then(|v| v.as_u64())
                .and_then(|n| u8::try_from(n).ok())
                .filter(|n| *n <= MAX_AID_LEVEL)
        };
        let switch = |key: &str| object.get(key).and_then(|v| v.as_bool());
        let aids = Aids {
            tc_max: level("tcMax"),
            abs_max: level("absMax"),
            stability: object.get("stability").and_then(|v| v.as_f64()).filter(|v| (0.0..=1.0).contains(v)),
            auto_shift: switch("autoShift"),
            auto_clutch: switch("autoClutch"),
            auto_blip: switch("autoBlip"),
            ideal_line: switch("idealLine"),
        };
        (!aids.is_empty()).then_some(aids)
    }
}

/// `text` trimmed and cut to `max` UTF-16 units, or `None` when nothing usable is left.
fn label(text: &str, max: usize) -> Option<String> {
    let clean: String = text.trim().chars().filter(|c| *c as u32 > 0x1f && *c as u32 != 0x7f).collect();
    let mut out = String::new();
    let mut units = 0;
    for c in clean.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    let out = out.trim_end().to_string();
    (!out.is_empty()).then_some(out)
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Lap {
    pub game: String,
    pub track_name: String,
    pub track_variant: Option<String>,
    pub track_length_m: Option<f64>,
    pub car_name: String,
    pub car_class: Option<String>,
    /// Version 2: the names to show when `track_name` and `car_name` are a game's folder names (Assetto Corsa's
    /// `ks_laguna_seca`): "Laguna Seca". The names stay the lap's identity; the titles are only what people read
    /// (`names::fill`).
    pub track_title: Option<String>,
    pub car_title: Option<String>,
    pub lap_number: u32,
    pub time_ms: u32,
    pub valid: bool,
    pub sectors_ms: Option<Vec<u32>>,
    /// ISO 8601, UTC.
    pub started_at: String,
    pub sample_rate_hz: f64,
    /// Version 2: stable for one run of one game session (every lap of it carries the same one).
    pub session_id: Option<String>,
    pub session_kind: Option<SessionKind>,
    /// Version 2: a short word ("dry", "rain"); `None` when the game says nothing about the weather.
    pub weather: Option<String>,
    pub air_temp_c: Option<f64>,
    pub track_temp_c: Option<f64>,
    pub tyre_compound: Option<String>,
    /// Version 2: the lap began in the pit lane (`out_lap`) or ended in it (`in_lap`).
    pub in_lap: Option<bool>,
    pub out_lap: Option<bool>,
    /// Version 2: who recorded the lap (`sanity::prepare` fills it when a reader left it empty).
    pub recorder: Option<Recorder>,
    /// Version 2: the aids the lap was driven with, highest setting seen on the lap; `None` when nothing is known.
    pub aids: Option<Aids>,
    /// Version 2: the ids of the data checks (`sanity`) the lap failed; empty when it passed all of them.
    pub checks: Vec<String>,
    pub channels: Vec<Channel>,
}

#[derive(Debug)]
pub struct LapError(pub String);

impl fmt::Display for LapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for LapError {}

fn err<T>(message: impl Into<String>) -> Result<T, LapError> {
    Err(LapError(message.into()))
}

impl Lap {
    pub fn sample_count(&self) -> usize {
        self.channels.first().map_or(0, |channel| channel.values.len())
    }

    #[cfg(test)]
    pub fn channel(&self, id: &str) -> Option<&Channel> {
        self.channels.iter().find(|channel| channel.id == id)
    }
}

/// A number as JavaScript's `JSON.stringify` writes it: whole numbers without a decimal point.
fn number(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{}", value)
    }
}

/// A JSON string the way `JSON.stringify` writes it (short escapes, other control characters as \u00XX).
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

fn is_id(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
        && text.len() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// A short word or two with no control characters (what the app's reader calls a label); lengths count the way JavaScript does.
fn is_label(text: &str, max: usize) -> bool {
    !text.is_empty() && text.encode_utf16().count() <= max && text.chars().all(|c| c as u32 > 0x1f && c as u32 != 0x7f)
}

fn is_session_id(text: &str) -> bool {
    (1..=64).contains(&text.len()) && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_temperature(value: f64) -> bool {
    value.is_finite() && (-100.0..=200.0).contains(&value)
}

/// The header with the keys in the one fixed order writers use, so equal laps give equal bytes. Version 1 leaves out
/// what only version 2 has.
fn header_json(lap: &Lap, sample_count: usize, version: u16) -> String {
    let title = |title: &Option<String>| {
        title
            .as_deref()
            .filter(|t| version >= 2 && is_label(t, 120))
            .map(|t| format!(",\"title\":{}", string(t)))
    };
    let mut track = format!("\"name\":{}", string(&lap.track_name));
    track.extend(title(&lap.track_title));
    if let Some(variant) = &lap.track_variant {
        track.push_str(&format!(",\"variant\":{}", string(variant)));
    }
    if let Some(length) = lap.track_length_m {
        track.push_str(&format!(",\"lengthM\":{}", number(length)));
    }
    let mut car = format!("\"name\":{}", string(&lap.car_name));
    car.extend(title(&lap.car_title));
    if let Some(class) = &lap.car_class {
        car.push_str(&format!(",\"class\":{}", string(class)));
    }
    let mut lap_json = format!("\"number\":{},\"timeMs\":{},\"valid\":{}", lap.lap_number, lap.time_ms, lap.valid);
    if let Some(sectors) = &lap.sectors_ms {
        let list: Vec<String> = sectors.iter().map(|ms| ms.to_string()).collect();
        lap_json.push_str(&format!(",\"sectorsMs\":[{}]", list.join(",")));
    }
    if version >= 2 {
        if let Some(in_lap) = lap.in_lap {
            lap_json.push_str(&format!(",\"inLap\":{in_lap}"));
        }
        if let Some(out_lap) = lap.out_lap {
            lap_json.push_str(&format!(",\"outLap\":{out_lap}"));
        }
    }
    let mut session = String::new();
    if version >= 2 {
        if let Some(id) = &lap.session_id {
            session.push_str(&format!(",\"sessionId\":{}", string(id)));
        }
        if let Some(kind) = lap.session_kind {
            session.push_str(&format!(",\"sessionKind\":{}", string(kind.as_str())));
        }
        if let Some(weather) = &lap.weather {
            session.push_str(&format!(",\"weather\":{}", string(weather)));
        }
        if let Some(air) = lap.air_temp_c {
            session.push_str(&format!(",\"airTempC\":{}", number(air)));
        }
        if let Some(track) = lap.track_temp_c {
            session.push_str(&format!(",\"trackTempC\":{}", number(track)));
        }
        if let Some(compound) = &lap.tyre_compound {
            session.push_str(&format!(",\"tyreCompound\":{}", string(compound)));
        }
    }
    if version >= 2 {
        if let Some(aids) = lap.aids.as_ref().filter(|aids| !aids.is_empty()) {
            session.push_str(&format!(",\"aids\":{}", aids.json()));
        }
        if let Some(recorder) = &lap.recorder {
            let mut object = format!(
                "\"app\":{},\"version\":{},\"build\":{},\"source\":{}",
                string(&recorder.app),
                string(&recorder.version),
                string(&recorder.build),
                string(&recorder.source)
            );
            if let Some(game_build) = &recorder.game_build {
                object.push_str(&format!(",\"gameBuild\":{}", string(game_build)));
            }
            if let Some(frame) = &recorder.coordinate_frame {
                object.push_str(&format!(",\"coordinateFrame\":{}", string(frame)));
            }
            session.push_str(&format!(",\"recorder\":{{{object}}}"));
        }
        if !lap.checks.is_empty() {
            let list: Vec<String> = lap.checks.iter().map(|id| string(id)).collect();
            session.push_str(&format!(",\"checks\":[{}]", list.join(",")));
        }
    }
    let channels: Vec<String> = lap
        .channels
        .iter()
        .map(|c| format!("{{\"id\":{},\"unit\":{}}}", string(&c.id), string(&c.unit)))
        .collect();
    format!(
        "{{\"game\":{},\"track\":{{{}}},\"car\":{{{}}},\"lap\":{{{}}},\"startedAt\":{},\"sampleRateHz\":{},\"sampleCount\":{}{},\"channels\":[{}]}}",
        string(&lap.game),
        track,
        car,
        lap_json,
        string(&lap.started_at),
        number(lap.sample_rate_hz),
        sample_count,
        session,
        channels.join(",")
    )
}

/// Lays a lap out as bytes (not yet compressed), in the current version. Refuses a lap the app would refuse.
pub fn pack(lap: &Lap) -> Result<Vec<u8>, LapError> {
    pack_as(lap, VERSION)
}

/// `pack` in a given version: 1 writes the first version of the format (what Companion 0.4 wrote), which has none of
/// the version 2 header fields (they are left out); 2 is the current one.
pub fn pack_as(lap: &Lap, version: u16) -> Result<Vec<u8>, LapError> {
    if !VERSIONS.contains(&version) {
        return err(format!("cannot write lap file version {version}"));
    }
    let samples = lap.sample_count();
    if samples == 0 || samples > MAX_SAMPLES {
        return err(format!("a lap has 1 to {MAX_SAMPLES} samples, not {samples}"));
    }
    if lap.channels.len() < 2 || lap.channels.len() > MAX_CHANNELS {
        return err(format!("a lap has 2 to {MAX_CHANNELS} channels"));
    }
    let mut seen: Vec<&str> = Vec::new();
    for channel in &lap.channels {
        if !is_id(&channel.id) {
            return err(format!("channel id {:?} is not valid", channel.id));
        }
        if channel.unit.is_empty() || channel.unit.len() > 16 {
            return err(format!("channel {} needs a unit of 1 to 16 characters", channel.id));
        }
        if seen.contains(&channel.id.as_str()) {
            return err(format!("channel {} is listed twice", channel.id));
        }
        seen.push(&channel.id);
        if channel.values.len() != samples {
            return err(format!(
                "channel {} has {} values, expected {samples}",
                channel.id,
                channel.values.len()
            ));
        }
        if let Some((_, unit)) = STANDARD_UNITS.iter().find(|(id, _)| *id == channel.id) {
            if *unit != channel.unit {
                return err(format!("channel {} must be in {unit}, not {}", channel.id, channel.unit));
            }
        }
    }
    for required in ["t", "dist"] {
        if !seen.contains(&required) {
            return err(format!("channel {required} is required"));
        }
    }
    if lap.track_name.is_empty() || lap.car_name.is_empty() {
        return err("the track and car names are required");
    }
    if version >= 2 {
        if lap.session_id.as_deref().is_some_and(|id| !is_session_id(id)) {
            return err("the session id must be 1 to 64 letters, digits, _ or -");
        }
        if lap.weather.as_deref().is_some_and(|text| !is_label(text, 32)) {
            return err("the weather must be a short text");
        }
        if lap.tyre_compound.as_deref().is_some_and(|text| !is_label(text, 40)) {
            return err("the tyre compound must be a short text");
        }
        if lap.air_temp_c.into_iter().chain(lap.track_temp_c).any(|t| !is_temperature(t)) {
            return err("the temperatures must be -100 to 200");
        }
        if let Some(recorder) = &lap.recorder {
            let plain = |text: &str, max: usize| is_label(text, max) && text.is_ascii();
            if !(plain(&recorder.app, 32)
                && plain(&recorder.version, 24)
                && plain(&recorder.build, 40)
                && is_label(&recorder.source, 32)
                && recorder.game_build.as_deref().is_none_or(|text| is_label(text, 64))
                && recorder.coordinate_frame.as_deref().is_none_or(|text| is_label(text, 64)))
            {
                return err("the recorder must be short plain labels");
            }
        }
        if lap.aids.as_ref().is_some_and(|aids| !aids.valid()) {
            return err("the aids must be settings 0 to 100 and a stability 0 to 1");
        }
        if lap.checks.len() > 16 || lap.checks.iter().any(|id| !is_id(id)) {
            return err("the checks must be up to 16 ids");
        }
    }

    let text = header_json(lap, samples, version);
    let header_bytes = text.len().div_ceil(4) * 4;
    if header_bytes > MAX_HEADER {
        return err("the header is too large");
    }
    let mut out = Vec::with_capacity(PREAMBLE + header_bytes + lap.channels.len() * samples * 4);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&version.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(header_bytes as u32).to_le_bytes());
    out.extend_from_slice(text.as_bytes());
    out.resize(PREAMBLE + header_bytes, b' ');
    for channel in &lap.channels {
        for value in &channel.values {
            out.extend_from_slice(&value.to_le_bytes());
        }
    }
    if out.len() > MAX_UNPACKED {
        return err("the lap is too large");
    }
    Ok(out)
}

/// The file as it is sent and stored: the lap's bytes, gzip-compressed.
pub fn gzip(lap: &Lap) -> Result<Vec<u8>, LapError> {
    let raw = pack(lap)?;
    let mut encoder = GzEncoder::new(Vec::with_capacity(raw.len() / 3), Compression::default());
    encoder.write_all(&raw).map_err(|e| LapError(e.to_string()))?;
    encoder.finish().map_err(|e| LapError(e.to_string()))
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Reads bytes laid out by `pack` (or by the app). Used by `inspect` and by the tests; the app
/// is the strict validator, this checks the structure and the sizes.
pub fn unpack(bytes: &[u8]) -> Result<Lap, LapError> {
    if bytes.len() < PREAMBLE {
        return err("the file is too short");
    }
    if &bytes[0..4] != MAGIC {
        return err("not a lap file");
    }
    if !VERSIONS.contains(&u16_at(bytes, 4)) {
        return err(format!("unsupported lap file version {}", u16_at(bytes, 4)));
    }
    if u16_at(bytes, 6) != 0 {
        return err("unknown flags");
    }
    let header_bytes = u32_at(bytes, 8) as usize;
    if header_bytes == 0 || !header_bytes.is_multiple_of(4) || header_bytes > MAX_HEADER || PREAMBLE + header_bytes > bytes.len() {
        return err("the header length is not valid");
    }
    let header: serde_json::Value = serde_json::from_slice(&bytes[PREAMBLE..PREAMBLE + header_bytes])
        .map_err(|e| LapError(format!("the header is not valid JSON: {e}")))?;

    let text = |value: &serde_json::Value| value.as_str().map(str::to_owned);
    let samples = header["sampleCount"].as_u64().unwrap_or(0) as usize;
    let list = header["channels"]
        .as_array()
        .ok_or_else(|| LapError("channels is missing".into()))?;
    if samples == 0 || samples > MAX_SAMPLES || list.len() < 2 || list.len() > MAX_CHANNELS {
        return err("the sample or channel count is not valid");
    }
    if bytes.len() != PREAMBLE + header_bytes + list.len() * samples * 4 {
        return err("the file size does not match its header");
    }

    let mut offset = PREAMBLE + header_bytes;
    let mut channels = Vec::with_capacity(list.len());
    for entry in list {
        let id = text(&entry["id"]).ok_or_else(|| LapError("a channel has no id".into()))?;
        let unit = text(&entry["unit"]).ok_or_else(|| LapError(format!("channel {id} has no unit")))?;
        let mut values = Vec::with_capacity(samples);
        for chunk in bytes[offset..offset + samples * 4].as_chunks::<4>().0 {
            values.push(f32::from_le_bytes(*chunk));
        }
        offset += samples * 4;
        channels.push(Channel { id, unit, values });
    }

    Ok(Lap {
        game: text(&header["game"]).unwrap_or_default(),
        track_name: text(&header["track"]["name"]).unwrap_or_default(),
        track_variant: text(&header["track"]["variant"]),
        track_length_m: header["track"]["lengthM"].as_f64(),
        car_name: text(&header["car"]["name"]).unwrap_or_default(),
        car_class: text(&header["car"]["class"]),
        track_title: text(&header["track"]["title"]),
        car_title: text(&header["car"]["title"]),
        lap_number: header["lap"]["number"].as_u64().unwrap_or(0) as u32,
        time_ms: header["lap"]["timeMs"].as_u64().unwrap_or(0) as u32,
        valid: header["lap"]["valid"].as_bool().unwrap_or(false),
        sectors_ms: header["lap"]["sectorsMs"]
            .as_array()
            .map(|items| items.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect()),
        started_at: text(&header["startedAt"]).unwrap_or_default(),
        sample_rate_hz: header["sampleRateHz"].as_f64().unwrap_or(0.0),
        session_id: text(&header["sessionId"]),
        session_kind: header["sessionKind"].as_str().and_then(SessionKind::parse),
        weather: text(&header["weather"]),
        air_temp_c: header["airTempC"].as_f64(),
        track_temp_c: header["trackTempC"].as_f64(),
        tyre_compound: text(&header["tyreCompound"]),
        in_lap: header["lap"]["inLap"].as_bool(),
        out_lap: header["lap"]["outLap"].as_bool(),
        aids: Aids::from_json(&header["aids"]),
        recorder: header["recorder"].as_object().map(|object| {
            let get = |key: &str| object.get(key).and_then(|v| v.as_str()).map(str::to_owned);
            Recorder {
                app: get("app").unwrap_or_default(),
                version: get("version").unwrap_or_default(),
                build: get("build").unwrap_or_default(),
                source: get("source").unwrap_or_default(),
                game_build: get("gameBuild"),
                coordinate_frame: get("coordinateFrame"),
            }
        }),
        checks: header["checks"]
            .as_array()
            .map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default(),
        channels,
    })
}

/// Reads a lap from what was stored. `max_bytes` caps the unzipped size, so a small file that
/// unzips to gigabytes is stopped while it is being read.
pub fn gunzip(bytes: &[u8], max_bytes: usize) -> Result<Lap, LapError> {
    let mut raw = Vec::new();
    let cap = max_bytes.min(MAX_UNPACKED);
    let read = GzDecoder::new(bytes)
        .take(cap as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|_| LapError("the file is not valid gzip data".into()))?;
    if read > cap {
        return err("the file is too large once unzipped");
    }
    unpack(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same bytes the app's tests hold in `src/lib/sim/lap-file.test.ts` and the spec shows,
    /// laid out by a separate script (`docs/telemetria-virtual-2026-11-10/golden-lap.mjs`). If this writer and the
    /// spec disagree, this test fails. This one is the lap of version 1.
    const GOLDEN_HEX: &str = "584c4150010000005c0100007b2267616d65223a226c6d75222c22747261636b223a7b226e616d65223a225465737420547261636b222c2276617269616e74223a224750222c226c656e6774684d223a32307d2c22636172223a7b226e616d65223a225465737420436172222c22636c617373223a224859504552434152227d2c226c6170223a7b226e756d626572223a312c2274696d654d73223a313030302c2276616c6964223a747275652c22736563746f72734d73223a5b3430302c3630305d7d2c22737461727465644174223a22323032362d31312d31305431323a30303a30302e3030305a222c2273616d706c6552617465487a223a322c2273616d706c65436f756e74223a332c226368616e6e656c73223a5b7b226964223a2274222c22756e6974223a2273227d2c7b226964223a2264697374222c22756e6974223a226d227d2c7b226964223a227370656564222c22756e6974223a226d2f73227d5d7d202020000000000000003f0000803f00000000000020410000a04100000000000020410000a041";

    /// The lap of version 2 of the spec: 648 bytes.
    const GOLDEN_V2_HEX: &str = "584c415002000000400200007b2267616d65223a226163222c22747261636b223a7b226e616d65223a225465737420547261636b222c2276617269616e74223a224750222c226c656e6774684d223a32307d2c22636172223a7b226e616d65223a225465737420436172222c22636c617373223a22475433227d2c226c6170223a7b226e756d626572223a322c2274696d654d73223a313030302c2276616c6964223a747275652c22736563746f72734d73223a5b3430302c3330302c3330305d2c22696e4c6170223a66616c73652c226f75744c6170223a747275657d2c22737461727465644174223a22323032362d31312d31305431323a30303a30302e3030305a222c2273616d706c6552617465487a223a322c2273616d706c65436f756e74223a332c2273657373696f6e4964223a226131623263336434653566363037313832393361346235633664376538663930222c2273657373696f6e4b696e64223a227072616374696365222c2277656174686572223a227261696e222c2261697254656d7043223a31382e352c22747261636b54656d7043223a32322c2274797265436f6d706f756e64223a22536f6674222c226368616e6e656c73223a5b7b226964223a2274222c22756e6974223a2273227d2c7b226964223a2264697374222c22756e6974223a226d227d2c7b226964223a227370656564222c22756e6974223a226d2f73227d2c7b226964223a22747972655f74656d705f666c222c22756e6974223a22c2b043227d2c7b226964223a22675f6c6174222c22756e6974223a2267227d5d7d20000000000000003f0000803f00000000000020410000a04100000000000020410000a0410000a0420000c07f0000a442000000000000003f000080bf";

    fn golden_v2_lap() -> Lap {
        let channel = |id: &str, unit: &str, values: [f32; 3]| Channel {
            id: id.into(),
            unit: unit.into(),
            values: values.to_vec(),
        };
        Lap {
            game: "ac".into(),
            track_name: "Test Track".into(),
            track_variant: Some("GP".into()),
            track_length_m: Some(20.0),
            car_name: "Test Car".into(),
            car_class: Some("GT3".into()),
            track_title: None,
            car_title: None,
            lap_number: 2,
            time_ms: 1000,
            valid: true,
            sectors_ms: Some(vec![400, 300, 300]),
            started_at: "2026-11-10T12:00:00.000Z".into(),
            sample_rate_hz: 2.0,
            session_id: Some("a1b2c3d4e5f60718293a4b5c6d7e8f90".into()),
            session_kind: Some(SessionKind::Practice),
            weather: Some("rain".into()),
            air_temp_c: Some(18.5),
            track_temp_c: Some(22.0),
            tyre_compound: Some("Soft".into()),
            in_lap: Some(false),
            out_lap: Some(true),
            recorder: None,
            aids: None,
            checks: Vec::new(),
            channels: vec![
                channel("t", "s", [0.0, 0.5, 1.0]),
                channel("dist", "m", [0.0, 10.0, 20.0]),
                channel("speed", "m/s", [0.0, 10.0, 20.0]),
                channel("tyre_temp_fl", "\u{b0}C", [80.0, f32::NAN, 82.0]),
                channel("g_lat", "g", [0.0, 0.5, -1.0]),
            ],
        }
    }

    fn golden_lap() -> Lap {
        let channel = |id: &str, unit: &str, values: [f32; 3]| Channel {
            id: id.into(),
            unit: unit.into(),
            values: values.to_vec(),
        };
        Lap {
            game: "lmu".into(),
            track_name: "Test Track".into(),
            track_variant: Some("GP".into()),
            track_length_m: Some(20.0),
            car_name: "Test Car".into(),
            car_class: Some("HYPERCAR".into()),
            lap_number: 1,
            time_ms: 1000,
            valid: true,
            sectors_ms: Some(vec![400, 600]),
            started_at: "2026-11-10T12:00:00.000Z".into(),
            sample_rate_hz: 2.0,
            channels: vec![
                channel("t", "s", [0.0, 0.5, 1.0]),
                channel("dist", "m", [0.0, 10.0, 20.0]),
                channel("speed", "m/s", [0.0, 10.0, 20.0]),
            ],
            ..Lap::default()
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
    fn from_hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn writes_the_golden_lap_byte_for_byte() {
        // The first version of the format, as Companion 0.4 wrote it.
        let bytes = pack_as(&golden_lap(), 1).unwrap();
        assert_eq!(bytes.len(), 396);
        assert_eq!(hex(&bytes), GOLDEN_HEX);
    }

    #[test]
    fn writes_the_golden_version_2_lap_byte_for_byte() {
        let bytes = pack(&golden_v2_lap()).unwrap();
        assert_eq!(bytes.len(), 648);
        assert_eq!(hex(&bytes), GOLDEN_V2_HEX);
        assert_eq!(&bytes[4..6], &2u16.to_le_bytes(), "new files are version 2");
    }

    #[test]
    fn reads_the_golden_version_2_bytes_back_into_the_same_lap() {
        let back = unpack(&from_hex(GOLDEN_V2_HEX)).unwrap();
        let want = golden_v2_lap();
        // NaN is not equal to itself: compare the columns by their bits.
        let bits = |lap: &Lap| -> Vec<Vec<u32>> {
            lap.channels
                .iter()
                .map(|c| c.values.iter().map(|v| v.to_bits()).collect())
                .collect()
        };
        assert_eq!(bits(&back), bits(&want));
        assert_eq!(
            (back.session_id, back.session_kind, back.weather, back.air_temp_c, back.track_temp_c),
            (want.session_id, want.session_kind, want.weather, want.air_temp_c, want.track_temp_c)
        );
        assert_eq!(
            (back.tyre_compound.as_deref(), back.in_lap, back.out_lap),
            (Some("Soft"), Some(false), Some(true))
        );
        assert_eq!(back.channels[3].unit, "\u{b0}C");
    }

    #[test]
    fn a_version_1_file_written_by_older_code_still_reads() {
        let back = unpack(&from_hex(GOLDEN_HEX)).unwrap();
        assert_eq!(back, golden_lap());
        assert!(back.session_id.is_none() && back.in_lap.is_none() && back.weather.is_none());
        // And the same lap, read and written again as version 1, gives the same bytes.
        assert_eq!(hex(&pack_as(&back, 1).unwrap()), GOLDEN_HEX);
        // Through gzip as well.
        let mut zipped = Vec::new();
        let mut encoder = GzEncoder::new(&mut zipped, Compression::default());
        encoder.write_all(&from_hex(GOLDEN_HEX)).unwrap();
        encoder.finish().unwrap();
        assert_eq!(gunzip(&zipped, MAX_UNPACKED).unwrap(), golden_lap());
    }

    #[test]
    fn version_1_leaves_out_the_version_2_fields() {
        let bytes = pack_as(&golden_v2_lap(), 1).unwrap();
        let text = String::from_utf8_lossy(&bytes).to_string();
        for key in [
            "sessionId",
            "sessionKind",
            "weather",
            "airTempC",
            "trackTempC",
            "tyreCompound",
            "inLap",
            "outLap",
        ] {
            assert!(!text.contains(key), "{key}");
        }
        assert!(pack_as(&golden_v2_lap(), 3).is_err());
        assert!(pack_as(&golden_v2_lap(), 0).is_err());
    }

    #[test]
    fn a_version_2_lap_round_trips_through_a_reader_written_here() {
        let mut lap = golden_v2_lap();
        // No NaN here, so the whole lap compares equal.
        lap.channels[3].values = vec![80.0, 81.0, 82.0];
        lap.session_kind = Some(SessionKind::Qualifying);
        assert_eq!(unpack(&pack(&lap).unwrap()).unwrap(), lap);
        assert_eq!(gunzip(&gzip(&lap).unwrap(), MAX_UNPACKED).unwrap(), lap);
        for kind in [
            SessionKind::Practice,
            SessionKind::Qualifying,
            SessionKind::Race,
            SessionKind::Unknown,
        ] {
            let mut other = lap.clone();
            other.session_kind = Some(kind);
            assert_eq!(unpack(&pack(&other).unwrap()).unwrap().session_kind, Some(kind));
        }
    }

    /// A reader written for this test alone: it shares nothing with `unpack` but `serde_json`. It reads a file the way
    /// the spec says, strictly, and gives back the header as JSON and the columns as bits.
    fn independent_reader(bytes: &[u8]) -> (serde_json::Value, Vec<(String, String, Vec<u32>)>) {
        assert_eq!(&bytes[0..4], b"XLAP");
        let version = u16::from_le_bytes([bytes[4], bytes[5]]);
        assert!(version == 1 || version == 2, "version {version}");
        assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), 0);
        let header_len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
        assert_eq!(header_len % 4, 0);
        let header_text = std::str::from_utf8(&bytes[12..12 + header_len]).expect("UTF-8");
        let header: serde_json::Value = serde_json::from_str(header_text).expect("JSON");
        let samples = header["sampleCount"].as_u64().unwrap() as usize;
        let channels = header["channels"].as_array().unwrap();
        assert_eq!(bytes.len(), 12 + header_len + channels.len() * samples * 4, "no byte more or less");
        let mut at = 12 + header_len;
        let mut columns = Vec::new();
        for channel in channels {
            let bits = (0..samples)
                .map(|i| u32::from_le_bytes(bytes[at + 4 * i..at + 4 * i + 4].try_into().unwrap()))
                .collect();
            columns.push((
                channel["id"].as_str().unwrap().to_owned(),
                channel["unit"].as_str().unwrap().to_owned(),
                bits,
            ));
            at += samples * 4;
        }
        (header, columns)
    }

    #[test]
    fn a_version_2_file_round_trips_through_a_reader_written_for_the_test() {
        let lap = golden_v2_lap();
        let bytes = pack(&lap).unwrap();
        let (header, columns) = independent_reader(&bytes);
        assert_eq!(header["game"], "ac");
        assert_eq!(header["lap"]["inLap"], false);
        assert_eq!(header["lap"]["outLap"], true);
        assert_eq!(header["lap"]["sectorsMs"], serde_json::json!([400, 300, 300]));
        assert_eq!(header["sessionId"], "a1b2c3d4e5f60718293a4b5c6d7e8f90");
        assert_eq!(header["sessionKind"], "practice");
        assert_eq!(header["weather"], "rain");
        assert_eq!(header["airTempC"], 18.5);
        assert_eq!(header["trackTempC"], 22);
        assert_eq!(header["tyreCompound"], "Soft");
        assert_eq!(columns.len(), lap.channels.len());
        for ((id, unit, bits), want) in columns.iter().zip(&lap.channels) {
            assert_eq!((id, unit), (&want.id, &want.unit));
            assert_eq!(bits, &want.values.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), "{id}");
        }
        // The same file as the old writer would have made it: version 1, no version 2 key.
        let (old_header, _) = independent_reader(&pack_as(&lap, 1).unwrap());
        assert!(old_header.get("sessionId").is_none() && old_header["lap"].get("inLap").is_none());
    }

    #[test]
    fn leaves_out_the_version_2_fields_that_are_not_given() {
        let mut lap = golden_v2_lap();
        lap.session_id = None;
        lap.session_kind = None;
        lap.weather = None;
        lap.air_temp_c = None;
        lap.track_temp_c = None;
        lap.tyre_compound = None;
        lap.in_lap = None;
        lap.out_lap = None;
        let text = String::from_utf8_lossy(&pack(&lap).unwrap()).to_string();
        for key in [
            "sessionId",
            "sessionKind",
            "weather",
            "airTempC",
            "trackTempC",
            "tyreCompound",
            "inLap",
            "outLap",
        ] {
            assert!(!text.contains(key), "{key}");
        }
    }

    #[test]
    fn refuses_version_2_fields_the_app_would_refuse() {
        let bad: [fn(&mut Lap); 8] = [
            |l| l.session_id = Some(String::new()),
            |l| l.session_id = Some("has a space".into()),
            |l| l.session_id = Some("a".repeat(65)),
            |l| l.weather = Some("rain\nsnow".into()),
            |l| l.weather = Some("w".repeat(33)),
            |l| l.tyre_compound = Some("c".repeat(41)),
            |l| l.air_temp_c = Some(201.0),
            |l| l.track_temp_c = Some(f64::NAN),
        ];
        for (i, damage) in bad.iter().enumerate() {
            let mut lap = golden_v2_lap();
            damage(&mut lap);
            assert!(pack(&lap).is_err(), "case {i}");
        }
        let mut edge = golden_v2_lap();
        edge.session_id = Some("S".repeat(64));
        edge.weather = Some("w".repeat(32));
        edge.tyre_compound = Some("c".repeat(40));
        edge.air_temp_c = Some(-100.0);
        edge.track_temp_c = Some(200.0);
        assert!(pack(&edge).is_ok());
    }

    #[test]
    fn the_version_2_channels_are_standard_with_one_unit_each() {
        let units: std::collections::HashMap<_, _> = STANDARD_UNITS.iter().copied().collect();
        assert_eq!(STANDARD_UNITS.len(), 13 + 22);
        for wheel in ["fl", "fr", "rl", "rr"] {
            assert_eq!(units[format!("tyre_temp_{wheel}").as_str()], "\u{b0}C");
            assert_eq!(units[format!("tyre_press_{wheel}").as_str()], "kPa");
            assert_eq!(units[format!("tyre_wear_{wheel}").as_str()], "ratio");
            assert_eq!(units[format!("brake_temp_{wheel}").as_str()], "\u{b0}C");
        }
        for (id, unit) in [
            ("g_lat", "g"),
            ("g_long", "g"),
            ("damage_body", "ratio"),
            ("drs", "state"),
            ("tc_active", "flag"),
            ("abs_active", "flag"),
        ] {
            assert_eq!(units[id], unit, "{id}");
        }
        // Every one is a valid channel id, so a reader that does not know it still takes it as a game's own channel.
        assert!(STANDARD_UNITS.iter().all(|(id, _)| is_id(id)));
        // A standard channel in the wrong unit is refused, as the app does.
        let mut wrong = golden_v2_lap();
        wrong.channels[3].unit = "C".into();
        assert!(pack(&wrong).unwrap_err().0.contains("tyre_temp_fl"));
    }

    #[test]
    fn a_lap_with_every_channel_stays_inside_the_channel_limit() {
        let mut lap = golden_lap();
        for (id, unit) in STANDARD_UNITS.iter().skip(3) {
            lap.channels.push(Channel {
                id: (*id).into(),
                unit: (*unit).into(),
                values: vec![1.0, 2.0, 3.0],
            });
        }
        assert_eq!(lap.channels.len(), 35);
        assert_eq!(unpack(&pack(&lap).unwrap()).unwrap(), lap);
        // The count limits did not move: 128 is the most, and one more is refused.
        while lap.channels.len() < MAX_CHANNELS {
            lap.channels.push(Channel {
                id: format!("extra_{}", lap.channels.len()),
                unit: "x".into(),
                values: vec![0.0; 3],
            });
        }
        assert!(pack(&lap).is_ok());
        lap.channels.push(Channel {
            id: "one_too_many".into(),
            unit: "x".into(),
            values: vec![0.0; 3],
        });
        assert!(pack(&lap).is_err());
    }

    #[test]
    fn reads_the_golden_bytes_back_into_the_same_lap() {
        assert_eq!(unpack(&from_hex(GOLDEN_HEX)).unwrap(), golden_lap());
    }

    #[test]
    fn leaves_out_optional_fields_that_are_not_given() {
        let mut lap = golden_lap();
        lap.track_variant = None;
        lap.track_length_m = None;
        lap.car_class = None;
        lap.sectors_ms = None;
        let back = unpack(&pack(&lap).unwrap()).unwrap();
        assert_eq!(back, lap);
        let text = String::from_utf8_lossy(&pack(&lap).unwrap()).to_string();
        assert!(!text.contains("variant") && !text.contains("sectorsMs"));
    }

    #[test]
    fn writes_text_the_way_json_stringify_does() {
        assert_eq!(string("a\"b\\c\n\u{1}é"), "\"a\\\"b\\\\c\\n\\u0001é\"");
        assert_eq!(number(20.0), "20");
        assert_eq!(number(99.5), "99.5");
        assert_eq!(number(0.1), "0.1");
    }

    #[test]
    fn gzip_round_trips_and_is_gzip() {
        let zipped = gzip(&golden_lap()).unwrap();
        assert_eq!(&zipped[0..2], &[0x1f, 0x8b]);
        assert_eq!(gunzip(&zipped, MAX_UNPACKED).unwrap(), golden_lap());
    }

    #[test]
    fn stops_a_small_file_that_unzips_to_something_huge() {
        let samples = 300_000;
        let zeros = |id: &str, unit: &str| Channel {
            id: id.into(),
            unit: unit.into(),
            values: vec![0.0; samples],
        };
        let mut lap = golden_lap();
        lap.channels = vec![zeros("t", "s"), zeros("dist", "m"), zeros("speed", "m/s")];
        let zipped = gzip(&lap).unwrap();
        assert!(zipped.len() < 100_000);
        assert!(gunzip(&zipped, 1024 * 1024).unwrap_err().0.contains("too large"));
        assert!(gunzip(&zipped, MAX_UNPACKED).is_ok());
    }

    #[test]
    fn refuses_laps_the_app_would_refuse() {
        let mut short = golden_lap();
        short.channels[2].values.pop();
        assert!(pack(&short).is_err());

        let mut no_distance = golden_lap();
        no_distance.channels.remove(1);
        assert!(pack(&no_distance).is_err());

        let mut wrong_unit = golden_lap();
        wrong_unit.channels[2].unit = "km/h".into();
        assert!(pack(&wrong_unit).unwrap_err().0.contains("m/s"));

        let mut twice = golden_lap();
        twice.channels.push(twice.channels[2].clone());
        assert!(pack(&twice).is_err());

        let mut bad_id = golden_lap();
        bad_id.channels[2].id = "Speed".into();
        assert!(pack(&bad_id).is_err());
    }

    #[test]
    fn refuses_files_that_are_not_well_formed() {
        let good = from_hex(GOLDEN_HEX);
        assert!(unpack(&good[..5]).is_err());
        let mut magic = good.clone();
        magic[0] = b'Y';
        assert!(unpack(&magic).is_err());
        let mut version = good.clone();
        version[4] = 3;
        assert!(unpack(&version).unwrap_err().0.contains("version 3"));
        version[4] = 0;
        assert!(unpack(&version).is_err());
        assert!(unpack(&good[..good.len() - 4]).is_err());
        let mut extra = good.clone();
        extra.push(0);
        assert!(unpack(&extra).is_err());
        assert!(gunzip(&[1, 2, 3, 4], MAX_UNPACKED).is_err());
    }

    fn stamped_lap() -> Lap {
        Lap {
            recorder: Some(Recorder {
                app: "xpeed-companion".into(),
                version: "0.8.2".into(),
                build: "9900d41".into(),
                source: "acevo".into(),
                game_build: Some("0.9.1".into()),
                coordinate_frame: None,
            }),
            checks: vec!["t_repeats".into(), "clutch_stuck".into()],
            ..golden_v2_lap()
        }
    }

    #[test]
    fn a_lap_without_a_stamp_writes_no_recorder_and_no_checks() {
        // The golden vector above proves the bytes; this names why: the keys are written only when set.
        let text = String::from_utf8_lossy(&pack(&golden_v2_lap()).unwrap()).to_string();
        assert!(!text.contains("recorder") && !text.contains("checks"));
    }

    #[test]
    fn a_stamped_lap_carries_who_recorded_it_and_what_the_checks_found() {
        let bytes = pack(&stamped_lap()).unwrap();
        let text = String::from_utf8_lossy(&bytes).to_string();
        assert!(text.contains(
            "\"recorder\":{\"app\":\"xpeed-companion\",\"version\":\"0.8.2\",\"build\":\"9900d41\",\"source\":\"acevo\",\"gameBuild\":\"0.9.1\"},\"checks\":[\"t_repeats\",\"clutch_stuck\"],\"channels\""
        ));
        assert_eq!(&bytes[4..6], &2u16.to_le_bytes(), "still version 2");
        let back = unpack(&bytes).unwrap();
        assert_eq!(back.recorder, stamped_lap().recorder);
        assert_eq!(back.checks, vec!["t_repeats", "clutch_stuck"]);
        // Version 1 has neither.
        let v1 = String::from_utf8_lossy(&pack_as(&stamped_lap(), 1).unwrap()).to_string();
        assert!(!v1.contains("recorder") && !v1.contains("checks"));
    }

    #[test]
    fn the_stamp_of_this_build_is_always_a_valid_header() {
        let mut lap = stamped_lap();
        lap.recorder = Some(Recorder::current(
            "a reader with a very very very long name that goes on",
            Some("  v1\u{7}.2 \n"),
        ));
        let recorder = lap.recorder.clone().unwrap();
        assert_eq!(recorder.app, "xpeed-companion");
        assert_eq!(recorder.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(recorder.game_build.as_deref(), Some("v1.2"));
        assert!(recorder.source.len() <= 32);
        assert!(pack(&lap).is_ok());
        assert_eq!(Recorder::current("", Some("  ")).source, "unknown");
        assert_eq!(Recorder::current("lmu", Some("  ")).game_build, None);
    }

    #[test]
    fn new_evo_laps_name_the_coordinate_contract_without_changing_historical_stamps() {
        let old = stamped_lap();
        assert!(!String::from_utf8_lossy(&pack(&old).unwrap()).contains("coordinateFrame"));
        let mut current = old.clone();
        current.recorder = Some(Recorder::current("acevo", Some("0.9.1")));
        let back = unpack(&pack(&current).unwrap()).unwrap();
        assert_eq!(back.recorder.unwrap().coordinate_frame.as_deref(), Some("acevo-reflected-x-v1"));
        assert!(Recorder::current("ac", None).coordinate_frame.is_none());
        current.recorder.as_mut().unwrap().coordinate_frame = Some("x".repeat(65));
        assert!(pack(&current).is_err());
    }

    #[test]
    fn refuses_a_recorder_or_checks_the_app_would_refuse() {
        let mut long = stamped_lap();
        long.recorder.as_mut().unwrap().build = "x".repeat(41);
        assert!(pack(&long).is_err());
        let mut ids = stamped_lap();
        ids.checks = vec!["Not An Id".into()];
        assert!(pack(&ids).is_err());
    }

    fn aided_lap() -> Lap {
        Lap {
            aids: Some(Aids {
                tc_max: Some(4),
                abs_max: Some(0),
                stability: Some(0.5),
                auto_shift: Some(false),
                auto_clutch: Some(true),
                auto_blip: Some(false),
                ideal_line: Some(true),
            }),
            ..golden_v2_lap()
        }
    }

    #[test]
    fn the_aids_of_a_lap_are_written_in_the_header_and_read_back() {
        let bytes = pack(&aided_lap()).unwrap();
        let text = String::from_utf8_lossy(&bytes).to_string();
        // The same text the TypeScript test of the app expects, so the two writers agree on the order of the keys.
        assert!(text.contains(
            "\"aids\":{\"tcMax\":4,\"absMax\":0,\"stability\":0.5,\"autoShift\":false,\"autoClutch\":true,\"autoBlip\":false,\"idealLine\":true},\"channels\""
        ));
        assert_eq!(
            &bytes[4..6],
            &2u16.to_le_bytes(),
            "still version 2: the field was added without a bump"
        );
        assert_eq!(unpack(&bytes).unwrap().aids, aided_lap().aids);
        assert_eq!(gunzip(&gzip(&aided_lap()).unwrap(), MAX_UNPACKED).unwrap().aids, aided_lap().aids);
        // Version 1 has no aids.
        let v1 = String::from_utf8_lossy(&pack_as(&aided_lap(), 1).unwrap()).to_string();
        assert!(!v1.contains("aids"));
    }

    #[test]
    fn a_lap_with_no_known_aid_writes_no_aids_object_and_old_files_still_read() {
        for aids in [None, Some(Aids::default())] {
            let lap = Lap { aids, ..golden_v2_lap() };
            let bytes = pack(&lap).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("aids"));
            assert_eq!(unpack(&bytes).unwrap().aids, None);
            // The golden vectors of the format (written before the field existed) are byte for byte what they were.
            assert_eq!(bytes, pack(&golden_v2_lap()).unwrap());
        }
        assert_eq!(unpack(&from_hex(GOLDEN_HEX)).unwrap().aids, None);
        assert_eq!(unpack(&from_hex(GOLDEN_V2_HEX)).unwrap().aids, None);
    }

    #[test]
    fn titles_go_beside_the_names_in_version_2_and_come_back() {
        let lap = Lap {
            track_title: Some("Laguna Seca".into()),
            car_title: Some("Porsche Macan Turbo".into()),
            ..golden_v2_lap()
        };
        let bytes = pack(&lap).unwrap();
        let text = String::from_utf8_lossy(&bytes).to_string();
        assert!(text.contains(r#""track":{"name":"Test Track","title":"Laguna Seca""#), "{text}");
        assert!(text.contains(r#""car":{"name":"Test Car","title":"Porsche Macan Turbo""#), "{text}");
        let back = unpack(&bytes).unwrap();
        assert_eq!((back.track_title, back.car_title), (lap.track_title.clone(), lap.car_title.clone()));
        // Version 1 has no titles; a lap without them is byte for byte what it was.
        assert!(!String::from_utf8_lossy(&pack_as(&lap, 1).unwrap()).contains("title"));
        assert_eq!(unpack(&from_hex(GOLDEN_V2_HEX)).unwrap().track_title, None);
        // A title the site would refuse (a control character) is left out, never sent.
        let bad = Lap {
            car_title: Some("bad\u{7}".into()),
            ..golden_v2_lap()
        };
        assert_eq!(pack(&bad).unwrap(), pack(&golden_v2_lap()).unwrap());
    }

    #[test]
    fn only_the_known_aids_are_written() {
        let lap = Lap {
            aids: Some(Aids {
                tc_max: Some(0),
                ideal_line: Some(false),
                ..Aids::default()
            }),
            ..golden_v2_lap()
        };
        let text = String::from_utf8_lossy(&pack(&lap).unwrap()).to_string();
        assert!(
            text.contains("\"aids\":{\"tcMax\":0,\"idealLine\":false},"),
            "tcMax 0 is a known \"off\""
        );
        assert_eq!(unpack(&pack(&lap).unwrap()).unwrap().aids, lap.aids);
    }

    #[test]
    fn refuses_aids_the_app_would_refuse() {
        for aids in [
            Aids {
                tc_max: Some(101),
                ..Aids::default()
            },
            Aids {
                abs_max: Some(255),
                ..Aids::default()
            },
            Aids {
                stability: Some(1.5),
                ..Aids::default()
            },
            Aids {
                stability: Some(-0.1),
                ..Aids::default()
            },
            Aids {
                stability: Some(f64::NAN),
                ..Aids::default()
            },
        ] {
            assert!(
                pack(&Lap {
                    aids: Some(aids.clone()),
                    ..golden_v2_lap()
                })
                .is_err(),
                "{aids:?}"
            );
        }
        let edge = Aids {
            tc_max: Some(100),
            abs_max: Some(100),
            stability: Some(1.0),
            ..Aids::default()
        };
        assert!(pack(&Lap {
            aids: Some(edge),
            ..golden_v2_lap()
        })
        .is_ok());
    }

    #[test]
    fn real_recorded_laps_remain_readable_and_round_trip_without_changing_samples() {
        let cases: [(&str, &[u8]); 4] = [
            ("ams2", include_bytes!("../fixtures/laps/ams2-real-lap-1.xlap.gz")),
            ("acevo", include_bytes!("../fixtures/laps/acevo-real-lap-1.xlap.gz")),
            ("acevo", include_bytes!("../fixtures/laps/acevo-real-lap-2.xlap.gz")),
            ("acevo", include_bytes!("../fixtures/laps/acevo-real-lap-3.xlap.gz")),
        ];
        for (game, bytes) in cases {
            let lap = gunzip(bytes, MAX_UNPACKED).unwrap();
            assert_eq!(lap.game, game);
            assert!(lap.sample_count() > 1000, "a real drive, not a tiny generated example");
            assert!(lap.session_id.is_none(), "personal session metadata was removed");
            let restored = gunzip(&gzip(&lap).unwrap(), MAX_UNPACKED).unwrap();
            assert_eq!(restored.sample_count(), lap.sample_count());
            assert_eq!(restored.time_ms, lap.time_ms);
            for (before, after) in lap.channels.iter().zip(&restored.channels) {
                assert_eq!(before.id, after.id);
                assert_eq!(before.unit, after.unit);
                assert!(before.values.iter().zip(&after.values).all(|(a, b)| a.to_bits() == b.to_bits()));
            }
        }
    }
}
