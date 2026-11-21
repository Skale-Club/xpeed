//! The site's own pages inside the panel. A click on one of the site's places in the sidebar (`nav`) shows that page in the content
//! area, right of the sidebar and under the header, with WebView2; the Companion's header and sidebar stay native (the contract is
//! `shared/design/companion-shell.md`). The page tells it is inside the Companion by the user agent, which gets
//! ` XpeedCompanion/<version>` added to WebView2's own.
//!
//! Everything here runs on the panel's window thread, which is an apartment-threaded COM thread (`start` makes it one). WebView2 is
//! made lazily, on the first click of a place, and asynchronously: the window procedure never waits for it. The completion
//! handlers only write into a slot (`Slot`) and post `WM_WEB`; the window reads the slot there, so no handler ever touches the
//! window's state while a message is being handled on it.
//!
//! The decisions that need no window are plain functions with tests: which place an address belongs to (`place_for_url`) and what
//! to do with a navigation (`nav_policy`).
//!
//! Memory: the web view is hidden on a native screen, closed when the panel window is destroyed (closing it, or hiding to the
//! tray) and after `IDLE_CLOSE_MS` of native screens; the next click makes it again. If WebView2 is not there or fails to start, the
//! place opens in the browser as before, for the rest of the session.

use std::cell::RefCell;
use std::rc::{Rc, Weak};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2, ICoreWebView2Controller, ICoreWebView2EnvironmentOptions,
    ICoreWebView2Settings2, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
};
use webview2_com::{
    take_pwstr, AcceleratorKeyPressedEventHandler, CreateCoreWebView2ControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, NavigationStartingEventHandler, NewWindowRequestedEventHandler,
    SourceChangedEventHandler,
};
use windows::core::{Interface, PCWSTR, PWSTR};
use windows::Win32::Foundation::{E_POINTER, HWND as ComHwnd, RECT as ComRect};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetClientRect, PostMessageW, WM_KEYDOWN};

use super::site::{WebPlace, WEB_PLACES};
use super::{content_left, scale_of, Tab, HEADER_H, WM_WEB};
use crate::applog;
use crate::win;

/// How long the web view may stay hidden, on native screens, before it is closed to give its memory back.
pub(super) const IDLE_CLOSE_MS: i64 = 5 * 60 * 1000;

/// What the site is told about the program, after WebView2's own user agent: the site's shell mode turns on when it sees it.
pub(super) const AGENT_TOKEN: &str = concat!("XpeedCompanion/", env!("CARGO_PKG_VERSION"));

/// The user agent is WebView2's own and ours after it.
pub(super) fn agent_with_token(default: &str) -> String {
    if default.contains("XpeedCompanion/") {
        default.to_owned()
    } else {
        format!("{} {AGENT_TOKEN}", default.trim_end())
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Addresses and the navigation policy (no window needed)
// ---------------------------------------------------------------------------------------------------------------------------------

/// Where an address lives: scheme, host (lower case) and port.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Origin {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

/// An http or https address taken apart: its origin and its path (always starting with `/`, without query or fragment).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Address {
    pub origin: Origin,
    pub path: String,
}

/// Takes an http(s) address apart. Anything else (another scheme, no host) is not an address the panel deals with.
pub(super) fn parse_address(url: &str) -> Option<Address> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    // Whatever comes before an `@` is a user name, not part of where the page lives.
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => (host, port.parse().ok()?),
        _ => (authority, default_port),
    };
    if host.is_empty() {
        return None;
    }
    let path = if tail.starts_with('/') {
        tail.split(['?', '#']).next().unwrap_or("/").to_owned()
    } else {
        "/".to_owned()
    };
    Some(Address {
        origin: Origin {
            scheme,
            host: host.to_ascii_lowercase(),
            port,
        },
        path,
    })
}

/// Whether `path` is `base` or something under it (`/virtual/sessions/42` is under `/virtual/sessions`; `/virtual/sessionsx` is not).
fn is_under(path: &str, base: &str) -> bool {
    path == base || path.strip_prefix(base).is_some_and(|rest| rest.starts_with('/'))
}

