//! Automobilista 2, Project CARS 2 and Project CARS 3 (the Project CARS 2 format): shared memory `$pcars2$`.
//!
//! The three games write the same struct. Automobilista 2's header (version 14) is Project CARS 2's (version 9, the
//! last one; its header still says 8) with fields added at the end ("AMS2 Additions (v10...)"): Project CARS 2's
//! struct is the first 20,576 of Automobilista 2's 20,700 bytes. Every field this reader uses lies in the first
//! `PCARS_READ` bytes (through `mSequenceNumber`, added in version 8), so the same reading serves all three; which
//! game it is comes from the header version (14: Automobilista 2) and, for the two Project CARS (both write the
//! Project CARS 2 memory), from the program running. Project CARS 1 writes another, older memory (`$pcars$`).
//!
//! Sources, all from what the game installs (`Support\SharedMemory\AMS2_SharedMemoryExampleApp\SharedMemory.h` and
//! `App.cpp`, header version 14):
//!
//! * The memory holds one C struct (`SharedMemory`, 20700 bytes) that the game rewrites once per graphics frame. The
//!   offsets below follow from the struct definitions (MSVC layout: `bool` and `char` take one byte, `int`, `unsigned
//!   int` and `float` take four and are aligned to four; nothing is larger, so there is no padding other than that);
//!   the test `the_offsets_follow_from_the_sizes_in_the_header` adds the sizes up, field by field, to prove them.
//! * Consistency protocol (`mSequenceNumber`): it is odd while the game writes and even otherwise. A copy is used only
//!   if the number was even before the copy, the copy carries the same number, and it is still the same after the copy
//!   (the example app checks the first two; the third closes the last gap). Otherwise the copy is tried again a few
//!   times and, failing that, that frame is given up. An unchanged number means nothing new: nothing is returned.
//! * The player's car is `mParticipantInfo[mViewedParticipantIndex]`, valid when the index is not -1, is below
//!   `mNumParticipants` and below 64 (the example app's own test). The car state outside the array (speed, rpm, gear,
//!   inputs, fuel, lap times, pit mode, car and track names) is the viewed car's.
//! * Units are the lap file's already: metres, seconds, metres per second, `mGear` -1 / 0 / 1.. (as the header says),
//!   pedals 0..1, steering -1..1, `mFuelLevel` a fraction of `mFuelCapacity` litres.
//!
//! Never read: another process's memory. Only the game's own shared memory, read-only and copied out.

use std::sync::atomic::{fence, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::game::{Frame, Source};
use crate::shm::{Mapping, Page};

/// The name the games give their memory.
const MEMORY_NAME: &str = "$pcars2$";

/// Which game of the format a reader is for: its id and name, the header versions it writes and how many bytes of
/// the struct a copy takes.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Kind {
    id: &'static str,
    name: &'static str,
    versions: (u32, u32),
    size: usize,
}

const AMS2: Kind = Kind {
    id: "ams2",
    name: "Automobilista 2",
    versions: (VERSION, VERSION),
    size: SIZE,
};
/// Project CARS 2: version 9 (8 in its last header); any version from 8 (when `mSequenceNumber` came) to just before
/// Automobilista 2's own has the fields this reader uses at the same places.
const PCARS2: Kind = Kind {
    id: "pcars2",
    name: "Project CARS 2",
    versions: (8, VERSION - 1),
    size: PCARS_READ,
};
/// Project CARS 3 writes the Project CARS 2 memory.
const PCARS3: Kind = Kind {
    id: "pcars3",
    name: "Project CARS 3",
    ..PCARS2
};
/// The bytes of the struct this reader uses, through `mSequenceNumber`.
const PCARS_READ: usize = at::SEQUENCE_NUMBER + 4;
/// Project CARS 2's whole struct (Automobilista 2's without its additions), for the record and the tests.
#[cfg(test)]
const PCARS2_SIZE: usize = 20_576;
/// `SHARED_MEMORY_VERSION` of the header this reader is written against.
const VERSION: u32 = 14;
/// `sizeof(SharedMemory)`.
const SIZE: usize = 20_700;
/// `STORED_PARTICIPANTS_MAX`.
const PARTICIPANTS_MAX: i32 = 64;
/// `sizeof(ParticipantInfo)`.
const PARTICIPANT_SIZE: usize = 100;
const STRING_LENGTH: usize = 64;

/// Byte offsets of the fields read, from the start of the memory.
mod at {
    pub const VERSION: usize = 0;
    pub const GAME_STATE: usize = 8;
    pub const VIEWED_PARTICIPANT: usize = 20;
    pub const NUM_PARTICIPANTS: usize = 24;
    pub const PARTICIPANTS: usize = 28;
    /// Inside a `ParticipantInfo`.
    pub const P_WORLD_POSITION: usize = 68;
    pub const P_CURRENT_LAP_DISTANCE: usize = 80;
    pub const P_LAPS_COMPLETED: usize = 88;

    pub const UNFILTERED_THROTTLE: usize = 6428;
    pub const UNFILTERED_BRAKE: usize = 6432;
    pub const UNFILTERED_STEERING: usize = 6436;
    pub const UNFILTERED_CLUTCH: usize = 6440;
    pub const CAR_NAME: usize = 6444;
    pub const CAR_CLASS_NAME: usize = 6508;
    pub const TRACK_LOCATION: usize = 6576;
    pub const TRACK_VARIATION: usize = 6640;
    pub const TRACK_LENGTH: usize = 6704;
    pub const LAP_INVALIDATED: usize = 6712;
    pub const LAST_LAP_TIME: usize = 6720;
    pub const CURRENT_TIME: usize = 6724;
    pub const PIT_MODE: usize = 6808;
    pub const FUEL_LEVEL: usize = 6840;
    pub const FUEL_CAPACITY: usize = 6844;
    pub const SPEED: usize = 6848;
    pub const RPM: usize = 6852;
    pub const GEAR: usize = 6876;
    pub const SEQUENCE_NUMBER: usize = 7320;
}

// (Type#1) game states: only the first three of interest are named; `GAME_MAX` is the first value that is not one.
const GAME_EXITED: u32 = 0;
const GAME_INGAME_PLAYING: u32 = 2;
const GAME_MAX: u32 = 8;
// (Type#7) pit modes.
const PIT_MODE_NONE: u32 = 0;
const PIT_MODE_IN_GARAGE: u32 = 4;
const PIT_MODE_MAX: u32 = 6;

