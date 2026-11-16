//! Reading the memory Le Mans Ultimate shares, the way the game's own interface describes.
//!
//! The protocol, as the headers the game installs document it:
//!
//! 1. open the mapping `LMU_Data` and the two events `LMU_Data_HoldEvent` and `LMU_Data_DataEvent`;
//! 2. wait for the hold event and then the data event, in that order (the only order without a race);
//! 3. take the game's lock (`LMU_SharedMemoryLockData`: two counters, `waiters` and `busy`, changed
//!    with atomic operations), copy what this frame carries, and release the lock;
//! 4. never work on the shared memory itself, only on the copy.
//!
//! The mapping is opened read-only. The lock mapping is the one thing we write to, as the protocol
//! requires, and it is created empty if the game has not created it yet (as the game does).
//! Only the parts of the memory this frame updated, and only the player's car, are copied, so the
//! lock is held for a few microseconds.

use std::ffi::CString;
use std::ptr::{copy_nonoverlapping, null, null_mut};
use std::sync::atomic::{AtomicI32, Ordering};

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Memory::{
    CreateFileMappingA, MapViewOfFile, OpenFileMappingA, UnmapViewOfFile, VirtualQuery, MEMORY_BASIC_INFORMATION,
    MEMORY_MAPPED_VIEW_ADDRESS,
};
use windows_sys::Win32::System::Threading::{CreateEventA, OpenEventA, SetEvent, WaitForSingleObject};

use super::layout::*;
use super::snapshot::{events, telemetry_range, Snapshot};

const FILE_MAP_READ: u32 = 0x0004;
const FILE_MAP_ALL_ACCESS: u32 = 0x000F_001F;
const PAGE_READWRITE: u32 = 0x04;
const SYNCHRONIZE: u32 = 0x0010_0000;
const ERROR_ALREADY_EXISTS: u32 = 183;
const PAGE_BYTES: usize = 4096;

/// The names of the Windows objects the game creates. The tests use names of their own so that they
/// can never touch the memory of a game that is running.
#[derive(Debug, Clone)]
pub struct Names {
    pub map: String,
    pub hold_event: String,
    pub data_event: String,
    pub lock_map: String,
    pub lock_event: String,
}

