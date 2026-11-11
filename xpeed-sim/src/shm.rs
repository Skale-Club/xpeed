#![allow(dead_code)] // until the readers of each game use everything here
//! Reading a memory a game shares under a name: opened read-only, copied out, never worked on in place.
//! (Le Mans Ultimate has its own reader because its memory is guarded by a lock and events.)

use std::ffi::CString;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingA, UnmapViewOfFile, VirtualQuery, FILE_MAP_READ, MEMORY_BASIC_INFORMATION, MEMORY_MAPPED_VIEW_ADDRESS,
};

/// A named shared memory of a game, mapped for reading.
pub struct Mapping {
    handle: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    len: usize,
}

// The view is only read, through `read`, which copies; nothing else touches it.
unsafe impl Send for Mapping {}

impl Mapping {
    /// `None` when no game has made a memory of that name (the game is not running, or it does not share).
    pub fn open(name: &str) -> Option<Mapping> {
        let name = CString::new(name).ok()?;
        unsafe {
            let handle = OpenFileMappingA(FILE_MAP_READ, 0, name.as_ptr().cast());
            if handle.is_null() {
                return None;
            }
            let view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
            if view.Value.is_null() {
                CloseHandle(handle);
                return None;
            }
            let mut info: MEMORY_BASIC_INFORMATION = std::mem::zeroed();
            let len = if VirtualQuery(view.Value, &mut info, std::mem::size_of::<MEMORY_BASIC_INFORMATION>()) == 0 {
                0
            } else {
                info.RegionSize
            };
            Some(Mapping { handle, view, len })
        }
    }

    /// The size Windows reports: the size the game asked for, rounded up to whole pages (4096 bytes).
    pub fn len(&self) -> usize {
        self.len
    }

    /// Copies `len` bytes from `at`. `None` when the memory is smaller than that.
    pub fn read(&self, at: usize, len: usize) -> Option<Vec<u8>> {
        if at.checked_add(len)? > self.len {
            return None;
        }
        let mut out = vec![0u8; len];
        unsafe { std::ptr::copy_nonoverlapping(self.view.Value.cast::<u8>().add(at), out.as_mut_ptr(), len) };
        Some(out)
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        unsafe {
            UnmapViewOfFile(self.view);
            CloseHandle(self.handle);
        }
    }
}

/// Little-endian reads out of a copied page. A read past the end gives zero, which no layout treats as a value
/// worth believing (the sources check the page is long enough first).
pub struct Page<'a>(pub &'a [u8]);

impl Page<'_> {
    pub fn i32_at(&self, at: usize) -> i32 {
        self.0.get(at..at + 4).map_or(0, |b| i32::from_le_bytes(b.try_into().unwrap()))
    }
    pub fn u32_at(&self, at: usize) -> u32 {
        self.0.get(at..at + 4).map_or(0, |b| u32::from_le_bytes(b.try_into().unwrap()))
    }
    pub fn f32_at(&self, at: usize) -> f32 {
        self.0.get(at..at + 4).map_or(0.0, |b| f32::from_le_bytes(b.try_into().unwrap()))
    }
    pub fn f64_at(&self, at: usize) -> f64 {
        self.0.get(at..at + 8).map_or(0.0, |b| f64::from_le_bytes(b.try_into().unwrap()))
    }
    pub fn i16_at(&self, at: usize) -> i16 {
        self.0.get(at..at + 2).map_or(0, |b| i16::from_le_bytes(b.try_into().unwrap()))
    }
    pub fn u8_at(&self, at: usize) -> u8 {
        self.0.get(at).copied().unwrap_or(0)
    }
    /// UTF-16 text of `units` characters starting at `at`.
    pub fn utf16_at(&self, at: usize, units: usize) -> String {
        let raw: Vec<u16> = self
            .0
            .get(at..at + units * 2)
            .unwrap_or(&[])
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        crate::game::text_of_utf16(&raw)
    }
    /// ASCII (or UTF-8) text of `len` bytes starting at `at`.
    pub fn ascii_at(&self, at: usize, len: usize) -> String {
        crate::game::text_of_ascii(self.0.get(at..at + len).unwrap_or(&[]))
    }
}

/// A shared memory made by the test itself, under a name of its own (never the real game's).
#[cfg(test)]
pub struct FakeMemory {
    handle: HANDLE,
    view: *mut u8,
    pub name: String,
}

#[cfg(test)]
impl FakeMemory {
    pub fn new(label: &str, bytes: usize) -> FakeMemory {
        use std::sync::atomic::{AtomicU32, Ordering};
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::Memory::{CreateFileMappingA, FILE_MAP_ALL_ACCESS, PAGE_READWRITE};
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let name = format!(
            "XpeedSimFake_{}_{}_{label}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        );
        let c = CString::new(name.clone()).unwrap();
        unsafe {
            let handle = CreateFileMappingA(
                INVALID_HANDLE_VALUE,
                std::ptr::null(),
                PAGE_READWRITE,
                0,
                bytes as u32,
                c.as_ptr().cast(),
            );
            assert!(!handle.is_null());
            let view = MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, 0).Value.cast::<u8>();
            assert!(!view.is_null());
            FakeMemory { handle, view, name }
        }
    }

    pub fn write(&self, at: usize, bytes: &[u8]) {
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.view.add(at), bytes.len()) };
    }
}

#[cfg(test)]
impl Drop for FakeMemory {
    fn drop(&mut self) {
        unsafe {
            UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: self.view.cast() });
            CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_opens_when_no_game_made_the_memory() {
        assert!(Mapping::open("XpeedSimNoSuchMemory_for_tests").is_none());
    }

    #[test]
    fn reads_what_a_game_wrote_and_refuses_what_is_past_the_end() {
        let fake = FakeMemory::new("read", 5000);
        fake.write(0, &42i32.to_le_bytes());
        fake.write(100, &1.5f32.to_le_bytes());
        fake.write(200, &"Monza".encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>());
        let mapping = Mapping::open(&fake.name).expect("opens");
        assert_eq!(mapping.len(), 8192, "5000 bytes are rounded up to two pages");
        let bytes = mapping.read(0, 400).unwrap();
        let page = Page(&bytes);
        assert_eq!(page.i32_at(0), 42);
        assert_eq!(page.f32_at(100), 1.5);
        assert_eq!(page.utf16_at(200, 15), "Monza");
        assert!(mapping.read(8000, 400).is_none());
        assert!(mapping.read(usize::MAX, 2).is_none());
        // Past the end of a copied page is zero, not a panic.
        assert_eq!(
            (page.i32_at(10_000), page.f32_at(10_000), page.utf16_at(10_000, 4)),
            (0, 0.0, String::new())
        );
    }

    #[test]
    fn the_mapping_is_read_only_a_game_keeps_its_own_memory() {
        let fake = FakeMemory::new("ro", 4096);
        let mapping = Mapping::open(&fake.name).unwrap();
        fake.write(0, &7i32.to_le_bytes());
        assert_eq!(
            Page(&mapping.read(0, 4).unwrap()).i32_at(0),
            7,
            "the reader sees what the game writes afterwards"
        );
    }
}