/// The place of `places` a page path belongs to: the one whose path is the longest prefix of it. A place that other places sit
/// under (`/virtual`, the overview) is the page only on itself (`/virtual` or `/virtual/`), so it does not claim all the rest.
pub(super) fn place_for_path(places: &[WebPlace], path: &str) -> Option<WebPlace> {
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let path = if path.len() > 1 { path.trim_end_matches('/') } else { path };
    let is_root = |p: &WebPlace| {
        places
            .iter()
            .any(|other| other.to != p.to && other.to.starts_with(p.to) && other.to[p.to.len()..].starts_with('/'))
    };
    places
        .iter()
        .filter(|p| if is_root(p) { path == p.to } else { is_under(path, p.to) })
        .max_by_key(|p| p.to.len())
        .copied()
}

/// The place of the site's Virtual menu an address is on, when it is on one (an address that is not http(s), or a page that is
/// no place of the menu, such as the sign-in page, is none: the sidebar keeps what it shows).
pub(super) fn place_for_url(url: &str) -> Option<WebPlace> {
    place_for_path(WEB_PLACES, &parse_address(url)?.path)
}

/// What the panel does with a navigation or a new window the page asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Nav {
    /// The site's own origin: shown in the panel (a new window of the site goes in the same view).
    InPlace,
    /// A host the site's sign-in needs (Google, Firebase): WebView2 opens its own pop-up window for it, so the sign-in's pop-ups
    /// still talk to the page that opened them.
    SignIn,
    /// Any other origin: not in the panel; the person's browser opens it.
    Browser,
    /// Not an http(s) address: nothing opens.
    Block,
}

/// Whether the host is one the site's sign-in uses as a pop-up: `accounts.google.com` and the rest of `*.google.com`,
/// `*.firebaseapp.com`, `*.web.app` and `www.recaptcha.net`.
pub(super) fn is_sign_in_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let under = |suffix: &str| host.len() > suffix.len() + 1 && host.ends_with(suffix) && host[..host.len() - suffix.len()].ends_with('.');
    host == "www.recaptcha.net" || under("google.com") || under("firebaseapp.com") || under("web.app")
}

/// What to do with `url` when the page lives on `server` (the origin the Companion is paired with).
pub(super) fn nav_policy(server: &str, url: &str) -> Nav {
    let Some(target) = parse_address(url) else {
        return Nav::Block;
    };
    if parse_address(server).is_some_and(|home| home.origin == target.origin) {
        Nav::InPlace
    } else if is_sign_in_host(&target.origin.host) {
        Nav::SignIn
    } else {
        Nav::Browser
    }
}

