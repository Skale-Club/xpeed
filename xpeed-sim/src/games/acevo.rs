//! Assetto Corsa EVO (`acevo`), EXPERIMENTAL: the shared memories `acevo_pmf_physics`, `acevo_pmf_graphics` and
//! `acevo_pmf_static`.
//!
//! The game is in early access and Kunos has not published an official layout that could be found. This reader is
//! written against three unofficial sources, and it is built to give nothing at all rather than numbers it cannot
//! vouch for. Nothing here has been checked against a running game.
//!
//! # Where the layout comes from
//!
//! * The names: the strings `acevo_pmf_physics`, `acevo_pmf_graphics` and `acevo_pmf_static` are in
//!   `AssettoCorsaEVO.exe`; community readers open them as `Local\acevo_pmf_*`. Both spellings are tried here.
//! * `acevo-shared-memory` 0.1.0 (<https://docs.rs/crate/acevo-shared-memory/0.1.0/source/>, file
//!   `src/bindings/source/wrapper.hpp`, the C++ header the crate binds, with `static_assert`s of the sizes of the
//!   sub-structs; also `src/mapper.rs`, `README.md`). It declares `#pragma pack(4)` and has no `car_ids` at the end of the
//!   graphics page.
//! * `kerb` 0.1.2 (<https://docs.rs/crate/kerb/0.1.2/source/src/ac_evo/structs.rs>, `SPageFilePhysicsEvo`,
//!   `SPageFileGraphicsEvo`, `SPageFileStaticEvo`, `#[repr(C)]`, claims "no `#pragma pack` anywhere"), which has `car_ids`.
//! * The community document "SharedFileOut.h" (<https://docs.google.com/document/d/1WzqMLkW2o_C0LGcvdMRelAV31ZIifux0CSHD9k6ddz0/>,
//!   exported as text; its PDF title is `ACE_SharedFileOut_Documentation_v1`). Its change log ends at `[2026-04-28] added
//!   "car_ids" to "SPageFileGraphicEvo"`. It gives meanings and units, no sizes of the three pages and no packing.
//!
//! No source names a game build. The change log dates put the layout at Assetto Corsa EVO 0.6.x (0.6 of 2026-04-15 reworked
//! the shared memory output; 0.6.2 and 0.6.3 touched its mapping). Later builds (0.8, 0.9) exist and nothing found says
//! whether they changed it.
//!
//! The two crates disagree about packing. For every field read here it does not matter: the sub-structs hold nothing
//! larger than four bytes, the `uint64_t` fields come first (offsets 8, 16, 24, 32, already 8-aligned) and only
//! `car_ids`, at the very end and not read, sits at 3940 (pack 4) or 3944 (natural). The test
//! `the_offsets_follow_from_the_sizes_in_the_sources` adds every field up, under both packings and both crates'
//! pads (the crates differ in the `place_holder` of two sub-structs, 140 against 143 and 137 against 138, which cancel
//! out once the struct is rounded to four bytes), and checks that they all land on the offsets used below and on the
//! `static_assert`ed sizes of the sub-structs (256, 128, 64), which is the strongest cross-check the sources allow.
//!
//! # How a mismatch shows
//!
//! * The page length. Windows rounds a shared memory up to whole 4096-byte pages (`Mapping::len`). The layout of the
//!   sources is: physics 800 bytes (one page, 4096), static 208 (4096), graphics 4904 with `car_ids`, or 4900 under
//!   pack 4 (two pages, 8192). The reader opens only when the three lengths are exactly 4096, 8192 and 4096.
//!   A graphics page of 4096 is the layout before `car_ids` (a build older than the 2026-04-28 change); anything longer
//!   than the sources' sizes means the structs grew and the offsets cannot be trusted. Both are refused. (This is a
//!   choice: if the game maps more than `sizeof` the reader will never open, which is better than guessing.)
//! * The static page holds `sm_version` and `ac_evo_version` (text, 15 bytes each). No source says what they contain,
//!   so no value is pinned; each must be non-empty printable ASCII with a digit and end in a zero inside its field.
//!   A blank or garbled marker (the page not written yet, a layout that moved) gives nothing, and is checked on every
//!   reading, not only at open. `open()` writes both strings in the log so that a value can be pinned after a first
//!   real run.
//! * `status` of the graphics page must be one of 0 to 3 (the document's `ACEVO_STATUS`); anything else is garbled.
//!
//! # What becomes of the lap
//!
//! * `driving`: graphics `status` is LIVE (2) and the lap count is believable. Off (0), replay (1) and pause (3) are not.
//! * `lap` = `total_lap_count` (laps completed) + 1; `lap_time_s` = `current_lap_time_ms` / 1000; `last_lap_s` =
//!   `last_laptime_ms` / 1000 when it is a real time.
//! * `lap_valid`: `is_valid_lap` and `timing_state.is_invalid` (a lap is not valid when either says so).
//! * `in_pits`: `is_in_pit_lane` or `is_in_pit_box`.
//! * `dist_m` is left `None`, so the lap cutter integrates the speed (`npos` is a spline fraction and is not used).
//! * Pedals, gear (physics: 0 reverse, 1 neutral, 2 first, so minus one), `rpms`, `speedKmh` / 3.6, `steerAngle`, `fuel`
//!   (litres) from the physics page. The position is the mean of the four `tyreContactPoint`s, the only world position
//!   of the player's car whose place in the page is the same under both packings (`car_coordinates` needs
//!   `car_ids`, whose offset depends on the packing); a position of exactly zero is "not given".
//! * Car: `car_model`; track and variant: `track`, `track_configuration`; track length: `track_length_m`, only when
//!   `session_state.lap_length_km` does not contradict it (within 2 %).
//!
//! # Not checked against a live game
//!
//! Everything. In particular: the sign and range of the steering, the polarity of the clutch (`0 = engaged`), whether
//! `total_lap_count` really counts completed laps from zero, whether `is_valid_lap` is filled in every mode, whether the
//! contact points are in the same world axes the other games use, the units of `fuel`, and that the pages are as long as
//! the sources say. The pages carry no sequence lock; the packet id before and after each copy is compared, which cannot
//! catch a copy torn after the id was written.
//!
//! Never read: another process's memory. Only the game's own shared memory, read-only and copied out.

use std::time::{Duration, Instant};

use crate::game::{CarState, Drs, Flag, Frame, Source};
use crate::shm::{Mapping, Page};

/// Windows gives a shared memory whole pages.
const PAGE: usize = 4096;
/// `sizeof(SPageFilePhysics)`.
const PHYSICS_BYTES: usize = 800;
/// `sizeof(SPageFileGraphicEvo)` with `car_ids`, natural alignment (kerb). With `#pragma pack(4)` it is 4900: the same two pages.
const GRAPHICS_BYTES: usize = 4904;
/// `sizeof(SPageFileStaticEvo)`.
const STATIC_BYTES: usize = 208;

/// Offsets (bytes) of the fields read.
mod phys {
    pub const PACKET_ID: usize = 0;
    pub const GAS: usize = 4;
    pub const BRAKE: usize = 8;
    pub const FUEL: usize = 12;
    pub const GEAR: usize = 16;
    pub const RPMS: usize = 20;
    pub const STEER_ANGLE: usize = 24;
    pub const SPEED_KMH: usize = 28;
    pub const CLUTCH: usize = 364;
    /// `float tyreContactPoint[4][3]`: 4 wheels, 12 bytes each.
    pub const TYRE_CONTACT_POINT: usize = 420;
}

mod gfx {
    pub const PACKET_ID: usize = 0;
    pub const STATUS: usize = 4;
    /// `bool tc_active`, `bool abs_active` ("actively intervening this frame") and `bool is_drs_available`.
    pub const TC_ACTIVE: usize = 45;
    pub const ABS_ACTIVE: usize = 46;
    pub const IS_DRS_AVAILABLE: usize = 53;
    /// `float handbrake_percent`: the handbrake's engagement, 0..1.
    pub const HANDBRAKE: usize = 84;
    /// `int8_t water_temperature_c` and `float oil_temperature_c`, Celsius.
    pub const WATER_TEMPERATURE_C: usize = 116;
    pub const OIL_TEMPERATURE_C: usize = 120;
    pub const CURRENT_LAP_TIME_MS: usize = 188;
    /// `SMEvoInstrumentation instrumentation` (128 bytes): `int8_t main_light_stage` at its start and
    /// `bool are_headlights_visible` 26 bytes in.
    pub const INSTRUMENTATION: usize = 1488;
    pub const HEADLIGHTS_VISIBLE: usize = INSTRUMENTATION + 26;
    /// `SMEvoElectronics electronics` (128 bytes), then `electronics_min_limit` and `electronics_max_limit`.
    pub const ELECTRONICS: usize = 1872;
    pub const ELECTRONICS_MAX_LIMIT: usize = ELECTRONICS + 2 * 128;
    /// Inside an `SMEvoElectronics`: `int8_t tc_level` (0 = off), `int8_t abs_level` (0 = off), `float brake_bias`
    /// (the front ratio, 0.56 = 56 % front), `int8_t engine_map_level`, `bool is_drs_open`, `bool is_pitlimiter_on`.
    pub const E_TC_LEVEL: usize = 0;
    pub const E_ABS_LEVEL: usize = 2;
    pub const E_BRAKE_BIAS: usize = 8;
    pub const E_ENGINE_MAP_LEVEL: usize = 12;
    pub const E_IS_DRS_OPEN: usize = 30;
    pub const E_IS_PITLIMITER_ON: usize = 38;
    /// `ACEVO_FLAG_TYPE flag` (shown to this driver) and `global_flag` (shown to all).
    pub const FLAG: usize = 2404;
    pub const GLOBAL_FLAG: usize = 2408;
    pub const TOTAL_LAP_COUNT: usize = 2384;
    pub const LAST_LAPTIME_MS: usize = 2396;
    /// `max_gears`: 16 bytes after `last_laptime_ms` (`best_laptime_ms`, `flag`, `global_flag`, then this).
    pub const MAX_GEARS: usize = 2412;
    /// `session_state.lap_length_km` (`session_state` at 2476, the field 84 bytes in).
    pub const SESSION_LAP_LENGTH_KM: usize = 2560;
    /// `timing_state.is_invalid` (`timing_state` at 2732, the field 117 bytes in).
    pub const TIMING_IS_INVALID: usize = 2849;
    pub const CAR_MODEL: usize = 3086;
    pub const IS_IN_PIT_BOX: usize = 3119;
    pub const IS_IN_PIT_LANE: usize = 3120;
    pub const IS_VALID_LAP: usize = 3121;
    /// What is copied: up to the end of `is_valid_lap`.
    pub const READ_LEN: usize = 3122;
}

