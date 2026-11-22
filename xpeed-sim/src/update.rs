//! Xpeed Companion updating itself.
//!
//! A background check asks the paired server (the Xpeed site when there is no pairing) what the newest version is
//! (`GET /api/companion/latest`, see `docs/platform/RELEASES.md`). When it is newer than this program, the installer is
//! downloaded, checked against the size and the SHA-256 the server gave, and run silently once no game is running; the
//! program closes first so the installer can replace its files, and the installer starts the new version.
//!
//! Everything that decides something is a plain function here (the answer's parsing, the versions, the allowed
//! addresses, whether an update may start now, the check of a downloaded file, the command line of the installer), so it
//! is tested without a screen, an installer or a real server. The windows of the program (the tray and the panel) only
//! show `UpdateState` and call these.
//!
//! The rules that keep a person's data and a recording safe:
//!
//! * an update never starts while a supported game is running (the check is made again at the last moment);
//! * the installer is taken only from HTTPS, only from the server's own address and the hosts GitHub serves releases
//!   from (`ALLOWED_HOSTS`), after at most 3 redirects, never bigger than `MAX_INSTALLER_BYTES`, and it is run only
//!   when its size and SHA-256 are the ones the server announced;
//! * the device key is never sent with any of these requests;
//! * nothing is downgraded and the same version is never installed again, with one exception: when the server's `blocked`
//!   list names the version that is running, the program installs the server's version even if it is older (a rollback),
//!   with the same size, SHA-256 and HTTPS checks;
//! * the server's `rollout` (0 to 100) says what share of computers install a new version by themselves, by a stable
//!   bucket of the computer's own key; "Update now" and a forced update (below `minVersion`, or a blocked version) ignore it;
//! * the downloaded file is checked again, size and SHA-256, right before the installer is started (`launch_verified`);
//! * the pairing, the laps and the configuration are not touched: the installer replaces the program's files only.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::net::{self, Sha256};
use crate::util::lock;

/// How long after the program starts the first check is made.
pub const FIRST_CHECK_AFTER: Duration = Duration::from_secs(30);
/// How often the server is asked after that.
pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// The most the server's answer may weigh.
pub const MAX_ANSWER_BYTES: u64 = 64 * 1024;
/// The biggest installer the program will download.
pub const MAX_INSTALLER_BYTES: u64 = 200 * 1024 * 1024;
/// How many redirects a download follows.
pub const MAX_REDIRECTS: usize = 3;
/// After a failed download or a file that did not check out, an automatic install waits this long before trying again.
pub const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(30 * 60);
/// What the server answers to the question "what is the newest version".
pub const LATEST_PATH: &str = "/api/companion/latest";
/// The hosts, besides the server's own, that a download may be redirected to: where GitHub keeps the files of a release
/// (`downloadUrl` is always a path of the Xpeed site, which redirects there).
pub const ALLOWED_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
/// The file (in the program's folder) that says which version an update was started for, for the balloon after it.
pub const MARKER_FILE: &str = "updating";

/// The flags the installer is started with: silent, no message boxes, no restart of Windows, close and restart the
/// programs that hold its files, and `/UPDATE=1`, which the installer's script reads to start the new version when it
/// is done (see `installer/xpeed-sim.iss`).
pub const INSTALLER_ARGS: [&str; 6] = [
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/CLOSEAPPLICATIONS",
    "/RESTARTAPPLICATIONS",
    "/UPDATE=1",
];

// ------------------------------------------------------------------------------------------------------------ versions

/// `major.minor.patch`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(pub u32, pub u32, pub u32);

impl Version {
    /// Exactly three numbers separated by dots: no `v`, no suffix, no sign, no leading zeros, nine digits at most each.
    pub fn parse(text: &str) -> Option<Version> {
        let mut parts = text.split('.');
        let mut number = || -> Option<u32> {
            let part = parts.next()?;
            let plain = !part.is_empty() && part.len() <= 9 && part.bytes().all(|b| b.is_ascii_digit());
            if plain && (part == "0" || !part.starts_with('0')) {
                part.parse().ok()
            } else {
                None
            }
        };
        let version = Version(number()?, number()?, number()?);
        parts.next().is_none().then_some(version)
    }

    /// The version of this program.
    pub fn running() -> Version {
        Version::parse(env!("CARGO_PKG_VERSION")).unwrap_or(Version(0, 0, 0))
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

/// What a version offered by the server means for the one that is running.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// The same version or an older one: nothing to do, and never a downgrade (unless the running one is blocked).
    UpToDate,
    /// Newer, or a way out of a blocked version. `required` when the running version is older than the server's
    /// `minVersion` or is on its `blocked` list.
    Available { required: bool },
}

/// Whether `target` may replace `running`: a newer version always; an older one only when `running` is on the `blocked`
/// list (the one allowed downgrade); never the same version.
pub fn may_replace(running: Version, target: Version, blocked: &[Version]) -> bool {
    target > running || (target < running && blocked.contains(&running))
}

pub fn status(running: Version, offer: &Offer) -> Status {
    if !may_replace(running, offer.version, &offer.blocked) {
        return Status::UpToDate;
    }
    Status::Available {
        required: running < offer.min_version || offer.blocked.contains(&running),
    }
}

/// Which of 100 places this computer holds for this version: the same every time for the same computer and version, spread
/// evenly between computers. `identity` is a hash of the computer's own key (see `identity_of`).
pub fn rollout_bucket(identity: &str, version: Version) -> u8 {
    let mut hash = Sha256::new();
    hash.update(format!("xpeed-rollout:{version}:{identity}").as_bytes());
    let hex = hash.finish_hex();
    (u32::from_str_radix(&hex[..8], 16).unwrap_or(0) % 100) as u8
}

/// Whether this computer is inside the share of `offer.rollout` percent: 0 lets nobody in, 100 everybody.
pub fn rollout_allows(offer: &Offer, identity: &str) -> bool {
    rollout_bucket(identity, offer.version) < offer.rollout
}

/// What stands for this computer in the rollout: a hash of its device key (the key itself is not kept here), or, with no
/// pairing, of the computer's name.
pub fn identity_of(token: Option<&str>) -> String {
    let mut hash = Sha256::new();
    match token {
        Some(token) => hash.update(format!("device:{token}").as_bytes()),
        None => hash.update(format!("computer:{}", std::env::var("COMPUTERNAME").unwrap_or_default()).as_bytes()),
    }
    hash.finish_hex()
}

// ----------------------------------------------------------------------------------------------------------- addresses

/// Where an address points: its scheme, host (lower case, an IPv6 one with its brackets) and port.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin {
    pub https: bool,
    pub host: String,
    pub port: u16,
}

impl Origin {
    fn prefix(&self) -> String {
        let (scheme, default) = if self.https { ("https", 443) } else { ("http", 80) };
        if self.port == default {
            format!("{scheme}://{}", self.host)
        } else {
            format!("{scheme}://{}:{}", self.host, self.port)
        }
    }

    fn is_loopback(&self) -> bool {
        matches!(self.host.as_str(), "localhost" | "127.0.0.1" | "[::1]")
    }
}

/// An absolute `http(s)` address split into where it points and the rest (path and query). Anything odd (spaces, control
/// characters, a backslash, a user name, a fragment, a port that is not a number, an unusual host) is `None`.
pub fn split_url(url: &str) -> Option<(Origin, &str)> {
    if url.len() > 2048 || url.chars().any(|c| c.is_control() || c.is_whitespace() || c == '\\') {
        return None;
    }
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    let (https, rest) = if lower.starts_with("https://") {
        (true, &url[8..])
    } else if lower.starts_with("http://") {
        (false, &url[7..])
    } else {
        return None;
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    if authority.contains('@') || tail.contains('#') {
        return None;
    }
    let (host, port_text) = if authority.starts_with('[') {
        let close = authority.find(']')?;
        let after = &authority[close + 1..];
        let port = if after.is_empty() { None } else { Some(after.strip_prefix(':')?) };
        let inner = &authority[1..close];
        if inner.is_empty() || !inner.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.') {
            return None;
        }
        (authority[..=close].to_ascii_lowercase(), port)
    } else {
        let (host, port) = match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        };
        if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
            return None;
        }
        (host.to_ascii_lowercase(), port)
    };
    let port = match port_text {
        None => {
            if https {
                443
            } else {
                80
            }
        }
        Some(text) => {
            if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            text.parse::<u16>().ok().filter(|p| *p != 0)?
        }
    };
    Some((Origin { https, host, port }, tail))
}

/// Whether the download may be asked of `target`: the server itself (over HTTPS; plain HTTP only when both are this
/// computer, for development), or one of `ALLOWED_HOSTS` over HTTPS on the usual port.
fn origin_allowed(target: &Origin, server: &Origin) -> bool {
    if target == server {
        return target.https || target.is_loopback();
    }
    target.https && target.port == 443 && ALLOWED_HOSTS.contains(&target.host.as_str())
}

/// Checks an address before the program asks it for anything.
pub fn check_hop(url: &str, server: &Origin) -> Result<(), DownloadError> {
    let Some((origin, _)) = split_url(url) else {
        return Err(DownloadError::Refused("the address is not valid".into()));
    };
    if origin_allowed(&origin, server) {
        Ok(())
    } else {
        Err(DownloadError::Refused(format!(
            "{} is not a place Xpeed Companion downloads from",
            origin.host
        )))
    }
}

/// The address a redirect points to, from the address that answered: an absolute one as it is, one that starts with `/`
/// on the same origin. Anything else (no scheme, `//host`, a bare path) is `None`.
pub fn resolve_location(current: &str, location: &str) -> Option<String> {
    let lower = location.get(..8).unwrap_or(location).to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return Some(location.to_owned());
    }
    if location.starts_with('/') && !location.starts_with("//") {
        let (origin, _) = split_url(current)?;
        return Some(format!("{}{location}", origin.prefix()));
    }
    None
}

// ----------------------------------------------------------------------------------------------------- the server's answer

/// The newest release, as the server announced it and as this program accepted it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub version: Version,
    pub build: String,
    /// On the server's own address: it redirects to where the file is.
    pub download_url: String,
    /// 64 lower-case hex digits.
    pub sha256: String,
    pub size: u64,
    pub released_at: String,
    pub min_version: Version,
    pub signed: bool,
    /// 0 to 100: the share of computers that install this version by themselves. 100 when the answer says nothing.
    pub rollout: u8,
    /// Versions that must not stay installed. Never holds `version`.
    pub blocked: Vec<Version>,
}

