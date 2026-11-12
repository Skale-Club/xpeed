//! iRacing: the telemetry the sim publishes through its own SDK, in a memory named `Local\IRSDKMemMapFileName`.
//!
//! Nothing to install: the sim writes this memory itself while it runs (the "iRacing SDK" is the official, documented
//! door every telemetry tool uses). This reader opens it read-only and copies out what it needs.
//!
//! # Sources
//!
//! * The SDK header `irsdk_defines.h` (shipped by iRacing with the sim and in its SDK download): the memory name, the
//!   header `irsdk_header`, the buffer descriptor `irsdk_varBuf`, the variable descriptor `irsdk_varHeader`, the type
//!   codes `irsdk_VarType`, `IRSDK_VER = 2` and the status bit `irsdk_stConnected = 1`.
//! * pyirsdk (<https://github.com/kutu/pyirsdk>, `irsdk.py`), which reads the same memory and states the same offsets:
//!   header fields at 0..40, the buffer descriptors from 48 with a stride of 16, variable descriptors of 144 bytes
//!   (`type` 0, `offset` 4, `count` 8, `countAsTime` 12, `name[32]` 16, `desc[64]` 48, `unit[32]` 112), and the type
//!   sizes char 1, bool 1, int 4, bitfield 4, float 4, double 8.
//!
//! # What the memory is
//!
//! * A fixed header (112 bytes): version, status, tick rate, where the session info text is and how long, how many
//!   variables there are and where their descriptors start, and up to 4 telemetry buffers (`numBuf`, each `bufLen`
//!   bytes) with the tick count each one was last written at.
//! * Variables are found **by name**, never by a fixed offset: each descriptor gives a name, a type and an offset
//!   inside a buffer. A variable this build of the sim does not publish is simply missing, and its value is "not given".
//! * The sim writes the buffers in turn (60 times a second). The newest is the one with the highest tick count. A copy
//!   is kept only if that buffer's tick count is the same after the copy as before it (the SDK's own client does the
//!   same check); otherwise it was being written while it was copied, and the next poll takes the next one.
//! * The session info is a YAML text (`WeekendInfo`, `DriverInfo`...), rewritten when `sessionInfoUpdate` changes. It
//!   gives the track (`TrackDisplayName`, `TrackConfigName`, `TrackLength`), the player's car index (`DriverCarIdx`)
//!   and each car's name (`CarScreenName`) and class (`CarClassShortName`). It is ISO-8859-1 unless it starts with the
//!   UTF-8 marker of newer builds; this reader takes it as UTF-8 when it is valid UTF-8 and as Latin-1 otherwise.
//!
//! # Units and conversions
//!
//! `Speed` m/s, `RPM`, `Gear` (-1 reverse, 0 neutral), `Throttle` and `Brake` 0..1, `FuelLevel` litres, `LapDist`
//! metres from the line, `LapCurrentLapTime` and `LapLastLapTime` seconds (the last is 0 or -1 while there is none),
//! `Lap` the laps started (it goes up as the car crosses the line), `OnPitRoad`. `Clutch` is 1 with the clutch fully
//! engaged (pedal up); the lap file wants the pedal (1 = pressed), so it is `1 - Clutch`. `SteeringWheelAngle` is in
//! radians, positive turning left; the lap file wants -1 (full left) .. 1 (full right), so it is
//! `-SteeringWheelAngle / SteeringWheelAngleMax`.
//!
//! `driving` is `IsOnTrack` (the player is in the car and its physics run) and not `IsReplayPlaying`.
//!
//! # Where the car is (the map)
//!
//! **The sim does not publish the car's position in the live telemetry.** `Lat`/`Lon`/`Alt` exist only in the
//! telemetry files it writes to disk (`.ibt`), as far as is known. When a build does publish them live, this reader
//! uses them (metres east and north of the first fix). Otherwise it **estimates** the position by adding up the
//! car's velocity, turned by its heading, 60 times a second (dead reckoning):
//!
//! * `VelocityX` is forward and `VelocityY` to the left, in the car's own frame (metres per second); `Yaw` is the
//!   heading in radians, counter-clockwise seen from above. The world velocity is then
//!   `east = vx·cos(yaw) - vy·sin(yaw)`, `north = vx·sin(yaw) + vy·cos(yaw)`.
//! * The lap file has x to the right and z down when drawn; this reader writes `x = east`, `z = -north`, so north is up
//!   and a left turn is drawn as a left turn.
//! * The position goes back to (0, 0) when a lap starts, so every lap starts at the line and laps lie on top of each
//!   other. Adding up 60 readings a second drifts a little (a few metres over a lap); when a lap is finished,
//!   `finish_lap` spreads the gap between its end and its start along the lap (by distance), so a closed lap closes.
//!   A gap too large for drift (over a tenth of the track) is left alone.
//!
//! **Not checked against the sim yet:** the sign of `Yaw` and of `VelocityY` (a wrong one draws the track mirrored),
//! the clutch and steering conventions above, and the program name. They come from the SDK's descriptions and from
//! the tools that read it; the first real session confirms or corrects them.
//!
//! Never read: another process's memory. Only the sim's own shared memory, read-only and copied out.

use std::collections::HashMap;
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::game::{Frame, Source};
use crate::lapfile::Lap;
use crate::shm::{Mapping, Page};

/// The name the sim gives its memory (`IRSDK_MEMMAPFILENAME`).
const MEMORY_NAME: &str = "Local\\IRSDKMemMapFileName";
/// `IRSDK_VER`.
const SDK_VERSION: i32 = 2;
/// `irsdk_stConnected`: a session is loaded and the buffers are being written.
const STATUS_CONNECTED: i32 = 1;
/// `sizeof(irsdk_header)`: ten ints, two pad ints, then four `irsdk_varBuf` of 16 bytes.
const HEADER_SIZE: usize = 112;
/// `sizeof(irsdk_varHeader)`.
const VAR_HEADER_SIZE: usize = 144;
/// `IRSDK_MAX_BUFS`.
const MAX_BUFFERS: usize = 4;
/// More variables than any build has: a header that says more is not believed.
const MAX_VARS: usize = 4096;
/// The session info text is well under this.
const MAX_SESSION_INFO: usize = 1 << 20;

