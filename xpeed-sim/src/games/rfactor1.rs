//! rFactor 1 engine games (Stock Car Extreme, `GSC.exe`; Automobilista, `AMS.exe`; rFactor, `rFactor.exe`): the shared
//! memory of Dan Allongo's rFactorSharedMemoryMap plugin, version `3.0.0.0`.
//!
//! The plugin uses the ISI plugin interface every rFactor 1 engine game loads from its `Plugins` folder, so the same
//! memory and the same reading serve the three games; which one it is comes from the program running. Only Stock Car
//! Extreme was tried with the plugin; Automobilista and rFactor load plugins the same way (the folder and the build,
//! 32-bit, may differ per game: check the game's own `Plugins` folder and whether its executable is 32-bit).
//!
//! The game has no shared memory of its own. A plugin the person puts in the game's `Plugins` folder copies the ISI
//! plugin interface (telemetry of the player's car, and scoring of every car) into a named memory.
//!
//! # What the person installs (the app says this when the game is found and nothing is shared)
//!
//! 1. Get `rFactorSharedMemoryMap.dll` **built from the source of the plugin's master branch** (commit `afbac1d`, July
//!    2016, version string `3.0.0.0`): <https://github.com/dallongo/rFactorSharedMemoryMap>. The only prebuilt DLL on its
//!    Releases page (`2.0.0.0`, May 2016) is older than the version marker and has a different layout (no `version`
//!    field, 128 vehicles); this reader refuses it (and any other version) instead of reading numbers it cannot vouch
//!    for. The project is a Visual Studio 2015 project (`Win32\rFactorSharedMemoryMap.sln`); the game is 32-bit, so the
//!    DLL must be built for Win32.
//! 2. Copy the DLL into `...\Stock Car Extreme\Plugins` (for example
//!    `F:\SteamLibrary\steamapps\common\Stock Car Extreme\Plugins`).
//! 3. Start the game. rFactor 1 loads every DLL in `Plugins`; no setting is needed (the plugin has no settings file and
//!    no option in the game's menus). The memory exists from the moment the game starts and is filled while a session
//!    runs; in the main menu it is empty.
//!
//! # Sources (all read from the plugin's repository, `master` at `afbac1d37d96c7f673c120290e7b487356ecef05`)
//!
//! * Layout: <https://raw.githubusercontent.com/dallongo/rFactorSharedMemoryMap/master/Include/rfSharedStruct.hpp>
//!   (`rfShared`, `rfVehicleInfo`, `rfWheel`, the memory name `$rFactorShared$`, the version `3.0.0.0`).
//! * Behaviour: <https://raw.githubusercontent.com/dallongo/rFactorSharedMemoryMap/master/Source/rFactorSharedMemoryMap.cpp>
//!   (what is written, when, and how the scoring part is interpolated).
//! * The header sets `#pragma pack(push, 1)`: no padding at all, so every offset is the sum of the sizes before it
//!   (`long` is 4 bytes with MSVC, `bool` and `char` are 1, `short` 2, `float` 4). The test
//!   `the_offsets_follow_from_the_sizes_in_the_header` adds the sizes up field by field and proves them; the total,
//!   `sizeof(rfShared)`, is 11367 bytes (the plugin creates the mapping with exactly that size).
//!
//! # What the memory is, and what follows from it
//!
//! * **No consistency protocol.** There is no sequence number, lock or update counter: the plugin writes the struct
//!   field by field from the game's own threads (telemetry about every physics frame, scoring twice a second). A copy
//!   can therefore be torn. The reader copies the struct twice, a few microseconds apart, and uses the copy only when
//!   both are byte-for-byte the same (a write in between, or half a write at the time of the first copy, makes them
//!   differ and the copy is tried again; after a few failures that frame is given up). This cannot prove a copy is not
//!   torn if the game's thread is stopped by the system in the middle of its writes, which is why every field is also
//!   range-checked, and why this is not the same guarantee as the sequence number of other games.
//! * The version marker is the first 8 bytes: `"3.0.0.0"` and a zero. `open` refuses a memory that does not have it
//!   (or is shorter than the struct), and a copy without it (the plugin clears the memory at the start and the end of
//!   every session and writes the marker again right after) gives no frame.
//! * Telemetry (`localVel`, `engineRPM`, `gear`, `unfiltered*`, `pos`, `fuel`, `lapNumber`, `lapStartET`, `trackName`)
//!   is the player's own car and is written only while the player is in the car (`inRealtime`). The scoring part
//!   (`currentET`, `gamePhase`, `numVehicles`, `lapDist`, the `vehicle[]` array) arrives twice a second; the plugin
//!   interpolates `currentET` and each car's `lapDist` between those updates.
//! * The player's scoring entry is the one with `isPlayer` set. From it: `lastLapTime` (-1 while there is no
//!   completed lap), `lapDist` (the distance around the track, which the lap file calls `dist`), `inPits` and
//!   `vehicleClass`. The header exports no vehicle name: the class string stands for the car.
//! * The top-level `lapDist` is the track length in metres (the ISI `ScoringInfo.mLapDist` is the distance around the
//!   track), not the player's position on it.
//!
//! # Units and conversions
//!
//! Speed is the length of `localVel` (metres per second); `gear` is -1 reverse, 0 neutral, 1.. forward; the pedals
//! are the `unfiltered*` values (0..1) and the wheel `unfilteredSteering` (-1..1, left to right); `fuel` is litres;
//! time on the lap is `currentET - lapStartET` (seconds on the session clock the game keeps); the world position is
//! `pos` (metres, left-handed, +y up) as the game gives it.
//!
//! `lap` is `lapNumber` as the game counts it, taken straight from the telemetry so that it changes at the very
//! moment `lapStartET` does. The header does not say whether the first lap is 0 or 1; the lap cutter only needs the
//! number to go up by one at each completed lap.
//!
//! `driving` is true only when the plugin says the player is in realtime (`inRealtime`, the car, not the monitor or
//! the garage screen), the car is under the local player's control (`control == 0`), and the session is in a phase
//! where a lap counts (`gamePhase`: warm-up, green flag, full-course yellow, stopped, over: not the garage, the grid
//! walk, the formation lap or the countdown).
//!
//! Never read: another process's memory. Only the plugin's own shared memory, read-only and copied out.

use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::game::{CarState, Frame, Source};
use crate::shm::{Mapping, Page};

/// The name the plugin gives its memory (`RF_SHARED_MEMORY_NAME`).
const MEMORY_NAME: &str = "$rFactorShared$";
/// `RF_SHARED_MEMORY_VERSION` as it sits in `char version[8]`: the text and its zero.
const VERSION: &[u8; 8] = b"3.0.0.0\0";
/// `sizeof(rfShared)` with `#pragma pack(1)`.
const SIZE: usize = 11_367;
/// `RF_SHARED_MEMORY_MAX_VSI_SIZE`.
const VEHICLES_MAX: i32 = 64;
/// `sizeof(rfVehicleInfo)`.
const VEHICLE_SIZE: usize = 168;

