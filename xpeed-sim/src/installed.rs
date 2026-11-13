//! Which of the games Xpeed Companion reads are installed on this computer, so the panel lists only those: from Steam's
//! libraries (the game's `appmanifest_<id>.acf` in one of the folders Steam's `libraryfolders.vdf` lists) and from
//! Windows' list of installed programs (for games installed outside Steam, such as iRacing or the EA app's F1) and
//! from Windows' list of installed Store packages (the Forza games from the Microsoft Store / Xbox app).
//! Read when the panel opens and when it comes back to the front; nothing leaves the computer.

use std::collections::HashSet;
use std::path::PathBuf;

/// Each game: its key (as in `covers::GAMES` and the laps), its Steam app id, the names Windows' list of programs
/// may give it (compared after `normalize`), and the names of its Microsoft Store packages (the part of the
/// package's full name before the first `_`, in lower case; see `package_name`).
///
/// Package names (the "package family name" without the `_8wekyb3d8bbwe` publisher part), each taken from the
/// `%LOCALAPPDATA%\Packages\<name>_8wekyb3d8bbwe` save folder that players' guides quote:
/// * `Microsoft.SunriseBaseGame`: Forza Horizon 4 ("Sunrise" is its code name). Microsoft Q&A answers use
///   `Get-AppxPackage *SunriseBaseGame*` for it; gamepretty.com's "Forza Horizon 4: Save File Location (MS Store &
///   Steam)" gives `Microsoft.SunriseBaseGame_8wekyb3d8bbwe`.
/// * `Microsoft.624F8B84B80`: Forza Horizon 5 (wotpack.ru's save-location guide:
///   `%localappdata%\Packages\Microsoft.624F8B84B80_8wekyb3d8bbwe\SystemAppData\wgs`).
/// * `Microsoft.ApolloBaseGame`: Forza Motorsport 7 ("Apollo"; MiniTool's "Forza Motorsport 7 save game location":
///   `%LOCALAPPDATA%\Packages\Microsoft.ApolloBaseGame_8wekyb3d8bbwe\SystemAppData\wgs`).
/// * `Microsoft.ForzaMotorsport`: Forza Motorsport (2023) (PCGamingWiki's Forza Motorsport page, Microsoft Store
///   save path `%LOCALAPPDATA%\Packages\Microsoft.ForzaMotorsport_8wekyb3d8bbwe\LocalCache\...`).
///
/// No package name could be sourced for Forza Horizon 6, so it is found only through Steam or the program list.
/// The EA app's F1 games have no sourced registry key of their own; they are found by the EA app's entry in the
/// program list (the names below), as before.
const GAMES: &[(&str, u32, &[&str], &[&str])] = &[
    ("lmu", 2_399_420, &["le mans ultimate"], &[]),
    ("ac", 244_210, &["assetto corsa"], &[]),
    ("acc", 805_550, &["assetto corsa competizione"], &[]),
    ("acevo", 3_058_630, &["assetto corsa evo"], &[]),
    ("acr", 3_917_090, &["assetto corsa rally"], &[]),
    ("ams2", 1_066_890, &["automobilista 2"], &[]),
    ("pcars2", 378_860, &["project cars 2"], &[]),
    ("pcars3", 958_400, &["project cars 3"], &[]),
    ("f1", 3_059_520, &["f1 25", "ea sports f1 25"], &[]),
    ("f124", 2_488_620, &["f1 24", "ea sports f1 24"], &[]),
    ("f123", 2_108_330, &["f1 23", "ea sports f1 23"], &[]),
    ("wreckfest2", 1_203_190, &["wreckfest 2"], &[]),
    ("rfactor1", 273_840, &["stock car extreme", "game stock car extreme"], &[]),
    ("ams1", 431_600, &["automobilista"], &[]),
    ("rf1", 339_790, &["rfactor"], &[]),
    ("r3e", 211_500, &["raceroom racing experience", "raceroom"], &[]),
    ("fm", 2_440_510, &["forza motorsport"], &["microsoft.forzamotorsport"]),
    // Only on the Microsoft Store (no Steam id): found by package, or by name when Windows lists it.
    ("fm7", 0, &["forza motorsport 7"], &["microsoft.apollobasegame"]),
    ("fh4", 1_293_830, &["forza horizon 4"], &["microsoft.sunrisebasegame"]),
    ("fh5", 1_551_360, &["forza horizon 5"], &["microsoft.624f8b84b80"]),
    // Steam app 2483190 (SteamDB / PCGamingWiki); the Store package name is not sourced.
    ("fh6", 2_483_190, &["forza horizon 6"], &[]),
    (
        "iracing",
        266_410,
        &["iracing", "iracing simulator", "iracing.com racing simulation"],
        &[],
    ),
];