/// Byte offsets inside the header and inside a variable descriptor.
mod at {
    pub const VER: usize = 0;
    pub const STATUS: usize = 4;
    pub const SESSION_INFO_UPDATE: usize = 12;
    pub const SESSION_INFO_LEN: usize = 16;
    pub const SESSION_INFO_OFFSET: usize = 20;
    pub const NUM_VARS: usize = 24;
    pub const VAR_HEADER_OFFSET: usize = 28;
    pub const NUM_BUF: usize = 32;
    pub const BUF_LEN: usize = 36;
    pub const VAR_BUF: usize = 48;
    pub const VAR_BUF_STRIDE: usize = 16;
    /// Inside an `irsdk_varBuf`.
    pub const B_TICK_COUNT: usize = 0;
    pub const B_BUF_OFFSET: usize = 4;
    /// Inside an `irsdk_varHeader`.
    pub const V_TYPE: usize = 0;
    pub const V_OFFSET: usize = 4;
    pub const V_NAME: usize = 16;
    pub const V_NAME_LEN: usize = 32;
}

/// About 200 Hz, so a 60 Hz buffer is taken soon after it is written.
const POLL: Duration = Duration::from_millis(5);
/// A longer gap between two readings is not added into the estimated position.
const MAX_STEP_SECONDS: f64 = 0.5;
/// A lap whose end is further than this share of the track from its start is not closed (it is not drift).
const MAX_CLOSING_SHARE: f64 = 0.1;
/// Metres per degree of latitude (a sphere of the WGS-84 mean radius), for the rare build that publishes `Lat`/`Lon`.
const METRES_PER_DEGREE: f64 = 6_371_008.8 * std::f64::consts::PI / 180.0;

pub fn open() -> Option<Box<dyn Source>> {
    IRacing::open_named(MEMORY_NAME).map(|reader| Box::new(reader) as Box<dyn Source>)
}

/// `irsdk_VarType`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Char,
    Bool,
    Int,
    BitField,
    Float,
    Double,
}

impl Kind {
    fn from_code(code: i32) -> Option<Kind> {
        Some(match code {
            0 => Kind::Char,
            1 => Kind::Bool,
            2 => Kind::Int,
            3 => Kind::BitField,
            4 => Kind::Float,
            5 => Kind::Double,
            _ => return None,
        })
    }

    fn size(self) -> usize {
        match self {
            Kind::Char | Kind::Bool => 1,
            Kind::Int | Kind::BitField | Kind::Float => 4,
            Kind::Double => 8,
        }
    }
}

/// Where one variable sits inside a telemetry buffer (its first element: every variable read here is a single value).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Var {
    kind: Kind,
    offset: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Header {
    status: i32,
    session_info_update: i32,
    session_info_len: usize,
    session_info_offset: usize,
    num_vars: usize,
    var_header_offset: usize,
    buf_len: usize,
    /// `(tickCount, bufOffset)` of each buffer in use.
    buffers: [(i32, usize); MAX_BUFFERS],
    num_buf: usize,
}

impl Header {
    /// The buffer written last: the highest tick count.
    fn newest(&self) -> (usize, i32, usize) {
        let (slot, (tick, offset)) = self.buffers[..self.num_buf]
            .iter()
            .copied()
            .enumerate()
            .max_by_key(|(_, (tick, _))| *tick)
            .expect("num_buf is at least 1");
        (slot, tick, offset)
    }
}

fn usize_of(v: i32) -> Option<usize> {
    usize::try_from(v).ok()
}

/// Reads the header out of its 112 bytes. `None` for a version other than 2, or any count or offset that does not fit
/// in a memory of `mapped` bytes (the sim has not filled the header yet, or this is not the SDK's memory).
fn parse_header(bytes: &[u8], mapped: usize) -> Option<Header> {
    if bytes.len() < HEADER_SIZE {
        return None;
    }
    let page = Page(bytes);
    if page.i32_at(at::VER) != SDK_VERSION {
        return None;
    }
    let num_buf = usize_of(page.i32_at(at::NUM_BUF))?;
    let buf_len = usize_of(page.i32_at(at::BUF_LEN))?;
    let num_vars = usize_of(page.i32_at(at::NUM_VARS))?;
    let var_header_offset = usize_of(page.i32_at(at::VAR_HEADER_OFFSET))?;
    let session_info_len = usize_of(page.i32_at(at::SESSION_INFO_LEN))?;
    let session_info_offset = usize_of(page.i32_at(at::SESSION_INFO_OFFSET))?;
    let fits = |start: usize, len: usize| start.checked_add(len).is_some_and(|end| end <= mapped);
    if !(1..=MAX_BUFFERS).contains(&num_buf)
        || buf_len == 0
        || !(1..=MAX_VARS).contains(&num_vars)
        || !fits(var_header_offset, num_vars * VAR_HEADER_SIZE)
        || session_info_len > MAX_SESSION_INFO
        || !fits(session_info_offset, session_info_len)
    {
        return None;
    }
    let mut buffers = [(0, 0); MAX_BUFFERS];
    for (slot, entry) in buffers.iter_mut().enumerate().take(num_buf) {
        let base = at::VAR_BUF + slot * at::VAR_BUF_STRIDE;
        let offset = usize_of(page.i32_at(base + at::B_BUF_OFFSET))?;
        if !fits(offset, buf_len) {
            return None;
        }
        *entry = (page.i32_at(base + at::B_TICK_COUNT), offset);
    }
    Some(Header {
        status: page.i32_at(at::STATUS),
        session_info_update: page.i32_at(at::SESSION_INFO_UPDATE),
        session_info_len,
        session_info_offset,
        num_vars,
        var_header_offset,
        buf_len,
        buffers,
        num_buf,
    })
}