/// The most versions a `blocked` list may hold.
pub const MAX_BLOCKED: usize = 50;

fn short_text(value: &Value, key: &str, longest: usize) -> Result<String, String> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} is missing or not text"))?;
    if text.is_empty() || text.chars().count() > longest || text.chars().any(char::is_control) {
        return Err(format!("{key} is empty, too long or has control characters"));
    }
    Ok(text.to_owned())
}

fn version_of(value: &Value, key: &str) -> Result<Version, String> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} is missing or not text"))?;
    Version::parse(text).ok_or_else(|| format!("{key} is not a version like 1.2.3"))
}

/// The server's answer to `LATEST_PATH`, trusting none of it: at most `MAX_ANSWER_BYTES`, every field present and in its
/// place, `version` and `minVersion` like `1.2.3` (the minimum not above the version), `sha256` 64 lower-case hex digits,
/// `size` a whole number from 1 to `MAX_INSTALLER_BYTES`, and `downloadUrl` an HTTPS address on `server`'s own host.
pub fn parse_offer(body: &[u8], server: &str) -> Result<Offer, String> {
    if body.len() as u64 > MAX_ANSWER_BYTES {
        return Err("the answer is too big".into());
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| "the answer is not JSON".to_owned())?;
    if !value.is_object() {
        return Err("the answer is not an object".into());
    }
    let version = version_of(&value, "version")?;
    let min_version = version_of(&value, "minVersion")?;
    if min_version > version {
        return Err("minVersion is above version".into());
    }
    let build = short_text(&value, "build", 64)?;
    if !build.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err("build has characters it should not".into());
    }
    let released_at = short_text(&value, "releasedAt", 40)?;
    let sha256 = short_text(&value, "sha256", 64)?;
    if sha256.len() != 64 || !sha256.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err("sha256 is not 64 lower-case hex digits".into());
    }
    let size = value
        .get("size")
        .and_then(Value::as_u64)
        .filter(|s| (1..=MAX_INSTALLER_BYTES).contains(s))
        .ok_or_else(|| "size is not a whole number from 1 byte to 200 MB".to_owned())?;
    let signed = value
        .get("signed")
        .and_then(Value::as_bool)
        .ok_or_else(|| "signed is missing or not true/false".to_owned())?;
    // Both are optional (an answer from before they existed means a full rollout and nothing blocked) and strict when present.
    let rollout = match value.get("rollout") {
        None => 100,
        Some(number) => number
            .as_u64()
            .filter(|n| *n <= 100)
            .ok_or_else(|| "rollout is not a whole number from 0 to 100".to_owned())? as u8,
    };
    let mut blocked: Vec<Version> = Vec::new();
    if let Some(list) = value.get("blocked") {
        let list = list
            .as_array()
            .filter(|l| l.len() <= MAX_BLOCKED)
            .ok_or_else(|| format!("blocked is not a list of at most {MAX_BLOCKED} versions"))?;
        for entry in list {
            let version = entry
                .as_str()
                .and_then(Version::parse)
                .ok_or_else(|| "blocked has something that is not a version like 1.2.3".to_owned())?;
            if !blocked.contains(&version) {
                blocked.push(version);
            }
        }
        if blocked.contains(&version) {
            return Err("blocked names the version being offered".into());
        }
    }
    let download_url = short_text(&value, "downloadUrl", 2048)?;
    let (server_origin, _) = split_url(server).ok_or_else(|| "the server's address is not valid".to_owned())?;
    let (origin, rest) = split_url(&download_url).ok_or_else(|| "downloadUrl is not a valid address".to_owned())?;
    if origin != server_origin || !(origin.https || origin.is_loopback()) {
        return Err("downloadUrl is not an HTTPS address on the server's own host".into());
    }
    if !rest.starts_with('/') {
        return Err("downloadUrl has no path".into());
    }
    Ok(Offer {
        version,
        build,
        download_url,
        sha256,
        size,
        released_at,
        min_version,
        signed,
        rollout,
        blocked,
    })
}

/// Asks the server for the newest version. Any problem (no network, a status that is not 200, an answer that does not
/// pass `parse_offer`) is an `Err` with one line to log; the caller tries again at the next interval.
pub fn check(agent: &ureq::Agent, server: &str) -> Result<Offer, String> {
    let mut response = agent
        .get(format!("{server}{LATEST_PATH}"))
        .header("Accept", "application/json")
        .call()
        .map_err(|error| net::network_problem(&error))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("the server answered {status}"));
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_ANSWER_BYTES)
        .read_to_vec()
        .map_err(|error| match error {
            ureq::Error::BodyExceedsLimit(_) => "the answer is too big".to_owned(),
            other => net::network_problem(&other),
        })?;
    parse_offer(&body, server)
}

/// The server to ask: the paired one, else the Xpeed site.
pub fn server_to_ask(config_path: Option<&Path>) -> String {
    config_path
        .and_then(|path| crate::config::load(path).ok().flatten())
        .map_or_else(|| crate::config::DEFAULT_SERVER.to_owned(), |config| config.server)
}

// ------------------------------------------------------------------------------------------------------ when to install

/// Who asks for the update.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    /// The program, by itself (after a check, or when a game has just closed).
    Automatic,
    /// The person, with "Update now".
    Person,
}

/// Why an update that is waiting does not start now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hold {
    /// A supported game is running: never during a game.
    GameRunning,
    /// The panel shows a car being driven (a lap in progress).
    LapView,
    /// "Update automatically" is off and the person has not asked.
    AutomaticOff,
    /// A download just failed or did not check out; it is tried again later.
    RecentFailure,
    /// The server's `rollout` has not reached this computer yet (only "Update now" installs before that).
    Rollout,
}

/// Whether an update may start now. A game running always holds it, whoever asks; "Update automatically" off and a lap on
/// the panel hold only the program's own attempts, and "Update now" is the person's word.
pub fn may_install(trigger: Trigger, automatic: bool, game_running: bool, lap_view: bool) -> Result<(), Hold> {
    if game_running {
        return Err(Hold::GameRunning);
    }
    if trigger == Trigger::Automatic {
        if !automatic {
            return Err(Hold::AutomaticOff);
        }
        if lap_view {
            return Err(Hold::LapView);
        }
    }
    Ok(())
}

/// What the person sees about updates (the Monitor tab and the tray menu show it).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum UpdateState {
    #[default]
    Nothing,
    /// A newer version is out. `required`: the running one is older than the server's `minVersion`. `held`: it would
    /// install by itself, and waits for the game to close.
    Available {
        version: String,
        required: bool,
        held: bool,
    },
    Downloading {
        version: String,
    },
}

/// What the last look for a new version said, for the Monitor tab's update card (as Xdeck's updater shows it): only
/// read when no newer version is waiting (`UpdateState::Nothing`), which then says more.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum CheckState {
    /// No look has finished in this run yet: the program looks by itself (30 s after it starts, then every 6 hours).
    #[default]
    Idle,
    /// A look is under way (the program's own, or "Check now").
    Checking,
    /// The running version is the newest; looked at this Unix time in ms.
    UpToDate { at_ms: i64 },
    /// The last look did not get an answer (no connection, the server down...). The reason is in the log.
    Failed,
}

/// What to do about the update that is waiting.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    Nothing,
    Wait(Hold),
    Install(Offer),
}

#[derive(Default)]
struct Inner {
    offer: Option<Offer>,
    failed_at: Option<Instant>,
    held: bool,
}

/// The update that is waiting, and the person's choice about installing by itself. Cheap to ask from any thread.
pub struct Updater {
    running: Version,
    automatic: AtomicBool,
    busy: AtomicBool,
    inner: Mutex<Inner>,
    /// Stands for this computer in the rollout (`identity_of`).
    identity: Mutex<String>,
}

/// Held while a download is under way; letting it go says the program is free to try again.
pub struct Busy(Arc<Updater>);

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
    }
}

impl Updater {
    pub fn new(running: Version, automatic: bool) -> Arc<Updater> {
        Arc::new(Updater {
            running,
            automatic: AtomicBool::new(automatic),
            busy: AtomicBool::new(false),
            inner: Mutex::new(Inner::default()),
            identity: Mutex::new(identity_of(None)),
        })
    }

    /// Tells who this computer is for the rollout: the device key when paired (only its hash is kept), else the computer's name.
    pub fn set_identity(&self, token: Option<&str>) {
        *lock(&self.identity) = identity_of(token);
    }

    pub fn automatic(&self) -> bool {
        self.automatic.load(Ordering::SeqCst)
    }

    pub fn set_automatic(&self, on: bool) {
        self.automatic.store(on, Ordering::SeqCst);
    }

    /// A check found `offer`: kept when it is newer than the running version, forgotten when it is not (the same version
    /// or an older one is never installed).
    pub fn offer_found(&self, offer: Offer) {
        let mut inner = lock(&self.inner);
        if status(self.running, &offer) == Status::UpToDate {
            inner.offer = None;
            inner.held = false;
            return;
        }
        // A different release is a new chance: a failure with the old one does not count.
        if inner.offer.as_ref().map(|o| (o.version, &o.sha256)) != Some((offer.version, &offer.sha256)) {
            inner.failed_at = None;
        }
        inner.offer = Some(offer);
    }

    /// What to do now about the update that is waiting, for `trigger`, given what the computer is doing.
    pub fn plan(&self, trigger: Trigger, game_running: bool, lap_view: bool, now: Instant) -> Plan {
        let mut inner = lock(&self.inner);
        let Some(offer) = inner.offer.clone() else {
            inner.held = false;
            return Plan::Nothing;
        };
        if status(self.running, &offer) == Status::UpToDate {
            inner.offer = None;
            inner.held = false;
            return Plan::Nothing;
        }
        if self.busy.load(Ordering::SeqCst) {
            return Plan::Nothing;
        }
        let automatic = self.automatic();
        let required = matches!(status(self.running, &offer), Status::Available { required: true });
        let verdict = may_install(trigger, automatic, game_running, lap_view);
        // "Held" is only said about an update that would install by itself.
        inner.held = automatic && matches!(verdict, Err(Hold::GameRunning | Hold::LapView));
        match verdict {
            Err(hold) => Plan::Wait(hold),
            Ok(()) => match inner.failed_at {
                // The program's own attempts wait for their place in the rollout, unless the update is forced.
                _ if trigger == Trigger::Automatic && !required && !rollout_allows(&offer, &lock(&self.identity)) => {
                    Plan::Wait(Hold::Rollout)
                }
                Some(at) if trigger == Trigger::Automatic && now.duration_since(at) < RETRY_AFTER_FAILURE => {
                    Plan::Wait(Hold::RecentFailure)
                }
                _ => Plan::Install(offer),
            },
        }
    }