mod stat {
    pub const SM_VERSION: usize = 0;
    pub const AC_EVO_VERSION: usize = 15;
    pub const VERSION_LEN: usize = 15;
    pub const TRACK: usize = 136;
    pub const TRACK_CONFIGURATION: usize = 169;
    pub const TEXT_LEN: usize = 33;
    pub const TRACK_LENGTH_M: usize = 204;
}

/// `ACEVO_STATUS`: 0 off, 1 replay, 2 live, 3 pause.
const STATUS_LIVE: i32 = 2;
const STATUS_MAX: i32 = 3;
const MAX_LAPS: i32 = 100_000;
/// Ten hours, in milliseconds.
const MAX_TIME_MS: i32 = 36_000_000;
const CAR_TEXT_LEN: usize = 33;

/// About 100 Hz.
const POLL_STEP: Duration = Duration::from_millis(10);
/// How often the memories are opened again to notice the game closing (a memory lives as long as anyone holds it, this
/// reader included, so it must let go to see the game go).
const RECHECK: Duration = Duration::from_secs(2);
const MISSES_BEFORE_GONE: u32 = 3;
/// Copies of a page tried while its packet id moves under the copy.
const COPY_ATTEMPTS: usize = 3;

fn page_len(bytes: usize) -> usize {
    bytes.next_multiple_of(PAGE)
}

/// The three memories have exactly the lengths the layout of the sources gives (see the module comment).
fn pages_fit(physics: usize, graphics: usize, statics: usize) -> bool {
    physics == page_len(PHYSICS_BYTES) && graphics == page_len(GRAPHICS_BYTES) && statics == page_len(STATIC_BYTES)
}

/// A version marker of the static page: printable ASCII with a digit, ended by a zero inside its field.
fn version_text(s: &Page, at: usize) -> Option<String> {
    let raw = s.0.get(at..at + stat::VERSION_LEN)?;
    let end = raw.iter().position(|&b| b == 0)?;
    let text = &raw[..end];
    let sane = !text.is_empty() && text.iter().all(|b| (0x20..0x7f).contains(b)) && text.iter().any(u8::is_ascii_digit);
    sane.then(|| String::from_utf8_lossy(text).trim().to_owned())
        .filter(|t| !t.is_empty())
}

/// Both markers of the static page, when they are there and sane.
fn markers(s: &Page) -> Option<(String, String)> {
    Some((version_text(s, stat::SM_VERSION)?, version_text(s, stat::AC_EVO_VERSION)?))
}

/// The names (candidates, in order) of the three shared memories. The tests use names of their own, never the game's.
struct Names {
    physics: Vec<String>,
    graphics: Vec<String>,
    statics: Vec<String>,
}

impl Names {
    fn game() -> Names {
        let both = |name: &str| vec![format!("Local\\{name}"), name.to_owned()];
        Names {
            physics: both("acevo_pmf_physics"),
            graphics: both("acevo_pmf_graphics"),
            statics: both("acevo_pmf_static"),
        }
    }

    #[cfg(test)]
    fn of(physics: &str, graphics: &str, statics: &str) -> Names {
        let one = |name: &str| vec![name.to_owned()];
        Names {
            physics: one(physics),
            graphics: one(graphics),
            statics: one(statics),
        }
    }
}

fn open_any(candidates: &[String]) -> Option<Mapping> {
    candidates.iter().find_map(|name| Mapping::open(name))
}

struct Pages {
    physics: Mapping,
    graphics: Mapping,
    statics: Mapping,
}

impl Pages {
    fn open(names: &Names) -> Option<Pages> {
        Some(Pages {
            physics: open_any(&names.physics)?,
            graphics: open_any(&names.graphics)?,
            statics: open_any(&names.statics)?,
        })
    }

    fn fit(&self) -> bool {
        pages_fit(self.physics.len(), self.graphics.len(), self.statics.len())
    }
}

/// The packet id was the same before the copy, in the copy and after it.
fn steady(before: i32, in_copy: i32, after: i32) -> bool {
    before == in_copy && before == after
}

/// A copy of the first `len` bytes of a page whose first four bytes are its packet id, taken only when the id did not move.
fn copy_steady(memory: &Mapping, len: usize) -> Option<Vec<u8>> {
    for _ in 0..COPY_ATTEMPTS {
        let before = Page(&memory.read(0, 4)?).i32_at(0);
        let copy = memory.read(0, len)?;
        let after = Page(&memory.read(0, 4)?).i32_at(0);
        if steady(before, Page(&copy).i32_at(0), after) {
            return Some(copy);
        }
    }
    None
}

struct AcEvo {
    names: Names,
    pages: Option<Pages>,
    recheck_every: Duration,
    last_check: Instant,
    misses: u32,
    gone: bool,
    /// The two packet counters (physics, graphics) of the last reading handed out.
    last_ids: Option<(i32, i32)>,
    epoch: Instant,
}

pub fn open() -> Option<Box<dyn Source>> {
    let source = AcEvo::open_with(Names::game(), RECHECK)?;
    if let Some(pages) = &source.pages {
        if let Some((sm, game)) = pages.statics.read(0, STATIC_BYTES).and_then(|b| markers(&Page(&b))) {
            crate::applog::line(&format!(
                "Assetto Corsa EVO shared memory: interface version {sm}, game version {game}"
            ));
        }
    }
    Some(Box::new(source))
}

impl AcEvo {
    /// `None` when a memory is missing, a length is not the one of the layout, or the static page's markers are not sane.
    fn open_with(names: Names, recheck_every: Duration) -> Option<AcEvo> {
        let pages = Pages::open(&names)?;
        if !pages.fit() {
            return None;
        }
        markers(&Page(&pages.statics.read(0, STATIC_BYTES)?))?;
        Some(AcEvo {
            names,
            pages: Some(pages),
            recheck_every,
            last_check: Instant::now(),
            misses: 0,
            gone: false,
            last_ids: None,
            epoch: Instant::now(),
        })
    }

    /// Lets go of the memories and opens them again: if the game is gone, nobody holds them and they are gone too.
    fn recheck(&mut self) {
        if self.gone || self.last_check.elapsed() < self.recheck_every {
            return;
        }
        self.last_check = Instant::now();
        self.pages = None;
        self.pages = Pages::open(&self.names);
        if self.pages.as_ref().is_some_and(Pages::fit) {
            self.misses = 0;
        } else {
            self.misses += 1;
        }
        self.gone = self.misses >= MISSES_BEFORE_GONE;
    }

    fn read_frame(&mut self) -> Option<Frame> {
        let pages = self.pages.as_ref()?;
        let physics = copy_steady(&pages.physics, PHYSICS_BYTES)?;
        let graphics = copy_steady(&pages.graphics, gfx::READ_LEN)?;
        let statics = pages.statics.read(0, STATIC_BYTES)?;
        let (p, g, s) = (Page(&physics), Page(&graphics), Page(&statics));
        let ids = (p.i32_at(phys::PACKET_ID), g.i32_at(gfx::PACKET_ID));
        if self.last_ids == Some(ids) {
            return None;
        }
        let frame = frame_from(&p, &g, &s, self.epoch.elapsed().as_secs_f64())?;
        self.last_ids = Some(ids);
        Some(frame)
    }
}

impl Source for AcEvo {
    fn game_id(&self) -> &'static str {
        "acevo"
    }

    fn game_name(&self) -> &'static str {
        "Assetto Corsa EVO (experimental)"
    }

    fn next(&mut self, timeout: Duration) -> Option<Frame> {
        let deadline = Instant::now() + timeout;
        loop {
            self.recheck();
            if !self.gone {
                if let Some(frame) = self.read_frame() {
                    return Some(frame);
                }
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            std::thread::sleep(POLL_STEP.min(deadline - now));
        }
    }

    fn alive(&self) -> bool {
        !self.gone
    }
}

/// A pedal: 0..1, pulled into range when a little outside it; far outside (or not a number) is "not given".
fn pedal(v: f32) -> f32 {
    if v.is_finite() && (-0.5..=1.5).contains(&v) {
        v.clamp(0.0, 1.0)
    } else {
        f32::NAN
    }
}

/// A time in milliseconds as seconds, when it is a time (not negative, not a huge "none yet" value).
fn seconds(ms: i32, allow_zero: bool) -> Option<f64> {
    let lo = if allow_zero { 0 } else { 1 };
    (lo..=MAX_TIME_MS).contains(&ms).then(|| f64::from(ms) / 1000.0)
}

/// Text of the pages: empty when it holds a control character (garbled).
fn text(page: &Page, at: usize, len: usize) -> String {
    let t = page.ascii_at(at, len);
    if t.chars().any(char::is_control) {
        String::new()
    } else {
        t
    }
}

