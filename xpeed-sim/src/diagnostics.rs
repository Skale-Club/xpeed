//! The text the Monitor tab's "Copy diagnostics" button puts on the clipboard, for a support request: the version and
//! build, the Windows version, the games and how each reader stands, the connection (the server and the account, never
//! the device key), the end of the log, and how many laps are on disk and waiting to be sent.
//!
//! `diagnostics_text` is pure: everything it shows is handed in, so it can be tested. It takes no key, and it also
//! blanks anything in the log that looks like one, in case a line ever carried it.

use std::path::Path;

use crate::status::Cloud;

/// How many lines of the end of the log go into the text.
pub const LOG_LINES: usize = 40;

/// Everything the text shows.
pub struct Input<'a> {
    pub version: &'a str,
    pub build: &'a str,
    pub windows: &'a str,
    /// The games found here and each reader's state in words: `(game, state)`.
    pub games: &'a [(String, String)],
    /// The background parts that have reported: `(name, state)`.
    pub workers: &'a [(String, String)],
    pub cloud: &'a Cloud,
    /// The server as the program keeps it (`https://host`); only the host is written.
    pub server: &'a str,
    pub account: Option<&'a str>,
    pub device: Option<&'a str>,
    /// The log's lines, oldest first (the whole file is fine: the end is taken here).
    pub log: &'a [String],
    pub laps_bytes: u64,
    pub laps_files: usize,
    /// Laps in the folder that have not been sent to the server yet.
    pub laps_waiting: usize,
}

/// How the cloud side stands, in words for the support text.
pub fn connection_word(cloud: &Cloud) -> String {
    match cloud {
        Cloud::NotPaired => "not connected".into(),
        Cloud::Idle => "connected, everything sent".into(),
        Cloud::Waiting(n) => format!("connected, {n} item(s) waiting to be sent"),
        Cloud::Refused => "the account no longer accepts this computer's key".into(),
    }
}

/// The Windows version in words from the pieces the registry holds (`Windows 11 Home 24H2 (build 26200.1234)`). Windows 11
/// still calls itself "Windows 10" in `ProductName`; the build number (22000 and up) tells the truth.
pub fn windows_name(product: Option<&str>, display: Option<&str>, build: Option<&str>, ubr: Option<u32>) -> String {
    let build_number = build.and_then(|b| b.trim().parse::<u32>().ok());
    let mut name = product.map(str::trim).filter(|p| !p.is_empty()).unwrap_or("Windows").to_owned();
    if build_number.is_some_and(|b| b >= 22000) {
        if let Some(rest) = name.strip_prefix("Windows 10") {
            name = format!("Windows 11{rest}");
        }
    }
    if let Some(display) = display.map(str::trim).filter(|d| !d.is_empty()) {
        name = format!("{name} {display}");
    }
    match (build.map(str::trim).filter(|b| !b.is_empty()), ubr) {
        (Some(build), Some(ubr)) => format!("{name} (build {build}.{ubr})"),
        (Some(build), None) => format!("{name} (build {build})"),
        _ => name,
    }
}

/// `12.3 MB`, `640 KB`, `0 B`.
fn size_text(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b >= KB * KB * KB {
        format!("{:.1} GB", b / (KB * KB * KB))
    } else if b >= KB * KB {
        format!("{:.1} MB", b / (KB * KB))
    } else if b >= KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

/// Blanks anything that looks like a device key (`xpd_` and what follows it) in a line.
pub fn scrub(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(at) = rest.find("xpd_") {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 4..];
        let key_len = tail
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .count();
        if key_len >= 8 {
            out.push_str("xpd_<hidden>");
        } else {
            out.push_str(&rest[at..at + 4 + key_len]);
        }
        rest = &tail[key_len..];
    }
    out.push_str(rest);
    out
}

/// The last `LOG_LINES` of the log, each on one line and scrubbed.
fn log_tail(log: &[String]) -> Vec<String> {
    let from = log.len().saturating_sub(LOG_LINES);
    log[from..]
        .iter()
        .map(|line| scrub(line.trim_end()))
        .filter(|line| !line.is_empty())
        .collect()
}

