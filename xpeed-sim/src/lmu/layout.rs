//! Where each field Xpeed Sim reads sits in the memory Le Mans Ultimate shares (`LMU_Data`).
//!
//! GENERATED: do not edit by hand. These are numbers only (sizes and byte offsets), produced by
//! `tools/layout_check.cpp`, a small helper compiled against the headers the game installs in
//! `Support\SharedMemoryInterface` (see `tools/regen-layout.ps1`). The headers themselves are not
//! part of this repository: their licence does not allow redistributing them.
//!
//! Generated for LMU 1.4.2.0. If the game changes the layout, regenerate this file and check
//! `LAYOUT_SIZE` against the size Xpeed Sim reports in `probe`.
#![allow(dead_code)]

pub const OBJECT_OUT_SIZE: usize = 324824;
pub const LAYOUT_SIZE: usize = 324824;
pub const GENERIC_EVENTS: usize = 0;
pub const GENERIC_GAME_VERSION: usize = 64;
pub const SME_MAX: usize = 16;
pub const SME_UPDATE_SCORING: u32 = 10;
pub const SME_UPDATE_TELEMETRY: u32 = 11;
pub const MAX_VEHICLES: usize = 104;

// Scoring
pub const SCORING_INFO: usize = 1632;
pub const SCORING_STREAM_SIZE: usize = 2184;
pub const SCORING_VEHICLES: usize = 2192;
pub const SCORING_INFO_SIZE: usize = 548;
pub const VEHICLE_SCORING_SIZE: usize = 584;
pub const SI_TRACK_NAME: usize = 0;
pub const SI_SESSION: usize = 64;
pub const SI_CURRENT_ET: usize = 68;
pub const SI_LAP_DIST: usize = 88;
pub const SI_NUM_VEHICLES: usize = 104;
pub const SI_GAME_PHASE: usize = 108;
pub const SI_IN_REALTIME: usize = 115;
pub const VS_ID: usize = 0;
pub const VS_DRIVER_NAME: usize = 4;
pub const VS_VEHICLE_NAME: usize = 36;
pub const VS_TOTAL_LAPS: usize = 100;
pub const VS_FINISH_STATUS: usize = 103;
pub const VS_LAP_DIST: usize = 104;
pub const VS_LAST_SECTOR1: usize = 152;
pub const VS_LAST_SECTOR2: usize = 160;
pub const VS_LAST_LAP_TIME: usize = 168;
pub const VS_NUM_PENALTIES: usize = 194;
pub const VS_IS_PLAYER: usize = 196;
pub const VS_CONTROL: usize = 197;
pub const VS_IN_PITS: usize = 198;
pub const VS_VEHICLE_CLASS: usize = 200;
pub const VS_LAP_START_ET: usize = 256;
pub const VS_TIME_INTO_LAP: usize = 464;
pub const VS_COUNT_LAP_FLAG: usize = 506;

// Telemetry
pub const TELEMETRY_ACTIVE_VEHICLES: usize = 128464;
pub const TELEMETRY_PLAYER_INDEX: usize = 128465;
pub const TELEMETRY_PLAYER_HAS_VEHICLE: usize = 128466;
pub const TELEMETRY_INFO: usize = 128468;
pub const TELEM_INFO_SIZE: usize = 1888;
pub const VECT3_SIZE: usize = 24;
pub const TI_ID: usize = 0;
pub const TI_DELTA_TIME: usize = 4;
pub const TI_ELAPSED_TIME: usize = 12;
pub const TI_LAP_NUMBER: usize = 20;
pub const TI_LAP_START_ET: usize = 24;
pub const TI_VEHICLE_NAME: usize = 32;
pub const TI_TRACK_NAME: usize = 96;
pub const TI_POS: usize = 160;
pub const TI_LOCAL_VEL: usize = 184;
pub const TI_GEAR: usize = 352;
pub const TI_ENGINE_RPM: usize = 356;
pub const TI_THROTTLE: usize = 388;
pub const TI_BRAKE: usize = 396;
pub const TI_STEERING: usize = 404;
pub const TI_CLUTCH: usize = 412;
pub const TI_FUEL: usize = 524;
pub const TI_WHEEL: usize = 848;
pub const TELEM_WHEEL_SIZE: usize = 260;
pub const TW_PRESSURE: usize = 120;
pub const TW_TEMPERATURE: usize = 128;
pub const TW_WEAR: usize = 152;
pub const TW_CARCASS_TEMPERATURE: usize = 204;
