//! Turning the bytes of `LMU_Data` into the few values Xpeed Sim uses.
//!
//! `Snapshot::from_memory` reads a buffer laid out like the shared memory (see `layout.rs`). The
//! reader fills that buffer from the game under the game's lock; the tests fill it by hand.
//! Only the player's car is read, and the driver's name is never kept.

use super::layout::*;

fn f64_at(bytes: &[u8], at: usize) -> f64 {
    f64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}
fn i32_at(bytes: &[u8], at: usize) -> i32 {
    i32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn i16_at(bytes: &[u8], at: usize) -> i16 {
    i16::from_le_bytes(bytes[at..at + 2].try_into().unwrap())
}
fn vect3_at(bytes: &[u8], at: usize) -> [f64; 3] {
    [f64_at(bytes, at), f64_at(bytes, at + 8), f64_at(bytes, at + 16)]
}
/// A fixed-size text field: up to the first zero byte, as UTF-8 (the game writes UTF-8).
fn text_at(bytes: &[u8], at: usize, max: usize) -> String {
    let field = &bytes[at..at + max];
    let end = field.iter().position(|&b| b == 0).unwrap_or(max);
    String::from_utf8_lossy(&field[..end]).into_owned()
}

/// The player's car, as the game reports it every telemetry update (100 Hz by default).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlayerTelemetry {
    /// Seconds of game session time.
    pub elapsed_time: f64,
    pub delta_time: f64,
    pub lap_number: i32,
    /// Session time at which the current lap started.
    pub lap_start_et: f64,
    pub vehicle_name: String,
    pub track_name: String,
    /// World position in meters, the game's own axes.
    pub pos: [f64; 3],
    /// Velocity in meters per second, in the car's own axes.
    pub local_vel: [f64; 3],
    pub gear: i32,
    pub rpm: f64,
    pub throttle: f64,
    pub brake: f64,
    pub steering: f64,
    pub clutch: f64,
    pub fuel_l: f64,
}

impl PlayerTelemetry {
    pub fn speed_ms(&self) -> f64 {
        self.local_vel.iter().map(|v| v * v).sum::<f64>().sqrt()
    }
}

/// The session as scoring sees it (a few updates per second).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionScoring {
    pub track_name: String,
    pub track_length_m: f64,
    pub session: i32,
    pub current_et: f64,
    pub num_vehicles: i32,
    pub game_phase: u8,
    pub in_realtime: bool,
}

/// The player's car in the scoring list.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VehicleScoring {
    pub vehicle_name: String,
    pub vehicle_class: String,
    pub total_laps: i16,
    /// Distance around the track, meters.
    pub lap_dist: f64,
    pub last_lap_time: f64,
    pub last_sector1: f64,
    /// Sector 2 is cumulative: the time from the start of the lap to the end of sector 2.
    pub last_sector2: f64,
    pub lap_start_et: f64,
    pub in_pits: bool,
    pub num_penalties: i16,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScoringFrame {
    pub session: SessionScoring,
    pub player: Option<VehicleScoring>,
}

/// What one frame of the game carried.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapshot {
    pub game_version: i32,
    /// The player's car, when telemetry was updated and the player has a car.
    pub telemetry: Option<PlayerTelemetry>,
    /// Scoring, when it was updated.
    pub scoring: Option<ScoringFrame>,
}

pub fn parse_telemetry(info: &[u8]) -> PlayerTelemetry {
    PlayerTelemetry {
        elapsed_time: f64_at(info, TI_ELAPSED_TIME),
        delta_time: f64_at(info, TI_DELTA_TIME),
        lap_number: i32_at(info, TI_LAP_NUMBER),
        lap_start_et: f64_at(info, TI_LAP_START_ET),
        vehicle_name: text_at(info, TI_VEHICLE_NAME, 64),
        track_name: text_at(info, TI_TRACK_NAME, 64),
        pos: vect3_at(info, TI_POS),
        local_vel: vect3_at(info, TI_LOCAL_VEL),
        gear: i32_at(info, TI_GEAR),
        rpm: f64_at(info, TI_ENGINE_RPM),
        throttle: f64_at(info, TI_THROTTLE),
        brake: f64_at(info, TI_BRAKE),
        steering: f64_at(info, TI_STEERING),
        clutch: f64_at(info, TI_CLUTCH),
        fuel_l: f64_at(info, TI_FUEL),
    }
}

