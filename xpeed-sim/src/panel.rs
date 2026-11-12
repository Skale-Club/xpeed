//! The Xpeed Sim window. It has two tabs:
//!
//! * **Dashboard:** speed, gear, revs, pedals, wheel, fuel, the lap time and the gap to the best lap, live, for
//!   someone who wants a screen beside the game without SimHub.
//! * **Monitor:** what the program is doing: each game's reader, the account, the laps saved and the last lines of
//!   the log.
//!
//! It is drawn with plain GDI into an off-screen bitmap 30 times a second, so it costs little next to a running
//! game and needs nothing installed. The window follows the DPI of its screen (it is made per-monitor DPI aware on its
//! own; the rest of the program is unchanged). Drawing (`paint`) only reads a `View`, so it is checked without a
//! window: a test paints both tabs into a bitmap.
//!
//! Closing the window only closes the window; the program keeps recording from the tray.

use std::ptr::{null, null_mut};
use std::sync::{Arc, Mutex};

use windows_sys::Win32::Foundation::{COLORREF, FILETIME, HWND, LPARAM, LRESULT, RECT, SIZE, SYSTEMTIME, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW,
    Ellipse, EndPaint, FillRect, GetStockObject, GetTextExtentPoint32W, InvalidateRect, RoundRect, SelectObject, SetBkMode, SetTextColor,
    CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DT_CENTER, DT_END_ELLIPSIS, DT_LEFT, DT_NOPREFIX, DT_RIGHT, DT_SINGLELINE,
    DT_VCENTER, FW_BOLD, FW_NORMAL, FW_SEMIBOLD, HDC, HFONT, NULL_PEN, OUT_DEFAULT_PRECIS, PAINTSTRUCT, SRCCOPY, TRANSPARENT,
};
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};
use windows_sys::Win32::UI::HiDpi::{
    AdjustWindowRectExForDpi, GetDpiForWindow, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetMessageW, GetWindowLongPtrW, IsWindow, KillTimer,
    LoadCursorW, PostQuitMessage, RegisterClassW, SendMessageW, SetForegroundWindow, SetTimer, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    TranslateMessage, CREATESTRUCTW, CW_USEDEFAULT, GWLP_USERDATA, HICON, HWND_NOTOPMOST, HWND_TOPMOST, ICON_BIG, ICON_SMALL, IDC_ARROW,
    MINMAXINFO, MSG, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_RESTORE, SW_SHOWNORMAL, WM_CLOSE, WM_CREATE, WM_DESTROY,
    WM_DPICHANGED, WM_ERASEBKGND, WM_GETMINMAXINFO, WM_KEYDOWN, WM_LBUTTONDOWN, WM_NCCREATE, WM_PAINT, WM_SETICON, WM_TIMER, WNDCLASSW,
    WS_OVERLAPPEDWINDOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowPlacement, SetWindowPlacement, CS_DBLCLKS, GWL_STYLE, HWND_TOP, SWP_FRAMECHANGED, SWP_NOOWNERZORDER, WINDOWPLACEMENT,
    WM_LBUTTONDBLCLK,
};

use crate::dash::Live;
use crate::present;
use crate::status::{Cloud, Game, Shared, Snapshot};
use crate::text::{text, Lang, Msg};
use crate::util::{clock, now_ms};
use crate::win;

const CLASS: &str = "XpeedSimPanel";
const TIMER: usize = 1;
/// About 30 frames a second.
const FRAME_MS: u32 = 33;
/// A reading older than this is not shown as live.
const STALE_MS: i64 = 3000;
/// Design size of the window at 96 DPI.
const WIDTH: i32 = 960;
const HEIGHT: i32 = 600;
const MIN_WIDTH: i32 = 720;
const MIN_HEIGHT: i32 = 480;

/// The colours, as `0x00BBGGRR`. The background and the accent are the app's (`--background` #111214, `--primary`
/// #F5E663).
const fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
    r as u32 | (g as u32) << 8 | (b as u32) << 16
}
const BG: COLORREF = rgb(0x11, 0x12, 0x14);
const CARD: COLORREF = rgb(0x1b, 0x1d, 0x21);
const TRACK: COLORREF = rgb(0x2a, 0x2d, 0x33);
const TEXT: COLORREF = rgb(0xec, 0xec, 0xee);
const MUTED: COLORREF = rgb(0x8b, 0x90, 0x99);
const ACCENT: COLORREF = rgb(0xf5, 0xe6, 0x63);
const GREEN: COLORREF = rgb(0x3d, 0xdc, 0x84);
const RED: COLORREF = rgb(0xff, 0x5a, 0x5a);
const BLUE: COLORREF = rgb(0x4e, 0xa8, 0xff);
const AMBER: COLORREF = rgb(0xff, 0xb5, 0x47);
const GREY: COLORREF = rgb(0x5c, 0x61, 0x6b);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Dash,
    Monitor,
}

/// One line of the monitor's game list.
#[derive(Clone, Debug, PartialEq)]
pub struct GameRow {
    pub title: String,
    pub state: Game,
}

/// Everything one frame of the window shows.
pub struct View<'a> {
    pub lang: Lang,
    pub tab: Tab,
    pub on_top: bool,
    /// The window fills its screen.
    pub full: bool,
    /// Pixels per design pixel (the screen's DPI / 96).
    pub scale: f32,
    pub now_ms: i64,
    pub snapshot: &'a Snapshot,
    pub live: Option<&'a Live>,
    pub games: &'a [GameRow],
    pub device: Option<&'a str>,
    pub server: &'a str,
    pub recent_laps: &'a [String],
    /// `(time as HH:MM:SS, text)`, oldest first.
    pub log: &'a [(String, String)],
    pub laps_dir: &'a str,
}

/// The account and the language as the tray knows them; the tray changes them when the computer is connected again
/// or the person picks another language.
#[derive(Clone, Debug, Default)]
pub struct Account {
    pub device: Option<String>,
    pub server: String,
    pub lang: Lang,
}

