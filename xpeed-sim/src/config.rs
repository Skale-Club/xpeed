//! Where Xpeed Companion sends laps (server address and device key), kept in one small file in the user's profile.
//!
//! The device key is a secret: it is never printed, it sits in the file protected by Windows (DPAPI, `tokenProtected`), and
//! the server it belongs to must be reached over HTTPS
//! (plain HTTP is accepted only for the machine itself, for development).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::secret;

/// What `pair` stores and `upload` / `record --upload` read.
#[derive(Clone, PartialEq)]
pub struct Config {
    /// `https://host[:port][/base]`, no trailing slash.
    pub server: String,
    /// The device key the server issued when pairing.
    pub token: String,
    pub device_name: String,
    /// Who the computer is connected as (the account's email or name), when the connection page said so. Pairings made
    /// with a code do not have it.
    pub account: Option<String>,
    /// Whether Xpeed Companion installs a newer version by itself (when no game is running). On unless the file says
    /// `"autoUpdate": false`: an old file without the field, or with a value that is not true or false, means on.
    pub auto_update: bool,
}

// A derived Debug would put the key in any log or test failure that prints a Config.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("server", &self.server)
            .field("token", &"<hidden>")
            .field("device_name", &self.device_name)
            .field("account", &self.account)
            .field("auto_update", &self.auto_update)
            .finish()
    }
}

/// An environment variable that was set to something: the new name first, then the old one (accepted as a fallback).
fn env_path(names: [&str; 2]) -> Option<PathBuf> {
    names
        .iter()
        .find_map(|name| std::env::var_os(name).filter(|p| !p.is_empty()))
        .map(PathBuf::from)
}

/// Whether the folder of the configuration was chosen by the person (`XPEED_COMPANION_HOME`, or the old `XPEED_SIM_HOME`).
/// Then nothing is moved: it is theirs.
pub fn home_is_overridden() -> bool {
    env_path(["XPEED_COMPANION_HOME", "XPEED_SIM_HOME"]).is_some()
}

/// Whether the folder of the laps was chosen by the person (`XPEED_COMPANION_LAPS`, or the old `XPEED_SIM_LAPS`).
pub fn laps_is_overridden() -> bool {
    env_path(["XPEED_COMPANION_LAPS", "XPEED_SIM_LAPS"]).is_some()
}

/// The folder under `base` that the configuration lives in, with the name of `product` (a per-OS spelling).
fn home_under(product: &str, base: Option<PathBuf>) -> Option<PathBuf> {
    base.map(|b| b.join(product)).filter(|b| !b.as_os_str().is_empty())
}

fn config_base() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
    }
}

/// The folder Xpeed Companion keeps its files in (configuration, log): `XPEED_COMPANION_HOME` (or the old
/// `XPEED_SIM_HOME`), else `%APPDATA%\Xpeed Companion` (`$XDG_CONFIG_HOME/xpeed-companion` or `~/.config/xpeed-companion`
/// elsewhere).
pub fn home_dir() -> Option<PathBuf> {
    if let Some(path) = env_path(["XPEED_COMPANION_HOME", "XPEED_SIM_HOME"]) {
        return Some(path);
    }
    home_under(if cfg!(windows) { "Xpeed Companion" } else { "xpeed-companion" }, config_base())
}

/// Where the configuration lived before the program was renamed (never used for anything but moving it).
pub fn legacy_home_dir() -> Option<PathBuf> {
    home_under(if cfg!(windows) { "Xpeed Sim" } else { "xpeed-sim" }, config_base())
}

/// Where the pairing (server address and device key) is kept.
pub fn default_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join("config.json"))
}

/// The Xpeed site people connect to unless they were paired with another one.
pub const DEFAULT_SERVER: &str = "https://xpeed.skale.club";