/// The variables, by name, out of `count` descriptors. A descriptor with a type the SDK does not have, or whose value
/// would sit past the end of a buffer, is left out.
fn parse_vars(bytes: &[u8], count: usize, buf_len: usize) -> HashMap<String, Var> {
    let page = Page(bytes);
    let mut vars = HashMap::with_capacity(count);
    for i in 0..count {
        let base = i * VAR_HEADER_SIZE;
        let Some(kind) = Kind::from_code(page.i32_at(base + at::V_TYPE)) else {
            continue;
        };
        let Some(offset) = usize_of(page.i32_at(base + at::V_OFFSET)) else {
            continue;
        };
        if offset.checked_add(kind.size()).is_none_or(|end| end > buf_len) {
            continue;
        }
        let name = page.ascii_at(base + at::V_NAME, at::V_NAME_LEN);
        if !name.is_empty() {
            vars.insert(name, Var { kind, offset });
        }
    }
    vars
}

/// The values of one telemetry buffer, looked up by name.
struct Values<'a> {
    vars: &'a HashMap<String, Var>,
    buf: &'a [u8],
}

impl Values<'_> {
    /// Any numeric variable as a float; `None` when this build does not publish it (or it is not a finite number).
    fn number(&self, name: &str) -> Option<f64> {
        let var = self.vars.get(name)?;
        let page = Page(self.buf);
        let v = match var.kind {
            Kind::Char | Kind::Bool => f64::from(page.u8_at(var.offset)),
            Kind::Int | Kind::BitField => f64::from(page.i32_at(var.offset)),
            Kind::Float => f64::from(page.f32_at(var.offset)),
            Kind::Double => f64::from_le_bytes(self.buf.get(var.offset..var.offset + 8)?.try_into().ok()?),
        };
        v.is_finite().then_some(v)
    }

    fn float(&self, name: &str) -> f32 {
        self.number(name).map_or(f32::NAN, |v| v as f32)
    }

    fn flag(&self, name: &str) -> Option<bool> {
        self.number(name).map(|v| v != 0.0)
    }
}

/// What the session info says about the track and the player's car.
#[derive(Clone, Debug, Default, PartialEq)]
struct Session {
    track: String,
    variant: Option<String>,
    length_m: Option<f64>,
    car: String,
    car_class: Option<String>,
}

/// The text up to its first zero: UTF-8 when it is valid UTF-8, else Latin-1 (every byte is the character of that
/// number), which is what older builds write.
fn decode_session(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    let text = &bytes[..end];
    match std::str::from_utf8(text) {
        Ok(s) => s.to_owned(),
        Err(_) => text.iter().map(|&b| char::from(b)).collect(),
    }
}

/// The lines under a top-level key of the YAML (`WeekendInfo:`), up to the next top-level key.
fn section<'a>(yaml: &'a str, name: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in yaml.lines() {
        if line.trim().is_empty() || line.trim() == "---" || line.trim() == "..." {
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('-') {
            inside = line.trim_end().strip_suffix(':') == Some(name);
            continue;
        }
        if inside {
            out.push(line);
        }
    }
    out
}

