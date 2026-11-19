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
//! * `phase` (and `driving`, which is `phase == Driving`): from graphics `status`. LIVE (2) is `Driving` (with a
//!   believable lap count; else `Unknown`), off (0) is `Menu`, replay (1) is `Replay`, pause (3) is `Paused`, any other
//!   number is `Unknown`. Not told apart: `Garage` (the pit box is a LIVE car with `in_pits`), `Loading`, and
//!   `Spectating` (the pages do not say whose car the camera follows). Outside `Driving` the gear, pedals, steering,
//!   speed and rpm are `NaN`: the pages hold zeros there, and a zero gear reads as reverse.
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
//! # What version 2 of the lap file takes from Assetto Corsa (`ac` only; Competizione and Rally give none of it)
//!
//! * `accG` (physics 44, 48, 52: sideways, up, along the car) becomes `g_lat` (x) and `g_long` (z). The sign is taken as
//!   the game writes it (x positive to the right, z positive forward, as the game's own axes are); not checked against
//!   a live game.
//! * `airTemp` and `roadTemp` (physics 288 and 292, Celsius) become the air and track temperature; both zero is what an
//!   unset page holds and says nothing. `brakeTemp[4]` (physics 348) fills the brake temperatures (Competizione's document has it at the same
//!   place: its fields sum to the same offset, so it is read there too).
//! * `session` (graphics 8: -1 unknown, 0 practice, 1 qualify, 2 race, 3 hotlap, 4 time attack, 5 drift, 6 drag) becomes
//!   the session kind (hotlap and time attack count as practice, drift and drag as unknown) and `tyreCompound`
//!   (graphics 176, 33 UTF-16 characters) the tyre compound.
//! * Sectors: `currentSectorIndex` (graphics 164) and `lastSectorTime` (graphics 168, milliseconds) are read only when
//!   the track has three sectors (`sectorCount`, static 400). The time at each change of sector gives the first two
//!   (`SectorTracker`); the cutter takes the third from the official lap time. A `lastSectorTime` that was the running
//!   total instead of the sector's own time would make the first two add up to nearly the lap, and the cutter drops
//!   sectors that do not leave a third.
//! * Not given: the weather (the page has none), the tread left (no documented unit), the tyres' pressure and core
//!   temperature are the ones read already.
//!
//! # Not checked against a live game
//!
//! `steerAngle` is documented as -1..1 and is passed through (clamped, and dropped when it is far outside that).
//! Competizione's `fuel` is documented in kilograms and is taken as litres, the way the game's own fuel gauge and
//! `maxFuel` read (and Assetto Corsa's `maxFuel` is the tank's capacity, in litres). The clutch pedal is not read: its polarity (1 = pressed or released) is not documented.

use std::time::{Duration, Instant};

