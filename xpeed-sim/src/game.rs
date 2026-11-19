//! What every game gives Xpeed Companion, in one shape (Le Mans Ultimate too, through `lmu/source.rs`).
//!
//! Each game has its own door (shared memory, UDP) and its own units. A `Source` opens one of them and turns what it
//! reads into `Frame`s with the units of the lap file (metres, seconds, metres per second, 0..1 pedals), so the lap
//! cutter (`lapcut.rs`) and the engine do not need to know which game it is. A value the game does not give is `NaN`
//! (or `None` for the lap fields): the lap file keeps a column only when the game gives that value.
//!
//! # The convention of a `Frame`
//!
//! One meaning for every field, whatever the game. A reader turns its game's raw value into this, and `norm.rs` says how
//! far a raw value may be from its range before it is "not given". Where a game's raw value is known to differ from the
//! convention (a pedal that reads 1 when released), the reader turns it around; where nobody has checked yet, the
//! reader's mapping is in the second table and is marked ASSUMED.
//!
//! | `Frame` field | Unit and range | Meaning |
//! |---------------|----------------|---------|
//! | `clock_s` | seconds, never goes back | the game's session clock, or this program's own |
//! | `lap` | whole number, 1 is the first lap driven, 0 is "no lap known" | the number of the lap being driven; a game that counts laps completed from 0 gives completed + 1 |
//! | `lap_time_s` | seconds, 0 to 86 400 | time on the lap in progress |
//! | `last_lap_s` | seconds, above 0 | the official time of the last completed lap |
//! | `lap_valid` | bool | `Some(false)`: the game says this lap will not count |
//! | `dist_m` | metres, 0 or more | distance covered on this lap since the line |
//! | `in_pits` | bool | the car is in the pit area: the pit lane or the pit box |
//! | `speed_ms` | metres per second, 0 or more | the speed, never a signed velocity |
//! | `rpm` | revolutions per minute | engine speed |
//! | `gear` | -1, 0, 1.. | -1 reverse, 0 neutral, 1 first |
//! | `gears` | 1.. | how many forward gears |
//! | `throttle`, `brake` | 0 to 1 | 1 is the pedal fully pressed (the driver's input, before the game filters it where it says) |
//! | `clutch` | 0 to 1 | 1 is the pedal fully pressed (clutch disengaged), 0 released |
//! | `steer` | -1 to 1 | +1 is full lock to the RIGHT, -1 full lock to the left |
//! | `x`, `y`, `z` | metres | x east, y up, z north (the map seen from above with north up: a clockwise lap turns right) |
//! | `fuel_l`, `fuel_capacity_l` | litres | the fuel in the tank, and the size of the tank |
//! | `Tyre::temp_c` | Celsius | the tread where the game gives it (the mean across), else the core |
//! | `Tyre::pressure_kpa` | kilopascals (1 psi is 6.894757 kPa) | the tyre's pressure |
//! | `Tyre::left` | 0 to 1 | 1 is a new tyre, 0 is gone |
//! | `Tyre::tread_c` | Celsius, three values | the inner, middle and outer reading across the tread (inner is the side toward the car's centre); `temp_c` is their mean |
//! | `Tyre::brake_c` | Celsius | the brake disc beside that wheel; tyres are front left, front right, rear left, rear right |
//! | `CarState::pit_limiter` | bool | the pit lane limiter is on |
//! | `CarState::abs_active`, `tc_active` | bool | the aid is acting right now, not just switched on |
//! | `CarState::tc_level`, `abs_level` | 0 and up | the driver's setting as the dash shows it, 0 is off, more is more intervention |
//! | `CarState::engine_map` | 0 and up | the number the dash shows for the engine map |
//! | `CarState::brake_bias` | 0 to 1 | the FRONT share of the braking (0.56 is 56 % front); a game that gives the rear share is turned around |
//! | `CarState::damage_*` | 0 to 1 | 0 is none, 1 is destroyed; body is the bodywork and aero, engine, gearbox, and suspension is the worst of the four |
//! | `CarState::water_c`, `oil_c` | Celsius | coolant and oil |
//! | `g_lat` | g | positive toward the car's right (a right-hand corner is positive) |
//! | `g_long` | g | positive forward (accelerating is positive, braking negative) |
//! | `sectors_ms`, `air_temp_c`, `track_temp_c` | milliseconds, Celsius | the first two sector times of the lap; the air and track temperature |
//!
//! ## How each reader maps its game's raw value
//!
//! `VERIFIED-LIVE` means it was checked against a running game (the capture and replay harness: `fixtures/README.md`);
//! everything else is `ASSUMED`: taken from the game's documentation or from another reader, never seen live. Where
//! two readers contradict each other, both are written down as they are; the fixtures settle which is right.
//!
//! | Reader | `steer` (+1 = right) | `clutch` (1 = pressed) | `x`, `y`, `z` | `lap` |
//! |--------|----------------------|------------------------|---------------|-------|
//! | Assetto Corsa, Competizione, Rally (`kunos.rs`) | `steerAngle` as given, positive right: ASSUMED | not read | Assetto Corsa and Competizione: `carCoordinates` as given; Assetto Corsa's ground is x = east, z = south like its `map.png` (checked on the installed game's `fast_lane.ai`, see `perspective::mirrored_ground`), so the live view mirrors it; Competizione's handedness not checked; Rally none: ASSUMED | `completedLaps` + 1: ASSUMED |
//! | Assetto Corsa EVO (`acevo.rs`) | `steerAngle` as given, positive right: VERIFIED-LIVE | `1 - clutch` (the game writes 1 = engaged): VERIFIED-LIVE | mean of the four `tyreContactPoint`s, x negated (the game's ground is mirrored), y and z as given: VERIFIED-LIVE | `total_lap_count` + 1: ASSUMED |
//! | Automobilista 2, Project CARS 2 and 3 (`ams2.rs`) | `mUnfilteredSteering` as given, positive right: ASSUMED | `mUnfilteredClutch` as given: ASSUMED | `mWorldPosition` as given, so z is north: ASSUMED | `mLapsCompleted` + 1: ASSUMED |
//! | RaceRoom (`r3e.rs`) | `steer_input_raw` as given, positive right: ASSUMED | `clutch_raw` as given: ASSUMED | `car_cg_location` as given, y up: ASSUMED | `completed_laps` + 1: ASSUMED |
//! | rFactor 1 engine games (`rfactor1.rs`) | `unfilteredSteering` as given ("left to right"): ASSUMED | `unfilteredClutch` as given: ASSUMED | `pos` as given (the game's left-handed axes, y up): ASSUMED | `lapNumber` as the game counts it; whether its first lap is 0 or 1 is not known: ASSUMED (the lap cutter only needs it to go up by one) |
//! | iRacing (`iracing.rs`) | `-SteeringWheelAngle / SteeringWheelAngleMax` (the SDK turns positive to the left): ASSUMED | `1 - Clutch` (the sim writes 1 = pedal up): ASSUMED | worked out from the velocity: x = east, z = MINUS north (the opposite of EVO and Automobilista 2): ASSUMED | `Lap` as the sim counts it; whether its first lap is 0 or 1 is not known: ASSUMED |
//! | EA SPORTS F1 (`f1.rs`) | `steer` as given (documented -1 left, +1 right): ASSUMED | `clutch` / 100 (0 released): ASSUMED | motion packet `worldPosition` as given: ASSUMED | `currentLapNum`, documented as starting at 1: ASSUMED |
//! | Forza Motorsport and Horizon (`forza.rs`) | `Steer` / 127 (documented -127 left, +127 right): ASSUMED | `Clutch` / 255: ASSUMED | `Position` as given, y up: ASSUMED | `LapNumber` + 1 (documented from 0): ASSUMED |
//! | Wreckfest 2 (`wreckfest2.rs`) | `steering` as given: ASSUMED | `clutch` as given: ASSUMED | `position` as given: ASSUMED | `lapCurrent` as given (0 is the grid, 1 the first lap): ASSUMED |
//! | Le Mans Ultimate (`lmu/`) | `mUnfilteredSteering` as given: ASSUMED | `mUnfilteredClutch` as given: ASSUMED | `mPos` as given (the game's left-handed axes): ASSUMED | `mLapNumber` as the game counts it; whether its first lap is 0 or 1 is not known: ASSUMED |
//!
//! | Reader | `brake_bias` (front share) | `tc_level`, `abs_level` | `damage_*` | `in_pits` | `Tyre::pressure_kpa` |
//! |--------|----------------------------|-------------------------|------------|-----------|----------------------|
//! | Assetto Corsa, Competizione | `brakeBias` as given, taken as the front share: ASSUMED | Competizione: the graphics page's TC and ABS (0 is off): ASSUMED; Assetto Corsa none | none | `isInPit` (and Competizione's `isInPitLane`): ASSUMED | psi to kPa: ASSUMED |
//! | Assetto Corsa EVO | `brake_bias` of the electronics as given, taken as the front share: ASSUMED | the electronics levels where the car has the aid (its maximum is above 0): ASSUMED | none | pit lane or pit box: ASSUMED | psi to kPa: ASSUMED |
//! | Automobilista 2 | `mBrakeBias` is the REAR share, so 1 minus it: VERIFIED-LIVE | `mTractionControlSetting`, `mAntiLockSetting`: ASSUMED | `mAeroDamage`, `mEngineDamage`, the worst `mSuspensionDamage`, as given: ASSUMED | any pit mode but none: ASSUMED | `mAirPressure` in kPa as written: VERIFIED-LIVE |
//! | RaceRoom | `brake_bias` is the REAR share, so 1 minus it: ASSUMED | `traction_control_setting`, `abs_setting`: ASSUMED | 1 minus `car_damage` (0.0 is the bad end): ASSUMED | `in_pitlane`: ASSUMED | `tire_pressure` as given, kPa: ASSUMED |
//! | rFactor 1 engine games | none | none | bodywork from the eight dents (sum over the worst case): ASSUMED | scoring `inPits`: ASSUMED | none |
//! | iRacing | none | none | none | `OnPitRoad`: ASSUMED | none |
//! | EA SPORTS F1 | `frontBrakeBias` in percent: ASSUMED | traction control 0 off, 1 medium, 2 full; ABS 0 off, 1 on: ASSUMED | percent of the wings (worst), gearbox, engine: ASSUMED | `pitStatus` other than 0: ASSUMED | none |
//! | Forza | none | none | none | none | none |
//! | Wreckfest 2 | none | assist levels 0 off, 1 half, 2 full: ASSUMED | the worst damage state of the group over the terminal state: ASSUMED | none | none |
//! | Le Mans Ultimate | `mRearBrakeBias` is the REAR share, so 1 minus it: ASSUMED | `mTC`, `mABS` where the car has the aid: ASSUMED | bodywork from the eight dents: ASSUMED | scoring `mInPits`: ASSUMED | `mPressure` in kPa: ASSUMED |
//!
//! The places where the readers contradict each other, and what would settle each, are the "what to verify per game"
//! list of `fixtures/README.md`: no reader was changed to guess which one is right.