/// What this computer calls itself in the person's list of computers in the Xpeed site.
pub fn device_name() -> String {
    let raw = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    let name: String = raw.chars().filter(|c| !c.is_control()).take(60).collect();
    if name.trim().is_empty() {
        "Windows PC".into()
    } else {
        name.trim().to_owned()
    }
}

/// The folder in Documents that holds the laps: `Documents\Xpeed Companion` (the old one is `Documents\Xpeed Sim`).
fn documents_folder(name: &str) -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .filter(|p| !p.is_empty())
        .map(|profile| PathBuf::from(profile).join("Documents").join(name))
}

/// `Documents\Xpeed Companion`, the folder that holds the laps.
pub fn documents_dir() -> Option<PathBuf> {
    documents_folder("Xpeed Companion")
}

/// The old `Documents\Xpeed Sim` (only to move it).
pub fn legacy_documents_dir() -> Option<PathBuf> {
    documents_folder("Xpeed Sim")
}

/// Where laps are written unless someone chose a folder: `XPEED_COMPANION_LAPS` (or the old `XPEED_SIM_LAPS`), else
/// `Documents\Xpeed Companion\Laps`.
pub fn default_laps_dir() -> PathBuf {
    if let Some(path) = env_path(["XPEED_COMPANION_LAPS", "XPEED_SIM_LAPS"]) {
        return path;
    }
    match documents_dir() {
        Some(dir) => dir.join("Laps"),
        None => home_dir().unwrap_or_default().join("Laps"),
    }
}

fn is_loopback(host: &str) -> bool {
    matches!(
        host.trim_start_matches('[').trim_end_matches(']'),
        "localhost" | "127.0.0.1" | "::1"
    )
}

/// Checks a server address and returns it in the form Xpeed Companion keeps: no trailing slash.
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

/// Why a configuration could not be read.
#[derive(Debug, PartialEq)]
pub enum LoadError {
    /// The file cannot be read, or is not a valid configuration.
    Invalid(String),
    /// The device key in the file is protected by Windows and this Windows user cannot open it (a profile copied to another
    /// user or PC). The file is left exactly as it was: the person reconnects this computer, which replaces it.
    KeyUnreadable(String),
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::Invalid(why) | LoadError::KeyUnreadable(why) => f.write_str(why),
        }
    }
}

/// The text of a configuration file as a `Config`, and whether its key was in plain text (an old file, to be migrated).
fn parse(text: &str, path: &Path) -> Result<(Config, bool), LoadError> {
    let broken = || LoadError::Invalid(format!("{} is not a valid configuration; pair again", path.display()));
    let value: Value = serde_json::from_str(text).map_err(|_| broken())?;
    let text_of = |key: &str| value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    let Some(server) = text_of("server") else {
        return Err(broken());
    };
    // The stored address is checked again: the file can be edited by hand.
    let server = normalize_server(&server).map_err(|why| LoadError::Invalid(format!("{}: {why}", path.display())))?;
    let unreadable = |why: &str| {
        LoadError::KeyUnreadable(format!(
            "the device key in {} cannot be opened by this Windows user ({why}); the file was left as it is. Reconnect this computer.",
            path.display()
        ))
    };
    let (token, plain) = match value.get(PROTECTED_KEY) {
        // A protected key wins; if it cannot be opened the plain one (there should be none) is not used instead.
        Some(protected) => {
            let blob = protected
                .as_str()
                .and_then(crate::util::base64_decode)
                .ok_or_else(|| unreadable("the stored value is damaged"))?;
            let bytes = secret::unprotect(&blob).map_err(|why| unreadable(&why))?;
            let token = String::from_utf8(bytes).ok().filter(|t| !t.is_empty());
            (token.ok_or_else(|| unreadable("the stored value is empty"))?, false)
        }
        None => (text_of("token").ok_or_else(broken)?, true),
    };
    let config = Config {
        server,
        token,
        device_name: text_of("deviceName").unwrap_or_default(),
        account: text_of("account"),
        // Only an explicit `false` turns it off.
        auto_update: value.get(AUTO_UPDATE_KEY).and_then(Value::as_bool).unwrap_or(true),
    };
    Ok((config, plain))
}

