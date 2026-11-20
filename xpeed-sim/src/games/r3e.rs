//! RaceRoom Racing Experience (R3E): the game's own shared memory, `$R3E`.
//!
//! # What the person does
//!
//! Nothing. RaceRoom always writes its shared memory while it runs (there is no setting for it in the game, and the
//! official sample only waits for `RRRE.exe` / `RRRE64.exe` and opens the memory). The reader is tried while one of
//! those two programs is running.
//!
//! # Sources
//!
//! All from the official API repository (it moved from `sector3studios/r3e-api` to `kwstudios-sweden/r3e-api`; the old
//! address redirects), at commit `e57a72fcafd74fcb1b0e7b5ca38a1a0aa59d74cb` (27 Oct 2026, "Update r3e.h and R3E.cs to
//! 3.6"):
//!
//! * Layout: <https://raw.githubusercontent.com/kwstudios-sweden/r3e-api/e57a72fcafd74fcb1b0e7b5ca38a1a0aa59d74cb/sample-c/src/r3e.h>
//!   (`r3e_shared`, the memory name `$R3E`, `R3E_VERSION_MAJOR` 3, `R3E_VERSION_MINOR` 6).
//! * Program names: `sample-c/src/utils.c` at the same commit (`is_r3e_running` looks for `RRRE.exe` and `RRRE64.exe`).
//! * The header sets `#pragma pack(push, 1)`: no padding at all, so every offset is the sum of the sizes before it
//!   (`r3e_int32` and `r3e_float32` 4 bytes, `r3e_float64` 8, `r3e_u8char` 1, every enum 4 with MSVC). The test
//!   `the_offsets_follow_from_the_sizes_in_the_header` adds them up field by field; the totals are the ones the commit
//!   states (`r3e_shared` 44024 bytes, `r3e_driver_data` 328).
//!
//! # What the memory is, and what follows from it
//!
//! * **No consistency protocol.** There is no sequence number or lock; the game rewrites the struct in place. The reader
//!   copies the part it reads twice, a few microseconds apart, and uses the copy only when both are byte-for-byte the
//!   same (the same guard as the rFactor 1 reader). This cannot prove a copy is whole if the game's thread is stopped by
//!   the system in the middle of its writes, which is why every value is also range-checked.
//! * Only the first `at::NUM_CARS` + 4 bytes are copied (up to and including `num_cars`): every field read sits before
//!   the array of all drivers.
//! * Versions: `open` refuses a memory whose `version_major` is not 3, or whose `all_drivers_offset` (the game's own
//!   "offset to num_cars") is not the one this layout gives (2008). The second check proves at run time that everything
//!   before the drivers array is where this reader expects it, whatever the minor version; the minor version itself is
//!   not checked (3.6 only added fields in former reserved slots and at the end). A copy that fails either check gives
//!   no frame and ends the door.
//!
//! # What is read, and how
//!
//! * `phase` (and `driving`, which is `phase == Driving`): the first that is true of `game_in_replay` or a replay
//!   `control_type` (3) is `Replay`; `game_in_menus` is `Menu`; `game_paused` is `Paused`; `game_player_in_garage` or the
//!   garage session phase is `Garage`; an AI or remote `control_type` (1, 2) is `Spectating`; any other control than the
//!   player's (0), or no lap count given, is `Unknown`; the grid walk, the formation lap and the start countdown are
//!   `Loading`; else `Driving` (-1 "unavailable", green, checkered and 0, which the enum does not name, count). The car
//!   values are left as the game gives them outside `Driving`: the audit found no stale or zeroed values here.
//! * `lap` is `completed_laps + 1` ("If this value is 6, the car is on it's 7th lap"); 0 while the game says -1.
//! * Times: `lap_time_current_self` and `lap_time_previous_self`, seconds, -1 = not given.
//! * `lap_valid`: `lap_valid_state` (0 this and next lap valid, 1 this lap invalid, 2 this and next invalid, -1 N/A).
//!   `current_lap_valid` is not used: the header gives no meaning for its values.
//! * `dist`: `lap_distance`, and the track length `layout_length`. The header gives no unit on those two; they are read
//!   as metres because every other distance into the lap in the header is in metres (`start_corridor_lap_distance`,
//!   "Lap distance where the start corridor begins, Unit: Meters", and `closest_yellow_distance_into_track`).
//! * `in_pits`: `in_pitlane` 1 (-1 N/A).
//! * Speed `car_speed` (m/s); rpm from `engine_rps` (radians per second, times 60 / 2π); `gear` -1 reverse, 0 neutral,
//!   1.. forward (-2 N/A); the pedals are `throttle_raw`, `brake_raw` and `clutch_raw` (0..1, -1 N/A) and the wheel
//!   `steer_input_raw` (-1..1); the position is `car_cg_location` (world space, metres, Y up); fuel `fuel_left` and the tank
//!   `fuel_capacity` (litres, -1 N/A).
//! * Tyres (front left, front right, rear left, rear right): temperature is the average of the three points across the
//!   tread `tire_temp[].current_temp` (left, centre, right; °C, -1 N/A); pressure `tire_pressure` (kPa, -1 N/A). Tread
//!   left is **not** given: the header has `tire_wear` "Range 0.0 - 1.0" but does not say whether 1.0 is a new tyre or a
//!   worn one, so it is not read.
//! * Names: `track_name` and `layout_name` (UTF-8). The memory has no car name (`vehicle_info` is an `r3e_driver_info`,
//!   whose `name` is the driver's), only the ids of the car model and class (`vehicle_info.model_id`, `class_id`); the
//!   car is written as `R3E model <id>` and the class as `R3E class <id>`. The names behind those ids are in
//!   `r3e-data.json` of the r3e-spectator-overlay repository, which the API's README points to.
//! * The race: `position` and `position_class` (1 is first), `num_cars`, `session_time_remaining` (seconds) and
//!   `number_of_laps` (the session's length in laps), each through `norm` (0, -1 and anything past the field are "not
//!   given"). Offsets worked out from the same header by `the_offsets_follow_from_the_sizes_in_the_header`; what the game
//!   writes in a timed or a lap-based session is not seen live (ASSUMED: -1 for the one that does not apply).
//! * The rivals (`Frame::field`): the drivers array after `num_cars` (`driver` below), copied at most every 200 ms
//!   (`FieldPace`) and only as far as `num_cars`. Per car: the name, `class_id` (as `R3E class <id>`), `place`,
//!   `place_class`, `lap_distance_fraction` (the share of the lap), `completed_laps`, `in_pitlane`, `time_delta_front` (the
//!   gap to the car ahead; -1 is none), the world `position`, and the last lap as the sum of `sector_time_previous_self`
//!   (all three given). Not in the header, so left `None`: a car's best lap, and the gap to the leader. The player's car
//!   is the driver whose `slot_id` is the player's `vehicle_info.slot_id`.
//! * The clock is the program's own (the game's `game_simulation_time` belongs to the session and can start again).
//!
//! Never read: another process's memory. Only the game's own shared memory, read-only and copied out.

use std::sync::Arc;
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::field::{self, Car, Field, FieldPace};
use crate::game::{Caps, CarState, Drs, Flag, Frame, Phase, Source, Tyre};
use crate::norm::{self, pedal, seconds, within};
use crate::shm::{Mapping, Page};

/// `R3E_SHARED_MEMORY_NAME`.
const MEMORY_NAME: &str = "$R3E";
/// `R3E_VERSION_MAJOR` of the header this reader is written against.
const VERSION_MAJOR: i32 = 3;
/// `sizeof(r3e_shared)` with `#pragma pack(1)` (version 3.6).
const SIZE: usize = 44_024;
/// The part of the memory copied: everything up to and including `num_cars`, before the drivers array.
const HEAD: usize = at::NUM_CARS + 4;
const STRING_LENGTH: usize = 64;
/// `sizeof(r3e_tire_temp)`: `current_temp[3]` and the optimal, cold and hot temperatures.
const TIRE_TEMP_SIZE: usize = 24;
/// `sizeof(r3e_brake_temp)`: `current_temp` and the optimal, cold and hot temperatures.
const BRAKE_TEMP_SIZE: usize = 16;

/// Byte offsets of the fields read, from the start of the memory.
mod at {
    pub const VERSION_MAJOR: usize = 0;
    pub const ALL_DRIVERS_OFFSET: usize = 8;
    pub const GAME_PAUSED: usize = 20;
    pub const GAME_IN_MENUS: usize = 24;
    pub const GAME_IN_REPLAY: usize = 28;
    pub const GAME_PLAYER_IN_GARAGE: usize = 36;
    pub const TRACK_NAME: usize = 600;
    pub const LAYOUT_NAME: usize = 664;
    pub const LAYOUT_LENGTH: usize = 736;
    pub const SESSION_PHASE: usize = 796;
    /// `int number_of_laps`: the length of the session in laps (-1 N/A).
    pub const NUMBER_OF_LAPS: usize = 812;
    /// `float session_time_remaining`, seconds (-1 N/A).
    pub const SESSION_TIME_REMAINING: usize = 820;
    pub const IN_PITLANE: usize = 848;
    /// `int position` (1 is first) and `int position_class`, right after `flags`.
    pub const POSITION: usize = 988;
    pub const POSITION_CLASS: usize = 992;
    pub const COMPLETED_LAPS: usize = 1028;
    pub const LAP_DISTANCE: usize = 1040;
    pub const LAP_TIME_PREVIOUS_SELF: usize = 1084;
    pub const LAP_TIME_CURRENT_SELF: usize = 1100;
    pub const LAP_VALID_STATE: usize = 1176;
    pub const VEHICLE_INFO: usize = 1196;
    /// Inside an `r3e_driver_info`.
    pub const DI_CLASS_ID: usize = 68;
    pub const DI_MODEL_ID: usize = 72;
    /// `driver_info.slot_id`.
    pub const DI_SLOT_ID: usize = 92;
    pub const CONTROL_TYPE: usize = 1388;
    pub const CAR_SPEED: usize = 1392;
    pub const ENGINE_RPS: usize = 1396;
    pub const GEAR: usize = 1408;
    /// `num_gears`, right after `gear`.
    pub const NUM_GEARS: usize = GEAR + 4;
    pub const CAR_CG_LOCATION: usize = 1416;
    pub const FUEL_LEFT: usize = 1456;
    /// `float fuel_capacity`, litres, right after `fuel_left`.
    pub const FUEL_CAPACITY: usize = FUEL_LEFT + 4;
    pub const THROTTLE_RAW: usize = 1504;
    pub const BRAKE_RAW: usize = 1512;
    pub const CLUTCH_RAW: usize = 1520;
    pub const STEER_INPUT_RAW: usize = 1524;
    pub const TIRE_PRESSURE: usize = 1712;
    pub const TIRE_TEMP: usize = 1744;
    /// `r3e_brake_temp brake_temp[4]`: the first float of each is `current_temp`, °C (-1 N/A).
    pub const BRAKE_TEMP: usize = 1856;
    /// `int num_cars`: the cars in the session; the drivers array follows it.
    pub const NUM_CARS: usize = 2008;

    // The car's state. `r3e_flags` (from 932): the ints `blue`, `black`, `green`, `checkered`, `white` and
    // `black_and_white` (-1 no data, 0 not active, 1 active; the last one also the reason) and `yellow` at its start.
    pub const FLAG_YELLOW: usize = 932;
    pub const FLAG_BLUE: usize = 964;
    pub const FLAG_BLACK: usize = 968;
    pub const FLAG_GREEN: usize = 972;
    pub const FLAG_CHECKERED: usize = 976;
    pub const FLAG_WHITE: usize = 980;
    pub const FLAG_BLACK_AND_WHITE: usize = 984;
    /// `float engine_temp` and `float engine_oil_temp`, Celsius.
    pub const ENGINE_TEMP: usize = 1480;
    pub const ENGINE_OIL_TEMP: usize = 1484;
    /// `r3e_aid_settings`: `int abs` and `int tc` (-1 N/A, 0 off, 1 on, 5 currently active).
    pub const AID_ABS: usize = 1536;
    pub const AID_TC: usize = 1540;
    /// `r3e_drs`: `int equipped`, `int available` (an activation left) and `int engaged` (-1 N/A, 0 no, 1 yes).
    pub const DRS_EQUIPPED: usize = 1556;
    pub const DRS_AVAILABLE: usize = 1560;
    pub const DRS_ENGAGED: usize = 1568;
    /// `int pit_limiter` (-1 N/A, 0 inactive, 1 active).
    pub const PIT_LIMITER: usize = 1572;
    /// `float brake_bias`: the share toward the REAR (0.3 = 30 %), -1 N/A.
    pub const BRAKE_BIAS: usize = 1596;
    /// `int abs_setting` (-1 N/A) and `int headlights` (-1 N/A, 0 off, 1 on, 2 strobing).
    pub const ABS_SETTING: usize = 1616;
    pub const HEADLIGHTS: usize = 1620;
    /// `int traction_control_setting` and `int engine_map_setting` (-1 N/A).
    pub const TRACTION_CONTROL_SETTING: usize = 1936;
    pub const ENGINE_MAP_SETTING: usize = 1940;
    /// `r3e_car_damage`: `float engine`, `transmission`, `aerodynamics`, `suspension`, 0..1, -1 N/A.
    pub const DAMAGE_ENGINE: usize = 1984;
    pub const DAMAGE_TRANSMISSION: usize = 1988;
    pub const DAMAGE_AERODYNAMICS: usize = 1992;
    pub const DAMAGE_SUSPENSION: usize = 1996;
}