pub fn diagnostics_text(input: &Input) -> String {
    let mut out = String::new();
    let mut line = |text: String| {
        out.push_str(&text);
        out.push('\n');
    };
    line("Xpeed Companion diagnostics".into());
    line(format!("Version: {} (build {})", input.version, input.build));
    line(format!("Windows: {}", input.windows));
    line(String::new());
    line("Games:".into());
    if input.games.is_empty() {
        line("  none detected".into());
    }
    for (game, state) in input.games {
        line(format!("  {game}: {state}"));
    }
    if !input.workers.is_empty() {
        line("Background parts:".into());
        for (name, state) in input.workers {
            line(format!("  {name}: {state}"));
        }
    }
    line(String::new());
    line("Connection:".into());
    line(format!("  State: {}", connection_word(input.cloud)));
    if *input.cloud != Cloud::NotPaired {
        line(format!("  Server: {}", crate::connect::host_of(input.server)));
        if let Some(account) = input.account.filter(|a| !a.is_empty()) {
            line(format!("  Account: {account}"));
        }
        if let Some(device) = input.device.filter(|d| !d.is_empty()) {
            line(format!("  Computer: {device}"));
        }
    }
    line(String::new());
    line(format!(
        "Laps folder: {} in {} file(s); {} lap(s) waiting to be sent",
        size_text(input.laps_bytes),
        input.laps_files,
        input.laps_waiting
    ));
    line(String::new());
    let tail = log_tail(input.log);
    line(format!("Last {} log line(s):", tail.len()));
    for log_line in tail {
        line(log_line);
    }
    out
}

/// The size in bytes and the number of the files under `dir` (nothing is read, only listed).
pub fn folder_size(dir: &Path) -> (u64, usize) {
    let (mut bytes, mut files) = (0u64, 0usize);
    let mut pending = vec![dir.to_path_buf()];
    while let Some(folder) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.filter_map(Result::ok) {
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => pending.push(entry.path()),
                Ok(kind) if kind.is_file() => {
                    bytes += entry.metadata().map_or(0, |m| m.len());
                    files += 1;
                }
                _ => {}
            }
        }
    }
    (bytes, files)
}

/// The log file's lines, oldest first (empty when there is none).
pub fn read_log(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .map(|text| text.lines().map(str::to_owned).collect())
        .unwrap_or_default()
}