/// Byte offsets of the fields read, from the start of the memory.
mod at {
    pub const VERSION: usize = 0;
    pub const LAP_NUMBER: usize = 12;
    pub const LAP_START_ET: usize = 16;
    pub const TRACK_NAME: usize = 20;
    pub const POS: usize = 84;
    pub const LOCAL_VEL: usize = 96;
    pub const GEAR: usize = 184;
    pub const ENGINE_RPM: usize = 188;
    pub const UNFILTERED_THROTTLE: usize = 204;
    pub const UNFILTERED_BRAKE: usize = 208;
    pub const UNFILTERED_STEERING: usize = 212;
    pub const UNFILTERED_CLUTCH: usize = 216;
    /// `float engineWaterTemp` and `float engineOilTemp`, Celsius.
    pub const ENGINE_WATER_TEMP: usize = 192;
    pub const ENGINE_OIL_TEMP: usize = 196;
    pub const FUEL: usize = 224;
    /// `bool overheating` (the overheating icon is shown) and `unsigned char dentSeverity[8]`: dents at eight places
    /// around the car, 0 none, 1 some, 2 more.
    pub const OVERHEATING: usize = 233;
    pub const DENT_SEVERITY: usize = 235;
    pub const CURRENT_ET: usize = 535;
    pub const LAP_DIST: usize = 547;
    pub const NUM_VEHICLES: usize = 551;
    pub const GAME_PHASE: usize = 555;
    pub const IN_REALTIME: usize = 562;
    pub const VEHICLES: usize = 615;
    /// Inside an `rfVehicleInfo`.
    pub const V_LAP_DIST: usize = 36;
    pub const V_LAST_LAP_TIME: usize = 68;
    pub const V_IS_PLAYER: usize = 84;
    pub const V_CONTROL: usize = 85;
    pub const V_IN_PITS: usize = 86;
    pub const V_VEHICLE_CLASS: usize = 88;
}

const TRACK_NAME_LENGTH: usize = 64;
const CLASS_NAME_LENGTH: usize = 32;

// `rfGamePhase`: only the ones that decide anything are named; `PHASE_MAX` is the last value the header has.
const PHASE_WARM_UP: u8 = 1;
const PHASE_GREEN_FLAG: u8 = 5;
const PHASE_MAX: u8 = 8;
/// `rfControl::player`.
const CONTROL_PLAYER: i8 = 0;

/// A copy is tried this many times before that frame is given up.
const ATTEMPTS: usize = 4;
/// The two copies of one reading are taken this far apart, longer than the plugin takes to write the struct.
const SETTLE: Duration = Duration::from_micros(60);
/// About 100 Hz.
const POLL: Duration = Duration::from_millis(10);
/// A memory that has not changed for this long: nothing is running in the game (the main menu, or it is gone). The
/// scoring part alone moves twice a second while any session is loaded.
const STALE: Duration = Duration::from_secs(30);

/// The games of this engine Xpeed Sim knows: the program, then the game's id and name. Stock Car Extreme keeps the id
/// `rfactor1` its laps were always written with.
const GAMES: [(&str, &str, &str); 3] = [
    ("gsc.exe", "rfactor1", "Stock Car Extreme"),
    ("ams.exe", "ams1", "Automobilista"),
    ("rfactor.exe", "rf1", "rFactor"),
];

pub fn open() -> Option<Box<dyn Source>> {
    let running = crate::win::running_programs();
    let (_, id, name) = GAMES
        .into_iter()
        .find(|(program, _, _)| crate::win::any_running(&running, &[program]))
        .unwrap_or(GAMES[0]);
    RFactor1::open_named(MEMORY_NAME).map(|mut reader| {
        reader.game = (id, name);
        Box::new(reader) as Box<dyn Source>
    })
}

struct RFactor1 {
    /// The game's id and name, from the program running.
    game: (&'static str, &'static str),
    memory: Mapping,
    started: Instant,
    /// The bytes of the last copy used, to skip a poll that finds the same thing.
    last_used: Option<Vec<u8>>,
    last_change: Instant,
    stale_after: Duration,
    /// The pause between the two copies (nothing in tests).
    settle: Duration,
}

/// The first 8 bytes are the version marker the header describes.
fn has_version(head: &[u8]) -> bool {
    head.get(..VERSION.len()) == Some(&VERSION[..])
}

impl RFactor1 {
    /// `None` when there is no such memory, it is shorter than the struct, or its version marker is not `3.0.0.0`.
    fn open_named(name: &str) -> Option<RFactor1> {
        let memory = Mapping::open(name)?;
        if memory.len() < SIZE {
            return None;
        }
        if !has_version(&memory.read(at::VERSION, VERSION.len())?) {
            return None;
        }
        let now = Instant::now();
        Some(RFactor1 {
            game: (GAMES[0].1, GAMES[0].2),
            memory,
            started: now,
            last_used: None,
            last_change: now,
            stale_after: STALE,
            settle: SETTLE,
        })
    }

    /// One try at a new reading: `None` when nothing is new or no stable copy could be had.
    fn try_read(&mut self) -> Option<Frame> {
        let memory = &self.memory;
        let settle = self.settle;
        let copy = stable_copy(
            || memory.read(0, SIZE),
            || {
                if !settle.is_zero() {
                    spin(settle)
                }
            },
        )?;
        if self.last_used.as_deref() == Some(&copy[..]) {
            return None;
        }
        self.last_change = Instant::now();
        let frame = frame_from(&copy, self.started.elapsed().as_secs_f64());
        self.last_used = Some(copy);
        frame
    }
}

/// Waits `d` without giving the processor away (a sleep is a whole timer tick on Windows, far longer than a struct
/// takes to write).
fn spin(d: Duration) {
    let until = Instant::now() + d;
    while Instant::now() < until {
        std::hint::spin_loop();
    }
}

/// Two copies, `gap` apart, that are the same: nothing was written between them. A copy that differs from its
/// successor is thrown away and the pair is tried again, up to `ATTEMPTS` times.
fn stable_copy(mut read: impl FnMut() -> Option<Vec<u8>>, mut gap: impl FnMut()) -> Option<Vec<u8>> {
    for _ in 0..ATTEMPTS {
        let first = read()?;
        gap();
        let second = read()?;
        if first == second {
            return Some(first);
        }
    }
    None
}

impl Source for RFactor1 {
    fn game_id(&self) -> &'static str {
        self.game.0
    }

    fn game_name(&self) -> &'static str {
        self.game.1
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

    fn alive(&self) -> bool {
        self.last_change.elapsed() < self.stale_after
    }
}

/// A float the game gave, inside `lo..=hi`; anything else (NaN, infinite, absurd) is "not given".
fn within(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_finite() && (lo..=hi).contains(&v) {
        v
    } else {
        f32::NAN
    }
}

/// A float that should be in `lo..=hi` and is pulled into it (pedals); NaN stays "not given".
fn clamped(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        f32::NAN
    }
}

