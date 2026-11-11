//! Assetto Corsa (`ac`), Assetto Corsa Competizione (`acc`) and Assetto Corsa Rally (`acr`), the Kunos family.
//!
//! All three share their telemetry the same way: three named shared memories, `acpmf_physics`, `acpmf_graphics`
//! and `acpmf_static` (the strings `Local\acpmf_physics`, `Local\acpmf_graphics` and `Local\acpmf_static` are in
//! `acr.exe` and in `AC2-Win64-Shipping.exe`; Assetto Corsa documents the same names in
//! `apps/python/deltabar/deltabar_lib/sim_info.py`). Nothing else is read: no process memory is touched and nothing
//! is injected.
//!
//! # Where the layouts come from
//!
//! * Assetto Corsa: `sim_info.py` that ships with the game (`_pack_ = 4`, `wchar` = 2 bytes). It covers physics
//!   (256 bytes), graphics (264) and the first 452 bytes of static (through `tyreRadius`).
//! * Assetto Corsa Competizione: Kunos' "ACC Shared Memory Documentation" v1.8.12, as published at
//!   <https://github.com/rrennoir/PyAccSharedMemory> (file `ACCSharedMemoryDocumentationV1.8.12.pdf`). Summing its
//!   fields gives physics = 800 bytes and graphics = 1588 bytes, the sizes that library maps. The tests below redo
//!   that sum for every offset used here.
//! * Assetto Corsa Rally: there is no published layout that can be checked. Only the part ACC and Assetto Corsa
//!   have in common is read (physics through `abs`, graphics through `normalizedCarPosition`, static through the
//!   car and track names). Position, the lap validity flag and the track name variant are therefore missing for it.
//!   Assetto Corsa EVO uses other memories (`acevo_pmf_*`) and is not supported.
//!
//! The shared prefix is the same in all three: physics `[0, 256)`, graphics `[0, 252)`, static `[0, 200)` (up to the
//! track name). After it the games differ: graphics offset 252 is `carCoordinates[3]` in Assetto Corsa but
//! `activeCars` in Competizione.
//!
//! # Telling the three apart
//!
//! The page sizes cannot do it: Windows rounds every one of these small memories up to 4096 bytes (`Mapping::len`),
//! so they all look alike. The method is, in order:
//!
//! 1. The names of the running processes (a read-only list of names, never their memory): `acs.exe` or
//!    `acs_x86.exe` is Assetto Corsa, `AC2-Win64-Shipping.exe` is Competizione, `acr.exe` is Rally. Exactly one
//!    family must be running. If the list is there and no family is in it, the memory is stale (another program still
//!    holds it) and nothing is opened. Two families at once is settled by the version below, or refused.
//! 2. Only when the process list cannot be had: `smVersion` in the static page, `1.0` to `1.7` is Assetto Corsa,
//!    `1.8.x` is Competizione. Anything else (Rally's version is not known) is refused rather than guessed.
//!
//! Limits: a renamed executable is not recognised while the process list works; the version rule cannot tell
//! Rally apart, so Rally needs the process list. A mod or a patch that changes the version string only matters when
//! the process list is missing.
//!
//! # What becomes of the lap
//!
//! * `driving`: graphics `status` is LIVE (2). Off (0), replay (1) and pause (3) are not driving.
//! * `lap` = `completedLaps` + 1, `lap_time_s` = `iCurrentTime` / 1000, `last_lap_s` = `iLastTime` / 1000 when it is
//!   a real time (Competizione shows `i32::MAX` before a first lap).
//! * `lap_valid`: Competizione's `isValidLap`; the other two games do not say, so `None`.
//! * `in_pits`: `isInPit` (and, for Competizione, `isInPitLane`).
//! * `dist_m` is left `None` on purpose, so the lap cutter integrates the speed. The games give
//!   `normalizedCarPosition` (0..1 along the spline), but a fraction cannot become metres without the length of the
//!   lap, and none of them gives one that can be vouched for (Competizione's `trackSplineLength` is "not used in
//!   ACC"). `distanceTraveled` is documented as the distance of the current stint, in no unit that was checked, and
//!   it is not per lap, so it is not used. `Frame` has no place for a fraction, and the cutter cannot re-anchor on
//!   one.
//! * `track_length_m` and `track_variant`: only for Assetto Corsa, from `trackSPlineLength` (offset 520) and
//!   `trackConfiguration` (offset 524). Those offsets come from the Competizione document, whose header marks them
//!   "not used in ACC" (so Assetto Corsa is the game that fills them); they are not checked against a live game.
//!
//! # Not checked against a live game
//!
//! `steerAngle` is documented as -1..1 and is passed through (clamped, and dropped when it is far outside that).
//! Competizione's `fuel` is documented in kilograms and is taken as litres, the way the game's own fuel gauge and
//! `maxFuel` read. The clutch pedal is not read: its polarity (1 = pressed or released) is not documented.

use std::time::{Duration, Instant};

use crate::game::{Frame, Source};
use crate::shm::{Mapping, Page};

/// How often the loop looks at the memory while it waits for a new reading (about 100 Hz).
const POLL_STEP: Duration = Duration::from_millis(10);
/// How often the memories are opened again and the process list is looked at, to notice the game closing (a memory
/// stays alive as long as anyone holds it, this reader included, so it must let go to see the game go).
const RECHECK: Duration = Duration::from_secs(2);
/// Checks in a row that must say "gone" before the source gives up.
const MISSES_BEFORE_GONE: u32 = 3;

/// Offsets (bytes) in the three pages. `_pack_ = 4`: every field is 4-aligned, a `wchar_t` is 2 bytes.
mod layout {
    pub const STATUS_LIVE: i32 = 2;
    pub const MAX_LAPS: i32 = 100_000;
    pub const MAX_CARS: usize = 60;

    // Physics, the same in all three games up to here.
    pub const PHYS_PACKET_ID: usize = 0;
    pub const PHYS_GAS: usize = 4;
    pub const PHYS_BRAKE: usize = 8;
    pub const PHYS_FUEL: usize = 12;
    pub const PHYS_GEAR: usize = 16;
    pub const PHYS_RPMS: usize = 20;
    pub const PHYS_STEER: usize = 24;
    pub const PHYS_SPEED_KMH: usize = 28;
    /// The end of `abs`: the physics prefix shared by the three games.
    pub const PHYS_LEN: usize = 256;

    // Graphics, shared prefix.
    pub const GFX_PACKET_ID: usize = 0;
    pub const GFX_STATUS: usize = 4;
    pub const GFX_COMPLETED_LAPS: usize = 132;
    pub const GFX_I_CURRENT_TIME: usize = 140;
    pub const GFX_I_LAST_TIME: usize = 144;
    pub const GFX_IS_IN_PIT: usize = 160;
    /// Not read (see the module comment on distance); here for the layout test.
    #[cfg(test)]
    pub const GFX_NORMALIZED_POSITION: usize = 248;
    /// The end of `normalizedCarPosition`: the graphics prefix shared by the three games.
    pub const GFX_PREFIX_LEN: usize = 252;
    // Graphics, Assetto Corsa only.
    pub const GFX_AC_CAR_COORDINATES: usize = 252;
    pub const GFX_AC_LEN: usize = 264;
    // Graphics, Competizione only.
    pub const GFX_ACC_ACTIVE_CARS: usize = 252;
    pub const GFX_ACC_CAR_COORDINATES: usize = 256;
    pub const GFX_ACC_CAR_ID: usize = 976;
    pub const GFX_ACC_PLAYER_CAR_ID: usize = 1216;
    pub const GFX_ACC_IS_IN_PIT_LANE: usize = 1236;
    pub const GFX_ACC_IS_VALID_LAP: usize = 1408;
    pub const GFX_ACC_LEN: usize = 1588;