/// The cars of the session: `r3e_driver_data all_drivers_data_1[128]`, right after `num_cars` (so from `at::NUM_CARS + 4`), each
/// element `driver::SIZE` bytes. Offsets inside one element, worked out from the header by the test
/// `the_offsets_follow_from_the_sizes_in_the_header`.
mod driver {
    /// `sizeof(r3e_driver_data)`.
    pub const SIZE: usize = 328;
    /// `R3E_NUM_DRIVERS_MAX`.
    pub const MAX: usize = 128;
    /// `driver_info.name` (64 bytes), the first field of the element.
    pub const NAME: usize = 0;
    /// `driver_info.class_id`.
    pub const CLASS_ID: usize = 68;
    /// `driver_info.slot_id`: the same value as the player's `vehicle_info.slot_id` marks the player's car.
    pub const SLOT_ID: usize = 92;
    /// `int place`, `int place_class` (1 is first; 0 or -1 none).
    pub const PLACE: usize = 132;
    pub const PLACE_CLASS: usize = 136;
    /// `float lap_distance_fraction`: 0..1 round the lap (-1 N/A); `lap_distance` (metres) comes just before it.
    pub const LAP_DISTANCE_FRACTION: usize = 144;
    /// `r3e_vec3_f32 position`: world space, metres.
    pub const POSITION: usize = 148;
    /// `int completed_laps`.
    pub const COMPLETED_LAPS: usize = 164;
    /// `float sector_time_previous_self[3]`: the sector times of the lap before this one, seconds (-1 N/A). Their sum is that
    /// lap's time (the header has no per-car previous or best lap time).
    pub const SECTOR_TIME_PREVIOUS_SELF: usize = 188;
    /// `float time_delta_front`: seconds to the car in front (-1 N/A).
    pub const TIME_DELTA_FRONT: usize = 212;
    /// `int in_pitlane`.
    pub const IN_PITLANE: usize = 224;
}

// `r3e_session_phase`: the phases before the start, in which a lap does not count.
const PHASE_GARAGE: i32 = 1;
const PHASE_COUNTDOWN: i32 = 4;
const PHASE_MAX: i32 = 6;
// `r3e_control`.
/// `r3e_control`: -1 unavailable, 0 the player, 1 an AI, 2 a remote driver, 3 a replay.
const CONTROL_PLAYER: i32 = 0;
const CONTROL_AI: i32 = 1;
const CONTROL_REMOTE: i32 = 2;
const CONTROL_REPLAY: i32 = 3;
const CONTROL_MAX: i32 = 3;

/// A copy is tried this many times before that frame is given up.
const ATTEMPTS: usize = 4;
/// The two copies of one reading are taken this far apart, longer than the game takes to write the struct.
const SETTLE: Duration = Duration::from_micros(60);
/// About 100 Hz.
const POLL: Duration = Duration::from_millis(10);
/// A memory that has not changed for this long: nothing is running in the game (a menu, or it is gone). The engine opens
/// the door again a few seconds later while the game runs.
const STALE: Duration = Duration::from_secs(30);

pub fn open() -> Option<Box<dyn Source>> {
    R3e::open_named(MEMORY_NAME).map(|reader| Box::new(reader) as Box<dyn Source>)
}

/// The reader of a capture (`replay.rs`): no pause between the two copies (a replay has nothing to wait for).
pub(crate) fn open_replay() -> Option<Box<dyn Source>> {
    R3e::open_named(MEMORY_NAME).map(|mut reader| {
        reader.settle = Duration::ZERO;
        Box::new(reader) as Box<dyn Source>
    })
}

struct R3e {
    memory: Mapping,
    started: Instant,
    /// The bytes of the last copy used, to skip a poll that finds the same thing.
    last_used: Option<Vec<u8>>,
    last_change: Instant,
    stale_after: Duration,
    /// A copy came with another version or layout: the door is over.
    refused: bool,
    /// The pause between the two copies (nothing in tests).
    settle: Duration,
    /// When the other cars are read (a few Hz, not on every sample).
    pace: FieldPace,
    /// Runs between the two copies of a pair, so a test can write "while" the reader copies.
    #[cfg(test)]
    between_copies: Option<Box<dyn FnMut()>>,
}

/// The version and the layout the memory declares are this reader's.
fn layout_is_ours(page: &Page) -> bool {
    page.i32_at(at::VERSION_MAJOR) == VERSION_MAJOR && page.i32_at(at::ALL_DRIVERS_OFFSET) == at::NUM_CARS as i32
}

impl R3e {
    /// `None` when there is no such memory, it is shorter than the struct, or its version or layout is not the header's.
    fn open_named(name: &str) -> Option<R3e> {
        let memory = Mapping::open(name)?;
        if memory.len() < SIZE {
            return None;
        }
        if !layout_is_ours(&Page(&memory.read(0, at::ALL_DRIVERS_OFFSET + 4)?)) {
            return None;
        }
        let now = Instant::now();
        Some(R3e {
            memory,
            started: now,
            last_used: None,
            last_change: now,
            stale_after: STALE,
            refused: false,
            settle: SETTLE,
            pace: FieldPace::default(),
            #[cfg(test)]
            between_copies: None,
        })
    }

    /// One try at a new reading: `None` when nothing is new or no stable copy could be had.
    fn try_read(&mut self) -> Option<Frame> {
        let memory = &self.memory;
        let settle = self.settle;
        #[cfg(test)]
        let hook = &mut self.between_copies;
        let copy = norm::stable_copy(
            ATTEMPTS,
            || memory.read(0, HEAD),
            || {
                #[cfg(test)]
                if let Some(hook) = hook.as_mut() {
                    hook();
                }
                if !settle.is_zero() {
                    norm::spin(settle)
                }
            },
        )?;
        if self.last_used.as_deref() == Some(&copy[..]) {
            return None;
        }
        self.last_change = Instant::now();
        if !layout_is_ours(&Page(&copy)) {
            self.refused = true;
            return None;
        }
        let mut frame = frame_from(&copy, self.started.elapsed().as_secs_f64());
        if let Some(frame) = frame.as_mut() {
            if self.pace.due(frame.clock_s) {
                frame.field = self.read_field(&copy, frame);
            }
        }
        self.last_used = Some(copy);
        frame
    }

    /// The other cars: one copy of the drivers array (`num_cars` elements, at most 128 of 328 bytes: about 42 kB for a full
    /// grid), taken only at the pace of `FieldPace`. Not checked twice like the head: each car's values are range-checked
    /// one by one, and a torn element costs one car for 200 ms.
    fn read_field(&self, head: &[u8], frame: &Frame) -> Option<Arc<Field>> {
        let page = Page(head);
        let cars = usize::try_from(page.i32_at(at::NUM_CARS)).ok()?.min(driver::MAX);
        if cars == 0 {
            return None;
        }
        let drivers = self.memory.read(at::NUM_CARS + 4, cars * driver::SIZE)?;
        drivers_field(page.i32_at(at::VEHICLE_INFO + at::DI_SLOT_ID), &drivers, frame)
    }
}

impl Source for R3e {
    fn game_id(&self) -> &'static str {
        "r3e"
    }

    fn game_name(&self) -> &'static str {
        "RaceRoom Racing Experience"
    }

    fn next(&mut self, timeout: Duration) -> Option<Frame> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.refused {
                return None;
            }
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
        !self.refused && self.last_change.elapsed() < self.stale_after
    }

    fn caps(&self) -> Caps {
        CAPS
    }
}

/// The header's "not available" for a temperature or a pressure is -1.0: that is no reading, whatever range it is in.
fn given(v: f32) -> f32 {
    if v == -1.0 {
        f32::NAN
    } else {
        v
    }
}

/// One tyre: the average of the points across the tread that are given (any one of the three is enough: the header
/// gives left, centre and right, and a car can leave one out), and the pressure.
fn tyre(page: &Page, index: usize) -> Tyre {
    let temps = tread_points(at::TIRE_TEMP + index * TIRE_TEMP_SIZE);
    let points: Vec<f32> = temps
        .iter()
        .map(|&at| norm::tyre_c(given(page.f32_at(at))))
        .filter(|v| v.is_finite())
        .collect();
    // The bar across the tread needs all three points. They are the tyre's own left, centre and right as seen from the
    // car (ASSUMED): on a left tyre the right edge is the inner one, on a right tyre the left edge.
    let across = norm::tread_points(
        given(page.f32_at(temps[0])),
        given(page.f32_at(temps[1])),
        given(page.f32_at(temps[2])),
    )
    .map(|[left, middle, right]| {
        if index.is_multiple_of(2) {
            [right, middle, left]
        } else {
            [left, middle, right]
        }
    });
    Tyre {
        brake_c: norm::brake_c(given(page.f32_at(at::BRAKE_TEMP + index * BRAKE_TEMP_SIZE))),
        temp_c: if points.is_empty() {
            f32::NAN
        } else {
            points.iter().sum::<f32>() / points.len() as f32
        },
        pressure_kpa: norm::pressure_kpa(given(page.f32_at(at::TIRE_PRESSURE + index * 4))),
        left: f32::NAN,
        tread_c: across,
    }
}

/// The three `current_temp` points (left, centre, right) of one `r3e_tire_temp`.
fn tread_points(base: usize) -> [usize; 3] {
    [base, base + 4, base + 8]
}

/// Turns one stable copy of the memory into a frame. `None` for a copy this reader cannot vouch for (too short, not
/// version 3 with this layout, a phase, a controller or a lap count the header does not have).
fn frame_from(bytes: &[u8], clock_s: f64) -> Option<Frame> {
    if bytes.len() < HEAD {
        return None;
    }
    let page = Page(bytes);
    if !layout_is_ours(&page) {
        return None;
    }
    let phase = page.i32_at(at::SESSION_PHASE);
    let control = page.i32_at(at::CONTROL_TYPE);
    let completed = page.i32_at(at::COMPLETED_LAPS);
    if !(-1..=PHASE_MAX).contains(&phase) || !(-1..=CONTROL_MAX).contains(&control) || !(-1..=100_000).contains(&completed) {
        return None;
    }
    let mut frame = Frame::empty();
    frame.clock_s = clock_s;

    // The first thing that is true decides, in this order.
    frame.set_phase(if page.i32_at(at::GAME_IN_REPLAY) != 0 || control == CONTROL_REPLAY {
        Phase::Replay
    } else if page.i32_at(at::GAME_IN_MENUS) != 0 {
        Phase::Menu
    } else if page.i32_at(at::GAME_PAUSED) != 0 {
        Phase::Paused
    } else if page.i32_at(at::GAME_PLAYER_IN_GARAGE) != 0 || phase == PHASE_GARAGE {
        Phase::Garage
    } else if control == CONTROL_AI || control == CONTROL_REMOTE {
        Phase::Spectating
    } else if control != CONTROL_PLAYER || completed < 0 {
        Phase::Unknown
    } else if (PHASE_GARAGE..=PHASE_COUNTDOWN).contains(&phase) {
        // The grid walk, the formation lap and the start countdown: a lap does not count yet.
        Phase::Loading
    } else {
        Phase::Driving
    });
    // The game counts laps completed from zero; the first lap is lap 1 here (the engine reads 0 as "no lap yet").
    frame.lap = if completed >= 0 { completed + 1 } else { 0 };
    frame.lap_time_s = seconds(page.f32_at(at::LAP_TIME_CURRENT_SELF), true);
    frame.last_lap_s = seconds(page.f32_at(at::LAP_TIME_PREVIOUS_SELF), false);
    frame.lap_valid = match page.i32_at(at::LAP_VALID_STATE) {
        0 => Some(true),
        1 | 2 => Some(false),
        _ => None,
    };
    frame.dist_m = {
        let d = within(page.f32_at(at::LAP_DISTANCE), 0.0, 1_000_000.0);
        d.is_finite().then(|| f64::from(d))
    };
    frame.in_pits = page.i32_at(at::IN_PITLANE) == 1;

    frame.speed_ms = within(page.f32_at(at::CAR_SPEED), 0.0, 1000.0);
    let rps = within(page.f32_at(at::ENGINE_RPS), 0.0, 10_000.0);
    frame.rpm = rps * (60.0 / std::f32::consts::TAU);
    frame.gear = norm::gear(page.i32_at(at::GEAR));
    // `num_gears`: the forward gears of the car.
    let num_gears = page.i32_at(at::NUM_GEARS);
    frame.gears = (1..=30).contains(&num_gears).then_some(num_gears as u8);
    // What the driver does with the pedals and the wheel, before any filtering the game applies.
    frame.throttle = pedal(page.f32_at(at::THROTTLE_RAW));
    frame.brake = pedal(page.f32_at(at::BRAKE_RAW));
    frame.clutch = pedal(page.f32_at(at::CLUTCH_RAW));
    frame.steer = norm::steer(page.f32_at(at::STEER_INPUT_RAW));
    frame.x = norm::position(page.f32_at(at::CAR_CG_LOCATION));
    frame.y = norm::position(page.f32_at(at::CAR_CG_LOCATION + 4));
    frame.z = norm::position(page.f32_at(at::CAR_CG_LOCATION + 8));
    frame.fuel_l = within(page.f32_at(at::FUEL_LEFT), 0.0, 10_000.0);
    // `fuel_capacity`, right after `fuel_left`: the tank in litres (-1 N/A).
    frame.fuel_capacity_l = Some(page.f32_at(at::FUEL_CAPACITY)).filter(|c| c.is_finite() && *c > 0.0 && *c <= 10_000.0);
    let tyres = [0, 1, 2, 3].map(|i| tyre(&page, i));
    frame.tyres = tyres.iter().any(Tyre::known).then_some(tyres);

    frame.state = state_from(&page);

    let model = page.i32_at(at::VEHICLE_INFO + at::DI_MODEL_ID);
    let class = page.i32_at(at::VEHICLE_INFO + at::DI_CLASS_ID);
    frame.car = if model >= 0 { format!("R3E model {model}") } else { String::new() };
    frame.car_class = (class >= 0).then(|| format!("R3E class {class}"));
    frame.track = page.ascii_at(at::TRACK_NAME, STRING_LENGTH);
    frame.track_variant = Some(page.ascii_at(at::LAYOUT_NAME, STRING_LENGTH)).filter(|s| !s.is_empty());
    let length = within(page.f32_at(at::LAYOUT_LENGTH), 0.0, 1_000_000.0);
    frame.track_length_m = (length > 0.0).then(|| f64::from(length));
    frame.cars = norm::cars(page.i32_at(at::NUM_CARS));
    frame.race_position = norm::place(page.i32_at(at::POSITION), frame.cars);
    frame.class_position = norm::place(page.i32_at(at::POSITION_CLASS), frame.cars);
    frame.session_time_left_s = norm::time_left_s(f64::from(page.f32_at(at::SESSION_TIME_REMAINING)));
    frame.session_laps = norm::race_laps(page.i32_at(at::NUMBER_OF_LAPS));
    // Every frame the reader tests make is held to the caps and the phase invariant.
    #[cfg(test)]
    crate::game::assert_frame_within_caps(&frame, CAPS, "r3e");
    Some(frame)
}