use std::time::Duration;

pub use crate::lapfile::SessionKind;

/// One tyre as the game tells it; `NaN` for what it does not give.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tyre {
    /// The brake's temperature in °C, when the game gives it.
    pub brake_c: f32,
    /// Temperature in °C: the tread where the game gives it, else the core.
    pub temp_c: f32,
    pub pressure_kpa: f32,
    /// How much of the tread is left, 0..1 (1 = new).
    pub left: f32,
    /// The temperature across the tread, inner, middle and outer, in °C, when the game gives the three (all three or
    /// none). `temp_c` is their mean then.
    pub tread_c: Option<[f32; 3]>,
}

impl Tyre {
    /// True when the game said anything about this tyre.
    pub fn known(&self) -> bool {
        self.temp_c.is_finite() || self.pressure_kpa.is_finite() || self.left.is_finite() || self.brake_c.is_finite()
    }
}

/// What the player is doing in the game right now, as far as the game says. `Frame::driving` is exactly
/// `phase == Phase::Driving`; the two are only ever set together, by `Frame::set_phase`.
///
/// A reader reports the phases its game exposes and nothing finer: a game that cannot tell a pause from a menu gives
/// `Menu` or `Unknown` for both, and says so in its module doc. `Unknown` is the honest answer when the game shows
/// something this reader cannot place (a status number it does not know, a page that is not written yet).
///
/// While the phase is not `Driving`, the live car values (gear, pedals, steering, speed, rpm) are `NaN` in the readers
/// whose game leaves them stale or zeroed there; see `Frame::withhold_car_values_unless_driving`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Phase {
    /// The player's own car is on the track and under the player's hands, in a session where a lap counts. The only
    /// phase whose frames the lap cutter uses. Pit lane and pit stops are still `Driving` (see `Frame::in_pits`).
    Driving,
    /// The game is frozen by the player (a pause screen or an escape menu in a running session). The car is still
    /// on the track, so the identity, fuel, tyres and lap times are meaningful; the live car values are not.
    Paused,
    /// A front-end screen outside any session: main menu, lobby, car or track selection, results.
    Menu,
    /// The player is in the garage or the pit box before going out (setup screens and the garage view included),
    /// not yet moving under their own control.
    Garage,
    /// The game is playing a recording back. Nothing on the frame is the player's live driving.
    Replay,
    /// Not the player's own driving: another car is being watched, or an AI or a remote driver has the player's car.
    Spectating,
    /// The game is loading a session or counting down to a start in which the player cannot drive yet.
    Loading,
    /// The game exposes no phase this reader can use, or what it shows is not one this reader knows.
    #[default]
    Unknown,
}

