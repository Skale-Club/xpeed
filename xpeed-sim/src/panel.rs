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
use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW, CreatePen, CreateSolidBrush, DeleteDC, DeleteObject,
    DrawTextW, EndPaint, FillRect, GetStockObject, GetTextExtentPoint32W, InvalidateRect, RoundRect, SelectObject, SetBkMode,
    SetTextCharacterExtra, SetTextColor, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DT_CENTER, DT_END_ELLIPSIS, DT_LEFT,
    DT_NOPREFIX, DT_RIGHT, DT_SINGLELINE, DT_VCENTER, FW_NORMAL, FW_SEMIBOLD, HDC, HFONT, NULL_PEN, OUT_DEFAULT_PRECIS, PAINTSTRUCT,
    PS_SOLID, SRCCOPY, TRANSPARENT,
};
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows_sys::Win32::Graphics::GdiPlus::{
    FillModeAlternate, GdipAddPathArc, GdipClosePathFigure, GdipCreateFromHDC, GdipCreatePath, GdipCreatePen1, GdipCreateSolidFill,
    GdipDeleteBrush, GdipDeleteGraphics, GdipDeletePath, GdipDeletePen, GdipDrawPath, GdipFillPath, GdipSetPixelOffsetMode,
    GdipSetSmoothingMode, GdiplusStartup, GdiplusStartupInput, GpGraphics, GpPath, PixelOffsetModeHalf, SmoothingModeAntiAlias, UnitPixel,
};
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

/// The colours, as `0x00BBGGRR`. The accent is the app's `--primary` (#F5E663); purple marks the best lap, as timing
/// screens do.
const fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
    r as u32 | (g as u32) << 8 | (b as u32) << 16
}
const BG: COLORREF = rgb(0x0c, 0x0d, 0x0f);
const CARD: COLORREF = rgb(0x16, 0x18, 0x1c);
const EDGE: COLORREF = rgb(0x25, 0x28, 0x2e);
const TRACK: COLORREF = rgb(0x27, 0x2a, 0x31);
const DIM: COLORREF = rgb(0x1f, 0x22, 0x27);
const TEXT: COLORREF = rgb(0xf2, 0xf2, 0xf3);
const MUTED: COLORREF = rgb(0x7c, 0x82, 0x8c);
const ACCENT: COLORREF = rgb(0xf5, 0xe6, 0x63);
const GREEN: COLORREF = rgb(0x2f, 0xd6, 0x7b);
const RED: COLORREF = rgb(0xff, 0x4d, 0x4d);
const BLUE: COLORREF = rgb(0x3d, 0x9b, 0xff);
const AMBER: COLORREF = rgb(0xff, 0xb0, 0x3b);
const PURPLE: COLORREF = rgb(0xb5, 0x7c, 0xff);
const GREY: COLORREF = rgb(0x5c, 0x61, 0x6b);

/// `a` with `t` (0..1) of `b` mixed in.
fn mix(a: COLORREF, b: COLORREF, t: f32) -> COLORREF {
    let channel = |shift: u32| {
        let (x, y) = ((a >> shift & 0xff) as f32, (b >> shift & 0xff) as f32);
        ((x + (y - x) * t).round() as u32) << shift
    };
    channel(0) | channel(8) | channel(16)
}

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

/// Height of the header, in design pixels.
const HEADER_H: f32 = 66.0;
/// The dashboard is laid out on this canvas (design units) and scaled whole to fit the window, so it keeps its
/// proportions at any size and fills a full screen instead of stretching empty cards.
const CANVAS_W: f32 = 1000.0;
const CANVAS_H: f32 = 520.0;
/// The shift lights light from this share of the top RPM to `SHIFT_AT`, where they flash.
const LIGHTS_FROM: f32 = 0.55;
const SHIFT_AT: f32 = 0.97;
const LIGHTS: usize = 20;

/// The places of the header that can be clicked: the two tabs, "full screen" and "always on top".
fn header_hits(width: i32, scale: f32) -> [RECT; 4] {
    let p = |v: f32| (v * scale).round() as i32;
    let (top, bottom) = (p(13.0), p(51.0));
    let right = width - p(16.0);
    let (on_top_w, full_w, gap) = (p(178.0), p(162.0), p(10.0));
    [
        rect(p(20.0), p(17.0), p(136.0), p(47.0)),
        rect(p(136.0), p(17.0), p(252.0), p(47.0)),
        rect(right - on_top_w - gap - full_w, top, right - on_top_w - gap, bottom),
        rect(right - on_top_w, top, right, bottom),
    ]
}

/// GDI+ is started once for the process; shapes are drawn with it (smooth edges) when it starts, with plain GDI
/// otherwise.
fn gdiplus_ready() -> bool {
    static READY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *READY.get_or_init(|| {
        let mut token = 0usize;
        let input = GdiplusStartupInput {
            GdiplusVersion: 1,
            ..Default::default()
        };
        unsafe { GdiplusStartup(&mut token, &input, null_mut()) == 0 }
    })
}

