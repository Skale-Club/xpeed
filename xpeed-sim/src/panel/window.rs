use super::*;

pub(super) const CLASS: &str = "XpeedSimPanel";

/// `WM_MOUSELEAVE`, sent once after `TrackMouseEvent` asked for it.
pub(super) const WM_MOUSELEAVE: u32 = 0x02a3;

/// Covers fetched in the background have arrived: read them again.
pub(super) const WM_COVERS: u32 = 0x8000 + 20;

pub(super) const WM_BRAND_DONE: u32 = 0x8000 + 21;

pub(super) const WM_MOUSEMOVE: u32 = 0x0200;

pub(super) const TIMER: usize = 1;

/// About 60 frames a second, so the carousel and the revs move smoothly.
pub(super) const FRAME_MS: u32 = 16;

/// A reading older than this is not shown as live.
pub(super) const STALE_MS: i64 = 3000;

/// Design size of the window at 96 DPI.
pub(super) const WIDTH: i32 = 1180;

pub(super) const HEIGHT: i32 = 640;

pub(super) const MIN_WIDTH: i32 = 360;

pub(super) const MIN_HEIGHT: i32 = 480;

pub(super) struct State {
    /// The back buffer frames are drawn into, kept for the window's size.
    pub(super) buffer: Option<Backdrop>,
    /// Where the mouse is over the window, while it is.
    pub(super) mouse: Option<(i32, i32)>,
    /// The buttons of the last frame, to know what a click hit.
    pub(super) buttons: Vec<(Action, RECT)>,
    /// The covers' carousel on the waiting screen.
    pub(super) carousel: Carousel,
    /// How far the games list is scrolled (design units), its bar in the last frame, and the thumb being dragged
    /// (where the mouse was pressed, and the scroll then).
    pub(super) games_scroll: f32,
    pub(super) scroll: Option<ScrollBar>,
    pub(super) drag: Option<(i32, f32)>,
    /// A press on the waiting screen's carousel: where (pixels), where the carousel was, and whether it has become a
    /// drag. A press that never moved acts as a click when the button comes up.
    pub(super) press: Option<(i32, i32, f32, bool)>,
    /// The carousel's step from one cover to the next (pixels), from the last frame that drew it.
    pub(super) carousel_step: f32,
    /// The language list is open.
    pub(super) lang_open: bool,
    /// When the diagnostics were last copied (Unix ms; 0 for never).
    pub(super) copied_at: i64,
    pub(super) ctx: Context,
    /// The games' covers, read when the window opens.
    pub(super) covers: Vec<CoverArt>,
    pub(super) brands: Vec<BrandArt>,
    pub(super) brand_requested: Option<String>,
    pub(super) brand_inflight: bool,
    pub(super) brand_retry_after: i64,
    /// The games installed here, read when the window opens and each time it comes to the front.
    pub(super) installed: Option<HashSet<&'static str>>,
    pub(super) tab: Tab,
    pub(super) on_top: bool,
    /// Full screen: where the window was and its style, to put it back.
    pub(super) full: Option<(WINDOWPLACEMENT, isize)>,
}

pub(super) fn scale_of(hwnd: HWND) -> f32 {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        1.0
    } else {
        dpi as f32 / 96.0
    }
}