pub fn parse_session(info: &[u8]) -> SessionScoring {
    SessionScoring {
        track_name: text_at(info, SI_TRACK_NAME, 64),
        track_length_m: f64_at(info, SI_LAP_DIST),
        session: i32_at(info, SI_SESSION),
        current_et: f64_at(info, SI_CURRENT_ET),
        num_vehicles: i32_at(info, SI_NUM_VEHICLES),
        game_phase: info[SI_GAME_PHASE],
        in_realtime: info[SI_IN_REALTIME] != 0,
    }
}

/// Whether this scoring entry is the player's own car (not an AI, not a remote driver).
pub fn is_player(vehicle: &[u8]) -> bool {
    vehicle[VS_IS_PLAYER] != 0 && vehicle[VS_CONTROL] == 0
}

pub fn parse_vehicle(vehicle: &[u8]) -> VehicleScoring {
    VehicleScoring {
        vehicle_name: text_at(vehicle, VS_VEHICLE_NAME, 64),
        vehicle_class: text_at(vehicle, VS_VEHICLE_CLASS, 32),
        total_laps: i16_at(vehicle, VS_TOTAL_LAPS),
        lap_dist: f64_at(vehicle, VS_LAP_DIST),
        last_lap_time: f64_at(vehicle, VS_LAST_LAP_TIME),
        last_sector1: f64_at(vehicle, VS_LAST_SECTOR1),
        last_sector2: f64_at(vehicle, VS_LAST_SECTOR2),
        lap_start_et: f64_at(vehicle, VS_LAP_START_ET),
        in_pits: vehicle[VS_IN_PITS] != 0,
        num_penalties: i16_at(vehicle, VS_NUM_PENALTIES),
    }
}

/// The event codes of this frame, from the queue at the start of the shared memory.
pub fn events(memory: &[u8]) -> Vec<u32> {
    (0..SME_MAX).map(|i| u32_at(memory, GENERIC_EVENTS + i * 4)).collect()
}

/// The slice of the shared memory that holds the telemetry of the car at `index`, if it exists.
pub fn telemetry_range(active_vehicles: u8, player_index: u8, player_has_vehicle: bool) -> Option<std::ops::Range<usize>> {
    if !player_has_vehicle || player_index >= active_vehicles || player_index as usize >= MAX_VEHICLES {
        return None;
    }
    let start = TELEMETRY_INFO + player_index as usize * TELEM_INFO_SIZE;
    Some(start..start + TELEM_INFO_SIZE)
}

impl Snapshot {
    /// Reads a buffer laid out like the shared memory (at least `LAYOUT_SIZE` bytes).
    pub fn from_memory(memory: &[u8]) -> Snapshot {
        assert!(memory.len() >= LAYOUT_SIZE, "the buffer is smaller than the shared memory layout");
        let codes = events(memory);
        let mut snapshot = Snapshot {
            game_version: i32_at(memory, GENERIC_GAME_VERSION),
            ..Snapshot::default()
        };

        if codes.contains(&SME_UPDATE_TELEMETRY) {
            let range = telemetry_range(
                memory[TELEMETRY_ACTIVE_VEHICLES],
                memory[TELEMETRY_PLAYER_INDEX],
                memory[TELEMETRY_PLAYER_HAS_VEHICLE] != 0,
            );
            snapshot.telemetry = range.map(|r| parse_telemetry(&memory[r]));
        }

        if codes.contains(&SME_UPDATE_SCORING) {
            let session = parse_session(&memory[SCORING_INFO..SCORING_INFO + SCORING_INFO_SIZE]);
            let count = session.num_vehicles.clamp(0, MAX_VEHICLES as i32) as usize;
            let player = (0..count)
                .map(|i| &memory[SCORING_VEHICLES + i * VEHICLE_SCORING_SIZE..SCORING_VEHICLES + (i + 1) * VEHICLE_SCORING_SIZE])
                .find(|vehicle| is_player(vehicle))
                .map(parse_vehicle);
            snapshot.scoring = Some(ScoringFrame { session, player });
        }
        snapshot
    }
}