/// The time on the lap: the session clock now minus the clock when the lap began. The two come from different
/// updates (the clock is interpolated between scoring updates), so a lap that has only just begun can read a little
/// below zero; that is zero. Anything further off is not given.
fn lap_time(current_et: f32, lap_start_et: f32) -> Option<f64> {
    if !current_et.is_finite() || !lap_start_et.is_finite() {
        return None;
    }
    let t = f64::from(current_et) - f64::from(lap_start_et);
    (-1.0..=86_400.0).contains(&t).then(|| t.max(0.0))
}

/// The slot of the player's car in the scoring array: the first car the plugin marks `isPlayer`.
fn player_slot(page: &Page, count: usize) -> Option<usize> {
    (0..count).find(|slot| page.u8_at(at::VEHICLES + slot * VEHICLE_SIZE + at::V_IS_PLAYER) == 1)
}

/// Turns one stable copy of the memory into a frame. `None` for a copy this reader cannot vouch for (too short, not
/// version `3.0.0.0`, a phase or a count the header does not have, a lap number that cannot be real).
fn frame_from(bytes: &[u8], clock_s: f64) -> Option<Frame> {
    if bytes.len() < SIZE || !has_version(bytes) {
        return None;
    }
    let page = Page(bytes);
    let phase = page.u8_at(at::GAME_PHASE);
    let vehicles = page.i32_at(at::NUM_VEHICLES);
    let lap = page.i32_at(at::LAP_NUMBER);
    if phase > PHASE_MAX || !(0..=VEHICLES_MAX).contains(&vehicles) || !(0..=100_000).contains(&lap) {
        return None;
    }
    let mut frame = Frame::empty();
    frame.clock_s = clock_s;
    // Without the player's scoring entry (the session is just starting, the scoring has not come yet) the frame says
    // nothing about a car.
    let Some(slot) = player_slot(&page, vehicles as usize) else {
        return Some(frame);
    };
    let me = at::VEHICLES + slot * VEHICLE_SIZE;

    let in_realtime = page.u8_at(at::IN_REALTIME) == 1;
    let control = page.u8_at(me + at::V_CONTROL) as i8;
    let lap_counts = phase == PHASE_WARM_UP || phase >= PHASE_GREEN_FLAG;
    frame.driving = in_realtime && control == CONTROL_PLAYER && lap_counts;
    frame.lap = lap;
    frame.lap_time_s = lap_time(page.f32_at(at::CURRENT_ET), page.f32_at(at::LAP_START_ET));
    // -1 while the player has not completed a lap.
    frame.last_lap_s = {
        let t = page.f32_at(me + at::V_LAST_LAP_TIME);
        (t.is_finite() && t > 0.0 && t <= 86_400.0).then(|| f64::from(t))
    };
    frame.dist_m = {
        // The plugin interpolates this between scoring updates, which can put it a hair below zero just after the line.
        let d = within(page.f32_at(me + at::V_LAP_DIST), -1000.0, 1_000_000.0);
        d.is_finite().then(|| f64::from(d.max(0.0)))
    };
    frame.in_pits = page.u8_at(me + at::V_IN_PITS) == 1;

    let velocity = [0, 4, 8].map(|i| f64::from(within(page.f32_at(at::LOCAL_VEL + i), -1000.0, 1000.0)));
    frame.speed_ms = if velocity.iter().all(|v| v.is_finite()) {
        velocity.iter().map(|v| v * v).sum::<f64>().sqrt() as f32
    } else {
        f32::NAN
    };
    frame.rpm = within(page.f32_at(at::ENGINE_RPM), 0.0, 100_000.0);
    let gear = page.i32_at(at::GEAR);
    frame.gear = if (-1..=30).contains(&gear) { gear as f32 } else { f32::NAN };
    // What the driver does with the pedals and the wheel, before any filtering the game applies.
    frame.throttle = clamped(page.f32_at(at::UNFILTERED_THROTTLE), 0.0, 1.0);
    frame.brake = clamped(page.f32_at(at::UNFILTERED_BRAKE), 0.0, 1.0);
    frame.clutch = clamped(page.f32_at(at::UNFILTERED_CLUTCH), 0.0, 1.0);
    frame.steer = clamped(page.f32_at(at::UNFILTERED_STEERING), -1.0, 1.0);
    frame.x = within(page.f32_at(at::POS), -1.0e7, 1.0e7);
    frame.y = within(page.f32_at(at::POS + 4), -1.0e7, 1.0e7);
    frame.z = within(page.f32_at(at::POS + 8), -1.0e7, 1.0e7);
    frame.fuel_l = within(page.f32_at(at::FUEL), 0.0, 10_000.0);
    frame.state = state_from(&page);
    // The header has no vehicle name: the class of the player's car is the only description of it.
    frame.car = page.ascii_at(me + at::V_VEHICLE_CLASS, CLASS_NAME_LENGTH);
    frame.track = page.ascii_at(at::TRACK_NAME, TRACK_NAME_LENGTH);
    let length = within(page.f32_at(at::LAP_DIST), 0.0, 1_000_000.0);
    frame.track_length_m = (length > 0.0).then(|| f64::from(length));
    Some(frame)
}