    // Static, shared prefix (`wchar_t` arrays: 15 for the versions, 33 for the names).
    pub const STAT_SM_VERSION: usize = 0;
    pub const STAT_CAR_MODEL: usize = 68;
    pub const STAT_TRACK: usize = 134;
    /// The end of `track`: all that is read of Competizione and Rally.
    pub const STAT_PREFIX_LEN: usize = 200;
    // Static, Assetto Corsa only.
    pub const STAT_AC_TRACK_SPLINE_LENGTH: usize = 520;
    pub const STAT_AC_TRACK_CONFIGURATION: usize = 524;
    pub const STAT_AC_LEN: usize = 556;
}
use layout::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Family {
    Ac,
    Acc,
    Acr,
}

impl Family {
    fn id(self) -> &'static str {
        match self {
            Family::Ac => "ac",
            Family::Acc => "acc",
            Family::Acr => "acr",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Family::Ac => "Assetto Corsa",
            Family::Acc => "Assetto Corsa Competizione",
            Family::Acr => "Assetto Corsa Rally",
        }
    }

    /// The game whose process has this executable name.
    fn of_process(exe: &str) -> Option<Family> {
        match exe.to_ascii_lowercase().as_str() {
            "acs.exe" | "acs_x86.exe" => Some(Family::Ac),
            "ac2-win64-shipping.exe" => Some(Family::Acc),
            "acr.exe" => Some(Family::Acr),
            _ => None,
        }
    }

    /// What the games' `smVersion` says, for the days the process list is not there: `1.0` to `1.7` is Assetto Corsa,
    /// `1.8.x` Competizione. Rally's version is not known, so nothing says Rally.
    fn of_version(version: &str) -> Option<Family> {
        let mut parts = version.trim().split('.');
        let major: u32 = parts.next()?.trim().parse().ok()?;
        let minor: u32 = parts.next()?.trim().parse().ok()?;
        match (major, minor) {
            (1, 0..=7) => Some(Family::Ac),
            (1, 8) => Some(Family::Acc),
            _ => None,
        }
    }

    fn graphics_len(self) -> usize {
        match self {
            Family::Ac => GFX_AC_LEN,
            Family::Acc => GFX_ACC_LEN,
            Family::Acr => GFX_PREFIX_LEN,
        }
    }

    fn static_len(self) -> usize {
        match self {
            Family::Ac => STAT_AC_LEN,
            Family::Acc | Family::Acr => STAT_PREFIX_LEN,
        }
    }
}

/// Which game it is. The flag says the process list decided it (so the list is also what says the game is gone).
fn detect(running: Option<&[String]>, sm_version: &str) -> Option<(Family, bool)> {
    let by_version = Family::of_version(sm_version);
    match running {
        Some(names) => {
            let mut found: Vec<Family> = names.iter().filter_map(|n| Family::of_process(n)).collect();
            found.sort_by_key(|f| *f as u8);
            found.dedup();
            match found.as_slice() {
                [one] => Some((*one, true)),
                [] => None,
                _ => by_version.filter(|v| found.contains(v)).map(|v| (v, true)),
            }
        }
        None => by_version.map(|v| (v, false)),
    }
}

/// Whether the three memories are big enough for the layout of `family`.
fn pages_fit(family: Family, physics: usize, graphics: usize, statics: usize) -> bool {
    physics >= PHYS_LEN && graphics >= family.graphics_len() && statics >= family.static_len()
}

/// The names of the three shared memories (the tests use names of their own, never the game's).
pub struct Names {
    physics: String,
    graphics: String,
    statics: String,
}

impl Names {
    pub fn game() -> Names {
        Names {
            physics: "acpmf_physics".into(),
            graphics: "acpmf_graphics".into(),
            statics: "acpmf_static".into(),
        }
    }
}

struct Pages {
    physics: Mapping,
    graphics: Mapping,
    statics: Mapping,
}

impl Pages {
    fn open(names: &Names) -> Option<Pages> {
        Some(Pages {
            physics: Mapping::open(&names.physics)?,
            graphics: Mapping::open(&names.graphics)?,
            statics: Mapping::open(&names.statics)?,
        })
    }
}

/// The names (executables) of the processes running now, `None` when Windows would not say.
type ProcessList = Box<dyn Fn() -> Option<Vec<String>>>;

struct KunosSource {
    family: Family,
    names: Names,
    pages: Option<Pages>,
    running: ProcessList,
    /// The process list is what told the games apart, so it is also what tells that the game left.
    by_process: bool,
    recheck_every: Duration,
    last_check: Instant,
    misses: u32,
    gone: bool,
    /// The two packet counters of the last reading handed out.
    last_ids: Option<(i32, i32)>,
    epoch: Instant,
}

impl KunosSource {
    fn open_with(names: &Names, running: ProcessList, recheck_every: Duration) -> Option<KunosSource> {
        let pages = Pages::open(names)?;
        let version = Page(&pages.statics.read(0, STAT_PREFIX_LEN)?).utf16_at(STAT_SM_VERSION, 15);
        let (family, by_process) = detect(running().as_deref(), &version)?;
        if !pages_fit(family, pages.physics.len(), pages.graphics.len(), pages.statics.len()) {
            return None;
        }
        let names = Names {
            physics: names.physics.clone(),
            graphics: names.graphics.clone(),
            statics: names.statics.clone(),
        };
        Some(KunosSource {
            family,
            names,
            pages: Some(pages),
            running,
            by_process,
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
        let process_gone =
            self.by_process && (self.running)().is_some_and(|names| !names.iter().any(|n| Family::of_process(n) == Some(self.family)));
        self.pages = None;
        self.pages = Pages::open(&self.names);
        let fits = self
            .pages
            .as_ref()
            .is_some_and(|p| pages_fit(self.family, p.physics.len(), p.graphics.len(), p.statics.len()));
        if process_gone || !fits {
            self.misses += 1;
        } else {
            self.misses = 0;
        }
        self.gone = self.misses >= MISSES_BEFORE_GONE;
    }

    fn read_frame(&mut self) -> Option<Frame> {
        let pages = self.pages.as_ref()?;
        let physics = pages.physics.read(0, PHYS_LEN)?;
        let graphics = pages.graphics.read(0, self.family.graphics_len())?;
        let statics = pages.statics.read(0, self.family.static_len())?;
        let (p, g, s) = (Page(&physics), Page(&graphics), Page(&statics));
        let ids = (p.i32_at(PHYS_PACKET_ID), g.i32_at(GFX_PACKET_ID));
        if self.last_ids == Some(ids) {
            return None;
        }
        self.last_ids = Some(ids);
        Some(frame_from(self.family, &p, &g, &s, self.epoch.elapsed().as_secs_f64()))
    }
}

impl Source for KunosSource {
    fn game_id(&self) -> &'static str {
        self.family.id()
    }

    fn game_name(&self) -> &'static str {
        self.family.name()
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

pub fn open() -> Option<Box<dyn Source>> {
    let source = KunosSource::open_with(&Names::game(), Box::new(running_processes), RECHECK)?;
    Some(Box::new(source))
}

fn pedal(v: f32) -> f32 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        f32::NAN
    }
}

