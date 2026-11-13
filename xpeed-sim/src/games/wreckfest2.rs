//! Wreckfest 2: the UDP telemetry the game sends to this computer ("Pino", `TelemetryDataFormatPino.h`, Bugbear,
//! revision 6, shipped in `<game folder>\telemetry\`).
//!
//! # How the person turns it on
//!
//! The header documents the packets only; it says nothing about the port or the switch. Both were found on a real
//! install, in the game's own settings folder:
//!
//! `Documents\My Games\Wreckfest 2\<SteamID>\savegame\telemetry\config.json`
//!
//! ```json
//! { "udp": [ { "enabled": 1, "ip": "127.0.0.1", "port": "23123" } ], ... }
//! ```
//!
//! So: set `"enabled": 1` (the game writes `0`), leave `"ip"` at `127.0.0.1` (the computer that runs Xpeed Companion) and
//! `"port"` at `23123`, then restart the game. The game sends only while a race runs. Next to that file the game keeps
//! a copy per computer (`config-<PC name>.json`); which of the two wins is not documented, so a person who sees no
//! laps should check both. This reader listens on port `23123` on every local address.
//!
//! # What is read
//!
//! Only the *Main* packet (type 0, 1218 bytes, about 60 per second). It carries everything for the player's own car:
//! the car, the timing, the session and the player status. The leaderboard, timing, sectors, motion, info and damage
//! packets describe all the cars; the player is the one in Main, so those are ignored. The packets have no revision
//! field (revisions 2 to 6 changed no layout): a packet is trusted when its signature, its type and its exact size
//! match, and anything else is dropped.
//!
//! Units are the Frame's already: metres, seconds, m/s, 0..1 pedals, -1..1 steering. The game's axes are X right,
//! Y up, Z forward (left handed); positions are passed on as given.
//!
//! # Decisions
//!
//! * `driving` is true only in a lap-based mode (see `lap_based`), in a real-time race (game status), not a replay,
//!   not spectating, not paused, with the player's car on track and physics running, and from lap 1 on (lap 0 is
//!   the grid before the start). Derbies and the waypoint race have no laps: `lap` stays 0 and nothing is recorded.
//! * `lap` is `lapCurrent`: it goes up by one at each lap and, since revision 5, to `laps + 1` at the finish. The
//!   frame at `laps + 1` is the one that closes the last lap; after the first one, `driving` goes false so the
//!   post-race drive-around is not collected as a lap.
//! * Times are the game's, in milliseconds. `lapTiming` says which lap the *TIMING* data was written for: when it
//!   differs from `lapCurrent` (multiplayer, just after the line) the frame gives no lap time and no last lap time
//!   instead of a stale one.
//! * `speed_ms` is the magnitude of the car's velocity (what the car really does), not the driveline's speedometer
//!   value (which a spinning wheel inflates); the speedometer is the fallback.
//! * Nothing in the packets says a lap is invalid, so `lap_valid` is `None`; there are no pits (`in_pits` false) and
//!   no fuel (NaN).
//! * The socket is bound as soon as `open` runs: the game sends only while it runs, so `next` simply waits. If another
//!   program (a dashboard) already owns the port, `open` returns `None` and is tried again later.

use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use crate::game::{CarState, Flag, Frame, Source};
use crate::shm::Page;

/// The port the game's telemetry output is set to by default.
pub const PORT: u16 = 23123;

/// Where every field of the Main packet is, worked out from the structs of the header (all packed, 1 byte alignment).
/// The tests add the field sizes up again from a table of the header and compare.
mod layout {
    /// `Packet::Header::signature`, little endian.
    pub const SIGNATURE: u32 = 1_869_769_584;
    pub const PACKET_MAIN: u8 = 0;

    // Packet::Header: signature u32, packetType u8, statusFlags u8, sessionTime s32, raceTime s32.
    pub const HEADER_LEN: usize = 14;
    pub const SIGNATURE_AT: usize = 0;
    pub const TYPE_AT: usize = 4;
    pub const GAME_STATUS_AT: usize = 5;

    // Packet::Main, in the order of the struct.
    pub const MAIN_LEN: usize = 1218;
    pub const MARSHAL_FLAGS: usize = HEADER_LEN; // u16: MarshalFlags of the player
    const LEADERBOARD: usize = MARSHAL_FLAGS + 2; // Participant::Leaderboard, 32 bytes
    const TIMING: usize = LEADERBOARD + 32; // Participant::Timing, 32 bytes
    const TIMING_SECTORS: usize = TIMING + 32; // Participant::TimingSectors, 36 bytes
    const INFO: usize = TIMING_SECTORS + 36; // Participant::Info, 213 bytes
    pub const DAMAGE: usize = INFO + 213; // Participant::Damage, 21 bytes: 56 parts of 3 bits
    pub const CAR: usize = DAMAGE + 21; // Car::Full, 532 bytes
    const SESSION: usize = CAR + 532; // Session, 208 bytes
    pub const PLAYER_STATUS_AT: usize = SESSION + 208; // u16
    const INPUT_EXTENDED: usize = PLAYER_STATUS_AT + 2; // 20 bytes
    const RESERVED: usize = INPUT_EXTENDED + 20; // 106 bytes
    const _: () = assert!(RESERVED + 106 == MAIN_LEN);

    // Participant::Leaderboard: status u8, trackStatus u8, lapCurrent u16, position u8, health u8, wrecks u16,
    // frags u16, assists u16, score s32, points s32, deltaLeader s32, lapTiming u16, reserved 6.
    pub const LAP_CURRENT_AT: usize = LEADERBOARD + 2;
    pub const LAP_TIMING_AT: usize = LEADERBOARD + 24;

    // Participant::Timing: lapTimeCurrent u32, lapTimePenaltyCurrent u32, lapTimeLast u32, lapTimeBest u32,
    // lapBest u8, deltaAhead s32, deltaBehind s32, lapProgress f32, reserved 3. Milliseconds.
    pub const LAP_TIME_CURRENT_AT: usize = TIMING;
    pub const LAP_TIME_LAST_AT: usize = TIMING + 8;
    pub const LAP_PROGRESS_AT: usize = TIMING + 25;

    // Participant::Info: carId[64], carName[96], playerName[24], participantIndex u8, 3 x s32, team u8, reserved 15.
    pub const CAR_ID_AT: usize = INFO;
    pub const CAR_ID_LEN: usize = 64;
    pub const CAR_NAME_AT: usize = INFO + 64;
    pub const CAR_NAME_LEN: usize = 96;

    // Car::Full: assists 8, chassis 52, driveline 24, engine 56, input 20, orientation 34, velocity 36, tires 4 x 72,
    // reserved 14.
    // Assists: flags u8 (bit 0 ABS active, bit 1 TCS active, bit 2 ESC active), gearbox u8, levelAbs, levelTcs,
    // levelEsc u8 (0 off, 1 half, 2 full), reserved 3.
    pub const ASSIST_FLAGS_AT: usize = CAR;
    pub const LEVEL_ABS_AT: usize = CAR + 2;
    pub const LEVEL_TCS_AT: usize = CAR + 3;
    const DRIVELINE: usize = CAR + 8 + 52; // type u8, gear u8, gearMax u8, speed f32, reserved 17
    pub const GEAR_AT: usize = DRIVELINE + 1; // 0 = R, 1 = N, 2 = 1st ...
    /// `gearMax`: "max forward gear AKA top gear, maxGear = 5 -> 5th is max" (TelemetryDataFormatPino.h).
    pub const GEAR_MAX_AT: usize = DRIVELINE + 2;
    pub const DRIVELINE_SPEED_AT: usize = DRIVELINE + 3;
    const ENGINE: usize = DRIVELINE + 24; // flags u8, rpm s32, rpmMax, rpmRedline, rpmIdle, 6 x f32, reserved 15
    pub const RPM_AT: usize = ENGINE + 1;
    /// `EngineFlags` (bit 0 running, 1 starting, 2 misfiring) and `tempWater` (Kelvin): after flags, rpm, rpmMax,
    /// rpmRedline, rpmIdle, torque, power and tempBlock.
    pub const ENGINE_FLAGS_AT: usize = ENGINE;
    pub const TEMP_WATER_AT: usize = ENGINE + 1 + 4 * 4 + 4 * 2 + 4;
    const INPUT: usize = ENGINE + 56; // throttle, brake, clutch, handbrake, steering: f32
    pub const THROTTLE_AT: usize = INPUT;
    pub const BRAKE_AT: usize = INPUT + 4;
    pub const CLUTCH_AT: usize = INPUT + 8;
    pub const HANDBRAKE_AT: usize = INPUT + 12;
    pub const STEERING_AT: usize = INPUT + 16;
    const ORIENTATION: usize = INPUT + 20; // position xyz f32, quaternion xyzw f32, extents 3 x u16
    pub const POSITION_AT: usize = ORIENTATION;
    const VELOCITY: usize = ORIENTATION + 34; // local velocity xyz, angular velocity xyz, acceleration xyz: f32
    pub const VELOCITY_AT: usize = VELOCITY;

