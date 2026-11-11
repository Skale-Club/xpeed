//! EA SPORTS F1 25: the UDP telemetry the game sends to this computer ("Data Out").
//!
//! The game only sends while it is running AND its telemetry output is switched on. The person has to set, in the
//! game: **Settings > Telemetry Settings**
//!
//! * UDP Telemetry: **On**
//! * UDP IP Address: the IP of this computer (`127.0.0.1` when the game runs on the same PC; with "Broadcast Mode"
//!   On the game ignores the address and sends to the whole network, which also reaches this program)
//! * UDP Port: **20777** (the game's default; this reader listens on it, on every local address)
//! * UDP Format: **2025** (the 2026 Season Pack offers a "2026" format: this reader refuses anything but 2025)
//! * UDP Send Rate: 20 Hz or more (60 Hz gives the best laps; fewer packets means a coarser lap trace)
//!
//! Source: EA's "F1 25 UDP Specification" (Data Out format) on the EA Sports F1 forum, Game Info Hub:
//! <https://forums.ea.com/blog/f1-games-game-info-hub-en/f1%c2%ae-25-udp-specification/12187347>
//! (the same thread carries the 2026 Season Pack variant). EA's site refuses automated downloads, so the layouts
//! below were cross-checked field by field against the community parser the spec itself is used with,
//! `F1Game.UDP` (<https://github.com/volodymyr-fed/F1Game.UDP>, mirrored at `Addzyyy/open-f1-parser`), whose
//! constants state the same packet sizes as the spec (see the `sizes_*` tests).
//!
//! What is read (all little-endian, packed, no padding; every packet starts with the 29-byte header):
//!
//! | id | packet       | size | used for                                                              |
//! |----|--------------|------|-----------------------------------------------------------------------|
//! | 0  | Motion       | 1349 | world position x, y, z of the player's car                            |
//! | 1  | Session      | 753  | track id, track length, session type, spectating                      |
//! | 2  | Lap Data     | 1285 | lap time, last lap time, lap distance, lap number, pits, lap invalid  |
//! | 4  | Participants | 1284 | team id of the player's car (the car name)                            |
//! | 6  | Car Telemetry| 1352 | speed, throttle, steer, brake, clutch, gear, rpm: one `Frame` per packet |
//!
//! Every other packet (events, setups, car status, damage, history...) is ignored. Car Status gives the fuel as a
//! mass in kilograms and the spec states no density, so `fuel_l` stays NaN.

use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use crate::game::{Frame, Source};
use crate::shm::Page;

/// The port the game sends to unless the person changes it (the spec's default).
pub const DEFAULT_PORT: u16 = 20777;
/// The only packet format read: the header's `packetFormat` of F1 25.
const FORMAT: u16 = 2025;

const HEADER_SIZE: usize = 29;
/// Every per-car array of the spec has 22 entries.
const CARS: usize = 22;

const ID_MOTION: u8 = 0;
const ID_SESSION: u8 = 1;
const ID_LAP_DATA: u8 = 2;
const ID_PARTICIPANTS: u8 = 4;
const ID_CAR_TELEMETRY: u8 = 6;

const MOTION_CAR: usize = 60;
const LAP_CAR: usize = 57;
const PARTICIPANT_CAR: usize = 57;
const TELEMETRY_CAR: usize = 60;

const MOTION_SIZE: usize = HEADER_SIZE + CARS * MOTION_CAR; // 1349
const SESSION_SIZE: usize = 753;
const LAP_DATA_SIZE: usize = HEADER_SIZE + CARS * LAP_CAR + 2; // + timeTrialPBCarIdx, timeTrialRivalCarIdx = 1285
const PARTICIPANTS_SIZE: usize = HEADER_SIZE + 1 + CARS * PARTICIPANT_CAR; // + numActiveCars = 1284
const TELEMETRY_SIZE: usize = HEADER_SIZE + CARS * TELEMETRY_CAR + 3; // + mfdPanel x2, suggestedGear = 1352