/// What the window needs from the rest of the program.
pub struct Context {
    pub shared: Arc<Shared>,
    pub account: Arc<Mutex<Account>>,
    pub laps_dir: String,
    /// The readers' lines: the title the panel shows and the game ids that report into it.
    pub readers: Vec<(String, Vec<&'static str>)>,
    pub icon_big: HICON,
    pub icon_small: HICON,
    /// Closing the window ends the message loop (the demo, which has no tray behind it).
    pub quit_on_close: bool,
}

struct State {
    ctx: Context,
    tab: Tab,
    on_top: bool,
    /// Full screen: where the window was and its style, to put it back.
    full: Option<(WINDOWPLACEMENT, isize)>,
}

/// The places of the header that can be clicked: the two tabs, "full screen" and "always on top".
fn header_hits(width: i32, scale: f32) -> [RECT; 4] {
    let p = |v: f32| (v * scale).round() as i32;
    [
        RECT {
            left: p(16.0),
            top: p(10.0),
            right: p(146.0),
            bottom: p(42.0),
        },
        RECT {
            left: p(154.0),
            top: p(10.0),
            right: p(284.0),
            bottom: p(42.0),
        },
        RECT {
            left: width - p(16.0) - p(200.0) - p(8.0) - p(170.0),
            top: p(10.0),
            right: width - p(16.0) - p(200.0) - p(8.0),
            bottom: p(42.0),
        },
        RECT {
            left: width - p(16.0) - p(200.0),
            top: p(10.0),
            right: width - p(16.0),
            bottom: p(42.0),
        },
    ]
}

fn inside(r: &RECT, x: i32, y: i32) -> bool {
    x >= r.left && x < r.right && y >= r.top && y < r.bottom
}

/// Drawing helpers over one device context, with the fonts it made (deleted when it is dropped).
struct Painter {
    hdc: HDC,
    scale: f32,
    fonts: Vec<((i32, i32), HFONT)>,
    face: Vec<u16>,
}

impl Painter {
    fn new(hdc: HDC, scale: f32) -> Painter {
        unsafe {
            SetBkMode(hdc, TRANSPARENT as i32);
        }
        Painter {
            hdc,
            scale,
            fonts: Vec::new(),
            face: win::wide("Segoe UI"),
        }
    }

    fn p(&self, v: f32) -> i32 {
        (v * self.scale).round() as i32
    }

    fn font(&mut self, size: f32, weight: i32) -> HFONT {
        let key = (self.p(size).max(1), weight);
        if let Some((_, font)) = self.fonts.iter().find(|(k, _)| *k == key) {
            return *font;
        }
        let font = unsafe {
            CreateFontW(
                -key.0,
                0,
                0,
                0,
                weight,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                OUT_DEFAULT_PRECIS as u32,
                CLIP_DEFAULT_PRECIS as u32,
                CLEARTYPE_QUALITY as u32,
                0,
                self.face.as_ptr(),
            )
        };
        self.fonts.push((key, font));
        font
    }

    fn fill(&self, r: RECT, color: COLORREF) {
        unsafe {
            let brush = CreateSolidBrush(color);
            FillRect(self.hdc, &r, brush);
            DeleteObject(brush);
        }
    }

    fn round(&self, r: RECT, radius: f32, color: COLORREF) {
        unsafe {
            let brush = CreateSolidBrush(color);
            let old_brush = SelectObject(self.hdc, brush);
            let old_pen = SelectObject(self.hdc, GetStockObject(NULL_PEN));
            let d = self.p(radius * 2.0);
            RoundRect(self.hdc, r.left, r.top, r.right + 1, r.bottom + 1, d, d);
            SelectObject(self.hdc, old_pen);
            SelectObject(self.hdc, old_brush);
            DeleteObject(brush);
        }
    }

    fn dot(&self, cx: i32, cy: i32, radius: f32, color: COLORREF) {
        let r = self.p(radius);
        unsafe {
            let brush = CreateSolidBrush(color);
            let old_brush = SelectObject(self.hdc, brush);
            let old_pen = SelectObject(self.hdc, GetStockObject(NULL_PEN));
            Ellipse(self.hdc, cx - r, cy - r, cx + r + 1, cy + r + 1);
            SelectObject(self.hdc, old_pen);
            SelectObject(self.hdc, old_brush);
            DeleteObject(brush);
        }
    }

    /// Text in a box, one line, cut with "…" when it does not fit. `align` is `DT_LEFT`, `DT_CENTER` or `DT_RIGHT`.
    fn text(&mut self, s: &str, r: RECT, size: f32, weight: i32, color: COLORREF, align: u32) {
        let font = self.font(size, weight);
        let wide: Vec<u16> = s.encode_utf16().collect();
        let mut r = r;
        unsafe {
            let old = SelectObject(self.hdc, font);
            SetTextColor(self.hdc, color);
            DrawTextW(
                self.hdc,
                wide.as_ptr(),
                wide.len() as i32,
                &mut r,
                align | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX | DT_END_ELLIPSIS,
            );
            SelectObject(self.hdc, old);
        }
    }

    fn width_of(&mut self, s: &str, size: f32, weight: i32) -> i32 {
        let font = self.font(size, weight);
        let wide: Vec<u16> = s.encode_utf16().collect();
        let mut extent = SIZE { cx: 0, cy: 0 };
        unsafe {
            let old = SelectObject(self.hdc, font);
            GetTextExtentPoint32W(self.hdc, wide.as_ptr(), wide.len() as i32, &mut extent);
            SelectObject(self.hdc, old);
        }
        extent.cx
    }

    /// A bar filled `share` of the way (0..1) from the left.
    fn hbar(&self, r: RECT, share: f32, color: COLORREF) {
        self.round(r, 3.0, TRACK);
        if share.is_finite() && share > 0.0 {
            let w = ((r.right - r.left) as f32 * share.min(1.0)).round() as i32;
            self.round(
                RECT {
                    right: r.left + w.max(1),
                    ..r
                },
                3.0,
                color,
            );
        }
    }

    /// A bar filled `share` of the way (0..1) from the bottom.
    fn vbar(&self, r: RECT, share: f32, color: COLORREF) {
        self.round(r, 4.0, TRACK);
        if share.is_finite() && share > 0.0 {
            let h = ((r.bottom - r.top) as f32 * share.min(1.0)).round() as i32;
            self.round(
                RECT {
                    top: r.bottom - h.max(1),
                    ..r
                },
                4.0,
                color,
            );
        }
    }
}

impl Drop for Painter {
    fn drop(&mut self) {
        for (_, font) in &self.fonts {
            unsafe {
                DeleteObject(*font);
            }
        }
    }
}

fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
    RECT { left, top, right, bottom }
}

/// `1:42.318` for seconds; `-:--.---` when there is none.
fn lap_clock(s: Option<f64>) -> String {
    match s {
        Some(s) if s.is_finite() && s >= 0.0 => clock((s * 1000.0).round() as u32),
        _ => "-:--.---".to_owned(),
    }
}

/// `+0.42` or `-1.07`; `—` when there is none.
fn delta_text(d: Option<f64>) -> String {
    match d {
        Some(d) if d.is_finite() => format!("{}{:.2}", if d < 0.0 { "-" } else { "+" }, d.abs()),
        _ => "—".to_owned(),
    }
}

fn gear_text(gear: f32) -> String {
    match gear {
        g if !g.is_finite() => "–".to_owned(),
        g if g < -0.5 => "R".to_owned(),
        g if g < 0.5 => "N".to_owned(),
        g => format!("{}", g.round() as i32),
    }
}

fn state_text(lang: Lang, game: &Game) -> String {
    text(
        lang,
        &match game {
            Game::Waiting => Msg::StateWaiting,
            Game::Connected => Msg::StateConnected,
            Game::Recording(lap) => Msg::StateRecording(*lap),
            Game::Paused => Msg::StatePaused,
            Game::Unsupported => Msg::StateUnsupported,
        },
    )
}