fn within(v: f32, limit: f32) -> f32 {
    if v.is_finite() && v.abs() <= limit {
        v
    } else {
        f32::NAN
    }
}

/// A time in milliseconds as seconds, when it is a time (not negative, not an "none yet" value like `i32::MAX`).
fn seconds(ms: i32) -> Option<f64> {
    (0..=36_000_000).contains(&ms).then(|| f64::from(ms) / 1000.0)
}

/// Competizione's coordinates of the player's own car: the slot of `carID` that is `playerCarID`.
fn acc_player_position(g: &Page) -> Option<[f32; 3]> {
    let active = usize::try_from(g.i32_at(GFX_ACC_ACTIVE_CARS)).ok()?.min(MAX_CARS);
    let me = g.i32_at(GFX_ACC_PLAYER_CAR_ID);
    let slot = (0..active).find(|&i| g.i32_at(GFX_ACC_CAR_ID + 4 * i) == me)?;
    let at = GFX_ACC_CAR_COORDINATES + 12 * slot;
    Some([g.f32_at(at), g.f32_at(at + 4), g.f32_at(at + 8)])
}

/// One reading of the three pages as a `Frame`. Never panics: a short or garbled page gives `NaN`, `None` or "not
/// driving", not an error.
fn frame_from(family: Family, p: &Page, g: &Page, s: &Page, clock_s: f64) -> Frame {
    let mut f = Frame::empty();
    f.clock_s = clock_s;
    let completed = g.i32_at(GFX_COMPLETED_LAPS);
    let lap_known = (0..=MAX_LAPS).contains(&completed);
    f.driving = g.i32_at(GFX_STATUS) == STATUS_LIVE && lap_known;
    f.lap = if lap_known { completed + 1 } else { 0 };
    f.lap_time_s = seconds(g.i32_at(GFX_I_CURRENT_TIME));
    f.last_lap_s = seconds(g.i32_at(GFX_I_LAST_TIME)).filter(|t| *t > 0.0);
    f.in_pits = g.i32_at(GFX_IS_IN_PIT) != 0;

    f.throttle = pedal(p.f32_at(PHYS_GAS));
    f.brake = pedal(p.f32_at(PHYS_BRAKE));
    f.speed_ms = (f64::from(within(p.f32_at(PHYS_SPEED_KMH), 1500.0)) / 3.6) as f32;
    let rpm = p.i32_at(PHYS_RPMS);
    f.rpm = if (0..=30_000).contains(&rpm) { rpm as f32 } else { f32::NAN };
    // 0 = reverse, 1 = neutral, 2 = first.
    let gear = p.i32_at(PHYS_GEAR);
    f.gear = if (0..=15).contains(&gear) { (gear - 1) as f32 } else { f32::NAN };
    // Documented as -1..1; a value far outside is not that (degrees, say) and is dropped, not pinned to the ends.
    let steer = p.f32_at(PHYS_STEER);
    f.steer = if steer.is_finite() && steer.abs() <= 1.5 {
        steer.clamp(-1.0, 1.0)
    } else {
        f32::NAN
    };
    f.fuel_l = {
        let fuel = p.f32_at(PHYS_FUEL);
        if fuel.is_finite() && (0.0..=1000.0).contains(&fuel) {
            fuel
        } else {
            f32::NAN
        }
    };

    f.car = s.utf16_at(STAT_CAR_MODEL, 33);
    f.track = s.utf16_at(STAT_TRACK, 33);

    let position = match family {
        Family::Ac => Some([
            g.f32_at(GFX_AC_CAR_COORDINATES),
            g.f32_at(GFX_AC_CAR_COORDINATES + 4),
            g.f32_at(GFX_AC_CAR_COORDINATES + 8),
        ]),
        Family::Acc => acc_player_position(g),
        Family::Acr => None,
    };
    if let Some([x, y, z]) = position {
        f.x = within(x, 1.0e6);
        f.y = within(y, 1.0e6);
        f.z = within(z, 1.0e6);
    }
    match family {
        Family::Ac => {
            let length = f64::from(s.f32_at(STAT_AC_TRACK_SPLINE_LENGTH));
            f.track_length_m = (length.is_finite() && (200.0..=100_000.0).contains(&length)).then_some(length);
            // Read at most the 15 characters the header gives it; stops at the first zero.
            let variant = s.utf16_at(STAT_AC_TRACK_CONFIGURATION, 15);
            f.track_variant = (!variant.is_empty() && variant.chars().all(|c| !c.is_control())).then_some(variant);
        }
        Family::Acc => {
            f.in_pits |= g.i32_at(GFX_ACC_IS_IN_PIT_LANE) != 0;
            f.lap_valid = match g.i32_at(GFX_ACC_IS_VALID_LAP) {
                0 => Some(false),
                1 => Some(true),
                _ => None,
            };
        }
        Family::Acr => {}
    }
    f
}