/// The keys of the games found installed here.
pub fn keys() -> HashSet<&'static str> {
    found(&steam_libraries(), &program_names(), &package_names())
}

/// `libraries`: Steam's folders; `programs`: names in Windows' list of programs; `packages`: the full names of the
/// installed Store packages (as `package_names` lists them).
fn found(libraries: &[PathBuf], programs: &[String], packages: &[String]) -> HashSet<&'static str> {
    let programs: Vec<String> = programs.iter().map(|name| normalize(name)).collect();
    let packages: Vec<String> = packages.iter().map(|full| package_name(full)).collect();
    GAMES
        .iter()
        .filter(|(_, app, names, package_list)| {
            libraries
                .iter()
                .any(|library| library.join("steamapps").join(format!("appmanifest_{app}.acf")).is_file())
                || programs.iter().any(|program| names.contains(&program.as_str()))
                || packages.iter().any(|package| package_list.contains(&package.as_str()))
        })
        .map(|(key, _, _, _)| *key)
        .collect()
}

/// A Store package's name, in lower case, from its full name `<Name>_<version>_<arch>_<resource id>_<publisher id>`
/// (for example `Microsoft.SunriseBaseGame_1.332.904.2_x64__8wekyb3d8bbwe` gives `microsoft.sunrisebasegame`). Names
/// have no `_`, so the name ends at the first one.
fn package_name(full_name: &str) -> String {
    full_name.split('_').next().unwrap_or_default().to_lowercase()
}

/// A program's name as compared: lower case, without trademark signs, single spaces.
fn normalize(name: &str) -> String {
    let plain: String = name.chars().filter(|c| !matches!(c, '®' | '™' | '©')).collect();
    plain.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The folders Steam's `libraryfolders.vdf` lists (lines like `"path"  "F:\\SteamLibrary"`).
fn library_paths(vdf: &str) -> Vec<PathBuf> {
    vdf.lines()
        .filter_map(|line| {
            let mut parts = line.split('"').filter(|part| !part.trim().is_empty());
            if parts.next()? != "path" {
                return None;
            }
            parts.next().map(|path| PathBuf::from(path.replace("\\\\", "\\")))
        })
        .collect()
}

/// Steam's own folder and the other libraries it lists.
fn steam_libraries() -> Vec<PathBuf> {
    let Some(steam) = steam_path() else { return Vec::new() };
    let vdf = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf")).unwrap_or_default();
    let mut libraries = vec![steam];
    libraries.extend(library_paths(&vdf));
    libraries
}

#[cfg(windows)]
fn steam_path() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
    registry_text(HKEY_CURRENT_USER, "Software\\Valve\\Steam", "SteamPath").map(PathBuf::from)
}

#[cfg(not(windows))]
fn steam_path() -> Option<PathBuf> {
    None
}

/// A text value of the registry.
#[cfg(windows)]
fn registry_text(root: windows_sys::Win32::System::Registry::HKEY, key: &str, value: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};
    let mut buffer = [0u16; 520];
    let mut size = (buffer.len() * 2) as u32;
    let found = unsafe {
        RegGetValueW(
            root,
            crate::win::wide(key).as_ptr(),
            crate::win::wide(value).as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    } == 0;
    let end = buffer.iter().position(|&u| u == 0).unwrap_or(buffer.len());
    found
        .then(|| String::from_utf16_lossy(&buffer[..end]))
        .filter(|text| !text.is_empty())
}