fn state_color(game: &Game) -> COLORREF {
    match game {
        Game::Recording(_) => GREEN,
        Game::Connected => BLUE,
        Game::Waiting => GREY,
        Game::Paused => AMBER,
        Game::Unsupported => RED,
    }
}

/// The colour of the rev bar: green, then amber, then red near the top.
fn rev_color(share: f32) -> COLORREF {
    if share >= 0.95 {
        RED
    } else if share >= 0.85 {
        AMBER
    } else {
        GREEN
    }
}

/// Draws one frame of the window.
pub fn paint(hdc: HDC, width: i32, height: i32, view: &View) {
    let mut g = Painter::new(hdc, view.scale);
    g.fill(rect(0, 0, width, height), BG);
    header(&mut g, width, view);
    let top = g.p(54.0);
    let body = rect(g.p(16.0), top, width - g.p(16.0), height - g.p(14.0));
    match view.tab {
        Tab::Dash => {
            // On a big window (full screen) the dashboard grows with it instead of leaving empty space.
            g.scale = view.scale * zoom(body, view.scale);
            dashboard(&mut g, body, view);
            g.scale = view.scale;
        }
        Tab::Monitor => monitor(&mut g, body, view),
    }
}

fn header(g: &mut Painter, width: i32, view: &View) {
    let [dash, mon, full, top] = header_hits(width, view.scale);
    g.round(full, 8.0, CARD);
    let full_label = text(
        view.lang,
        if view.full {
            &Msg::PanelExitFullScreen
        } else {
            &Msg::PanelFullScreen
        },
    );
    g.text(&full_label, full, 14.0, FW_NORMAL as i32, TEXT, DT_CENTER);
    for (r, tab, label) in [(dash, Tab::Dash, Msg::PanelTabDash), (mon, Tab::Monitor, Msg::PanelTabMonitor)] {
        let selected = view.tab == tab;
        g.round(r, 8.0, if selected { ACCENT } else { CARD });
        let color = if selected { BG } else { TEXT };
        g.text(&text(view.lang, &label), r, 15.0, FW_SEMIBOLD as i32, color, DT_CENTER);
    }
    g.round(top, 8.0, if view.on_top { CARD } else { BG });
    let box_size = g.p(14.0);
    let bx = top.left + g.p(12.0);
    let by = (top.top + top.bottom - box_size) / 2;
    let check = rect(bx, by, bx + box_size, by + box_size);
    g.round(check, 3.0, if view.on_top { ACCENT } else { TRACK });
    if view.on_top {
        g.text("\u{2713}", check, 12.0, FW_BOLD as i32, BG, DT_CENTER);
    }
    let label = rect(bx + box_size + g.p(8.0), top.top, top.right - g.p(8.0), top.bottom);
    g.text(
        &text(view.lang, &Msg::PanelOnTop),
        label,
        14.0,
        FW_NORMAL as i32,
        if view.on_top { TEXT } else { MUTED },
        DT_LEFT,
    );
}

/// How much bigger than its design size (928 × 532 at this DPI) the dashboard can be drawn in `body`: 1 at the
/// normal size, up to 3 on a big screen.
fn zoom(body: RECT, scale: f32) -> f32 {
    let w = (body.right - body.left) as f32 / (928.0 * scale);
    let h = (body.bottom - body.top) as f32 / (532.0 * scale);
    w.min(h).clamp(1.0, 3.0)
}