/// The text for the machine this runs on, from the shared status and where the program keeps its files.
#[cfg(windows)]
pub fn collect(
    shared: &crate::status::Shared,
    games: &[(String, String)],
    server: &str,
    device: Option<&str>,
    account: Option<&str>,
) -> String {
    let snapshot = shared.snapshot();
    let workers: Vec<(String, String)> = shared
        .workers()
        .into_iter()
        .map(|(id, health)| {
            let state = match health {
                crate::supervisor::Health::Running => "running",
                crate::supervisor::Health::Restarting => "restarting after an error",
                crate::supervisor::Health::Failed => "stopped after repeated errors",
            };
            (crate::supervisor::title(id).to_owned(), state.to_owned())
        })
        .collect();
    let log = crate::config::home_dir()
        .map(|home| read_log(&home.join("companion.log")))
        .unwrap_or_default();
    let laps = crate::config::default_laps_dir();
    let (laps_bytes, laps_files) = folder_size(&laps);
    let paired = snapshot.cloud != Cloud::NotPaired;
    diagnostics_text(&Input {
        version: env!("CARGO_PKG_VERSION"),
        build: env!("XPEED_BUILD"),
        windows: &format!("{}, {}", crate::win::windows_version(), std::env::consts::ARCH),
        games,
        workers: &workers,
        cloud: &snapshot.cloud,
        server,
        account,
        device,
        log: &log,
        laps_bytes,
        laps_files,
        laps_waiting: crate::outbox::count_pending_laps(&laps, if paired { server } else { "" }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(games: &'a [(String, String)], workers: &'a [(String, String)], log: &'a [String], cloud: &'a Cloud) -> Input<'a> {
        Input {
            version: "0.4.0",
            build: "abc1234",
            windows: "Windows 11 Home 24H2 (build 26200.1), x86_64",
            games,
            workers,
            cloud,
            server: "https://xpeed.skale.club",
            account: Some("ana@example.com"),
            device: Some("RIG"),
            log,
            laps_bytes: 3 * 1024 * 1024 + 200 * 1024,
            laps_files: 14,
            laps_waiting: 2,
        }
    }

    #[test]
    fn says_the_version_the_games_the_connection_the_folder_and_the_log() {
        let games = vec![
            ("Le Mans Ultimate".to_owned(), "recording lap 3".to_owned()),
            ("Assetto Corsa".to_owned(), "waiting".to_owned()),
        ];
        let workers = vec![("uploader".to_owned(), "running".to_owned())];
        let log = vec!["2026-11-13T12:00:00.000Z  Xpeed Companion 0.4.0 starting".to_owned()];
        let text = diagnostics_text(&input(&games, &workers, &log, &Cloud::Waiting(2)));
        for part in [
            "Version: 0.4.0 (build abc1234)",
            "Windows: Windows 11 Home 24H2",
            "Le Mans Ultimate: recording lap 3",
            "Assetto Corsa: waiting",
            "uploader: running",
            "State: connected, 2 item(s) waiting to be sent",
            "Server: xpeed.skale.club",
            "Account: ana@example.com",
            "Laps folder: 3.2 MB in 14 file(s); 2 lap(s) waiting to be sent",
            "Xpeed Companion 0.4.0 starting",
        ] {
            assert!(text.contains(part), "{part} is missing from:\n{text}");
        }
        assert!(!text.contains("https://"), "only the host of the server is written");
    }

    #[test]
    fn never_contains_the_device_key_even_when_a_log_line_carries_it() {
        let key = "xpd_AbCdEfGh0123456789-_abcdefghijklmnopqrs";
        let log = vec![
            format!("2026-11-13T12:00:00.000Z  sent with Bearer {key} ok"),
            format!("{key} at the start and {key} twice"),
            "a short xpd_abc is not a key".to_owned(),
        ];
        let text = diagnostics_text(&input(&[], &[], &log, &Cloud::Idle));
        assert!(!text.contains(key) && !text.contains("AbCdEfGh"), "{text}");
        assert!(text.contains("Bearer xpd_<hidden> ok"), "{text}");
        assert!(text.contains("xpd_abc is not a key"), "a short word is left alone");
        assert!(!text.contains("token"), "nothing about a token is written: {text}");
        // Not connected: no server, account or computer lines.
        let text = diagnostics_text(&input(&[], &[], &[], &Cloud::NotPaired));
        assert!(
            text.contains("State: not connected") && !text.contains("Server:") && !text.contains("ana@example.com"),
            "{text}"
        );
    }

    #[test]
    fn keeps_only_the_last_forty_log_lines() {
        let log: Vec<String> = (1..=100).map(|n| format!("line number {n}")).collect();
        let text = diagnostics_text(&input(&[], &[], &log, &Cloud::Idle));
        assert!(text.contains("Last 40 log line(s):"));
        assert!(text.contains("line number 100") && text.contains("line number 61"));
        assert!(!text.contains("line number 60\n") && !text.contains("line number 1\n"), "{text}");
        assert_eq!(text.matches("line number").count(), 40);
        // A short log is written whole, and none at all is fine.
        let few: Vec<String> = (1..=3).map(|n| format!("line number {n}")).collect();
        assert_eq!(
            diagnostics_text(&input(&[], &[], &few, &Cloud::Idle))
                .matches("line number")
                .count(),
            3
        );
        assert!(diagnostics_text(&input(&[], &[], &[], &Cloud::Idle)).contains("Last 0 log line(s):"));
    }

    #[test]
    fn names_the_windows_version_from_the_registry_pieces() {
        assert_eq!(
            windows_name(Some("Windows 10 Home Single Language"), Some("25H2"), Some("26200"), Some(1)),
            "Windows 11 Home Single Language 25H2 (build 26200.1)"
        );
        assert_eq!(
            windows_name(Some("Windows 10 Pro"), Some("22H2"), Some("19045"), Some(5247)),
            "Windows 10 Pro 22H2 (build 19045.5247)"
        );
        assert_eq!(windows_name(None, None, Some("19045"), None), "Windows (build 19045)");
        assert_eq!(windows_name(None, None, None, None), "Windows");
    }

    #[test]
    fn counts_the_size_of_a_folder_and_what_it_holds() {
        let dir = crate::config::scratch_dir("diag-folder");
        std::fs::write(dir.join("a.xlap.gz"), vec![0u8; 1000]).unwrap();
        std::fs::create_dir_all(dir.join("tracks")).unwrap();
        std::fs::write(dir.join("tracks").join("t.xtrk.gz"), vec![0u8; 24]).unwrap();
        assert_eq!(folder_size(&dir), (1024, 2));
        assert_eq!(folder_size(&dir.join("missing")), (0, 0));
        assert_eq!(read_log(&dir.join("missing.log")), Vec::<String>::new());
    }

    #[test]
    fn writes_sizes_in_plain_units() {
        assert_eq!(size_text(0), "0 B");
        assert_eq!(size_text(2048), "2 KB");
        assert_eq!(size_text(5 * 1024 * 1024), "5.0 MB");
    }
}
