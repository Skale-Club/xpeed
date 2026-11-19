//! The text of the Windows resource script that gives `xpeed-companion.exe` its icon, its version info and its
//! application manifest. `build.rs` includes this file (std only) to write `app.rc` and `app.manifest`; the program's
//! tests include it too, so the text is checked.

/// The application manifest. It asks for version 6 of Windows' common controls, the ones with visual styles: without
/// it every native control (the Coach window's buttons, edits and lists, the tray menu, message boxes) is drawn the
/// old way, grey and bevelled. It also says the program runs as the user who starts it, never elevated.
pub const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
</assembly>
"#;

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

/// The `.rc` text: icon number 1 (the first icon, the one Explorer and the taskbar pick) from `icon_path`, the
/// manifest (resource 1 of type 24, `RT_MANIFEST`, the one Windows reads for an .exe) from `manifest_path`, and the
/// version block for `version`.
pub fn resource_script(version: &str, icon_path: &str, manifest_path: &str) -> String {
    let [a, b, c, d] = version_numbers(version);
    let numbers = format!("{a},{b},{c},{d}");
    // Backslashes are escapes inside an .rc string.
    let icon = icon_path.replace('\\', "\\\\");
    let manifest = manifest_path.replace('\\', "\\\\");
    let lines = [
        format!("1 ICON \"{icon}\""),
        format!("1 24 \"{manifest}\""),
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
        "      VALUE \"InternalName\", \"xpeed-companion\"".to_owned(),
        // \251 is the copyright sign in the code page the resource compiler reads by default (Latin-1).
        "      VALUE \"LegalCopyright\", \"\\251 Skale Club\"".to_owned(),
        "      VALUE \"OriginalFilename\", \"xpeed-companion.exe\"".to_owned(),
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
        let rc = resource_script("0.2.0", r"C:\out dir\xpeed.ico", r"C:\out dir\app.manifest");
        assert!(rc.contains("FILEVERSION 0,2,0,0"));
        assert!(rc.contains("PRODUCTVERSION 0,2,0,0"));
        assert!(rc.contains("VALUE \"FileVersion\", \"0.2.0\""));
        assert!(rc.contains("VALUE \"ProductVersion\", \"0.2.0\""));
        assert!(rc.contains("BLOCK \"040904b0\""));
        assert!(rc.contains("VALUE \"CompanyName\", \"Skale Club\""));
        assert!(rc.contains("VALUE \"FileDescription\", \"Xpeed Companion\""));
        assert!(rc.contains("VALUE \"ProductName\", \"Xpeed Companion\""));
        assert!(rc.contains("VALUE \"OriginalFilename\", \"xpeed-companion.exe\""));
        assert!(rc.contains("VALUE \"InternalName\", \"xpeed-companion\""));
        assert!(rc.contains("VALUE \"Translation\", 0x409, 1200"));
    }

    #[test]
    fn the_icon_is_resource_number_one_with_its_path_escaped() {
        let rc = resource_script("0.2.0", r"C:\out dir\xpeed.ico", r"C:\out dir\app.manifest");
        assert!(rc.starts_with("1 ICON \"C:\\\\out dir\\\\xpeed.ico\""));
    }

    #[test]
    fn the_manifest_is_resource_one_of_type_24_and_asks_for_the_styled_common_controls() {
        let rc = resource_script("0.2.0", r"C:\out dir\xpeed.ico", r"C:\out dir\app.manifest");
        assert!(rc.contains("\r\n1 24 \"C:\\\\out dir\\\\app.manifest\"\r\n"));
        assert!(MANIFEST.contains(r#"name="Microsoft.Windows.Common-Controls" version="6.0.0.0""#));
        assert!(MANIFEST.contains(r#"publicKeyToken="6595b64144ccf1df""#));
        assert!(MANIFEST.contains(r#"level="asInvoker""#));
    }
}