/// A flag the race shows the player.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flag {
    Green,
    Yellow,
    Blue,
    White,
    Black,
    Chequered,
}

/// The rear wing's state where the car has DRS (or a push to pass the game reports the same way).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Drs {
    /// Not allowed here.
    Off,
    /// Allowed: the driver may open it.
    Available,
    Open,
}

/// The dashboard lights and the car's own state, as the game tells them. `None` (or `NaN`) is what the game does
/// not give, which the panel leaves out rather than showing as off or zero (`Option`, not `NaN`, so frames still
/// compare equal in tests).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CarState {
    /// The pit lane speed limiter is on.
    pub pit_limiter: Option<bool>,
    /// ABS is acting right now (not just switched on).
    pub abs_active: Option<bool>,
    /// Traction control is acting right now.
    pub tc_active: Option<bool>,
    pub drs: Option<Drs>,
    pub headlights: Option<bool>,
    pub handbrake: Option<bool>,
    /// The game warns about the engine (overheating, stalled, damaged).
    pub engine_warning: Option<bool>,
    pub flag: Option<Flag>,
    /// Coolant (water) temperature in °C.
    pub water_c: Option<f32>,
    /// Oil temperature in °C.
    pub oil_c: Option<f32>,
    /// The driver's settings as the car's dash shows them: TC and ABS levels (0 = off) and the engine map.
    pub tc_level: Option<u8>,
    pub abs_level: Option<u8>,
    pub engine_map: Option<u8>,
    /// Share of braking on the front axle, 0..1 (0.56 = 56 % front).
    pub brake_bias: Option<f32>,
    /// Damage, 0 = none .. 1 = destroyed: bodywork and aero, engine, gearbox, and the worst of the four suspensions.
    pub damage_body: Option<f32>,
    pub damage_engine: Option<f32>,
    pub damage_gearbox: Option<f32>,
    pub damage_suspension: Option<f32>,
}

impl CarState {
    /// Nothing known.
    pub const UNKNOWN: CarState = CarState {
        pit_limiter: None,
        abs_active: None,
        tc_active: None,
        drs: None,
        headlights: None,
        handbrake: None,
        engine_warning: None,
        flag: None,
        water_c: None,
        oil_c: None,
        tc_level: None,
        abs_level: None,
        engine_map: None,
        brake_bias: None,
        damage_body: None,
        damage_engine: None,
        damage_gearbox: None,
        damage_suspension: None,
    };
}