/// Reads the pairing. A file from before the key was protected (a plain `token`) still loads, and is then rewritten with
/// the protected form, but only once that form has been written and read back to the same key (`migrate`).
pub fn load_checked(path: &Path) -> Result<Option<Config>, LoadError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(LoadError::Invalid(format!("cannot read {}: {error}", path.display()))),
    };
    let (config, plain) = parse(&text, path)?;
    if plain {
        migrate(path, &text, &config);
    }
    Ok(Some(config))
}

pub fn load(path: &Path) -> Result<Option<Config>, String> {
    load_checked(path).map_err(|error| error.to_string())
}

/// The file's field for the protected device key (base64 of the DPAPI bytes). `token` is only in files from before.
const PROTECTED_KEY: &str = "tokenProtected";
/// The file's optional field for "Update automatically".
const AUTO_UPDATE_KEY: &str = "autoUpdate";

fn render(config: &Config, key_field: (&str, String)) -> String {
    let mut value = json!({
        "server": config.server,
        "deviceName": config.device_name,
    });
    value[key_field.0] = json!(key_field.1);
    if let Some(account) = config.account.as_deref().filter(|a| !a.is_empty()) {
        value["account"] = json!(account);
    }
    // Written only when it is off, so a file that never changed the setting looks as it always did.
    if !config.auto_update {
        value[AUTO_UPDATE_KEY] = json!(false);
    }
    serde_json::to_string_pretty(&value).unwrap_or_default() + "\n"
}

/// The device key protected by Windows as base64, after checking that it opens back to the same key.
fn protected_key(config: &Config) -> Result<String, String> {
    let blob = secret::protect(config.token.as_bytes())?;
    if secret::unprotect(&blob).ok().as_deref() != Some(config.token.as_bytes()) {
        return Err("the protected device key did not open back to the same key".into());
    }
    Ok(crate::util::base64_encode(&blob))
}

/// The file's text with the key protected by Windows.
fn protected_body(config: &Config) -> Result<String, String> {
    Ok(render(config, (PROTECTED_KEY, protected_key(config)?)))
}

/// An old file's own text with only the key changed: `token` out, `tokenProtected` in. Every other field is kept as it
/// was, including ones this version does not know.
fn migrated_body(original: &str, config: &Config) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(original).map_err(|e| e.to_string())?;
    let fields = value.as_object_mut().ok_or("the configuration is not an object")?;
    fields.remove("token");
    fields.insert(PROTECTED_KEY.into(), json!(protected_key(config)?));
    Ok(serde_json::to_string_pretty(&value).map_err(|e| e.to_string())? + "\n")
}

/// Writes the file next to its final name (`.part`) and renames it, so a half-written configuration never exists. With
/// `verify`, the `.part` is first read back and must give that device key; otherwise it is thrown away and the file that
/// was there stays untouched.
fn write_body(path: &Path, body: &str, verify: Option<&str>) -> Result<(), String> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let partial = path.with_extension("json.part");
    std::fs::write(&partial, body).map_err(|e| format!("cannot write {}: {e}", partial.display()))?;
    if let Some(token) = verify {
        let read_back = std::fs::read_to_string(&partial)
            .map_err(|e| e.to_string())
            .and_then(|text| parse(&text, &partial).map_err(|e| e.to_string()));
        if !matches!(&read_back, Ok((config, _)) if config.token == token) {
            let _ = std::fs::remove_file(&partial);
            return Err(format!(
                "the protected copy of {} did not read back to the same key",
                path.display()
            ));
        }
    }
    std::fs::rename(&partial, path).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Rewrites an old file (plain `token`) with the key protected. Nothing changes unless the protected form was written and