/// Where the web view sits in a window whose inside is `width` x `height` pixels: right of the sidebar, under the header, to the
/// window's right and bottom edges. `(left, top, right, bottom)`, never inverted.
pub(super) fn content_bounds(width: i32, height: i32, scale: f32) -> (i32, i32, i32, i32) {
    let left = content_left(scale).min(width);
    let top = ((HEADER_H * scale).round() as i32).min(height);
    (left, top, width.max(left), height.max(top))
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The web view
// ---------------------------------------------------------------------------------------------------------------------------------

enum Phase {
    /// Not made (yet, or closed).
    Idle,
    /// WebView2 is starting; the completion handlers will say how it went.
    Creating,
    Ready {
        controller: ICoreWebView2Controller,
        view: ICoreWebView2,
    },
}

/// What the completion handlers and events write and the window reads.
struct Slot {
    phase: Phase,
    /// Bumped each time the web view is closed, so a handler of an earlier start knows it is too late.
    generation: u32,
    /// The address to show as soon as the view exists.
    want: Option<String>,
    /// The origin the panel is paired with, for the navigation policy.
    server: String,
    /// The page's latest address, until the window has read it.
    url: Option<String>,
    /// The page's address as last read (kept: the place it is on).
    current: String,
    /// WebView2 could not be used: from now on a place opens in the browser.
    failed: bool,
    /// The failure has not been told to the window yet.
    failure_pending: bool,
    /// What was last given to the controller: bounds `(l, t, r, b)` and visibility.
    applied: Option<((i32, i32, i32, i32), bool)>,
    /// Since when (ms) the view is hidden on a native screen.
    hidden_since: Option<i64>,
}

/// The web view of the panel window.
pub(super) struct Web {
    slot: Rc<RefCell<Slot>>,
}

impl Default for Web {
    fn default() -> Self {
        Web {
            slot: Rc::new(RefCell::new(Slot {
                phase: Phase::Idle,
                generation: 0,
                want: None,
                server: String::new(),
                url: None,
                current: String::new(),
                failed: false,
                failure_pending: false,
                applied: None,
                hidden_since: None,
            })),
        }
    }
}

fn com_hwnd(hwnd: HWND) -> ComHwnd {
    ComHwnd(hwnd.cast())
}

/// The first address of a page: with the shell mark too (harmless; the user agent is the signal that stays).
fn first_address(url: &str) -> String {
    if url.contains('?') {
        format!("{url}&shell=companion")
    } else {
        format!("{url}?shell=companion")
    }
}

impl Web {
    /// The web view is made and showing something (a click on the window's chrome takes the keyboard back from it).
    pub(super) fn ready(&self) -> bool {
        matches!(self.slot.borrow().phase, Phase::Ready { .. })
    }

    /// Shows the page of `place` of the site at `server`. `from_native` is a click that comes from a native screen: the page
    /// that was open comes back as it was (when it is on that place), not reloaded. Returns false when the web view cannot be used
    /// (the caller opens the browser).
    pub(super) fn show(&self, hwnd: HWND, server: &str, place: WebPlace, from_native: bool) -> bool {
        let url = format!("{server}{}", place.to);
        let (phase_ready, current) = {
            let mut slot = self.slot.borrow_mut();
            if slot.failed {
                return false;
            }
            slot.server = server.to_owned();
            (matches!(slot.phase, Phase::Ready { .. }), slot.current.clone())
        };
        if phase_ready {
            let on_place = parse_address(&current).is_some_and(|a| a.path.trim_end_matches('/') == place.to);
            let same_place = place_for_url(&current) == Some(place);
            // From a native screen the page comes back as it was when it is on this place; a click on the place that is already
            // showing goes to its main page, unless it is there.
            if !(on_place || (from_native && same_place)) {
                self.navigate(&url);
            }
            self.focus();
            return true;
        }
        let creating = matches!(self.slot.borrow().phase, Phase::Creating);
        self.slot.borrow_mut().want = Some(first_address(&url));
        if creating {
            return true;
        }
        start(&self.slot, hwnd)
    }

    /// The page navigates to `url` (the site's address).
    fn navigate(&self, url: &str) {
        let view = match &self.slot.borrow().phase {
            Phase::Ready { view, .. } => view.clone(),
            _ => return,
        };
        let wide = win::wide(url);
        if let Err(why) = unsafe { view.Navigate(PCWSTR(wide.as_ptr())) } {
            applog::line(&format!("web view: could not go to {url}: {why}"));
        }
    }

    /// Gives the keyboard to the page.
    fn focus(&self) {
        let controller = match &self.slot.borrow().phase {
            Phase::Ready { controller, .. } => controller.clone(),
            _ => return,
        };
        let _ = unsafe { controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
    }

    /// Keeps the web view as the window needs it: shown in the content area while a place is on screen, hidden otherwise, and
    /// closed after `IDLE_CLOSE_MS` on native screens. Cheap: it only calls WebView2 when something changed.
    pub(super) fn reconcile(&self, hwnd: HWND, tab: &Tab, now: i64) {
        let showing = matches!(tab, Tab::Web(_));
        let (controller, applied) = {
            let mut slot = self.slot.borrow_mut();
            let Phase::Ready { controller, .. } = &slot.phase else {
                return;
            };
            let controller = controller.clone();
            if showing {
                slot.hidden_since = None;
            } else {
                let since = *slot.hidden_since.get_or_insert(now);
                if now - since >= IDLE_CLOSE_MS {
                    drop(slot);
                    self.close();
                    return;
                }
            }
            (controller, slot.applied)
        };
        let mut client: RECT = unsafe { std::mem::zeroed() };
        unsafe { GetClientRect(hwnd, &mut client) };
        let bounds = content_bounds(client.right, client.bottom, scale_of(hwnd));
        let want = (bounds, showing && client.right > 0 && client.bottom > 0);
        if applied == Some(want) {
            return;
        }
        unsafe {
            if applied.map(|(b, _)| b) != Some(bounds) {
                let _ = controller.SetBounds(ComRect {
                    left: bounds.0,
                    top: bounds.1,
                    right: bounds.2,
                    bottom: bounds.3,
                });
                let _ = controller.NotifyParentWindowPositionChanged();
            }
            if applied.map(|(_, v)| v) != Some(want.1) {
                let _ = controller.SetIsVisible(want.1);
            }
        }
        self.slot.borrow_mut().applied = Some(want);
    }

    /// Closes the web view (the window is closing, or it has been on native screens for long). The next click makes it again.
    pub(super) fn close(&self) {
        let phase = {
            let mut slot = self.slot.borrow_mut();
            slot.generation = slot.generation.wrapping_add(1);
            slot.applied = None;
            slot.hidden_since = None;
            slot.want = None;
            std::mem::replace(&mut slot.phase, Phase::Idle)
        };
        if let Phase::Ready { controller, .. } = phase {
            let _ = unsafe { controller.Close() };
        }
    }

    /// The page's address, when it changed since the last time.
    pub(super) fn take_url(&self) -> Option<String> {
        self.slot.borrow_mut().url.take()
    }

    /// Whether the web view stopped working since the last time this was asked (the window then opens the place in the browser).
    pub(super) fn take_failure(&self) -> bool {
        std::mem::take(&mut self.slot.borrow_mut().failure_pending)
    }
}

/// Where WebView2 keeps what the page stores (the sign-in among it): the Companion's own folder.
fn user_data_folder() -> Option<std::path::PathBuf> {
    crate::config::home_dir().map(|home| home.join("WebView"))
}

/// Records that the web view cannot be used, in the log and for the window.
fn fail(slot: &Rc<RefCell<Slot>>, hwnd: HWND, why: &str) {
    applog::line(&format!("web view: {why}; the site's places open in the browser from now on"));
    let mut s = slot.borrow_mut();
    s.failed = true;
    s.failure_pending = true;
    s.phase = Phase::Idle;
    s.want = None;
    drop(s);
    unsafe {
        PostMessageW(hwnd, WM_WEB, 0, 0);
    }
}

/// Starts making the environment and then the controller. Returns false when it cannot even start (no WebView2 runtime): the
/// failure is recorded and the caller opens the browser. Otherwise it returns at once; the handlers finish the work.
fn start(slot: &Rc<RefCell<Slot>>, hwnd: HWND) -> bool {
    let Some(folder) = user_data_folder() else {
        fail(slot, hwnd, "no folder for the web view's data");
        return false;
    };
    let _ = std::fs::create_dir_all(&folder);
    // WebView2 needs an apartment-threaded COM thread with a message loop: the window's thread is one. (Already initialised that
    // way is fine; a thread that is already multi-threaded would fail below, and the browser takes over.)
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    let generation = {
        let mut s = slot.borrow_mut();
        s.phase = Phase::Creating;
        s.generation
    };
    let weak = Rc::downgrade(slot);
    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |result, environment| {
        let Some(slot) = weak.upgrade() else { return Ok(()) };
        if slot.borrow().generation != generation {
            return Ok(());
        }
        let made = (|| -> windows::core::Result<()> {
            result?;
            let environment = environment.ok_or_else(|| windows::core::Error::from(E_POINTER))?;
            let weak = Rc::downgrade(&slot);
            let controller_done = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(move |result, controller| {
                if let Some(slot) = weak.upgrade() {
                    controller_made(&slot, hwnd, generation, result, controller);
                } else if let Some(controller) = controller {
                    let _ = unsafe { controller.Close() };
                }
                Ok(())
            }));
            unsafe { environment.CreateCoreWebView2Controller(com_hwnd(hwnd), &controller_done) }
        })();
        if let Err(why) = made {
            fail(&slot, hwnd, &format!("could not make the web view ({why})"));
        }
        Ok(())
    }));
    let wide_folder = win::wide(&folder.to_string_lossy());
    let started = unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            PCWSTR::null(),
            PCWSTR(wide_folder.as_ptr()),
            None::<&ICoreWebView2EnvironmentOptions>,
            &handler,
        )
    };
    match started {
        Ok(()) => true,
        Err(why) => {
            fail(slot, hwnd, &format!("WebView2 could not start ({why}); is its runtime installed?"));
            false
        }
    }
}