fn dashboard(g: &mut Painter, body: RECT, view: &View) {
    let live = view.live.filter(|l| view.now_ms - l.at_ms <= STALE_MS);
    let Some(live) = live else {
        let mid = (body.top + body.bottom) / 2;
        g.text(
            &text(view.lang, &Msg::PanelWaiting),
            rect(body.left, mid - g.p(40.0), body.right, mid),
            22.0,
            FW_SEMIBOLD as i32,
            TEXT,
            DT_CENTER,
        );
        g.text(
            &present::game_line_of(view.lang, view.snapshot),
            rect(body.left, mid, body.right, mid + g.p(30.0)),
            15.0,
            FW_NORMAL as i32,
            MUTED,
            DT_CENTER,
        );
        return;
    };
    let sc = g.scale;
    let p = |v: f32| (v * sc).round() as i32;
    let (left, right) = (body.left, body.right);
    let width = right - left;

    // What is being driven, and the lap.
    let info = [live.game, live.track.as_str(), live.car.as_str()]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("  ·  ");
    let lap_label = if live.in_pits {
        format!(
            "{}  ·  {}",
            text(view.lang, &Msg::PanelLap(live.lap)),
            text(view.lang, &Msg::PanelPits)
        )
    } else if !live.driving {
        text(view.lang, &Msg::PanelNotDriving)
    } else {
        text(view.lang, &Msg::PanelLap(live.lap))
    };
    let lap_w = g.width_of(&lap_label, 16.0, FW_SEMIBOLD as i32) + p(8.0);
    g.text(
        &info,
        rect(left, body.top, right - lap_w, body.top + p(26.0)),
        15.0,
        FW_NORMAL as i32,
        MUTED,
        DT_LEFT,
    );
    let lap_color = if live.in_pits || !live.driving { AMBER } else { ACCENT };
    g.text(
        &lap_label,
        rect(right - lap_w, body.top, right, body.top + p(26.0)),
        16.0,
        FW_SEMIBOLD as i32,
        lap_color,
        DT_RIGHT,
    );

    // The rev bar, in segments.
    let rev_top = body.top + p(34.0);
    let rev = rect(left, rev_top, right, rev_top + p(22.0));
    let share = if live.rpm_top > 0.0 { live.rpm / live.rpm_top } else { f32::NAN };
    let segments = 40;
    let gap = p(3.0).max(1);
    let seg_w = (width - gap * (segments - 1)) as f32 / segments as f32;
    for i in 0..segments {
        let x0 = left + (i as f32 * (seg_w + gap as f32)).round() as i32;
        let x1 = left + (i as f32 * (seg_w + gap as f32) + seg_w).round() as i32;
        let at = (i as f32 + 1.0) / segments as f32;
        let lit = share.is_finite() && share >= at - 0.5 / segments as f32;
        let color = if lit { rev_color(at) } else { TRACK };
        g.round(rect(x0, rev.top, x1, rev.bottom), 2.0, color);
    }
    let rpm_text = if live.rpm.is_finite() {
        format!("{:.0} rpm", live.rpm)
    } else {
        String::new()
    };
    g.text(
        &rpm_text,
        rect(left, rev.bottom + p(2.0), right, rev.bottom + p(22.0)),
        13.0,
        FW_NORMAL as i32,
        MUTED,
        DT_RIGHT,
    );

    // Main area: gear and speed on the left, times on the right.
    let main_top = rev.bottom + p(26.0);
    let bottom_h = p(150.0);
    let main_bottom = body.bottom - bottom_h - p(12.0);
    let split = left + width * 2 / 5;
    let gear_card = rect(left, main_top, split - p(8.0), main_bottom);
    g.round(gear_card, 12.0, CARD);
    let gear_h = (gear_card.bottom - gear_card.top) * 3 / 5;
    let gear_px = ((gear_h as f32 / g.scale) * 0.95).min(180.0);
    g.text(
        &gear_text(live.gear),
        rect(gear_card.left, gear_card.top + p(6.0), gear_card.right, gear_card.top + gear_h),
        gear_px,
        FW_BOLD as i32,
        ACCENT,
        DT_CENTER,
    );
    let speed = if live.speed_ms.is_finite() {
        format!("{:.0}", live.speed_ms * 3.6)
    } else {
        "–".to_owned()
    };
    let speed_area = rect(gear_card.left, gear_card.top + gear_h, gear_card.right, gear_card.bottom - p(30.0));
    g.text(&speed, speed_area, 54.0, FW_BOLD as i32, TEXT, DT_CENTER);
    g.text(
        "km/h",
        rect(
            gear_card.left,
            gear_card.bottom - p(34.0),
            gear_card.right,
            gear_card.bottom - p(8.0),
        ),
        14.0,
        FW_NORMAL as i32,
        MUTED,
        DT_CENTER,
    );

    let times = rect(split + p(8.0), main_top, right, main_bottom);
    g.round(times, 12.0, CARD);
    let pad = p(18.0);
    let (tl, tr) = (times.left + pad, times.right - pad);
    let rows = (times.bottom - times.top - 2 * pad) as f32;
    let row = |share: f32| times.top + pad + (rows * share).round() as i32;
    g.text(
        &lap_clock(live.lap_time_s),
        rect(tl, row(0.0), tr, row(0.36)),
        50.0,
        FW_BOLD as i32,
        TEXT,
        DT_LEFT,
    );
    let delta_color = match live.delta_s {
        Some(d) if d < 0.0 => GREEN,
        Some(_) => RED,
        None => MUTED,
    };
    let delta_label = text(view.lang, &Msg::PanelDelta);
    g.text(
        &delta_label,
        rect(tl, row(0.36), tr, row(0.48)),
        13.0,
        FW_NORMAL as i32,
        MUTED,
        DT_LEFT,
    );
    g.text(
        &delta_text(live.delta_s),
        rect(tl, row(0.46), tr, row(0.72)),
        40.0,
        FW_BOLD as i32,
        delta_color,
        DT_LEFT,
    );
    let half = (tl + tr) / 2;
    for (x0, x1, label, value) in [
        (tl, half, Msg::PanelLastLap, live.last_lap_s),
        (half, tr, Msg::PanelBestLap, live.best_lap_s),
    ] {
        g.text(
            &text(view.lang, &label),
            rect(x0, row(0.74), x1, row(0.84)),
            13.0,
            FW_NORMAL as i32,
            MUTED,
            DT_LEFT,
        );
        g.text(
            &lap_clock(value),
            rect(x0, row(0.83), x1, row(1.0)),
            24.0,
            FW_SEMIBOLD as i32,
            TEXT,
            DT_LEFT,
        );
    }

    // Bottom strip: pedals, wheel, fuel and where on the lap.
    let strip = rect(left, body.bottom - bottom_h, right, body.bottom);
    g.round(strip, 12.0, CARD);
    let bar_w = p(30.0);
    let bar_top = strip.top + p(16.0);
    let bar_bottom = strip.bottom - p(34.0);
    let mut x = strip.left + p(20.0);
    for (label, value, color) in [
        (Msg::PanelThrottle, live.throttle, GREEN),
        (Msg::PanelBrake, live.brake, RED),
        (Msg::PanelClutch, live.clutch, BLUE),
    ] {
        g.vbar(rect(x, bar_top, x + bar_w, bar_bottom), value, color);
        g.text(
            &text(view.lang, &label),
            rect(x - p(22.0), bar_bottom + p(4.0), x + bar_w + p(22.0), strip.bottom - p(8.0)),
            12.0,
            FW_NORMAL as i32,
            MUTED,
            DT_CENTER,
        );
        x += bar_w + p(44.0);
    }
    let info_left = x + p(10.0);
    let info_right = strip.right - p(20.0);
    // The wheel: a bar with the centre marked; the fill goes from the centre to where the wheel is.
    let wheel_y = strip.top + p(26.0);
    g.text(
        &text(view.lang, &Msg::PanelSteer),
        rect(info_left, strip.top + p(6.0), info_right, wheel_y - p(2.0)),
        12.0,
        FW_NORMAL as i32,
        MUTED,
        DT_LEFT,
    );
    let wheel = rect(info_left, wheel_y, info_right, wheel_y + p(12.0));
    g.round(wheel, 3.0, TRACK);
    let centre = (wheel.left + wheel.right) / 2;
    if live.steer.is_finite() {
        let reach = ((wheel.right - wheel.left) as f32 / 2.0 * live.steer.clamp(-1.0, 1.0)).round() as i32;
        let (a, b) = if reach < 0 {
            (centre + reach, centre)
        } else {
            (centre, centre + reach)
        };
        g.round(rect(a, wheel.top, b.max(a + 1), wheel.bottom), 3.0, ACCENT);
    }
    g.fill(rect(centre - 1, wheel.top - p(3.0), centre + 1, wheel.bottom + p(3.0)), TEXT);

    // Where on the lap.
    let lap_y = wheel.bottom + p(30.0);
    let share = match (live.dist_m, live.track_length_m) {
        (Some(d), Some(l)) if l > 0.0 => (d / l) as f32,
        _ => f32::NAN,
    };
    let where_label = match (live.dist_m, live.track_length_m) {
        (Some(d), Some(l)) => format!("{:.0} / {:.0} m", d, l),
        (Some(d), None) => format!("{:.0} m", d),
        _ => String::new(),
    };
    g.text(
        &where_label,
        rect(info_left, lap_y - p(20.0), info_right, lap_y - p(2.0)),
        12.0,
        FW_NORMAL as i32,
        MUTED,
        DT_LEFT,
    );
    g.hbar(rect(info_left, lap_y, info_right, lap_y + p(8.0)), share, ACCENT);

    // Fuel.
    let fuel = if live.fuel_l.is_finite() {
        format!("{}  {:.1} L", text(view.lang, &Msg::PanelFuel), live.fuel_l)
    } else {
        format!("{}  –", text(view.lang, &Msg::PanelFuel))
    };
    g.text(
        &fuel,
        rect(info_left, lap_y + p(16.0), info_right, strip.bottom - p(10.0)),
        18.0,
        FW_SEMIBOLD as i32,
        TEXT,
        DT_LEFT,
    );
}

