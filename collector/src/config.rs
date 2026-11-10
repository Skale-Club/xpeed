//! Where the collector sends laps (server address and device key), kept in one small file in the user's profile.
//!
//! The device key is a secret: it is never printed, and the server it belongs to must be reached over HTTPS
//! (plain HTTP is accepted only for the machine itself, for development).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// What `pair` stores and `upload` / `record --upload` read.
#[derive(Clone, PartialEq)]
pub struct Config {
    /// `https://host[:port][/base]`, no trailing slash.
    pub server: String,
    /// The device key the server issued when pairing.
    pub token: String,
    pub device_name: String,
}

// A derived Debug would put the key in any log or test failure that prints a Config.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("server", &self.server)
            .field("token", &"<hidden>")
            .field("device_name", &self.device_name)
            .finish()
    }
}

/// Where the configuration lives: `XPEED_COLLECTOR_CONFIG`, else `%APPDATA%\Xpeed\collector.json`
/// (`$XDG_CONFIG_HOME` or `~/.config` elsewhere).
pub fn default_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("XPEED_COLLECTOR_CONFIG").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(path));
    }
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
    };
    base.filter(|b| !b.as_os_str().is_empty())
        .map(|b| b.join("Xpeed").join("collector.json"))
}

fn is_loopback(host: &str) -> bool {
    matches!(
        host.trim_start_matches('[').trim_end_matches(']'),
        "localhost" | "127.0.0.1" | "::1"
    )
}

/// Checks a server address and returns it in the form the collector keeps: no trailing slash.
pub fn normalize_server(input: &str) -> Result<String, String> {
    let text = input.trim();
    let (scheme, rest) = text.split_once("://").ok_or("the server address must start with https://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return Err("the server address must start with https://".into());
    }
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, ""),
    };
    if authority.contains('@') {
        return Err("the server address must not contain a user name or password".into());
    }
    if authority.is_empty() || authority.starts_with(':') || authority.chars().any(|c| c.is_whitespace()) {
        return Err("the server address has no host".into());
    }
    if rest.contains('?') || rest.contains('#') {
        return Err("the server address must not have a query or a fragment".into());
    }
    let host = if let Some(end) = authority.strip_prefix('[').and_then(|r| r.find(']')) {
        &authority[..end + 2]
    } else {
        authority.split(':').next().unwrap_or("")
    };
    if scheme == "http" && !is_loopback(host) {
        return Err(
            "plain http is only accepted for this computer (localhost); use https:// so the device key is not sent in the open".into(),
        );
    }
    Ok(format!(
        "{scheme}://{}{}",
        authority.to_ascii_lowercase(),
        path.trim_end_matches('/')
    ))
}

/// A pairing code as the person typed it (`abcd-2345`) as the server wants it (`ABCD2345`).
pub fn normalize_code(input: &str) -> Result<String, String> {
    let code: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect::<String>()
        .to_ascii_uppercase();
    if (6..=32).contains(&code.len()) && code.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(code)
    } else {
        Err("the pairing code should be letters and numbers, like ABCD-2345".into())
    }
}

pub fn load(path: &Path) -> Result<Option<Config>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let broken = || format!("{} is not a valid collector configuration; pair again", path.display());
    let value: Value = serde_json::from_str(&text).map_err(|_| broken())?;
    let text_of = |key: &str| value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    let (Some(server), Some(token)) = (text_of("server"), text_of("token")) else {
        return Err(broken());
    };
    // The stored address is checked again: the file can be edited by hand.
    let server = normalize_server(&server).map_err(|why| format!("{}: {why}", path.display()))?;
    Ok(Some(Config {
        server,
        token,
        device_name: text_of("deviceName").unwrap_or_default(),
    }))
}