/// A copy is tried this many times before that frame is given up.
const ATTEMPTS: usize = 4;
/// About 100 Hz.
const POLL: Duration = Duration::from_millis(10);
/// A sequence number that has not moved for this long: the game has stopped writing (it is gone).
const STALE: Duration = Duration::from_secs(30);

pub fn open() -> Option<Box<dyn Source>> {
    Ams2::open_as(MEMORY_NAME, AMS2).map(|reader| Box::new(reader) as Box<dyn Source>)
}

/// Project CARS 2 or 3, whichever is running (both write the Project CARS 2 memory).
pub fn open_pcars() -> Option<Box<dyn Source>> {
    let running = crate::win::running_programs();
    let kind = if crate::win::any_running(&running, &["pcars3.exe", "pcars3avx.exe"]) {
        PCARS3
    } else {
        PCARS2
    };
    Ams2::open_as(MEMORY_NAME, kind).map(|reader| Box::new(reader) as Box<dyn Source>)
}

struct Ams2 {
    kind: Kind,
    memory: Mapping,
    started: Instant,
    /// The sequence number of the last copy used.
    last_used: Option<u32>,
    /// The last sequence number seen, odd or even, and when it last changed.
    last_seen: u32,
    last_change: Instant,
    exited: bool,
    stale_after: Duration,
}

impl Ams2 {
    /// Automobilista 2's reader on the memory of that name (the tests' fake memories).
    #[cfg(test)]
    fn open_named(name: &str) -> Option<Ams2> {
        Ams2::open_as(name, AMS2)
    }

    /// `None` when there is no such memory, it is shorter than the game's struct, or its version is not the game's.
    fn open_as(name: &str, kind: Kind) -> Option<Ams2> {
        let memory = Mapping::open(name)?;
        if memory.len() < kind.size {
            return None;
        }
        let head = memory.read(at::VERSION, 4)?;
        let version = Page(&head).u32_at(0);
        if version < kind.versions.0 || version > kind.versions.1 {
            return None;
        }
        let now = Instant::now();
        Some(Ams2 {
            kind,
            memory,
            started: now,
            last_used: None,
            last_seen: Page(&head).u32_at(0),
            last_change: now,
            exited: false,
            stale_after: STALE,
        })
    }

    fn sequence(&self) -> Option<u32> {
        self.memory.read(at::SEQUENCE_NUMBER, 4).map(|b| Page(&b).u32_at(0))
    }

    /// One try at a new reading: `None` when nothing is new, the game is writing, or the copy is not consistent.
    fn try_read(&mut self) -> Option<Frame> {
        for attempt in 0..ATTEMPTS {
            let before = self.sequence()?;
            fence(Ordering::Acquire);
            if before != self.last_seen {
                self.last_seen = before;
                self.last_change = Instant::now();
            }
            if !before.is_multiple_of(2) {
                // The game is writing right now.
                if attempt + 1 < ATTEMPTS {
                    sleep(Duration::from_millis(1));
                }
                continue;
            }
            if self.last_used == Some(before) {
                return None;
            }
            let copy = self.memory.read(0, self.kind.size)?;
            fence(Ordering::Acquire);
            let after = self.sequence()?;
            if !consistent(before, Page(&copy).u32_at(at::SEQUENCE_NUMBER), after) {
                continue;
            }
            self.last_used = Some(before);
            self.exited = Page(&copy).u32_at(at::GAME_STATE) == GAME_EXITED;
            return frame_of(self.kind, &copy, self.started.elapsed().as_secs_f64());
        }
        None
    }
}

/// The copy may be used: the number was even before it, the copy carries the same one, and it is the same after.
fn consistent(before: u32, in_copy: u32, after: u32) -> bool {
    before.is_multiple_of(2) && before == in_copy && before == after
}

impl Source for Ams2 {
    fn game_id(&self) -> &'static str {
        self.kind.id
    }

    fn game_name(&self) -> &'static str {
        self.kind.name
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
        !self.exited && self.last_change.elapsed() < self.stale_after
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

fn seconds(v: f32, allow_zero: bool) -> Option<f64> {
    (v.is_finite() && v <= 86_400.0 && if allow_zero { v >= 0.0 } else { v > 0.0 }).then(|| f64::from(v))
}

/// The slot of the player's car in the participant array, by the rule of the header's example app.
fn viewed_slot(page: &Page) -> Option<usize> {
    let index = page.i32_at(at::VIEWED_PARTICIPANT);
    let count = page.i32_at(at::NUM_PARTICIPANTS);
    (index >= 0 && index < count && index < PARTICIPANTS_MAX).then_some(index as usize)
}

/// Turns one consistent copy of the memory into a frame. `None` for a copy this reader cannot vouch for (too short,
/// not version 14, a game state that is not one of the header's, a lap count that cannot be real).
#[cfg(test)]
fn frame_from(bytes: &[u8], clock_s: f64) -> Option<Frame> {
    frame_of(AMS2, bytes, clock_s)
}