use crate::game::{AidSettings, Caps, CarState, Drs, Flag, Frame, Phase, SectorTracker, SessionKind, Source, Tyre};
use crate::norm;
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
    /// `AC_STATUS`: 0 off, 1 replay, 2 live, 3 pause.
    pub const STATUS_OFF: i32 = 0;
    pub const STATUS_REPLAY: i32 = 1;
    pub const STATUS_LIVE: i32 = 2;
    pub const STATUS_PAUSE: i32 = 3;
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
    /// `float accG[3]`: the car's acceleration in g, sideways (x), up (y) and along the car (z).
    pub const PHYS_ACCEL_G: usize = 44;
    /// `float wheelsPressure[4]`, psi.
    pub const PHYS_WHEELS_PRESSURE: usize = 88;
    /// `float tyreCoreTemperature[4]`, °C.
    pub const PHYS_TYRE_CORE_TEMPERATURE: usize = 152;
    /// `float tyreTempI[4]`, `tyreTempM[4]` and `tyreTempO[4]`, °C: the tyre's inner, middle and outer tread (after
    /// `clutch`, in the part both Assetto Corsa's and Competizione's layouts reach).
    pub const PHYS_TYRE_TEMP_I: usize = 368;
    pub const PHYS_TYRE_TEMP_M: usize = 384;
    pub const PHYS_TYRE_TEMP_O: usize = 400;
    /// `float drs` (0 or 1: the wing is open) and `float tc` (above 0 while traction control acts).
    pub const PHYS_DRS: usize = 200;
    pub const PHYS_TC: usize = 204;
    /// `int pitLimiterOn` and `float abs` (above 0 while ABS acts).
    pub const PHYS_PIT_LIMITER_ON: usize = 248;
    pub const PHYS_ABS: usize = 252;
    /// The end of `abs`: the physics prefix shared by the three games.
    pub const PHYS_LEN: usize = 256;
    // Physics past the prefix, from the `sim_info.py` that Assetto Corsa ships for its Competizione-style app
    // (through `localVelocity`) and, past that, the Competizione header of the document named above.
    /// `int drsAvailable` and `int drsEnabled` (Assetto Corsa).
    pub const PHYS_DRS_AVAILABLE: usize = 340;
    pub const PHYS_DRS_ENABLED: usize = 344;
    /// `float airTemp` and `float roadTemp`, Celsius.
    pub const PHYS_AIR_TEMP: usize = 288;
    pub const PHYS_ROAD_TEMP: usize = 292;
    /// `float brakeTemp[4]`, Celsius, front left to rear right.
    pub const PHYS_BRAKE_TEMP: usize = 348;
    /// `float brakeBias`: the front share of the braking, 0..1.
    pub const PHYS_BRAKE_BIAS: usize = 564;
    /// `float autoShifterOn` (Assetto Corsa; after `kersCharge` and `kersInput`): the game shifts for the driver.
    pub const PHYS_AC_AUTO_SHIFTER_ON: usize = 264;
    /// What is copied of Assetto Corsa's physics page: through `brakeBias`.
    pub const PHYS_AC_LEN: usize = 564 + 4;
    /// Competizione's `int tcinAction`, `int absinAction`, and `float waterTemp` (Celsius).
    pub const PHYS_ACC_TC_IN_ACTION: usize = 672;
    pub const PHYS_ACC_ABS_IN_ACTION: usize = 676;
    pub const PHYS_ACC_WATER_TEMP: usize = 712;
    /// What is copied of Competizione's physics page: through `waterTemp`.
    pub const PHYS_ACC_LEN: usize = 712 + 4;

    // Graphics, shared prefix.
    pub const GFX_PACKET_ID: usize = 0;
    pub const GFX_STATUS: usize = 4;
    /// `int session`: -1 unknown, 0 practice, 1 qualify, 2 race, 3 hotlap, 4 time attack, 5 drift, 6 drag.
    pub const GFX_SESSION: usize = 8;
    pub const GFX_COMPLETED_LAPS: usize = 132;
    /// `int position`: the player's place, 1 is first.
    pub const GFX_POSITION: usize = 136;
    pub const GFX_I_CURRENT_TIME: usize = 140;
    pub const GFX_I_LAST_TIME: usize = 144;
    /// `float sessionTimeLeft`: milliseconds (ASSUMED: the header gives no unit; the tools that read it divide by 1000).
    pub const GFX_SESSION_TIME_LEFT: usize = 152;
    pub const GFX_IS_IN_PIT: usize = 160;
    /// `int currentSectorIndex` (0 is the first sector) and `int lastSectorTime` (milliseconds).
    pub const GFX_CURRENT_SECTOR_INDEX: usize = 164;
    pub const GFX_LAST_SECTOR_TIME: usize = 168;
    /// `int numberOfLaps`: the length of the session in laps (0 when it is timed).
    pub const GFX_NUMBER_OF_LAPS: usize = 172;
    /// `wchar_t tyreCompound[33]`.
    pub const GFX_TYRE_COMPOUND: usize = 176;
    /// Not read (see the module comment on distance); here for the layout test.
    #[cfg(test)]
    pub const GFX_NORMALIZED_POSITION: usize = 248;
    /// The end of `normalizedCarPosition`: the graphics prefix shared by the three games.
    pub const GFX_PREFIX_LEN: usize = 252;
    // Graphics, Assetto Corsa only.
    pub const GFX_AC_CAR_COORDINATES: usize = 252;
    /// `flag` of Assetto Corsa's newer `sim_info.py` (after `carCoordinates` and `penaltyTime`), and the end of it.
    pub const GFX_AC_FLAG: usize = 268;
    /// `int idealLineOn`, the field after `flag` in Assetto Corsa's struct. Competizione's document has a `penalty`
    /// between the two (so 276 there). Assetto Corsa's own `sim_info.py` (shipped with the game in
    /// `apps/python/actv_competizione`) has none, checked on the installed game on 2026-11-19. ASSUMED, not seen live.
    pub const GFX_AC_IDEAL_LINE_ON: usize = 272;
    pub const GFX_AC_LEN: usize = 272 + 4;
    // Graphics, Competizione only.
    pub const GFX_ACC_ACTIVE_CARS: usize = 252;
    pub const GFX_ACC_CAR_COORDINATES: usize = 256;
    pub const GFX_ACC_CAR_ID: usize = 976;
    pub const GFX_ACC_PLAYER_CAR_ID: usize = 1216;
    /// `flag` (the document's `ACC_FLAG_TYPE`), and the driver's settings `TC` and `ABS` (levels, 0 = off).
    pub const GFX_ACC_FLAG: usize = 1224;
    pub const GFX_ACC_IS_IN_PIT_LANE: usize = 1236;
    pub const GFX_ACC_TC: usize = 1268;
    pub const GFX_ACC_ABS: usize = 1280;
    pub const GFX_ACC_IS_VALID_LAP: usize = 1408;
    pub const GFX_ACC_LEN: usize = 1588;

    // Static, shared prefix (`wchar_t` arrays: 15 for the versions, 33 for the names).
    pub const STAT_SM_VERSION: usize = 0;
    pub const STAT_CAR_MODEL: usize = 68;
    pub const STAT_TRACK: usize = 134;
    /// `int sectorCount` (Assetto Corsa's static page, after the three driver names).
    pub const STAT_SECTOR_COUNT: usize = 400;
    /// `float maxFuel` (Assetto Corsa's static page, litres), after `sectorCount`, `maxTorque`, `maxPower` and `maxRpm`.
    pub const STAT_AC_MAX_FUEL: usize = 416;
    /// The end of `track`: all that is read of Competizione and Rally.
    pub const STAT_PREFIX_LEN: usize = 200;
    // Static, Assetto Corsa only.
    /// `int hasDRS` of `sim_info.py`.
    pub const STAT_AC_HAS_DRS: usize = 496;
    /// `float aidStability` (0..1), then `int aidAutoclutch` and `int aidAutoBlip` (0 or 1): the driver's settings of
    /// the session, after `allowTyreBlankets`.
    pub const STAT_AC_AID_STABILITY: usize = 484;
    pub const STAT_AC_AID_AUTO_CLUTCH: usize = 488;
    pub const STAT_AC_AID_AUTO_BLIP: usize = 492;
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

    /// What this game's pages can fill on a `Frame` (what `frame_from` reads for it, nothing more).
    fn caps(self) -> Caps {
        // The shared prefix: lap timing, the pedals, speed, rpm, gear, steering, fuel, the tyres' pressure and temperature, the pit lane flag, and the limiter and the TC / ABS floats.
        let shared = Caps::LAP_TIME
            .or(Caps::LAST_LAP)
            .or(Caps::IN_PITS)
            .or(Caps::SPEED)
            .or(Caps::RPM)
            .or(Caps::GEAR)
            .or(Caps::THROTTLE)
            .or(Caps::BRAKE)
            .or(Caps::STEER)
            .or(Caps::FUEL)
            .or(Caps::TYRE_TEMP)
            .or(Caps::TYRE_PRESSURE)
            .or(Caps::PIT_LIMITER)
            .or(Caps::TC_ACTIVE)
            .or(Caps::ABS_ACTIVE);
        // The race: the place, the time left and the laps of the session lie in the graphics prefix of Assetto Corsa and
        // Competizione (not read for Rally, whose page is not checked).
        let race = Caps::RACE_POSITION.or(Caps::SESSION_TIME_LEFT).or(Caps::SESSION_LAPS);
        match self {
            Family::Ac => shared
                .or(race)
                .or(Caps::POSITION)
                .or(Caps::TYRE_TREAD)
                .or(Caps::BRAKE_TEMP)
                .or(Caps::BRAKE_BIAS)
                .or(Caps::DRS)
                .or(Caps::FLAG)
                .or(Caps::FUEL_CAPACITY)
                .or(Caps::TRACK_LENGTH)
                .or(Caps::TRACK_VARIANT)
                .or(Caps::SECTORS)
                .or(Caps::SESSION_KIND)
                .or(Caps::AIR_TEMP)
                .or(Caps::TRACK_TEMP)
                .or(Caps::TYRE_COMPOUND)
                .or(Caps::G_LAT)
                .or(Caps::G_LONG),
            Family::Acc => shared
                .or(race)
                .or(Caps::CARS)
                .or(Caps::POSITION)
                .or(Caps::TYRE_TREAD)
                .or(Caps::BRAKE_TEMP)
                .or(Caps::LAP_VALID)
                .or(Caps::BRAKE_BIAS)
                .or(Caps::WATER_TEMP)
                .or(Caps::TC_LEVEL)
                .or(Caps::ABS_LEVEL)
                .or(Caps::FLAG),
            Family::Acr => shared,
        }
    }

    /// How much of the physics page is copied: the shared prefix, plus what the game's own header gives past it.
    fn physics_len(self) -> usize {
        match self {
            Family::Ac => PHYS_AC_LEN,
            Family::Acc => PHYS_ACC_LEN,
            Family::Acr => PHYS_LEN,
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
    physics >= family.physics_len() && graphics >= family.graphics_len() && statics >= family.static_len()
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
    /// The first two sectors of the lap being driven (Assetto Corsa).
    sectors: SectorTracker,
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
            sectors: SectorTracker::default(),
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
        let physics = pages.physics.read(0, self.family.physics_len())?;
        let graphics = pages.graphics.read(0, self.family.graphics_len())?;
        let statics = pages.statics.read(0, self.family.static_len())?;
        let (p, g, s) = (Page(&physics), Page(&graphics), Page(&statics));
        let ids = (p.i32_at(PHYS_PACKET_ID), g.i32_at(GFX_PACKET_ID));
        if self.last_ids == Some(ids) {
            return None;
        }
        self.last_ids = Some(ids);
        let mut frame = frame_from(self.family, &p, &g, &s, self.epoch.elapsed().as_secs_f64());
        if self.family == Family::Ac && frame.driving {
            if let Some((sector, last_ms)) = sector_reading(&g, &s) {
                frame.sectors_ms = self.sectors.update(frame.lap, sector, last_ms);
            }
        }
        Some(frame)
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

    fn caps(&self) -> Caps {
        self.family.caps()
    }
}

pub fn open() -> Option<Box<dyn Source>> {
    let source = KunosSource::open_with(&Names::game(), Box::new(running_processes), RECHECK)?;
    Some(Box::new(source))
}

/// The reader of a capture (`replay.rs`): the same reader, told by a process list that the game of the capture is the
/// one running (as it was while capturing), and never looking again (nothing runs in a replay).
pub(crate) fn open_replay(game_id: &str) -> Option<Box<dyn Source>> {
    let program = match game_id {
        "acc" => "ac2-win64-shipping.exe",
        "acr" => "acr.exe",
        _ => "acs.exe",
    };
    let running: ProcessList = Box::new(move || Some(vec![program.to_owned()]));
    let source = KunosSource::open_with(&Names::game(), running, Duration::from_secs(86_400))?;
    Some(Box::new(source))
}

/// Assetto Corsa's sector index and last sector time, for a track with three sectors (anything else gives none: the
/// third sector is worked out from the lap time, which needs exactly three).
fn sector_reading(g: &Page, s: &Page) -> Option<(i32, i32)> {
    (s.i32_at(STAT_SECTOR_COUNT) == 3).then(|| (g.i32_at(GFX_CURRENT_SECTOR_INDEX), g.i32_at(GFX_LAST_SECTOR_TIME)))
}

/// The kind of session of Assetto Corsa's `session`: hotlap and time attack are timed laps with no one else, which
/// is practice; drift and drag are not a kind this knows.
fn session_kind_of(session: i32) -> Option<SessionKind> {
    match session {
        0 | 3 | 4 => Some(SessionKind::Practice),
        1 => Some(SessionKind::Qualifying),
        2 => Some(SessionKind::Race),
        5 | 6 => Some(SessionKind::Unknown),
        _ => None,
    }
}

/// Competizione's coordinates of the player's own car: the slot of `carID` that is `playerCarID`.
fn acc_player_position(g: &Page) -> Option<[f32; 3]> {
    let active = usize::try_from(g.i32_at(GFX_ACC_ACTIVE_CARS)).ok()?.min(MAX_CARS);
    let me = g.i32_at(GFX_ACC_PLAYER_CAR_ID);
    let slot = (0..active).find(|&i| g.i32_at(GFX_ACC_CAR_ID + 4 * i) == me)?;
    let at = GFX_ACC_CAR_COORDINATES + 12 * slot;
    Some([g.f32_at(at), g.f32_at(at + 4), g.f32_at(at + 8)])
}

/// The flag of `ACC_FLAG_TYPE` (the same numbers in Assetto Corsa's `AC_FLAG_TYPE`, which stops at 6): 0 none, 1 blue,
/// 2 yellow, 3 black, 4 white, 5 chequered, 6 penalty (a black flag), 7 green (Competizione), 8 orange (Competizione,
/// a mechanical failure: shown as black).
fn flag_of(v: i32) -> Option<Flag> {
    const TABLE: [(i64, Flag); 8] = [
        (1, Flag::Blue),
        (2, Flag::Yellow),
        (3, Flag::Black),
        (4, Flag::White),
        (5, Flag::Chequered),
        (6, Flag::Black),
        (7, Flag::Green),
        (8, Flag::Black),
    ];
    norm::flag_code(i64::from(v), &TABLE)
}

/// The car's lights and settings that the pages give. Damage is left out: `carDamage` (Assetto Corsa) and
/// `suspensionDamage` (Competizione) have no documented unit, so nothing is normalised from them; neither game gives
/// oil temperature, headlights (Competizione's `lightsStage` is not documented), the handbrake or an engine warning.
/// Competizione's `EngineMap` is not given either: whether it counts from 0 or from 1 is not documented.
fn state_from(family: Family, p: &Page, g: &Page, s: &Page) -> CarState {
    let mut state = CarState::UNKNOWN;
    // The whole family: `pitLimiterOn` is an int flag.
    state.pit_limiter = match p.i32_at(PHYS_PIT_LIMITER_ON) {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    };
    // `tc` and `abs` are floats that rise while the aid acts.
    let acting = |at: usize| {
        let v = p.f32_at(at);
        v.is_finite().then_some(v > 0.0)
    };
    state.tc_active = acting(PHYS_TC);
    state.abs_active = acting(PHYS_ABS);
    let bias = p.f32_at(PHYS_BRAKE_BIAS);
    match family {
        Family::Ac => {
            state.brake_bias = (bias > 0.0 && bias < 1.0).then_some(bias);
            // The car has a wing only when the static page says so; then `drsEnabled` is open and
            // `drsAvailable` the zone's permission.
            if s.i32_at(STAT_AC_HAS_DRS) == 1 {
                state.drs = Some(if p.i32_at(PHYS_DRS_ENABLED) != 0 || p.f32_at(PHYS_DRS) > 0.5 {
                    Drs::Open
                } else if p.i32_at(PHYS_DRS_AVAILABLE) != 0 {
                    Drs::Available
                } else {
                    Drs::Off
                });
            }
            state.flag = flag_of(g.i32_at(GFX_AC_FLAG));
        }
        Family::Acc => {
            state.brake_bias = (bias > 0.0 && bias < 1.0).then_some(bias);
            // Competizione has its own "in action" flags, which the `tc` and `abs` floats do not carry.
            state.tc_active = Some(p.i32_at(PHYS_ACC_TC_IN_ACTION) != 0);
            state.abs_active = Some(p.i32_at(PHYS_ACC_ABS_IN_ACTION) != 0);
            let water = p.f32_at(PHYS_ACC_WATER_TEMP);
            state.water_c = Some(norm::water_c(water)).filter(|c| c.is_finite());
            let level = |at: usize| u8::try_from(g.i32_at(at)).ok().filter(|v| *v <= 30);
            state.tc_level = level(GFX_ACC_TC);
            state.abs_level = level(GFX_ACC_ABS);
            state.flag = flag_of(g.i32_at(GFX_ACC_FLAG));
        }
        // Rally: nothing past the shared prefix is known.
        Family::Acr => {}
    }
    state
}

/// The aids of Assetto Corsa (the original) for the lap file. A switch is given only when the page holds a 0 or a 1, and
/// the stability only inside 0..1: any other number is a page the game has not filled, not a setting.
///
/// `tc` and `abs` of the physics page are what the aid is doing right now (see `state_from`), so Assetto Corsa's TC and
/// ABS settings are not given here: a lap's `tcMax` and `absMax` stay out of its header until a capture settles it.
/// Every mapping here is ASSUMED (`game.rs` lists them).
fn ac_aids(p: &Page, g: &Page, s: &Page) -> AidSettings {
    // A page too short to hold the field reads as 0, which would say "off"; it must say "not given".
    let switch = |page: &Page, at: usize| match (page.0.len() >= at + 4).then(|| page.i32_at(at)) {
        Some(0) => Some(false),
        Some(1) => Some(true),
        _ => None,
    };
    let stability = (s.0.len() >= STAT_AC_AID_STABILITY + 4).then(|| s.f32_at(STAT_AC_AID_STABILITY));
    AidSettings {
        stability: stability.filter(|v| v.is_finite() && (0.0..=1.0).contains(v)),
        auto_shift: switch(p, PHYS_AC_AUTO_SHIFTER_ON),
        auto_clutch: switch(s, STAT_AC_AID_AUTO_CLUTCH),
        auto_blip: switch(s, STAT_AC_AID_AUTO_BLIP),
        ideal_line: switch(g, GFX_AC_IDEAL_LINE_ON),
        ..AidSettings::UNKNOWN
    }
}

/// One reading of the three pages as a `Frame`. Never panics: a short or garbled page gives `NaN`, `None` or "not
/// driving", not an error.
fn frame_from(family: Family, p: &Page, g: &Page, s: &Page, clock_s: f64) -> Frame {
    let mut f = Frame::empty();
    f.clock_s = clock_s;
    let completed = g.i32_at(GFX_COMPLETED_LAPS);
    let lap_known = (0..=MAX_LAPS).contains(&completed);
    f.set_phase(match g.i32_at(GFX_STATUS) {
        STATUS_LIVE if lap_known => Phase::Driving,
        STATUS_OFF => Phase::Menu,
        STATUS_REPLAY => Phase::Replay,
        STATUS_PAUSE => Phase::Paused,
        _ => Phase::Unknown,
    });
    f.lap = if lap_known { completed + 1 } else { 0 };
    f.lap_time_s = norm::seconds_ms(g.i32_at(GFX_I_CURRENT_TIME), true);
    f.last_lap_s = norm::seconds_ms(g.i32_at(GFX_I_LAST_TIME), false);
    f.in_pits = g.i32_at(GFX_IS_IN_PIT) != 0;
    if matches!(family, Family::Ac | Family::Acc) {
        // Only Competizione's page says how many cars are active.
        if family == Family::Acc {
            f.cars = norm::cars(g.i32_at(GFX_ACC_ACTIVE_CARS));
        }
        f.race_position = norm::place(g.i32_at(GFX_POSITION), f.cars);
        f.session_time_left_s = norm::time_left_s(f64::from(g.f32_at(GFX_SESSION_TIME_LEFT)) / 1000.0);
        f.session_laps = norm::race_laps(g.i32_at(GFX_NUMBER_OF_LAPS));
    }

    f.throttle = norm::pedal(p.f32_at(PHYS_GAS));
    f.brake = norm::pedal(p.f32_at(PHYS_BRAKE));
    f.speed_ms = (f64::from(norm::within(p.f32_at(PHYS_SPEED_KMH), -1500.0, 1500.0)) / 3.6) as f32;
    let rpm = p.i32_at(PHYS_RPMS);
    f.rpm = if (0..=30_000).contains(&rpm) { rpm as f32 } else { f32::NAN };
    // 0 = reverse, 1 = neutral, 2 = first.
    let gear = p.i32_at(PHYS_GEAR);
    f.gear = if (0..=15).contains(&gear) { norm::gear(gear - 1) } else { f32::NAN };
    // Documented as -1..1; a value far outside is not that (degrees, say) and is dropped, not pinned to the ends.
    f.steer = norm::steer(p.f32_at(PHYS_STEER));
    f.fuel_l = {
        let fuel = p.f32_at(PHYS_FUEL);
        if fuel.is_finite() && (0.0..=1000.0).contains(&fuel) {
            fuel
        } else {
            f32::NAN
        }
    };

    // Tyres, front left to rear right: pressure (psi in the page) and core temperature. The page's `tyreWear` has
    // no documented unit (and Competizione leaves it empty), so the tread left is not given.
    let has_tread = matches!(family, Family::Ac | Family::Acc);
    let tyres: [Tyre; 4] = std::array::from_fn(|i| {
        let at = |base: usize| p.f32_at(base + 4 * i);
        // The tread (the mean of the inner, middle and outer readings, as Assetto Corsa EVO's reader takes it) when all
        // three are believable, else the core. Both lie in the part of the page that Assetto Corsa's and
        // Competizione's layouts reach.
        let tread = if has_tread {
            norm::tread_c(at(PHYS_TYRE_TEMP_I), at(PHYS_TYRE_TEMP_M), at(PHYS_TYRE_TEMP_O))
        } else {
            f32::NAN
        };
        let core = norm::tyre_c(at(PHYS_TYRE_CORE_TEMPERATURE));
        Tyre {
            // `brakeTemp[4]` is in the part of the page that Assetto Corsa's and Competizione's layouts reach (Rally's
            // copy stops at `abs`).
            brake_c: if has_tread { norm::brake_c(at(PHYS_BRAKE_TEMP)) } else { f32::NAN },
            temp_c: if tread.is_finite() { tread } else { core },
            pressure_kpa: norm::pressure_kpa(at(PHYS_WHEELS_PRESSURE) * norm::KPA_PER_PSI),
            left: f32::NAN,
            tread_c: if has_tread {
                norm::tread_points(at(PHYS_TYRE_TEMP_I), at(PHYS_TYRE_TEMP_M), at(PHYS_TYRE_TEMP_O))
            } else {
                None
            },
        }
    });
    f.tyres = tyres.iter().any(Tyre::known).then_some(tyres);

    f.state = state_from(family, p, g, s);
    if family == Family::Ac {
        let accel = |at: usize| Some(p.f32_at(at)).filter(|g| g.is_finite() && g.abs() <= 12.0);
        f.g_lat = accel(PHYS_ACCEL_G);
        f.g_long = accel(PHYS_ACCEL_G + 8);
        // Both zero is what a page the game has not filled holds.
        let (air, road) = (p.f32_at(PHYS_AIR_TEMP), p.f32_at(PHYS_ROAD_TEMP));
        if !(air == 0.0 && road == 0.0) {
            f.air_temp_c = Some(air).filter(|c| c.is_finite() && (-60.0..=100.0).contains(c));
            f.track_temp_c = Some(road).filter(|c| c.is_finite() && (-60.0..=100.0).contains(c));
        }
        f.session_kind = session_kind_of(g.i32_at(GFX_SESSION));
        f.aids = ac_aids(p, g, s);
        f.tyre_compound = Some(g.utf16_at(GFX_TYRE_COMPOUND, 33)).filter(|c| !c.is_empty());
    }
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
        f.x = norm::position(x);
        f.y = norm::position(y);
        f.z = norm::position(z);
    }
    match family {
        Family::Ac => {
            let length = f64::from(s.f32_at(STAT_AC_TRACK_SPLINE_LENGTH));
            f.track_length_m = (length.is_finite() && (200.0..=100_000.0).contains(&length)).then_some(length);
            f.fuel_capacity_l = Some(s.f32_at(STAT_AC_MAX_FUEL)).filter(|c| c.is_finite() && (1.0..=1000.0).contains(c));
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
    // Outside a live session the page holds zeros (a zero gear reads as reverse): no car values.
    f.withhold_car_values_unless_driving();
    // Every frame the reader tests make is held to the caps and the phase invariant.
    #[cfg(test)]
    crate::game::assert_frame_within_caps(&f, family.caps(), "kunos");
    f
}

/// The executable names of the running processes (the shared list of `win.rs`: a read-only list, no process is
/// opened). `None` when Windows gave no list at all (a running system always has some), so a failed look is not
/// taken for "the game is gone".
fn running_processes() -> Option<Vec<String>> {
    let names = crate::win::running_programs();
    (!names.is_empty()).then_some(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::assert_frame_within_caps;
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

    /// What follows `abs` in the physics page: `sim_info.py` of `apps/python/actv_competizione` (through
    /// `localVelocity`) and Competizione's document (past it; the sum is the 800 bytes of its page).
    const PHYSICS_EXTRA: Fields = &[
        ("kersCharge", F, 1),
        ("kersInput", F, 1),
        ("autoShifterOn", F, 1),
        ("rideHeight", F, 2),
        ("turboBoost", F, 1),
        ("ballast", F, 1),
        ("airDensity", F, 1),
        ("airTemp", F, 1),
        ("roadTemp", F, 1),
        ("localAngularVel", F, 3),
        ("finalFF", F, 1),
        ("performanceMeter", F, 1),
        ("engineBrake", F, 1),
        ("ersRecoveryLevel", F, 1),
        ("ersPowerLevel", F, 1),
        ("ersHeatCharging", F, 1),
        ("ersIsCharging", F, 1),
        ("kersCurrentKJ", F, 1),
        ("drsAvailable", F, 1),
        ("drsEnabled", F, 1),
        ("brakeTemp", F, 4),
        ("clutch", F, 1),
        ("tyreTempI", F, 4),
        ("tyreTempM", F, 4),
        ("tyreTempO", F, 4),
        ("isAIControlled", F, 1),
        ("tyreContactPoint", F, 12),
        ("tyreContactNormal", F, 12),
        ("tyreContactHeading", F, 12),
        ("brakeBias", F, 1),
        ("localVelocity", F, 3),
        ("P2PActivations", F, 1),
        ("P2PStatus", F, 1),
        ("currentMaxRpm", F, 1),
        ("mz", F, 4),
        ("fx", F, 4),
        ("fy", F, 4),
        ("slipRatio", F, 4),
        ("slipAngle", F, 4),
        ("tcinAction", F, 1),
        ("absinAction", F, 1),
        ("suspensionDamage", F, 4),
        ("tyreTemp", F, 4),
        ("waterTemp", F, 1),
        ("brakePressure", F, 4),
        ("frontBrakeCompound", F, 1),
        ("rearBrakeCompound", F, 1),
        ("padLife", F, 4),
        ("discLife", F, 4),
        ("ignitionOn", F, 1),
        ("starterEngineOn", F, 1),
        ("isEngineRunning", F, 1),
        ("kerbVibration", F, 1),
        ("slipVibrations", F, 1),
        ("gVibrations", F, 1),
        ("absVibrations", F, 1),
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
        // From the newer `sim_info.py` Assetto Corsa ships (`apps/python/actv_competizione`).
        ("penaltyTime", F, 1),
        ("flag", F, 1),
        ("idealLineOn", F, 1),
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
            ("accG", PHYS_ACCEL_G),
            ("wheelsPressure", PHYS_WHEELS_PRESSURE),
            ("tyreCoreTemperature", PHYS_TYRE_CORE_TEMPERATURE),
        ] {
            assert_eq!(offset_of(PHYSICS, name), at, "{name}");
        }
        for (name, at) in [
            ("drs", PHYS_DRS),
            ("tc", PHYS_TC),
            ("pitLimiterOn", PHYS_PIT_LIMITER_ON),
            ("abs", PHYS_ABS),
        ] {
            assert_eq!(offset_of(PHYSICS, name), at, "{name}");
        }
        // Past the prefix the fields continue from where `abs` ends.
        let all: Vec<_> = PHYSICS.iter().chain(PHYSICS_EXTRA.iter()).copied().collect();
        let all: Fields = Box::leak(all.into_boxed_slice());
        assert_eq!(offsets(all).1, 800, "Competizione's physics page");
        for (name, at) in [
            ("airTemp", PHYS_AIR_TEMP),
            ("roadTemp", PHYS_ROAD_TEMP),
            ("brakeTemp", PHYS_BRAKE_TEMP),
            ("tyreTempI", PHYS_TYRE_TEMP_I),
            ("tyreTempM", PHYS_TYRE_TEMP_M),
            ("tyreTempO", PHYS_TYRE_TEMP_O),
            ("drsAvailable", PHYS_DRS_AVAILABLE),
            ("drsEnabled", PHYS_DRS_ENABLED),
            ("brakeBias", PHYS_BRAKE_BIAS),
            ("autoShifterOn", PHYS_AC_AUTO_SHIFTER_ON),
            ("tcinAction", PHYS_ACC_TC_IN_ACTION),
            ("absinAction", PHYS_ACC_ABS_IN_ACTION),
            ("waterTemp", PHYS_ACC_WATER_TEMP),
        ] {
            assert_eq!(offset_of(all, name), at, "{name}");
        }
        assert_eq!(PHYS_AC_LEN, PHYS_BRAKE_BIAS + 4);
        assert_eq!(PHYS_ACC_LEN, PHYS_ACC_WATER_TEMP + 4);
    }

    #[test]
    fn the_graphics_offsets_are_the_sum_of_the_field_sizes() {
        assert_eq!(offsets(GRAPHICS_AC).1, GFX_AC_LEN);
        assert_eq!(offsets(GRAPHICS_ACC).1, GFX_ACC_LEN, "1588 bytes, the size Competizione's page has");
        for (name, at) in [
            ("packetId", GFX_PACKET_ID),
            ("status", GFX_STATUS),
            ("session", GFX_SESSION),
            ("completedLaps", GFX_COMPLETED_LAPS),
            ("position", GFX_POSITION),
            ("iCurrentTime", GFX_I_CURRENT_TIME),
            ("iLastTime", GFX_I_LAST_TIME),
            ("sessionTimeLeft", GFX_SESSION_TIME_LEFT),
            ("isInPit", GFX_IS_IN_PIT),
            ("currentSectorIndex", GFX_CURRENT_SECTOR_INDEX),
            ("lastSectorTime", GFX_LAST_SECTOR_TIME),
            ("numberOfLaps", GFX_NUMBER_OF_LAPS),
            ("tyreCompound", GFX_TYRE_COMPOUND),
            ("normalizedCarPosition", GFX_NORMALIZED_POSITION),
        ] {
            assert_eq!(offset_of(GRAPHICS_AC, name), at, "AC {name}");
            assert_eq!(offset_of(GRAPHICS_ACC, name), at, "ACC {name}: the prefix is shared");
        }
        assert_eq!(offset_of(GRAPHICS_AC, "normalizedCarPosition") + 4, GFX_PREFIX_LEN);
        assert_eq!(offset_of(GRAPHICS_AC, "carCoordinates"), GFX_AC_CAR_COORDINATES);
        assert_eq!(offset_of(GRAPHICS_AC, "flag"), GFX_AC_FLAG);
        assert_eq!(offset_of(GRAPHICS_AC, "idealLineOn"), GFX_AC_IDEAL_LINE_ON);
        for (name, at) in [
            ("activeCars", GFX_ACC_ACTIVE_CARS),
            ("carCoordinates", GFX_ACC_CAR_COORDINATES),
            ("carID", GFX_ACC_CAR_ID),
            ("playerCarID", GFX_ACC_PLAYER_CAR_ID),
            ("flag", GFX_ACC_FLAG),
            ("TC", GFX_ACC_TC),
            ("ABS", GFX_ACC_ABS),
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
        assert_eq!(offset_of(STATIC, "sectorCount"), STAT_SECTOR_COUNT);
        assert_eq!(offset_of(STATIC, "maxFuel"), STAT_AC_MAX_FUEL);
        const { assert!(STAT_AC_MAX_FUEL + 4 <= STAT_AC_LEN) };
        const { assert!(STAT_SECTOR_COUNT + 4 <= STAT_AC_LEN) };
        assert_eq!(offset_of(STATIC, "hasDRS"), STAT_AC_HAS_DRS);
        for (name, at) in [
            ("aidStability", STAT_AC_AID_STABILITY),
            ("aidAutoclutch", STAT_AC_AID_AUTO_CLUTCH),
            ("aidAutoBlip", STAT_AC_AID_AUTO_BLIP),
        ] {
            assert_eq!(offset_of(STATIC, name), at, "{name}");
            const { assert!(STAT_AC_AID_AUTO_BLIP + 4 <= STAT_AC_LEN) };
        }
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
        assert!(
            !pages_fit(Family::Acc, 700, 1588, 784),
            "Competizione's physics are read through waterTemp"
        );
        assert!(pages_fit(Family::Ac, 568, 276, 556));
        assert!(
            !pages_fit(Family::Ac, 568, 272, 556),
            "Assetto Corsa's graphics are read through idealLineOn"
        );
        assert!(pages_fit(Family::Acr, 256, 252, 200));
        assert!(
            !pages_fit(Family::Acc, 800, 1000, 784),
            "Competizione's graphics page is 1588 bytes"
        );
        assert!(!pages_fit(Family::Ac, 255, 276, 556));
        assert!(
            !pages_fit(Family::Ac, 256, 276, 556),
            "Assetto Corsa's physics are read through brakeBias"
        );
        assert!(!pages_fit(Family::Ac, 568, 100, 556));
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
        // The car's state: limiter on, TC acting, ABS not, a wing the zone allows, a yellow flag, 62.5 % front brakes.
        sim.phys.write(PHYS_PIT_LIMITER_ON, &1i32.to_le_bytes());
        sim.phys.write(PHYS_TC, &0.5f32.to_le_bytes());
        sim.phys.write(PHYS_BRAKE_BIAS, &0.625f32.to_le_bytes());
        sim.phys.write(PHYS_DRS_AVAILABLE, &1i32.to_le_bytes());
        sim.stat.write(STAT_AC_HAS_DRS, &1i32.to_le_bytes());
        sim.stat.write(STAT_AC_MAX_FUEL, &80.0f32.to_le_bytes());
        sim.gfx_i32(GFX_AC_FLAG, 2);
        let mut source = open_sim(&sim, processes(&["acs.exe"]));
        let f = source.next(SOON).expect("a frame");
        assert_frame_within_caps(&f, source.caps(), "assetto corsa");
        assert_eq!(f.fuel_capacity_l, Some(80.0), "the static page's maxFuel");
        assert_eq!(
            f.state,
            CarState {
                pit_limiter: Some(true),
                abs_active: Some(false),
                tc_active: Some(true),
                drs: Some(Drs::Available),
                flag: Some(Flag::Yellow),
                brake_bias: Some(0.625),
                ..CarState::UNKNOWN
            }
        );
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
        // The car's state: TC acting, ABS not, water 88.5, TC level 5 and ABS level 3, a green flag, 56.25 % front.
        sim.phys.write(PHYS_ACC_TC_IN_ACTION, &1i32.to_le_bytes());
        sim.phys.write(PHYS_ACC_WATER_TEMP, &88.5f32.to_le_bytes());
        sim.phys.write(PHYS_BRAKE_BIAS, &0.5625f32.to_le_bytes());
        sim.gfx_i32(GFX_ACC_TC, 5);
        sim.gfx_i32(GFX_ACC_ABS, 3);
        sim.gfx_i32(GFX_ACC_FLAG, 7);
        let mut source = open_sim(&sim, processes(&["AC2-Win64-Shipping.exe"]));
        let f = source.next(SOON).expect("a frame");
        assert_eq!(
            f.state,
            CarState {
                pit_limiter: Some(false),
                abs_active: Some(false),
                tc_active: Some(true),
                flag: Some(Flag::Green),
                water_c: Some(88.5),
                tc_level: Some(5),
                abs_level: Some(3),
                brake_bias: Some(0.5625),
                ..CarState::UNKNOWN
            }
        );
        assert_frame_within_caps(&f, source.caps(), "competizione");
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
        // The same for the state: only the shared prefix (the limiter, the TC and ABS floats) counts.
        sim.phys.write(PHYS_BRAKE_BIAS, &0.6f32.to_le_bytes());
        sim.phys.write(PHYS_ACC_WATER_TEMP, &90.0f32.to_le_bytes());
        sim.phys.write(PHYS_PIT_LIMITER_ON, &1i32.to_le_bytes());
        sim.gfx_i32(GFX_ACC_FLAG, 2);
        sim.step();
        let mut source = open_sim(&sim, processes(&["acr.exe"]));
        let f = source.next(SOON).expect("a frame");
        assert_eq!(source.game_id(), "acr");
        assert_frame_within_caps(&f, source.caps(), "rally");
        assert!(f.driving && !f.in_pits);
        assert_eq!((f.lap, f.lap_valid, f.track_variant, f.track_length_m), (5, None, None, None));
        assert!(f.x.is_nan() && f.y.is_nan() && f.z.is_nan());
        assert_eq!(
            f.state,
            CarState {
                pit_limiter: Some(true),
                abs_active: Some(false),
                tc_active: Some(false),
                ..CarState::UNKNOWN
            }
        );
        assert_eq!(
            (f.car.as_str(), f.track.as_str(), f.gear, f.rpm),
            ("ks_ferrari_f40", "monza", 2.0, 7200.0)
        );
    }

    #[test]
    fn assetto_corsa_gives_the_g_the_temperatures_the_session_the_compound_and_the_brakes() {
        let sim = Sim::live("1.7");
        sim.phys.write(PHYS_ACCEL_G, &1.5f32.to_le_bytes());
        sim.phys.write(PHYS_ACCEL_G + 4, &1.0f32.to_le_bytes());
        sim.phys.write(PHYS_ACCEL_G + 8, &(-0.75f32).to_le_bytes());
        sim.phys.write(PHYS_AIR_TEMP, &21.5f32.to_le_bytes());
        sim.phys.write(PHYS_ROAD_TEMP, &33.0f32.to_le_bytes());
        for (i, c) in [310.0f32, 320.0, 250.0, 260.0].into_iter().enumerate() {
            sim.phys.write(PHYS_BRAKE_TEMP + 4 * i, &c.to_le_bytes());
        }
        sim.phys.write(PHYS_WHEELS_PRESSURE, &27.5f32.to_le_bytes());
        sim.gfx_i32(GFX_SESSION, 1);
        sim.gfx.write(GFX_TYRE_COMPOUND, &utf16("Soft (S)"));
        let mut source = open_sim(&sim, processes(&["acs.exe"]));
        let f = source.next(SOON).expect("a frame");
        // x is sideways, z along the car; the vertical G is not kept.
        assert_eq!((f.g_lat, f.g_long), (Some(1.5), Some(-0.75)));
        assert_eq!((f.air_temp_c, f.track_temp_c), (Some(21.5), Some(33.0)));
        assert_eq!(f.session_kind, Some(SessionKind::Qualifying));
        assert_eq!(f.tyre_compound.as_deref(), Some("Soft (S)"));
        assert_eq!(f.weather, None, "the pages have no weather");
        let tyres = f.tyres.expect("tyres");
        assert_eq!(tyres.map(|t| t.brake_c), [310.0, 320.0, 250.0, 260.0]);
        assert!(approx(tyres[0].pressure_kpa, 27.5 * 6.894_757));
        // The rest of the frame is what it was.
        assert_eq!((f.lap, f.sectors_ms), (5, [None, None]));
    }

    #[test]
    fn assetto_corsa_values_the_page_has_not_filled_are_not_given() {
        let sim = Sim::live("1.7");
        let mut source = open_sim(&sim, processes(&["acs.exe"]));
        let f = source.next(SOON).expect("a frame");
        assert_eq!((f.air_temp_c, f.track_temp_c), (None, None), "both zero: nothing set");
        assert_eq!(f.tyre_compound, None);
        assert_eq!(f.session_kind, Some(SessionKind::Practice), "session 0 is practice");
        assert!(f.tyres.is_none() || f.tyres.unwrap().iter().all(|t| t.brake_c.is_nan()));
        // A G that is not one (the page is garbled) is not given.
        let mut sim = sim;
        sim.phys.write(PHYS_ACCEL_G, &9999.0f32.to_le_bytes());
        sim.phys.write(PHYS_ACCEL_G + 8, &f32::NAN.to_le_bytes());
        sim.step();
        let f = source.next(SOON).expect("a frame");
        assert_eq!((f.g_lat, f.g_long), (None, None));
    }

    #[test]
    fn assetto_corsa_and_competizione_give_the_race_values_and_rally_none() {
        for (exe, version, cars) in [
            ("acs.exe", "1.7", None),
            ("AC2-Win64-Shipping.exe", "1.8.12", Some(20)),
            ("acr.exe", "", None),
        ] {
            let sim = Sim::live(version);
            sim.gfx_i32(GFX_POSITION, 4);
            sim.gfx_i32(GFX_NUMBER_OF_LAPS, 12);
            sim.gfx.write(GFX_SESSION_TIME_LEFT, &1_500_500.0f32.to_le_bytes());
            sim.gfx_i32(GFX_ACC_ACTIVE_CARS, 20);
            let exes: &'static [&'static str] = Box::leak(vec![exe].into_boxed_slice());
            let mut source = open_sim(&sim, processes(exes));
            let f = source.next(SOON).expect("a frame");
            if exe == "acr.exe" {
                assert_eq!(
                    (f.race_position, f.cars, f.session_time_left_s, f.session_laps),
                    (None, None, None, None),
                    "{exe}"
                );
                continue;
            }
            assert_eq!((f.race_position, f.class_position, f.cars), (Some(4), None, cars), "{exe}");
            assert_eq!((f.session_time_left_s, f.session_laps), (Some(1500.5), Some(12)), "{exe}");
            // Not given: no place yet, a time that is negative, a lap count that is garbage.
            sim.gfx_i32(GFX_POSITION, 0);
            sim.gfx.write(GFX_SESSION_TIME_LEFT, &(-1.0f32).to_le_bytes());
            sim.gfx_i32(GFX_NUMBER_OF_LAPS, 70_000);
            let mut sim = sim;
            sim.step();
            let f = source.next(SOON).expect("a frame");
            assert_eq!(
                (f.race_position, f.session_time_left_s, f.session_laps),
                (None, None, None),
                "{exe}"
            );
        }
    }

    #[test]
    fn the_session_numbers_map_to_the_kinds_of_session() {
        for (n, want) in [
            (-1, None),
            (0, Some(SessionKind::Practice)),
            (1, Some(SessionKind::Qualifying)),
            (2, Some(SessionKind::Race)),
            (3, Some(SessionKind::Practice)),
            (4, Some(SessionKind::Practice)),
            (5, Some(SessionKind::Unknown)),
            (6, Some(SessionKind::Unknown)),
            (7, None),
        ] {
            assert_eq!(session_kind_of(n), want, "session {n}");
        }
    }

    #[test]
    fn competizione_and_rally_give_none_of_what_version_2_asks_of_assetto_corsa() {
        for (exe, version) in [("AC2-Win64-Shipping.exe", "1.8.12"), ("acr.exe", "")] {
            let sim = Sim::live(version);
            sim.phys.write(PHYS_ACCEL_G, &1.5f32.to_le_bytes());
            sim.phys.write(PHYS_AIR_TEMP, &21.5f32.to_le_bytes());
            sim.phys.write(PHYS_BRAKE_TEMP, &310.0f32.to_le_bytes());
            sim.phys.write(PHYS_WHEELS_PRESSURE, &27.5f32.to_le_bytes());
            sim.gfx_i32(GFX_SESSION, 2);
            sim.gfx.write(GFX_TYRE_COMPOUND, &utf16("dry_compound"));
            sim.stat.write(STAT_SECTOR_COUNT, &3i32.to_le_bytes());
            let exes: &'static [&'static str] = Box::leak(vec![exe].into_boxed_slice());
            let mut source = open_sim(&sim, processes(exes));
            let f = source.next(SOON).expect("a frame");
            assert_eq!((f.g_lat, f.g_long), (None, None), "{exe}");
            assert_eq!(
                (f.air_temp_c, f.track_temp_c, f.session_kind, f.tyre_compound.clone()),
                (None, None, None, None),
                "{exe}"
            );
            assert_eq!(f.sectors_ms, [None, None], "{exe}");
            // Competizione's document has `brakeTemp` where Assetto Corsa's layout does (read there since the tyre and brake
            // temperatures were taken from both); Rally's copy stops before it.
            let brake = f.tyres.map(|t| t[0].brake_c);
            if exe == "acr.exe" {
                assert!(brake.is_none_or(f32::is_nan), "{exe}");
            } else {
                assert_eq!(brake, Some(310.0), "{exe}");
            }
        }
    }

    #[test]
    fn assetto_corsa_sector_times_are_kept_as_the_car_crosses_each_line() {
        let mut sim = Sim::live("1.7");
        sim.stat.write(STAT_SECTOR_COUNT, &3i32.to_le_bytes());
        let mut source = open_sim(&sim, processes(&["acs.exe"]));
        let mut next = |sim: &mut Sim, lap_done: i32, sector: i32, last_ms: i32| {
            sim.gfx_i32(GFX_COMPLETED_LAPS, lap_done);
            sim.gfx_i32(GFX_CURRENT_SECTOR_INDEX, sector);
            sim.gfx_i32(GFX_LAST_SECTOR_TIME, last_ms);
            sim.step();
            source.next(SOON).expect("a frame").sectors_ms
        };
        // Lap 5 is the lap after four completed. The first reading is not a change of sector.
        assert_eq!(next(&mut sim, 4, 0, 0), [None, None]);
        assert_eq!(next(&mut sim, 4, 1, 31_200), [Some(31_200), None]);
        assert_eq!(next(&mut sim, 4, 1, 31_200), [Some(31_200), None]);
        assert_eq!(next(&mut sim, 4, 2, 28_900), [Some(31_200), Some(28_900)]);
        // Lap 6: forgotten, and the wrap from the last sector records nothing.
        assert_eq!(next(&mut sim, 5, 0, 30_000), [None, None]);
        assert_eq!(next(&mut sim, 5, 1, 30_500), [Some(30_500), None]);
    }

    #[test]
    fn a_track_that_has_not_three_sectors_gives_none() {
        let mut sim = Sim::live("1.7");
        sim.stat.write(STAT_SECTOR_COUNT, &2i32.to_le_bytes());
        let mut source = open_sim(&sim, processes(&["acs.exe"]));
        assert_eq!(source.next(SOON).unwrap().sectors_ms, [None, None]);
        sim.gfx_i32(GFX_CURRENT_SECTOR_INDEX, 1);
        sim.gfx_i32(GFX_LAST_SECTOR_TIME, 40_000);
        sim.step();
        assert_eq!(source.next(SOON).unwrap().sectors_ms, [None, None]);
    }

    #[test]
    fn the_flag_numbers_map_to_the_flags() {
        for (n, want) in [
            (0, None),
            (1, Some(Flag::Blue)),
            (2, Some(Flag::Yellow)),
            (3, Some(Flag::Black)),
            (4, Some(Flag::White)),
            (5, Some(Flag::Chequered)),
            (6, Some(Flag::Black)),
            (7, Some(Flag::Green)),
            (8, Some(Flag::Black)),
            (9, None),
            (-1, None),
        ] {
            assert_eq!(flag_of(n), want, "flag {n}");
        }
    }

    #[test]
    fn the_tyre_temperature_is_the_tread_mean_with_the_core_standing_in_and_rally_has_only_the_core() {
        for (exe, version, tread) in [
            ("acs.exe", "1.7", true),
            ("AC2-Win64-Shipping.exe", "1.8.12", true),
            ("acr.exe", "", false),
        ] {
            let mut sim = Sim::live(version);
            let exes: &'static [&'static str] = Box::leak(vec![exe].into_boxed_slice());
            let mut source = open_sim(&sim, processes(exes));
            for i in 0..4 {
                sim.phys
                    .write(PHYS_TYRE_CORE_TEMPERATURE + 4 * i, &(60.0f32 + i as f32).to_le_bytes());
                sim.phys.write(PHYS_TYRE_TEMP_I + 4 * i, &(80.0f32 + i as f32).to_le_bytes());
                sim.phys.write(PHYS_TYRE_TEMP_M + 4 * i, &(84.0f32 + i as f32).to_le_bytes());
                sim.phys.write(PHYS_TYRE_TEMP_O + 4 * i, &(88.0f32 + i as f32).to_le_bytes());
            }
            sim.step();
            let temps = source.next(SOON).unwrap().tyres.unwrap().map(|t| t.temp_c);
            let want = if tread {
                [84.0, 85.0, 86.0, 87.0]
            } else {
                [60.0, 61.0, 62.0, 63.0]
            };
            assert_eq!(temps, want, "{exe}");
            // The three readings across the tread are given where the game has them, and only there.
            sim.step();
            let across = source.next(SOON).unwrap().tyres.unwrap().map(|t| t.tread_c);
            assert_eq!(across[0], tread.then_some([80.0, 84.0, 88.0]), "{exe}");
            if tread {
                // One of the three points missing: the core stands in for that tyre only.
                sim.phys.write(PHYS_TYRE_TEMP_M + 4, &0.0f32.to_le_bytes());
                sim.step();
                let temps = source.next(SOON).unwrap().tyres.unwrap().map(|t| t.temp_c);
                assert_eq!((temps[0], temps[1]), (84.0, 61.0), "{exe}");
            }
        }
    }

    #[test]
    fn the_process_list_is_the_shared_one_and_a_failed_look_is_none() {
        let names = running_processes().expect("a running system has processes");
        assert!(!names.is_empty());
        assert!(
            names.iter().all(|n| n == &n.to_ascii_lowercase()),
            "the shared list is in lower case"
        );
    }

    #[test]
    fn assetto_corsa_gives_the_aids_the_pages_hold() {
        let sim = Sim::live("1.7");
        sim.phys.write(PHYS_AC_AUTO_SHIFTER_ON, &1i32.to_le_bytes());
        sim.stat.write(STAT_AC_AID_STABILITY, &0.5f32.to_le_bytes());
        sim.stat.write(STAT_AC_AID_AUTO_CLUTCH, &1i32.to_le_bytes());
        sim.stat.write(STAT_AC_AID_AUTO_BLIP, &0i32.to_le_bytes());
        sim.gfx_i32(GFX_AC_IDEAL_LINE_ON, 1);
        let mut source = open_sim(&sim, processes(&["acs.exe"]));
        let f = source.next(SOON).expect("a frame");
        assert_eq!(
            f.aids,
            AidSettings {
                stability: Some(0.5),
                auto_shift: Some(true),
                auto_clutch: Some(true),
                auto_blip: Some(false),
                ideal_line: Some(true),
                ..AidSettings::UNKNOWN
            }
        );
        // The physics `tc` and `abs` floats stay "acting now": no setting comes from them, and no "car has none".
        assert_eq!(
            (f.state.tc_level, f.state.abs_level, f.aids.tc_absent, f.aids.abs_absent),
            (None, None, false, false)
        );
    }

    #[test]
    fn assetto_corsa_aids_that_are_not_a_switch_or_a_share_are_not_given() {
        let mut sim = Sim::live("1.7");
        for bad in [2i32, -1, 1_000_000] {
            sim.phys.write(PHYS_AC_AUTO_SHIFTER_ON, &bad.to_le_bytes());
            sim.stat.write(STAT_AC_AID_AUTO_CLUTCH, &bad.to_le_bytes());
            sim.stat.write(STAT_AC_AID_AUTO_BLIP, &bad.to_le_bytes());
            sim.gfx_i32(GFX_AC_IDEAL_LINE_ON, bad);
            sim.step();
            let mut source = open_sim(&sim, processes(&["acs.exe"]));
            let f = source.next(SOON).expect("a frame");
            assert_eq!(
                (f.aids.auto_shift, f.aids.auto_clutch, f.aids.auto_blip, f.aids.ideal_line),
                (None, None, None, None),
                "{bad}"
            );
        }
        for bad in [1.5f32, -0.1, f32::NAN, f32::INFINITY] {
            sim.stat.write(STAT_AC_AID_STABILITY, &bad.to_le_bytes());
            sim.step();
            let mut source = open_sim(&sim, processes(&["acs.exe"]));
            assert_eq!(source.next(SOON).expect("a frame").aids.stability, None, "{bad}");
        }
        // A page too short to hold a field says nothing, not "off".
        let short = Page(&[0u8; GFX_AC_IDEAL_LINE_ON + 2]);
        let physics = Page(&[0u8; PHYS_AC_AUTO_SHIFTER_ON + 2]);
        let statics = Page(&[0u8; STAT_AC_AID_STABILITY + 2]);
        assert_eq!(ac_aids(&physics, &short, &statics), AidSettings::UNKNOWN);
    }

    #[test]
    fn competizione_and_rally_give_no_other_aids() {
        for (exe, version) in [("AC2-Win64-Shipping.exe", "1.8.12"), ("acr.exe", "")] {
            let sim = Sim::live(version);
            // What Assetto Corsa would read from these offsets is not read for them.
            sim.gfx_i32(GFX_AC_IDEAL_LINE_ON, 1);
            sim.phys.write(PHYS_AC_AUTO_SHIFTER_ON, &1i32.to_le_bytes());
            let exes: &'static [&'static str] = Box::leak(vec![exe].into_boxed_slice());
            let mut source = open_sim(&sim, processes(exes));
            assert_eq!(source.next(SOON).expect("a frame").aids, AidSettings::UNKNOWN, "{exe}");
        }
    }

    #[test]
    fn assetto_corsa_gives_a_wing_only_when_the_car_has_one() {
        let sim = Sim::live("1.7");
        let mut source = open_sim(&sim, processes(&["acs.exe"]));
        assert_eq!(source.next(SOON).unwrap().state.drs, None, "no hasDRS");
        sim.stat.write(STAT_AC_HAS_DRS, &1i32.to_le_bytes());
        let mut sim = sim;
        sim.step();
        assert_eq!(source.next(SOON).unwrap().state.drs, Some(Drs::Off));
        sim.phys.write(PHYS_DRS_ENABLED, &1i32.to_le_bytes());
        sim.step();
        assert_eq!(source.next(SOON).unwrap().state.drs, Some(Drs::Open));
        // A bias past 1 is not one.
        sim.phys.write(PHYS_BRAKE_BIAS, &1.5f32.to_le_bytes());
        sim.step();
        assert_eq!(source.next(SOON).unwrap().state.brake_bias, None);
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
            assert_frame_within_caps(&f, source.caps(), "kunos");
        }
    }

    #[test]
    fn the_status_says_which_phase_and_a_game_that_is_not_live_gives_no_car_values() {
        let mut sim = Sim::live("1.7");
        let mut source = open_sim(&sim, no_processes());
        for (status, phase) in [
            (STATUS_LIVE, Phase::Driving),
            (STATUS_OFF, Phase::Menu),
            (STATUS_REPLAY, Phase::Replay),
            (STATUS_PAUSE, Phase::Paused),
            (-1, Phase::Unknown),
            (7, Phase::Unknown),
        ] {
            sim.gfx_i32(GFX_STATUS, status);
            // The page left behind: gear 0 (reverse), pedals and speed as they were.
            sim.phys.write(PHYS_GEAR, &0i32.to_le_bytes());
            sim.step();
            let f = source.next(SOON).expect("a frame");
            assert_eq!(f.phase, phase, "status {status}");
            let live = phase == Phase::Driving;
            if live {
                assert_eq!((f.gear, f.throttle, f.rpm), (-1.0, 0.75, 7200.0));
            } else {
                for v in [f.gear, f.throttle, f.brake, f.steer, f.speed_ms, f.rpm] {
                    assert!(v.is_nan(), "status {status}: car values are withheld");
                }
                assert!(f.fuel_l.is_finite() && f.lap_time_s.is_some(), "fuel and timing stay");
                assert_eq!((f.car.as_str(), f.track.as_str()), ("ks_ferrari_f40", "monza"));
            }
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

/// A made-up drive of Assetto Corsa, written as a capture (`capture.rs`) from the reader's own pages, for the tests of
/// `replay.rs`: a car going round a circle of 1000 m clockwise, lap after lap (the first in 25 s, each next one a second
/// slower: the cutter tells a new official lap time from the old one, so the laps must differ), with the steering as given.
#[cfg(test)]
pub(crate) mod capture_fixture {
    use super::*;
    use crate::capture::testing::{header, Shared};
    use crate::capture::{mem_stream, open_stream, Writer};

    const NAMES: (&str, &str, &str) = ("acpmf_physics", "acpmf_graphics", "acpmf_static");
    /// Readings in a lap; the milliseconds between two readings are `25 + lap` (about 40 Hz), counting laps from 0.
    const PER_LAP: u32 = 1000;

    /// The time of lap number `lap` (counting from 0), in milliseconds.
    pub(crate) fn lap_ms(lap: u32) -> u64 {
        PER_LAP as u64 * (25 + lap as u64)
    }

    fn put(page: &mut [u8], at: usize, bytes: &[u8]) {
        page[at..at + bytes.len()].copy_from_slice(bytes);
    }

    fn put_f32(page: &mut [u8], at: usize, v: f32) {
        put(page, at, &v.to_le_bytes());
    }

    fn put_i32(page: &mut [u8], at: usize, v: i32) {
        put(page, at, &v.to_le_bytes());
    }

    /// `laps` whole laps and the first ten readings of the next (which close the last of them); the steering is
    /// `steer` all the way (positive is a right turn, which is what the clockwise circle asks for).
    pub(crate) fn synthetic_capture(laps: u32, steer: f32) -> Vec<u8> {
        let family = Family::Ac;
        let mut physics = vec![0u8; family.physics_len()];
        let mut graphics = vec![0u8; family.graphics_len()];
        let mut statics = vec![0u8; family.static_len()];
        let utf16 = |text: &str| text.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>();
        put(&mut statics, STAT_SM_VERSION, &utf16("1.7"));
        put(&mut statics, STAT_CAR_MODEL, &utf16("ks_test_car"));
        put(&mut statics, STAT_TRACK, &utf16("test_circle"));
        put_f32(&mut statics, STAT_AC_TRACK_SPLINE_LENGTH, 1000.0);
        put_f32(&mut statics, STAT_AC_MAX_FUEL, 60.0);
        put_f32(&mut physics, PHYS_GAS, 0.8);
        put_f32(&mut physics, PHYS_FUEL, 40.0);
        put_i32(&mut physics, PHYS_GEAR, 5);
        put_i32(&mut physics, PHYS_RPMS, 6000);
        put_f32(&mut physics, PHYS_STEER, steer);
        put_i32(&mut graphics, GFX_STATUS, STATUS_LIVE);

        let sink = Shared::default();
        let mut w = Writer::new(sink.clone(), &header("ac", "kunos")).unwrap();
        for name in [NAMES.0, NAMES.1, NAMES.2] {
            w.record(0, &open_stream(name), &4096u64.to_le_bytes()).unwrap();
        }
        w.record(0, &mem_stream(NAMES.2, 0, STAT_PREFIX_LEN), &statics[..STAT_PREFIX_LEN])
            .unwrap();
        let radius = 1000.0 / std::f32::consts::TAU;
        for i in 0..(laps * PER_LAP + 10) {
            let (lap, within) = (i / PER_LAP, i % PER_LAP);
            let step = 25 + lap as u64;
            let speed_ms = 1000.0 / (lap_ms(lap) as f32 / 1000.0);
            put_f32(&mut physics, PHYS_SPEED_KMH, speed_ms * 3.6);
            let angle = std::f32::consts::TAU * within as f32 / PER_LAP as f32;
            put_i32(&mut physics, PHYS_PACKET_ID, i as i32 + 1);
            put_i32(&mut graphics, GFX_PACKET_ID, i as i32 + 1);
            put_i32(&mut graphics, GFX_COMPLETED_LAPS, lap as i32);
            put_i32(&mut graphics, GFX_I_CURRENT_TIME, (within as u64 * step) as i32);
            put_i32(&mut graphics, GFX_I_LAST_TIME, if lap > 0 { lap_ms(lap - 1) as i32 } else { 0 });
            put_f32(&mut graphics, GFX_AC_CAR_COORDINATES, radius * angle.sin());
            put_f32(&mut graphics, GFX_AC_CAR_COORDINATES + 8, radius * angle.cos());
            let t = (0..lap).map(lap_ms).sum::<u64>() + within as u64 * step;
            w.tick();
            w.record(t, &mem_stream(NAMES.0, 0, physics.len()), &physics).unwrap();
            w.record(t, &mem_stream(NAMES.1, 0, graphics.len()), &graphics).unwrap();
            w.record(t, &mem_stream(NAMES.2, 0, statics.len()), &statics).unwrap();
        }
        w.finish().unwrap();
        let bytes = sink.0.lock().unwrap().clone();
        bytes
    }
}