/// The value of `key: value` on a line (a list item `- key: value` too), without quotes; `None` for another key or an
/// empty value.
fn value_of(line: &str, key: &str) -> Option<String> {
    let rest = line.trim_start().trim_start_matches("- ").trim_start();
    let value = rest.strip_prefix(key)?.strip_prefix(':')?.trim();
    let value = value.trim_matches('"').trim_matches('\'').trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn first_value(lines: &[&str], key: &str) -> Option<String> {
    lines.iter().find_map(|line| value_of(line, key))
}

/// `6.93 km` (or `4.31 mi`) in metres.
fn length_of(text: &str) -> Option<f64> {
    let mut parts = text.split_whitespace();
    let number: f64 = parts.next()?.parse().ok()?;
    let metres = match parts.next().unwrap_or("km") {
        "km" => number * 1000.0,
        "mi" => number * 1609.344,
        "m" => number,
        _ => return None,
    };
    (metres.is_finite() && metres > 0.0).then_some(metres)
}

fn parse_session(yaml: &str) -> Session {
    let weekend = section(yaml, "WeekendInfo");
    let track = first_value(&weekend, "TrackDisplayName")
        .or_else(|| first_value(&weekend, "TrackName"))
        .unwrap_or_default();
    let variant = first_value(&weekend, "TrackConfigName");
    let length_m = first_value(&weekend, "TrackLength").and_then(|t| length_of(&t));

    let drivers = section(yaml, "DriverInfo");
    let player = first_value(&drivers, "DriverCarIdx");
    let (mut car, mut car_class) = (String::new(), None);
    if let Some(player) = player {
        let mut current: Option<String> = None;
        for line in &drivers {
            if line.trim_start().starts_with("- ") {
                current = value_of(line, "CarIdx");
                if current.is_some() && current != Some(player.clone()) {
                    continue;
                }
            }
            if current.as_deref() != Some(player.as_str()) {
                continue;
            }
            if let Some(name) = value_of(line, "CarScreenName") {
                car = name;
            }
            if let Some(class) = value_of(line, "CarClassShortName") {
                car_class = Some(class);
            }
        }
    }
    Session {
        track,
        variant,
        length_m,
        car,
        car_class,
    }
}

/// The estimated (or, when the build publishes it, the real) position of the car.
#[derive(Debug, Default)]
struct Path {
    lap: i32,
    x: f64,
    z: f64,
    /// The sim's clock at the last reading added in.
    last_t: Option<f64>,
    /// The first `Lat`/`Lon` fix, for builds that publish them.
    origin: Option<(f64, f64)>,
}

impl Path {
    /// `(x, y, z, estimated)` for this reading.
    fn step(&mut self, values: &Values, driving: bool, lap: i32) -> (f32, f32, f32, bool) {
        let lat = values.number("Lat");
        let lon = values.number("Lon");
        if let (Some(lat), Some(lon)) = (lat, lon) {
            if lat != 0.0 || lon != 0.0 {
                let (lat0, lon0) = *self.origin.get_or_insert((lat, lon));
                let east = (lon - lon0) * METRES_PER_DEGREE * lat0.to_radians().cos();
                let north = (lat - lat0) * METRES_PER_DEGREE;
                let alt = values.number("Alt").map_or(f32::NAN, |a| a as f32);
                return (east as f32, alt, -north as f32, false);
            }
        }
        if lap != self.lap {
            self.lap = lap;
            self.x = 0.0;
            self.z = 0.0;
            self.last_t = None;
        }
        let (yaw, vx, vy, t) = (
            values.number("Yaw"),
            values.number("VelocityX"),
            values.number("VelocityY"),
            values.number("SessionTime"),
        );
        let (Some(yaw), Some(vx), Some(vy), Some(t)) = (yaw, vx, vy, t) else {
            self.last_t = None;
            return (f32::NAN, f32::NAN, f32::NAN, true);
        };
        if driving {
            if let Some(prev) = self.last_t {
                let dt = t - prev;
                if dt > 0.0 && dt <= MAX_STEP_SECONDS {
                    let (sin, cos) = yaw.sin_cos();
                    let east = vx * cos - vy * sin;
                    let north = vx * sin + vy * cos;
                    self.x += east * dt;
                    self.z -= north * dt;
                }
            }
            self.last_t = Some(t);
        } else {
            self.last_t = None;
        }
        (self.x as f32, f32::NAN, self.z as f32, true)
    }
}

/// Turns one telemetry buffer into a frame. Returns whether its position was estimated.
fn frame_from(values: &Values, session: &Session, path: &mut Path, clock_s: f64) -> (Frame, bool) {
    let mut frame = Frame::empty();
    frame.clock_s = clock_s;
    let on_track = values.flag("IsOnTrack").unwrap_or(false);
    let replay = values.flag("IsReplayPlaying").unwrap_or(false);
    frame.driving = on_track && !replay;
    frame.lap = values.number("Lap").map_or(0, |v| v as i32).clamp(0, 100_000);
    frame.lap_time_s = values.number("LapCurrentLapTime").filter(|t| (0.0..=86_400.0).contains(t));
    frame.last_lap_s = values.number("LapLastLapTime").filter(|t| *t > 0.0 && *t <= 86_400.0);
    frame.dist_m = values
        .number("LapDist")
        .filter(|d| (-1000.0..=1_000_000.0).contains(d))
        .map(|d| d.max(0.0));
    frame.in_pits = values.flag("OnPitRoad").unwrap_or(false);
    frame.speed_ms = within(values.float("Speed"), 0.0, 1000.0);
    frame.rpm = within(values.float("RPM"), 0.0, 100_000.0);
    frame.gear = within(values.float("Gear"), -1.0, 20.0);
    frame.throttle = clamped(values.float("Throttle"), 0.0, 1.0);
    frame.brake = clamped(values.float("Brake"), 0.0, 1.0);
    frame.clutch = clamped(1.0 - values.float("Clutch"), 0.0, 1.0);
    frame.steer = {
        let angle = values.float("SteeringWheelAngle");
        let max = values.float("SteeringWheelAngleMax");
        if max.is_finite() && max > 0.0 {
            clamped(-angle / max, -1.0, 1.0)
        } else {
            f32::NAN
        }
    };
    frame.fuel_l = within(values.float("FuelLevel"), 0.0, 10_000.0);
    let (x, y, z, estimated) = path.step(values, frame.driving, frame.lap);
    (frame.x, frame.y, frame.z) = (x, y, z);
    frame.car = session.car.clone();
    frame.car_class = session.car_class.clone();
    frame.track = session.track.clone();
    frame.track_variant = session.variant.clone();
    frame.track_length_m = session.length_m;
    (frame, estimated)
}

/// A float inside `lo..=hi`; anything else is "not given".
fn within(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_finite() && (lo..=hi).contains(&v) {
        v
    } else {
        f32::NAN
    }
}

/// A float pulled into `lo..=hi` (pedals, wheel); NaN stays "not given".
fn clamped(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        f32::NAN
    }
}

/// Spreads the gap between a lap's last position and its first along the lap, by distance, so an estimated path that
/// drifted closes on itself. A gap over a tenth of the track (or of the lap's distance, when the track length is not
/// known) is not drift, and the lap is left as it is.
fn close_loop(lap: &mut Lap) {
    let index = |id: &str| lap.channels.iter().position(|c| c.id == id);
    let (Some(ix), Some(iz), Some(id)) = (index("x"), index("z"), index("dist")) else {
        return;
    };
    let dist = lap.channels[id].values.clone();
    let n = dist.len();
    if n < 2 || lap.channels[ix].values.len() != n || lap.channels[iz].values.len() != n {
        return;
    }
    let (d0, span) = (f64::from(dist[0]), f64::from(dist[n - 1]) - f64::from(dist[0]));
    let gap = |c: usize| f64::from(lap.channels[c].values[n - 1]) - f64::from(lap.channels[c].values[0]);
    let (ex, ez) = (gap(ix), gap(iz));
    let limit = MAX_CLOSING_SHARE * lap.track_length_m.unwrap_or(span);
    if span.is_nan() || span <= 0.0 || !ex.is_finite() || !ez.is_finite() || ex.hypot(ez) > limit {
        return;
    }
    for (c, error) in [(ix, ex), (iz, ez)] {
        for (value, d) in lap.channels[c].values.iter_mut().zip(&dist) {
            let share = ((f64::from(*d) - d0) / span).clamp(0.0, 1.0);
            *value = (f64::from(*value) - error * share) as f32;
        }
    }
}

struct IRacing {
    memory: Mapping,
    started: Instant,
    vars: HashMap<String, Var>,
    /// `(numVars, varHeaderOffset, bufLen)` the variables were read for.
    vars_for: Option<(usize, usize, usize)>,
    session: Session,
    session_update: Option<i32>,
    last_tick: Option<i32>,
    connected: bool,
    path: Path,
    /// Whether the last positions were estimated (and so a finished lap is closed).
    estimated: bool,
}

