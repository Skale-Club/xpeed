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
            Ok(LmuReader {
                map,
                view,
                hold,
                data,
                lock,
                mapped_bytes,
                buffer: vec![0; LAYOUT_SIZE],
                lock_timeout_ms: 100,
            })
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
        self.mapped_bytes == round_up_to_page(LAYOUT_SIZE)
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
    }

    /// Reads this frame. None if the game's lock was not free in time (the frame is skipped).
    pub fn read(&mut self) -> Option<Snapshot> {
        if !self.lock.lock(self.lock_timeout_ms) {
            return None;
        }
        self.copy(0, GENERIC_GAME_VERSION + 4);
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

    #[test]
    fn notices_memory_of_another_size_without_reading_it() {
        let game = FakeGame::new(LAYOUT_SIZE + 2 * PAGE_BYTES, true);
        let reader = LmuReader::open(&game.names).unwrap();
        assert!(!reader.layout_matches());
        assert_eq!(reader.mapped_bytes(), round_up_to_page(LAYOUT_SIZE + 2 * PAGE_BYTES));
    }
}