/// One reading of the player's car.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    /// Seconds on a clock that never goes backwards while the game runs (the game's, or the program's own).
    pub clock_s: f64,
    /// False in a menu, a replay or a garage: the frame is not part of any lap. Always `phase == Phase::Driving`; set
    /// it only with `set_phase`.
    pub driving: bool,
    /// What the player is doing, as far as the game says (`Unknown` until a reader knows).
    pub phase: Phase,
    /// The number of the lap being driven: 1 for the first lap driven (a game that counts laps completed from 0 gives
    /// completed + 1), 0 when the game says no lap. The number changes when a lap is completed.
    pub lap: i32,
    /// Time on the current lap, in seconds, on the game's own clock. `None` when the game does not give it.
    pub lap_time_s: Option<f64>,
    /// The official time of the last completed lap, in seconds. `None` while there is none yet.
    pub last_lap_s: Option<f64>,
    /// The game's own verdict on the current lap (`Some(false)`: it will not count). `None` when it gives none.
    pub lap_valid: Option<bool>,
    /// Distance covered on the current lap, in metres, when the game gives it (or a fraction of a known length).
    pub dist_m: Option<f64>,
    pub in_pits: bool,
    pub speed_ms: f32,
    pub rpm: f32,
    pub gear: f32,
    /// How many forward gears the car has, when the game says. `None` when it does not.
    pub gears: Option<u8>,
    pub throttle: f32,
    pub brake: f32,
    pub clutch: f32,
    pub steer: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub fuel_l: f32,
    /// The size of the fuel tank in litres, when the game says (`None` when it does not: the dash then takes the
    /// biggest fuel reading seen as the tank).
    pub fuel_capacity_l: Option<f32>,
    /// Front left, front right, rear left, rear right; `None` when the game gives nothing about tyres.
    pub tyres: Option<[Tyre; 4]>,
    /// Dashboard lights, engine temperatures, electronics settings and damage.
    pub state: CarState,
    pub car: String,
    pub car_class: Option<String>,
    pub track: String,
    pub track_variant: Option<String>,
    pub track_length_m: Option<f64>,
    /// How long the first two sectors of the lap in progress took, in milliseconds, each once it is done (`None`
    /// before that, or for a game that gives no sector times). The last sector is not here: the cutter takes it as
    /// the official lap time minus these two, because a game that shows its third sector's time while it runs may
    /// still hold the one of the lap before. A game with other than three sectors gives `None` for both.
    pub sectors_ms: [Option<u32>; 2],
    /// What kind of session this is, when the game says.
    pub session_kind: Option<SessionKind>,
    /// A short word for the weather ("dry", "rain"), when the game gives it.
    pub weather: Option<String>,
    /// Air and track temperature in °C, when the game gives them.
    pub air_temp_c: Option<f32>,
    pub track_temp_c: Option<f32>,
    /// The compound of the tyres on the car, as the game names it.
    pub tyre_compound: Option<String>,
    /// The car's acceleration in g: sideways (positive toward the car's right: a right-hand corner is positive) and
    /// along the car (positive forward: accelerating is positive, braking negative). `None` when the game gives none
    /// (an `Option`, not `NaN`, so frames still compare equal in tests).
    pub g_lat: Option<f32>,
    pub g_long: Option<f32>,
}

impl Frame {
    /// Sets what the player is doing, and `driving` with it: the one way to change either, so the two cannot disagree.
    pub fn set_phase(&mut self, phase: Phase) {
        self.phase = phase;
        self.driving = phase == Phase::Driving;
    }

    /// True when `driving` and `phase` agree (the invariant `set_phase` keeps). Readers `debug_assert!` it on every
    /// frame they build, so each reader test checks it on every frame the test produces.
    pub fn phase_consistent(&self) -> bool {
        self.driving == (self.phase == Phase::Driving)
    }

    /// The rule for every phase but `Driving`: the live car values (gear, pedals, steering, speed, rpm) are `NaN`,
    /// because a game leaves them stale or zeroed there (a zeroed gear is reverse, a zeroed clutch a full pedal).
    /// Identity (car, track), fuel, tyres, temperatures, the state lights and the lap timing are kept as they are:
    /// they mean something in the pits, the garage and a pause. Readers call this where their game was found to leave
    /// such values behind; it does nothing while the phase is `Driving`.
    pub fn withhold_car_values_unless_driving(&mut self) {
        if self.phase != Phase::Driving {
            self.speed_ms = f32::NAN;
            self.rpm = f32::NAN;
            self.gear = f32::NAN;
            self.throttle = f32::NAN;
            self.brake = f32::NAN;
            self.clutch = f32::NAN;
            self.steer = f32::NAN;
        }
    }

