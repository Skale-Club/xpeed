//! The small pieces of Windows the app needs: text conversion, questions on screen, opening links and folders,
//! starting with Windows, running only once, and a terminal for the command line.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, ERROR_SUCCESS, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
use windows_sys::Win32::System::Console::{
    AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONERROR, MB_ICONQUESTION, MB_OK, MB_TOPMOST, MB_YESNO, SW_SHOWNORMAL,
};

/// UTF-16, with the zero Windows wants at the end.
pub fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain(Some(0)).collect()
}

/// Copies `text` into a fixed buffer (a tray tooltip, a balloon), cut to fit and always ending in zero.
pub fn fill<const N: usize>(buffer: &mut [u16; N], text: &str) {
    buffer.fill(0);
    for (slot, unit) in buffer.iter_mut().take(N - 1).zip(text.encode_utf16()) {
        *slot = unit;
    }
}

pub fn ask_yes_no(title: &str, text: &str) -> bool {
    // The "no" button is the default: pressing Enter never connects anything.
    unsafe {
        MessageBoxW(
            null_mut(),
            wide(text).as_ptr(),
            wide(title).as_ptr(),
            MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_TOPMOST,
        ) == IDYES
    }
}

pub fn tell_error(title: &str, text: &str) {
    unsafe {
        MessageBoxW(
            null_mut(),
            wide(text).as_ptr(),
            wide(title).as_ptr(),
            MB_OK | MB_ICONERROR | MB_TOPMOST,
        );
    }
}

/// Opens a web address or a folder with whatever Windows uses for it.
pub fn open(target: &str) {
    unsafe {
        ShellExecuteW(
            null_mut(),
            wide("open").as_ptr(),
            wide(target).as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        );
    }
}

pub const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
pub const RUN_NAME: &str = "Xpeed Sim";

/// Whether `name` is set under the per-user "start with Windows" key `key`.
pub fn autostart_enabled(key: &str, name: &str) -> bool {
    unsafe {
        let mut handle: HKEY = null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, wide(key).as_ptr(), 0, KEY_READ, &mut handle) != ERROR_SUCCESS {
            return false;
        }
        let present = RegQueryValueExW(handle, wide(name).as_ptr(), null(), null_mut(), null_mut(), null_mut()) == ERROR_SUCCESS;
        RegCloseKey(handle);
        present
    }
}

/// Starts (or stops) `exe run` with Windows for this person only; no administrator needed.
pub fn set_autostart(key: &str, name: &str, on: bool, exe: &Path) -> Result<(), String> {
    unsafe {
        let mut handle: HKEY = null_mut();
        let opened = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            wide(key).as_ptr(),
            0,
            null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            null(),
            &mut handle,
            null_mut(),
        );
        if opened != ERROR_SUCCESS {
            return Err(format!("cannot open the start-up list (error {opened})"));
        }
        let result = if on {
            let command = wide(&format!("\"{}\" run", exe.display()));
            RegSetValueExW(
                handle,
                wide(name).as_ptr(),
                0,
                REG_SZ,
                command.as_ptr().cast(),
                (command.len() * 2) as u32,
            )
        } else {
            // Not being there is the same as being off.
            let removed = RegDeleteValueW(handle, wide(name).as_ptr());
            if removed == 2 {
                ERROR_SUCCESS
            } else {
                removed
            }
        };
        RegCloseKey(handle);
        if result == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("cannot change the start-up list (error {result})"))
        }
    }
}

/// Holds the right to be the one running copy; letting go (dropping) frees it.
pub struct Instance(HANDLE);