impl Names {
    pub fn lmu() -> Self {
        Names {
            map: "LMU_Data".into(),
            hold_event: "LMU_Data_HoldEvent".into(),
            data_event: "LMU_Data_DataEvent".into(),
            lock_map: "LMU_SharedMemoryLockData".into(),
            lock_event: "LMU_SharedMemoryLockEvent".into(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    /// The game is not running, or its Enable plugins setting is off (the mapping does not exist).
    NotRunning,
    /// The memory is smaller than the layout we know: not a game we can read.
    TooSmall {
        found: usize,
        expected: usize,
    },
    Os(String),
}

fn c_name(text: &str) -> CString {
    CString::new(text).expect("object names have no zero bytes")
}

fn last_error(what: &str) -> OpenError {
    OpenError::Os(format!("{what} failed (Windows error {})", unsafe { GetLastError() }))
}

fn round_up_to_page(bytes: usize) -> usize {
    bytes.div_ceil(PAGE_BYTES) * PAGE_BYTES
}

/// The game version `layout.rs` was generated for (its header says "Generated for LMU 1.4.2.0"; the fourth number is
/// the build and is not compared). Change it together with `layout.rs` when that is regenerated.
pub const LAYOUT_VERSION: [u32; 3] = [1, 4, 2];

/// What the game's version number says about the layout this build reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Version {
    /// The game has not written its version yet (0): nothing to judge.
    Unwritten,
    /// The version the layout was generated for.
    Same,
    /// The same major and minor, another patch: the layout is taken to be the same (a patch does not move fields),
    /// and the difference is logged once.
    Patch([u32; 3]),
    /// Another major or minor: the layout may have moved. Nothing is read.
    Other([u32; 3]),
    /// A number that does not read as a version in the assumed packing (see `decode_version`): not refused (the
    /// packing is not checked against a live game), logged once.
    NotUnderstood(i32),
}

/// The game's `gameVersion` as major, minor and patch. ASSUMED, not checked against a live game (the header gives no
/// packing): `major * 10000 + minor * 100 + patch` (1.4.2 is 10402). A number that does not decode to a major
/// between 1 and 9 is not taken for a version at all, so a different packing can never make a good game look like
/// another one: it is `NotUnderstood`, accepted and logged. `xpeed-companion probe` prints the number.
pub fn decode_version(raw: i32) -> Option<[u32; 3]> {
    let raw = u32::try_from(raw).ok().filter(|v| *v > 0)?;
    let (major, minor, patch) = (raw / 10_000, raw / 100 % 100, raw % 100);
    (1..=9).contains(&major).then_some([major, minor, patch])
}

/// Judges the game's version number against `LAYOUT_VERSION`.
pub fn judge_version(raw: i32) -> Version {
    if raw == 0 {
        return Version::Unwritten;
    }
    match decode_version(raw) {
        None => Version::NotUnderstood(raw),
        Some(found) if found[..2] != LAYOUT_VERSION[..2] => Version::Other(found),
        Some(found) if found != LAYOUT_VERSION => Version::Patch(found),
        Some(_) => Version::Same,
    }
}

fn dotted(v: [u32; 3]) -> String {
    format!("{}.{}.{}", v[0], v[1], v[2])
}

/// The game's lock: a spin lock over two counters in a small mapping, with an event to sleep on.
struct Lock {
    map: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    event: HANDLE,
}

impl Lock {
    fn open(names: &Names) -> Result<Lock, OpenError> {
        unsafe {
            let map = CreateFileMappingA(
                INVALID_HANDLE_VALUE,
                null(),
                PAGE_READWRITE,
                0,
                8,
                c_name(&names.lock_map).as_ptr().cast(),
            );
            if map.is_null() {
                return Err(last_error("creating the lock mapping"));
            }
            let existed = GetLastError() == ERROR_ALREADY_EXISTS;
            let view = MapViewOfFile(map, FILE_MAP_ALL_ACCESS, 0, 0, 8);
            if view.Value.is_null() {
                let error = last_error("mapping the lock");
                CloseHandle(map);
                return Err(error);
            }
            if !existed {
                // Nobody had created it: start it free, as the game does when it is first.
                std::ptr::write_bytes(view.Value.cast::<u8>(), 0, 8);
            }
            let event = CreateEventA(null(), 0, 0, c_name(&names.lock_event).as_ptr().cast());
            if event.is_null() {
                let error = last_error("creating the lock event");
                UnmapViewOfFile(view);
                CloseHandle(map);
                return Err(error);
            }
            Ok(Lock { map, view, event })
        }
    }

    fn waiters(&self) -> &AtomicI32 {
        unsafe { AtomicI32::from_ptr(self.view.Value.cast::<i32>()) }
    }
    fn busy(&self) -> &AtomicI32 {
        unsafe { AtomicI32::from_ptr(self.view.Value.cast::<i32>().add(1)) }
    }

    /// Takes the lock, spinning first and then sleeping on the event. False if it was not free in time.
    fn lock(&self, timeout_ms: u32) -> bool {
        for _ in 0..4000 {
            if self.busy().compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                return true;
            }
            std::hint::spin_loop();
        }
        self.waiters().fetch_add(1, Ordering::SeqCst);
        let mut acquired = false;
        loop {
            if self.busy().compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                acquired = true;
                break;
            }
            if unsafe { WaitForSingleObject(self.event, timeout_ms) } != WAIT_OBJECT_0 {
                break;
            }
        }
        self.waiters().fetch_sub(1, Ordering::SeqCst);
        acquired
    }

    fn unlock(&self) {
        self.busy().store(0, Ordering::SeqCst);
        if self.waiters().load(Ordering::SeqCst) > 0 {
            unsafe { SetEvent(self.event) };
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.event);
            UnmapViewOfFile(self.view);
            CloseHandle(self.map);
        }
    }
}