/// A GDI colour (`0x00BBGGRR`) as GDI+ wants it (`0xAARRGGBB`, opaque).
fn argb(color: COLORREF) -> u32 {
    0xff00_0000 | (color & 0xff) << 16 | (color & 0xff00) | (color >> 16 & 0xff)
}

/// Runs `draw` with a GDI+ surface over `hdc`, smoothing on. False when GDI+ is not there.
fn smooth(hdc: HDC, draw: impl FnOnce(*mut GpGraphics)) -> bool {
    if !gdiplus_ready() {
        return false;
    }
    unsafe {
        let mut graphics = null_mut();
        if GdipCreateFromHDC(hdc, &mut graphics) != 0 || graphics.is_null() {
            return false;
        }
        GdipSetSmoothingMode(graphics, SmoothingModeAntiAlias);
        GdipSetPixelOffsetMode(graphics, PixelOffsetModeHalf);
        draw(graphics);
        GdipDeleteGraphics(graphics);
    }
    true
}

/// A rounded rectangle as a GDI+ path (`radius` in pixels, no more than half the shorter side).
unsafe fn rounded_path(x: f32, y: f32, w: f32, h: f32, radius: f32) -> *mut GpPath {
    let mut path = null_mut();
    GdipCreatePath(FillModeAlternate, &mut path);
    let d = (radius * 2.0).min(w).min(h).max(0.5);
    GdipAddPathArc(path, x, y, d, d, 180.0, 90.0);
    GdipAddPathArc(path, x + w - d, y, d, d, 270.0, 90.0);
    GdipAddPathArc(path, x + w - d, y + h - d, d, d, 0.0, 90.0);
    GdipAddPathArc(path, x, y + h - d, d, d, 90.0, 90.0);
    GdipClosePathFigure(path);
    path
}

fn inside(r: &RECT, x: i32, y: i32) -> bool {
    x >= r.left && x < r.right && y >= r.top && y < r.bottom
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Face {
    /// Labels and running text.
    Ui,
    /// Numbers: Bahnschrift, the DIN-like face Windows ships, as motorsport screens use.
    Num,
    /// The log.
    Mono,
    /// Windows' icon font (full screen, pin).
    Icon,
}

impl Face {
    fn name(self, weight: i32) -> &'static str {
        match self {
            Face::Ui => "Segoe UI",
            Face::Num if weight >= FW_SEMIBOLD as i32 => "Bahnschrift SemiBold",
            Face::Num => "Bahnschrift",
            Face::Mono => "Cascadia Mono",
            Face::Icon => "Segoe MDL2 Assets",
        }
    }
}

/// Drawing over one device context in design units: `s` pixels per unit from the origin `(ox, oy)`. The fonts it
/// made are deleted when it is dropped.
struct Painter {
    hdc: HDC,
    s: f32,
    ox: i32,
    oy: i32,
    fonts: Vec<((i32, i32, Face), HFONT)>,
}

impl Painter {
    fn new(hdc: HDC, s: f32) -> Painter {
        unsafe {
            SetBkMode(hdc, TRANSPARENT as i32);
        }
        Painter {
            hdc,
            s,
            ox: 0,
            oy: 0,
            fonts: Vec::new(),
        }
    }

    /// Design units from here on: `s` pixels each, starting at pixel `(ox, oy)`.
    fn place(&mut self, s: f32, ox: i32, oy: i32) {
        (self.s, self.ox, self.oy) = (s, ox, oy);
    }

    fn px(&self, v: f32) -> i32 {
        (v * self.s).round() as i32
    }

    /// A box in design units, as pixels.
    fn r(&self, x: f32, y: f32, w: f32, h: f32) -> RECT {
        rect(
            self.ox + self.px(x),
            self.oy + self.px(y),
            self.ox + self.px(x + w),
            self.oy + self.px(y + h),
        )
    }