pub(super) unsafe fn paint_window(hwnd: HWND, state: &mut State) {
    let mut ps: PAINTSTRUCT = std::mem::zeroed();
    let hdc = BeginPaint(hwnd, &mut ps);
    let mut client = rect(0, 0, 0, 0);
    GetClientRect(hwnd, &mut client);
    let (w, h) = (client.right.max(1), client.bottom.max(1));
    // The back buffer is kept between frames (a new 8 MB bitmap every frame cost time), and remade when the size
    // changes.
    if state.buffer.as_ref().is_none_or(|b| b.key != (w, h, 0)) {
        state.buffer = Some(Backdrop::new(hdc, (w, h, 0), |_| {}));
    }
    let memory = state.buffer.as_ref().map_or(null_mut(), |b| b.dc);

    let ctx = &state.ctx;
    let snapshot = ctx.shared.snapshot();
    let live = ctx.shared.live();
    let games = game_rows(ctx, state.installed.as_ref());
    let account = lock(&ctx.account).clone();
    let recent_laps = ctx.shared.recent_laps();
    let activity: Vec<(String, String)> = ctx
        .shared
        .activity()
        .into_iter()
        .rev()
        .map(|(ms, event)| {
            let time = local_time(ms);
            (
                time.get(..5).unwrap_or(&time).to_owned(),
                text(account.lang, &activity_message(event)),
            )
        })
        .collect();
    let now = now_ms();
    state.carousel.tick(now);
    let failed = ctx
        .shared
        .failed_workers()
        .into_iter()
        .map(crate::supervisor::title)
        .collect::<Vec<_>>()
        .join(", ");
    let update = ctx.shared.update_state();
    let view = View {
        lang: account.lang,
        tab: state.tab,
        on_top: state.on_top,
        full: state.full.is_some(),
        scale: scale_of(hwnd),
        now_ms: now,
        snapshot: &snapshot,
        live: live.as_ref(),
        games: &games,
        device: account.device.as_deref(),
        server: &account.server,
        card: crate::connect::card(
            matches!(snapshot.cloud, Cloud::Idle | Cloud::Waiting(_)),
            &crate::connect::Flow::global().phase(),
            account.label.as_deref(),
        ),
        recent_laps: &recent_laps,
        activity: &activity,
        covers: &state.covers,
        brands: &state.brands,
        mouse: state.mouse,
        buttons: Default::default(),
        carousel: state.carousel.at(now),
        games_scroll: state.games_scroll,
        scroll: Default::default(),
        carousel_step: Default::default(),
        lang_open: state.lang_open,
        copied: state.copied_at > 0 && now - state.copied_at < COPIED_FOR_MS,
        failed: &failed,
        update: &update,
        focus: focus_of(&ctx.shared.games()),
    };
    paint(memory, w, h, &view);
    state.buttons = view.buttons.take();
    state.scroll = view.scroll.get();
    if view.carousel_step.get() > 0.0 {
        state.carousel_step = view.carousel_step.get();
    }
    state.games_scroll = state.games_scroll.clamp(0.0, state.scroll.map_or(0.0, |bar| bar.max));
    BitBlt(hdc, 0, 0, w, h, memory, 0, 0, SRCCOPY);
    EndPaint(hwnd, &ps);
}