/// Builds a buffer laid out like the shared memory, for the tests of this crate.
#[cfg(test)]
pub mod fake {
    use super::*;

    pub struct Memory(pub Vec<u8>);

    impl Memory {
        pub fn new() -> Self {
            Memory(vec![0; LAYOUT_SIZE])
        }
        pub fn put(&mut self, at: usize, bytes: &[u8]) {
            self.0[at..at + bytes.len()].copy_from_slice(bytes);
        }
        pub fn put_f64(&mut self, at: usize, value: f64) {
            self.put(at, &value.to_le_bytes());
        }
        pub fn put_i32(&mut self, at: usize, value: i32) {
            self.put(at, &value.to_le_bytes());
        }
        pub fn put_text(&mut self, at: usize, max: usize, value: &str) {
            assert!(value.len() < max);
            self.put(at, value.as_bytes());
        }
        pub fn set_events(&mut self, codes: &[u32]) {
            for (i, code) in codes.iter().enumerate() {
                self.put(GENERIC_EVENTS + i * 4, &code.to_le_bytes());
            }
        }

        /// The player's car at telemetry slot `index`.
        pub fn telemetry(&mut self, index: usize, active: u8, t: &PlayerTelemetry) {
            self.0[TELEMETRY_ACTIVE_VEHICLES] = active;
            self.0[TELEMETRY_PLAYER_INDEX] = index as u8;
            self.0[TELEMETRY_PLAYER_HAS_VEHICLE] = 1;
            let base = TELEMETRY_INFO + index * TELEM_INFO_SIZE;
            self.put_f64(base + TI_ELAPSED_TIME, t.elapsed_time);
            self.put_f64(base + TI_DELTA_TIME, t.delta_time);
            self.put_i32(base + TI_LAP_NUMBER, t.lap_number);
            self.put_f64(base + TI_LAP_START_ET, t.lap_start_et);
            self.put_text(base + TI_VEHICLE_NAME, 64, &t.vehicle_name);
            self.put_text(base + TI_TRACK_NAME, 64, &t.track_name);
            for axis in 0..3 {
                self.put_f64(base + TI_POS + axis * 8, t.pos[axis]);
                self.put_f64(base + TI_LOCAL_VEL + axis * 8, t.local_vel[axis]);
            }
            self.put_i32(base + TI_GEAR, t.gear);
            self.put_f64(base + TI_ENGINE_RPM, t.rpm);
            self.put_f64(base + TI_THROTTLE, t.throttle);
            self.put_f64(base + TI_BRAKE, t.brake);
            self.put_f64(base + TI_STEERING, t.steering);
            self.put_f64(base + TI_CLUTCH, t.clutch);
            self.put_f64(base + TI_FUEL, t.fuel_l);
        }