    fn font(&mut self, size: f32, weight: i32, face: Face) -> HFONT {
        let key = (self.px(size).max(1), weight, face);
        if let Some((_, font)) = self.fonts.iter().find(|(k, _)| *k == key) {
            return *font;
        }
        let name = win::wide(face.name(weight));
        // Bahnschrift's weights are faces of their own; asking them for bold again would thicken them twice.
        let gdi_weight = if face == Face::Num { FW_NORMAL as i32 } else { weight };
        let font = unsafe {
            CreateFontW(
                -key.0,
                0,
                0,
                0,
                gdi_weight,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                OUT_DEFAULT_PRECIS as u32,
                CLIP_DEFAULT_PRECIS as u32,
                CLEARTYPE_QUALITY as u32,
                0,
                name.as_ptr(),
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

    /// A rounded box; `edge` draws a one-pixel border in that colour.
    fn round(&self, r: RECT, radius: f32, color: COLORREF, edge: Option<COLORREF>) {
        let (x, y, w, h) = (r.left as f32, r.top as f32, (r.right - r.left) as f32, (r.bottom - r.top) as f32);
        let radius_px = radius * self.s;
        let drawn = smooth(self.hdc, |graphics| unsafe {
            let path = rounded_path(x, y, w, h, radius_px);
            let mut brush = null_mut();
            GdipCreateSolidFill(argb(color), &mut brush);
            GdipFillPath(graphics, brush.cast(), path);
            GdipDeleteBrush(brush.cast());
            GdipDeletePath(path);
            if let Some(edge) = edge {
                // Half a pixel in, so the one-pixel line falls on whole pixels.
                let path = rounded_path(x + 0.5, y + 0.5, w - 1.0, h - 1.0, radius_px - 0.5);
                let mut pen = null_mut();
                GdipCreatePen1(argb(edge), 1.0, UnitPixel, &mut pen);
                GdipDrawPath(graphics, pen, path);
                GdipDeletePen(pen);
                GdipDeletePath(path);
            }
        });
        if drawn {
            return;
        }
        unsafe {
            let brush = CreateSolidBrush(color);
            let pen = edge.map(|c| CreatePen(PS_SOLID, 1, c));
            let old_brush = SelectObject(self.hdc, brush);
            let old_pen = SelectObject(self.hdc, pen.unwrap_or_else(|| GetStockObject(NULL_PEN)));
            let d = self.px(radius * 2.0).max(1);
            let grow = i32::from(edge.is_none());
            RoundRect(self.hdc, r.left, r.top, r.right + grow, r.bottom + grow, d, d);
            SelectObject(self.hdc, old_pen);
            SelectObject(self.hdc, old_brush);
            DeleteObject(brush);
            if let Some(pen) = pen {
                DeleteObject(pen);
            }
        }
    }

    /// One line of text in a box, cut with "…" when it does not fit.
    #[allow(clippy::too_many_arguments)]
    fn text(&mut self, s: &str, r: RECT, size: f32, weight: i32, face: Face, color: COLORREF, align: u32) {
        // An empty string has a dangling pointer, and DrawTextW reads it even with a length of zero.
        if s.is_empty() {
            return;
        }
        let font = self.font(size, weight, face);
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

    /// The width of a text, in design units.
    fn width_of(&mut self, s: &str, size: f32, weight: i32, face: Face) -> f32 {
        if s.is_empty() {
            return 0.0;
        }
        let font = self.font(size, weight, face);
        let wide: Vec<u16> = s.encode_utf16().collect();
        let mut extent = SIZE { cx: 0, cy: 0 };
        unsafe {
            let old = SelectObject(self.hdc, font);
            GetTextExtentPoint32W(self.hdc, wide.as_ptr(), wide.len() as i32, &mut extent);
            SelectObject(self.hdc, old);
        }
        extent.cx as f32 / self.s
    }

    /// A tile: the card colour with its border.
    fn tile(&self, x: f32, y: f32, w: f32, h: f32, color: COLORREF) {
        self.round(self.r(x, y, w, h), 12.0, color, Some(EDGE));
    }

    /// A small upper-case label with its letters spaced out.
    ///
    /// The spacing also follows the last letter, which right or centred alignment would count as text and push the
    /// label off its place (and cut it); so the label is measured and placed by hand, without that last space.
    fn caps(&mut self, s: &str, r: RECT, size: f32, color: COLORREF, align: u32) {
        let upper = s.to_uppercase();
        let extra = self.px(1.3);
        unsafe {
            SetTextCharacterExtra(self.hdc, extra);
        }
        let width = (self.width_of(&upper, size, FW_SEMIBOLD as i32, Face::Ui) * self.s).round() as i32 - extra;
        let left = if align == DT_RIGHT {
            r.right - width
        } else if align == DT_CENTER {
            (r.left + r.right - width) / 2
        } else {
            r.left
        };
        let placed = rect(left.max(r.left), r.top, left + width + extra + self.px(4.0), r.bottom);
        self.text(&upper, placed, size, FW_SEMIBOLD as i32, Face::Ui, color, DT_LEFT);
        unsafe {
            SetTextCharacterExtra(self.hdc, 0);
        }
    }

    /// The small upper-case label at the top left of a tile.
    fn label(&mut self, s: &str, x: f32, y: f32, w: f32) {
        let r = self.r(x, y, w, 18.0);
        self.text(&s.to_uppercase(), r, 11.5, FW_SEMIBOLD as i32, Face::Ui, MUTED, DT_LEFT);
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

/// The colour of shift light `i` of `LIGHTS`: the first third green, then amber, then red.
fn light_color(i: usize) -> COLORREF {
    match i * 3 / LIGHTS {
        0 => GREEN,
        1 => AMBER,
        _ => RED,
    }
}

/// How many shift lights are lit at `share` of the top RPM, and whether they flash (time to shift).
fn lights_lit(share: f32) -> (usize, bool) {
    if !share.is_finite() {
        return (0, false);
    }
    if share >= SHIFT_AT {
        return (LIGHTS, true);
    }
    let lit = ((share - LIGHTS_FROM) / (SHIFT_AT - LIGHTS_FROM) * LIGHTS as f32).floor();
    (lit.clamp(0.0, LIGHTS as f32) as usize, false)
}

/// Splits a saved lap's label (`Lap 3  1:47.918`) into its name and its time.
fn lap_parts(label: &str) -> (&str, &str) {
    label.split_once("  ").map_or((label, ""), |(name, time)| (name, time.trim()))
}

/// Draws one frame of the window.
pub fn paint(hdc: HDC, width: i32, height: i32, view: &View) {
    let mut g = Painter::new(hdc, view.scale);
    g.fill(rect(0, 0, width, height), BG);
    header(&mut g, width, view);
    let top = g.px(HEADER_H);
    let body = rect(g.px(16.0), top, width - g.px(16.0), height - g.px(16.0));
    match view.tab {
        Tab::Dash => dashboard(&mut g, body, view),
        Tab::Monitor => monitor(&mut g, body, view),
    }
}

fn header(g: &mut Painter, width: i32, view: &View) {
    g.place(view.scale, 0, 0);
    let [dash, mon, full, top] = header_hits(width, view.scale);
    let semi = FW_SEMIBOLD as i32;
    // The tabs: one pill, the chosen tab a yellow pill inside it.
    let control = g.r(16.0, 13.0, 240.0, 38.0);
    g.round(control, 19.0, CARD, Some(EDGE));
    for (r, tab, label) in [(dash, Tab::Dash, Msg::PanelTabDash), (mon, Tab::Monitor, Msg::PanelTabMonitor)] {
        let selected = view.tab == tab;
        if selected {
            g.round(r, 15.0, ACCENT, None);
        }
        let color = if selected { BG } else { MUTED };
        g.text(&text(view.lang, &label), r, 14.0, semi, Face::Ui, color, DT_CENTER);
    }
    // Full screen and always on top: pill buttons with Windows' own icons; one that is on is filled yellow.
    let full_label = text(
        view.lang,
        if view.full {
            &Msg::PanelExitFullScreen
        } else {
            &Msg::PanelFullScreen
        },
    );
    let buttons = [
        (full, view.full, if view.full { "\u{E73F}" } else { "\u{E740}" }, full_label),
        (top, view.on_top, "\u{E718}", text(view.lang, &Msg::PanelOnTop)),
    ];
    for (r, active, icon, label) in buttons {
        let (fill, edge, icon_ink, ink) = if active {
            (ACCENT, None, BG, BG)
        } else {
            (CARD, Some(EDGE), MUTED, TEXT)
        };
        g.round(r, 19.0, fill, edge);
        // Icon and label centred together.
        let (icon_w, space) = (g.px(14.0), g.px(9.0));
        let measured = g.width_of(&label, 13.5, semi, Face::Ui);
        let label_w = g.px(measured).min(r.right - r.left - icon_w - space - g.px(24.0));
        let start = (r.left + r.right - icon_w - space - label_w) / 2;
        let icon_box = rect(start, r.top, start + icon_w, r.bottom);
        g.text(icon, icon_box, 13.0, FW_NORMAL as i32, Face::Icon, icon_ink, DT_CENTER);
        let label_box = rect(
            start + icon_w + space,
            r.top,
            start + icon_w + space + label_w + g.px(2.0),
            r.bottom,
        );
        g.text(&label, label_box, 13.5, semi, Face::Ui, ink, DT_LEFT);
    }
}

/// Fits the canvas in `body`: the scale and where its top left goes.
fn canvas_fit(body: RECT) -> (f32, i32, i32) {
    let (bw, bh) = ((body.right - body.left) as f32, (body.bottom - body.top) as f32);
    let s = (bw / CANVAS_W).min(bh / CANVAS_H).max(0.1);
    let ox = body.left + ((bw - CANVAS_W * s) / 2.0).round() as i32;
    let oy = body.top + ((bh - CANVAS_H * s) / 2.0).round() as i32;
    (s, ox, oy)
}

fn waiting(g: &mut Painter, body: RECT, view: &View) {
    let (s, ox, oy) = canvas_fit(body);
    g.place(s, ox, oy);
    let title = text(view.lang, &Msg::PanelWaitingTitle);
    let r = g.r(0.0, 150.0, CANVAS_W, 50.0);
    g.text(&title, r, 34.0, FW_SEMIBOLD as i32, Face::Num, TEXT, DT_CENTER);
    let r = g.r(0.0, 202.0, CANVAS_W, 26.0);
    g.text(
        &text(view.lang, &Msg::PanelWaiting),
        r,
        15.0,
        FW_NORMAL as i32,
        Face::Ui,
        MUTED,
        DT_CENTER,
    );
    // The games it reads, as chips, centred in rows.
    let chips: Vec<(String, f32)> = view
        .games
        .iter()
        .map(|row| (row.title.clone(), g.width_of(&row.title, 13.0, FW_SEMIBOLD as i32, Face::Ui) + 28.0))
        .collect();
    let mut rows: Vec<Vec<(String, f32)>> = vec![Vec::new()];
    let mut used = 0.0;
    for chip in chips {
        if used + chip.1 > 760.0 && !rows.last().unwrap().is_empty() {
            rows.push(Vec::new());
            used = 0.0;
        }
        used += chip.1 + 10.0;
        rows.last_mut().unwrap().push(chip);
    }
    for (i, row) in rows.iter().enumerate() {
        let total: f32 = row.iter().map(|(_, w)| w + 10.0).sum::<f32>() - 10.0;
        let mut x = (CANVAS_W - total) / 2.0;
        let y = 262.0 + i as f32 * 40.0;
        for (name, w) in row {
            g.round(g.r(x, y, *w, 30.0), 15.0, CARD, Some(EDGE));
            let r = g.r(x, y, *w, 30.0);
            g.text(name, r, 13.0, FW_SEMIBOLD as i32, Face::Ui, MUTED, DT_CENTER);
            x += w + 10.0;
        }
    }
}

fn dashboard(g: &mut Painter, body: RECT, view: &View) {
    let Some(live) = view.live.filter(|l| view.now_ms - l.at_ms <= STALE_MS) else {
        return waiting(g, body, view);
    };
    let (s, ox, oy) = canvas_fit(body);
    g.place(s, ox, oy);
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);

    // The shift lights: a bar of segments the width of the screen, glowing when lit, flashing at the top.
    let share = if live.rpm_top > 0.0 { live.rpm / live.rpm_top } else { f32::NAN };
    let (lit, flash) = lights_lit(share);
    let blink_on = view.now_ms / 120 % 2 == 0;
    let seg_gap = 6.0;
    let seg_w = (CANVAS_W - seg_gap * (LIGHTS as f32 - 1.0)) / LIGHTS as f32;
    for i in 0..LIGHTS {
        let x = i as f32 * (seg_w + seg_gap);
        let color = match (flash, i < lit) {
            (true, _) if blink_on => BLUE,
            (true, _) => DIM,
            (false, true) => light_color(i),
            (false, false) => DIM,
        };
        if color != DIM {
            g.round(g.r(x - 3.0, -3.0, seg_w + 6.0, 28.0), 7.0, mix(BG, color, 0.22), None);
        }
        g.round(g.r(x, 0.0, seg_w, 22.0), 4.0, color, None);
    }

    // Where and what: track and car on the left, the lap on the right.
    let r = g.r(0.0, 38.0, 640.0, 26.0);
    g.text(&live.track.to_uppercase(), r, 17.0, semi, Face::Num, TEXT, DT_LEFT);
    let car = [live.car.as_str(), live.game]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("  ·  ");
    let r = g.r(0.0, 64.0, 640.0, 18.0);
    g.text(&car, r, 12.5, normal, Face::Ui, MUTED, DT_LEFT);
    let r = g.r(640.0, 36.0, 360.0, 30.0);
    g.text(
        &text(view.lang, &Msg::PanelLap(live.lap)).to_uppercase(),
        r,
        26.0,
        semi,
        Face::Num,
        ACCENT,
        DT_RIGHT,
    );
    let status = if live.in_pits {
        text(view.lang, &Msg::PanelPits)
    } else if !live.driving {
        text(view.lang, &Msg::PanelNotDriving)
    } else {
        String::new()
    };
    let r = g.r(640.0, 64.0, 360.0, 18.0);
    g.caps(&status, r, 11.0, AMBER, DT_RIGHT);
    g.fill(g.r(0.0, 92.0, CANVAS_W, 1.0), EDGE);

    // Left column: the lap's times. Right column, mirrored: fuel, revs, lap progress.
    let rows = [(100.0, 112.0, 54.0), (212.0, 96.0, 40.0), (308.0, 96.0, 40.0)];
    let fuel = if live.fuel_l.is_finite() {
        format!("{:.1} L", live.fuel_l)
    } else {
        "–".to_owned()
    };
    let rpm = if live.rpm.is_finite() {
        format!("{:.0}", live.rpm)
    } else {
        "–".to_owned()
    };
    let progress = match (live.dist_m, live.track_length_m) {
        (Some(d), Some(l)) if l > 0.0 => Some((d / l).clamp(0.0, 1.0) as f32),
        _ => None,
    };
    let lap_share = progress.map_or_else(|| "–".to_owned(), |p| format!("{:.0}%", p * 100.0));
    let left = [
        (text(view.lang, &Msg::PanelLapTime), lap_clock(live.lap_time_s), TEXT),
        (text(view.lang, &Msg::PanelLastLap), lap_clock(live.last_lap_s), TEXT),
        (text(view.lang, &Msg::PanelBestLap), lap_clock(live.best_lap_s), PURPLE),
    ];
    let right = [
        (text(view.lang, &Msg::PanelFuel), fuel, TEXT),
        ("RPM".to_owned(), rpm, TEXT),
        (text(view.lang, &Msg::PanelLapProgress), lap_share, TEXT),
    ];
    for (i, ((y, h, size), ((l_label, l_value, l_color), (r_label, r_value, r_color)))) in
        rows.iter().zip(left.iter().zip(right.iter())).enumerate()
    {
        if i > 0 {
            g.fill(g.r(0.0, *y, 300.0, 1.0), EDGE);
            g.fill(g.r(700.0, *y, 300.0, 1.0), EDGE);
        }
        let r = g.r(0.0, y + 10.0, 300.0, 18.0);
        g.caps(l_label, r, 11.0, MUTED, DT_LEFT);
        let r = g.r(-2.0, y + 28.0, 320.0, h - 34.0);
        g.text(l_value, r, *size, semi, Face::Num, *l_color, DT_LEFT);
        let r = g.r(700.0, y + 10.0, 300.0, 18.0);
        g.caps(r_label, r, 11.0, MUTED, DT_RIGHT);
        let r = g.r(680.0, y + 28.0, 322.0, h - 34.0);
        g.text(r_value, r, *size, semi, Face::Num, *r_color, DT_RIGHT);
    }
    g.round(g.r(760.0, 392.0, 240.0, 6.0), 3.0, TRACK, None);
    if let Some(p) = progress {
        g.round(g.r(760.0, 392.0, (240.0 * p).max(6.0), 6.0), 3.0, ACCENT, None);
    }

    // Centre: the delta to the best lap above the gear, the speed below it.
    let delta_color = match live.delta_s {
        Some(d) if d < 0.0 => GREEN,
        Some(_) => RED,
        None => MUTED,
    };
    let r = g.r(330.0, 100.0, 340.0, 16.0);
    g.caps(&text(view.lang, &Msg::PanelDelta), r, 10.5, MUTED, DT_CENTER);
    let r = g.r(330.0, 114.0, 340.0, 40.0);
    g.text(&delta_text(live.delta_s), r, 38.0, semi, Face::Num, delta_color, DT_CENTER);
    let bar = (350.0, 158.0, 300.0, 6.0);
    g.round(g.r(bar.0, bar.1, bar.2, bar.3), 4.0, TRACK, None);
    if let Some(d) = live.delta_s.filter(|d| d.is_finite()) {
        let reach = (d.clamp(-1.0, 1.0) as f32) * bar.2 / 2.0;
        let mid = bar.0 + bar.2 / 2.0;
        let (x, w) = if reach < 0.0 { (mid + reach, -reach) } else { (mid, reach) };
        g.round(g.r(x, bar.1, w.max(3.0), bar.3), 4.0, delta_color, None);
    }
    g.fill(g.r(bar.0 + bar.2 / 2.0 - 1.0, bar.1 - 4.0, 2.0, bar.3 + 8.0), TEXT);

    // The gear in a frame that lights up red near the limit and flashes blue when it is time to shift.
    let frame = match (flash, lit) {
        (true, _) if blink_on => BLUE,
        (true, _) => RED,
        (false, n) if n >= LIGHTS - 2 => RED,
        _ => EDGE,
    };
    g.round(g.r(352.0, 172.0, 296.0, 188.0), 20.0, frame, None);
    g.round(g.r(355.0, 175.0, 290.0, 182.0), 17.0, mix(BG, CARD, 0.75), None);
    let r = g.r(352.0, 172.0, 296.0, 188.0);
    g.text(&gear_text(live.gear), r, 168.0, semi, Face::Num, ACCENT, DT_CENTER);
    let speed = if live.speed_ms.is_finite() {
        format!("{:.0}", live.speed_ms * 3.6)
    } else {
        "–".to_owned()
    };
    let r = g.r(330.0, 364.0, 340.0, 40.0);
    g.text(&speed, r, 42.0, semi, Face::Num, TEXT, DT_CENTER);
    let r = g.r(330.0, 402.0, 340.0, 14.0);
    g.caps("km/h", r, 10.5, MUTED, DT_CENTER);

    // Bottom: brake and throttle on one bar from the centre, then the wheel; clutch on the right.
    g.fill(g.r(0.0, 424.0, CANVAS_W, 1.0), EDGE);
    let percent = |v: f32| {
        if v.is_finite() {
            format!("{:.0}%", v * 100.0)
        } else {
            "–".to_owned()
        }
    };
    let side = |g: &mut Painter, label: &str, value: String, y: f32, align: u32| {
        let x = if align == DT_RIGHT { 880.0 } else { 0.0 };
        let r = g.r(x, y, 120.0, 16.0);
        g.caps(label, r, 10.5, MUTED, align);
        let r = g.r(x, y + 15.0, 120.0, 28.0);
        g.text(&value, r, 22.0, semi, Face::Num, TEXT, align);
    };
    side(g, &text(view.lang, &Msg::PanelBrake), percent(live.brake), 432.0, DT_LEFT);
    side(g, &text(view.lang, &Msg::PanelThrottle), percent(live.throttle), 432.0, DT_RIGHT);
    let (bx, bw, by, bh) = (140.0, 720.0, 444.0, 18.0);
    let mid = bx + bw / 2.0;
    g.round(g.r(bx, by, bw, bh), 9.0, TRACK, None);
    if live.brake.is_finite() && live.brake > 0.0 {
        let w = (bw / 2.0 * live.brake.min(1.0)).max(bh);
        g.round(g.r(mid - w, by, w, bh), 9.0, RED, None);
    }
    if live.throttle.is_finite() && live.throttle > 0.0 {
        let w = (bw / 2.0 * live.throttle.min(1.0)).max(bh);
        g.round(g.r(mid, by, w, bh), 9.0, GREEN, None);
    }
    g.fill(g.r(mid - 1.0, by - 4.0, 2.0, bh + 8.0), TEXT);

    let wheel = if live.steer.is_finite() {
        let side = if live.steer < -0.005 {
            "L "
        } else if live.steer > 0.005 {
            "R "
        } else {
            ""
        };
        format!("{side}{:.0}%", live.steer.abs() * 100.0)
    } else {
        "–".to_owned()
    };
    side(g, &text(view.lang, &Msg::PanelSteer), wheel, 476.0, DT_LEFT);
    side(g, &text(view.lang, &Msg::PanelClutch), percent(live.clutch), 476.0, DT_RIGHT);
    let (ty, th) = (494.0, 6.0);
    g.round(g.r(bx, ty, bw, th), 3.0, TRACK, None);
    g.fill(g.r(mid - 1.0, ty - 5.0, 2.0, th + 10.0), MUTED);
    if live.steer.is_finite() {
        let x = mid + live.steer.clamp(-1.0, 1.0) * bw / 2.0;
        g.round(g.r(x - 16.0, ty - 5.0, 32.0, th + 10.0), 8.0, ACCENT, None);
    }
}

fn monitor(g: &mut Painter, body: RECT, view: &View) {
    let s = view.scale;
    g.place(s, body.left, body.top);
    let (w, h) = ((body.right - body.left) as f32 / s, (body.bottom - body.top) as f32 / s);
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let gap = 16.0;
    let footer = 26.0;
    let col = (w - gap) / 2.0;
    let right = col + gap;
    let area_h = h - footer;

    // Games: each reader with a status pill.
    let row_h = 38.0;
    let games_h = 54.0 + row_h * view.games.len().max(1) as f32;
    g.tile(0.0, 0.0, col, games_h, CARD);
    g.label(&text(view.lang, &Msg::PanelGames), 20.0, 16.0, col - 40.0);
    for (i, row) in view.games.iter().enumerate() {
        let y = 44.0 + row_h * i as f32;
        if i > 0 {
            g.fill(g.r(20.0, y, col - 40.0, 1.0), EDGE);
        }
        let state = state_text(view.lang, &row.state);
        let pill_w = g.width_of(&state, 12.0, semi, Face::Ui) + 22.0;
        let r = g.r(20.0, y, col - 60.0 - pill_w, row_h);
        g.text(&row.title, r, 14.5, normal, Face::Ui, TEXT, DT_LEFT);
        pill(g, col - 20.0 - pill_w, y + 7.0, pill_w, &state, state_color(&row.state));
    }

    // Account.
    let account_y = games_h + gap;
    g.tile(0.0, account_y, col, area_h - account_y, CARD);
    g.label(&text(view.lang, &Msg::PanelAccount), 20.0, account_y + 16.0, col - 40.0);
    let (cloud_word, cloud_color) = match view.snapshot.cloud {
        Cloud::Idle => ("OK", GREEN),
        Cloud::Waiting(_) => ("…", AMBER),
        Cloud::NotPaired => ("—", GREY),
        Cloud::Refused => ("!", RED),
    };
    pill(g, 20.0, account_y + 46.0, 40.0, cloud_word, cloud_color);
    let r = g.r(72.0, account_y + 42.0, col - 92.0, 30.0);
    let cloud = present::cloud_line(view.lang, &view.snapshot.cloud, view.device);
    g.text(&cloud, r, 17.0, semi, Face::Ui, TEXT, DT_LEFT);
    let r = g.r(72.0, account_y + 70.0, col - 92.0, 20.0);
    g.text(view.server, r, 12.5, normal, Face::Ui, MUTED, DT_LEFT);
    let r = g.r(20.0, account_y + 100.0, col - 40.0, 20.0);
    g.text(
        &present::game_line_of(view.lang, view.snapshot),
        r,
        12.5,
        normal,
        Face::Ui,
        MUTED,
        DT_LEFT,
    );
    if area_h - account_y > 170.0 {
        let folder = text(view.lang, &Msg::PanelLapsFolder(view.laps_dir.to_owned()));
        let r = g.r(20.0, area_h - 36.0, col - 40.0, 20.0);
        g.text(&folder, r, 12.0, normal, Face::Ui, MUTED, DT_LEFT);
    }

    // Laps saved, newest first.
    let laps_h = (area_h * 0.44).max(150.0);
    g.tile(right, 0.0, col, laps_h, CARD);
    g.label(&text(view.lang, &Msg::PanelLaps), right + 20.0, 16.0, col - 40.0);
    if view.recent_laps.is_empty() {
        let r = g.r(right + 20.0, 44.0, col - 40.0, 24.0);
        g.text(&text(view.lang, &Msg::PanelNoLaps), r, 13.5, normal, Face::Ui, MUTED, DT_LEFT);
    } else {
        let count = text(view.lang, &Msg::PanelLapsCount(view.snapshot.laps_saved));
        let r = g.r(right + 20.0, 14.0, col - 40.0, 22.0);
        g.text(&count, r, 12.0, normal, Face::Ui, MUTED, DT_RIGHT);
        let lap_row = 34.0;
        let room = ((laps_h - 52.0) / lap_row).floor().max(0.0) as usize;
        for (i, label) in view.recent_laps.iter().rev().take(room).enumerate() {
            let y = 44.0 + lap_row * i as f32;
            if i > 0 {
                g.fill(g.r(right + 20.0, y, col - 40.0, 1.0), EDGE);
            }
            let (name, time) = lap_parts(label);
            let r = g.r(right + 20.0, y, col / 2.0, lap_row);
            g.text(name, r, 14.0, normal, Face::Ui, TEXT, DT_LEFT);
            let r = g.r(right + col / 2.0, y, col / 2.0 - 20.0, lap_row);
            g.text(time, r, 18.0, semi, Face::Num, if i == 0 { ACCENT } else { TEXT }, DT_RIGHT);
        }
    }

    // The log, newest at the bottom, on alternating rows.
    let log_y = laps_h + gap;
    g.tile(right, log_y, col, area_h - log_y, CARD);
    g.label(&text(view.lang, &Msg::PanelLog), right + 20.0, log_y + 16.0, col - 40.0);
    let line_h = 21.0;
    let room = ((area_h - log_y - 56.0) / line_h).floor().max(0.0) as usize;
    let shown = &view.log[view.log.len().saturating_sub(room)..];
    for (i, (time, line)) in shown.iter().enumerate() {
        let y = log_y + 44.0 + line_h * i as f32;
        if i % 2 == 1 {
            g.fill(g.r(right + 12.0, y, col - 24.0, line_h), mix(CARD, BG, 0.45));
        }
        let r = g.r(right + 20.0, y, 70.0, line_h);
        g.text(time, r, 11.5, normal, Face::Mono, MUTED, DT_LEFT);
        let r = g.r(right + 92.0, y, col - 112.0, line_h);
        g.text(line, r, 11.5, normal, Face::Mono, TEXT, DT_LEFT);
    }

    let r = g.r(0.0, h - 20.0, w, 20.0);
    g.text(&text(view.lang, &Msg::PanelHint), r, 12.0, normal, Face::Ui, MUTED, DT_RIGHT);
}

/// A small rounded label with a tinted background.
fn pill(g: &mut Painter, x: f32, y: f32, w: f32, word: &str, color: COLORREF) {
    g.round(g.r(x, y, w, 24.0), 12.0, mix(CARD, color, 0.18), None);
    let r = g.r(x, y, w, 24.0);
    g.text(word, r, 12.0, FW_SEMIBOLD as i32, Face::Ui, color, DT_CENTER);
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
            if y > (HEADER_H * scale_of(hwnd)) as i32 {
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
        assert_eq!(&pixels[..3], &[0x0f, 0x0d, 0x0c], "the corner is the background");
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
        assert!(
            has_color(&waiting, ACCENT) < 6000,
            "no gear while waiting: only the selected tab is in the accent"
        );
    }

    #[test]
    fn the_header_can_be_clicked_where_it_is_drawn() {
        let [dash, mon, full, top] = header_hits(960, 1.0);
        assert!(inside(&dash, 20, 20) && !inside(&dash, 150, 20));
        assert!(inside(&mon, 160, 20));
        assert!(inside(&full, 700, 20) && !inside(&full, 764, 20));
        assert!(inside(&top, 900, 20) && !inside(&top, 900, 52));
        assert!(full.right < top.left && mon.right < full.left, "nothing overlaps");
        let [dash2, _, _, top2] = header_hits(1440, 1.5);
        assert_eq!((dash2.left, dash2.right), (30, 204));
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
    }

    #[test]
    fn the_dashboard_canvas_fills_the_window_and_keeps_its_shape() {
        let (s, ox, oy) = canvas_fit(rect(16, 58, 944, 584));
        assert!((s - 0.928).abs() < 0.001 && ox == 16, "{s} {ox}");
        assert_eq!(oy, 58 + ((526.0 - 520.0 * s) / 2.0).round() as i32);
        let (s, ox, _) = canvas_fit(rect(16, 58, 1904, 1064));
        assert!((s - 1.888).abs() < 0.001, "full HD: {s}");
        assert_eq!(ox, 16);
        let (s, ox, oy) = canvas_fit(rect(0, 0, 3000, 520));
        assert_eq!((s, oy), (1.0, 0), "a wide window keeps the height");
        assert_eq!(ox, 1000, "and centres the canvas");
    }

    #[test]
    fn turns_gdi_colours_into_gdiplus_colours() {
        assert_eq!(argb(rgb(0x12, 0x34, 0x56)), 0xff12_3456);
        assert_eq!(argb(ACCENT), 0xfff5_e663);
    }

    #[test]
    fn the_shift_lights_fill_up_and_flash_at_the_top() {
        assert_eq!(lights_lit(0.3), (0, false));
        assert_eq!(lights_lit(LIGHTS_FROM), (0, false));
        assert_eq!(lights_lit(0.761), (10, false));
        assert_eq!(lights_lit(0.969), (19, false));
        assert_eq!(lights_lit(0.98), (LIGHTS, true));
        assert_eq!(lights_lit(f32::NAN), (0, false));
        assert_eq!((light_color(0), light_color(7), light_color(19)), (GREEN, AMBER, RED));
        assert_eq!(mix(rgb(0, 0, 0), rgb(200, 100, 50), 0.5), rgb(100, 50, 25));
        assert_eq!(lap_parts("Lap 3  1:47.918"), ("Lap 3", "1:47.918"));
        assert_eq!(lap_parts("odd"), ("odd", ""));
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