/// The controller is there (or it failed): set the view up and show the page that was asked for.
fn controller_made(
    slot: &Rc<RefCell<Slot>>,
    hwnd: HWND,
    generation: u32,
    result: windows::core::Result<()>,
    controller: Option<ICoreWebView2Controller>,
) {
    if slot.borrow().generation != generation {
        // The window closed it while it was being made.
        if let Some(controller) = controller {
            let _ = unsafe { controller.Close() };
        }
        return;
    }
    let controller = match (result, controller) {
        (Ok(()), Some(controller)) => controller,
        (Err(why), _) => return fail(slot, hwnd, &format!("could not make the web view ({why})")),
        (Ok(()), None) => return fail(slot, hwnd, "could not make the web view (no controller)"),
    };
    let setup = (|| -> windows::core::Result<ICoreWebView2> {
        let view = unsafe { controller.CoreWebView2()? };
        configure(slot, hwnd, &controller, &view)?;
        Ok(view)
    })();
    match setup {
        Ok(view) => {
            let want = {
                let mut s = slot.borrow_mut();
                s.phase = Phase::Ready {
                    controller: controller.clone(),
                    view: view.clone(),
                };
                s.applied = None;
                s.want.take()
            };
            // Bounds and visibility are settled by the window's next `reconcile` (a message away); the page can start loading now.
            unsafe {
                let _ = controller.SetIsVisible(false);
            }
            if let Some(url) = want {
                let wide = win::wide(&url);
                if let Err(why) = unsafe { view.Navigate(PCWSTR(wide.as_ptr())) } {
                    applog::line(&format!("web view: could not go to {url}: {why}"));
                }
            }
            unsafe {
                let _ = controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                PostMessageW(hwnd, WM_WEB, 0, 0);
            }
        }
        Err(why) => {
            let _ = unsafe { controller.Close() };
            fail(slot, hwnd, &format!("could not set the web view up ({why})"));
        }
    }
}