// Header (offsets).
const H_FORMAT: usize = 0;
const H_PACKET_ID: usize = 6;
const H_SESSION_UID: usize = 7;
const H_PLAYER_CAR: usize = 27;

// Session packet (offsets from the start of the packet).
const S_TRACK_LENGTH: usize = 33; // u16, metres
const S_SESSION_TYPE: usize = 35; // u8, 0 unknown
const S_TRACK_ID: usize = 36; // i8, -1 unknown
const S_IS_SPECTATING: usize = 44; // u8

// Per-car fields (offsets from the start of the car's entry).
const M_POS_X: usize = 0; // f32 x3: worldPositionX, Y, Z (metres)

const L_LAST_LAP_MS: usize = 0; // u32
const L_CURRENT_LAP_MS: usize = 4; // u32
const L_LAP_DISTANCE: usize = 20; // f32, metres; negative before the line is first crossed
const L_CURRENT_LAP_NUM: usize = 33; // u8
const L_PIT_STATUS: usize = 34; // u8: 0 none, 1 pitting, 2 in pit area
const L_CURRENT_LAP_INVALID: usize = 37; // u8: 0 valid, 1 invalid
const L_DRIVER_STATUS: usize = 44; // u8: 0 in garage, 1 flying lap, 2 in lap, 3 out lap, 4 on track
const L_RESULT_STATUS: usize = 45; // u8: 0 invalid, 1 inactive, 2 active, 3 finished, ...

const P_TEAM_ID: usize = 3; // u8

const T_SPEED_KMH: usize = 0; // u16
const T_THROTTLE: usize = 2; // f32 0..1
const T_STEER: usize = 6; // f32 -1..1
const T_BRAKE: usize = 10; // f32 0..1
const T_CLUTCH: usize = 14; // u8 0..100
const T_GEAR: usize = 15; // i8: -1 reverse, 0 neutral, 1..8
const T_RPM: usize = 16; // u16

fn u16_at(p: &Page, at: usize) -> u16 {
    u16::from(p.u8_at(at)) | (u16::from(p.u8_at(at + 1)) << 8)
}

fn u64_at(p: &Page, at: usize) -> u64 {
    u64::from(p.u32_at(at)) | (u64::from(p.u32_at(at + 4)) << 32)
}

fn i8_at(p: &Page, at: usize) -> i8 {
    i8::from_le_bytes([p.u8_at(at)])
}

/// The size the spec gives for a packet this reader uses; `None` for every packet it does not read.
fn expected_size(packet_id: u8) -> Option<usize> {
    match packet_id {
        ID_MOTION => Some(MOTION_SIZE),
        ID_SESSION => Some(SESSION_SIZE),
        ID_LAP_DATA => Some(LAP_DATA_SIZE),
        ID_PARTICIPANTS => Some(PARTICIPANTS_SIZE),
        ID_CAR_TELEMETRY => Some(TELEMETRY_SIZE),
        _ => None,
    }
}

/// The header fields this reader needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Header {
    packet_id: u8,
    session_uid: u64,
    player_car: usize,
}

impl Header {
    /// `None` unless the bytes start with a header of format 2025.
    fn parse(data: &[u8]) -> Option<Header> {
        if data.len() < HEADER_SIZE {
            return None;
        }
        let p = Page(data);
        if u16_at(&p, H_FORMAT) != FORMAT {
            return None;
        }
        Some(Header {
            packet_id: p.u8_at(H_PACKET_ID),
            session_uid: u64_at(&p, H_SESSION_UID),
            player_car: usize::from(p.u8_at(H_PLAYER_CAR)),
        })
    }
}

/// The track name of the spec's table (Appendix: Track IDs). An id the table does not have is named by its number.
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

