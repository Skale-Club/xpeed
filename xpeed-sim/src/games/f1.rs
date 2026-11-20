//! EA SPORTS F1 25 (also with its 2026 Season Pack), F1 24 and F1 23: the UDP telemetry the games send to this
//! computer ("Data Out").
//!
//! The game only sends while it is running AND its telemetry output is switched on. The person has to set, in the
//! game: **Settings > Telemetry Settings**
//!
//! * UDP Telemetry: **On**
//! * UDP IP Address: the IP of this computer (`127.0.0.1` when the game runs on the same PC; with "Broadcast Mode"
//!   On the game ignores the address and sends to the whole network, which also reaches this program)
//! * UDP Port: **20777** (the games' default; this reader listens on it, on every local address)
//! * UDP Format: **the game's own year**: 2025 in F1 25 (or 2026, for those who own its Season Pack), 2024 in F1 24,
//!   2023 in F1 23. Each game also offers the formats of the years before it; the format decides how a packet is read
//!   and which game its laps are filed under, so F1 25 set to "2024" would be read, and its laps saved, as F1 24.
//!   Any other format (2022 and older) is refused.
//! * UDP Send Rate: 20 Hz or more (60 Hz gives the best laps; fewer packets means a coarser lap trace)
//!
//! One socket serves the three games: the `packetFormat` of every packet's header says which year's layout it has.
//! The game id follows it: `"f1"` for 2025 and for 2026 (the Season Pack is F1 25), `"f124"` for 2024, `"f123"` for
//! 2023.
//!
//! Sources. EA publishes each year's "UDP Specification" on the EA Sports F1 forum, but its site refuses automated
//! downloads (HTTP 403), so each year's layouts were taken from faithful copies of the official text and every size
//! below is the one the spec states (proven by the `sizes_*` tests, which sum the fields in the spec's order):
//!
//! * F1 25 (format 2025): EA's "F1 25 UDP Specification", Game Info Hub,
//!   <https://forums.ea.com/blog/f1-games-game-info-hub-en/f1%c2%ae-25-udp-specification/12187347>, cross-checked field
//!   by field against the community parser the spec itself is used with, `F1Game.UDP`
//!   (<https://github.com/volodymyr-fed/F1Game.UDP>, mirrored at `Addzyyy/open-f1-parser`).
//! * F1 25 with the 2026 Season Pack (format 2026): EA's "EA SPORTS F1 25 2026 Season Pack UDP Specification" (version
//!   11.0), same forum, <https://forums.ea.com/blog/f1-games-game-info-hub-en/ea-sports%E2%84%A2-f1%C2%AE25-2026-season-pack-udp-specification/12187347>.
//!   Copies used, two independent transcriptions that agree on every packet size and on the fields read here:
//!   `F1Game.UDP` (commit `df33608` "add support for 2026 Season Pack telemetry data", the `Data/` and `Packets/`
//!   structs and `Enums/Team.cs`, `Enums/Track.cs`) and `racehub-io/f1-telemetry-client` (0.3.0, `src/constants/
//!   packetSizes.ts`, the per-car parsers and `constants/teams.ts`, <https://github.com/racehub-io/f1-telemetry-client>);
//!   the Python bridge `Rbntje/FermaxoRacingDash` (`bridge.py`) also states the packet sizes. No recording of a real
//!   game was available: the layout is proven by the sizes (`sizes_of_2026`), not yet by a capture.
//! * F1 24 (format 2024): EA's "F1 24 UDP Specification",
//!   <https://forums.ea.com/discussions/f1-24-general-discussion-en/f1-24-udp-specification/8369125>. Copies used:
//!   `p403n1x87/f1-packets` (the official text as a C header, commit `9cb0b00` "add the new F1 24 spec", file
//!   `data/spec.h`, <https://github.com/p403n1x87/f1-packets>) and `MacManley/f1-24-udp` (the official document
//!   reproduced in its README, with the appendices, <https://github.com/MacManley/f1-24-udp>); the team table also
//!   matches `F1Game.UDP` tag `v24.1.0`.
//! * F1 23 (format 2023): EA's "F1 23 UDP Specification",
//!   <https://forums.ea.com/discussions/f1-23-en/f1-23-udp-specification/8390745>. Copies used: `p403n1x87/f1-packets`
//!   commit `26fa6a2` "add the new F1 23 spec" (`data/spec.h`) and `MacManley/f1-23-udp`
//!   (<https://github.com/MacManley/f1-23-udp>, README); the team table also matches `F1Game.UDP` tag `v23.2.0`.
//!
//! What is read (all little-endian, packed, no padding; every packet starts with the same 29-byte header in the
//! three years). Sizes in bytes, per format:
//!
//! | id | packet        | 2026 | 2025 | 2024 | 2023 | used for                                                             |
//! |----|---------------|------|------|------|------|----------------------------------------------------------------------|
//! | 0  | Motion        | 1325 | 1349 | 1349 | 1349 | world position x, y, z of the player's car                           |
//! | 1  | Session       | 926  | 753  | 753  | 644  | track id, track length, session type, spectating, total laps, time left |
//! | 2  | Lap Data      | 1399 | 1285 | 1285 | 1131 | lap time, last lap time, lap distance, lap number, pits, lap invalid, car position |
//! | 4  | Participants  | 1470 | 1284 | 1350 | 1306 | team id of the player's car (the car name), `numActiveCars`          |
//! | 6  | Car Telemetry | 1448 | 1352 | 1352 | 1352 | speed, throttle, steer, brake, clutch, gear, rpm: one `Frame` each   |
//!
//! What changes between the years, for these packets: the Session packet of 2023 has 56 weather forecast samples (64
//! later) and ends after `numRedFlagPeriods` (2024 added the rule settings, the weekend structure and the sector
//! starts); the Lap Data of 2023 gives the deltas to the car in front and to the leader as plain milliseconds (2024
//! split them into milliseconds and minutes) and has no speed trap fields, so every field after `sector2` sits
//! elsewhere; the participant's name is 48 bytes in 2023 and 2024 (32 in 2025), 2024 added `techLevel` and 2025 the
//! livery colours. Motion, Car Telemetry and the fields read from the header and from the start of the Session packet
//! are the same in the three years. The team ids differ (Appendix: Team IDs of each year).
//!
//! The 2026 Season Pack has 24 cars in every array (22 before), so every packet is longer: Motion's g-forces are i16
//! (54 bytes a car), Car Telemetry's `engineTemperature` a u8 (59), Car Status gains `ersHarvestLimitPerLap` (59), the
//! Participants' `driverId`, `networkId` and `teamId` are u16 (60), and the Session packet ends with the active aero
//! and DRS zones, the start reaction time and the assists (926). Lap Data and Car Damage keep the 2025 entries. The
//! 2026 team table adds the 2026 F1 cars (ids 476 to 486, with Audi and Cadillac) and the 2025 F2 teams; Madrid is
//! track 42.
//!
//! The race: `carPosition` of the player's Lap Data entry (1 is first; at 32 in the 2024 to 2026 entries, at 30 in 2023),
//! the Session packet's `totalLaps` (32, u8, the race length in laps) and `sessionTimeLeft` (38, u16, seconds; 0 is taken
//! as "none", because a session whose time has run out is over), and the Participants packet's `numActiveCars` (the
//! first byte after the header) as the number of cars. No class position: the formats have none (single class). Each goes
//! through `norm`. Not seen live: what the game writes in `totalLaps` and `sessionTimeLeft` in the sessions where they do
//! not apply (practice, a race that is lap-based) is ASSUMED to be 0.
//!
//! The rivals (`Frame::field`, at most every 200 ms): every car's Lap Data entry (position, `currentLapNum`, `lapDistance`
//! over the Session's track length, pit status, last lap, `deltaToCarInFront` and `deltaToRaceLeader`), the Participants'
//! names and the Motion world positions, for the first `numActiveCars` cars. No best lap (Lap Data has none) and no class.
//!
//! Car Status (1239 bytes in the three years before 2026, 1445 in it) and Car Damage (953 bytes in 2023 and 2024, 1041 in 2025, which added
//! `tyreBlisters[4]`) also feed the car's state: the aids, the brake bias, the pit limiter, the DRS permission and the
//! FIA flag from Car Status, the wing, floor, gearbox and engine damage (percentages) from Car Damage. Every other
//! packet (events, setups, history...) is ignored. Car Status gives the fuel as a mass in kilograms and the spec
//! states no density, so `fuel_l` stays NaN. The one `engineTemperature` of Car Telemetry is not said to be the
//! water's or the oil's, so neither is given; the spec has no suspension damage, headlights or handbrake.
//!
//! # Phase
//!
//! The game only sends packets while a session runs, and none in a menu or a pause, so the frames carry what the last
//! Session and Lap Data packets said (`Decoder::phase`): `Driving` (a known session and track, not spectating, an active
//! car out of the garage on a numbered lap), `Garage` (an active car in the garage), `Spectating` (the Session packet's
//! `isSpectating`), else `Unknown`. Not told: `Menu`, `Paused`, `Replay`, `Loading`. The telemetry is not withheld
//! outside `Driving`: the game fills it in the garage, and sends nothing where it would be stale.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::field::{self, Car, Field, FieldPace};
use crate::game::{Caps, CarState, Drs, Flag, Frame, Phase, Source};
use crate::games::udp::{Door, Wait};
use crate::norm;
use crate::shm::Page;

/// The port the game sends to unless the person changes it (the spec's default).
pub const DEFAULT_PORT: u16 = 20777;

const HEADER_SIZE: usize = 29;
/// Every per-car array of the spec has 22 entries in 2023 to 2025 (`Layout::cars`: 24 in 2026).
const CARS: usize = 22;

const ID_MOTION: u8 = 0;
const ID_SESSION: u8 = 1;
const ID_LAP_DATA: u8 = 2;
const ID_PARTICIPANTS: u8 = 4;
const ID_CAR_TELEMETRY: u8 = 6;
const ID_CAR_STATUS: u8 = 7;
const ID_CAR_DAMAGE: u8 = 10;

/// Sizes of one car's entry in the packets 2023 to 2025 share (`Layout` has the ones of the year):
/// `CarStatusData` is 55 bytes (`PacketCarStatusData` 1239), `CarMotionData` and `CarTelemetryData` 60.
const STATUS_CAR: usize = 55;
const MOTION_CAR: usize = 60;
const TELEMETRY_CAR: usize = 60;

// Header (offsets).
const H_FORMAT: usize = 0;
const H_PACKET_ID: usize = 6;
const H_SESSION_UID: usize = 7;
const H_PLAYER_CAR: usize = 27;

// Session packet (offsets from the start of the packet; the same in the three years).
const S_TRACK_LENGTH: usize = 33; // u16, metres
const S_SESSION_TYPE: usize = 35; // u8, 0 unknown
const S_TRACK_ID: usize = 36; // i8, -1 unknown
const S_IS_SPECTATING: usize = 44; // u8
const S_TOTAL_LAPS: usize = 32; // u8, 0 when the session has no lap count
const S_SESSION_TIME_LEFT: usize = 38; // u16, seconds

// Per-car fields (offsets from the start of the car's entry).
const M_POS_X: usize = 0; // f32 x3: worldPositionX, Y, Z (metres)

const L_LAST_LAP_MS: usize = 0; // u32, every year
const L_CURRENT_LAP_MS: usize = 4; // u32, every year

const T_SPEED_KMH: usize = 0; // u16
const T_THROTTLE: usize = 2; // f32 0..1
const T_STEER: usize = 6; // f32 -1..1
const T_BRAKE: usize = 10; // f32 0..1
const T_CLUTCH: usize = 14; // u8 0..100
const T_GEAR: usize = 15; // i8: -1 reverse, 0 neutral, 1..8
const T_RPM: usize = 16; // u16
const T_DRS: usize = 18; // u8: 0 off, 1 on

// Car Status (offsets from the start of the car's entry; the same in the three years).
const C_TRACTION_CONTROL: usize = 0; // u8: 0 off, 1 medium, 2 full
const C_ANTI_LOCK: usize = 1; // u8: 0 off, 1 on
const C_FRONT_BRAKE_BIAS: usize = 3; // u8, percentage
const C_PIT_LIMITER: usize = 4; // u8: 0 off, 1 on
const C_DRS_ALLOWED: usize = 22; // u8: 0 not allowed, 1 allowed
const C_FIA_FLAGS: usize = 28; // i8: -1 unknown, 0 none, 1 green, 2 blue, 3 yellow

// Car Damage (offsets inside the car's entry from `damage_wings`, the front left wing; every field is a percentage).
const D_FRONT_LEFT_WING: usize = 0;
const D_FRONT_RIGHT_WING: usize = 1;
const D_REAR_WING: usize = 2;
const D_FLOOR: usize = 3;
const D_DIFFUSER: usize = 4;
const D_SIDEPOD: usize = 5;
const D_GEARBOX: usize = 8;
const D_ENGINE: usize = 9;
const D_ENGINE_BLOWN: usize = 16;
const D_ENGINE_SEIZED: usize = 17;
/// The size of `CarDamageData` from `damage_wings` to its end.
const D_TAIL: usize = 18;

/// Where the Lap Data fields this reader uses sit in one car's entry (they move between the years).
#[derive(Debug)]
struct LapFields {
    distance: usize,      // f32, metres; negative before the line is first crossed
    position: usize,      // u8: carPosition, 1 is first
    lap_num: usize,       // u8
    pit_status: usize,    // u8: 0 none, 1 pitting, 2 in pit area
    invalid: usize,       // u8: 0 valid, 1 invalid
    driver_status: usize, // u8: 0 in garage, 1 flying lap, 2 in lap, 3 out lap, 4 on track
    result_status: usize, // u8: 0 invalid, 1 inactive, 2 active, 3 finished, ...
    delta_front: usize,   // u16 milliseconds (2024 on: followed by a u8 of minutes): the time to the car in front
    delta_leader: usize,  // the same for the time to the race leader
    delta_minutes: bool,  // 2024 and later: each delta has a minutes part after its milliseconds
}

/// What one year's packet format looks like, as far as this reader goes.
#[derive(Debug)]
struct Layout {
    /// The header's `packetFormat`.
    format: u16,
    game_id: &'static str,
    game_name: &'static str,
    /// The car name when the Participants packet has not come yet (or names a team the table does not have).
    short_name: &'static str,
    session_size: usize,
    /// The entries of every per-car array: 22 up to 2025, 24 in 2026.
    cars: usize,
    /// One car's entry in Motion, Car Telemetry and Car Status.
    motion_car: usize,
    telemetry_car: usize,
    status_car: usize,
    /// Where `teamId` sits in a participant's entry and whether it is a u16 (2026) or a u8.
    team_id_at: usize,
    team_id_u16: bool,
    /// One car's entry in Lap Data, and where its fields are.
    lap_car: usize,
    lap: LapFields,
    /// One car's entry in Participants, and where the driver's name (a zero-ended UTF-8 `name[..]`) is in it.
    participant_car: usize,
    name_at: usize,
    name_len: usize,
    /// Where `frontLeftWingDamage` sits in a `CarDamageData`: after tyresWear[4] (f32), tyresDamage[4] and
    /// brakesDamage[4], and in 2025 also tyreBlisters[4]. The entry ends `D_TAIL` bytes later.
    damage_wings: usize,
    /// The year's Appendix: Team IDs, with the class each team races in.
    team: fn(u16) -> Option<(&'static str, &'static str)>,
}

impl Layout {
    /// Lap Data: the 22 entries, then timeTrialPBCarIdx and timeTrialRivalCarIdx.
    const fn lap_data_size(&self) -> usize {
        HEADER_SIZE + self.cars * self.lap_car + 2
    }

    const fn motion_size(&self) -> usize {
        HEADER_SIZE + self.cars * self.motion_car
    }

    /// Car Telemetry: the entries, then mfdPanelIndex x2 and suggestedGear.
    const fn telemetry_size(&self) -> usize {
        HEADER_SIZE + self.cars * self.telemetry_car + 3
    }

    const fn status_size(&self) -> usize {
        HEADER_SIZE + self.cars * self.status_car
    }

    /// Participants: numActiveCars, then the 22 entries.
    const fn participants_size(&self) -> usize {
        HEADER_SIZE + 1 + self.cars * self.participant_car
    }

    /// The size the spec gives for a packet this reader uses; `None` for every packet it does not read.
    fn expected_size(&self, packet_id: u8) -> Option<usize> {
        match packet_id {
            ID_MOTION => Some(self.motion_size()),
            ID_SESSION => Some(self.session_size),
            ID_LAP_DATA => Some(self.lap_data_size()),
            ID_PARTICIPANTS => Some(self.participants_size()),
            ID_CAR_TELEMETRY => Some(self.telemetry_size()),
            ID_CAR_STATUS => Some(self.status_size()),
            ID_CAR_DAMAGE => Some(HEADER_SIZE + self.cars * (self.damage_wings + D_TAIL)),
            _ => None,
        }
    }
}

