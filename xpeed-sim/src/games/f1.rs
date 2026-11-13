//! EA SPORTS F1 25, F1 24 and F1 23: the UDP telemetry the games send to this computer ("Data Out").
//!
//! The game only sends while it is running AND its telemetry output is switched on. The person has to set, in the
//! game: **Settings > Telemetry Settings**
//!
//! * UDP Telemetry: **On**
//! * UDP IP Address: the IP of this computer (`127.0.0.1` when the game runs on the same PC; with "Broadcast Mode"
//!   On the game ignores the address and sends to the whole network, which also reaches this program)
//! * UDP Port: **20777** (the games' default; this reader listens on it, on every local address)
//! * UDP Format: **the game's own year**: 2025 in F1 25, 2024 in F1 24, 2023 in F1 23. Each game also offers the
//!   formats of the years before it; the format decides how a packet is read and which game its laps are filed
//!   under, so F1 25 set to "2024" would be read, and its laps saved, as F1 24. Any other format (the "2026" of the
//!   F1 25 Season Pack, 2022 and older) is refused.
//! * UDP Send Rate: 20 Hz or more (60 Hz gives the best laps; fewer packets means a coarser lap trace)
//!
//! One socket serves the three games: the `packetFormat` of every packet's header says which year's layout it has.
//! The game id follows it: `"f1"` for 2025, `"f124"` for 2024, `"f123"` for 2023.
//!
//! Sources. EA publishes each year's "UDP Specification" on the EA Sports F1 forum, but its site refuses automated
//! downloads (HTTP 403), so each year's layouts were taken from faithful copies of the official text and every size
//! below is the one the spec states (proven by the `sizes_*` tests, which sum the fields in the spec's order):
//!
//! * F1 25 (format 2025): EA's "F1 25 UDP Specification", Game Info Hub,
//!   <https://forums.ea.com/blog/f1-games-game-info-hub-en/f1%c2%ae-25-udp-specification/12187347> (the same thread
//!   carries the 2026 Season Pack variant), cross-checked field by field against the community parser the spec itself
//!   is used with, `F1Game.UDP` (<https://github.com/volodymyr-fed/F1Game.UDP>, mirrored at `Addzyyy/open-f1-parser`).
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
//! | id | packet        | 2025 | 2024 | 2023 | used for                                                             |
//! |----|---------------|------|------|------|----------------------------------------------------------------------|
//! | 0  | Motion        | 1349 | 1349 | 1349 | world position x, y, z of the player's car                           |
//! | 1  | Session       | 753  | 753  | 644  | track id, track length, session type, spectating                     |
//! | 2  | Lap Data      | 1285 | 1285 | 1131 | lap time, last lap time, lap distance, lap number, pits, lap invalid |
//! | 4  | Participants  | 1284 | 1350 | 1306 | team id of the player's car (the car name)                           |
//! | 6  | Car Telemetry | 1352 | 1352 | 1352 | speed, throttle, steer, brake, clutch, gear, rpm: one `Frame` each   |
//!
//! What changes between the years, for these packets: the Session packet of 2023 has 56 weather forecast samples (64
//! later) and ends after `numRedFlagPeriods` (2024 added the rule settings, the weekend structure and the sector
//! starts); the Lap Data of 2023 gives the deltas to the car in front and to the leader as plain milliseconds (2024
//! split them into milliseconds and minutes) and has no speed trap fields, so every field after `sector2` sits
//! elsewhere; the participant's name is 48 bytes in 2023 and 2024 (32 in 2025), 2024 added `techLevel` and 2025 the
//! livery colours. Motion, Car Telemetry and the fields read from the header and from the start of the Session packet
//! are the same in the three years. The team ids differ (Appendix: Team IDs of each year).
//!
//! Car Status (1239 bytes in the three years) and Car Damage (953 bytes in 2023 and 2024, 1041 in 2025, which added
//! `tyreBlisters[4]`) also feed the car's state: the aids, the brake bias, the pit limiter, the DRS permission and the
//! FIA flag from Car Status, the wing, floor, gearbox and engine damage (percentages) from Car Damage. Every other
//! packet (events, setups, history...) is ignored. Car Status gives the fuel as a mass in kilograms and the spec
//! states no density, so `fuel_l` stays NaN. The one `engineTemperature` of Car Telemetry is not said to be the
//! water's or the oil's, so neither is given; the spec has no suspension damage, headlights or handbrake.