impl Drop for Instance {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// `Some` for the first copy under this name, `None` when another is already running.
pub fn single_instance(name: &str) -> Option<Instance> {
    unsafe {
        let handle = CreateMutexW(null(), 0, wide(name).as_ptr());
        if handle.is_null() {
            return None;
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(handle);
            return None;
        }
        Some(Instance(handle))
    }
}

/// The program has no console of its own (it is a tray app), so a command typed in a terminal borrows that
/// terminal's. When the output already goes somewhere (a file, a pipe) it is left alone.
pub fn attach_terminal() {
    unsafe {
        let has = |which| {
            let handle = GetStdHandle(which);
            !handle.is_null() && handle != INVALID_HANDLE_VALUE
        };
        if has(STD_OUTPUT_HANDLE) && has(STD_ERROR_HANDLE) {
            return;
        }
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return;
        }
        let console = CreateFileW(
            wide("CONOUT$").as_ptr(),
            0x4000_0000, /* GENERIC_WRITE */
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            0,
            null_mut(),
        );
        if console != INVALID_HANDLE_VALUE {
            if !has(STD_OUTPUT_HANDLE) {
                SetStdHandle(STD_OUTPUT_HANDLE, console);
            }
            if !has(STD_ERROR_HANDLE) {
                SetStdHandle(STD_ERROR_HANDLE, console);
            }
        }
    }
}

/// The names of the programs running right now, in lower case (`xpeed-sim.exe`, `f1_25.exe`...). Only names: nothing
/// of what the programs do or hold is looked at.
pub fn running_programs() -> Vec<String> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut names = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return names;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let end = entry.szExeFile.iter().position(|&u| u == 0).unwrap_or(entry.szExeFile.len());
            names.push(String::from_utf16_lossy(&entry.szExeFile[..end]).to_lowercase());
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    names
}

/// Whether any of `wanted` (lower case) is among the running programs.
pub fn any_running(running: &[String], wanted: &[&str]) -> bool {
    wanted.iter().any(|w| running.iter().any(|r| r == w))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_text_for_windows_with_the_closing_zero() {
        assert_eq!(wide("Aé"), vec![65, 233, 0]);
        assert_eq!(wide(""), vec![0]);
    }

    #[test]
    fn fills_a_fixed_buffer_and_always_ends_it() {
        let mut buffer = [9u16; 6];
        fill(&mut buffer, "abc");
        assert_eq!(buffer, [97, 98, 99, 0, 0, 0]);
        fill(&mut buffer, "abcdefghij");
        assert_eq!(buffer, [97, 98, 99, 100, 101, 0], "cut to fit, never without the zero");
    }

    #[test]
    fn starts_with_windows_only_under_a_key_the_test_owns() {
        let key = format!("Software\\XpeedSimTest{}", std::process::id());
        let exe = Path::new("C:\\Program Files\\Xpeed Sim\\xpeed-sim.exe");
        assert!(!autostart_enabled(&key, RUN_NAME));
        set_autostart(&key, RUN_NAME, true, exe).unwrap();
        assert!(autostart_enabled(&key, RUN_NAME));
        set_autostart(&key, RUN_NAME, false, exe).unwrap();
        assert!(!autostart_enabled(&key, RUN_NAME));
        // Turning it off when it is already off is fine.
        set_autostart(&key, RUN_NAME, false, exe).unwrap();
        unsafe {
            windows_sys::Win32::System::Registry::RegDeleteKeyW(HKEY_CURRENT_USER, wide(&key).as_ptr());
        }
    }

    #[test]
    fn lists_the_running_programs_by_name_and_finds_this_one() {
        let running = running_programs();
        assert!(!running.is_empty());
        let me = std::env::current_exe()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_lowercase();
        assert!(any_running(&running, &[me.as_str()]), "{me} not in the list");
        assert!(any_running(&running, &["no-such-game.exe", me.as_str()]));
        assert!(!any_running(&running, &["no-such-game.exe"]));
        assert!(!any_running(&[], &["f1_25.exe"]));
    }

    #[test]
    fn only_one_copy_of_a_name_runs_at_a_time() {
        let name = format!("Local\\XpeedSimTest{}", std::process::id());
        let first = single_instance(&name).expect("the first copy runs");
        assert!(single_instance(&name).is_none(), "the second is turned away");
        drop(first);
        assert!(single_instance(&name).is_some(), "and the name is free again afterwards");
    }
}