pub struct LmuReader {
    map: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    hold: HANDLE,
    data: HANDLE,
    lock: Lock,
    mapped_bytes: usize,
    /// A copy laid out like the shared memory; only the parts of the last frame are fresh.
    buffer: Vec<u8>,
    /// How long to wait for the game's lock before giving a frame up.
    pub lock_timeout_ms: u32,
    /// The version number judged last (each number is judged, and noted in the log, once).
    judged: Option<i32>,
    /// The game's version is another major or minor than the layout's: nothing is read.
    refused: bool,
    /// What was last written to the log about the version.
    #[cfg_attr(not(test), allow(dead_code))]
    note: Option<String>,
}

impl LmuReader {
    pub fn open(names: &Names) -> Result<LmuReader, OpenError> {
        unsafe {
            let map = OpenFileMappingA(FILE_MAP_READ, 0, c_name(&names.map).as_ptr().cast());
            if map.is_null() {
                return Err(OpenError::NotRunning);
            }
            let view = MapViewOfFile(map, FILE_MAP_READ, 0, 0, 0);
            if view.Value.is_null() {
                let error = last_error("mapping the game memory");
                CloseHandle(map);
                return Err(error);
            }
            let mut info: MEMORY_BASIC_INFORMATION = std::mem::zeroed();
            let mapped_bytes = if VirtualQuery(view.Value, &mut info, std::mem::size_of::<MEMORY_BASIC_INFORMATION>()) == 0 {
                0
            } else {
                info.RegionSize
            };
            let cleanup = |hold: HANDLE, data: HANDLE| {
                if !hold.is_null() {
                    CloseHandle(hold);
                }
                if !data.is_null() {
                    CloseHandle(data);
                }
                UnmapViewOfFile(view);
                CloseHandle(map);
            };
            if mapped_bytes < LAYOUT_SIZE {
                cleanup(null_mut(), null_mut());
                return Err(OpenError::TooSmall {
                    found: mapped_bytes,
                    expected: LAYOUT_SIZE,
                });
            }
            let hold = OpenEventA(SYNCHRONIZE, 0, c_name(&names.hold_event).as_ptr().cast());
            let data = OpenEventA(SYNCHRONIZE, 0, c_name(&names.data_event).as_ptr().cast());
            if hold.is_null() || data.is_null() {
                let error = last_error("opening the frame events");
                cleanup(hold, data);
                return Err(error);
            }
            let lock = match Lock::open(names) {
                Ok(lock) => lock,
                Err(error) => {
                    cleanup(hold, data);
                    return Err(error);
                }
            };
            let mut reader = LmuReader {
                map,
                view,
                hold,
                data,
                lock,
                mapped_bytes,
                buffer: vec![0; LAYOUT_SIZE],
                lock_timeout_ms: 100,
                judged: None,
                refused: false,
                note: None,
            };
            reader.judge(reader.version_in_memory());
            if reader.refused {
                let message = reader.note.clone().unwrap_or_default();
                return Err(OpenError::Os(message));
            }
            Ok(reader)
        }
    }

    /// Judges the game's version number once per value: another major or minor refuses the game (nothing is read from
    /// it), another patch or a number that does not read as a version is accepted and written to the log once.
    fn judge(&mut self, raw: i32) {
        if self.judged == Some(raw) {
            return;
        }
        let verdict = judge_version(raw);
        if verdict == Version::Unwritten {
            return;
        }
        self.judged = Some(raw);
        let note = match verdict {
            Version::Other(found) => {
                self.refused = true;
                Some(format!(
                    "Le Mans Ultimate says it is version {}; this build reads the layout of {}. Another game version: nothing is read.",
                    dotted(found),
                    dotted(LAYOUT_VERSION)
                ))
            }
            Version::Patch(found) => Some(format!(
                "Le Mans Ultimate is version {}, a patch away from the {} this build's layout was made for; reading it as the same layout.",
                dotted(found),
                dotted(LAYOUT_VERSION)
            )),
            Version::NotUnderstood(raw) => Some(format!(
                "Le Mans Ultimate reports the game version number {raw}, which does not read as a version; reading it as the layout of {}.",
                dotted(LAYOUT_VERSION)
            )),
            Version::Same | Version::Unwritten => None,
        };
        if let Some(text) = note {
            crate::applog::line(&text);
            self.note = Some(text);
        }
    }