/// F1 25. LapData (57 bytes): the two lap times, the sector times and the deltas (each as milliseconds u16 + minutes
/// u8), so lapDistance is at 20 and carPosition at 32, ..., speedTrapFastestSpeed f32, speedTrapFastestLap u8.
/// ParticipantData (57 bytes): name[32], techLevel, numColours, liveryColours[4].
const F1_25: Layout = Layout {
    format: 2025,
    game_id: "f1",
    game_name: "EA SPORTS F1 25",
    short_name: "F1 25",
    session_size: 753,
    cars: CARS,
    motion_car: MOTION_CAR,
    telemetry_car: TELEMETRY_CAR,
    status_car: STATUS_CAR,
    team_id_at: 3,
    team_id_u16: false,
    lap_car: 57,
    lap: LapFields {
        distance: 20,
        position: 32,
        lap_num: 33,
        pit_status: 34,
        invalid: 37,
        driver_status: 44,
        result_status: 45,
        delta_front: 14,
        delta_leader: 17,
        delta_minutes: true,
    },
    participant_car: 57,
    name_at: 7,
    name_len: 32,
    damage_wings: 28,
    team: team_25,
};

/// F1 24: the Session and Lap Data of F1 25; ParticipantData (60 bytes) has name[48] and techLevel, no livery.
const F1_24: Layout = Layout {
    format: 2024,
    game_id: "f124",
    game_name: "EA SPORTS F1 24",
    short_name: "F1 24",
    session_size: 753,
    cars: CARS,
    motion_car: MOTION_CAR,
    telemetry_car: TELEMETRY_CAR,
    status_car: STATUS_CAR,
    team_id_at: 3,
    team_id_u16: false,
    lap_car: 57,
    lap: LapFields {
        distance: 20,
        position: 32,
        lap_num: 33,
        pit_status: 34,
        invalid: 37,
        driver_status: 44,
        result_status: 45,
        delta_front: 14,
        delta_leader: 17,
        delta_minutes: true,
    },
    participant_car: 60,
    name_at: 7,
    name_len: 48,
    damage_wings: 24,
    team: team_24,
};

/// F1 23. LapData (50 bytes): the deltas to the car in front and to the leader are plain u16 milliseconds, so
/// lapDistance is at 18 and carPosition at 30; no speed trap fields. ParticipantData (58 bytes): name[48], no
/// techLevel. The Session packet ends after numRedFlagPeriods (644 bytes).
const F1_23: Layout = Layout {
    format: 2023,
    game_id: "f123",
    game_name: "EA SPORTS F1 23",
    short_name: "F1 23",
    session_size: 644,
    cars: CARS,
    motion_car: MOTION_CAR,
    telemetry_car: TELEMETRY_CAR,
    status_car: STATUS_CAR,
    team_id_at: 3,
    team_id_u16: false,
    lap_car: 50,
    lap: LapFields {
        distance: 18,
        position: 30,
        lap_num: 31,
        pit_status: 32,
        invalid: 35,
        driver_status: 42,
        result_status: 43,
        delta_front: 14,
        delta_leader: 16,
        delta_minutes: false,
    },
    participant_car: 58,
    name_at: 7,
    name_len: 48,
    damage_wings: 24,
    team: team_23,
};

/// F1 25 with the 2026 Season Pack ("UDP Format: 2026"): the game is F1 25, so its laps are filed as `"f1"`. 24 cars
/// per array. CarMotionData is 54 bytes (the three g-forces are i16 in thousandths), CarTelemetryData 59
/// (`engineTemperature` is a u8), CarStatusData 59 (`ersHarvestLimitPerLap` f32 before `ersDeployedThisLap`),
/// ParticipantData 60 (`driverId`, `networkId` and `teamId` are u16). LapData (57 bytes), CarDamageData (46 bytes)
/// and the start of the Session packet (926 bytes: it adds the active aero and DRS zones, the start reaction time
/// and the assists) are laid out as in F1 25.
const F1_25_2026: Layout = Layout {
    format: 2026,
    game_id: "f1",
    game_name: "EA SPORTS F1 25",
    short_name: "F1 25",
    session_size: 926,
    cars: 24,
    motion_car: 54,
    telemetry_car: 59,
    status_car: 59,
    team_id_at: 5,
    team_id_u16: true,
    lap_car: 57,
    lap: LapFields {
        distance: 20,
        position: 32,
        lap_num: 33,
        pit_status: 34,
        invalid: 37,
        driver_status: 44,
        result_status: 45,
        delta_front: 14,
        delta_leader: 17,
        delta_minutes: true,
    },
    participant_car: 60,
    name_at: 10,
    name_len: 32,
    damage_wings: 28,
    team: team_26,
};

/// The formats read, newest first.
const LAYOUTS: [&Layout; 4] = [&F1_25_2026, &F1_25, &F1_24, &F1_23];

/// The layout of a packet format; `None` for a format this reader does not read.
fn layout_of(format: u16) -> Option<&'static Layout> {
    LAYOUTS.into_iter().find(|l| l.format == format)
}

/// The game a source names itself after before any packet has come: the one whose program is running (F1 25 when
/// none of them is, or when more than one is).
fn layout_of_programs(running: &[String]) -> &'static Layout {
    let year = |exe: &str| running.iter().any(|r| r == exe);
    match (year("f1_25.exe"), year("f1_24.exe"), year("f1_23.exe")) {
        (false, true, false) => &F1_24,
        (false, false, true) => &F1_23,
        _ => &F1_25,
    }
}

/// The header fields this reader needs.
#[derive(Clone, Copy, Debug)]
struct Header {
    layout: &'static Layout,
    packet_id: u8,
    session_uid: u64,
    player_car: usize,
}

impl Header {
    /// `None` unless the bytes start with a header of a format this reader reads (2026, 2025, 2024, 2023).
    fn parse(data: &[u8]) -> Option<Header> {
        if data.len() < HEADER_SIZE {
            return None;
        }
        let p = Page(data);
        Some(Header {
            layout: layout_of(p.u16_at(H_FORMAT))?,
            packet_id: p.u8_at(H_PACKET_ID),
            session_uid: p.u64_at(H_SESSION_UID),
            player_car: usize::from(p.u8_at(H_PLAYER_CAR)),
        })
    }
}

/// The track name of the spec's table (Appendix: Track IDs; ids 0 to 32 are the same in 2023, 2024 and 2025). An id
/// the table does not have is named by its number.
fn track_name(id: i8) -> String {
    let name = match id {
        0 => "Melbourne",
        1 => "Paul Ricard",
        2 => "Shanghai",
        3 => "Sakhir (Bahrain)",
        4 => "Catalunya",
        5 => "Monaco",
        6 => "Montreal",
        7 => "Silverstone",
        8 => "Hockenheim",
        9 => "Hungaroring",
        10 => "Spa",
        11 => "Monza",
        12 => "Singapore",
        13 => "Suzuka",
        14 => "Abu Dhabi",
        15 => "Texas",
        16 => "Brazil",
        17 => "Austria",
        18 => "Sochi",
        19 => "Mexico",
        20 => "Baku (Azerbaijan)",
        21 => "Sakhir Short",
        22 => "Silverstone Short",
        23 => "Texas Short",
        24 => "Suzuka Short",
        25 => "Hanoi",
        26 => "Zandvoort",
        27 => "Imola",
        28 => "Portimao",
        29 => "Jeddah",
        30 => "Miami",
        31 => "Las Vegas",
        32 => "Losail",
        39 => "Silverstone (Reverse)",
        40 => "Austria (Reverse)",
        41 => "Zandvoort (Reverse)",
        42 => "Madrid",
        _ => return format!("Track {id}"),
    };
    name.to_owned()
}

/// The team of the F1 25 table (Appendix: Team IDs) and the class it races in. `None` for an id the table does not
/// have (the 2026 Season Pack adds teams the 2025 format does not name).
fn team_25(id: u16) -> Option<(&'static str, &'static str)> {
    let name = match id {
        0 => "Mercedes",
        1 => "Ferrari",
        2 => "Red Bull Racing",
        3 => "Williams",
        4 => "Aston Martin",
        5 => "Alpine",
        6 => "RB",
        7 => "Haas",
        8 => "McLaren",
        9 => "Sauber",
        41 => "F1 Generic",
        104 => "F1 Custom Team",
        143 => "ART GP '23",
        144 => "Campos '23",
        145 => "Carlin '23",
        146 => "PHM '23",
        147 => "Dams '23",
        148 => "Hitech '23",
        149 => "MP Motorsport '23",
        150 => "Prema '23",
        151 => "Trident '23",
        152 => "Van Amersfoort Racing '23",
        153 => "Virtuosi '23",
        158 => "ART GP '24",
        159 => "Campos '24",
        160 => "Rodin '24",
        161 => "PHM '24",
        162 => "Dams '24",
        163 => "Hitech '24",
        164 => "MP Motorsport '24",
        165 => "Prema '24",
        166 => "Trident '24",
        167 => "Van Amersfoort Racing '24",
        168 => "Invicta '24",
        _ => return None,
    };
    Some((name, if id >= 143 { "F2" } else { "F1" }))
}

/// The 2026 Season Pack's table: the one of F1 25, the 2025 F2 teams (465 to 475) and the 2026 F1 cars (476 to 486,
/// which include the two new teams, Audi and Cadillac). Ids 0 to 9 name the 2025 grid in this format too.
fn team_26(id: u16) -> Option<(&'static str, &'static str)> {
    let name = match id {
        465 => "ART GP '25",
        466 => "Campos '25",
        467 => "Rodin '25",
        468 => "AIX Racing '25",
        469 => "Dams '25",
        470 => "Hitech '25",
        471 => "MP Motorsport '25",
        472 => "Prema '25",
        473 => "Trident '25",
        474 => "Van Amersfoort Racing '25",
        475 => "Invicta '25",
        476 => "Mercedes '26",
        477 => "Ferrari '26",
        478 => "Red Bull Racing '26",
        479 => "Williams '26",
        480 => "Aston Martin '26",
        481 => "Alpine '26",
        482 => "RB '26",
        483 => "Haas '26",
        484 => "McLaren '26",
        485 => "Audi '26",
        486 => "Cadillac '26",
        _ => return team_25(id),
    };
    Some((name, if id <= 475 { "F2" } else { "F1" }))
}

/// The F1 24 table: the one of F1 25 without the 2024 F2 teams (158 to 168), which F1 24 does not have.
fn team_24(id: u16) -> Option<(&'static str, &'static str)> {
    match id {
        158..=168 => None,
        _ => team_25(id),
    }
}

/// The F1 23 table, with the class each car races in: the F2 teams of 2021 and 2022 are F2, the road and safety
/// cars are Supercars (the name of their formula in the Session packet), the rest is F1.
fn team_23(id: u16) -> Option<(&'static str, &'static str)> {
    let name = match id {
        0 => "Mercedes",
        1 => "Ferrari",
        2 => "Red Bull Racing",
        3 => "Williams",
        4 => "Aston Martin",
        5 => "Alpine",
        6 => "Alpha Tauri",
        7 => "Haas",
        8 => "McLaren",
        9 => "Alfa Romeo",
        85 => "Mercedes 2020",
        86 => "Ferrari 2020",
        87 => "Red Bull 2020",
        88 => "Williams 2020",
        89 => "Racing Point 2020",
        90 => "Renault 2020",
        91 => "Alpha Tauri 2020",
        92 => "Haas 2020",
        93 => "McLaren 2020",
        94 => "Alfa Romeo 2020",
        95 => "Aston Martin DB11 V12",
        96 => "Aston Martin Vantage F1 Edition",
        97 => "Aston Martin Vantage Safety Car",
        98 => "Ferrari F8 Tributo",
        99 => "Ferrari Roma",
        100 => "McLaren 720S",
        101 => "McLaren Artura",
        102 => "Mercedes AMG GT Black Series Safety Car",
        103 => "Mercedes AMG GTR Pro",
        104 => "F1 Custom Team",
        106 => "Prema '21",
        107 => "Uni-Virtuosi '21",
        108 => "Carlin '21",
        109 => "Hitech '21",
        110 => "Art GP '21",
        111 => "MP Motorsport '21",
        112 => "Charouz '21",
        113 => "Dams '21",
        114 => "Campos '21",
        115 => "BWT '21",
        116 => "Trident '21",
        117 => "Mercedes AMG GT Black Series",
        118 => "Mercedes '22",
        119 => "Ferrari '22",
        120 => "Red Bull Racing '22",
        121 => "Williams '22",
        122 => "Aston Martin '22",
        123 => "Alpine '22",
        124 => "Alpha Tauri '22",
        125 => "Haas '22",
        126 => "McLaren '22",
        127 => "Alfa Romeo '22",
        128 => "Konnersport '22",
        129 => "Konnersport",
        130 => "Prema '22",
        131 => "Virtuosi '22",
        132 => "Carlin '22",
        133 => "MP Motorsport '22",
        134 => "Charouz '22",
        135 => "Dams '22",
        136 => "Campos '22",
        137 => "Van Amersfoort Racing '22",
        138 => "Trident '22",
        139 => "Hitech '22",
        140 => "Art GP '22",
        _ => return None,
    };
    let class = match id {
        106..=116 | 130..=140 => "F2",
        95..=103 | 117 => "Supercar",
        _ => "F1",
    };
    Some((name, class))
}

#[derive(Clone, Copy, Debug)]
struct SessionInfo {
    session_type: u8,
    track_id: i8,
    track_length_m: u16,
    spectating: bool,
    total_laps: u8,
    time_left_s: u16,
}

/// What Car Status says of the player's car.
#[derive(Clone, Copy, Debug)]
struct StatusInfo {
    traction_control: u8,
    anti_lock: u8,
    front_brake_bias: u8,
    pit_limiter: u8,
    drs_allowed: u8,
    fia_flag: i8,
}

/// What Car Damage says of the player's car (percentages, 0..100).
#[derive(Clone, Copy, Debug)]
struct DamageInfo {
    /// The worst of the two front wings, the rear wing, the floor, the diffuser and the sidepod.
    body: u8,
    gearbox: u8,
    engine: u8,
    engine_gone: bool,
}

#[derive(Clone, Copy, Debug)]
struct LapInfo {
    last_lap_ms: u32,
    current_lap_ms: u32,
    distance_m: f32,
    position: u8,
    lap_number: u8,
    pit_status: u8,
    invalid: bool,
    driver_status: u8,
    result_status: u8,
}

/// What the Lap Data packet says of one car (any car, not only the player's).
#[derive(Clone, Copy, Debug)]
struct RivalLap {
    last_lap_ms: u32,
    distance_m: f32,
    position: u8,
    lap_number: u8,
    pit_status: u8,
    result_status: u8,
    /// The time to the car in front and to the leader, in milliseconds.
    delta_front_ms: u32,
    delta_leader_ms: u32,
}

/// What the packets of one session say of one car: its name (Participants), its lap data and its world position (Motion).
#[derive(Clone, Debug, Default)]
struct Rival {
    name: String,
    lap: Option<RivalLap>,
    world: Option<[f32; 3]>,
}

/// A time of the Lap Data packet: the milliseconds part, and from 2024 on the minutes part after it.
fn delta_ms(page: &Page, at: usize, with_minutes: bool) -> u32 {
    let ms = u32::from(page.u16_at(at));
    if with_minutes {
        ms + 60_000 * u32::from(page.u8_at(at + 2))
    } else {
        ms
    }
}

/// Turns the packets of one game session into frames: keeps the latest Motion, Session, Lap Data and Participants of
/// the player's car, and builds a `Frame` whenever a Car Telemetry packet comes.
#[derive(Default)]
struct Decoder {
    /// The format of the packets read so far (`None` before the first one).
    layout: Option<&'static Layout>,
    session_uid: Option<u64>,
    session: Option<SessionInfo>,
    lap: Option<LapInfo>,
    position: Option<[f32; 3]>,
    team_id: Option<u16>,
    /// `numActiveCars` of the last Participants packet.
    active_cars: Option<u8>,
    status: Option<StatusInfo>,
    damage: Option<DamageInfo>,
    /// Every car's latest names, lap data and positions, by car index (the rivals layer).
    rivals: Vec<Rival>,
    /// When the other cars are published with a frame (a few Hz, not on every telemetry packet).
    pace: FieldPace,
}