/// The user agent, the events the panel listens to.
fn configure(
    slot: &Rc<RefCell<Slot>>,
    hwnd: HWND,
    controller: &ICoreWebView2Controller,
    view: &ICoreWebView2,
) -> windows::core::Result<()> {
    unsafe {
        // The site's shell mode turns on from the user agent: WebView2's own plus ours.
        let settings = view.Settings()?;
        if let Ok(settings) = settings.cast::<ICoreWebView2Settings2>() {
            let mut current = PWSTR::null();
            settings.UserAgent(&mut current)?;
            let agent = agent_with_token(&take_pwstr(current));
            let wide = win::wide(&agent);
            settings.SetUserAgent(PCWSTR(wide.as_ptr()))?;
        }
        let mut token = 0i64;

        // Navigations: the site's own origin loads here; the sign-in hosts are let through; any other origin goes to the browser.
        let weak = Rc::downgrade(slot);
        view.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                match nav_policy(&server_of(&weak), &uri) {
                    Nav::InPlace | Nav::SignIn => {}
                    Nav::Browser => {
                        args.SetCancel(true)?;
                        win::open(&uri);
                    }
                    Nav::Block => args.SetCancel(true)?,
                }
                Ok(())
            })),
            &mut token,
        )?;

        // New windows: the site's own go in this view; the sign-in's are left to WebView2 (its own pop-up window); others open in
        // the browser.
        let weak = Rc::downgrade(slot);
        view.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(move |view, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                match nav_policy(&server_of(&weak), &uri) {
                    Nav::SignIn => {}
                    Nav::InPlace => {
                        args.SetHandled(true)?;
                        if let Some(view) = view {
                            let wide = win::wide(&uri);
                            view.Navigate(PCWSTR(wide.as_ptr()))?;
                        }
                    }
                    Nav::Browser => {
                        args.SetHandled(true)?;
                        win::open(&uri);
                    }
                    Nav::Block => args.SetHandled(true)?,
                }
                Ok(())
            })),
            &mut token,
        )?;

        // The address changed (also inside the page, without a load): the window moves the sidebar's mark to the place it is on.
        let weak = Rc::downgrade(slot);
        view.add_SourceChanged(
            &SourceChangedEventHandler::create(Box::new(move |view, _| {
                let Some(view) = view else { return Ok(()) };
                let mut source = PWSTR::null();
                view.Source(&mut source)?;
                let source = take_pwstr(source);
                if let Some(slot) = weak.upgrade() {
                    let mut s = slot.borrow_mut();
                    s.current = source.clone();
                    s.url = Some(source);
                    drop(s);
                    PostMessageW(hwnd, WM_WEB, 0, 0);
                }
                Ok(())
            })),
            &mut token,
        )?;

        // F11 (full screen) keeps working while the page has the keyboard: it goes to the panel as it would from its own.
        controller.add_AcceleratorKeyPressed(
            &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let (mut kind, mut key) = (COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, 0u32);
                args.KeyEventKind(&mut kind)?;
                args.VirtualKey(&mut key)?;
                const VK_F11: u32 = 0x7a;
                if kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && key == VK_F11 {
                    args.SetHandled(true)?;
                    PostMessageW(hwnd, WM_KEYDOWN, key as usize, 0);
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

/// The origin the panel is paired with (what the navigation policy compares with).
fn server_of(slot: &Weak<RefCell<Slot>>) -> String {
    slot.upgrade().map(|slot| slot.borrow().server.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(to: &'static str) -> WebPlace {
        WebPlace {
            to,
            group: "g",
            icon: "Icon",
            label: [to; 3],
        }
    }

    fn menu() -> Vec<WebPlace> {
        [
            "/virtual",
            "/virtual/sessions",
            "/virtual/leaderboards",
            "/virtual/friends",
            "/virtual/tracks",
            "/virtual/cars",
        ]
        .into_iter()
        .map(place)
        .collect()
    }

    fn at(path: &str) -> Option<&'static str> {
        place_for_path(&menu(), path).map(|p| p.to)
    }

    #[test]
    fn parses_an_address_into_origin_and_path() {
        let a = parse_address("https://Xpeed.Skale.club/virtual/sessions?x=1#top").unwrap();
        assert_eq!(
            a.origin,
            Origin {
                scheme: "https".into(),
                host: "xpeed.skale.club".into(),
                port: 443
            }
        );
        assert_eq!(a.path, "/virtual/sessions");
        assert_eq!(parse_address("http://localhost:3000").unwrap().path, "/");
        assert_eq!(parse_address("http://localhost:3000/a").unwrap().origin.port, 3000);
        assert_eq!(parse_address("https://me@host.test:8443/p").unwrap().origin.host, "host.test");
        assert_eq!(parse_address("https://host.test?q=/virtual").unwrap().path, "/");
        for not in [
            "",
            "about:blank",
            "mailto:a@b.c",
            "data:text/html,x",
            "file:///c:/a",
            "javascript:1",
            "https://",
            "ftp://h/p",
        ] {
            assert_eq!(parse_address(not), None, "{not}");
        }
    }

    #[test]
    fn the_longest_place_path_wins() {
        assert_eq!(at("/virtual/sessions"), Some("/virtual/sessions"));
        assert_eq!(at("/virtual/sessions/"), Some("/virtual/sessions"));
        assert_eq!(at("/virtual/sessions/abc123"), Some("/virtual/sessions"));
        assert_eq!(at("/virtual/leaderboards/ac/monza"), Some("/virtual/leaderboards"));
        assert_eq!(at("/virtual/cars"), Some("/virtual/cars"));
        assert_eq!(at("/virtual/tracks/imola"), Some("/virtual/tracks"));
        // A longer name that only starts with a place's is not under it.
        assert_eq!(at("/virtual/sessionsx"), None);
        assert_eq!(at("/virtual/carsx/1"), None);
    }

    #[test]
    fn the_overview_is_only_itself() {
        assert_eq!(at("/virtual"), Some("/virtual"));
        assert_eq!(at("/virtual/"), Some("/virtual"));
        assert_eq!(at("/virtual/unknown"), None, "the overview does not claim the pages under it");
        assert_eq!(at("/virtual/unknown/deep"), None);
        assert_eq!(at("/"), None);
        assert_eq!(at("/login"), None);
        assert_eq!(at("/settings"), None);
        // A query or a fragment is not part of the path.
        assert_eq!(at("/virtual/friends?tab=requests"), Some("/virtual/friends"));
    }

    #[test]
    fn a_place_with_nothing_under_it_claims_its_subpages() {
        let places = vec![place("/a"), place("/b")];
        assert_eq!(place_for_path(&places, "/a/x/y").map(|p| p.to), Some("/a"));
        assert_eq!(place_for_path(&places, "/c"), None);
    }

    #[test]
    fn the_real_menu_matches_its_own_places() {
        for p in WEB_PLACES {
            assert_eq!(place_for_url(&format!("https://xpeed.skale.club{}", p.to)), Some(*p), "{}", p.to);
            assert_eq!(place_for_url(&format!("https://xpeed.skale.club{}/", p.to)), Some(*p), "{}/", p.to);
        }
        assert_eq!(
            place_for_url("https://xpeed.skale.club/virtual/sessions/s1").map(|p| p.to),
            Some("/virtual/sessions")
        );
        assert_eq!(place_for_url("about:blank"), None);
        assert_eq!(place_for_url("https://xpeed.skale.club/login"), None);
    }

    const SERVER: &str = "https://xpeed.skale.club";

    #[test]
    fn the_sites_own_origin_loads_in_place() {
        assert_eq!(nav_policy(SERVER, "https://xpeed.skale.club/virtual/sessions"), Nav::InPlace);
        assert_eq!(nav_policy(SERVER, "https://XPEED.skale.club/"), Nav::InPlace);
        assert_eq!(nav_policy(SERVER, "https://xpeed.skale.club:443/x"), Nav::InPlace);
        // Another scheme, host or port is another origin.
        assert_eq!(nav_policy(SERVER, "http://xpeed.skale.club/"), Nav::Browser);
        assert_eq!(nav_policy(SERVER, "https://xpeed.skale.club:8443/"), Nav::Browser);
        assert_eq!(nav_policy(SERVER, "https://skale.club/"), Nav::Browser);
        assert_eq!(nav_policy(SERVER, "https://xpeed.skale.club.evil.test/"), Nav::Browser);
        // The server follows the configuration (a domain move, a local test server).
        assert_eq!(nav_policy("https://xpeed.app", "https://xpeed.app/virtual"), Nav::InPlace);
        assert_eq!(nav_policy("http://localhost:5173", "http://localhost:5173/virtual"), Nav::InPlace);
    }

    #[test]
    fn the_sign_in_hosts_get_their_own_popup() {
        for url in [
            "https://accounts.google.com/o/oauth2/auth",
            "https://apis.google.com/js/api.js",
            "https://xpeed-1234.firebaseapp.com/__/auth/handler",
            "https://xpeed-1234.web.app/__/auth/handler",
            "https://www.recaptcha.net/recaptcha/api2/anchor",
        ] {
            assert_eq!(nav_policy(SERVER, url), Nav::SignIn, "{url}");
        }
        // Only those hosts, not look-alikes.
        for url in [
            "https://google.com/",
            "https://evilgoogle.com/",
            "https://accounts.google.com.evil.test/",
            "https://firebaseapp.com/",
            "https://notweb.app/",
            "https://recaptcha.net/",
            "https://example.com/",
        ] {
            assert_eq!(nav_policy(SERVER, url), Nav::Browser, "{url}");
        }
    }

    #[test]
    fn only_http_and_https_open_anything() {
        for url in [
            "javascript:alert(1)",
            "file:///c:/windows/win.ini",
            "mailto:a@b.c",
            "data:text/html,hi",
            "about:blank",
            "blob:https://xpeed.skale.club/1",
        ] {
            assert_eq!(nav_policy(SERVER, url), Nav::Block, "{url}");
        }
    }

    #[test]
    fn the_user_agent_gets_our_token_once() {
        let default =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
        let with = agent_with_token(default);
        assert!(with.starts_with(default));
        assert!(with.ends_with(&format!(" XpeedCompanion/{}", env!("CARGO_PKG_VERSION"))));
        assert_eq!(agent_with_token(&with), with, "never added twice");
    }

    #[test]
    fn the_first_address_carries_the_shell_mark() {
        assert_eq!(first_address("https://x.test/virtual"), "https://x.test/virtual?shell=companion");
        assert_eq!(first_address("https://x.test/a?b=1"), "https://x.test/a?b=1&shell=companion");
    }

    #[test]
    fn the_view_fills_the_content_area() {
        let (l, t, r, b) = content_bounds(1180, 640, 1.0);
        assert_eq!((l, t, r, b), (48, 66, 1180, 640));
        let (l, t, r, b) = content_bounds(1180, 640, 1.5);
        assert_eq!((l, t), (72, 99));
        assert_eq!((r, b), (1180, 640));
        // A window smaller than the chrome never gives an inverted box.
        let (l, t, r, b) = content_bounds(30, 40, 1.0);
        assert!(l <= r && t <= b);
    }
}