use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use crate::game::{CarState, Drs, Flag, Frame, Source};
use crate::shm::Page;

/// The port the game sends to unless the person changes it (the spec's default).
pub const DEFAULT_PORT: u16 = 20777;

const HEADER_SIZE: usize = 29;
/// Every per-car array of the spec has 22 entries.
const CARS: usize = 22;

const ID_MOTION: u8 = 0;
const ID_SESSION: u8 = 1;
const ID_LAP_DATA: u8 = 2;
const ID_PARTICIPANTS: u8 = 4;
const ID_CAR_TELEMETRY: u8 = 6;
const ID_CAR_STATUS: u8 = 7;
const ID_CAR_DAMAGE: u8 = 10;

/// `CarStatusData` is 55 bytes in the three years: `PacketCarStatusData` is 1239 bytes.
const STATUS_CAR: usize = 55;
const STATUS_SIZE: usize = HEADER_SIZE + CARS * STATUS_CAR;

// The same in the three years.
const MOTION_CAR: usize = 60;
const TELEMETRY_CAR: usize = 60;
const MOTION_SIZE: usize = HEADER_SIZE + CARS * MOTION_CAR; // 1349
const TELEMETRY_SIZE: usize = HEADER_SIZE + CARS * TELEMETRY_CAR + 3; // + mfdPanel x2, suggestedGear = 1352

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

// Per-car fields (offsets from the start of the car's entry).
const M_POS_X: usize = 0; // f32 x3: worldPositionX, Y, Z (metres)

const L_LAST_LAP_MS: usize = 0; // u32, every year
const L_CURRENT_LAP_MS: usize = 4; // u32, every year

const P_TEAM_ID: usize = 3; // u8, every year

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
    lap_num: usize,       // u8
    pit_status: usize,    // u8: 0 none, 1 pitting, 2 in pit area
    invalid: usize,       // u8: 0 valid, 1 invalid
    driver_status: usize, // u8: 0 in garage, 1 flying lap, 2 in lap, 3 out lap, 4 on track
    result_status: usize, // u8: 0 invalid, 1 inactive, 2 active, 3 finished, ...
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
    /// One car's entry in Lap Data, and where its fields are.
    lap_car: usize,
    lap: LapFields,
    /// One car's entry in Participants.
    participant_car: usize,
    /// Where `frontLeftWingDamage` sits in a `CarDamageData`: after tyresWear[4] (f32), tyresDamage[4] and
    /// brakesDamage[4], and in 2025 also tyreBlisters[4]. The entry ends `D_TAIL` bytes later.
    damage_wings: usize,
    /// The year's Appendix: Team IDs, with the class each team races in.
    team: fn(u8) -> Option<(&'static str, &'static str)>,
}

impl Layout {
    /// Lap Data: the 22 entries, then timeTrialPBCarIdx and timeTrialRivalCarIdx.
    const fn lap_data_size(&self) -> usize {
        HEADER_SIZE + CARS * self.lap_car + 2
    }

    /// Participants: numActiveCars, then the 22 entries.
    const fn participants_size(&self) -> usize {
        HEADER_SIZE + 1 + CARS * self.participant_car
    }