/// A byte the game writes as a `bool`: 0 or 1; anything else is not a bool.
fn flag(page: &Page, at: usize) -> Option<bool> {
    match page.u8_at(at) {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

/// `ACEVO_FLAG_TYPE`: 0 none, 1 white, 2 green, 3 red, 4 blue, 5 yellow, 6 black, 7 black and white, 8 chequered,
/// 9 orange circle (a mechanical problem), 10 red and yellow stripes. `Flag` has no red and no slippery-surface flag,
/// and the black and white and the orange circle are shown as black.
fn flag_of(v: i32) -> Option<Flag> {
    match v {
        1 => Some(Flag::White),
        2 => Some(Flag::Green),
        4 => Some(Flag::Blue),
        5 => Some(Flag::Yellow),
        6 | 7 | 9 => Some(Flag::Black),
        8 => Some(Flag::Chequered),
        _ => None,
    }
}

/// The car's lights, temperatures and electronics from the graphics page. Damage is not read: the sources give the
/// nine `car_damage` floats no range. A setting is given only for a car whose maximum for it is above 0 (a car
/// without traction control has `tc_level` 0 and a maximum 0). No source has a gearbox or engine damage, the engine
/// warning light or a DRS-less car's "off" (a car with no wing writes false for both DRS flags, so neither is told).
fn state_from(g: &Page) -> CarState {
    let mut state = CarState::UNKNOWN;
    state.pit_limiter = flag(g, gfx::ELECTRONICS + gfx::E_IS_PITLIMITER_ON);
    state.abs_active = flag(g, gfx::ABS_ACTIVE);
    state.tc_active = flag(g, gfx::TC_ACTIVE);
    state.headlights = flag(g, gfx::HEADLIGHTS_VISIBLE);
    let handbrake = g.f32_at(gfx::HANDBRAKE);
    state.handbrake = (0.0..=1.0).contains(&handbrake).then_some(handbrake > 0.0);
    state.drs = if flag(g, gfx::ELECTRONICS + gfx::E_IS_DRS_OPEN) == Some(true) {
        Some(Drs::Open)
    } else if flag(g, gfx::IS_DRS_AVAILABLE) == Some(true) {
        Some(Drs::Available)
    } else {
        None
    };
    // The flag shown to this driver; the one shown to all when there is none for this driver.
    state.flag = flag_of(g.i32_at(gfx::FLAG)).or_else(|| flag_of(g.i32_at(gfx::GLOBAL_FLAG)));
    let temp = |c: f32| (c.is_finite() && c > 0.0 && c <= 400.0).then_some(c);
    state.water_c = temp(f32::from(g.u8_at(gfx::WATER_TEMPERATURE_C) as i8));
    state.oil_c = temp(g.f32_at(gfx::OIL_TEMPERATURE_C));
    let level = |at: usize| {
        let (value, max) = (g.u8_at(gfx::ELECTRONICS + at) as i8, g.u8_at(gfx::ELECTRONICS_MAX_LIMIT + at) as i8);
        (value >= 0 && max > 0).then_some(value as u8)
    };
    state.tc_level = level(gfx::E_TC_LEVEL);
    state.abs_level = level(gfx::E_ABS_LEVEL);
    state.engine_map = level(gfx::E_ENGINE_MAP_LEVEL);
    let bias = g.f32_at(gfx::ELECTRONICS + gfx::E_BRAKE_BIAS);
    state.brake_bias = (bias > 0.0 && bias < 1.0).then_some(bias);
    state
}

/// The mean of the four tyres' world contact points; not given when one is not a number or all of them are zero.
fn position(p: &Page) -> [f32; 3] {
    let mut sum = [0.0f32; 3];
    let mut any = false;
    for wheel in 0..4 {
        for (axis, total) in sum.iter_mut().enumerate() {
            let v = p.f32_at(phys::TYRE_CONTACT_POINT + 12 * wheel + 4 * axis);
            if !v.is_finite() || v.abs() > 1.0e6 {
                return [f32::NAN; 3];
            }
            any |= v != 0.0;
            *total += v;
        }
    }
    if any {
        sum.map(|v| v / 4.0)
    } else {
        [f32::NAN; 3]
    }
}

/// One reading of the three pages as a `Frame`. `None` for what this reader cannot vouch for: a page shorter than the
/// layout, a static page whose version markers are not sane, a `status` that is not one of the four. Never panics.
fn frame_from(p: &Page, g: &Page, s: &Page, clock_s: f64) -> Option<Frame> {
    if p.0.len() < PHYSICS_BYTES || g.0.len() < gfx::READ_LEN || s.0.len() < STATIC_BYTES {
        return None;
    }
    markers(s)?;
    let status = g.i32_at(gfx::STATUS);
    if !(0..=STATUS_MAX).contains(&status) {
        return None;
    }
    let mut f = Frame::empty();
    f.clock_s = clock_s;

    let completed = g.i32_at(gfx::TOTAL_LAP_COUNT);
    let lap_known = (0..=MAX_LAPS).contains(&completed);
    f.driving = status == STATUS_LIVE && lap_known;
    // Laps completed from zero: the first lap is lap 1 (the engine reads 0 as "no lap yet").
    f.lap = if lap_known { completed + 1 } else { 0 };
    f.lap_time_s = seconds(g.i32_at(gfx::CURRENT_LAP_TIME_MS), true);
    f.last_lap_s = seconds(g.i32_at(gfx::LAST_LAPTIME_MS), false);
    f.lap_valid = match (flag(g, gfx::IS_VALID_LAP), flag(g, gfx::TIMING_IS_INVALID)) {
        (Some(false), _) | (_, Some(true)) => Some(false),
        (Some(true), Some(false)) => Some(true),
        _ => None,
    };
    f.in_pits = flag(g, gfx::IS_IN_PIT_LANE) == Some(true) || flag(g, gfx::IS_IN_PIT_BOX) == Some(true);

    f.throttle = pedal(p.f32_at(phys::GAS));
    f.brake = pedal(p.f32_at(phys::BRAKE));
    // 0 = engaged, 1 = fully disengaged: the pedal pressed is 1, like the other two.
    f.clutch = pedal(p.f32_at(phys::CLUTCH));
    // Never negative (a hair below zero is noise): the speed, not a velocity.
    let kmh = p.f32_at(phys::SPEED_KMH);
    f.speed_ms = if kmh.is_finite() && (-1.0..=1500.0).contains(&kmh) {
        (f64::from(kmh.max(0.0)) / 3.6) as f32
    } else {
        f32::NAN
    };
    let rpm = p.i32_at(phys::RPMS);
    f.rpm = if (0..=30_000).contains(&rpm) { rpm as f32 } else { f32::NAN };
    // 0 = reverse, 1 = neutral, 2 = first.
    let gear = p.i32_at(phys::GEAR);
    f.gear = if (0..=15).contains(&gear) { (gear - 1) as f32 } else { f32::NAN };
    // `max_gears` (graphics page): the forward gears.
    let max_gears = g.i32_at(gfx::MAX_GEARS);
    f.gears = (1..=15).contains(&max_gears).then_some(max_gears as u8);
    // Documented as -1..1; far outside that is not a steering value and is dropped, not pinned to the ends.
    let steer = p.f32_at(phys::STEER_ANGLE);
    f.steer = if steer.is_finite() && steer.abs() <= 1.5 {
        steer.clamp(-1.0, 1.0)
    } else {
        f32::NAN
    };
    let fuel = p.f32_at(phys::FUEL);
    f.fuel_l = if fuel.is_finite() && (0.0..=1000.0).contains(&fuel) {
        fuel
    } else {
        f32::NAN
    };
    [f.x, f.y, f.z] = position(p);
    f.state = state_from(g);

    f.car = text(g, gfx::CAR_MODEL, CAR_TEXT_LEN);
    f.track = text(s, stat::TRACK, stat::TEXT_LEN);
    f.track_variant = Some(text(s, stat::TRACK_CONFIGURATION, stat::TEXT_LEN)).filter(|v| !v.is_empty());
    // The static length, unless the session's own length (km) is there and says something else.
    let length = f64::from(s.f32_at(stat::TRACK_LENGTH_M));
    let session = f64::from(g.f32_at(gfx::SESSION_LAP_LENGTH_KM)) * 1000.0;
    let agrees = !(session.is_finite() && session > 0.0) || (session - length).abs() <= 0.02 * length;
    f.track_length_m = (length.is_finite() && (200.0..=100_000.0).contains(&length) && agrees).then_some(length);
    Some(f)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lapcut::LapCutter;
    use crate::shm::FakeMemory;

    // ---- the layouts, proved by adding up the sizes of the published fields -----------------------------------

    /// (name, size of one element, alignment of one element, count).
    type Field = (&'static str, usize, usize, usize);

    struct Built {
        at: Vec<(&'static str, usize)>,
        size: usize,
        align: usize,
    }

    impl Built {
        fn offset(&self, name: &str) -> usize {
            self.at
                .iter()
                .find(|(n, _)| *n == name)
                .unwrap_or_else(|| panic!("no field {name}"))
                .1
        }
    }

    /// The C++ layout: each field at the next multiple of its alignment (at most `pack` when there is `#pragma pack`), the struct
    /// as long as a multiple of its own alignment.
    fn build(pack: Option<usize>, fields: &[Field]) -> Built {
        let (mut at, mut align, mut out) = (0usize, 1usize, Vec::new());
        for &(name, size, field_align, count) in fields {
            let a = pack.map_or(field_align, |p| field_align.min(p));
            at = at.next_multiple_of(a);
            out.push((name, at));
            at += size * count;
            align = align.max(a);
        }
        Built {
            at: out,
            size: at.next_multiple_of(align),
            align,
        }
    }

    fn i4(n: &'static str, c: usize) -> Field {
        (n, 4, 4, c) // int, unsigned, float
    }
    fn c1(n: &'static str, c: usize) -> Field {
        (n, 1, 1, c) // bool, char, int8_t, uint8_t
    }
    fn s2(n: &'static str, c: usize) -> Field {
        (n, 2, 2, c) // short, unsigned short
    }
    fn q8(n: &'static str, c: usize) -> Field {
        (n, 8, 8, c) // uint64_t
    }

    /// The `place_holder` lengths of the two sources: they differ for the session and the timing sub-structs.
    #[derive(Clone, Copy)]
    struct Pads {
        session: usize,
        timing: usize,
    }
    /// `wrapper.hpp` of acevo-shared-memory.
    const HEADER: Pads = Pads { session: 140, timing: 137 };
    /// `structs.rs` of kerb.
    const KERB: Pads = Pads { session: 143, timing: 138 };

    fn with_pad(pack: Option<usize>, mut fields: Vec<Field>, pad: usize) -> Built {
        fields.push(c1("place_holder", pad));
        build(pack, &fields)
    }

    fn tyre(pack: Option<usize>) -> Built {
        with_pad(
            pack,
            vec![
                i4("slip", 1),
                c1("lock", 1),
                i4("tyre_pressure", 1),
                i4("tyre_temperature_c", 1),
                i4("brake_temperature_c", 1),
                i4("brake_pressure", 1),
                i4("tyre_temperature_left", 1),
                i4("tyre_temperature_center", 1),
                i4("tyre_temperature_right", 1),
                c1("tyre_compound_front", 33),
                c1("tyre_compound_rear", 33),
                i4("tyre_normalized_pressure", 1),
                i4("tyre_normalized_temperature_left", 1),
                i4("tyre_normalized_temperature_center", 1),
                i4("tyre_normalized_temperature_right", 1),
                i4("brake_normalized_temperature", 1),
                i4("tyre_normalized_temperature_core", 1),
            ],
            128,
        )
    }

    fn damage(pack: Option<usize>) -> Built {
        with_pad(pack, vec![i4("damage", 9)], 92)
    }

    fn pit(pack: Option<usize>) -> Built {
        with_pad(pack, vec![c1("states", 6)], 58)
    }

    fn electronics(pack: Option<usize>) -> Built {
        with_pad(
            pack,
            vec![
                c1("tc_level", 1),
                c1("tc_cut_level", 1),
                c1("abs_level", 1),
                c1("esc_level", 1),
                c1("ebb_level", 1),
                i4("brake_bias", 1),
                c1("engine_map_level", 1),
                i4("turbo_level", 1),
                c1("ers_deployment_map", 1),
                i4("ers_recharge_map", 1),
                c1("is_ers_heat_charging_on", 1),
                c1("is_ers_overtake_mode_on", 1),
                c1("is_drs_open", 1),
                c1("diff_power_level", 1),
                c1("diff_coast_level", 1),
                c1("front_bump_damper_level", 1),
                c1("front_rebound_damper_level", 1),
                c1("rear_bump_damper_level", 1),
                c1("rear_rebound_damper_level", 1),
                c1("is_ignition_on", 1),
                c1("is_pitlimiter_on", 1),
                c1("active_performance_mode", 1),
            ],
            88,
        )
    }

    fn instrumentation(pack: Option<usize>) -> Built {
        with_pad(
            pack,
            vec![
                c1("main_light_stage", 1),
                c1("special_light_stage", 1),
                c1("cockpit_light_stage", 1),
                c1("wiper_level", 1),
                c1("rain_lights", 1),
                c1("direction_light_left", 1),
                c1("direction_light_right", 1),
                c1("flashing_lights", 1),
                c1("warning_lights", 1),
                c1("selected_display_index", 1),
                c1("display_current_page_index", 16),
                c1("are_headlights_visible", 1),
            ],
            101,
        )
    }

    fn session(pack: Option<usize>, pads: Pads) -> Built {
        with_pad(
            pack,
            vec![
                c1("phase_name", 33),
                c1("time_left", 15),
                i4("time_left_ms", 1),
                c1("wait_time", 15),
                i4("total_lap", 1),
                i4("current_lap", 1),
                i4("lights_on", 1),
                i4("lights_mode", 1),
                i4("lap_length_km", 1),
                i4("end_session_flag", 1),
                c1("time_to_next_session", 15),
                c1("disconnected_from_server", 1),
                c1("restart_season_enabled", 1),
                c1("ui_enable_drive", 1),
                c1("ui_enable_setup", 1),
                c1("is_ready_to_next_blinking", 1),
                c1("show_waiting_for_players", 1),
            ],
            pads.session,
        )
    }

    fn timing(pack: Option<usize>, pads: Pads) -> Built {
        with_pad(
            pack,
            vec![
                c1("current_laptime", 15),
                c1("delta_current", 15),
                i4("delta_current_p", 1),
                c1("last_laptime", 15),
                c1("delta_last", 15),
                i4("delta_last_p", 1),
                c1("best_laptime", 15),
                c1("ideal_laptime", 15),
                c1("total_time", 15),
                c1("is_invalid", 1),
            ],
            pads.timing,
        )
    }

    fn assists(pack: Option<usize>) -> Built {
        with_pad(
            pack,
            vec![
                c1("auto_gear", 1),
                c1("auto_blip", 1),
                c1("auto_clutch", 1),
                c1("auto_clutch_on_start", 1),
                c1("manual_ignition_e_start", 1),
                c1("auto_pit_limiter", 1),
                c1("standing_start_assist", 1),
                i4("auto_steer", 1),
                i4("arcade_stability_control", 1),
            ],
            48,
        )
    }

    /// `SPageFileGraphicEvo`, every field in the order of the header; `car_ids` is the field kerb adds (and the
    /// document's change log of 2026-04-28).
    fn graphics(pack: Option<usize>, pads: Pads, car_ids: bool) -> Built {
        let (tyre, dmg, pit, ins, el) = (tyre(pack), damage(pack), pit(pack), instrumentation(pack), electronics(pack));
        let (ses, tim, asst) = (session(pack, pads), timing(pack, pads), assists(pack));
        let sub = |n: &'static str, b: &Built| (n, b.size, b.align, 1);
        let mut f: Vec<Field> = vec![
            i4("packet_id", 1),
            i4("status", 1),
            q8("focused_car_id_a", 1),
            q8("focused_car_id_b", 1),
            q8("player_car_id_a", 1),
            q8("player_car_id_b", 1),
            s2("rpm", 1),
        ];
        for n in [
            "is_rpm_limiter_on",
            "is_change_up_rpm",
            "is_change_down_rpm",
            "tc_active",
            "abs_active",
            "esc_active",
            "launch_active",
            "is_ignition_on",
            "is_engine_running",
            "kers_is_charging",
            "is_wrong_way",
            "is_drs_available",
            "battery_is_charging",
            "is_max_kj_per_lap_reached",
            "is_max_charge_kj_per_lap_reached",
        ] {
            f.push(c1(n, 1));
        }
        f.extend([s2("display_speed_kmh", 1), s2("display_speed_mph", 1), s2("display_speed_ms", 1)]);
        f.extend([i4("pitspeeding_delta", 1), s2("gear_int", 1)]);
        for n in [
            "rpm_percent",
            "gas_percent",
            "brake_percent",
            "handbrake_percent",
            "clutch_percent",
            "steering_percent",
            "ffb_strength",
            "car_ffb_mupliplier",
            "water_temperature_percent",
            "water_pressure_bar",
            "fuel_pressure_bar",
        ] {
            f.push(i4(n, 1));
        }
        f.extend([c1("water_temperature_c", 1), c1("air_temperature_c", 1)]);
        for n in [
            "oil_temperature_c",
            "oil_pressure_bar",
            "exhaust_temperature_c",
            "g_forces_x",
            "g_forces_y",
            "g_forces_z",
            "turbo_boost",
            "turbo_boost_level",
            "turbo_boost_perc",
            "steer_degrees",
            "current_km",
            "total_km",
            "total_driving_time_s",
            "time_of_day_hours",
            "time_of_day_minutes",
            "time_of_day_seconds",
            "delta_time_ms",
            "current_lap_time_ms",
            "predicted_lap_time_ms",
            "fuel_liter_current_quantity",
            "fuel_liter_current_quantity_percent",
            "fuel_liter_per_km",
            "km_per_fuel_liter",
            "current_torque",
            "current_bhp",
        ] {
            f.push(i4(n, 1));
        }
        f.extend([
            sub("tyre_lf", &tyre),
            sub("tyre_rf", &tyre),
            sub("tyre_lr", &tyre),
            sub("tyre_rr", &tyre),
        ]);
        for n in ["npos", "kers_charge_perc", "kers_current_perc", "control_lock_time"] {
            f.push(i4(n, 1));
        }
        f.extend([sub("car_damage", &dmg), i4("car_location", 1), sub("pit_info", &pit)]);
        for n in [
            "fuel_liter_used",
            "fuel_liter_per_lap",
            "laps_possible_with_fuel",
            "battery_temperature",
            "battery_voltage",
            "instantaneous_fuel_liter_per_km",
            "instantaneous_km_per_fuel_liter",
            "gear_rpm_window",
        ] {
            f.push(i4(n, 1));
        }
        f.extend([
            sub("instrumentation", &ins),
            sub("instrumentation_min_limit", &ins),
            sub("instrumentation_max_limit", &ins),
            sub("electronics", &el),
            sub("electronics_min_limit", &el),
            sub("electronics_max_limit", &el),
            sub("electronics_is_modifiable", &el),
        ]);
        for n in [
            "total_lap_count",
            "current_pos",
            "total_drivers",
            "last_laptime_ms",
            "best_laptime_ms",
            "flag",
            "global_flag",
            "max_gears",
            "engine_type",
        ] {
            f.push(i4(n, 1));
        }
        f.extend([c1("has_kers", 1), c1("is_last_lap", 1), c1("performance_mode_name", 33)]);
        for n in [
            "diff_coast_raw_value",
            "diff_power_raw_value",
            "race_cut_gained_time_ms",
            "distance_to_deadline",
            "race_cut_current_delta",
        ] {
            f.push(i4(n, 1));
        }
        f.extend([sub("session_state", &ses), sub("timing_state", &tim)]);
        for n in [
            "player_ping",
            "player_latency",
            "player_cpu_usage",
            "player_cpu_usage_avg",
            "player_qos",
            "player_qos_avg",
            "player_fps",
            "player_fps_avg",
        ] {
            f.push(i4(n, 1));
        }
        f.extend([
            c1("driver_name", 33),
            c1("driver_surname", 33),
            c1("car_model", 33),
            c1("is_in_pit_box", 1),
            c1("is_in_pit_lane", 1),
            c1("is_valid_lap", 1),
            i4("car_coordinates", 180),
            i4("gap_ahead", 1),
            i4("gap_behind", 1),
            c1("active_cars", 1),
            i4("fuel_per_lap", 1),
            i4("fuel_estimated_laps", 1),
            sub("assists_state", &asst),
            i4("max_fuel", 1),
            i4("max_turbo_boost", 1),
            c1("use_single_compound", 1),
        ]);
        if car_ids {
            f.push(q8("car_ids", 120));
        }
        build(pack, &f)
    }

    /// `SPageFilePhysics` (kerb's `SPageFilePhysicsEvo` has the same fields in the same order): all 4-byte fields.
    fn physics() -> Built {
        let fields: Vec<Field> = [
            ("packetId", 1),
            ("gas", 1),
            ("brake", 1),
            ("fuel", 1),
            ("gear", 1),
            ("rpms", 1),
            ("steerAngle", 1),
            ("speedKmh", 1),
            ("velocity", 3),
            ("accG", 3),
            ("wheelSlip", 4),
            ("wheelLoad", 4),
            ("wheelsPressure", 4),
            ("wheelAngularSpeed", 4),
            ("tyreWear", 4),
            ("tyreDirtyLevel", 4),
            ("tyreCoreTemperature", 4),
            ("camberRAD", 4),
            ("suspensionTravel", 4),
            ("drs", 1),
            ("tc", 1),
            ("heading", 1),
            ("pitch", 1),
            ("roll", 1),
            ("cgHeight", 1),
            ("carDamage", 5),
            ("numberOfTyresOut", 1),
            ("pitLimiterOn", 1),
            ("abs", 1),
            ("kersCharge", 1),
            ("kersInput", 1),
            ("autoShifterOn", 1),
            ("rideHeight", 2),
            ("turboBoost", 1),
            ("ballast", 1),
            ("airDensity", 1),
            ("airTemp", 1),
            ("roadTemp", 1),
            ("localAngularVel", 3),
            ("finalFF", 1),
            ("performanceMeter", 1),
            ("engineBrake", 1),
            ("ersRecoveryLevel", 1),
            ("ersPowerLevel", 1),
            ("ersHeatCharging", 1),
            ("ersIsCharging", 1),
            ("kersCurrentKJ", 1),
            ("drsAvailable", 1),
            ("drsEnabled", 1),
            ("brakeTemp", 4),
            ("clutch", 1),
            ("tyreTempI", 4),
            ("tyreTempM", 4),
            ("tyreTempO", 4),
            ("isAIControlled", 1),
            ("tyreContactPoint", 12),
            ("tyreContactNormal", 12),
            ("tyreContactHeading", 12),
            ("brakeBias", 1),
            ("localVelocity", 3),
            ("P2PActivations", 1),
            ("P2PStatus", 1),
            ("currentMaxRpm", 1),
            ("mz", 4),
            ("fx", 4),
            ("fy", 4),
            ("slipRatio", 4),
            ("slipAngle", 4),
            ("tcinAction", 1),
            ("absInAction", 1),
            ("suspensionDamage", 4),
            ("tyreTemp", 4),
            ("waterTemp", 1),
            ("brakeTorque", 4),
            ("frontBrakeCompound", 1),
            ("rearBrakeCompound", 1),
            ("padLife", 4),
            ("discLife", 4),
            ("ignitionOn", 1),
            ("starterEngineOn", 1),
            ("isEngineRunning", 1),
            ("kerbVibration", 1),
            ("slipVibrations", 1),
            ("roadVibrations", 1),
            ("absVibrations", 1),
        ]
        .into_iter()
        .map(|(n, c)| i4(n, c))
        .collect();
        build(None, &fields)
    }

    fn statics() -> Built {
        build(
            None,
            &[
                c1("sm_version", 15),
                c1("ac_evo_version", 15),
                i4("session", 1),
                c1("session_name", 33),
                c1("event_id", 1),
                c1("session_id", 1),
                i4("starting_grip", 1),
                i4("starting_ambient_temperature_c", 1),
                i4("starting_ground_temperature_c", 1),
                c1("is_static_weather", 1),
                c1("is_timed_race", 1),
                c1("is_online", 1),
                i4("number_of_sessions", 1),
                c1("nation", 33),
                i4("longitude", 1),
                i4("latitude", 1),
                c1("track", 33),
                c1("track_configuration", 33),
                i4("track_length_m", 1),
            ],
        )
    }

    #[test]
    fn the_offsets_follow_from_the_sizes_in_the_sources() {
        // Physics and static do not depend on the packing (nothing larger than four bytes).
        let p = physics();
        assert_eq!(p.size, PHYSICS_BYTES);
        for (name, want) in [
            ("packetId", phys::PACKET_ID),
            ("gas", phys::GAS),
            ("brake", phys::BRAKE),
            ("fuel", phys::FUEL),
            ("gear", phys::GEAR),
            ("rpms", phys::RPMS),
            ("steerAngle", phys::STEER_ANGLE),
            ("speedKmh", phys::SPEED_KMH),
            ("clutch", phys::CLUTCH),
            ("tyreContactPoint", phys::TYRE_CONTACT_POINT),
        ] {
            assert_eq!(p.offset(name), want, "physics {name}");
        }
        const { assert!(phys::TYRE_CONTACT_POINT + 48 <= PHYSICS_BYTES) };
        let s = statics();
        assert_eq!(s.size, STATIC_BYTES);
        for (name, want) in [
            ("sm_version", stat::SM_VERSION),
            ("ac_evo_version", stat::AC_EVO_VERSION),
            ("track", stat::TRACK),
            ("track_configuration", stat::TRACK_CONFIGURATION),
            ("track_length_m", stat::TRACK_LENGTH_M),
        ] {
            assert_eq!(s.offset(name), want, "static {name}");
        }
        assert_eq!(s.offset("ac_evo_version"), s.offset("sm_version") + stat::VERSION_LEN);
        assert_eq!(s.offset("track_configuration"), s.offset("track") + stat::TEXT_LEN);

        // Graphics, under both packings and both crates' pads.
        for pack in [None, Some(4)] {
            // The `static_assert`s of the header: the sub-structs are 256, 128 and 64 bytes.
            for (name, built, want) in [
                ("tyre", tyre(pack), 256),
                ("damage", damage(pack), 128),
                ("pit", pit(pack), 64),
                ("electronics", electronics(pack), 128),
                ("instrumentation", instrumentation(pack), 128),
                ("assists", assists(pack), 64),
            ] {
                assert_eq!(built.size, want, "{name}, pack {pack:?}");
            }
            for pads in [HEADER, KERB] {
                assert_eq!(session(pack, pads).size, 256, "session, pack {pack:?}");
                assert_eq!(timing(pack, pads).size, 256, "timing, pack {pack:?}");
                let g = graphics(pack, pads, true);
                for (name, want) in [
                    ("packet_id", gfx::PACKET_ID),
                    ("status", gfx::STATUS),
                    ("current_lap_time_ms", gfx::CURRENT_LAP_TIME_MS),
                    ("total_lap_count", gfx::TOTAL_LAP_COUNT),
                    ("last_laptime_ms", gfx::LAST_LAPTIME_MS),
                    ("max_gears", gfx::MAX_GEARS),
                    ("tc_active", gfx::TC_ACTIVE),
                    ("abs_active", gfx::ABS_ACTIVE),
                    ("is_drs_available", gfx::IS_DRS_AVAILABLE),
                    ("handbrake_percent", gfx::HANDBRAKE),
                    ("water_temperature_c", gfx::WATER_TEMPERATURE_C),
                    ("oil_temperature_c", gfx::OIL_TEMPERATURE_C),
                    ("instrumentation", gfx::INSTRUMENTATION),
                    ("electronics", gfx::ELECTRONICS),
                    ("flag", gfx::FLAG),
                    ("global_flag", gfx::GLOBAL_FLAG),
                    ("car_model", gfx::CAR_MODEL),
                    ("is_in_pit_box", gfx::IS_IN_PIT_BOX),
                    ("is_in_pit_lane", gfx::IS_IN_PIT_LANE),
                    ("is_valid_lap", gfx::IS_VALID_LAP),
                ] {
                    assert_eq!(g.offset(name), want, "graphics {name}, pack {pack:?}");
                }
                assert_eq!(
                    g.offset("session_state") + session(pack, pads).offset("lap_length_km"),
                    gfx::SESSION_LAP_LENGTH_KM
                );
                assert_eq!(
                    g.offset("timing_state") + timing(pack, pads).offset("is_invalid"),
                    gfx::TIMING_IS_INVALID
                );
                // Inside the sub-structs, and the min / max copies that follow `electronics` (128 bytes each).
                let (el, ins) = (electronics(pack), instrumentation(pack));
                for (name, want) in [
                    ("tc_level", gfx::E_TC_LEVEL),
                    ("abs_level", gfx::E_ABS_LEVEL),
                    ("brake_bias", gfx::E_BRAKE_BIAS),
                    ("engine_map_level", gfx::E_ENGINE_MAP_LEVEL),
                    ("is_drs_open", gfx::E_IS_DRS_OPEN),
                    ("is_pitlimiter_on", gfx::E_IS_PITLIMITER_ON),
                ] {
                    assert_eq!(el.offset(name), want, "electronics {name}, pack {pack:?}");
                }
                assert_eq!(ins.offset("are_headlights_visible"), gfx::HEADLIGHTS_VISIBLE - gfx::INSTRUMENTATION);
                assert_eq!(g.offset("electronics_max_limit"), gfx::ELECTRONICS_MAX_LIMIT);
                assert_eq!(g.offset("total_lap_count"), g.offset("electronics_is_modifiable") + 128);
                const { assert!(gfx::ELECTRONICS_MAX_LIMIT + gfx::E_IS_PITLIMITER_ON < gfx::READ_LEN) };
                assert_eq!(gfx::READ_LEN, gfx::IS_VALID_LAP + 1);
                // The same graphics page without `car_ids` (the header of acevo-shared-memory): shorter by 960 bytes less
                // the alignment padding, and still one page: that is the "old layout" the page length gives away.
                let old = graphics(pack, pads, false);
                assert_eq!(old.size, g.offset("car_ids").next_multiple_of(old.align));
                assert_eq!(page_len(old.size), PAGE, "pack {pack:?}");
                assert_ne!(page_len(old.size), page_len(GRAPHICS_BYTES));
                // With `car_ids`: 4904 (natural) or 4900 (pack 4), the same two pages either way.
                assert_eq!(g.size, if pack.is_some() { 4900 } else { GRAPHICS_BYTES }, "pack {pack:?}");
                assert_eq!(page_len(g.size), page_len(GRAPHICS_BYTES));
                assert_eq!(page_len(g.size), 2 * PAGE);
                assert_eq!(g.offset("car_ids"), if pack.is_some() { 3940 } else { 3944 });
            }
        }
        // The pads of the two crates differ and still give the same layout.
        for pack in [None, Some(4)] {
            assert_eq!(session(pack, HEADER).size, session(pack, KERB).size);
            assert_eq!(timing(pack, HEADER).size, timing(pack, KERB).size);
        }
    }

    #[test]
    fn only_the_page_lengths_of_the_layout_fit() {
        assert!(pages_fit(4096, 8192, 4096));
        assert!(
            !pages_fit(4096, 4096, 4096),
            "a graphics page of one page is the layout before car_ids"
        );
        assert!(!pages_fit(4096, 12_288, 4096), "longer than the sources say");
        assert!(!pages_fit(8192, 8192, 4096));
        assert!(!pages_fit(4096, 8192, 8192));
        assert!(!pages_fit(0, 8192, 4096));
        assert!(!pages_fit(4096, 8192, 0));
    }

    // ---- images of the pages and a fake game ------------------------------------------------------------------

    struct Img(Vec<u8>);

    impl Img {
        fn i32(&mut self, at: usize, v: i32) {
            self.0[at..at + 4].copy_from_slice(&v.to_le_bytes());
        }
        fn f32(&mut self, at: usize, v: f32) {
            self.0[at..at + 4].copy_from_slice(&v.to_le_bytes());
        }
        fn text(&mut self, at: usize, len: usize, s: &str) {
            self.0[at..at + len].fill(0);
            self.0[at..at + s.len()].copy_from_slice(s.as_bytes());
        }
    }

    struct Image {
        physics: Img,
        graphics: Img,
        statics: Img,
    }

    impl Image {
        /// A representative moment on track, with values that are exact in `f32`.
        fn on_track() -> Image {
            let mut i = Image {
                physics: Img(vec![0; PHYSICS_BYTES]),
                graphics: Img(vec![0; GRAPHICS_BYTES]),
                statics: Img(vec![0; STATIC_BYTES]),
            };
            i.physics.i32(phys::PACKET_ID, 1);
            i.physics.f32(phys::GAS, 0.75);
            i.physics.f32(phys::BRAKE, 0.25);
            i.physics.f32(phys::CLUTCH, 0.5);
            i.physics.f32(phys::FUEL, 42.5);
            i.physics.i32(phys::GEAR, 4);
            i.physics.i32(phys::RPMS, 7250);
            i.physics.f32(phys::STEER_ANGLE, -0.5);
            i.physics.f32(phys::SPEED_KMH, 180.0);
            for (wheel, (x, z)) in [(10.0, 20.0), (12.0, 20.0), (10.0, 24.0), (12.0, 24.0)].into_iter().enumerate() {
                let at = phys::TYRE_CONTACT_POINT + 12 * wheel;
                i.physics.f32(at, x);
                i.physics.f32(at + 4, 1.0);
                i.physics.f32(at + 8, z);
            }
            i.graphics.i32(gfx::PACKET_ID, 1);
            i.graphics.i32(gfx::STATUS, STATUS_LIVE);
            i.graphics.i32(gfx::CURRENT_LAP_TIME_MS, 63_250);
            i.graphics.i32(gfx::TOTAL_LAP_COUNT, 3);
            i.graphics.i32(gfx::LAST_LAPTIME_MS, 90_500);
            i.graphics.i32(gfx::MAX_GEARS, 6);
            i.graphics.f32(gfx::SESSION_LAP_LENGTH_KM, 5.793);
            i.graphics.0[gfx::IS_VALID_LAP] = 1;
            // The car's state: limiter on, ABS acting, headlights on, a handbrake half up, the wing open, a green
            // flag; water 85 and oil 101.5; TC 3 of 8, ABS 2 of 11, map 1 of 4, 56.25 % front brakes.
            i.graphics.0[gfx::ELECTRONICS + gfx::E_IS_PITLIMITER_ON] = 1;
            i.graphics.0[gfx::ABS_ACTIVE] = 1;
            i.graphics.0[gfx::HEADLIGHTS_VISIBLE] = 1;
            i.graphics.f32(gfx::HANDBRAKE, 0.5);
            i.graphics.0[gfx::ELECTRONICS + gfx::E_IS_DRS_OPEN] = 1;
            i.graphics.i32(gfx::FLAG, 2);
            i.graphics.0[gfx::WATER_TEMPERATURE_C] = 85;
            i.graphics.f32(gfx::OIL_TEMPERATURE_C, 101.5);
            for (at, value, max) in [(gfx::E_TC_LEVEL, 3, 8), (gfx::E_ABS_LEVEL, 2, 11), (gfx::E_ENGINE_MAP_LEVEL, 1, 4)] {
                i.graphics.0[gfx::ELECTRONICS + at] = value;
                i.graphics.0[gfx::ELECTRONICS_MAX_LIMIT + at] = max;
            }
            i.graphics.f32(gfx::ELECTRONICS + gfx::E_BRAKE_BIAS, 0.5625);
            i.graphics.text(gfx::CAR_MODEL, CAR_TEXT_LEN, "ks_porsche_911_gt3");
            i.statics.text(stat::SM_VERSION, stat::VERSION_LEN, "1.0.0");
            i.statics.text(stat::AC_EVO_VERSION, stat::VERSION_LEN, "0.6.3");
            i.statics.text(stat::TRACK, stat::TEXT_LEN, "monza");
            i.statics.text(stat::TRACK_CONFIGURATION, stat::TEXT_LEN, "gp");
            i.statics.f32(stat::TRACK_LENGTH_M, 5793.0);
            i
        }

        fn frame(&self) -> Option<Frame> {
            frame_from(
                &Page(&self.physics.0),
                &Page(&self.graphics.0[..gfx::READ_LEN]),
                &Page(&self.statics.0),
                1.0,
            )
        }
    }

    /// A fake game: three memories under names of their own, and the image the test keeps in them.
    struct Rig {
        physics: FakeMemory,
        graphics: FakeMemory,
        statics: FakeMemory,
        image: Image,
    }

    impl Rig {
        fn new(label: &str) -> Rig {
            let rig = Rig {
                physics: FakeMemory::new(&format!("{label}_p"), PHYSICS_BYTES),
                graphics: FakeMemory::new(&format!("{label}_g"), GRAPHICS_BYTES),
                statics: FakeMemory::new(&format!("{label}_s"), STATIC_BYTES),
                image: Image::on_track(),
            };
            rig.write_all();
            rig
        }
        fn write_all(&self) {
            self.physics.write(0, &self.image.physics.0);
            self.graphics.write(0, &self.image.graphics.0);
            self.statics.write(0, &self.image.statics.0);
        }
        fn names(&self) -> Names {
            Names::of(&self.physics.name, &self.graphics.name, &self.statics.name)
        }
        fn reader(&self) -> AcEvo {
            AcEvo::open_with(self.names(), Duration::from_secs(3600)).expect("opens")
        }
        /// The game finishes a step: both packet counters up, the pages written.
        fn step(&mut self) {
            let (p, g) = (Page(&self.image.physics.0).i32_at(0), Page(&self.image.graphics.0).i32_at(0));
            self.image.physics.i32(phys::PACKET_ID, p + 1);
            self.image.graphics.i32(gfx::PACKET_ID, g + 1);
            self.physics.write(0, &self.image.physics.0);
            self.graphics.write(0, &self.image.graphics.0);
        }
    }

    const NOW: Duration = Duration::from_millis(0);

    #[test]
    fn reads_a_moment_on_track_into_exact_frame_values() {
        let rig = Rig::new("happy");
        let mut reader = rig.reader();
        assert_eq!(
            (reader.game_id(), reader.game_name()),
            ("acevo", "Assetto Corsa EVO (experimental)")
        );
        let frame = reader.next(NOW).expect("a frame");
        let mut want = Frame::empty();
        want.clock_s = frame.clock_s;
        want.driving = true;
        want.lap = 4; // three laps completed: the fourth is being driven
        want.lap_time_s = Some(63.25);
        want.last_lap_s = Some(90.5);
        want.lap_valid = Some(true);
        want.in_pits = false;
        want.speed_ms = 50.0; // 180 km/h
        want.rpm = 7250.0;
        want.gear = 3.0; // the game's 4 is third gear
        want.gears = Some(6);
        want.throttle = 0.75;
        want.brake = 0.25;
        want.clutch = 0.5;
        want.steer = -0.5;
        want.x = 11.0;
        want.y = 1.0;
        want.z = 22.0;
        want.fuel_l = 42.5;
        want.car = "ks_porsche_911_gt3".into();
        want.track = "monza".into();
        want.track_variant = Some("gp".into());
        want.track_length_m = Some(5793.0);
        want.state = CarState {
            pit_limiter: Some(true),
            abs_active: Some(true),
            tc_active: Some(false),
            drs: Some(Drs::Open),
            headlights: Some(true),
            handbrake: Some(true),
            engine_warning: None,
            flag: Some(Flag::Green),
            water_c: Some(85.0),
            oil_c: Some(101.5),
            tc_level: Some(3),
            abs_level: Some(2),
            engine_map: Some(1),
            brake_bias: Some(0.5625),
            damage_body: None,
            damage_engine: None,
            damage_gearbox: None,
            damage_suspension: None,
        };
        assert_eq!(frame, want);
        assert!(reader.alive());
    }

    #[test]
    fn the_car_state_gives_a_setting_only_for_a_car_that_has_the_aid() {
        let mut image = Image::on_track();
        // The car has no traction control (maximum 0): a level of 0 says nothing.
        image.graphics.0[gfx::ELECTRONICS + gfx::E_TC_LEVEL] = 0;
        image.graphics.0[gfx::ELECTRONICS_MAX_LIMIT + gfx::E_TC_LEVEL] = 0;
        // A garbled bias, a handbrake past 1 and a bool of 7 are not given.
        image.graphics.f32(gfx::ELECTRONICS + gfx::E_BRAKE_BIAS, 1.5);
        image.graphics.f32(gfx::HANDBRAKE, 3.0);
        image.graphics.0[gfx::ABS_ACTIVE] = 7;
        let state = image.frame().unwrap().state;
        assert_eq!(
            (state.tc_level, state.brake_bias, state.handbrake, state.abs_active),
            (None, None, None, None)
        );
        assert_eq!(state.abs_level, Some(2));
        // No flag for this driver: the one shown to all drivers counts; a red flag is not one `Flag` has.
        image.graphics.i32(gfx::FLAG, 0);
        image.graphics.i32(gfx::GLOBAL_FLAG, 5);
        assert_eq!(image.frame().unwrap().state.flag, Some(Flag::Yellow));
        for (n, want) in [
            (0, None),
            (1, Some(Flag::White)),
            (2, Some(Flag::Green)),
            (3, None),
            (4, Some(Flag::Blue)),
            (5, Some(Flag::Yellow)),
            (6, Some(Flag::Black)),
            (7, Some(Flag::Black)),
            (8, Some(Flag::Chequered)),
            (9, Some(Flag::Black)),
            (10, None),
            (11, None),
        ] {
            assert_eq!(flag_of(n), want, "flag {n}");
        }
        // The wing: open wins, then "allowed here"; neither says nothing.
        image.graphics.0[gfx::ELECTRONICS + gfx::E_IS_DRS_OPEN] = 0;
        image.graphics.0[gfx::IS_DRS_AVAILABLE] = 1;
        assert_eq!(image.frame().unwrap().state.drs, Some(Drs::Available));
        image.graphics.0[gfx::IS_DRS_AVAILABLE] = 0;
        assert_eq!(image.frame().unwrap().state.drs, None);
    }

    #[test]
    fn only_live_is_driving_and_an_unknown_status_is_garbled_data() {
        for (status, name) in [(0, "off"), (1, "replay"), (2, "live"), (3, "pause")] {
            let mut image = Image::on_track();
            image.graphics.i32(gfx::STATUS, status);
            let frame = image.frame().unwrap();
            assert_eq!(frame.driving, status == 2, "{name}");
            // The frame still carries the lap times when it is not driving (a lap can be closed in a menu).
            assert_eq!(frame.last_lap_s, Some(90.5), "{name}");
        }
        for status in [-1, 4, 5, 100, i32::MAX, i32::MIN] {
            let mut image = Image::on_track();
            image.graphics.i32(gfx::STATUS, status);
            assert!(image.frame().is_none(), "status {status}");
        }
        // A lap count that cannot be real is not driving, and is no lap.
        for completed in [-1, 100_001, i32::MAX, i32::MIN] {
            let mut image = Image::on_track();
            image.graphics.i32(gfx::TOTAL_LAP_COUNT, completed);
            let frame = image.frame().unwrap();
            assert_eq!((frame.driving, frame.lap), (false, 0), "completed {completed}");
        }
    }

    #[test]
    fn gears_pedals_speed_fuel_and_times_are_converted_and_garbage_is_not_given() {
        // 0 is reverse, 1 neutral, 2 first: the lap file has -1, 0, 1.
        for (gear, want) in [(0, -1.0), (1, 0.0), (2, 1.0), (8, 7.0)] {
            let mut image = Image::on_track();
            image.physics.i32(phys::GEAR, gear);
            assert_eq!(image.frame().unwrap().gear, want, "gear {gear}");
        }
        for gear in [-1, 16, i32::MAX, i32::MIN] {
            let mut image = Image::on_track();
            image.physics.i32(phys::GEAR, gear);
            assert!(image.frame().unwrap().gear.is_nan(), "gear {gear}");
        }
        // km/h to m/s.
        let mut image = Image::on_track();
        image.physics.f32(phys::SPEED_KMH, 36.0);
        assert_eq!(image.frame().unwrap().speed_ms, 10.0);
        image.physics.f32(phys::SPEED_KMH, -0.5);
        assert_eq!(image.frame().unwrap().speed_ms, 0.0, "a hair below zero is noise");
        for speed in [f32::NAN, f32::INFINITY, -5.0, -5000.0, 1500.5, 5000.0] {
            image.physics.f32(phys::SPEED_KMH, speed);
            assert!(image.frame().unwrap().speed_ms.is_nan(), "speed {speed}");
        }
        // Pedals a little outside 0..1 are pulled in; far outside or not a number is not given.
        let mut image = Image::on_track();
        image.physics.f32(phys::GAS, 1.25);
        image.physics.f32(phys::BRAKE, -0.25);
        image.physics.f32(phys::CLUTCH, 9.0);
        image.physics.f32(phys::STEER_ANGLE, -1.25);
        image.physics.i32(phys::RPMS, -3);
        image.physics.f32(phys::FUEL, -1.0);
        let frame = image.frame().unwrap();
        assert_eq!((frame.throttle, frame.brake, frame.steer), (1.0, 0.0, -1.0));
        assert!(frame.clutch.is_nan() && frame.rpm.is_nan() && frame.fuel_l.is_nan());
        image.physics.f32(phys::STEER_ANGLE, 90.0);
        image.physics.f32(phys::FUEL, 1.0e6);
        image.physics.i32(phys::RPMS, 30_001);
        let frame = image.frame().unwrap();
        assert!(frame.steer.is_nan() && frame.fuel_l.is_nan() && frame.rpm.is_nan());
        // Times: milliseconds to seconds; "none yet" values are not times.
        for (ms, now, last) in [
            (0, Some(0.0), None),
            (1, Some(0.001), Some(0.001)),
            (-1, None, None),
            (i32::MAX, None, None),
        ] {
            let mut image = Image::on_track();
            image.graphics.i32(gfx::CURRENT_LAP_TIME_MS, ms);
            image.graphics.i32(gfx::LAST_LAPTIME_MS, ms);
            let frame = image.frame().unwrap();
            assert_eq!((frame.lap_time_s, frame.last_lap_s), (now, last), "{ms} ms");
        }
    }

    #[test]
    fn the_pits_the_lap_verdict_the_position_and_the_track_length() {
        // In the pit lane or the pit box.
        for (lane, pit_box, want) in [(0, 0, false), (1, 0, true), (0, 1, true), (1, 1, true), (2, 0, false)] {
            let mut image = Image::on_track();
            image.graphics.0[gfx::IS_IN_PIT_LANE] = lane;
            image.graphics.0[gfx::IS_IN_PIT_BOX] = pit_box;
            assert_eq!(image.frame().unwrap().in_pits, want, "lane {lane} box {pit_box}");
        }
        // A lap is valid only when both flags agree it is; a byte that is not a bool says nothing.
        for (valid, invalid, want) in [
            (1, 0, Some(true)),
            (0, 0, Some(false)),
            (1, 1, Some(false)),
            (0, 1, Some(false)),
            (7, 0, None),
            (1, 7, None),
            (7, 7, None),
            (7, 1, Some(false)),
        ] {
            let mut image = Image::on_track();
            image.graphics.0[gfx::IS_VALID_LAP] = valid;
            image.graphics.0[gfx::TIMING_IS_INVALID] = invalid;
            assert_eq!(image.frame().unwrap().lap_valid, want, "valid {valid} invalid {invalid}");
        }
        // No position (all zero) or a garbled one is not given.
        let mut image = Image::on_track();
        for at in (0..12).map(|i| phys::TYRE_CONTACT_POINT + 4 * i) {
            image.physics.f32(at, 0.0);
        }
        let frame = image.frame().unwrap();
        assert!(frame.x.is_nan() && frame.y.is_nan() && frame.z.is_nan());
        let mut image = Image::on_track();
        image.physics.f32(phys::TYRE_CONTACT_POINT + 8, f32::NAN);
        assert!(image.frame().unwrap().x.is_nan());
        // The track length: the static one, unless the session's contradicts it; both missing is not a length.
        let mut image = Image::on_track();
        image.graphics.f32(gfx::SESSION_LAP_LENGTH_KM, 0.0);
        assert_eq!(image.frame().unwrap().track_length_m, Some(5793.0), "no second opinion");
        image.graphics.f32(gfx::SESSION_LAP_LENGTH_KM, 5.9);
        assert_eq!(image.frame().unwrap().track_length_m, Some(5793.0), "within 2 %");
        image.graphics.f32(gfx::SESSION_LAP_LENGTH_KM, 7.5);
        assert_eq!(image.frame().unwrap().track_length_m, None, "contradicted");
        for length in [0.0, 199.0, 200_000.0, f32::NAN, f32::INFINITY] {
            let mut image = Image::on_track();
            image.statics.f32(stat::TRACK_LENGTH_M, length);
            assert_eq!(image.frame().unwrap().track_length_m, None, "length {length}");
        }
        // Names: an empty variant is not given; a control character makes a text empty.
        let mut image = Image::on_track();
        image.statics.text(stat::TRACK_CONFIGURATION, stat::TEXT_LEN, "");
        assert_eq!(image.frame().unwrap().track_variant, None);
        image.statics.text(stat::TRACK, stat::TEXT_LEN, "mon\u{1}za");
        assert_eq!(image.frame().unwrap().track, "");
    }

    #[test]
    fn a_packet_that_did_not_change_is_not_read_twice() {
        let mut rig = Rig::new("dup");
        let mut reader = rig.reader();
        assert!(reader.next(NOW).is_some());
        assert!(reader.next(NOW).is_none(), "the same two ids: nothing new");
        assert!(reader.next(Duration::from_millis(25)).is_none(), "still nothing new after waiting");
        // Either counter moving is a new reading.
        let p = Page(&rig.image.physics.0).i32_at(0);
        rig.image.physics.i32(phys::PACKET_ID, p + 1);
        rig.physics.write(0, &rig.image.physics.0);
        assert!(reader.next(NOW).is_some());
        assert!(reader.next(NOW).is_none());
        let g = Page(&rig.image.graphics.0).i32_at(0);
        rig.image.graphics.i32(gfx::PACKET_ID, g + 1);
        rig.graphics.write(0, &rig.image.graphics.0);
        assert!(reader.next(NOW).is_some());
        assert!(reader.next(NOW).is_none());
        rig.step();
        assert!(reader.next(NOW).is_some());
    }

    #[test]
    fn a_copy_is_steady_only_when_the_id_is_the_same_before_inside_and_after() {
        assert!(steady(5, 5, 5));
        assert!(!steady(5, 6, 6), "changed before the copy was taken");
        assert!(!steady(5, 5, 6), "changed during the copy");
        assert!(!steady(5, 4, 5));
    }

    #[test]
    fn a_memory_that_is_missing_the_wrong_length_or_unmarked_is_refused() {
        let rig = Rig::new("refuse");
        assert!(AcEvo::open_with(rig.names(), RECHECK).is_some());
        let names = |p: &str, g: &str, s: &str| Names::of(p, g, s);
        assert!(AcEvo::open_with(names("XpeedSimNoSuchEvo", &rig.graphics.name, &rig.statics.name), RECHECK).is_none());
        assert!(AcEvo::open_with(names(&rig.physics.name, "XpeedSimNoSuchEvo", &rig.statics.name), RECHECK).is_none());
        assert!(AcEvo::open_with(names(&rig.physics.name, &rig.graphics.name, "XpeedSimNoSuchEvo"), RECHECK).is_none());

        // Graphics of one page: the layout before `car_ids` (the header of acevo-shared-memory, 3940 bytes).
        let old = FakeMemory::new("old_g", 3940);
        old.write(0, &rig.image.graphics.0[..3940]);
        assert_eq!(Mapping::open(&old.name).unwrap().len(), 4096);
        assert!(AcEvo::open_with(names(&rig.physics.name, &old.name, &rig.statics.name), RECHECK).is_none());
        // Longer than the layout: any of the three.
        for (which, bytes) in [("p", 8200), ("g", 9000), ("s", 8200)] {
            let big = FakeMemory::new(&format!("big_{which}"), bytes);
            let n = match which {
                "p" => names(&big.name, &rig.graphics.name, &rig.statics.name),
                "g" => names(&rig.physics.name, &big.name, &rig.statics.name),
                _ => names(&rig.physics.name, &rig.graphics.name, &big.name),
            };
            assert!(AcEvo::open_with(n, RECHECK).is_none(), "{which} of {bytes} bytes");
        }

        // The version markers of the static page.
        let marker = |sm: &[u8], game: &[u8]| {
            let mut rig = Rig::new("marker");
            rig.image.statics.0[stat::SM_VERSION..stat::SM_VERSION + 15].fill(0);
            rig.image.statics.0[stat::SM_VERSION..stat::SM_VERSION + sm.len()].copy_from_slice(sm);
            rig.image.statics.0[stat::AC_EVO_VERSION..stat::AC_EVO_VERSION + 15].fill(0);
            rig.image.statics.0[stat::AC_EVO_VERSION..stat::AC_EVO_VERSION + game.len()].copy_from_slice(game);
            rig.write_all();
            let opened = AcEvo::open_with(rig.names(), RECHECK).is_some();
            rig.step();
            (opened, rig.image.frame().is_some())
        };
        assert_eq!(marker(b"1.0.0", b"0.6.3"), (true, true));
        assert_eq!(marker(b"2", b"v0.9-rc1"), (true, true), "no value is pinned, only a sane marker");
        assert_eq!(marker(b"", b"0.6.3"), (false, false), "blank: the page is not written yet");
        assert_eq!(marker(b"1.0.0", b""), (false, false));
        assert_eq!(marker(b"abc", b"0.6.3"), (false, false), "no digit");
        assert_eq!(marker(b"1.0\x01", b"0.6.3"), (false, false), "not printable");
        assert_eq!(marker(b"1.0.0", b"\xff\xfe1"), (false, false), "not ASCII");
        // No zero inside the 15 bytes of the field: not a version string.
        assert_eq!(marker(&[b'1'; 15], b"0.6.3"), (false, false));
        assert_eq!(marker(&[b'1'; 14], b"0.6.3"), (true, true), "14 characters and the zero");

        // The same refusals on a copy of the pages (the memory changed under an open reader).
        let image = Image::on_track();
        assert!(frame_from(
            &Page(&image.physics.0[..PHYSICS_BYTES - 1]),
            &Page(&image.graphics.0),
            &Page(&image.statics.0),
            0.0
        )
        .is_none());
        assert!(frame_from(
            &Page(&image.physics.0),
            &Page(&image.graphics.0[..gfx::READ_LEN - 1]),
            &Page(&image.statics.0),
            0.0
        )
        .is_none());
        assert!(frame_from(
            &Page(&image.physics.0),
            &Page(&image.graphics.0),
            &Page(&image.statics.0[..STATIC_BYTES - 1]),
            0.0
        )
        .is_none());
        assert!(frame_from(&Page(&[]), &Page(&[]), &Page(&[]), 0.0).is_none());
    }

    #[test]
    fn garbled_memory_never_panics_and_never_gives_numbers_out_of_range() {
        // A small deterministic generator, so a failure can be repeated.
        let mut state: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let mut given = 0;
        for round in 0..400 {
            let mut physics: Vec<u8> = (0..PHYSICS_BYTES).map(|_| next() as u8).collect();
            let mut graphics: Vec<u8> = (0..GRAPHICS_BYTES).map(|_| next() as u8).collect();
            let mut statics: Vec<u8> = (0..STATIC_BYTES).map(|_| next() as u8).collect();
            // Most rounds keep the markers and the status sane so the rest is read.
            if round % 4 != 0 {
                statics[stat::SM_VERSION..stat::SM_VERSION + 15].copy_from_slice(b"1.0.0\0\0\0\0\0\0\0\0\0\0");
                statics[stat::AC_EVO_VERSION..stat::AC_EVO_VERSION + 15].copy_from_slice(b"0.6.3\0\0\0\0\0\0\0\0\0\0");
                graphics[gfx::STATUS..gfx::STATUS + 4].copy_from_slice(&((next() % 4) as i32).to_le_bytes());
                graphics[gfx::TOTAL_LAP_COUNT..gfx::TOTAL_LAP_COUNT + 4].copy_from_slice(&((next() % 1000) as i32).to_le_bytes());
                // Some numbers in a range where they are believable, so the range checks below have something to check.
                for at in [phys::GAS, phys::BRAKE, phys::CLUTCH, phys::STEER_ANGLE, phys::SPEED_KMH, phys::FUEL] {
                    let v = (next() % 4000) as f32 / 1000.0 - 2.0;
                    physics[at..at + 4].copy_from_slice(&v.to_le_bytes());
                }
                for at in [phys::GEAR, phys::RPMS] {
                    physics[at..at + 4].copy_from_slice(&((next() % 20) as i32 - 2).to_le_bytes());
                }
                for at in [gfx::CURRENT_LAP_TIME_MS, gfx::LAST_LAPTIME_MS] {
                    graphics[at..at + 4].copy_from_slice(&((next() % 200_000) as i32 - 1000).to_le_bytes());
                }
            }
            let Some(f) = frame_from(&Page(&physics), &Page(&graphics[..gfx::READ_LEN]), &Page(&statics), 1.0) else {
                continue;
            };
            given += 1;
            assert!(f.lap >= 1 || !f.driving);
            for v in [f.throttle, f.brake, f.clutch] {
                assert!(v.is_nan() || (0.0..=1.0).contains(&v));
            }
            assert!(f.steer.is_nan() || (-1.0..=1.0).contains(&f.steer));
            assert!(f.speed_ms.is_nan() || (0.0..=1500.0 / 3.6 + 0.01).contains(&f.speed_ms));
            assert!(f.rpm.is_nan() || (0.0..=30_000.0).contains(&f.rpm));
            assert!(f.gear.is_nan() || (-1.0..=14.0).contains(&f.gear));
            assert!(f.fuel_l.is_nan() || (0.0..=1000.0).contains(&f.fuel_l));
            assert!(f.lap_time_s.is_none_or(|t| t.is_finite() && t >= 0.0));
            assert!(f.last_lap_s.is_none_or(|t| t.is_finite() && t > 0.0));
            assert!(f.track_length_m.is_none_or(|l| (200.0..=100_000.0).contains(&l)));
            assert!(f.dist_m.is_none());
            for v in [f.x, f.y, f.z] {
                assert!(v.is_nan() || v.abs() <= 1.0e6);
            }
        }
        assert!(given > 100, "given {given}");
    }

    #[test]
    fn it_notices_the_game_leaving() {
        // The memories vanish with the game (nobody else holds them): after a few looks it says it is gone.
        let rig = Rig::new("leave");
        let mut source = AcEvo::open_with(rig.names(), Duration::ZERO).unwrap();
        for _ in 0..5 {
            source.next(Duration::from_millis(1));
        }
        assert!(
            source.alive(),
            "opening the memories again while the game holds them changes nothing"
        );
        drop(rig);
        for _ in 0..3 {
            assert!(source.next(Duration::from_millis(1)).is_none());
        }
        assert!(!source.alive());
    }

    // ---- laps -------------------------------------------------------------------------------------------------

    /// Drives lap `completed + 1` through the memory, one reading every 20 ms of the game's lap clock, from `from` to `to`.
    fn drive(
        rig: &mut Rig,
        source: &mut AcEvo,
        cutter: &mut LapCutter,
        laps: &mut Vec<crate::lapfile::Lap>,
        (completed, last_ms): (i32, i32),
        (from, to): (i32, i32),
    ) {
        let mut at = from;
        while at < to {
            rig.image.graphics.i32(gfx::TOTAL_LAP_COUNT, completed);
            rig.image.graphics.i32(gfx::LAST_LAPTIME_MS, last_ms);
            rig.image.graphics.i32(gfx::CURRENT_LAP_TIME_MS, at);
            rig.image.physics.f32(phys::TYRE_CONTACT_POINT, at as f32 / 100.0);
            rig.step();
            let frame = source.next(NOW).expect("a frame for every new packet");
            laps.extend(cutter.on_frame(&frame, 1_794_312_000_000 + i64::from(at)));
            at += 20;
        }
    }

    fn lap_through_the_reader(invalid_midway: bool) -> Vec<crate::lapfile::Lap> {
        let mut rig = Rig::new("lap");
        let mut source = rig.reader();
        let mut cutter = LapCutter::new(source.game_id());
        let mut laps = Vec::new();
        // Lap 1 (no lap completed): 30 s, no official time yet.
        drive(&mut rig, &mut source, &mut cutter, &mut laps, (0, 0), (0, 15_000));
        if invalid_midway {
            rig.image.graphics.0[gfx::TIMING_IS_INVALID] = 1;
        }
        drive(&mut rig, &mut source, &mut cutter, &mut laps, (0, 0), (15_000, 30_000));
        assert!(laps.is_empty());
        // The line is crossed: one lap completed, the lap clock starts again, the official time is 30.0 s.
        rig.image.graphics.0[gfx::TIMING_IS_INVALID] = 0;
        drive(&mut rig, &mut source, &mut cutter, &mut laps, (1, 30_000), (0, 1_000));
        laps
    }

    #[test]
    fn a_scripted_lap_through_the_reader_and_the_cutter_is_one_lap_with_its_official_time() {
        let laps = lap_through_the_reader(false);
        assert_eq!(laps.len(), 1);
        let lap = &laps[0];
        assert_eq!(
            (lap.game.as_str(), lap.lap_number, lap.time_ms, lap.valid),
            ("acevo", 1, 30_000, true)
        );
        assert_eq!((lap.track_name.as_str(), lap.track_variant.as_deref()), ("monza", Some("gp")));
        assert_eq!(lap.car_name, "ks_porsche_911_gt3");
        assert_eq!(lap.track_length_m, Some(5793.0));
        assert_eq!(lap.sample_count(), 1500);
        let ids: Vec<&str> = lap.channels.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            ["t", "dist", "speed", "rpm", "gear", "throttle", "brake", "clutch", "steer", "x", "y", "z", "fuel"]
        );
        assert_eq!(lap.channel("t").unwrap().values.last(), Some(&29.98));
        assert_eq!(lap.channel("speed").unwrap().values[0], 50.0);
        assert!(crate::lapfile::gunzip(&crate::lapfile::gzip(lap).unwrap(), crate::lapfile::MAX_UNPACKED).is_ok());
    }

    #[test]
    fn a_lap_the_game_called_invalid_is_kept_but_not_valid() {
        let laps = lap_through_the_reader(true);
        assert_eq!((laps.len(), laps[0].time_ms, laps[0].valid), (1, 30_000, false));
    }
}