pub(super) fn set_on_top(hwnd: HWND, on: bool) {
    unsafe {
        SetWindowPos(
            hwnd,
            if on { HWND_TOPMOST } else { HWND_NOTOPMOST },
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// Fills the screen the window is on, or puts it back where it was (the usual way: drop the frame, cover the
/// monitor; then restore the style and the placement).
/// The dashboard tab shows the waiting screen (no reading, or none for a while).
/// Whether the window shows something in motion: the dashboard's live readings, or a cover sliding.
pub(super) fn moving(state: &State) -> bool {
    if state.tab != Tab::Dash {
        return false;
    }
    let now = now_ms();
    !waiting_now(state) || now - state.carousel.since < SLIDE_MS
}

/// Whether the point (in the window's pixels) is on something a click acts on: a tab, a header button or a button
/// of the last frame.
pub(super) unsafe fn clickable(hwnd: HWND, state: &State, x: i32, y: i32) -> bool {
    let mut client = rect(0, 0, 0, 0);
    GetClientRect(hwnd, &mut client);
    header_hits(client.right, scale_of(hwnd)).iter().any(|r| inside(r, x, y))
        || state.buttons.iter().any(|(_, r)| inside(r, x, y))
        || (state.tab == Tab::Monitor && state.scroll.is_some_and(|bar| inside(&bar.thumb, x, y)))
}

/// Reads again which games are installed, and their covers when that changed.
pub(super) fn refresh_installed(state: &mut State) {
    let now = Some(crate::installed::keys());
    if now != state.installed || state.covers.is_empty() {
        state.installed = now;
        state.covers = CoverArt::load(state.installed.as_ref());
        state.games_scroll = 0.0;
    }
}

/// How long the Monitor tab says "Copied" after the diagnostics were copied.
pub(super) const COPIED_FOR_MS: i64 = 2000;

/// The support text for this moment, on the clipboard. The games are the ones the Monitor tab lists, with their state
/// in English (the text is for support, whatever language the person uses).
pub(super) unsafe fn copy_diagnostics(hwnd: HWND, state: &mut State) -> bool {
    let account = lock(&state.ctx.account).clone();
    let games: Vec<(String, String)> = game_rows(&state.ctx, state.installed.as_ref())
        .into_iter()
        .map(|row| (row.title, state_text(Lang::En, &row.state)))
        .collect();
    let report = crate::diagnostics::collect(
        &state.ctx.shared,
        &games,
        &account.server,
        account.device.as_deref(),
        account.label.as_deref(),
    );
    match win::copy_to_clipboard(hwnd, &report) {
        Ok(()) => true,
        Err(why) => {
            crate::applog::line(&format!("could not copy the diagnostics: {why}"));
            false
        }
    }
}

/// A click on the carousel (a press that did not move): a square or a side cover brings that game to the middle;
/// elsewhere, left of the middle goes back one and right of it goes on one.
pub(super) unsafe fn carousel_click(hwnd: HWND, state: &mut State, x: i32, y: i32) {
    let now = now_ms();
    if let Some(&(Action::Cover(i), _)) = state.buttons.iter().find(|(_, r)| inside(r, x, y)) {
        let steps = carousel_steps(state.carousel.target, i, state.covers.len());
        if steps != 0 {
            state.carousel.step(steps, now);
        }
        return;
    }
    let mut client = rect(0, 0, 0, 0);
    GetClientRect(hwnd, &mut client);
    state.carousel.step(if x < client.right / 2 { -1 } else { 1 }, now);
}

/// The person picked a language in the panel: shown at once here, and the tray (which keeps it in the settings and
/// shows it in its menu) is told, so both always say the same.
pub(super) fn choose_lang(state: &mut State, lang: Lang) {
    lock(&state.ctx.account).lang = lang;
    crate::tray::set_lang_of_running(lang);
}

pub(super) fn waiting_now(state: &State) -> bool {
    state.tab == Tab::Dash && state.ctx.shared.live().is_none_or(|l| now_ms() - l.at_ms > STALE_MS)
}

pub(super) unsafe fn toggle_full(hwnd: HWND, state: &mut State) {
    if let Some((placement, style)) = state.full.take() {
        SetWindowLongPtrW(hwnd, GWL_STYLE, style);
        SetWindowPlacement(hwnd, &placement);
        SetWindowPos(
            hwnd,
            null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED,
        );
        return;
    }
    let mut placement: WINDOWPLACEMENT = std::mem::zeroed();
    placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
    let mut monitor: MONITORINFO = std::mem::zeroed();
    monitor.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if GetWindowPlacement(hwnd, &mut placement) == 0
        || GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut monitor) == 0
    {
        return;
    }
    let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    SetWindowLongPtrW(hwnd, GWL_STYLE, style & !(WS_OVERLAPPEDWINDOW as isize));
    let r = monitor.rcMonitor;
    SetWindowPos(
        hwnd,
        if state.on_top { HWND_TOPMOST } else { HWND_TOP },
        r.left,
        r.top,
        r.right - r.left,
        r.bottom - r.top,
        SWP_NOOWNERZORDER | SWP_FRAMECHANGED,
    );
    state.full = Some((placement, style));
}

/// Guards the panel's window procedure: a panic must not unwind out of an `extern "system"` function (that aborts the
/// whole program, and the recording with it).
pub(super) static PANEL_GUARD: crate::supervisor::UiGuard = crate::supervisor::UiGuard::new();

/// The window procedure Windows calls; the real one is `window_proc_body`, run inside `PANEL_GUARD`. A panic is already in
/// the log and the crash report (the panic hook), and here it only means "this message was not handled": the window stays
/// alive, the recording threads never notice. After 5 panics in a minute the panel stops drawing its screens (the next
/// paint would fail the same way) and says so in plain words, and the tray shows one balloon.
pub(super) unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_CREATE {
        // A new panel window starts clean, even after an earlier one gave up.
        PANEL_GUARD.reset();
    }
    if PANEL_GUARD.tripped() {
        match message {
            WM_PAINT => {
                paint_failed(hwnd);
                return 0;
            }
            WM_TIMER => {
                // Nothing moves any more: stop the frame timer instead of repainting the same message.
                windows_sys::Win32::UI::WindowsAndMessaging::KillTimer(hwnd, TIMER);
                return 0;
            }
            _ => {}
        }
    }
    match PANEL_GUARD.run(|| window_proc_body(hwnd, message, wparam, lparam)) {
        Ok(result) => result,
        Err(panic) => {
            if panic == crate::supervisor::UiPanic::JustTripped {
                crate::applog::line("the panel failed 5 times in a minute; it stopped drawing and the recording is not affected");
                crate::tray::panel_failed_of_running();
                windows_sys::Win32::Graphics::Gdi::InvalidateRect(hwnd, null(), 0);
            }
            DefWindowProcW(hwnd, message, wparam, lparam)
        }
    }
}

/// What the panel shows once it gave up drawing: a plain sentence on a plain background. Nothing here can panic (no text
/// tables, no state of the panel, only drawing calls with constant text).
pub(super) unsafe fn paint_failed(hwnd: HWND) {
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect, SetBkMode, SetTextColor, DT_CENTER, DT_WORDBREAK,
        PAINTSTRUCT, TRANSPARENT,
    };
    let mut paint: PAINTSTRUCT = std::mem::zeroed();
    let hdc = BeginPaint(hwnd, &mut paint);
    if hdc.is_null() {
        return;
    }
    let mut area: RECT = std::mem::zeroed();
    GetClientRect(hwnd, &mut area);
    let background = CreateSolidBrush(0x0020_1a14); // BGR of a dark blue-grey
    FillRect(hdc, &area, background);
    DeleteObject(background);
    SetBkMode(hdc, TRANSPARENT as i32);
    SetTextColor(hdc, 0x00f0_ebe6);
    let text: Vec<u16> = "Something went wrong drawing the panel. Recording continues."
        .encode_utf16()
        .collect();
    let mut inner = RECT {
        left: area.left + 24,
        top: area.top + (area.bottom - area.top) / 3,
        right: (area.right - 24).max(area.left + 25),
        bottom: area.bottom.max(area.top + 1),
    };
    DrawTextW(hdc, text.as_ptr(), text.len() as i32, &mut inner, DT_CENTER | DT_WORDBREAK);
    EndPaint(hwnd, &paint);
}