/// The executable names of the running processes (a read-only list; no process is opened). `None` if Windows says no.
fn running_processes() -> Option<Vec<String>> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};

    #[repr(C)]
    struct ProcessEntry {
        size: u32,
        usage: u32,
        pid: u32,
        heap_id: usize,
        module_id: u32,
        threads: u32,
        parent_pid: u32,
        priority: i32,
        flags: u32,
        exe_file: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> HANDLE;
        fn Process32FirstW(snapshot: HANDLE, entry: *mut ProcessEntry) -> i32;
        fn Process32NextW(snapshot: HANDLE, entry: *mut ProcessEntry) -> i32;
    }

    const SNAPSHOT_PROCESSES: u32 = 2;
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(SNAPSHOT_PROCESSES, 0);
        if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
            return None;
        }
        let mut entry: ProcessEntry = std::mem::zeroed();
        entry.size = std::mem::size_of::<ProcessEntry>() as u32;
        let mut names = Vec::new();
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            names.push(crate::game::text_of_utf16(&entry.exe_file));
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        Some(names)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lapcut::LapCutter;
    use crate::shm::FakeMemory;
    use std::cell::RefCell;
    use std::rc::Rc;

    // ---- the layouts, proved by adding up the sizes of the published fields -----------------------------------

    /// (field, size of one element in bytes, count). Offsets as the C++ compiler lays them out with `_pack_ = 4`.
    type Fields = &'static [(&'static str, usize, usize)];

    fn offsets(fields: Fields) -> (Vec<(&'static str, usize)>, usize) {
        let mut at = 0usize;
        let mut out = Vec::new();
        for &(name, size, count) in fields {
            at = at.next_multiple_of(size.min(4));
            out.push((name, at));
            at += size * count;
        }
        (out, at.next_multiple_of(4))
    }

    fn offset_of(fields: Fields, name: &str) -> usize {
        offsets(fields).0.into_iter().find(|(n, _)| *n == name).unwrap().1
    }

    const F: usize = 4; // int and float
    const W: usize = 2; // wchar_t

    /// `SPageFilePhysics` of `sim_info.py` (Assetto Corsa); Competizione's header starts with the same 256 bytes.
    const PHYSICS: Fields = &[
        ("packetId", F, 1),
        ("gas", F, 1),
        ("brake", F, 1),
        ("fuel", F, 1),
        ("gear", F, 1),
        ("rpms", F, 1),
        ("steerAngle", F, 1),
        ("speedKmh", F, 1),
        ("velocity", F, 3),
        ("accG", F, 3),
        ("wheelSlip", F, 4),
        ("wheelLoad", F, 4),
        ("wheelsPressure", F, 4),
        ("wheelAngularSpeed", F, 4),
        ("tyreWear", F, 4),
        ("tyreDirtyLevel", F, 4),
        ("tyreCoreTemperature", F, 4),
        ("camberRAD", F, 4),
        ("suspensionTravel", F, 4),
        ("drs", F, 1),
        ("tc", F, 1),
        ("heading", F, 1),
        ("pitch", F, 1),
        ("roll", F, 1),
        ("cgHeight", F, 1),
        ("carDamage", F, 5),
        ("numberOfTyresOut", F, 1),
        ("pitLimiterOn", F, 1),
        ("abs", F, 1),
    ];

    /// `SPageFileGraphic` of `sim_info.py` (Assetto Corsa).
    const GRAPHICS_AC: Fields = &[
        ("packetId", F, 1),
        ("status", F, 1),
        ("session", F, 1),
        ("currentTime", W, 15),
        ("lastTime", W, 15),
        ("bestTime", W, 15),
        ("split", W, 15),
        ("completedLaps", F, 1),
        ("position", F, 1),
        ("iCurrentTime", F, 1),
        ("iLastTime", F, 1),
        ("iBestTime", F, 1),
        ("sessionTimeLeft", F, 1),
        ("distanceTraveled", F, 1),
        ("isInPit", F, 1),
        ("currentSectorIndex", F, 1),
        ("lastSectorTime", F, 1),
        ("numberOfLaps", F, 1),
        ("tyreCompound", W, 33),
        ("replayTimeMultiplier", F, 1),
        ("normalizedCarPosition", F, 1),
        ("carCoordinates", F, 3),
    ];

    /// `SPageFileGraphic` of the ACC Shared Memory Documentation v1.8.12 (Competizione).
    const GRAPHICS_ACC: Fields = &[
        ("packetId", F, 1),
        ("status", F, 1),
        ("session", F, 1),
        ("currentTime", W, 15),
        ("lastTime", W, 15),
        ("bestTime", W, 15),
        ("split", W, 15),
        ("completedLaps", F, 1),
        ("position", F, 1),
        ("iCurrentTime", F, 1),
        ("iLastTime", F, 1),
        ("iBestTime", F, 1),
        ("sessionTimeLeft", F, 1),
        ("distanceTraveled", F, 1),
        ("isInPit", F, 1),
        ("currentSectorIndex", F, 1),
        ("lastSectorTime", F, 1),
        ("numberOfLaps", F, 1),
        ("tyreCompound", W, 33),
        ("replayTimeMultiplier", F, 1),
        ("normalizedCarPosition", F, 1),
        ("activeCars", F, 1),
        ("carCoordinates", F, 180),
        ("carID", F, 60),
        ("playerCarID", F, 1),
        ("penaltyTime", F, 1),
        ("flag", F, 1),
        ("penalty", F, 1),
        ("idealLineOn", F, 1),
        ("isInPitLane", F, 1),
        ("surfaceGrip", F, 1),
        ("mandatoryPitDone", F, 1),
        ("windSpeed", F, 1),
        ("windDirection", F, 1),
        ("isSetupMenuVisible", F, 1),
        ("mainDisplayIndex", F, 1),
        ("secondaryDisplayIndex", F, 1),
        ("TC", F, 1),
        ("TCCUT", F, 1),
        ("EngineMap", F, 1),
        ("ABS", F, 1),
        ("fuelXLap", F, 1),
        ("rainLights", F, 1),
        ("flashingLights", F, 1),
        ("lightsStage", F, 1),
        ("exhaustTemperature", F, 1),
        ("wiperLV", F, 1),
        ("driverStintTotalTimeLeft", F, 1),
        ("driverStintTimeLeft", F, 1),
        ("rainTyres", F, 1),
        ("sessionIndex", F, 1),
        ("usedFuel", F, 1),
        ("deltaLapTime", W, 15),
        ("iDeltaLapTime", F, 1),
        ("estimatedLapTime", W, 15),
        ("iEstimatedLapTime", F, 1),
        ("isDeltaPositive", F, 1),
        ("iSplit", F, 1),
        ("isValidLap", F, 1),
        ("fuelEstimatedLaps", F, 1),
        ("trackStatus", W, 33),
        ("missingMandatoryPits", F, 1),
        ("Clock", F, 1),
        ("directionLightsLeft", F, 1),
        ("directionLightsRight", F, 1),
        ("GlobalYellow", F, 1),
        ("GlobalYellow1", F, 1),
        ("GlobalYellow2", F, 1),
        ("GlobalYellow3", F, 1),
        ("GlobalWhite", F, 1),
        ("GlobalGreen", F, 1),
        ("GlobalChequered", F, 1),
        ("GlobalRed", F, 1),
        ("mfdTyreSet", F, 1),
        ("mfdFuelToAdd", F, 1),
        ("mfdTyrePressureLF", F, 1),
        ("mfdTyrePressureRF", F, 1),
        ("mfdTyrePressureLR", F, 1),
        ("mfdTyrePressureRR", F, 1),
        ("trackGripStatus", F, 1),
        ("rainIntensity", F, 1),
        ("rainIntensityIn10min", F, 1),
        ("rainIntensityIn30min", F, 1),
        ("currentTyreSet", F, 1),
        ("strategyTyreSet", F, 1),
        ("gapAhead", F, 1),
        ("gapBehind", F, 1),
    ];

    /// `SPageFileStatic` of `sim_info.py` (Assetto Corsa), then the fields the Competizione header adds up to
    /// `trackConfiguration` (marked "not used in ACC": Assetto Corsa fills them).
    const STATIC: Fields = &[
        ("smVersion", W, 15),
        ("acVersion", W, 15),
        ("numberOfSessions", F, 1),
        ("numCars", F, 1),
        ("carModel", W, 33),
        ("track", W, 33),
        ("playerName", W, 33),
        ("playerSurname", W, 33),
        ("playerNick", W, 33),
        ("sectorCount", F, 1),
        ("maxTorque", F, 1),
        ("maxPower", F, 1),
        ("maxRpm", F, 1),
        ("maxFuel", F, 1),
        ("suspensionMaxTravel", F, 4),
        ("tyreRadius", F, 4),
        ("maxTurboBoost", F, 1),
        ("deprecated_1", F, 1),
        ("deprecated_2", F, 1),
        ("penaltiesEnabled", F, 1),
        ("aidFuelRate", F, 1),
        ("aidTireRate", F, 1),
        ("aidMechanicalDamage", F, 1),
        ("allowTyreBlankets", F, 1),
        ("aidStability", F, 1),
        ("aidAutoclutch", F, 1),
        ("aidAutoBlip", F, 1),
        ("hasDRS", F, 1),
        ("hasERS", F, 1),
        ("hasKERS", F, 1),
        ("kersMaxJ", F, 1),
        ("engineBrakeSettingsCount", F, 1),
        ("ersPowerControllerCount", F, 1),
        ("trackSplineLength", F, 1),
        ("trackConfiguration", W, 15),
    ];

    #[test]
    fn the_physics_offsets_are_the_sum_of_the_field_sizes() {
        let (_, total) = offsets(PHYSICS);
        assert_eq!(total, PHYS_LEN, "256 bytes, the prefix shared by the three games");
        for (name, at) in [
            ("packetId", PHYS_PACKET_ID),
            ("gas", PHYS_GAS),
            ("brake", PHYS_BRAKE),
            ("fuel", PHYS_FUEL),
            ("gear", PHYS_GEAR),
            ("rpms", PHYS_RPMS),
            ("steerAngle", PHYS_STEER),
            ("speedKmh", PHYS_SPEED_KMH),
        ] {
            assert_eq!(offset_of(PHYSICS, name), at, "{name}");
        }
    }

    #[test]
    fn the_graphics_offsets_are_the_sum_of_the_field_sizes() {
        assert_eq!(offsets(GRAPHICS_AC).1, GFX_AC_LEN);
        assert_eq!(offsets(GRAPHICS_ACC).1, GFX_ACC_LEN, "1588 bytes, the size Competizione's page has");
        for (name, at) in [
            ("packetId", GFX_PACKET_ID),
            ("status", GFX_STATUS),
            ("completedLaps", GFX_COMPLETED_LAPS),
            ("iCurrentTime", GFX_I_CURRENT_TIME),
            ("iLastTime", GFX_I_LAST_TIME),
            ("isInPit", GFX_IS_IN_PIT),
            ("normalizedCarPosition", GFX_NORMALIZED_POSITION),
        ] {
            assert_eq!(offset_of(GRAPHICS_AC, name), at, "AC {name}");
            assert_eq!(offset_of(GRAPHICS_ACC, name), at, "ACC {name}: the prefix is shared");
        }
        assert_eq!(offset_of(GRAPHICS_AC, "normalizedCarPosition") + 4, GFX_PREFIX_LEN);
        assert_eq!(offset_of(GRAPHICS_AC, "carCoordinates"), GFX_AC_CAR_COORDINATES);
        for (name, at) in [
            ("activeCars", GFX_ACC_ACTIVE_CARS),
            ("carCoordinates", GFX_ACC_CAR_COORDINATES),
            ("carID", GFX_ACC_CAR_ID),
            ("playerCarID", GFX_ACC_PLAYER_CAR_ID),
            ("isInPitLane", GFX_ACC_IS_IN_PIT_LANE),
            ("isValidLap", GFX_ACC_IS_VALID_LAP),
        ] {
            assert_eq!(offset_of(GRAPHICS_ACC, name), at, "ACC {name}");
        }
        assert_eq!(GFX_ACC_CAR_ID, GFX_ACC_CAR_COORDINATES + MAX_CARS * 12);
        assert_eq!(GFX_ACC_PLAYER_CAR_ID, GFX_ACC_CAR_ID + MAX_CARS * 4);
    }

    #[test]
    fn the_static_offsets_are_the_sum_of_the_field_sizes() {
        assert_eq!(offset_of(STATIC, "smVersion"), STAT_SM_VERSION);
        assert_eq!(offset_of(STATIC, "carModel"), STAT_CAR_MODEL);
        assert_eq!(offset_of(STATIC, "track"), STAT_TRACK);
        assert_eq!(offset_of(STATIC, "track") + 33 * W, 200);
        const { assert!(STAT_PREFIX_LEN >= 200) };
        assert_eq!(offset_of(STATIC, "maxTurboBoost"), 452, "where sim_info.py's own struct ends");
        assert_eq!(offset_of(STATIC, "trackSplineLength"), STAT_AC_TRACK_SPLINE_LENGTH);
        assert_eq!(offset_of(STATIC, "trackConfiguration"), STAT_AC_TRACK_CONFIGURATION);
        const { assert!(STAT_AC_TRACK_CONFIGURATION + 15 * W <= STAT_AC_LEN) };
    }

    // ---- a game made of three memories of the test's own ----------------------------------------------------

    struct Sim {
        names: Names,
        phys: FakeMemory,
        gfx: FakeMemory,
        stat: FakeMemory,
        packet: i32,
    }

    fn utf16(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    impl Sim {
        fn new() -> Sim {
            let phys = FakeMemory::new("phys", 800);
            let gfx = FakeMemory::new("gfx", 1588);
            let stat = FakeMemory::new("stat", 784);
            let names = Names {
                physics: phys.name.clone(),
                graphics: gfx.name.clone(),
                statics: stat.name.clone(),
            };
            Sim {
                names,
                phys,
                gfx,
                stat,
                packet: 0,
            }
        }

        /// A car on track, LIVE, third gear at 180 km/h, on its fifth lap, with the version a game of `family` says.
        fn live(version: &str) -> Sim {
            let mut sim = Sim::new();
            sim.stat.write(STAT_SM_VERSION, &utf16(version));
            sim.stat.write(STAT_CAR_MODEL, &utf16("ks_ferrari_f40"));
            sim.stat.write(STAT_TRACK, &utf16("monza"));
            sim.phys.write(PHYS_GAS, &0.75f32.to_le_bytes());
            sim.phys.write(PHYS_BRAKE, &0.25f32.to_le_bytes());
            sim.phys.write(PHYS_FUEL, &40.5f32.to_le_bytes());
            sim.phys.write(PHYS_GEAR, &3i32.to_le_bytes());
            sim.phys.write(PHYS_RPMS, &7200i32.to_le_bytes());
            sim.phys.write(PHYS_STEER, &(-0.25f32).to_le_bytes());
            sim.phys.write(PHYS_SPEED_KMH, &180.0f32.to_le_bytes());
            sim.gfx.write(GFX_STATUS, &STATUS_LIVE.to_le_bytes());
            sim.gfx.write(GFX_COMPLETED_LAPS, &4i32.to_le_bytes());
            sim.gfx.write(GFX_I_CURRENT_TIME, &63_250i32.to_le_bytes());
            sim.gfx.write(GFX_I_LAST_TIME, &91_500i32.to_le_bytes());
            sim.gfx.write(GFX_NORMALIZED_POSITION, &0.5f32.to_le_bytes());
            sim.step();
            sim
        }

        /// The game writes a new reading: both packet counters move.
        fn step(&mut self) {
            self.packet += 1;
            self.phys.write(PHYS_PACKET_ID, &self.packet.to_le_bytes());
            self.gfx.write(GFX_PACKET_ID, &self.packet.to_le_bytes());
        }

        fn gfx_i32(&self, at: usize, v: i32) {
            self.gfx.write(at, &v.to_le_bytes());
        }

        fn gfx_f32(&self, at: usize, v: f32) {
            self.gfx.write(at, &v.to_le_bytes());
        }
    }

    fn no_processes() -> ProcessList {
        Box::new(|| None)
    }

    fn processes(names: &'static [&'static str]) -> ProcessList {
        Box::new(move || Some(names.iter().map(|n| (*n).to_owned()).collect()))
    }

    fn open_sim(sim: &Sim, running: ProcessList) -> KunosSource {
        KunosSource::open_with(&sim.names, running, Duration::from_secs(3600)).expect("opens")
    }

    const SOON: Duration = Duration::from_millis(50);

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    // ---- telling the games apart ----------------------------------------------------------------------------

    fn s(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[test]
    fn the_process_names_say_which_game_it_is() {
        for (exe, family) in [
            ("acs.exe", Family::Ac),
            ("ACS_x86.exe", Family::Ac),
            ("AC2-Win64-Shipping.exe", Family::Acc),
            ("acr.exe", Family::Acr),
        ] {
            let list = s(&["explorer.exe", exe, "steam.exe"]);
            assert_eq!(detect(Some(&list), ""), Some((family, true)), "{exe}");
        }
        // The launchers are not the game.
        assert_eq!(detect(Some(&s(&["AssettoCorsa.exe", "acc.exe"])), "1.7"), None);
        // No known game running: the memory is stale, whatever the version says.
        assert_eq!(detect(Some(&s(&["explorer.exe"])), "1.8.12"), None);
    }

    #[test]
    fn the_version_decides_only_when_there_is_no_process_list() {
        for (version, family) in [("1.7", Some(Family::Ac)), ("1.8.12", Some(Family::Acc)), ("1.8", Some(Family::Acc))] {
            assert_eq!(detect(None, version), family.map(|f| (f, false)), "{version}");
        }
        for version in ["", "2.0", "1.9", "garbage", "1", "1.x"] {
            assert_eq!(detect(None, version), None, "{version:?} is not guessed");
        }
        // Two games at once: the version picks one of them, or nothing does.
        let both = s(&["acs.exe", "AC2-Win64-Shipping.exe"]);
        assert_eq!(detect(Some(&both), "1.8.12"), Some((Family::Acc, true)));
        assert_eq!(detect(Some(&both), "1.9"), None);
    }

    #[test]
    fn each_game_opens_under_its_own_id_and_name() {
        for (exe, version, id, name) in [
            ("acs.exe", "1.7", "ac", "Assetto Corsa"),
            ("AC2-Win64-Shipping.exe", "1.8.12", "acc", "Assetto Corsa Competizione"),
            ("acr.exe", "", "acr", "Assetto Corsa Rally"),
        ] {
            let sim = Sim::live(version);
            let exes: &'static [&'static str] = Box::leak(vec![exe].into_boxed_slice());
            let source = open_sim(&sim, processes(exes));
            assert_eq!((source.game_id(), source.game_name()), (id, name));
        }
        // Without a process list, the version still tells the two it knows; Rally it cannot.
        assert_eq!(open_sim(&Sim::live("1.7"), no_processes()).game_id(), "ac");
        assert_eq!(open_sim(&Sim::live("1.8.12"), no_processes()).game_id(), "acc");
        assert!(KunosSource::open_with(&Sim::live("1.9").names, no_processes(), RECHECK).is_none());
        assert!(KunosSource::open_with(&Sim::live("1.8.12").names, processes(&[]), RECHECK).is_none());
    }

    #[test]
    fn the_real_process_list_works() {
        let me = std::env::current_exe()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_lowercase();
        let list = running_processes().expect("the list can be had");
        assert!(
            list.iter().any(|n| n.to_lowercase() == me),
            "this test's own program {me} is in {} names",
            list.len()
        );
        // A struct declared by hand that did not match Windows' would not walk the list at all.
        assert!(list.len() > 5);
    }

    #[test]
    fn pages_too_short_for_the_layout_are_refused() {
        assert!(pages_fit(Family::Acc, 800, 1588, 784));
        assert!(pages_fit(Family::Ac, 256, 264, 556));
        assert!(pages_fit(Family::Acr, 256, 252, 200));
        assert!(
            !pages_fit(Family::Acc, 800, 1000, 784),
            "Competizione's graphics page is 1588 bytes"
        );
        assert!(!pages_fit(Family::Ac, 255, 264, 556));
        assert!(!pages_fit(Family::Ac, 256, 100, 556));
        assert!(!pages_fit(Family::Acr, 256, 252, 100));
        assert!(!pages_fit(Family::Acr, 0, 0, 0));
    }

    #[test]
    fn nothing_opens_while_a_memory_is_missing() {
        let sim = Sim::live("1.7");
        let mut names = Names::game();
        names.physics = sim.names.physics.clone();
        names.graphics = "XpeedSimNoSuchKunosMemory".into();
        names.statics = sim.names.statics.clone();
        assert!(KunosSource::open_with(&names, no_processes(), RECHECK).is_none());
    }

    // ---- reading ----------------------------------------------------------------------------------------------

    #[test]
    fn a_reading_becomes_a_frame_with_exact_values_assetto_corsa() {
        let sim = Sim::live("1.7");
        sim.gfx_f32(GFX_AC_CAR_COORDINATES, 100.5);
        sim.gfx_f32(GFX_AC_CAR_COORDINATES + 4, 12.25);
        sim.gfx_f32(GFX_AC_CAR_COORDINATES + 8, -300.75);
        sim.stat.write(STAT_AC_TRACK_SPLINE_LENGTH, &5793.0f32.to_le_bytes());
        sim.stat.write(STAT_AC_TRACK_CONFIGURATION, &utf16("gp"));
        let mut source = open_sim(&sim, processes(&["acs.exe"]));
        let f = source.next(SOON).expect("a frame");
        assert!(f.driving && !f.in_pits);
        assert_eq!((f.lap, f.lap_time_s, f.last_lap_s), (5, Some(63.25), Some(91.5)));
        assert_eq!(f.lap_valid, None, "Assetto Corsa gives no verdict");
        assert_eq!(f.dist_m, None, "the cutter integrates the speed");
        assert!(approx(f.speed_ms, 50.0), "180 km/h is 50 m/s, got {}", f.speed_ms);
        assert_eq!(
            (f.rpm, f.gear, f.throttle, f.brake, f.steer, f.fuel_l),
            (7200.0, 2.0, 0.75, 0.25, -0.25, 40.5)
        );
        assert!(f.clutch.is_nan(), "the clutch is not read");
        assert_eq!((f.x, f.y, f.z), (100.5, 12.25, -300.75));
        assert_eq!((f.car.as_str(), f.track.as_str()), ("ks_ferrari_f40", "monza"));
        assert_eq!((f.track_variant.as_deref(), f.track_length_m), (Some("gp"), Some(5793.0)));
        assert!(f.clock_s >= 0.0 && f.clock_s < 5.0);
    }

    #[test]
    fn a_reading_becomes_a_frame_with_exact_values_competizione() {
        let sim = Sim::live("1.8.12");
        sim.gfx_i32(GFX_ACC_ACTIVE_CARS, 3);
        for (i, id) in [101, 202, 303].into_iter().enumerate() {
            sim.gfx_i32(GFX_ACC_CAR_ID + 4 * i, id);
            for axis in 0..3 {
                sim.gfx_f32(GFX_ACC_CAR_COORDINATES + 12 * i + 4 * axis, (i * 1000 + axis) as f32);
            }
        }
        sim.gfx_i32(GFX_ACC_PLAYER_CAR_ID, 202);
        sim.gfx_i32(GFX_ACC_IS_VALID_LAP, 1);
        let mut source = open_sim(&sim, processes(&["AC2-Win64-Shipping.exe"]));
        let f = source.next(SOON).expect("a frame");
        assert_eq!(
            (f.lap, f.lap_time_s, f.last_lap_s, f.lap_valid),
            (5, Some(63.25), Some(91.5), Some(true))
        );
        assert_eq!((f.x, f.y, f.z), (1000.0, 1001.0, 1002.0), "the player's slot, not the first");
        assert_eq!((f.track_variant.clone(), f.track_length_m), (None, None), "not used in ACC");
        assert!(!f.in_pits);
        sim.gfx_i32(GFX_ACC_IS_VALID_LAP, 0);
        sim.gfx_i32(GFX_ACC_IS_IN_PIT_LANE, 1);
        let mut sim = sim;
        sim.step();
        let f = source.next(SOON).expect("a frame");
        assert_eq!((f.lap_valid, f.in_pits), (Some(false), true));
        // A player id that is not among the cars on track: no position, never somebody else's.
        sim.gfx_i32(GFX_ACC_PLAYER_CAR_ID, 999);
        sim.step();
        let f = source.next(SOON).expect("a frame");
        assert!(f.x.is_nan() && f.y.is_nan() && f.z.is_nan());
        // An absurd isValidLap says nothing.
        sim.gfx_i32(GFX_ACC_IS_VALID_LAP, 77);
        sim.step();
        assert_eq!(source.next(SOON).unwrap().lap_valid, None);
    }

    #[test]
    fn rally_reads_only_the_shared_prefix() {
        let mut sim = Sim::live("");
        // Bytes where Competizione keeps its extras (and Assetto Corsa its coordinates) mean nothing for Rally.
        sim.gfx_i32(GFX_ACC_ACTIVE_CARS, 1);
        sim.gfx_i32(GFX_ACC_CAR_ID, 5);
        sim.gfx_i32(GFX_ACC_PLAYER_CAR_ID, 5);
        sim.gfx_f32(GFX_ACC_CAR_COORDINATES, 42.0);
        sim.gfx_i32(GFX_ACC_IS_VALID_LAP, 0);
        sim.gfx_i32(GFX_ACC_IS_IN_PIT_LANE, 1);
        sim.stat.write(STAT_AC_TRACK_SPLINE_LENGTH, &5000.0f32.to_le_bytes());
        sim.stat.write(STAT_AC_TRACK_CONFIGURATION, &utf16("nope"));
        sim.step();
        let mut source = open_sim(&sim, processes(&["acr.exe"]));
        let f = source.next(SOON).expect("a frame");
        assert_eq!(source.game_id(), "acr");
        assert!(f.driving && !f.in_pits);
        assert_eq!((f.lap, f.lap_valid, f.track_variant, f.track_length_m), (5, None, None, None));
        assert!(f.x.is_nan() && f.y.is_nan() && f.z.is_nan());
        assert_eq!(
            (f.car.as_str(), f.track.as_str(), f.gear, f.rpm),
            ("ks_ferrari_f40", "monza", 2.0, 7200.0)
        );
    }

    #[test]
    fn anything_but_live_is_not_driving() {
        let mut sim = Sim::live("1.7");
        let mut source = open_sim(&sim, no_processes());
        for (status, driving) in [(STATUS_LIVE, true), (0, false), (1, false), (3, false), (-1, false), (7, false)] {
            sim.gfx_i32(GFX_STATUS, status);
            sim.step();
            let f = source.next(SOON).expect("a frame");
            assert_eq!(f.driving, driving, "status {status}");
            assert_eq!(f.lap, 5, "the lap is still known");
        }
    }

    #[test]
    fn gears_speeds_and_laps_are_converted() {
        let mut sim = Sim::live("1.7");
        let mut source = open_sim(&sim, no_processes());
        // AC: 0 = reverse, 1 = neutral, 2 = first.
        for (raw, gear) in [(0i32, -1.0), (1, 0.0), (2, 1.0), (7, 6.0)] {
            sim.phys.write(PHYS_GEAR, &raw.to_le_bytes());
            sim.step();
            assert_eq!(source.next(SOON).unwrap().gear, gear, "raw gear {raw}");
        }
        for (kmh, ms) in [(0.0f32, 0.0f32), (36.0, 10.0), (360.0, 100.0)] {
            sim.phys.write(PHYS_SPEED_KMH, &kmh.to_le_bytes());
            sim.step();
            assert!(approx(source.next(SOON).unwrap().speed_ms, ms), "{kmh} km/h");
        }
        // The lap is completed laps + 1; the last time is only a time when it is positive and plausible.
        for (completed, last, lap, official) in [
            (0, 0, 1, None),
            (0, i32::MAX, 1, None),
            (0, -5, 1, None),
            (1, 90_123, 2, Some(90.123)),
        ] {
            sim.gfx_i32(GFX_COMPLETED_LAPS, completed);
            sim.gfx_i32(GFX_I_LAST_TIME, last);
            sim.step();
            let f = source.next(SOON).unwrap();
            assert_eq!((f.lap, f.last_lap_s), (lap, official), "completed {completed}, last {last}");
        }
        // Pedals are held to 0..1.
        sim.phys.write(PHYS_GAS, &1.5f32.to_le_bytes());
        sim.phys.write(PHYS_BRAKE, &(-0.2f32).to_le_bytes());
        sim.step();
        let f = source.next(SOON).unwrap();
        assert_eq!((f.throttle, f.brake), (1.0, 0.0));
    }

    #[test]
    fn a_reading_that_did_not_change_is_not_handed_out_twice() {
        let mut sim = Sim::live("1.8.12");
        let mut source = open_sim(&sim, no_processes());
        assert!(source.next(SOON).is_some());
        let t0 = Instant::now();
        assert!(source.next(Duration::from_millis(40)).is_none(), "same packet ids");
        assert!(t0.elapsed() >= Duration::from_millis(30), "it waited for the timeout, not spun");
        // Either counter moving is a new reading.
        sim.packet += 1;
        sim.phys.write(PHYS_PACKET_ID, &sim.packet.to_le_bytes());
        assert!(source.next(SOON).is_some());
        sim.gfx_i32(GFX_PACKET_ID, 12_345);
        assert!(source.next(SOON).is_some());
        assert!(source.next(Duration::from_millis(20)).is_none());
    }

    #[test]
    fn a_garbled_memory_gives_no_panic_and_no_believable_numbers() {
        // All ones, then a pseudo-random fill, over every page.
        for pattern in 0..3u32 {
            let sim = Sim::new();
            let mut seed = 0x9e37_79b9u32;
            let mut fill = |mem: &FakeMemory, len: usize| {
                let bytes: Vec<u8> = (0..len)
                    .map(|_| {
                        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                        match pattern {
                            0 => 0xff,
                            1 => 0x00,
                            _ => (seed >> 24) as u8,
                        }
                    })
                    .collect();
                mem.write(0, &bytes);
            };
            fill(&sim.phys, 800);
            fill(&sim.gfx, 1588);
            fill(&sim.stat, 784);
            for exe in ["acs.exe", "AC2-Win64-Shipping.exe", "acr.exe"] {
                let exes: &'static [&'static str] = Box::leak(vec![exe].into_boxed_slice());
                let mut source = open_sim(&sim, processes(exes));
                let f = source.next(SOON).expect("a frame comes out of any bytes");
                // Whatever came out, it is a frame the cutter can take (it may only be that the car is not driving).
                if f.driving {
                    assert!(f.lap >= 1, "a lap number when driving");
                }
                for v in [f.speed_ms, f.rpm, f.gear, f.throttle, f.brake, f.steer, f.fuel_l, f.x, f.y, f.z] {
                    assert!(v.is_nan() || v.is_finite());
                }
                assert!((f.throttle.is_nan() || (0.0..=1.0).contains(&f.throttle)) && (f.steer.is_nan() || f.steer.abs() <= 1.0));
            }
        }
        // And a page the reader cannot copy (all of it is past the end) is a missing reading, not a panic.
        let g = Page(&[]);
        let f = frame_from(Family::Acc, &g, &g, &g, 1.0);
        assert!(!f.driving && f.lap_time_s == Some(0.0));
    }

    #[test]
    fn it_notices_the_game_leaving() {
        // The memories vanish with the game (nobody else holds them): after a few looks it says it is gone.
        let sim = Sim::live("1.7");
        let mut source = KunosSource::open_with(&sim.names, no_processes(), Duration::ZERO).unwrap();
        for _ in 0..5 {
            source.next(Duration::from_millis(1));
        }
        assert!(
            source.alive(),
            "opening the memories again while the game holds them changes nothing"
        );
        drop(sim);
        for _ in 0..3 {
            assert!(source.next(Duration::from_millis(1)).is_none());
        }
        assert!(!source.alive());

        // Or the program of the game is not in the list any more, although something still holds the memory.
        let sim = Sim::live("1.8.12");
        let list = Rc::new(RefCell::new(s(&["AC2-Win64-Shipping.exe"])));
        let seen = Rc::clone(&list);
        let mut source = KunosSource::open_with(&sim.names, Box::new(move || Some(seen.borrow().clone())), Duration::ZERO).unwrap();
        source.next(Duration::from_millis(1));
        assert!(source.alive());
        *list.borrow_mut() = s(&["explorer.exe"]);
        for _ in 0..3 {
            source.next(Duration::from_millis(1));
        }
        assert!(!source.alive());
    }

    // ---- laps -----------------------------------------------------------------------------------------------

    #[test]
    fn a_lap_flows_through_the_reader_into_the_cutter() {
        let mut sim = Sim::live("1.8.12");
        sim.gfx_i32(GFX_ACC_ACTIVE_CARS, 1);
        sim.gfx_i32(GFX_ACC_CAR_ID, 7);
        sim.gfx_i32(GFX_ACC_PLAYER_CAR_ID, 7);
        sim.gfx_i32(GFX_ACC_IS_VALID_LAP, 1);
        sim.gfx_i32(GFX_COMPLETED_LAPS, 0);
        // Competizione shows i32::MAX as the last lap time until there is one.
        sim.gfx_i32(GFX_I_LAST_TIME, i32::MAX);
        let mut source = open_sim(&sim, processes(&["AC2-Win64-Shipping.exe"]));
        let mut cutter = LapCutter::new(source.game_id());
        let mut laps = Vec::new();
        let mut feed =
            |source: &mut KunosSource, sim: &mut Sim, laps: &mut Vec<crate::lapfile::Lap>, completed: i32, last: i32, to_ms: i32| {
                sim.gfx_i32(GFX_COMPLETED_LAPS, completed);
                sim.gfx_i32(GFX_I_LAST_TIME, last);
                let mut ms = 0;
                while ms < to_ms {
                    sim.gfx_i32(GFX_I_CURRENT_TIME, ms);
                    sim.gfx_f32(GFX_ACC_CAR_COORDINATES, ms as f32 / 100.0);
                    sim.step();
                    let frame = source.next(SOON).expect("a frame for every new packet");
                    laps.extend(cutter.on_frame(&frame, 1_794_312_000_000 + i64::from(ms)));
                    ms += 10;
                }
            };
        // Lap 1: 30 s at 100 Hz, then lap 2 begins with the official time of lap 1.
        feed(&mut source, &mut sim, &mut laps, 0, i32::MAX, 30_000);
        assert!(laps.is_empty());
        feed(&mut source, &mut sim, &mut laps, 1, 30_000, 1_000);
        assert_eq!(laps.len(), 1);
        let lap = &laps[0];
        assert_eq!(
            (lap.game.as_str(), lap.lap_number, lap.time_ms, lap.valid),
            ("acc", 1, 30_000, true)
        );
        assert_eq!((lap.track_name.as_str(), lap.car_name.as_str()), ("monza", "ks_ferrari_f40"));
        assert_eq!(lap.sample_count(), 3000);
        let ids: Vec<&str> = lap.channels.iter().map(|c| c.id.as_str()).collect();
        for wanted in [
            "t", "dist", "speed", "rpm", "gear", "throttle", "brake", "steer", "x", "y", "z", "fuel",
        ] {
            assert!(ids.contains(&wanted), "{wanted} in {ids:?}");
        }
        assert!(!ids.contains(&"clutch"), "the clutch column is left out");
        assert!(crate::lapfile::gunzip(&crate::lapfile::gzip(lap).unwrap(), crate::lapfile::MAX_UNPACKED).is_ok());
    }

    #[test]
    fn a_lap_the_game_called_invalid_is_kept_but_not_valid() {
        let mut sim = Sim::live("1.8.12");
        sim.gfx_i32(GFX_COMPLETED_LAPS, 0);
        sim.gfx_i32(GFX_I_LAST_TIME, 0);
        sim.gfx_i32(GFX_ACC_IS_VALID_LAP, 1);
        let mut source = open_sim(&sim, no_processes());
        let mut cutter = LapCutter::new(source.game_id());
        let mut laps = Vec::new();
        for (completed, last, from, to) in [(0, 0, 0, 20_000), (1, 20_000, 0, 1_000)] {
            sim.gfx_i32(GFX_COMPLETED_LAPS, completed);
            sim.gfx_i32(GFX_I_LAST_TIME, last);
            for ms in (from..to).step_by(10) {
                sim.gfx_i32(GFX_I_CURRENT_TIME, ms);
                sim.gfx_i32(GFX_ACC_IS_VALID_LAP, i32::from(!(completed == 0 && ms > 8_000)));
                sim.step();
                laps.extend(cutter.on_frame(&source.next(SOON).unwrap(), 0));
            }
        }
        assert_eq!(laps.len(), 1);
        assert_eq!((laps[0].time_ms, laps[0].valid), (20_000, false));
    }
}
