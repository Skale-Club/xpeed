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
//! The race: `PlayerCarPosition` and `PlayerCarClassPosition` (1 is first, 0 none), `SessionTimeRemain` (seconds; an
//! unlimited session writes about a week, which is past a day and so not given) and `SessionLapsTotal` (the SDK's
//! "unlimited" is 32767, past the lap limit, so not given), all looked up by name like every variable: a build that
//! does not publish one gives none. The cars are counted from the session info, not from a variable: the entries of
//! `DriverInfo: Drivers` that are not the pace car (`CarIsPaceCar: 1`, or the user name "Pace Car", as the test fixture
//! has it) and not a spectator (`IsSpectator: 1`).
//!
//! The rivals (`Frame::field`) and the spotter (`Frame::spotter`), all ASSUMED and listed in "to confirm" below. The
//! rivals are read at most every 200 ms (`FieldPace`):
//!
//! * The per-car arrays of the telemetry (up to 64 elements, the index being the `CarIdx` of the driver list):
//!   `CarIdxPosition` and `CarIdxClassPosition` (1 is first, 0 none), `CarIdxLapCompleted` (laps done, -1 not in the
//!   world), `CarIdxLapDistPct` (0 to 1 round the lap, -1 off the track), `CarIdxOnPitRoad`, `CarIdxLastLapTime` and
//!   `CarIdxBestLapTime` (seconds, -1 none) and `CarIdxClass` (a number, used for the class only when the driver list has
//!   no `CarClassShortName`: then `iRacing class <n>`). The arrays are found by name like every variable, with the
//!   descriptor's `count` (a variable whose elements would run past the buffer is not read).
//! * The names and classes come from `DriverInfo: Drivers` (`UserName`, `CarClassShortName`), the cars being the racing
//!   ones (no pace car, no spectator, the same rule as `cars`); the player's own car is `DriverCarIdx`. A car with no
//!   place, no laps and no share of the lap (it left the session) is left out, the player's own never.
//! * No world positions: the SDK gives none for the other cars (`RIVALS`, not `RIVALS_WORLD`). No gap to the car ahead:
//!   `field::complete` estimates them from the laps and the share of the lap.
//! * The spotter is `CarLeftRight`, the SDK's `irsdk_CarLeftRight`: 0 off (not given), 1 clear, 2 a car left, 3 a car
//!   right, 4 cars on both sides, 5 two cars left, 6 two cars right. Given only while driving.
//!
//! `driving` is `IsOnTrack` (the player is in the car and its physics run) and not `IsReplayPlaying`.
//!
//! # Phase
//!
//! `IsReplayPlaying` is `Replay`; else `IsOnTrack` is `Driving`; else `IsInGarage` (when the build publishes it) is
//! `Garage`; anything else is `Unknown` (the sim's menus, the pause of an offline session and the pit stall are not
//! told apart, and the telemetry is the player's own car even when watching another, so `Spectating` is not told
//! either). The sim leaving a session gives one empty `Unknown` frame. The car values are left as the sim gives them
//! outside `Driving`: the audit found no stale or zeroed values here.
//!
//! # Where the car is (the map)
//!
//! ASSUMED, never checked against a live game: the axes below. They contradict EVO's and Automobilista 2's (z = north);
//! `game.rs` and `fixtures/README.md` list this one to be settled by a fixture (`map_direction`). The lap number `Lap` is
//! passed through and its first lap may be 0 or 1 (ASSUMED too).
//!
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
//! the clutch and steering conventions above, the program name, and the race values (the four variable names and
//! what they hold in a lap-based, a timed and an unlimited session, and the pace car and spectator markers in
//! `DriverInfo`). They come from the SDK's descriptions and from
//! the tools that read it; the first real session confirms or corrects them. Also to confirm: the names of the eight
//! `CarIdx*` arrays and what they hold outside a race (the position arrays are probably 0 in a practice session), that
//! `CarIdx` of the driver list is the index into them, the `CarLeftRight` numbers, and that `UserName` is the name to
//! show (`TeamName` is not read).
//!
//! Never read: another process's memory. Only the sim's own shared memory, read-only and copied out.