impl Decoder {
    /// Reads one datagram. Returns a frame when it was a Car Telemetry packet of a format this reader reads and the
    /// right size for that format. Never panics, whatever the bytes are.
    fn feed(&mut self, data: &[u8], clock_s: f64) -> Option<Frame> {
        let header = Header::parse(data)?;
        let layout = header.layout;
        let size = layout.expected_size(header.packet_id)?;
        if data.len() != size || header.player_car >= layout.cars {
            return None;
        }
        // Another session (a new race, a restart) or another game's format: nothing from before may leak into it.
        let same_format = self.layout.is_some_and(|l| l.format == layout.format);
        if !same_format || self.session_uid != Some(header.session_uid) {
            *self = Decoder::default();
            self.layout = Some(layout);
            self.session_uid = Some(header.session_uid);
        }
        let page = Page(data);
        let at = |entry: usize| HEADER_SIZE + header.player_car * entry;
        match header.packet_id {
            ID_MOTION => {
                let base = at(layout.motion_car) + M_POS_X;
                self.position = Some([page.f32_at(base), page.f32_at(base + 4), page.f32_at(base + 8)]);
                self.rivals.resize(layout.cars, Rival::default());
                for (i, rival) in self.rivals.iter_mut().enumerate() {
                    let at = HEADER_SIZE + i * layout.motion_car + M_POS_X;
                    rival.world = Some([page.f32_at(at), page.f32_at(at + 4), page.f32_at(at + 8)]);
                }
                None
            }
            ID_SESSION => {
                self.session = Some(SessionInfo {
                    session_type: page.u8_at(S_SESSION_TYPE),
                    track_id: page.i8_at(S_TRACK_ID),
                    track_length_m: page.u16_at(S_TRACK_LENGTH),
                    spectating: page.u8_at(S_IS_SPECTATING) != 0,
                    total_laps: page.u8_at(S_TOTAL_LAPS),
                    time_left_s: page.u16_at(S_SESSION_TIME_LEFT),
                });
                None
            }
            ID_LAP_DATA => {
                let car = at(layout.lap_car);
                let f = &layout.lap;
                self.lap = Some(LapInfo {
                    last_lap_ms: page.u32_at(car + L_LAST_LAP_MS),
                    current_lap_ms: page.u32_at(car + L_CURRENT_LAP_MS),
                    distance_m: page.f32_at(car + f.distance),
                    position: page.u8_at(car + f.position),
                    lap_number: page.u8_at(car + f.lap_num),
                    pit_status: page.u8_at(car + f.pit_status),
                    invalid: page.u8_at(car + f.invalid) != 0,
                    driver_status: page.u8_at(car + f.driver_status),
                    result_status: page.u8_at(car + f.result_status),
                });
                self.rivals.resize(layout.cars, Rival::default());
                for (i, rival) in self.rivals.iter_mut().enumerate() {
                    let car = HEADER_SIZE + i * layout.lap_car;
                    rival.lap = Some(RivalLap {
                        last_lap_ms: page.u32_at(car + L_LAST_LAP_MS),
                        distance_m: page.f32_at(car + f.distance),
                        position: page.u8_at(car + f.position),
                        lap_number: page.u8_at(car + f.lap_num),
                        pit_status: page.u8_at(car + f.pit_status),
                        result_status: page.u8_at(car + f.result_status),
                        delta_front_ms: delta_ms(&page, car + f.delta_front, f.delta_minutes),
                        delta_leader_ms: delta_ms(&page, car + f.delta_leader, f.delta_minutes),
                    });
                }
                None
            }
            ID_PARTICIPANTS => {
                // numActiveCars comes first, then the entries.
                self.active_cars = Some(page.u8_at(HEADER_SIZE));
                self.rivals.resize(layout.cars, Rival::default());
                for (i, rival) in self.rivals.iter_mut().enumerate() {
                    let at = HEADER_SIZE + 1 + i * layout.participant_car + layout.name_at;
                    rival.name = page.ascii_at(at, layout.name_len);
                }
                let entry = HEADER_SIZE + 1 + header.player_car * layout.participant_car + layout.team_id_at;
                self.team_id = Some(if layout.team_id_u16 {
                    page.u16_at(entry)
                } else {
                    u16::from(page.u8_at(entry))
                });
                None
            }
            ID_CAR_STATUS => {
                let car = at(layout.status_car);
                self.status = Some(StatusInfo {
                    traction_control: page.u8_at(car + C_TRACTION_CONTROL),
                    anti_lock: page.u8_at(car + C_ANTI_LOCK),
                    front_brake_bias: page.u8_at(car + C_FRONT_BRAKE_BIAS),
                    pit_limiter: page.u8_at(car + C_PIT_LIMITER),
                    drs_allowed: page.u8_at(car + C_DRS_ALLOWED),
                    fia_flag: page.i8_at(car + C_FIA_FLAGS),
                });
                None
            }
            ID_CAR_DAMAGE => {
                let car = at(layout.damage_wings + D_TAIL) + layout.damage_wings;
                let b = |off: usize| page.u8_at(car + off);
                let body = [D_FRONT_LEFT_WING, D_FRONT_RIGHT_WING, D_REAR_WING, D_FLOOR, D_DIFFUSER, D_SIDEPOD]
                    .into_iter()
                    .map(b)
                    .max()
                    .unwrap_or(0);
                self.damage = Some(DamageInfo {
                    body,
                    gearbox: b(D_GEARBOX),
                    engine: b(D_ENGINE),
                    engine_gone: b(D_ENGINE_BLOWN) != 0 || b(D_ENGINE_SEIZED) != 0,
                });
                None
            }
            ID_CAR_TELEMETRY => {
                let mut frame = self.frame(layout, &page, at(layout.telemetry_car), clock_s);
                if self.pace.due(clock_s) {
                    frame.field = self.field(header.player_car, &frame);
                }
                Some(frame)
            }
            _ => None,
        }
    }

    /// The cars of the session: the first `numActiveCars` entries (the game fills the arrays from index 0) that have lap data and
    /// whose result status is not "invalid" or "inactive" (0, 1). Per car: the name (a car with none is "Car <n>"), the
    /// position, the laps done (`currentLapNum` - 1), the lap distance over the track's length (the share of the lap), the
    /// pit status, the last lap, the gaps (the time to the car in front, and to the leader, only where above 0: the
    /// game writes 0 for a leader and in a session with no gaps) and the world position. No best lap (Lap Data has none), no
    /// class (a single class: `Frame::car_class` has the player's team).
    fn field(&self, player: usize, frame: &Frame) -> Option<Arc<Field>> {
        let active = usize::from(self.active_cars?);
        let mut cars = Vec::new();
        for (slot, rival) in self.rivals.iter().enumerate().take(active) {
            let Some(lap) = rival.lap.filter(|l| l.result_status >= 2) else {
                continue;
            };
            let name = if rival.name.is_empty() {
                format!("Car {}", slot + 1)
            } else {
                rival.name.clone()
            };
            let mut car = Car::named(slot as u16, &name);
            car.position = norm::place(lap.position, frame.cars);
            car.laps_done = lap.lap_number.checked_sub(1).map(i32::from);
            if let Some(length) = frame.track_length_m {
                car.lap_share = field::lap_share(f64::from(lap.distance_m.max(0.0)), length);
            }
            car.in_pits = lap.pit_status != 0;
            car.last_lap_s = (lap.last_lap_ms > 0).then(|| f64::from(lap.last_lap_ms) / 1000.0);
            let first = lap.position == 1;
            car.gap_ahead_s = (!first && lap.delta_front_ms > 0).then(|| f64::from(lap.delta_front_ms) / 1000.0);
            car.gap_leader_s = (!first && lap.delta_leader_ms > 0).then(|| f64::from(lap.delta_leader_ms) / 1000.0);
            car.world = rival.world.filter(|w| w.iter().all(|c| norm::position(*c).is_finite()));
            car.is_player = slot == player;
            cars.push(car);
        }
        (!cars.is_empty()).then(|| field::publish(cars, frame.clock_s, frame.track_length_m))
    }

    fn frame(&self, layout: &Layout, page: &Page, car: usize, clock_s: f64) -> Frame {
        let mut f = Frame::empty();
        f.clock_s = clock_s;

        let speed_kmh = page.u16_at(car + T_SPEED_KMH);
        f.speed_ms = f32::from(speed_kmh) / 3.6;
        f.rpm = f32::from(page.u16_at(car + T_RPM));
        let gear = page.i8_at(car + T_GEAR);
        // -1 reverse, 0 neutral, 1..8; anything else is not a gear.
        f.gear = if gear <= 8 { norm::gear(i32::from(gear)) } else { f32::NAN };
        f.throttle = norm::pedal(page.f32_at(car + T_THROTTLE));
        f.brake = norm::pedal(page.f32_at(car + T_BRAKE));
        f.steer = norm::steer(page.f32_at(car + T_STEER));
        f.clutch = norm::pedal(f32::from(page.u8_at(car + T_CLUTCH)) / 100.0);
        f.state = self.state(page.u8_at(car + T_DRS));

        if let Some([x, y, z]) = self.position {
            (f.x, f.y, f.z) = (x, y, z);
        }
        match self.team_id.and_then(layout.team) {
            Some((name, class)) => {
                f.car = name.to_owned();
                f.car_class = Some(class.to_owned());
            }
            None => {
                f.car = layout.short_name.to_owned();
                f.car_class = Some("F1".to_owned());
            }
        }
        if let Some(s) = &self.session {
            if s.track_id >= 0 {
                f.track = track_name(s.track_id);
            }
            f.track_length_m = (s.track_length_m > 0).then_some(f64::from(s.track_length_m));
            f.session_laps = norm::race_laps(s.total_laps);
            f.session_time_left_s = norm::time_left_s(f64::from(s.time_left_s)).filter(|t| *t > 0.0);
        }
        f.cars = self.active_cars.and_then(norm::cars);
        if let Some(l) = &self.lap {
            f.lap = i32::from(l.lap_number);
            f.lap_time_s = Some(f64::from(l.current_lap_ms) / 1000.0);
            f.last_lap_s = (l.last_lap_ms > 0).then(|| f64::from(l.last_lap_ms) / 1000.0);
            f.lap_valid = Some(!l.invalid);
            f.dist_m = l.distance_m.is_finite().then(|| f64::from(l.distance_m.max(0.0)));
            f.in_pits = l.pit_status != 0;
            f.race_position = norm::place(l.position, f.cars);
        }
        f.set_phase(self.phase());
        // Every frame the reader tests make is held to the caps and the phase invariant.
        #[cfg(test)]
        crate::game::assert_frame_within_caps(&f, CAPS, "f1");
        f
    }

    /// The car's state from Car Status and Car Damage (`None`s until those packets have come) and the DRS flag of the
    /// telemetry packet. Percentages become 0..1; a percentage above 100 is not one.
    fn state(&self, drs_on: u8) -> CarState {
        let mut state = CarState::UNKNOWN;
        let percent = |v: u8| (v <= 100).then(|| f32::from(v) / 100.0);
        if let Some(s) = &self.status {
            state.pit_limiter = (s.pit_limiter <= 1).then_some(s.pit_limiter == 1);
            // The settings: traction control 0 off, 1 medium, 2 full; ABS 0 off, 1 on.
            state.tc_level = (s.traction_control <= 2).then_some(s.traction_control);
            state.abs_level = (s.anti_lock <= 1).then_some(s.anti_lock);
            state.brake_bias = percent(s.front_brake_bias).filter(|b| *b > 0.0);
            state.drs = Some(if drs_on == 1 {
                Drs::Open
            } else if s.drs_allowed == 1 {
                Drs::Available
            } else {
                Drs::Off
            });
            state.flag = norm::flag_code(i64::from(s.fia_flag), &[(1, Flag::Green), (2, Flag::Blue), (3, Flag::Yellow)]);
        }
        if let Some(d) = &self.damage {
            state.damage_body = percent(d.body);
            state.damage_gearbox = percent(d.gearbox);
            state.damage_engine = percent(d.engine);
            state.engine_warning = Some(d.engine_gone);
        }
        state
    }

    /// In a car on a track session: the game gave a session (a known track, not "unknown", not spectating) and lap
    /// data saying the player's car is out of the garage, active and on a numbered lap. The session type numbers
    /// differ between the years (a race is 10 in 2023, 15 later), but 0 is "unknown" in all of them.
    ///
    /// The phase: `Driving` as above; `Spectating` when the session says the player is spectating; `Garage` when the
    /// lap data says the car is in the garage (driver status 0) on a known track; anything else (no session or lap
    /// data yet, an unknown session or track, a car that is not active, no lap number) is `Unknown`. The game sends no
    /// packets in a menu or a pause and the format has no replay flag, so `Menu`, `Paused`, `Replay` and `Loading` are
    /// never told: the frames just stop, or carry the last session.
    fn phase(&self) -> Phase {
        let (Some(s), Some(l)) = (&self.session, &self.lap) else {
            return Phase::Unknown;
        };
        if s.session_type == 0 || s.track_id < 0 {
            Phase::Unknown
        } else if s.spectating {
            Phase::Spectating
        } else if l.driver_status == 0 && l.result_status == 2 {
            Phase::Garage // 0 = in garage, 2 = active
        } else if l.lap_number >= 1 && l.driver_status != 0 && l.result_status == 2 {
            Phase::Driving
        } else {
            Phase::Unknown
        }
    }
}

/// The open door: a UDP socket the game sends its telemetry to.
pub struct F1Source {
    door: Door,
    start: Instant,
    decoder: Decoder,
    /// The game named before any packet has come (from the program that is running).
    first_guess: &'static Layout,
}

/// The biggest packet of the formats is well under 1500 bytes; a longer datagram is cut and refused by size.
const BUFFER: usize = 2048;

impl F1Source {
    /// Binds `addr` (loopback senders only); `None` when that fails (the port is busy: another program, for example a
    /// dashboard, owns it).
    fn bind(addr: SocketAddr, first_guess: &'static Layout) -> Option<F1Source> {
        Some(F1Source::with_door(Door::bind(addr, BUFFER)?, first_guess))
    }

    fn with_door(door: Door, first_guess: &'static Layout) -> F1Source {
        F1Source {
            door,
            start: Instant::now(),
            decoder: Decoder::default(),
            first_guess,
        }
    }

    /// The game of the packets read so far, or the first guess before any.
    fn layout(&self) -> &'static Layout {
        self.decoder.layout.unwrap_or(self.first_guess)
    }

    #[cfg(test)]
    fn local_addr(&self) -> SocketAddr {
        self.door.local_addr()
    }
}

impl crate::replay::Datagrams for F1Source {
    fn feed(&mut self, data: &[u8], clock_s: f64) -> Option<Frame> {
        self.decoder.feed(data, clock_s)
    }
}

/// The reader of a capture (`replay.rs`): a source on a socket of the loopback that nobody writes to, fed the recorded
/// datagrams through the same decoder. `game_id` is what the capture said before any packet came.
pub(crate) fn datagrams(game_id: &str) -> Option<Box<dyn crate::replay::Datagrams>> {
    let first_guess = [&F1_24, &F1_23].into_iter().find(|l| l.game_id == game_id).unwrap_or(&F1_25);
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, 0));
    Some(Box::new(F1Source::bind(addr, first_guess)?))
}

/// Opens the door on UDP port 20777 (the loopback; see `udp.rs` for `XPEED_UDP_LISTEN_ALL`). `None` when the port is
/// not free.
pub fn open() -> Option<Box<dyn Source>> {
    let first_guess = layout_of_programs(&crate::win::running_programs());
    let source = F1Source::with_door(Door::listen(DEFAULT_PORT, BUFFER)?, first_guess);
    Some(Box::new(source))
}

impl Source for F1Source {
    /// `"f1"` (F1 25), `"f124"` or `"f123"`: the game of the packets read so far. It can change while the door is
    /// open (the person closes one game and starts another before the reader lets go of the port).
    fn game_id(&self) -> &'static str {
        self.layout().game_id
    }

    fn game_name(&self) -> &'static str {
        self.layout().game_name
    }

    fn next(&mut self, timeout: Duration) -> Option<Frame> {
        let deadline = Instant::now() + timeout;
        loop {
            let Wait::Datagram(n) = self.door.recv(deadline) else {
                return None;
            };
            let data = self.door.data(n);
            crate::capture::tap_datagram(data);
            let clock_s = self.start.elapsed().as_secs_f64();
            if let Some(frame) = self.decoder.feed(data, clock_s) {
                return Some(frame);
            }
            if Instant::now() >= deadline {
                return None;
            }
        }
    }

    fn alive(&self) -> bool {
        self.door.alive()
    }

    fn listens(&self) -> bool {
        true
    }

    fn caps(&self) -> Caps {
        CAPS
    }
}