    /// Marks a download as under way; `None` when one already is.
    pub fn begin(self: &Arc<Self>) -> Option<Busy> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Busy(self.clone()))
    }

    /// The download failed or its file did not check out: the program's own attempts wait a while.
    pub fn failed(&self, now: Instant) {
        lock(&self.inner).failed_at = Some(now);
    }

    pub fn state(&self) -> UpdateState {
        let inner = lock(&self.inner);
        let Some(offer) = &inner.offer else {
            return UpdateState::Nothing;
        };
        if self.busy.load(Ordering::SeqCst) {
            return UpdateState::Downloading {
                version: offer.version.to_string(),
            };
        }
        UpdateState::Available {
            version: offer.version.to_string(),
            required: matches!(status(self.running, offer), Status::Available { required: true }),
            held: inner.held,
        }
    }
}

// ------------------------------------------------------------------------------------------------------------ the check

/// A wake-up for the checker: "Check for updates" in the menu.
#[derive(Default)]
pub struct Wake {
    asked: Mutex<bool>,
    changed: Condvar,
}

impl Wake {
    pub fn new() -> Wake {
        Wake::default()
    }

    /// Asks for a check now.
    pub fn trigger(&self) {
        *lock(&self.asked) = true;
        self.changed.notify_all();
    }

    /// Waits up to `total`, in short steps, until asked (true, and the ask is used up), or until `quitting()` says so.
    fn wait(&self, total: Duration, quitting: &dyn Fn() -> bool) -> bool {
        let until = Instant::now() + total;
        let mut asked = lock(&self.asked);
        loop {
            if *asked {
                *asked = false;
                return true;
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() || quitting() {
                return false;
            }
            let step = left.min(Duration::from_millis(100));
            asked = match self.changed.wait_timeout(asked, step) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }
}

/// What the checker's loop needs.
pub struct CheckLoop<'a> {
    /// The wait before the first check, and between checks.
    pub first: Duration,
    pub every: Duration,
    pub wake: &'a Wake,
    pub quitting: &'a dyn Fn() -> bool,
    /// A look starts; `true` when the person asked for it.
    pub checking: &'a dyn Fn(bool),
    /// Asks the server. Any problem is one line for the log.
    pub fetch: &'a dyn Fn() -> Result<Offer, String>,
    /// An answer was accepted; `true` when the person asked for this check ("Check for updates").
    pub found: &'a dyn Fn(Offer, bool),
    /// The look got no answer; `true` when the person asked for it (only then is a balloon said).
    pub failed: &'a dyn Fn(bool),
    pub say: &'a dyn Fn(String),
}

/// Checks after `first`, then every `every` (or at once when asked), until the program quits. A check that fails is one
/// line in the log and the next try is at the next interval; the Monitor tab's card says it failed, and a balloon says
/// so only when the person asked for the check.
pub fn check_loop(l: &CheckLoop) {
    let mut forced = l.wake.wait(l.first, l.quitting);
    while !(l.quitting)() {
        (l.checking)(forced);
        match (l.fetch)() {
            Ok(offer) => (l.found)(offer, forced),
            Err(why) => {
                (l.failed)(forced);
                (l.say)(format!(
                    "could not check for a new version: {why}. Trying again in {}.",
                    if l.every >= Duration::from_secs(3600) {
                        format!("{} h", l.every.as_secs() / 3600)
                    } else {
                        format!("{} s", l.every.as_secs().max(1))
                    }
                ))
            }
        }
        forced = l.wake.wait(l.every, l.quitting);
    }
}

// ---------------------------------------------------------------------------------------------------------- the download

/// Why an installer was not downloaded.
#[derive(Debug, PartialEq, Eq)]
pub enum DownloadError {
    /// An address the program does not download from (or a redirect it does not follow).
    Refused(String),
    TooManyRedirects,
    Status(u16),
    Network(String),
    /// The file is not the size the server announced.
    Size {
        expected: u64,
        got: u64,
    },
    /// The SHA-256 of the file is not the one the server announced. The file was deleted.
    Hash,
    Disk(String),
    /// The program is closing.
    Quit,
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DownloadError::Refused(why) => write!(f, "refused: {why}"),
            DownloadError::TooManyRedirects => write!(f, "too many redirects"),
            DownloadError::Status(code) => write!(f, "the server answered {code}"),
            DownloadError::Network(why) => f.write_str(why),
            DownloadError::Size { expected, got } => write!(f, "the file is {got} bytes, the server said {expected}"),
            DownloadError::Hash => write!(f, "the file's SHA-256 is not the one the server announced; the file was deleted"),
            DownloadError::Disk(why) => f.write_str(why),
            DownloadError::Quit => write!(f, "the program is closing"),
        }
    }
}

/// The name an installer is kept under here. Never taken from the server: the version was checked to be `1.2.3`.
pub fn installer_name(version: &Version) -> String {
    format!("xpeed-companion-setup-{version}.exe")
}

/// Where installers are downloaded to.
pub fn download_dir() -> PathBuf {
    std::env::temp_dir().join("Xpeed Companion update")
}

fn part_of(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// One agent for the download: the same as for every call (no redirects followed by the library, the system's TLS) with
/// room for a big file. The device key is never put on these requests.
pub fn download_agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .tls_config(ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls).build())
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(20 * 60)))
        .user_agent(concat!("xpeed-companion/", env!("CARGO_PKG_VERSION")))
        .build();
    ureq::Agent::new_with_config(config)
}

/// Checks a file against the size and the SHA-256 the server announced (read in pieces: the file is not held in memory).
pub fn verify_file(path: &Path, size: u64, sha256: &str) -> Result<(), DownloadError> {
    let disk = |error: std::io::Error| DownloadError::Disk(format!("cannot read {}: {error}", path.display()));
    let mut file = File::open(path).map_err(disk)?;
    let length = file.metadata().map_err(disk)?.len();
    if length != size {
        return Err(DownloadError::Size {
            expected: size,
            got: length,
        });
    }
    let (mut hash, mut buffer) = (Sha256::new(), vec![0u8; 64 * 1024]);
    loop {
        let read = file.read(&mut buffer).map_err(disk)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    if hash.finish_hex() == sha256 {
        Ok(())
    } else {
        Err(DownloadError::Hash)
    }
}

/// `verify_file`, and a file that does not check out is deleted.
pub fn verify_or_delete(path: &Path, size: u64, sha256: &str) -> Result<(), DownloadError> {
    let result = verify_file(path, size, sha256);
    if matches!(result, Err(DownloadError::Size { .. } | DownloadError::Hash)) {
        let _ = std::fs::remove_file(path);
    }
    result
}

/// Downloads the installer of `offer` into `dir` and gives back its path, only when it is exactly what the server
/// announced. `offer.download_url` is on the server; each redirect (at most `MAX_REDIRECTS`) is followed only to
/// `ALLOWED_HOSTS` or the server itself, over HTTPS, and each address is checked before it is asked. The bytes go to a
/// `.part` file that is renamed only after the size and the SHA-256 match; otherwise it is deleted. A file from an earlier
/// try that still checks out is used as it is.
#[cfg(test)]
pub fn download(agent: &ureq::Agent, offer: &Offer, dir: &Path, quitting: &dyn Fn() -> bool) -> Result<PathBuf, DownloadError> {
    download_with_progress(agent, offer, dir, quitting, &|_| {})
}

/// `download`, telling `progress` how many bytes of the installer have arrived as they do (for the Monitor tab's bar).
pub fn download_with_progress(
    agent: &ureq::Agent,
    offer: &Offer,
    dir: &Path,
    quitting: &dyn Fn() -> bool,
    progress: &dyn Fn(u64),
) -> Result<PathBuf, DownloadError> {
    let (server, _) = split_url(&offer.download_url).ok_or_else(|| DownloadError::Refused("the download address is not valid".into()))?;
    std::fs::create_dir_all(dir).map_err(|e| DownloadError::Disk(format!("cannot create {}: {e}", dir.display())))?;
    let file = dir.join(installer_name(&offer.version));
    if file.exists() {
        if verify_or_delete(&file, offer.size, &offer.sha256).is_ok() {
            return Ok(file);
        }
        let _ = std::fs::remove_file(&file);
    }
    let part = part_of(&file);
    let _ = std::fs::remove_file(&part);
    let mut url = offer.download_url.clone();
    for hop in 0..=MAX_REDIRECTS {
        check_hop(&url, &server)?;
        let response = agent
            .get(&url)
            .call()
            .map_err(|error| DownloadError::Network(net::network_problem(&error)))?;
        match response.status().as_u16() {
            200 => return save(response, offer, &file, &part, quitting, progress),
            301 | 302 | 303 | 307 | 308 => {
                if hop == MAX_REDIRECTS {
                    return Err(DownloadError::TooManyRedirects);
                }
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| DownloadError::Refused("a redirect without a place to go".into()))?;
                url = resolve_location(&url, location)
                    .ok_or_else(|| DownloadError::Refused("a redirect to an address it does not understand".into()))?;
            }
            other => return Err(DownloadError::Status(other)),
        }
    }
    Err(DownloadError::TooManyRedirects)
}

