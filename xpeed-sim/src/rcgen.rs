//! The text of the Windows resource script that gives `xpeed-sim.exe` its icon and its version info. `build.rs`
//! includes this file (std only) to write `app.rc`; the program's tests include it too, so the text is checked.

/// The version as the four numbers of a Windows file version: `0.2.0` is `0, 2, 0, 0`. A suffix such as
/// `-beta` is ignored; anything missing or unreadable counts as 0.
pub fn version_numbers(version: &str) -> [u16; 4] {
    let core = version.split(['-', '+']).next().unwrap_or("");
    let mut numbers = [0u16; 4];
    for (slot, part) in numbers.iter_mut().zip(core.split('.')) {
        *slot = part.trim().parse().unwrap_or(0);
    }
    numbers
}

/// The `.rc` text: icon number 1 (the first icon, the one Explorer and the taskbar pick) from `icon_path`, and the
/// version block for `version`.
pub fn resource_script(version: &str, icon_path: &str) -> String {
    let [a, b, c, d] = version_numbers(version);
    let numbers = format!("{a},{b},{c},{d}");
    // Backslashes are escapes inside an .rc string.
    let icon = icon_path.replace('\\', "\\\\");
    let lines = [
        format!("1 ICON \"{icon}\""),
        String::new(),
        "1 VERSIONINFO".to_owned(),
        format!("FILEVERSION {numbers}"),
        format!("PRODUCTVERSION {numbers}"),
        "FILEOS 0x4".to_owned(),
        "FILETYPE 0x1".to_owned(),
        "BEGIN".to_owned(),
        "  BLOCK \"StringFileInfo\"".to_owned(),
        "  BEGIN".to_owned(),
        "    BLOCK \"040904b0\"".to_owned(),
        "    BEGIN".to_owned(),
        "      VALUE \"CompanyName\", \"Skale Club\"".to_owned(),
        "      VALUE \"FileDescription\", \"Xpeed Companion\"".to_owned(),
        format!("      VALUE \"FileVersion\", \"{version}\""),
        "      VALUE \"InternalName\", \"xpeed-sim\"".to_owned(),
        // \251 is the copyright sign in the code page the resource compiler reads by default (Latin-1).
        "      VALUE \"LegalCopyright\", \"\\251 Skale Club\"".to_owned(),
        "      VALUE \"OriginalFilename\", \"xpeed-sim.exe\"".to_owned(),
        "      VALUE \"ProductName\", \"Xpeed Companion\"".to_owned(),
        format!("      VALUE \"ProductVersion\", \"{version}\""),
        "    END".to_owned(),
        "  END".to_owned(),
        "  BLOCK \"VarFileInfo\"".to_owned(),
        "  BEGIN".to_owned(),
        "    VALUE \"Translation\", 0x409, 1200".to_owned(),
        "  END".to_owned(),
        "END".to_owned(),
    ];
    lines.join("\r\n") + "\r\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_splits_into_the_four_numbers_of_a_file_version() {
        assert_eq!(version_numbers("0.2.0"), [0, 2, 0, 0]);
        assert_eq!(version_numbers("1.12.345"), [1, 12, 345, 0]);
        assert_eq!(version_numbers("2.0.1-beta.1"), [2, 0, 1, 0]);
        assert_eq!(version_numbers("3"), [3, 0, 0, 0]);
        assert_eq!(version_numbers("x.y"), [0, 0, 0, 0]);
    }

    #[test]
    fn the_version_info_text_carries_the_version_and_the_product_names() {
        let rc = resource_script("0.2.0", r"C:\out dir\xpeed.ico");
        assert!(rc.contains("FILEVERSION 0,2,0,0"));
        assert!(rc.contains("PRODUCTVERSION 0,2,0,0"));
        assert!(rc.contains("VALUE \"FileVersion\", \"0.2.0\""));
        assert!(rc.contains("VALUE \"ProductVersion\", \"0.2.0\""));
        assert!(rc.contains("BLOCK \"040904b0\""));
        assert!(rc.contains("VALUE \"CompanyName\", \"Skale Club\""));
        assert!(rc.contains("VALUE \"FileDescription\", \"Xpeed Companion\""));
        assert!(rc.contains("VALUE \"ProductName\", \"Xpeed Companion\""));
        assert!(rc.contains("VALUE \"OriginalFilename\", \"xpeed-sim.exe\""));
        assert!(rc.contains("VALUE \"InternalName\", \"xpeed-sim\""));
        assert!(rc.contains("VALUE \"Translation\", 0x409, 1200"));
    }

    #[test]
    fn the_icon_is_resource_number_one_with_its_path_escaped() {
        let rc = resource_script("0.2.0", r"C:\out dir\xpeed.ico");
        assert!(rc.starts_with("1 ICON \"C:\\\\out dir\\\\xpeed.ico\""));
    }
}