/// The overheating light, the temperatures and the dents. The plugin exports no lights, flags, aids, brake bias or
/// engine and gearbox damage, so those are not given.
fn state_from(page: &Page) -> CarState {
    let temp = |at: usize| {
        let c = page.f32_at(at);
        (c.is_finite() && c > 0.0 && c <= 400.0).then_some(c)
    };
    // Eight dents, each 0 none, 1 some, 2 more (more than 2 is not one): the sum over the worst case, all at 2.
    let dents: u32 = (0..8).map(|i| u32::from(page.u8_at(at::DENT_SEVERITY + i).min(2))).sum();
    CarState {
        engine_warning: match page.u8_at(at::OVERHEATING) {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        },
        water_c: temp(at::ENGINE_WATER_TEMP),
        oil_c: temp(at::ENGINE_OIL_TEMP),
        damage_body: Some(dents as f32 / 16.0),
        ..CarState::UNKNOWN
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lapcut::LapCutter;
    use crate::shm::FakeMemory;

    /// The whole struct as bytes, built by the test with the offsets the reader uses.
    struct Image(Vec<u8>);

    /// The player's slot in the test image (other cars come before and after it).
    const PLAYER: usize = 1;

    impl Image {
        fn new() -> Image {
            let mut image = Image(vec![0; SIZE]);
            image.0[..8].copy_from_slice(VERSION);
            image
        }
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
        fn vehicle(slot: usize) -> usize {
            at::VEHICLES + slot * VEHICLE_SIZE
        }
        /// A representative moment on track, with values that are exact in `f32`.
        fn on_track() -> Image {
            let mut i = Image::new();
            i.i32(at::NUM_VEHICLES, 3);
            i.0[at::GAME_PHASE] = PHASE_GREEN_FLAG;
            i.0[at::IN_REALTIME] = 1;
            i.i32(at::LAP_NUMBER, 4);
            i.f32(at::LAP_START_ET, 1000.5);
            i.f32(at::CURRENT_ET, 1063.75);
            i.text(at::TRACK_NAME, TRACK_NAME_LENGTH, "Interlagos");
            i.f32(at::POS, 100.5);
            i.f32(at::POS + 4, 2.25);
            i.f32(at::POS + 8, -300.75);
            // 3-4-12 is a 13 metres per second vector. The game's +z points out the back, so forward is negative.
            i.f32(at::LOCAL_VEL, 3.0);
            i.f32(at::LOCAL_VEL + 4, 4.0);
            i.f32(at::LOCAL_VEL + 8, -12.0);
            i.i32(at::GEAR, 4);
            i.f32(at::ENGINE_RPM, 7250.0);
            i.f32(at::UNFILTERED_THROTTLE, 0.75);
            i.f32(at::UNFILTERED_BRAKE, 0.25);
            i.f32(at::UNFILTERED_CLUTCH, 0.5);
            i.f32(at::UNFILTERED_STEERING, -0.5);
            i.f32(at::FUEL, 42.5);
            i.f32(at::LAP_DIST, 4309.0);
            // The car's state: overheating, water 92.5 and oil 110.25, dents 2 + 1 + 1 of a worst case of 16.
            i.0[at::OVERHEATING] = 1;
            i.f32(at::ENGINE_WATER_TEMP, 92.5);
            i.f32(at::ENGINE_OIL_TEMP, 110.25);
            i.0[at::DENT_SEVERITY + 1] = 2;
            i.0[at::DENT_SEVERITY + 4] = 1;
            i.0[at::DENT_SEVERITY + 7] = 1;
            // Cars around the player, which must not be mistaken for it.
            for (slot, dist, last) in [(0, 10.0, 80.0), (2, 20.0, 81.0)] {
                let v = Image::vehicle(slot);
                i.f32(v + at::V_LAP_DIST, dist);
                i.f32(v + at::V_LAST_LAP_TIME, last);
                i.text(v + at::V_VEHICLE_CLASS, CLASS_NAME_LENGTH, "Other Class");
                i.0[v + at::V_IN_PITS] = 1;
            }
            let me = Image::vehicle(PLAYER);
            i.0[me + at::V_IS_PLAYER] = 1;
            i.0[me + at::V_CONTROL] = 0;
            i.f32(me + at::V_LAP_DIST, 1234.5);
            i.f32(me + at::V_LAST_LAP_TIME, 90.5);
            i.text(me + at::V_VEHICLE_CLASS, CLASS_NAME_LENGTH, "Stock Car Extreme");
            i
        }
    }

    /// A fake plugin memory and the image the test keeps in it.
    struct Rig {
        fake: FakeMemory,
        image: Image,
    }

    impl Rig {
        fn new(label: &str, image: Image) -> Rig {
            let rig = Rig {
                fake: FakeMemory::new(label, SIZE),
                image,
            };
            rig.fake.write(0, &rig.image.0);
            rig
        }
        fn publish(&self) {
            self.fake.write(0, &self.image.0);
        }
        fn reader(&self) -> RFactor1 {
            let mut reader = RFactor1::open_named(&self.fake.name).expect("opens");
            reader.settle = Duration::ZERO;
            reader
        }
    }

    const NOW: Duration = Duration::from_millis(0);

    /// Field by field: (name, bytes of one element, how many). `#pragma pack(1)`: nothing is aligned.
    type Fields<'a> = &'a [(&'a str, usize, usize)];

    fn layout(fields: Fields) -> (Vec<(String, usize)>, usize) {
        let mut at: usize = 0;
        let mut offsets = Vec::new();
        for (name, size, count) in fields {
            offsets.push((name.to_string(), at));
            at += size * count;
        }
        (offsets, at)
    }

    fn offset_of(offsets: &[(String, usize)], name: &str) -> usize {
        offsets
            .iter()
            .find(|(n, _)| n == name)
            .unwrap_or_else(|| panic!("no field {name}"))
            .1
    }

    #[test]
    fn the_offsets_follow_from_the_sizes_in_the_header() {
        const F: usize = 4; // float
        const L: usize = 4; // long (MSVC, 32 and 64 bit)
        const S: usize = 2; // short
        const B: usize = 1; // bool, char, signed char, unsigned char
        const V3: usize = 3 * F; // rfVec3

        let (_, wheel) = layout(&[
            ("rotation", F, 1),
            ("suspensionDeflection", F, 1),
            ("rideHeight", F, 1),
            ("tireLoad", F, 1),
            ("lateralForce", F, 1),
            ("gripFract", F, 1),
            ("brakeTemp", F, 1),
            ("pressure", F, 1),
            ("temperature", F, 3),
            ("wear", F, 1),
            ("terrainName", B, 16),
            ("surfaceType", B, 1),
            ("flat", B, 1),
            ("detached", B, 1),
        ]);
        assert_eq!(wheel, 67);

        let (v, vehicle) = layout(&[
            ("driverName", B, 32),
            ("totalLaps", S, 1),
            ("sector", B, 1),
            ("finishStatus", B, 1),
            ("lapDist", F, 1),
            ("pathLateral", F, 1),
            ("trackEdge", F, 1),
            ("bestSector1", F, 1),
            ("bestSector2", F, 1),
            ("bestLapTime", F, 1),
            ("lastSector1", F, 1),
            ("lastSector2", F, 1),
            ("lastLapTime", F, 1),
            ("curSector1", F, 1),
            ("curSector2", F, 1),
            ("numPitstops", S, 1),
            ("numPenalties", S, 1),
            ("isPlayer", B, 1),
            ("control", B, 1),
            ("inPits", B, 1),
            ("place", B, 1),
            ("vehicleClass", B, 32),
            ("timeBehindNext", F, 1),
            ("lapsBehindNext", L, 1),
            ("timeBehindLeader", F, 1),
            ("lapsBehindLeader", L, 1),
            ("lapStartET", F, 1),
            ("pos", V3, 1),
            ("yaw", F, 1),
            ("pitch", F, 1),
            ("roll", F, 1),
            ("speed", F, 1),
        ]);
        assert_eq!(vehicle, VEHICLE_SIZE);
        for (name, want) in [
            ("lapDist", at::V_LAP_DIST),
            ("lastLapTime", at::V_LAST_LAP_TIME),
            ("isPlayer", at::V_IS_PLAYER),
            ("control", at::V_CONTROL),
            ("inPits", at::V_IN_PITS),
            ("vehicleClass", at::V_VEHICLE_CLASS),
        ] {
            assert_eq!(offset_of(&v, name), want, "vehicle.{name}");
        }

        let (o, size) = layout(&[
            ("version", B, 8),
            ("deltaTime", F, 1),
            ("lapNumber", L, 1),
            ("lapStartET", F, 1),
            ("trackName", B, 64),
            ("pos", V3, 1),
            ("localVel", V3, 1),
            ("localAccel", V3, 1),
            ("oriX", V3, 1),
            ("oriY", V3, 1),
            ("oriZ", V3, 1),
            ("localRot", V3, 1),
            ("localRotAccel", V3, 1),
            ("speed", F, 1),
            ("gear", L, 1),
            ("engineRPM", F, 1),
            ("engineWaterTemp", F, 1),
            ("engineOilTemp", F, 1),
            ("clutchRPM", F, 1),
            ("unfilteredThrottle", F, 1),
            ("unfilteredBrake", F, 1),
            ("unfilteredSteering", F, 1),
            ("unfilteredClutch", F, 1),
            ("steeringArmForce", F, 1),
            ("fuel", F, 1),
            ("engineMaxRPM", F, 1),
            ("scheduledStops", B, 1),
            ("overheating", B, 1),
            ("detached", B, 1),
            ("dentSeverity", B, 8),
            ("lastImpactET", F, 1),
            ("lastImpactMagnitude", F, 1),
            ("lastImpactPos", V3, 1),
            ("wheel", wheel, 4),
            ("session", L, 1),
            ("currentET", F, 1),
            ("endET", F, 1),
            ("maxLaps", L, 1),
            ("lapDist", F, 1),
            ("numVehicles", L, 1),
            ("gamePhase", B, 1),
            ("yellowFlagState", B, 1),
            ("sectorFlag", B, 3),
            ("startLight", B, 1),
            ("numRedLights", B, 1),
            ("inRealtime", B, 1),
            ("playerName", B, 32),
            ("ambientTemp", F, 1),
            ("trackTemp", F, 1),
            ("wind", V3, 1),
            ("vehicle", vehicle, VEHICLES_MAX as usize),
        ]);
        assert_eq!(size, SIZE, "sizeof(rfShared)");
        for (name, want) in [
            ("version", at::VERSION),
            ("lapNumber", at::LAP_NUMBER),
            ("lapStartET", at::LAP_START_ET),
            ("trackName", at::TRACK_NAME),
            ("pos", at::POS),
            ("localVel", at::LOCAL_VEL),
            ("gear", at::GEAR),
            ("engineRPM", at::ENGINE_RPM),
            ("unfilteredThrottle", at::UNFILTERED_THROTTLE),
            ("unfilteredBrake", at::UNFILTERED_BRAKE),
            ("unfilteredSteering", at::UNFILTERED_STEERING),
            ("unfilteredClutch", at::UNFILTERED_CLUTCH),
            ("fuel", at::FUEL),
            ("engineWaterTemp", at::ENGINE_WATER_TEMP),
            ("engineOilTemp", at::ENGINE_OIL_TEMP),
            ("overheating", at::OVERHEATING),
            ("dentSeverity", at::DENT_SEVERITY),
            ("currentET", at::CURRENT_ET),
            ("lapDist", at::LAP_DIST),
            ("numVehicles", at::NUM_VEHICLES),
            ("gamePhase", at::GAME_PHASE),
            ("inRealtime", at::IN_REALTIME),
            ("vehicle", at::VEHICLES),
        ] {
            assert_eq!(offset_of(&o, name), want, "{name}");
        }
        // Spot checks against the layout worked out independently with a C struct model (Python ctypes, `_pack_ = 1`).
        assert_eq!(offset_of(&o, "wheel"), 263);
        assert_eq!(offset_of(&o, "session"), 531);
        assert_eq!(offset_of(&o, "playerName"), 563);
        assert_eq!(offset_of(&o, "wind"), 603);
        // The plugin makes the mapping `SIZE` bytes long; Windows rounds that to whole pages, three here.
        assert_eq!(SIZE.div_ceil(4096) * 4096, 12_288);
    }

    #[test]
    fn reads_a_moment_on_track_into_exact_frame_values() {
        let rig = Rig::new("happy", Image::on_track());
        let mut reader = rig.reader();
        assert_eq!((reader.game_id(), reader.game_name()), ("rfactor1", "Stock Car Extreme"));
        let frame = reader.next(NOW).expect("a frame");
        let mut want = Frame::empty();
        want.clock_s = frame.clock_s;
        want.driving = true;
        want.lap = 4;
        want.lap_time_s = Some(63.25); // 1063.75 - 1000.5
        want.last_lap_s = Some(90.5);
        want.lap_valid = None; // the plugin does not export it
        want.dist_m = Some(1234.5);
        want.in_pits = false;
        want.speed_ms = 13.0;
        want.rpm = 7250.0;
        want.gear = 4.0;
        want.throttle = 0.75;
        want.brake = 0.25;
        want.clutch = 0.5;
        want.steer = -0.5;
        want.x = 100.5;
        want.y = 2.25;
        want.z = -300.75;
        want.fuel_l = 42.5;
        want.car = "Stock Car Extreme".into();
        want.car_class = None;
        want.track = "Interlagos".into();
        want.track_variant = None;
        want.track_length_m = Some(4309.0);
        want.state = CarState {
            engine_warning: Some(true),
            water_c: Some(92.5),
            oil_c: Some(110.25),
            damage_body: Some(0.25),
            ..CarState::UNKNOWN
        };
        assert_eq!(frame, want);
        assert!(reader.alive());
    }

    #[test]
    fn the_car_state_says_nothing_for_a_temperature_of_zero_and_pins_a_wild_dent() {
        let mut image = Image::on_track();
        image.f32(at::ENGINE_WATER_TEMP, 0.0);
        image.f32(at::ENGINE_OIL_TEMP, f32::NAN);
        image.0[at::OVERHEATING] = 5;
        for i in 0..8 {
            image.0[at::DENT_SEVERITY + i] = 200;
        }
        let state = frame_from(&image.0, 0.0).unwrap().state;
        assert_eq!((state.water_c, state.oil_c, state.engine_warning), (None, None, None));
        assert_eq!(state.damage_body, Some(1.0), "a dent above 2 counts as 2");
        assert_eq!(
            (state.handbrake, state.flag, state.tc_level, state.damage_engine),
            (None, None, None, None)
        );
    }

    #[test]
    fn the_player_is_the_car_marked_is_player_and_nobody_else() {
        let mut image = Image::on_track();
        // The marker moves to slot 2: its distance, class and pit state are now the player's.
        image.0[Image::vehicle(PLAYER) + at::V_IS_PLAYER] = 0;
        image.0[Image::vehicle(2) + at::V_IS_PLAYER] = 1;
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert_eq!(
            (frame.dist_m, frame.car.as_str(), frame.in_pits, frame.last_lap_s),
            (Some(20.0), "Other Class", true, Some(81.0))
        );
        assert!(frame.in_pits, "in the pits is the player's flag");
        // A byte that is not a clean `true` is not a player; with nobody marked the frame says nothing about a car.
        image.0[Image::vehicle(2) + at::V_IS_PLAYER] = 2;
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert!(!frame.driving && frame.dist_m.is_none() && frame.x.is_nan() && frame.car.is_empty() && frame.track.is_empty());
        // A marker past the cars the game says exist is not looked at (zeroed or stale slots).
        let mut image = Image::on_track();
        image.0[Image::vehicle(PLAYER) + at::V_IS_PLAYER] = 0;
        image.0[Image::vehicle(5) + at::V_IS_PLAYER] = 1;
        assert!(!frame_from(&image.0, 0.0).unwrap().driving);
        // The last slot of the array is valid when the count says so.
        image.i32(at::NUM_VEHICLES, 64);
        image.f32(Image::vehicle(63) + at::V_LAP_DIST, 99.0);
        image.0[Image::vehicle(5) + at::V_IS_PLAYER] = 0;
        image.0[Image::vehicle(63) + at::V_IS_PLAYER] = 1;
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert_eq!((frame.driving, frame.dist_m), (true, Some(99.0)));
    }

    #[test]
    fn driving_only_in_the_car_under_the_players_hands_in_a_phase_where_a_lap_counts() {
        let names = [
            "garage",
            "warm up",
            "grid walk",
            "formation",
            "countdown",
            "green flag",
            "full course yellow",
            "session stopped",
            "session over",
        ];
        for (phase, name) in names.iter().enumerate() {
            let mut image = Image::on_track();
            image.0[at::GAME_PHASE] = phase as u8;
            let frame = frame_from(&image.0, 0.0).unwrap();
            assert_eq!(frame.driving, [1, 5, 6, 7, 8].contains(&phase), "{name}");
            // Even when it is not driving, the frame still carries the last lap time (a lap can be closed in a menu).
            assert_eq!(frame.last_lap_s, Some(90.5), "{name}");
        }
        // The monitor (the player has left the car): the telemetry in memory is the last one the car gave.
        let mut image = Image::on_track();
        image.0[at::IN_REALTIME] = 0;
        assert!(!frame_from(&image.0, 0.0).unwrap().driving);
        // Not under the local player's control: the AI, a remote driver, a replay, nobody.
        for control in [1u8, 2, 3, 0xff] {
            let mut image = Image::on_track();
            image.0[Image::vehicle(PLAYER) + at::V_CONTROL] = control;
            assert!(!frame_from(&image.0, 0.0).unwrap().driving, "control {control}");
        }
        // A phase the header does not have is garbled data.
        let mut image = Image::on_track();
        image.0[at::GAME_PHASE] = 9;
        assert!(frame_from(&image.0, 0.0).is_none());
    }

    #[test]
    fn the_pit_flag_is_the_players() {
        let mut image = Image::on_track();
        image.0[Image::vehicle(PLAYER) + at::V_IN_PITS] = 1;
        assert!(frame_from(&image.0, 0.0).unwrap().in_pits);
        // The other cars are in the pits in the picture and the player is not.
        assert!(!frame_from(&Image::on_track().0, 0.0).unwrap().in_pits);
    }

    #[test]
    fn speed_gear_pedals_fuel_and_times_are_converted_and_garbage_is_not_given() {
        // Speed is the length of the local velocity vector, in metres per second, whatever way the car points.
        let mut image = Image::on_track();
        for (v, want) in [
            ([0.0, 0.0, -55.5], 55.5),
            ([0.0, 0.0, 55.5], 55.5),
            ([-3.0, 12.0, 4.0], 13.0),
            ([0.0; 3], 0.0),
        ] {
            for (i, c) in v.iter().enumerate() {
                image.f32(at::LOCAL_VEL + 4 * i, *c);
            }
            assert_eq!(frame_from(&image.0, 0.0).unwrap().speed_ms, want, "{v:?}");
        }
        image.f32(at::LOCAL_VEL + 8, f32::NAN);
        assert!(frame_from(&image.0, 0.0).unwrap().speed_ms.is_nan());
        image.f32(at::LOCAL_VEL + 8, 1.0e6);
        assert!(frame_from(&image.0, 0.0).unwrap().speed_ms.is_nan());

        for (gear, want) in [(-1, -1.0), (0, 0.0), (1, 1.0), (7, 7.0)] {
            let mut image = Image::on_track();
            image.i32(at::GEAR, gear);
            assert_eq!(frame_from(&image.0, 0.0).unwrap().gear, want, "gear {gear}");
        }
        for gear in [-2, 31, i32::MAX, i32::MIN] {
            let mut image = Image::on_track();
            image.i32(at::GEAR, gear);
            assert!(frame_from(&image.0, 0.0).unwrap().gear.is_nan(), "gear {gear}");
        }
        // Pedals and wheel are pulled into their ranges; NaN and infinity are not given.
        let mut image = Image::on_track();
        image.f32(at::UNFILTERED_THROTTLE, 1.5);
        image.f32(at::UNFILTERED_BRAKE, -0.5);
        image.f32(at::UNFILTERED_CLUTCH, f32::NAN);
        image.f32(at::UNFILTERED_STEERING, -3.0);
        image.f32(at::ENGINE_RPM, -5.0);
        image.f32(at::FUEL, f32::INFINITY);
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert_eq!((frame.throttle, frame.brake, frame.steer), (1.0, 0.0, -1.0));
        assert!(frame.clutch.is_nan() && frame.rpm.is_nan() && frame.fuel_l.is_nan());

        // Times: the lap time is the clock minus the lap's start; a hair below zero is zero, a lot below is not given.
        for (now, start, want) in [
            (1063.75, 1000.5, Some(63.25)),
            (10.0, 10.25, Some(0.0)),
            (10.0, 20.0, None),
            (f32::NAN, 1.0, None),
        ] {
            let mut image = Image::on_track();
            image.f32(at::CURRENT_ET, now);
            image.f32(at::LAP_START_ET, start);
            assert_eq!(frame_from(&image.0, 0.0).unwrap().lap_time_s, want, "{now} {start}");
        }
        // The last lap time is -1 while there is none, and then it is a time in seconds.
        for (last, want) in [(-1.0, None), (0.0, None), (f32::NAN, None), (87.125, Some(87.125))] {
            let mut image = Image::on_track();
            image.f32(Image::vehicle(PLAYER) + at::V_LAST_LAP_TIME, last);
            assert_eq!(frame_from(&image.0, 0.0).unwrap().last_lap_s, want, "{last}");
        }
        // The distance interpolated a hair below zero after the line is zero; far below, or not a number, is not given.
        for (dist, want) in [(-0.5, Some(0.0)), (0.0, Some(0.0)), (-5000.0, None), (f32::NAN, None)] {
            let mut image = Image::on_track();
            image.f32(Image::vehicle(PLAYER) + at::V_LAP_DIST, dist);
            assert_eq!(frame_from(&image.0, 0.0).unwrap().dist_m, want, "{dist}");
        }
        // No track length when the game gives none.
        let mut image = Image::on_track();
        image.f32(at::LAP_DIST, 0.0);
        assert_eq!(frame_from(&image.0, 0.0).unwrap().track_length_m, None);
    }

    #[test]
    fn the_lap_number_is_the_games_and_one_that_cannot_be_real_is_refused() {
        for lap in [0, 1, 2, 57, 100_000] {
            let mut image = Image::on_track();
            image.i32(at::LAP_NUMBER, lap);
            assert_eq!(frame_from(&image.0, 0.0).unwrap().lap, lap);
        }
        for lap in [-1, 100_001, i32::MAX, i32::MIN] {
            let mut image = Image::on_track();
            image.i32(at::LAP_NUMBER, lap);
            assert!(frame_from(&image.0, 0.0).is_none(), "lap {lap}");
        }
        for count in [-1, 65, i32::MAX, i32::MIN] {
            let mut image = Image::on_track();
            image.i32(at::NUM_VEHICLES, count);
            assert!(frame_from(&image.0, 0.0).is_none(), "vehicles {count}");
        }
    }

    #[test]
    fn unchanged_data_is_skipped_and_a_change_is_taken() {
        let mut rig = Rig::new("same", Image::on_track());
        let mut reader = rig.reader();
        assert!(reader.next(NOW).is_some());
        assert!(reader.next(NOW).is_none(), "the same bytes: nothing new");
        assert!(reader.next(Duration::from_millis(25)).is_none(), "still nothing new after waiting");
        rig.image.f32(at::ENGINE_RPM, 7300.0);
        rig.publish();
        assert_eq!(reader.next(NOW).unwrap().rpm, 7300.0);
        assert!(reader.next(NOW).is_none());
        // The plugin clears the memory between sessions: no marker, no frame; the version comes back with the data.
        let blank = Image(vec![0; SIZE]);
        rig.fake.write(0, &blank.0);
        assert!(reader.next(NOW).is_none());
        rig.image.f32(at::ENGINE_RPM, 7400.0);
        rig.publish();
        assert_eq!(reader.next(NOW).unwrap().rpm, 7400.0);
    }

    #[test]
    fn a_copy_is_used_only_when_two_copies_taken_apart_are_the_same() {
        let a = vec![1u8, 2, 3];
        let b = vec![1u8, 2, 9];
        // Calm memory: the first pair is the same.
        let mut reads = 0;
        assert_eq!(
            stable_copy(
                || {
                    reads += 1;
                    Some(a.clone())
                },
                || {}
            ),
            Some(a.clone())
        );
        assert_eq!(reads, 2);
        // A write between the two copies: they differ, the pair is tried again and the next one is taken.
        let mut script = vec![a.clone(), b.clone(), b.clone(), b.clone()].into_iter();
        assert_eq!(stable_copy(|| script.next(), || {}), Some(b.clone()));
        // The game never stops writing: after the attempts there is no copy at all.
        let mut n = 0u8;
        let mut gaps = 0;
        assert_eq!(
            stable_copy(
                || {
                    n = n.wrapping_add(1);
                    Some(vec![n])
                },
                || gaps += 1
            ),
            None
        );
        assert_eq!(gaps, ATTEMPTS, "the copies are taken apart, once per pair");
        // The memory cannot be read: nothing.
        assert_eq!(stable_copy(|| None, || {}), None);
    }

    #[test]
    fn a_memory_that_is_too_short_or_of_another_version_is_refused() {
        let ok = Rig::new("ok", Image::on_track());
        assert!(RFactor1::open_named(&ok.fake.name).is_some());
        assert!(RFactor1::open_named("XpeedSimNoSuchRFactorMemory").is_none());
        // Two pages: Windows reports 8192, less than the struct needs.
        let short = FakeMemory::new("short", 8192);
        short.write(0, &Image::on_track().0[..8192]);
        assert!(RFactor1::open_named(&short.name).is_none());
        // Exactly the struct's size is enough (the mapping is rounded up to pages).
        let exact = FakeMemory::new("exact", SIZE);
        exact.write(0, &Image::on_track().0);
        assert!(RFactor1::open_named(&exact.name).is_some());
        // The version marker is exactly "3.0.0.0" and its zero: the old release (no marker at all), other versions,
        // an empty memory and a longer text are all refused.
        let marks: [&[u8]; 7] = [
            b"3.0.0.1\0",
            b"2.0.0.0\0",
            b"3.0.0.0X",
            b"3.0.0\0\0\0",
            b"\0\0\0\0\0\0\0\0",
            b"3.0.0.0 \0",
            b"30.0.0.0",
        ];
        for mark in marks {
            let mut image = Image::on_track();
            image.0[..mark.len().min(8)].copy_from_slice(&mark[..mark.len().min(8)]);
            let rig = Rig::new("version", image);
            assert!(
                RFactor1::open_named(&rig.fake.name).is_none(),
                "marker {:?}",
                String::from_utf8_lossy(mark)
            );
        }
        // A copy of the wrong version (the memory changed under an open reader) gives nothing.
        let mut image = Image::on_track();
        image.0[0] = b'2';
        assert!(frame_from(&image.0, 0.0).is_none());
        assert!(frame_from(&Image::on_track().0[..SIZE - 1], 0.0).is_none());
        assert!(frame_from(&[], 0.0).is_none());
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
        for round in 0..300 {
            let mut bytes: Vec<u8> = (0..SIZE).map(|_| next() as u8).collect();
            // Most rounds keep the version, the phase, the counts and the player valid so the rest is read.
            if round % 3 != 0 {
                bytes[..8].copy_from_slice(VERSION);
                bytes[at::GAME_PHASE] = (next() % 9) as u8;
                bytes[at::NUM_VEHICLES..at::NUM_VEHICLES + 4].copy_from_slice(&64i32.to_le_bytes());
                bytes[at::LAP_NUMBER..at::LAP_NUMBER + 4].copy_from_slice(&((next() % 1000) as i32).to_le_bytes());
                let slot = (next() % 64) as usize;
                bytes[at::VEHICLES + slot * VEHICLE_SIZE + at::V_IS_PLAYER] = 1;
                // Some floats in a range where they are believable, so the range checks below have something to check.
                let mut floats = vec![
                    at::LOCAL_VEL,
                    at::LOCAL_VEL + 4,
                    at::LOCAL_VEL + 8,
                    at::ENGINE_RPM,
                    at::UNFILTERED_THROTTLE,
                    at::UNFILTERED_BRAKE,
                    at::UNFILTERED_CLUTCH,
                    at::UNFILTERED_STEERING,
                    at::FUEL,
                    at::CURRENT_ET,
                    at::LAP_START_ET,
                    at::LAP_DIST,
                ];
                floats.extend([at::V_LAP_DIST, at::V_LAST_LAP_TIME].map(|f| at::VEHICLES + slot * VEHICLE_SIZE + f));
                for float_at in floats {
                    let v = (next() % 4000) as f32 / 1000.0 - 2.0;
                    bytes[float_at..float_at + 4].copy_from_slice(&v.to_le_bytes());
                }
            }
            let Some(f) = frame_from(&bytes, 1.0) else { continue };
            given += 1;
            for v in [f.throttle, f.brake, f.clutch] {
                assert!(v.is_nan() || (0.0..=1.0).contains(&v));
            }
            assert!(f.steer.is_nan() || (-1.0..=1.0).contains(&f.steer));
            assert!(f.speed_ms.is_nan() || (0.0..=2000.0).contains(&f.speed_ms));
            assert!(f.gear.is_nan() || (-1.0..=30.0).contains(&f.gear));
            assert!(f.fuel_l.is_nan() || (0.0..=10_000.0).contains(&f.fuel_l));
            assert!(f.rpm.is_nan() || (0.0..=100_000.0).contains(&f.rpm));
            assert!(f.dist_m.is_none_or(|d| d.is_finite() && d >= 0.0));
            assert!(f.lap_time_s.is_none_or(|t| t.is_finite() && t >= 0.0));
            assert!(f.last_lap_s.is_none_or(|t| t.is_finite() && t > 0.0));
            assert!(f.track_length_m.is_none_or(|t| t.is_finite() && t > 0.0));
            assert!(f.lap >= 0);
        }
        assert!(given > 50, "given {given}");
        // And bytes of every length, up to nothing, never panic.
        for len in [0, 1, 7, 8, 100, 615, 3000, SIZE - 1] {
            let bytes: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            assert!(frame_from(&bytes, 0.0).is_none());
        }
    }

    #[test]
    fn the_clock_never_goes_backwards() {
        let mut rig = Rig::new("clock", Image::on_track());
        let mut reader = rig.reader();
        let mut last = -1.0;
        for i in 0..50 {
            rig.image.f32(at::CURRENT_ET, 1063.75 + i as f32 * 0.01);
            rig.publish();
            let frame = reader.next(Duration::from_millis(20)).expect("a frame");
            assert!(frame.clock_s >= last && frame.clock_s >= 0.0);
            last = frame.clock_s;
        }
    }

    #[test]
    fn the_door_is_alive_until_the_memory_stops_changing() {
        let mut rig = Rig::new("alive", Image::on_track());
        let mut reader = rig.reader();
        reader.stale_after = Duration::from_millis(80);
        assert!(reader.next(NOW).is_some() && reader.alive());
        // The game keeps scoring: still alive well past the limit.
        for i in 0..6 {
            sleep(Duration::from_millis(30));
            rig.image.f32(at::CURRENT_ET, 2000.0 + i as f32);
            rig.publish();
            reader.next(NOW);
            assert!(reader.alive());
        }
        // Nothing changes any more (the main menu, or the game is gone).
        sleep(Duration::from_millis(120));
        assert!(reader.next(NOW).is_none());
        assert!(!reader.alive());
    }

    /// One frame of a lap as the game would leave it in memory: the telemetry (lap number and start), the scoring clock
    /// and the player's distance and official last time.
    fn lap_frame(rig: &mut Rig, lap_number: i32, lap_start: f32, lap_time: f32, last_lap: f32) {
        rig.image.i32(at::LAP_NUMBER, lap_number);
        rig.image.f32(at::LAP_START_ET, lap_start);
        rig.image.f32(at::CURRENT_ET, lap_start + lap_time);
        rig.image.f32(at::POS, lap_time * 10.0);
        let me = Image::vehicle(PLAYER);
        rig.image.f32(me + at::V_LAP_DIST, lap_time * 50.0);
        rig.image.f32(me + at::V_LAST_LAP_TIME, last_lap);
        rig.publish();
    }

    fn drive_a_lap_through_the_reader(in_the_pits: bool) -> Vec<crate::lapfile::Lap> {
        let mut image = Image::on_track();
        image.0[Image::vehicle(PLAYER) + at::V_IN_PITS] = 0;
        let mut rig = Rig::new("lap", image);
        let mut reader = rig.reader();
        let mut cutter = LapCutter::new(reader.game_id());
        let mut laps = Vec::new();
        let mut feed = |reader: &mut RFactor1, laps: &mut Vec<_>| {
            let frame = reader.next(Duration::from_millis(20)).expect("a frame");
            laps.extend(cutter.on_frame(&frame, 1_794_312_000_000));
        };
        // Lap 1: 30 seconds at 20 Hz; the session clock is at 500 when it starts. No official time yet (-1).
        for i in 0..600 {
            rig.image.0[Image::vehicle(PLAYER) + at::V_IN_PITS] = u8::from(in_the_pits && i == 100);
            lap_frame(&mut rig, 1, 500.0, i as f32 / 20.0, -1.0);
            feed(&mut reader, &mut laps);
        }
        rig.image.0[Image::vehicle(PLAYER) + at::V_IN_PITS] = 0;
        // The line is crossed: the telemetry says lap 2 at once (the lap's start moves to 530.0), but the scoring, which
        // carries the official time, arrives half a second later.
        for i in 0..10 {
            lap_frame(&mut rig, 2, 530.0, i as f32 / 20.0, -1.0);
            feed(&mut reader, &mut laps);
        }
        for i in 10..30 {
            lap_frame(&mut rig, 2, 530.0, i as f32 / 20.0, 30.0);
            feed(&mut reader, &mut laps);
        }
        laps
    }

    #[test]
    fn a_scripted_lap_through_the_reader_and_the_cutter_is_one_lap_with_its_official_time() {
        let laps = drive_a_lap_through_the_reader(false);
        assert_eq!(laps.len(), 1);
        let lap = &laps[0];
        assert_eq!(
            (lap.game.as_str(), lap.lap_number, lap.time_ms, lap.valid),
            ("rfactor1", 1, 30_000, true)
        );
        assert_eq!((lap.track_name.as_str(), lap.track_variant.as_deref()), ("Interlagos", None));
        assert_eq!((lap.car_name.as_str(), lap.car_class.as_deref()), ("Stock Car Extreme", None));
        assert_eq!(lap.track_length_m, Some(4309.0));
        assert_eq!(lap.sample_count(), 600);
        let ids: Vec<&str> = lap.channels.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            ["t", "dist", "speed", "rpm", "gear", "throttle", "brake", "clutch", "steer", "x", "y", "z", "fuel"]
        );
        // The lap time is a difference of two session-clock floats around 530 s, good to about a microsecond here.
        assert!((lap.channel("t").unwrap().values.last().unwrap() - 29.95).abs() < 1e-4);
        assert_eq!(lap.channel("speed").unwrap().values[0], 13.0);
        assert_eq!(lap.channel("fuel").unwrap().values[0], 42.5);
        assert_eq!(lap.channel("dist").unwrap().values[100], 250.0);
    }

    #[test]
    fn a_lap_through_the_pits_is_kept_but_not_valid() {
        let laps = drive_a_lap_through_the_reader(true);
        assert_eq!((laps.len(), laps[0].time_ms, laps[0].valid), (1, 30_000, false));
    }
}
