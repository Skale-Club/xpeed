//! Connecting this computer to an Xpeed account, the short way: the app makes its own device key, asks the server for
//! a connection request that carries only the key's hash, opens the page where the person clicks Connect once, and
//! polls until the server says yes. No code to copy, no link to open, no question box.
//!
//! This module holds everything that is not drawing or Windows: the key, the state the panel's Account card shows,
//! and the background flow. The tray starts it (`tray::start_connect`) and the panel reads its state.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::config::{self, Config};
use crate::net::{self, LinkStatus};

/// How often the server is asked whether the person clicked Connect.
/// The page of the Xpeed site that explains and starts the connection (opened when this computer is not connected).
pub const CONNECT_PATH: &str = "/virtual/companion";
/// The part of the Xpeed site a connected person goes to ("Open Xpeed").
pub const OPEN_PATH: &str = "/virtual";
/// The page where the person confirms one connection request, followed by `/<request id>`.
pub const DEVICE_PAGE: &str = "/companion/connect";

pub const POLL_EVERY: Duration = Duration::from_secs(2);
/// How long a request is waited for (the server's own request lives 10 minutes).
pub const GIVE_UP_AFTER: Duration = Duration::from_secs(10 * 60);
/// Answers that fail one after the other before the wait is given up.
const MAX_FAILURES_IN_A_ROW: u32 = 3;

/// A device key: `xpd_` and 32 random bytes from the operating system, in base64url without padding.
pub fn new_key() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    fill_random(&mut bytes)?;
    Ok(format!("xpd_{}", base64url(&bytes)))
}

#[cfg(windows)]
fn fill_random(bytes: &mut [u8]) -> Result<(), String> {
    use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err("cannot make a device key: the system has no random numbers to give".into())
    }
}

#[cfg(not(windows))]
fn fill_random(bytes: &mut [u8]) -> Result<(), String> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(bytes))
        .map_err(|_| "cannot make a device key: the system has no random numbers to give".to_owned())
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        let digits = chunk.len() + 1;
        for i in 0..digits {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// Why a connection ended without a connected computer.
#[derive(Clone, Debug, PartialEq)]
pub enum Note {
    Cancelled,
    Expired,
    Failed(String),
    /// The device key saved on this computer cannot be opened by this Windows user (a copied profile): connect again.
    Reconnect,
}

/// Where the connection flow is.
#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    /// Nothing is going on (and nothing ended just now).
    Idle,
    /// Waiting for the click on the page. `page` is the address of that page once the server made the request, and `code`
    /// the 4 characters that page shows too (when the server sends one), for the person to compare.
    Waiting { page: Option<String>, code: Option<String> },
    /// The last attempt ended without a connection, and why.
    Ended(Note),
}

struct Inner {
    phase: Phase,
    /// Counts the attempts, so a thread of an attempt that was cancelled never changes the state of a later one.
    generation: u64,
}

/// The state of the connection flow, shared by the thread that runs it and the panel that shows it.
#[derive(Clone)]
pub struct Flow(Arc<Mutex<Inner>>);

impl Flow {
    pub fn new() -> Flow {
        Flow(Arc::new(Mutex::new(Inner {
            phase: Phase::Idle,
            generation: 0,
        })))
    }