/// The body of a 200 answer into `part`, then, if it is what was announced, into `file`.
fn save(
    mut response: ureq::http::Response<ureq::Body>,
    offer: &Offer,
    file: &Path,
    part: &Path,
    quitting: &dyn Fn() -> bool,
    progress: &dyn Fn(u64),
) -> Result<PathBuf, DownloadError> {
    if let Some(length) = response.body().content_length() {
        if length != offer.size {
            return Err(DownloadError::Size {
                expected: offer.size,
                got: length,
            });
        }
    }
    let disk = |error: std::io::Error| DownloadError::Disk(format!("cannot write {}: {error}", part.display()));
    let mut out = File::create(part).map_err(disk)?;
    let mut reader = response.body_mut().with_config().limit(offer.size + 1).reader();
    let (mut hash, mut buffer, mut total) = (Sha256::new(), vec![0u8; 64 * 1024], 0u64);
    let copied = loop {
        if quitting() {
            break Err(DownloadError::Quit);
        }
        match reader.read(&mut buffer) {
            Ok(0) => break Ok(()),
            Ok(read) => {
                total += read as u64;
                if total > offer.size {
                    break Err(DownloadError::Size {
                        expected: offer.size,
                        got: total,
                    });
                }
                hash.update(&buffer[..read]);
                if let Err(error) = out.write_all(&buffer[..read]) {
                    break Err(disk(error));
                }
                progress(total);
            }
            Err(error) => break Err(DownloadError::Network(format!("the download was cut: {error}"))),
        }
    };
    let finished = copied.and_then(|()| out.sync_all().map_err(disk)).and_then(|()| {
        if total != offer.size {
            Err(DownloadError::Size {
                expected: offer.size,
                got: total,
            })
        } else if hash.finish_hex() != offer.sha256 {
            Err(DownloadError::Hash)
        } else {
            Ok(())
        }
    });
    drop(out);
    match finished {
        Ok(()) => std::fs::rename(part, file)
            .map(|()| file.to_owned())
            .map_err(|e| DownloadError::Disk(format!("cannot rename {}: {e}", part.display()))),
        Err(error) => {
            let _ = std::fs::remove_file(part);
            Err(error)
        }
    }
}

/// Removes what an earlier update left in `dir` (installers and half-downloaded files, by their names only).
pub fn clean_dir(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.starts_with("xpeed-companion-setup-") && (name.ends_with(".exe") || name.ends_with(".exe.part")) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ---------------------------------------------------------------------------------------------------------- the install

/// The command that starts the installer: its path and, exactly, `INSTALLER_ARGS`.
pub fn installer_command(installer: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(installer);
    command.args(INSTALLER_ARGS);
    command
}

/// Starts the installer silently, on its own, so it goes on after this program has exited.
#[cfg(windows)]
pub fn launch_installer(installer: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    installer_command(installer)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("cannot start {}: {error}", installer.display()))
}

/// A downloaded installer that was checked, waiting for the program to close so it can run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Staged {
    pub path: PathBuf,
    pub version: Version,
    /// What the server announced: the file is checked against them again right before it is started.
    pub size: u64,
    pub sha256: String,
    /// The offer's `blocked` list when it was downloaded: it says whether `version` may be older than the running one.
    pub blocked: Vec<Version>,
}

impl Staged {
    pub fn of(path: PathBuf, offer: &Offer) -> Staged {
        Staged {
            path,
            version: offer.version,
            size: offer.size,
            sha256: offer.sha256.clone(),
            blocked: offer.blocked.clone(),
        }
    }

    /// Whether this installer may still replace `running` (a newer one, or the way out of a blocked one).
    pub fn still_applies(&self, running: Version) -> bool {
        may_replace(running, self.version, &self.blocked)
    }
}

/// Why an installer was not started.
#[derive(Debug, PartialEq, Eq)]
pub enum LaunchError {
    /// The file is not what was downloaded and checked any more (it was changed, or is gone). A changed file was deleted.
    Changed(DownloadError),
    Start(String),
}

impl std::fmt::Display for LaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LaunchError::Changed(why) => write!(f, "the installer is not what was downloaded any more ({why}); it was not started"),
            LaunchError::Start(why) => f.write_str(why),
        }
    }
}

/// The last step before the installer runs: its size and SHA-256 are checked once more (something may have replaced the file
/// since the download), and only a file that still checks out is handed to `start`. A file that does not is deleted.
pub fn launch_verified(staged: &Staged, start: &dyn Fn(&Path) -> Result<(), String>) -> Result<(), LaunchError> {
    verify_or_delete(&staged.path, staged.size, &staged.sha256).map_err(LaunchError::Changed)?;
    start(&staged.path).map_err(LaunchError::Start)
}