/// read back to the same key; any failure leaves the old file as it was, still working.
fn migrate(path: &Path, original: &str, config: &Config) {
    match migrated_body(original, config).and_then(|body| write_body(path, &body, Some(&config.token))) {
        Ok(()) => crate::applog::line("the device key is now protected by Windows in the configuration file"),
        Err(why) => crate::applog::line(&format!("the device key stays as it was in the configuration file: {why}")),
    }
}

/// Saves the pairing, with the device key protected by Windows (a plain `token` only where Windows cannot protect it).
pub fn save(path: &Path, config: &Config) -> Result<(), String> {
    match protected_body(config) {
        Ok(body) => write_body(path, &body, Some(&config.token)),
        Err(why) => {
            crate::applog::line(&format!("the device key is saved without Windows protection: {why}"));
            write_body(path, &render(config, ("token", config.token.clone())), None)
        }
    }
}

// Records who the paired computer is connected as, keeping the key, server and device name as they are. Only the
/// pairing that holds `token` is touched (a newer pairing made meanwhile is left alone). Returns whether the file changed.
pub fn update_account(path: &Path, token: &str, account: &str) -> Result<bool, String> {
    let account = account.trim();
    if account.is_empty() {
        return Ok(false);
    }
    let Some(mut config) = load(path)? else {
        return Ok(false);
    };
    if config.token != token || config.account.as_deref() == Some(account) {
        return Ok(false);
    }
    config.account = Some(account.to_owned());
    save(path, &config)?;
    Ok(true)
}

/// Whether "Update automatically" is on for the pairing in `path`: on when there is no file, no such field, or a value
/// that is not true or false (and when the file cannot be read: the person's choice is never guessed to be off).
pub fn auto_update_of(path: &Path) -> bool {
    load(path).ok().flatten().is_none_or(|config| config.auto_update)
}

/// Remembers the choice "Update automatically" in the configuration file, keeping everything else in it (the key stays
/// protected). Returns whether it was written: with no pairing there is no file to keep it in, and the choice then only
/// lasts until the program is closed.
pub fn set_auto_update(path: &Path, on: bool) -> Result<bool, String> {
    let Some(mut config) = load(path)? else {
        return Ok(false);
    };
    if config.auto_update != on {
        config.auto_update = on;
        save(path, &config)?;
    }
    Ok(true)
}

/// The language the person picked in the tray menu, kept in `language` next to the pairing. English when there is
/// no choice yet (or the file cannot be read).
pub fn load_lang(home: &Path) -> crate::text::Lang {
    std::fs::read_to_string(home.join(LANGUAGE_FILE)).map_or(crate::text::Lang::En, |code| crate::text::Lang::from_code(&code))
}