/// A card with a title; returns the area under the title.
fn card(g: &mut Painter, r: RECT, title: &str) -> RECT {
    g.round(r, 12.0, CARD);
    let pad = g.p(16.0);
    g.text(
        title,
        rect(r.left + pad, r.top + g.p(10.0), r.right - pad, r.top + g.p(36.0)),
        15.0,
        FW_SEMIBOLD as i32,
        ACCENT,
        DT_LEFT,
    );
    rect(r.left + pad, r.top + g.p(42.0), r.right - pad, r.bottom - g.p(12.0))
}

fn monitor(g: &mut Painter, body: RECT, view: &View) {
    let sc = g.scale;
    let p = |v: f32| (v * sc).round() as i32;
    let footer_h = p(40.0);
    let area = rect(body.left, body.top, body.right, body.bottom - footer_h);
    let split = (area.left + area.right) / 2;
    let line_h = p(24.0);

    // Games.
    let games_h = p(56.0) + line_h * view.games.len().max(1) as i32;
    let games = card(
        g,
        rect(area.left, area.top, split - p(8.0), area.top + games_h),
        &text(view.lang, &Msg::PanelGames),
    );
    for (i, row) in view.games.iter().enumerate() {
        let y = games.top + line_h * i as i32;
        g.dot(games.left + p(6.0), y + line_h / 2, 5.0, state_color(&row.state));
        let state = state_text(view.lang, &row.state);
        let state_w = g.width_of(&state, 13.0, FW_NORMAL as i32) + p(4.0);
        g.text(
            &row.title,
            rect(games.left + p(20.0), y, games.right - state_w, y + line_h),
            14.0,
            FW_NORMAL as i32,
            TEXT,
            DT_LEFT,
        );
        g.text(
            &state,
            rect(games.right - state_w, y, games.right, y + line_h),
            13.0,
            FW_NORMAL as i32,
            MUTED,
            DT_RIGHT,
        );
    }

    // Account.
    let account_top = area.top + games_h + p(12.0);
    let account = card(
        g,
        rect(area.left, account_top, split - p(8.0), area.bottom),
        &text(view.lang, &Msg::PanelAccount),
    );
    let cloud_color = match view.snapshot.cloud {
        Cloud::Idle => GREEN,
        Cloud::Waiting(_) => AMBER,
        Cloud::NotPaired => GREY,
        Cloud::Refused => RED,
    };
    g.dot(account.left + p(6.0), account.top + line_h / 2, 5.0, cloud_color);
    g.text(
        &present::cloud_line(view.lang, &view.snapshot.cloud, view.device),
        rect(account.left + p(20.0), account.top, account.right, account.top + line_h),
        14.0,
        FW_NORMAL as i32,
        TEXT,
        DT_LEFT,
    );
    g.text(
        view.server,
        rect(
            account.left + p(20.0),
            account.top + line_h,
            account.right,
            account.top + 2 * line_h,
        ),
        13.0,
        FW_NORMAL as i32,
        MUTED,
        DT_LEFT,
    );
    g.text(
        &present::game_line_of(view.lang, view.snapshot),
        rect(
            account.left + p(20.0),
            account.top + 2 * line_h + p(6.0),
            account.right,
            account.top + 3 * line_h + p(6.0),
        ),
        13.0,
        FW_NORMAL as i32,
        MUTED,
        DT_LEFT,
    );

    // Laps saved, newest first.
    let laps_h = (area.bottom - area.top) * 2 / 5;
    let laps = card(
        g,
        rect(split + p(8.0), area.top, area.right, area.top + laps_h),
        &text(view.lang, &Msg::PanelLaps),
    );
    if view.recent_laps.is_empty() {
        g.text(
            &text(view.lang, &Msg::PanelNoLaps),
            rect(laps.left, laps.top, laps.right, laps.top + line_h),
            14.0,
            FW_NORMAL as i32,
            MUTED,
            DT_LEFT,
        );
    } else {
        g.text(
            &text(view.lang, &Msg::PanelLapsCount(view.snapshot.laps_saved)),
            rect(laps.left, laps.top, laps.right, laps.top + line_h),
            13.0,
            FW_NORMAL as i32,
            MUTED,
            DT_LEFT,
        );
        let room = ((laps.bottom - laps.top - line_h) / line_h).max(0) as usize;
        for (i, label) in view.recent_laps.iter().rev().take(room).enumerate() {
            let y = laps.top + line_h * (i as i32 + 1);
            g.text(
                label,
                rect(laps.left, y, laps.right, y + line_h),
                14.0,
                FW_NORMAL as i32,
                TEXT,
                DT_LEFT,
            );
        }
    }

    // The log, newest at the bottom.
    let log = card(
        g,
        rect(split + p(8.0), area.top + laps_h + p(12.0), area.right, area.bottom),
        &text(view.lang, &Msg::PanelLog),
    );
    let small = p(19.0);
    let room = ((log.bottom - log.top) / small).max(0) as usize;
    let shown = &view.log[view.log.len().saturating_sub(room)..];
    let time_w = g.width_of("00:00:00", 12.0, FW_NORMAL as i32) + p(10.0);
    for (i, (time, line)) in shown.iter().enumerate() {
        let y = log.top + small * i as i32;
        g.text(
            time,
            rect(log.left, y, log.left + time_w, y + small),
            12.0,
            FW_NORMAL as i32,
            MUTED,
            DT_LEFT,
        );
        g.text(
            line,
            rect(log.left + time_w, y, log.right, y + small),
            12.0,
            FW_NORMAL as i32,
            TEXT,
            DT_LEFT,
        );
    }

    // Footer: the folder and the keys.
    let footer = rect(body.left, body.bottom - footer_h + p(8.0), body.right, body.bottom);
    let half = (footer.left + footer.right) / 2 + p(60.0);
    g.text(
        &text(view.lang, &Msg::PanelLapsFolder(view.laps_dir.to_owned())),
        rect(footer.left, footer.top, half, footer.bottom),
        12.0,
        FW_NORMAL as i32,
        MUTED,
        DT_LEFT,
    );
    g.text(
        &text(view.lang, &Msg::PanelHint),
        rect(half, footer.top, footer.right, footer.bottom),
        12.0,
        FW_NORMAL as i32,
        MUTED,
        DT_RIGHT,
    );
}

/// `HH:MM:SS` on this computer's clock for a Unix time in ms.
fn local_time(unix_ms: i64) -> String {
    // FILETIME counts 100 ns since 1601-01-01.
    let ticks = (unix_ms.max(0) as u64 + 11_644_473_600_000) * 10_000;
    let file = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    unsafe {
        let mut utc: SYSTEMTIME = std::mem::zeroed();
        let mut local: SYSTEMTIME = std::mem::zeroed();
        if FileTimeToSystemTime(&file, &mut utc) == 0 || SystemTimeToTzSpecificLocalTime(null(), &utc, &mut local) == 0 {
            return String::new();
        }
        format!("{:02}:{:02}:{:02}", local.wHour, local.wMinute, local.wSecond)
    }
}