/// Notes in `home` which version an update was started for.
pub fn write_marker(home: &Path, version: &Version) -> Result<(), String> {
    let path = home.join(MARKER_FILE);
    std::fs::write(&path, version.to_string()).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// What the start of the program says about the update before it.
#[derive(Debug, PartialEq, Eq)]
pub enum AfterUpdate {
    /// No update was under way.
    Nothing,
    /// This is the version the update was for.
    Updated(String),
    /// The update was for another version than the one running: it did not complete.
    NotCompleted(String),
}

/// Reads and removes the marker an update left, and says what it means for the version running now.
pub fn after_update(home: &Path, running: &Version) -> AfterUpdate {
    let path = home.join(MARKER_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return AfterUpdate::Nothing;
    };
    let _ = std::fs::remove_file(&path);
    match Version::parse(text.trim()) {
        Some(wanted) if wanted == *running => AfterUpdate::Updated(wanted.to_string()),
        Some(wanted) => AfterUpdate::NotCompleted(wanted.to_string()),
        None => AfterUpdate::Nothing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stub::{Recorded, Reply, Stub};
    use std::sync::atomic::AtomicUsize;

    const HASH: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // sha256("abc")

    /// A click on a shortcut opens the panel ("panel" shows the running copy's panel or starts with it); starting with Windows
    /// and the start after an update stay "run" (tray only). With "run", a click while the tray copy ran did nothing (owner,
    /// 2026-11-22).
    #[test]
    fn shortcuts_open_the_panel_and_start_up_stays_in_the_tray() {
        let script = include_str!("../installer/xpeed-sim.iss");
        let lines = |section: &str| -> Vec<&str> {
            let start = script.find(&format!("[{section}]")).expect(section);
            script[start..]
                .lines()
                .skip(1)
                .take_while(|l| !l.starts_with('['))
                .filter(|l| l.starts_with("Name:") || l.starts_with("Filename:") || l.starts_with("Root:"))
                .collect()
        };
        let icons = lines("Icons");
        assert_eq!(icons.len(), 2, "Start menu and desktop");
        for icon in icons {
            assert!(icon.contains("Parameters: \"panel\""), "{icon}");
        }
        let run = lines("Run");
        assert!(run.iter().any(|l| l.contains("postinstall") && l.contains("Parameters: \"panel\"")));
        assert!(run.iter().any(|l| l.contains("IsSelfUpdate") && l.contains("Parameters: \"run\"")));
        for autostart in lines("Registry").into_iter().filter(|l| l.contains("ValueType: string")) {
            assert!(autostart.contains("\" run\""), "{autostart}");
        }
    }

    fn answer_for(server: &str) -> Value {
        serde_json::json!({
            "version": "0.6.0",
            "build": "3bd8f29",
            "downloadUrl": format!("{server}/api/companion/download"),
            "sha256": HASH,
            "size": 3,
            "releasedAt": "2026-11-13T16:20:18Z",
            "minVersion": "0.4.0",
            "signed": false
        })
    }

    fn offer_at(server: &str) -> Offer {
        parse_offer(answer_for(server).to_string().as_bytes(), server).unwrap()
    }

    #[test]
    fn parses_a_valid_answer() {
        let server = "https://xpeed.skale.club";
        let offer = parse_offer(answer_for(server).to_string().as_bytes(), server).unwrap();
        assert_eq!(
            offer,
            Offer {
                version: Version(0, 6, 0),
                build: "3bd8f29".into(),
                download_url: "https://xpeed.skale.club/api/companion/download".into(),
                sha256: HASH.into(),
                size: 3,
                released_at: "2026-11-13T16:20:18Z".into(),
                min_version: Version(0, 4, 0),
                signed: false,
                rollout: 100,
                blocked: vec![],
            }
        );
        // A server with a base path and a port, and the biggest size allowed.
        let server = "https://example.com:8443/xpeed";
        let mut value = answer_for("https://example.com:8443");
        value["size"] = MAX_INSTALLER_BYTES.into();
        value["signed"] = true.into();
        let offer = parse_offer(value.to_string().as_bytes(), server).unwrap();
        assert_eq!((offer.size, offer.signed), (MAX_INSTALLER_BYTES, true));
        // Plain http is fine only for this computer (development).
        let local = "http://127.0.0.1:5010";
        assert!(parse_offer(answer_for(local).to_string().as_bytes(), local).is_ok());
    }

    #[test]
    fn rejects_every_malformed_field() {
        let server = "https://xpeed.skale.club";
        let good = answer_for(server);
        // (field, a value that must be refused)
        let bad: Vec<(&str, Value)> = vec![
            ("version", "0.6".into()),
            ("version", "v0.6.0".into()),
            ("version", "0.6.0-beta".into()),
            ("version", "0.6.0.1".into()),
            ("version", "00.6.0".into()),
            ("version", "0.06.0".into()),
            ("version", "-1.6.0".into()),
            ("version", "0.6.x".into()),
            ("version", "".into()),
            ("version", "1234567890.0.0".into()),
            ("version", 6.into()),
            ("version", Value::Null),
            ("minVersion", "0.4".into()),
            ("minVersion", "x.y.z".into()),
            ("minVersion", "0.7.0".into()), // above the version it belongs to
            ("minVersion", 4.into()),
            ("build", "".into()),
            ("build", "x".repeat(65).into()),
            ("build", "abc def".into()),
            ("build", "abc/../".into()),
            ("build", "abc\n".into()),
            ("build", 7.into()),
            ("releasedAt", "".into()),
            ("releasedAt", "x".repeat(41).into()),
            ("releasedAt", 1.into()),
            ("sha256", HASH.to_uppercase().into()),
            ("sha256", HASH[..63].into()),
            ("sha256", format!("{HASH}0").into()),
            ("sha256", format!("g{}", &HASH[1..]).into()),
            ("sha256", "".into()),
            ("sha256", 5.into()),
            ("size", 0.into()),
            ("size", (-1).into()),
            ("size", (MAX_INSTALLER_BYTES + 1).into()),
            ("size", 3.5.into()),
            ("size", "3".into()),
            ("size", Value::Null),
            ("signed", "false".into()),
            ("signed", 0.into()),
            ("signed", Value::Null),
            ("downloadUrl", "http://xpeed.skale.club/api/companion/download".into()), // not https
            ("downloadUrl", "https://evil.example/api/companion/download".into()),    // not the server's host
            ("downloadUrl", "https://xpeed.skale.club.evil.example/x".into()),
            ("downloadUrl", "https://xpeed.skale.club:8443/x".into()), // another port
            ("downloadUrl", "https://xpeed.skale.club@evil.example/x".into()),
            ("downloadUrl", "https://user:pass@xpeed.skale.club/x".into()),
            (
                "downloadUrl",
                "https://github.com/Skale-Club/xpeed/releases/download/x/y.exe".into(),
            ), // only a redirect may go there
            ("downloadUrl", "//xpeed.skale.club/x".into()),
            ("downloadUrl", "/api/companion/download".into()),
            ("downloadUrl", "javascript:alert(1)".into()),
            ("downloadUrl", "https://xpeed.skale.club".into()), // no path
            ("downloadUrl", "https://xpeed.skale.club/a b".into()),
            ("downloadUrl", "https://xpeed.skale.club/a\\b".into()),
            ("downloadUrl", "https://xpeed.skale.club/x#frag".into()),
            ("downloadUrl", "".into()),
            ("downloadUrl", 1.into()),
        ];
        for (field, value) in bad {
            let mut answer = good.clone();
            answer[field] = value.clone();
            assert!(
                parse_offer(answer.to_string().as_bytes(), server).is_err(),
                "{field} = {value} should be refused"
            );
        }
        // Every field is needed.
        for field in [
            "version",
            "build",
            "downloadUrl",
            "sha256",
            "size",
            "releasedAt",
            "minVersion",
            "signed",
        ] {
            let mut answer = good.clone();
            answer.as_object_mut().unwrap().remove(field);
            assert!(parse_offer(answer.to_string().as_bytes(), server).is_err(), "without {field}");
        }
        // The answer as a whole.
        for body in ["", "not json", "[]", "null", "3", "\"x\"", "{}"] {
            assert!(parse_offer(body.as_bytes(), server).is_err(), "{body:?}");
        }
        // More than 64 KB is refused whatever it holds.
        let mut big = good.clone();
        big["notes"] = "x".repeat(MAX_ANSWER_BYTES as usize).into();
        assert!(parse_offer(big.to_string().as_bytes(), server).unwrap_err().contains("too big"));
        // Fields this program does not know are ignored.
        let mut extra = good.clone();
        extra["notes"] = "what is new".into();
        assert!(parse_offer(extra.to_string().as_bytes(), server).is_ok());
    }

    #[test]
    fn compares_versions_newer_same_older_and_invalid() {
        let offer_of = |version: &str| {
            let mut value = answer_for("https://xpeed.skale.club");
            value["version"] = version.into();
            value["minVersion"] = "0.0.0".into();
            parse_offer(value.to_string().as_bytes(), "https://xpeed.skale.club").unwrap()
        };
        let running = Version(0, 5, 0);
        assert_eq!(status(running, &offer_of("0.6.0")), Status::Available { required: false });
        assert_eq!(status(running, &offer_of("0.5.1")), Status::Available { required: false });
        assert_eq!(status(running, &offer_of("1.0.0")), Status::Available { required: false });
        assert_eq!(
            status(running, &offer_of("0.5.0")),
            Status::UpToDate,
            "the same version is not installed again"
        );
        assert_eq!(status(running, &offer_of("0.4.9")), Status::UpToDate, "never a downgrade");
        assert_eq!(status(running, &offer_of("0.0.1")), Status::UpToDate);
        // Numbers, not text: 0.10.0 is newer than 0.9.0.
        assert!(Version(0, 10, 0) > Version(0, 9, 0) && Version(1, 0, 0) > Version(0, 99, 99));
        assert_eq!(Version::parse("12.0.345"), Some(Version(12, 0, 345)));
        assert_eq!(Version(0, 6, 0).to_string(), "0.6.0");
        for invalid in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "a.b.c",
            "1.2.",
            ".1.2",
            "1..2",
            "01.2.3",
            "1.2.3-rc1",
            "v1.2.3",
            " 1.2.3",
            "1.2.3 ",
            "+1.2.3",
            "1.2.-3",
        ] {
            assert_eq!(Version::parse(invalid), None, "{invalid:?}");
        }
        assert_eq!(Version::running().to_string(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn a_min_version_above_the_running_one_makes_the_update_required() {
        let server = "https://xpeed.skale.club";
        let make = |version: &str, min: &str| {
            let mut value = answer_for(server);
            value["version"] = version.into();
            value["minVersion"] = min.into();
            parse_offer(value.to_string().as_bytes(), server).unwrap()
        };
        assert_eq!(
            status(Version(0, 5, 0), &make("0.6.0", "0.6.0")),
            Status::Available { required: true }
        );
        assert_eq!(
            status(Version(0, 5, 0), &make("0.6.0", "0.5.1")),
            Status::Available { required: true }
        );
        assert_eq!(
            status(Version(0, 5, 0), &make("0.6.0", "0.5.0")),
            Status::Available { required: false }
        );
        assert_eq!(
            status(Version(0, 5, 0), &make("0.6.0", "0.4.0")),
            Status::Available { required: false }
        );
        // What the person sees says so, and it still waits for a game to end.
        let updater = Updater::new(Version(0, 5, 0), true);
        updater.offer_found(make("0.6.0", "0.6.0"));
        assert_eq!(
            updater.state(),
            UpdateState::Available {
                version: "0.6.0".into(),
                required: true,
                held: false
            }
        );
        assert_eq!(
            updater.plan(Trigger::Automatic, true, false, Instant::now()),
            Plan::Wait(Hold::GameRunning),
            "even a required update never starts during a game"
        );
        assert!(matches!(
            updater.plan(Trigger::Automatic, false, false, Instant::now()),
            Plan::Install(_)
        ));
    }

    #[test]
    fn only_the_server_and_the_release_hosts_are_downloaded_from() {
        let server = split_url("https://xpeed.skale.club").unwrap().0;
        for good in [
            "https://xpeed.skale.club/api/companion/download",
            "https://XPEED.skale.club/x",
            "https://github.com/Skale-Club/xpeed/releases/download/companion-latest/setup.exe",
            "https://objects.githubusercontent.com/github-production-release-asset/1?X-Amz=1",
            "https://release-assets.githubusercontent.com/github-production-release-asset/1",
        ] {
            assert_eq!(check_hop(good, &server), Ok(()), "{good}");
        }
        for bad in [
            "http://xpeed.skale.club/x",
            "http://github.com/x",
            "https://evil.example/x",
            "https://github.com.evil.example/x",
            "https://evilgithub.com/x",
            "https://api.github.com/x",
            "https://githubusercontent.com/x",
            "https://raw.githubusercontent.com/x",
            "https://github.com:8443/x",
            "https://github.com@evil.example/x",
            "https://evil.example@github.com/x",
            "https://github.com./x",
            "https://xpeed.skale.club:444/x",
            "https://127.0.0.1/x",
            "https://[::1]/x",
            "ftp://github.com/x",
            "file:///c:/windows/system32/x.exe",
            "//github.com/x",
            "github.com/x",
            "https://github.com/a b",
            "https://",
            "",
        ] {
            assert!(check_hop(bad, &server).is_err(), "{bad}");
        }
        // A server on this computer may be reached over plain http, and only itself.
        let local = split_url("http://127.0.0.1:5010").unwrap().0;
        assert_eq!(check_hop("http://127.0.0.1:5010/x", &local), Ok(()));
        assert!(check_hop("http://127.0.0.1:5011/x", &local).is_err());
        assert!(check_hop("http://localhost:5010/x", &local).is_err());
        assert_eq!(check_hop("https://github.com/x", &local), Ok(()));
        // A redirect's place: absolute as it is, a path on the same origin, nothing else.
        let here = "https://xpeed.skale.club:8443/api/companion/download";
        assert_eq!(
            resolve_location(here, "https://github.com/a").as_deref(),
            Some("https://github.com/a")
        );
        assert_eq!(
            resolve_location(here, "/file.exe").as_deref(),
            Some("https://xpeed.skale.club:8443/file.exe")
        );
        for odd in ["//evil.example/x", "file.exe", "", "javascript:x"] {
            assert_eq!(resolve_location(here, odd), None, "{odd:?}");
        }
    }

    #[test]
    fn a_redirect_to_an_unlisted_host_is_refused() {
        let dir = crate::config::scratch_dir("update-redirect-refused");
        for target in [
            "https://evil.example/installer.exe",
            "http://github.com/installer.exe",
            "https://github.com.evil.example/installer.exe",
            "//evil.example/installer.exe",
            "http://127.0.0.1:1/installer.exe", // another port of this computer is another place
        ] {
            let location = target.to_owned();
            let stub = Stub::start(move |_: &Recorded| Reply::new(302, "").header("Location", &location));
            let offer = offer_at(&stub.url);
            let error = download(&download_agent(), &offer, &dir, &|| false).unwrap_err();
            assert!(matches!(error, DownloadError::Refused(_)), "{target}: {error:?}");
            assert_eq!(stub.requests().len(), 1, "{target}: the unlisted place was never asked");
            assert!(!dir.join(installer_name(&offer.version)).exists());
            assert!(!part_of(&dir.join(installer_name(&offer.version))).exists());
        }
    }

    #[test]
    fn redirects_inside_the_server_are_followed_up_to_three() {
        let dir = crate::config::scratch_dir("update-redirect-follow");
        // /download -> /a -> /b -> /file: three redirects, the file comes.
        let stub = Stub::start(|r: &Recorded| match r.path.as_str() {
            "/api/companion/download" => Reply::new(302, "").header("Location", "/a"),
            "/a" => Reply::new(301, "").header("Location", "/b"),
            "/b" => Reply::new(307, "").header("Location", "/file"),
            "/file" => Reply::new(200, "abc"),
            _ => Reply::new(404, ""),
        });
        let offer = offer_at(&stub.url);
        let path = download(&download_agent(), &offer, &dir, &|| false).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"abc");
        assert_eq!(stub.requests().len(), 4);
        // One more redirect than allowed: refused.
        let dir = crate::config::scratch_dir("update-redirect-four");
        let stub = Stub::start(|r: &Recorded| match r.path.as_str() {
            "/api/companion/download" => Reply::new(302, "").header("Location", "/a"),
            "/a" => Reply::new(302, "").header("Location", "/b"),
            "/b" => Reply::new(302, "").header("Location", "/c"),
            "/c" => Reply::new(302, "").header("Location", "/file"),
            "/file" => Reply::new(200, "abc"),
            _ => Reply::new(404, ""),
        });
        let offer = offer_at(&stub.url);
        assert_eq!(
            download(&download_agent(), &offer, &dir, &|| false),
            Err(DownloadError::TooManyRedirects)
        );
        assert!(!stub.requests().iter().any(|r| r.path == "/file"));
        // No device key and no cookies go on a download.
        assert!(stub
            .requests()
            .iter()
            .all(|r| !r.headers.contains_key("authorization") && !r.headers.contains_key("cookie")));
    }

    #[test]
    fn the_download_is_verified_against_the_hash_and_a_wrong_hash_deletes_the_file() {
        // The right bytes: kept, under a name this program chose, with no half-written file left.
        let dir = crate::config::scratch_dir("update-verify-good");
        let stub = Stub::start(|_: &Recorded| Reply::new(200, "abc"));
        let offer = offer_at(&stub.url);
        let arrived = Mutex::new(Vec::new());
        let path = download_with_progress(&download_agent(), &offer, &dir, &|| false, &|bytes| {
            arrived.lock().unwrap().push(bytes)
        })
        .unwrap();
        assert_eq!(arrived.lock().unwrap().last(), Some(&3), "the bar is told how much arrived");
        assert_eq!(path, dir.join("xpeed-companion-setup-0.6.0.exe"));
        assert_eq!(std::fs::read(&path).unwrap(), b"abc");
        assert!(!part_of(&path).exists());
        assert_eq!(verify_file(&path, 3, HASH), Ok(()));
        // The same size, other bytes: refused, nothing is left on disk.
        let dir = crate::config::scratch_dir("update-verify-bad");
        let stub = Stub::start(|_: &Recorded| Reply::new(200, "abd"));
        let offer = offer_at(&stub.url);
        assert_eq!(download(&download_agent(), &offer, &dir, &|| false), Err(DownloadError::Hash));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "the file was deleted");
        // Another size, announced in the header or only by the bytes: refused too.
        for body in ["ab", "abcd", ""] {
            let dir = crate::config::scratch_dir("update-verify-size");
            let stub = Stub::start(move |_: &Recorded| Reply::new(200, body));
            let offer = offer_at(&stub.url);
            assert!(
                matches!(
                    download(&download_agent(), &offer, &dir, &|| false),
                    Err(DownloadError::Size { .. })
                ),
                "{body:?}"
            );
            assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        }
        // A server that says no.
        let dir = crate::config::scratch_dir("update-verify-404");
        let stub = Stub::start(|_: &Recorded| Reply::new(404, "nope"));
        assert_eq!(
            download(&download_agent(), &offer_at(&stub.url), &dir, &|| false),
            Err(DownloadError::Status(404))
        );
        // A file on disk that no longer checks out is deleted when it is looked at again.
        let dir = crate::config::scratch_dir("update-verify-disk");
        let file = dir.join("setup.exe");
        std::fs::write(&file, b"abd").unwrap();
        assert_eq!(verify_or_delete(&file, 3, HASH), Err(DownloadError::Hash));
        assert!(!file.exists());
        std::fs::write(&file, b"abc").unwrap();
        assert_eq!(verify_or_delete(&file, 3, HASH), Ok(()));
        assert!(file.exists());
        // A file from an earlier try that still checks out is not downloaded again.
        let dir = crate::config::scratch_dir("update-verify-reuse");
        let stub = Stub::start(|_: &Recorded| Reply::new(200, "abc"));
        let offer = offer_at(&stub.url);
        std::fs::write(dir.join(installer_name(&offer.version)), b"abc").unwrap();
        download(&download_agent(), &offer, &dir, &|| false).unwrap();
        assert!(stub.requests().is_empty());
        // Cleaning removes installers and half files by name, and nothing else.
        std::fs::write(dir.join("xpeed-companion-setup-0.1.0.exe.part"), b"x").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        clean_dir(&dir);
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, ["notes.txt"]);
    }

    #[test]
    fn a_game_running_postpones_the_update() {
        let updater = Updater::new(Version(0, 5, 0), true);
        let offer = offer_at("https://xpeed.skale.club");
        updater.offer_found(offer.clone());
        let now = Instant::now();
        // No game: it goes. A game: it waits, whoever asks, and the person is shown that it is held.
        assert_eq!(updater.plan(Trigger::Automatic, false, false, now), Plan::Install(offer.clone()));
        assert_eq!(updater.plan(Trigger::Automatic, true, false, now), Plan::Wait(Hold::GameRunning));
        assert_eq!(
            updater.state(),
            UpdateState::Available {
                version: "0.6.0".into(),
                required: false,
                held: true
            }
        );
        assert_eq!(updater.plan(Trigger::Person, true, false, now), Plan::Wait(Hold::GameRunning));
        // A lap on the panel holds the program's own attempt only.
        assert_eq!(updater.plan(Trigger::Automatic, false, true, now), Plan::Wait(Hold::LapView));
        // The game closes: the next look finds it free again, and nothing is held.
        assert_eq!(updater.plan(Trigger::Automatic, false, false, now), Plan::Install(offer));
        assert!(matches!(updater.state(), UpdateState::Available { held: false, .. }));
        // The pure rule, in a table: (trigger, automatic, game, lap view) -> verdict.
        for (trigger, automatic, game, lap, want) in [
            (Trigger::Automatic, true, false, false, Ok(())),
            (Trigger::Automatic, true, true, false, Err(Hold::GameRunning)),
            (Trigger::Automatic, true, true, true, Err(Hold::GameRunning)),
            (Trigger::Automatic, true, false, true, Err(Hold::LapView)),
            (Trigger::Automatic, false, false, false, Err(Hold::AutomaticOff)),
            (Trigger::Automatic, false, true, false, Err(Hold::GameRunning)),
            (Trigger::Person, true, false, false, Ok(())),
            (Trigger::Person, false, false, false, Ok(())),
            (Trigger::Person, false, false, true, Ok(())),
            (Trigger::Person, true, true, false, Err(Hold::GameRunning)),
            (Trigger::Person, false, true, true, Err(Hold::GameRunning)),
        ] {
            assert_eq!(
                may_install(trigger, automatic, game, lap),
                want,
                "{trigger:?} auto {automatic} game {game} lap {lap}"
            );
        }
    }

    #[test]
    fn the_toggle_off_blocks_automatic_installs_but_not_update_now() {
        let updater = Updater::new(Version(0, 5, 0), false);
        let offer = offer_at("https://xpeed.skale.club");
        updater.offer_found(offer.clone());
        let now = Instant::now();
        assert_eq!(updater.plan(Trigger::Automatic, false, false, now), Plan::Wait(Hold::AutomaticOff));
        // It is shown as available, with the button, and not as held for a game.
        assert_eq!(
            updater.state(),
            UpdateState::Available {
                version: "0.6.0".into(),
                required: false,
                held: false
            }
        );
        assert_eq!(updater.plan(Trigger::Person, false, false, now), Plan::Install(offer.clone()));
        // Still never during a game.
        assert_eq!(updater.plan(Trigger::Person, true, false, now), Plan::Wait(Hold::GameRunning));
        assert!(
            matches!(updater.state(), UpdateState::Available { held: false, .. }),
            "it would not install by itself"
        );
        // Turning it on lets the program do it.
        updater.set_automatic(true);
        assert_eq!(updater.plan(Trigger::Automatic, false, false, now), Plan::Install(offer));
        // Only one download at a time, and the person sees it.
        let busy = updater.begin().expect("free");
        assert!(updater.begin().is_none());
        assert_eq!(updater.state(), UpdateState::Downloading { version: "0.6.0".into() });
        assert_eq!(updater.plan(Trigger::Person, false, false, now), Plan::Nothing);
        drop(busy);
        assert!(updater.begin().is_some());
    }

    #[test]
    fn the_same_or_an_older_version_is_never_offered_for_install() {
        let updater = Updater::new(Version(0, 6, 0), true);
        updater.offer_found(offer_at("https://xpeed.skale.club")); // 0.6.0: the version that is running
        assert_eq!(updater.state(), UpdateState::Nothing);
        assert_eq!(updater.plan(Trigger::Person, false, false, Instant::now()), Plan::Nothing);
        let newer = Updater::new(Version(0, 7, 0), true);
        newer.offer_found(offer_at("https://xpeed.skale.club")); // 0.6.0: older than the running one
        assert_eq!(newer.plan(Trigger::Person, false, false, Instant::now()), Plan::Nothing);
        // An offer that was waiting is forgotten when the server then names the running version.
        let waiting = Updater::new(Version(0, 5, 0), true);
        waiting.offer_found(offer_at("https://xpeed.skale.club"));
        assert_ne!(waiting.state(), UpdateState::Nothing);
        let mut same = offer_at("https://xpeed.skale.club");
        same.version = Version(0, 5, 0);
        same.min_version = Version(0, 5, 0);
        waiting.offer_found(same);
        assert_eq!(waiting.state(), UpdateState::Nothing);
    }

    #[test]
    fn a_failed_download_is_not_hammered_by_the_programs_own_attempts() {
        let updater = Updater::new(Version(0, 5, 0), true);
        let offer = offer_at("https://xpeed.skale.club");
        updater.offer_found(offer.clone());
        let t0 = Instant::now();
        updater.failed(t0);
        assert_eq!(
            updater.plan(Trigger::Automatic, false, false, t0 + Duration::from_secs(60)),
            Plan::Wait(Hold::RecentFailure)
        );
        assert!(matches!(
            updater.plan(Trigger::Person, false, false, t0 + Duration::from_secs(60)),
            Plan::Install(_)
        ));
        assert!(matches!(
            updater.plan(Trigger::Automatic, false, false, t0 + RETRY_AFTER_FAILURE),
            Plan::Install(_)
        ));
        // A different release starts clean.
        updater.failed(t0);
        let mut next = offer;
        next.version = Version(0, 6, 1);
        next.sha256 = "0".repeat(64);
        updater.offer_found(next);
        assert!(matches!(
            updater.plan(Trigger::Automatic, false, false, t0 + Duration::from_secs(60)),
            Plan::Install(_)
        ));
    }

    #[test]
    fn the_installer_command_line_is_built_exactly() {
        let command = installer_command(Path::new(r"C:\Temp\Xpeed Companion update\xpeed-companion-setup-0.6.0.exe"));
        assert_eq!(
            command.get_program().to_string_lossy(),
            r"C:\Temp\Xpeed Companion update\xpeed-companion-setup-0.6.0.exe"
        );
        let args: Vec<String> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(
            args,
            [
                "/VERYSILENT",
                "/SUPPRESSMSGBOXES",
                "/NORESTART",
                "/CLOSEAPPLICATIONS",
                "/RESTARTAPPLICATIONS",
                "/UPDATE=1",
            ]
        );
        assert_eq!(installer_name(&Version(0, 6, 0)), "xpeed-companion-setup-0.6.0.exe");
    }

    #[test]
    fn asks_the_paired_server_else_the_xpeed_site() {
        let dir = crate::config::scratch_dir("update-server");
        let path = dir.join("config.json");
        assert_eq!(server_to_ask(Some(&path)), crate::config::DEFAULT_SERVER, "no pairing");
        assert_eq!(server_to_ask(None), crate::config::DEFAULT_SERVER);
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(
            server_to_ask(Some(&path)),
            crate::config::DEFAULT_SERVER,
            "a file that cannot be read"
        );
        std::fs::write(
            &path,
            r#"{"server":"https://xpeed.example:8443/base","token":"xpd_a","deviceName":"RIG"}"#,
        )
        .unwrap();
        assert_eq!(server_to_ask(Some(&path)), "https://xpeed.example:8443/base");
    }

    #[test]
    fn asks_for_the_newest_version_without_the_device_key_and_reads_the_answer() {
        // The answer names another address than the server's own: refused, since it must be on the server it came from.
        let stub = Stub::start(|_: &Recorded| Reply::new(200, &answer_for("http://127.0.0.1:1").to_string()));
        assert!(check(&net::agent(), &stub.url).unwrap_err().contains("downloadUrl"));
        let own = Arc::new(Mutex::new(String::new()));
        let own_in_stub = own.clone();
        let stub = Stub::start(move |_: &Recorded| Reply::new(200, &answer_for(&own_in_stub.lock().unwrap()).to_string()));
        *own.lock().unwrap() = stub.url.clone();
        let offer = check(&net::agent(), &stub.url).unwrap();
        assert_eq!(offer.version, Version(0, 6, 0));
        let seen = stub.requests();
        assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("GET", LATEST_PATH));
        assert!(!seen[0].headers.contains_key("authorization"), "the device key never goes");
        // A status that is not 200, a redirect and an answer that is too big are errors, and nothing more.
        for (status, body) in [(503, "{}"), (404, ""), (302, ""), (500, "oops")] {
            let stub = Stub::start(move |_: &Recorded| Reply::new(status, body).header("Location", "https://evil.example/"));
            let why = check(&net::agent(), &stub.url).unwrap_err();
            assert!(why.contains(&status.to_string()), "{why}");
        }
        let huge = "x".repeat(MAX_ANSWER_BYTES as usize + 10);
        let stub = Stub::start(move |_: &Recorded| Reply::new(200, &huge));
        assert!(check(&net::agent(), &stub.url).unwrap_err().contains("too big"));
    }

    #[test]
    fn a_failed_check_is_quiet_and_retried_at_the_next_interval() {
        // A server that is down once, then answers.
        let calls = Arc::new(AtomicUsize::new(0));
        let own = Arc::new(Mutex::new(String::new()));
        let (counted, own_in_stub) = (calls.clone(), own.clone());
        let stub = Stub::start(move |_: &Recorded| {
            if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                Reply::new(503, r#"{"error":"unavailable","retryable":true}"#).header("Retry-After", "60")
            } else {
                Reply::new(200, &answer_for(&own_in_stub.lock().unwrap()).to_string())
            }
        });
        *own.lock().unwrap() = stub.url.clone();
        let (lines, found) = (Mutex::new(Vec::new()), Mutex::new(Vec::new()));
        let looks = Mutex::new(Vec::new());
        let wake = Wake::new();
        let agent = net::agent();
        let (done, quit_at) = (AtomicBool::new(false), Instant::now() + Duration::from_secs(20));
        check_loop(&CheckLoop {
            first: Duration::from_millis(5),
            every: Duration::from_millis(40),
            wake: &wake,
            quitting: &|| done.load(Ordering::SeqCst) || Instant::now() > quit_at,
            checking: &|forced| looks.lock().unwrap().push(("checking", forced)),
            fetch: &|| check(&agent, &stub.url),
            found: &|offer, forced| {
                found.lock().unwrap().push((offer.version, forced));
                done.store(true, Ordering::SeqCst);
            },
            failed: &|forced| looks.lock().unwrap().push(("failed", forced)),
            say: &|line| lines.lock().unwrap().push(line),
        });
        // Each look says it starts, and the one that got no answer says it failed (quietly: nobody asked for it).
        assert_eq!(
            *looks.lock().unwrap(),
            [("checking", false), ("failed", false), ("checking", false)]
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2, "tried again at the next interval");
        let lines = lines.lock().unwrap();
        assert_eq!(lines.len(), 1, "one quiet line for the failure: {lines:?}");
        assert!(lines[0].contains("503") && lines[0].contains("Trying again"), "{}", lines[0]);
        assert_eq!(*found.lock().unwrap(), [(Version(0, 6, 0), false)]);
        // Asking for a check wakes the checker before the interval is over, and the answer says it was asked for.
        let wake = Wake::new();
        wake.trigger();
        let seen = Mutex::new(Vec::new());
        let stop = AtomicBool::new(false);
        let offer = offer_at("https://xpeed.skale.club");
        check_loop(&CheckLoop {
            first: Duration::from_secs(3600),
            every: Duration::from_secs(3600),
            wake: &wake,
            quitting: &|| stop.load(Ordering::SeqCst),
            checking: &|_| {},
            fetch: &|| Ok(offer.clone()),
            found: &|_, forced| {
                seen.lock().unwrap().push(forced);
                stop.store(true, Ordering::SeqCst);
            },
            failed: &|_| {},
            say: &|_| {},
        });
        assert_eq!(*seen.lock().unwrap(), [true]);
    }

    #[test]
    fn the_supervisor_restarts_the_checker_after_a_panic() {
        use crate::supervisor::{supervise, Ended, Health, Policy};
        let offer = offer_at("https://xpeed.skale.club");
        let fetches = AtomicUsize::new(0);
        let (found, lines, states) = (Mutex::new(Vec::new()), Mutex::new(Vec::new()), Mutex::new(Vec::new()));
        let stop = AtomicBool::new(false);
        let wake = Wake::new();
        let policy = Policy {
            delays: vec![Duration::from_millis(5)],
            max_restarts: 5,
            window: Duration::from_secs(60),
        };
        let ended = supervise(
            "the update checker",
            &policy,
            &|| stop.load(Ordering::SeqCst),
            &|line| lines.lock().unwrap().push(line),
            &|state| states.lock().unwrap().push(state),
            || {
                check_loop(&CheckLoop {
                    first: Duration::from_millis(1),
                    every: Duration::from_millis(10),
                    wake: &wake,
                    quitting: &|| stop.load(Ordering::SeqCst),
                    checking: &|_| {},
                    fetch: &|| {
                        if fetches.fetch_add(1, Ordering::SeqCst) == 0 {
                            panic!("the first check blows up");
                        }
                        Ok(offer.clone())
                    },
                    found: &|offer, _| {
                        found.lock().unwrap().push(offer.version);
                        stop.store(true, Ordering::SeqCst);
                    },
                    failed: &|_| {},
                    say: &|_| {},
                });
            },
        );
        assert_eq!(ended, Ended::Finished);
        assert_eq!(fetches.load(Ordering::SeqCst), 2, "it started again after the panic");
        assert_eq!(*found.lock().unwrap(), [Version(0, 6, 0)]);
        assert_eq!(*states.lock().unwrap(), [Health::Running, Health::Restarting, Health::Running]);
        assert!(lines.lock().unwrap()[0].contains("the first check blows up"));
    }

    #[test]
    fn remembers_which_version_an_update_was_for_and_says_what_happened_at_the_next_start() {
        let home = crate::config::scratch_dir("update-marker");
        assert_eq!(after_update(&home, &Version(0, 6, 0)), AfterUpdate::Nothing);
        write_marker(&home, &Version(0, 6, 0)).unwrap();
        assert_eq!(after_update(&home, &Version(0, 6, 0)), AfterUpdate::Updated("0.6.0".into()));
        assert_eq!(after_update(&home, &Version(0, 6, 0)), AfterUpdate::Nothing, "said once");
        // The old version came back up (the installer did not finish): not a success.
        write_marker(&home, &Version(0, 6, 0)).unwrap();
        assert_eq!(after_update(&home, &Version(0, 5, 0)), AfterUpdate::NotCompleted("0.6.0".into()));
        // A marker that is not a version is ignored (and removed).
        std::fs::write(home.join(MARKER_FILE), "garbage").unwrap();
        assert_eq!(after_update(&home, &Version(0, 6, 0)), AfterUpdate::Nothing);
        assert!(!home.join(MARKER_FILE).exists());
    }

    fn offer_with(version: &str, min: &str, rollout: Option<u64>, blocked: &[&str]) -> Offer {
        let server = "https://xpeed.skale.club";
        let mut value = answer_for(server);
        value["version"] = version.into();
        value["minVersion"] = min.into();
        if let Some(rollout) = rollout {
            value["rollout"] = rollout.into();
        }
        if !blocked.is_empty() {
            value["blocked"] = blocked.to_vec().into();
        }
        parse_offer(value.to_string().as_bytes(), server).unwrap()
    }

    #[test]
    fn an_answer_without_rollout_or_blocked_is_a_full_rollout_with_nothing_blocked() {
        let offer = offer_at("https://xpeed.skale.club");
        assert_eq!((offer.rollout, offer.blocked.len()), (100, 0));
        let offer = offer_with("0.6.0", "0.4.0", Some(0), &["0.5.0", "0.5.0", "0.4.9"]);
        assert_eq!(offer.rollout, 0);
        assert_eq!(offer.blocked, [Version(0, 5, 0), Version(0, 4, 9)], "duplicates dropped");
    }

    #[test]
    fn rejects_a_malformed_rollout_or_blocked_list() {
        let server = "https://xpeed.skale.club";
        let bad: Vec<(&str, Value)> = vec![
            ("rollout", 101.into()),
            ("rollout", (-1).into()),
            ("rollout", 12.5.into()),
            ("rollout", "50".into()),
            ("rollout", Value::Null),
            ("blocked", "0.5.0".into()),
            ("blocked", serde_json::json!(["0.5"])),
            ("blocked", serde_json::json!([5])),
            ("blocked", serde_json::json!(["0.6.0"])), // the offered version itself
            ("blocked", Value::Null),
            (
                "blocked",
                Value::Array((0..=MAX_BLOCKED as u32).map(|i| format!("0.1.{i}").into()).collect()),
            ),
        ];
        for (field, value) in bad {
            let mut answer = answer_for(server);
            answer[field] = value.clone();
            assert!(parse_offer(answer.to_string().as_bytes(), server).is_err(), "{field} = {value}");
        }
    }

    #[test]
    fn a_blocked_running_version_may_be_replaced_by_an_older_one_and_nothing_else_may() {
        // The server offers 0.5.0 (a rollback) and blocks 0.5.1, which is what is running.
        let rollback = offer_with("0.5.0", "0.4.0", None, &["0.5.1"]);
        assert_eq!(status(Version(0, 5, 1), &rollback), Status::Available { required: true });
        assert!(may_replace(Version(0, 5, 1), Version(0, 5, 0), &rollback.blocked));
        // A version that is lower but not blocked is still refused: never a downgrade by itself.
        assert_eq!(status(Version(0, 5, 2), &rollback), Status::UpToDate);
        assert_eq!(status(Version(0, 9, 0), &rollback), Status::UpToDate);
        let plain = offer_with("0.5.0", "0.4.0", None, &[]);
        assert_eq!(status(Version(0, 5, 1), &plain), Status::UpToDate);
        assert!(!may_replace(Version(0, 5, 1), Version(0, 5, 0), &[]));
        // The same version is never installed again, blocked list or not.
        assert_eq!(status(Version(0, 5, 0), &rollback), Status::UpToDate);
        assert!(!may_replace(Version(0, 5, 0), Version(0, 5, 0), &[Version(0, 5, 0)]));
        // A blocked version also moves up when the offer is newer, and that is required.
        let newer = offer_with("0.6.0", "0.4.0", None, &["0.5.1"]);
        assert_eq!(status(Version(0, 5, 1), &newer), Status::Available { required: true });
        assert_eq!(status(Version(0, 5, 2), &newer), Status::Available { required: false });
    }

    #[test]
    fn the_updater_plans_the_allowed_downgrade_and_forgets_the_refused_one() {
        let rollback = offer_with("0.5.0", "0.4.0", Some(0), &["0.5.1"]);
        let blocked_running = Updater::new(Version(0, 5, 1), true);
        blocked_running.offer_found(rollback.clone());
        // Even with a rollout of 0, a blocked version is a forced update: it installs by itself.
        assert!(matches!(
            blocked_running.plan(Trigger::Automatic, false, false, Instant::now()),
            Plan::Install(offer) if offer.version == Version(0, 5, 0)
        ));
        assert_eq!(
            blocked_running.state(),
            UpdateState::Available {
                version: "0.5.0".into(),
                required: true,
                held: false
            }
        );
        // Still never during a game.
        assert_eq!(
            blocked_running.plan(Trigger::Automatic, true, false, Instant::now()),
            Plan::Wait(Hold::GameRunning)
        );
        // Another running version: the lower offer is not kept at all.
        let other = Updater::new(Version(0, 5, 2), true);
        other.offer_found(rollback);
        assert_eq!(other.state(), UpdateState::Nothing);
        assert_eq!(other.plan(Trigger::Person, false, false, Instant::now()), Plan::Nothing);
    }

    #[test]
    fn the_rollout_bucket_is_stable_spread_out_and_respects_zero_and_one_hundred() {
        let v = Version(0, 9, 0);
        assert_eq!(rollout_bucket("device-a", v), rollout_bucket("device-a", v), "the same every time");
        let ids: Vec<String> = (0..2000).map(|i| identity_of(Some(&format!("key-{i}")))).collect();
        let buckets: Vec<u8> = ids.iter().map(|id| rollout_bucket(id, v)).collect();
        assert!(buckets.iter().all(|b| *b < 100));
        for (from, to) in [(0u8, 25u8), (25, 50), (50, 75), (75, 100)] {
            let n = buckets.iter().filter(|b| (from..to).contains(b)).count();
            assert!((350..650).contains(&n), "{from}..{to} holds {n} of 2000");
        }
        // Another version shuffles who goes first.
        assert!(ids.iter().any(|id| rollout_bucket(id, v) != rollout_bucket(id, Version(0, 9, 1))));
        // 0 lets nobody in, 100 lets everybody in, and a share lets in about that share.
        let (none, all, tenth) = (
            offer_with("0.9.0", "0.4.0", Some(0), &[]),
            offer_with("0.9.0", "0.4.0", Some(100), &[]),
            offer_with("0.9.0", "0.4.0", Some(10), &[]),
        );
        assert!(ids.iter().all(|id| !rollout_allows(&none, id)));
        assert!(ids.iter().all(|id| rollout_allows(&all, id)));
        let inside = ids.iter().filter(|id| rollout_allows(&tenth, id)).count();
        assert!((120..280).contains(&inside), "10% let in {inside} of 2000");
        // Growing the share only adds computers: nobody who was in is put out.
        let half = offer_with("0.9.0", "0.4.0", Some(50), &[]);
        assert!(ids
            .iter()
            .filter(|id| rollout_allows(&tenth, id))
            .all(|id| rollout_allows(&half, id)));
    }

    #[test]
    fn an_automatic_update_waits_for_its_place_in_the_rollout_and_a_manual_one_does_not() {
        let v = Version(0, 9, 0);
        // Two computers, one inside a 50% rollout and one outside.
        let tokens: Vec<String> = (0..200).map(|i| format!("key-{i}")).collect();
        let inside = tokens.iter().find(|t| rollout_bucket(&identity_of(Some(t)), v) < 50).unwrap();
        let outside = tokens.iter().find(|t| rollout_bucket(&identity_of(Some(t)), v) >= 50).unwrap();
        let offer = offer_with("0.9.0", "0.4.0", Some(50), &[]);
        let make = |token: &str| {
            let updater = Updater::new(Version(0, 8, 0), true);
            updater.set_identity(Some(token));
            updater.offer_found(offer.clone());
            updater
        };
        let (a, b) = (make(inside), make(outside));
        assert!(matches!(a.plan(Trigger::Automatic, false, false, Instant::now()), Plan::Install(_)));
        assert_eq!(b.plan(Trigger::Automatic, false, false, Instant::now()), Plan::Wait(Hold::Rollout));
        // "Update now" is the person's word: the rollout is ignored.
        assert!(matches!(b.plan(Trigger::Person, false, false, Instant::now()), Plan::Install(_)));
        // The update is still shown (and not "held": it is not waiting for a game).
        assert_eq!(
            b.state(),
            UpdateState::Available {
                version: "0.9.0".into(),
                required: false,
                held: false
            }
        );
        // A rollout of 0 holds every automatic install; 100 holds none.
        let paused = Updater::new(Version(0, 8, 0), true);
        paused.offer_found(offer_with("0.9.0", "0.4.0", Some(0), &[]));
        assert_eq!(
            paused.plan(Trigger::Automatic, false, false, Instant::now()),
            Plan::Wait(Hold::Rollout)
        );
        let open = Updater::new(Version(0, 8, 0), true);
        open.set_identity(Some(outside));
        open.offer_found(offer_with("0.9.0", "0.4.0", Some(100), &[]));
        assert!(matches!(
            open.plan(Trigger::Automatic, false, false, Instant::now()),
            Plan::Install(_)
        ));
        // A forced update (below minVersion) goes whatever the rollout says.
        let forced = Updater::new(Version(0, 8, 0), true);
        forced.offer_found(offer_with("0.9.0", "0.9.0", Some(0), &[]));
        assert!(matches!(
            forced.plan(Trigger::Automatic, false, false, Instant::now()),
            Plan::Install(_)
        ));
    }

    fn staged_in(dir: &Path, bytes: &[u8]) -> Staged {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("setup.exe");
        std::fs::write(&path, bytes).unwrap();
        let mut hash = Sha256::new();
        hash.update(bytes);
        Staged {
            path,
            version: Version(0, 9, 0),
            size: bytes.len() as u64,
            sha256: hash.finish_hex(),
            blocked: vec![],
        }
    }

    #[test]
    fn the_installer_is_checked_again_right_before_it_starts() {
        let dir = crate::config::scratch_dir("update-launch");
        let staged = staged_in(&dir, b"the real installer");
        let started = AtomicUsize::new(0);
        let start = |_: &Path| {
            started.fetch_add(1, Ordering::SeqCst);
            Ok(())
        };
        // Untouched: it starts.
        assert_eq!(launch_verified(&staged, &start), Ok(()));
        assert_eq!(started.load(Ordering::SeqCst), 1);
        // The same size with other bytes (replaced after the download): refused and deleted, never started.
        std::fs::write(&staged.path, b"the evil installer").unwrap();
        assert_eq!(launch_verified(&staged, &start), Err(LaunchError::Changed(DownloadError::Hash)));
        assert!(!staged.path.exists(), "the changed file was deleted");
        // Another size: refused too.
        let staged = staged_in(&dir, b"abc");
        std::fs::write(&staged.path, b"abcd").unwrap();
        assert!(matches!(
            launch_verified(&staged, &start),
            Err(LaunchError::Changed(DownloadError::Size { expected: 3, got: 4 }))
        ));
        assert!(!staged.path.exists());
        // Gone altogether: refused.
        assert!(matches!(
            launch_verified(&staged, &start),
            Err(LaunchError::Changed(DownloadError::Disk(_)))
        ));
        assert_eq!(
            started.load(Ordering::SeqCst),
            1,
            "the installer was started only for the good file"
        );
        // A start that fails is reported as that.
        let staged = staged_in(&dir, b"ok");
        assert_eq!(
            launch_verified(&staged, &|_| Err("cannot start".into())),
            Err(LaunchError::Start("cannot start".into()))
        );
    }

    #[test]
    fn a_staged_installer_applies_only_while_it_may_still_replace_the_running_version() {
        let mut staged = staged_in(&crate::config::scratch_dir("update-staged"), b"x");
        staged.version = Version(0, 5, 0);
        assert!(!staged.still_applies(Version(0, 5, 1)), "older and not blocked");
        assert!(!staged.still_applies(Version(0, 5, 0)), "the same");
        assert!(staged.still_applies(Version(0, 4, 0)), "newer");
        staged.blocked = vec![Version(0, 5, 1)];
        assert!(staged.still_applies(Version(0, 5, 1)), "the running one is blocked: the way out");
        assert!(!staged.still_applies(Version(0, 5, 2)));
    }
}