    /// What this frame actually fills: the groups of values that are present (finite, `Some` or true).
    #[allow(dead_code)] // held by the reader tests; the panel will use it in step 1b
    pub fn filled(&self) -> Caps {
        let mut c = Caps::NONE;
        let mut add = |on: bool, cap: Caps| {
            if on {
                c = c.or(cap);
            }
        };
        add(self.lap_time_s.is_some(), Caps::LAP_TIME);
        add(self.last_lap_s.is_some(), Caps::LAST_LAP);
        add(self.lap_valid.is_some(), Caps::LAP_VALID);
        add(self.dist_m.is_some(), Caps::DIST);
        add(self.in_pits, Caps::IN_PITS);
        add(self.speed_ms.is_finite(), Caps::SPEED);
        add(self.rpm.is_finite(), Caps::RPM);
        add(self.gear.is_finite(), Caps::GEAR);
        add(self.gears.is_some(), Caps::GEARS);
        add(self.throttle.is_finite(), Caps::THROTTLE);
        add(self.brake.is_finite(), Caps::BRAKE);
        add(self.clutch.is_finite(), Caps::CLUTCH);
        add(self.steer.is_finite(), Caps::STEER);
        add(self.x.is_finite() || self.y.is_finite() || self.z.is_finite(), Caps::POSITION);
        add(self.fuel_l.is_finite(), Caps::FUEL);
        add(self.fuel_capacity_l.is_some(), Caps::FUEL_CAPACITY);
        if let Some(tyres) = &self.tyres {
            add(tyres.iter().any(|t| t.temp_c.is_finite()), Caps::TYRE_TEMP);
            add(tyres.iter().any(|t| t.pressure_kpa.is_finite()), Caps::TYRE_PRESSURE);
            add(tyres.iter().any(|t| t.left.is_finite()), Caps::TYRE_WEAR);
            add(tyres.iter().any(|t| t.brake_c.is_finite()), Caps::BRAKE_TEMP);
            add(tyres.iter().any(|t| t.tread_c.is_some()), Caps::TYRE_TREAD);
        }
        add(self.car_class.is_some(), Caps::CAR_CLASS);
        add(self.track_variant.is_some(), Caps::TRACK_VARIANT);
        add(self.track_length_m.is_some(), Caps::TRACK_LENGTH);
        add(self.sectors_ms.iter().any(Option::is_some), Caps::SECTORS);
        add(self.session_kind.is_some(), Caps::SESSION_KIND);
        add(self.weather.is_some(), Caps::WEATHER);
        add(self.air_temp_c.is_some(), Caps::AIR_TEMP);
        add(self.track_temp_c.is_some(), Caps::TRACK_TEMP);
        add(self.tyre_compound.is_some(), Caps::TYRE_COMPOUND);
        add(self.g_lat.is_some(), Caps::G_LAT);
        add(self.g_long.is_some(), Caps::G_LONG);
        let s = &self.state;
        add(s.pit_limiter.is_some(), Caps::PIT_LIMITER);
        add(s.abs_active.is_some(), Caps::ABS_ACTIVE);
        add(s.tc_active.is_some(), Caps::TC_ACTIVE);
        add(s.drs.is_some(), Caps::DRS);
        add(s.headlights.is_some(), Caps::HEADLIGHTS);
        add(s.handbrake.is_some(), Caps::HANDBRAKE);
        add(s.engine_warning.is_some(), Caps::ENGINE_WARNING);
        add(s.flag.is_some(), Caps::FLAG);
        add(s.water_c.is_some(), Caps::WATER_TEMP);
        add(s.oil_c.is_some(), Caps::OIL_TEMP);
        add(s.tc_level.is_some(), Caps::TC_LEVEL);
        add(s.abs_level.is_some(), Caps::ABS_LEVEL);
        add(s.engine_map.is_some(), Caps::ENGINE_MAP);
        add(s.brake_bias.is_some(), Caps::BRAKE_BIAS);
        add(s.damage_body.is_some(), Caps::DAMAGE_BODY);
        add(s.damage_engine.is_some(), Caps::DAMAGE_ENGINE);
        add(s.damage_gearbox.is_some(), Caps::DAMAGE_GEARBOX);
        add(s.damage_suspension.is_some(), Caps::DAMAGE_SUSPENSION);
        c
    }

    /// A frame that says nothing yet: every optional value missing. Sources fill in what their game has.
    pub fn empty() -> Frame {
        Frame {
            clock_s: 0.0,
            driving: false,
            phase: Phase::Unknown,
            lap: 0,
            lap_time_s: None,
            last_lap_s: None,
            lap_valid: None,
            dist_m: None,
            in_pits: false,
            speed_ms: f32::NAN,
            rpm: f32::NAN,
            gear: f32::NAN,
            gears: None,
            throttle: f32::NAN,
            brake: f32::NAN,
            clutch: f32::NAN,
            steer: f32::NAN,
            x: f32::NAN,
            y: f32::NAN,
            z: f32::NAN,
            fuel_l: f32::NAN,
            fuel_capacity_l: None,
            tyres: None,
            state: CarState::UNKNOWN,
            car: String::new(),
            car_class: None,
            track: String::new(),
            track_variant: None,
            track_length_m: None,
            sectors_ms: [None; 2],
            session_kind: None,
            weather: None,
            air_temp_c: None,
            track_temp_c: None,
            tyre_compound: None,
            g_lat: None,
            g_long: None,
        }
    }
}

/// The sector times of the lap in progress, for a game that tells only the sector the car is in and the time of the
/// last sector it finished (Assetto Corsa): the time at each change of sector is kept for the first two sectors, and
/// forgotten when the lap number changes.
#[derive(Debug, Default)]
pub struct SectorTracker {
    lap: i32,
    sector: Option<i32>,
    done: [Option<u32>; 2],
}

impl SectorTracker {
    /// One reading: the lap, the sector the car is in now (0 is the first) and the game's "last sector time" in
    /// milliseconds. Returns the sectors done on this lap so far. A change of sector counts only when it goes up by
    /// one (so a reading that jumps, a restart or a car put back on the track records nothing), and only a positive
    /// time is believed.
    pub fn update(&mut self, lap: i32, sector: i32, last_sector_ms: i32) -> [Option<u32>; 2] {
        if lap != self.lap {
            self.lap = lap;
            self.sector = None;
            self.done = [None; 2];
        }
        if let Some(before) = self.sector {
            if sector == before + 1 && (0..2).contains(&before) && (1..=3_600_000).contains(&last_sector_ms) {
                self.done[before as usize] = Some(last_sector_ms as u32);
            }
        }
        self.sector = Some(sector);
        self.done
    }
}