/// The game list for the monitor: Le Mans Ultimate, then each reader, with the best state any of its games reports.
fn game_rows(ctx: &Context) -> Vec<GameRow> {
    let reported = ctx.shared.games();
    let rank = |g: &Game| match g {
        Game::Recording(_) => 4,
        Game::Connected => 3,
        Game::Unsupported => 2,
        Game::Paused => 1,
        Game::Waiting => 0,
    };
    let state_of = |ids: &[&str]| {
        reported
            .iter()
            .filter(|(id, _, _)| ids.contains(id))
            .map(|(_, _, g)| g.clone())
            .max_by_key(rank)
            .unwrap_or(Game::Waiting)
    };
    let mut rows = vec![GameRow {
        title: "Le Mans Ultimate".to_owned(),
        state: state_of(&["lmu"]),
    }];
    rows.extend(ctx.readers.iter().map(|(title, ids)| GameRow {
        title: title.clone(),
        state: state_of(ids),
    }));
    rows
}

fn scale_of(hwnd: HWND) -> f32 {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        1.0
    } else {
        dpi as f32 / 96.0
    }
}

unsafe fn paint_window(hwnd: HWND, state: &State) {
    let mut ps: PAINTSTRUCT = std::mem::zeroed();
    let hdc = BeginPaint(hwnd, &mut ps);
    let mut client = rect(0, 0, 0, 0);
    GetClientRect(hwnd, &mut client);
    let (w, h) = (client.right.max(1), client.bottom.max(1));
    let memory = CreateCompatibleDC(hdc);
    let bitmap = CreateCompatibleBitmap(hdc, w, h);
    let old = SelectObject(memory, bitmap);

    let ctx = &state.ctx;
    let snapshot = ctx.shared.snapshot();
    let live = ctx.shared.live();
    let games = game_rows(ctx);
    let account = ctx.account.lock().unwrap().clone();
    let recent_laps = ctx.shared.recent_laps();
    let log: Vec<(String, String)> = crate::applog::recent(60)
        .into_iter()
        .map(|(ms, line)| (local_time(ms), line))
        .collect();
    let view = View {
        lang: account.lang,
        tab: state.tab,
        on_top: state.on_top,
        full: state.full.is_some(),
        scale: scale_of(hwnd),
        now_ms: now_ms(),
        snapshot: &snapshot,
        live: live.as_ref(),
        games: &games,
        device: account.device.as_deref(),
        server: &account.server,
        recent_laps: &recent_laps,
        log: &log,
        laps_dir: &ctx.laps_dir,
    };
    paint(memory, w, h, &view);
    BitBlt(hdc, 0, 0, w, h, memory, 0, 0, SRCCOPY);
    SelectObject(memory, old);
    DeleteObject(bitmap);
    DeleteDC(memory);
    EndPaint(hwnd, &ps);
}