    /// The size the spec gives for a packet this reader uses; `None` for every packet it does not read.
    fn expected_size(&self, packet_id: u8) -> Option<usize> {
        match packet_id {
            ID_MOTION => Some(MOTION_SIZE),
            ID_SESSION => Some(self.session_size),
            ID_LAP_DATA => Some(self.lap_data_size()),
            ID_PARTICIPANTS => Some(self.participants_size()),
            ID_CAR_TELEMETRY => Some(TELEMETRY_SIZE),
            ID_CAR_STATUS => Some(STATUS_SIZE),
            ID_CAR_DAMAGE => Some(HEADER_SIZE + CARS * (self.damage_wings + D_TAIL)),
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
    lap_car: 57,
    lap: LapFields {
        distance: 20,
        lap_num: 33,
        pit_status: 34,
        invalid: 37,
        driver_status: 44,
        result_status: 45,
    },
    participant_car: 57,
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
    lap_car: 57,
    lap: LapFields {
        distance: 20,
        lap_num: 33,
        pit_status: 34,
        invalid: 37,
        driver_status: 44,
        result_status: 45,
    },
    participant_car: 60,
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
    lap_car: 50,
    lap: LapFields {
        distance: 18,
        lap_num: 31,
        pit_status: 32,
        invalid: 35,
        driver_status: 42,
        result_status: 43,
    },
    participant_car: 58,
    damage_wings: 24,
    team: team_23,
};

/// The formats read, newest first.
const LAYOUTS: [&Layout; 3] = [&F1_25, &F1_24, &F1_23];

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

fn u16_at(p: &Page, at: usize) -> u16 {
    u16::from(p.u8_at(at)) | (u16::from(p.u8_at(at + 1)) << 8)
}

fn u64_at(p: &Page, at: usize) -> u64 {
    u64::from(p.u32_at(at)) | (u64::from(p.u32_at(at + 4)) << 32)
}

fn i8_at(p: &Page, at: usize) -> i8 {
    i8::from_le_bytes([p.u8_at(at)])
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
    /// `None` unless the bytes start with a header of a format this reader reads (2025, 2024, 2023).
    fn parse(data: &[u8]) -> Option<Header> {
        if data.len() < HEADER_SIZE {
            return None;
        }
        let p = Page(data);
        Some(Header {
            layout: layout_of(u16_at(&p, H_FORMAT))?,
            packet_id: p.u8_at(H_PACKET_ID),
            session_uid: u64_at(&p, H_SESSION_UID),
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
        _ => return format!("Track {id}"),
    };
    name.to_owned()
}

/// The team of the F1 25 table (Appendix: Team IDs) and the class it races in. `None` for an id the table does not
/// have (the 2026 Season Pack adds teams the 2025 format does not name).
fn team_25(id: u8) -> Option<(&'static str, &'static str)> {
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

/// The F1 24 table: the one of F1 25 without the 2024 F2 teams (158 to 168), which F1 24 does not have.
fn team_24(id: u8) -> Option<(&'static str, &'static str)> {
    match id {
        158..=168 => None,
        _ => team_25(id),
    }
}

/// The F1 23 table, with the class each car races in: the F2 teams of 2021 and 2022 are F2, the road and safety
/// cars are Supercars (the name of their formula in the Session packet), the rest is F1.
fn team_23(id: u8) -> Option<(&'static str, &'static str)> {
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
    lap_number: u8,
    pit_status: u8,
    invalid: bool,
    driver_status: u8,
    result_status: u8,
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
    team_id: Option<u8>,
    status: Option<StatusInfo>,
    damage: Option<DamageInfo>,
}

impl Decoder {
    /// Reads one datagram. Returns a frame when it was a Car Telemetry packet of a format this reader reads and the
    /// right size for that format. Never panics, whatever the bytes are.
    fn feed(&mut self, data: &[u8], clock_s: f64) -> Option<Frame> {
        let header = Header::parse(data)?;
        let layout = header.layout;
        let size = layout.expected_size(header.packet_id)?;
        if data.len() != size || header.player_car >= CARS {
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
                let base = at(MOTION_CAR) + M_POS_X;
                self.position = Some([page.f32_at(base), page.f32_at(base + 4), page.f32_at(base + 8)]);
                None
            }
            ID_SESSION => {
                self.session = Some(SessionInfo {
                    session_type: page.u8_at(S_SESSION_TYPE),
                    track_id: i8_at(&page, S_TRACK_ID),
                    track_length_m: u16_at(&page, S_TRACK_LENGTH),
                    spectating: page.u8_at(S_IS_SPECTATING) != 0,
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
                    lap_number: page.u8_at(car + f.lap_num),
                    pit_status: page.u8_at(car + f.pit_status),
                    invalid: page.u8_at(car + f.invalid) != 0,
                    driver_status: page.u8_at(car + f.driver_status),
                    result_status: page.u8_at(car + f.result_status),
                });
                None
            }
            ID_PARTICIPANTS => {
                // numActiveCars comes first, then the 22 entries.
                let entry = HEADER_SIZE + 1 + header.player_car * layout.participant_car;
                self.team_id = Some(page.u8_at(entry + P_TEAM_ID));
                None
            }
            ID_CAR_STATUS => {
                let car = at(STATUS_CAR);
                self.status = Some(StatusInfo {
                    traction_control: page.u8_at(car + C_TRACTION_CONTROL),
                    anti_lock: page.u8_at(car + C_ANTI_LOCK),
                    front_brake_bias: page.u8_at(car + C_FRONT_BRAKE_BIAS),
                    pit_limiter: page.u8_at(car + C_PIT_LIMITER),
                    drs_allowed: page.u8_at(car + C_DRS_ALLOWED),
                    fia_flag: i8_at(&page, car + C_FIA_FLAGS),
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
            ID_CAR_TELEMETRY => Some(self.frame(layout, &page, at(TELEMETRY_CAR), clock_s)),
            _ => None,
        }
    }

    fn frame(&self, layout: &Layout, page: &Page, car: usize, clock_s: f64) -> Frame {
        let mut f = Frame::empty();
        f.clock_s = clock_s;

        let speed_kmh = u16_at(page, car + T_SPEED_KMH);
        f.speed_ms = f32::from(speed_kmh) / 3.6;
        f.rpm = f32::from(u16_at(page, car + T_RPM));
        let gear = i8_at(page, car + T_GEAR);
        // -1 reverse, 0 neutral, 1..8; anything else is not a gear.
        f.gear = if (-1..=8).contains(&gear) { f32::from(gear) } else { f32::NAN };
        f.throttle = page.f32_at(car + T_THROTTLE).clamp(0.0, 1.0);
        f.brake = page.f32_at(car + T_BRAKE).clamp(0.0, 1.0);
        f.steer = page.f32_at(car + T_STEER).clamp(-1.0, 1.0);
        f.clutch = (f32::from(page.u8_at(car + T_CLUTCH)) / 100.0).clamp(0.0, 1.0);
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
        }
        if let Some(l) = &self.lap {
            f.lap = i32::from(l.lap_number);
            f.lap_time_s = Some(f64::from(l.current_lap_ms) / 1000.0);
            f.last_lap_s = (l.last_lap_ms > 0).then(|| f64::from(l.last_lap_ms) / 1000.0);
            f.lap_valid = Some(!l.invalid);
            f.dist_m = l.distance_m.is_finite().then(|| f64::from(l.distance_m.max(0.0)));
            f.in_pits = l.pit_status != 0;
        }
        f.driving = self.driving();
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
            state.flag = match s.fia_flag {
                1 => Some(Flag::Green),
                2 => Some(Flag::Blue),
                3 => Some(Flag::Yellow),
                _ => None,
            };
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
    fn driving(&self) -> bool {
        let (Some(s), Some(l)) = (&self.session, &self.lap) else {
            return false;
        };
        s.session_type != 0
            && s.track_id >= 0
            && !s.spectating
            && l.lap_number >= 1
            && l.driver_status != 0 // 0 = in garage
            && l.result_status == 2 // 2 = active
    }
}

/// The open door: a UDP socket the game sends its telemetry to.
pub struct F1Source {
    socket: UdpSocket,
    start: Instant,
    decoder: Decoder,
    /// The game named before any packet has come (from the program that is running).
    first_guess: &'static Layout,
    buf: Vec<u8>,
    alive: bool,
}

impl F1Source {
    /// Binds `addr`; `None` when that fails (the port is busy: another program, for example a dashboard, owns it).
    /// std gives no way to ask for address reuse before the bind, so a port another program holds is not shared.
    fn bind(addr: SocketAddr, first_guess: &'static Layout) -> Option<F1Source> {
        let socket = UdpSocket::bind(addr).ok()?;
        Some(F1Source {
            socket,
            start: Instant::now(),
            decoder: Decoder::default(),
            first_guess,
            // The biggest packet of the formats is well under 1500 bytes; a longer datagram is cut and refused by size.
            buf: vec![0; 2048],
            alive: true,
        })
    }

    /// The game of the packets read so far, or the first guess before any.
    fn layout(&self) -> &'static Layout {
        self.decoder.layout.unwrap_or(self.first_guess)
    }

    #[cfg(test)]
    fn local_addr(&self) -> SocketAddr {
        self.socket.local_addr().expect("a bound socket has an address")
    }
}

/// Opens the door on UDP port 20777, all local addresses. `None` when the port is not free.
pub fn open() -> Option<Box<dyn Source>> {
    let first_guess = layout_of_programs(&crate::win::running_programs());
    let source = F1Source::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, DEFAULT_PORT)), first_guess)?;
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
            let wait = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
            if self.socket.set_read_timeout(Some(wait)).is_err() {
                self.alive = false;
                return None;
            }
            match self.socket.recv_from(&mut self.buf) {
                Ok((n, _)) => {
                    let clock_s = self.start.elapsed().as_secs_f64();
                    if let Some(frame) = self.decoder.feed(&self.buf[..n], clock_s) {
                        return Some(frame);
                    }
                }
                Err(e) => match e.kind() {
                    ErrorKind::WouldBlock | ErrorKind::TimedOut => return None,
                    // Windows reports a refused earlier send on a UDP socket this way; nothing is wrong with the door.
                    ErrorKind::ConnectionReset | ErrorKind::Interrupted => {}
                    _ => {
                        self.alive = false;
                        return None;
                    }
                },
            }
            if Instant::now() >= deadline {
                return None;
            }
        }
    }

    fn alive(&self) -> bool {
        self.alive
    }

    fn listens(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lapcut::LapCutter;

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
    const ALL: [&Layout; 3] = LAYOUTS;

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

    /// CarMotionData (every year): worldPosition x3 f32, worldVelocity x3 f32, worldForwardDir x3 i16, worldRightDir
    /// x3 i16, gForce lateral/longitudinal/vertical f32, yaw, pitch, roll f32 = 60 bytes.
    fn motion_car(w: &mut W, pos: [f32; 3]) {
        w.f32(pos[0]).f32(pos[1]).f32(pos[2]);
        w.f32(1.0).f32(2.0).f32(3.0);
        w.i16(100).i16(200).i16(300).i16(400).i16(500).i16(600);
        w.f32(0.1).f32(0.2).f32(0.3);
        w.f32(0.4).f32(0.5).f32(0.6);
    }

    fn motion_packet(format: u16, uid: u64, player: u8, pos: [f32; 3]) -> Vec<u8> {
        let mut w = header(format, ID_MOTION, uid, player);
        for i in 0..CARS {
            if i == usize::from(player) {
                motion_car(&mut w, pos);
            } else {
                motion_car(&mut w, [9000.0 + i as f32, -9000.0, 7.0]);
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
        w.u32(l.last_ms).u32(l.current_ms);
        w.u16(11_111).u8(0).u16(22_222).u8(0);
        if y.format == 2023 {
            w.u16(333).u16(444);
        } else {
            w.u16(333).u8(0).u16(444).u8(0);
        }
        w.f32(l.distance).f32(l.distance + 1000.0).f32(0.0);
        w.u8(3)
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
            lap_num: 9,
            pit: 2,
            invalid: 1,
            driver_status: 0,
            result_status: 7,
        };
        let mut w = header(y.format, ID_LAP_DATA, UID, player);
        for i in 0..CARS {
            lap_car(y, &mut w, if i == usize::from(player) { l } else { &decoy });
        }
        w.u8(255).u8(255); // timeTrialPBCarIdx, timeTrialRivalCarIdx
        w.0
    }

    fn lap_packet(player: u8, l: &Lap) -> Vec<u8> {
        lap_in(&F1_25, player, l)
    }

    /// ParticipantData: aiControlled, driverId, networkId, teamId, myTeam, raceNumber, nationality, then
    /// 2025: name[32], yourTelemetry, showOnlineNames, techLevel u16, platform, numColours, liveryColours[4] (r,g,b);
    /// 2024: name[48], yourTelemetry, showOnlineNames, techLevel u16, platform;
    /// 2023: name[48], yourTelemetry, showOnlineNames, platform.
    fn participants_in(y: &Layout, player: u8, team_id: u8) -> Vec<u8> {
        let mut w = header(y.format, ID_PARTICIPANTS, UID, player);
        w.u8(CARS as u8); // numActiveCars
        for i in 0..CARS {
            let team_id = if i == usize::from(player) { team_id } else { 8 };
            w.u8(0).u8(3).u8(255).u8(team_id).u8(0).u8(16).u8(5);
            match y.format {
                2025 => {
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

    fn participants_packet(player: u8, team_id: u8) -> Vec<u8> {
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

    /// CarTelemetryData (every year, 60 bytes): speed u16, throttle f32, steer f32, brake f32, clutch u8, gear i8,
    /// engineRPM u16, drs u8, revLightsPercent u8, revLightsBitValue u16, brakesTemperature[4] u16,
    /// tyresSurfaceTemperature[4] u8, tyresInnerTemperature[4] u8, engineTemperature u16, tyresPressure[4] f32,
    /// surfaceType[4] u8.
    fn tele_car(w: &mut W, t: &Tele) {
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
        w.u16(105);
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
        for i in 0..CARS {
            tele_car(&mut w, if i == usize::from(player) { t } else { &decoy });
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

    /// CarStatusData (every year, 55 bytes): tractionControl, antiLockBrakes, fuelMix, frontBrakeBias,
    /// pitLimiterStatus u8, fuelInTank, fuelCapacity, fuelRemainingLaps f32, maxRPM, idleRPM u16, maxGears,
    /// drsAllowed u8, drsActivationDistance u16, actualTyreCompound, visualTyreCompound, tyresAgeLaps u8,
    /// vehicleFiaFlags i8, enginePowerICE, enginePowerMGUK, ersStoreEnergy f32, ersDeployMode u8, three ers f32,
    /// networkPaused u8.
    fn status_car(w: &mut W, c: &Car) {
        w.u8(c.traction_control)
            .u8(c.anti_lock)
            .u8(1)
            .u8(c.front_brake_bias)
            .u8(c.pit_limiter);
        w.f32(50.0).f32(110.0).f32(20.0);
        w.u16(13_000).u16(4_000).u8(8).u8(c.drs_allowed).u16(0);
        w.u8(18).u8(17).u8(3).i8(c.fia_flags);
        w.f32(1.0).f32(2.0).f32(3.0).u8(1).f32(4.0).f32(5.0).f32(6.0).u8(0);
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
        for i in 0..CARS {
            status_car(&mut w, if i == usize::from(player) { c } else { &decoy });
        }
        w.0
    }

    /// CarDamageData: tyresWear[4] f32, tyresDamage[4], brakesDamage[4] u8, (2025: tyreBlisters[4] u8), then the
    /// six wing and body parts, drsFault, ersFault, gearBoxDamage, engineDamage, six engine wears, engineBlown and
    /// engineSeized (u8). 42 bytes in 2023 and 2024, 46 in 2025.
    fn damage_car(format: u16, w: &mut W, c: &Car) {
        for _ in 0..4 {
            w.f32(7.0);
        }
        w.zeros(8);
        if format == 2025 {
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
        for i in 0..CARS {
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
        for format in [2022, 2026, 2021, 2020, 2019, 0, 25, 65_535] {
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
                (2025, "f1", "EA SPORTS F1 25", "F1 25"),
                (2024, "f124", "EA SPORTS F1 24", "F1 24"),
                (2023, "f123", "EA SPORTS F1 23", "F1 23"),
            ]
        );
        assert!(layout_of(2022).is_none() && layout_of(2026).is_none());
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
        assert_eq!(MOTION_SIZE, 1349);

        // CarTelemetryData (+ mfdPanelIndex, mfdPanelIndexSecondaryPlayer, suggestedGear): every year, 1352 bytes.
        let telemetry = [2, 4, 4, 4, 1, 1, 2, 1, 1, 2, 8, 4, 4, 2, 16, 4];
        assert_eq!(telemetry.iter().sum::<usize>(), TELEMETRY_CAR);
        assert_eq!(HEADER_SIZE + CARS * telemetry.iter().sum::<usize>() + 3, 1352);
        assert_eq!(TELEMETRY_SIZE, 1352);

        // CarStatusData (not read, but its size is part of each spec's table): 1239 bytes in the three years.
        let status = [1, 1, 1, 1, 1, 4, 4, 4, 2, 2, 1, 1, 2, 1, 1, 1, 1, 4, 4, 4, 1, 4, 4, 4, 1];
        assert_eq!(HEADER_SIZE + CARS * status.iter().sum::<usize>(), 1239);
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
        assert_eq!(field_offsets(&lap)[14], F1_25.lap.lap_num);

        // ParticipantData (+ numActiveCars): name[32], techLevel, numColours, liveryColours[4] of 3 bytes.
        let participant = [1, 1, 1, 1, 1, 1, 1, 32, 1, 1, 2, 1, 1, 12];
        assert_eq!(participant.iter().sum::<usize>(), F1_25.participant_car);
        assert_eq!(F1_25.participants_size(), 1284);

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
        assert_eq!(field_offsets(&participant)[3], P_TEAM_ID);

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
        assert_eq!(field_offsets(&participant)[3], P_TEAM_ID);

        // PacketSessionData: 56 forecast samples, ends after numRedFlagPeriods.
        let session = session_2023_fields(56);
        assert_eq!(HEADER_SIZE + session.iter().sum::<usize>(), 644);
        assert_eq!(F1_23.session_size, 644);
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
    }

    /// The same session in each year's own layout gives the same frame.
    #[test]
    fn every_year_gives_the_same_frame_from_its_own_layout() {
        let (_, want) = running(0);
        for y in ALL {
            for player in [0u8, 7, 21] {
                let (d, f) = running_in(y, player);
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
    fn a_player_index_outside_the_22_cars_is_refused() {
        let mut d = Decoder::default();
        for y in ALL {
            assert!(d.feed(&tele_packet_in(y.format, 22, &sample_tele()), 1.0).is_none());
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
        let t = Tele {
            throttle: 1.7,
            steer: -3.0,
            brake: -0.5,
            clutch: 200,
            ..sample_tele()
        };
        let f = d.feed(&tele_packet(0, &t), 0.0).unwrap();
        assert_eq!((f.throttle, f.steer, f.brake, f.clutch), (1.0, -1.0, 0.0, 1.0));
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
        let car_of = |y: &Layout, team_id: u8| {
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
            let driving_with = |session: Vec<u8>, lap: Lap| {
                let mut d = Decoder::default();
                d.feed(&session, 0.0);
                d.feed(&lap_in(y, 0, &lap), 0.0);
                d.feed(&tele_packet_in(y.format, 0, &sample_tele()), 0.0).unwrap().driving
            };
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
        for format in [2022, 2026, 2021, 0, 65_535] {
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
        ] {
            sender.send(&tele_packet_in(y.format, 0, &sample_tele())).unwrap();
            assert!(source.next(Duration::from_millis(500)).is_some());
            assert_eq!((source.game_id(), source.game_name()), (id, name));
        }
        // A refused format changes nothing.
        sender.send(&tele_packet_in(2026, 0, &sample_tele())).unwrap();
        assert!(source.next(Duration::from_millis(50)).is_none());
        assert_eq!(source.game_id(), "f1");
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
        sender.send(&tele_packet_in(2026, 2, &sample_tele())).unwrap();
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
}