impl IRacing {
    /// `None` when there is no such memory or it does not start with SDK version 2.
    fn open_named(name: &str) -> Option<IRacing> {
        let memory = Mapping::open(name)?;
        if memory.len() < HEADER_SIZE || Page(&memory.read(0, 4)?).i32_at(at::VER) != SDK_VERSION {
            return None;
        }
        Some(IRacing {
            memory,
            started: Instant::now(),
            vars: HashMap::new(),
            vars_for: None,
            session: Session::default(),
            session_update: None,
            last_tick: None,
            connected: false,
            path: Path::default(),
            estimated: true,
        })
    }

    /// The sim left the session (or its header cannot be believed): one frame that is not driving, then nothing.
    fn disconnect(&mut self) -> Option<Frame> {
        self.vars_for = None;
        self.session_update = None;
        self.last_tick = None;
        self.path.last_t = None;
        if !self.connected {
            return None;
        }
        self.connected = false;
        let mut frame = Frame::empty();
        frame.clock_s = self.started.elapsed().as_secs_f64();
        Some(frame)
    }

    fn try_read(&mut self) -> Option<Frame> {
        let head = self.memory.read(0, HEADER_SIZE)?;
        let header = parse_header(&head, self.memory.len()).filter(|h| h.status & STATUS_CONNECTED != 0);
        let Some(header) = header else {
            return self.disconnect();
        };
        let layout = (header.num_vars, header.var_header_offset, header.buf_len);
        if self.vars_for != Some(layout) {
            let bytes = self.memory.read(header.var_header_offset, header.num_vars * VAR_HEADER_SIZE)?;
            self.vars = parse_vars(&bytes, header.num_vars, header.buf_len);
            self.vars_for = Some(layout);
        }
        if self.session_update != Some(header.session_info_update) {
            let bytes = self.memory.read(header.session_info_offset, header.session_info_len)?;
            self.session = parse_session(&decode_session(&bytes));
            self.session_update = Some(header.session_info_update);
        }
        let (slot, tick, offset) = header.newest();
        if self.last_tick == Some(tick) {
            return None;
        }
        let buf = self.memory.read(offset, header.buf_len)?;
        // Written again while it was copied: the next poll takes the next buffer.
        let tick_after = Page(&self.memory.read(at::VAR_BUF + slot * at::VAR_BUF_STRIDE + at::B_TICK_COUNT, 4)?).i32_at(0);
        if tick_after != tick {
            return None;
        }
        self.last_tick = Some(tick);
        self.connected = true;
        let values = Values {
            vars: &self.vars,
            buf: &buf,
        };
        let (frame, estimated) = frame_from(&values, &self.session, &mut self.path, self.started.elapsed().as_secs_f64());
        self.estimated = estimated;
        Some(frame)
    }
}