    // Session: trackId[64], trackName[96], trackLength f32, laps s16, eventLength s16, gridSize u8,
    // gridSizeRemaining u8, sectorCount u8, sectorFract1 f32, sectorFract2 f32, gameMode u8, damageMode u8,
    // status u8, reserved 26.
    pub const TRACK_ID_AT: usize = SESSION;
    pub const TRACK_ID_LEN: usize = 64;
    pub const TRACK_NAME_AT: usize = SESSION + 64;
    pub const TRACK_NAME_LEN: usize = 96;
    pub const TRACK_LENGTH_AT: usize = SESSION + 160;
    pub const LAPS_AT: usize = SESSION + 164;
    pub const SECTOR_COUNT_AT: usize = SESSION + 170;
    pub const GAME_MODE_AT: usize = SESSION + 179;

    // MarshalFlags (the player's): bits.
    pub const MARSHAL_GREEN: u16 = 1 << 0;
    pub const MARSHAL_FINISH: u16 = 1 << 2;
    pub const MARSHAL_DQ: u16 = 1 << 3;
    pub const MARSHAL_MEATBALL: u16 = 1 << 4;
    pub const MARSHAL_BLUE: u16 = 1 << 6;
    pub const MARSHAL_WHITE: u16 = 1 << 7;
    // Damage::Part indexes and States (0 ok .. 4 terminal).
    pub const DAMAGE_BYTES: usize = 21;
    pub const PART_ENGINE: usize = 0;
    pub const PART_GEARBOX: usize = 1;
    pub const PART_SUSPENSION: std::ops::RangeInclusive<usize> = 6..=9;
    pub const PART_ARMOR: std::ops::RangeInclusive<usize> = 30..=35;
    pub const STATE_TERMINAL: u8 = 4;

    // GameStatusFlags (Header::statusFlags).
    pub const GAME_PAUSED: u8 = 1 << 0;
    pub const GAME_REPLAY: u8 = 1 << 1;
    pub const GAME_SPECTATE: u8 = 1 << 2;
    pub const GAME_IN_RACE: u8 = 1 << 5;
    // PlayerStatusFlags (Main::playerStatusFlags).
    pub const PLAYER_IN_RACE: u16 = 1 << 0;
    pub const PLAYER_PHYSICS_RUNNING: u16 = 1 << 2;

    // GameMode.
    pub const MODE_DEATHMATCH: u8 = 1;
    pub const MODE_LAST_MAN_STANDING: u8 = 2;
    pub const MODE_DEMOLITION_DERBY: u8 = 3;
    pub const MODE_WAYPOINT_RACE: u8 = 5;
    pub const MODE_GAUNTLET: u8 = 6;
}

/// A time longer than a day is not a time (the game has no such lap): garbage or a "none" marker.
const MAX_TIME_MS: u32 = 86_400_000;

fn u16_at(page: &Page, at: usize) -> u16 {
    u16::from_le_bytes([page.u8_at(at), page.u8_at(at + 1)])
}

fn finite(v: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        f32::NAN
    }
}

fn clamped(v: f32, low: f32, high: f32) -> f32 {
    if v.is_finite() {
        v.clamp(low, high)
    } else {
        f32::NAN
    }
}

fn seconds(ms: u32) -> Option<f64> {
    (ms < MAX_TIME_MS).then(|| f64::from(ms) / 1000.0)
}

fn mode_name(mode: u8) -> &'static str {
    match mode {
        0 => "Banger racing",
        1 => "Deathmatch",
        2 => "Last man standing",
        3 => "Demolition derby",
        4 => "Suicide race",
        5 => "Waypoint race",
        6 => "Gauntlet",
        7 => "Folk race",
        8 => "Time trial",
        _ => "Wreckfest 2",
    }
}

/// What one Main packet says that the frame needs.
struct Main {
    game_status: u8,
    player_status: u16,
    lap_current: u16,
    lap_timing: u16,
    lap_time_current_ms: u32,
    lap_time_last_ms: u32,
    lap_progress: f32,
    car_id: String,
    car_name: String,
    gear: u8,
    gear_max: u8,
    driveline_speed: f32,
    rpm: i32,
    throttle: f32,
    brake: f32,
    clutch: f32,
    steering: f32,
    position: [f32; 3],
    velocity: [f32; 3],
    track_id: String,
    track_name: String,
    track_length: f32,
    laps: i16,
    sector_count: u8,
    game_mode: u8,
    marshal_flags: u16,
    assist_flags: u8,
    level_abs: u8,
    level_tcs: u8,
    engine_flags: u8,
    temp_water_k: f32,
    handbrake: f32,
    damage: [u8; layout::DAMAGE_BYTES],
}

/// The state (0 ok .. 4 terminal) of part `i` of the bit-packed damage: three bits each, as the header unpacks them.
fn damage_state(packed: &[u8; layout::DAMAGE_BYTES], i: usize) -> u8 {
    let bit = i * 3;
    let (byte, offset) = (bit / 8, bit % 8);
    let mut state = (packed[byte] >> offset) & 0b111;
    if offset > 5 {
        state |= (packed.get(byte + 1).copied().unwrap_or(0) << (8 - offset)) & 0b111;
    }
    state
}

impl Main {
    /// `None` unless the bytes are exactly one Main packet of the Pino format.
    fn parse(bytes: &[u8]) -> Option<Main> {
        use layout::*;
        if bytes.len() != MAIN_LEN {
            return None;
        }
        let p = Page(bytes);
        let signature = u32::from_le_bytes([
            p.u8_at(SIGNATURE_AT),
            p.u8_at(SIGNATURE_AT + 1),
            p.u8_at(SIGNATURE_AT + 2),
            p.u8_at(SIGNATURE_AT + 3),
        ]);
        if signature != SIGNATURE || p.u8_at(TYPE_AT) != PACKET_MAIN {
            return None;
        }
        let triple = |at: usize| [p.f32_at(at), p.f32_at(at + 4), p.f32_at(at + 8)];
        Some(Main {
            game_status: p.u8_at(GAME_STATUS_AT),
            player_status: u16_at(&p, PLAYER_STATUS_AT),
            lap_current: u16_at(&p, LAP_CURRENT_AT),
            lap_timing: u16_at(&p, LAP_TIMING_AT),
            lap_time_current_ms: p.u32_at(LAP_TIME_CURRENT_AT),
            lap_time_last_ms: p.u32_at(LAP_TIME_LAST_AT),
            lap_progress: p.f32_at(LAP_PROGRESS_AT),
            car_id: p.ascii_at(CAR_ID_AT, CAR_ID_LEN),
            car_name: p.ascii_at(CAR_NAME_AT, CAR_NAME_LEN),
            gear: p.u8_at(GEAR_AT),
            gear_max: p.u8_at(GEAR_MAX_AT),
            driveline_speed: p.f32_at(DRIVELINE_SPEED_AT),
            rpm: p.i32_at(RPM_AT),
            throttle: p.f32_at(THROTTLE_AT),
            brake: p.f32_at(BRAKE_AT),
            clutch: p.f32_at(CLUTCH_AT),
            steering: p.f32_at(STEERING_AT),
            position: triple(POSITION_AT),
            velocity: triple(VELOCITY_AT),
            track_id: p.ascii_at(TRACK_ID_AT, TRACK_ID_LEN),
            track_name: p.ascii_at(TRACK_NAME_AT, TRACK_NAME_LEN),
            track_length: p.f32_at(TRACK_LENGTH_AT),
            laps: p.i16_at(LAPS_AT),
            sector_count: p.u8_at(SECTOR_COUNT_AT),
            game_mode: p.u8_at(GAME_MODE_AT),
            marshal_flags: u16_at(&p, MARSHAL_FLAGS),
            assist_flags: p.u8_at(ASSIST_FLAGS_AT),
            level_abs: p.u8_at(LEVEL_ABS_AT),
            level_tcs: p.u8_at(LEVEL_TCS_AT),
            engine_flags: p.u8_at(ENGINE_FLAGS_AT),
            temp_water_k: p.f32_at(TEMP_WATER_AT),
            handbrake: p.f32_at(HANDBRAKE_AT),
            damage: std::array::from_fn(|i| p.u8_at(DAMAGE + i)),
        })
    }