use std::collections::HashMap;
use std::sync::Arc;
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::field::{self, Car, Field, FieldPace};
use crate::game::{Caps, Frame, Phase, Source, Spotter};
use crate::lapfile::Lap;
use crate::norm::{self, pedal, within};
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
    pub const V_COUNT: usize = 8;
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

/// Where one variable sits inside a telemetry buffer: its first element, and how many it has (1 for a single value, up to
/// 64 for the per-car arrays).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Var {
    kind: Kind,
    offset: usize,
    count: usize,
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

/// The variables, by name, out of `count` descriptors. A descriptor with a type the SDK does not have, or whose values
/// would sit past the end of a buffer, is left out. An element count of 0 or less is read as 1.
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
        let elements = usize_of(page.i32_at(base + at::V_COUNT)).filter(|&c| c >= 1).unwrap_or(1);
        if offset
            .checked_add(kind.size().saturating_mul(elements))
            .is_none_or(|end| end > buf_len)
        {
            continue;
        }
        let name = page.ascii_at(base + at::V_NAME, at::V_NAME_LEN);
        if !name.is_empty() {
            vars.insert(
                name,
                Var {
                    kind,
                    offset,
                    count: elements,
                },
            );
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
        self.element(name, 0)
    }

    /// Element `index` of a variable (the per-car arrays) as a float; `None` when this build does not publish the variable,
    /// it has no such element, or the value is not a finite number.
    fn element(&self, name: &str, index: usize) -> Option<f64> {
        let var = self.vars.get(name)?;
        if index >= var.count {
            return None;
        }
        let at = var.offset + index * var.kind.size();
        let page = Page(self.buf);
        let v = match var.kind {
            Kind::Char | Kind::Bool => f64::from(page.u8_at(at)),
            Kind::Int | Kind::BitField => f64::from(page.i32_at(at)),
            Kind::Float => f64::from(page.f32_at(at)),
            Kind::Double => f64::from_le_bytes(self.buf.get(at..at + 8)?.try_into().ok()?),
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
    /// The cars in the session, from the driver list.
    cars: Option<u16>,
    /// The racing cars of the driver list (the rivals layer's names and classes).
    drivers: Vec<Driver>,
    /// `DriverCarIdx`: the player's own car in the driver list.
    player_idx: Option<u16>,
}

/// One racing car of the driver list.
#[derive(Clone, Debug, PartialEq)]
struct Driver {
    /// `CarIdx`: the index of the car in every per-car array.
    idx: u16,
    name: String,
    class: Option<String>,
}

/// The entries of `Drivers`, each as its own lines.
fn driver_entries<'a>(drivers: &[&'a str]) -> Vec<Vec<&'a str>> {
    let mut entries: Vec<Vec<&str>> = Vec::new();
    for line in drivers {
        if line.trim_start().starts_with("- ") {
            entries.push(Vec::new());
        }
        if let Some(entry) = entries.last_mut() {
            entry.push(*line);
        }
    }
    entries
}

/// An entry that is racing: not the pace car and not a spectator.
fn is_racing(entry: &[&str]) -> bool {
    let is = |key: &str| first_value(entry, key).as_deref() == Some("1");
    first_value(entry, "CarIdx").is_some()
        && !is("CarIsPaceCar")
        && !is("IsSpectator")
        && first_value(entry, "UserName").as_deref() != Some("Pace Car")
}

/// The cars of the driver list that are racing: every entry of `Drivers` but the pace car and the spectators.
fn count_cars(drivers: &[&str]) -> Option<u16> {
    let racing = driver_entries(drivers).iter().filter(|entry| is_racing(entry)).count();
    norm::cars(racing as i64)
}