/// The cars of the session from a copy of the drivers array. `player_slot` is the player's `vehicle_info.slot_id`; `frame`
/// is the player's reading of the same moment (it gives the field size, the track length, the clock and the player's own
/// last lap). A slot with no name and no place is empty and left out; `None` when no car is left.
fn drivers_field(player_slot: i32, drivers: &[u8], frame: &Frame) -> Option<Arc<Field>> {
    let mut cars = Vec::new();
    for (index, bytes) in drivers.as_chunks::<{ driver::SIZE }>().0.iter().take(driver::MAX).enumerate() {
        let page = Page(bytes.as_slice());
        let name = page.ascii_at(driver::NAME, STRING_LENGTH);
        let position = norm::place(page.i32_at(driver::PLACE), frame.cars);
        if name.is_empty() && position.is_none() {
            continue;
        }
        let mut car = Car::named(index as u16, &name);
        let class = page.i32_at(driver::CLASS_ID);
        car.class = (class >= 0).then(|| format!("R3E class {class}"));
        car.position = position;
        car.class_position = norm::place(page.i32_at(driver::PLACE_CLASS), frame.cars);
        let laps = page.i32_at(driver::COMPLETED_LAPS);
        car.laps_done = (0..=100_000).contains(&laps).then_some(laps);
        let share = within(page.f32_at(driver::LAP_DISTANCE_FRACTION), 0.0, 1.05);
        car.lap_share = share.is_finite().then(|| share.min(1.0));
        car.in_pits = page.i32_at(driver::IN_PITLANE) == 1;
        let sectors: Vec<f32> = (0..3).map(|i| page.f32_at(driver::SECTOR_TIME_PREVIOUS_SELF + i * 4)).collect();
        car.last_lap_s = if sectors.iter().all(|&t| t > 0.0) {
            seconds(sectors.iter().sum(), false)
        } else {
            None
        };
        car.gap_ahead_s = seconds(page.f32_at(driver::TIME_DELTA_FRONT), true);
        let world = [0, 4, 8].map(|d| norm::position(page.f32_at(driver::POSITION + d)));
        car.world = world.iter().all(|v| v.is_finite()).then_some(world);
        car.is_player = player_slot >= 0 && page.i32_at(driver::SLOT_ID) == player_slot;
        if car.is_player {
            car.last_lap_s = car.last_lap_s.or(frame.last_lap_s);
        }
        cars.push(car);
    }
    (!cars.is_empty()).then(|| field::publish(cars, frame.clock_s, frame.track_length_m))
}

/// What a frame can fill. Not given: the handbrake and the engine warning (not in the header), the tread left (no
/// stated direction), the tank's size, the weather, the session kind, the sectors, the g forces, the air and track
/// temperatures (none is read).
const CAPS: Caps = Caps::LAP_TIME
    .or(Caps::LAST_LAP)
    .or(Caps::LAP_VALID)
    .or(Caps::DIST)
    .or(Caps::IN_PITS)
    .or(Caps::SPEED)
    .or(Caps::RPM)
    .or(Caps::GEAR)
    .or(Caps::GEARS)
    .or(Caps::THROTTLE)
    .or(Caps::BRAKE)
    .or(Caps::CLUTCH)
    .or(Caps::STEER)
    .or(Caps::POSITION)
    .or(Caps::FUEL)
    .or(Caps::FUEL_CAPACITY)
    .or(Caps::TYRE_TEMP)
    .or(Caps::TYRE_PRESSURE)
    .or(Caps::TYRE_TREAD)
    .or(Caps::BRAKE_TEMP)
    .or(Caps::CAR_CLASS)
    .or(Caps::TRACK_VARIANT)
    .or(Caps::TRACK_LENGTH)
    .or(Caps::PIT_LIMITER)
    .or(Caps::ABS_ACTIVE)
    .or(Caps::TC_ACTIVE)
    .or(Caps::DRS)
    .or(Caps::HEADLIGHTS)
    .or(Caps::FLAG)
    .or(Caps::WATER_TEMP)
    .or(Caps::OIL_TEMP)
    .or(Caps::TC_LEVEL)
    .or(Caps::ABS_LEVEL)
    .or(Caps::ENGINE_MAP)
    .or(Caps::BRAKE_BIAS)
    .or(Caps::DAMAGE_BODY)
    .or(Caps::DAMAGE_ENGINE)
    .or(Caps::DAMAGE_GEARBOX)
    .or(Caps::DAMAGE_SUSPENSION)
    .or(Caps::RACE_POSITION)
    .or(Caps::CLASS_POSITION)
    .or(Caps::CARS)
    .or(Caps::SESSION_TIME_LEFT)
    .or(Caps::SESSION_LAPS)
    .or(Caps::RIVALS)
    .or(Caps::RIVALS_WORLD);