/// `frame_from` for one game of the format.
fn frame_of(kind: Kind, bytes: &[u8], clock_s: f64) -> Option<Frame> {
    if bytes.len() < kind.size {
        return None;
    }
    let page = Page(bytes);
    let version = page.u32_at(at::VERSION);
    if version < kind.versions.0 || version > kind.versions.1 {
        return None;
    }
    let state = page.u32_at(at::GAME_STATE);
    if state >= GAME_MAX {
        return None;
    }
    let mut frame = Frame::empty();
    frame.clock_s = clock_s;
    // Without a valid player slot (the front end, a replay with nobody viewed) the frame says nothing about a car.
    let Some(slot) = viewed_slot(&page) else {
        return Some(frame);
    };
    let me = at::PARTICIPANTS + slot * PARTICIPANT_SIZE;
    let laps_completed = page.u32_at(me + at::P_LAPS_COMPLETED);
    if laps_completed > 100_000 {
        return None;
    }
    let pit_mode = page.u32_at(at::PIT_MODE);
    if pit_mode >= PIT_MODE_MAX {
        return None;
    }

    // Playing, and not sitting in the garage: a menu, a pause, a restart and a replay are all other states.
    frame.driving = state == GAME_INGAME_PLAYING && pit_mode != PIT_MODE_IN_GARAGE;
    // The game counts laps completed from zero; the first lap is lap 1 here (the engine reads 0 as "no lap yet").
    frame.lap = laps_completed as i32 + 1;
    frame.lap_time_s = seconds(page.f32_at(at::CURRENT_TIME), true);
    frame.last_lap_s = seconds(page.f32_at(at::LAST_LAP_TIME), false);
    frame.lap_valid = Some(page.u8_at(at::LAP_INVALIDATED) == 0);
    frame.dist_m = {
        let d = within(page.f32_at(me + at::P_CURRENT_LAP_DISTANCE), 0.0, 1_000_000.0);
        d.is_finite().then(|| f64::from(d))
    };
    frame.in_pits = pit_mode != PIT_MODE_NONE;
    frame.speed_ms = within(page.f32_at(at::SPEED), 0.0, 1000.0);
    frame.rpm = within(page.f32_at(at::RPM), 0.0, 100_000.0);
    let gear = page.i32_at(at::GEAR);
    frame.gear = if (-1..=30).contains(&gear) { gear as f32 } else { f32::NAN };
    // What the driver does with the pedals and the wheel, before any filtering the game applies.
    frame.throttle = clamped(page.f32_at(at::UNFILTERED_THROTTLE), 0.0, 1.0);
    frame.brake = clamped(page.f32_at(at::UNFILTERED_BRAKE), 0.0, 1.0);
    frame.clutch = clamped(page.f32_at(at::UNFILTERED_CLUTCH), 0.0, 1.0);
    frame.steer = clamped(page.f32_at(at::UNFILTERED_STEERING), -1.0, 1.0);
    let position = me + at::P_WORLD_POSITION;
    frame.x = within(page.f32_at(position), -1.0e7, 1.0e7);
    frame.y = within(page.f32_at(position + 4), -1.0e7, 1.0e7);
    frame.z = within(page.f32_at(position + 8), -1.0e7, 1.0e7);
    let level = page.f32_at(at::FUEL_LEVEL);
    let capacity = within(page.f32_at(at::FUEL_CAPACITY), 0.0, 10_000.0);
    frame.fuel_l = if level.is_finite() && capacity > 0.0 {
        level.clamp(0.0, 1.0) * capacity
    } else {
        f32::NAN
    };
    frame.car = page.ascii_at(at::CAR_NAME, STRING_LENGTH);
    frame.car_class = Some(page.ascii_at(at::CAR_CLASS_NAME, STRING_LENGTH)).filter(|s| !s.is_empty());
    frame.track = page.ascii_at(at::TRACK_LOCATION, STRING_LENGTH);
    frame.track_variant = Some(page.ascii_at(at::TRACK_VARIATION, STRING_LENGTH)).filter(|s| !s.is_empty());
    let length = within(page.f32_at(at::TRACK_LENGTH), 0.0, 1_000_000.0);
    frame.track_length_m = (length > 0.0).then(|| f64::from(length));
    Some(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lapcut::LapCutter;
    use crate::shm::FakeMemory;

    /// The whole struct as bytes, built by the test with the offsets the reader uses.
    struct Image(Vec<u8>);

    impl Image {
        fn new() -> Image {
            let mut image = Image(vec![0; SIZE]);
            image.u32(at::VERSION, VERSION);
            image.u32(at::GAME_STATE, GAME_INGAME_PLAYING);
            image.i32(at::VIEWED_PARTICIPANT, 0);
            image.i32(at::NUM_PARTICIPANTS, 1);
            image
        }
        fn u32(&mut self, at: usize, v: u32) {
            self.0[at..at + 4].copy_from_slice(&v.to_le_bytes());
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
        fn seq(&self) -> u32 {
            Page(&self.0).u32_at(at::SEQUENCE_NUMBER)
        }
        /// A participant: world position, lap distance and laps completed.
        fn participant(&mut self, slot: usize, pos: [f32; 3], dist: f32, laps_completed: u32) {
            let me = at::PARTICIPANTS + slot * PARTICIPANT_SIZE;
            self.0[me] = 1;
            for (i, v) in pos.iter().enumerate() {
                self.f32(me + at::P_WORLD_POSITION + 4 * i, *v);
            }
            self.f32(me + at::P_CURRENT_LAP_DISTANCE, dist);
            self.u32(me + at::P_LAPS_COMPLETED, laps_completed);
        }
        /// A representative moment on track, with values that are exact in `f32`.
        fn on_track() -> Image {
            let mut i = Image::new();
            i.participant(0, [100.5, 2.25, -300.75], 1234.5, 3);
            i.f32(at::SPEED, 55.5);
            i.f32(at::RPM, 7250.0);
            i.i32(at::GEAR, 4);
            i.f32(at::UNFILTERED_THROTTLE, 0.75);
            i.f32(at::UNFILTERED_BRAKE, 0.25);
            i.f32(at::UNFILTERED_CLUTCH, 0.5);
            i.f32(at::UNFILTERED_STEERING, -0.5);
            i.f32(at::FUEL_LEVEL, 0.5);
            i.f32(at::FUEL_CAPACITY, 100.0);
            i.f32(at::CURRENT_TIME, 63.25);
            i.f32(at::LAST_LAP_TIME, 90.5);
            i.f32(at::TRACK_LENGTH, 4309.0);
            i.text(at::CAR_NAME, "Formula Ultimate Gen2");
            i.text(at::CAR_CLASS_NAME, "Formula Ultimate");
            i.text(at::TRACK_LOCATION, "Interlagos");
            i.text(at::TRACK_VARIATION, "Grand Prix");
            i
        }
    }

    /// A fake game memory and the image the test keeps in it.
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
        /// Like the game ending a frame: the whole image with the sequence number moved up by two (even).
        fn publish(&mut self) {
            let next = (self.image.seq() | 1).wrapping_add(1);
            self.image.u32(at::SEQUENCE_NUMBER, next);
            self.fake.write(0, &self.image.0);
        }
        fn reader(&self) -> Ams2 {
            Ams2::open_named(&self.fake.name).expect("opens")
        }
    }

    const NOW: Duration = Duration::from_millis(0);

    /// Field by field: (name, bytes of one element, how many). The alignment of a field is its element size up to four
    /// (`bool` and `char` one, `int`, `unsigned int` and `float` four, a struct of those four).
    type Fields<'a> = &'a [(&'a str, usize, usize)];

    fn layout(fields: Fields) -> (Vec<(String, usize)>, usize) {
        let mut at: usize = 0;
        let mut offsets = Vec::new();
        for (name, size, count) in fields {
            let align = (*size).min(4);
            at = at.div_ceil(align) * align;
            offsets.push((name.to_string(), at));
            at += size * count;
        }
        (offsets, at.div_ceil(4) * 4)
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
        const F: usize = 4; // float, int, unsigned int
        const B: usize = 1; // bool, char
        const P: usize = 64; // STORED_PARTICIPANTS_MAX (and STRING_LENGTH_MAX)
        const T: usize = 4; // TYRE_MAX
        let (p, p_size) = layout(&[
            ("mIsActive", B, 1),
            ("mName", B, P),
            ("mWorldPosition", F, 3),
            ("mCurrentLapDistance", F, 1),
            ("mRacePosition", F, 1),
            ("mLapsCompleted", F, 1),
            ("mCurrentLap", F, 1),
            ("mCurrentSector", F, 1),
        ]);
        assert_eq!(p_size, PARTICIPANT_SIZE);
        assert_eq!(offset_of(&p, "mWorldPosition"), at::P_WORLD_POSITION);
        assert_eq!(offset_of(&p, "mCurrentLapDistance"), at::P_CURRENT_LAP_DISTANCE);
        assert_eq!(offset_of(&p, "mLapsCompleted"), at::P_LAPS_COMPLETED);

        let (o, size) = layout(&[
            ("mVersion", F, 1),
            ("mBuildVersionNumber", F, 1),
            ("mGameState", F, 1),
            ("mSessionState", F, 1),
            ("mRaceState", F, 1),
            ("mViewedParticipantIndex", F, 1),
            ("mNumParticipants", F, 1),
            ("mParticipantInfo", p_size, P),
            ("mUnfilteredThrottle", F, 1),
            ("mUnfilteredBrake", F, 1),
            ("mUnfilteredSteering", F, 1),
            ("mUnfilteredClutch", F, 1),
            ("mCarName", B, P),
            ("mCarClassName", B, P),
            ("mLapsInEvent", F, 1),
            ("mTrackLocation", B, P),
            ("mTrackVariation", B, P),
            ("mTrackLength", F, 1),
            ("mNumSectors", F, 1),
            ("mLapInvalidated", B, 1),
            ("mBestLapTime", F, 1),
            ("mLastLapTime", F, 1),
            ("mCurrentTime", F, 1),
            ("mSplitTimeAhead", F, 1),
            ("mSplitTimeBehind", F, 1),
            ("mSplitTime", F, 1),
            ("mEventTimeRemaining", F, 1),
            ("mPersonalFastestLapTime", F, 1),
            ("mWorldFastestLapTime", F, 1),
            ("mCurrentSector1Time", F, 1),
            ("mCurrentSector2Time", F, 1),
            ("mCurrentSector3Time", F, 1),
            ("mFastestSector1Time", F, 1),
            ("mFastestSector2Time", F, 1),
            ("mFastestSector3Time", F, 1),
            ("mPersonalFastestSector1Time", F, 1),
            ("mPersonalFastestSector2Time", F, 1),
            ("mPersonalFastestSector3Time", F, 1),
            ("mWorldFastestSector1Time", F, 1),
            ("mWorldFastestSector2Time", F, 1),
            ("mWorldFastestSector3Time", F, 1),
            ("mHighestFlagColour", F, 1),
            ("mHighestFlagReason", F, 1),
            ("mPitMode", F, 1),
            ("mPitSchedule", F, 1),
            ("mCarFlags", F, 1),
            ("mOilTempCelsius", F, 1),
            ("mOilPressureKPa", F, 1),
            ("mWaterTempCelsius", F, 1),
            ("mWaterPressureKPa", F, 1),
            ("mFuelPressureKPa", F, 1),
            ("mFuelLevel", F, 1),
            ("mFuelCapacity", F, 1),
            ("mSpeed", F, 1),
            ("mRpm", F, 1),
            ("mMaxRPM", F, 1),
            ("mBrake", F, 1),
            ("mThrottle", F, 1),
            ("mClutch", F, 1),
            ("mSteering", F, 1),
            ("mGear", F, 1),
            ("mNumGears", F, 1),
            ("mOdometerKM", F, 1),
            ("mAntiLockActive", B, 1),
            ("mLastOpponentCollisionIndex", F, 1),
            ("mLastOpponentCollisionMagnitude", F, 1),
            ("mBoostActive", B, 1),
            ("mBoostAmount", F, 1),
            ("mOrientation", F, 3),
            ("mLocalVelocity", F, 3),
            ("mWorldVelocity", F, 3),
            ("mAngularVelocity", F, 3),
            ("mLocalAcceleration", F, 3),
            ("mWorldAcceleration", F, 3),
            ("mExtentsCentre", F, 3),
            ("mTyreFlags", F, T),
            ("mTerrain", F, T),
            ("mTyreY", F, T),
            ("mTyreRPS", F, T),
            ("mTyreSlipSpeed", F, T),
            ("mTyreTemp", F, T),
            ("mTyreGrip", F, T),
            ("mTyreHeightAboveGround", F, T),
            ("mTyreLateralStiffness", F, T),
            ("mTyreWear", F, T),
            ("mBrakeDamage", F, T),
            ("mSuspensionDamage", F, T),
            ("mBrakeTempCelsius", F, T),
            ("mTyreTreadTemp", F, T),
            ("mTyreLayerTemp", F, T),
            ("mTyreCarcassTemp", F, T),
            ("mTyreRimTemp", F, T),
            ("mTyreInternalAirTemp", F, T),
            ("mCrashState", F, 1),
            ("mAeroDamage", F, 1),
            ("mEngineDamage", F, 1),
            ("mAmbientTemperature", F, 1),
            ("mTrackTemperature", F, 1),
            ("mRainDensity", F, 1),
            ("mWindSpeed", F, 1),
            ("mWindDirectionX", F, 1),
            ("mWindDirectionY", F, 1),
            ("mCloudBrightness", F, 1),
            ("mSequenceNumber", F, 1),
            ("mWheelLocalPositionY", F, T),
            ("mSuspensionTravel", F, T),
            ("mSuspensionVelocity", F, T),
            ("mAirPressure", F, T),
            ("mEngineSpeed", F, 1),
            ("mEngineTorque", F, 1),
            ("mWings", F, 2),
            ("mHandBrake", F, 1),
            ("mCurrentSector1Times", F, P),
            ("mCurrentSector2Times", F, P),
            ("mCurrentSector3Times", F, P),
            ("mFastestSector1Times", F, P),
            ("mFastestSector2Times", F, P),
            ("mFastestSector3Times", F, P),
            ("mFastestLapTimes", F, P),
            ("mLastLapTimes", F, P),
            ("mLapsInvalidated", B, P),
            ("mRaceStates", F, P),
            ("mPitModes", F, P),
            ("mOrientations", F, P * 3),
            ("mSpeeds", F, P),
            ("mCarNames", B, P * P),
            ("mCarClassNames", B, P * P),
            ("mEnforcedPitStopLap", F, 1),
            ("mTranslatedTrackLocation", B, P),
            ("mTranslatedTrackVariation", B, P),
            ("mBrakeBias", F, 1),
            ("mTurboBoostPressure", F, 1),
            ("mTyreCompound", B, T * 40),
            ("mPitSchedules", F, P),
            ("mHighestFlagColours", F, P),
            ("mHighestFlagReasons", F, P),
            ("mNationalities", F, P),
            ("mSnowDensity", F, 1),
            ("mSessionDuration", F, 1),
            ("mSessionAdditionalLaps", F, 1),
            ("mTyreTempLeft", F, T),
            ("mTyreTempCenter", F, T),
            ("mTyreTempRight", F, T),
            ("mDrsState", F, 1),
            ("mRideHeight", F, T),
            ("mJoyPad0", F, 1),
            ("mDPad", F, 1),
            ("mAntiLockSetting", F, 1),
            ("mTractionControlSetting", F, 1),
            ("mErsDeploymentMode", F, 1),
            ("mErsAutoModeEnabled", B, 1),
            ("mClutchTemp", F, 1),
            ("mClutchWear", F, 1),
            ("mClutchOverheated", B, 1),
            ("mClutchSlipping", B, 1),
            ("mYellowFlagState", F, 1),
            ("mSessionIsPrivate", B, 1),
            ("mLaunchStage", F, 1),
        ]);
        assert_eq!(size, SIZE, "sizeof(SharedMemory)");
        for (name, want) in [
            ("mVersion", at::VERSION),
            ("mGameState", at::GAME_STATE),
            ("mViewedParticipantIndex", at::VIEWED_PARTICIPANT),
            ("mNumParticipants", at::NUM_PARTICIPANTS),
            ("mParticipantInfo", at::PARTICIPANTS),
            ("mUnfilteredThrottle", at::UNFILTERED_THROTTLE),
            ("mUnfilteredBrake", at::UNFILTERED_BRAKE),
            ("mUnfilteredSteering", at::UNFILTERED_STEERING),
            ("mUnfilteredClutch", at::UNFILTERED_CLUTCH),
            ("mCarName", at::CAR_NAME),
            ("mCarClassName", at::CAR_CLASS_NAME),
            ("mTrackLocation", at::TRACK_LOCATION),
            ("mTrackVariation", at::TRACK_VARIATION),
            ("mTrackLength", at::TRACK_LENGTH),
            ("mLapInvalidated", at::LAP_INVALIDATED),
            ("mLastLapTime", at::LAST_LAP_TIME),
            ("mCurrentTime", at::CURRENT_TIME),
            ("mPitMode", at::PIT_MODE),
            ("mFuelLevel", at::FUEL_LEVEL),
            ("mFuelCapacity", at::FUEL_CAPACITY),
            ("mSpeed", at::SPEED),
            ("mRpm", at::RPM),
            ("mGear", at::GEAR),
            ("mSequenceNumber", at::SEQUENCE_NUMBER),
        ] {
            assert_eq!(offset_of(&o, name), want, "{name}");
        }
        // Spot checks against the layout worked out independently with a C struct model (Python ctypes).
        assert_eq!(offset_of(&o, "mLastLapTimes"), 9200);
        assert_eq!(offset_of(&o, "mCarNames"), 11_056);
        assert_eq!(offset_of(&o, "mLaunchStage"), 20_696);
        // The game's memory is made `SIZE` bytes long; Windows rounds that to whole pages, and a page count that
        // still holds the struct is what `open_named` asks of the mapping.
        assert!(SIZE.div_ceil(4096) * 4096 >= SIZE);
    }

    #[test]
    fn reads_a_moment_on_track_into_exact_frame_values() {
        let mut rig = Rig::new("happy", Image::on_track());
        rig.publish();
        let mut reader = rig.reader();
        assert_eq!((reader.game_id(), reader.game_name()), ("ams2", "Automobilista 2"));
        let frame = reader.next(NOW).expect("a frame");
        let mut want = Frame::empty();
        want.clock_s = frame.clock_s;
        want.driving = true;
        want.lap = 4; // three laps completed: the fourth is being driven
        want.lap_time_s = Some(63.25);
        want.last_lap_s = Some(90.5);
        want.lap_valid = Some(true);
        want.dist_m = Some(1234.5);
        want.in_pits = false;
        want.speed_ms = 55.5;
        want.rpm = 7250.0;
        want.gear = 4.0;
        want.throttle = 0.75;
        want.brake = 0.25;
        want.clutch = 0.5;
        want.steer = -0.5;
        want.x = 100.5;
        want.y = 2.25;
        want.z = -300.75;
        want.fuel_l = 50.0;
        want.car = "Formula Ultimate Gen2".into();
        want.car_class = Some("Formula Ultimate".into());
        want.track = "Interlagos".into();
        want.track_variant = Some("Grand Prix".into());
        want.track_length_m = Some(4309.0);
        assert_eq!(frame, want);
        assert!(reader.alive());
    }

    #[test]
    fn an_empty_class_or_variation_is_not_given() {
        let mut image = Image::on_track();
        image.text(at::CAR_CLASS_NAME, "");
        image.text(at::TRACK_VARIATION, "");
        image.f32(at::LAST_LAP_TIME, 0.0);
        image.f32(at::TRACK_LENGTH, 0.0);
        image.0[at::LAP_INVALIDATED] = 1;
        let frame = frame_from(&image.0, 1.0).unwrap();
        assert_eq!((frame.car_class, frame.track_variant, frame.track_length_m), (None, None, None));
        assert_eq!((frame.last_lap_s, frame.lap_valid), (None, Some(false)));
    }

    #[test]
    fn only_an_even_unchanged_sequence_number_is_used() {
        let mut rig = Rig::new("seq", Image::on_track());
        rig.publish();
        let mut reader = rig.reader();
        assert!(reader.next(NOW).is_some());
        assert!(reader.next(NOW).is_none(), "the same number: nothing new");
        assert!(reader.next(Duration::from_millis(25)).is_none(), "still nothing new after waiting");
        // The game starts writing (odd): the half-written frame is not used, however it looks.
        rig.image.f32(at::SPEED, 999.0);
        let odd = rig.image.seq() + 1;
        rig.image.u32(at::SEQUENCE_NUMBER, odd);
        rig.fake.write(0, &rig.image.0);
        assert!(reader.next(Duration::from_millis(15)).is_none());
        // It finishes (even): the new frame is taken.
        rig.image.u32(at::SEQUENCE_NUMBER, odd + 1);
        rig.fake.write(0, &rig.image.0);
        assert_eq!(reader.next(NOW).unwrap().speed_ms, 999.0);
        assert!(reader.next(NOW).is_none());
    }

    #[test]
    fn a_copy_is_consistent_only_when_the_number_is_even_and_the_same_before_inside_and_after() {
        assert!(consistent(10, 10, 10));
        assert!(!consistent(11, 11, 11), "odd");
        assert!(!consistent(10, 12, 10), "changed while copying: the copy carries a newer one");
        assert!(!consistent(10, 10, 12), "changed after copying");
        assert!(!consistent(10, 8, 10));
    }

    #[test]
    fn a_copy_is_never_torn_while_the_game_writes_all_the_time() {
        struct Writer(FakeMemory);
        // The test's own memory, written from one thread only.
        unsafe impl Send for Writer {}
        let mut image = Image::on_track();
        image.f32(at::SPEED, 0.0);
        image.f32(at::RPM, 0.0);
        let fake = FakeMemory::new("torn", SIZE);
        fake.write(0, &image.0);
        let mut reader = Ams2::open_named(&fake.name).unwrap();
        let writer = Writer(fake);
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_writer = stop.clone();
        let thread = std::thread::spawn(move || {
            let writer = writer;
            let mut n: u32 = 0;
            while !stop_writer.load(Ordering::Relaxed) {
                n += 1;
                writer.0.write(at::SEQUENCE_NUMBER, &(2 * n - 1).to_le_bytes());
                fence(Ordering::SeqCst);
                writer.0.write(at::SPEED, &(n as f32).to_le_bytes());
                for _ in 0..200 {
                    std::hint::spin_loop();
                }
                writer.0.write(at::RPM, &(n as f32).to_le_bytes());
                fence(Ordering::SeqCst);
                writer.0.write(at::SEQUENCE_NUMBER, &(2 * n).to_le_bytes());
                // The game writes once per graphics frame, not without a pause.
                std::thread::sleep(Duration::from_micros(500));
            }
        });
        let until = Instant::now() + Duration::from_millis(400);
        let (mut frames, mut torn) = (0, 0);
        while Instant::now() < until {
            if let Some(frame) = reader.next(Duration::from_millis(2)) {
                frames += 1;
                if frame.speed_ms != frame.rpm {
                    torn += 1;
                }
            }
        }
        stop.store(true, Ordering::Relaxed);
        thread.join().unwrap();
        assert!(frames > 5, "frames {frames}");
        assert_eq!(torn, 0, "of {frames} frames");
    }

    #[test]
    fn only_playing_is_driving() {
        let names = [
            "exited",
            "front end",
            "playing",
            "paused",
            "in menu, time ticking",
            "restarting",
            "replay",
            "front end replay",
        ];
        for (state, name) in names.iter().enumerate() {
            let mut image = Image::on_track();
            image.u32(at::GAME_STATE, state as u32);
            let frame = frame_from(&image.0, 0.0).unwrap();
            assert_eq!(frame.driving, state == 2, "{name}");
            // Even when it is not driving, the frame still carries the last lap time (a lap can be closed in a menu).
            assert_eq!(frame.last_lap_s, Some(90.5), "{name}");
        }
        let mut image = Image::on_track();
        image.u32(at::GAME_STATE, 8);
        assert!(
            frame_from(&image.0, 0.0).is_none(),
            "a state the header does not know is garbled data"
        );
    }

    #[test]
    fn the_pit_mode_gives_in_pits_and_the_garage_is_not_driving() {
        for (mode, in_pits, driving) in [
            (0, false, true), // none
            (1, true, true),  // driving into the pits
            (2, true, true),  // in the pit box
            (3, true, true),  // driving out of the pits
            (4, true, false), // in the garage
            (5, true, true),  // driving out of the garage
        ] {
            let mut image = Image::on_track();
            image.u32(at::PIT_MODE, mode);
            let frame = frame_from(&image.0, 0.0).unwrap();
            assert_eq!((frame.in_pits, frame.driving), (in_pits, driving), "pit mode {mode}");
        }
        let mut image = Image::on_track();
        image.u32(at::PIT_MODE, 6);
        assert!(frame_from(&image.0, 0.0).is_none());
    }

    #[test]
    fn gears_pedals_and_fuel_are_converted_and_garbage_is_not_given() {
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
        image.f32(at::SPEED, f32::INFINITY);
        image.f32(at::RPM, -5.0);
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert_eq!((frame.throttle, frame.brake, frame.steer), (1.0, 0.0, -1.0));
        assert!(frame.clutch.is_nan() && frame.speed_ms.is_nan() && frame.rpm.is_nan());
        // Fuel: a fraction of the capacity in litres; without a capacity there is no litre figure.
        let mut image = Image::on_track();
        image.f32(at::FUEL_LEVEL, 0.25);
        image.f32(at::FUEL_CAPACITY, 80.0);
        assert_eq!(frame_from(&image.0, 0.0).unwrap().fuel_l, 20.0);
        image.f32(at::FUEL_CAPACITY, 0.0);
        assert!(frame_from(&image.0, 0.0).unwrap().fuel_l.is_nan());
        // Speed is metres per second as the game gives it: 55.5 stays 55.5, it is not read as km/h.
        assert_eq!(frame_from(&Image::on_track().0, 0.0).unwrap().speed_ms, 55.5);
    }

    #[test]
    fn the_player_is_the_viewed_participant() {
        let mut image = Image::on_track();
        image.i32(at::NUM_PARTICIPANTS, 4);
        image.participant(0, [1.0, 1.0, 1.0], 10.0, 7);
        image.participant(1, [2.0, 2.0, 2.0], 20.0, 8);
        image.participant(2, [3.0, 4.0, 5.0], 30.0, 9);
        image.participant(3, [6.0, 6.0, 6.0], 40.0, 10);
        for (viewed, x, dist, lap) in [(0, 1.0, 10.0, 8), (2, 3.0, 30.0, 10), (3, 6.0, 40.0, 11)] {
            image.i32(at::VIEWED_PARTICIPANT, viewed);
            let frame = frame_from(&image.0, 0.0).unwrap();
            assert_eq!((frame.x, frame.dist_m, frame.lap), (x, Some(dist), lap), "viewed {viewed}");
        }
        image.i32(at::VIEWED_PARTICIPANT, 2);
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert_eq!((frame.y, frame.z), (4.0, 5.0));
        // No valid slot: -1, past the count, past the array, negative. The frame says nothing about a car.
        for viewed in [-1, 4, 63, 64, 200, -7, i32::MIN, i32::MAX] {
            image.i32(at::VIEWED_PARTICIPANT, viewed);
            let frame = frame_from(&image.0, 0.0).unwrap();
            assert!(
                !frame.driving && frame.dist_m.is_none() && frame.x.is_nan() && frame.car.is_empty(),
                "viewed {viewed}"
            );
        }
        // The count counts: a slot at or past it is not valid even when it is inside the array.
        image.i32(at::VIEWED_PARTICIPANT, 3);
        image.i32(at::NUM_PARTICIPANTS, 3);
        assert!(!frame_from(&image.0, 0.0).unwrap().driving);
        // The last slot of the array is valid when the count says so.
        image.i32(at::VIEWED_PARTICIPANT, 63);
        image.i32(at::NUM_PARTICIPANTS, 64);
        image.participant(63, [9.0, 9.0, 9.0], 99.0, 1);
        let frame = frame_from(&image.0, 0.0).unwrap();
        assert_eq!((frame.x, frame.dist_m, frame.lap, frame.driving), (9.0, Some(99.0), 2, true));
    }

    #[test]
    fn reads_project_cars_2_and_3_from_their_shorter_memory() {
        // Project CARS 2's struct ends where Automobilista 2's additions start, and everything read is before that.
        assert_eq!(
            SIZE - PCARS2_SIZE,
            124,
            "the AMS2 additions: 2 + 12 + 1 + 4 + 2 + 2 + 1 + 1 + 4 + 2 + 1 + 1 fields, padded"
        );
        const { assert!(PCARS_READ <= PCARS2_SIZE) };
        for end in [
            at::GEAR + 4,
            at::FUEL_CAPACITY + 4,
            at::TRACK_VARIATION + STRING_LENGTH,
            at::PARTICIPANTS + 64 * PARTICIPANT_SIZE,
        ] {
            assert!(end <= PCARS_READ, "{end}");
        }
        for (version, kind) in [(9, PCARS2), (8, PCARS3)] {
            let mut image = Image::on_track();
            image.u32(at::VERSION, version);
            image.u32(at::SEQUENCE_NUMBER, 2);
            let fake = FakeMemory::new("pcars", PCARS2_SIZE);
            fake.write(0, &image.0[..PCARS2_SIZE]);
            assert!(Ams2::open_named(&fake.name).is_none(), "not Automobilista 2");
            let mut reader = Ams2::open_as(&fake.name, kind).expect("opens");
            assert_eq!((reader.game_id(), reader.game_name()), (kind.id, kind.name));
            let frame = reader.next(NOW).expect("a frame");
            assert_eq!(frame.speed_ms, 55.5);
            assert!(frame.track.contains("Interlagos"), "{}", frame.track);
        }
        // Too old (before mSequenceNumber), or Automobilista 2's own version: not Project CARS.
        for version in [7, VERSION] {
            let mut image = Image::on_track();
            image.u32(at::VERSION, version);
            let rig = Rig::new("pcars-version", image);
            assert!(Ams2::open_as(&rig.fake.name, PCARS2).is_none(), "version {version}");
        }
    }

    #[test]
    fn a_memory_that_is_too_short_or_of_another_version_is_refused() {
        let ok = Rig::new("ok", Image::on_track());
        assert!(Ams2::open_named(&ok.fake.name).is_some());
        assert!(Ams2::open_named("XpeedSimNoSuchPcars2Memory").is_none());
        // One page: Windows reports 4096, less than the struct needs.
        let short = FakeMemory::new("short", 4096);
        short.write(0, &Image::on_track().0[..4096]);
        assert!(Ams2::open_named(&short.name).is_none());
        // Exactly the struct's size is enough (the mapping is rounded up to pages).
        let exact = FakeMemory::new("exact", SIZE);
        exact.write(0, &Image::on_track().0);
        assert!(Ams2::open_named(&exact.name).is_some());
        for version in [0, 13, 15, 1000, u32::MAX] {
            let mut image = Image::on_track();
            image.u32(at::VERSION, version);
            let rig = Rig::new("version", image);
            assert!(Ams2::open_named(&rig.fake.name).is_none(), "version {version}");
        }
        // A copy of the wrong version (the memory changed under an open reader) gives nothing.
        let mut image = Image::on_track();
        image.u32(at::VERSION, 9);
        assert!(frame_from(&image.0, 0.0).is_none());
        assert!(frame_from(&Image::on_track().0[..SIZE - 1], 0.0).is_none());
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
            // Most rounds keep the version, the state and the player's slot valid so the rest is read.
            if round % 3 != 0 {
                bytes[..4].copy_from_slice(&VERSION.to_le_bytes());
                bytes[at::GAME_STATE..at::GAME_STATE + 4].copy_from_slice(&(next() as u32 % 8).to_le_bytes());
                let slot = (next() % 64) as usize;
                bytes[at::VIEWED_PARTICIPANT..at::VIEWED_PARTICIPANT + 4].copy_from_slice(&(slot as i32).to_le_bytes());
                bytes[at::NUM_PARTICIPANTS..at::NUM_PARTICIPANTS + 4].copy_from_slice(&64i32.to_le_bytes());
                let laps_at = at::PARTICIPANTS + slot * PARTICIPANT_SIZE + at::P_LAPS_COMPLETED;
                bytes[laps_at..laps_at + 4].copy_from_slice(&(next() as u32 % 1000).to_le_bytes());
                // Some floats in a range where they are believable, so the range checks below have something to check.
                for float_at in [
                    at::UNFILTERED_THROTTLE,
                    at::UNFILTERED_BRAKE,
                    at::UNFILTERED_CLUTCH,
                    at::UNFILTERED_STEERING,
                    at::SPEED,
                    at::RPM,
                    at::FUEL_LEVEL,
                    at::FUEL_CAPACITY,
                    at::CURRENT_TIME,
                    at::LAST_LAP_TIME,
                ] {
                    let v = (next() % 4000) as f32 / 1000.0 - 2.0;
                    bytes[float_at..float_at + 4].copy_from_slice(&v.to_le_bytes());
                }
                bytes[at::PIT_MODE..at::PIT_MODE + 4].copy_from_slice(&(next() as u32 % 6).to_le_bytes());
            }
            let Some(f) = frame_from(&bytes, 1.0) else { continue };
            given += 1;
            assert!(f.lap >= 1 || !f.driving);
            for v in [f.throttle, f.brake, f.clutch] {
                assert!(v.is_nan() || (0.0..=1.0).contains(&v));
            }
            assert!(f.steer.is_nan() || (-1.0..=1.0).contains(&f.steer));
            assert!(f.speed_ms.is_nan() || (0.0..=1000.0).contains(&f.speed_ms));
            assert!(f.gear.is_nan() || (-1.0..=30.0).contains(&f.gear));
            assert!(f.fuel_l.is_nan() || (0.0..=10_000.0).contains(&f.fuel_l));
            assert!(f.dist_m.is_none_or(|d| d.is_finite() && d >= 0.0));
            assert!(f.lap_time_s.is_none_or(|t| t.is_finite() && t >= 0.0));
            assert!(f.last_lap_s.is_none_or(|t| t.is_finite() && t > 0.0));
        }
        assert!(given > 50, "given {given}");
    }

    #[test]
    fn the_clock_never_goes_backwards() {
        let mut rig = Rig::new("clock", Image::on_track());
        let mut reader = rig.reader();
        let mut last = -1.0;
        for _ in 0..50 {
            rig.publish();
            let frame = reader.next(Duration::from_millis(20)).expect("a frame");
            assert!(frame.clock_s >= last && frame.clock_s >= 0.0);
            last = frame.clock_s;
        }
    }

    #[test]
    fn the_door_is_alive_until_the_game_exits_or_stops_writing() {
        let mut rig = Rig::new("alive", Image::on_track());
        rig.publish();
        let mut reader = rig.reader();
        reader.stale_after = Duration::from_millis(80);
        assert!(reader.next(NOW).is_some() && reader.alive());
        // The game keeps writing: still alive well past the limit.
        for _ in 0..6 {
            sleep(Duration::from_millis(30));
            rig.publish();
            reader.next(NOW);
            assert!(reader.alive());
        }
        // It stops writing.
        sleep(Duration::from_millis(120));
        assert!(!reader.alive());
        // It says it has exited.
        rig.image.u32(at::GAME_STATE, GAME_EXITED);
        rig.publish();
        assert!(reader.next(NOW).is_some());
        assert!(!reader.alive());
    }

    /// One frame of a lap as the game would leave it in memory.
    fn lap_frame(rig: &mut Rig, laps_completed: u32, lap_time: f32, last_lap: f32, invalidated: bool) {
        rig.image
            .participant(0, [lap_time * 10.0, 0.0, 0.0], lap_time * 50.0, laps_completed);
        rig.image.f32(at::CURRENT_TIME, lap_time);
        rig.image.f32(at::LAST_LAP_TIME, last_lap);
        rig.image.0[at::LAP_INVALIDATED] = u8::from(invalidated);
        rig.publish();
    }

    fn drive_a_lap_through_the_reader(invalidated: bool) -> Vec<crate::lapfile::Lap> {
        let mut rig = Rig::new("lap", Image::on_track());
        let mut reader = rig.reader();
        let mut cutter = LapCutter::new(reader.game_id());
        let mut laps = Vec::new();
        let mut feed = |reader: &mut Ams2, laps: &mut Vec<_>| {
            let frame = reader.next(Duration::from_millis(20)).expect("a frame");
            laps.extend(cutter.on_frame(&frame, 1_794_312_000_000));
        };
        // Lap 1 (no laps completed yet): 30 seconds at 20 Hz on the game's lap clock, no official time yet.
        for i in 0..600 {
            lap_frame(&mut rig, 0, i as f32 / 20.0, 0.0, invalidated && i == 100);
            feed(&mut reader, &mut laps);
        }
        // The line is crossed: one lap completed, the lap clock starts again, the official time is 30.0.
        for i in 0..20 {
            lap_frame(&mut rig, 1, i as f32 / 20.0, 30.0, false);
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
            ("ams2", 1, 30_000, true)
        );
        assert_eq!(
            (lap.track_name.as_str(), lap.track_variant.as_deref()),
            ("Interlagos", Some("Grand Prix"))
        );
        assert_eq!(
            (lap.car_name.as_str(), lap.car_class.as_deref()),
            ("Formula Ultimate Gen2", Some("Formula Ultimate"))
        );
        assert_eq!(lap.track_length_m, Some(4309.0));
        assert_eq!(lap.sample_count(), 600);
        let ids: Vec<&str> = lap.channels.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            ["t", "dist", "speed", "rpm", "gear", "throttle", "brake", "clutch", "steer", "x", "y", "z", "fuel"]
        );
        assert_eq!(lap.channel("t").unwrap().values.last(), Some(&29.95));
        assert_eq!(lap.channel("speed").unwrap().values[0], 55.5);
        assert_eq!(lap.channel("fuel").unwrap().values[0], 50.0);
    }

    #[test]
    fn a_lap_the_game_called_invalid_is_kept_but_not_valid() {
        let laps = drive_a_lap_through_the_reader(true);
        assert_eq!((laps.len(), laps[0].time_ms, laps[0].valid), (1, 30_000, false));
    }
}