fn set_on_top(hwnd: HWND, on: bool) {
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
unsafe fn toggle_full(hwnd: HWND, state: &mut State) {
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

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
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
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_ERASEBKGND => 1,
        WM_PAINT => {
            paint_window(hwnd, state);
            0
        }
        WM_LBUTTONDOWN => {
            let (x, y) = ((lparam & 0xffff) as i16 as i32, ((lparam >> 16) & 0xffff) as i16 as i32);
            let mut client = rect(0, 0, 0, 0);
            GetClientRect(hwnd, &mut client);
            let [dash, mon, full, top] = header_hits(client.right, scale_of(hwnd));
            if inside(&dash, x, y) {
                state.tab = Tab::Dash;
            } else if inside(&mon, x, y) {
                state.tab = Tab::Monitor;
            } else if inside(&full, x, y) {
                toggle_full(hwnd, state);
            } else if inside(&top, x, y) {
                state.on_top = !state.on_top;
                set_on_top(hwnd, state.on_top);
            }
            InvalidateRect(hwnd, null(), 0);
            0
        }
        WM_LBUTTONDBLCLK => {
            // A double click below the header: full screen and back.
            let y = ((lparam >> 16) & 0xffff) as i16 as i32;
            if y > (54.0 * scale_of(hwnd)) as i32 {
                toggle_full(hwnd, state);
                InvalidateRect(hwnd, null(), 0);
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
                VK_ESCAPE if state.full.is_some() => toggle_full(hwnd, state),
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
        let window_class = WNDCLASSW {
            style: CS_DBLCLKS,
            lpfnWndProc: Some(window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: null_mut(),
            hCursor: LoadCursorW(null_mut(), IDC_ARROW),
            hbrBackground: null_mut(),
            lpszMenuName: null(),
            lpszClassName: class.as_ptr(),
        };
        // Registering twice fails harmlessly (the class from the first time is used).
        RegisterClassW(&window_class);
        let state = Box::into_raw(Box::new(State {
            ctx: ctx(),
            tab: Tab::Dash,
            on_top: false,
            full: None,
        }));
        // Only this window follows the screen's DPI; the thread goes back to how it was afterwards.
        let before = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            win::wide("Xpeed Sim").as_ptr(),
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
        if hwnd.is_null() {
            crate::applog::line("could not create the panel window");
            drop(Box::from_raw(state));
            return null_mut();
        }
        // The design size is the inside of the window, at the screen's scale; the frame goes around it.
        let dpi = GetDpiForWindow(hwnd).max(96);
        let scale = dpi as f32 / 96.0;
        let mut outer = rect(0, 0, (WIDTH as f32 * scale) as i32, (HEIGHT as f32 * scale) as i32);
        AdjustWindowRectExForDpi(&mut outer, WS_OVERLAPPEDWINDOW, 0, 0, dpi);
        SetWindowPos(
            hwnd,
            null_mut(),
            0,
            0,
            outer.right - outer.left,
            outer.bottom - outer.top,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
        ShowWindow(hwnd, SW_SHOWNORMAL);
        SetForegroundWindow(hwnd);
        hwnd
    }
}

const DEMO_TRACK_M: f64 = 2400.0;

/// Made-up driving on a 2.4 km track, as one game would give it.
fn demo_frame(lap: i32, dist: f64, lap_time: f64, last: Option<f64>, fuel: f32, pace: f64) -> crate::game::Frame {
    use std::f64::consts::TAU;
    let mut frame = crate::game::Frame::empty();
    let phase = TAU * dist / 800.0;
    let speed = (48.0 + 26.0 * phase.sin()) * pace;
    let accel = phase.cos();
    frame.driving = true;
    frame.lap = lap;
    frame.dist_m = Some(dist);
    frame.lap_time_s = Some(lap_time);
    frame.last_lap_s = last;
    frame.track = "Demo Ring".into();
    frame.car = "Demo GT3".into();
    frame.track_length_m = Some(DEMO_TRACK_M);
    frame.speed_ms = speed as f32;
    let gear = (1.0 + speed / 14.0).floor().min(6.0);
    frame.gear = gear as f32;
    frame.rpm = (4200.0 + (speed - (gear - 1.0) * 14.0) / 14.0 * 4000.0) as f32;
    frame.throttle = if accel > -0.2 {
        (0.6 + 0.4 * accel).clamp(0.0, 1.0) as f32
    } else {
        0.0
    };
    frame.brake = if accel < -0.4 {
        ((-accel - 0.4) * 1.6).min(1.0) as f32
    } else {
        0.0
    };
    frame.clutch = 0.0;
    frame.steer = (0.6 * (TAU * dist / 600.0).sin()) as f32;
    frame.fuel_l = fuel;
    frame
}

/// Opens the panel alone, fed with made-up driving, so it can be seen without a game. Nothing is recorded or sent.
pub fn demo(lang: Lang) -> std::process::ExitCode {
    use std::time::{Duration, Instant};
    crate::applog::line("panel demo: made-up data, nothing is recorded or sent");
    let shared = Shared::new(true);
    shared.set_game("lmu", "Le Mans Ultimate", Game::Waiting);
    shared.set_game("ac", "Assetto Corsa", Game::Connected);
    let feeder = {
        let shared = shared.clone();
        std::thread::spawn(move || {
            let mut tracker = crate::dash::Tracker::default();
            let (mut lap, mut dist, mut lap_time, mut last, mut fuel) = (1, 0.0, 0.0, None, 60.0f32);
            let start = Instant::now();
            let mut previous = Duration::ZERO;
            while !shared.quitting() {
                std::thread::sleep(Duration::from_millis(16));
                let now = start.elapsed();
                let dt = (now - previous).as_secs_f64();
                previous = now;
                // Each lap a little faster or slower than the one before, so the delta moves.
                let pace = 1.0 + 0.012 * (f64::from(lap) * 1.7).sin();
                let speed = f64::from(demo_frame(lap, dist, 0.0, None, fuel, pace).speed_ms);
                dist += speed * dt;
                lap_time += dt;
                fuel = (fuel - (dt * 0.004) as f32).max(0.0);
                if dist >= DEMO_TRACK_M {
                    last = Some(lap_time);
                    let label = format!("Lap {lap}  {}", lap_clock(Some(lap_time)));
                    crate::applog::line(&format!("panel demo: lap {lap} done"));
                    shared.update(|s| {
                        s.laps_saved += 1;
                        s.last_lap = Some(label.clone());
                    });
                    shared.notify(crate::status::Notice::LapSaved(label));
                    lap += 1;
                    dist -= DEMO_TRACK_M;
                    lap_time = 0.0;
                }
                shared.set_game("ac", "Assetto Corsa", Game::Recording(lap as u32));
                let frame = demo_frame(lap, dist, lap_time, last, fuel, pace);
                shared.offer_live(tracker.on_frame("Demo", &frame, now_ms()));
            }
        })
    };
    let hwnd = show(null_mut(), || Context {
        shared: shared.clone(),
        account: Arc::new(Mutex::new(Account {
            device: Some("DEMO".into()),
            server: "https://xpeed.skale.club".into(),
            lang,
        })),
        laps_dir: "(demo)".into(),
        readers: crate::games::READERS.iter().map(|r| (r.title.to_owned(), r.ids.to_vec())).collect(),
        icon_big: null_mut(),
        icon_small: null_mut(),
        quit_on_close: true,
    });
    if !hwnd.is_null() {
        unsafe {
            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
    shared.quit();
    let _ = feeder.join();
    std::process::ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::Frame;
    use windows_sys::Win32::Graphics::Gdi::{CreateDIBSection, GdiFlush, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS};

    /// Paints a view into a bitmap and gives back its pixels (BGRA, top row first).
    fn render(view: &View, width: i32, height: i32) -> Vec<u8> {
        unsafe {
            let hdc = CreateCompatibleDC(null_mut());
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..std::mem::zeroed()
            };
            let mut bits: *mut std::ffi::c_void = null_mut();
            let bitmap = CreateDIBSection(hdc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
            assert!(!bitmap.is_null());
            let old = SelectObject(hdc, bitmap);
            paint(hdc, width, height, view);
            GdiFlush();
            let pixels = std::slice::from_raw_parts(bits.cast::<u8>(), (width * height * 4) as usize).to_vec();
            SelectObject(hdc, old);
            DeleteObject(bitmap);
            DeleteDC(hdc);
            pixels
        }
    }

    fn has_color(pixels: &[u8], color: COLORREF) -> usize {
        let (r, g, b) = ((color & 0xff) as u8, (color >> 8 & 0xff) as u8, (color >> 16 & 0xff) as u8);
        pixels
            .as_chunks::<4>()
            .0
            .iter()
            .filter(|p| p[0] == b && p[1] == g && p[2] == r)
            .count()
    }

    /// Saves the picture when `XPEED_SIM_PANEL_PNG` names a folder (to look at it); otherwise nothing.
    fn save(pixels: &[u8], width: i32, height: i32, name: &str) {
        let Some(dir) = std::env::var_os("XPEED_SIM_PANEL_PNG") else {
            return;
        };
        let path = std::path::Path::new(&dir).join(name);
        let file = std::fs::File::create(&path).unwrap();
        let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let rgba: Vec<u8> = pixels.as_chunks::<4>().0.iter().flat_map(|p| [p[2], p[1], p[0], 255]).collect();
        encoder.write_header().unwrap().write_image_data(&rgba).unwrap();
    }

    fn live_reading() -> Live {
        let mut tracker = crate::dash::Tracker::default();
        let mut frame = Frame::empty();
        frame.driving = true;
        frame.lap = 4;
        frame.track = "Autodromo Nazionale Monza".into();
        frame.car = "Ferrari 296 GT3".into();
        frame.track_length_m = Some(5793.0);
        frame.rpm = 8000.0;
        tracker.on_frame("Assetto Corsa", &frame, 0);
        frame.dist_m = Some(2310.0);
        frame.lap_time_s = Some(41.532);
        frame.last_lap_s = Some(107.918);
        frame.speed_ms = 71.4;
        frame.rpm = 7350.0;
        frame.gear = 5.0;
        frame.throttle = 0.92;
        frame.brake = 0.0;
        frame.clutch = 0.0;
        frame.steer = -0.18;
        frame.fuel_l = 38.6;
        let mut live = tracker.on_frame("Assetto Corsa", &frame, 1_000);
        live.best_lap_s = Some(107.204);
        live.delta_s = Some(-0.27);
        live
    }

    struct Fixture {
        snapshot: Snapshot,
        games: Vec<GameRow>,
        laps: Vec<String>,
        log: Vec<(String, String)>,
    }

    fn fixture() -> Fixture {
        Fixture {
            snapshot: Snapshot {
                game: Game::Recording(4),
                title: Some("Assetto Corsa"),
                cloud: Cloud::Idle,
                laps_saved: 3,
                last_lap: Some("Lap 3  1:47.918".into()),
            },
            games: vec![
                GameRow {
                    title: "Le Mans Ultimate".into(),
                    state: Game::Waiting,
                },
                GameRow {
                    title: "Assetto Corsa · ACC · AC Rally".into(),
                    state: Game::Recording(4),
                },
                GameRow {
                    title: "Automobilista 2".into(),
                    state: Game::Waiting,
                },
                GameRow {
                    title: "iRacing".into(),
                    state: Game::Connected,
                },
                GameRow {
                    title: "Stock Car Extreme".into(),
                    state: Game::Unsupported,
                },
            ],
            laps: vec!["Lap 1  1:49.002".into(), "Lap 2  1:48.115".into(), "Lap 3  1:47.918".into()],
            log: vec![
                ("21:40:02".into(), "Xpeed Sim 0.1.0 starting".into()),
                ("21:40:02".into(), "paired with https://xpeed.skale.club as RIG".into()),
                ("21:41:15".into(), "Connected to Assetto Corsa.".into()),
                ("21:43:05".into(), "Saved lap 1 (1:49.002) to ac_monza_lap1.xlap.gz".into()),
            ],
        }
    }

    fn view<'a>(f: &'a Fixture, live: Option<&'a Live>, tab: Tab, scale: f32, lang: Lang) -> View<'a> {
        View {
            lang,
            tab,
            on_top: tab == Tab::Monitor,
            full: false,
            scale,
            now_ms: 1_500,
            snapshot: &f.snapshot,
            live,
            games: &f.games,
            device: Some("RIG"),
            server: "https://xpeed.skale.club",
            recent_laps: &f.laps,
            log: &f.log,
            laps_dir: "C:\\Users\\Driver\\Documents\\Xpeed Sim\\Laps",
        }
    }

    #[test]
    fn paints_the_dashboard_with_the_gear_in_the_accent_colour_and_the_delta_in_green() {
        let f = fixture();
        let live = live_reading();
        let (w, h) = (960, 600);
        let pixels = render(&view(&f, Some(&live), Tab::Dash, 1.0, Lang::En), w, h);
        save(&pixels, w, h, "panel-dashboard.png");
        assert_eq!(&pixels[..3], &[0x14, 0x12, 0x11], "the corner is the background");
        assert!(
            has_color(&pixels, ACCENT) > 2000,
            "the selected tab and the gear are drawn in the accent"
        );
        assert!(
            has_color(&pixels, GREEN) > 300,
            "a negative delta, the throttle and the low revs are green"
        );
        assert!(has_color(&pixels, RED) < has_color(&pixels, GREEN), "no brake, revs under the red");
    }

    #[test]
    fn paints_the_monitor_and_scales_with_the_screen() {
        let f = fixture();
        let (w, h) = (1440, 900);
        let pixels = render(&view(&f, None, Tab::Monitor, 1.5, Lang::En), w, h);
        save(&pixels, w, h, "panel-monitor-150.png");
        assert!(has_color(&pixels, CARD) > 100_000, "the cards fill most of the window");
        assert!(has_color(&pixels, RED) > 10, "the unsupported game has a red dot");
    }

    #[test]
    fn says_it_waits_when_there_is_no_reading_or_it_is_old() {
        let f = fixture();
        let mut old = live_reading();
        old.at_ms = -10_000;
        let (w, h) = (960, 600);
        let waiting = render(&view(&f, None, Tab::Dash, 1.0, Lang::En), w, h);
        save(&waiting, w, h, "panel-waiting.png");
        let stale = render(&view(&f, Some(&old), Tab::Dash, 1.0, Lang::En), w, h);
        assert_eq!(waiting, stale, "a reading older than 3 s is not shown");
        assert!(has_color(&waiting, CARD) < 20_000, "no cards while waiting");
    }

    #[test]
    fn the_header_can_be_clicked_where_it_is_drawn() {
        let [dash, mon, full, top] = header_hits(960, 1.0);
        assert!(inside(&dash, 20, 20) && !inside(&dash, 150, 20));
        assert!(inside(&mon, 160, 20));
        assert!(inside(&full, 600, 20) && !inside(&full, 740, 20));
        assert!(inside(&top, 900, 20) && !inside(&top, 900, 60));
        assert!(full.right < top.left && mon.right < full.left, "nothing overlaps");
        let [dash2, _, _, top2] = header_hits(1440, 1.5);
        assert_eq!((dash2.left, dash2.right), (24, 219));
        assert_eq!(top2.right, 1440 - 24);
    }

    #[test]
    fn writes_times_gears_and_deltas_like_a_dashboard() {
        assert_eq!(lap_clock(Some(107.918)), "1:47.918");
        assert_eq!(lap_clock(None), "-:--.---");
        assert_eq!(delta_text(Some(-0.274)), "-0.27");
        assert_eq!(delta_text(Some(0.0)), "+0.00");
        assert_eq!(delta_text(None), "—");
        assert_eq!(
            (gear_text(-1.0), gear_text(0.0), gear_text(5.0), gear_text(f32::NAN)),
            ("R".into(), "N".into(), "5".into(), "–".into())
        );
        assert_eq!((rev_color(0.5), rev_color(0.9), rev_color(0.97)), (GREEN, AMBER, RED));
    }

    #[test]
    fn the_dashboard_grows_on_a_big_screen_and_never_shrinks() {
        assert_eq!(zoom(rect(16, 54, 944, 586), 1.0), 1.0);
        assert_eq!(zoom(rect(0, 0, 400, 300), 1.0), 1.0, "a small window keeps the design size");
        let full_hd = zoom(rect(16, 54, 1904, 1066), 1.0);
        assert!((full_hd - 1.902).abs() < 0.01, "{full_hd}");
        assert_eq!(zoom(rect(0, 0, 10_000, 10_000), 1.0), 3.0);
        assert_eq!(zoom(rect(0, 0, 1392, 798), 1.5), 1.0, "the screen's DPI is already counted");
    }

    #[test]
    fn the_demo_drives_a_believable_car() {
        for i in 0..240 {
            let frame = demo_frame(2, i as f64 * 10.0, i as f64 * 0.2, Some(55.0), 40.0, 1.0);
            assert!((20.0..=75.0).contains(&frame.speed_ms), "{}", frame.speed_ms);
            assert!((1.0..=6.0).contains(&frame.gear));
            assert!((0.0..=1.0).contains(&frame.throttle) && (0.0..=1.0).contains(&frame.brake));
            assert!(frame.throttle == 0.0 || frame.brake == 0.0, "never both pedals at once");
            assert!((-1.0..=1.0).contains(&frame.steer));
        }
    }

    #[test]
    fn shows_log_times_on_the_local_clock() {
        let text = local_time(1_794_000_000_000);
        assert_eq!(text.len(), 8);
        assert_eq!(text.as_bytes()[2], b':');
    }
}