pub(super) unsafe fn window_proc_body(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_NCCREATE {
        let create = lparam as *const CREATESTRUCTW;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, (*create).lpCreateParams as isize);
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State;
    if state.is_null() {
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    let state = &mut *state;
    match message {
        WM_CREATE => {
            SetTimer(hwnd, TIMER, FRAME_MS, None);
            SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, state.ctx.icon_big as isize);
            SendMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, state.ctx.icon_small as isize);
            0
        }
        WM_TIMER => {
            fetch_brand_if_needed(hwnd, state);
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_ERASEBKGND => 1,
        WM_PAINT => {
            paint_window(hwnd, state);
            // While something moves (a cover sliding, the live readings), the next frame follows the screen's own
            // refresh: wait for the compositor's next pass, then ask for another frame. The timer alone ticks
            // unevenly (Windows' timer granularity), which shows as stutter even when every frame is fast.
            if moving(state) && IsIconic(hwnd) == 0 {
                DwmFlush();
                InvalidateRect(hwnd, null(), 0);
            }
            0
        }
        WM_LBUTTONDOWN
            if !state.lang_open
                && state.tab == Tab::Monitor
                && state.scroll.is_some_and(|bar| {
                    let (x, y) = ((lparam & 0xffff) as i16 as i32, ((lparam >> 16) & 0xffff) as i16 as i32);
                    inside(&bar.track, x, y)
                }) =>
        {
            // On the games list's bar: a press on the thumb drags it; on the track, the thumb jumps there first.
            let y = ((lparam >> 16) & 0xffff) as i16 as i32;
            if let Some(bar) = state.scroll {
                if y < bar.thumb.top || y > bar.thumb.bottom {
                    let middle = (bar.thumb.top + bar.thumb.bottom) / 2;
                    state.games_scroll = (state.games_scroll + (y - middle) as f32 * bar.per_px).clamp(0.0, bar.max);
                }
            }
            state.drag = Some((y, state.games_scroll));
            SetCapture(hwnd);
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_LBUTTONUP => {
            if state.drag.take().is_some() {
                ReleaseCapture();
            }
            if let Some((x, y, start, dragged)) = state.press.take() {
                ReleaseCapture();
                if dragged {
                    state.carousel.let_go(start, now_ms());
                } else {
                    carousel_click(hwnd, state, x, y);
                }
                InvalidateRect(hwnd, null(), 0);
            }
            0
        }
        WM_CAPTURECHANGED => {
            state.drag = None;
            // The capture went elsewhere mid-drag: settle where it is.
            if let Some((_, _, start, true)) = state.press.take() {
                state.carousel.let_go(start, now_ms());
            }
            0
        }
        WM_MOUSEWHEEL => {
            // Over the games list (Monitor tab), the wheel scrolls it: about one line a notch.
            let mut at = POINT {
                x: (lparam & 0xffff) as i16 as i32,
                y: ((lparam >> 16) & 0xffff) as i16 as i32,
            };
            ScreenToClient(hwnd, &mut at);
            match state.scroll {
                Some(bar) if state.tab == Tab::Monitor && inside(&bar.area, at.x, at.y) => {
                    let notches = ((wparam >> 16) & 0xffff) as i16 as f32 / 120.0;
                    state.games_scroll = (state.games_scroll - notches * 48.0).clamp(0.0, bar.max);
                    InvalidateRect(hwnd, null(), 0);
                    0
                }
                _ => DefWindowProcW(hwnd, message, wparam, lparam),
            }
        }
        WM_LBUTTONDOWN => {
            let (x, y) = ((lparam & 0xffff) as i16 as i32, ((lparam >> 16) & 0xffff) as i16 as i32);
            let mut client = rect(0, 0, 0, 0);
            GetClientRect(hwnd, &mut client);
            let [dash, mon, lang, full, top] = header_hits(client.right, scale_of(hwnd));
            if inside(&lang, x, y) {
                state.lang_open = !state.lang_open;
            } else if state.lang_open {
                // With the list open, a click picks a language or, anywhere else, only closes the list.
                if let Some(&(Action::Lang(i), _)) = state.buttons.iter().find(|(_, r)| inside(r, x, y)) {
                    choose_lang(state, Lang::ALL[i]);
                }
                state.lang_open = false;
            } else if inside(&dash, x, y) {
                state.tab = Tab::Dash;
            } else if inside(&mon, x, y) {
                state.tab = Tab::Monitor;
            } else if inside(&full, x, y) {
                toggle_full(hwnd, state);
            } else if inside(&top, x, y) {
                state.on_top = !state.on_top;
                set_on_top(hwnd, state.on_top);
            } else if waiting_now(state) && y > (HEADER_H * scale_of(hwnd)) as i32 {
                // The carousel: it follows the mouse while dragged; a press that does not move is a click, on release.
                state.press = Some((x, y, state.carousel.at(now_ms()), false));
                SetCapture(hwnd);
            } else if let Some(&(action, _)) = state.buttons.iter().find(|(_, r)| inside(r, x, y)) {
                let account = lock(&state.ctx.account).clone();
                match action {
                    Action::Connect => crate::tray::start_connect(&account.server),
                    Action::OpenConnectPage => match crate::connect::Flow::global().page() {
                        Some(page) => win::open(&page),
                        None => win::open(&format!("{}{}", account.server, crate::connect::CONNECT_PATH)),
                    },
                    Action::CancelConnect => crate::connect::Flow::global().cancel(),
                    Action::OpenXpeed => win::open(&format!("{}{}", account.server, crate::connect::OPEN_PATH)),
                    Action::UpdateNow => {
                        crate::tray::update_now_of_running();
                    }
                    Action::CopyDiagnostics => {
                        if copy_diagnostics(hwnd, state) {
                            state.copied_at = now_ms();
                        }
                    }
                    Action::Lang(i) => choose_lang(state, Lang::ALL[i]),
                    Action::Cover(i) => {
                        let steps = carousel_steps(state.carousel.target, i, state.covers.len());
                        if steps != 0 {
                            state.carousel.step(steps, now_ms());
                        }
                    }
                }
            }
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_MOUSEMOVE => {
            let (x, y) = ((lparam & 0xffff) as i16 as i32, ((lparam >> 16) & 0xffff) as i16 as i32);
            if state.mouse.is_none() {
                // Ask to be told when the mouse leaves the window, to drop the tooltip.
                let mut track = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                TrackMouseEvent(&mut track);
            }
            state.mouse = Some((x, y));
            if let Some((x0, y0, start, dragged)) = state.press {
                // A few pixels before it counts as a drag, so a shaky click stays a click.
                let dx = x - x0;
                if dragged || dx.abs() as f32 > 4.0 * scale_of(hwnd) {
                    state.carousel.hold(start - dx as f32 / state.carousel_step.max(1.0));
                    state.press = Some((x0, y0, start, true));
                    InvalidateRect(hwnd, null(), 0);
                }
            }
            if let (Some((from_y, from_scroll)), Some(bar)) = (state.drag, state.scroll) {
                state.games_scroll = (from_scroll + (y - from_y) as f32 * bar.per_px).clamp(0.0, bar.max);
                InvalidateRect(hwnd, null(), 0);
            }
            0
        }
        WM_SETCURSOR if (lparam & 0xffff) as u32 == HTCLIENT => {
            let mut at = POINT { x: 0, y: 0 };
            GetCursorPos(&mut at);
            ScreenToClient(hwnd, &mut at);
            if clickable(hwnd, state, at.x, at.y) {
                SetCursor(LoadCursorW(null_mut(), IDC_HAND));
                1
            } else {
                DefWindowProcW(hwnd, message, wparam, lparam)
            }
        }
        WM_MOUSELEAVE => {
            state.mouse = None;
            0
        }
        WM_ACTIVATE if wparam & 0xffff != 0 => {
            // Back to the front: a game may have been installed or removed meanwhile.
            refresh_installed(state);
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_COVERS => {
            state.covers = CoverArt::load(state.installed.as_ref());
            state.brands = BrandArt::load();
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_BRAND_DONE => {
            state.brand_inflight = false;
            if wparam == 0 {
                state.brand_requested = None;
                state.brand_retry_after = now_ms() + 30_000;
            } else {
                state.brands = BrandArt::load();
                InvalidateRect(hwnd, null(), 0);
            }
            0
        }
        WM_LBUTTONDBLCLK => {
            // A double click below the header: full screen and back. On the carousel, the second click of a quick
            // pair is one more press (two quick clicks move it two covers).
            let (x, y) = ((lparam & 0xffff) as i16 as i32, ((lparam >> 16) & 0xffff) as i16 as i32);
            if y > (HEADER_H * scale_of(hwnd)) as i32 {
                if waiting_now(state) {
                    state.press = Some((x, y, state.carousel.at(now_ms()), false));
                    SetCapture(hwnd);
                } else {
                    toggle_full(hwnd, state);
                    InvalidateRect(hwnd, null(), 0);
                }
            }
            0
        }
        WM_KEYDOWN => {
            const VK_ESCAPE: usize = 0x1b;
            const VK_F11: usize = 0x7a;
            match wparam {
                0x31 => state.tab = Tab::Dash,
                0x32 => state.tab = Tab::Monitor,
                0x54 => {
                    state.on_top = !state.on_top;
                    set_on_top(hwnd, state.on_top);
                }
                VK_F11 | 0x46 => toggle_full(hwnd, state),
                VK_ESCAPE if state.lang_open => state.lang_open = false,
                VK_ESCAPE if state.full.is_some() => toggle_full(hwnd, state),
                // Left and right arrows move the covers' carousel.
                0x25 => state.carousel.step(-1, now_ms()),
                0x27 => state.carousel.step(1, now_ms()),
                _ => return DefWindowProcW(hwnd, message, wparam, lparam),
            }
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_GETMINMAXINFO => {
            let info = &mut *(lparam as *mut MINMAXINFO);
            let scale = scale_of(hwnd);
            info.ptMinTrackSize.x = (MIN_WIDTH as f32 * scale) as i32;
            info.ptMinTrackSize.y = (MIN_HEIGHT as f32 * scale) as i32;
            0
        }
        WM_DPICHANGED => {
            // Moved to a screen with another scale: take the size Windows suggests for it.
            let r = &*(lparam as *const RECT);
            SetWindowPos(
                hwnd,
                null_mut(),
                r.left,
                r.top,
                r.right - r.left,
                r.bottom - r.top,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
            0
        }
        WM_CLOSE => {
            DestroyWindow(hwnd);
            0
        }
        WM_DESTROY => {
            KillTimer(hwnd, TIMER);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            if state.ctx.quit_on_close {
                PostQuitMessage(0);
            }
            drop(Box::from_raw(state as *mut State));
            0
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

/// Brings the game covers up to date with the Xpeed server's, once a run (again the next time the window opens when
/// the server could not be reached), off the window's thread; the window reads them again when some changed.
pub(super) fn fetch_covers_once(hwnd: HWND, server: String) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let server = if server.is_empty() {
        crate::config::DEFAULT_SERVER.to_owned()
    } else {
        server
    };
    let target = hwnd as isize;
    std::thread::spawn(move || {
        let covers = crate::covers::sync(&server);
        let brands = crate::brands::sync(&server, None);
        if covers.is_none() || brands.is_none() {
            STARTED.store(false, std::sync::atomic::Ordering::SeqCst);
        }
        if covers.unwrap_or(0) > 0 {
            unsafe {
                PostMessageW(target as HWND, WM_COVERS, 0, 0);
            }
        }
    });
}

/// Fetch just the current make's image off the UI thread, once per car name change.
pub(super) unsafe fn fetch_brand_if_needed(hwnd: HWND, state: &mut State) {
    let Some(live) = state.ctx.shared.live() else { return };
    if live.car.is_empty()
        || state.brand_inflight
        || state.brand_requested.as_deref() == Some(&live.car)
        || now_ms() < state.brand_retry_after
    {
        return;
    }
    let car = live.car.clone();
    state.brand_requested = Some(car.clone());
    state.brand_inflight = true;
    let mut server = lock(&state.ctx.account).server.clone();
    if server.is_empty() {
        server = crate::config::DEFAULT_SERVER.to_owned();
    }
    let target = hwnd as isize;
    std::thread::spawn(move || {
        let result = crate::brands::sync(&server, Some(&car));
        unsafe {
            PostMessageW(target as HWND, WM_BRAND_DONE, usize::from(result.is_some()), 0);
        }
    });
}

/// Shows the window, making it if it is not open (`existing` is the one made before, if any). Returns its handle.
pub fn show(existing: HWND, ctx: impl FnOnce() -> Context) -> HWND {
    unsafe {
        if !existing.is_null() && IsWindow(existing) != 0 {
            ShowWindow(existing, SW_RESTORE);
            SetForegroundWindow(existing);
            return existing;
        }
        let instance = GetModuleHandleW(null());
        let class = win::wide(CLASS);
        // The class carries the program's embedded icon, so the window has it before any WM_SETICON.
        let window_class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_DBLCLKS,
            lpfnWndProc: Some(window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: crate::tray::class_icon(false),
            hCursor: LoadCursorW(null_mut(), IDC_ARROW),
            hbrBackground: null_mut(),
            lpszMenuName: null(),
            lpszClassName: class.as_ptr(),
            hIconSm: crate::tray::class_icon(true),
        };
        // Registering twice fails harmlessly (the class from the first time is used).
        RegisterClassExW(&window_class);
        let state = Box::into_raw(Box::new(State {
            ctx: ctx(),
            tab: Tab::Dash,
            on_top: false,
            full: None,
            covers: Vec::new(),
            brands: Vec::new(),
            brand_requested: None,
            brand_inflight: false,
            brand_retry_after: 0,
            installed: None,
            buffer: None,
            mouse: None,
            buttons: Vec::new(),
            carousel: Carousel::new(now_ms()),
            games_scroll: 0.0,
            scroll: None,
            drag: None,
            press: None,
            carousel_step: 120.0,
            lang_open: false,
            copied_at: 0,
        }));
        refresh_installed(&mut *state);
        // Only this window follows the screen's DPI; the thread goes back to how it was afterwards.
        let before = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            win::wide("Xpeed Companion").as_ptr(),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            WIDTH,
            HEIGHT,
            null_mut(),
            null_mut(),
            instance,
            state.cast(),
        );
        if !before.is_null() {
            SetThreadDpiAwarenessContext(before);
        }
        if !hwnd.is_null() {
            // A dark title bar, the colour of the window (Windows 11; older versions ignore what they do not know).
            let dark: i32 = 1;
            DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE as u32, (&dark as *const i32).cast(), 4);
            DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR as u32, (&BG as *const COLORREF).cast(), 4);
        }
        if hwnd.is_null() {
            crate::applog::line("could not create the panel window");
            drop(Box::from_raw(state));
            return null_mut();
        }
        // The design size is the inside of the window, at the screen's scale; the frame goes around it.
        let dpi = GetDpiForWindow(hwnd).max(96);
        let scale = dpi as f32 / 96.0;
        // 16:9 like the screens it runs on, sized from the screen's work area and centred on it.
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let work = if GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut info) != 0 {
            info.rcWork
        } else {
            rect(0, 0, (WIDTH as f32 * scale) as i32 * 5 / 4, (HEIGHT as f32 * scale) as i32 * 5 / 4)
        };
        let (cw, ch) = opening_size(work.right - work.left, work.bottom - work.top, scale);
        let mut outer = rect(0, 0, cw, ch);
        AdjustWindowRectExForDpi(&mut outer, WS_OVERLAPPEDWINDOW, 0, 0, dpi);
        let (ow, oh) = (outer.right - outer.left, outer.bottom - outer.top);
        SetWindowPos(
            hwnd,
            null_mut(),
            work.left + ((work.right - work.left) - ow).max(0) / 2,
            work.top + ((work.bottom - work.top) - oh).max(0) / 2,
            ow,
            oh,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
        ShowWindow(hwnd, SW_SHOWNORMAL);
        SetForegroundWindow(hwnd);
        let server = lock(&(*state).ctx.account).server.clone();
        fetch_covers_once(hwnd, server);
        hwnd
    }
}