pub fn save_lang(home: &Path, lang: crate::text::Lang) -> Result<(), String> {
    std::fs::create_dir_all(home).map_err(|e| format!("cannot create {}: {e}", home.display()))?;
    let path = home.join(LANGUAGE_FILE);
    std::fs::write(&path, lang.code()).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

const LANGUAGE_FILE: &str = "language";

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
        "xpeed-companion-test-{}-{name}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    #[test]
    fn saving_the_account_keeps_the_token_server_and_device_name() {
        let path = scratch_dir("update-account").join("config.json");
        let config = Config {
            server: "https://xpeed.skale.club".into(),
            token: "xpd_key".into(),
            device_name: "RIG".into(),
            account: None,
            auto_update: true,
        };
        save(&path, &config).unwrap();
        assert!(update_account(&path, "xpd_key", " ana@example.com ").unwrap());
        let saved = load(&path).unwrap().unwrap();
        assert_eq!(saved.account.as_deref(), Some("ana@example.com"));
        assert_eq!(
            (saved.server.as_str(), saved.token.as_str(), saved.device_name.as_str()),
            ("https://xpeed.skale.club", "xpd_key", "RIG")
        );
        // The same account again changes nothing; a changed email replaces it.
        assert!(!update_account(&path, "xpd_key", "ana@example.com").unwrap());
        assert!(update_account(&path, "xpd_key", "ana@new.example").unwrap());
        assert_eq!(load(&path).unwrap().unwrap().account.as_deref(), Some("ana@new.example"));
        // An empty answer, or another pairing's key, leaves the file alone.
        assert!(!update_account(&path, "xpd_key", "").unwrap());
        assert!(!update_account(&path, "xpd_other", "bob@example.com").unwrap());
        assert_eq!(load(&path).unwrap().unwrap().account.as_deref(), Some("ana@new.example"));
    }

    use super::*;

    #[test]
    fn remembers_the_language_picked_and_starts_in_english() {
        use crate::text::Lang;
        let home = scratch_dir("lang");
        assert_eq!(load_lang(&home), Lang::En);
        save_lang(&home, Lang::Pt).unwrap();
        assert_eq!(load_lang(&home), Lang::Pt);
        save_lang(&home, Lang::En).unwrap();
        assert_eq!(load_lang(&home), Lang::En);
    }

    #[test]
    fn laps_go_where_the_person_said_or_to_documents() {
        std::env::set_var("XPEED_SIM_LAPS", r"D:\old-name");
        assert_eq!(default_laps_dir(), PathBuf::from(r"D:\old-name"), "the old variable still works");
        std::env::set_var("XPEED_COMPANION_LAPS", r"D:\mine");
        assert_eq!(default_laps_dir(), PathBuf::from(r"D:\mine"), "the new one wins");
        std::env::remove_var("XPEED_SIM_LAPS");
        std::env::remove_var("XPEED_COMPANION_LAPS");
        assert!(default_laps_dir().ends_with(r"Xpeed Companion\Laps") || default_laps_dir().ends_with("Laps"));
    }

    #[test]
    fn a_computer_always_has_a_short_name_without_control_characters() {
        let name = device_name();
        assert!(!name.is_empty() && name.chars().count() <= 60 && !name.chars().any(char::is_control));
    }

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
        let path = dir.join("nested").join("config.json");
        let config = Config {
            server: "https://xpeed.skale.club".into(),
            token: "xpd_secret".into(),
            device_name: "RIG".into(),
            account: Some("ana@example.com".into()),
            auto_update: true,
        };
        assert_eq!(load(&path), Ok(None));
        save(&path, &config).unwrap();
        assert_eq!(load(&path), Ok(Some(config)));
        assert!(!path.with_extension("json.part").exists(), "no half-written file is left");
        assert_eq!(remove(&path), Ok(true));
        assert_eq!(remove(&path), Ok(false));
    }

    #[test]
    fn an_old_config_without_the_update_field_loads_as_automatic() {
        let dir = scratch_dir("config-auto-update");
        let path = dir.join("config.json");
        let old = r#"{"server":"https://xpeed.skale.club","token":"xpd_old","deviceName":"RIG"}"#;
        std::fs::write(&path, old).unwrap();
        let config = load(&path).unwrap().unwrap();
        assert!(config.auto_update, "no field means on");
        assert!(auto_update_of(&path));
        // Saving it again does not add the field: the file looks as it always did.
        save(&path, &config).unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("autoUpdate"));
        // A value that is not true or false means on too.
        for odd in ["\"no\"", "0", "null", "[]", "\"false\""] {
            let body = format!(r#"{{"server":"https://xpeed.skale.club","token":"xpd_old","autoUpdate":{odd}}}"#);
            std::fs::write(&path, body).unwrap();
            assert!(load(&path).unwrap().unwrap().auto_update, "{odd}");
        }
        // Only an explicit false turns it off.
        std::fs::write(
            &path,
            r#"{"server":"https://xpeed.skale.club","token":"xpd_old","autoUpdate":false}"#,
        )
        .unwrap();
        assert!(!load(&path).unwrap().unwrap().auto_update);
        assert!(!auto_update_of(&path));
        // No file at all, or one that cannot be read: on.
        assert!(auto_update_of(&dir.join("missing.json")));
        std::fs::write(&path, "not json").unwrap();
        assert!(auto_update_of(&path));
    }

    #[test]
    fn the_choice_about_updates_is_kept_with_the_pairing_and_survives_saving_it_again() {
        let path = scratch_dir("config-auto-update-kept").join("config.json");
        // With no pairing there is no file to keep it in.
        assert_eq!(set_auto_update(&path, false), Ok(false));
        assert!(!path.exists());
        save(&path, &sample()).unwrap();
        assert_eq!(set_auto_update(&path, false), Ok(true));
        assert!(!load(&path).unwrap().unwrap().auto_update);
        // Another change to the file (the account) keeps it, and so does the key.
        assert!(update_account(&path, &sample().token, "bob@example.com").unwrap());
        let saved = load(&path).unwrap().unwrap();
        assert!(!saved.auto_update);
        assert_eq!(
            (saved.token.as_str(), saved.account.as_deref()),
            (sample().token.as_str(), Some("bob@example.com"))
        );
        assert_eq!(set_auto_update(&path, true), Ok(true));
        assert!(load(&path).unwrap().unwrap().auto_update);
        assert!(
            !std::fs::read_to_string(&path).unwrap().contains("autoUpdate"),
            "on is the absence of the field"
        );
    }

    #[test]
    fn an_old_config_file_without_an_account_still_loads() {
        let dir = scratch_dir("config-old");
        let path = dir.join("config.json");
        std::fs::write(
            &path,
            r#"{"server":"https://xpeed.skale.club","token":"xpd_old","deviceName":"RIG"}"#,
        )
        .unwrap();
        let config = load(&path).unwrap().unwrap();
        assert_eq!((config.token.as_str(), config.device_name.as_str()), ("xpd_old", "RIG"));
        assert_eq!(config.account, None);
        // Saving it again adds no empty account.
        save(&path, &config).unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("account"));
    }

    fn sample() -> Config {
        Config {
            server: "https://xpeed.skale.club".into(),
            token: "xpd_secret_key_0123456789".into(),
            device_name: "RIG".into(),
            account: Some("ana@example.com".into()),
            auto_update: true,
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_new_file_holds_the_key_protected_and_never_in_the_clear() {
        let path = scratch_dir("protected-new").join("config.json");
        save(&path, &sample()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"tokenProtected\""), "{text}");
        assert!(!text.contains("xpd_secret_key"), "the key is not in the file: {text}");
        assert!(!text.contains("\"token\""), "no plain token field: {text}");
        // A protected file loads, with the same key and the other fields as they were.
        assert_eq!(load_checked(&path), Ok(Some(sample())));
        assert!(!path.with_extension("json.part").exists());
    }

    #[cfg(windows)]
    #[test]
    fn an_old_file_with_a_plain_key_loads_and_is_rewritten_protected() {
        let path = scratch_dir("protected-migrate").join("config.json");
        std::fs::write(
            &path,
            r#"{"server":"https://xpeed.skale.club","token":"xpd_old_plain_key","deviceName":"RIG","account":"ana@example.com"}"#,
        )
        .unwrap();
        let config = load_checked(&path).unwrap().unwrap();
        assert_eq!(config.token, "xpd_old_plain_key");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("tokenProtected") && !text.contains("xpd_old_plain_key"),
            "migrated: {text}"
        );
        assert!(!path.with_extension("json.part").exists());
        // The migrated file gives back the very same pairing, and loading it again changes nothing.
        assert_eq!(load_checked(&path), Ok(Some(config.clone())));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        assert_eq!(
            (config.server.as_str(), config.device_name.as_str()),
            ("https://xpeed.skale.club", "RIG")
        );
        assert_eq!(config.account.as_deref(), Some("ana@example.com"));
    }

    #[cfg(windows)]
    #[test]
    fn a_protected_value_that_cannot_be_opened_means_not_connected_and_the_file_stays_as_it_is() {
        let dir = scratch_dir("protected-corrupt");
        let path = dir.join("config.json");
        let other_entropy = crate::util::base64_encode(&secret::protect_with(b"xpd_key", b"someone else").unwrap());
        for damaged in [
            "\"AAAA\"".to_owned(),               // base64, but not what Windows wrote
            "\"!!! not base64 !!!\"".to_owned(), // not base64
            "\"\"".to_owned(),                   // empty
            "5".to_owned(),                      // not even text
            format!("\"{other_entropy}\""),      // protected by something else
        ] {
            let body = format!(r#"{{"server":"https://xpeed.skale.club","tokenProtected":{damaged},"deviceName":"RIG"}}"#);
            std::fs::write(&path, &body).unwrap();
            let before = std::fs::read(&path).unwrap();
            let loaded = load_checked(&path);
            assert!(matches!(loaded, Err(LoadError::KeyUnreadable(_))), "{damaged}: {loaded:?}");
            let message = load(&path).unwrap_err();
            assert!(
                message.contains("Reconnect this computer") && !message.contains(&other_entropy),
                "{message}"
            );
            assert_eq!(
                std::fs::read(&path).unwrap(),
                before,
                "{damaged}: the file is byte for byte the same"
            );
            assert!(!path.with_extension("json.part").exists());
            // A plain `token` beside a protected value that cannot be opened is not used instead.
            let both = format!(r#"{{"server":"https://xpeed.skale.club","token":"xpd_plain","tokenProtected":{damaged}}}"#);
            std::fs::write(&path, &both).unwrap();
            assert!(matches!(load_checked(&path), Err(LoadError::KeyUnreadable(_))));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), both);
        }
    }

    #[cfg(windows)]
    #[test]
    fn saving_the_account_keeps_the_key_protected() {
        let path = scratch_dir("protected-account").join("config.json");
        let mut config = sample();
        config.account = None;
        save(&path, &config).unwrap();
        assert!(update_account(&path, &config.token, "bob@example.com").unwrap());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("tokenProtected") && !text.contains("xpd_secret_key") && !text.contains("\"token\""),
            "{text}"
        );
        let saved = load(&path).unwrap().unwrap();
        assert_eq!(
            (saved.token.as_str(), saved.account.as_deref()),
            (config.token.as_str(), Some("bob@example.com"))
        );
    }

    #[test]
    fn a_copy_that_does_not_read_back_to_the_same_key_is_thrown_away_and_the_file_is_untouched() {
        let path = scratch_dir("protected-verify").join("config.json");
        let old = r#"{"server":"https://xpeed.skale.club","token":"xpd_a","deviceName":"RIG"}"#;
        std::fs::write(&path, old).unwrap();
        let other = render(&sample(), ("token", "xpd_b".into()));
        assert!(write_body(&path, &other, Some("xpd_a")).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), old);
        assert!(!path.with_extension("json.part").exists(), "the unverified copy is removed");
        // The same copy, read back to the key that was meant, is accepted.
        assert!(write_body(&path, &other, Some("xpd_b")).is_ok());
        assert_eq!(load(&path).unwrap().unwrap().token, "xpd_b");
    }

    #[test]
    fn never_shows_the_key_in_a_debug_print() {
        let config = Config {
            server: "https://x.example".into(),
            token: "xpd_secret".into(),
            device_name: String::new(),
            account: None,
            auto_update: true,
        };
        assert!(!format!("{config:?}").contains("xpd_secret"));
    }

    #[test]
    fn refuses_a_file_that_was_damaged_or_edited_to_something_unsafe() {
        let dir = scratch_dir("config-bad");
        let path = dir.join("config.json");
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