    /// The flow of this program.
    pub fn global() -> Flow {
        static FLOW: OnceLock<Flow> = OnceLock::new();
        FLOW.get_or_init(Flow::new).clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn phase(&self) -> Phase {
        self.lock().phase.clone()
    }

    /// The page to open again while waiting.
    pub fn page(&self) -> Option<String> {
        match &self.lock().phase {
            Phase::Waiting { page, .. } => page.clone(),
            _ => None,
        }
    }

    /// Stops waiting on this computer. The request is left to expire on the server.
    pub fn cancel(&self) {
        let mut inner = self.lock();
        if matches!(inner.phase, Phase::Waiting { .. }) {
            inner.generation += 1;
            inner.phase = Phase::Idle;
        }
    }

    /// Starts an attempt: its number, or the page to open again when one is already waiting.
    fn begin(&self) -> Result<u64, Option<String>> {
        let mut inner = self.lock();
        if let Phase::Waiting { page, .. } = &inner.phase {
            return Err(page.clone());
        }
        inner.generation += 1;
        inner.phase = Phase::Waiting { page: None, code: None };
        Ok(inner.generation)
    }

    /// Says why this computer is not connected, from the start (the card shows the note until Connect is clicked). Only
    /// when nothing is going on.
    pub fn end_with(&self, note: Note) {
        let mut inner = self.lock();
        if inner.phase == Phase::Idle {
            inner.phase = Phase::Ended(note);
        }
    }

    /// Changes the state for attempt `generation`; false when that attempt is no longer the current one.
    fn set(&self, generation: u64, phase: Phase) -> bool {
        let mut inner = self.lock();
        if inner.generation != generation {
            return false;
        }
        inner.phase = phase;
        true
    }

    fn current(&self, generation: u64) -> bool {
        self.lock().generation == generation
    }
}

impl Default for Flow {
    fn default() -> Self {
        Flow::new()
    }
}

/// What the Account card of the panel shows.
#[derive(Clone, Debug, PartialEq)]
pub enum Card {
    /// No account, with the reason the last attempt ended when it just did.
    NotConnected { note: Option<Note> },
    /// A request is open: the person has to click Connect in the browser, after checking that the page shows `code`.
    Waiting { code: Option<String> },
    /// Connected, as this account when it is known (the card never says it is connected "as" the server).
    Connected { who: Option<String> },
}

pub fn host_of(server: &str) -> &str {
    server.split_once("://").map_or(server, |(_, rest)| rest)
}

/// The card for this moment: whether the computer is connected, how the flow stands, and who it is connected as.
pub fn card(connected: bool, phase: &Phase, account: Option<&str>) -> Card {
    match phase {
        Phase::Waiting { code, .. } => Card::Waiting { code: code.clone() },
        _ if connected => Card::Connected {
            who: account.filter(|a| !a.is_empty()).map(str::to_owned),
        },
        Phase::Ended(note) => Card::NotConnected { note: Some(note.clone()) },
        Phase::Idle => Card::NotConnected { note: None },
    }
}

/// What the flow needs from the program around it.
pub struct Hooks {
    /// Opens a page in the browser.
    pub open: Box<dyn Fn(&str) + Send + Sync>,
    /// The pairing was saved: pick it up (start sending laps, refresh what is shown).
    pub connected: Box<dyn Fn(&Config) + Send + Sync>,
}

#[derive(Clone, Copy)]
pub struct Timing {
    pub poll: Duration,
    pub limit: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            poll: POLL_EVERY,
            limit: GIVE_UP_AFTER,
        }
    }
}

/// The person clicked Connect. With a request already open this only opens its page again; otherwise a thread makes
/// the key, asks the server, opens the page and waits for the answer. `config_path` is where an approved pairing is
/// saved.
pub fn click(flow: &Flow, server: &str, config_path: Option<PathBuf>, hooks: Arc<Hooks>, timing: Timing) {
    let generation = match flow.begin() {
        Ok(generation) => generation,
        Err(page) => {
            if let Some(page) = page {
                (hooks.open)(&page);
            }
            return;
        }
    };
    let (flow, server) = (flow.clone(), server.to_owned());
    std::thread::spawn(move || {
        let outcome = run(&flow, generation, &server, config_path, &hooks, timing);
        if let Some(phase) = outcome {
            flow.set(generation, phase);
        }
    });
}