/// The racing cars with their `CarIdx`, name and class; an entry whose `CarIdx` is not a number is left out.
fn racing_drivers(drivers: &[&str]) -> Vec<Driver> {
    driver_entries(drivers)
        .iter()
        .filter(|entry| is_racing(entry))
        .filter_map(|entry| {
            Some(Driver {
                idx: first_value(entry, "CarIdx")?.parse().ok()?,
                name: first_value(entry, "UserName").unwrap_or_default(),
                class: first_value(entry, "CarClassShortName"),
            })
        })
        .collect()
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
    let player_idx = player.as_deref().and_then(|p| p.parse().ok());
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
        cars: count_cars(&drivers),
        drivers: racing_drivers(&drivers),
        player_idx,
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
    let in_garage = values.flag("IsInGarage").unwrap_or(false);
    frame.set_phase(if replay {
        Phase::Replay
    } else if on_track {
        Phase::Driving
    } else if in_garage {
        Phase::Garage
    } else {
        Phase::Unknown
    });
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
    frame.gear = {
        let gear = values.float("Gear");
        if gear.is_finite() {
            norm::gear(gear.round() as i32)
        } else {
            f32::NAN
        }
    };
    frame.throttle = pedal(values.float("Throttle"));
    frame.brake = pedal(values.float("Brake"));
    // 1 = clutch fully engaged (pedal up) in the sim, so the pedal is turned around; NaN stays NaN.
    frame.clutch = 1.0 - pedal(values.float("Clutch"));
    frame.steer = {
        let angle = values.float("SteeringWheelAngle");
        let max = values.float("SteeringWheelAngleMax");
        if max.is_finite() && max > 0.0 {
            norm::steer(-angle / max)
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
    frame.cars = session.cars;
    let whole = |name: &str| values.number(name).map(|v| v as i64);
    frame.race_position = whole("PlayerCarPosition").and_then(|p| norm::place(p, frame.cars));
    frame.class_position = whole("PlayerCarClassPosition").and_then(|p| norm::place(p, frame.cars));
    frame.session_time_left_s = values.number("SessionTimeRemain").and_then(norm::time_left_s);
    frame.session_laps = whole("SessionLapsTotal").and_then(norm::race_laps);
    frame.spotter = values
        .number("CarLeftRight")
        .filter(|_| frame.driving)
        .and_then(|v| spotter_of(v as i64));
    // Every frame the reader tests make is held to the caps and the phase invariant.
    #[cfg(test)]
    crate::game::assert_frame_within_caps(&frame, CAPS, "iracing");
    (frame, estimated)
}

/// The SDK's `irsdk_CarLeftRight` as the spotter: 0 is off (not given), 1 clear, 2 a car left, 3 a car right, 4 cars on
/// both sides, 5 two cars left, 6 two cars right. Anything else is not given.
fn spotter_of(v: i64) -> Option<Spotter> {
    Some(match v {
        1 => Spotter::Clear,
        2 => Spotter::Left,
        3 => Spotter::Right,
        4 => Spotter::Both,
        5 => Spotter::TwoLeft,
        6 => Spotter::TwoRight,
        _ => return None,
    })
}

/// A lap time of the per-car arrays: -1 and 0 are "none yet", and a time past a day is not a lap.
fn lap_time(v: Option<f64>) -> Option<f64> {
    v.filter(|t| *t > 0.0 && *t <= 86_400.0)
}

/// The racing cars of the session in the units of the rivals layer, from the per-car arrays (indexed by `CarIdx`) and the
/// driver list. A car with no place, no laps and no share of the lap is not in the session now and is left out (the
/// player's own never); `None` when no car is left.
fn field_from(values: &Values, session: &Session, clock_s: f64, track_length_m: Option<f64>) -> Option<Arc<Field>> {
    // A build without the per-car arrays has no field at all (not a field of the player alone).
    if ["CarIdxPosition", "CarIdxLapCompleted", "CarIdxLapDistPct"].iter().all(|name| values.element(name, 0).is_none()) {
        return None;
    }
    let mut cars = Vec::new();
    for driver in &session.drivers {
        let idx = usize::from(driver.idx);
        let whole = |name: &str| values.element(name, idx).map(|v| v as i64);
        let name = if driver.name.is_empty() {
            format!("Car {}", driver.idx)
        } else {
            driver.name.clone()
        };
        let mut car = Car::named(driver.idx, &name);
        car.class = driver
            .class
            .clone()
            .or_else(|| whole("CarIdxClass").filter(|c| *c >= 0).map(|c| format!("iRacing class {c}")));
        car.position = whole("CarIdxPosition").and_then(|p| norm::place(p, session.cars));
        car.class_position = whole("CarIdxClassPosition").and_then(|p| norm::place(p, session.cars));
        car.laps_done = whole("CarIdxLapCompleted")
            .and_then(|l| i32::try_from(l).ok())
            .filter(|l| (0..=100_000).contains(l));
        car.lap_share = values
            .element("CarIdxLapDistPct", idx)
            .filter(|p| (0.0..=1.05).contains(p))
            .map(|p| p.min(1.0) as f32);
        car.in_pits = values.element("CarIdxOnPitRoad", idx).is_some_and(|v| v != 0.0);
        car.last_lap_s = lap_time(values.element("CarIdxLastLapTime", idx));
        car.best_lap_s = lap_time(values.element("CarIdxBestLapTime", idx));
        car.is_player = session.player_idx == Some(driver.idx);
        if !car.is_player && car.position.is_none() && car.laps_done.is_none() && car.lap_share.is_none() {
            continue;
        }
        cars.push(car);
    }
    (!cars.is_empty()).then(|| field::publish(cars, clock_s, track_length_m))
}

/// What a frame can fill. The position is the SDK's `Lat`/`Lon` when the build publishes them, else the path worked out
/// from the velocity (`Path`). Not given: tyres, temperatures, the car's state lights, the session kind, the sectors
/// and the g forces (none is read), and the tank's size.
const CAPS: Caps = Caps::LAP_TIME
    .or(Caps::LAST_LAP)
    .or(Caps::DIST)
    .or(Caps::IN_PITS)
    .or(Caps::SPEED)
    .or(Caps::RPM)
    .or(Caps::GEAR)
    .or(Caps::THROTTLE)
    .or(Caps::BRAKE)
    .or(Caps::CLUTCH)
    .or(Caps::STEER)
    .or(Caps::POSITION)
    .or(Caps::FUEL)
    .or(Caps::CAR_CLASS)
    .or(Caps::TRACK_VARIANT)
    .or(Caps::TRACK_LENGTH)
    .or(Caps::RACE_POSITION)
    .or(Caps::CLASS_POSITION)
    .or(Caps::CARS)
    .or(Caps::SESSION_TIME_LEFT)
    .or(Caps::SESSION_LAPS)
    .or(Caps::RIVALS)
    .or(Caps::SPOTTER);

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
    /// When the other cars are read (a few Hz, not on every sample).
    pace: FieldPace,
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
            pace: FieldPace::default(),
        })
    }

    /// The sim left the session (or its header cannot be believed): one frame that is not driving, then nothing.
    fn disconnect(&mut self) -> Option<Frame> {
        self.vars_for = None;
        self.session_update = None;
        self.last_tick = None;
        self.path.last_t = None;
        self.pace = FieldPace::default();
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
        let (mut frame, estimated) = frame_from(&values, &self.session, &mut self.path, self.started.elapsed().as_secs_f64());
        if self.pace.due(frame.clock_s) {
            frame.field = field_from(&values, &self.session, frame.clock_s, frame.track_length_m);
        }
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

    fn caps(&self) -> Caps {
        CAPS
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
        ("PlayerCarPosition", Kind::Int),
        ("PlayerCarClassPosition", Kind::Int),
        ("SessionTimeRemain", Kind::Double),
        ("SessionLapsTotal", Kind::Int),
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
            let sized: Vec<(&'static str, Kind, usize)> = vars.iter().map(|&(name, kind)| (name, kind, 1)).collect();
            Image::sized(&sized, session)
        }

        /// The same with a count of elements per variable (the per-car arrays have 64).
        fn sized(vars: &[(&'static str, Kind, usize)], session: &[u8]) -> Image {
            let mut offsets = HashMap::new();
            let mut offset: usize = 0;
            for &(name, kind, count) in vars {
                offsets.insert(name, (kind, offset));
                offset += (kind.size() * count).next_multiple_of(8);
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
            for (i, &(name, kind, count)) in vars.iter().enumerate() {
                let base = var_headers + i * VAR_HEADER_SIZE;
                image.put_i32(base + at::V_TYPE, code_of(kind));
                image.put_i32(base + at::V_OFFSET, image.vars[name].1 as i32);
                image.put_i32(base + at::V_COUNT, count as i32);
                image.bytes[base + at::V_NAME..base + at::V_NAME + name.len()].copy_from_slice(name.as_bytes());
            }
            image.bytes[session_at..session_at + session.len()].copy_from_slice(session);
            image
        }

        fn put_i32(&mut self, at: usize, v: i32) {
            self.bytes[at..at + 4].copy_from_slice(&v.to_le_bytes());
        }

        fn set(&mut self, slot: usize, name: &str, v: f64) {
            self.set_at(slot, name, 0, v);
        }

        /// Element `index` of an array variable.
        fn set_at(&mut self, slot: usize, name: &str, index: usize, v: f64) {
            let (kind, offset) = self.vars[name];
            let at = self.buf_base + slot * self.buf_len + offset + index * kind.size();
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
        driving_image_of(VARS, SESSION)
    }

    /// The driving moment with the variables of `vars` (which hold the ones of `VARS`) and a session text.
    fn driving_image_of(vars: &[(&'static str, Kind)], session: &str) -> Image {
        let mut image = Image::new(vars, session.as_bytes());
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
            // Second overall and first in the class, 25 minutes left and a 20-lap length (both set here).
            ("PlayerCarPosition", 2.0),
            ("PlayerCarClassPosition", 1.0),
            ("SessionTimeRemain", 1500.5),
            ("SessionLapsTotal", 20.0),
        ] {
            image.set(0, name, v);
        }
        image.tick(0, 10);
        image
    }

    #[test]
    fn the_race_values_are_read_by_name_and_the_pace_car_is_not_counted() {
        let image = driving_image();
        let (vars, buf) = image.values(0);
        let values = Values { vars: &vars, buf: &buf };
        let session = parse_session(SESSION);
        assert_eq!(session.cars, Some(2), "the pace car and nobody else is left out");
        let (frame, _) = frame_from(&values, &session, &mut Path::default(), 0.0);
        assert_eq!((frame.race_position, frame.class_position, frame.cars), (Some(2), Some(1), Some(2)));
        assert_eq!((frame.session_time_left_s, frame.session_laps), (Some(1500.5), Some(20)));
        // The pace car and the spectators by their own markers, whatever the user name.
        let yaml = "DriverInfo:\n DriverCarIdx: 1\n Drivers:\n- CarIdx: 0\n   UserName: Safety\n   CarIsPaceCar: 1\n \
- CarIdx: 1\n   UserName: Me\n   CarIsPaceCar: 0\n   IsSpectator: 0\n - CarIdx: 2\n   UserName: Watcher\n   IsSpectator: 1\n \
- CarIdx: 3\n   UserName: Other\n";
        assert_eq!(parse_session(yaml).cars, Some(2));
        assert_eq!(parse_session("WeekendInfo:\n TrackName: x\n").cars, None, "no driver list");
        // Unlimited and not-given values: a week of seconds, 32767 laps, no position yet, a place past the field.
        for (name, v) in [
            ("SessionTimeRemain", 604_800.0),
            ("SessionLapsTotal", 32_767.0),
            ("PlayerCarPosition", 0.0),
            ("PlayerCarClassPosition", 3.0),
        ] {
            let mut image = driving_image();
            image.set(0, name, v);
            let (vars, buf) = image.values(0);
            let (frame, _) = frame_from(&Values { vars: &vars, buf: &buf }, &session, &mut Path::default(), 0.0);
            assert_eq!(
                (
                    frame.race_position,
                    frame.class_position,
                    frame.session_time_left_s,
                    frame.session_laps
                ),
                match name {
                    "SessionTimeRemain" => (Some(2), Some(1), None, Some(20)),
                    "SessionLapsTotal" => (Some(2), Some(1), Some(1500.5), None),
                    "PlayerCarPosition" => (None, Some(1), Some(1500.5), Some(20)),
                    _ => (Some(2), None, Some(1500.5), Some(20)),
                },
                "{name}"
            );
        }
        // A build that publishes none of the four variables gives none of them.
        let mut image = Image::new(&VARS[..VARS.len() - 4], SESSION.as_bytes());
        image.set(0, "IsOnTrack", 1.0);
        image.tick(0, 10);
        let (vars, buf) = image.values(0);
        let (frame, _) = frame_from(&Values { vars: &vars, buf: &buf }, &Session::default(), &mut Path::default(), 0.0);
        assert_eq!(
            (
                frame.race_position,
                frame.class_position,
                frame.cars,
                frame.session_time_left_s,
                frame.session_laps
            ),
            (None, None, None, None, None)
        );
    }

    /// Three racers (the player is index 2), the pace car and a spectator.
    const RACE_SESSION: &str =
        "---\nWeekendInfo:\n TrackName: spa 2024 gp\n TrackLength: 6.93 km\nDriverInfo:\n DriverCarIdx: 2\n Drivers:\n \
- CarIdx: 0\n   UserName: Pace Car\n   CarIsPaceCar: 1\n \
- CarIdx: 1\n   UserName: Leader\n   CarClassShortName: GT3\n \
- CarIdx: 2\n   UserName: Me\n   CarClassShortName: GT3\n \
- CarIdx: 3\n   UserName: Slower\n   CarClassShortName: MX5 Cup\n \
- CarIdx: 4\n   UserName: Watcher\n   IsSpectator: 1\n\n...\n";

    const ARRAYS: &[(&str, Kind)] = &[
        ("CarIdxPosition", Kind::Int),
        ("CarIdxClassPosition", Kind::Int),
        ("CarIdxLapCompleted", Kind::Int),
        ("CarIdxLapDistPct", Kind::Float),
        ("CarIdxOnPitRoad", Kind::Bool),
        ("CarIdxLastLapTime", Kind::Float),
        ("CarIdxBestLapTime", Kind::Float),
        ("CarIdxClass", Kind::Int),
    ];

    /// `VARS`, `CarLeftRight` and the per-car arrays of 64, filled for three cars: the leader (1), the player (2, in the pit
    /// lane) and a slower car of another class (3).
    fn race_image() -> Image {
        let mut vars: Vec<(&'static str, Kind, usize)> = VARS.iter().map(|&(n, k)| (n, k, 1)).collect();
        vars.push(("CarLeftRight", Kind::Int, 1));
        vars.extend(ARRAYS.iter().map(|&(n, k)| (n, k, 64)));
        let mut image = Image::sized(&vars, RACE_SESSION.as_bytes());
        for (name, v) in [("SessionTime", 120.25), ("IsOnTrack", 1.0), ("Lap", 5.0), ("LapDist", 2210.0)] {
            image.set(0, name, v);
        }
        // (index, position, class position, laps, share, in pits, last, best, class)
        for (i, pos, cpos, laps, share, pit, last, best, class) in [
            (1, 1, 1, 4, 0.75, 0, 140.5, 139.0, 11),
            (2, 2, 2, 4, 0.5, 1, 141.0, 140.0, 11),
            (3, 3, 1, 3, 0.25, 0, 160.0, 158.0, 12),
        ] {
            for (name, v) in [
                ("CarIdxPosition", f64::from(pos)),
                ("CarIdxClassPosition", f64::from(cpos)),
                ("CarIdxLapCompleted", f64::from(laps)),
                ("CarIdxLapDistPct", share),
                ("CarIdxOnPitRoad", f64::from(pit)),
                ("CarIdxLastLapTime", last),
                ("CarIdxBestLapTime", best),
                ("CarIdxClass", f64::from(class)),
            ] {
                image.set_at(0, name, i, v);
            }
        }
        // The pace car, the spectator and the empty slots: not in the world.
        for i in [0, 4, 5] {
            image.set_at(0, "CarIdxLapCompleted", i, -1.0);
            image.set_at(0, "CarIdxLapDistPct", i, -1.0);
        }
        image.tick(0, 10);
        image
    }

    #[test]
    fn the_per_car_arrays_become_the_field_with_the_names_of_the_driver_list() {
        let image = race_image();
        let (vars, buf) = image.values(0);
        assert_eq!(vars["CarIdxPosition"].count, 64);
        let session = parse_session(RACE_SESSION);
        assert_eq!((session.cars, session.player_idx), (Some(3), Some(2)));
        let ids: Vec<u16> = session.drivers.iter().map(|d| d.idx).collect();
        assert_eq!(ids, [1, 2, 3], "no pace car, no spectator");
        let field = field_from(&Values { vars: &vars, buf: &buf }, &session, 7.5, Some(6930.0)).expect("a field");
        assert_eq!(field.at_s, 7.5);
        let names: Vec<&str> = field.cars.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Leader", "Me", "Slower"]);
        let slots: Vec<u16> = field.cars.iter().map(|c| c.slot).collect();
        assert_eq!(slots, [1, 2, 3]);
        let places: Vec<(Option<u16>, Option<u16>)> = field.cars.iter().map(|c| (c.position, c.class_position)).collect();
        assert_eq!(places, [(Some(1), Some(1)), (Some(2), Some(2)), (Some(3), Some(1))]);
        let classes: Vec<Option<&str>> = field.cars.iter().map(|c| c.class.as_deref()).collect();
        assert_eq!(classes, [Some("GT3"), Some("GT3"), Some("MX5 Cup")]);
        let laps: Vec<Option<i32>> = field.cars.iter().map(|c| c.laps_done).collect();
        assert_eq!(laps, [Some(4), Some(4), Some(3)]);
        let shares: Vec<Option<f32>> = field.cars.iter().map(|c| c.lap_share).collect();
        assert_eq!(shares, [Some(0.75), Some(0.5), Some(0.25)]);
        let pits: Vec<bool> = field.cars.iter().map(|c| c.in_pits).collect();
        assert_eq!(pits, [false, true, false]);
        let last: Vec<Option<f64>> = field.cars.iter().map(|c| c.last_lap_s).collect();
        assert_eq!(last, [Some(140.5), Some(141.0), Some(160.0)]);
        let best: Vec<Option<f64>> = field.cars.iter().map(|c| c.best_lap_s).collect();
        assert_eq!(best, [Some(139.0), Some(140.0), Some(158.0)]);
        let player: Vec<bool> = field.cars.iter().map(|c| c.is_player).collect();
        assert_eq!(player, [false, true, false]);
        assert!(field.cars.iter().all(|c| c.world.is_none()), "the SDK gives no world positions");
        assert_eq!(field.cars[0].gap_leader_s, Some(0.0), "the gaps are the layer's estimate");
        // A car that left (no place, no laps, no share) is dropped; the player's own stays.
        let mut gone = race_image();
        gone.set_at(0, "CarIdxPosition", 3, 0.0);
        gone.set_at(0, "CarIdxLapCompleted", 3, -1.0);
        gone.set_at(0, "CarIdxLapDistPct", 3, -1.0);
        let (vars, buf) = gone.values(0);
        let field = field_from(&Values { vars: &vars, buf: &buf }, &session, 0.0, None).unwrap();
        let names: Vec<&str> = field.cars.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Leader", "Me"]);
        assert!(field.player().is_some());
        // A build with no per-car arrays gives no field.
        let image = driving_image_of(VARS, RACE_SESSION);
        let (vars, buf) = image.values(0);
        assert!(field_from(&Values { vars: &vars, buf: &buf }, &session, 0.0, None).is_none());
    }

    #[test]
    fn the_spotter_follows_car_left_right() {
        let vars: Vec<(&'static str, Kind)> = VARS.iter().copied().chain([("CarLeftRight", Kind::Int)]).collect();
        let session = Session::default();
        for (raw, want) in [
            (0.0, None),
            (1.0, Some(Spotter::Clear)),
            (2.0, Some(Spotter::Left)),
            (3.0, Some(Spotter::Right)),
            (4.0, Some(Spotter::Both)),
            (5.0, Some(Spotter::TwoLeft)),
            (6.0, Some(Spotter::TwoRight)),
            (7.0, None),
            (-1.0, None),
        ] {
            let mut image = driving_image_of(&vars, SESSION);
            image.set(0, "CarLeftRight", raw);
            let (v, buf) = image.values(0);
            let (frame, _) = frame_from(&Values { vars: &v, buf: &buf }, &session, &mut Path::default(), 0.0);
            assert_eq!(frame.spotter, want, "{raw}");
            if want.is_some() {
                assert!(frame.filled().has(Caps::SPOTTER));
            }
            // Not while the player is not in the car.
            image.set(0, "IsOnTrack", 0.0);
            let (v, buf) = image.values(0);
            let (frame, _) = frame_from(&Values { vars: &v, buf: &buf }, &session, &mut Path::default(), 0.0);
            assert_eq!(frame.spotter, None, "{raw} out of the car");
        }
        // A build that does not publish it gives none.
        let image = driving_image();
        let (v, buf) = image.values(0);
        let (frame, _) = frame_from(&Values { vars: &v, buf: &buf }, &session, &mut Path::default(), 0.0);
        assert_eq!(frame.spotter, None);
    }

    #[test]
    fn the_reader_publishes_the_field_with_a_frame_and_not_on_every_one() {
        let mut image = race_image();
        let fake = FakeMemory::new("iracing-field", image.bytes.len());
        fake.write(0, &image.bytes);
        let mut reader = IRacing::open_named(&fake.name).expect("opens");
        let frame = reader.next(Duration::ZERO).expect("a frame");
        let field = frame.field.as_ref().expect("the first reading carries the other cars");
        assert_eq!(field.cars.len(), 3);
        crate::game::assert_frame_within_caps(&frame, CAPS, "iracing");
        assert!(frame.filled().has(Caps::RIVALS) && !frame.filled().has(Caps::RIVALS_WORLD));
        // The next reading is inside the 200 ms: no field on it.
        image.set(1, "IsOnTrack", 1.0);
        image.tick(1, 11);
        fake.write(0, &image.bytes);
        assert!(reader.next(Duration::ZERO).expect("a frame").field.is_none());
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
    fn pedals_gear_and_wheel_follow_the_one_tolerance() {
        let frame_with = |changes: &[(&str, f32)]| {
            let mut image = driving_image();
            for &(name, v) in changes {
                image.set(0, name, f64::from(v));
            }
            let (vars, buf) = image.values(0);
            frame_from(&Values { vars: &vars, buf: &buf }, &Session::default(), &mut Path::default(), 0.0).0
        };
        // A hair outside the range is pulled in; the clutch is turned around (1 = engaged = pedal up).
        let f = frame_with(&[("Throttle", 1.2), ("Brake", -0.2), ("Clutch", 1.3), ("Gear", 25.0)]);
        assert_eq!((f.throttle, f.brake, f.clutch, f.gear), (1.0, 0.0, 0.0, 25.0));
        // Far outside it is not given: a different unit, not a pedal.
        let f = frame_with(&[("Throttle", 5.0), ("Brake", -1.0), ("Clutch", -4.0), ("Gear", 99.0)]);
        assert!(f.throttle.is_nan() && f.brake.is_nan() && f.clutch.is_nan() && f.gear.is_nan());
        let f = frame_with(&[("SteeringWheelAngle", 9.0), ("SteeringWheelAngleMax", 4.0)]);
        assert!(f.steer.is_nan(), "2.25 turns of lock beyond the maximum is not the wheel");
        let f = frame_with(&[("SteeringWheelAngle", -4.4), ("SteeringWheelAngleMax", 4.0)]);
        assert_eq!(f.steer, 1.0, "a hair past full lock is pulled in");
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
            ..Lap::default()
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
