//! Lap files: one lap of one car, every channel sampled at the same moments.
//!
//! The same byte layout the app reads (`docs/telemetria-virtual-2026-11-10/FORMATO-DE-VOLTA.md`,
//! `src/lib/sim/lap-file.ts`). The test `writes_the_golden_lap_byte_for_byte` checks this writer
//! against the 396-byte vector in that spec, so the two programs cannot drift apart unnoticed.
//!
//! Uncompressed layout, little-endian: `XLAP`, u16 version, u16 flags, u32 header length (a
//! multiple of 4), the JSON header padded with spaces, then one float32 column per channel.

use std::fmt;
use std::io::{Read, Write};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

pub const MAGIC: &[u8; 4] = b"XLAP";
pub const VERSION: u16 = 1;
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
];

#[derive(Debug, Clone, PartialEq)]
pub struct Channel {
    pub id: String,
    pub unit: String,
    pub values: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Lap {
    pub game: String,
    pub track_name: String,
    pub track_variant: Option<String>,
    pub track_length_m: Option<f64>,
    pub car_name: String,
    pub car_class: Option<String>,
    pub lap_number: u32,
    pub time_ms: u32,
    pub valid: bool,
    pub sectors_ms: Option<Vec<u32>>,
    /// ISO 8601, UTC.
    pub started_at: String,
    pub sample_rate_hz: f64,
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

/// The header with the keys in the one fixed order writers use, so equal laps give equal bytes.
fn header_json(lap: &Lap, sample_count: usize) -> String {
    let mut track = format!("\"name\":{}", string(&lap.track_name));
    if let Some(variant) = &lap.track_variant {
        track.push_str(&format!(",\"variant\":{}", string(variant)));
    }
    if let Some(length) = lap.track_length_m {
        track.push_str(&format!(",\"lengthM\":{}", number(length)));
    }
    let mut car = format!("\"name\":{}", string(&lap.car_name));
    if let Some(class) = &lap.car_class {
        car.push_str(&format!(",\"class\":{}", string(class)));
    }
    let mut lap_json = format!("\"number\":{},\"timeMs\":{},\"valid\":{}", lap.lap_number, lap.time_ms, lap.valid);
    if let Some(sectors) = &lap.sectors_ms {
        let list: Vec<String> = sectors.iter().map(|ms| ms.to_string()).collect();
        lap_json.push_str(&format!(",\"sectorsMs\":[{}]", list.join(",")));
    }
    let channels: Vec<String> = lap
        .channels
        .iter()
        .map(|c| format!("{{\"id\":{},\"unit\":{}}}", string(&c.id), string(&c.unit)))
        .collect();
    format!(
        "{{\"game\":{},\"track\":{{{}}},\"car\":{{{}}},\"lap\":{{{}}},\"startedAt\":{},\"sampleRateHz\":{},\"sampleCount\":{},\"channels\":[{}]}}",
        string(&lap.game),
        track,
        car,
        lap_json,
        string(&lap.started_at),
        number(lap.sample_rate_hz),
        sample_count,
        channels.join(",")
    )
}

/// Lays a lap out as bytes (not yet compressed). Refuses a lap the app would refuse.
pub fn pack(lap: &Lap) -> Result<Vec<u8>, LapError> {
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

    let text = header_json(lap, samples);
    let header_bytes = text.len().div_ceil(4) * 4;
    if header_bytes > MAX_HEADER {
        return err("the header is too large");
    }
    let mut out = Vec::with_capacity(PREAMBLE + header_bytes + lap.channels.len() * samples * 4);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
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
    if u16_at(bytes, 4) != VERSION {
        return err(format!("unsupported lap file version {}", u16_at(bytes, 4)));
    }
    if u16_at(bytes, 6) != 0 {
        return err("unknown flags");
    }
    let header_bytes = u32_at(bytes, 8) as usize;
    if header_bytes == 0 || header_bytes % 4 != 0 || header_bytes > MAX_HEADER || PREAMBLE + header_bytes > bytes.len() {
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
        for chunk in bytes[offset..offset + samples * 4].chunks_exact(4) {
            values.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
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
        lap_number: header["lap"]["number"].as_u64().unwrap_or(0) as u32,
        time_ms: header["lap"]["timeMs"].as_u64().unwrap_or(0) as u32,
        valid: header["lap"]["valid"].as_bool().unwrap_or(false),
        sectors_ms: header["lap"]["sectorsMs"]
            .as_array()
            .map(|items| items.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect()),
        started_at: text(&header["startedAt"]).unwrap_or_default(),
        sample_rate_hz: header["sampleRateHz"].as_f64().unwrap_or(0.0),
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
    /// laid out by a separate script. If this writer and the spec disagree, this test fails.
    const GOLDEN_HEX: &str = "584c4150010000005c0100007b2267616d65223a226c6d75222c22747261636b223a7b226e616d65223a225465737420547261636b222c2276617269616e74223a224750222c226c656e6774684d223a32307d2c22636172223a7b226e616d65223a225465737420436172222c22636c617373223a224859504552434152227d2c226c6170223a7b226e756d626572223a312c2274696d654d73223a313030302c2276616c6964223a747275652c22736563746f72734d73223a5b3430302c3630305d7d2c22737461727465644174223a22323032362d31312d31305431323a30303a30302e3030305a222c2273616d706c6552617465487a223a322c2273616d706c65436f756e74223a332c226368616e6e656c73223a5b7b226964223a2274222c22756e6974223a2273227d2c7b226964223a2264697374222c22756e6974223a226d227d2c7b226964223a227370656564222c22756e6974223a226d2f73227d5d7d202020000000000000003f0000803f00000000000020410000a04100000000000020410000a041";

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
        let bytes = pack(&golden_lap()).unwrap();
        assert_eq!(bytes.len(), 396);
        assert_eq!(hex(&bytes), GOLDEN_HEX);
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
        version[4] = 2;
        assert!(unpack(&version).is_err());
        assert!(unpack(&good[..good.len() - 4]).is_err());
        let mut extra = good.clone();
        extra.push(0);
        assert!(unpack(&extra).is_err());
        assert!(gunzip(&[1, 2, 3, 4], MAX_UNPACKED).is_err());
    }
}