macro_rules! caps_table {
    ($($(#[$doc:meta])* $name:ident),+ $(,)?) => {
        /// Which optional values a game can give: one bit per group of `Frame`, `Tyre` and `CarState` fields. A value
        /// that is missing now (the game has not said yet) and one the game never gives look the same on a `Frame`
        /// (`NaN` or `None`); `Source::caps` tells them apart. The rule: a field outside a reader's caps is always
        /// `NaN`/`None`/false on its frames; a field inside them may still be missing at any moment.
        #[derive(Clone, Copy, Default, PartialEq, Eq)]
        pub struct Caps(u64);

        #[allow(non_camel_case_types, dead_code, clippy::upper_case_acronyms)]
        #[repr(u8)]
        enum Bit { $($name),+ }

        impl Caps {
            $(
                $(#[$doc])*
                pub const $name: Caps = Caps(1u64 << (Bit::$name as u8));
            )+

            /// Every group, with the name it is shown by.
            pub const ALL: &'static [(Caps, &'static str)] = &[$((Caps::$name, stringify!($name))),+];
        }
    };
}

caps_table! {
    // Frame: lap timing.
    /// Time on the current lap.
    LAP_TIME,
    /// The official time of the last lap.
    LAST_LAP,
    /// The game's verdict on whether the current lap counts.
    LAP_VALID,
    /// Distance covered on the lap, in metres (else the cutter integrates the speed).
    DIST,
    /// Whether the car is in the pit lane (the field is a plain bool: "filled" means true).
    IN_PITS,
    // Frame: the car.
    SPEED,
    RPM,
    GEAR,
    /// How many forward gears the car has.
    GEARS,
    THROTTLE,
    BRAKE,
    CLUTCH,
    STEER,
    /// The world position (x, y, z).
    POSITION,
    FUEL,
    FUEL_CAPACITY,
    // Tyre.
    TYRE_TEMP,
    TYRE_PRESSURE,
    TYRE_WEAR,
    BRAKE_TEMP,
    /// The temperature across each tyre's tread (inner, middle, outer).
    TYRE_TREAD,
    // Frame: the circuit and the session.
    CAR_CLASS,
    TRACK_VARIANT,
    TRACK_LENGTH,
    /// The first two sector times.
    SECTORS,
    SESSION_KIND,
    WEATHER,
    AIR_TEMP,
    TRACK_TEMP,
    TYRE_COMPOUND,
    G_LAT,
    G_LONG,
    // CarState.
    PIT_LIMITER,
    ABS_ACTIVE,
    TC_ACTIVE,
    DRS,
    HEADLIGHTS,
    HANDBRAKE,
    ENGINE_WARNING,
    FLAG,
    WATER_TEMP,
    OIL_TEMP,
    TC_LEVEL,
    ABS_LEVEL,
    ENGINE_MAP,
    BRAKE_BIAS,
    DAMAGE_BODY,
    DAMAGE_ENGINE,
    DAMAGE_GEARBOX,
    DAMAGE_SUSPENSION,
}

#[allow(dead_code)] // the set operations are used by the tests now and by the panel in step 1b
impl Caps {
    /// Nothing.
    pub const NONE: Caps = Caps(0);

    /// Both sets together (usable in a `const`).
    pub const fn or(self, other: Caps) -> Caps {
        Caps(self.0 | other.0)
    }

    /// Every group of `self` that is not in `other`, as a set.
    pub const fn minus(self, other: Caps) -> Caps {
        Caps(self.0 & !other.0)
    }

    /// True when every group of `other` is in `self`.
    pub const fn has(self, other: Caps) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// The names of the groups in the set, in declaration order.
    pub fn names(self) -> Vec<&'static str> {
        Caps::ALL.iter().filter(|(c, _)| self.has(*c)).map(|(_, n)| *n).collect()
    }
}

impl std::fmt::Debug for Caps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Caps{:?}", self.names())
    }
}

/// Checks a frame against what its reader says it can give: the phase invariant holds, and nothing outside `caps` is
/// filled. Reader tests call it on the frames their fixtures build.
#[cfg(test)]
pub fn assert_frame_within_caps(frame: &Frame, caps: Caps, who: &str) {
    assert!(frame.phase_consistent(), "{who}: driving and phase disagree: {:?}", frame.phase);
    let outside = frame.filled().minus(caps);
    assert!(outside.is_empty(), "{who}: the frame fills {outside:?}, which its caps do not give");
}

/// An open door into one game.
pub trait Source {
    /// The id written into lap files (`"ac"`, `"acc"`, ...): lower case, no spaces.
    fn game_id(&self) -> &'static str;
    /// The name people know, for the tray menu and the log.
    fn game_name(&self) -> &'static str;
    /// Waits up to `timeout` for a new reading. `None`: nothing new yet (the game is paused, or in a menu).
    fn next(&mut self, timeout: Duration) -> Option<Frame>;
    /// False once the game has gone away (its door closed); the engine then goes back to looking.
    fn alive(&self) -> bool;
    /// True for a source that is only a socket waiting for packets: its game may send nothing at all (the person has
    /// not switched its telemetry output on), so opening it proves nothing and the game counts as connected only once
    /// the first frame arrives. False (the default) for shared memory, where finding the memory means the game shares.
    fn listens(&self) -> bool {
        false
    }
    /// What this game can give on a frame (see `Caps`). It describes the game and the format, not the moment: a
    /// value inside it may be missing now, a value outside it is never filled.
    // The engine hands it to the panel's tracker (`Tracker::set_caps`), which decides what the dashboard can show.
    fn caps(&self) -> Caps;
    /// A last touch on a finished lap before it is written (iRacing closes its estimated path). Nothing by default.
    fn finish_lap(&self, _lap: &mut crate::lapfile::Lap) {}
}

