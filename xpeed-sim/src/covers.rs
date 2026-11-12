//! Game covers for the panel's waiting screen, taken from the art Steam already keeps on this computer for the games
//! in the person's library (`<Steam>\appcache\librarycache\<app id>`). Nothing is downloaded and no art ships with the
//! program: a game Steam has no art for here (or iRacing, which is not sold on Steam) is shown by its name.

use std::path::{Path, PathBuf};

/// The games Xpeed Sim reads, in the order the waiting screen shows them, with their Steam app id. The ids were
/// checked against the games' own Steam manifests (`appmanifest_<id>.acf`), except iRacing's (266410, its Steam
/// store id), which only finds art when iRacing is in the person's Steam library.
pub const GAMES: &[(&str, u32)] = &[
    ("Le Mans Ultimate", 2_399_420),
    ("Assetto Corsa", 244_210),
    ("Assetto Corsa Competizione", 805_550),
    ("Assetto Corsa EVO", 3_058_630),
    ("Assetto Corsa Rally", 3_917_090),
    ("Automobilista 2", 1_066_890),
    ("F1 25", 3_059_520),
    ("Wreckfest 2", 1_203_190),
    ("Stock Car Extreme", 273_840),
    ("iRacing", 266_410),
];

/// The portrait cover of a game in Steam's library cache, if Steam has one: newer Steam keeps it in a hashed
/// sub-folder (`library_600x900.jpg` or `library_capsule.jpg`), older Steam next to the others or at the top level.
pub fn cover_file(cache: &Path, app: u32) -> Option<PathBuf> {
    if app == 0 {
        return None;
    }
    let folder = cache.join(app.to_string());
    let names = ["library_600x900.jpg", "library_capsule.jpg"];
    for name in names {
        let direct = folder.join(name);
        if direct.is_file() {
            return Some(direct);
        }
    }
    if let Ok(entries) = std::fs::read_dir(&folder) {
        let mut found: Vec<(std::time::SystemTime, PathBuf)> = entries
            .flatten()
            .filter(|e| e.path().is_dir())
            .flat_map(|e| names.map(|n| e.path().join(n)))
            .filter(|p| p.is_file())
            .map(|p| (std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), p))
            .collect();
        // The newest, when Steam kept more than one.
        found.sort();
        if let Some((_, path)) = found.pop() {
            return Some(path);
        }
    }
    let old = cache.join(format!("{app}_library_600x900.jpg"));
    old.is_file().then_some(old)
}

/// Steam's library cache on this computer, from where Steam says it is installed.
#[cfg(windows)]
pub fn library_cache() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let mut buffer = [0u16; 520];
    let mut size = (buffer.len() * 2) as u32;
    let found = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            crate::win::wide("Software\\Valve\\Steam").as_ptr(),
            crate::win::wide("SteamPath").as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    } == 0;
    if !found {
        return None;
    }
    let end = buffer.iter().position(|&u| u == 0).unwrap_or(buffer.len());
    let cache = PathBuf::from(String::from_utf16_lossy(&buffer[..end]))
        .join("appcache")
        .join("librarycache");
    cache.is_dir().then_some(cache)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_cover_wherever_this_steam_keeps_it() {
        let cache = crate::config::scratch_dir("covers");
        // Newer Steam: in a hashed folder.
        let hashed = cache.join("244210").join("c35922c4");
        std::fs::create_dir_all(&hashed).unwrap();
        std::fs::write(hashed.join("library_capsule.jpg"), b"jpg").unwrap();
        assert_eq!(cover_file(&cache, 244_210), Some(hashed.join("library_capsule.jpg")));
        // Next to the others.
        let flat = cache.join("805550");
        std::fs::create_dir_all(&flat).unwrap();
        std::fs::write(flat.join("library_600x900.jpg"), b"jpg").unwrap();
        assert_eq!(cover_file(&cache, 805_550), Some(flat.join("library_600x900.jpg")));
        // Older Steam: at the top.
        std::fs::write(cache.join("273840_library_600x900.jpg"), b"jpg").unwrap();
        assert_eq!(cover_file(&cache, 273_840), Some(cache.join("273840_library_600x900.jpg")));
        // Nothing for a game not in the library, or not on Steam.
        assert_eq!(cover_file(&cache, 1_066_890), None);
        assert_eq!(cover_file(&cache, 0), None);
    }

    #[test]
    fn lists_every_game_once() {
        let mut ids: Vec<u32> = GAMES.iter().map(|(_, id)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), GAMES.len());
    }
}