    /// The game's version number straight from the mapping (a plain aligned integer the game writes at the start).
    fn version_in_memory(&self) -> i32 {
        if self.mapped_bytes < GENERIC_GAME_VERSION + 4 {
            return 0;
        }
        unsafe {
            self.view
                .Value
                .cast::<u8>()
                .add(GENERIC_GAME_VERSION)
                .cast::<i32>()
                .read_unaligned()
        }
    }

    /// The size of the mapping the game made, rounded up to whole pages (what Windows reports).
    pub fn mapped_bytes(&self) -> usize {
        self.mapped_bytes
    }

    /// Whether the game's memory is the size of the layout this build was made for. A different size
    /// means a game version with another layout: read nothing from it. (A change smaller than a page
    /// cannot be seen from the size; the game version printed by `probe` covers that.)
    pub fn layout_matches(&self) -> bool {
        self.mapped_bytes == round_up_to_page(LAYOUT_SIZE) && !self.refused
    }

    /// Waits for the next frame, in the order the game's interface requires. False on timeout.
    pub fn wait_frame(&self, timeout_ms: u32) -> bool {
        unsafe {
            WaitForSingleObject(self.hold, timeout_ms) == WAIT_OBJECT_0 && WaitForSingleObject(self.data, timeout_ms) == WAIT_OBJECT_0
        }
    }

    fn copy(&mut self, start: usize, len: usize) {
        assert!(start + len <= LAYOUT_SIZE && start + len <= self.mapped_bytes);
        unsafe { copy_nonoverlapping(self.view.Value.cast::<u8>().add(start), self.buffer.as_mut_ptr().add(start), len) }
        // A capture (`capture.rs`) keeps what was copied; nothing happens unless one runs on this thread.
        crate::capture::tap_lmu(start, &self.buffer[start..start + len]);
    }

    /// Reads this frame. None if the game's lock was not free in time (the frame is skipped).
    pub fn read(&mut self) -> Option<Snapshot> {
        if !self.lock.lock(self.lock_timeout_ms) {
            return None;
        }
        self.copy(0, GENERIC_GAME_VERSION + 4);
        // The game may write its version after the mapping exists: the first number seen is judged here too.
        self.judge(i32::from_le_bytes(
            self.buffer[GENERIC_GAME_VERSION..GENERIC_GAME_VERSION + 4].try_into().unwrap(),
        ));
        if self.refused {
            self.lock.unlock();
            return None;
        }
        let codes = events(&self.buffer);
        if codes.contains(&SME_UPDATE_TELEMETRY) {
            self.copy(TELEMETRY_ACTIVE_VEHICLES, 3);
            let (active, index, has_car) = (
                self.buffer[TELEMETRY_ACTIVE_VEHICLES],
                self.buffer[TELEMETRY_PLAYER_INDEX],
                self.buffer[TELEMETRY_PLAYER_HAS_VEHICLE] != 0,
            );
            if let Some(range) = telemetry_range(active, index, has_car) {
                self.copy(range.start, range.len());
            }
        }
        if codes.contains(&SME_UPDATE_SCORING) {
            self.copy(SCORING_INFO, SCORING_INFO_SIZE);
            let count = i32::from_le_bytes(
                self.buffer[SCORING_INFO + SI_NUM_VEHICLES..SCORING_INFO + SI_NUM_VEHICLES + 4]
                    .try_into()
                    .unwrap(),
            );
            let count = count.clamp(0, MAX_VEHICLES as i32) as usize;
            self.copy(SCORING_VEHICLES, count * VEHICLE_SCORING_SIZE);
        }
        self.lock.unlock();
        Some(Snapshot::from_memory(&self.buffer))
    }
}