/// The names in Windows' list of installed programs (both registry views, and this user's).
#[cfg(windows)]
fn program_names() -> Vec<String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ,
    };
    let places = [
        (HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
        (
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
        (HKEY_CURRENT_USER, "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
    ];
    let mut names = Vec::new();
    for (root, path) in places {
        let mut key = std::ptr::null_mut();
        if unsafe { RegOpenKeyExW(root, crate::win::wide(path).as_ptr(), 0, KEY_READ, &mut key) } != 0 {
            continue;
        }
        for index in 0.. {
            let mut name = [0u16; 256];
            let mut len = name.len() as u32;
            let listed = unsafe {
                RegEnumKeyExW(
                    key,
                    index,
                    name.as_mut_ptr(),
                    &mut len,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if listed != 0 {
                break;
            }
            let sub = String::from_utf16_lossy(&name[..len as usize]);
            if let Some(display) = registry_text(key, &sub, "DisplayName") {
                names.push(display);
            }
        }
        unsafe {
            RegCloseKey(key);
        }
    }
    names
}

#[cfg(not(windows))]
fn program_names() -> Vec<String> {
    Vec::new()
}

/// The full names of the Store (packaged) apps installed for this user: one sub-key per package under
/// `HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages`,
/// named `<Name>_<version>_<arch>__<publisher id>`. This is the package repository the Appx deployment service keeps
/// (the list `Get-AppxPackage` shows); the full-name format is in Microsoft's "Package identity overview"
/// (<https://learn.microsoft.com/windows/apps/desktop/modernize/package-identity-overview>). Nothing is run: only
/// the key names are read.
#[cfg(windows)]
fn package_names() -> Vec<String> {
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY_CURRENT_USER, KEY_READ};
    let path = "Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";
    let mut names = Vec::new();
    let mut key = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, crate::win::wide(path).as_ptr(), 0, KEY_READ, &mut key) } != 0 {
        return names;
    }
    for index in 0.. {
        let mut name = [0u16; 256];
        let mut len = name.len() as u32;
        let listed = unsafe {
            RegEnumKeyExW(
                key,
                index,
                name.as_mut_ptr(),
                &mut len,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if listed != 0 {
            break;
        }
        names.push(String::from_utf16_lossy(&name[..len as usize]));
    }
    unsafe {
        RegCloseKey(key);
    }
    names
}

#[cfg(not(windows))]
fn package_names() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_libraries_steam_lists() {
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t\t\"apps\"\n\t\t{\n\t\t\t\"244210\"\t\t\"1\"\n\t\t}\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"F:\\\\SteamLibrary\"\n\t}\n}\n";
        assert_eq!(
            library_paths(vdf),
            [PathBuf::from("C:\\Program Files (x86)\\Steam"), PathBuf::from("F:\\SteamLibrary")]
        );
        assert!(library_paths("").is_empty());
    }

    #[test]
    fn finds_steam_games_by_manifest_and_others_by_program_name() {
        let library = crate::config::scratch_dir("installed-steam");
        std::fs::create_dir_all(library.join("steamapps")).unwrap();
        std::fs::write(library.join("steamapps").join("appmanifest_805550.acf"), b"\"AppState\"{}").unwrap();
        std::fs::write(library.join("steamapps").join("appmanifest_1066890.acf"), b"\"AppState\"{}").unwrap();
        let programs = [
            "iRacing Simulator".to_owned(),
            "F1® 25".to_owned(),
            "Assetto Corsa Ultimate Edition".to_owned(),
        ];
        let keys = found(&[library], &programs, &[]);
        let mut keys: Vec<&str> = keys.into_iter().collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["acc", "ams2", "f1", "iracing"],
            "a name that only starts like a game is not that game"
        );
        assert!(found(&[], &[], &[]).is_empty());
    }

    #[test]
    fn finds_store_games_by_package_name() {
        let packages = [
            "Microsoft.SunriseBaseGame_1.332.904.2_x64__8wekyb3d8bbwe".to_owned(),
            "Microsoft.624F8B84B80_3.614.70.0_x64__8wekyb3d8bbwe".to_owned(),
            "Microsoft.ApolloBaseGame_7.0.0.0_x64__8wekyb3d8bbwe".to_owned(),
            "Microsoft.ForzaMotorsport_1.0.0.0_x64__8wekyb3d8bbwe".to_owned(),
            "Microsoft.WindowsCalculator_11.2.0.0_x64__8wekyb3d8bbwe".to_owned(),
        ];
        let mut keys: Vec<&str> = found(&[], &[], &packages).into_iter().collect();
        keys.sort_unstable();
        assert_eq!(keys, ["fh4", "fh5", "fm", "fm7"]);
        // A name that only starts like a game's package is not that game.
        let other = [
            "Microsoft.SunriseBaseGameTools_1.0_x64__8wekyb3d8bbwe".to_owned(),
            "plain".to_owned(),
            String::new(),
        ];
        assert!(found(&[], &[], &other).is_empty());
        assert_eq!(
            package_name("Microsoft.SunriseBaseGame_1.332.904.2_x64__8wekyb3d8bbwe"),
            "microsoft.sunrisebasegame"
        );
        assert_eq!(package_name(""), "");
    }

    /// What this computer has installed: `cargo test what_is_installed_here -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn what_is_installed_here() {
        let mut keys: Vec<&str> = keys().into_iter().collect();
        keys.sort_unstable();
        println!("libraries: {:?}", steam_libraries());
        let packages = package_names();
        let forza: Vec<&String> = packages.iter().filter(|p| p.to_lowercase().contains("forza")).collect();
        println!("store packages listed: {}, forza ones: {forza:?}", packages.len());
        println!("installed: {keys:?}");
    }

    #[test]
    fn knows_every_game_the_covers_know() {
        let mut ours: Vec<&str> = GAMES.iter().map(|(key, _, _, _)| *key).collect();
        let mut covers: Vec<&str> = crate::covers::GAMES.iter().map(|(key, _)| *key).collect();
        ours.sort_unstable();
        covers.sort_unstable();
        assert_eq!(ours, covers);
        assert_eq!(normalize("  F1®   25 "), "f1 25");
    }
}