/// One attempt, from the key to the answer. The state to end in, or `None` when the attempt was cancelled or the
/// state was already set.
fn run(flow: &Flow, generation: u64, server: &str, config_path: Option<PathBuf>, hooks: &Hooks, timing: Timing) -> Option<Phase> {
    let failed = |why: String| Some(Phase::Ended(Note::Failed(why)));
    let key = match new_key() {
        Ok(key) => key,
        Err(why) => return failed(why),
    };
    let agent = net::agent();
    let device_name = config::device_name();
    let start = match net::link_start(&agent, server, &device_name, &net::sha256_hex(key.as_bytes())) {
        Ok(start) => start,
        Err(why) => return failed(why),
    };
    let (id, code) = (start.id, start.verify_code);
    let page = format!("{server}{DEVICE_PAGE}/{id}");
    if !flow.set(
        generation,
        Phase::Waiting {
            page: Some(page.clone()),
            code,
        },
    ) {
        return None;
    }
    (hooks.open)(&page);
    let started = Instant::now();
    let mut failures = 0;
    loop {
        std::thread::sleep(timing.poll);
        if !flow.current(generation) {
            return None;
        }
        if started.elapsed() >= timing.limit {
            return Some(Phase::Ended(Note::Expired));
        }
        match net::link_poll(&agent, server, &id, &key) {
            Ok(LinkStatus::Pending) => failures = 0,
            Ok(LinkStatus::Cancelled) => return Some(Phase::Ended(Note::Cancelled)),
            Ok(LinkStatus::Expired) => return Some(Phase::Ended(Note::Expired)),
            Ok(LinkStatus::Approved { account }) => {
                let config = Config {
                    server: server.to_owned(),
                    token: key,
                    device_name,
                    account: Some(account).filter(|a| !a.is_empty()),
                };
                if let Some(path) = &config_path {
                    if let Err(why) = config::save(path, &config) {
                        return failed(why);
                    }
                }
                // Idle first, so the card never shows "waiting" over a connected computer.
                if !flow.set(generation, Phase::Idle) {
                    return None;
                }
                (hooks.connected)(&config);
                return None;
            }
            Err(why) => {
                failures += 1;
                if failures >= MAX_FAILURES_IN_A_ROW {
                    return failed(why);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stub::{Recorded, Reply, Stub};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn a_key_has_the_format_the_server_expects_and_no_two_are_alike() {
        let a = new_key().unwrap();
        let b = new_key().unwrap();
        assert_ne!(a, b);
        for key in [&a, &b] {
            let body = key.strip_prefix("xpd_").expect("starts with xpd_");
            // 32 bytes in base64url without padding is 43 characters.
            assert_eq!(body.len(), 43, "{key}");
            assert!(body.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'), "{key}");
        }
    }

    #[test]
    fn base64url_matches_the_standard_examples() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff, 0xfe]), "-__-");
    }

    fn quick() -> Timing {
        Timing {
            poll: Duration::from_millis(20),
            limit: Duration::from_secs(5),
        }
    }

    fn silent_hooks(opened: &Arc<Mutex<Vec<String>>>, connected: &Arc<Mutex<Vec<Config>>>) -> Arc<Hooks> {
        let (opened, connected) = (opened.clone(), connected.clone());
        Arc::new(Hooks {
            open: Box::new(move |page| opened.lock().unwrap().push(page.to_owned())),
            connected: Box::new(move |config| connected.lock().unwrap().push(config.clone())),
        })
    }

    fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
        let started = Instant::now();
        while !done() {
            assert!(started.elapsed() < Duration::from_secs(10), "gave up waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn an_approved_flow_opens_the_page_saves_the_pairing_and_connects() {
        let polls = Arc::new(AtomicUsize::new(0));
        let counted = polls.clone();
        let stub = Stub::start(move |request: &Recorded| {
            if request.path == "/api/sim/link" {
                Reply::new(201, r#"{"id":"abc-123","expiresAt":"2026-11-13T12:10:00.000Z"}"#)
            } else if counted.fetch_add(1, Ordering::SeqCst) < 2 {
                Reply::new(200, r#"{"status":"pending"}"#)
            } else {
                Reply::new(200, r#"{"status":"approved","account":"ana@example.com"}"#)
            }
        });
        let dir = config::scratch_dir("connect-approved");
        let path = dir.join("config.json");
        let (opened, connected) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
        let flow = Flow::new();
        click(&flow, &stub.url, Some(path.clone()), silent_hooks(&opened, &connected), quick());
        wait_for("the connection", || !connected.lock().unwrap().is_empty());

        assert_eq!(*opened.lock().unwrap(), [format!("{}/companion/connect/abc-123", stub.url)]);
        let saved = config::load(&path).unwrap().expect("a pairing was saved");
        let key = saved.token.clone();
        assert!(key.starts_with("xpd_"));
        assert_eq!(saved.server, stub.url);
        assert_eq!(saved.device_name, config::device_name());
        assert_eq!(saved.account.as_deref(), Some("ana@example.com"));
        assert_eq!(connected.lock().unwrap()[0], saved);
        wait_for("the flow to go idle", || flow.phase() == Phase::Idle);
        // The key that was saved is the one whose hash the server was given.
        let start = &stub.requests()[0];
        let sent: serde_json::Value = serde_json::from_slice(&start.body).unwrap();
        assert_eq!(sent["tokenHash"], net::sha256_hex(key.as_bytes()));
    }

    #[test]
    fn clicking_again_while_waiting_only_opens_the_page_again() {
        let starts = Arc::new(AtomicUsize::new(0));
        let counted = starts.clone();
        let stub = Stub::start(move |request: &Recorded| {
            if request.path == "/api/sim/link" {
                counted.fetch_add(1, Ordering::SeqCst);
                Reply::new(201, r#"{"id":"one","expiresAt":"x"}"#)
            } else {
                Reply::new(200, r#"{"status":"pending"}"#)
            }
        });
        let (opened, connected) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
        let hooks = silent_hooks(&opened, &connected);
        let flow = Flow::new();
        click(&flow, &stub.url, None, hooks.clone(), quick());
        wait_for("the page", || flow.page().is_some());
        click(&flow, &stub.url, None, hooks, quick());
        wait_for("the page to open twice", || opened.lock().unwrap().len() == 2);
        assert_eq!(starts.load(Ordering::SeqCst), 1, "no second request was made");
        // Cancelling stops the wait on this side.
        flow.cancel();
        assert_eq!(flow.phase(), Phase::Idle);
    }

    #[test]
    fn a_request_that_expired_or_was_cancelled_ends_with_its_note() {
        for (status, note) in [("expired", Note::Expired), ("cancelled", Note::Cancelled)] {
            let stub = Stub::start(move |request: &Recorded| {
                if request.path == "/api/sim/link" {
                    Reply::new(201, r#"{"id":"one","expiresAt":"x"}"#)
                } else {
                    Reply::new(200, &format!(r#"{{"status":"{status}"}}"#))
                }
            });
            let (opened, connected) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
            let flow = Flow::new();
            click(&flow, &stub.url, None, silent_hooks(&opened, &connected), quick());
            wait_for("the end", || matches!(flow.phase(), Phase::Ended(_)));
            assert_eq!(flow.phase(), Phase::Ended(note));
            assert!(connected.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn a_server_that_refuses_the_request_ends_the_flow_with_the_reason() {
        let stub = Stub::start(|_| Reply::new(429, r#"{"error":"rate_limited"}"#).header("Retry-After", "30"));
        let (opened, connected) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
        let flow = Flow::new();
        click(&flow, &stub.url, None, silent_hooks(&opened, &connected), quick());
        wait_for("the end", || matches!(flow.phase(), Phase::Ended(_)));
        assert!(matches!(flow.phase(), Phase::Ended(Note::Failed(why)) if why.contains("too many attempts")));
        assert!(opened.lock().unwrap().is_empty(), "no page opens when there is no request");
    }

    #[test]
    fn the_account_card_goes_from_not_connected_to_waiting_to_connected() {
        let flow = Flow::new();
        assert_eq!(card(false, &flow.phase(), None), Card::NotConnected { note: None });
        let generation = flow.begin().unwrap();
        assert_eq!(card(false, &flow.phase(), None), Card::Waiting { code: None });
        // A second click only gets the page back (none yet while the server is being asked).
        assert_eq!(flow.begin(), Err(None));
        assert!(flow.set(
            generation,
            Phase::Waiting {
                page: Some("https://xpeed.skale.club/companion/connect/x".into()),
                code: Some("K7QX".into())
            }
        ));
        // The card carries the code to compare with the page.
        assert_eq!(card(false, &flow.phase(), None), Card::Waiting { code: Some("K7QX".into()) });
        assert_eq!(flow.begin(), Err(Some("https://xpeed.skale.club/companion/connect/x".into())));
        // Approved: the pairing exists and the flow is idle.
        assert!(flow.set(generation, Phase::Idle));
        assert_eq!(
            card(true, &flow.phase(), Some("ana@example.com")),
            Card::Connected {
                who: Some("ana@example.com".into())
            }
        );
        // A pairing made the old way has no account until the server says it: just "Connected", never the host.
        assert_eq!(card(true, &flow.phase(), None), Card::Connected { who: None });
    }

    #[test]
    fn waiting_then_expired_goes_back_to_not_connected_with_the_note() {
        let flow = Flow::new();
        let generation = flow.begin().unwrap();
        assert_eq!(card(false, &flow.phase(), None), Card::Waiting { code: None });
        assert!(flow.set(generation, Phase::Ended(Note::Expired)));
        assert_eq!(card(false, &flow.phase(), None), Card::NotConnected { note: Some(Note::Expired) });
        // Connect again starts clean.
        assert!(flow.begin().is_ok());
        assert_eq!(card(false, &flow.phase(), None), Card::Waiting { code: None });
        // An attempt that was cancelled cannot change the state of the next one.
        flow.cancel();
        let next = flow.begin().unwrap();
        assert!(!flow.set(next - 1, Phase::Ended(Note::Cancelled)));
        assert_eq!(flow.phase(), Phase::Waiting { page: None, code: None });
    }

    #[test]
    fn a_key_that_cannot_be_opened_shows_the_reconnect_note_until_connect_is_clicked() {
        let flow = Flow::new();
        flow.end_with(Note::Reconnect);
        assert_eq!(
            card(false, &flow.phase(), None),
            Card::NotConnected {
                note: Some(Note::Reconnect)
            }
        );
        // It never covers a flow that is already going on.
        let busy = Flow::new();
        busy.begin().unwrap();
        busy.end_with(Note::Reconnect);
        assert_eq!(card(false, &busy.phase(), None), Card::Waiting { code: None });
        // Connect starts clean.
        assert!(flow.begin().is_ok());
        assert_eq!(card(false, &flow.phase(), None), Card::Waiting { code: None });
    }

    #[test]
    fn the_code_the_server_sends_reaches_the_waiting_card() {
        for (reply, expected) in [
            (r#"{"id":"abc","expiresAt":"x","verifyCode":"K7QX"}"#, Some("K7QX".to_owned())),
            (r#"{"id":"abc","expiresAt":"x"}"#, None),
        ] {
            let stub = Stub::start(move |request: &Recorded| {
                if request.path == "/api/sim/link" {
                    Reply::new(201, reply)
                } else {
                    Reply::new(200, r#"{"status":"pending"}"#)
                }
            });
            let (opened, connected) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
            let flow = Flow::new();
            click(&flow, &stub.url, None, silent_hooks(&opened, &connected), quick());
            wait_for("the page", || flow.page().is_some());
            assert_eq!(card(false, &flow.phase(), None), Card::Waiting { code: expected });
            flow.cancel();
        }
    }
}