/// Writes the file next to its final name and renames it, so a half-written configuration never exists.
pub fn save(path: &Path, config: &Config) -> Result<(), String> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let body = serde_json::to_string_pretty(&json!({
        "server": config.server,
        "token": config.token,
        "deviceName": config.device_name,
    }))
    .map_err(|e| e.to_string())?;
    let partial = path.with_extension("json.part");
    std::fs::write(&partial, body + "\n").map_err(|e| format!("cannot write {}: {e}", partial.display()))?;
    std::fs::rename(&partial, path).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Forgets the pairing on this computer. The server is not told: the person revokes the device in the app.
pub fn remove(path: &Path) -> Result<bool, String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("cannot remove {}: {error}", path.display())),
    }
}

#[cfg(test)]
pub fn scratch_dir(name: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "xpeed-collector-test-{}-{name}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_https_addresses_without_a_trailing_slash() {
        assert_eq!(normalize_server("https://xpeed.skale.club").unwrap(), "https://xpeed.skale.club");
        assert_eq!(
            normalize_server("  HTTPS://Xpeed.Skale.Club/  ").unwrap(),
            "https://xpeed.skale.club"
        );
        assert_eq!(
            normalize_server("https://example.com:8443/xpeed/").unwrap(),
            "https://example.com:8443/xpeed"
        );
    }

    #[test]
    fn plain_http_is_only_for_this_computer() {
        assert_eq!(normalize_server("http://localhost:3000").unwrap(), "http://localhost:3000");
        assert_eq!(normalize_server("http://127.0.0.1:5010/").unwrap(), "http://127.0.0.1:5010");
        assert_eq!(normalize_server("http://[::1]:8080").unwrap(), "http://[::1]:8080");
        for open in [
            "http://xpeed.skale.club",
            "http://192.168.0.10:3000",
            "http://localhost.evil.example",
            "http://127.0.0.1.evil.example",
        ] {
            assert!(
                normalize_server(open).unwrap_err().contains("only accepted for this computer"),
                "{open}"
            );
        }
    }

    #[test]
    fn refuses_addresses_that_are_not_a_plain_server() {
        for bad in [
            "",
            "xpeed.skale.club",
            "ftp://xpeed.skale.club",
            "https://",
            "https://:443",
            "https://user:pass@xpeed.skale.club",
            "https://xpeed.skale.club?x=1",
            "https://xpeed.skale.club/#top",
            "https://xpeed .skale.club",
        ] {
            assert!(normalize_server(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn reads_a_pairing_code_the_way_people_type_it() {
        assert_eq!(normalize_code("abcd-2345").unwrap(), "ABCD2345");
        assert_eq!(normalize_code(" ab cd 23 45 ").unwrap(), "ABCD2345");
        for bad in ["", "AB-12", "ABCD 23$5", &"A".repeat(33)] {
            assert!(normalize_code(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn saves_and_reads_back_the_pairing() {
        let dir = scratch_dir("config");
        let path = dir.join("nested").join("collector.json");
        let config = Config {
            server: "https://xpeed.skale.club".into(),
            token: "xpd_secret".into(),
            device_name: "RIG".into(),
        };
        assert_eq!(load(&path), Ok(None));
        save(&path, &config).unwrap();
        assert_eq!(load(&path), Ok(Some(config)));
        assert!(!path.with_extension("json.part").exists(), "no half-written file is left");
        assert_eq!(remove(&path), Ok(true));
        assert_eq!(remove(&path), Ok(false));
    }

    #[test]
    fn never_shows_the_key_in_a_debug_print() {
        let config = Config {
            server: "https://x.example".into(),
            token: "xpd_secret".into(),
            device_name: String::new(),
        };
        assert!(!format!("{config:?}").contains("xpd_secret"));
    }

    #[test]
    fn refuses_a_file_that_was_damaged_or_edited_to_something_unsafe() {
        let dir = scratch_dir("config-bad");
        let path = dir.join("collector.json");
        for body in [
            "not json",
            "{}",
            r#"{"server":"https://x.example"}"#,
            r#"{"server":"https://x.example","token":""}"#,
            r#"{"server":"http://evil.example","token":"xpd_a"}"#,
        ] {
            std::fs::write(&path, body).unwrap();
            assert!(load(&path).is_err(), "{body:?} should be refused");
        }
    }
}