impl Drop for LmuReader {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.hold);
            CloseHandle(self.data);
            UnmapViewOfFile(self.view);
            CloseHandle(self.map);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering as Seq};

    use super::*;
    use crate::lmu::snapshot::fake::Memory;
    use crate::lmu::snapshot::{PlayerTelemetry, SessionScoring, VehicleScoring};

    static NEXT: AtomicU32 = AtomicU32::new(0);

    /// Stands in for the game: creates the same kinds of Windows objects under names of its own.
    struct FakeGame {
        names: Names,
        map: HANDLE,
        view: *mut u8,
        hold: HANDLE,
        data: HANDLE,
        lock_map: HANDLE,
        lock_view: *mut i32,
    }

    impl FakeGame {
        fn new(map_bytes: usize, signaled: bool) -> FakeGame {
            let tag = format!("XpeedTest_{}_{}", std::process::id(), NEXT.fetch_add(1, Seq::SeqCst));
            let names = Names {
                map: format!("{tag}_Data"),
                hold_event: format!("{tag}_Hold"),
                data_event: format!("{tag}_DataEvent"),
                lock_map: format!("{tag}_LockData"),
                lock_event: format!("{tag}_LockEvent"),
            };
            unsafe {
                let map = CreateFileMappingA(
                    INVALID_HANDLE_VALUE,
                    null(),
                    PAGE_READWRITE,
                    0,
                    map_bytes as u32,
                    c_name(&names.map).as_ptr().cast(),
                );
                assert!(!map.is_null());
                let view = MapViewOfFile(map, FILE_MAP_ALL_ACCESS, 0, 0, 0).Value.cast::<u8>();
                let hold = CreateEventA(null(), 1, signaled as i32, c_name(&names.hold_event).as_ptr().cast());
                let data = CreateEventA(null(), 1, signaled as i32, c_name(&names.data_event).as_ptr().cast());
                let lock_map = CreateFileMappingA(
                    INVALID_HANDLE_VALUE,
                    null(),
                    PAGE_READWRITE,
                    0,
                    8,
                    c_name(&names.lock_map).as_ptr().cast(),
                );
                let lock_view = MapViewOfFile(lock_map, FILE_MAP_ALL_ACCESS, 0, 0, 8).Value.cast::<i32>();
                FakeGame {
                    names,
                    map,
                    view,
                    hold,
                    data,
                    lock_map,
                    lock_view,
                }
            }
        }

        fn write_frame(&self, memory: &Memory) {
            unsafe { copy_nonoverlapping(memory.0.as_ptr(), self.view, memory.0.len().min(LAYOUT_SIZE)) }
        }
        fn signal(&self) {
            unsafe {
                SetEvent(self.hold);
                SetEvent(self.data);
            }
        }
        fn busy(&self) -> &AtomicI32 {
            unsafe { AtomicI32::from_ptr(self.lock_view.add(1)) }
        }
    }

    impl Drop for FakeGame {
        fn drop(&mut self) {
            unsafe {
                UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: self.view.cast() });
                UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                    Value: self.lock_view.cast(),
                });
                for handle in [self.map, self.hold, self.data, self.lock_map] {
                    CloseHandle(handle);
                }
            }
        }
    }

    fn car() -> PlayerTelemetry {
        PlayerTelemetry {
            elapsed_time: 42.5,
            delta_time: 0.01,
            lap_number: 2,
            lap_start_et: 40.0,
            vehicle_name: "Test Car #1".into(),
            track_name: "Test Ring".into(),
            local_vel: [0.0, 0.0, -60.0],
            gear: 3,
            rpm: 5000.0,
            throttle: 0.5,
            ..PlayerTelemetry::default()
        }
    }

    fn full_frame() -> Memory {
        let mut memory = Memory::new();
        memory.set_events(&[SME_UPDATE_SCORING, SME_UPDATE_TELEMETRY]);
        memory.put_i32(GENERIC_GAME_VERSION, 777);
        memory.telemetry(1, 3, &car());
        let session = SessionScoring {
            track_name: "Test Ring".into(),
            track_length_m: 3000.0,
            current_et: 42.4,
            num_vehicles: 2,
            ..SessionScoring::default()
        };
        let mine = VehicleScoring {
            vehicle_name: "Test Car #1".into(),
            vehicle_class: "Hyper".into(),
            lap_dist: 250.0,
            ..VehicleScoring::default()
        };
        memory.scoring(&session, &[VehicleScoring::default(), mine], Some(1));
        memory
    }

    #[test]
    fn says_so_when_the_game_is_not_running() {
        let names = FakeGame::new(round_up_to_page(LAYOUT_SIZE), true).names.clone();
        let missing = Names {
            map: format!("{}_nope", names.map),
            ..names
        };
        assert_eq!(LmuReader::open(&missing).err(), Some(OpenError::NotRunning));
    }

    #[test]
    fn reads_a_frame_through_the_same_protocol_as_the_game() {
        let game = FakeGame::new(LAYOUT_SIZE, true);
        game.write_frame(&full_frame());
        let mut reader = LmuReader::open(&game.names).unwrap();
        assert!(reader.layout_matches());
        assert!(reader.wait_frame(100));
        let snapshot = reader.read().expect("the lock is free");
        assert_eq!(snapshot.game_version, 777);
        assert_eq!(snapshot.telemetry, Some(car()));
        let scoring = snapshot.scoring.unwrap();
        assert_eq!(scoring.session.track_length_m, 3000.0);
        assert_eq!(scoring.player.unwrap().lap_dist, 250.0);
        assert_eq!(game.busy().load(Ordering::SeqCst), 0, "the lock is released after the copy");
    }

    #[test]
    fn copies_only_what_the_frame_updated() {
        let game = FakeGame::new(LAYOUT_SIZE, true);
        let mut memory = full_frame();
        memory.set_events(&[SME_UPDATE_TELEMETRY, 0]);
        game.write_frame(&memory);
        let mut reader = LmuReader::open(&game.names).unwrap();
        let snapshot = reader.read().unwrap();
        assert!(snapshot.telemetry.is_some());
        assert!(snapshot.scoring.is_none());
    }

    #[test]
    fn waits_for_the_frame_events_in_order() {
        let game = FakeGame::new(LAYOUT_SIZE, false);
        let reader = LmuReader::open(&game.names).unwrap();
        assert!(!reader.wait_frame(20), "nothing is signaled yet");
        unsafe { SetEvent(game.hold) };
        assert!(!reader.wait_frame(20), "the hold event alone is not a frame");
        game.signal();
        assert!(reader.wait_frame(20));
    }

    #[test]
    fn skips_the_frame_when_the_game_holds_the_lock() {
        let game = FakeGame::new(LAYOUT_SIZE, true);
        game.write_frame(&full_frame());
        let mut reader = LmuReader::open(&game.names).unwrap();
        reader.lock_timeout_ms = 20;
        game.busy().store(1, Ordering::SeqCst);
        assert!(reader.read().is_none());
        game.busy().store(0, Ordering::SeqCst);
        assert!(reader.read().is_some());
    }

    #[test]
    fn refuses_memory_smaller_than_the_layout() {
        let game = FakeGame::new(100_000, true);
        match LmuReader::open(&game.names) {
            Err(OpenError::TooSmall { expected, .. }) => assert_eq!(expected, LAYOUT_SIZE),
            other => panic!("expected TooSmall, got {:?}", other.err()),
        }
    }

    fn version_number(major: i32, minor: i32, patch: i32) -> i32 {
        major * 10_000 + minor * 100 + patch
    }

    #[test]
    fn the_version_the_layout_was_made_for_matches_its_header() {
        let header = include_str!("layout.rs");
        let want = format!(
            "Generated for LMU {}.{}.{}.0",
            LAYOUT_VERSION[0], LAYOUT_VERSION[1], LAYOUT_VERSION[2]
        );
        assert!(header.contains(&want), "layout.rs says another version than LAYOUT_VERSION: {want}");
    }

    #[test]
    fn a_version_number_is_judged_against_the_layouts() {
        assert_eq!(judge_version(0), Version::Unwritten);
        assert_eq!(judge_version(version_number(1, 4, 2)), Version::Same);
        assert_eq!(judge_version(version_number(1, 4, 3)), Version::Patch([1, 4, 3]));
        assert_eq!(judge_version(version_number(1, 4, 0)), Version::Patch([1, 4, 0]));
        assert_eq!(judge_version(version_number(1, 5, 2)), Version::Other([1, 5, 2]));
        assert_eq!(judge_version(version_number(1, 3, 9)), Version::Other([1, 3, 9]));
        assert_eq!(judge_version(version_number(2, 4, 2)), Version::Other([2, 4, 2]));
        // Numbers that do not read as a version in the assumed packing are never a refusal.
        for odd in [777, 12, -5, 1420, 16_908_800, 104_020, 99_999_999] {
            assert_eq!(judge_version(odd), Version::NotUnderstood(odd), "{odd}");
        }
    }

    #[test]
    fn a_game_of_another_major_or_minor_is_refused_with_the_other_version_message() {
        let game = FakeGame::new(LAYOUT_SIZE, true);
        let mut memory = full_frame();
        memory.put_i32(GENERIC_GAME_VERSION, version_number(1, 5, 0));
        game.write_frame(&memory);
        match LmuReader::open(&game.names) {
            Err(OpenError::Os(message)) => {
                assert!(message.contains("Another game version"), "{message}");
                assert!(message.contains("1.5.0") && message.contains("1.4.2"), "{message}");
            }
            other => panic!("expected a refusal, got {:?}", other.err()),
        }
    }

    #[test]
    fn a_game_whose_version_appears_after_the_memory_is_refused_at_the_first_read() {
        let game = FakeGame::new(LAYOUT_SIZE, true);
        let mut memory = full_frame();
        memory.put_i32(GENERIC_GAME_VERSION, 0);
        game.write_frame(&memory);
        let mut reader = LmuReader::open(&game.names).expect("no version written yet: nothing to judge");
        assert!(reader.layout_matches());
        memory.put_i32(GENERIC_GAME_VERSION, version_number(1, 6, 0));
        game.write_frame(&memory);
        assert!(reader.read().is_none(), "another version: nothing is read");
        assert!(!reader.layout_matches());
        assert_eq!(game.busy().load(Ordering::SeqCst), 0, "the lock is released all the same");
        assert!(reader.note.as_deref().is_some_and(|n| n.contains("Another game version")));
    }

    #[test]
    fn a_game_of_another_patch_is_read_and_noted_once() {
        let game = FakeGame::new(LAYOUT_SIZE, true);
        let mut memory = full_frame();
        memory.put_i32(GENERIC_GAME_VERSION, version_number(1, 4, 5));
        game.write_frame(&memory);
        let mut reader = LmuReader::open(&game.names).expect("a patch does not refuse");
        assert!(reader.layout_matches());
        let first = reader.note.clone().expect("the difference is noted when it is first seen");
        assert!(first.contains("1.4.5") && first.contains("1.4.2"), "{first}");
        let snapshot = reader.read().expect("and it is read");
        assert_eq!(snapshot.telemetry, Some(car()));
        // The same number again says nothing new.
        reader.note = None;
        assert!(reader.read().is_some());
        assert_eq!(reader.note, None, "noted once, not at every frame");
    }

    #[test]
    fn the_version_of_the_layout_reads_without_a_word() {
        let game = FakeGame::new(LAYOUT_SIZE, true);
        let mut memory = full_frame();
        memory.put_i32(GENERIC_GAME_VERSION, version_number(1, 4, 2));
        game.write_frame(&memory);
        let mut reader = LmuReader::open(&game.names).unwrap();
        assert!(reader.read().is_some());
        assert_eq!(reader.note, None);
    }

    #[test]
    fn notices_memory_of_another_size_without_reading_it() {
        let game = FakeGame::new(LAYOUT_SIZE + 2 * PAGE_BYTES, true);
        let reader = LmuReader::open(&game.names).unwrap();
        assert!(!reader.layout_matches());
        assert_eq!(reader.mapped_bytes(), round_up_to_page(LAYOUT_SIZE + 2 * PAGE_BYTES));
    }
}