    /// Does the mode count laps? The header: `sectorCount` is 3 "except in derbies etc. Pay attention to this"
    /// (0 there since revision 6); the derby modes and the waypoint race have no laps, and the gauntlet (a team
    /// chase) is not a lap time either. An unknown mode counts laps when it has sectors.
    fn lap_based(&self) -> bool {
        use layout::*;
        self.sector_count > 0
            && !matches!(
                self.game_mode,
                MODE_DEATHMATCH | MODE_LAST_MAN_STANDING | MODE_DEMOLITION_DERBY | MODE_WAYPOINT_RACE | MODE_GAUNTLET
            )
    }

    /// The race is over for the player: `lapCurrent` has gone to one above the laps of the race.
    fn finished(&self) -> bool {
        self.lap_based() && self.laps > 0 && i32::from(self.lap_current) > i32::from(self.laps)
    }

    fn in_a_race(&self) -> bool {
        use layout::*;
        self.game_status & GAME_IN_RACE != 0
            && self.game_status & (GAME_PAUSED | GAME_REPLAY | GAME_SPECTATE) == 0
            && self.player_status & PLAYER_IN_RACE != 0
            && self.player_status & PLAYER_PHYSICS_RUNNING != 0
    }

    /// The aids, the handbrake, the flag, the coolant and the damage of the player's car. The header has no pit
    /// limiter, headlights, oil temperature (only its pressure), brake bias or engine map.
    fn state(&self) -> CarState {
        use layout::*;
        let mut state = CarState::UNKNOWN;
        state.abs_active = Some(self.assist_flags & 1 != 0);
        state.tc_active = Some(self.assist_flags & 2 != 0);
        // The assist levels: 0 off, 1 half, 2 full.
        state.abs_level = (self.level_abs <= 2).then_some(self.level_abs);
        state.tc_level = (self.level_tcs <= 2).then_some(self.level_tcs);
        state.handbrake = (0.0..=1.0).contains(&self.handbrake).then_some(self.handbrake > 0.0);
        // The engine's own "misfiring" flag is the warning: the header has no warning light.
        state.engine_warning = Some(self.engine_flags & (1 << 2) != 0);
        // `tempWater` is in Kelvin; 0 is unset.
        let celsius = self.temp_water_k - 273.15;
        state.water_c = (self.temp_water_k.is_finite() && (0.0..=400.0).contains(&celsius)).then_some(celsius);
        let m = self.marshal_flags;
        state.flag = if m & (MARSHAL_DQ | MARSHAL_MEATBALL) != 0 {
            Some(Flag::Black)
        } else if m & MARSHAL_FINISH != 0 {
            Some(Flag::Chequered)
        } else if m & MARSHAL_BLUE != 0 {
            Some(Flag::Blue)
        } else if m & MARSHAL_WHITE != 0 {
            Some(Flag::White)
        } else if m & MARSHAL_GREEN != 0 {
            Some(Flag::Green)
        } else {
            None
        };
        // Damage states are 0 (ok) to 4 (terminal); the worst of the parts of a group, as a share of terminal.
        let worst = |parts: &mut dyn Iterator<Item = usize>| {
            let states: Vec<u8> = parts.map(|i| damage_state(&self.damage, i)).collect();
            states
                .iter()
                .all(|s| *s <= STATE_TERMINAL)
                .then(|| f32::from(states.into_iter().max().unwrap_or(0)) / f32::from(STATE_TERMINAL))
        };
        state.damage_engine = worst(&mut (PART_ENGINE..=PART_ENGINE));
        state.damage_gearbox = worst(&mut (PART_GEARBOX..=PART_GEARBOX));
        state.damage_suspension = worst(&mut PART_SUSPENSION.clone());
        state.damage_body = worst(&mut PART_ARMOR.clone());
        state
    }

    fn to_frame(&self, clock_s: f64) -> Frame {
        let lap_based = self.lap_based();
        // The TIMING data belongs to lap `lapTiming`; it is only this lap's when the two numbers agree.
        let timing_ok = self.lap_timing == self.lap_current;
        let mut f = Frame::empty();
        f.clock_s = clock_s;
        f.driving = lap_based && self.in_a_race() && self.lap_current >= 1;
        if lap_based {
            f.lap = i32::from(self.lap_current);
            if timing_ok {
                f.lap_time_s = seconds(self.lap_time_current_ms);
                f.last_lap_s = seconds(self.lap_time_last_ms).filter(|t| *t > 0.0);
            }
            if self.track_length.is_finite() && self.track_length > 0.0 && self.lap_progress.is_finite() {
                f.dist_m = Some(f64::from(self.lap_progress.clamp(0.0, 1.0)) * f64::from(self.track_length));
                f.track_length_m = Some(f64::from(self.track_length));
            }
        }
        let [vx, vy, vz] = self.velocity;
        let speed = (vx * vx + vy * vy + vz * vz).sqrt();
        f.speed_ms = if speed.is_finite() { speed } else { finite(self.driveline_speed) };
        f.rpm = if self.rpm >= 0 { self.rpm as f32 } else { f32::NAN };
        // 0 = reverse, 1 = neutral, 2 = first: the frame has -1, 0, 1.
        f.gear = if self.gear <= 20 { f32::from(self.gear) - 1.0 } else { f32::NAN };
        // `gearMax` is the top forward gear, so it is also how many there are; 0 is unset.
        f.gears = (1..=20).contains(&self.gear_max).then_some(self.gear_max);
        f.throttle = clamped(self.throttle, 0.0, 1.0);
        f.brake = clamped(self.brake, 0.0, 1.0);
        f.clutch = clamped(self.clutch, 0.0, 1.0);
        f.steer = clamped(self.steering, -1.0, 1.0);
        f.state = self.state();
        f.x = finite(self.position[0]);
        f.y = finite(self.position[1]);
        f.z = finite(self.position[2]);
        f.car = if !self.car_name.is_empty() {
            self.car_name.clone()
        } else {
            self.car_id.clone()
        };
        f.track = if !self.track_name.is_empty() {
            self.track_name.clone()
        } else if !self.track_id.is_empty() {
            self.track_id.clone()
        } else {
            mode_name(self.game_mode).to_owned()
        };
        f
    }
}

/// The open door: a UDP socket the game sends its telemetry to.
pub struct Wreckfest2 {
    socket: UdpSocket,
    /// Taken when the door opens; the frames' clock runs from it and never goes backwards.
    started: Instant,
    healthy: bool,
    buffer: Vec<u8>,
    /// The lap number of the finish frame already given as driving (the next ones of it are not).
    finish_given: Option<i32>,
}

impl Wreckfest2 {
    /// Binds the socket. `None` when the address is taken (another program listens on that port).
    fn bind(addr: SocketAddr) -> Option<Wreckfest2> {
        let socket = UdpSocket::bind(addr).ok()?;
        Some(Wreckfest2 {
            socket,
            started: Instant::now(),
            healthy: true,
            // The largest packet (info) is 8195 bytes; a datagram can hold 65507.
            buffer: vec![0; 65_536],
            finish_given: None,
        })
    }

    #[cfg(test)]
    fn local_addr(&self) -> SocketAddr {
        self.socket.local_addr().expect("a bound socket has an address")
    }

    fn frame_of(&mut self, main: &Main) -> Frame {
        let mut frame = main.to_frame(self.started.elapsed().as_secs_f64());
        if main.finished() {
            // The first frame at `laps + 1` closes the last lap; the drive around after it is not a lap.
            if self.finish_given == Some(frame.lap) {
                frame.driving = false;
            } else if frame.driving {
                self.finish_given = Some(frame.lap);
            }
        } else {
            self.finish_given = None;
        }
        frame
    }
}

impl Source for Wreckfest2 {
    fn game_id(&self) -> &'static str {
        "wreckfest2"
    }

    fn game_name(&self) -> &'static str {
        "Wreckfest 2"
    }

    fn next(&mut self, timeout: Duration) -> Option<Frame> {
        let deadline = Instant::now() + timeout;
        loop {
            // A zero timeout is an error for a socket: wait at least a millisecond.
            let wait = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
            if self.socket.set_read_timeout(Some(wait)).is_err() {
                self.healthy = false;
                return None;
            }
            match self.socket.recv_from(&mut self.buffer) {
                Ok((n, _)) => {
                    if let Some(main) = Main::parse(&self.buffer[..n]) {
                        return Some(self.frame_of(&main));
                    }
                    // Another packet type, or not ours: not a frame; keep waiting for the rest of the time.
                    if Instant::now() >= deadline {
                        return None;
                    }
                }
                Err(e) => match e.kind() {
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted | ErrorKind::ConnectionReset => return None,
                    _ => {
                        self.healthy = false;
                        return None;
                    }
                },
            }
        }
    }

    fn alive(&self) -> bool {
        self.healthy
    }

    fn listens(&self) -> bool {
        true
    }
}