impl Source for IRacing {
    fn game_id(&self) -> &'static str {
        "iracing"
    }

    fn game_name(&self) -> &'static str {
        "iRacing"
    }

    fn next(&mut self, timeout: Duration) -> Option<Frame> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(frame) = self.try_read() {
                return Some(frame);
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            sleep((deadline - now).min(POLL));
        }
    }

    /// The sim keeps its memory while it runs; the engine lets go of the reader when the program closes.
    fn alive(&self) -> bool {
        true
    }

    fn finish_lap(&self, lap: &mut Lap) {
        if self.estimated {
            close_loop(lap);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lapfile::Channel;
    use crate::shm::FakeMemory;

    const VARS: &[(&str, Kind)] = &[
        ("SessionTime", Kind::Double),
        ("IsOnTrack", Kind::Bool),
        ("IsReplayPlaying", Kind::Bool),
        ("Lap", Kind::Int),
        ("LapCurrentLapTime", Kind::Float),
        ("LapLastLapTime", Kind::Float),
        ("LapDist", Kind::Float),
        ("OnPitRoad", Kind::Bool),
        ("Speed", Kind::Float),
        ("RPM", Kind::Float),
        ("Gear", Kind::Int),
        ("Throttle", Kind::Float),
        ("Brake", Kind::Float),
        ("Clutch", Kind::Float),
        ("SteeringWheelAngle", Kind::Float),
        ("SteeringWheelAngleMax", Kind::Float),
        ("FuelLevel", Kind::Float),
        ("Yaw", Kind::Float),
        ("VelocityX", Kind::Float),
        ("VelocityY", Kind::Float),
    ];

    const SESSION: &str = "---\nWeekendInfo:\n TrackName: spa 2024 gp\n TrackID: 163\n TrackLength: 6.93 km\n \
TrackDisplayName: Circuit de Spa-Francorchamps\n TrackConfigName: Grand Prix Pits\n WeekendOptions:\n  NumStarters: 0\n\
SessionInfo:\n Sessions:\n - SessionNum: 0\n   SessionType: Practice\nDriverInfo:\n DriverCarIdx: 2\n Drivers:\n \
- CarIdx: 0\n   UserName: Pace Car\n   CarScreenName: safety pcporsche911cup\n   CarClassShortName: \n \
- CarIdx: 2\n   UserName: Someone\n   CarScreenName: Mazda MX-5 Cup\n   CarClassShortName: MX5 Cup\n \
- CarIdx: 3\n   UserName: Other\n   CarScreenName: Ferrari 296 GT3\n   CarClassShortName: GT3\n\n...\n";

    /// A memory laid out the way the SDK lays it out: header, descriptors, session text, three buffers.
    struct Image {
        bytes: Vec<u8>,
        vars: HashMap<&'static str, (Kind, usize)>,
        buf_len: usize,
        buf_base: usize,
    }

    fn code_of(kind: Kind) -> i32 {
        match kind {
            Kind::Char => 0,
            Kind::Bool => 1,
            Kind::Int => 2,
            Kind::BitField => 3,
            Kind::Float => 4,
            Kind::Double => 5,
        }
    }

    impl Image {
        fn new(vars: &[(&'static str, Kind)], session: &[u8]) -> Image {
            let mut offsets = HashMap::new();
            let mut offset: usize = 0;
            for &(name, kind) in vars {
                offsets.insert(name, (kind, offset));
                offset += 8;
            }
            let buf_len = offset.next_multiple_of(16);
            let var_headers = HEADER_SIZE;
            let session_at = var_headers + vars.len() * VAR_HEADER_SIZE;
            let buf_base = (session_at + session.len() + 1).next_multiple_of(16);
            let mut image = Image {
                bytes: vec![0; buf_base + 3 * buf_len],
                vars: offsets,
                buf_len,
                buf_base,
            };
            image.put_i32(at::VER, SDK_VERSION);
            image.put_i32(at::STATUS, STATUS_CONNECTED);
            image.put_i32(8, 60);
            image.put_i32(at::SESSION_INFO_UPDATE, 1);
            image.put_i32(at::SESSION_INFO_LEN, session.len() as i32 + 1);
            image.put_i32(at::SESSION_INFO_OFFSET, session_at as i32);
            image.put_i32(at::NUM_VARS, vars.len() as i32);
            image.put_i32(at::VAR_HEADER_OFFSET, var_headers as i32);
            image.put_i32(at::NUM_BUF, 3);
            image.put_i32(at::BUF_LEN, buf_len as i32);
            for slot in 0..3 {
                image.put_i32(
                    at::VAR_BUF + slot * at::VAR_BUF_STRIDE + at::B_BUF_OFFSET,
                    (buf_base + slot * buf_len) as i32,
                );
            }
            for (i, &(name, kind)) in vars.iter().enumerate() {
                let base = var_headers + i * VAR_HEADER_SIZE;
                image.put_i32(base + at::V_TYPE, code_of(kind));
                image.put_i32(base + at::V_OFFSET, image.vars[name].1 as i32);
                image.put_i32(base + 8, 1);
                image.bytes[base + at::V_NAME..base + at::V_NAME + name.len()].copy_from_slice(name.as_bytes());
            }
            image.bytes[session_at..session_at + session.len()].copy_from_slice(session);
            image
        }

        fn put_i32(&mut self, at: usize, v: i32) {
            self.bytes[at..at + 4].copy_from_slice(&v.to_le_bytes());
        }

        fn set(&mut self, slot: usize, name: &str, v: f64) {
            let (kind, offset) = self.vars[name];
            let at = self.buf_base + slot * self.buf_len + offset;
            match kind {
                Kind::Char | Kind::Bool => self.bytes[at] = v as u8,
                Kind::Int | Kind::BitField => self.put_i32(at, v as i32),
                Kind::Float => self.bytes[at..at + 4].copy_from_slice(&(v as f32).to_le_bytes()),
                Kind::Double => self.bytes[at..at + 8].copy_from_slice(&v.to_le_bytes()),
            }
        }

        fn tick(&mut self, slot: usize, tick: i32) {
            self.put_i32(at::VAR_BUF + slot * at::VAR_BUF_STRIDE + at::B_TICK_COUNT, tick);
        }

        fn values(&self, slot: usize) -> (HashMap<String, Var>, Vec<u8>) {
            let header = parse_header(&self.bytes, self.bytes.len()).unwrap();
            let start = header.var_header_offset;
            let vars = parse_vars(
                &self.bytes[start..start + header.num_vars * VAR_HEADER_SIZE],
                header.num_vars,
                header.buf_len,
            );
            let at = self.buf_base + slot * self.buf_len;
            (vars, self.bytes[at..at + self.buf_len].to_vec())
        }
    }

    fn driving_image() -> Image {
        let mut image = Image::new(VARS, SESSION.as_bytes());
        for (name, v) in [
            ("SessionTime", 120.25),
            ("IsOnTrack", 1.0),
            ("Lap", 3.0),
            ("LapCurrentLapTime", 41.5),
            ("LapLastLapTime", 138.912),
            ("LapDist", 2210.0),
            ("Speed", 61.0),
            ("RPM", 6400.0),
            ("Gear", 4.0),
            ("Throttle", 0.75),
            ("Brake", 0.0),
            ("Clutch", 1.0),
            ("SteeringWheelAngle", 0.5),
            ("SteeringWheelAngleMax", 4.0),
            ("FuelLevel", 31.5),
            ("Yaw", 0.0),
            ("VelocityX", 61.0),
            ("VelocityY", 0.0),
        ] {
            image.set(0, name, v);
        }
        image.tick(0, 10);
        image
    }

    #[test]
    fn reads_the_header_the_descriptors_and_one_buffer() {
        let image = driving_image();
        let header = parse_header(&image.bytes, image.bytes.len()).expect("header");
        assert_eq!((header.num_buf, header.num_vars, header.buf_len), (3, VARS.len(), image.buf_len));
        let (vars, buf) = image.values(0);
        assert_eq!(vars.len(), VARS.len());
        assert_eq!(vars["SessionTime"].kind, Kind::Double);
        let values = Values { vars: &vars, buf: &buf };
        assert_eq!(values.number("SessionTime"), Some(120.25));
        assert_eq!(values.number("Gear"), Some(4.0));
        assert_eq!(values.flag("IsOnTrack"), Some(true));
        assert_eq!(values.number("Lat"), None, "a variable this build does not publish is not given");
    }

    #[test]
    fn turns_a_buffer_into_a_frame_in_the_units_of_the_lap_file() {
        let image = driving_image();
        let (vars, buf) = image.values(0);
        let values = Values { vars: &vars, buf: &buf };
        let session = parse_session(SESSION);
        let (frame, estimated) = frame_from(&values, &session, &mut Path::default(), 9.0);
        assert!(estimated, "no Lat/Lon: the position is estimated");
        assert!(frame.driving);
        assert_eq!((frame.lap, frame.clock_s), (3, 9.0));
        assert_eq!(frame.lap_time_s, Some(41.5));
        assert!((frame.last_lap_s.unwrap() - 138.912).abs() < 1e-3);
        assert_eq!(frame.dist_m, Some(2210.0));
        assert_eq!((frame.speed_ms, frame.rpm, frame.gear), (61.0, 6400.0, 4.0));
        assert_eq!((frame.throttle, frame.brake), (0.75, 0.0));
        assert_eq!(frame.clutch, 0.0, "clutch fully engaged is the pedal up");
        assert_eq!(frame.steer, -0.125, "0.5 rad to the left of a 4 rad wheel");
        assert_eq!(frame.fuel_l, 31.5);
        assert_eq!(frame.track, "Circuit de Spa-Francorchamps");
        assert_eq!(frame.track_variant.as_deref(), Some("Grand Prix Pits"));
        assert_eq!(frame.track_length_m, Some(6930.0));
        assert_eq!(
            (frame.car.as_str(), frame.car_class.as_deref()),
            ("Mazda MX-5 Cup", Some("MX5 Cup"))
        );
        assert!(frame.y.is_nan(), "no height without Alt");
    }

    #[test]
    fn a_replay_or_the_garage_is_not_driving_and_no_last_lap_is_none() {
        let mut image = driving_image();
        image.set(0, "IsReplayPlaying", 1.0);
        image.set(0, "LapLastLapTime", -1.0);
        image.set(0, "LapDist", -3.0);
        let (vars, buf) = image.values(0);
        let (frame, _) = frame_from(&Values { vars: &vars, buf: &buf }, &Session::default(), &mut Path::default(), 0.0);
        assert!(!frame.driving);
        assert_eq!(frame.last_lap_s, None);
        assert_eq!(frame.dist_m, Some(0.0), "just before the line reads a little below zero");
        image.set(0, "IsReplayPlaying", 0.0);
        image.set(0, "IsOnTrack", 0.0);
        let (vars, buf) = image.values(0);
        let (frame, _) = frame_from(&Values { vars: &vars, buf: &buf }, &Session::default(), &mut Path::default(), 0.0);
        assert!(!frame.driving);
    }

    #[test]
    fn refuses_a_header_it_cannot_believe() {
        let image = driving_image();
        let len = image.bytes.len();
        let broken = |at: usize, v: i32| {
            let mut bytes = image.bytes.clone();
            bytes[at..at + 4].copy_from_slice(&v.to_le_bytes());
            parse_header(&bytes, len)
        };
        assert!(broken(at::VER, 1).is_none(), "another SDK version");
        assert!(broken(at::NUM_BUF, 0).is_none());
        assert!(broken(at::NUM_BUF, 5).is_none());
        assert!(broken(at::NUM_VARS, 100_000).is_none());
        assert!(broken(at::BUF_LEN, 1 << 30).is_none(), "buffers past the end of the memory");
        assert!(broken(at::SESSION_INFO_OFFSET, len as i32).is_none());
        assert!(broken(at::VAR_HEADER_OFFSET, -4).is_none());
        assert!(parse_header(&image.bytes[..50], len).is_none());
    }

    #[test]
    fn leaves_out_a_descriptor_with_an_unknown_type_or_past_the_buffer() {
        let mut image = driving_image();
        image.put_i32(HEADER_SIZE + at::V_TYPE, 9);
        image.put_i32(HEADER_SIZE + VAR_HEADER_SIZE + at::V_OFFSET, image.buf_len as i32);
        let (vars, _) = image.values(0);
        assert!(!vars.contains_key("SessionTime") && !vars.contains_key("IsOnTrack"));
        assert_eq!(vars.len(), VARS.len() - 2);
    }

    #[test]
    fn takes_the_newest_buffer_by_tick_count() {
        let mut image = driving_image();
        image.tick(0, 10);
        image.tick(1, 12);
        image.tick(2, 11);
        let header = parse_header(&image.bytes, image.bytes.len()).unwrap();
        let (slot, tick, offset) = header.newest();
        assert_eq!((slot, tick, offset), (1, 12, image.buf_base + image.buf_len));
    }

    #[test]
    fn reads_track_and_car_out_of_the_session_info() {
        let session = parse_session(SESSION);
        assert_eq!(session.track, "Circuit de Spa-Francorchamps");
        assert_eq!(session.variant.as_deref(), Some("Grand Prix Pits"));
        assert_eq!(session.length_m, Some(6930.0));
        assert_eq!(session.car, "Mazda MX-5 Cup", "the car of DriverCarIdx, not the first one listed");
        assert_eq!(session.car_class.as_deref(), Some("MX5 Cup"));
        // No config name, no display name: the short name stands for the track.
        let bare = parse_session("WeekendInfo:\n TrackName: lime rock\n TrackLength: 2.4 mi\n");
        assert_eq!((bare.track.as_str(), bare.variant.clone()), ("lime rock", None));
        assert!((bare.length_m.unwrap() - 3862.4256).abs() < 1e-3);
        assert_eq!(bare.car, "");
    }

    #[test]
    fn decodes_latin1_session_text_and_stops_at_the_zero() {
        assert_eq!(
            decode_session(b"TrackDisplayName: Aut\xf3dromo\0junk"),
            "TrackDisplayName: Autódromo"
        );
        assert_eq!(decode_session("Autódromo\0".as_bytes()), "Autódromo");
    }

    /// Feeds the path readings at 60 Hz of a car going at `speed` while its heading follows `yaw(t)`.
    fn drive(path: &mut Path, seconds: f64, speed: f64, yaw: impl Fn(f64) -> f64, lap: i32) -> (f32, f32) {
        let mut image = Image::new(VARS, b"");
        let mut last = (f32::NAN, f32::NAN);
        let steps = (seconds * 60.0).round() as usize;
        for i in 0..=steps {
            let t = i as f64 / 60.0;
            image.set(0, "SessionTime", 1000.0 + t);
            image.set(0, "Yaw", yaw(t));
            image.set(0, "VelocityX", speed);
            image.set(0, "VelocityY", 0.0);
            let (vars, buf) = image.values(0);
            let (x, _, z, _) = path.step(&Values { vars: &vars, buf: &buf }, true, lap);
            last = (x, z);
        }
        last
    }

    #[test]
    fn estimates_the_position_from_heading_and_speed_north_up() {
        // East at 10 m/s for 10 s: 100 m to the right.
        let (x, z) = drive(&mut Path::default(), 10.0, 10.0, |_| 0.0, 1);
        assert!((x - 100.0).abs() < 0.01 && z.abs() < 0.01, "{x} {z}");
        // North: up on the map, which is z going down.
        let (x, z) = drive(&mut Path::default(), 10.0, 10.0, |_| std::f64::consts::FRAC_PI_2, 1);
        assert!(x.abs() < 0.01 && (z + 100.0).abs() < 0.01, "{x} {z}");
    }

    #[test]
    fn a_full_circle_comes_back_and_a_left_turn_is_drawn_as_one() {
        // Radius 100 m at 20 m/s, turning left (counter-clockwise): one turn takes 2πr/v seconds.
        let period = std::f64::consts::TAU * 100.0 / 20.0;
        let mut path = Path::default();
        let (qx, qz) = drive(&mut path, period / 4.0, 20.0, |t| t * 20.0 / 100.0, 1);
        // A quarter of a left turn from heading east ends up north-east of the start: right and up (z negative).
        assert!((qx - 100.0).abs() < 1.0 && (qz + 100.0).abs() < 1.0, "{qx} {qz}");
        let mut path = Path::default();
        let (x, z) = drive(&mut path, period, 20.0, |t| t * 20.0 / 100.0, 1);
        assert!(x.hypot(z) < 1.0, "closes within a metre: {x} {z}");
    }

    #[test]
    fn every_lap_starts_at_the_line() {
        let mut path = Path::default();
        drive(&mut path, 5.0, 10.0, |_| 0.0, 1);
        let mut image = Image::new(VARS, b"");
        image.set(0, "SessionTime", 2000.0);
        image.set(0, "VelocityX", 10.0);
        let (vars, buf) = image.values(0);
        let (x, _, z, _) = path.step(&Values { vars: &vars, buf: &buf }, true, 2);
        assert_eq!((x, z), (0.0, 0.0));
    }

    #[test]
    fn uses_lat_and_lon_when_the_build_publishes_them() {
        let mut vars_list = VARS.to_vec();
        vars_list.extend([("Lat", Kind::Double), ("Lon", Kind::Double), ("Alt", Kind::Float)]);
        let mut image = Image::new(&vars_list, b"");
        image.set(0, "Lat", 50.0);
        image.set(0, "Lon", 5.0);
        image.set(0, "Alt", 400.0);
        let mut path = Path::default();
        let (vars, buf) = image.values(0);
        assert_eq!(path.step(&Values { vars: &vars, buf: &buf }, true, 1), (0.0, 400.0, 0.0, false));
        image.set(0, "Lat", 50.001);
        let (vars, buf) = image.values(0);
        let (x, _, z, estimated) = path.step(&Values { vars: &vars, buf: &buf }, true, 1);
        assert!(
            !estimated && x.abs() < 0.01 && (z + 111.2).abs() < 0.1,
            "a thousandth of a degree north: {x} {z}"
        );
    }

    fn lap_with(x: Vec<f32>, z: Vec<f32>, dist: Vec<f32>, length: Option<f64>) -> Lap {
        let channel = |id: &str, values: Vec<f32>| Channel {
            id: id.into(),
            unit: "m".into(),
            values,
        };
        Lap {
            game: "iracing".into(),
            track_name: "Test".into(),
            track_variant: None,
            track_length_m: length,
            car_name: "Car".into(),
            car_class: None,
            lap_number: 1,
            time_ms: 60_000,
            valid: true,
            sectors_ms: None,
            started_at: "2026-11-11T00:00:00.000Z".into(),
            sample_rate_hz: 60.0,
            channels: vec![channel("dist", dist), channel("x", x), channel("z", z)],
        }
    }

    #[test]
    fn closes_a_lap_that_drifted_and_leaves_one_that_did_not_come_back() {
        let mut lap = lap_with(vec![0.0, 100.0, 8.0], vec![0.0, -50.0, 6.0], vec![0.0, 500.0, 1000.0], Some(1000.0));
        close_loop(&mut lap);
        assert_eq!(lap.channels[1].values, vec![0.0, 96.0, 0.0]);
        assert_eq!(lap.channels[2].values, vec![0.0, -53.0, 0.0]);
        // 300 m off on a 1000 m track is not drift.
        let mut far = lap_with(vec![0.0, 100.0, 300.0], vec![0.0, 0.0, 0.0], vec![0.0, 500.0, 1000.0], Some(1000.0));
        let before = far.clone();
        close_loop(&mut far);
        assert_eq!(far, before);
    }

    #[test]
    fn reads_the_sims_memory_end_to_end() {
        let mut image = driving_image();
        let fake = FakeMemory::new("iracing", image.bytes.len());
        fake.write(0, &image.bytes);
        let mut reader = IRacing::open_named(&fake.name).expect("opens");
        assert_eq!((reader.game_id(), reader.game_name()), ("iracing", "iRacing"));
        let frame = reader.next(Duration::ZERO).expect("a frame");
        assert!(frame.driving && frame.lap == 3);
        assert_eq!(frame.car, "Mazda MX-5 Cup");
        assert!(reader.next(Duration::ZERO).is_none(), "the same tick is not read twice");

        // A newer buffer is read.
        image.set(1, "IsOnTrack", 1.0);
        image.set(1, "Lap", 4.0);
        image.tick(1, 11);
        fake.write(0, &image.bytes);
        assert_eq!(reader.next(Duration::ZERO).map(|f| f.lap), Some(4));

        // The sim leaves the session: one frame that is not driving, then nothing.
        image.put_i32(at::STATUS, 0);
        fake.write(0, &image.bytes);
        let frame = reader.next(Duration::ZERO).expect("one frame on leaving");
        assert!(!frame.driving);
        assert!(reader.next(Duration::ZERO).is_none());
    }

    #[test]
    fn does_not_open_a_memory_of_another_sdk_version() {
        let mut image = driving_image();
        image.put_i32(at::VER, 1);
        let fake = FakeMemory::new("iracing-v1", image.bytes.len());
        fake.write(0, &image.bytes);
        assert!(IRacing::open_named(&fake.name).is_none());
    }
}