/// What a frame of any of the three games (every format) can fill: the car's telemetry (no tyres, temperatures, fuel,
/// session kind or weather are read), the lap data, the car's state from Car Status and Car Damage, the world position,
/// the track length and the team as car and class. The fuel is a mass with no stated density (`fuel_l` stays `NaN`),
/// the one `engineTemperature` is neither water nor oil, and the spec has no sector times in a form this reader uses.
const CAPS: Caps = Caps::LAP_TIME
    .or(Caps::LAST_LAP)
    .or(Caps::LAP_VALID)
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
    .or(Caps::CAR_CLASS)
    .or(Caps::TRACK_LENGTH)
    .or(Caps::PIT_LIMITER)
    .or(Caps::DRS)
    .or(Caps::FLAG)
    .or(Caps::TC_LEVEL)
    .or(Caps::ABS_LEVEL)
    .or(Caps::BRAKE_BIAS)
    .or(Caps::ENGINE_WARNING)
    .or(Caps::DAMAGE_BODY)
    .or(Caps::DAMAGE_ENGINE)
    .or(Caps::DAMAGE_GEARBOX)
    .or(Caps::RACE_POSITION)
    .or(Caps::CARS)
    .or(Caps::SESSION_TIME_LEFT)
    .or(Caps::SESSION_LAPS)
    .or(Caps::RIVALS)
    .or(Caps::RIVALS_WORLD);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lapcut::LapCutter;
    use std::net::UdpSocket;

    // ---- byte builders, field by field in the order of each year's spec ----

    #[derive(Default)]
    struct W(Vec<u8>);

    impl W {
        fn u8(&mut self, v: u8) -> &mut Self {
            self.0.push(v);
            self
        }
        fn i8(&mut self, v: i8) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn u16(&mut self, v: u16) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn i16(&mut self, v: i16) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn u32(&mut self, v: u32) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn u64(&mut self, v: u64) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn f32(&mut self, v: f32) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn zeros(&mut self, n: usize) -> &mut Self {
            self.0.resize(self.0.len() + n, 0);
            self
        }
    }

    const UID: u64 = 0x1122_3344_5566_7788;
    /// The default of the tests that are about the reading, not the year.
    const FORMAT: u16 = 2025;
    const ALL: [&Layout; 4] = LAYOUTS;

    /// The entries of the arrays in the packets of a format (22 for a format this reader does not read: the tests
    /// build packets of those too, to see them refused).
    fn cars_of(format: u16) -> usize {
        layout_of(format).map_or(CARS, |l| l.cars)
    }

    /// PacketHeader (the same in 2023, 2024 and 2025): packetFormat u16, gameYear u8, gameMajorVersion u8,
    /// gameMinorVersion u8, packetVersion u8, packetId u8, sessionUID u64, sessionTime f32, frameIdentifier u32,
    /// overallFrameIdentifier u32, playerCarIndex u8, secondaryPlayerCarIndex u8.
    fn header(format: u16, packet_id: u8, uid: u64, player: u8) -> W {
        let mut w = W::default();
        w.u16(format)
            .u8((format % 100) as u8)
            .u8(1)
            .u8(15)
            .u8(1)
            .u8(packet_id)
            .u64(uid)
            .f32(12.5)
            .u32(700)
            .u32(700)
            .u8(player)
            .u8(255);
        assert_eq!(w.0.len(), HEADER_SIZE);
        w
    }

    /// CarMotionData: worldPosition x3 f32, worldVelocity x3 f32, worldForwardDir x3 i16, worldRightDir x3 i16,
    /// gForce lateral/longitudinal/vertical (f32 = 60 bytes; i16 thousandths in 2026 = 54 bytes), yaw, pitch, roll f32.
    fn motion_car(format: u16, w: &mut W, pos: [f32; 3]) {
        w.f32(pos[0]).f32(pos[1]).f32(pos[2]);
        w.f32(1.0).f32(2.0).f32(3.0);
        w.i16(100).i16(200).i16(300).i16(400).i16(500).i16(600);
        if format == 2026 {
            w.i16(100).i16(200).i16(300);
        } else {
            w.f32(0.1).f32(0.2).f32(0.3);
        }
        w.f32(0.4).f32(0.5).f32(0.6);
    }

    fn motion_packet(format: u16, uid: u64, player: u8, pos: [f32; 3]) -> Vec<u8> {
        let mut w = header(format, ID_MOTION, uid, player);
        for i in 0..cars_of(format) {
            if i == usize::from(player) {
                motion_car(format, &mut w, pos);
            } else {
                motion_car(format, &mut w, [9000.0 + i as f32, -9000.0, 7.0]);
            }
        }
        w.0
    }

    /// Session packet: the fields up to and including isSpectating are written one by one (the same in every year);
    /// every later field this reader does not use is zero (the packet is padded to the year's size).
    fn session_in(y: &Layout, uid: u64, player: u8, session_type: u8, track: i8, length: u16, spectating: bool) -> Vec<u8> {
        let mut w = header(y.format, ID_SESSION, uid, player);
        w.u8(0) // weather
            .i8(30) // trackTemperature
            .i8(22) // airTemperature
            .u8(5) // totalLaps
            .u16(length) // trackLength
            .u8(session_type) // sessionType
            .i8(track) // trackId
            .u8(0) // formula
            .u16(0) // sessionTimeLeft
            .u16(0) // sessionDuration
            .u8(80) // pitSpeedLimit
            .u8(0) // gamePaused
            .u8(u8::from(spectating)); // isSpectating
        let rest = y.session_size - w.0.len();
        w.zeros(rest);
        w.0
    }

    fn session_packet(uid: u64, player: u8, session_type: u8, track: i8, length: u16, spectating: bool) -> Vec<u8> {
        session_in(&F1_25, uid, player, session_type, track, length, spectating)
    }

    /// A race session of the year (the race's session type differs: 10 in 2023, 15 later).
    fn race_session(y: &Layout, player: u8) -> Vec<u8> {
        let race = if y.format == 2023 { 10 } else { 15 };
        session_in(y, UID, player, race, 11, 5793, false)
    }

    struct Lap {
        last_ms: u32,
        current_ms: u32,
        distance: f32,
        position: u8,
        lap_num: u8,
        pit: u8,
        invalid: u8,
        driver_status: u8,
        result_status: u8,
    }

    impl Lap {
        fn on_track(lap_num: u8, current_ms: u32, last_ms: u32, distance: f32) -> Lap {
            Lap {
                last_ms,
                current_ms,
                distance,
                position: 3,
                lap_num,
                pit: 0,
                invalid: 0,
                driver_status: 4,
                result_status: 2,
            }
        }
    }

    /// LapData.
    ///
    /// 2024 and 2025 (57 bytes): lastLapTimeInMS u32, currentLapTimeInMS u32, sector1TimeMSPart u16,
    /// sector1TimeMinutesPart u8, sector2 u16+u8, deltaToCarInFront u16+u8, deltaToRaceLeader u16+u8, lapDistance f32,
    /// totalDistance f32, safetyCarDelta f32, carPosition u8, currentLapNum u8, pitStatus u8, numPitStops u8, sector u8,
    /// currentLapInvalid u8, penalties u8, totalWarnings u8, cornerCuttingWarnings u8, numUnservedDriveThroughPens u8,
    /// numUnservedStopGoPens u8, gridPosition u8, driverStatus u8, resultStatus u8, pitLaneTimerActive u8,
    /// pitLaneTimeInLaneInMS u16, pitStopTimerInMS u16, pitStopShouldServePenalty u8, speedTrapFastestSpeed f32,
    /// speedTrapFastestLap u8.
    ///
    /// 2023 (50 bytes): the same, but deltaToCarInFrontInMS and deltaToRaceLeaderInMS are a u16 each (no minutes
    /// part) and there are no speed trap fields.
    fn lap_car(y: &Layout, w: &mut W, l: &Lap) {
        lap_car_with_gaps(y, w, l, (333, 444));
    }

    /// `lap_car` with the milliseconds to the car in front and to the leader (the minutes part, when the year has one, 0).
    fn lap_car_with_gaps(y: &Layout, w: &mut W, l: &Lap, gaps: (u16, u16)) {
        w.u32(l.last_ms).u32(l.current_ms);
        w.u16(11_111).u8(0).u16(22_222).u8(0);
        if y.format == 2023 {
            w.u16(gaps.0).u16(gaps.1);
        } else {
            w.u16(gaps.0).u8(0).u16(gaps.1).u8(0);
        }
        w.f32(l.distance).f32(l.distance + 1000.0).f32(0.0);
        w.u8(l.position)
            .u8(l.lap_num)
            .u8(l.pit)
            .u8(0)
            .u8(1)
            .u8(l.invalid)
            .u8(0)
            .u8(0)
            .u8(0)
            .u8(0)
            .u8(0)
            .u8(1);
        w.u8(l.driver_status).u8(l.result_status);
        w.u8(0).u16(0).u16(0).u8(0);
        if y.format != 2023 {
            w.f32(300.0).u8(1);
        }
    }

    fn lap_in(y: &Layout, player: u8, l: &Lap) -> Vec<u8> {
        let decoy = Lap {
            last_ms: 99_999,
            current_ms: 88_888,
            distance: 123.0,
            position: 15,
            lap_num: 9,
            pit: 2,
            invalid: 1,
            driver_status: 0,
            result_status: 7,
        };
        let mut w = header(y.format, ID_LAP_DATA, UID, player);
        for i in 0..y.cars {
            lap_car(y, &mut w, if i == usize::from(player) { l } else { &decoy });
        }
        w.u8(255).u8(255); // timeTrialPBCarIdx, timeTrialRivalCarIdx
        w.0
    }

    /// A Lap Data packet of the cars the test describes (index = car), the rest "invalid" (result status 0).
    fn lap_cars_in(y: &Layout, player: u8, cars: &[(Lap, (u16, u16))]) -> Vec<u8> {
        let mut gone = Lap::on_track(0, 0, 0, 0.0);
        gone.result_status = 0;
        let mut w = header(y.format, ID_LAP_DATA, UID, player);
        for i in 0..y.cars {
            match cars.get(i) {
                Some((lap, gaps)) => lap_car_with_gaps(y, &mut w, lap, *gaps),
                None => lap_car(y, &mut w, &gone),
            }
        }
        w.u8(255).u8(255);
        w.0
    }

    fn lap_packet(player: u8, l: &Lap) -> Vec<u8> {
        lap_in(&F1_25, player, l)
    }

    /// ParticipantData: aiControlled, driverId, networkId, teamId (u8 each; u16 each in 2026), myTeam, raceNumber,
    /// nationality, then 2026 as 2025 (60 bytes with the three u16 ids),
    /// 2025: name[32], yourTelemetry, showOnlineNames, techLevel u16, platform, numColours, liveryColours[4] (r,g,b);
    /// 2024: name[48], yourTelemetry, showOnlineNames, techLevel u16, platform;
    /// 2023: name[48], yourTelemetry, showOnlineNames, platform.
    fn participants_in(y: &Layout, player: u8, team_id: u16) -> Vec<u8> {
        let mut w = header(y.format, ID_PARTICIPANTS, UID, player);
        w.u8(20); // numActiveCars (the same in every year: fewer than the arrays hold)
        for i in 0..y.cars {
            let team_id = if i == usize::from(player) { team_id } else { 8 };
            if y.format == 2026 {
                w.u8(0).u16(3).u16(255).u16(team_id).u8(0).u8(16).u8(5);
            } else {
                w.u8(0)
                    .u8(3)
                    .u8(255)
                    .u8(u8::try_from(team_id).expect("a u8 team id"))
                    .u8(0)
                    .u8(16)
                    .u8(5);
            }
            match y.format {
                2025 | 2026 => {
                    w.zeros(32);
                    w.u8(1).u8(1).u16(0).u8(1).u8(0);
                    w.zeros(12);
                }
                2024 => {
                    w.zeros(48);
                    w.u8(1).u8(1).u16(0).u8(1);
                }
                _ => {
                    w.zeros(48);
                    w.u8(1).u8(1).u8(1);
                }
            }
        }
        w.0
    }

    fn participants_packet(player: u8, team_id: u16) -> Vec<u8> {
        participants_in(&F1_25, player, team_id)
    }

    struct Tele {
        speed_kmh: u16,
        throttle: f32,
        steer: f32,
        brake: f32,
        clutch: u8,
        gear: i8,
        rpm: u16,
    }

    /// CarTelemetryData (60 bytes; 59 in 2026, where engineTemperature is a u8): speed u16, throttle f32, steer f32, brake f32, clutch u8, gear i8,
    /// engineRPM u16, drs u8, revLightsPercent u8, revLightsBitValue u16, brakesTemperature[4] u16,
    /// tyresSurfaceTemperature[4] u8, tyresInnerTemperature[4] u8, engineTemperature u16, tyresPressure[4] f32,
    /// surfaceType[4] u8.
    fn tele_car(format: u16, w: &mut W, t: &Tele) {
        w.u16(t.speed_kmh)
            .f32(t.throttle)
            .f32(t.steer)
            .f32(t.brake)
            .u8(t.clutch)
            .i8(t.gear)
            .u16(t.rpm);
        w.u8(1).u8(50).u16(0x00ff);
        for _ in 0..4 {
            w.u16(500);
        }
        w.zeros(4).zeros(4);
        if format == 2026 {
            w.u8(105);
        } else {
            w.u16(105);
        }
        for _ in 0..4 {
            w.f32(22.5);
        }
        w.zeros(4);
    }

    fn tele_packet_in(format: u16, player: u8, t: &Tele) -> Vec<u8> {
        let decoy = Tele {
            speed_kmh: 33,
            throttle: 0.9,
            steer: -0.9,
            brake: 0.9,
            clutch: 99,
            gear: 7,
            rpm: 1234,
        };
        let mut w = header(format, ID_CAR_TELEMETRY, UID, player);
        for i in 0..cars_of(format) {
            tele_car(format, &mut w, if i == usize::from(player) { t } else { &decoy });
        }
        w.u8(0).u8(255).u8(4); // mfdPanelIndex, mfdPanelIndexSecondaryPlayer, suggestedGear
        w.0
    }

    fn tele_packet(player: u8, t: &Tele) -> Vec<u8> {
        tele_packet_in(FORMAT, player, t)
    }

    fn sample_tele() -> Tele {
        Tele {
            speed_kmh: 180,
            throttle: 0.75,
            steer: -0.25,
            brake: 0.125,
            clutch: 40,
            gear: 5,
            rpm: 11_500,
        }
    }

    /// The five packets of the year, for `player` on lap 3 of a race at Monza in a Ferrari (team 1 in every year).
    fn packet_set(y: &Layout, player: u8) -> [Vec<u8>; 5] {
        [
            motion_packet(y.format, UID, player, [100.5, 12.25, -300.75]),
            race_session(y, player),
            lap_in(y, player, &Lap::on_track(3, 45_678, 91_234, 2500.5)),
            participants_in(y, player, 1),
            tele_packet_in(y.format, player, &sample_tele()),
        ]
    }

    /// A decoder that has seen a whole running session of the year for `player` and the frame of one telemetry packet.
    fn running_in(y: &Layout, player: u8) -> (Decoder, Frame) {
        let mut d = Decoder::default();
        let [motion, session, lap, participants, tele] = packet_set(y, player);
        for packet in [motion, session, lap, participants] {
            assert!(d.feed(&packet, 1.0).is_none());
        }
        let frame = d.feed(&tele, 2.5).expect("a telemetry packet gives a frame");
        (d, frame)
    }

    fn running(player: u8) -> (Decoder, Frame) {
        running_in(&F1_25, player)
    }

    /// What the tests put in one car's Car Status and Car Damage.
    struct Car {
        traction_control: u8,
        anti_lock: u8,
        front_brake_bias: u8,
        pit_limiter: u8,
        drs_allowed: u8,
        fia_flags: i8,
        /// Front left wing, front right wing, rear wing, floor, diffuser, sidepod, gearbox, engine (percentages).
        damage: [u8; 8],
        blown: u8,
        seized: u8,
    }

    impl Car {
        fn sample() -> Car {
            Car {
                traction_control: 2,
                anti_lock: 1,
                front_brake_bias: 56,
                pit_limiter: 1,
                drs_allowed: 1,
                fia_flags: 3,
                damage: [10, 40, 25, 5, 0, 15, 20, 35],
                blown: 0,
                seized: 0,
            }
        }
    }

    /// CarStatusData (55 bytes; 59 in 2026, which adds ersHarvestLimitPerLap f32 before ersDeployedThisLap):
    /// tractionControl, antiLockBrakes, fuelMix, frontBrakeBias,
    /// pitLimiterStatus u8, fuelInTank, fuelCapacity, fuelRemainingLaps f32, maxRPM, idleRPM u16, maxGears,
    /// drsAllowed u8, drsActivationDistance u16, actualTyreCompound, visualTyreCompound, tyresAgeLaps u8,
    /// vehicleFiaFlags i8, enginePowerICE, enginePowerMGUK, ersStoreEnergy f32, ersDeployMode u8, three ers f32,
    /// networkPaused u8.
    fn status_car(format: u16, w: &mut W, c: &Car) {
        w.u8(c.traction_control)
            .u8(c.anti_lock)
            .u8(1)
            .u8(c.front_brake_bias)
            .u8(c.pit_limiter);
        w.f32(50.0).f32(110.0).f32(20.0);
        w.u16(13_000).u16(4_000).u8(8).u8(c.drs_allowed).u16(0);
        w.u8(18).u8(17).u8(3).i8(c.fia_flags);
        w.f32(1.0).f32(2.0).f32(3.0).u8(1).f32(4.0).f32(5.0);
        if format == 2026 {
            w.f32(4_000_000.0);
        }
        w.f32(6.0).u8(0);
    }

    fn status_packet_in(format: u16, player: u8, c: &Car) -> Vec<u8> {
        let decoy = Car {
            traction_control: 0,
            anti_lock: 0,
            front_brake_bias: 99,
            pit_limiter: 0,
            drs_allowed: 0,
            fia_flags: 2,
            ..Car::sample()
        };
        let mut w = header(format, ID_CAR_STATUS, UID, player);
        for i in 0..cars_of(format) {
            status_car(format, &mut w, if i == usize::from(player) { c } else { &decoy });
        }
        w.0
    }

    /// CarDamageData: tyresWear[4] f32, tyresDamage[4], brakesDamage[4] u8, (2025: tyreBlisters[4] u8), then the
    /// six wing and body parts, drsFault, ersFault, gearBoxDamage, engineDamage, six engine wears, engineBlown and
    /// engineSeized (u8). 42 bytes in 2023 and 2024, 46 in 2025 and 2026.
    fn damage_car(format: u16, w: &mut W, c: &Car) {
        for _ in 0..4 {
            w.f32(7.0);
        }
        w.zeros(8);
        if format >= 2025 {
            w.zeros(4);
        }
        for d in &c.damage[..6] {
            w.u8(*d);
        }
        w.u8(0).u8(0).u8(c.damage[6]).u8(c.damage[7]);
        w.zeros(6);
        w.u8(c.blown).u8(c.seized);
    }

    fn damage_packet_in(format: u16, player: u8, c: &Car) -> Vec<u8> {
        let decoy = Car {
            damage: [90; 8],
            blown: 1,
            seized: 1,
            ..Car::sample()
        };
        let mut w = header(format, ID_CAR_DAMAGE, UID, player);
        for i in 0..cars_of(format) {
            damage_car(format, &mut w, if i == usize::from(player) { c } else { &decoy });
        }
        w.0
    }

    /// The decoder of a running session of the year, after the status and the damage of `c` came too.
    fn running_with(y: &Layout, player: u8, c: &Car) -> (Decoder, Frame) {
        let (mut d, _) = running_in(y, player);
        assert!(d.feed(&status_packet_in(y.format, player, c), 1.5).is_none());
        assert!(d.feed(&damage_packet_in(y.format, player, c), 1.5).is_none());
        let frame = d.feed(&tele_packet_in(y.format, player, &sample_tele()), 3.0).expect("a frame");
        (d, frame)
    }

    #[test]
    fn the_car_state_comes_from_status_damage_and_the_drs_flag_in_every_year() {
        for y in ALL {
            for player in [0u8, 7, 21] {
                let (_, f) = running_with(y, player, &Car::sample());
                assert_eq!(
                    f.state,
                    CarState {
                        pit_limiter: Some(true),
                        abs_active: None,
                        tc_active: None,
                        // The telemetry packet's `drs` is 1: the wing is open.
                        drs: Some(Drs::Open),
                        headlights: None,
                        handbrake: None,
                        engine_warning: Some(false),
                        flag: Some(Flag::Yellow),
                        water_c: None,
                        oil_c: None,
                        tc_level: Some(2),
                        abs_level: Some(1),
                        engine_map: None,
                        brake_bias: Some(0.56),
                        damage_body: Some(0.4), // the worst of the six parts: the front right wing
                        damage_engine: Some(0.35),
                        damage_gearbox: Some(0.2),
                        damage_suspension: None,
                    },
                    "{} player {player}",
                    y.format
                );
            }
        }
    }

    #[test]
    fn before_status_and_damage_come_the_state_has_only_what_the_telemetry_says() {
        let (_, f) = running(0);
        assert_eq!(f.state, CarState::UNKNOWN, "no Car Status or Car Damage yet");
    }

    #[test]
    fn the_flags_the_wing_and_a_blown_engine_map_as_the_spec_says() {
        for (fia, want) in [
            (-1, None),
            (0, None),
            (1, Some(Flag::Green)),
            (2, Some(Flag::Blue)),
            (3, Some(Flag::Yellow)),
            (4, None),
        ] {
            let car = Car {
                fia_flags: fia,
                ..Car::sample()
            };
            assert_eq!(running_with(&F1_25, 0, &car).1.state.flag, want, "flag {fia}");
        }
        // The wing: not open and not allowed is off; allowed is available.
        let mut d = running_with(
            &F1_25,
            0,
            &Car {
                drs_allowed: 0,
                ..Car::sample()
            },
        )
        .0;
        let mut t = sample_tele_packet_with_drs(0);
        assert_eq!(d.feed(&t, 4.0).unwrap().state.drs, Some(Drs::Off));
        d.feed(&status_packet_in(FORMAT, 0, &Car::sample()), 4.0);
        assert_eq!(d.feed(&t, 4.1).unwrap().state.drs, Some(Drs::Available));
        // An engine that is blown or seized is a warning; a percentage above 100 is not one.
        for (blown, seized) in [(1, 0), (0, 1)] {
            let car = Car {
                blown,
                seized,
                ..Car::sample()
            };
            assert_eq!(running_with(&F1_25, 0, &car).1.state.engine_warning, Some(true));
        }
        t.clear();
        let car = Car {
            damage: [101, 0, 0, 0, 0, 0, 255, 100],
            front_brake_bias: 150,
            traction_control: 9,
            pit_limiter: 4,
            ..Car::sample()
        };
        let state = running_with(&F1_25, 0, &car).1.state;
        assert_eq!(
            (state.damage_body, state.damage_gearbox, state.damage_engine),
            (None, None, Some(1.0))
        );
        assert_eq!((state.brake_bias, state.tc_level, state.pit_limiter), (None, None, None));
    }

    /// A Car Telemetry packet of 2025 with the DRS flag off (the sample has it on).
    fn sample_tele_packet_with_drs(drs: u8) -> Vec<u8> {
        let mut packet = tele_packet(0, &sample_tele());
        packet[HEADER_SIZE + T_DRS] = drs;
        packet
    }

    #[test]
    fn the_status_and_damage_packets_are_the_spec_sizes_and_offsets() {
        // CarStatusData: 55 bytes, with tractionControl .. pitLimiterStatus, drsAllowed and vehicleFiaFlags where the
        // reader looks (the three specs share the layout).
        let status = [1, 1, 1, 1, 1, 4, 4, 4, 2, 2, 1, 1, 2, 1, 1, 1, 1, 4, 4, 4, 1, 4, 4, 4, 1];
        assert_eq!(status.iter().sum::<usize>(), STATUS_CAR);
        let at = field_offsets(&status);
        assert_eq!(
            [at[0], at[1], at[3], at[4], at[11], at[16]],
            [
                C_TRACTION_CONTROL,
                C_ANTI_LOCK,
                C_FRONT_BRAKE_BIAS,
                C_PIT_LIMITER,
                C_DRS_ALLOWED,
                C_FIA_FLAGS
            ]
        );
        // CarTelemetryData's `drs` follows engineRPM.
        let telemetry = [2, 4, 4, 4, 1, 1, 2, 1];
        assert_eq!(field_offsets(&telemetry)[7], T_DRS);
        // CarDamageData: 42 bytes in 2023 and 2024 (953-byte packet), 46 in 2025 (1041), which added tyreBlisters.
        let tail = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
        assert_eq!(tail.iter().sum::<usize>(), D_TAIL);
        let tail_at = field_offsets(&tail);
        assert_eq!(
            [tail_at[0], tail_at[3], tail_at[5], tail_at[8], tail_at[9], tail_at[16], tail_at[17]],
            [
                D_FRONT_LEFT_WING,
                D_FLOOR,
                D_SIDEPOD,
                D_GEARBOX,
                D_ENGINE,
                D_ENGINE_BLOWN,
                D_ENGINE_SEIZED
            ]
        );
        let head_2023 = 16 + 4 + 4;
        assert_eq!(F1_23.damage_wings, head_2023);
        assert_eq!(F1_24.damage_wings, head_2023);
        assert_eq!(F1_25.damage_wings, head_2023 + 4, "2025 added tyreBlisters[4]");
        assert_eq!(HEADER_SIZE + CARS * STATUS_CAR, 1239);
        for (y, want) in [(&F1_23, 953), (&F1_24, 953), (&F1_25, 1041)] {
            assert_eq!(y.expected_size(ID_CAR_DAMAGE), Some(want), "{}", y.format);
            assert_eq!(y.expected_size(ID_CAR_STATUS), Some(1239));
            assert_eq!(damage_packet_in(y.format, 0, &Car::sample()).len(), want);
            assert_eq!(status_packet_in(y.format, 0, &Car::sample()).len(), 1239);
        }
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    // ---- header and sizes ----

    #[test]
    fn parses_the_header() {
        for y in ALL {
            let bytes = header(y.format, 6, UID, 7).0;
            let h = Header::parse(&bytes).expect("a header of a format this reader reads");
            assert_eq!(h.layout.format, y.format);
            assert_eq!((h.packet_id, h.session_uid, h.player_car), (6, UID, 7));
            // The offsets of the layout: packetId is the 7th byte, playerCarIndex the 28th.
            assert_eq!(bytes[6], 6);
            assert_eq!(bytes[27], 7);
            assert_eq!(u16::from_le_bytes([bytes[0], bytes[1]]), y.format);
        }
    }

    #[test]
    fn refuses_other_formats_and_short_headers() {
        for format in [2022, 2027, 2021, 2020, 2019, 0, 25, 65_535] {
            assert!(Header::parse(&header(format, 6, UID, 0).0).is_none(), "format {format}");
        }
        for y in ALL {
            let ok = header(y.format, 6, UID, 0).0;
            assert!(Header::parse(&ok[..HEADER_SIZE - 1]).is_none());
        }
        assert!(Header::parse(&[]).is_none());
    }

    #[test]
    fn each_format_names_its_own_game() {
        let ids: Vec<_> = ALL.iter().map(|y| (y.format, y.game_id, y.game_name, y.short_name)).collect();
        assert_eq!(
            ids,
            [
                (2026, "f1", "EA SPORTS F1 25", "F1 25"),
                (2025, "f1", "EA SPORTS F1 25", "F1 25"),
                (2024, "f124", "EA SPORTS F1 24", "F1 24"),
                (2023, "f123", "EA SPORTS F1 23", "F1 23"),
            ]
        );
        assert!(layout_of(2022).is_none() && layout_of(2027).is_none());
        // The ids are the ones the panel lists for this reader.
        let reader = crate::games::READERS.iter().find(|r| r.family == "f1").expect("the F1 reader");
        assert_eq!(reader.ids, ["f1", "f124", "f123"]);
    }

    /// The field sizes of every struct in the spec's order, summed: they give the packet sizes each year's spec
    /// states.
    #[test]
    fn sizes_add_up_to_the_ones_the_spec_states() {
        // PacketHeader: the same in 2023, 2024 and 2025.
        let header_fields = [2, 1, 1, 1, 1, 1, 8, 4, 4, 4, 1, 1];
        assert_eq!(header_fields.iter().sum::<usize>(), HEADER_SIZE);
        assert_eq!(HEADER_SIZE, 29);

        // CarMotionData: every year; Motion is 1349 bytes in the three specs.
        let motion = [4, 4, 4, 4, 4, 4, 2, 2, 2, 2, 2, 2, 4, 4, 4, 4, 4, 4];
        assert_eq!(motion.iter().sum::<usize>(), MOTION_CAR);
        assert_eq!(HEADER_SIZE + CARS * motion.iter().sum::<usize>(), 1349);
        assert_eq!(F1_25.motion_size(), 1349);

        // CarTelemetryData (+ mfdPanelIndex, mfdPanelIndexSecondaryPlayer, suggestedGear): every year, 1352 bytes.
        let telemetry = [2, 4, 4, 4, 1, 1, 2, 1, 1, 2, 8, 4, 4, 2, 16, 4];
        assert_eq!(telemetry.iter().sum::<usize>(), TELEMETRY_CAR);
        assert_eq!(HEADER_SIZE + CARS * telemetry.iter().sum::<usize>() + 3, 1352);
        assert_eq!(F1_25.telemetry_size(), 1352);

        // CarStatusData (not read, but its size is part of each spec's table): 1239 bytes in the three years.
        let status = [1, 1, 1, 1, 1, 4, 4, 4, 2, 2, 1, 1, 2, 1, 1, 1, 1, 4, 4, 4, 1, 4, 4, 4, 1];
        assert_eq!(HEADER_SIZE + CARS * status.iter().sum::<usize>(), 1239);
        assert_eq!(F1_25.status_size(), 1239);
    }

    /// Three cars at Monza (5793 m): car 0 leads (lap 4, halfway round), car 2 is second and in the pit lane, car 1, the
    /// player, is third. Their names, and the number of active cars (3), are written into the Participants packet.
    fn rival_packets(y: &Layout) -> [Vec<u8>; 5] {
        let car = |position: u8, distance: f32, last_ms: u32, pit: u8| Lap {
            position,
            pit,
            ..Lap::on_track(4, 30_000, last_ms, distance)
        };
        let laps = [
            (car(1, 2896.5, 90_000, 0), (0, 0)),
            (car(3, 1448.25, 91_000, 0), (1500, 6000)),
            (car(2, 2000.0, 0, 2), (4500, 4500)),
        ];
        let mut participants = participants_in(y, 1, 1);
        participants[HEADER_SIZE] = 3;
        for (i, name) in ["Leader A", "Some Driver", "Second"].into_iter().enumerate() {
            let at = HEADER_SIZE + 1 + i * y.participant_car + y.name_at;
            participants[at..at + name.len()].copy_from_slice(name.as_bytes());
        }
        [
            motion_packet(y.format, UID, 1, [100.5, 12.25, -300.75]),
            race_session(y, 1),
            lap_cars_in(y, 1, &laps),
            participants,
            tele_packet_in(y.format, 1, &sample_tele()),
        ]
    }

    #[test]
    fn the_rivals_come_from_the_per_car_packets_in_every_year() {
        for y in ALL {
            let mut d = Decoder::default();
            let [motion, session, lap, participants, tele] = rival_packets(y);
            for packet in [motion, session, lap, participants] {
                assert!(d.feed(&packet, 1.0).is_none());
            }
            let frame = d.feed(&tele, 2.5).expect("a frame");
            crate::game::assert_frame_within_caps(&frame, CAPS, "f1");
            assert!(frame.filled().has(Caps::RIVALS.or(Caps::RIVALS_WORLD)), "{}", y.format);
            let field = frame.field.as_ref().expect("the first frame carries the other cars");
            assert_eq!(field.at_s, 2.5);
            let names: Vec<&str> = field.cars.iter().map(|c| c.name.as_str()).collect();
            assert_eq!(names, ["Leader A", "Second", "Some Driver"], "{}: sorted by position", y.format);
            let slots: Vec<u16> = field.cars.iter().map(|c| c.slot).collect();
            assert_eq!(slots, [0, 2, 1]);
            let positions: Vec<Option<u16>> = field.cars.iter().map(|c| c.position).collect();
            assert_eq!(positions, [Some(1), Some(2), Some(3)]);
            assert!(
                field.cars.iter().all(|c| c.class.is_none() && c.class_position.is_none()),
                "one class"
            );
            let shares: Vec<Option<f32>> = field.cars.iter().map(|c| c.lap_share).collect();
            assert_eq!(shares, [Some(0.5), Some((2000.0f64 / 5793.0) as f32), Some(0.25)]);
            let laps: Vec<Option<i32>> = field.cars.iter().map(|c| c.laps_done).collect();
            assert_eq!(laps, [Some(3); 3]);
            let pits: Vec<bool> = field.cars.iter().map(|c| c.in_pits).collect();
            assert_eq!(pits, [false, true, false]);
            let last: Vec<Option<f64>> = field.cars.iter().map(|c| c.last_lap_s).collect();
            assert_eq!(last, [Some(90.0), None, Some(91.0)]);
            let ahead: Vec<Option<f64>> = field.cars.iter().map(|c| c.gap_ahead_s).collect();
            assert_eq!(ahead, [None, Some(4.5), Some(1.5)], "{}", y.format);
            let leader: Vec<Option<f64>> = field.cars.iter().map(|c| c.gap_leader_s).collect();
            assert_eq!(leader, [None, Some(4.5), Some(6.0)], "{}", y.format);
            let player: Vec<bool> = field.cars.iter().map(|c| c.is_player).collect();
            assert_eq!(player, [false, false, true]);
            assert_eq!(field.player().unwrap().world, Some([100.5, 12.25, -300.75]));
            assert_eq!(field.cars[0].world, Some([9000.0, -9000.0, 7.0]));
        }
    }

    #[test]
    fn the_field_is_published_at_most_every_200_ms() {
        let y = &F1_25;
        let mut d = Decoder::default();
        let [motion, session, lap, participants, tele] = rival_packets(y);
        for packet in [motion, session, lap, participants] {
            d.feed(&packet, 1.0);
        }
        assert!(d.feed(&tele, 2.5).unwrap().field.is_some());
        assert!(d.feed(&tele, 2.6).unwrap().field.is_none());
        assert!(d.feed(&tele, 2.75).unwrap().field.is_some());
    }

    #[test]
    fn a_car_with_no_lap_data_yet_or_an_inactive_one_is_not_in_the_field_and_a_nameless_one_is_numbered() {
        let y = &F1_25;
        let mut d = Decoder::default();
        // Only the car count and the lap data: names are not known yet.
        let [_, session, lap, mut participants, tele] = rival_packets(y);
        participants[HEADER_SIZE] = 5; // numActiveCars: two cars past the three the test described, "invalid" in the lap data
        d.feed(&session, 1.0);
        d.feed(&participants, 1.0);
        let none = d.feed(&tele, 2.0).unwrap();
        assert!(none.field.is_none(), "no lap data yet");
        d.feed(&lap, 2.1);
        let frame = d.feed(&tele, 2.5).unwrap();
        let field = frame.field.unwrap();
        assert_eq!(field.cars.len(), 3, "the invalid ones are left out");
        let mut d = Decoder::default();
        d.feed(&session, 1.0);
        d.feed(&lap, 1.0);
        d.feed(&participants_in(y, 1, 1), 1.0);
        let named: Vec<String> = d
            .feed(&tele, 2.5)
            .unwrap()
            .field
            .unwrap()
            .cars
            .iter()
            .map(|c| c.name.clone())
            .collect();
        assert!(named.iter().all(|n| n.starts_with("Car ")), "{named:?}");
    }

    #[test]
    fn sizes_of_2025() {
        // LapData (+ timeTrialPBCarIdx, timeTrialRivalCarIdx).
        let lap = [
            4, 4, 2, 1, 2, 1, 2, 1, 2, 1, 4, 4, 4, // times, deltas (ms + minutes), distances
            1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // position .. resultStatus (14 one-byte fields)
            1, 2, 2, 1, 4, 1, // pit lane timer, times, serve penalty, speed trap
        ];
        assert_eq!(lap.iter().sum::<usize>(), F1_25.lap_car);
        assert_eq!(F1_25.lap_data_size(), 1285);
        assert_eq!(field_offsets(&lap)[10], F1_25.lap.distance);
        assert_eq!(
            (field_offsets(&lap)[6], field_offsets(&lap)[8]),
            (F1_25.lap.delta_front, F1_25.lap.delta_leader)
        );
        assert_eq!(field_offsets(&lap)[14], F1_25.lap.lap_num);

        // ParticipantData (+ numActiveCars): name[32], techLevel, numColours, liveryColours[4] of 3 bytes.
        let participant = [1, 1, 1, 1, 1, 1, 1, 32, 1, 1, 2, 1, 1, 12];
        assert_eq!(participant.iter().sum::<usize>(), F1_25.participant_car);
        assert_eq!(F1_25.participants_size(), 1284);
        assert_eq!(field_offsets(&participant)[3], F1_25.team_id_at);
        assert_eq!((field_offsets(&participant)[7], participant[7]), (F1_25.name_at, F1_25.name_len));

        // PacketSessionData, field by field.
        let session: Vec<usize> = [session_2023_fields(64), session_2024_additions()].concat();
        assert_eq!(HEADER_SIZE + session.iter().sum::<usize>(), 753);
        assert_eq!(F1_25.session_size, 753);
    }

    #[test]
    fn sizes_of_2024() {
        // LapData: the same as 2025's.
        let lap = [
            4, 4, 2, 1, 2, 1, 2, 1, 2, 1, 4, 4, 4, // times, deltas (ms + minutes), distances
            1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // position .. resultStatus
            1, 2, 2, 1, 4, 1, // pit lane timer, times, serve penalty, speed trap
        ];
        assert_eq!(lap.iter().sum::<usize>(), F1_24.lap_car);
        assert_eq!(F1_24.lap_data_size(), 1285);
        let at = field_offsets(&lap);
        assert_eq!(
            [at[10], at[14], at[15], at[18], at[25], at[26]],
            [
                F1_24.lap.distance,
                F1_24.lap.lap_num,
                F1_24.lap.pit_status,
                F1_24.lap.invalid,
                F1_24.lap.driver_status,
                F1_24.lap.result_status
            ]
        );

        // ParticipantData (+ numActiveCars): name[48], techLevel u16, no livery.
        let participant = [1, 1, 1, 1, 1, 1, 1, 48, 1, 1, 2, 1];
        assert_eq!(participant.iter().sum::<usize>(), F1_24.participant_car);
        assert_eq!(F1_24.participants_size(), 1350);
        assert_eq!(field_offsets(&participant)[3], F1_24.team_id_at);
        assert_eq!((field_offsets(&participant)[7], participant[7]), (F1_24.name_at, F1_24.name_len));
        assert_eq!((at[6], at[8]), (F1_24.lap.delta_front, F1_24.lap.delta_leader));

        // PacketSessionData: 64 forecast samples and the fields 2024 added.
        let session: Vec<usize> = [session_2023_fields(64), session_2024_additions()].concat();
        assert_eq!(HEADER_SIZE + session.iter().sum::<usize>(), 753);
        assert_eq!(F1_24.session_size, 753);
        check_session_offsets(&session);
    }

    #[test]
    fn sizes_of_2023() {
        // LapData: the deltas are a plain u16 each, no speed trap.
        let lap = [
            4, 4, 2, 1, 2, 1, 2, 2, 4, 4, 4, // times, deltas (ms), distances
            1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // position .. resultStatus
            1, 2, 2, 1, // pit lane timer, times, serve penalty
        ];
        assert_eq!(lap.iter().sum::<usize>(), F1_23.lap_car);
        assert_eq!(F1_23.lap_data_size(), 1131);
        let at = field_offsets(&lap);
        assert_eq!(
            [at[0], at[1], at[8], at[12], at[13], at[16], at[23], at[24]],
            [
                L_LAST_LAP_MS,
                L_CURRENT_LAP_MS,
                F1_23.lap.distance,
                F1_23.lap.lap_num,
                F1_23.lap.pit_status,
                F1_23.lap.invalid,
                F1_23.lap.driver_status,
                F1_23.lap.result_status
            ]
        );

        // ParticipantData (+ numActiveCars): name[48], no techLevel.
        let participant = [1, 1, 1, 1, 1, 1, 1, 48, 1, 1, 1];
        assert_eq!(participant.iter().sum::<usize>(), F1_23.participant_car);
        assert_eq!(F1_23.participants_size(), 1306);
        assert_eq!(field_offsets(&participant)[3], F1_23.team_id_at);
        assert_eq!((field_offsets(&participant)[7], participant[7]), (F1_23.name_at, F1_23.name_len));
        assert_eq!((at[6], at[7]), (F1_23.lap.delta_front, F1_23.lap.delta_leader));

        // PacketSessionData: 56 forecast samples, ends after numRedFlagPeriods.
        let session = session_2023_fields(56);
        assert_eq!(HEADER_SIZE + session.iter().sum::<usize>(), 644);
        assert_eq!(F1_23.session_size, 644);
        check_session_offsets(&session);
    }

    /// The 2026 Season Pack ("F1 25 2026 Season Pack UDP Specification", version 11.0), field by field. Two independent
    /// transcriptions give the same packet sizes: `F1Game.UDP` (1325, 926, 1399, 1470, 1448, 1445, 1133 bytes) and
    /// `racehub-io/f1-telemetry-client` (`PACKET_SIZES`), and the Python bridge `FermaxoRacingDash` the same table.
    #[test]
    fn sizes_of_2026() {
        let y = &F1_25_2026;
        assert_eq!(y.cars, 24);
        // CarMotionData: positions, velocities, directions (i16), the g-forces now i16 too, yaw, pitch, roll.
        let motion = [4, 4, 4, 4, 4, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 4, 4];
        assert_eq!(motion.iter().sum::<usize>(), y.motion_car);
        assert_eq!(y.motion_size(), 1325);
        assert_eq!(field_offsets(&motion)[0], M_POS_X);

        // LapData (+ timeTrialPBCarIdx, timeTrialRivalCarIdx): as in 2025.
        let lap = [
            4, 4, 2, 1, 2, 1, 2, 1, 2, 1, 4, 4, 4, // times, deltas (ms + minutes), distances
            1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // position .. resultStatus (14 one-byte fields)
            1, 2, 2, 1, 4, 1, // pit lane timer, times, serve penalty, speed trap
        ];
        assert_eq!(lap.iter().sum::<usize>(), y.lap_car);
        assert_eq!(y.lap_data_size(), 1399);
        let at = field_offsets(&lap);
        assert_eq!(
            [at[10], at[14], at[15], at[18], at[25], at[26]],
            [
                y.lap.distance,
                y.lap.lap_num,
                y.lap.pit_status,
                y.lap.invalid,
                y.lap.driver_status,
                y.lap.result_status
            ]
        );

        // ParticipantData (+ numActiveCars): driverId, networkId and teamId are u16; name[32], techLevel,
        // numColours, liveryColours[4] of 3 bytes.
        let participant = [1, 2, 2, 2, 1, 1, 1, 32, 1, 1, 2, 1, 1, 12];
        assert_eq!(participant.iter().sum::<usize>(), y.participant_car);
        assert_eq!(y.participants_size(), 1470);
        assert_eq!(field_offsets(&participant)[3], y.team_id_at);
        assert_eq!((field_offsets(&participant)[7], participant[7]), (y.name_at, y.name_len));
        assert!(y.team_id_u16);

        // CarTelemetryData (+ mfdPanelIndex x2, suggestedGear): engineTemperature is a u8.
        let telemetry = [2, 4, 4, 4, 1, 1, 2, 1, 1, 2, 8, 4, 4, 1, 16, 4];
        assert_eq!(telemetry.iter().sum::<usize>(), y.telemetry_car);
        assert_eq!(y.telemetry_size(), 1448);
        assert_eq!(field_offsets(&telemetry)[7], T_DRS);

        // CarStatusData: ersHarvestLimitPerLap f32 is new (before ersDeployedThisLap).
        let status = [1, 1, 1, 1, 1, 4, 4, 4, 2, 2, 1, 1, 2, 1, 1, 1, 1, 4, 4, 4, 1, 4, 4, 4, 4, 1];
        assert_eq!(status.iter().sum::<usize>(), y.status_car);
        assert_eq!(y.status_size(), 1445);
        let at = field_offsets(&status);
        assert_eq!(
            [at[0], at[1], at[3], at[4], at[11], at[16]],
            [
                C_TRACTION_CONTROL,
                C_ANTI_LOCK,
                C_FRONT_BRAKE_BIAS,
                C_PIT_LIMITER,
                C_DRS_ALLOWED,
                C_FIA_FLAGS
            ]
        );

        // CarDamageData: 46 bytes, as in 2025.
        assert_eq!(y.damage_wings, F1_25.damage_wings);
        assert_eq!(y.expected_size(ID_CAR_DAMAGE), Some(1133));

        // PacketSessionData: the fields of 2025, then the 2026 additions.
        let session: Vec<usize> = [
            session_2023_fields(64),
            session_2024_additions(),
            vec![
                1,
                1,     // activeAeroTrackStatus, numActiveAeroZonesFull
                8 * 8, // activeAeroZonesFull[8]: zoneStart f32, zoneEnd f32
                1,
                8 * 8, // numActiveAeroZonesPartial, activeAeroZonesPartial[8]
                1,
                4 * 8, // numDRSZones, drsZones[4]
                4,     // startReactionTime
                1,
                1,
                1,
                1,
                1, // antiLockBrakesAssist, tractionControlAssist, hiVis, colourBlind, recurringRewindPrompt
            ],
        ]
        .concat();
        assert_eq!(HEADER_SIZE + session.iter().sum::<usize>(), 926);
        assert_eq!(y.session_size, 926);
        check_session_offsets(&session);
    }

    /// Where each field starts, from the sizes in order.
    fn field_offsets(sizes: &[usize]) -> Vec<usize> {
        sizes
            .iter()
            .scan(0, |at, size| {
                let here = *at;
                *at += size;
                Some(here)
            })
            .collect()
    }

    /// PacketSessionData of 2023, after the header; `samples` weather forecast samples of 8 bytes.
    fn session_2023_fields(samples: usize) -> Vec<usize> {
        [
            // weather, trackTemperature, airTemperature, totalLaps, trackLength, sessionType, trackId, formula,
            // sessionTimeLeft, sessionDuration, pitSpeedLimit, gamePaused, isSpectating, spectatorCarIndex,
            // sliProNativeSupport, numMarshalZones
            &[1, 1, 1, 1, 2, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 1][..],
            &[21 * 5],                    // marshalZones[21]: zoneStart f32, zoneFlag i8
            &[1, 1, 1],                   // safetyCarStatus, networkGame, numWeatherForecastSamples
            &[samples * 8],               // weatherForecastSamples: 8 bytes each
            &[1, 1, 4, 4, 4, 1, 1, 1],    // forecastAccuracy, aiDifficulty, 3 link ids, pitStopWindow x3
            &[1, 1, 1, 1, 1, 1, 1, 1, 1], // steering .. dynamicRacingLineType
            &[1, 1, 4, 1],                // gameMode, ruleSet, timeOfDay, sessionLength
            &[1, 1, 1, 1],                // speed/temperature units, lead and secondary player
            &[1, 1, 1],                   // numSafetyCarPeriods, numVirtualSafetyCarPeriods, numRedFlagPeriods
        ]
        .concat()
    }

    /// The fields 2024 added at the end of PacketSessionData (2025 has the same).
    fn session_2024_additions() -> Vec<usize> {
        [
            &[1; 25][..], // equalCarPerformance .. numSessionsInWeekend
            &[12],        // weekendStructure[12]
            &[4, 4],      // sector2LapDistanceStart, sector3LapDistanceStart
        ]
        .concat()
    }

    /// The Session fields read sit where the reader looks for them (offsets from the start of the packet).
    fn check_session_offsets(session: &[usize]) {
        let at: Vec<usize> = field_offsets(session).iter().map(|o| o + HEADER_SIZE).collect();
        assert_eq!(
            [at[4], at[5], at[6], at[12]],
            [S_TRACK_LENGTH, S_SESSION_TYPE, S_TRACK_ID, S_IS_SPECTATING]
        );
    }

    #[test]
    fn the_builders_make_packets_of_the_spec_sizes() {
        let sizes = |y: &Layout| packet_set(y, 0).map(|p| p.len());
        assert_eq!(sizes(&F1_25), [1349, 753, 1285, 1284, 1352]);
        assert_eq!(sizes(&F1_24), [1349, 753, 1285, 1350, 1352]);
        assert_eq!(sizes(&F1_23), [1349, 644, 1131, 1306, 1352]);
        assert_eq!(sizes(&F1_25_2026), [1325, 926, 1399, 1470, 1448]);
    }

    /// A packet of one year that claims another year's format is held to that year's sizes: the Lap Data of 2023
    /// (1131) is not a 2024 one, the Participants of 2024 (1350) is not a 2025 one, and so on.
    #[test]
    fn a_packet_with_another_years_format_is_held_to_that_years_size() {
        for from in ALL {
            for to in ALL {
                let [_, session, lap, participants, _] = packet_set(from, 0);
                for (id, mut packet) in [(ID_SESSION, session), (ID_LAP_DATA, lap), (ID_PARTICIPANTS, participants)] {
                    packet[0..2].copy_from_slice(&to.format.to_le_bytes());
                    let mut d = Decoder::default();
                    let read = d.feed(&packet, 0.0).is_none() && d.session_uid.is_some();
                    let same_size = from.expected_size(id) == to.expected_size(id);
                    assert_eq!(read, same_size, "packet {id} of {} as {}", from.format, to.format);
                }
            }
        }
    }

    // ---- exact frame values ----

    /// The 2026 Season Pack: a Car Telemetry, Lap Data, Session, Motion and Participants packet of 24 cars read into
    /// a frame, with exact values, filed under F1 25's game id.
    #[test]
    fn reads_the_2026_season_pack_packets_of_24_cars() {
        let y = &F1_25_2026;
        assert_eq!((y.game_id, y.game_name), ("f1", "EA SPORTS F1 25"));
        for player in [0u8, 9, 23] {
            let mut d = Decoder::default();
            let [motion, session, lap, participants, tele] = packet_set(y, player);
            assert_eq!(
                [motion.len(), session.len(), lap.len(), participants.len(), tele.len()],
                [1325, 926, 1399, 1470, 1448]
            );
            for p in [motion, session, lap, participants] {
                assert!(d.feed(&p, 1.0).is_none());
            }
            let f = d.feed(&tele, 2.5).expect("a frame");
            assert_eq!(d.layout.map(|l| l.game_id), Some("f1"));
            assert!(f.driving);
            assert!(close(f.speed_ms, 50.0));
            assert_eq!(f.rpm, 11_500.0);
            assert_eq!(f.gear, 5.0);
            assert!(close(f.throttle, 0.75) && close(f.steer, -0.25) && close(f.brake, 0.125));
            assert!(close(f.clutch, 0.4));
            assert_eq!((f.x, f.y, f.z), (100.5, 12.25, -300.75));
            assert_eq!(f.track, "Monza");
            assert_eq!(f.track_length_m, Some(5793.0));
            assert_eq!(f.lap, 3);
            assert_eq!(f.lap_time_s, Some(45.678));
            assert_eq!(f.last_lap_s, Some(91.234));
            assert_eq!(f.dist_m, Some(2500.5));
            assert_eq!(f.lap_valid, Some(true));
            assert!(!f.in_pits);
            assert_eq!((f.car.as_str(), f.car_class.as_deref()), ("Ferrari", Some("F1")));
        }
        // Car 23 is the last of 24; a player index of 24 is outside the arrays.
        let mut d = Decoder::default();
        assert!(d.feed(&tele_packet_in(2026, 24, &sample_tele()), 0.0).is_none());
        // The 2025 packets still read as before (22 cars, a u8 team id).
        let (_, f) = running_in(&F1_25, 21);
        assert!(close(f.speed_ms, 50.0));
        assert_eq!((f.car.as_str(), f.lap), ("Ferrari", 3));
    }

    #[test]
    fn a_2026_team_id_is_two_bytes_and_names_the_new_cars() {
        let car_of = |team_id: u16| {
            let mut d = Decoder::default();
            d.feed(&participants_in(&F1_25_2026, 4, team_id), 0.0);
            let f = d.feed(&tele_packet_in(2026, 4, &sample_tele()), 0.0).unwrap();
            (f.car, f.car_class.unwrap_or_default())
        };
        assert_eq!(car_of(485), ("Audi '26".to_owned(), "F1".to_owned()));
        assert_eq!(car_of(486), ("Cadillac '26".to_owned(), "F1".to_owned()));
        assert_eq!(car_of(477), ("Ferrari '26".to_owned(), "F1".to_owned()));
        assert_eq!(car_of(475), ("Invicta '25".to_owned(), "F2".to_owned()));
        // The 2025 grid keeps its ids; an id the table does not have falls back to the game's name.
        assert_eq!(car_of(1), ("Ferrari".to_owned(), "F1".to_owned()));
        assert_eq!(car_of(500), ("F1 25".to_owned(), "F1".to_owned()));
        assert_eq!(track_name(42), "Madrid");
    }

    #[test]
    fn the_2026_car_state_and_laps_flow_like_2025() {
        let (d, f) = running_with(&F1_25_2026, 12, &Car::sample());
        assert_eq!(d.layout.map(|l| l.game_id), Some("f1"));
        assert_eq!(f.state.tc_level, Some(2));
        assert_eq!(f.state.brake_bias, Some(0.56));
        assert_eq!(f.state.pit_limiter, Some(true));
        assert_eq!(f.state.damage_gearbox, Some(0.2));
    }

    #[test]
    fn builds_the_frame_from_the_five_packets() {
        let (_, f) = running(0);
        assert!(f.driving);
        assert_eq!(f.clock_s, 2.5);
        // Car Telemetry: 180 km/h = 50 m/s.
        assert!(close(f.speed_ms, 50.0));
        assert_eq!(f.rpm, 11_500.0);
        assert_eq!(f.gear, 5.0);
        assert_eq!(f.throttle, 0.75);
        assert_eq!(f.steer, -0.25);
        assert_eq!(f.brake, 0.125);
        assert!(close(f.clutch, 0.4));
        // Motion.
        assert_eq!((f.x, f.y, f.z), (100.5, 12.25, -300.75));
        // Lap Data.
        assert_eq!(f.lap, 3);
        assert_eq!(f.lap_time_s, Some(45.678));
        assert_eq!(f.last_lap_s, Some(91.234));
        assert_eq!(f.lap_valid, Some(true));
        assert_eq!(f.dist_m, Some(2500.5));
        assert!(!f.in_pits);
        // Session and Participants.
        assert_eq!(f.track, "Monza");
        assert_eq!(f.track_length_m, Some(5793.0));
        assert_eq!(f.car, "Ferrari");
        assert_eq!(f.car_class.as_deref(), Some("F1"));
        assert!(f.fuel_l.is_nan());
        assert_eq!(f.track_variant, None);
        // The race: third of the 20 active cars, a 5-lap session, no time left given (0).
        assert_eq!((f.race_position, f.class_position, f.cars), (Some(3), None, Some(20)));
        assert_eq!((f.session_laps, f.session_time_left_s), (Some(5), None));
    }

    #[test]
    fn the_race_values_come_from_the_players_entries_in_every_year_and_the_implausible_are_not_given() {
        for y in ALL {
            let mut d = Decoder::default();
            let mut session = race_session(y, 0);
            session[S_SESSION_TIME_LEFT..S_SESSION_TIME_LEFT + 2].copy_from_slice(&1234u16.to_le_bytes());
            d.feed(&session, 0.0);
            d.feed(&lap_in(y, 0, &Lap::on_track(2, 100, 0, 5.0)), 0.0);
            d.feed(&participants_in(y, 0, 1), 0.0);
            let f = d.feed(&tele_packet_in(y.format, 0, &sample_tele()), 0.0).unwrap();
            assert_eq!(
                (f.race_position, f.cars, f.session_laps),
                (Some(3), Some(20), Some(5)),
                "{}",
                y.format
            );
            assert_eq!(f.session_time_left_s, Some(1234.0), "{}", y.format);
            // A position past the active cars, no total laps, and no active cars are not given.
            let mut d = Decoder::default();
            let mut session = race_session(y, 0);
            session[S_TOTAL_LAPS] = 0;
            d.feed(&session, 0.0);
            let lap = Lap {
                position: 21,
                ..Lap::on_track(2, 100, 0, 5.0)
            };
            d.feed(&lap_in(y, 0, &lap), 0.0);
            d.feed(&participants_in(y, 0, 1), 0.0);
            let f = d.feed(&tele_packet_in(y.format, 0, &sample_tele()), 0.0).unwrap();
            assert_eq!((f.race_position, f.cars, f.session_laps), (None, Some(20), None), "{}", y.format);
            let mut participants = participants_in(y, 0, 1);
            participants[HEADER_SIZE] = 0;
            d.feed(&participants, 0.0);
            let f = d.feed(&tele_packet_in(y.format, 0, &sample_tele()), 0.0).unwrap();
            assert_eq!(f.cars, None, "{}", y.format);
            // Before those packets came, nothing is said.
            let mut d = Decoder::default();
            let f = d.feed(&tele_packet_in(y.format, 0, &sample_tele()), 0.0).unwrap();
            assert_eq!(
                (f.race_position, f.cars, f.session_laps, f.session_time_left_s),
                (None, None, None, None)
            );
        }
    }

    /// The same session in each year's own layout gives the same frame.
    #[test]
    fn every_year_gives_the_same_frame_from_its_own_layout() {
        let (_, mut want) = running(0);
        // The rivals depend on which slot is the player's: compared in their own tests.
        want.field = None;
        for y in ALL {
            for player in [0u8, 7, 21] {
                let (d, mut f) = running_in(y, player);
                f.field = None;
                assert_eq!(d.layout.map(|l| l.format), Some(y.format));
                // Compared as text: the values the game does not give are NaN, which is never equal to itself.
                assert_eq!(format!("{f:?}"), format!("{want:?}"), "{} player {player}", y.format);
            }
        }
    }

    #[test]
    fn lap_details_reach_the_frame_in_every_year() {
        for y in ALL {
            let mut d = Decoder::default();
            d.feed(&session_in(y, UID, 0, 13, 5, 3337, false), 0.0);
            let lap = Lap {
                last_ms: 0,
                current_ms: 1500,
                distance: -12.5,
                position: 0,
                lap_num: 1,
                pit: 1,
                invalid: 1,
                driver_status: 3,
                result_status: 2,
            };
            d.feed(&lap_in(y, 0, &lap), 0.0);
            let f = d.feed(&tele_packet_in(y.format, 0, &sample_tele()), 0.0).unwrap();
            assert!(f.driving, "{}", y.format);
            assert_eq!(f.track, "Monaco");
            assert_eq!(f.lap, 1);
            assert_eq!(f.last_lap_s, None, "no completed lap yet");
            assert_eq!(f.dist_m, Some(0.0), "a negative distance is before the line");
            assert_eq!(f.lap_valid, Some(false));
            assert!(f.in_pits);
            assert_eq!(f.lap_time_s, Some(1.5));
            // Without participants the car is named after the game.
            assert_eq!(f.car, y.short_name);
            assert_eq!(f.car_class.as_deref(), Some("F1"));
            // Without motion the position is unknown.
            assert!(f.x.is_nan() && f.y.is_nan() && f.z.is_nan());
        }
    }

    #[test]
    fn picks_the_player_car_when_it_is_not_the_first() {
        for player in [1u8, 7, 21] {
            let (_, f) = running(player);
            assert!(f.driving, "player {player}");
            assert!(close(f.speed_ms, 50.0), "player {player}");
            assert_eq!(f.gear, 5.0);
            assert_eq!((f.x, f.y, f.z), (100.5, 12.25, -300.75));
            assert_eq!(f.lap, 3);
            assert_eq!(f.dist_m, Some(2500.5));
            assert_eq!(f.car, "Ferrari");
        }
    }

    #[test]
    fn a_player_index_outside_the_cars_is_refused() {
        let mut d = Decoder::default();
        for y in ALL {
            assert!(d.feed(&tele_packet_in(y.format, y.cars as u8, &sample_tele()), 1.0).is_none());
            assert!(d.feed(&tele_packet_in(y.format, 255, &sample_tele()), 1.0).is_none());
        }
    }

    #[test]
    fn gears_are_as_the_game_gives_them() {
        let mut d = Decoder::default();
        for (raw, expect) in [(-1i8, -1.0f32), (0, 0.0), (1, 1.0), (8, 8.0)] {
            let t = Tele {
                gear: raw,
                ..sample_tele()
            };
            assert_eq!(d.feed(&tele_packet(0, &t), 0.0).unwrap().gear, expect);
        }
        for raw in [9i8, 100, -2, -128] {
            let t = Tele {
                gear: raw,
                ..sample_tele()
            };
            assert!(d.feed(&tele_packet(0, &t), 0.0).unwrap().gear.is_nan(), "gear {raw}");
        }
    }

    #[test]
    fn pedals_and_steering_stay_in_range() {
        let mut d = Decoder::default();
        // A hair outside the range is pulled in.
        let t = Tele {
            throttle: 1.2,
            steer: -1.3,
            brake: -0.2,
            clutch: 120,
            ..sample_tele()
        };
        let f = d.feed(&tele_packet(0, &t), 0.0).unwrap();
        assert_eq!((f.throttle, f.steer, f.brake, f.clutch), (1.0, -1.0, 0.0, 1.0));
        // Far outside it (one tolerance for every game, `norm.rs`) is not given, not pinned to the end.
        let t = Tele {
            throttle: 1.7,
            steer: -3.0,
            brake: -0.6,
            clutch: 200,
            ..sample_tele()
        };
        let f = d.feed(&tele_packet(0, &t), 0.0).unwrap();
        assert!(f.throttle.is_nan() && f.steer.is_nan() && f.brake.is_nan() && f.clutch.is_nan());
    }

    #[test]
    fn team_and_track_tables() {
        assert_eq!(team_25(0), Some(("Mercedes", "F1")));
        assert_eq!(team_25(2), Some(("Red Bull Racing", "F1")));
        assert_eq!(team_25(9), Some(("Sauber", "F1")));
        assert_eq!(team_25(41), Some(("F1 Generic", "F1")));
        assert_eq!(team_25(150), Some(("Prema '23", "F2")));
        assert_eq!(team_25(168), Some(("Invicta '24", "F2")));
        assert_eq!(team_25(200), None);
        assert_eq!(track_name(0), "Melbourne");
        assert_eq!(track_name(11), "Monza");
        assert_eq!(track_name(32), "Losail");
        assert_eq!(track_name(55), "Track 55");

        let mut d = Decoder::default();
        d.feed(&session_packet(UID, 0, 15, 55, 4000, false), 0.0);
        d.feed(&participants_packet(0, 200), 0.0);
        d.feed(&lap_packet(0, &Lap::on_track(1, 0, 0, 0.0)), 0.0);
        let f = d.feed(&tele_packet(0, &sample_tele()), 0.0).unwrap();
        assert_eq!(f.track, "Track 55");
        assert_eq!(f.car, "F1 25");
        assert!(f.driving, "an id the table does not know is still a track");
    }

    #[test]
    fn each_year_has_its_own_team_table() {
        // F1 24: the 2024 grid and the 2023 F2 teams, not the 2024 F2 teams of F1 25.
        assert_eq!(team_24(6), Some(("RB", "F1")));
        assert_eq!(team_24(9), Some(("Sauber", "F1")));
        assert_eq!(team_24(104), Some(("F1 Custom Team", "F1")));
        assert_eq!(team_24(143), Some(("ART GP '23", "F2")));
        assert_eq!(team_24(153), Some(("Virtuosi '23", "F2")));
        for id in 158..=168 {
            assert_eq!(team_24(id), None, "team {id}");
        }
        // F1 23: the 2023 grid, the 2020 and 2022 cars, the F2 teams of 2021 and 2022, the supercars.
        assert_eq!(team_23(6), Some(("Alpha Tauri", "F1")));
        assert_eq!(team_23(9), Some(("Alfa Romeo", "F1")));
        assert_eq!(team_23(89), Some(("Racing Point 2020", "F1")));
        assert_eq!(team_23(99), Some(("Ferrari Roma", "Supercar")));
        assert_eq!(team_23(117), Some(("Mercedes AMG GT Black Series", "Supercar")));
        assert_eq!(team_23(106), Some(("Prema '21", "F2")));
        assert_eq!(team_23(126), Some(("McLaren '22", "F1")));
        assert_eq!(team_23(129), Some(("Konnersport", "F1")));
        assert_eq!(team_23(140), Some(("Art GP '22", "F2")));
        assert_eq!(team_23(41), None);
        assert_eq!(team_23(143), None);

        // The Participants packet is read with the table of its year.
        let car_of = |y: &Layout, team_id: u16| {
            let mut d = Decoder::default();
            d.feed(&participants_in(y, 4, team_id), 0.0);
            let f = d.feed(&tele_packet_in(y.format, 4, &sample_tele()), 0.0).unwrap();
            (f.car, f.car_class.unwrap_or_default())
        };
        assert_eq!(car_of(&F1_25, 6), ("RB".to_owned(), "F1".to_owned()));
        assert_eq!(car_of(&F1_24, 6), ("RB".to_owned(), "F1".to_owned()));
        assert_eq!(car_of(&F1_23, 6), ("Alpha Tauri".to_owned(), "F1".to_owned()));
        assert_eq!(car_of(&F1_25, 160), ("Rodin '24".to_owned(), "F2".to_owned()));
        assert_eq!(car_of(&F1_24, 160), ("F1 24".to_owned(), "F1".to_owned()));
        assert_eq!(car_of(&F1_23, 130), ("Prema '22".to_owned(), "F2".to_owned()));
        assert_eq!(car_of(&F1_23, 143), ("F1 23".to_owned(), "F1".to_owned()));
    }

    // ---- not driving ----

    #[test]
    fn no_lap_data_or_no_session_is_not_driving() {
        let mut d = Decoder::default();
        // Telemetry alone.
        assert!(!d.feed(&tele_packet(0, &sample_tele()), 0.0).unwrap().driving);
        // Session but no lap data.
        d.feed(&session_packet(UID, 0, 15, 11, 5793, false), 0.0);
        assert!(!d.feed(&tele_packet(0, &sample_tele()), 0.0).unwrap().driving);
        // Lap data but no session (a fresh decoder).
        let mut d = Decoder::default();
        d.feed(&lap_packet(0, &Lap::on_track(1, 100, 0, 5.0)), 0.0);
        assert!(!d.feed(&tele_packet(0, &sample_tele()), 0.0).unwrap().driving);
    }

    #[test]
    fn the_menu_garage_spectating_and_unknown_sessions_are_not_driving() {
        for y in ALL {
            let phase_with = |session: Vec<u8>, lap: Lap| {
                let mut d = Decoder::default();
                d.feed(&session, 0.0);
                d.feed(&lap_in(y, 0, &lap), 0.0);
                d.feed(&tele_packet_in(y.format, 0, &sample_tele()), 0.0).unwrap().phase
            };
            let driving_with = |session: Vec<u8>, lap: Lap| phase_with(session, lap) == Phase::Driving;
            let race = || race_session(y, 0);
            assert!(driving_with(race(), Lap::on_track(1, 100, 0, 5.0)));
            // In the garage.
            assert!(!driving_with(
                race(),
                Lap {
                    driver_status: 0,
                    ..Lap::on_track(1, 100, 0, 5.0)
                }
            ));
            assert_eq!(
                phase_with(
                    race(),
                    Lap {
                        driver_status: 0,
                        ..Lap::on_track(1, 100, 0, 5.0)
                    }
                ),
                Phase::Garage
            );
            assert_eq!(
                phase_with(session_in(y, UID, 0, 15, 11, 5793, true), Lap::on_track(1, 100, 0, 5.0)),
                Phase::Spectating
            );
            assert_eq!(phase_with(race(), Lap::on_track(0, 0, 0, 0.0)), Phase::Unknown);
            // Not an active car (inactive, finished, retired).
            for result in [0, 1, 3, 4, 7] {
                assert!(
                    !driving_with(
                        race(),
                        Lap {
                            result_status: result,
                            ..Lap::on_track(1, 100, 0, 5.0)
                        }
                    ),
                    "result {result}"
                );
            }
            // No lap number yet (zeroed lap data of a menu).
            assert!(!driving_with(race(), Lap::on_track(0, 0, 0, 0.0)));
            // Unknown session type, unknown track, spectating.
            assert!(!driving_with(
                session_in(y, UID, 0, 0, 11, 5793, false),
                Lap::on_track(1, 100, 0, 5.0)
            ));
            assert!(!driving_with(
                session_in(y, UID, 0, 15, -1, 5793, false),
                Lap::on_track(1, 100, 0, 5.0)
            ));
            assert!(!driving_with(
                session_in(y, UID, 0, 15, 11, 5793, true),
                Lap::on_track(1, 100, 0, 5.0)
            ));
            // Time trial counts (13 in 2023, 18 later).
            let time_trial = if y.format == 2023 { 13 } else { 18 };
            assert!(driving_with(
                session_in(y, UID, 0, time_trial, 11, 5793, false),
                Lap::on_track(1, 100, 0, 5.0)
            ));
        }
    }

    #[test]
    fn a_new_session_forgets_the_old_one() {
        let (mut d, _) = running(0);
        // The same car, another session: only telemetry has come, nothing else is known yet.
        let other = {
            let mut t = tele_packet(0, &sample_tele());
            t[7..15].copy_from_slice(&(UID + 1).to_le_bytes());
            t
        };
        let f = d.feed(&other, 3.0).unwrap();
        assert!(!f.driving);
        assert!(f.track.is_empty() && f.lap_time_s.is_none() && f.x.is_nan());
        assert_eq!(f.car, "F1 25");
    }

    /// Packets of another year (another game on the same port, even with the same session uid) start afresh: the
    /// session, lap and car of one game never reach the frames of another.
    #[test]
    fn another_years_packets_forget_the_old_game() {
        let (mut d, _) = running_in(&F1_24, 0);
        let f = d.feed(&tele_packet_in(2023, 0, &sample_tele()), 3.0).unwrap();
        assert_eq!(d.layout.map(|l| l.format), Some(2023));
        assert!(!f.driving);
        assert!(f.track.is_empty() && f.lap_time_s.is_none() && f.x.is_nan());
        assert_eq!(f.car, "F1 23");
    }

    // ---- bad input ----

    #[test]
    fn a_wrong_format_year_is_ignored() {
        let mut d = Decoder::default();
        for format in [2022, 2027, 2021, 0, 65_535] {
            assert!(d.feed(&tele_packet_in(format, 0, &sample_tele()), 0.0).is_none(), "format {format}");
            assert!(d.feed(&motion_packet(format, UID, 0, [1.0, 2.0, 3.0]), 0.0).is_none());
        }
        // Nothing of those reached the state.
        assert!(d.position.is_none() && d.session_uid.is_none() && d.layout.is_none());
    }

    #[test]
    fn a_wrong_size_is_ignored() {
        for y in ALL {
            for packet in &packet_set(y, 0) {
                let mut d = Decoder::default();
                let mut longer = packet.clone();
                longer.push(0);
                assert!(d.feed(&longer, 0.0).is_none());
                assert!(d.feed(&packet[..packet.len() - 1], 0.0).is_none());
                assert!(d.session_uid.is_none(), "a refused packet leaves no trace");
            }
            // A telemetry-sized packet that claims another id is held to that id's size.
            let mut d = Decoder::default();
            let mut wrong_id = tele_packet_in(y.format, 0, &sample_tele());
            wrong_id[6] = ID_LAP_DATA;
            assert!(d.feed(&wrong_id, 0.0).is_none());
            assert!(d.session_uid.is_none());
        }
    }

    #[test]
    fn other_packets_are_ignored() {
        let mut d = Decoder::default();
        for y in ALL {
            for id in [3u8, 5, 8, 9, 11, 12, 13, 14, 15, 16, 255] {
                for size in [1352, 1239, 1349] {
                    let mut w = header(y.format, id, UID, 0);
                    w.zeros(size - HEADER_SIZE);
                    assert!(d.feed(&w.0, 0.0).is_none(), "packet {id}");
                }
            }
        }
        assert!(d.session_uid.is_none());
    }

    #[test]
    fn garbage_and_truncated_packets_never_panic() {
        let mut d = Decoder::default();
        for y in ALL {
            let valid = packet_set(y, 3);
            for packet in &valid {
                for cut in 0..packet.len() {
                    d.feed(&packet[..cut], 0.0);
                }
            }
            // Valid sizes with random bytes (the format forced, so the body is read too).
            let mut state = 0x9e37_79b9_7f4a_7c15u64 ^ u64::from(y.format);
            let mut next = || {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                (state >> 33) as u8
            };
            for round in 0..300 {
                let packet = &valid[round % valid.len()];
                let mut junk: Vec<u8> = packet.iter().map(|_| next()).collect();
                junk[0..2].copy_from_slice(&y.format.to_le_bytes());
                junk[6] = packet[6];
                junk[27] = next() % 22;
                d.feed(&junk, 0.0);
                // And pure noise of random length.
                let len = usize::from(next()) * 8;
                let noise: Vec<u8> = (0..len).map(|_| next()).collect();
                d.feed(&noise, 0.0);
            }
        }
        assert!(d.feed(&[], 0.0).is_none());
        assert!(d.feed(&[0xff; 1], 0.0).is_none());
    }

    #[test]
    fn nan_and_infinite_distances_are_not_believed() {
        let mut d = Decoder::default();
        d.feed(&session_packet(UID, 0, 15, 11, 5793, false), 0.0);
        d.feed(&lap_packet(0, &Lap::on_track(1, 100, 0, f32::NAN)), 0.0);
        assert_eq!(d.feed(&tele_packet(0, &sample_tele()), 0.0).unwrap().dist_m, None);
        d.feed(&lap_packet(0, &Lap::on_track(1, 100, 0, f32::INFINITY)), 0.0);
        assert_eq!(d.feed(&tele_packet(0, &sample_tele()), 0.0).unwrap().dist_m, None);
    }

    // ---- the first guess ----

    #[test]
    fn names_the_game_whose_program_is_running_before_any_packet() {
        let guess = |names: &[&str]| {
            let running: Vec<String> = names.iter().map(|n| (*n).to_owned()).collect();
            layout_of_programs(&running).game_id
        };
        assert_eq!(guess(&["explorer.exe", "f1_25.exe"]), "f1");
        assert_eq!(guess(&["f1_24.exe"]), "f124");
        assert_eq!(guess(&["f1_23.exe", "steam.exe"]), "f123");
        assert_eq!(guess(&[]), "f1");
        assert_eq!(guess(&["f1_24.exe", "f1_23.exe"]), "f1", "two games: no guess");
        // The program names are the ones the reader is tried with.
        let reader = crate::games::READERS.iter().find(|r| r.family == "f1").expect("the F1 reader");
        for exe in ["f1_25.exe", "f1_24.exe", "f1_23.exe"] {
            assert!(reader.programs.contains(&exe), "{exe}");
        }
    }

    // ---- the socket ----

    fn loopback_pair_as(first_guess: &'static Layout) -> (F1Source, UdpSocket) {
        let source = F1Source::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), first_guess).expect("an ephemeral loopback port is free");
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        sender.connect(source.local_addr()).unwrap();
        (source, sender)
    }

    fn loopback_pair() -> (F1Source, UdpSocket) {
        loopback_pair_as(&F1_25)
    }

    #[test]
    fn identifies_itself() {
        let (source, _) = loopback_pair();
        assert_eq!(source.game_id(), "f1");
        assert_eq!(source.game_name(), "EA SPORTS F1 25");
        assert!(source.alive());
        assert_eq!(DEFAULT_PORT, 20777);
        let (source, _) = loopback_pair_as(&F1_23);
        assert_eq!((source.game_id(), source.game_name()), ("f123", "EA SPORTS F1 23"));
    }

    /// The name follows the format of the packets, whatever the first guess was.
    #[test]
    fn names_the_game_of_the_packets_it_reads() {
        let (mut source, sender) = loopback_pair();
        for (y, id, name) in [
            (&F1_24, "f124", "EA SPORTS F1 24"),
            (&F1_23, "f123", "EA SPORTS F1 23"),
            (&F1_25, "f1", "EA SPORTS F1 25"),
            (&F1_25_2026, "f1", "EA SPORTS F1 25"),
        ] {
            sender.send(&tele_packet_in(y.format, 0, &sample_tele())).unwrap();
            assert!(source.next(Duration::from_millis(500)).is_some());
            assert_eq!((source.game_id(), source.game_name()), (id, name));
        }
        // A refused format changes nothing.
        sender.send(&tele_packet_in(2022, 0, &sample_tele())).unwrap();
        assert!(source.next(Duration::from_millis(50)).is_none());
        assert_eq!(source.game_id(), "f1");
    }

    #[test]
    fn an_oversized_datagram_does_not_kill_the_door() {
        let (mut source, sender) = loopback_pair();
        // Bigger than the buffer: Windows says "message too long" for it, which is not the door's fault.
        sender.send(&vec![0u8; BUFFER + 500]).unwrap();
        sender.send(&tele_packet(0, &sample_tele())).unwrap();
        assert!(
            source.next(Duration::from_millis(500)).is_some(),
            "the next good packet still comes through"
        );
        assert!(source.alive());
        sender.send(&vec![0u8; BUFFER + 500]).unwrap();
        assert!(source.next(Duration::from_millis(50)).is_none());
        assert!(source.alive(), "an oversized datagram alone is nothing");
    }

    #[test]
    fn says_nothing_until_packets_come() {
        let (mut source, _sender) = loopback_pair();
        let started = Instant::now();
        assert!(source.next(Duration::from_millis(30)).is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(source.alive());
    }

    #[test]
    fn a_busy_port_gives_no_source() {
        let (first, _) = loopback_pair();
        assert!(F1Source::bind(first.local_addr(), &F1_25).is_none());
    }

    #[test]
    fn gives_a_frame_for_each_telemetry_packet_over_udp() {
        let (mut source, sender) = loopback_pair();
        sender.send(&motion_packet(FORMAT, UID, 2, [10.0, 20.0, 30.0])).unwrap();
        sender.send(&session_packet(UID, 2, 15, 11, 5793, false)).unwrap();
        sender.send(&lap_packet(2, &Lap::on_track(1, 2000, 0, 80.0))).unwrap();
        sender.send(&participants_packet(2, 8)).unwrap();
        sender.send(b"not a packet at all").unwrap();
        sender.send(&tele_packet_in(2022, 2, &sample_tele())).unwrap();
        sender.send(&tele_packet(2, &sample_tele())).unwrap();
        let f = source.next(Duration::from_millis(500)).expect("a frame");
        assert!(f.driving);
        assert!(close(f.speed_ms, 50.0));
        assert_eq!((f.x, f.y, f.z), (10.0, 20.0, 30.0));
        assert_eq!(f.car, "McLaren");
        assert_eq!(f.track, "Monza");
        // The next frame's clock never goes back.
        sender.send(&tele_packet(2, &sample_tele())).unwrap();
        let g = source.next(Duration::from_millis(500)).expect("another frame");
        assert!(g.clock_s >= f.clock_s);
        assert!(source.next(Duration::from_millis(10)).is_none());
    }

    /// A scripted lap of the year over loopback, cut into a lap file by the real lap cutter.
    fn a_lap_flows_in(y: &'static Layout) {
        let (mut source, sender) = loopback_pair_as(y);
        let mut cutter = LapCutter::new(source.game_id());
        let mut laps = Vec::new();
        sender.send(&race_session(y, 0)).unwrap();
        sender.send(&participants_in(y, 0, 1)).unwrap();

        // Lap 1: 6.5 s at 20 Hz, then lap 2 begins (the game raises the lap number and shows the last lap time).
        let tick = |source: &mut F1Source, lap: &Lap, pos: f32| {
            sender.send(&motion_packet(y.format, UID, 0, [pos, 0.0, -pos])).unwrap();
            sender.send(&lap_in(y, 0, lap)).unwrap();
            sender.send(&tele_packet_in(y.format, 0, &sample_tele())).unwrap();
            source.next(Duration::from_millis(500)).expect("a frame for every telemetry packet")
        };
        for i in 0..130u32 {
            let ms = i * 50;
            let f = tick(&mut source, &Lap::on_track(1, ms, 0, ms as f32 * 0.9), i as f32);
            assert!(f.driving && f.lap == 1);
            laps.extend(cutter.on_frame(&f, 1_794_312_000_000 + i64::from(ms)));
        }
        assert!(laps.is_empty(), "a lap is not done before the next one starts");
        for i in 0..4u32 {
            let ms = i * 50;
            let f = tick(&mut source, &Lap::on_track(2, ms, 6500, ms as f32 * 0.9), 130.0 + i as f32);
            assert_eq!((f.lap, f.last_lap_s), (2, Some(6.5)));
            laps.extend(cutter.on_frame(&f, 1_794_312_000_000 + 6500 + i64::from(ms)));
        }
        assert_eq!(source.game_id(), y.game_id);
        assert_eq!(laps.len(), 1, "exactly one lap");
        let lap = &laps[0];
        assert_eq!(lap.game, y.game_id);
        assert_eq!(lap.lap_number, 1);
        assert_eq!(lap.time_ms, 6500, "the game's own time, not the one measured here");
        assert!(lap.valid);
        assert_eq!(lap.track_name, "Monza");
        assert_eq!(lap.car_name, "Ferrari");
        assert_eq!(lap.car_class.as_deref(), Some("F1"));
        assert_eq!(lap.track_length_m, Some(5793.0));
        assert_eq!(lap.sample_count(), 130);
        for id in [
            "t", "dist", "speed", "rpm", "gear", "throttle", "brake", "clutch", "steer", "x", "y", "z",
        ] {
            assert!(lap.channel(id).is_some(), "channel {id}");
        }
        assert!(lap.channel("fuel").is_none(), "the game gives no fuel in litres");
    }

    #[test]
    fn a_lap_flows_from_udp_to_the_lap_cutter() {
        a_lap_flows_in(&F1_25);
    }

    #[test]
    fn a_lap_of_f1_24_flows_from_udp_to_the_lap_cutter() {
        a_lap_flows_in(&F1_24);
    }

    #[test]
    fn a_lap_of_f1_23_flows_from_udp_to_the_lap_cutter() {
        a_lap_flows_in(&F1_23);
    }

    /// The 2026 Season Pack format is F1 25: its lap is filed under game id `"f1"`.
    #[test]
    fn a_lap_of_the_2026_season_pack_flows_from_udp_to_the_lap_cutter_as_f1() {
        a_lap_flows_in(&F1_25_2026);
    }
}