/// The team of the spec's table (Appendix: Team IDs) and the class it races in. `None` for an id the table does not
/// have (the 2026 Season Pack adds teams the 2025 format does not name).
fn team(id: u8) -> Option<(&'static str, &'static str)> {
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

#[derive(Clone, Copy, Debug)]
struct SessionInfo {
    session_type: u8,
    track_id: i8,
    track_length_m: u16,
    spectating: bool,
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
    session_uid: Option<u64>,
    session: Option<SessionInfo>,
    lap: Option<LapInfo>,
    position: Option<[f32; 3]>,
    team_id: Option<u8>,
}

impl Decoder {
    /// Reads one datagram. Returns a frame when it was a Car Telemetry packet of the 2025 format and the right size.
    /// Never panics, whatever the bytes are.
    fn feed(&mut self, data: &[u8], clock_s: f64) -> Option<Frame> {
        let header = Header::parse(data)?;
        let size = expected_size(header.packet_id)?;
        if data.len() != size || header.player_car >= CARS {
            return None;
        }
        // Another session (a new race, a restart): nothing from the old one may leak into it.
        if self.session_uid != Some(header.session_uid) {
            *self = Decoder::default();
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
                let car = at(LAP_CAR);
                self.lap = Some(LapInfo {
                    last_lap_ms: page.u32_at(car + L_LAST_LAP_MS),
                    current_lap_ms: page.u32_at(car + L_CURRENT_LAP_MS),
                    distance_m: page.f32_at(car + L_LAP_DISTANCE),
                    lap_number: page.u8_at(car + L_CURRENT_LAP_NUM),
                    pit_status: page.u8_at(car + L_PIT_STATUS),
                    invalid: page.u8_at(car + L_CURRENT_LAP_INVALID) != 0,
                    driver_status: page.u8_at(car + L_DRIVER_STATUS),
                    result_status: page.u8_at(car + L_RESULT_STATUS),
                });
                None
            }
            ID_PARTICIPANTS => {
                // numActiveCars comes first, then the 22 entries.
                self.team_id = Some(page.u8_at(HEADER_SIZE + 1 + header.player_car * PARTICIPANT_CAR + P_TEAM_ID));
                None
            }
            ID_CAR_TELEMETRY => Some(self.frame(&page, at(TELEMETRY_CAR), clock_s)),
            _ => None,
        }
    }

    fn frame(&self, page: &Page, car: usize, clock_s: f64) -> Frame {
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

        if let Some([x, y, z]) = self.position {
            (f.x, f.y, f.z) = (x, y, z);
        }
        match self.team_id.and_then(team) {
            Some((name, class)) => {
                f.car = name.to_owned();
                f.car_class = Some(class.to_owned());
            }
            None => {
                f.car = "F1 25".to_owned();
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

    /// In a car on a track session: the game gave a session (a known track, not "unknown", not spectating) and lap
    /// data saying the player's car is out of the garage, active and on a numbered lap.
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
    buf: Vec<u8>,
    alive: bool,
}

impl F1Source {
    /// Binds `addr`; `None` when that fails (the port is busy: another program, for example a dashboard, owns it).
    /// std gives no way to ask for address reuse before the bind, so a port another program holds is not shared.
    fn bind(addr: SocketAddr) -> Option<F1Source> {
        let socket = UdpSocket::bind(addr).ok()?;
        Some(F1Source {
            socket,
            start: Instant::now(),
            decoder: Decoder::default(),
            // The biggest packet of the format is well under 1500 bytes; a longer datagram is cut and refused by size.
            buf: vec![0; 2048],
            alive: true,
        })
    }

    #[cfg(test)]
    fn local_addr(&self) -> SocketAddr {
        self.socket.local_addr().expect("a bound socket has an address")
    }
}

/// Opens the door on UDP port 20777, all local addresses. `None` when the port is not free.
pub fn open() -> Option<Box<dyn Source>> {
    let source = F1Source::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, DEFAULT_PORT)))?;
    Some(Box::new(source))
}