pub fn open() -> Option<Box<dyn Source>> {
    Wreckfest2::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, PORT))).map(|s| Box::new(s) as Box<dyn Source>)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lapcut::LapCutter;

    // ---- the header, as a table of (field, bytes) for every struct, to add up again ---------------------------

    type Fields = Vec<(&'static str, usize)>;

    fn size(fields: &Fields) -> usize {
        fields.iter().map(|f| f.1).sum()
    }

    fn at(fields: &Fields, name: &str) -> usize {
        let mut offset = 0;
        for (n, s) in fields {
            if *n == name {
                return offset;
            }
            offset += s;
        }
        panic!("no field {name}");
    }

    fn header() -> Fields {
        vec![
            ("signature", 4),
            ("packetType", 1),
            ("statusFlags", 1),
            ("sessionTime", 4),
            ("raceTime", 4),
        ]
    }
    fn leaderboard() -> Fields {
        vec![
            ("status", 1),
            ("trackStatus", 1),
            ("lapCurrent", 2),
            ("position", 1),
            ("health", 1),
            ("wrecks", 2),
            ("frags", 2),
            ("assists", 2),
            ("score", 4),
            ("points", 4),
            ("deltaLeader", 4),
            ("lapTiming", 2),
            ("reserved", 6),
        ]
    }
    fn timing() -> Fields {
        vec![
            ("lapTimeCurrent", 4),
            ("lapTimePenaltyCurrent", 4),
            ("lapTimeLast", 4),
            ("lapTimeBest", 4),
            ("lapBest", 1),
            ("deltaAhead", 4),
            ("deltaBehind", 4),
            ("lapProgress", 4),
            ("reserved", 3),
        ]
    }
    fn timing_sectors() -> Fields {
        vec![
            ("sectorTimeCurrentLap1", 4),
            ("sectorTimeCurrentLap2", 4),
            ("sectorTimeLastLap1", 4),
            ("sectorTimeLastLap2", 4),
            ("sectorTimeBestLap1", 4),
            ("sectorTimeBestLap2", 4),
            ("sectorTimeBest1", 4),
            ("sectorTimeBest2", 4),
            ("sectorTimeBest3", 4),
        ]
    }
    fn info() -> Fields {
        vec![
            ("carId", 64),
            ("carName", 96),
            ("playerName", 24),
            ("participantIndex", 1),
            ("lastNormalTrackStatusTime", 4),
            ("lastCollisionTime", 4),
            ("lastResetTime", 4),
            ("team", 1),
            ("reserved", 15),
        ]
    }
    /// DAMAGE_BYTES_PER_PARTICIPANT = (DAMAGE_PARTS_MAX * DAMAGE_BITS_PER_PART + 7) / 8 with 56 parts, 3 bits.
    fn damage() -> Fields {
        vec![("damageStates", (56usize * 3).div_ceil(8))]
    }
    fn orientation() -> Fields {
        vec![
            ("positionX", 4),
            ("positionY", 4),
            ("positionZ", 4),
            ("orientationQuaternionX", 4),
            ("orientationQuaternionY", 4),
            ("orientationQuaternionZ", 4),
            ("orientationQuaternionW", 4),
            ("extentsX", 2),
            ("extentsY", 2),
            ("extentsZ", 2),
        ]
    }
    fn velocity() -> Fields {
        vec![
            ("velocityLocalX", 4),
            ("velocityLocalY", 4),
            ("velocityLocalZ", 4),
            ("angularVelocityX", 4),
            ("angularVelocityY", 4),
            ("angularVelocityZ", 4),
            ("accelerationLocalX", 4),
            ("accelerationLocalY", 4),
            ("accelerationLocalZ", 4),
        ]
    }
    fn assists() -> Fields {
        vec![
            ("flags", 1),
            ("assistGearbox", 1),
            ("levelAbs", 1),
            ("levelTcs", 1),
            ("levelEsc", 1),
            ("reserved", 3),
        ]
    }
    fn chassis() -> Fields {
        vec![
            ("trackWidth", 2 * 4),
            ("wheelBase", 4),
            ("steeringWheelLockToLock", 4),
            ("steeringLock", 4),
            ("cornerWeights", 4 * 4),
            ("reserved", 16),
        ]
    }
    fn driveline() -> Fields {
        vec![("type", 1), ("gear", 1), ("gearMax", 1), ("speed", 4), ("reserved", 17)]
    }
    fn engine() -> Fields {
        vec![
            ("flags", 1),
            ("rpm", 4),
            ("rpmMax", 4),
            ("rpmRedline", 4),
            ("rpmIdle", 4),
            ("torque", 4),
            ("power", 4),
            ("tempBlock", 4),
            ("tempWater", 4),
            ("pressureManifold", 4),
            ("pressureOil", 4),
            ("reserved", 15),
        ]
    }
    fn input() -> Fields {
        vec![("throttle", 4), ("brake", 4), ("clutch", 4), ("handbrake", 4), ("steering", 4)]
    }
    fn tire() -> Fields {
        vec![
            ("rps", 4),
            ("camber", 4),
            ("slipRatio", 4),
            ("slipAngle", 4),
            ("radiusUnloaded", 4),
            ("loadVertical", 4),
            ("forceLat", 4),
            ("forceLong", 4),
            ("temperatureInner", 4),
            ("temperatureTread", 4),
            ("suspensionVelocity", 4),
            ("suspensionDisplacement", 4),
            ("suspensionDispNorm", 4),
            ("positionVertical", 4),
            ("surfaceType", 1),
            ("reserved", 15),
        ]
    }
    fn car_full() -> Fields {
        vec![
            ("assists", size(&assists())),
            ("chassis", size(&chassis())),
            ("driveline", size(&driveline())),
            ("engine", size(&engine())),
            ("input", size(&input())),
            ("orientation", size(&orientation())),
            ("velocity", size(&velocity())),
            ("tires", 4 * size(&tire())),
            ("reserved", 14),
        ]
    }
    fn session() -> Fields {
        vec![
            ("trackId", 64),
            ("trackName", 96),
            ("trackLength", 4),
            ("laps", 2),
            ("eventLength", 2),
            ("gridSize", 1),
            ("gridSizeRemaining", 1),
            ("sectorCount", 1),
            ("sectorFract1", 4),
            ("sectorFract2", 4),
            ("gameMode", 1),
            ("damageMode", 1),
            ("status", 1),
            ("reserved", 26),
        ]
    }
    fn input_extended() -> Fields {
        vec![("flags", 1), ("ffbForce", 4), ("reserved", 15)]
    }
    fn main_packet() -> Fields {
        vec![
            ("header", size(&header())),
            ("marshalFlagsPlayer", 2),
            ("participantPlayerLeaderboard", size(&leaderboard())),
            ("participantPlayerTiming", size(&timing())),
            ("participantPlayerTimingSectors", size(&timing_sectors())),
            ("participantPlayerInfo", size(&info())),
            ("participantPlayerDamage", size(&damage())),
            ("carPlayer", size(&car_full())),
            ("session", size(&session())),
            ("playerStatusFlags", 2),
            ("inputExtended", size(&input_extended())),
            ("reserved", 106),
        ]
    }

    #[test]
    fn the_offsets_are_the_sums_of_the_field_sizes_of_the_header() {
        use layout::*;
        assert_eq!(
            (size(&header()), size(&leaderboard()), size(&timing()), size(&timing_sectors())),
            (14, 32, 32, 36)
        );
        assert_eq!(
            (size(&info()), size(&damage()), size(&car_full()), size(&session())),
            (213, 21, 532, 208)
        );
        assert_eq!(size(&main_packet()), 1218);
        assert_eq!(MAIN_LEN, size(&main_packet()));
        assert_eq!(HEADER_LEN, size(&header()));

        let lb = at(&main_packet(), "participantPlayerLeaderboard");
        let tm = at(&main_packet(), "participantPlayerTiming");
        let inf = at(&main_packet(), "participantPlayerInfo");
        let car = at(&main_packet(), "carPlayer");
        let ses = at(&main_packet(), "session");
        let in_car = |part: &str, field: &Fields, name: &str| car + at(&car_full(), part) + at(field, name);
        let checks: [(usize, usize, &str); 29] = [
            (SIGNATURE_AT, at(&header(), "signature"), "signature"),
            (TYPE_AT, at(&header(), "packetType"), "packetType"),
            (GAME_STATUS_AT, at(&header(), "statusFlags"), "statusFlags"),
            (LAP_CURRENT_AT, lb + at(&leaderboard(), "lapCurrent"), "lapCurrent"),
            (LAP_TIMING_AT, lb + at(&leaderboard(), "lapTiming"), "lapTiming"),
            (LAP_TIME_CURRENT_AT, tm + at(&timing(), "lapTimeCurrent"), "lapTimeCurrent"),
            (LAP_TIME_LAST_AT, tm + at(&timing(), "lapTimeLast"), "lapTimeLast"),
            (LAP_PROGRESS_AT, tm + at(&timing(), "lapProgress"), "lapProgress"),
            (CAR_ID_AT, inf + at(&info(), "carId"), "carId"),
            (CAR_NAME_AT, inf + at(&info(), "carName"), "carName"),
            (GEAR_AT, in_car("driveline", &driveline(), "gear"), "gear"),
            (DRIVELINE_SPEED_AT, in_car("driveline", &driveline(), "speed"), "driveline speed"),
            (RPM_AT, in_car("engine", &engine(), "rpm"), "rpm"),
            (THROTTLE_AT, in_car("input", &input(), "throttle"), "throttle"),
            (BRAKE_AT, in_car("input", &input(), "brake"), "brake"),
            (CLUTCH_AT, in_car("input", &input(), "clutch"), "clutch"),
            (STEERING_AT, in_car("input", &input(), "steering"), "steering"),
            (POSITION_AT, in_car("orientation", &orientation(), "positionX"), "positionX"),
            (POSITION_AT + 8, in_car("orientation", &orientation(), "positionZ"), "positionZ"),
            (VELOCITY_AT, in_car("velocity", &velocity(), "velocityLocalX"), "velocityLocalX"),
            (VELOCITY_AT + 8, in_car("velocity", &velocity(), "velocityLocalZ"), "velocityLocalZ"),
            (TRACK_ID_AT, ses + at(&session(), "trackId"), "trackId"),
            (TRACK_NAME_AT, ses + at(&session(), "trackName"), "trackName"),
            (TRACK_LENGTH_AT, ses + at(&session(), "trackLength"), "trackLength"),
            (LAPS_AT, ses + at(&session(), "laps"), "laps"),
            (SECTOR_COUNT_AT, ses + at(&session(), "sectorCount"), "sectorCount"),
            (GAME_MODE_AT, ses + at(&session(), "gameMode"), "gameMode"),
            (PLAYER_STATUS_AT, at(&main_packet(), "playerStatusFlags"), "playerStatusFlags"),
            (
                CAR_NAME_AT + CAR_NAME_LEN,
                inf + at(&info(), "playerName"),
                "playerName (right after carName)",
            ),
        ];
        for (coded, derived, name) in checks {
            assert_eq!(coded, derived, "{name}");
        }
        // The state's fields.
        for (coded, derived, name) in [
            (MARSHAL_FLAGS, at(&main_packet(), "marshalFlagsPlayer"), "marshalFlagsPlayer"),
            (DAMAGE, at(&main_packet(), "participantPlayerDamage"), "damageStates"),
            (ASSIST_FLAGS_AT, in_car("assists", &assists(), "flags"), "assists.flags"),
            (LEVEL_ABS_AT, in_car("assists", &assists(), "levelAbs"), "levelAbs"),
            (LEVEL_TCS_AT, in_car("assists", &assists(), "levelTcs"), "levelTcs"),
            (ENGINE_FLAGS_AT, in_car("engine", &engine(), "flags"), "engine.flags"),
            (TEMP_WATER_AT, in_car("engine", &engine(), "tempWater"), "tempWater"),
            (HANDBRAKE_AT, in_car("input", &input(), "handbrake"), "handbrake"),
        ] {
            assert_eq!(coded, derived, "{name}");
        }
        assert_eq!(DAMAGE_BYTES, size(&damage()));
        // The text fields are as long as the header says.
        assert_eq!((CAR_ID_LEN, CAR_NAME_LEN, TRACK_ID_LEN, TRACK_NAME_LEN), (64, 96, 64, 96));
        // The other packets (ignored) have their sizes from the same table.
        let participants = |each: usize, reserved: usize| size(&header()) + 1 + 36 * each + reserved;
        assert_eq!(participants(size(&leaderboard()), 64), 1231);
        assert_eq!(participants(size(&timing_sectors()), 64), 1375);
        assert_eq!(participants(size(&orientation()) + 4, 0), 1383);
        assert_eq!(participants(size(&info()), 512), 8195);
        assert_eq!(participants(size(&damage()), 256), 1027);
    }

    #[test]
    fn the_signature_and_the_port_are_the_ones_the_header_and_the_game_use() {
        assert_eq!(layout::SIGNATURE, 1_869_769_584);
        assert_eq!(layout::SIGNATURE.to_le_bytes(), *b"pkro");
        assert_eq!(PORT, 23123);
    }

    // ---- a packet written field by field in the order of the header --------------------------------------------

    #[derive(Default)]
    struct W(Vec<u8>);
    impl W {
        fn u8(&mut self, v: u8) {
            self.0.push(v);
        }
        fn u16(&mut self, v: u16) {
            self.0.extend(v.to_le_bytes());
        }
        fn i16(&mut self, v: i16) {
            self.0.extend(v.to_le_bytes());
        }
        fn u32(&mut self, v: u32) {
            self.0.extend(v.to_le_bytes());
        }
        fn i32(&mut self, v: i32) {
            self.0.extend(v.to_le_bytes());
        }
        fn f32(&mut self, v: f32) {
            self.0.extend(v.to_le_bytes());
        }
        /// A zero terminated text in a field of `n` bytes, the rest filled with leftovers the game might leave.
        fn text(&mut self, s: &str, n: usize) {
            let mut field = vec![0xEE; n];
            field[..s.len()].copy_from_slice(s.as_bytes());
            field[s.len()] = 0;
            self.0.extend(field);
        }
        /// Bytes nobody should read (reserved space): not zero, so a wrong offset shows.
        fn junk(&mut self, n: usize) {
            self.0.extend(std::iter::repeat_n(0xA5, n));
        }
    }

    #[derive(Clone)]
    struct Scene {
        packet_type: u8,
        game_status: u8,
        player_status: u16,
        lap_current: u16,
        lap_timing: u16,
        lap_time_current: u32,
        lap_time_last: u32,
        lap_progress: f32,
        car_id: &'static str,
        car_name: &'static str,
        track_id: &'static str,
        track_name: &'static str,
        track_length: f32,
        laps: i16,
        sector_count: u8,
        game_mode: u8,
        gear: u8,
        gear_max: u8,
        speedo: f32,
        rpm: i32,
        throttle: f32,
        brake: f32,
        clutch: f32,
        steering: f32,
        position: [f32; 3],
        velocity: [f32; 3],
        marshal_flags: u16,
        assist_flags: u8,
        engine_flags: u8,
        /// The state of each of the 37 damage parts (0 ok .. 4 terminal), packed three bits each by `build_main`.
        damage: [u8; 37],
    }

    /// The header's packing: `DAMAGE_BITS_PER_PART` = 3, the part `i` at bit `3 i`, little endian.
    fn pack_damage(states: &[u8; 37]) -> [u8; 21] {
        let mut out = [0u8; 21];
        for (i, state) in states.iter().enumerate() {
            let bit = i * 3;
            let value = u16::from(*state & 0b111) << (bit % 8);
            out[bit / 8] |= value as u8;
            if bit % 8 > 5 {
                out[bit / 8 + 1] |= (value >> 8) as u8;
            }
        }
        out
    }

    impl Scene {
        /// A race in progress with a different value in every field.
        fn racing() -> Scene {
            Scene {
                packet_type: 0,
                game_status: layout::GAME_IN_RACE,
                player_status: 1 | 2 | 4 | 8, // in race, drivable, physics running, the player drives
                lap_current: 2,
                lap_timing: 2,
                lap_time_current: 83_456,
                lap_time_last: 91_234,
                lap_progress: 0.25,
                car_id: "car04:default",
                car_name: "Rocket",
                track_id: "track01_4",
                track_name: "Savolax Sandpit Reverse",
                track_length: 3000.0,
                laps: 5,
                sector_count: 3,
                game_mode: 0,
                gear: 3,
                gear_max: 5,
                speedo: 55.5,
                rpm: 6543,
                throttle: 0.75,
                brake: 0.25,
                clutch: 0.5,
                steering: -0.5,
                position: [101.5, 2.25, -303.75],
                velocity: [3.0, 0.0, 4.0],
                // The green and the blue flag, the ABS and TCS lights, a running engine.
                marshal_flags: layout::MARSHAL_GREEN | layout::MARSHAL_BLUE,
                assist_flags: 3,
                engine_flags: 1,
                // Engine 1, gearbox 2, suspensions 0 3 1 0, armour 0 0 2 0 4 1 (the rest of the parts untouched).
                damage: {
                    let mut d = [0u8; 37];
                    d[0] = 1;
                    d[1] = 2;
                    d[6..10].copy_from_slice(&[0, 3, 1, 0]);
                    d[30..36].copy_from_slice(&[0, 0, 2, 0, 4, 1]);
                    d
                },
            }
        }
    }

    /// Packet::Main, struct by struct as the header lists them.
    fn build_main(s: &Scene) -> Vec<u8> {
        let mut w = W::default();
        // Header
        w.u32(layout::SIGNATURE);
        w.u8(s.packet_type);
        w.u8(s.game_status);
        w.i32(123_456);
        w.i32(65_432);
        w.u16(s.marshal_flags); // marshalFlagsPlayer
                                // Participant::Leaderboard
        w.u8(2); // status: racing
        w.u8(0);
        w.u16(s.lap_current);
        w.u8(3); // position
        w.u8(100); // health
        w.u16(1);
        w.u16(2);
        w.u16(3);
        w.i32(1234);
        w.i32(55);
        w.i32(-7);
        w.u16(s.lap_timing);
        w.junk(6);
        // Participant::Timing
        w.u32(s.lap_time_current);
        w.u32(777); // penalty
        w.u32(s.lap_time_last);
        w.u32(88_888); // best
        w.u8(1);
        w.i32(11);
        w.i32(22);
        w.f32(s.lap_progress);
        w.junk(3);
        // Participant::TimingSectors
        for i in 0..9 {
            w.u32(1000 + i);
        }
        // Participant::Info
        w.text(s.car_id, 64);
        w.text(s.car_name, 96);
        w.text("Vanildo", 24);
        w.u8(4);
        w.i32(1);
        w.i32(2);
        w.i32(3);
        w.u8(255);
        w.junk(15);
        // Participant::Damage
        w.0.extend(pack_damage(&s.damage));
        // Car::Full: assists
        for v in [s.assist_flags, 2, 1, 2, 2] {
            w.u8(v);
        }
        w.junk(3);
        // chassis
        for v in [1.6f32, 1.7, 2.6] {
            w.f32(v);
        }
        w.i32(900);
        w.f32(0.6);
        for v in [4000.0f32, 4100.0, 3000.0, 3100.0] {
            w.f32(v);
        }
        w.junk(16);
        // driveline
        w.u8(1);
        w.u8(s.gear);
        w.u8(s.gear_max);
        w.f32(s.speedo);
        w.junk(17);
        // engine
        w.u8(s.engine_flags);
        w.i32(s.rpm);
        w.i32(7500);
        w.i32(7000);
        w.i32(900);
        for v in [250.0f32, 90_000.0, 350.0, 360.0, 101.0, 300.0] {
            w.f32(v);
        }
        w.junk(15);
        // input
        w.f32(s.throttle);
        w.f32(s.brake);
        w.f32(s.clutch);
        w.f32(0.9); // handbrake
        w.f32(s.steering);
        // orientation
        for v in s.position {
            w.f32(v);
        }
        for v in [0.1f32, 0.2, 0.3, 0.9] {
            w.f32(v);
        }
        for v in [90u16, 70, 220] {
            w.u16(v);
        }
        // velocity
        for v in s.velocity {
            w.f32(v);
        }
        for v in [0.5f32, 0.6, 0.7, 1.5, 1.6, 1.7] {
            w.f32(v);
        }
        // tires
        for t in 0..4 {
            for i in 0..14 {
                w.f32(t as f32 * 100.0 + i as f32);
            }
            w.u8(2);
            w.junk(15);
        }
        w.junk(14); // Car::Full reserved
                    // Session
        w.text(s.track_id, 64);
        w.text(s.track_name, 96);
        w.f32(s.track_length);
        w.i16(s.laps);
        w.i16(600);
        w.u8(12);
        w.u8(11);
        w.u8(s.sector_count);
        w.f32(0.33);
        w.f32(0.67);
        w.u8(s.game_mode);
        w.u8(1);
        w.u8(3); // status: racing
        w.junk(26);
        w.u16(s.player_status);
        // InputExtended
        w.u8(1);
        w.f32(0.4);
        w.junk(15);
        w.junk(106); // Main reserved
        w.0
    }

    /// A packet of another type of the format (the ones that describe all the cars), of the size the header gives.
    fn other_packet(packet_type: u8, len: usize) -> Vec<u8> {
        let mut w = W::default();
        w.u32(layout::SIGNATURE);
        w.u8(packet_type);
        w.u8(layout::GAME_IN_RACE);
        w.i32(123_456);
        w.i32(65_432);
        // Whatever the cars say: lap numbers that are not the player's.
        w.0.extend(std::iter::repeat_n(9u8, len - w.0.len()));
        w.0
    }

    fn parse_frame(s: &Scene) -> Frame {
        Main::parse(&build_main(s)).expect("a valid packet").to_frame(1.0)
    }

    // ---- parsing -------------------------------------------------------------------------------------------

    #[test]
    fn a_main_packet_becomes_the_frame_with_the_values_it_holds() {
        let bytes = build_main(&Scene::racing());
        assert_eq!(bytes.len(), 1218, "the packet is as long as the header makes it");
        let f = parse_frame(&Scene::racing());
        assert!(f.driving);
        assert_eq!(f.clock_s, 1.0);
        assert_eq!(f.lap, 2);
        assert_eq!(f.lap_time_s, Some(83.456));
        assert_eq!(f.last_lap_s, Some(91.234));
        assert_eq!(f.lap_valid, None, "the packets say nothing about it");
        assert_eq!(f.dist_m, Some(750.0), "0.25 of a 3000 m lap");
        assert!(!f.in_pits);
        assert_eq!(f.speed_ms, 5.0, "the length of the velocity (3, 0, 4), not the speedometer's 55.5");
        assert_eq!(f.rpm, 6543.0);
        assert_eq!(f.gear, 2.0, "the header's 3 is second gear");
        assert_eq!(f.gears, Some(5), "gearMax 5: fifth is the top gear");
        assert_eq!((f.throttle, f.brake, f.clutch, f.steer), (0.75, 0.25, 0.5, -0.5));
        assert_eq!((f.x, f.y, f.z), (101.5, 2.25, -303.75));
        assert!(f.fuel_l.is_nan());
        assert_eq!((f.car.as_str(), f.track.as_str()), ("Rocket", "Savolax Sandpit Reverse"));
        assert_eq!((f.car_class, f.track_variant, f.track_length_m), (None, None, Some(3000.0)));
        // The car's state: 360 K of coolant (86.85 C), a 0.9 handbrake, ABS level 1 and TCS level 2, both acting.
        let water = f.state.water_c.expect("the coolant");
        assert!((water - 86.85).abs() < 0.001, "{water}");
        assert_eq!(
            CarState { water_c: None, ..f.state },
            CarState {
                abs_active: Some(true),
                tc_active: Some(true),
                handbrake: Some(true),
                engine_warning: Some(false),
                flag: Some(Flag::Blue),
                abs_level: Some(1),
                tc_level: Some(2),
                damage_body: Some(1.0),        // an armour part is terminal (4 of 4)
                damage_engine: Some(0.25),     // 1 of 4
                damage_gearbox: Some(0.5),     // 2 of 4
                damage_suspension: Some(0.75), // the worst of 0, 3, 1, 0
                ..CarState::UNKNOWN
            }
        );
    }

    #[test]
    fn the_packed_damage_the_flags_and_a_misfire_map_as_the_header_says() {
        // Every part's three bits survive the packing, including the ones that straddle two bytes.
        let states: [u8; 37] = std::array::from_fn(|i| (i % 5) as u8);
        let packed = pack_damage(&states);
        for (i, want) in states.iter().enumerate() {
            assert_eq!(damage_state(&packed, i), *want, "part {i}");
        }
        for (flags, want) in [
            (0u16, None),
            (layout::MARSHAL_GREEN, Some(Flag::Green)),
            (layout::MARSHAL_GREEN | layout::MARSHAL_WHITE, Some(Flag::White)),
            (
                layout::MARSHAL_GREEN | layout::MARSHAL_WHITE | layout::MARSHAL_BLUE,
                Some(Flag::Blue),
            ),
            (layout::MARSHAL_BLUE | layout::MARSHAL_FINISH, Some(Flag::Chequered)),
            (layout::MARSHAL_FINISH | layout::MARSHAL_MEATBALL, Some(Flag::Black)),
            (layout::MARSHAL_DQ, Some(Flag::Black)),
            (1 << 5, None), // the "close to DQ" warning is not a flag `Flag` has
        ] {
            let f = parse_frame(&Scene {
                marshal_flags: flags,
                ..Scene::racing()
            });
            assert_eq!(f.state.flag, want, "marshal flags {flags:#b}");
        }
        let f = parse_frame(&Scene {
            engine_flags: 1 | 4,
            assist_flags: 0,
            damage: [7; 37],
            ..Scene::racing()
        });
        assert_eq!(f.state.engine_warning, Some(true), "misfiring");
        assert_eq!((f.state.abs_active, f.state.tc_active), (Some(false), Some(false)));
        assert_eq!(
            (f.state.damage_engine, f.state.damage_body),
            (None, None),
            "a state above 4 is not one"
        );
    }

    #[test]
    fn the_top_gear_of_the_header_is_the_gear_count_when_set() {
        let gears = |m: u8| {
            parse_frame(&Scene {
                gear_max: m,
                ..Scene::racing()
            })
            .gears
        };
        assert_eq!((gears(6), gears(0), gears(200)), (Some(6), None, None));
    }

    #[test]
    fn the_gears_of_the_header_become_the_gears_of_the_frame() {
        let gear = |g: u8| {
            parse_frame(&Scene {
                gear: g,
                ..Scene::racing()
            })
            .gear
        };
        assert_eq!((gear(0), gear(1), gear(2), gear(6)), (-1.0, 0.0, 1.0, 5.0));
        assert!(gear(200).is_nan());
    }

    #[test]
    fn without_a_name_the_car_and_the_track_fall_back_to_something_stable() {
        let f = parse_frame(&Scene {
            car_name: "",
            track_name: "",
            ..Scene::racing()
        });
        assert_eq!((f.car.as_str(), f.track.as_str()), ("car04:default", "track01_4"));
        let f = parse_frame(&Scene {
            car_id: "",
            car_name: "",
            track_id: "",
            track_name: "",
            game_mode: 8,
            ..Scene::racing()
        });
        assert_eq!((f.car.as_str(), f.track.as_str()), ("", "Time trial"));
    }

    #[test]
    fn the_speedometer_is_the_fallback_for_the_speed() {
        let f = parse_frame(&Scene {
            velocity: [f32::NAN, 0.0, 0.0],
            speedo: 40.0,
            ..Scene::racing()
        });
        assert_eq!(f.speed_ms, 40.0);
    }

    #[test]
    fn packets_of_the_wrong_size_signature_or_type_are_ignored() {
        let good = build_main(&Scene::racing());
        assert!(Main::parse(&good).is_some());
        for len in [0, 1, 13, 14, 1217, 1219, 1231, 8195] {
            let mut bytes = good.clone();
            bytes.resize(len, 0);
            assert!(Main::parse(&bytes).is_none(), "{len} bytes");
        }
        let mut other_signature = good.clone();
        other_signature[0] ^= 1;
        assert!(Main::parse(&other_signature).is_none());
        for packet_type in 1..=7u8 {
            assert!(
                Main::parse(&build_main(&Scene {
                    packet_type,
                    ..Scene::racing()
                }))
                .is_none(),
                "type {packet_type}"
            );
        }
        // The other packets of the format, at their own sizes.
        for (packet_type, len) in [(1u8, 1231), (2, 1231), (3, 1375), (4, 1383), (5, 8195), (6, 1027)] {
            assert!(Main::parse(&other_packet(packet_type, len)).is_none(), "type {packet_type}");
        }
    }

    /// A small generator of bytes, so the "garbage" is the same on every run.
    struct Noise(u64);
    impl Noise {
        fn byte(&mut self) -> u8 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 33) as u8
        }
    }

    #[test]
    fn garbage_and_truncated_packets_never_panic() {
        let good = build_main(&Scene::racing());
        // Every cut of a good packet.
        for len in 0..=good.len() {
            let _ = Main::parse(&good[..len]);
        }
        let mut noise = Noise(7);
        // Random bytes of random lengths, and random bytes in a packet of the right size with the right signature.
        for round in 0..400 {
            let len = if round % 4 == 0 { good.len() } else { (noise.byte() as usize) * 12 };
            let mut bytes: Vec<u8> = (0..len).map(|_| noise.byte()).collect();
            if round % 2 == 0 && len == good.len() {
                bytes[..4].copy_from_slice(&layout::SIGNATURE.to_le_bytes());
                bytes[layout::TYPE_AT] = 0;
            }
            if let Some(main) = Main::parse(&bytes) {
                let _ = main.to_frame(0.0);
                let _ = (main.lap_based(), main.finished(), main.in_a_race());
            }
        }
        // Every float and integer at its extreme.
        for fill in [0x00u8, 0xFF, 0x7F, 0x80] {
            let mut bytes = vec![fill; good.len()];
            bytes[..4].copy_from_slice(&layout::SIGNATURE.to_le_bytes());
            bytes[layout::TYPE_AT] = 0;
            let f = Main::parse(&bytes).expect("right size and signature").to_frame(0.0);
            assert!(f.lap_time_s.is_none_or(|t| t < 86_400.0));
        }
        // Not-a-number floats give "not given", not a number that is wrong.
        let f = parse_frame(&Scene {
            throttle: f32::NAN,
            steering: f32::INFINITY,
            position: [f32::NAN; 3],
            lap_progress: f32::NAN,
            ..Scene::racing()
        });
        assert!(f.throttle.is_nan() && f.steer.is_nan() && f.x.is_nan());
        assert_eq!(f.dist_m, None);
        let f = parse_frame(&Scene {
            throttle: 7.0,
            brake: -2.0,
            steering: 3.0,
            lap_progress: 4.0,
            ..Scene::racing()
        });
        assert_eq!((f.throttle, f.brake, f.steer, f.dist_m), (1.0, 0.0, 1.0, Some(3000.0)));
    }

    #[test]
    fn only_a_race_the_player_is_driving_counts_as_driving() {
        use layout::*;
        let driving = |s: Scene| parse_frame(&s).driving;
        assert!(driving(Scene::racing()));
        let g = |status: u8| Scene {
            game_status: status,
            ..Scene::racing()
        };
        assert!(!driving(g(0)), "outside a race (menu, garage)");
        assert!(!driving(g(GAME_IN_RACE | GAME_PAUSED)), "paused");
        assert!(!driving(g(GAME_IN_RACE | GAME_REPLAY)), "replay");
        assert!(!driving(g(GAME_IN_RACE | GAME_SPECTATE)), "spectating");
        let p = |status: u16| Scene {
            player_status: status,
            ..Scene::racing()
        };
        assert!(!driving(p(0)));
        assert!(!driving(p(2 | 8)), "the player's car is not on track");
        assert!(!driving(p(1 | 2 | 8)), "physics not running");
        assert!(driving(p(1 | 4)), "the control flags do not matter");
        assert!(
            !driving(Scene {
                lap_current: 0,
                lap_timing: 0,
                ..Scene::racing()
            }),
            "lap 0 is the grid before the start"
        );
    }

    #[test]
    fn derbies_have_no_laps_and_nothing_to_record() {
        // sectorCount 0 is how revision 6 says it; the mode alone says it too (older games sent 3).
        for (mode, sectors) in [(1u8, 0u8), (2, 0), (3, 0), (3, 3), (5, 0), (6, 3), (0, 0)] {
            let f = parse_frame(&Scene {
                game_mode: mode,
                sector_count: sectors,
                lap_current: 4,
                lap_timing: 4,
                ..Scene::racing()
            });
            assert!(!f.driving, "mode {mode}, sectors {sectors}");
            assert_eq!((f.lap, f.lap_time_s, f.last_lap_s, f.dist_m), (0, None, None, None), "mode {mode}");
        }
        // The race modes do have laps.
        for mode in [0u8, 4, 7, 8, 9, 255] {
            assert!(
                parse_frame(&Scene {
                    game_mode: mode,
                    ..Scene::racing()
                })
                .driving,
                "mode {mode}"
            );
        }
        // A derby whose lap counter moves still makes no lap.
        let mut cutter = LapCutter::new("wreckfest2");
        for i in 0..400 {
            let scene = Scene {
                game_mode: 3,
                sector_count: 0,
                lap_current: 1 + (i / 60) as u16,
                lap_timing: 1 + (i / 60) as u16,
                lap_time_current: i * 50,
                ..Scene::racing()
            };
            let frame = Main::parse(&build_main(&scene)).unwrap().to_frame(f64::from(i) * 0.05);
            assert!(cutter.on_frame(&frame, i64::from(i) * 50).is_empty());
        }
    }

    #[test]
    fn timing_of_another_lap_is_not_given() {
        // Just after the line in multiplayer: lapCurrent is 3 but the timing is still of lap 2.
        let late = parse_frame(&Scene {
            lap_current: 3,
            lap_timing: 2,
            ..Scene::racing()
        });
        assert!(late.driving);
        assert_eq!((late.lap, late.lap_time_s, late.last_lap_s), (3, None, None));
        let in_step = parse_frame(&Scene {
            lap_current: 3,
            lap_timing: 3,
            ..Scene::racing()
        });
        assert_eq!((in_step.lap_time_s, in_step.last_lap_s), (Some(83.456), Some(91.234)));
        // No last lap yet (0), and a time that is no time.
        let first = parse_frame(&Scene {
            lap_time_last: 0,
            ..Scene::racing()
        });
        assert_eq!(first.last_lap_s, None);
        let junk = parse_frame(&Scene {
            lap_time_current: u32::MAX,
            lap_time_last: u32::MAX,
            ..Scene::racing()
        });
        assert_eq!((junk.lap_time_s, junk.last_lap_s), (None, None));
    }

    // ---- the door --------------------------------------------------------------------------------------------

    fn loopback() -> Wreckfest2 {
        Wreckfest2::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).expect("a free loopback port")
    }

    fn sender() -> UdpSocket {
        UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap()
    }

    const WAIT: Duration = Duration::from_millis(500);

    #[test]
    fn a_port_somebody_else_listens_on_is_not_opened() {
        let first = loopback();
        assert!(Wreckfest2::bind(first.local_addr()).is_none());
        assert!(first.alive());
    }

    #[test]
    fn it_waits_for_the_game_and_then_gives_what_the_game_sends() {
        let mut source = loopback();
        let (tx, to) = (sender(), source.local_addr());
        assert_eq!((source.game_id(), source.game_name()), ("wreckfest2", "Wreckfest 2"));
        let t = Instant::now();
        assert!(source.next(Duration::from_millis(30)).is_none(), "nothing sent yet");
        assert!(t.elapsed() >= Duration::from_millis(20) && t.elapsed() < Duration::from_secs(2));
        assert!(source.alive(), "a silent game does not close the door");
        assert!(source.next(Duration::ZERO).is_none(), "a zero wait is fine");

        tx.send_to(&build_main(&Scene::racing()), to).unwrap();
        let f = source.next(WAIT).expect("the frame");
        assert_eq!((f.lap, f.car.as_str(), f.driving), (2, "Rocket", true));
        // The clock only goes forward.
        tx.send_to(&build_main(&Scene::racing()), to).unwrap();
        let g = source.next(WAIT).unwrap();
        assert!(g.clock_s >= f.clock_s && f.clock_s >= 0.0);
    }

    #[test]
    fn what_is_not_a_main_packet_is_skipped_and_the_player_is_the_one_in_main() {
        let mut source = loopback();
        let (tx, to) = (sender(), source.local_addr());
        // The packets about all the cars, whose lap numbers (9) are not the player's.
        for (packet_type, len) in [(1u8, 1231), (2, 1231), (3, 1375), (4, 1383), (5, 8195), (6, 1027)] {
            tx.send_to(&other_packet(packet_type, len), to).unwrap();
        }
        tx.send_to(b"hello", to).unwrap();
        tx.send_to(&[], to).unwrap();
        let mut wrong_size = build_main(&Scene::racing());
        wrong_size.push(0);
        tx.send_to(&wrong_size, to).unwrap();
        assert!(source.next(Duration::from_millis(60)).is_none(), "no frame from those");
        tx.send_to(
            &build_main(&Scene {
                lap_current: 4,
                lap_timing: 4,
                ..Scene::racing()
            }),
            to,
        )
        .unwrap();
        assert_eq!(source.next(WAIT).expect("the main packet").lap, 4);
        assert!(source.alive());
    }

    #[test]
    fn garbage_sent_by_somebody_does_not_stop_the_reader() {
        let mut source = loopback();
        let (tx, to) = (sender(), source.local_addr());
        let mut noise = Noise(99);
        for _ in 0..100 {
            let len = noise.byte() as usize * 30;
            let junk: Vec<u8> = (0..len).map(|_| noise.byte()).collect();
            tx.send_to(&junk, to).unwrap();
        }
        let _ = source.next(Duration::from_millis(100));
        assert!(source.alive());
        tx.send_to(&build_main(&Scene::racing()), to).unwrap();
        // Whatever the junk was, the next valid packet comes out (junk before it was skipped).
        let mut got = None;
        for _ in 0..200 {
            if let Some(f) = source.next(Duration::from_millis(20)) {
                got = Some(f);
                break;
            }
        }
        assert_eq!(got.expect("the frame").lap, 2);
    }

    #[test]
    fn a_whole_race_over_udp_makes_its_laps_with_the_games_own_times() {
        let mut source = loopback();
        let (tx, to) = (sender(), source.local_addr());
        let mut cutter = LapCutter::new(source.game_id());
        let mut laps = Vec::new();
        let mut sent = 0i64;
        // A race of two laps on a 2000 m track. One packet at a time, so the socket never has to hold them.
        let mut feed = |scene: Scene, source: &mut Wreckfest2, cutter: &mut LapCutter, laps: &mut Vec<crate::lapfile::Lap>| -> Frame {
            tx.send_to(&build_main(&scene), to).unwrap();
            let frame = source.next(WAIT).expect("a frame");
            sent += 1;
            laps.extend(cutter.on_frame(&frame, 1_794_312_000_000 + sent * 50));
            frame
        };
        let race = |lap: u16, timing: u16, ms: u32, last: u32, progress: f32| Scene {
            laps: 2,
            track_length: 2000.0,
            lap_current: lap,
            lap_timing: timing,
            lap_time_current: ms,
            lap_time_last: last,
            lap_progress: progress,
            ..Scene::racing()
        };

        // The grid before the start: lap 0, not recorded.
        for _ in 0..5 {
            let f = feed(race(0, 0, 0, 0, 0.0), &mut source, &mut cutter, &mut laps);
            assert!(!f.driving && f.lap == 0);
        }
        // Lap 1: 6.5 s at 20 Hz.
        for i in 1..=130u32 {
            let f = feed(race(1, 1, i * 50, 0, i as f32 / 131.0), &mut source, &mut cutter, &mut laps);
            assert!(f.driving && f.last_lap_s.is_none());
        }
        assert!(laps.is_empty(), "the lap is not over");
        // Lap 2: 6.0 s. The first two frames come with the timing still of lap 1 (the game's multiplayer delay):
        // no times in them, and the lap 1 time is not taken from them.
        for i in 1..=120u32 {
            let timing = if i <= 2 { 1 } else { 2 };
            let f = feed(
                race(2, timing, i * 50, 6_520, i as f32 / 121.0),
                &mut source,
                &mut cutter,
                &mut laps,
            );
            if i <= 2 {
                assert_eq!((f.lap_time_s, f.last_lap_s), (None, None));
                assert!(laps.is_empty());
            }
        }
        assert_eq!(laps.len(), 1, "lap 1 is written once the game's time for it arrived");
        let lap1 = &laps[0];
        assert_eq!((lap1.lap_number, lap1.time_ms, lap1.valid), (1, 6_520, true));
        assert_eq!(
            (lap1.game.as_str(), lap1.car_name.as_str(), lap1.track_name.as_str()),
            ("wreckfest2", "Rocket", "Savolax Sandpit Reverse")
        );
        assert_eq!(lap1.track_length_m, Some(2000.0));
        assert_eq!(lap1.sample_count(), 130);
        let ids: Vec<&str> = lap1.channels.iter().map(|c| c.id.as_str()).collect();
        // This game gives no fuel; version 2 adds the damage and the aids' lights.
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
                "damage_body",
                "tc_active",
                "abs_active"
            ]
        );
        let dist = lap1.channel("dist").unwrap();
        assert_eq!(dist.values[0], 2000.0 / 131.0, "metres along the lap from lapProgress x the length");
        assert!(dist.values.windows(2).all(|w| w[1] >= w[0]));
        assert_eq!(*lap1.channel("t").unwrap().values.last().unwrap(), 6.5, "the game's lap clock");

        // The finish: lapCurrent goes to laps + 1. The first frame is the one that closes lap 2, the rest are the
        // drive around after the flag.
        let finish = |ms: u32| race(3, 3, ms, 6_010, 0.0);
        let f = feed(finish(0), &mut source, &mut cutter, &mut laps);
        assert!(f.driving && f.lap == 3 && f.last_lap_s == Some(6.01));
        assert_eq!(laps.len(), 1, "the official time of lap 2 comes with the next frame");
        for i in 1..=5 {
            let f = feed(finish(i * 50), &mut source, &mut cutter, &mut laps);
            assert!(!f.driving, "after the finish the lap is not driven");
        }
        assert_eq!(laps.len(), 2);
        let lap2 = &laps[1];
        assert_eq!((lap2.lap_number, lap2.time_ms, lap2.valid), (2, 6_010, true));
        assert_eq!(lap2.sample_count(), 120);

        // A new race on the same track starts again from lap 1 and is cut as before.
        for i in 1..=10u32 {
            let f = feed(race(1, 1, i * 50, 0, 0.0), &mut source, &mut cutter, &mut laps);
            assert!(f.driving);
        }
        assert_eq!(laps.len(), 2);
    }
}