/// A three-way int of the header (-1 no data, 0 no, 1 yes) as a bool; 2 and the rest are not given.
fn yes_no(v: i32) -> Option<bool> {
    match v {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

/// An aid (`r3e_aid_settings`): -1 N/A, 0 off, 1 on, 5 currently active. The aid acting is a bool; N/A is not given.
fn aid_acting(v: i32) -> Option<bool> {
    match v {
        0 | 1 => Some(false),
        5 => Some(true),
        _ => None,
    }
}

/// A setting (-1 N/A) as the level the dash shows.
fn level(v: i32) -> Option<u8> {
    u8::try_from(v).ok()
}

/// `car_damage` is 0..1 with 0.0 the bad end (the header says of the aerodynamics that "0.0 doesn't necessarily
/// mean completely destroyed"), so the damage is 1 minus the value; -1 is N/A.
fn damage(v: f32) -> Option<f32> {
    (0.0..=1.0).contains(&v).then_some(1.0 - v)
}

/// The dashboard lights, temperatures, electronics and damage. The handbrake and the engine warning are not in the
/// header.
fn state_from(page: &Page) -> CarState {
    let on = |at: usize| page.i32_at(at) == 1;
    // The most serious flag showing: a black one (with the black and white warning), the chequered, yellow, blue,
    // white, then green. The header has no red flag.
    let flag = norm::flag_showing(&[
        (on(at::FLAG_BLACK) || page.i32_at(at::FLAG_BLACK_AND_WHITE) > 0, Flag::Black),
        (on(at::FLAG_CHECKERED), Flag::Chequered),
        (on(at::FLAG_YELLOW), Flag::Yellow),
        (on(at::FLAG_BLUE), Flag::Blue),
        (on(at::FLAG_WHITE), Flag::White),
        (on(at::FLAG_GREEN), Flag::Green),
    ]);
    let drs = if on(at::DRS_ENGAGED) {
        Some(Drs::Open)
    } else if on(at::DRS_AVAILABLE) {
        Some(Drs::Available)
    } else if on(at::DRS_EQUIPPED) {
        Some(Drs::Off)
    } else {
        None
    };
    // `brake_bias` is the REAR share: the front's is what is left.
    let rear = page.f32_at(at::BRAKE_BIAS);
    CarState {
        pit_limiter: yes_no(page.i32_at(at::PIT_LIMITER)),
        abs_active: aid_acting(page.i32_at(at::AID_ABS)),
        tc_active: aid_acting(page.i32_at(at::AID_TC)),
        drs,
        headlights: match page.i32_at(at::HEADLIGHTS) {
            0 => Some(false),
            1 | 2 => Some(true),
            _ => None,
        },
        handbrake: None,
        engine_warning: None,
        flag,
        water_c: Some(norm::water_c(given(page.f32_at(at::ENGINE_TEMP)))).filter(|c| c.is_finite()),
        oil_c: Some(norm::oil_c(given(page.f32_at(at::ENGINE_OIL_TEMP)))).filter(|c| c.is_finite()),
        tc_level: level(page.i32_at(at::TRACTION_CONTROL_SETTING)),
        abs_level: level(page.i32_at(at::ABS_SETTING)),
        engine_map: level(page.i32_at(at::ENGINE_MAP_SETTING)),
        brake_bias: (rear > 0.0 && rear < 1.0).then_some(1.0 - rear),
        damage_body: damage(page.f32_at(at::DAMAGE_AERODYNAMICS)),
        damage_engine: damage(page.f32_at(at::DAMAGE_ENGINE)),
        damage_gearbox: damage(page.f32_at(at::DAMAGE_TRANSMISSION)),
        damage_suspension: damage(page.f32_at(at::DAMAGE_SUSPENSION)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lapcut::LapCutter;
    use crate::shm::FakeMemory;
    use std::rc::Rc;

    /// The whole struct as bytes, built by the test with the offsets the reader uses.
    struct Image(Vec<u8>);

    impl Image {
        /// A memory as the game leaves it on track before anything is filled in: the version, the layout, the player in
        /// control, the green flag, and -1 ("not available") in the fields that have it.
        fn new() -> Image {
            let mut i = Image(vec![0; SIZE]);
            i.i32(at::VERSION_MAJOR, VERSION_MAJOR);
            i.i32(4, 6); // version_minor
            i.i32(at::ALL_DRIVERS_OFFSET, at::NUM_CARS as i32);
            i.i32(12, 328); // driver_data_size
            i.i32(at::SESSION_PHASE, 5);
            i.i32(at::CONTROL_TYPE, CONTROL_PLAYER);
            i.i32(at::COMPLETED_LAPS, 0);
            i.i32(at::IN_PITLANE, 0);
            i.i32(at::LAP_VALID_STATE, 0);
            i.f32(at::LAP_TIME_PREVIOUS_SELF, -1.0);
            i.f32(at::LAP_TIME_CURRENT_SELF, -1.0);
            i.i32(at::VEHICLE_INFO + at::DI_MODEL_ID, -1);
            i.i32(at::VEHICLE_INFO + at::DI_CLASS_ID, -1);
            for t in 0..4 {
                for p in tread_points(at::TIRE_TEMP + t * TIRE_TEMP_SIZE) {
                    i.f32(p, -1.0);
                }
                i.f32(at::TIRE_PRESSURE + t * 4, -1.0);
                i.f32(at::BRAKE_TEMP + t * BRAKE_TEMP_SIZE, -1.0);
            }
            i
        }
        fn i32(&mut self, at: usize, v: i32) {
            self.0[at..at + 4].copy_from_slice(&v.to_le_bytes());
        }
        fn f32(&mut self, at: usize, v: f32) {
            self.0[at..at + 4].copy_from_slice(&v.to_le_bytes());
        }
        fn text(&mut self, at: usize, s: &str) {
            self.0[at..at + STRING_LENGTH].fill(0);
            self.0[at..at + s.len()].copy_from_slice(s.as_bytes());
        }
        /// One tyre: the three tread points and the pressure.
        fn tyre(&mut self, index: usize, temps: [f32; 3], pressure: f32) {
            for (at, t) in tread_points(at::TIRE_TEMP + index * TIRE_TEMP_SIZE).into_iter().zip(temps) {
                self.f32(at, t);
            }
            self.f32(at::TIRE_PRESSURE + index * 4, pressure);
        }
        /// A representative moment on track, with values that are exact in `f32`.
        fn on_track() -> Image {
            let mut i = Image::new();
            i.i32(at::COMPLETED_LAPS, 3);
            i.f32(at::LAP_TIME_CURRENT_SELF, 63.25);
            i.f32(at::LAP_TIME_PREVIOUS_SELF, 90.5);
            i.f32(at::LAP_DISTANCE, 1234.5);
            i.f32(at::CAR_SPEED, 55.5);
            // 7500 rpm is 7500 turns of 2π radians a minute.
            i.f32(at::ENGINE_RPS, 7500.0 * std::f32::consts::TAU / 60.0);
            i.i32(at::GEAR, 4);
            i.i32(at::NUM_GEARS, 6);
            i.f32(at::THROTTLE_RAW, 0.75);
            i.f32(at::BRAKE_RAW, 0.25);
            i.f32(at::CLUTCH_RAW, 0.5);
            i.f32(at::STEER_INPUT_RAW, -0.5);
            i.f32(at::CAR_CG_LOCATION, 100.5);
            i.f32(at::CAR_CG_LOCATION + 4, 2.25);
            i.f32(at::CAR_CG_LOCATION + 8, -300.75);
            i.f32(at::FUEL_LEFT, 42.5);
            i.f32(at::FUEL_CAPACITY, 80.0);
            i.tyre(0, [80.0, 90.0, 100.0], 180.5);
            i.tyre(1, [81.0, 91.0, 101.0], 181.5);
            i.tyre(2, [70.0, 75.0, 80.0], 170.25);
            i.tyre(3, [71.0, 76.0, 81.0], 171.25);
            for (t, c) in [450.0, 455.0, 300.0, 305.0].into_iter().enumerate() {
                i.f32(at::BRAKE_TEMP + t * BRAKE_TEMP_SIZE, c);
            }
            // The car's state: limiter on, ABS acting, TC on but not acting, the wing open, a yellow flag and a blue one
            // (yellow wins), headlights strobing, water 88.5 and oil 105.25, 30 % of the braking behind, TC 4 and ABS 2
            // and map 3, damage: aero 0.75 left, engine 0.5 left, gearbox untouched, suspension 0.25 left.
            i.i32(at::PIT_LIMITER, 1);
            i.i32(at::AID_ABS, 5);
            i.i32(at::AID_TC, 1);
            i.i32(at::DRS_EQUIPPED, 1);
            i.i32(at::DRS_ENGAGED, 1);
            i.i32(at::FLAG_YELLOW, 1);
            i.i32(at::FLAG_BLUE, 1);
            i.i32(at::HEADLIGHTS, 2);
            i.f32(at::ENGINE_TEMP, 88.5);
            i.f32(at::ENGINE_OIL_TEMP, 105.25);
            i.f32(at::BRAKE_BIAS, 0.25);
            i.i32(at::TRACTION_CONTROL_SETTING, 4);
            i.i32(at::ABS_SETTING, 2);
            i.i32(at::ENGINE_MAP_SETTING, 3);
            i.f32(at::DAMAGE_AERODYNAMICS, 0.75);
            i.f32(at::DAMAGE_ENGINE, 0.5);
            i.f32(at::DAMAGE_TRANSMISSION, 1.0);
            i.f32(at::DAMAGE_SUSPENSION, 0.25);
            i.i32(at::VEHICLE_INFO + at::DI_MODEL_ID, 5031);
            i.i32(at::VEHICLE_INFO + at::DI_CLASS_ID, 1703);
            // The driver's name sits where a car name might be looked for; it must not be taken for one.
            i.text(at::VEHICLE_INFO, "Some Driver");
            i.text(at::TRACK_NAME, "Nürburgring");
            i.text(at::LAYOUT_NAME, "Grand Prix");
            i.f32(at::LAYOUT_LENGTH, 5148.0);
            // Third of twelve, second in the class, 25 minutes left and a 20-lap length (both set here, a real session has one).
            i.i32(at::POSITION, 3);
            i.i32(at::POSITION_CLASS, 2);
            i.i32(at::NUM_CARS, 12);
            i.f32(at::SESSION_TIME_REMAINING, 1500.5);
            i.i32(at::NUMBER_OF_LAPS, 20);
            i
        }
    }

    /// A fake game memory and the image the test keeps in it.
    struct Rig {
        fake: Rc<FakeMemory>,
        image: Image,
    }

    impl Rig {
        fn new(label: &str, image: Image) -> Rig {
            let rig = Rig {
                fake: Rc::new(FakeMemory::new(label, SIZE)),
                image,
            };
            rig.fake.write(0, &rig.image.0);
            rig
        }
        fn publish(&self) {
            self.fake.write(0, &self.image.0);
        }
        fn reader(&self) -> R3e {
            let mut reader = R3e::open_named(&self.fake.name).expect("opens");
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
        const I: usize = 4; // r3e_int32, and every enum (MSVC)
        const F: usize = 4; // r3e_float32
        const D: usize = 8; // r3e_float64
        const C: usize = 1; // r3e_u8char
        const T: usize = 4; // R3E_TIRE_INDEX_MAX
        const V3D: usize = 3 * D; // r3e_vec3_f64
        const V3F: usize = 3 * F; // r3e_vec3_f32, r3e_ori_f32, r3e_sectorStarts

        let (_, player) = layout(&[
            ("user_id", I, 1),
            ("game_simulation_ticks", I, 1),
            ("game_simulation_time", D, 1),
            ("position", V3D, 1),
            ("velocity", V3D, 1),
            ("local_velocity", V3D, 1),
            ("acceleration", V3D, 1),
            ("local_acceleration", V3D, 1),
            ("orientation", V3D, 1),
            ("rotation", V3D, 1),
            ("angular_acceleration", V3D, 1),
            ("angular_velocity", V3D, 1),
            ("local_angular_velocity", V3D, 1),
            ("local_g_force", V3D, 1),
            ("steering_force", D, 1),
            ("steering_force_percentage", D, 1),
            ("engine_torque", D, 1),
            ("current_downforce", D, 1),
            ("voltage", D, 1),
            ("ers_level", D, 1),
            ("power_mgu_h", D, 1),
            ("power_mgu_k", D, 1),
            ("torque_mgu_k", D, 1),
            ("suspension_deflection", D, T),
            ("suspension_velocity", D, T),
            ("camber", D, T),
            ("ride_height", D, T),
            ("front_wing_height", D, 1),
            ("front_roll_angle", D, 1),
            ("rear_roll_angle", D, 1),
            ("third_spring_suspension_deflection_front", D, 1),
            ("third_spring_suspension_velocity_front", D, 1),
            ("third_spring_suspension_deflection_rear", D, 1),
            ("third_spring_suspension_velocity_rear", D, 1),
            ("unused1", D, 1),
            ("unused2", D, 1),
            ("unused3", D, 1),
        ]);
        assert_eq!(player, 560, "sizeof(r3e_playerdata)");

        let (_, flags) = layout(&[
            ("yellow", I, 1),
            ("yellowCausedIt", I, 1),
            ("yellowOvertake", I, 1),
            ("yellowPositionsGained", I, 1),
            ("sector_yellow", I, 3),
            ("closest_yellow_distance_into_track", F, 1),
            ("blue", I, 1),
            ("black", I, 1),
            ("green", I, 1),
            ("checkered", I, 1),
            ("white", I, 1),
            ("black_and_white", I, 1),
        ]);
        let (_, damage) = layout(&[
            ("engine", F, 1),
            ("transmission", F, 1),
            ("aerodynamics", F, 1),
            ("suspension", F, 1),
            ("unused1", F, 1),
            ("unused2", F, 1),
        ]);
        let (_, penalties) = layout(&[
            ("drive_through", F, 1),
            ("stop_and_go", F, 1),
            ("pit_stop", F, 1),
            ("time_deduction", F, 1),
            ("slow_down", F, 1),
        ]);
        let (_, drs) = layout(&[
            ("equipped", I, 1),
            ("available", I, 1),
            ("numActivationsLeft", I, 1),
            ("engaged", I, 1),
        ]);
        let (_, ptp) = layout(&[
            ("available", I, 1),
            ("engaged", I, 1),
            ("amount_left", I, 1),
            ("engaged_time_left", F, 1),
            ("wait_time_left", F, 1),
        ]);
        let (tt, tire_temp) = layout(&[
            ("current_temp", F, 3),
            ("optimal_temp", F, 1),
            ("cold_temp", F, 1),
            ("hot_temp", F, 1),
        ]);
        assert_eq!((offset_of(&tt, "current_temp"), tire_temp), (0, TIRE_TEMP_SIZE));
        let (_, brake_temp) = layout(&[
            ("current_temp", F, 1),
            ("optimal_temp", F, 1),
            ("cold_temp", F, 1),
            ("hot_temp", F, 1),
        ]);
        let (_, aids) = layout(&[
            ("abs", I, 1),
            ("tc", I, 1),
            ("esp", I, 1),
            ("countersteer", I, 1),
            ("cornering", I, 1),
        ]);
        let (di, driver_info) = layout(&[
            ("name", C, 64),
            ("car_number", I, 1),
            ("class_id", I, 1),
            ("model_id", I, 1),
            ("team_id", I, 1),
            ("livery_id", I, 1),
            ("manufacturer_id", I, 1),
            ("user_id", I, 1),
            ("slot_id", I, 1),
            ("class_performance_index", I, 1),
            ("engine_type", I, 1),
            ("car_width", F, 1),
            ("car_length", F, 1),
            ("rating", F, 1),
            ("reputation", F, 1),
            ("unused1", F, 1),
            ("unused2", F, 1),
        ]);
        assert_eq!(driver_info, 128, "sizeof(r3e_driver_info)");
        assert_eq!(offset_of(&di, "class_id"), at::DI_CLASS_ID);
        assert_eq!(offset_of(&di, "model_id"), at::DI_MODEL_ID);
        let (dd, driver_data) = layout(&[
            ("driver_info", driver_info, 1),
            ("finish_status", I, 1),
            ("place", I, 1),
            ("place_class", I, 1),
            ("lap_distance", F, 1),
            ("lap_distance_fraction", F, 1),
            ("position", V3F, 1),
            ("track_sector", I, 1),
            ("completed_laps", I, 1),
            ("current_lap_valid", I, 1),
            ("lap_time_current_self", F, 1),
            ("sector_time_current_self", F, 3),
            ("sector_time_previous_self", F, 3),
            ("sector_time_best_self", F, 3),
            ("time_delta_front", F, 1),
            ("time_delta_behind", F, 1),
            ("pitstop_status", I, 1),
            ("in_pitlane", I, 1),
            ("num_pitstops", I, 1),
            ("penalties", penalties, 1),
            ("car_speed", F, 1),
            ("tire_type_front", I, 1),
            ("tire_type_rear", I, 1),
            ("tire_subtype_front", I, 1),
            ("tire_subtype_rear", I, 1),
            ("base_penalty_weight", F, 1),
            ("aid_penalty_weight", F, 1),
            ("drs_state", I, 1),
            ("ptp_state", I, 1),
            ("virtual_energy", F, 1),
            ("penaltyType", I, 1),
            ("penaltyReason", I, 1),
            ("engineState", I, 1),
            ("orientation", V3F, 1),
            ("start_group", I, 1),
            ("start_phase", I, 1),
            ("formation_slot", I, 1),
        ]);
        assert_eq!(driver_data, 328, "sizeof(r3e_driver_data), as the 3.6 commit states");
        assert_eq!((driver::SIZE, driver::MAX), (driver_data, 128));
        assert_eq!(offset_of(&di, "slot_id"), at::DI_SLOT_ID);
        assert_eq!(offset_of(&di, "name"), driver::NAME);
        assert_eq!(offset_of(&di, "class_id"), driver::CLASS_ID);
        for (name, want) in [
            ("place", driver::PLACE),
            ("place_class", driver::PLACE_CLASS),
            ("lap_distance_fraction", driver::LAP_DISTANCE_FRACTION),
            ("position", driver::POSITION),
            ("completed_laps", driver::COMPLETED_LAPS),
            ("sector_time_previous_self", driver::SECTOR_TIME_PREVIOUS_SELF),
            ("time_delta_front", driver::TIME_DELTA_FRONT),
            ("in_pitlane", driver::IN_PITLANE),
        ] {
            assert_eq!(offset_of(&dd, name), want, "{name}");
        }

        let (o, size) = layout(&[
            ("version_major", I, 1),
            ("version_minor", I, 1),
            ("all_drivers_offset", I, 1),
            ("driver_data_size", I, 1),
            ("game_mode", I, 1),
            ("game_paused", I, 1),
            ("game_in_menus", I, 1),
            ("game_in_replay", I, 1),
            ("game_using_vr", I, 1),
            ("game_player_in_garage", I, 1),
            ("player", player, 1),
            ("track_name", C, 64),
            ("layout_name", C, 64),
            ("track_id", I, 1),
            ("layout_id", I, 1),
            ("layout_length", F, 1),
            ("sector_start_factors", V3F, 1),
            ("race_session_laps", I, 3),
            ("race_session_minutes", I, 3),
            ("event_index", I, 1),
            ("session_type", I, 1),
            ("session_iteration", I, 1),
            ("session_length_format", I, 1),
            ("session_pit_speed_limit", F, 1),
            ("session_phase", I, 1),
            ("start_lights", I, 1),
            ("tire_wear_active", I, 1),
            ("fuel_use_active", I, 1),
            ("number_of_laps", I, 1),
            ("session_time_duration", F, 1),
            ("session_time_remaining", F, 1),
            ("max_incident_points", I, 1),
            ("start_mode", I, 1),
            ("start_group_count", I, 1),
            ("pit_window_status", I, 1),
            ("pit_window_start", I, 1),
            ("pit_window_end", I, 1),
            ("in_pitlane", I, 1),
            ("pit_menu_selection", I, 1),
            ("pit_menu_state", I, 12), // R3E_PIT_MENU_MAX
            ("pit_state", I, 1),
            ("pit_total_duration", F, 1),
            ("pit_elapsed_time", F, 1),
            ("pit_action", I, 1),
            ("num_pitstops", I, 1),
            ("pit_min_duration_total", F, 1),
            ("pit_min_duration_left", F, 1),
            ("flags", flags, 1),
            ("position", I, 1),
            ("position_class", I, 1),
            ("finish_status", I, 1),
            ("cut_track_warnings", I, 1),
            ("penalties", penalties, 1),
            ("num_penalties", I, 1),
            ("completed_laps", I, 1),
            ("current_lap_valid", I, 1),
            ("track_sector", I, 1),
            ("lap_distance", F, 1),
            ("lap_distance_fraction", F, 1),
            ("lap_time_best_leader", F, 1),
            ("lap_time_best_leader_class", F, 1),
            ("session_best_lap_sector_times", F, 3),
            ("lap_time_best_self", F, 1),
            ("sector_time_best_self", F, 3),
            ("lap_time_previous_self", F, 1),
            ("sector_time_previous_self", F, 3),
            ("lap_time_current_self", F, 1),
            ("sector_time_current_self", F, 3),
            ("lap_time_delta_leader", F, 1),
            ("lap_time_delta_leader_class", F, 1),
            ("time_delta_front", F, 1),
            ("time_delta_behind", F, 1),
            ("time_delta_best_self", F, 1),
            ("best_individual_sector_time_self", F, 3),
            ("best_individual_sector_time_leader", F, 3),
            ("best_individual_sector_time_leader_class", F, 3),
            ("incident_points", I, 1),
            ("lap_valid_state", I, 1),
            ("prev_lap_valid", I, 1),
            ("discharge_rate", F, 1),
            ("brake_regen", F, 1),
            ("unused1", F, 1),
            ("vehicle_info", driver_info, 1),
            ("player_name", C, 64),
            ("control_type", I, 1),
            ("car_speed", F, 1),
            ("engine_rps", F, 1),
            ("max_engine_rps", F, 1),
            ("upshift_rps", F, 1),
            ("gear", I, 1),
            ("num_gears", I, 1),
            ("car_cg_location", V3F, 1),
            ("car_orientation", V3F, 1),
            ("local_acceleration", V3F, 1),
            ("total_mass", F, 1),
            ("fuel_left", F, 1),
            ("fuel_capacity", F, 1),
            ("fuel_per_lap", F, 1),
            ("virtual_energy_left", F, 1),
            ("virtual_energy_capacity", F, 1),
            ("virtual_energy_per_lap", F, 1),
            ("engine_temp", F, 1),
            ("engine_oil_temp", F, 1),
            ("fuel_pressure", F, 1),
            ("engine_oil_pressure", F, 1),
            ("turbo_pressure", F, 1),
            ("throttle", F, 1),
            ("throttle_raw", F, 1),
            ("brake", F, 1),
            ("brake_raw", F, 1),
            ("clutch", F, 1),
            ("clutch_raw", F, 1),
            ("steer_input_raw", F, 1),
            ("steer_lock_degrees", I, 1),
            ("steer_wheel_range_degrees", I, 1),
            ("aid_settings", aids, 1),
            ("drs", drs, 1),
            ("pit_limiter", I, 1),
            ("push_to_pass", ptp, 1),
            ("brake_bias", F, 1),
            ("drs_numActivationsTotal", I, 1),
            ("ptp_numActivationsTotal", I, 1),
            ("battery_soc", F, 1),
            ("water_left", F, 1),
            ("abs_setting", I, 1),
            ("headlights", I, 1),
            ("steer_wheel_max_rotation", I, 1),
            ("tire_type", I, 1),
            ("tire_rps", F, T),
            ("tire_speed", F, T),
            ("tire_grip", F, T),
            ("tire_wear", F, T),
            ("tire_flatspot", I, T),
            ("tire_pressure", F, T),
            ("tire_dirt", F, T),
            ("tire_temp", tire_temp, T),
            ("tire_type_front", I, 1),
            ("tire_type_rear", I, 1),
            ("tire_subtype_front", I, 1),
            ("tire_subtype_rear", I, 1),
            ("brake_temp", brake_temp, T),
            ("brake_pressure", F, T),
            ("traction_control_setting", I, 1),
            ("engine_map_setting", I, 1),
            ("engine_brake_setting", I, 1),
            ("traction_control_percent", F, 1),
            ("tire_on_mtrl", I, T),
            ("tire_load", F, T),
            ("car_damage", damage, 1),
            ("num_cars", I, 1),
            ("all_drivers_data_1", driver_data, 128), // R3E_NUM_DRIVERS_MAX
            ("formation_speed_limit", F, 1),
            ("formation_pace_floor", F, 1),
            ("start_corridor_lap_distance", F, 1),
            ("formation_side", I, 1),
            ("formation_follow_slot_id", I, 1),
            ("pitlane_start_delay_remaining", F, 1),
            ("start_penalty_pending", I, 1),
        ]);
        assert_eq!(size, SIZE, "sizeof(r3e_shared), as the 3.6 commit states");
        assert_eq!(
            offset_of(&o, "formation_speed_limit"),
            43_996,
            "the size before 3.6, as the commit states"
        );
        for (name, want) in [
            ("version_major", at::VERSION_MAJOR),
            ("all_drivers_offset", at::ALL_DRIVERS_OFFSET),
            ("game_paused", at::GAME_PAUSED),
            ("game_in_menus", at::GAME_IN_MENUS),
            ("game_in_replay", at::GAME_IN_REPLAY),
            ("game_player_in_garage", at::GAME_PLAYER_IN_GARAGE),
            ("track_name", at::TRACK_NAME),
            ("layout_name", at::LAYOUT_NAME),
            ("layout_length", at::LAYOUT_LENGTH),
            ("session_phase", at::SESSION_PHASE),
            ("number_of_laps", at::NUMBER_OF_LAPS),
            ("session_time_remaining", at::SESSION_TIME_REMAINING),
            ("position", at::POSITION),
            ("position_class", at::POSITION_CLASS),
            ("in_pitlane", at::IN_PITLANE),
            ("completed_laps", at::COMPLETED_LAPS),
            ("lap_distance", at::LAP_DISTANCE),
            ("lap_time_previous_self", at::LAP_TIME_PREVIOUS_SELF),
            ("lap_time_current_self", at::LAP_TIME_CURRENT_SELF),
            ("lap_valid_state", at::LAP_VALID_STATE),
            ("vehicle_info", at::VEHICLE_INFO),
            ("control_type", at::CONTROL_TYPE),
            ("car_speed", at::CAR_SPEED),
            ("engine_rps", at::ENGINE_RPS),
            ("gear", at::GEAR),
            ("num_gears", at::NUM_GEARS),
            ("car_cg_location", at::CAR_CG_LOCATION),
            ("fuel_left", at::FUEL_LEFT),
            ("fuel_capacity", at::FUEL_CAPACITY),
            ("throttle_raw", at::THROTTLE_RAW),
            ("brake_raw", at::BRAKE_RAW),
            ("clutch_raw", at::CLUTCH_RAW),
            ("steer_input_raw", at::STEER_INPUT_RAW),
            ("tire_pressure", at::TIRE_PRESSURE),
            ("tire_temp", at::TIRE_TEMP),
            ("brake_temp", at::BRAKE_TEMP),
            ("flags", at::FLAG_YELLOW),
            ("engine_temp", at::ENGINE_TEMP),
            ("engine_oil_temp", at::ENGINE_OIL_TEMP),
            ("aid_settings", at::AID_ABS),
            ("drs", at::DRS_EQUIPPED),
            ("pit_limiter", at::PIT_LIMITER),
            ("brake_bias", at::BRAKE_BIAS),
            ("abs_setting", at::ABS_SETTING),
            ("headlights", at::HEADLIGHTS),
            ("traction_control_setting", at::TRACTION_CONTROL_SETTING),
            ("engine_map_setting", at::ENGINE_MAP_SETTING),
            ("car_damage", at::DAMAGE_ENGINE),
            ("num_cars", at::NUM_CARS),
        ] {
            assert_eq!(offset_of(&o, name), want, "{name}");
        }
        // The game says where `num_cars` is (`all_drivers_offset`, "Offset to num_cars"); the reader checks that against
        // this, and copies everything up to it. Every field read lies inside that part.
        // Inside the structs: `r3e_flags` (yellow first, then four ints before `blue`), `r3e_aid_settings`, `r3e_drs`
        // and `r3e_car_damage`, whose fields follow one another.
        assert_eq!(at::FLAG_BLUE, at::FLAG_YELLOW + 8 * 4);
        assert_eq!(
            (
                at::FLAG_BLACK,
                at::FLAG_GREEN,
                at::FLAG_CHECKERED,
                at::FLAG_WHITE,
                at::FLAG_BLACK_AND_WHITE
            ),
            (
                at::FLAG_BLUE + 4,
                at::FLAG_BLUE + 8,
                at::FLAG_BLUE + 12,
                at::FLAG_BLUE + 16,
                at::FLAG_BLUE + 20
            )
        );
        assert_eq!(at::AID_TC, at::AID_ABS + 4);
        assert_eq!((at::DRS_AVAILABLE, at::DRS_ENGAGED), (at::DRS_EQUIPPED + 4, at::DRS_EQUIPPED + 12));
        assert_eq!(
            (at::DAMAGE_TRANSMISSION, at::DAMAGE_AERODYNAMICS, at::DAMAGE_SUSPENSION),
            (at::DAMAGE_ENGINE + 4, at::DAMAGE_ENGINE + 8, at::DAMAGE_ENGINE + 12)
        );
        assert_eq!(at::FLAG_BLACK_AND_WHITE + 4, offset_of(&o, "flags") + flags);
        assert_eq!(HEAD, offset_of(&o, "num_cars") + 4);
        const { assert!(at::TIRE_TEMP + 4 * TIRE_TEMP_SIZE <= HEAD) };
        const { assert!(at::BRAKE_TEMP + 4 * BRAKE_TEMP_SIZE <= HEAD) };
        // The mapping is rounded up to whole pages; what `open_named` asks of it still holds the struct.
        assert!(SIZE.div_ceil(4096) * 4096 >= SIZE);
    }

    #[test]
    fn reads_a_moment_on_track_into_exact_frame_values() {
        let rig = Rig::new("happy", Image::on_track());
        let mut reader = rig.reader();
        assert_eq!((reader.game_id(), reader.game_name()), ("r3e", "RaceRoom Racing Experience"));
        let frame = reader.next(NOW).expect("a frame");
        let mut want = Frame::empty();
        want.clock_s = frame.clock_s;
        want.set_phase(Phase::Driving);
        want.lap = 4; // three laps completed: the fourth is being driven
        want.lap_time_s = Some(63.25);
        want.last_lap_s = Some(90.5);
        want.lap_valid = Some(true);
        want.dist_m = Some(1234.5);
        want.in_pits = false;
        want.speed_ms = 55.5;
        want.rpm = frame.rpm;
        want.gear = 4.0;
        want.gears = Some(6);
        want.throttle = 0.75;
        want.brake = 0.25;
        want.clutch = 0.5;
        want.steer = -0.5;
        want.x = 100.5;
        want.y = 2.25;
        want.z = -300.75;
        want.fuel_l = 42.5;
        want.fuel_capacity_l = Some(80.0);
        // The race: third of twelve, second in class, 1500.5 s left of a 20-lap race.
        want.race_position = Some(3);
        want.class_position = Some(2);
        want.cars = Some(12);
        want.session_time_left_s = Some(1500.5);
        want.session_laps = Some(20);
        want.tyres = Some([
            Tyre {
                brake_c: 450.0,
                temp_c: 90.0,
                pressure_kpa: 180.5,
                left: f32::NAN,
                tread_c: Some([100.0, 90.0, 80.0]),
            },
            Tyre {
                brake_c: 455.0,
                temp_c: 91.0,
                pressure_kpa: 181.5,
                left: f32::NAN,
                tread_c: Some([81.0, 91.0, 101.0]),
            },
            Tyre {
                brake_c: 300.0,
                temp_c: 75.0,
                pressure_kpa: 170.25,
                left: f32::NAN,
                tread_c: Some([80.0, 75.0, 70.0]),
            },
            Tyre {
                brake_c: 305.0,
                temp_c: 76.0,
                pressure_kpa: 171.25,
                left: f32::NAN,
                tread_c: Some([71.0, 76.0, 81.0]),
            },
        ]);
        want.car = "R3E model 5031".into();
        want.car_class = Some("R3E class 1703".into());
        want.track = "Nürburgring".into();
        want.track_variant = Some("Grand Prix".into());
        want.track_length_m = Some(5148.0);
        want.state = CarState {
            pit_limiter: Some(true),
            abs_active: Some(true),
            tc_active: Some(false),
            drs: Some(Drs::Open),
            headlights: Some(true),
            handbrake: None,
            engine_warning: None,
            flag: Some(Flag::Yellow),
            water_c: Some(88.5),
            oil_c: Some(105.25),
            tc_level: Some(4),
            abs_level: Some(2),
            engine_map: Some(3),
            brake_bias: Some(0.75), // 0.25 of the braking is behind
            damage_body: Some(0.25),
            damage_engine: Some(0.5),
            damage_gearbox: Some(0.0),
            damage_suspension: Some(0.75),
        };
        // NaN is never equal to itself: the tyres are compared apart.
        let (got_tyres, want_tyres) = (frame.tyres.unwrap(), want.tyres.take().unwrap());
        let mut frame = frame;
        frame.tyres = None;
        assert_eq!(frame, want);
        for (got, want) in got_tyres.iter().zip(want_tyres) {
            assert_eq!(
                (got.temp_c, got.pressure_kpa, got.brake_c),
                (want.temp_c, want.pressure_kpa, want.brake_c)
            );
            assert!(got.left.is_nan(), "tread left is not given");
        }
        assert!((frame.rpm - 7500.0).abs() < 0.01, "rpm {}", frame.rpm);
        assert!(reader.alive());
    }

    #[test]
    fn the_race_values_are_read_and_what_the_game_calls_not_available_is_not_given() {
        let frame = frame_from(&Image::on_track().0, 0.0).unwrap();
        assert_eq!(
            (frame.race_position, frame.class_position, frame.cars),
            (Some(3), Some(2), Some(12))
        );
        assert_eq!((frame.session_time_left_s, frame.session_laps), (Some(1500.5), Some(20)));
        // A lap-based session: no time (-1); a timed one: no laps (-1).
        let mut image = Image::on_track();
        image.f32(at::SESSION_TIME_REMAINING, -1.0);
        image.i32(at::NUMBER_OF_LAPS, -1);
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert_eq!((frame.session_time_left_s, frame.session_laps), (None, None));
        // A place past the field, no place yet, a field of none and a time that is no time are not given.
        image.i32(at::POSITION, 13);
        image.i32(at::POSITION_CLASS, 0);
        image.f32(at::SESSION_TIME_REMAINING, f32::NAN);
        image.i32(at::NUMBER_OF_LAPS, 5000);
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert_eq!((frame.race_position, frame.class_position, frame.cars), (None, None, Some(12)));
        assert_eq!((frame.session_time_left_s, frame.session_laps), (None, None));
        image.i32(at::NUM_CARS, 0);
        assert_eq!(frame_from(&image.0, 0.0).unwrap().cars, None);
        // Nothing written yet.
        let frame = frame_from(&Image::new().0, 0.0).unwrap();
        assert_eq!((frame.race_position, frame.cars, frame.session_laps), (None, None, None));
    }

    #[test]
    fn the_car_state_says_nothing_for_what_the_header_calls_not_available() {
        // The header's -1 in every field that has it.
        let mut image = Image::new();
        for at in [
            at::PIT_LIMITER,
            at::AID_ABS,
            at::AID_TC,
            at::DRS_EQUIPPED,
            at::DRS_AVAILABLE,
            at::DRS_ENGAGED,
            at::HEADLIGHTS,
            at::ABS_SETTING,
            at::TRACTION_CONTROL_SETTING,
            at::ENGINE_MAP_SETTING,
            at::FLAG_BLACK,
            at::FLAG_BLUE,
            at::FLAG_GREEN,
            at::FLAG_YELLOW,
        ] {
            image.i32(at, -1);
        }
        for at in [
            at::ENGINE_TEMP,
            at::ENGINE_OIL_TEMP,
            at::BRAKE_BIAS,
            at::DAMAGE_ENGINE,
            at::DAMAGE_TRANSMISSION,
            at::DAMAGE_AERODYNAMICS,
            at::DAMAGE_SUSPENSION,
        ] {
            image.f32(at, -1.0);
        }
        assert_eq!(frame_from(&image.0, 0.0).unwrap().state, CarState::UNKNOWN);
        // Flags by their weight, and the drs by what it says.
        image.i32(at::FLAG_GREEN, 1);
        assert_eq!(frame_from(&image.0, 0.0).unwrap().state.flag, Some(Flag::Green));
        image.i32(at::FLAG_WHITE, 1);
        assert_eq!(frame_from(&image.0, 0.0).unwrap().state.flag, Some(Flag::White));
        image.i32(at::FLAG_BLUE, 1);
        assert_eq!(frame_from(&image.0, 0.0).unwrap().state.flag, Some(Flag::Blue));
        image.i32(at::FLAG_YELLOW, 1);
        assert_eq!(frame_from(&image.0, 0.0).unwrap().state.flag, Some(Flag::Yellow));
        image.i32(at::FLAG_CHECKERED, 1);
        assert_eq!(frame_from(&image.0, 0.0).unwrap().state.flag, Some(Flag::Chequered));
        image.i32(at::FLAG_BLACK_AND_WHITE, 3); // wrong way
        assert_eq!(frame_from(&image.0, 0.0).unwrap().state.flag, Some(Flag::Black));
        image.i32(at::DRS_EQUIPPED, 1);
        assert_eq!(frame_from(&image.0, 0.0).unwrap().state.drs, Some(Drs::Off));
        image.i32(at::DRS_AVAILABLE, 1);
        assert_eq!(frame_from(&image.0, 0.0).unwrap().state.drs, Some(Drs::Available));
        // ABS and TC: "on" is not "acting"; a pit limiter and a wild bias or damage are not believed.
        image.i32(at::AID_ABS, 1);
        image.i32(at::PIT_LIMITER, 7);
        image.f32(at::BRAKE_BIAS, 1.5);
        image.f32(at::DAMAGE_ENGINE, 3.0);
        let state = frame_from(&image.0, 0.0).unwrap().state;
        assert_eq!(
            (state.abs_active, state.pit_limiter, state.brake_bias, state.damage_engine),
            (Some(false), None, None, None)
        );
    }

    #[test]
    fn rpm_is_the_engine_speed_in_radians_per_second_turned_into_turns_per_minute() {
        for (rps, rpm) in [
            (0.0, 0.0),
            (std::f32::consts::PI, 30.0),
            (100.0, 954.929_7),
            (1_047.197_6, 10_000.0),
        ] {
            let mut image = Image::on_track();
            image.f32(at::ENGINE_RPS, rps);
            let got = frame_from(&image.0, 0.0).unwrap().rpm;
            assert!((got - rpm).abs() < 0.01, "{rps} rad/s: {got} rpm, want {rpm}");
        }
        for rps in [-1.0, -0.5, f32::NAN, f32::INFINITY, 20_000.0] {
            let mut image = Image::on_track();
            image.f32(at::ENGINE_RPS, rps);
            assert!(frame_from(&image.0, 0.0).unwrap().rpm.is_nan(), "{rps} rad/s");
        }
    }

    #[test]
    fn driving_only_on_track_under_the_players_hands_in_a_phase_where_a_lap_counts() {
        for (field, name) in [
            (at::GAME_PAUSED, "paused"),
            (at::GAME_IN_MENUS, "in menus"),
            (at::GAME_IN_REPLAY, "in a replay"),
            (at::GAME_PLAYER_IN_GARAGE, "in the garage"),
        ] {
            let mut image = Image::on_track();
            image.i32(field, 1);
            let frame = frame_from(&image.0, 0.0).unwrap();
            assert!(!frame.driving, "{name}");
            // Even when it is not driving, the frame still carries the last lap time (a lap can be closed in a menu).
            assert_eq!(frame.last_lap_s, Some(90.5), "{name}");
        }
        for (control, driving) in [(-1, false), (0, true), (1, false), (2, false), (3, false)] {
            let mut image = Image::on_track();
            image.i32(at::CONTROL_TYPE, control);
            assert_eq!(frame_from(&image.0, 0.0).unwrap().driving, driving, "control {control}");
        }
        for (phase, driving) in [
            (-1, true),
            (0, true),
            (1, false),
            (2, false),
            (3, false),
            (4, false),
            (5, true),
            (6, true),
        ] {
            let mut image = Image::on_track();
            image.i32(at::SESSION_PHASE, phase);
            assert_eq!(frame_from(&image.0, 0.0).unwrap().driving, driving, "phase {phase}");
        }
        // No lap count given: lap 0 ("no lap yet") and not driving.
        let mut image = Image::on_track();
        image.i32(at::COMPLETED_LAPS, -1);
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert_eq!((frame.lap, frame.driving), (0, false));
        // Values the header does not have are garbled data.
        for (field, value) in [
            (at::CONTROL_TYPE, 4),
            (at::CONTROL_TYPE, -2),
            (at::SESSION_PHASE, 7),
            (at::SESSION_PHASE, -2),
            (at::COMPLETED_LAPS, -2),
            (at::COMPLETED_LAPS, 100_001),
        ] {
            let mut image = Image::on_track();
            image.i32(field, value);
            assert!(frame_from(&image.0, 0.0).is_none(), "{field} = {value}");
        }
    }

    #[test]
    fn the_pit_lane_and_the_lap_verdict_are_the_games() {
        for (value, in_pits) in [(-1, false), (0, false), (1, true)] {
            let mut image = Image::on_track();
            image.i32(at::IN_PITLANE, value);
            let frame = frame_from(&image.0, 0.0).unwrap();
            assert_eq!((frame.in_pits, frame.driving), (in_pits, true), "in_pitlane {value}");
        }
        for (state, valid) in [(-1, None), (0, Some(true)), (1, Some(false)), (2, Some(false)), (3, None)] {
            let mut image = Image::on_track();
            image.i32(at::LAP_VALID_STATE, state);
            assert_eq!(frame_from(&image.0, 0.0).unwrap().lap_valid, valid, "lap_valid_state {state}");
        }
    }

    #[test]
    fn the_forward_gear_count_is_given_only_when_the_game_sets_it() {
        for (num, want) in [(6, Some(6)), (1, Some(1)), (0, None), (-1, None), (31, None)] {
            let mut image = Image::on_track();
            image.i32(at::NUM_GEARS, num);
            assert_eq!(frame_from(&image.0, 0.0).unwrap().gears, want, "num_gears {num}");
        }
    }

    #[test]
    fn gears_pedals_fuel_times_and_names_are_converted_and_garbage_is_not_given() {
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
        // -1.0 is "not available" for a pedal; a hair off the range is pulled in. The wheel is pulled into -1..1.
        let mut image = Image::on_track();
        image.f32(at::THROTTLE_RAW, 1.5);
        image.f32(at::BRAKE_RAW, -0.01);
        image.f32(at::CLUTCH_RAW, -1.0);
        image.f32(at::STEER_INPUT_RAW, -1.2);
        image.f32(at::CAR_SPEED, f32::INFINITY);
        image.f32(at::FUEL_LEFT, -1.0);
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert_eq!((frame.throttle, frame.brake, frame.steer), (1.0, 0.0, -1.0));
        // Far outside the range (the one tolerance of `norm.rs`) is not given, not pinned to the end.
        image.f32(at::THROTTLE_RAW, 5.0);
        image.f32(at::STEER_INPUT_RAW, -3.0);
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert!(frame.throttle.is_nan() && frame.steer.is_nan());
        assert!(frame.clutch.is_nan() && frame.speed_ms.is_nan() && frame.fuel_l.is_nan());
        // No time yet: -1.0. A lap just begun: zero is a current time but not a last one.
        let mut image = Image::on_track();
        image.f32(at::LAP_TIME_CURRENT_SELF, -1.0);
        image.f32(at::LAP_TIME_PREVIOUS_SELF, -1.0);
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert_eq!((frame.lap_time_s, frame.last_lap_s), (None, None));
        image.f32(at::LAP_TIME_CURRENT_SELF, 0.0);
        image.f32(at::LAP_TIME_PREVIOUS_SELF, 0.0);
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert_eq!((frame.lap_time_s, frame.last_lap_s), (Some(0.0), None));
        // No layout name, length or ids: not given.
        let mut image = Image::on_track();
        image.text(at::LAYOUT_NAME, "");
        image.f32(at::LAYOUT_LENGTH, -1.0);
        image.i32(at::VEHICLE_INFO + at::DI_MODEL_ID, -1);
        image.i32(at::VEHICLE_INFO + at::DI_CLASS_ID, -1);
        image.f32(at::LAP_DISTANCE, -1.0);
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert_eq!((frame.track_variant, frame.track_length_m, frame.dist_m), (None, None, None));
        assert_eq!((frame.car.as_str(), frame.car_class), ("", None));
        assert_eq!(frame.track, "Nürburgring");
    }

    #[test]
    fn tyre_temperatures_are_the_tread_average_and_not_available_is_not_given() {
        // One point not available: the average of the other two.
        let mut image = Image::on_track();
        image.tyre(0, [80.0, -1.0, 100.0], -1.0);
        let tyres = frame_from(&image.0, 0.0).unwrap().tyres.unwrap();
        assert_eq!(tyres[0].temp_c, 90.0);
        assert_eq!(tyres[0].tread_c, None, "a bar across the tread needs all three points");
        assert_eq!(
            tyres[1].tread_c,
            Some([81.0, 91.0, 101.0]),
            "a right tyre: the left edge is the inner one"
        );
        assert!(tyres[0].pressure_kpa.is_nan());
        assert_eq!(tyres[1].temp_c, 91.0);
        // Nothing about one tyre: that tyre is unknown, the others are still given.
        image.tyre(0, [-1.0, -1.0, -1.0], -1.0);
        image.f32(at::BRAKE_TEMP, -1.0);
        let tyres = frame_from(&image.0, 0.0).unwrap().tyres.unwrap();
        assert!(!tyres[0].known() && tyres[3].known());
        // Nothing about any tyre (the game says -1 everywhere): no tyres at all.
        let frame = frame_from(&Image::new().0, 0.0).unwrap();
        assert_eq!(frame.tyres, None);
        // A zeroed memory says nothing about tyres either.
        let mut image = Image::new();
        for t in 0..4 {
            image.tyre(t, [0.0; 3], 0.0);
        }
        assert_eq!(frame_from(&image.0, 0.0).unwrap().tyres, None);
        // A brake temperature alone is a known tyre; -1 and zero are not given; carbon brakes run past 500 °C.
        let mut image = Image::new();
        image.f32(at::BRAKE_TEMP, 820.0);
        image.f32(at::BRAKE_TEMP + BRAKE_TEMP_SIZE, 0.0);
        let tyres = frame_from(&image.0, 0.0)
            .unwrap()
            .tyres
            .expect("a brake alone is something to show");
        assert_eq!(tyres[0].brake_c, 820.0);
        assert!(tyres[0].known() && tyres[0].temp_c.is_nan());
        assert!(tyres[1].brake_c.is_nan() && tyres[2].brake_c.is_nan() && !tyres[1].known());
        // Absurd values are not given.
        let mut image = Image::on_track();
        image.tyre(2, [f32::NAN, 9000.0, f32::INFINITY], 1.0e9);
        image.f32(at::BRAKE_TEMP + 2 * BRAKE_TEMP_SIZE, 1.0e9);
        let tyres = frame_from(&image.0, 0.0).unwrap().tyres.unwrap();
        assert!(!tyres[2].known());
    }

    #[test]
    fn unchanged_data_is_skipped_and_a_change_is_taken() {
        let mut rig = Rig::new("same", Image::on_track());
        let mut reader = rig.reader();
        assert!(reader.next(NOW).is_some());
        assert!(reader.next(NOW).is_none(), "the same bytes: nothing new");
        assert!(reader.next(Duration::from_millis(25)).is_none(), "still nothing new after waiting");
        rig.image.f32(at::CAR_SPEED, 60.0);
        rig.publish();
        assert_eq!(reader.next(NOW).unwrap().speed_ms, 60.0);
        assert!(reader.next(NOW).is_none());
        // A change past the copied part (the drivers array) is not a new reading.
        rig.image.i32(at::NUM_CARS + 4, 12);
        rig.publish();
        assert!(reader.next(NOW).is_none());
    }

    /// Writes car `index` of the drivers array: name, slot, class, the places (overall, class), the share of the lap and the
    /// completed laps; the sector times and the time to the car in front are "not available" and the position is made up.
    fn write_driver(image: &mut Image, index: usize, name: &str, ids: (i32, i32), places: (i32, i32), lap: (f32, i32)) {
        let base = at::NUM_CARS + 4 + index * driver::SIZE;
        image.text(base + driver::NAME, name);
        image.i32(base + driver::SLOT_ID, ids.0);
        image.i32(base + driver::CLASS_ID, ids.1);
        image.i32(base + driver::PLACE, places.0);
        image.i32(base + driver::PLACE_CLASS, places.1);
        image.f32(base + driver::LAP_DISTANCE_FRACTION, lap.0);
        image.i32(base + driver::COMPLETED_LAPS, lap.1);
        for d in 0..3 {
            image.f32(base + driver::SECTOR_TIME_PREVIOUS_SELF + d * 4, -1.0);
        }
        image.f32(base + driver::TIME_DELTA_FRONT, -1.0);
        image.f32(base + driver::POSITION, 10.0 * (index + 1) as f32);
        image.f32(base + driver::POSITION + 4, 2.0);
        image.f32(base + driver::POSITION + 8, -30.0);
    }

    /// Three cars: the leader, the second (in the pit lane, another class, 4.25 s ahead of the third), and the player (third).
    fn three_cars() -> Image {
        let mut image = Image::on_track();
        image.i32(at::NUM_CARS, 3);
        image.i32(at::VEHICLE_INFO + at::DI_SLOT_ID, 7);
        write_driver(&mut image, 0, "Leader A", (5, 1703), (1, 1), (0.75, 4));
        write_driver(&mut image, 1, "Second", (9, 1704), (2, 1), (0.25, 3));
        write_driver(&mut image, 2, "Some Driver", (7, 1703), (3, 2), (0.5, 3));
        let first = at::NUM_CARS + 4;
        for (d, t) in [30.0, 31.0, 29.5].into_iter().enumerate() {
            image.f32(first + driver::SECTOR_TIME_PREVIOUS_SELF + d * 4, t);
        }
        let second = first + driver::SIZE;
        image.f32(second + driver::TIME_DELTA_FRONT, 4.25);
        image.i32(second + driver::IN_PITLANE, 1);
        let player = second + driver::SIZE;
        image.f32(player + driver::TIME_DELTA_FRONT, 1.5);
        for (d, v) in [100.5, 2.25, -300.75].into_iter().enumerate() {
            image.f32(player + driver::POSITION + d * 4, v);
        }
        image
    }

    #[test]
    fn reads_the_other_cars_into_a_field() {
        let image = three_cars();
        let frame = frame_from(&image.0, 12.5).unwrap();
        let first = at::NUM_CARS + 4;
        let field = drivers_field(7, &image.0[first..first + 3 * driver::SIZE], &frame).unwrap();
        assert_eq!(field.at_s, 12.5);
        let names: Vec<&str> = field.cars.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Leader A", "Second", "Some Driver"]);
        let slots: Vec<u16> = field.cars.iter().map(|c| c.slot).collect();
        assert_eq!(slots, [0, 1, 2]);
        let positions: Vec<Option<u16>> = field.cars.iter().map(|c| c.position).collect();
        assert_eq!(positions, [Some(1), Some(2), Some(3)]);
        let classes: Vec<(Option<&str>, Option<u16>)> = field.cars.iter().map(|c| (c.class.as_deref(), c.class_position)).collect();
        assert_eq!(
            classes,
            [
                (Some("R3E class 1703"), Some(1)),
                (Some("R3E class 1704"), Some(1)),
                (Some("R3E class 1703"), Some(2))
            ]
        );
        let shares: Vec<Option<f32>> = field.cars.iter().map(|c| c.lap_share).collect();
        assert_eq!(shares, [Some(0.75), Some(0.25), Some(0.5)]);
        let laps: Vec<Option<i32>> = field.cars.iter().map(|c| c.laps_done).collect();
        assert_eq!(laps, [Some(4), Some(3), Some(3)]);
        let pits: Vec<bool> = field.cars.iter().map(|c| c.in_pits).collect();
        assert_eq!(pits, [false, true, false]);
        let gaps: Vec<Option<f64>> = field.cars.iter().map(|c| c.gap_ahead_s).collect();
        assert_eq!(gaps, [None, Some(4.25), Some(1.5)]);
        // The header has no gap to the leader: it is the gaps ahead added up.
        let leader: Vec<Option<f64>> = field.cars.iter().map(|c| c.gap_leader_s).collect();
        assert_eq!(leader, [None, Some(4.25), Some(5.75)]);
        // The previous sectors add up to the leader's last lap; the player's own last lap is the player's.
        let last: Vec<Option<f64>> = field.cars.iter().map(|c| c.last_lap_s).collect();
        assert_eq!(last, [Some(90.5), None, Some(90.5)]);
        assert!(field.cars.iter().all(|c| c.best_lap_s.is_none()));
        let player: Vec<bool> = field.cars.iter().map(|c| c.is_player).collect();
        assert_eq!(player, [false, false, true]);
        assert_eq!(field.player().unwrap().world, Some([100.5, 2.25, -300.75]));
        assert_eq!(field.cars[0].world, Some([10.0, 2.0, -30.0]));
    }

    #[test]
    fn an_empty_slot_is_left_out_and_no_car_is_no_field() {
        let mut image = three_cars();
        let frame = frame_from(&image.0, 0.0).unwrap();
        let first = at::NUM_CARS + 4;
        // The second slot has no name and no place.
        let second = first + driver::SIZE;
        image.text(second + driver::NAME, "");
        image.i32(second + driver::PLACE, 0);
        let field = drivers_field(7, &image.0[first..first + 3 * driver::SIZE], &frame).unwrap();
        assert_eq!(field.cars.len(), 2);
        assert!(drivers_field(7, &[0; 3 * driver::SIZE], &frame).is_none());
        // No player slot known: nobody is marked.
        let field = drivers_field(-1, &three_cars().0[first..first + 3 * driver::SIZE], &frame).unwrap();
        assert!(field.player().is_none());
    }

    #[test]
    fn the_reader_publishes_the_field_with_a_frame_and_not_on_every_one() {
        let mut rig = Rig::new("field", three_cars());
        let mut reader = rig.reader();
        let frame = reader.next(NOW).unwrap();
        let field = frame.field.as_ref().expect("the first reading carries the other cars");
        assert_eq!(field.cars.len(), 3);
        crate::game::assert_frame_within_caps(&frame, CAPS, "r3e");
        assert!(frame.filled().has(Caps::RIVALS.or(Caps::RIVALS_WORLD)));
        // A reading straight after is inside the 200 ms: no field on it.
        rig.image.f32(at::CAR_SPEED, 60.0);
        rig.publish();
        assert!(reader.next(NOW).unwrap().field.is_none());
    }

    #[test]
    fn the_tank_is_the_header_capacity_and_not_available_is_not_given() {
        let frame = frame_from(&Image::on_track().0, 0.0).unwrap();
        assert_eq!((frame.fuel_l, frame.fuel_capacity_l), (42.5, Some(80.0)));
        for bad in [-1.0, 0.0, f32::NAN, 1.0e6] {
            let mut image = Image::on_track();
            image.f32(at::FUEL_CAPACITY, bad);
            assert_eq!(frame_from(&image.0, 0.0).unwrap().fuel_capacity_l, None, "capacity {bad}");
        }
    }

    #[test]
    fn a_copy_is_used_only_when_two_copies_taken_apart_are_the_same() {
        let a = vec![1u8, 2, 3];
        let b = vec![1u8, 2, 9];
        // Calm memory: the first pair is the same.
        let mut reads = 0;
        assert_eq!(
            norm::stable_copy(
                ATTEMPTS,
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
        assert_eq!(norm::stable_copy(ATTEMPTS, || script.next(), || {}), Some(b.clone()));
        // The game never stops writing: after the attempts there is no copy at all.
        let mut n = 0u8;
        let mut gaps = 0;
        assert_eq!(
            norm::stable_copy(
                ATTEMPTS,
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
        assert_eq!(norm::stable_copy(ATTEMPTS, || None, || {}), None);
    }

    #[test]
    fn a_reading_the_game_is_halfway_through_writing_is_never_used() {
        // The memory says 10 m/s and 10 rad/s. The game then writes a new reading (20 and 20), one field at a time,
        // in the gaps between the reader's copies: the first pair sees the first half written, the second the rest.
        let mut image = Image::on_track();
        image.f32(at::CAR_SPEED, 10.0);
        image.f32(at::ENGINE_RPS, 10.0);
        let rig = Rig::new("torn", image);
        let mut reader = rig.reader();
        let fake = rig.fake.clone();
        let mut step = 0;
        reader.between_copies = Some(Box::new(move || {
            match step {
                0 => fake.write(at::CAR_SPEED, &20.0f32.to_le_bytes()),
                1 => fake.write(at::ENGINE_RPS, &20.0f32.to_le_bytes()),
                _ => {}
            }
            step += 1;
        }));
        let frame = reader.next(NOW).expect("the finished reading");
        assert_eq!(frame.speed_ms, 20.0);
        assert!((frame.rpm - 20.0 * 60.0 / std::f32::consts::TAU).abs() < 1e-3, "rpm {}", frame.rpm);
        // A game that writes in every gap gives no reading at all rather than a torn one.
        let mut n = 0.0f32;
        let fake = rig.fake.clone();
        reader.between_copies = Some(Box::new(move || {
            n += 1.0;
            fake.write(at::CAR_SPEED, &n.to_le_bytes());
        }));
        assert!(reader.next(NOW).is_none());
    }

    #[test]
    fn a_memory_that_is_too_short_or_of_another_version_or_layout_is_refused() {
        let ok = Rig::new("ok", Image::on_track());
        assert!(R3e::open_named(&ok.fake.name).is_some());
        assert!(R3e::open_named("XpeedSimNoSuchR3eMemory").is_none());
        // Ten pages: Windows reports 40960, less than the struct needs.
        let short = FakeMemory::new("short", 40_960);
        short.write(0, &Image::on_track().0[..40_960]);
        assert!(R3e::open_named(&short.name).is_none());
        // Exactly the struct's size is enough (the mapping is rounded up to pages).
        let exact = FakeMemory::new("exact", SIZE);
        exact.write(0, &Image::on_track().0);
        assert!(R3e::open_named(&exact.name).is_some());
        // Another major version, or the game saying the drivers start elsewhere (a layout this reader does not know).
        for (field, value) in [
            (at::VERSION_MAJOR, 2),
            (at::VERSION_MAJOR, 4),
            (at::VERSION_MAJOR, 0),
            (at::VERSION_MAJOR, -1),
            (at::ALL_DRIVERS_OFFSET, 0),
            (at::ALL_DRIVERS_OFFSET, 2004),
            (at::ALL_DRIVERS_OFFSET, 2012),
        ] {
            let mut image = Image::on_track();
            image.i32(field, value);
            let rig = Rig::new("version", image);
            assert!(R3e::open_named(&rig.fake.name).is_none(), "{field} = {value}");
        }
        // Another minor version of the same layout is read.
        let mut image = Image::on_track();
        image.i32(4, 5);
        let rig = Rig::new("minor", image);
        assert!(R3e::open_named(&rig.fake.name).is_some());
        // A copy of another version (the memory changed under an open reader) gives nothing.
        let mut image = Image::on_track();
        image.i32(at::VERSION_MAJOR, 2);
        assert!(frame_from(&image.0, 0.0).is_none());
        assert!(frame_from(&Image::on_track().0[..HEAD - 1], 0.0).is_none());
        assert!(frame_from(&[], 0.0).is_none());
        // Only the copied part is needed.
        assert!(frame_from(&Image::on_track().0[..HEAD], 0.0).is_some());
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
        let put = |bytes: &mut Vec<u8>, at: usize, v: [u8; 4]| bytes[at..at + 4].copy_from_slice(&v);
        let mut given = 0;
        for round in 0..300 {
            let mut bytes: Vec<u8> = (0..HEAD).map(|_| next() as u8).collect();
            // Most rounds keep the version, the layout, the phase, the controller and the laps valid so the rest is read.
            if round % 3 != 0 {
                put(&mut bytes, at::VERSION_MAJOR, VERSION_MAJOR.to_le_bytes());
                put(&mut bytes, at::ALL_DRIVERS_OFFSET, (at::NUM_CARS as i32).to_le_bytes());
                put(&mut bytes, at::SESSION_PHASE, ((next() % 8) as i32 - 1).to_le_bytes());
                put(&mut bytes, at::CONTROL_TYPE, ((next() % 5) as i32 - 1).to_le_bytes());
                put(&mut bytes, at::COMPLETED_LAPS, ((next() % 1000) as i32 - 1).to_le_bytes());
                for flag in [at::GAME_PAUSED, at::GAME_IN_MENUS, at::GAME_IN_REPLAY, at::GAME_PLAYER_IN_GARAGE] {
                    put(&mut bytes, flag, ((next() % 4 == 0) as i32).to_le_bytes());
                }
                // Some floats in a range where they are believable, so the range checks below have something to check.
                let mut floats = vec![
                    at::CAR_SPEED,
                    at::ENGINE_RPS,
                    at::THROTTLE_RAW,
                    at::BRAKE_RAW,
                    at::CLUTCH_RAW,
                    at::STEER_INPUT_RAW,
                    at::FUEL_LEFT,
                    at::LAP_TIME_CURRENT_SELF,
                    at::LAP_TIME_PREVIOUS_SELF,
                    at::LAP_DISTANCE,
                    at::LAYOUT_LENGTH,
                ];
                for t in 0..4 {
                    floats.extend(tread_points(at::TIRE_TEMP + t * TIRE_TEMP_SIZE));
                    floats.push(at::TIRE_PRESSURE + t * 4);
                    floats.push(at::BRAKE_TEMP + t * BRAKE_TEMP_SIZE);
                }
                for float_at in floats {
                    let v = (next() % 4000) as f32 / 1000.0 - 2.0;
                    put(&mut bytes, float_at, v.to_le_bytes());
                }
            }
            let Some(f) = frame_from(&bytes, 1.0) else { continue };
            given += 1;
            assert!(f.lap >= 1 || !f.driving);
            for v in [f.throttle, f.brake, f.clutch] {
                assert!(v.is_nan() || (0.0..=1.0).contains(&v));
            }
            assert!(f.steer.is_nan() || (-1.0..=1.0).contains(&f.steer));
            assert!(f.speed_ms.is_nan() || (0.0..=1000.0).contains(&f.speed_ms));
            assert!(f.rpm.is_nan() || (0.0..=100_000.0).contains(&f.rpm));
            assert!(f.gear.is_nan() || (-1.0..=30.0).contains(&f.gear));
            assert!(f.fuel_l.is_nan() || (0.0..=10_000.0).contains(&f.fuel_l));
            assert!(f.dist_m.is_none_or(|d| d.is_finite() && d >= 0.0));
            assert!(f.lap_time_s.is_none_or(|t| t.is_finite() && t >= 0.0));
            assert!(f.last_lap_s.is_none_or(|t| t.is_finite() && t > 0.0));
            assert!(f.track_length_m.is_none_or(|t| t.is_finite() && t > 0.0));
            for t in f.tyres.iter().flatten() {
                assert!(t.temp_c.is_nan() || (-50.0..=400.0).contains(&t.temp_c));
                assert!(t.pressure_kpa.is_nan() || (0.0..=1000.0).contains(&t.pressure_kpa));
                assert!(t.left.is_nan());
                assert!(t.brake_c.is_nan() || (0.0..=2000.0).contains(&t.brake_c));
            }
            assert!(f.lap >= 0);
        }
        assert!(given > 50, "given {given}");
        // And bytes of every length, up to nothing, never panic.
        for len in [0, 1, 4, 12, 100, 1000, HEAD - 1] {
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
            rig.image.f32(at::LAP_TIME_CURRENT_SELF, 63.25 + i as f32 * 0.01);
            rig.publish();
            let frame = reader.next(Duration::from_millis(20)).expect("a frame");
            assert!(frame.clock_s >= last && frame.clock_s >= 0.0);
            last = frame.clock_s;
        }
    }

    #[test]
    fn the_door_is_alive_until_the_memory_stops_changing_or_changes_layout() {
        let mut rig = Rig::new("alive", Image::on_track());
        let mut reader = rig.reader();
        reader.stale_after = Duration::from_millis(80);
        assert!(reader.next(NOW).is_some() && reader.alive());
        // The game keeps writing: still alive well past the limit.
        for i in 0..6 {
            sleep(Duration::from_millis(30));
            rig.image.f32(at::LAP_TIME_CURRENT_SELF, 70.0 + i as f32);
            rig.publish();
            reader.next(NOW);
            assert!(reader.alive());
        }
        // Nothing changes any more (a menu, or the game is gone).
        sleep(Duration::from_millis(120));
        assert!(reader.next(NOW).is_none());
        assert!(!reader.alive());
        // Another reader, and the memory turns into another version under it: no frame, and the door is over.
        let mut reader = rig.reader();
        assert!(reader.next(NOW).is_some());
        rig.image.i32(at::VERSION_MAJOR, 4);
        rig.publish();
        assert!(reader.next(NOW).is_none());
        assert!(!reader.alive());
        rig.image.i32(at::VERSION_MAJOR, VERSION_MAJOR);
        rig.publish();
        assert!(reader.next(NOW).is_none(), "a refused door stays shut; the engine opens a new one");
    }

    /// One frame of a lap as the game would leave it in memory.
    fn lap_frame(rig: &mut Rig, completed: i32, lap_time: f32, last_lap: f32, valid_state: i32) {
        rig.image.i32(at::COMPLETED_LAPS, completed);
        rig.image.f32(at::LAP_TIME_CURRENT_SELF, lap_time);
        rig.image.f32(at::LAP_TIME_PREVIOUS_SELF, last_lap);
        rig.image.f32(at::LAP_DISTANCE, lap_time * 50.0);
        rig.image.f32(at::CAR_CG_LOCATION, lap_time * 10.0);
        rig.image.i32(at::LAP_VALID_STATE, valid_state);
        rig.publish();
    }

    fn drive_a_lap_through_the_reader(cut: bool) -> Vec<crate::lapfile::Lap> {
        let mut rig = Rig::new("lap", Image::on_track());
        let mut reader = rig.reader();
        let mut cutter = LapCutter::new(reader.game_id());
        let mut laps = Vec::new();
        let mut feed = |reader: &mut R3e, laps: &mut Vec<_>| {
            let frame = reader.next(Duration::from_millis(20)).expect("a frame");
            laps.extend(cutter.on_frame(&frame, 1_794_312_000_000));
        };
        // Lap 1 (no laps completed yet): 30 seconds at 20 Hz on the game's lap clock, no previous lap (-1).
        for i in 0..600 {
            let state = i32::from(cut && i >= 100);
            lap_frame(&mut rig, 0, i as f32 / 20.0, -1.0, state);
            feed(&mut reader, &mut laps);
        }
        // The line is crossed: one lap completed, the lap clock starts again, the previous lap is 30.0.
        for i in 0..20 {
            lap_frame(&mut rig, 1, i as f32 / 20.0, 30.0, 0);
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
            ("r3e", 1, 30_000, true)
        );
        assert_eq!(
            (lap.track_name.as_str(), lap.track_variant.as_deref()),
            ("Nürburgring", Some("Grand Prix"))
        );
        assert_eq!(
            (lap.car_name.as_str(), lap.car_class.as_deref()),
            ("R3E model 5031", Some("R3E class 1703"))
        );
        assert_eq!(lap.track_length_m, Some(5148.0));
        assert_eq!(lap.sample_count(), 600);
        let ids: Vec<&str> = lap.channels.iter().map(|c| c.id.as_str()).collect();
        // The 13 channels of version 1, then what version 2 adds that this game gives (the tyres, the brakes, the damage, the wing and the aids).
        assert_eq!(
            ids,
            [
                "t",
                "dist",
                "speed",
                "rpm",
                "gear",
                "throttle",
                "brake",
                "clutch",
                "steer",
                "x",
                "y",
                "z",
                "fuel",
                "tyre_temp_fl",
                "tyre_temp_fr",
                "tyre_temp_rl",
                "tyre_temp_rr",
                "tyre_press_fl",
                "tyre_press_fr",
                "tyre_press_rl",
                "tyre_press_rr",
                "brake_temp_fl",
                "brake_temp_fr",
                "brake_temp_rl",
                "brake_temp_rr",
                "damage_body",
                "drs",
                "tc_active",
                "abs_active"
            ]
        );
        assert_eq!(lap.channel("t").unwrap().values.last(), Some(&29.95));
        assert_eq!(lap.channel("speed").unwrap().values[0], 55.5);
        assert_eq!(lap.channel("fuel").unwrap().values[0], 42.5);
        assert_eq!(lap.channel("dist").unwrap().values[100], 250.0);
    }

    #[test]
    fn a_lap_the_game_called_invalid_is_kept_but_not_valid() {
        let laps = drive_a_lap_through_the_reader(true);
        assert_eq!((laps.len(), laps[0].time_ms, laps[0].valid), (1, 30_000, false));
    }
}