impl Source for F1Source {
    fn game_id(&self) -> &'static str {
        "f1"
    }

    fn game_name(&self) -> &'static str {
        "EA SPORTS F1 25"
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lapcut::LapCutter;

    // ---- byte builders, field by field in the order of the spec ----

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

    /// PacketHeader: packetFormat u16, gameYear u8, gameMajorVersion u8, gameMinorVersion u8, packetVersion u8,
    /// packetId u8, sessionUID u64, sessionTime f32, frameIdentifier u32, overallFrameIdentifier u32,
    /// playerCarIndex u8, secondaryPlayerCarIndex u8.
    fn header(format: u16, packet_id: u8, uid: u64, player: u8) -> W {
        let mut w = W::default();
        w.u16(format)
            .u8(25)
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
    /// gForce lateral/longitudinal/vertical f32, yaw, pitch, roll f32 = 60 bytes.
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

    /// Session packet: the fields up to and including trackId are written one by one; every later field this reader
    /// does not use is zero (the packet is padded to the spec's 753 bytes).
    fn session_packet(uid: u64, player: u8, session_type: u8, track: i8, length: u16, spectating: bool) -> Vec<u8> {
        let mut w = header(FORMAT, ID_SESSION, uid, player);
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
        let rest = SESSION_SIZE - w.0.len();
        w.zeros(rest);
        w.0
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

    /// LapData (57 bytes): lastLapTimeInMS u32, currentLapTimeInMS u32, sector1TimeMSPart u16, sector1TimeMinutesPart
    /// u8, sector2 u16+u8, deltaToCarInFront u16+u8, deltaToRaceLeader u16+u8, lapDistance f32, totalDistance f32,
    /// safetyCarDelta f32, carPosition u8, currentLapNum u8, pitStatus u8, numPitStops u8, sector u8,
    /// currentLapInvalid u8, penalties u8, totalWarnings u8, cornerCuttingWarnings u8, numUnservedDriveThroughPens u8,
    /// numUnservedStopGoPens u8, gridPosition u8, driverStatus u8, resultStatus u8, pitLaneTimerActive u8,
    /// pitLaneTimeInLaneInMS u16, pitStopTimerInMS u16, pitStopShouldServePenalty u8, speedTrapFastestSpeed f32,
    /// speedTrapFastestLap u8.
    fn lap_car(w: &mut W, l: &Lap) {
        w.u32(l.last_ms).u32(l.current_ms);
        w.u16(11_111).u8(0).u16(22_222).u8(0).u16(333).u8(0).u16(444).u8(0);
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
        w.u8(0).u16(0).u16(0).u8(0).f32(300.0).u8(1);
    }

    fn lap_packet(player: u8, l: &Lap) -> Vec<u8> {
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
        let mut w = header(FORMAT, ID_LAP_DATA, UID, player);
        for i in 0..CARS {
            lap_car(&mut w, if i == usize::from(player) { l } else { &decoy });
        }
        w.u8(255).u8(255); // timeTrialPBCarIdx, timeTrialRivalCarIdx
        w.0
    }

    fn participants_packet(player: u8, team_id: u8) -> Vec<u8> {
        let mut w = header(FORMAT, ID_PARTICIPANTS, UID, player);
        w.u8(CARS as u8); // numActiveCars
        for i in 0..CARS {
            let team_id = if i == usize::from(player) { team_id } else { 8 };
            // aiControlled, driverId, networkId, teamId, myTeam, raceNumber, nationality, name[32],
            // yourTelemetry, showOnlineNames, techLevel u16, platform, numColours, liveryColour[4] (r,g,b)
            w.u8(0).u8(3).u8(255).u8(team_id).u8(0).u8(16).u8(5);
            w.zeros(32);
            w.u8(1).u8(1).u16(0).u8(1).u8(0);
            w.zeros(12);
        }
        w.0
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

    /// CarTelemetryData (60 bytes): speed u16, throttle f32, steer f32, brake f32, clutch u8, gear i8, engineRPM u16,
    /// drs u8, revLightsPercent u8, revLightsBitValue u16, brakesTemperature[4] u16, tyresSurfaceTemperature[4] u8,
    /// tyresInnerTemperature[4] u8, engineTemperature u16, tyresPressure[4] f32, surfaceType[4] u8.
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

    /// A decoder that has seen a whole running session for `player` (car 1 = Ferrari) and the frame of one telemetry packet.
    fn running(player: u8) -> (Decoder, Frame) {
        let mut d = Decoder::default();
        assert!(d.feed(&motion_packet(FORMAT, UID, player, [100.5, 12.25, -300.75]), 1.0).is_none());
        assert!(d.feed(&session_packet(UID, player, 15, 11, 5793, false), 1.0).is_none());
        assert!(d
            .feed(&lap_packet(player, &Lap::on_track(3, 45_678, 91_234, 2500.5)), 1.0)
            .is_none());
        assert!(d.feed(&participants_packet(player, 1), 1.0).is_none());
        let frame = d
            .feed(&tele_packet(player, &sample_tele()), 2.5)
            .expect("a telemetry packet gives a frame");
        (d, frame)
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    // ---- header and sizes ----

    #[test]
    fn parses_the_header() {
        let bytes = header(FORMAT, 6, UID, 7).0;
        let h = Header::parse(&bytes).expect("a 2025 header");
        assert_eq!(
            h,
            Header {
                packet_id: 6,
                session_uid: UID,
                player_car: 7
            }
        );
        // The offsets of the layout: packetId is the 7th byte, playerCarIndex the 28th.
        assert_eq!(bytes[6], 6);
        assert_eq!(bytes[27], 7);
        assert_eq!(u16::from_le_bytes([bytes[0], bytes[1]]), 2025);
    }

    #[test]
    fn refuses_other_formats_and_short_headers() {
        assert!(Header::parse(&header(2024, 6, UID, 0).0).is_none());
        assert!(Header::parse(&header(2026, 6, UID, 0).0).is_none());
        assert!(Header::parse(&header(0, 6, UID, 0).0).is_none());
        let ok = header(FORMAT, 6, UID, 0).0;
        assert!(Header::parse(&ok[..HEADER_SIZE - 1]).is_none());
        assert!(Header::parse(&[]).is_none());
    }

    /// The field sizes of every struct in the spec's order, summed: they give the packet sizes the spec states.
    #[test]
    fn sizes_add_up_to_the_ones_the_spec_states() {
        // PacketHeader.
        let header_fields = [2, 1, 1, 1, 1, 1, 8, 4, 4, 4, 1, 1];
        assert_eq!(header_fields.iter().sum::<usize>(), HEADER_SIZE);
        assert_eq!(HEADER_SIZE, 29);

        // CarMotionData.
        let motion = [4, 4, 4, 4, 4, 4, 2, 2, 2, 2, 2, 2, 4, 4, 4, 4, 4, 4];
        assert_eq!(motion.iter().sum::<usize>(), MOTION_CAR);
        assert_eq!(HEADER_SIZE + CARS * motion.iter().sum::<usize>(), 1349);
        assert_eq!(MOTION_SIZE, 1349);

        // LapData (+ timeTrialPBCarIdx, timeTrialRivalCarIdx).
        let lap = [
            4, 4, 2, 1, 2, 1, 2, 1, 2, 1, 4, 4, 4, // times, deltas, distances
            1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // position .. resultStatus (14 one-byte fields)
            1, 2, 2, 1, 4, 1, // pit lane timer, times, serve penalty, speed trap
        ];
        assert_eq!(lap.iter().sum::<usize>(), LAP_CAR);
        assert_eq!(HEADER_SIZE + CARS * lap.iter().sum::<usize>() + 2, 1285);
        assert_eq!(LAP_DATA_SIZE, 1285);

        // ParticipantData (+ numActiveCars).
        let participant = [1, 1, 1, 1, 1, 1, 1, 32, 1, 1, 2, 1, 1, 12];
        assert_eq!(participant.iter().sum::<usize>(), PARTICIPANT_CAR);
        assert_eq!(HEADER_SIZE + 1 + CARS * participant.iter().sum::<usize>(), 1284);
        assert_eq!(PARTICIPANTS_SIZE, 1284);

        // CarTelemetryData (+ mfdPanelIndex, mfdPanelIndexSecondaryPlayer, suggestedGear).
        let telemetry = [2, 4, 4, 4, 1, 1, 2, 1, 1, 2, 8, 4, 4, 2, 16, 4];
        assert_eq!(telemetry.iter().sum::<usize>(), TELEMETRY_CAR);
        assert_eq!(HEADER_SIZE + CARS * telemetry.iter().sum::<usize>() + 3, 1352);
        assert_eq!(TELEMETRY_SIZE, 1352);

        // CarStatusData (not read, but its size is part of the spec's table).
        let status = [1, 1, 1, 1, 1, 4, 4, 4, 2, 2, 1, 1, 2, 1, 1, 1, 1, 4, 4, 4, 1, 4, 4, 4, 1];
        assert_eq!(HEADER_SIZE + CARS * status.iter().sum::<usize>(), 1239);

        // PacketSessionData, field by field.
        let session: Vec<usize> = [
            // weather, trackTemperature, airTemperature, totalLaps, trackLength, sessionType, trackId, formula,
            // sessionTimeLeft, sessionDuration, pitSpeedLimit, gamePaused, isSpectating, spectatorCarIndex,
            // sliProNativeSupport, numMarshalZones
            &[1, 1, 1, 1, 2, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 1][..],
            &[21 * 5],                    // marshalZones[21]: zoneStart f32, zoneFlag i8
            &[1, 1, 1],                   // safetyCarStatus, networkGame, numWeatherForecastSamples
            &[64 * 8],                    // weatherForecastSamples[64]: 8 bytes each
            &[1, 1, 4, 4, 4, 1, 1, 1],    // forecastAccuracy, aiDifficulty, 3 link ids, pitStopWindow x3
            &[1, 1, 1, 1, 1, 1, 1, 1, 1], // steering .. dynamicRacingLineType
            &[1, 1, 4, 1],                // gameMode, ruleSet, timeOfDay, sessionLength
            &[1, 1, 1, 1],                // speed/temperature units, lead and secondary player
            &[1, 1, 1],                   // numSafetyCarPeriods, numVirtualSafetyCarPeriods, numRedFlagPeriods
            &[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // equalCarPerformance .. numSessionsInWeekend
            &[12],                        // weekendStructure[12]
            &[4, 4],                      // sector2LapDistanceStart, sector3LapDistanceStart
        ]
        .concat();
        assert_eq!(HEADER_SIZE + session.iter().sum::<usize>(), 753);
        assert_eq!(SESSION_SIZE, 753);
    }

    #[test]
    fn the_builders_make_packets_of_the_spec_sizes() {
        assert_eq!(motion_packet(FORMAT, UID, 0, [0.0; 3]).len(), 1349);
        assert_eq!(session_packet(UID, 0, 15, 11, 5793, false).len(), 753);
        assert_eq!(lap_packet(0, &Lap::on_track(1, 0, 0, 0.0)).len(), 1285);
        assert_eq!(participants_packet(0, 1).len(), 1284);
        assert_eq!(tele_packet(0, &sample_tele()).len(), 1352);
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
        assert!(d.feed(&tele_packet(22, &sample_tele()), 1.0).is_none());
        assert!(d.feed(&tele_packet(255, &sample_tele()), 1.0).is_none());
    }

    #[test]
    fn lap_details_reach_the_frame() {
        let mut d = Decoder::default();
        d.feed(&session_packet(UID, 0, 18, 5, 3337, false), 0.0);
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
        d.feed(&lap_packet(0, &lap), 0.0);
        let f = d.feed(&tele_packet(0, &sample_tele()), 0.0).unwrap();
        assert!(f.driving);
        assert_eq!(f.track, "Monaco");
        assert_eq!(f.last_lap_s, None, "no completed lap yet");
        assert_eq!(f.dist_m, Some(0.0), "a negative distance is before the line");
        assert_eq!(f.lap_valid, Some(false));
        assert!(f.in_pits);
        assert_eq!(f.lap_time_s, Some(1.5));
        // Without participants the car is named after the game.
        assert_eq!(f.car, "F1 25");
        assert_eq!(f.car_class.as_deref(), Some("F1"));
        // Without motion the position is unknown.
        assert!(f.x.is_nan() && f.y.is_nan() && f.z.is_nan());
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
        assert_eq!(team(0), Some(("Mercedes", "F1")));
        assert_eq!(team(2), Some(("Red Bull Racing", "F1")));
        assert_eq!(team(9), Some(("Sauber", "F1")));
        assert_eq!(team(41), Some(("F1 Generic", "F1")));
        assert_eq!(team(150), Some(("Prema '23", "F2")));
        assert_eq!(team(168), Some(("Invicta '24", "F2")));
        assert_eq!(team(200), None);
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
        let driving_with = |session: Vec<u8>, lap: Lap| {
            let mut d = Decoder::default();
            d.feed(&session, 0.0);
            d.feed(&lap_packet(0, &lap), 0.0);
            d.feed(&tele_packet(0, &sample_tele()), 0.0).unwrap().driving
        };
        let race = || session_packet(UID, 0, 15, 11, 5793, false);
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
            session_packet(UID, 0, 0, 11, 5793, false),
            Lap::on_track(1, 100, 0, 5.0)
        ));
        assert!(!driving_with(
            session_packet(UID, 0, 15, -1, 5793, false),
            Lap::on_track(1, 100, 0, 5.0)
        ));
        assert!(!driving_with(
            session_packet(UID, 0, 15, 11, 5793, true),
            Lap::on_track(1, 100, 0, 5.0)
        ));
        // Time trial counts.
        assert!(driving_with(
            session_packet(UID, 0, 18, 11, 5793, false),
            Lap::on_track(1, 100, 0, 5.0)
        ));
    }

    #[test]
    fn a_new_session_forgets_the_old_one() {
        let (mut d, _) = running(0);
        // The same car, another session: only telemetry has come, nothing else is known yet.
        let other = {
            let t = tele_packet(0, &sample_tele());
            let mut t = t;
            t[7..15].copy_from_slice(&(UID + 1).to_le_bytes());
            t
        };
        let f = d.feed(&other, 3.0).unwrap();
        assert!(!f.driving);
        assert!(f.track.is_empty() && f.lap_time_s.is_none() && f.x.is_nan());
        assert_eq!(f.car, "F1 25");
    }

    // ---- bad input ----

    #[test]
    fn a_wrong_format_year_is_ignored() {
        let mut d = Decoder::default();
        for format in [2023, 2024, 2026, 0, 65_535] {
            assert!(d.feed(&tele_packet_in(format, 0, &sample_tele()), 0.0).is_none(), "format {format}");
            assert!(d.feed(&motion_packet(format, UID, 0, [1.0, 2.0, 3.0]), 0.0).is_none());
        }
        // Nothing of those reached the state.
        assert!(d.position.is_none() && d.session_uid.is_none());
    }

    #[test]
    fn a_wrong_size_is_ignored() {
        let packets = [
            motion_packet(FORMAT, UID, 0, [1.0, 2.0, 3.0]),
            session_packet(UID, 0, 15, 11, 5793, false),
            lap_packet(0, &Lap::on_track(1, 100, 0, 5.0)),
            participants_packet(0, 1),
            tele_packet(0, &sample_tele()),
        ];
        for packet in &packets {
            let mut d = Decoder::default();
            let mut longer = packet.clone();
            longer.push(0);
            assert!(d.feed(&longer, 0.0).is_none());
            assert!(d.feed(&packet[..packet.len() - 1], 0.0).is_none());
            assert!(d.session_uid.is_none(), "a refused packet leaves no trace");
        }
        // A telemetry-sized packet that claims another id is held to that id's size.
        let mut d = Decoder::default();
        let mut wrong_id = tele_packet(0, &sample_tele());
        wrong_id[6] = ID_LAP_DATA;
        assert!(d.feed(&wrong_id, 0.0).is_none());
    }

    #[test]
    fn other_packets_are_ignored() {
        let mut d = Decoder::default();
        for id in [3u8, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 255] {
            let mut w = header(FORMAT, id, UID, 0);
            w.zeros(1352 - HEADER_SIZE);
            assert!(d.feed(&w.0, 0.0).is_none(), "packet {id}");
            let mut w = header(FORMAT, id, UID, 0);
            w.zeros(1239 - HEADER_SIZE);
            assert!(d.feed(&w.0, 0.0).is_none(), "packet {id}");
        }
        assert!(d.session_uid.is_none());
    }

    #[test]
    fn garbage_and_truncated_packets_never_panic() {
        let valid = [
            motion_packet(FORMAT, UID, 3, [1.0, 2.0, 3.0]),
            session_packet(UID, 3, 15, 11, 5793, false),
            lap_packet(3, &Lap::on_track(1, 100, 0, 5.0)),
            participants_packet(3, 1),
            tele_packet(3, &sample_tele()),
        ];
        let mut d = Decoder::default();
        for packet in &valid {
            for cut in 0..packet.len() {
                d.feed(&packet[..cut], 0.0);
            }
        }
        // Valid sizes with random bytes (the format forced, so the body is read too).
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = || {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (state >> 33) as u8
        };
        for round in 0..300 {
            let packet = &valid[round % valid.len()];
            let mut junk: Vec<u8> = packet.iter().map(|_| next()).collect();
            junk[0..2].copy_from_slice(&FORMAT.to_le_bytes());
            junk[6] = packet[6];
            junk[27] = next() % 22;
            d.feed(&junk, 0.0);
            // And pure noise of random length.
            let len = usize::from(next()) * 8;
            let noise: Vec<u8> = (0..len).map(|_| next()).collect();
            d.feed(&noise, 0.0);
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

    // ---- the socket ----

    fn loopback_pair() -> (F1Source, UdpSocket) {
        let source = F1Source::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).expect("an ephemeral loopback port is free");
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        sender.connect(source.local_addr()).unwrap();
        (source, sender)
    }

    #[test]
    fn identifies_itself() {
        let (source, _) = loopback_pair();
        assert_eq!(source.game_id(), "f1");
        assert_eq!(source.game_name(), "EA SPORTS F1 25");
        assert!(source.alive());
        assert_eq!(DEFAULT_PORT, 20777);
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
        assert!(F1Source::bind(first.local_addr()).is_none());
    }

    #[test]
    fn gives_a_frame_for_each_telemetry_packet_over_udp() {
        let (mut source, sender) = loopback_pair();
        sender.send(&motion_packet(FORMAT, UID, 2, [10.0, 20.0, 30.0])).unwrap();
        sender.send(&session_packet(UID, 2, 15, 11, 5793, false)).unwrap();
        sender.send(&lap_packet(2, &Lap::on_track(1, 2000, 0, 80.0))).unwrap();
        sender.send(&participants_packet(2, 8)).unwrap();
        sender.send(b"not a packet at all").unwrap();
        sender.send(&tele_packet_in(2024, 2, &sample_tele())).unwrap();
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

    /// A scripted lap over loopback, cut into a lap file by the real lap cutter.
    #[test]
    fn a_lap_flows_from_udp_to_the_lap_cutter() {
        let (mut source, sender) = loopback_pair();
        let mut cutter = LapCutter::new(source.game_id());
        let mut laps = Vec::new();
        sender.send(&session_packet(UID, 0, 15, 11, 5793, false)).unwrap();
        sender.send(&participants_packet(0, 1)).unwrap();

        // Lap 1: 6.5 s at 20 Hz, then lap 2 begins (the game raises the lap number and shows the last lap time).
        let tick = |source: &mut F1Source, lap: &Lap, pos: f32| {
            sender.send(&motion_packet(FORMAT, UID, 0, [pos, 0.0, -pos])).unwrap();
            sender.send(&lap_packet(0, lap)).unwrap();
            sender.send(&tele_packet(0, &sample_tele())).unwrap();
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
        assert_eq!(laps.len(), 1, "exactly one lap");
        let lap = &laps[0];
        assert_eq!(lap.game, "f1");
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
}