/// A text field of a game's memory: UTF-16 or ASCII up to the first zero, trimmed.
pub fn text_of_utf16(units: &[u16]) -> String {
    let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end]).trim().to_owned()
}

pub fn text_of_ascii(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The names written in backticks in the convention table at the top of this file.
    fn convention_names() -> Vec<String> {
        // Line endings normalised: a Windows checkout has CRLF in the file, while string literals always hold LF.
        let source = include_str!("game.rs").replace("\r\n", "\n");
        let source = source.as_str();
        let start = source.find("| `Frame` field |").expect("the convention table");
        let end = source[start..].find("## How each reader maps").expect("the per-reader tables");
        source[start..start + end]
            .split('`')
            .skip(1)
            .step_by(2)
            .flat_map(|names| names.split(',').map(|n| n.trim().rsplit("::").next().unwrap_or("").to_owned()))
            .collect()
    }

    /// The names of the fields of `struct_name`, from this file's own text.
    fn fields_of(struct_name: &str) -> Vec<String> {
        let source = include_str!("game.rs").replace("\r\n", "\n");
        let source = source.as_str();
        let start = source.find(&format!("pub struct {struct_name} {{")).expect("the struct");
        let body = &source[start..start + source[start..].find("\n}\n").unwrap()];
        body.lines()
            .skip(1)
            .filter_map(|l| l.trim().strip_prefix("pub "))
            .filter_map(|l| l.split(':').next())
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn the_convention_table_has_a_row_for_every_value_a_reader_fills() {
        let names = convention_names();
        let covered = |field: &str| {
            names
                .iter()
                .any(|n| n == field || n.strip_suffix('*').is_some_and(|p| field.starts_with(p)))
        };
        // Who the car, track and session are, and what the game is doing, have no unit to agree on.
        let identity = [
            "driving",
            "phase",
            "car",
            "car_class",
            "track",
            "track_variant",
            "track_length_m",
            "session_kind",
            "weather",
            "tyre_compound",
            "state",
            "tyres",
            "lap_valid",
            "flag",
            "drs",
            "headlights",
            "handbrake",
            "engine_warning",
        ];
        for (struct_name, skip) in [("Frame", &identity[..]), ("Tyre", &[][..]), ("CarState", &identity[..])] {
            for field in fields_of(struct_name) {
                assert!(
                    skip.contains(&field.as_str()) || covered(&field),
                    "{struct_name}::{field} has no row in the convention table of game.rs"
                );
            }
        }
        assert!(covered("steer") && covered("damage_body") && !covered("no_such_field"));
    }

    #[test]
    fn a_frame_with_nothing_in_it_says_nothing() {
        let frame = Frame::empty();
        assert!(!frame.driving && frame.lap_time_s.is_none() && frame.dist_m.is_none());
        assert!(frame.speed_ms.is_nan() && frame.x.is_nan());
    }

    #[test]
    fn a_frame_gives_no_sectors_session_or_weather_until_a_game_says() {
        let frame = Frame::empty();
        assert_eq!(frame.sectors_ms, [None; 2]);
        assert!(frame.session_kind.is_none() && frame.weather.is_none() && frame.tyre_compound.is_none());
        assert!(frame.air_temp_c.is_none() && frame.track_temp_c.is_none());
        assert!(frame.g_lat.is_none() && frame.g_long.is_none());
    }

    #[test]
    fn the_phase_and_driving_only_change_together() {
        let mut frame = Frame::empty();
        assert_eq!((frame.phase, frame.driving), (Phase::Unknown, false));
        for phase in [
            Phase::Driving,
            Phase::Paused,
            Phase::Menu,
            Phase::Garage,
            Phase::Replay,
            Phase::Spectating,
            Phase::Loading,
            Phase::Unknown,
        ] {
            frame.set_phase(phase);
            assert_eq!(frame.driving, phase == Phase::Driving, "{phase:?}");
            assert!(frame.phase_consistent());
        }
        frame.driving = true;
        assert!(!frame.phase_consistent(), "the check catches a hand-set flag");
    }

    #[test]
    fn car_values_are_withheld_unless_driving_and_the_rest_is_kept() {
        let mut frame = Frame::empty();
        frame.speed_ms = 30.0;
        frame.rpm = 6000.0;
        frame.gear = -1.0;
        (frame.throttle, frame.brake, frame.clutch, frame.steer) = (0.5, 0.2, 1.0, -0.3);
        (frame.x, frame.y, frame.z) = (1.0, 2.0, 3.0);
        frame.fuel_l = 40.0;
        frame.lap_time_s = Some(12.5);
        frame.car = "Car".into();
        frame.set_phase(Phase::Driving);
        let driving = frame.clone();
        frame.withhold_car_values_unless_driving();
        assert_eq!(frame, driving, "nothing changes while driving");
        for phase in [
            Phase::Paused,
            Phase::Menu,
            Phase::Garage,
            Phase::Replay,
            Phase::Spectating,
            Phase::Loading,
            Phase::Unknown,
        ] {
            let mut f = driving.clone();
            f.set_phase(phase);
            f.withhold_car_values_unless_driving();
            for v in [f.speed_ms, f.rpm, f.gear, f.throttle, f.brake, f.clutch, f.steer] {
                assert!(v.is_nan(), "{phase:?}");
            }
            assert_eq!((f.fuel_l, f.lap_time_s, f.car.as_str()), (40.0, Some(12.5), "Car"), "{phase:?}");
        }
    }

    #[test]
    fn an_empty_frame_fills_nothing_and_a_full_one_fills_every_group_once() {
        assert!(Frame::empty().filled().is_empty());
        let all = Caps::ALL.iter().fold(Caps::NONE, |all, (c, _)| all.or(*c));
        assert_eq!(Caps::ALL.len() as u32, all.names().len() as u32, "every group has its own bit");
        let mut f = Frame::empty();
        f.lap_time_s = Some(1.0);
        f.last_lap_s = Some(1.0);
        f.lap_valid = Some(true);
        f.dist_m = Some(1.0);
        f.in_pits = true;
        (f.speed_ms, f.rpm, f.gear, f.throttle, f.brake, f.clutch, f.steer) = (1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
        f.gears = Some(6);
        f.x = 1.0;
        f.fuel_l = 1.0;
        f.fuel_capacity_l = Some(1.0);
        f.tyres = Some(
            [Tyre {
                brake_c: 1.0,
                temp_c: 1.0,
                pressure_kpa: 1.0,
                left: 1.0,
                tread_c: Some([1.0; 3]),
            }; 4],
        );
        f.car_class = Some("x".into());
        f.track_variant = Some("x".into());
        f.track_length_m = Some(1.0);
        f.sectors_ms = [Some(1), None];
        f.session_kind = Some(SessionKind::Race);
        f.weather = Some("dry".into());
        (f.air_temp_c, f.track_temp_c) = (Some(1.0), Some(1.0));
        f.tyre_compound = Some("x".into());
        (f.g_lat, f.g_long) = (Some(1.0), Some(1.0));
        f.state = CarState {
            pit_limiter: Some(true),
            abs_active: Some(true),
            tc_active: Some(true),
            drs: Some(Drs::Off),
            headlights: Some(true),
            handbrake: Some(true),
            engine_warning: Some(true),
            flag: Some(Flag::Green),
            water_c: Some(1.0),
            oil_c: Some(1.0),
            tc_level: Some(1),
            abs_level: Some(1),
            engine_map: Some(1),
            brake_bias: Some(0.5),
            damage_body: Some(0.0),
            damage_engine: Some(0.0),
            damage_gearbox: Some(0.0),
            damage_suspension: Some(0.0),
        };
        assert_eq!(f.filled(), all, "missing from the frame: {:?}", all.minus(f.filled()));
    }

    #[test]
    fn caps_combine_and_name_their_groups() {
        let caps = Caps::SPEED.or(Caps::GEAR);
        assert!(caps.has(Caps::SPEED) && caps.has(Caps::GEAR) && !caps.has(Caps::RPM));
        assert_eq!(caps.names(), ["SPEED", "GEAR"]);
        assert_eq!(caps.minus(Caps::SPEED), Caps::GEAR);
        assert!(Caps::default().is_empty());
    }

    #[test]
    #[should_panic(expected = "which its caps do not give")]
    fn a_frame_that_fills_what_its_caps_do_not_give_is_caught() {
        let mut f = Frame::empty();
        f.rpm = 1.0;
        assert_frame_within_caps(&f, Caps::SPEED, "test");
    }

    #[test]
    fn keeps_the_time_of_each_sector_when_the_car_goes_into_the_next() {
        let mut sectors = SectorTracker::default();
        assert_eq!(sectors.update(1, 0, 0), [None, None]);
        assert_eq!(sectors.update(1, 0, 0), [None, None]);
        // Into sector 2: the last sector (the first) took 31.2 s.
        assert_eq!(sectors.update(1, 1, 31_200), [Some(31_200), None]);
        assert_eq!(sectors.update(1, 1, 31_200), [Some(31_200), None]);
        assert_eq!(sectors.update(1, 2, 28_900), [Some(31_200), Some(28_900)]);
        // Into the next lap: forgotten, and the wrap from sector 3 to sector 1 records nothing.
        assert_eq!(sectors.update(2, 0, 30_000), [None, None]);
        assert_eq!(sectors.update(2, 1, 30_500), [Some(30_500), None]);
    }

    #[test]
    fn a_reading_that_jumps_or_has_no_time_records_no_sector() {
        let mut sectors = SectorTracker::default();
        sectors.update(3, 0, 0);
        // Sector 0 straight to sector 2: the first one's time cannot be told from this.
        assert_eq!(sectors.update(3, 2, 20_000), [None, None]);
        let mut sectors = SectorTracker::default();
        sectors.update(3, 0, 0);
        assert_eq!(sectors.update(3, 1, 0), [None, None], "no time yet");
        assert_eq!(sectors.update(3, 2, -1), [None, None]);
        // The first reading of a lap is not a change of sector, whatever sector it shows (joined in the middle).
        let mut joined = SectorTracker::default();
        assert_eq!(joined.update(5, 2, 25_000), [None, None]);
    }

    #[test]
    fn reads_text_up_to_the_first_zero() {
        assert_eq!(text_of_utf16(&[0x50, 0x6f, 0x72, 0, 0x78]), "Por");
        assert_eq!(text_of_utf16(&[0x20, 0x41, 0x20]), "A");
        assert_eq!(text_of_ascii(b"Monza\0junk"), "Monza");
        assert_eq!(text_of_ascii(b"no zero"), "no zero");
        assert_eq!(text_of_ascii(b""), "");
    }
}