        /// Session scoring and a list of cars; `player` is the index of the player's own car.
        pub fn scoring(&mut self, s: &SessionScoring, cars: &[VehicleScoring], player: Option<usize>) {
            let base = SCORING_INFO;
            self.put_text(base + SI_TRACK_NAME, 64, &s.track_name);
            self.put_f64(base + SI_LAP_DIST, s.track_length_m);
            self.put_i32(base + SI_SESSION, s.session);
            self.put_f64(base + SI_CURRENT_ET, s.current_et);
            self.put_i32(base + SI_NUM_VEHICLES, cars.len() as i32);
            self.0[base + SI_GAME_PHASE] = s.game_phase;
            self.0[base + SI_IN_REALTIME] = s.in_realtime as u8;
            for (i, car) in cars.iter().enumerate() {
                let at = SCORING_VEHICLES + i * VEHICLE_SCORING_SIZE;
                self.put_text(at + VS_VEHICLE_NAME, 64, &car.vehicle_name);
                self.put_text(at + VS_VEHICLE_CLASS, 32, &car.vehicle_class);
                self.put(at + VS_TOTAL_LAPS, &car.total_laps.to_le_bytes());
                self.put_f64(at + VS_LAP_DIST, car.lap_dist);
                self.put_f64(at + VS_LAST_LAP_TIME, car.last_lap_time);
                self.put_f64(at + VS_LAST_SECTOR1, car.last_sector1);
                self.put_f64(at + VS_LAST_SECTOR2, car.last_sector2);
                self.put_f64(at + VS_LAP_START_ET, car.lap_start_et);
                self.0[at + VS_IN_PITS] = car.in_pits as u8;
                self.put(at + VS_NUM_PENALTIES, &car.num_penalties.to_le_bytes());
                self.0[at + VS_IS_PLAYER] = (Some(i) == player) as u8;
                self.0[at + VS_CONTROL] = if Some(i) == player { 0 } else { 1 };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::Memory;
    use super::*;

    fn car() -> PlayerTelemetry {
        PlayerTelemetry {
            elapsed_time: 123.456,
            delta_time: 0.01,
            lap_number: 3,
            lap_start_et: 100.5,
            vehicle_name: "Toyota GR010 #8".into(),
            track_name: "Circuit de la Sarthe".into(),
            pos: [10.0, 2.5, -30.0],
            local_vel: [0.0, 0.0, -80.0],
            gear: 5,
            rpm: 7200.0,
            throttle: 1.0,
            brake: 0.0,
            steering: -0.25,
            clutch: 0.0,
            fuel_l: 55.5,
        }
    }

    #[test]
    fn the_layout_is_the_one_the_game_reported() {
        // A few of the numbers the compiler printed for LMU 1.4.2.0: if someone edits layout.rs by hand, this notices.
        assert_eq!(LAYOUT_SIZE, 324_824);
        assert_eq!(MAX_VEHICLES, 104);
        assert_eq!(TELEM_INFO_SIZE, 1888);
        assert_eq!(VEHICLE_SCORING_SIZE, 584);
        // The last car's telemetry ends 4 bytes short of the end: the whole object is padded to a multiple of 8.
        let telemetry_end = TELEMETRY_INFO + MAX_VEHICLES * TELEM_INFO_SIZE;
        assert!(telemetry_end <= LAYOUT_SIZE && LAYOUT_SIZE - telemetry_end < 8 && LAYOUT_SIZE.is_multiple_of(8));
        // The scoring block is the car list followed by a 65536-byte results stream; telemetry starts right after it.
        assert_eq!(
            SCORING_VEHICLES + MAX_VEHICLES * VEHICLE_SCORING_SIZE + 65_536,
            TELEMETRY_ACTIVE_VEHICLES
        );
    }

    #[test]
    fn reads_the_players_telemetry_from_its_slot() {
        let mut memory = Memory::new();
        memory.set_events(&[SME_UPDATE_TELEMETRY]);
        memory.telemetry(2, 5, &car());
        let snapshot = Snapshot::from_memory(&memory.0);
        assert_eq!(snapshot.telemetry, Some(car()));
        assert_eq!(snapshot.scoring, None);
        assert!((snapshot.telemetry.unwrap().speed_ms() - 80.0).abs() < 1e-9);
    }

    #[test]
    fn ignores_telemetry_when_the_player_has_no_car_or_the_index_is_out_of_range() {
        let mut memory = Memory::new();
        memory.set_events(&[SME_UPDATE_TELEMETRY]);
        memory.telemetry(0, 1, &car());
        memory.0[TELEMETRY_PLAYER_HAS_VEHICLE] = 0;
        assert_eq!(Snapshot::from_memory(&memory.0).telemetry, None);
        memory.0[TELEMETRY_PLAYER_HAS_VEHICLE] = 1;
        memory.0[TELEMETRY_PLAYER_INDEX] = 7; // past the active cars
        assert_eq!(Snapshot::from_memory(&memory.0).telemetry, None);
        memory.0[TELEMETRY_ACTIVE_VEHICLES] = 200;
        memory.0[TELEMETRY_PLAYER_INDEX] = 150; // past the slots there are
        assert_eq!(Snapshot::from_memory(&memory.0).telemetry, None);
    }

    #[test]
    fn does_not_read_telemetry_that_was_not_updated_this_frame() {
        let mut memory = Memory::new();
        memory.set_events(&[SME_UPDATE_SCORING]);
        memory.telemetry(0, 1, &car());
        assert_eq!(Snapshot::from_memory(&memory.0).telemetry, None);
    }

    #[test]
    fn finds_the_players_own_car_in_the_scoring_list() {
        let session = SessionScoring {
            track_name: "Circuit de la Sarthe".into(),
            track_length_m: 13_626.0,
            session: 10,
            current_et: 900.0,
            num_vehicles: 3,
            game_phase: 5,
            in_realtime: true,
        };
        let mine = VehicleScoring {
            vehicle_name: "Toyota GR010 #8".into(),
            vehicle_class: "Hyper".into(),
            total_laps: 4,
            lap_dist: 1234.5,
            last_lap_time: 207.25,
            last_sector1: 60.0,
            last_sector2: 130.0,
            lap_start_et: 800.0,
            in_pits: false,
            num_penalties: 0,
        };
        let other = VehicleScoring {
            vehicle_name: "Ferrari 499P #51".into(),
            vehicle_class: "Hyper".into(),
            ..mine.clone()
        };
        let mut memory = Memory::new();
        memory.set_events(&[SME_UPDATE_SCORING]);
        memory.scoring(&session, &[other.clone(), mine.clone(), other], Some(1));
        let frame = Snapshot::from_memory(&memory.0).scoring.unwrap();
        assert_eq!(frame.session, session);
        assert_eq!(frame.player, Some(mine));
    }

    #[test]
    fn has_no_player_when_no_scoring_entry_is_the_players() {
        let mut memory = Memory::new();
        memory.set_events(&[SME_UPDATE_SCORING]);
        let session = SessionScoring {
            num_vehicles: 2,
            ..SessionScoring::default()
        };
        memory.scoring(&session, &[VehicleScoring::default(), VehicleScoring::default()], None);
        assert_eq!(Snapshot::from_memory(&memory.0).scoring.unwrap().player, None);
    }

    #[test]
    fn a_wild_vehicle_count_never_reads_past_the_list() {
        let mut memory = Memory::new();
        memory.set_events(&[SME_UPDATE_SCORING]);
        memory.put_i32(SCORING_INFO + SI_NUM_VEHICLES, i32::MAX);
        let frame = Snapshot::from_memory(&memory.0).scoring.unwrap();
        assert_eq!(frame.player, None);
        memory.put_i32(SCORING_INFO + SI_NUM_VEHICLES, -5);
        assert_eq!(Snapshot::from_memory(&memory.0).scoring.unwrap().player, None);
    }

    #[test]
    fn reads_text_up_to_the_first_zero_and_keeps_utf8() {
        let mut memory = Memory::new();
        memory.set_events(&[SME_UPDATE_TELEMETRY]);
        let mut t = car();
        t.vehicle_name = "Peugeot 9X8 \u{e9}".into();
        memory.telemetry(0, 1, &t);
        assert_eq!(
            Snapshot::from_memory(&memory.0).telemetry.unwrap().vehicle_name,
            "Peugeot 9X8 \u{e9}"
        );
    }

    #[test]
    fn carries_the_game_version() {
        let mut memory = Memory::new();
        memory.put_i32(GENERIC_GAME_VERSION, 12345);
        assert_eq!(Snapshot::from_memory(&memory.0).game_version, 12345);
    }
}
