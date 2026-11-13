//! The Xpeed Companion window. It has two tabs:
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

use std::collections::HashSet;
use windows_sys::Win32::Foundation::POINT;
use windows_sys::Win32::Foundation::{COLORREF, FILETIME, HWND, LPARAM, LRESULT, RECT, SIZE, SYSTEMTIME, WPARAM};
use windows_sys::Win32::Graphics::Dwm::{DwmFlush, DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE};
use windows_sys::Win32::Graphics::Gdi::{
    AddFontMemResourceEx, BeginPaint, BitBlt, CreateCompatibleDC, CreateFontW, CreatePen, CreateSolidBrush, DeleteDC, DeleteObject,
    DrawTextW, EndPaint, FillRect, GetGlyphOutlineW, GetStockObject, GetTextExtentPoint32W, GetTextMetricsW, InvalidateRect, RoundRect,
    SelectObject, SetBkMode, SetTextCharacterExtra, SetTextColor, ANTIALIASED_QUALITY, CLEARTYPE_NATURAL_QUALITY, CLIP_DEFAULT_PRECIS,
    DEFAULT_CHARSET, DT_CENTER, DT_END_ELLIPSIS, DT_LEFT, DT_NOCLIP, DT_NOPREFIX, DT_RIGHT, DT_SINGLELINE, DT_TOP, DT_VCENTER, FIXED,
    FW_BOLD, FW_NORMAL, FW_SEMIBOLD, GGO_METRICS, GLYPHMETRICS, HDC, HFONT, MAT2, NULL_PEN, OUT_DEFAULT_PRECIS, PAINTSTRUCT, PS_SOLID,
    SRCCOPY, TEXTMETRICW, TRANSPARENT,
};
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows_sys::Win32::Graphics::Gdi::{IntersectClipRect, ScreenToClient, SelectClipRgn};
use windows_sys::Win32::Graphics::GdiPlus::GdipCreateBitmapFromScan0;
use windows_sys::Win32::Graphics::GdiPlus::{
    FillModeAlternate, GdipAddPathArc, GdipAddPathLine2, GdipClosePathFigure, GdipCreateBitmapFromFile, GdipCreateFromHDC,
    GdipCreateLineBrush, GdipCreatePath, GdipCreatePen1, GdipCreateSolidFill, GdipDeleteBrush, GdipDeleteGraphics, GdipDeletePath,
    GdipDeletePen, GdipDisposeImage, GdipDrawImageRectI, GdipDrawLine, GdipDrawLines, GdipDrawPath, GdipFillEllipse, GdipFillPath,
    GdipGetImageThumbnail, GdipSetInterpolationMode, GdipSetLinePresetBlend, GdipSetPenEndCap, GdipSetPenLineJoin, GdipSetPenStartCap,
    GdipSetPixelOffsetMode, GdipSetSmoothingMode, GdiplusStartup, GdiplusStartupInput, GpGraphics, GpImage, GpPath,
    InterpolationModeHighQualityBicubic, LineCapRound, LineJoinRound, PixelOffsetModeHalf, PointF, SmoothingModeAntiAlias, UnitPixel,
    WrapModeTile,
};
use windows_sys::Win32::Graphics::GdiPlus::{GdipCloneBitmapAreaI, GdipDrawImageRect, GdipFillRectangle, SmoothingModeNone};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};
use windows_sys::Win32::UI::HiDpi::{
    AdjustWindowRectExForDpi, GetDpiForWindow, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetMessageW, GetWindowLongPtrW, IsWindow, KillTimer,
    LoadCursorW, PostQuitMessage, RegisterClassW, SendMessageW, SetForegroundWindow, SetTimer, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    TranslateMessage, CREATESTRUCTW, CW_USEDEFAULT, GWLP_USERDATA, HICON, HWND_NOTOPMOST, HWND_TOPMOST, ICON_BIG, ICON_SMALL, IDC_ARROW,
    MINMAXINFO, MSG, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_RESTORE, SW_SHOWNORMAL, WM_CLOSE, WM_CREATE, WM_DESTROY,
    WM_DPICHANGED, WM_ERASEBKGND, WM_GETMINMAXINFO, WM_KEYDOWN, WM_LBUTTONDOWN, WM_NCCREATE, WM_PAINT, WM_SETICON, WM_TIMER, WNDCLASSW,
    WS_OVERLAPPEDWINDOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorPos, IsIconic, PostMessageW};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowPlacement, SetWindowPlacement, CS_DBLCLKS, GWL_STYLE, HWND_TOP, SWP_FRAMECHANGED, SWP_NOOWNERZORDER, WINDOWPLACEMENT,
    WM_LBUTTONDBLCLK,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{SetCursor, HTCLIENT, IDC_HAND, WM_SETCURSOR};
use windows_sys::Win32::UI::WindowsAndMessaging::{WM_ACTIVATE, WM_CAPTURECHANGED, WM_LBUTTONUP, WM_MOUSEWHEEL};

use crate::connect::{self, Card, Note};
use crate::dash::Live;
use crate::present;
use crate::status::{Activity, Cloud, Game, Notice, Shared, Snapshot};
use crate::text::{text, Lang, Msg};
use crate::util::{clock, now_ms};
use crate::win;

const CLASS: &str = "XpeedSimPanel";
/// `WM_MOUSELEAVE`, sent once after `TrackMouseEvent` asked for it.
const WM_MOUSELEAVE: u32 = 0x02a3;
/// Covers fetched in the background have arrived: read them again.
const WM_COVERS: u32 = 0x8000 + 20;
const WM_BRAND_DONE: u32 = 0x8000 + 21;
const WM_MOUSEMOVE: u32 = 0x0200;
const TIMER: usize = 1;
/// About 60 frames a second, so the carousel and the revs move smoothly.
const FRAME_MS: u32 = 16;
/// A reading older than this is not shown as live.
const STALE_MS: i64 = 3000;
/// Design size of the window at 96 DPI.
const WIDTH: i32 = 1180;
const HEIGHT: i32 = 640;
const MIN_WIDTH: i32 = 360;
const MIN_HEIGHT: i32 = 480;

/// The colours, as `0x00BBGGRR`. The accent is the app's `--primary` (#F5E663); purple marks the best lap, as timing
/// screens do.
const fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
    r as u32 | (g as u32) << 8 | (b as u32) << 16
}
const BG: COLORREF = rgb(0x0c, 0x0d, 0x0f);
/// The window's background runs from this at the top to that at the bottom.
const BG_TOP: COLORREF = rgb(0x14, 0x16, 0x1a);
const BG_BOTTOM: COLORREF = rgb(0x08, 0x09, 0x0b);
const CARD: COLORREF = rgb(0x16, 0x18, 0x1c);
const EDGE: COLORREF = rgb(0x25, 0x28, 0x2e);
const TRACK: COLORREF = rgb(0x27, 0x2a, 0x31);
const WHITE: COLORREF = rgb(0xff, 0xff, 0xff);
const TEXT: COLORREF = rgb(0xf2, 0xf2, 0xf3);
const MUTED: COLORREF = rgb(0x7c, 0x82, 0x8c);
const ACCENT: COLORREF = rgb(0xf5, 0xe6, 0x63);
const GREEN: COLORREF = rgb(0x2f, 0xd6, 0x7b);
const RED: COLORREF = rgb(0xff, 0x4d, 0x4d);
const BLUE: COLORREF = rgb(0x3d, 0x9b, 0xff);
/// A calm steel blue for a cold tyre or a cold brake (the loud BLUE is for the clutch and the shift flash).
const STEEL: COLORREF = rgb(0x6b, 0x95, 0xc2);
const AMBER: COLORREF = rgb(0xff, 0xb0, 0x3b);
const PURPLE: COLORREF = rgb(0xb5, 0x7c, 0xff);
const GREY: COLORREF = rgb(0x5c, 0x61, 0x6b);
/// The rev bar's base line, and its gradient from low revs to the limit.
const CYAN: COLORREF = rgb(0x26, 0xc6, 0xff);
const REV_STOPS: [(f32, COLORREF); 4] = [
    (0.0, rgb(0x57, 0xe3, 0x3a)),
    (0.55, rgb(0xe9, 0xef, 0x3c)),
    (0.8, rgb(0xff, 0x9f, 0x1c)),
    (1.0, rgb(0xff, 0x30, 0x30)),
];
const REV_DIVISIONS: usize = 10;

/// `a` with `t` (0..1) of `b` mixed in.
fn mix(a: COLORREF, b: COLORREF, t: f32) -> COLORREF {
    let channel = |shift: u32| {
        let (x, y) = ((a >> shift & 0xff) as f32, (b >> shift & 0xff) as f32);
        ((x + (y - x) * t).round() as u32) << shift
    };
    channel(0) | channel(8) | channel(16)
}

/// What a button on the panel does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Starts connecting this computer to an account (or, with a request already open, opens its page again).
    Connect,
    /// Opens the page of the open connection request again.
    OpenConnectPage,
    /// Stops waiting for the click on that page.
    CancelConnect,
    /// Opens Xpeed in the browser.
    OpenXpeed,
    /// Brings this cover of the waiting screen's carousel to the middle.
    Cover(usize),
    /// Picks this language (its place in `Lang::ALL`) from the language list.
    Lang(usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Dash,
    Monitor,
}

/// One line of the monitor's game list.
#[derive(Clone, Debug, PartialEq)]
pub struct GameRow {
    /// The game whose cover the line shows (the first of its games installed here).
    pub key: &'static str,
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
    /// What the Account card shows (not connected, waiting for the browser, connected).
    pub card: crate::connect::Card,
    pub recent_laps: &'a [String],
    /// What happened, in the person's language: `(time as HH:MM, text)`, newest first.
    pub activity: &'a [(String, String)],
    /// The games and their covers for the waiting screen; empty draws the games' names as chips instead.
    pub covers: &'a [CoverArt],
    pub brands: &'a [BrandArt],
    /// Where the mouse is over the window (pixels), for the icon buttons' tooltips.
    pub mouse: Option<(i32, i32)>,
    /// The buttons drawn in this frame and where (pixels), for the clicks that follow.
    pub buttons: std::cell::RefCell<Vec<(Action, RECT)>>,
    /// Where the covers' carousel is: the index of the cover in the middle, fractional while it slides.
    pub carousel: f32,
    /// How far the games list is scrolled (design units).
    pub games_scroll: f32,
    /// The carousel's step from one cover to the next as drawn in this frame (pixels), for dragging it.
    pub carousel_step: std::cell::Cell<f32>,
    /// The language list under the language button is open.
    pub lang_open: bool,
    /// The game that is open, when one is (its id, name and state): the waiting screen is about it, not the list.
    pub focus: Option<(&'static str, &'static str, Game)>,
    /// The games list's scroll bar as drawn in this frame, when the list is longer than its card.
    pub scroll: std::cell::Cell<Option<ScrollBar>>,
}

/// A list's scroll bar as drawn (pixels): the list, the bar's track and thumb, how far the list scrolls (design
/// units) and how many of those one pixel of the thumb's travel is.
#[derive(Clone, Copy)]
pub struct ScrollBar {
    area: RECT,
    track: RECT,
    thumb: RECT,
    max: f32,
    per_px: f32,
}

/// The account and the language as the tray knows them; the tray changes them when the computer is connected again
/// or the person picks another language.
#[derive(Clone, Debug, Default)]
pub struct Account {
    pub device: Option<String>,
    pub server: String,
    /// Who the computer is connected as (the account's email or name), when known.
    pub label: Option<String>,
    pub lang: Lang,
}

/// What the window needs from the rest of the program.
pub struct Context {
    pub shared: Arc<Shared>,
    pub account: Arc<Mutex<Account>>,
    /// The readers' lines: the title the panel shows and the game ids that report into it.
    pub readers: Vec<(String, Vec<&'static str>)>,
    pub icon_big: HICON,
    pub icon_small: HICON,
    /// Closing the window ends the message loop (the demo, which has no tray behind it).
    pub quit_on_close: bool,
}

/// A game for the waiting screen: its name, and its cover once Xpeed Companion has it from the Xpeed server (a small copy,
/// made once).
pub struct CoverArt {
    pub key: &'static str,
    pub name: &'static str,
    image: *mut GpImage,
}

/// A cached make mark, loaded once and owned by the panel (never by its paint loop).
pub struct BrandArt {
    pub brand: crate::brands::Brand,
    image: *mut GpImage,
}
impl BrandArt {
    fn load() -> Vec<Self> {
        let Some(dir) = crate::brands::folder() else { return Vec::new() };
        let body = std::fs::read_to_string(dir.join("catalog.json")).unwrap_or_default();
        crate::brands::listed(&body)
            .into_iter()
            .filter_map(|brand| {
                let path = crate::brands::file_in(&dir, &brand.key)?;
                let hash = std::fs::read_to_string(dir.join(format!("{}.sha256", brand.key))).ok()?;
                if hash.trim() != brand.sha256 {
                    return None;
                }
                let image = load_thumbnail(&path, 80, 48);
                (!image.is_null()).then_some(Self { brand, image })
            })
            .collect()
    }
}
impl Drop for BrandArt {
    fn drop(&mut self) {
        if !self.image.is_null() {
            unsafe {
                GdipDisposeImage(self.image);
            }
        }
    }
}

impl CoverArt {
    /// The covers of the games installed here (every game Xpeed Companion reads when none was found), from its covers
    /// folder, at about twice the size they are drawn.
    pub fn load(installed: Option<&HashSet<&'static str>>) -> Vec<CoverArt> {
        crate::covers::GAMES
            .iter()
            .filter(|(key, _)| installed.is_none_or(|set| set.is_empty() || set.contains(key)))
            .map(|&(key, name)| CoverArt {
                key,
                name,
                image: crate::covers::file(key).map_or(null_mut(), |file| load_thumbnail(&file, 240, 360)),
            })
            .collect()
    }
}

impl Drop for CoverArt {
    fn drop(&mut self) {
        if !self.image.is_null() {
            unsafe {
                GdipDisposeImage(self.image);
            }
        }
    }
}

/// An image file as a GDI+ image of `w` × `h` pixels; null when GDI+ or the file cannot be read.
fn load_thumbnail(file: &std::path::Path, w: u32, h: u32) -> *mut GpImage {
    if !gdiplus_ready() {
        return null_mut();
    }
    unsafe {
        let mut full = null_mut();
        let name = win::wide(&file.display().to_string());
        if GdipCreateBitmapFromFile(name.as_ptr(), &mut full) != 0 || full.is_null() {
            return null_mut();
        }
        let mut small = null_mut();
        let made = GdipGetImageThumbnail(full.cast(), w, h, &mut small, 0, null_mut()) == 0;
        GdipDisposeImage(full.cast());
        if !made {
            return null_mut();
        }
        // Kept in premultiplied 32-bit pixels, the format GDI+ draws without converting: drawing a cover took about
        // 7 ms each before, converting its pixels every time.
        let mut ready = null_mut();
        let cloned = GdipCloneBitmapAreaI(0, 0, w as i32, h as i32, PIXEL_FORMAT_32BPP_PARGB, small.cast(), &mut ready) == 0;
        if cloned && !ready.is_null() {
            GdipDisposeImage(small);
            ready.cast()
        } else {
            small
        }
    }
}

/// `PixelFormat32bppPARGB` of GDI+.
const PIXEL_FORMAT_32BPP_PARGB: i32 = 0x000e_200b;

/// The covers' carousel: it moves on by one every few seconds, or when asked, sliding there with an ease.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Carousel {
    /// The cover it is going to (counts up and down without wrapping; the drawing wraps it).
    target: i64,
    /// Where it was when it set off.
    from: f32,
    /// When it set off (Unix ms).
    since: i64,
    /// Where a mouse drag holds it, while the button is down.
    held: Option<f32>,
}

/// How long a slide takes, and how long a cover stays in the middle before the next one comes.
const SLIDE_MS: i64 = 800;
const DWELL_MS: i64 = 3500;

impl Carousel {
    fn new(now: i64) -> Carousel {
        Carousel {
            target: 0,
            from: 0.0,
            since: now,
            held: None,
        }
    }

    /// Where it is at `now`: eased in and out (gently away, gently in) from where it set off to where it is going.
    fn at(&self, now: i64) -> f32 {
        if let Some(held) = self.held {
            return held;
        }
        let t = ((now - self.since) as f32 / SLIDE_MS as f32).clamp(0.0, 1.0);
        let eased = if t < 0.5 {
            4.0 * t * t * t
        } else {
            1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
        };
        self.from + (self.target as f32 - self.from) * eased
    }

    /// One step on (or back), from wherever it is now.
    fn step(&mut self, by: i64, now: i64) {
        self.from = self.at(now);
        self.target += by;
        self.since = now;
    }

    /// Held by a drag at `at` (in covers, fractional).
    fn hold(&mut self, at: f32) {
        self.held = Some(at);
    }

    /// Let go after a drag that started at `start`: it eases onto the nearest cover, leaning the way it was dragged
    /// (a fifth of a cover is enough to go on to the next one).
    fn let_go(&mut self, start: f32, now: i64) {
        let Some(at) = self.held.take() else { return };
        let moved = at - start;
        let target = if moved > 0.2 {
            at.ceil()
        } else if moved < -0.2 {
            at.floor()
        } else {
            at.round()
        };
        self.from = at;
        self.target = target as i64;
        self.since = now;
    }

    /// Moves on by itself once a cover has had its time in the middle.
    fn tick(&mut self, now: i64) {
        if self.held.is_none() && now - self.since >= SLIDE_MS + DWELL_MS {
            self.step(1, now);
        }
    }
}

struct State {
    /// The back buffer frames are drawn into, kept for the window's size.
    buffer: Option<Backdrop>,
    /// Where the mouse is over the window, while it is.
    mouse: Option<(i32, i32)>,
    /// The buttons of the last frame, to know what a click hit.
    buttons: Vec<(Action, RECT)>,
    /// The covers' carousel on the waiting screen.
    carousel: Carousel,
    /// How far the games list is scrolled (design units), its bar in the last frame, and the thumb being dragged
    /// (where the mouse was pressed, and the scroll then).
    games_scroll: f32,
    scroll: Option<ScrollBar>,
    drag: Option<(i32, f32)>,
    /// A press on the waiting screen's carousel: where (pixels), where the carousel was, and whether it has become a
    /// drag. A press that never moved acts as a click when the button comes up.
    press: Option<(i32, i32, f32, bool)>,
    /// The carousel's step from one cover to the next (pixels), from the last frame that drew it.
    carousel_step: f32,
    /// The language list is open.
    lang_open: bool,
    ctx: Context,
    /// The games' covers, read when the window opens.
    covers: Vec<CoverArt>,
    brands: Vec<BrandArt>,
    brand_requested: Option<String>,
    brand_inflight: bool,
    brand_retry_after: i64,
    /// The games installed here, read when the window opens and each time it comes to the front.
    installed: Option<HashSet<&'static str>>,
    tab: Tab,
    on_top: bool,
    /// Full screen: where the window was and its style, to put it back.
    full: Option<(WINDOWPLACEMENT, isize)>,
}

/// The corner radius of buttons, pills and cards (design pixels): nearly square, as racing screens are.
const CORNER: f32 = 2.5;

/// Height of the header, in design pixels.
const HEADER_H: f32 = 66.0;
/// The dashboard is laid out on this canvas (design units) and scaled whole to fit the window, so it keeps its
/// proportions at any size and fills a full screen instead of stretching empty cards.
const CANVAS_W: f32 = 1000.0;
const CANVAS_H: f32 = 520.0;
/// The column on the right for the track map and the tyres, shown when the game gives them and the window is big
/// enough for the wider canvas not to shrink the rest (full screen, a large window).
const SIDE_W: f32 = 360.0;
/// The shift lights light from this share of the top RPM to `SHIFT_AT`, where they flash.
const LIGHTS_FROM: f32 = 0.55;
const SHIFT_AT: f32 = 0.97;
const LIGHTS: usize = 20;

/// The places of the header that can be clicked: the two tabs, "full screen" and "always on top" (square icon
/// buttons at the right).
fn header_hits(width: i32, scale: f32) -> [RECT; 5] {
    let p = |v: f32| (v * scale).round() as i32;
    let (top, bottom) = (p(13.0), p(51.0));
    let right = width - p(16.0);
    let (side, gap) = (p(38.0), p(8.0));
    let nth = |n: i32| rect(right - side - n * (side + gap), top, right - n * (side + gap), bottom);
    // Narrower tabs in a narrow window (a phone held upright), so they never run into the buttons.
    let tab = if (width as f32 / scale) < 560.0 { 80.0 } else { 116.0 };
    [
        rect(p(20.0), p(17.0), p(20.0 + tab), p(47.0)),
        rect(p(20.0 + tab), p(17.0), p(20.0 + 2.0 * tab), p(47.0)),
        nth(2),
        nth(1),
        nth(0),
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

/// The top edge of the rev bar at `t` (0 at the left end, 1 at the right): highest in the middle, `side` lower at
/// the ends, along a parabola.
fn dome_top(y: f32, side: f32, t: f32) -> f32 {
    let from_middle = 2.0 * t - 1.0;
    y + side * from_middle * from_middle
}

/// The part of the rev bar from `t0` to `t1` (shares of its width) as a GDI+ path: the curved top, sampled finely
/// so it stays smooth, and the flat bottom. Filled directly (no clipping, which GDI+ does by whole pixels and would
/// turn the curve into steps).
unsafe fn dome_part(x: f32, y: f32, w: f32, h: f32, side: f32, t0: f32, t1: f32) -> *mut GpPath {
    let mut path = null_mut();
    GdipCreatePath(FillModeAlternate, &mut path);
    let steps = ((t1 - t0) * 160.0).ceil().max(2.0) as usize;
    let mut points: Vec<PointF> = (0..=steps)
        .map(|i| {
            let t = t0 + (t1 - t0) * i as f32 / steps as f32;
            PointF {
                X: x + w * t,
                Y: dome_top(y, side, t),
            }
        })
        .collect();
    points.push(PointF { X: x + w * t1, Y: y + h });
    points.push(PointF { X: x + w * t0, Y: y + h });
    GdipAddPathLine2(path, points.as_ptr(), points.len() as i32);
    GdipClosePathFigure(path);
    path
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
    /// Numbers.
    Num,
    /// The small upper-case labels over the values.
    Label,
}

impl Face {
    /// The font name, the GDI weight to ask for and whether it is italic. Everything is in Chakra Petch (the owner's
    /// pick, 2026-11-12, over Bahnschrift, Racing Sans One, Russo One and Saira): numbers italic, words upright.
    fn font(self, weight: i32) -> (&'static str, i32, bool) {
        let normal = FW_NORMAL as i32;
        match self {
            Face::Ui if weight >= FW_SEMIBOLD as i32 => ("Chakra Petch SemiBold", normal, false),
            Face::Ui => ("Chakra Petch", normal, false),
            Face::Label => ("Chakra Petch SemiBold", normal, false),
            Face::Num if weight >= FW_SEMIBOLD as i32 => ("Chakra Petch", FW_BOLD as i32, true),
            Face::Num => ("Chakra Petch Medium", normal, true),
        }
    }
}

/// Chakra Petch (SIL Open Font License 1.1, `assets/fonts/OFL.txt`), carried inside the program and made known to
/// this process only, so nothing is installed and every computer draws the same.
fn register_fonts() {
    static DONE: std::sync::Once = std::sync::Once::new();
    DONE.call_once(|| {
        const FONTS: [&[u8]; 4] = [
            include_bytes!("../assets/fonts/ChakraPetch-BoldItalic.ttf"),
            include_bytes!("../assets/fonts/ChakraPetch-MediumItalic.ttf"),
            include_bytes!("../assets/fonts/ChakraPetch-SemiBold.ttf"),
            include_bytes!("../assets/fonts/ChakraPetch-Regular.ttf"),
        ];
        for font in FONTS {
            let mut added = 0u32;
            unsafe {
                // Windows writes the count through this pointer (declared const in the bindings).
                AddFontMemResourceEx(
                    font.as_ptr().cast(),
                    font.len() as u32,
                    null(),
                    std::ptr::addr_of_mut!(added).cast_const(),
                );
            }
        }
    });
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
        register_fonts();
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
        let (name, gdi_weight, italic) = face.font(weight);
        let name = win::wide(name);
        // Big text is smoothed in grey (no colour fringes on the dark background); small text keeps ClearType.
        let quality = if key.0 >= 18 {
            ANTIALIASED_QUALITY as u32
        } else {
            CLEARTYPE_NATURAL_QUALITY
        };
        let font = unsafe {
            CreateFontW(
                -key.0,
                0,
                0,
                0,
                gdi_weight,
                u32::from(italic),
                0,
                0,
                DEFAULT_CHARSET as u32,
                OUT_DEFAULT_PRECIS as u32,
                CLIP_DEFAULT_PRECIS as u32,
                quality,
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

    /// The rev bar in design units: the dome filled `share` (0..1) of the way with the green-to-red gradient,
    /// divided in tenths; all blue when `flash_on` (time to shift).
    fn rev_bar(&self, x: f32, y: f32, w: f32, h: f32, share: f32, flash_on: bool) {
        let (px, py, pw, ph) = (self.ox as f32 + x * self.s, self.oy as f32 + y * self.s, w * self.s, h * self.s);
        let fill = if share.is_finite() { share.clamp(0.0, 1.0) } else { 0.0 };
        let line_w = (2.0 * self.s).max(1.5);
        let side = ph * 0.45;
        let drawn = smooth(self.hdc, |graphics| unsafe {
            let whole = dome_part(px, py, pw, ph, side, 0.0, 1.0);
            let mut brush = null_mut();
            GdipCreateSolidFill(argb(if flash_on { BLUE } else { TRACK }), &mut brush);
            GdipFillPath(graphics, brush.cast(), whole);
            GdipDeleteBrush(brush.cast());
            GdipDeletePath(whole);
            if !flash_on && fill > 0.0 {
                let lit = dome_part(px, py, pw, ph, side, 0.0, fill);
                let (from, to) = (PointF { X: px, Y: py }, PointF { X: px + pw, Y: py });
                let mut gradient = null_mut();
                GdipCreateLineBrush(&from, &to, argb(REV_STOPS[0].1), argb(REV_STOPS[3].1), WrapModeTile, &mut gradient);
                let colors = REV_STOPS.map(|(_, c)| argb(c));
                let places = REV_STOPS.map(|(at, _)| at);
                GdipSetLinePresetBlend(gradient, colors.as_ptr(), places.as_ptr(), colors.len() as i32);
                GdipFillPath(graphics, gradient.cast(), lit);
                GdipDeleteBrush(gradient.cast());
                GdipDeletePath(lit);
            }
            // The divisions, cut in the background colour from the curve down.
            let mut pen = null_mut();
            GdipCreatePen1(argb(BG), line_w, UnitPixel, &mut pen);
            for i in 1..REV_DIVISIONS {
                let t = i as f32 / REV_DIVISIONS as f32;
                let lx = px + pw * t;
                GdipDrawLine(graphics, pen, lx, dome_top(py, side, t) - 2.0, lx, py + ph);
            }
            GdipDeletePen(pen);
        });
        if !drawn {
            self.fill(self.r(x, y + h * 0.45, w, h * 0.55), TRACK);
            self.fill(self.r(x, y + h * 0.45, w * fill, h * 0.55), if flash_on { BLUE } else { GREEN });
        }
    }

    /// The track in a box (design units): the path smoothed, turned so its long side follows the box's, and scaled to
    /// fit with a margin, drawn as a dark ribbon with a lighter line on top. A whole lap is a closed shape with a
    /// start/finish tick; a partial path is open, and is not drawn across a jump. The car is a yellow dot, placed
    /// with the same transform.
    fn track_map(&self, (x, y, w, h): (f32, f32, f32, f32), path: &[(f32, f32)], complete: bool, car: Option<(f32, f32)>) {
        let key = MapKey {
            at: path.as_ptr() as usize,
            len: path.len(),
            ends: path
                .first()
                .zip(path.last())
                .map(|(a, b)| [a.0.to_bits(), a.1.to_bits(), b.0.to_bits(), b.1.to_bits()]),
            frame: [x, y, w, h].map(f32::to_bits),
            complete,
        };
        let prepared = MAP_CACHE.with(|cell| {
            let mut kept = cell.borrow_mut();
            if kept.as_ref().is_none_or(|(k, _)| *k != key) {
                *kept = prepare_map(path, complete, x + w / 2.0, y + h / 2.0, w, h).map(|p| (key, p));
            }
            kept.as_ref().map(|(_, p)| p.clone())
        });
        let Some(map) = prepared else {
            return;
        };
        let to_px = |(px, py): (f32, f32)| PointF {
            X: self.ox as f32 + px * self.s,
            Y: self.oy as f32 + py * self.s,
        };
        let road = (11.0 * self.s).max(3.0);
        let line = (2.5 * self.s).max(1.0);
        smooth(self.hdc, |graphics| unsafe {
            for (width, color) in [(road, TRACK), (line, mix(TRACK, TEXT, 0.5))] {
                let mut pen = null_mut();
                GdipCreatePen1(argb(color), width, UnitPixel, &mut pen);
                GdipSetPenLineJoin(pen, LineJoinRound);
                GdipSetPenStartCap(pen, LineCapRound);
                GdipSetPenEndCap(pen, LineCapRound);
                for run in &map.runs {
                    let points: Vec<PointF> = run.iter().map(|&p| to_px(p)).collect();
                    GdipDrawLines(graphics, pen, points.as_ptr(), points.len() as i32);
                }
                GdipDeletePen(pen);
            }
            if let Some((a, b)) = map.start {
                let mut pen = null_mut();
                GdipCreatePen1(argb(TEXT), (2.5 * self.s).max(1.5), UnitPixel, &mut pen);
                let (a, b) = (to_px(a), to_px(b));
                GdipDrawLine(graphics, pen, a.X, a.Y, b.X, b.Y);
                GdipDeletePen(pen);
            }
            if let Some(car) = car {
                let at = to_px(map.fit.apply(car));
                for (radius, color) in [(13.0, mix(BG, ACCENT, 0.3)), (7.0, ACCENT)] {
                    let mut brush = null_mut();
                    GdipCreateSolidFill(argb(color), &mut brush);
                    let d = radius * 2.0 * self.s;
                    GdipFillEllipse(graphics, brush.cast(), at.X - d / 2.0, at.Y - d / 2.0, d, d);
                    GdipDeleteBrush(brush.cast());
                }
            }
        });
    }

    /// The window's background: a light gradient from top to bottom, with very fine diagonal lines over it.
    ///
    /// It is drawn once for each window size and kept: a frame copies it (drawing its hundreds of lines every frame
    /// took most of a frame's time).
    fn backdrop(&self, w: i32, h: i32) {
        let key = (w, h, self.px(7.0));
        BACKDROP.with(|cell| {
            let mut kept = cell.borrow_mut();
            if kept.as_ref().is_none_or(|b| b.key != key) {
                *kept = Some(Backdrop::new(self.hdc, key, |dc| draw_backdrop(dc, w, h, (7.0 * self.s).max(5.0))));
            }
            if let Some(b) = kept.as_ref() {
                unsafe {
                    BitBlt(self.hdc, 0, 0, w, h, b.dc, 0, 0, SRCCOPY);
                }
            }
        });
    }
}

/// What a prepared map was made from: the map's data (its address, length and ends) and the box, so it is made again
/// only when one of them changes.
#[derive(Clone, PartialEq)]
struct MapKey {
    at: usize,
    len: usize,
    ends: Option<[u32; 4]>,
    frame: [u32; 4],
    complete: bool,
}

/// A map ready to draw, in design units: the runs to draw, the start mark, and how the world is laid in the box.
#[derive(Clone)]
struct PreparedMap {
    runs: Vec<Vec<(f32, f32)>>,
    start: Option<((f32, f32), (f32, f32))>,
    fit: crate::maps::Fit,
}

/// Cuts the path at jumps, smooths it, fits it in the box (`cx`, `cy`, `w`, `h`) and finds the start mark of a whole
/// lap. Done once per map and box, not at every redraw.
fn prepare_map(path: &[(f32, f32)], complete: bool, cx: f32, cy: f32, w: f32, h: f32) -> Option<PreparedMap> {
    let mut runs = crate::maps::split_at_gaps(path, crate::dash::MAP_JUMP_METRES);
    if runs.is_empty() {
        return None;
    }
    // A whole lap closes on itself (when it came with its first point repeated, that is dropped first).
    let closed = complete && runs.len() == 1;
    if closed && runs[0].len() > 3 && runs[0].first() == runs[0].last() {
        runs[0].pop();
    }
    let mut runs: Vec<Vec<(f32, f32)>> = runs.iter().map(|r| crate::maps::smooth(r, 3, closed)).collect();
    if closed {
        let first = runs[0][0];
        runs[0].push(first);
    }
    let all: Vec<(f32, f32)> = runs.iter().flatten().copied().collect();
    let fit = crate::maps::fit(&all, cx, cy, w, h, 18.0)?;
    let runs: Vec<Vec<(f32, f32)>> = runs.iter().map(|r| r.iter().map(|&p| fit.apply(p)).collect()).collect();
    // The start/finish mark: a tick across the road at the first point, square to the way the lap leaves it.
    let start = closed
        .then(|| {
            let run = &runs[0];
            let (a, b) = (run[0], *run.get(3).unwrap_or(&run[run.len() - 1]));
            let (dx, dy) = (b.0 - a.0, b.1 - a.1);
            let len = dx.hypot(dy);
            (len > 0.0).then(|| {
                (
                    (a.0 - dy / len * 9.0, a.1 + dx / len * 9.0),
                    (a.0 + dy / len * 9.0, a.1 - dx / len * 9.0),
                )
            })
        })
        .flatten();
    Some(PreparedMap { runs, start, fit })
}

thread_local! {
    /// The map as last prepared, for its box; one per thread (the window's, and each test's).
    static MAP_CACHE: std::cell::RefCell<Option<(MapKey, PreparedMap)>> = const { std::cell::RefCell::new(None) };
    /// The background as last drawn, for the window's size; one per thread (the window's, and each test's).
    static BACKDROP: std::cell::RefCell<Option<Backdrop>> = const { std::cell::RefCell::new(None) };
}

/// A 32-bit bitmap in plain memory (a DIB): GDI+ draws into it directly, much faster than into a device bitmap.
unsafe fn dib(hdc: HDC, w: i32, h: i32) -> windows_sys::Win32::Graphics::Gdi::HBITMAP {
    use windows_sys::Win32::Graphics::Gdi::{CreateDIBSection, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS};
    let mut info: BITMAPINFO = std::mem::zeroed();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w.max(1),
        biHeight: -h.max(1),
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        ..std::mem::zeroed()
    };
    let mut bits = null_mut();
    CreateDIBSection(hdc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0)
}

/// A drawn background kept in a memory bitmap.
struct Backdrop {
    key: (i32, i32, i32),
    dc: HDC,
    bitmap: windows_sys::Win32::Graphics::Gdi::HBITMAP,
    old: windows_sys::Win32::Graphics::Gdi::HGDIOBJ,
}

impl Backdrop {
    fn new(like: HDC, key: (i32, i32, i32), draw: impl FnOnce(HDC)) -> Backdrop {
        unsafe {
            let dc = CreateCompatibleDC(like);
            let bitmap = dib(dc, key.0, key.1);
            let old = SelectObject(dc, bitmap);
            draw(dc);
            Backdrop { key, dc, bitmap, old }
        }
    }
}

impl Drop for Backdrop {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            DeleteObject(self.bitmap);
            DeleteDC(self.dc);
        }
    }
}

/// The background itself: a light gradient from top to bottom with very fine diagonal lines over it.
fn draw_backdrop(hdc: HDC, w: i32, h: i32, step: f32) {
    let (fw, fh) = (w as f32, h as f32);
    let drawn = smooth(hdc, |graphics| unsafe {
        let (from, to) = (PointF { X: 0.0, Y: -1.0 }, PointF { X: 0.0, Y: fh + 1.0 });
        let mut gradient = null_mut();
        GdipCreateLineBrush(&from, &to, argb(BG_TOP), argb(BG_BOTTOM), WrapModeTile, &mut gradient);
        GdipFillRectangle(graphics, gradient.cast(), 0.0, 0.0, fw, fh);
        GdipDeleteBrush(gradient.cast());
        // Hairlines one pixel wide, crisp (no smoothing), white at a few per cent.
        GdipSetSmoothingMode(graphics, SmoothingModeNone);
        let mut pen = null_mut();
        GdipCreatePen1(0x09ff_ffff, 1.0, UnitPixel, &mut pen);
        let mut x = -fh;
        while x < fw {
            GdipDrawLine(graphics, pen, x, fh, x + fh, 0.0);
            x += step;
        }
        GdipDeletePen(pen);
    });
    if !drawn {
        unsafe {
            let brush = CreateSolidBrush(BG);
            FillRect(hdc, &rect(0, 0, w, h), brush);
            DeleteObject(brush);
        }
    }
}

impl Painter {
    /// A cover for a game Steam has no art for here: a dark card with two yellow racing stripes across its top
    /// corner and the game's name in the racing font. Xpeed's own design, not the game's art.
    fn cover_card(&mut self, (x, y, w, h): (f32, f32, f32, f32), name: &str, scale: f32) {
        let k = h * 0.36 / (w * 0.48);
        smooth(self.hdc, |graphics| unsafe {
            let fill = |color: COLORREF, points: &[PointF]| {
                let mut path = null_mut();
                GdipCreatePath(FillModeAlternate, &mut path);
                GdipAddPathLine2(path, points.as_ptr(), points.len() as i32);
                GdipClosePathFigure(path);
                let mut brush = null_mut();
                GdipCreateSolidFill(argb(color), &mut brush);
                GdipFillPath(graphics, brush.cast(), path);
                GdipDeleteBrush(brush.cast());
                GdipDeletePath(path);
            };
            let pt = |px: f32, py: f32| PointF { X: px, Y: py };
            fill(mix(BG, CARD, 0.8), &[pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)]);
            // Two stripes parallel to the corner's edge: a wide one at the corner, a thin one beside it.
            fill(ACCENT, &[pt(x + w * 0.52, y), pt(x + w, y), pt(x + w, y + w * 0.48 * k)]);
            let (a, b) = (0.36, 0.44);
            fill(
                ACCENT,
                &[
                    pt(x + w * a, y),
                    pt(x + w * b, y),
                    pt(x + w, y + w * (1.0 - b) * k),
                    pt(x + w, y + w * (1.0 - a) * k),
                ],
            );
        });
        // The name, upper case, one word a line, in the middle.
        let words: Vec<String> = name.split_whitespace().map(str::to_uppercase).collect();
        let size = 22.0 * scale;
        let line = size * 1.1 * self.s;
        let top = y + h * 0.58 - line * words.len() as f32 / 2.0;
        for (i, word) in words.iter().enumerate() {
            let ly = top + line * i as f32;
            let r = rect(x as i32, ly as i32, (x + w) as i32, (ly + line) as i32);
            self.text(word, r, size, FW_SEMIBOLD as i32, Face::Num, TEXT, DT_CENTER);
        }
        self.fill(
            rect(x as i32, (y + h) as i32 - self.px(3.0), (x + w) as i32, (y + h) as i32),
            ACCENT,
        );
    }

    /// A box in design units as exact pixels (x, y, w, h), not rounded.
    fn exact(&self, x: f32, y: f32, w: f32, h: f32) -> (f32, f32, f32, f32) {
        (self.ox as f32 + x * self.s, self.oy as f32 + y * self.s, w * self.s, h * self.s)
    }

    /// An image in an exact box. The carousel draws several every frame, so the settings are the fastest that still
    /// look right, as measured (`frame_times`): high-quality bilinear without the half-pixel offset took 1.4 ms a
    /// cover at full HD, against 4.9 ms for plain bilinear and 7 ms for bicubic with the offset.
    fn image_exact(&self, (x, y, w, h): (f32, f32, f32, f32), image: *mut GpImage) {
        use windows_sys::Win32::Graphics::GdiPlus::{InterpolationModeHighQualityBilinear, PixelOffsetModeNone};
        smooth(self.hdc, |graphics| unsafe {
            GdipSetInterpolationMode(graphics, InterpolationModeHighQualityBilinear);
            GdipSetPixelOffsetMode(graphics, PixelOffsetModeNone);
            GdipDrawImageRect(graphics, image, x, y, w, h);
        });
    }

    /// A colour over an exact box with `amount` (0..1) of opacity: the shade over a cover drawn by `image_exact`. It
    /// uses the same pixel offset as the cover and reaches half a pixel past it on every side, so no edge of the cover
    /// is left unshaded (a lighter line showed at the right edge when the two were half a pixel apart).
    fn veil_exact(&self, (x, y, w, h): (f32, f32, f32, f32), color: COLORREF, amount: f32) {
        use windows_sys::Win32::Graphics::GdiPlus::PixelOffsetModeNone;
        let alpha = ((amount.clamp(0.0, 1.0) * 255.0).round() as u32) << 24;
        smooth(self.hdc, |graphics| unsafe {
            GdipSetPixelOffsetMode(graphics, PixelOffsetModeNone);
            let mut brush = null_mut();
            GdipCreateSolidFill(alpha | (argb(color) & 0x00ff_ffff), &mut brush);
            GdipFillRectangle(graphics, brush.cast(), x - 0.5, y - 0.5, w + 1.0, h + 1.0);
            GdipDeleteBrush(brush.cast());
        });
    }

    /// An image filling a box (pixels), smoothly scaled.
    /// The lines `s` breaks into to fit `w` design units at this size (words kept whole).
    fn wrap_lines(&mut self, s: &str, w: f32, size: f32, weight: i32, face: Face) -> Vec<String> {
        let mut lines: Vec<String> = Vec::new();
        for word in s.split_whitespace() {
            let longer = lines.last().map(|line| format!("{line} {word}"));
            match (lines.last_mut(), longer) {
                (Some(line), Some(longer)) if self.width_of(&longer, size, weight, face) <= w => *line = longer,
                _ => lines.push(word.to_owned()),
            }
        }
        lines
    }

    /// Text in as many lines as it needs to fit `w` design units, `line_h` apart, from `y` down; the height used.
    #[allow(clippy::too_many_arguments)]
    fn wrapped(
        &mut self,
        s: &str,
        x: f32,
        y: f32,
        w: f32,
        size: f32,
        weight: i32,
        face: Face,
        color: COLORREF,
        align: u32,
        line_h: f32,
    ) -> f32 {
        let lines = self.wrap_lines(s, w, size, weight, face);
        for (i, line) in lines.iter().enumerate() {
            let r = self.r(x, y + line_h * i as f32, w, line_h);
            self.text(line, r, size, weight, face, color, align);
        }
        line_h * lines.len() as f32
    }

    /// Draws only inside `r` until `unclip` (GDI and GDI+ both keep to it).
    fn clip(&self, r: RECT) {
        unsafe {
            IntersectClipRect(self.hdc, r.left, r.top, r.right, r.bottom);
        }
    }

    fn unclip(&self) {
        unsafe {
            SelectClipRgn(self.hdc, null_mut());
        }
    }

    fn image(&self, r: RECT, image: *mut GpImage) {
        smooth(self.hdc, |graphics| unsafe {
            GdipSetInterpolationMode(graphics, InterpolationModeHighQualityBicubic);
            GdipDrawImageRectI(graphics, image, r.left, r.top, r.right - r.left, r.bottom - r.top);
        });
    }

    /// A tall slim bar (a pedal): a rounded trough with the fill rising from the bottom to `value` (0..1; NaN counts
    /// as released).
    fn vertical_bar(&self, (x, y, w, h): Area, value: f32, color: COLORREF) {
        self.round(self.r(x, y, w, h), w / 2.0, TRACK, None);
        let filled = pedal_fill(value, h);
        if filled >= 1.0 {
            self.round(self.r(x, y + h - filled, w, filled), (w / 2.0).min(filled / 2.0), color, None);
        }
    }

    /// The wheel as a slim bar: a trough with a tick at the centre and a yellow fill from the centre toward the side
    /// the wheel is turned to (-1 full left .. 1 full right; none without a value).
    fn steer_bar(&self, (x, y, w, h): Area, steer: f32) {
        self.round(self.r(x, y, w, h), h / 2.0, TRACK, None);
        let share = steer_share(steer);
        let (half, len) = (w / 2.0, w / 2.0 * share.abs());
        if len >= 1.0 {
            let fx = if share > 0.0 { x + half } else { x + half - len };
            self.round(self.r(fx, y, len, h), (h / 2.0).min(len / 2.0), ACCENT, None);
        }
        let tick = if steer.is_finite() { TEXT } else { MUTED };
        self.fill(self.r(x + half - 1.0, y - 3.0, 2.0, h + 6.0), tick);
    }

    /// One light of the lights card, in a pill of `cell`: lit in its colour, off as a dim outline, or (DRS allowed, not
    /// open) outlined in its colour. Headlights are a small lamp, the flag a swatch of its colour.
    fn pill(&mut self, lang: Lang, pill: Pill, (x, y, w, h): Area) {
        let color = pill_color(pill.kind);
        let dim = mix(CARD, MUTED, 0.55);
        let (fill, edge, ink) = match pill.glow {
            Glow::On => (color, None, BG),
            Glow::Ready => (CARD, Some(color), color),
            Glow::Off => (CARD, Some(mix(CARD, MUTED, 0.3)), dim),
        };
        self.round(self.r(x, y, w, h), h / 2.0, fill, edge);
        let r = self.r(x, y + 1.0, w, h - 1.0);
        let label = match pill.kind {
            PillKind::Pit => Some("PIT".to_owned()),
            PillKind::Abs => Some("ABS".to_owned()),
            PillKind::Tc => Some("TC".to_owned()),
            PillKind::Drs => Some("DRS".to_owned()),
            PillKind::Fuel => Some(text(lang, &Msg::PanelLightFuel)),
            PillKind::Engine => Some(text(lang, &Msg::PanelLightEngine)),
            PillKind::Handbrake => Some(text(lang, &Msg::PanelLightHandbrake)),
            PillKind::Flag => None,
            PillKind::Headlights => None,
        };
        match (pill.kind, label) {
            (PillKind::Headlights, _) => self.headlamp(x + w / 2.0, y + h / 2.0, 11.0, ink),
            (PillKind::Flag, _) => {
                let sw = h - 8.0;
                self.flag_swatch(x + 6.0, y + 4.0, sw, pill.flag);
                let label = text(lang, &Msg::PanelFlag);
                let r = self.r(x + 6.0 + sw + 4.0, y + 1.0, w - sw - 14.0, h - 1.0);
                self.caps(&label, r, 8.5, mix(CARD, MUTED, 0.75), DT_LEFT);
            }
            (_, Some(label)) => self.caps(&label, r, 9.0, ink, DT_CENTER),
            _ => {}
        }
    }

    /// The flag's colour as a small square at (`x`, `y`): green, yellow, blue, white, black with a light edge, or
    /// chequered.
    fn flag_swatch(&self, x: f32, y: f32, size: f32, flag: Option<crate::game::Flag>) {
        use crate::game::Flag;
        let Some(flag) = flag else { return };
        let radius = 1.5;
        match flag {
            Flag::Green => self.round(self.r(x, y, size, size), radius, GREEN, None),
            Flag::Yellow => self.round(self.r(x, y, size, size), radius, ACCENT, None),
            Flag::Blue => self.round(self.r(x, y, size, size), radius, BLUE, None),
            Flag::White => self.round(self.r(x, y, size, size), radius, WHITE, None),
            Flag::Black => self.round(self.r(x, y, size, size), radius, rgb(0x05, 0x05, 0x06), Some(MUTED)),
            Flag::Chequered => {
                self.round(self.r(x, y, size, size), radius, WHITE, None);
                let q = size / 2.0;
                self.fill(self.r(x, y, q, q), rgb(0x10, 0x10, 0x12));
                self.fill(self.r(x + q, y + q, q, q), rgb(0x10, 0x10, 0x12));
            }
        }
    }

    /// A small headlamp glyph centred at (`cx`, `cy`), `size` design units across: a lamp with three rays.
    fn headlamp(&self, cx: f32, cy: f32, size: f32, color: COLORREF) {
        let to_px = |x: f32, y: f32| (self.ox as f32 + x * self.s, self.oy as f32 + y * self.s);
        smooth(self.hdc, |graphics| unsafe {
            let (lx, ly) = to_px(cx - size * 0.5, cy - size * 0.36);
            let (lw, lh) = (size * 0.5 * self.s, size * 0.72 * self.s);
            let mut brush = null_mut();
            GdipCreateSolidFill(argb(color), &mut brush);
            GdipFillEllipse(graphics, brush.cast(), lx, ly, lw, lh);
            GdipDeleteBrush(brush.cast());
            let mut pen = null_mut();
            GdipCreatePen1(argb(color), (1.4 * self.s).max(1.0), UnitPixel, &mut pen);
            GdipSetPenStartCap(pen, LineCapRound);
            GdipSetPenEndCap(pen, LineCapRound);
            for k in [-1.0_f32, 0.0, 1.0] {
                let (ax, ay) = to_px(cx + size * 0.18, cy + k * size * 0.3);
                let (bx, by) = to_px(cx + size * 0.5, cy + k * size * 0.42);
                GdipDrawLine(graphics, pen, ax, ay, bx, by);
            }
            GdipDeletePen(pen);
        });
    }

    /// A brake disc glyph centred at (`cx`, `cy`), `d` design units across: a disc with a hole and a hub.
    fn brake_disc(&self, cx: f32, cy: f32, d: f32, color: COLORREF) {
        let to_px = |x: f32, y: f32| (self.ox as f32 + x * self.s, self.oy as f32 + y * self.s);
        smooth(self.hdc, |graphics| unsafe {
            for (size, c) in [(d, color), (d * 0.5, BG), (d * 0.2, color)] {
                let (x, y) = to_px(cx - size / 2.0, cy - size / 2.0);
                let mut brush = null_mut();
                GdipCreateSolidFill(argb(c), &mut brush);
                GdipFillEllipse(graphics, brush.cast(), x, y, size * self.s, size * self.s);
                GdipDeleteBrush(brush.cast());
            }
        });
    }

    /// The car's silhouette from above in `area`: a rounded body tapering to the nose, a cockpit opening, a wing at
    /// each end, all in a colour barely lighter than the background.
    fn car_body(&self, area: Area) {
        let (x, y, w, h) = area;
        if w < 4.0 || h < 4.0 {
            return;
        }
        let body = mix(BG, MUTED, 0.14);
        let points: Vec<PointF> = body_outline(area)
            .into_iter()
            .map(|(px, py)| PointF {
                X: self.ox as f32 + px * self.s,
                Y: self.oy as f32 + py * self.s,
            })
            .collect();
        smooth(self.hdc, |graphics| unsafe {
            let mut path = null_mut();
            GdipCreatePath(FillModeAlternate, &mut path);
            GdipAddPathLine2(path, points.as_ptr(), points.len() as i32);
            GdipClosePathFigure(path);
            let mut brush = null_mut();
            GdipCreateSolidFill(argb(body), &mut brush);
            GdipFillPath(graphics, brush.cast(), path);
            GdipDeleteBrush(brush.cast());
            GdipDeletePath(path);
        });
        let cx = x + w / 2.0;
        // The wings across the two ends, the cockpit in the middle.
        let wing = mix(BG, MUTED, 0.22);
        self.round(self.r(cx - w * 0.36, y, w * 0.72, (h * 0.03).max(3.0)), 1.5, wing, None);
        self.round(
            self.r(cx - w * 0.4, y + h - (h * 0.035).max(3.0), w * 0.8, (h * 0.035).max(3.0)),
            1.5,
            wing,
            None,
        );
        self.round(
            self.r(cx - w * 0.17, y + h * 0.38, w * 0.34, h * 0.24),
            w * 0.15,
            mix(BG, MUTED, 0.04),
            None,
        );
    }

    /// A bar of `count` small blocks in design units; a block is lit (in `color`) when its middle falls between
    /// `from` and `to` (shares of the bar's width), dark otherwise.
    #[allow(clippy::too_many_arguments)]
    fn blocks(&self, x: f32, y: f32, w: f32, h: f32, count: usize, from: f32, to: f32, color: COLORREF) {
        // Square blocks a hair apart, laid out in whole pixels so every gap is the same.
        let area = self.r(x, y, w, h);
        let gap = (1.5 * self.s).round().max(1.0);
        let block = ((area.right - area.left) as f32 - gap * (count as f32 - 1.0)) / count as f32;
        for i in 0..count {
            let middle = (i as f32 + 0.5) / count as f32;
            let lit = from.is_finite() && to.is_finite() && middle >= from && middle <= to;
            let left = area.left + (i as f32 * (block + gap)).round() as i32;
            let right = area.left + (i as f32 * (block + gap) + block).round() as i32;
            self.fill(
                rect(left, area.top, right.max(left + 1), area.bottom),
                if lit { color } else { TRACK },
            );
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
        if face == Face::Num {
            return self.tabular(s, r, font, color, align);
        }
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

    /// Numbers with every digit in a slot as wide as the widest digit, so a running time does not shift sideways as
    /// its digits change (the fonts' own digits are proportional, and GDI cannot ask for their tabular ones).
    ///
    /// They are centred on their own height (the capital height), not on the font's line, which also holds room
    /// for descenders and would leave figures sitting high in their box.
    fn tabular(&mut self, s: &str, r: RECT, font: HFONT, color: COLORREF, align: u32) {
        unsafe {
            let old = SelectObject(self.hdc, font);
            SetTextColor(self.hdc, color);
            let width = |c: char| {
                let mut unit = [0u16; 2];
                let unit = c.encode_utf16(&mut unit);
                let mut extent = SIZE { cx: 0, cy: 0 };
                GetTextExtentPoint32W(self.hdc, unit.as_ptr(), unit.len() as i32, &mut extent);
                extent.cx
            };
            let digit = ('0'..='9').map(width).max().unwrap_or(0);
            // The real ink of the letters and figures (not dots, colons or signs): how far above and below the
            // baseline it reaches. The text is placed so that ink is centred in the box.
            let identity = MAT2 {
                eM11: FIXED { fract: 0, value: 1 },
                eM12: FIXED { fract: 0, value: 0 },
                eM21: FIXED { fract: 0, value: 0 },
                eM22: FIXED { fract: 0, value: 1 },
            };
            let mut ink: Option<(i32, i32)> = None;
            for c in s.chars().filter(|c| c.is_alphanumeric()) {
                let mut glyph: GLYPHMETRICS = std::mem::zeroed();
                if GetGlyphOutlineW(self.hdc, c as u32, GGO_METRICS, &mut glyph, 0, null_mut(), &identity) == u32::MAX {
                    continue;
                }
                let above = glyph.gmptGlyphOrigin.y;
                let below = above - glyph.gmBlackBoxY as i32;
                ink = Some(ink.map_or((above, below), |(a, b)| (a.max(above), b.min(below))));
            }
            let mut metrics: TEXTMETRICW = std::mem::zeroed();
            let have_metrics = GetTextMetricsW(self.hdc, &mut metrics) != 0;
            let (vertical, top, line) = match ink {
                Some((above, below)) if have_metrics => {
                    let baseline = (r.top + r.bottom) / 2 + (above + below) / 2;
                    (DT_TOP, baseline - metrics.tmAscent, metrics.tmHeight)
                }
                _ => (DT_VCENTER, r.top, r.bottom - r.top),
            };
            let slots: Vec<(char, i32)> = s.chars().map(|c| (c, if c.is_ascii_digit() { digit } else { width(c) })).collect();
            let total: i32 = slots.iter().map(|(_, w)| w).sum();
            let mut x = if align == DT_RIGHT {
                r.right - total
            } else if align == DT_CENTER {
                (r.left + r.right - total) / 2
            } else {
                r.left
            };
            for (c, w) in slots {
                let mut unit = [0u16; 2];
                let unit = c.encode_utf16(&mut unit);
                let mut cell = if vertical == DT_TOP {
                    rect(x, top, x + w, top + line)
                } else {
                    rect(x, r.top, x + w, r.bottom)
                };
                DrawTextW(
                    self.hdc,
                    unit.as_ptr(),
                    unit.len() as i32,
                    &mut cell,
                    DT_CENTER | DT_SINGLELINE | vertical | DT_NOPREFIX | DT_NOCLIP,
                );
                x += w;
            }
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

    /// The font size, from `size` down to `floor`, at which `s` fits in `room` design units; never above `size`.
    fn fitted(&mut self, s: &str, room: f32, size: f32, floor: f32, weight: i32, face: Face) -> f32 {
        let mut fit = fit_size(self.width_of(s, size, weight, face), size, room, floor);
        // Glyph widths round to whole pixels, so one more look at the result, and a step down while it still runs out.
        for _ in 0..3 {
            if fit <= floor || self.width_of(s, fit, weight, face) <= room {
                break;
            }
            fit = (fit * 0.95).max(floor);
        }
        fit
    }

    /// The mark of a lap that does not count: a red square with a white "!", `size` design units on a side.
    fn invalid_mark(&self, x: f32, y: f32, size: f32) {
        self.round(self.r(x, y, size, size), size * 0.22, RED, None);
        let (bar, cx) = ((size * 0.14).max(1.0), x + size / 2.0);
        self.fill(self.r(cx - bar / 2.0, y + size * 0.2, bar, size * 0.38), WHITE);
        self.fill(self.r(cx - bar / 2.0, y + size * 0.68, bar, size * 0.14), WHITE);
    }

    /// A tile: the card colour with its border.
    fn tile(&self, x: f32, y: f32, w: f32, h: f32, color: COLORREF) {
        self.round(self.r(x, y, w, h), CORNER, color, Some(EDGE));
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
        // Chakra Petch's capitals are small for their size: drawn a little bigger to read like the old labels.
        let size = size * 1.18;
        let width = (self.width_of(&upper, size, FW_SEMIBOLD as i32, Face::Label) * self.s).round() as i32 - extra;
        let left = if align == DT_RIGHT {
            r.right - width
        } else if align == DT_CENTER {
            (r.left + r.right - width) / 2
        } else {
            r.left
        };
        let placed = rect(left.max(r.left), r.top, left + width + extra + self.px(4.0), r.bottom);
        self.text(&upper, placed, size, FW_SEMIBOLD as i32, Face::Label, color, DT_LEFT);
        unsafe {
            SetTextCharacterExtra(self.hdc, 0);
        }
    }

    /// The small upper-case label at the top left of a tile.
    fn label(&mut self, s: &str, x: f32, y: f32, w: f32) {
        let r = self.r(x, y, w, 18.0);
        self.caps(s, r, 11.0, MUTED, DT_LEFT);
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

/// The gears either side of `gear` (R, N, 1, 2, ...): the one below and the one above. There is nothing below
/// reverse, and nothing above the top gear when the car's forward gear count (`gears`) is known; when it is not, there
/// is always one above a forward gear.
fn neighbour_gears(gear: f32, gears: Option<u8>) -> (Option<String>, Option<String>) {
    if !gear.is_finite() {
        return (None, None);
    }
    let g = gear.round() as i32;
    let below = (g > -1).then(|| gear_text((g - 1) as f32));
    let in_top_gear = g >= 1 && gears.is_some_and(|count| g >= i32::from(count));
    let above = (!in_top_gear).then(|| gear_text((g + 1) as f32));
    (below, above)
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
            Game::Silent => Msg::StateSilent,
            Game::Loading => Msg::StateLoading,
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
        Game::Silent => AMBER,
        Game::Loading => MUTED,
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

/// A saved lap's label (`Lap 3  1:47.918`, or `Lap 5  3:27.250 (not valid)`) in its parts.
#[derive(Debug, PartialEq)]
struct LapLabel<'a> {
    name: &'a str,
    time: &'a str,
    /// The label says the lap did not count.
    invalid: bool,
}

/// Splits a saved lap's label into its name, its time and whether the lap was invalid.
fn lap_parts(label: &str) -> LapLabel<'_> {
    let (name, rest) = label.split_once("  ").unwrap_or((label, ""));
    let rest = rest.trim();
    match rest.strip_suffix(crate::engine::NOT_VALID_MARK.trim_start()) {
        Some(time) => LapLabel {
            name,
            time: time.trim_end(),
            invalid: true,
        },
        None => LapLabel {
            name,
            time: rest,
            invalid: false,
        },
    }
}

/// The best time among the laps that counted, in seconds; an invalid lap is never the fastest.
fn fastest_valid(laps: &[LapLabel]) -> Option<f64> {
    laps.iter()
        .filter(|l| !l.invalid)
        .filter_map(|l| clock_seconds(l.time))
        .reduce(f64::min)
}

/// The font size for a text measured `measured` wide at `size`, so that it fits in `room`: `size` itself when it
/// already fits, smaller in proportion when it does not, and never below `floor`.
fn fit_size(measured: f32, size: f32, room: f32, floor: f32) -> f32 {
    if measured <= room || measured <= 0.0 {
        return size;
    }
    (size * room / measured).max(floor.min(size))
}

/// The flags of the languages, in the order of `Lang::ALL`: Nucleo's flag icons (`assets/flags/*.svg`), drawn once
/// into premultiplied 32-bit pixels at 120 x 96 (`*.bgra`, made from the SVGs with headless Chrome; `*.png` are the
/// same pixels to look at).
const FLAG_W: i32 = 120;
const FLAG_H: i32 = 96;
static FLAG_PIXELS: [&[u8]; 3] = [
    include_bytes!("../assets/flags/us.bgra"),
    include_bytes!("../assets/flags/br.bgra"),
    include_bytes!("../assets/flags/es.bgra"),
];

thread_local! {
    static FLAGS: std::cell::OnceCell<[usize; 3]> = const { std::cell::OnceCell::new() };
}

/// The flag of a language as a GDI+ image (made on first use, kept for the program's life); null without GDI+.
fn flag_image(lang: Lang) -> *mut GpImage {
    let index = Lang::ALL.iter().position(|l| *l == lang).unwrap_or(0);
    FLAGS.with(|flags| {
        flags.get_or_init(|| {
            FLAG_PIXELS.map(|pixels| {
                if !gdiplus_ready() || pixels.len() != (FLAG_W * FLAG_H * 4) as usize {
                    return 0;
                }
                unsafe {
                    // A bitmap over the embedded pixels, copied at once into one GDI+ owns (the pixels are only read).
                    let mut over = null_mut();
                    let made = GdipCreateBitmapFromScan0(
                        FLAG_W,
                        FLAG_H,
                        FLAG_W * 4,
                        PIXEL_FORMAT_32BPP_PARGB,
                        pixels.as_ptr().cast_mut(),
                        &mut over,
                    ) == 0;
                    if !made || over.is_null() {
                        return 0;
                    }
                    let mut own = null_mut();
                    let copied = GdipCloneBitmapAreaI(0, 0, FLAG_W, FLAG_H, PIXEL_FORMAT_32BPP_PARGB, over, &mut own) == 0;
                    GdipDisposeImage(over.cast());
                    if copied {
                        own as usize
                    } else {
                        0
                    }
                }
            })
        })[index] as *mut GpImage
    })
}

/// Draws one frame of the window.
pub fn paint(hdc: HDC, width: i32, height: i32, view: &View) {
    let mut g = Painter::new(hdc, view.scale);
    g.backdrop(width, height);
    header(&mut g, width, view);
    let top = g.px(HEADER_H);
    let body = rect(g.px(16.0), top, width - g.px(16.0), height - g.px(16.0));
    match view.tab {
        Tab::Dash => dashboard(&mut g, body, view),
        Tab::Monitor => monitor(&mut g, body, view),
    }
    if view.lang_open {
        lang_list(&mut g, width, view);
    } else {
        tooltip(&mut g, width, view);
    }
}

/// The language list, open under the language button: each language's flag and its name in its own words, the one
/// in use marked in yellow, the row under the mouse lit.
fn lang_list(g: &mut Painter, width: i32, view: &View) {
    let [_, _, button, _, _] = header_hits(width, view.scale);
    g.place(view.scale, 0, 0);
    let (row_h, pad, list_w) = (g.px(40.0), g.px(6.0), g.px(200.0));
    let rows = Lang::ALL.len() as i32;
    let list = rect(
        button.right - list_w,
        button.bottom + g.px(6.0),
        button.right,
        button.bottom + g.px(6.0) + pad * 2 + row_h * rows,
    );
    g.round(list, CORNER, CARD, Some(EDGE));
    for (i, lang) in Lang::ALL.into_iter().enumerate() {
        let top = list.top + pad + row_h * i as i32;
        let row = rect(list.left + pad, top, list.right - pad, top + row_h);
        let current = lang == view.lang;
        if view.mouse.is_some_and(|(mx, my)| inside(&row, mx, my)) {
            g.fill(row, mix(CARD, TEXT, 0.07));
        }
        if current {
            g.fill(
                rect(row.left, row.top + g.px(8.0), row.left + g.px(3.0), row.bottom - g.px(8.0)),
                ACCENT,
            );
        }
        let (fw, fh) = (g.px(25.0), g.px(20.0));
        let flag = rect(
            row.left + g.px(14.0),
            top + (row_h - fh) / 2,
            row.left + g.px(14.0) + fw,
            top + (row_h - fh) / 2 + fh,
        );
        let image = flag_image(lang);
        if !image.is_null() {
            g.image(flag, image);
        }
        let label = rect(flag.right + g.px(12.0), top, row.right - g.px(8.0), top + row_h);
        g.text(
            lang.name(),
            label,
            14.0,
            FW_SEMIBOLD as i32,
            Face::Ui,
            if current { ACCENT } else { TEXT },
            DT_LEFT,
        );
        view.buttons.borrow_mut().push((Action::Lang(i), row));
    }
}

/// The name of the icon button under the mouse, in a small label below it.
fn tooltip(g: &mut Painter, width: i32, view: &View) {
    let Some((mx, my)) = view.mouse else { return };
    let [_, _, lang, full, top] = header_hits(width, view.scale);
    let (r, label) = if inside(&lang, mx, my) {
        (lang, text(view.lang, &Msg::MenuLanguage))
    } else if inside(&full, mx, my) {
        (
            full,
            text(
                view.lang,
                if view.full {
                    &Msg::PanelExitFullScreen
                } else {
                    &Msg::PanelFullScreen
                },
            ),
        )
    } else if inside(&top, mx, my) {
        (top, text(view.lang, &Msg::PanelOnTop))
    } else {
        return;
    };
    g.place(view.scale, 0, 0);
    let measured = g.width_of(&label, 12.5, FW_SEMIBOLD as i32, Face::Ui);
    let w = g.px(measured + 20.0);
    let h = g.px(28.0);
    let tip = rect(r.right - w, r.bottom + g.px(6.0), r.right, r.bottom + g.px(6.0) + h);
    g.round(tip, CORNER, CARD, Some(EDGE));
    g.text(&label, tip, 12.5, FW_SEMIBOLD as i32, Face::Ui, TEXT, DT_CENTER);
}

fn header(g: &mut Painter, width: i32, view: &View) {
    g.place(view.scale, 0, 0);
    let [dash, mon, lang, full, top] = header_hits(width, view.scale);
    let semi = FW_SEMIBOLD as i32;
    // The tabs: one pill, the chosen tab a yellow pill inside it.
    let control = rect(dash.left - g.px(4.0), g.px(13.0), mon.right + g.px(4.0), g.px(51.0));
    g.round(control, CORNER, CARD, Some(EDGE));
    let tab_size = if mon.right - dash.left < g.px(200.0) { 12.0 } else { 14.0 };
    for (r, tab, label) in [(dash, Tab::Dash, Msg::PanelTabDash), (mon, Tab::Monitor, Msg::PanelTabMonitor)] {
        let selected = view.tab == tab;
        if selected {
            g.round(r, CORNER, ACCENT, None);
        }
        let color = if selected { BG } else { MUTED };
        g.text(&text(view.lang, &label), r, tab_size, semi, Face::Ui, color, DT_CENTER);
    }
    // Full screen and always on top: square icon buttons; one that is on is filled yellow. Full screen uses
    // Windows' own icon; the pin is drawn here, upright and square like the rest.
    // The language: a square button with its flag (yellow edge while its list is open); a click opens the list.
    g.round(lang, CORNER, CARD, Some(if view.lang_open { ACCENT } else { EDGE }));
    let (fw, fh) = (g.px(22.5), g.px(18.0));
    let (cx, cy) = ((lang.left + lang.right) / 2, (lang.top + lang.bottom) / 2);
    let image = flag_image(view.lang);
    if image.is_null() {
        g.text(&view.lang.code().to_uppercase(), lang, 12.5, semi, Face::Ui, TEXT, DT_CENTER);
    } else {
        g.image(rect(cx - fw / 2, cy - fh / 2, cx - fw / 2 + fw, cy - fh / 2 + fh), image);
    }
    for (r, active) in [(full, view.full), (top, view.on_top)] {
        let (fill, edge) = if active { (ACCENT, None) } else { (CARD, Some(EDGE)) };
        g.round(r, CORNER, fill, edge);
    }
    let (full_ink, pin_ink) = (if view.full { BG } else { TEXT }, if view.on_top { BG } else { TEXT });
    full_icon(g, full, full_ink, view.full);
    pin_icon(g, top, pin_ink);
    // The version, small, left of the icon buttons, where every tab shows it.
    let version = concat!("v", env!("CARGO_PKG_VERSION"));
    let right = lang.left - g.px(14.0);
    if right - g.px(60.0) > mon.right + g.px(12.0) {
        let r = rect(right - g.px(120.0), lang.top, right, lang.bottom);
        g.text(version, r, 12.0, FW_NORMAL as i32, Face::Ui, MUTED, DT_RIGHT);
    }
}

/// Four square corners in a box (pixels): pointing out to go full screen, in to leave it.
fn full_icon(g: &mut Painter, r: RECT, color: COLORREF, leaving: bool) {
    let (cx, cy) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    let (reach, near, arm, t) = (g.px(8.0), g.px(3.0), g.px(5.0), g.px(1.6).max(1));
    // A box from two corners in any order.
    let span = |x0: i32, y0: i32, x1: i32, y1: i32| rect(x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1));
    for (sx, sy) in [(-1, -1), (1, -1), (-1, 1), (1, 1)] {
        // Going full screen: each corner's point at the outside, its arms back toward the middle. Leaving: the
        // point near the middle, its arms out.
        let (vx, vy, d) = if leaving {
            (cx + sx * near, cy + sy * near, 1)
        } else {
            (cx + sx * reach, cy + sy * reach, -1)
        };
        g.fill(span(vx, vy, vx + d * sx * arm, vy + d * sy * t), color);
        g.fill(span(vx, vy, vx + d * sx * t, vy + d * sy * arm), color);
    }
}

/// An upright push pin in a box (pixels): a cap, a body, a wide collar and the needle, all square.
fn pin_icon(g: &mut Painter, r: RECT, color: COLORREF) {
    let (cx, cy) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    let p = |v: f32| g.px(v);
    for (x0, y0, x1, y1) in [
        (-4.5, -9.0, 4.5, -6.5),  // cap
        (-3.0, -6.5, 3.0, 1.0),   // body
        (-6.5, 1.0, 6.5, 3.5),    // collar
        (-0.75, 3.5, 0.75, 10.0), // needle
    ] {
        g.fill(rect(cx + p(x0), cy + p(y0), cx + p(x1).max(p(x0) + 1), cy + p(y1)), color);
    }
}

/// Fits a canvas of `width` x `height` design units in `body`, centred: its scale and where it starts (pixels).
fn canvas_fit_wh(body: RECT, width: f32, height: f32) -> (f32, i32, i32) {
    let (bw, bh) = ((body.right - body.left) as f32, (body.bottom - body.top) as f32);
    let s = (bw / width).min(bh / height).max(0.1);
    let ox = body.left + ((bw - width * s) / 2.0).round() as i32;
    let oy = body.top + ((bh - height * s) / 2.0).round() as i32;
    (s, ox, oy)
}

/// The game the waiting screen is about: the most interesting one that is open (recording, connected, unsupported,
/// paused, open without data), if any.
fn focus_of(games: &[(&'static str, &'static str, Game)]) -> Option<(&'static str, &'static str, Game)> {
    let rank = |g: &Game| match g {
        Game::Recording(_) => 5,
        Game::Connected => 4,
        Game::Unsupported => 3,
        Game::Paused => 2,
        Game::Silent | Game::Loading => 1,
        Game::Waiting => 0,
    };
    games
        .iter()
        .filter(|(_, _, g)| *g != Game::Waiting)
        .max_by_key(|(_, _, g)| rank(g))
        .cloned()
}

/// The waiting screen about one open game: its cover, its name, and what happens next (or what to switch on). `cw` is
/// the canvas width (narrower in a tall window), its text wrapped to fit.
/// What the open-game screen says: its title, its line (in yellow when the person has something to do) and a note.
fn focus_words(view: &View, (id, name, game): (&'static str, &'static str, Game)) -> (String, String, Option<String>, bool) {
    let (title, line, note) = match game {
        Game::Silent => (Msg::FocusOpen(name.into()), Msg::Setup(id), Some(Msg::FocusAutoConnect)),
        Game::Loading => (Msg::FocusOpen(name.into()), Msg::FocusLoading, None),
        Game::Unsupported => (Msg::FocusOpen(name.into()), Msg::FocusUnsupported, None),
        Game::Paused => (Msg::FocusConnected(name.into()), Msg::FocusPaused, None),
        _ => (Msg::FocusConnected(name.into()), Msg::FocusGetInCar, None),
    };
    let act = game == Game::Silent || game == Game::Unsupported;
    (
        text(view.lang, &title),
        text(view.lang, &line),
        note.map(|n| text(view.lang, &n)),
        act,
    )
}

/// The open-game screen's cover size, and the height of the whole block for a canvas `cw` wide.
const FOCUS_COVER: (f32, f32) = (170.0, 255.0);
fn focus_height(g: &mut Painter, view: &View, focus: (&'static str, &'static str, Game), cw: f32) -> f32 {
    let (title, line, note, _) = focus_words(view, focus);
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let mut h = g.wrap_lines(&title, cw - 40.0, 34.0, semi, Face::Num).len() as f32 * 46.0 + 6.0;
    h += g.wrap_lines(&line, cw - 60.0, 15.0, semi, Face::Ui).len() as f32 * 22.0;
    if let Some(note) = note {
        h += 4.0 + g.wrap_lines(&note, cw - 60.0, 13.0, normal, Face::Ui).len() as f32 * 20.0;
    }
    h + 24.0 + FOCUS_COVER.1 + 9.0
}

/// The waiting screen about one open game, from the top of its own canvas: its name, what happens next (or what to
/// switch on), then its cover. `cw` is the canvas width (narrower in a tall window), the words wrapped to fit.
fn focus_screen(g: &mut Painter, view: &View, focus: (&'static str, &'static str, Game), cw: f32) {
    let (id, name, game) = focus.clone();
    let (title, line, note, act) = focus_words(view, focus);
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let mut y = 0.0;
    y += g.wrapped(&title, 20.0, y, cw - 40.0, 34.0, semi, Face::Num, TEXT, DT_CENTER, 46.0);
    y += 6.0;
    y += g.wrapped(
        &line,
        30.0,
        y,
        cw - 60.0,
        15.0,
        semi,
        Face::Ui,
        if act { ACCENT } else { MUTED },
        DT_CENTER,
        22.0,
    );
    if let Some(note) = note {
        y += 4.0;
        y += g.wrapped(&note, 30.0, y, cw - 60.0, 13.0, normal, Face::Ui, MUTED, DT_CENTER, 20.0);
    }
    // The game's cover, as big as the carousel's middle one; a name card when there is no cover.
    let (w, h) = FOCUS_COVER;
    let (x, y) = ((cw - w) / 2.0, y + 24.0);
    let exact = g.exact(x, y, w, h);
    match view.covers.iter().find(|c| c.key == id).map(|c| c.image).filter(|i| !i.is_null()) {
        Some(image) => g.image_exact(exact, image),
        None => g.cover_card(exact, name, 1.1),
    }
    // A line under it: yellow while the game is the one being watched, amber while it shares no data.
    g.fill(g.r(x, y + h + 6.0, w, 3.0), if game == Game::Silent { AMBER } else { ACCENT });
}

fn waiting(g: &mut Painter, body: RECT, view: &View) {
    // A tall window (a phone held upright) gets a narrower canvas, so the words stay big enough to read.
    let tall = ((body.right - body.left) as f32) < ((body.bottom - body.top) as f32) * 0.9;
    let cw = if tall { PORTRAIT_W } else { CANVAS_W };
    let (s, ox, oy) = canvas_fit_wh(body, cw, CANVAS_H);
    g.place(s, ox, oy);
    if let Some(focus) = view.focus.clone() {
        // Measured first, then fitted by its own height: the block sits in the middle whatever the window's shape.
        // On a phone the block is drawn narrower, so it comes out bigger (the title wraps).
        let fcw = if tall { 440.0 } else { cw };
        let margin = 40.0;
        let h = focus_height(g, view, focus.clone(), fcw) + 2.0 * margin;
        let (s, ox, oy) = canvas_fit_wh(body, fcw, h);
        g.place(s, ox, oy + (margin * s).round() as i32);
        return focus_screen(g, view, focus, fcw);
    }
    let title = text(view.lang, &Msg::PanelWaitingTitle);
    let r = g.r(0.0, 66.0, cw, 50.0);
    g.text(&title, r, 34.0, FW_SEMIBOLD as i32, Face::Num, TEXT, DT_CENTER);
    g.wrapped(
        &text(view.lang, &Msg::PanelWaiting),
        20.0,
        116.0,
        cw - 40.0,
        15.0,
        FW_NORMAL as i32,
        Face::Ui,
        MUTED,
        DT_CENTER,
        22.0,
    );
    if !view.covers.is_empty() {
        view.carousel_step.set(120.0 * g.s);
        return cover_carousel(g, view.covers, view.carousel, &view.buttons, cw);
    }
    // The games it reads, as chips, centred in rows.
    let chips: Vec<(String, f32)> = view
        .games
        .iter()
        .map(|row| (row.title.clone(), g.width_of(&row.title, 13.0, FW_SEMIBOLD as i32, Face::Ui) + 28.0))
        .collect();
    let mut rows: Vec<Vec<(String, f32)>> = vec![Vec::new()];
    let mut used = 0.0;
    for chip in chips {
        if used + chip.1 > cw - 240.0 && !rows.last().unwrap().is_empty() {
            rows.push(Vec::new());
            used = 0.0;
        }
        used += chip.1 + 10.0;
        rows.last_mut().unwrap().push(chip);
    }
    for (i, row) in rows.iter().enumerate() {
        let total: f32 = row.iter().map(|(_, w)| w + 10.0).sum::<f32>() - 10.0;
        let mut x = (cw - total) / 2.0;
        let y = 262.0 + i as f32 * 40.0;
        for (name, w) in row {
            g.round(g.r(x, y, *w, 30.0), 15.0, CARD, Some(EDGE));
            let r = g.r(x, y, *w, 30.0);
            g.text(name, r, 13.0, FW_SEMIBOLD as i32, Face::Ui, MUTED, DT_CENTER);
            x += w + 10.0;
        }
    }
}

/// Where cover `i` of `count` sits from the middle of a carousel at `at`: a signed distance in covers, wrapped so the
/// covers go round (the nearest way).
fn carousel_offset(i: usize, count: usize, at: f32) -> f32 {
    let n = count as f32;
    let d = (i as f32 - at).rem_euclid(n);
    if d > n / 2.0 {
        d - n
    } else {
        d
    }
}

/// How many steps (the nearest way round, negative to the left) take a carousel of `count` covers whose middle is
/// heading to `target` to cover `to`.
fn carousel_steps(target: i64, to: usize, count: usize) -> i64 {
    if count == 0 {
        return 0;
    }
    let n = count as i64;
    let by = (to as i64 - target).rem_euclid(n);
    if by > n / 2 {
        by - n
    } else {
        by
    }
}

/// The games as a carousel: the cover in the middle big, the others smaller and darker the further they are, going
/// round; the middle game's name under it and a row of small squares saying which one it is. Steam's art where it
/// has some, the name on a card where not. A click on a side cover or on one of the squares brings that game to the
/// middle.
fn cover_carousel(g: &mut Painter, covers: &[CoverArt], at: f32, buttons: &std::cell::RefCell<Vec<(Action, RECT)>>, cw: f32) {
    let count = covers.len();
    let (big_w, mid_x, top) = (150.0, cw / 2.0, 168.0);
    let big_h = big_w * 1.5;
    // Far covers first, so the nearer ones are drawn over them.
    let mut order: Vec<(usize, f32)> = (0..count).map(|i| (i, carousel_offset(i, count, at))).collect();
    order.sort_by(|a, b| b.1.abs().total_cmp(&a.1.abs()));
    for (i, d) in order {
        let far = d.abs();
        if far > 3.2 {
            continue;
        }
        let scale = (1.0 - 0.17 * far).max(0.4);
        let (w, h) = (big_w * scale, big_h * scale);
        // Closer together further out, as on a curved shelf.
        let x = mid_x + d.signum() * (far * 128.0 - far * far * 9.0) - w / 2.0;
        let y = top + (big_h - h) / 2.0;
        let exact = g.exact(x, y, w, h);
        let cover = &covers[i];
        if cover.image.is_null() {
            g.cover_card(exact, cover.name, scale);
        } else {
            g.image_exact(exact, cover.image);
        }
        // Darker the further from the middle.
        let shade = (far * 0.32).min(0.8);
        if shade > 0.01 {
            g.veil_exact(exact, BG, shade);
        }
        // A side cover is a button; nearer covers are drawn later and go first, as they are on top.
        if far > 0.5 {
            buttons.borrow_mut().insert(0, (Action::Cover(i), g.r(x, y, w, h)));
        }
    }
    // The game in the middle, and where it is in the list.
    let middle = (at.round() as i64).rem_euclid(count as i64) as usize;
    let r = g.r(0.0, top + big_h + 14.0, cw, 26.0);
    g.text(
        &covers[middle].name.to_uppercase(),
        r,
        18.0,
        FW_SEMIBOLD as i32,
        Face::Num,
        TEXT,
        DT_CENTER,
    );
    let (dot, gap) = (7.0, 6.0);
    let total = count as f32 * dot + (count as f32 - 1.0) * gap;
    for i in 0..count {
        let x = mid_x - total / 2.0 + i as f32 * (dot + gap);
        g.fill(g.r(x, top + big_h + 48.0, dot, dot), if i == middle { ACCENT } else { TRACK });
        // A square is small: its button reaches halfway to its neighbours and a little above and below.
        let hit = g.r(x - gap / 2.0, top + big_h + 40.0, dot + gap, dot + 16.0);
        buttons.borrow_mut().push((Action::Cover(i), hit));
    }
}

/// The dashboard's layouts, one per shape of window. Each is a canvas in design units, scaled whole to fit, so the
/// panel works on an ultrawide screen, a 16:9 or 16:10 one, a 4:3 one and a phone held upright alike.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Layout {
    /// The main dashboard alone (a small window).
    Classic,
    /// Ultrawide (21:9): the main dashboard and the track and tyre column.
    Ultrawide,
    /// 16:9 and 16:10: the column, and the recent laps under the dashboard.
    Wide,
    /// 4:3 and 5:4: the track and the tyres side by side under the dashboard.
    Square,
    /// A tall window (a phone held upright): everything in one column.
    Portrait,
}

/// The recent laps under the dashboard (`Layout::Wide`).
const BAND_H: f32 = 188.0;
/// The track and tyre row under the dashboard (`Layout::Square`).
const SQUARE_ROW_H: f32 = 310.0;
/// The tall layout's canvas (about 9:16).
const PORTRAIT_W: f32 = 600.0;
const PORTRAIT_H: f32 = 1210.0;

impl Layout {
    fn size(self) -> (f32, f32) {
        match self {
            Layout::Classic => (CANVAS_W, CANVAS_H),
            Layout::Ultrawide => (CANVAS_W + SIDE_W, CANVAS_H),
            Layout::Wide => (CANVAS_W + SIDE_W, CANVAS_H + BAND_H),
            Layout::Square => (CANVAS_W, CANVAS_H + SQUARE_ROW_H),
            Layout::Portrait => (PORTRAIT_W, PORTRAIT_H),
        }
    }

    /// The smallest scale at which the layout still reads well (the tall one is drawn bigger to begin with).
    fn min_scale(self) -> f32 {
        match self {
            Layout::Classic => 0.0,
            Layout::Portrait => 0.5,
            _ => 0.75,
        }
    }
}

/// The layout that fills a body of `bw` x `bh` pixels best while staying readable; between two that fill it about as
/// well, the one that shows more.
fn pick_layout(bw: f32, bh: f32) -> Layout {
    let order = [Layout::Wide, Layout::Ultrawide, Layout::Square, Layout::Portrait, Layout::Classic];
    let fill = |l: Layout| {
        let (w, h) = l.size();
        let s = (bw / w).min(bh / h);
        (s >= l.min_scale()).then(|| s * s * w * h / (bw * bh).max(1.0))
    };
    let best = order.iter().filter_map(|&l| fill(l)).fold(0.0_f32, f32::max);
    order
        .into_iter()
        .find(|&l| fill(l).is_some_and(|f| f >= best - 0.03))
        .unwrap_or(Layout::Classic)
}

fn dashboard(g: &mut Painter, body: RECT, view: &View) {
    let Some(live) = view.live.filter(|l| view.now_ms - l.at_ms <= STALE_MS) else {
        return waiting(g, body, view);
    };
    let layout = pick_layout((body.right - body.left) as f32, (body.bottom - body.top) as f32);
    let (w, h) = layout.size();
    let (s, ox, oy) = canvas_fit_wh(body, w, h);
    g.place(s, ox, oy);
    match layout {
        Layout::Portrait => portrait_block(g, live, view),
        Layout::Classic => main_block(g, live, view, w),
        Layout::Ultrawide => {
            main_block(g, live, view, w);
            side_column(g, live, view, CANVAS_H);
        }
        Layout::Wide => {
            main_block(g, live, view, w);
            side_column(g, live, view, h);
            laps_band(g, view, live, CANVAS_H + 22.0, CANVAS_W, h);
        }
        Layout::Square => {
            main_block(g, live, view, w);
            let (top, half) = (CANVAS_H + 22.0, (CANVAS_W - 20.0) / 2.0);
            track_panel(g, live, view, 0.0, top, half, h - top);
            tyres_panel(g, live, view, half + 20.0, top, half, h - top);
        }
    }
}

/// The recent laps as cards, oldest to newest, then the lap being driven (marked yellow, its time running): the
/// fastest in purple, each with its gap to the fastest.
fn laps_band(g: &mut Painter, view: &View, live: &Live, top: f32, w: f32, bottom: f32) {
    let r = g.r(0.0, top, w, 16.0);
    g.caps(&text(view.lang, &Msg::PanelRecentLaps), r, 10.5, MUTED, DT_LEFT);
    let (y, h) = (top + 24.0, bottom - top - 24.0);
    let laps: Vec<LapLabel> = view.recent_laps.iter().map(|label| lap_parts(label)).collect();
    let fastest = fastest_valid(&laps).unwrap_or(f64::INFINITY);
    // Six places, always: the last completed laps (up to five), the lap being driven, then empty places, so the row
    // keeps its shape from the first lap on.
    let (n, gap) = (6_usize, 12.0);
    let card_w = (w - gap * (n as f32 - 1.0)) / n as f32;
    let shown = &laps[laps.len().saturating_sub(n - 1)..];
    let semi = FW_SEMIBOLD as i32;
    let card = |g: &mut Painter,
                i: usize,
                edge: COLORREF,
                name: &str,
                name_color: COLORREF,
                time: &str,
                time_color: COLORREF,
                note: &str,
                note_color: COLORREF,
                invalid: bool| {
        let x = i as f32 * (card_w + gap);
        g.fill(g.r(x, y, card_w, h), CARD);
        g.fill(g.r(x, y, card_w, 3.0), edge);
        let r = g.r(x + 14.0, y + 14.0, card_w - 28.0, 16.0);
        g.caps(name, r, 10.5, name_color, DT_LEFT);
        if invalid {
            g.invalid_mark(x + card_w - 14.0 - 16.0, y + 13.0, 16.0);
        }
        // The time never leaves its card: smaller when it is long.
        let room = card_w - 24.0;
        let size = g.fitted(time, room, 30.0, 14.0, semi, Face::Num);
        let r = g.r(x + 12.0, y + 40.0, room + 4.0, 40.0);
        g.text(time, r, size, semi, Face::Num, time_color, DT_LEFT);
        let r = g.r(x + 14.0, y + h - 36.0, card_w - 28.0, 20.0);
        g.text(note, r, 14.0, semi, Face::Num, note_color, DT_LEFT);
    };
    for (i, lap) in shown.iter().enumerate() {
        let secs = clock_seconds(lap.time);
        let is_fastest = !lap.invalid && secs.is_some_and(|s| (s - fastest).abs() < 0.0005);
        let note = match secs {
            _ if lap.invalid => text(view.lang, &Msg::PanelInvalid),
            _ if is_fastest => text(view.lang, &Msg::PanelFastest),
            Some(s) if fastest.is_finite() => format!("+{:.3}", s - fastest),
            _ => String::new(),
        };
        let (edge, color) = match (lap.invalid, is_fastest) {
            (true, _) => (RED, MUTED),
            (_, true) => (PURPLE, PURPLE),
            _ => (EDGE, TEXT),
        };
        let note_color = match (lap.invalid, is_fastest) {
            (true, _) => RED,
            (_, true) => PURPLE,
            _ => MUTED,
        };
        card(g, i, edge, lap.name, MUTED, lap.time, color, &note, note_color, lap.invalid);
    }
    // The lap being driven, its time running and its delta to the best lap.
    let now = shown.len();
    let delta_color = match live.delta_s {
        Some(d) if d < 0.0 => GREEN,
        Some(_) => RED,
        None => MUTED,
    };
    let name = text(view.lang, &Msg::PanelLap(live.lap.max(1)));
    card(
        g,
        now,
        ACCENT,
        &name,
        ACCENT,
        &lap_clock(live.lap_time_s),
        TEXT,
        &delta_text(live.delta_s),
        delta_color,
        live.lap_valid == Some(false),
    );
    // The places still to fill.
    for i in now + 1..n {
        let x = i as f32 * (card_w + gap);
        g.fill(g.r(x, y, card_w, h), mix(BG, CARD, 0.45));
    }
    if laps.is_empty() {
        let x = (now + 1) as f32 * (card_w + gap);
        let note = text(view.lang, &Msg::PanelNoLapsYet);
        g.wrapped(
            &note,
            x + 20.0,
            y + h / 2.0 - 11.0,
            w - x - 40.0,
            14.0,
            FW_NORMAL as i32,
            Face::Ui,
            MUTED,
            DT_CENTER,
            22.0,
        );
    }
}

/// The mark of a lap that will not count, ending at `right` (design units), with its word before it when `label`.
fn invalid_flag(g: &mut Painter, view: &View, right: f32, y: f32, label: bool) {
    let size = 22.0;
    g.invalid_mark(right - size, y, size);
    if label {
        let word = text(view.lang, &Msg::PanelInvalid);
        let room = 120.0;
        let fit = g.fitted(&word, room, 15.0, 11.0, FW_SEMIBOLD as i32, Face::Ui);
        let used = g.width_of(&word, fit, FW_SEMIBOLD as i32, Face::Ui);
        let r = g.r(right - size - 8.0 - used, y, used + 2.0, size);
        g.text(&word, r, fit, FW_SEMIBOLD as i32, Face::Ui, RED, DT_LEFT);
    }
}

/// `1:47.918` as seconds.
fn clock_seconds(text: &str) -> Option<f64> {
    let (minutes, seconds) = text.split_once(':')?;
    Some(minutes.trim().parse::<f64>().ok()? * 60.0 + seconds.trim().parse::<f64>().ok()?)
}

/// The tall layout (a phone held upright), on a 600 x 1210 canvas: the rev bar, the lap, the delta, the gear with the
/// pedals either side and the wheel under the speed, the times and the fuel in two columns, the car strip (lights,
/// engine and fuel, electronics and damage), then the track and the tyres side by side.
fn brand_car_line(g: &mut Painter, car: &str, live: &Live, view: &View, width: f32) -> RECT {
    let catalog: Vec<_> = view.brands.iter().map(|b| b.brand.clone()).collect();
    let Some(brand) = crate::brands::match_brand(&live.car, &catalog) else {
        return g.r(0.0, 72.0, width, 18.0);
    };
    if let Some(art) = view.brands.iter().find(|b| b.brand.key == brand.key) {
        let tile = g.r(0.0, 70.0, 34.0, 20.0);
        g.round(tile, 3.0, rgb(0xf5, 0xf5, 0xf5), None);
        g.image(g.r(2.0, 71.0, 30.0, 18.0), art.image);
        g.r(40.0, 72.0, width - 40.0, 18.0)
    } else {
        let _ = car;
        g.r(0.0, 72.0, width, 18.0)
    }
}
fn portrait_block(g: &mut Painter, live: &Live, view: &View) {
    let w = PORTRAIT_W;
    let share = if live.rpm_top > 0.0 { live.rpm / live.rpm_top } else { f32::NAN };
    let (lit, flash) = lights_lit(share);
    let blink_on = view.now_ms / 120 % 2 == 0;
    g.rev_bar(0.0, 0.0, w, 36.0, share, flash && blink_on);
    g.round(g.r(0.0, 37.0, w, 3.0), 1.5, CYAN, None);
    title_line(g, live, view, w, 420.0, false);
    g.fill(g.r(0.0, 95.0, w, 1.0), EDGE);

    let bottom = centre_block(g, live, view, w / 2.0, 100.0, 190.0, (lit, flash, blink_on));
    g.fill(g.r(0.0, bottom + 14.0, w, 1.0), EDGE);

    // The times on the left, fuel and lap progress on the right.
    let top = bottom + 22.0;
    side_stats(g, live, view, (0.0, w, top), 76.0, [34.0, 34.0, 34.0], 290.0);
    let strip = top + 76.0 * 3.0 + 6.0;
    g.fill(g.r(0.0, strip - 4.0, w, 1.0), EDGE);

    // The car strip, stacked: the lights across, the engine and the electronics side by side under them.
    let (lights_h, row_h, gap) = (80.0, 108.0, 10.0);
    car_card(g, live, view, CarCard::Lights, (0.0, strip + 6.0, w, lights_h));
    let row_y = strip + 6.0 + lights_h + gap;
    let half = (w - gap) / 2.0;
    car_card(g, live, view, CarCard::Engine, (0.0, row_y, half, row_h));
    car_card(g, live, view, CarCard::Electronics, (half + gap, row_y, half, row_h));

    // The track and the tyres side by side, a square each.
    let low = row_y + row_h + 14.0;
    let track_w = 250.0;
    track_panel(g, live, view, 0.0, low, track_w, PORTRAIT_H - low);
    tyres_panel(g, live, view, track_w + 14.0, low, w - track_w - 14.0, PORTRAIT_H - low);
}

/// The line over the dashboard: track and car on the left, the lap on the right (with the mark of a lap that will
/// not count, and whether the car is in the pits). `left_w` is the room the left side has.
fn title_line(g: &mut Painter, live: &Live, view: &View, width: f32, left_w: f32, labelled: bool) {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let r = g.r(0.0, 48.0, left_w, 24.0);
    g.text(&live.track.to_uppercase(), r, 17.0, semi, Face::Num, TEXT, DT_LEFT);
    let car = [live.car.as_str(), live.game]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("  ·  ");
    let r = brand_car_line(g, &car, live, view, left_w);
    g.text(&car, r, 12.5, normal, Face::Ui, MUTED, DT_LEFT);
    let r = g.r(width - 200.0, 46.0, 200.0, 28.0);
    let title = text(view.lang, &Msg::PanelLap(live.lap)).to_uppercase();
    g.text(&title, r, 26.0, semi, Face::Num, ACCENT, DT_RIGHT);
    if live.lap_valid == Some(false) {
        let at = width - g.width_of(&title, 26.0, semi, Face::Num) - 12.0;
        invalid_flag(g, view, at, 49.0, labelled);
    }
    let status = if live.in_pits {
        text(view.lang, &Msg::PanelPits)
    } else if !live.driving {
        text(view.lang, &Msg::PanelNotDriving)
    } else {
        String::new()
    };
    let r = g.r(width - 240.0, 72.0, 240.0, 18.0);
    g.caps(&status, r, 11.0, AMBER, DT_RIGHT);
}

/// The lap's times in a column on the left (lap time, last, best) and fuel and lap progress on the right, in rows of
/// `row_h` from `top`. `columns` is `(left edge, right edge, top)`; `sizes` the size of each row's figure; `room` the
/// width a column has. Fuel is big, with the laps it lasts and its use per lap under it; the lap is a percentage
/// with the distance and a bar, using the room of the two rows under the fuel.
fn side_stats(g: &mut Painter, live: &Live, view: &View, columns: (f32, f32, f32), row_h: f32, sizes: [f32; 3], room: f32) {
    let (left, right, top) = columns;
    let semi = FW_SEMIBOLD as i32;
    let lang = view.lang;
    let progress = match (live.dist_m, live.track_length_m) {
        (Some(d), Some(l)) if l > 0.0 => Some((d / l).clamp(0.0, 1.0) as f32),
        _ => None,
    };
    let lap_share = progress.map_or_else(|| "–".to_owned(), |p| format!("{:.0}%", p * 100.0));
    let rows = [
        (text(lang, &Msg::PanelLapTime), lap_clock(live.lap_time_s), TEXT),
        (text(lang, &Msg::PanelLastLap), lap_clock(live.last_lap_s), TEXT),
        (text(lang, &Msg::PanelBestLap), lap_clock(live.best_lap_s), PURPLE),
    ];
    for (i, (label, value, color)) in rows.iter().enumerate() {
        let y = top + row_h * i as f32;
        if i > 0 {
            g.fill(g.r(left, y, room, 1.0), EDGE);
        }
        let r = g.r(left, y + 10.0, room, 18.0);
        g.caps(label, r, 11.0, MUTED, DT_LEFT);
        let r = g.r(left - 2.0, y + 28.0, room + 20.0, row_h - 34.0);
        g.text(value, r, sizes[i], semi, Face::Num, *color, DT_LEFT);
    }
    // Fuel: big, with what it lasts under it.
    let fuel = if live.fuel_l.is_finite() {
        format!("{:.1} L", live.fuel_l)
    } else {
        "–".to_owned()
    };
    let rx = right - room;
    let r = g.r(rx, top + 10.0, room, 18.0);
    g.caps(&text(lang, &Msg::PanelFuel), r, 11.0, MUTED, DT_RIGHT);
    let r = g.r(rx - 22.0, top + 28.0, room + 24.0, row_h - 50.0);
    g.text(&fuel, r, sizes[0], semi, Face::Num, TEXT, DT_RIGHT);
    let sub = fuel_sub_line(live, lang);
    if !sub.0.is_empty() {
        let r = g.r(rx, top + row_h - 22.0, room, 16.0);
        g.text(&sub.0, r, 12.5, FW_NORMAL as i32, Face::Ui, sub.1, DT_RIGHT);
    }
    // The lap: the share, the bar and the distance.
    let y = top + row_h;
    g.fill(g.r(rx, y, room, 1.0), EDGE);
    let r = g.r(rx, y + 10.0, room, 18.0);
    g.caps(&text(lang, &Msg::PanelLapProgress), r, 11.0, MUTED, DT_RIGHT);
    let r = g.r(rx - 22.0, y + 28.0, room + 24.0, row_h - 30.0);
    g.text(&lap_share, r, sizes[1] + 12.0, semi, Face::Num, TEXT, DT_RIGHT);
    let bar_w = room.min(240.0);
    g.blocks(
        right - bar_w,
        y + row_h + 2.0,
        bar_w,
        9.0,
        20,
        0.0,
        progress.unwrap_or(f32::NAN),
        ACCENT,
    );
    if let (Some(d), Some(l)) = (live.dist_m, live.track_length_m) {
        if l > 0.0 {
            let line = format!("{:.0} / {:.0} m", d.clamp(0.0, l), l);
            let r = g.r(rx, y + row_h + 18.0, room, 16.0);
            g.text(&line, r, 12.5, FW_NORMAL as i32, Face::Ui, MUTED, DT_RIGHT);
        }
    }
}

/// "13.3 laps · 2.9 L/lap" under the fuel, with only what is known, and its colour (amber under two laps of fuel, red
/// under one).
fn fuel_sub_line(live: &Live, lang: Lang) -> (String, COLORREF) {
    let left = fuel_laps_left(live.fuel_l, live.fuel_per_lap_l);
    let mut parts = Vec::new();
    if let Some(n) = left {
        parts.push(text(lang, &Msg::PanelFuelLaps(format!("{n:.1}"))));
    }
    if let Some(per) = live.fuel_per_lap_l.filter(|p| p.is_finite() && *p > 0.0) {
        parts.push(text(lang, &Msg::PanelFuelPerLap(format!("{per:.1}"))));
    }
    let color = match left {
        Some(n) if n < 1.0 => RED,
        Some(n) if n < 2.0 => AMBER,
        _ => MUTED,
    };
    (parts.join("  ·  "), color)
}

/// The laps of fuel left at the car's use per lap; nothing until the use per lap is known.
fn fuel_laps_left(fuel_l: f32, per_lap_l: Option<f32>) -> Option<f32> {
    let per = per_lap_l.filter(|p| p.is_finite() && *p > 0.0)?;
    fuel_l.is_finite().then(|| fuel_l.max(0.0) / per)
}

/// The main dashboard on its 1000 x 520 canvas: rev bar (as wide as the whole layout, `width`), track and car, the
/// lap's times and the fuel on the sides, the delta, the gear between its pedals and the speed over the wheel in the
/// middle, and the car strip along the bottom.
fn main_block(g: &mut Painter, live: &Live, view: &View, width: f32) {
    // The rev bar: a dome across the top, green to red as the revs climb, on a cyan line; it flashes blue at the
    // shift point.
    let share = if live.rpm_top > 0.0 { live.rpm / live.rpm_top } else { f32::NAN };
    let (lit, flash) = lights_lit(share);
    let blink_on = view.now_ms / 120 % 2 == 0;
    g.rev_bar(0.0, 0.0, width, 36.0, share, flash && blink_on);
    g.round(g.r(0.0, 37.0, width, 3.0), 1.5, CYAN, None);
    title_line(g, live, view, width, 640.0, true);
    g.fill(g.r(0.0, 95.0, width, 1.0), EDGE);

    side_stats(g, live, view, (0.0, CANVAS_W, 100.0), 98.0, [52.0, 42.0, 42.0], MAIN_SIDE_W);
    centre_block(g, live, view, CANVAS_W / 2.0, 100.0, 140.0, (lit, flash, blink_on));

    // The car strip along the bottom.
    let strip = STRIP_TOP;
    g.fill(g.r(0.0, strip - 5.0, CANVAS_W, 1.0), EDGE);
    for (card, area) in strip_plan(0.0, strip, CANVAS_W, CANVAS_H - strip - 8.0) {
        car_card(g, live, view, card, area);
    }
}

/// The width of the left and right columns of the main block, and where its car strip starts.
const MAIN_SIDE_W: f32 = 300.0;
const STRIP_TOP: f32 = 400.0;

/// The height of a pedal bar's fill, in the same units as `full`: `value` is 0..1; out of range is clamped and a
/// value the game does not give (NaN) counts as released.
fn pedal_fill(value: f32, full: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0) * full
    } else {
        0.0
    }
}

/// The one-letter tag under a pedal bar: the first letter of its (translated) name, in capitals.
fn pedal_tag(name: &str) -> String {
    name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default()
}

/// How far the wheel is turned, -1 (full left) to 1 (full right); straight without a value.
fn steer_share(steer: f32) -> f32 {
    if steer.is_finite() {
        steer.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

/// Where the middle of the dashboard puts its parts, from the centre line `cx` and the top of the delta.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Centre {
    /// The gear's frame (the corner brackets).
    frame: Area,
    brake: Area,
    throttle: Area,
    clutch: Area,
    /// The steering bar, under the speed.
    steer: Area,
    /// Where the speed and its unit go.
    speed: Area,
    unit: Area,
    /// The first line under everything.
    bottom: f32,
}

const FRAME_W: f32 = 280.0;

fn centre_plan(cx: f32, top: f32, frame_h: f32) -> Centre {
    let (fx, fy) = (cx - FRAME_W / 2.0, top + 72.0);
    let (bar_w, clutch_w, gap) = (18.0, 10.0, 10.0);
    let brake_x = fx - gap - bar_w;
    let speed_y = fy + frame_h + 6.0;
    Centre {
        frame: (fx, fy, FRAME_W, frame_h),
        brake: (brake_x, fy, bar_w, frame_h),
        throttle: (fx + FRAME_W + gap, fy, bar_w, frame_h),
        clutch: (brake_x - 7.0 - clutch_w, fy, clutch_w, frame_h),
        steer: (fx, speed_y + 60.0, FRAME_W, 8.0),
        speed: (cx - 120.0, speed_y, 240.0, 40.0),
        unit: (cx - 120.0, speed_y + 38.0, 240.0, 14.0),
        bottom: speed_y + 72.0,
    }
}

/// The middle of the dashboard: the delta over the gear (its corner brackets turning red near the limit and flashing
/// blue at the shift), the brake and the throttle as tall bars outside the brackets (the clutch beside the brake, when
/// the game gives it), the speed under the gear and the wheel as a bar under the speed. Returns the line under all of
/// it. `lights` is `(shift lights lit, flashing, blink phase)`.
fn centre_block(g: &mut Painter, live: &Live, view: &View, cx: f32, top: f32, frame_h: f32, lights: (usize, bool, bool)) -> f32 {
    let (lit, flash, blink_on) = lights;
    let semi = FW_SEMIBOLD as i32;
    let plan = centre_plan(cx, top, frame_h);
    let delta_color = match live.delta_s {
        Some(d) if d < 0.0 => GREEN,
        Some(_) => RED,
        None => MUTED,
    };
    let r = g.r(cx - 170.0, top, 340.0, 16.0);
    g.caps(&text(view.lang, &Msg::PanelDelta), r, 10.5, MUTED, DT_CENTER);
    let r = g.r(cx - 170.0, top + 14.0, 340.0, 40.0);
    g.text(&delta_text(live.delta_s), r, 38.0, semi, Face::Num, delta_color, DT_CENTER);
    // Each block is a tenth of a second, faster to the left.
    let (from, to) = match live.delta_s.filter(|d| d.is_finite()) {
        Some(d) => {
            let at = 0.5 + (d.clamp(-1.0, 1.0) as f32) / 2.0;
            (at.min(0.5), at.max(0.5))
        }
        None => (f32::NAN, f32::NAN),
    };
    g.blocks(cx - 150.0, top + 56.0, 300.0, 9.0, 20, from, to, delta_color);
    g.fill(g.r(cx - 1.0, top + 52.0, 2.0, 17.0), TEXT);

    let frame = match (flash, lit) {
        (true, _) if blink_on => BLUE,
        (true, _) => RED,
        (false, n) if n >= LIGHTS - 2 => RED,
        _ => MUTED,
    };
    let (fx, fy, fw, fh) = plan.frame;
    let (arm, thick) = (26.0, 3.0);
    for (px, py, dx, dy) in [
        (fx, fy, 1.0, 1.0),
        (fx + fw, fy, -1.0, 1.0),
        (fx, fy + fh, 1.0, -1.0),
        (fx + fw, fy + fh, -1.0, -1.0),
    ] {
        let x0 = if dx > 0.0 { px } else { px - arm };
        let y0 = if dy > 0.0 { py } else { py - thick };
        g.fill(g.r(x0, y0, arm, thick), frame);
        let x1 = if dx > 0.0 { px } else { px - thick };
        let y1 = if dy > 0.0 { py } else { py - arm };
        g.fill(g.r(x1, y1, thick, arm), frame);
    }
    let r = g.r(fx - 4.0, fy - 4.0, fw + 8.0, fh + 8.0);
    g.text(&gear_text(live.gear), r, fh * 0.93, semi, Face::Num, ACCENT, DT_CENTER);
    let (below, above) = neighbour_gears(live.gear, live.gears);
    for (gear, x) in [(below, fx + 24.0), (above, fx + fw - 64.0)] {
        if let Some(gear) = gear {
            let (w, h) = (40.0, 52.0);
            let y = fy + fh / 2.0 - h / 2.0;
            g.fill(g.r(x, y, w, h), CARD);
            let r = g.r(x, y, w, h);
            g.text(&gear, r, 26.0, semi, Face::Num, MUTED, DT_CENTER);
        }
    }

    // The pedals: tall slim bars with a letter under each.
    let mut bars = vec![
        (Msg::PanelBrake, live.brake, RED, plan.brake),
        (Msg::PanelThrottle, live.throttle, GREEN, plan.throttle),
    ];
    if live.clutch.is_finite() {
        bars.push((Msg::PanelClutch, live.clutch, BLUE, plan.clutch));
    }
    for (name, value, color, area) in &bars {
        g.vertical_bar(*area, *value, *color);
        let (bx, by, bw, bh) = *area;
        let r = g.r(bx - 8.0, by + bh + 3.0, bw + 16.0, 14.0);
        g.caps(&pedal_tag(&text(view.lang, name)), r, 9.0, MUTED, DT_CENTER);
    }

    let speed = if live.speed_ms.is_finite() {
        format!("{:.0}", live.speed_ms * 3.6)
    } else {
        "–".to_owned()
    };
    let (sx, sy, sw, sh) = plan.speed;
    let r = g.r(sx, sy, sw, sh);
    g.text(&speed, r, 42.0, semi, Face::Num, TEXT, DT_CENTER);
    let (ux, uy, uw, uh) = plan.unit;
    let r = g.r(ux, uy, uw, uh);
    g.caps("km/h", r, 10.5, MUTED, DT_CENTER);
    g.steer_bar(plan.steer, live.steer);
    plan.bottom
}

// The CAR strip: three cards in the lap-card look.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CarCard {
    Lights,
    Engine,
    Electronics,
}

impl CarCard {
    /// The narrowest a card reads well at, and the share of a row it takes.
    fn min_w(self) -> f32 {
        match self {
            CarCard::Lights => 230.0,
            CarCard::Engine => 190.0,
            CarCard::Electronics => 290.0,
        }
    }

    fn weight(self) -> f32 {
        match self {
            CarCard::Lights => 1.0,
            CarCard::Engine => 0.85,
            CarCard::Electronics => 1.15,
        }
    }
}

/// The cards that fit a row of `w` x `h` at (`x`, `y`), left to right: lights, engine and fuel, electronics and
/// damage. When there is not room for all of them, the engine goes first, then the electronics, never the lights.
fn strip_plan(x: f32, y: f32, w: f32, h: f32) -> Vec<(CarCard, Area)> {
    let gap = 12.0;
    let sets: [&[CarCard]; 3] = [
        &[CarCard::Lights, CarCard::Engine, CarCard::Electronics],
        &[CarCard::Lights, CarCard::Electronics],
        &[CarCard::Lights],
    ];
    for set in sets {
        let room = w - gap * (set.len() as f32 - 1.0);
        let total: f32 = set.iter().map(|c| c.weight()).sum();
        let fits = set.iter().all(|c| room * c.weight() / total >= c.min_w());
        if fits || set.len() == 1 {
            let mut at = x;
            return set
                .iter()
                .map(|&c| {
                    let cw = room * c.weight() / total;
                    let area = (at, y, cw, h);
                    at += cw + gap;
                    (c, area)
                })
                .collect();
        }
    }
    Vec::new()
}

/// One card: its fill and top edge like a lap card, its title, then what it holds.
fn car_card(g: &mut Painter, live: &Live, view: &View, card: CarCard, area: Area) {
    let (x, y, w, h) = area;
    g.fill(g.r(x, y, w, h), CARD);
    g.fill(g.r(x, y, w, 3.0), EDGE);
    let title = match card {
        CarCard::Lights => Msg::PanelLights,
        CarCard::Engine => Msg::PanelEngineFuel,
        CarCard::Electronics => Msg::PanelElectronics,
    };
    let r = g.r(x + 14.0, y + 10.0, w - 28.0, 16.0);
    g.caps(&text(view.lang, &title), r, 10.5, MUTED, DT_LEFT);
    let inner = (x + 14.0, y + 32.0, w - 28.0, (h - 32.0 - 8.0).max(1.0));
    match card {
        CarCard::Lights => lights_card(g, live, view, inner),
        CarCard::Engine => engine_card(g, live, view, inner),
        CarCard::Electronics => electronics_card(g, live, view, inner),
    }
}

/// A line in a card that has nothing to show.
fn card_note(g: &mut Painter, msg: &Msg, view: &View, (x, y, w, h): Area) {
    let note = text(view.lang, msg);
    let r = g.r(x, y, w, h.min(24.0));
    g.text(&note, r, 12.5, FW_NORMAL as i32, Face::Ui, MUTED, DT_LEFT);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PillKind {
    Pit,
    Abs,
    Tc,
    Drs,
    Headlights,
    Fuel,
    Engine,
    Handbrake,
    Flag,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Glow {
    Off,
    On,
    /// DRS allowed but not open: an outline in the light's colour.
    Ready,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pill {
    kind: PillKind,
    glow: Glow,
    flag: Option<crate::game::Flag>,
}

fn pill_color(kind: PillKind) -> COLORREF {
    match kind {
        PillKind::Pit => ACCENT,
        PillKind::Abs | PillKind::Tc | PillKind::Fuel => AMBER,
        PillKind::Engine | PillKind::Handbrake => RED,
        PillKind::Headlights | PillKind::Drs => GREEN,
        PillKind::Flag => MUTED,
    }
}

/// The lights the game gives, in their fixed order; a light it does not give is left out (never shown as off). FUEL
/// is given whenever the laps of fuel left are known, and lit under two.
fn light_pills(live: &Live) -> Vec<Pill> {
    use crate::game::Drs;
    let s = &live.state;
    let lit = |on: bool| if on { Glow::On } else { Glow::Off };
    let mut pills = Vec::new();
    let mut add = |kind, glow, flag| pills.push(Pill { kind, glow, flag });
    if let Some(on) = s.pit_limiter {
        add(PillKind::Pit, lit(on), None);
    }
    if let Some(on) = s.abs_active {
        add(PillKind::Abs, lit(on), None);
    }
    if let Some(on) = s.tc_active {
        add(PillKind::Tc, lit(on), None);
    }
    if let Some(drs) = s.drs {
        let glow = match drs {
            Drs::Open => Glow::On,
            Drs::Available => Glow::Ready,
            Drs::Off => Glow::Off,
        };
        add(PillKind::Drs, glow, None);
    }
    if let Some(on) = s.headlights {
        add(PillKind::Headlights, lit(on), None);
    }
    if let Some(left) = fuel_laps_left(live.fuel_l, live.fuel_per_lap_l) {
        add(PillKind::Fuel, lit(left < 2.0), None);
    }
    if let Some(on) = s.engine_warning {
        add(PillKind::Engine, lit(on), None);
    }
    if let Some(on) = s.handbrake {
        add(PillKind::Handbrake, lit(on), None);
    }
    if let Some(f) = s.flag {
        add(PillKind::Flag, Glow::Off, Some(f));
    }
    pills
}

/// Where `n` pills go in a box: as many columns as the width allows (and no more than `n`), pills stretching a little
/// to fill the row, wrapping to new rows.
fn pill_cells((x, y, w, _h): Area, n: usize) -> Vec<Area> {
    let (min_w, max_w, ph, gap) = (50.0, 66.0, 20.0, 6.0);
    if n == 0 {
        return Vec::new();
    }
    let cols = (((w + gap) / (min_w + gap)).floor() as usize).clamp(1, n);
    let pw = ((w - gap * (cols as f32 - 1.0)) / cols as f32).min(max_w);
    (0..n)
        .map(|i| {
            let (col, row) = (i % cols, i / cols);
            (x + col as f32 * (pw + gap), y + row as f32 * (ph + gap), pw, ph)
        })
        .collect()
}

fn lights_card(g: &mut Painter, live: &Live, view: &View, inner: Area) {
    let pills = light_pills(live);
    if pills.is_empty() {
        return card_note(g, &Msg::PanelNoLights, view, inner);
    }
    for (pill, cell) in pills.iter().zip(pill_cells(inner, pills.len())) {
        g.pill(view.lang, *pill, cell);
    }
}

/// A readout: a small caps label over a figure.
struct Cell {
    label: String,
    value: String,
    color: COLORREF,
}

/// Where `n` cells go in a box with `cols` columns: `(x, y, w, h)` each.
fn cell_grid((x, y, w, h): Area, n: usize, cols: usize) -> Vec<Area> {
    if n == 0 {
        return Vec::new();
    }
    let cols = cols.clamp(1, n);
    let rows = n.div_ceil(cols);
    let (cw, rh) = (w / cols as f32, (h / rows as f32).min(44.0));
    (0..n)
        .map(|i| (x + (i % cols) as f32 * cw, y + (i / cols) as f32 * rh, cw, rh))
        .collect()
}

fn draw_cells(g: &mut Painter, cells: &[Cell], area: Area, cols: usize) {
    let semi = FW_SEMIBOLD as i32;
    for (cell, (x, y, w, h)) in cells.iter().zip(cell_grid(area, cells.len(), cols)) {
        let r = g.r(x, y, w - 4.0, 12.0);
        g.caps(&cell.label, r, 9.0, MUTED, DT_LEFT);
        let size = (h - 12.0).clamp(14.0, 20.0);
        let r = g.r(x - 1.0, y + 12.0, w + 2.0, size + 4.0);
        g.text(&cell.value, r, size, semi, Face::Num, cell.color, DT_LEFT);
    }
}

/// The colour of a temperature that gets worse above `warm` and `hot`.
fn heat_color(temp_c: f32, warm: f32, hot: f32) -> COLORREF {
    if temp_c >= hot {
        RED
    } else if temp_c >= warm {
        AMBER
    } else {
        TEXT
    }
}

/// The figures of the engine and fuel card, only those known.
fn engine_cells(live: &Live, lang: Lang) -> Vec<Cell> {
    let mut cells = Vec::new();
    if let Some(t) = live.state.water_c.filter(|t| t.is_finite()) {
        cells.push(Cell {
            label: text(lang, &Msg::PanelWater),
            value: format!("{t:.0} °C"),
            color: heat_color(t, 105.0, 115.0),
        });
    }
    if let Some(t) = live.state.oil_c.filter(|t| t.is_finite()) {
        cells.push(Cell {
            label: text(lang, &Msg::PanelOil),
            value: format!("{t:.0} °C"),
            color: heat_color(t, 130.0, 145.0),
        });
    }
    if let Some(per) = live.fuel_per_lap_l.filter(|p| p.is_finite() && *p > 0.0) {
        cells.push(Cell {
            label: text(lang, &Msg::PanelPerLap),
            value: format!("{per:.1} L"),
            color: TEXT,
        });
    }
    if let Some(n) = fuel_laps_left(live.fuel_l, live.fuel_per_lap_l) {
        let color = if n < 1.0 {
            RED
        } else if n < 2.0 {
            AMBER
        } else {
            TEXT
        };
        cells.push(Cell {
            label: text(lang, &Msg::PanelLapsLeft),
            value: format!("{n:.1}"),
            color,
        });
    }
    cells
}

fn engine_card(g: &mut Painter, live: &Live, view: &View, inner: Area) {
    let cells = engine_cells(live, view.lang);
    if cells.is_empty() {
        return card_note(g, &Msg::PanelNoCarData, view, inner);
    }
    draw_cells(g, &cells, inner, 2);
}

/// The figures of the electronics half: TC, ABS and MAP levels and the brake bias, only those known.
fn electronics_cells(live: &Live, lang: Lang) -> Vec<Cell> {
    let level = |n: u8| if n == 0 { "OFF".to_owned() } else { n.to_string() };
    let s = &live.state;
    let mut cells = Vec::new();
    for (label, value) in [
        ("TC", s.tc_level.map(level)),
        ("ABS", s.abs_level.map(level)),
        ("MAP", s.engine_map.map(|n| n.to_string())),
    ] {
        if let Some(value) = value {
            cells.push(Cell {
                label: label.to_owned(),
                value,
                color: TEXT,
            });
        }
    }
    if let Some(bias) = s.brake_bias.filter(|b| b.is_finite()) {
        cells.push(Cell {
            label: text(lang, &Msg::PanelBias),
            value: format!("{:.1} %", bias.clamp(0.0, 1.0) * 100.0),
            color: TEXT,
        });
    }
    cells
}

/// The damage bars the car has: name and share (0 = none .. 1 = destroyed), only those known.
fn damage_bars(live: &Live, lang: Lang) -> Vec<(String, f32)> {
    let s = &live.state;
    [
        (Msg::PanelDmgBody, s.damage_body),
        (Msg::PanelDmgEngine, s.damage_engine),
        (Msg::PanelDmgGearbox, s.damage_gearbox),
        (Msg::PanelDmgSusp, s.damage_suspension),
    ]
    .into_iter()
    .filter_map(|(msg, d)| d.filter(|d| d.is_finite()).map(|d| (text(lang, &msg), d.clamp(0.0, 1.0))))
    .collect()
}

/// Damage's colour: green, through amber, to red.
fn damage_color(share: f32) -> COLORREF {
    let s = share.clamp(0.0, 1.0);
    if s < 0.5 {
        mix(GREEN, AMBER, s / 0.5)
    } else {
        mix(AMBER, RED, (s - 0.5) / 0.5)
    }
}

/// Where the two halves of the electronics card go: the figures on the left, the damage bars on the right; a half
/// with nothing to show gives its room to the other.
fn electronics_split((x, y, w, h): Area, stats: bool, bars: bool) -> (Area, Area) {
    match (stats, bars) {
        (true, true) => {
            let left = (w * 0.46).floor();
            ((x, y, left, h), (x + left + 14.0, y, w - left - 14.0, h))
        }
        (true, false) => ((x, y, w, h), (x + w, y, 0.0, h)),
        (false, true) => ((x, y, 0.0, h), (x, y, w, h)),
        (false, false) => ((x, y, 0.0, h), (x, y, 0.0, h)),
    }
}

fn electronics_card(g: &mut Painter, live: &Live, view: &View, inner: Area) {
    let cells = electronics_cells(live, view.lang);
    let bars = damage_bars(live, view.lang);
    if cells.is_empty() && bars.is_empty() {
        return card_note(g, &Msg::PanelNoCarData, view, inner);
    }
    let (stats_area, bars_area) = electronics_split(inner, !cells.is_empty(), !bars.is_empty());
    draw_cells(g, &cells, stats_area, 2);
    let (bx, by, bw, bh) = bars_area;
    let row_h = (bh / 4.0).min(18.0);
    for (i, (name, share)) in bars.iter().enumerate() {
        let y = by + i as f32 * row_h;
        let r = g.r(bx, y, 44.0, row_h);
        g.caps(name, r, 8.0, MUTED, DT_LEFT);
        let track = (bx + 48.0, y + row_h / 2.0 - 3.0, (bw - 48.0).max(1.0), 6.0);
        g.round(g.r(track.0, track.1, track.2, track.3), 3.0, TRACK, None);
        let color = damage_color(*share);
        // Undamaged is an empty bar with a pip of green, so it still reads as healthy.
        let len = (track.2 * share).max(5.0);
        g.round(g.r(track.0, track.1, len, track.3), 3.0, color, None);
    }
}

/// The colour of a tyre's temperature: blue cold, green in its window, amber warm, red hot (°C, typical for racing
/// tyres; each game and compound has its own window, so this is a guide, not a target).
fn tyre_color(temp_c: f32) -> COLORREF {
    match temp_c {
        t if !t.is_finite() => MUTED,
        t if t < 65.0 => STEEL,
        t if t < 95.0 => GREEN,
        t if t < 110.0 => AMBER,
        _ => RED,
    }
}

/// The right-hand column, from under the header line to `bottom`: the track map, then the four tyres.
fn side_column(g: &mut Painter, live: &Live, view: &View, bottom: f32) {
    let (x, w, top) = (CANVAS_W + 24.0, SIDE_W - 24.0, 106.0);
    let tyres_h = ((bottom - top) * 0.46).clamp(214.0, 330.0);
    track_panel(g, live, view, x, top, w, bottom - top - tyres_h - 14.0);
    tyres_panel(g, live, view, x, bottom - tyres_h, w, tyres_h);
}

/// The track map (the car's own path, with where it is now) in a box; until there is enough of a path, a word that
/// it draws itself as the car goes.
fn track_panel(g: &mut Painter, live: &Live, view: &View, x: f32, y: f32, w: f32, h: f32) {
    let r = g.r(x, y, w, 16.0);
    g.caps(&text(view.lang, &Msg::PanelTrack), r, 10.5, MUTED, DT_LEFT);
    match live.map.as_ref().filter(|m| m.len() >= 30) {
        Some(map) => g.track_map((x, y + 22.0, w, h - 22.0), map, live.map_complete, live.pos),
        None => {
            g.fill(g.r(x, y + 22.0, w, h - 22.0), mix(BG, CARD, 0.5));
            let note = text(view.lang, &Msg::PanelMapSoon);
            g.wrapped(
                &note,
                x + 16.0,
                y + 22.0 + (h - 22.0) / 2.0 - 10.0,
                w - 32.0,
                13.0,
                FW_NORMAL as i32,
                Face::Ui,
                MUTED,
                DT_CENTER,
                20.0,
            );
        }
    }
}

/// The four tyres around a quiet top view of the car: a rounded tyre at each corner, partly outside the body, its
/// border and glow in its temperature's colour and its tread left filling it from the bottom. On the outer side the
/// temperature and the pressure; above the front tyres and below the rear ones the brake's temperature with a disc
/// in its colour. When the game says nothing about tyres, a word that it does not.
fn tyres_panel(g: &mut Painter, live: &Live, view: &View, x: f32, y: f32, w: f32, h: f32) {
    let r = g.r(x, y, w, 16.0);
    g.caps(&text(view.lang, &Msg::PanelTyres), r, 10.5, MUTED, DT_LEFT);
    let Some(tyres) = live.tyres else {
        g.fill(g.r(x, y + 22.0, w, h - 22.0), mix(BG, CARD, 0.5));
        let note = text(view.lang, &Msg::PanelNoTyres);
        g.wrapped(
            &note,
            x + 16.0,
            y + 22.0 + (h - 22.0) / 2.0 - 10.0,
            w - 32.0,
            13.0,
            FW_NORMAL as i32,
            Face::Ui,
            MUTED,
            DT_CENTER,
            20.0,
        );
        return;
    };
    let brakes = tyres.iter().any(|t| t.brake_c.is_finite());
    let plan = schematic(x, y + 22.0, w, h - 22.0, brakes);
    // The car first, so the tyres sit on top of it.
    g.car_body(plan.body);
    for (i, tyre) in tyres.iter().enumerate() {
        tyre_box(g, &plan, i, tyre);
    }
}

/// A box in design units: `(x, y, width, height)`.
type Area = (f32, f32, f32, f32);

/// Where everything of the tyre schematic goes. Tyre order everywhere: front left, front right, rear left, rear right.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Schematic {
    tyres: [Area; 4],
    /// Beside each tyre, on its outer side: the temperature and the pressure. Left tyres' text is right-aligned (it
    /// hugs the tyre), right tyres' text left-aligned.
    readout: [Area; 4],
    /// The brake temperature: above the front tyres, below the rear ones. Zero height when no brake is shown.
    brake: [Area; 4],
    /// The car's silhouette between the tyres.
    body: Area,
    /// The size of the big temperature.
    temp_size: f32,
}

/// The brake row's height.
const BRAKE_ROW: f32 = 18.0;

/// The schematic for a box: the car in the middle, as large as the height allows, the readouts on its two sides.
/// `brakes`: keep a row above and below for the brake temperatures.
fn schematic(x: f32, y: f32, w: f32, h: f32, brakes: bool) -> Schematic {
    let brake_h = if brakes { BRAKE_ROW } else { 0.0 };
    let inner_h = (h - 2.0 * brake_h).max(1.0);
    // A tyre is about twice as long as it is wide. Long enough to hold the temperature and the pressure.
    let th = (inner_h * 0.32).clamp(33.0, 80.0).min(inner_h / 2.0 - 4.0).max(8.0);
    let tw = (th * 0.55).clamp(8.0, 42.0);
    // The distance between the two tyres of an axle: wide, but never so wide that the readouts lose their room.
    let (readout_min, pad) = (80.0, 10.0);
    let gap = (th * 1.15)
        .clamp(30.0, 70.0)
        .min((w - 2.0 * tw - 2.0 * (readout_min + pad)).max(14.0));
    let cx = x + w / 2.0;
    let (left_x, right_x) = (cx - gap / 2.0 - tw, cx + gap / 2.0);
    let (front_y, rear_y) = (y + brake_h, y + h - brake_h - th);
    // The temperature and the pressure take about 50 units of height at the biggest; the size follows the tyre.
    let temp_size = ((th - 18.0) / 1.15).clamp(14.0, 30.0);
    let block = temp_size * 1.15 + 16.0;
    // The body reaches a little past the tyres at both ends and as far out as the middle of each tyre.
    let half = gap / 2.0 + tw * 0.5;
    let (body_top, body_bottom) = ((front_y - th * 0.15).max(y), (rear_y + th * 1.15).min(y + h));
    let mut plan = Schematic {
        tyres: [
            (left_x, front_y, tw, th),
            (right_x, front_y, tw, th),
            (left_x, rear_y, tw, th),
            (right_x, rear_y, tw, th),
        ],
        readout: [(0.0, 0.0, 0.0, 0.0); 4],
        brake: [(0.0, 0.0, 0.0, 0.0); 4],
        body: (cx - half, body_top, half * 2.0, body_bottom - body_top),
        temp_size,
    };
    for i in 0..4 {
        let (tx, ty, tw, th) = plan.tyres[i];
        let rh = block;
        let ry = (ty + th / 2.0 - rh / 2.0).max(y);
        plan.readout[i] = if i.is_multiple_of(2) {
            (x, ry, (tx - pad - x).max(0.0), rh)
        } else {
            (tx + tw + pad, ry, (x + w - tx - tw - pad).max(0.0), rh)
        };
        if brakes {
            let by = if i < 2 { y } else { y + h - brake_h };
            plan.brake[i] = (tx + tw / 2.0 - 40.0, by, 80.0, brake_h);
        }
    }
    plan
}

/// The colour of a brake disc's temperature: steel blue cold, green working, amber hot, red over the limit.
fn brake_color(temp_c: f32) -> COLORREF {
    match temp_c {
        t if !t.is_finite() => MUTED,
        t if t < 150.0 => STEEL,
        t if t < 450.0 => GREEN,
        t if t < 700.0 => AMBER,
        _ => RED,
    }
}

/// One tyre of the schematic: a dark tyre with its border and a soft glow in its temperature's colour and its tread
/// left as a muted fill from the bottom; the temperature big and the pressure under it on the outer side; the
/// brake's temperature with its disc in its row.
fn tyre_box(g: &mut Painter, plan: &Schematic, i: usize, tyre: &crate::game::Tyre) {
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let known = tyre.temp_c.is_finite();
    let color = tyre_color(tyre.temp_c);
    let (x, y, w, h) = plan.tyres[i];
    let radius = (w * 0.3).min(9.0);
    let edge = if known { color } else { mix(BG, MUTED, 0.35) };
    // The glow: a few rings getting fainter outward.
    if known {
        for (grow, amount) in [(5.0, 0.07), (3.5, 0.12), (2.0, 0.2)] {
            g.round(
                g.r(x - grow, y - grow, w + 2.0 * grow, h + 2.0 * grow),
                radius + grow,
                mix(BG, color, amount),
                None,
            );
        }
    }
    g.round(g.r(x, y, w, h), radius, edge, None);
    let base = mix(BG, CARD, 0.55);
    let border = 1.6;
    g.round(
        g.r(x + border, y + border, w - 2.0 * border, h - 2.0 * border),
        radius - border,
        base,
        None,
    );
    // Tread left: the fill rises from the bottom, in the temperature's colour, muted.
    if tyre.left.is_finite() {
        let inset = 3.2;
        let (fx, fw, full) = (x + inset, w - 2.0 * inset, h - 2.0 * inset);
        let filled = full * tyre.left.clamp(0.0, 1.0);
        if filled >= 1.0 {
            let tint = if known { mix(base, color, 0.5) } else { mix(base, MUTED, 0.3) };
            g.round(
                g.r(fx, y + inset + full - filled, fw, filled),
                (radius - inset).max(1.0).min(filled / 2.0),
                tint,
                None,
            );
        }
    }
    // The readout, centred on the tyre's height, on its outer side.
    let (rx, _, rw, _) = plan.readout[i];
    let right_aligned = i.is_multiple_of(2);
    let size = plan.temp_size;
    let block = size * 1.15 + 16.0;
    let top = y + h / 2.0 - block / 2.0;
    let temp = if known { format!("{:.0}°", tyre.temp_c) } else { "–".to_owned() };
    let r = g.r(rx, top, rw, size * 1.15);
    g.text(
        &temp,
        r,
        size,
        semi,
        Face::Num,
        color,
        if right_aligned { DT_RIGHT } else { DT_LEFT },
    );
    if tyre.pressure_kpa.is_finite() {
        let num = format!("{:.1}", tyre.pressure_kpa / 6.894_757);
        let (num_w, psi_w) = (g.width_of(&num, 14.0, semi, Face::Num), g.width_of("psi", 10.0, normal, Face::Ui));
        let ly = top + size * 1.15 + 1.0;
        let (num_x, psi_x) = if right_aligned {
            (rx + rw - psi_w - 4.0 - num_w, rx + rw - psi_w)
        } else {
            (rx, rx + num_w + 4.0)
        };
        let r = g.r(num_x - 1.0, ly, num_w + 2.0, 18.0);
        g.text(&num, r, 14.0, semi, Face::Num, TEXT, DT_LEFT);
        let r = g.r(psi_x, ly + 4.0, psi_w + 2.0, 14.0);
        g.text("psi", r, 10.0, normal, Face::Ui, MUTED, DT_LEFT);
    }
    let (bx, by, bw, bh) = plan.brake[i];
    if tyre.brake_c.is_finite() && bh > 0.0 {
        let label = format!("{:.0} °C", tyre.brake_c);
        let (disc, gap) = (11.0, 5.0);
        let label_w = g.width_of(&label, 12.0, normal, Face::Num);
        let left = bx + (bw - (disc + gap + label_w)) / 2.0;
        g.brake_disc(left + disc / 2.0, by + bh / 2.0, disc, brake_color(tyre.brake_c));
        let r = g.r(left + disc + gap, by, label_w + 4.0, bh);
        g.text(&label, r, 12.0, normal, Face::Num, MUTED, DT_LEFT);
    }
}

/// The car's outline seen from above, in a box: the half width at each distance from the nose, as a share of the
/// box's half width. Control points `(distance 0..1, half width)`, joined smoothly.
const BODY_PROFILE: [(f32, f32); 13] = [
    (0.00, 0.10),
    (0.03, 0.24),
    (0.09, 0.38),
    (0.17, 0.52),
    (0.26, 0.74),
    (0.36, 0.88),
    (0.48, 0.84),
    (0.60, 0.82),
    (0.72, 0.90),
    (0.85, 0.98),
    (0.94, 0.96),
    (0.98, 0.86),
    (1.00, 0.55),
];

/// The silhouette's outline, going down the right side and back up the left, all inside the box.
fn body_outline((x, y, w, h): Area) -> Vec<(f32, f32)> {
    let half = w / 2.0;
    let cx = x + half;
    let steps = 48;
    let side: Vec<(f32, f32)> = (0..=steps)
        .map(|k| {
            let t = k as f32 / steps as f32;
            let at = BODY_PROFILE
                .windows(2)
                .find(|p| t <= p[1].0)
                .unwrap_or(&BODY_PROFILE[BODY_PROFILE.len() - 2..]);
            let (a, b) = (at[0], at[1]);
            let u = ((t - a.0) / (b.0 - a.0)).clamp(0.0, 1.0);
            // Eased between the two control points, so the outline has no corners.
            let ease = (1.0 - (u * std::f32::consts::PI).cos()) / 2.0;
            (y + t * h, (a.1 + (b.1 - a.1) * ease) * half)
        })
        .collect();
    side.iter()
        .map(|&(py, hw)| (cx + hw, py))
        .chain(side.iter().rev().map(|&(py, hw)| (cx - hw, py)))
        .collect()
}

fn monitor(g: &mut Painter, body: RECT, view: &View) {
    let s = view.scale;
    g.place(s, body.left, body.top);
    let (w, h) = ((body.right - body.left) as f32 / s, (body.bottom - body.top) as f32 / s);
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let gap = 16.0;
    let footer = 26.0;
    // Two columns side by side; in a narrow window (a phone held upright) one under the other.
    let stacked = w < 640.0;
    let col = if stacked { w } else { (w - gap) / 2.0 };
    let right = if stacked { 0.0 } else { col + gap };
    let left_h = if stacked { ((h - footer - gap) * 0.55).round() } else { h - footer };
    let area_h = left_h;

    // The account card always gets the height its content needs, and the games list takes what is left: its rows
    // get lower and, when even that is not enough, the last line says how many more games there are. Nothing is
    // ever drawn outside its card, whatever the window's size.
    let wanted: Vec<(Action, String, bool)> = match &view.card {
        Card::Connected { .. } => vec![(Action::OpenXpeed, text(view.lang, &Msg::PanelOpenXpeed), false)],
        Card::Waiting => vec![
            (Action::OpenConnectPage, text(view.lang, &Msg::ConnectOpenAgain), true),
            (Action::CancelConnect, text(view.lang, &Msg::ConnectCancel), false),
        ],
        Card::NotConnected { .. } => vec![(Action::Connect, text(view.lang, &Msg::MenuConnect), true)],
    };
    let buttons: Vec<(Action, String, bool, f32)> = wanted
        .into_iter()
        .map(|(action, label, primary)| {
            let w = (g.width_of(&label, 13.5, semi, Face::Ui) + 36.0).min(col - 40.0);
            (action, label, primary, w)
        })
        .collect();
    let lines = button_lines(&buttons.iter().map(|b| b.3).collect::<Vec<_>>(), col - 40.0);
    let line_count = lines.iter().map(|&(line, _)| line).max().map_or(0, |l| l + 1) as f32;
    let (button_h, button_gap) = (36.0, 10.0);
    let account_need = 104.0 + line_count * button_h + (line_count - 1.0).max(0.0) * button_gap + 20.0;
    let games = view.games.len().max(1);
    let (games_h, row_h, max_scroll) = games_layout(games, area_h - gap - account_need);
    let offset = view.games_scroll.clamp(0.0, max_scroll);
    let scrolling = max_scroll > 0.0;

    // Games: each reader with its cover, its name and a status pill; the list scrolls inside its card when it is
    // longer than the room (mouse wheel, or the thin bar at the right).
    g.tile(0.0, 0.0, col, games_h, CARD);
    g.label(&text(view.lang, &Msg::PanelGames), 20.0, 16.0, col - 40.0);
    let (list_top, list_bottom) = (42.0, games_h - 8.0);
    let bar = if scrolling { 14.0 } else { 0.0 };
    g.clip(g.r(0.0, list_top, col, list_bottom - list_top));
    for (i, row) in view.games.iter().enumerate() {
        let y = list_top + row_h * i as f32 - offset;
        if y + row_h < list_top || y > list_bottom {
            continue;
        }
        if i > 0 {
            g.fill(g.r(20.0, y, col - 40.0 - bar, 1.0), EDGE);
        }
        // The cover, small; the game's initial on a card when there is none.
        let th = (row_h - 10.0).min(42.0);
        let tw = th * 2.0 / 3.0;
        let thumb = g.r(20.0, y + (row_h - th) / 2.0, tw, th);
        match cover_for(row.key, view.covers) {
            Some(image) => g.image(thumb, image),
            None => {
                g.fill(thumb, TRACK);
                let initial: String = row.title.chars().take(1).collect();
                g.text(&initial, thumb, 14.0, semi, Face::Num, MUTED, DT_CENTER);
            }
        }
        let state = state_text(view.lang, &row.state);
        let pill_w = g.width_of(&state, 12.0, semi, Face::Ui) + 22.0;
        let text_x = 20.0 + tw + 14.0;
        let r = g.r(text_x, y, col - text_x - 40.0 - bar - pill_w, row_h);
        g.text(&row.title, r, 14.5, normal, Face::Ui, TEXT, DT_LEFT);
        pill(
            g,
            col - 20.0 - bar - pill_w,
            y + (row_h - 24.0) / 2.0,
            pill_w,
            &state,
            state_color(&row.state),
        );
    }
    g.unclip();
    if scrolling {
        // A thin square bar: the track in the edge colour, the thumb lit when the mouse is on it.
        let track_h = list_bottom - list_top;
        let content = row_h * games as f32;
        let thumb_h = (track_h * track_h / content).clamp(24.0, track_h);
        let thumb_y = list_top + (track_h - thumb_h) * offset / max_scroll;
        let x = col - 17.0;
        g.fill(g.r(x, list_top, 3.0, track_h), EDGE);
        let thumb_hit = g.r(x - 6.0, thumb_y, 15.0, thumb_h);
        let lit = view.mouse.is_some_and(|(mx, my)| inside(&thumb_hit, mx, my));
        g.fill(g.r(x - 1.0, thumb_y, 5.0, thumb_h), if lit { ACCENT } else { MUTED });
        view.scroll.set(Some(ScrollBar {
            area: g.r(0.0, 0.0, col, games_h),
            track: g.r(x - 6.0, list_top, 15.0, track_h),
            thumb: thumb_hit,
            max: max_scroll,
            per_px: max_scroll / ((track_h - thumb_h).max(1.0) * s),
        }));
    }

    // Account: the state in words, where it connects, and what can be done about it.
    let account_y = games_h + gap;
    let account_h = area_h - account_y;
    g.tile(0.0, account_y, col, account_h, CARD);
    g.label(&text(view.lang, &Msg::PanelAccount), 20.0, account_y + 16.0, col - 40.0);
    let cloud_color = match view.snapshot.cloud {
        Cloud::Idle => GREEN,
        Cloud::Waiting(_) => AMBER,
        Cloud::NotPaired => GREY,
        Cloud::Refused => RED,
    };
    let host = connect::host_of(view.server);
    // The headline, its colour and the muted line under it, by what the card says.
    let (dot, headline, muted) = match &view.card {
        Card::Waiting => (
            AMBER,
            text(view.lang, &Msg::ConnectWaiting),
            text(view.lang, &Msg::ConnectWaitingHint),
        ),
        Card::Connected { who } => (
            cloud_color,
            // Laps waiting to be sent matter more than who it is: say that when it is so.
            match view.snapshot.cloud {
                Cloud::Waiting(_) => present::cloud_line(view.lang, &view.snapshot.cloud, view.device),
                _ => text(view.lang, &Msg::ConnectedAs(who.clone())),
            },
            host.to_owned(),
        ),
        Card::NotConnected { note } => (
            cloud_color,
            present::cloud_line(view.lang, &view.snapshot.cloud, view.device),
            match note {
                Some(Note::Cancelled) => text(view.lang, &Msg::ConnectNoteCancelled),
                Some(Note::Expired) => text(view.lang, &Msg::ConnectNoteExpired),
                Some(Note::Failed(why)) => why.clone(),
                None => host.to_owned(),
            },
        ),
    };
    g.fill(g.r(20.0, account_y + 52.0, 10.0, 10.0), dot);
    let r = g.r(40.0, account_y + 42.0, col - 60.0, 30.0);
    g.text(&headline, r, 17.0, semi, Face::Ui, TEXT, DT_LEFT);
    let r = g.r(40.0, account_y + 70.0, col - 60.0, 20.0);
    g.text(&muted, r, 12.5, normal, Face::Ui, MUTED, DT_LEFT);
    // The buttons, in as many lines as the card's width needs: connecting comes first while there is no account (or
    // it refused this computer).
    for ((action, label, primary, w), &(line, x)) in buttons.iter().zip(&lines) {
        let by = account_y + 104.0 + line as f32 * (button_h + button_gap);
        if by + button_h > area_h - 12.0 {
            break;
        }
        let r = g.r(20.0 + x, by, *w, button_h);
        let (fill, edge, ink) = if *primary { (ACCENT, None, BG) } else { (CARD, Some(EDGE), TEXT) };
        g.round(r, CORNER, fill, edge);
        g.text(label, r, 13.5, semi, Face::Ui, ink, DT_CENTER);
        view.buttons.borrow_mut().push((*action, r));
    }

    // The right column (laps and activity), under the left one when stacked.
    let area_h = if stacked { h - footer - left_h - gap } else { h - footer };
    if stacked {
        g.place(s, body.left, body.top + ((left_h + gap) * s).round() as i32);
    }
    // Laps saved, newest first.
    let laps_h = if stacked {
        (area_h * 0.4).max(110.0)
    } else {
        (area_h * 0.44).max(150.0)
    };
    g.tile(right, 0.0, col, laps_h, CARD);
    g.label(&text(view.lang, &Msg::PanelLaps), right + 20.0, 16.0, col - 40.0);
    if view.recent_laps.is_empty() {
        let r = g.r(right + 20.0, 44.0, col - 40.0, 24.0);
        g.text(&text(view.lang, &Msg::PanelNoLaps), r, 13.5, normal, Face::Ui, MUTED, DT_LEFT);
    } else {
        // The count beside the title only when both fit on the line (in a small window they would run into each other).
        let count = text(view.lang, &Msg::PanelLapsCount(view.snapshot.laps_saved));
        let title = text(view.lang, &Msg::PanelLaps).to_uppercase();
        let need = g.width_of(&count, 12.0, normal, Face::Ui) + g.width_of(&title, 12.0, semi, Face::Label) * 1.3 + 24.0;
        if need <= col - 40.0 {
            let r = g.r(right + 20.0, 14.0, col - 40.0, 22.0);
            g.text(&count, r, 12.0, normal, Face::Ui, MUTED, DT_RIGHT);
        }
        let lap_row = 34.0;
        let room = ((laps_h - 52.0) / lap_row).floor().max(0.0) as usize;
        for (i, label) in view.recent_laps.iter().rev().take(room).enumerate() {
            let y = 44.0 + lap_row * i as f32;
            if i > 0 {
                g.fill(g.r(right + 20.0, y, col - 40.0, 1.0), EDGE);
            }
            let lap = lap_parts(label);
            let r = g.r(right + 20.0, y, col / 2.0, lap_row);
            g.text(lap.name, r, 14.0, normal, Face::Ui, TEXT, DT_LEFT);
            // The time stays in its half of the row (smaller when it is long), the mark of an invalid lap before it.
            let room = col / 2.0 - 20.0 - if lap.invalid { 24.0 } else { 0.0 };
            let size = g.fitted(lap.time, room, 18.0, 11.0, semi, Face::Num);
            let color = match (lap.invalid, i) {
                (true, _) => MUTED,
                (_, 0) => ACCENT,
                _ => TEXT,
            };
            let r = g.r(right + col / 2.0, y, col / 2.0 - 20.0, lap_row);
            g.text(lap.time, r, size, semi, Face::Num, color, DT_RIGHT);
            if lap.invalid {
                // The digits are set a little wider than the plain measure: leave room.
                let used = g.width_of(lap.time, size, semi, Face::Num) * 1.18 + 8.0;
                g.invalid_mark(right + col - 20.0 - used - 22.0, y + (lap_row - 16.0) / 2.0, 16.0);
            }
        }
    }

    // Activity: what happened, newest first, in plain words (the technical log stays in the log file).
    let log_y = laps_h + gap;
    g.tile(right, log_y, col, area_h - log_y, CARD);
    g.label(&text(view.lang, &Msg::PanelActivity), right + 20.0, log_y + 16.0, col - 40.0);
    if view.activity.is_empty() {
        let r = g.r(right + 20.0, log_y + 44.0, col - 40.0, 24.0);
        g.text(&text(view.lang, &Msg::PanelNoActivity), r, 13.5, normal, Face::Ui, MUTED, DT_LEFT);
    }
    let line_h = 32.0;
    let room = ((area_h - log_y - 52.0) / line_h).floor().max(0.0) as usize;
    for (i, (time, line)) in view.activity.iter().take(room).enumerate() {
        let y = log_y + 42.0 + line_h * i as f32;
        if i > 0 {
            g.fill(g.r(right + 20.0, y, col - 40.0, 1.0), EDGE);
        }
        let r = g.r(right + 20.0, y, 52.0, line_h);
        g.text(time, r, 12.0, normal, Face::Ui, MUTED, DT_LEFT);
        let r = g.r(right + 76.0, y, col - 96.0, line_h);
        g.text(line, r, 13.5, normal, Face::Ui, TEXT, DT_LEFT);
    }

    g.place(s, body.left, body.top);
    let r = g.r(0.0, h - 20.0, w, 20.0);
    g.text(&text(view.lang, &Msg::PanelHint), r, 12.0, normal, Face::Ui, MUTED, DT_RIGHT);
}

/// Buttons of these widths in lines no wider than `room`, 10 apart: each one's line and its left edge in the line.
fn button_lines(widths: &[f32], room: f32) -> Vec<(usize, f32)> {
    let mut placed = Vec::with_capacity(widths.len());
    let (mut line, mut x) = (0, 0.0);
    for &w in widths {
        if x > 0.0 && x + w > room {
            line += 1;
            x = 0.0;
        }
        placed.push((line, x));
        x += w + 10.0;
    }
    placed
}

/// The games card in `room` design units of height, for `games` lines: its height, the height of a line (from 52
/// down to 44) and how far the list scrolls (0 when every line fits).
fn games_layout(games: usize, room: f32) -> (f32, f32, f32) {
    let games = games.max(1) as f32;
    let (head, foot) = (42.0, 8.0);
    let list = (room - head - foot).max(44.0);
    let row_h = (list / games).clamp(44.0, 52.0);
    let content = row_h * games;
    if content <= list {
        (head + foot + content, row_h, 0.0)
    } else {
        (head + foot + list, row_h, content - list)
    }
}

/// The cover of a game, when it is loaded.
fn cover_for(key: &str, covers: &[CoverArt]) -> Option<*mut GpImage> {
    covers
        .iter()
        .find(|c| c.key == key)
        .map(|c| c.image)
        .filter(|image| !image.is_null())
}

/// A small rounded label with a tinted background.
fn pill(g: &mut Painter, x: f32, y: f32, w: f32, word: &str, color: COLORREF) {
    g.round(g.r(x, y, w, 24.0), CORNER, mix(CARD, color, 0.18), None);
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
/// The games list: one line per reader, only for games installed here (all of them when none was found, and always
/// a game that is running). A line for several games names only those installed ("ACC · AC Rally"), and a single one
/// by its full name.
fn game_rows(ctx: &Context, installed: Option<&HashSet<&'static str>>) -> Vec<GameRow> {
    let reported = ctx.shared.games();
    let rank = |g: &Game| match g {
        Game::Recording(_) => 4,
        Game::Connected => 3,
        Game::Unsupported => 3,
        Game::Paused => 2,
        Game::Silent | Game::Loading => 1,
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
    let lines = std::iter::once(("Le Mans Ultimate".to_owned(), vec!["lmu"])).chain(ctx.readers.iter().cloned());
    lines
        .filter_map(|(title, ids)| {
            let state = state_of(&ids);
            let here: Vec<&'static str> = match installed {
                Some(set) if !set.is_empty() => ids.iter().copied().filter(|id| set.contains(id)).collect(),
                _ => ids.clone(),
            };
            if here.is_empty() && matches!(state, Game::Waiting) {
                return None;
            }
            let here = if here.is_empty() { ids.clone() } else { here };
            Some(GameRow {
                key: here[0],
                title: line_title(&title, &ids, &here),
                state,
            })
        })
        .collect()
}

/// The title of a line for the games `here` among the reader's `ids` (its title naming them in order, "A · B · C").
fn line_title(title: &str, ids: &[&'static str], here: &[&'static str]) -> String {
    let parts: Vec<&str> = title.split(" \u{b7} ").collect();
    if parts.len() != ids.len() || here.len() == ids.len() {
        return title.to_owned();
    }
    if let [only] = here {
        if let Some((_, name)) = crate::covers::GAMES.iter().find(|(key, _)| key == only) {
            return (*name).to_owned();
        }
    }
    ids.iter()
        .zip(&parts)
        .filter(|(id, _)| here.contains(id))
        .map(|(_, part)| *part)
        .collect::<Vec<_>>()
        .join(" \u{b7} ")
}

fn scale_of(hwnd: HWND) -> f32 {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        1.0
    } else {
        dpi as f32 / 96.0
    }
}

unsafe fn paint_window(hwnd: HWND, state: &mut State) {
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
    let account = ctx.account.lock().unwrap().clone();
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
            &account.server,
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
/// The dashboard tab shows the waiting screen (no reading, or none for a while).
/// Whether the window shows something in motion: the dashboard's live readings, or a cover sliding.
fn moving(state: &State) -> bool {
    if state.tab != Tab::Dash {
        return false;
    }
    let now = now_ms();
    !waiting_now(state) || now - state.carousel.since < SLIDE_MS
}

/// Whether the point (in the window's pixels) is on something a click acts on: a tab, a header button or a button
/// of the last frame.
unsafe fn clickable(hwnd: HWND, state: &State, x: i32, y: i32) -> bool {
    let mut client = rect(0, 0, 0, 0);
    GetClientRect(hwnd, &mut client);
    header_hits(client.right, scale_of(hwnd)).iter().any(|r| inside(r, x, y))
        || state.buttons.iter().any(|(_, r)| inside(r, x, y))
        || (state.tab == Tab::Monitor && state.scroll.is_some_and(|bar| inside(&bar.thumb, x, y)))
}

/// Reads again which games are installed, and their covers when that changed.
fn refresh_installed(state: &mut State) {
    let now = Some(crate::installed::keys());
    if now != state.installed || state.covers.is_empty() {
        state.installed = now;
        state.covers = CoverArt::load(state.installed.as_ref());
        state.games_scroll = 0.0;
    }
}

/// An activity as a message of the person's language.
fn activity_message(event: Activity) -> Msg {
    match event {
        Activity::GameConnected(name) => Msg::ActivityGameConnected(name.to_owned()),
        Activity::GameClosed(name) => Msg::ActivityGameClosed(name.to_owned()),
        Activity::GameUnsupported(name) => Msg::ActivityGameUnsupported(name.to_owned()),
        Activity::Notice(Notice::LapSaved(label)) => Msg::NoticeLapSaved(label),
        Activity::Notice(Notice::LapsSent(n)) => Msg::NoticeLapsSent(n),
        Activity::Notice(Notice::Paired(name)) => Msg::NoticePaired(name),
        Activity::Notice(Notice::NotPaired) => Msg::CloudNotPaired,
        Activity::Notice(Notice::Refused) => Msg::NoticeRefused,
    }
}

/// A click on the carousel (a press that did not move): a square or a side cover brings that game to the middle;
/// elsewhere, left of the middle goes back one and right of it goes on one.
unsafe fn carousel_click(hwnd: HWND, state: &mut State, x: i32, y: i32) {
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
fn choose_lang(state: &mut State, lang: Lang) {
    state.ctx.account.lock().unwrap().lang = lang;
    crate::tray::set_lang_of_running(lang);
}

fn waiting_now(state: &State) -> bool {
    state.tab == Tab::Dash && state.ctx.shared.live().is_none_or(|l| now_ms() - l.at_ms > STALE_MS)
}

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
                let account = state.ctx.account.lock().unwrap().clone();
                match action {
                    Action::Connect => crate::tray::start_connect(&account.server),
                    Action::OpenConnectPage => {
                        if let Some(page) = crate::connect::Flow::global().page() {
                            win::open(&page);
                        }
                    }
                    Action::CancelConnect => crate::connect::Flow::global().cancel(),
                    Action::OpenXpeed => win::open(&format!("{}/sim", account.server)),
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

/// The inside of the window as it opens (pixels), for a screen whose work area is `work_w` x `work_h`: 16:9, about
/// 80% of the work area (1536 x 864 on a 1920 x 1080 screen), never smaller than the smallest window.
fn opening_size(work_w: i32, work_h: i32, scale: f32) -> (i32, i32) {
    let (min_w, min_h) = (MIN_WIDTH as f32 * scale, MIN_HEIGHT as f32 * scale);
    let w = (work_w as f32 * 0.8).min(work_h as f32 * 0.85 * 16.0 / 9.0).max(min_w);
    let h = (w * 9.0 / 16.0).max(min_h);
    (w.round() as i32, h.round() as i32)
}

/// Brings the game covers up to date with the Xpeed server's, once a run (again the next time the window opens when
/// the server could not be reached), off the window's thread; the window reads them again when some changed.
fn fetch_covers_once(hwnd: HWND, server: String) {
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
unsafe fn fetch_brand_if_needed(hwnd: HWND, state: &mut State) {
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
    let mut server = state.ctx.account.lock().map(|a| a.server.clone()).unwrap_or_default();
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
        let server = (*state).ctx.account.lock().map(|a| a.server.clone()).unwrap_or_default();
        fetch_covers_once(hwnd, server);
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
            label: None,
            lang,
        })),
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
    #[test]
    fn a_pedal_bar_fills_with_its_value_and_never_past_the_bar() {
        assert_eq!(pedal_fill(0.0, 50.0), 0.0);
        assert_eq!(pedal_fill(0.5, 50.0), 25.0);
        assert_eq!(pedal_fill(1.0, 50.0), 50.0);
        assert_eq!(pedal_fill(1.7, 50.0), 50.0);
        assert_eq!(pedal_fill(-0.3, 50.0), 0.0);
    }

    #[test]
    fn a_pedal_without_a_value_counts_as_released() {
        assert_eq!(pedal_fill(f32::NAN, 50.0), 0.0);
        assert_eq!(pedal_fill(f32::INFINITY, 50.0), 0.0);
    }

    #[test]
    fn a_pedal_tag_is_the_first_letter_in_capitals() {
        assert_eq!(pedal_tag("Brake"), "B");
        assert_eq!(pedal_tag("embreagem"), "E");
        assert_eq!(pedal_tag(""), "");
    }

    #[test]
    fn the_wheel_bar_fills_toward_the_turn_and_stays_straight_without_a_value() {
        assert_eq!(steer_share(0.0), 0.0);
        assert_eq!(steer_share(0.5), 0.5);
        assert_eq!(steer_share(-1.0), -1.0);
        assert_eq!(steer_share(3.0), 1.0);
        assert_eq!(steer_share(-3.0), -1.0);
        assert_eq!(steer_share(f32::NAN), 0.0);
    }

    /// Whether a box lies between two vertical lines.
    fn within_centre(a: Area, from: f32, to: f32) -> bool {
        a.0 >= from && a.0 + a.2 <= to
    }

    #[test]
    fn the_pedal_bars_and_the_wheel_bar_stay_in_the_centre_column_clear_of_the_side_columns() {
        // The main block (used by the classic, ultrawide, wide and square layouts), then the portrait canvas.
        for (name, cx, top, frame_h, from, to) in [
            ("main", CANVAS_W / 2.0, 100.0, 140.0, MAIN_SIDE_W, CANVAS_W - MAIN_SIDE_W),
            ("portrait", PORTRAIT_W / 2.0, 100.0, 190.0, 0.0, PORTRAIT_W),
        ] {
            let plan = centre_plan(cx, top, frame_h);
            let (fx, fy, fw, fh) = plan.frame;
            for (what, bar) in [
                ("brake", plan.brake),
                ("throttle", plan.throttle),
                ("clutch", plan.clutch),
                ("wheel", plan.steer),
            ] {
                assert!(within_centre(bar, from, to), "{name}: the {what} bar stays in the centre column");
            }
            // The pedals are as tall as the brackets, brake on the left and throttle on the right, outside the frame.
            assert_eq!((plan.brake.1, plan.brake.3), (fy, fh));
            assert_eq!((plan.throttle.1, plan.throttle.3), (fy, fh));
            assert!(plan.brake.0 + plan.brake.2 <= fx, "{name}: the brake is left of the frame");
            assert!(plan.throttle.0 >= fx + fw, "{name}: the throttle is right of the frame");
            // The clutch sits on the outer side of the brake, apart from it, and is thinner.
            assert!(
                plan.clutch.0 + plan.clutch.2 < plan.brake.0 && plan.clutch.2 < plan.brake.2,
                "{name}: clutch"
            );
            // The wheel bar is about the frame's width, under the speed and its unit, above the bottom line.
            assert!((plan.steer.2 - fw).abs() < 1.0);
            assert!(
                plan.steer.1 >= plan.unit.1 + plan.unit.3 && plan.steer.1 + plan.steer.3 <= plan.bottom,
                "{name}: wheel"
            );
            assert!(!overlap(plan.steer, plan.brake) && !overlap(plan.steer, plan.throttle));
            // The letters under the pedals end above the wheel bar.
            assert!(plan.brake.1 + plan.brake.3 + 17.0 <= plan.steer.1 + plan.steer.3);
        }
        // The main block's middle ends above its car strip.
        assert!(centre_plan(CANVAS_W / 2.0, 100.0, 140.0).bottom < STRIP_TOP - 5.0);
    }

    #[test]
    fn the_car_strip_cards_fit_their_row_and_the_least_important_go_first() {
        let (row_y, row_h) = (STRIP_TOP, CANVAS_H - STRIP_TOP - 8.0);
        let all = strip_plan(0.0, row_y, CANVAS_W, row_h);
        let kinds: Vec<CarCard> = all.iter().map(|c| c.0).collect();
        assert_eq!(
            kinds,
            [CarCard::Lights, CarCard::Engine, CarCard::Electronics],
            "the main block has room for all three"
        );
        for (card, area) in &all {
            assert!(inside_box(*area, 0.0, row_y, CANVAS_W, row_h), "{card:?} is inside its row");
            assert!(area.2 >= card.min_w(), "{card:?} is wide enough to read");
        }
        for pair in all.windows(2) {
            assert!(!overlap(pair[0].1, pair[1].1), "cards side by side, not over each other");
            assert!(pair[1].1 .0 > pair[0].1 .0 + pair[0].1 .2, "with a gap");
        }
        // Less room: the engine and fuel card goes first, then electronics; the lights never.
        let two: Vec<CarCard> = strip_plan(0.0, 0.0, 560.0, 100.0).iter().map(|c| c.0).collect();
        assert_eq!(two, [CarCard::Lights, CarCard::Electronics]);
        let one: Vec<CarCard> = strip_plan(0.0, 0.0, 300.0, 100.0).iter().map(|c| c.0).collect();
        assert_eq!(one, [CarCard::Lights]);
        let tiny: Vec<CarCard> = strip_plan(0.0, 0.0, 120.0, 100.0).iter().map(|c| c.0).collect();
        assert_eq!(tiny, [CarCard::Lights], "the lights stay even where they are squeezed");
        // The pills of the lights card stay inside it, in rows that do not overlap.
        let (_, lights) = all[0];
        let inner = (lights.0 + 14.0, lights.1 + 32.0, lights.2 - 28.0, lights.3 - 40.0);
        for n in 1..=9 {
            let cells = pill_cells(inner, n);
            assert_eq!(cells.len(), n);
            for (i, c) in cells.iter().enumerate() {
                assert!(
                    inside_box(*c, inner.0, inner.1, inner.2, inner.3),
                    "pill {i} of {n} inside the card"
                );
                for d in &cells[i + 1..] {
                    assert!(!overlap(*c, *d), "pills of {n} do not overlap");
                }
            }
        }
        // And the other two cards' figures stay inside theirs, however many are known.
        let (_, engine) = all[1];
        let inner = (engine.0 + 14.0, engine.1 + 32.0, engine.2 - 28.0, engine.3 - 40.0);
        for n in 1..=4 {
            for c in cell_grid(inner, n, 2) {
                assert!(inside_box(c, inner.0, inner.1, inner.2, inner.3), "{n} figures in the engine card");
            }
        }
        for (stats, bars) in [(true, true), (true, false), (false, true)] {
            let (s, b) = electronics_split(inner, stats, bars);
            assert!(!overlap(s, b));
            assert!(inside_box(s, inner.0, inner.1, inner.2, inner.3) && inside_box(b, inner.0, inner.1, inner.2, inner.3));
        }
    }

    #[test]
    fn a_light_the_game_does_not_give_is_not_drawn() {
        use crate::game::{CarState, Drs, Flag};
        let mut live = live_reading();
        live.fuel_per_lap_l = None;
        live.state = CarState::UNKNOWN;
        assert!(light_pills(&live).is_empty(), "nothing known, nothing drawn (not even as off)");
        // Only what is given appears, in the fixed order, lit or off.
        live.state.headlights = Some(false);
        live.state.abs_active = Some(true);
        live.state.drs = Some(Drs::Available);
        live.state.flag = Some(Flag::Yellow);
        let kinds: Vec<(PillKind, Glow)> = light_pills(&live).iter().map(|p| (p.kind, p.glow)).collect();
        assert_eq!(
            kinds,
            [
                (PillKind::Abs, Glow::On),
                (PillKind::Drs, Glow::Ready),
                (PillKind::Headlights, Glow::Off),
                (PillKind::Flag, Glow::Off)
            ]
        );
        for hidden in [PillKind::Pit, PillKind::Tc, PillKind::Fuel, PillKind::Engine, PillKind::Handbrake] {
            assert!(light_pills(&live).iter().all(|p| p.kind != hidden), "{hidden:?} is not given");
        }
        live.state.drs = Some(Drs::Open);
        assert_eq!(light_pills(&live)[1].glow, Glow::On, "DRS open is lit");
        // The same in the picture: a light that is not given paints nothing, one that is lit paints its colour.
        let f = fixture();
        let none = {
            let mut l = live_reading();
            l.state = CarState::UNKNOWN;
            l.fuel_per_lap_l = None;
            l
        };
        let lit = {
            let mut l = none.clone();
            l.state.engine_warning = Some(true);
            l.state.handbrake = Some(true);
            l
        };
        let (w, h) = (1032, 602);
        let plain = render(&view(&f, Some(&none), Tab::Dash, 1.0, Lang::En), w, h);
        let drawn = render(&view(&f, Some(&lit), Tab::Dash, 1.0, Lang::En), w, h);
        assert!(has_color(&drawn, RED) > has_color(&plain, RED) + 200, "ENG and HB light up in red");
    }

    #[test]
    fn laps_of_fuel_left_are_computed_and_hidden_without_the_use_per_lap() {
        assert_eq!(fuel_laps_left(30.0, Some(2.0)), Some(15.0));
        assert_eq!(fuel_laps_left(0.0, Some(2.0)), Some(0.0));
        assert_eq!(fuel_laps_left(-1.0, Some(2.0)), Some(0.0), "never below nothing");
        assert_eq!(fuel_laps_left(30.0, None), None, "no use per lap, no laps");
        assert_eq!(fuel_laps_left(30.0, Some(0.0)), None);
        assert_eq!(fuel_laps_left(30.0, Some(f32::NAN)), None);
        assert_eq!(fuel_laps_left(f32::NAN, Some(2.0)), None);
        let mut live = live_reading();
        live.fuel_l = 38.6;
        live.fuel_per_lap_l = Some(2.9);
        assert_eq!(fuel_sub_line(&live, Lang::En).0, "13.3 laps  ·  2.9 L/lap");
        assert_eq!(fuel_sub_line(&live, Lang::Pt).0, "13.3 voltas  ·  2.9 L/volta");
        live.fuel_per_lap_l = None;
        assert_eq!(
            fuel_sub_line(&live, Lang::En).0,
            "",
            "nothing under the fuel until the use per lap is known"
        );
        assert!(engine_cells(&live, Lang::En)
            .iter()
            .all(|c| c.label != text(Lang::En, &Msg::PanelLapsLeft)));
        // The fuel light needs the laps too: under two laps it is lit.
        assert!(light_pills(&live).iter().all(|p| p.kind != PillKind::Fuel));
        live.fuel_per_lap_l = Some(2.9);
        live.fuel_l = 4.0;
        assert_eq!(
            light_pills(&live).iter().find(|p| p.kind == PillKind::Fuel).map(|p| p.glow),
            Some(Glow::On)
        );
        live.fuel_l = 20.0;
        assert_eq!(
            light_pills(&live).iter().find(|p| p.kind == PillKind::Fuel).map(|p| p.glow),
            Some(Glow::Off)
        );
    }

    #[test]
    fn the_engine_and_electronics_cards_keep_only_what_is_known() {
        use crate::game::CarState;
        let mut live = live_reading();
        live.state = CarState::UNKNOWN;
        assert!(electronics_cells(&live, Lang::En).is_empty() && damage_bars(&live, Lang::En).is_empty());
        live.state.water_c = Some(92.0);
        live.fuel_per_lap_l = None;
        let engine = engine_cells(&live, Lang::En);
        assert_eq!(engine.len(), 1, "water alone: oil, use and laps are left out");
        assert_eq!(engine[0].value, "92 °C");
        live.state.tc_level = Some(0);
        live.state.brake_bias = Some(0.56);
        live.state.damage_gearbox = Some(0.4);
        let cells = electronics_cells(&live, Lang::En);
        assert_eq!(cells.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["OFF", "56.0 %"]);
        assert_eq!(damage_bars(&live, Lang::En), [("Gbx".to_owned(), 0.4)]);
        assert_eq!(damage_color(0.0), GREEN);
        assert_eq!(damage_color(0.5), AMBER);
        assert_eq!(damage_color(1.0), RED);
    }

    #[test]
    fn the_brake_disc_and_tyre_colours_follow_their_temperature() {
        assert_eq!(brake_color(100.0), STEEL);
        assert_eq!(brake_color(300.0), GREEN);
        assert_eq!(brake_color(600.0), AMBER);
        assert_eq!(brake_color(800.0), RED);
        assert_eq!(brake_color(f32::NAN), MUTED);
        assert_eq!(tyre_color(50.0), STEEL, "a cold tyre is a calm steel blue");
        assert_eq!(tyre_color(80.0), GREEN);
    }

    use super::*;

    #[test]
    fn a_dragged_carousel_settles_on_a_cover_leaning_the_way_it_was_dragged() {
        let mut c = Carousel::new(0);
        c.hold(0.3);
        assert_eq!(c.at(10), 0.3, "held where the mouse is");
        c.tick(1_000_000);
        assert_eq!(c.at(1_000_000), 0.3, "no moving on by itself while held");
        c.let_go(0.0, 100);
        assert_eq!(c.target, 1, "a third of a cover to the right goes on to the next");
        assert_eq!(c.at(100), 0.3, "and eases from where it was let go");
        assert!((c.at(100 + SLIDE_MS) - 1.0).abs() < 1e-6);
        let mut c = Carousel::new(0);
        c.hold(-0.1);
        c.let_go(0.0, 0);
        assert_eq!(c.target, 0, "a tenth of a cover goes back");
        let mut c = Carousel::new(0);
        c.hold(1.7);
        c.let_go(2.0, 0);
        assert_eq!(c.target, 1, "dragged back past a fifth: the previous cover");
    }

    #[test]
    fn the_waiting_screen_is_about_the_most_interesting_open_game() {
        assert_eq!(focus_of(&[("ac", "Assetto Corsa", Game::Waiting)]), None);
        let games = [
            ("ac", "Assetto Corsa", Game::Waiting),
            ("ams2", "Automobilista 2", Game::Silent),
            ("f1", "EA SPORTS F1 25", Game::Connected),
        ];
        assert_eq!(focus_of(&games), Some(("f1", "EA SPORTS F1 25", Game::Connected)));
        assert_eq!(focus_of(&games[..2]), Some(("ams2", "Automobilista 2", Game::Silent)));
    }

    #[test]
    fn a_game_that_is_loading_ranks_like_one_open_without_data_and_says_to_wait() {
        let loading = ("ams2", "Automobilista 2", Game::Loading);
        assert_eq!(
            focus_of(&[("ac", "Assetto Corsa", Game::Waiting), loading.clone()]),
            Some(loading.clone())
        );
        let silent = ("lmu", "Le Mans Ultimate", Game::Silent);
        // Same rank: the last of the two is the focus, whichever order (so neither beats the other).
        assert_eq!(focus_of(&[loading.clone(), silent.clone()]), Some(silent.clone()));
        assert_eq!(focus_of(&[silent.clone(), loading.clone()]), Some(loading.clone()));
        let paused = ("ac", "Assetto Corsa", Game::Paused);
        assert_eq!(focus_of(&[loading.clone(), paused.clone()]), Some(paused), "paused beats loading");
        let f = fixture();
        let view = view(&f, None, Tab::Dash, 1.0, Lang::En);
        let (title, line, note, act) = focus_words(&view, loading);
        assert_eq!(title, "Automobilista 2 is open");
        assert_eq!(line, text(Lang::En, &Msg::FocusLoading));
        assert!(line.starts_with("Loading"), "{line}");
        assert_eq!(note, None, "no note while it loads");
        assert!(!act, "muted, not the colour of something to do");
        let (_, setup, _, act) = focus_words(&view, silent);
        assert_ne!(setup, line);
        assert!(act, "no data after the wait: there is something to do");
        assert_eq!(state_text(Lang::En, &Game::Loading), "loading");
        assert_eq!(state_color(&Game::Loading), MUTED);
    }

    #[test]
    fn the_window_opens_16_by_9_from_the_screen_it_is_on() {
        assert_eq!(opening_size(1920, 1032, 1.0), (1536, 864), "a 1920 x 1080 screen with its taskbar");
        assert_eq!(opening_size(2560, 1392, 1.0), (2048, 1152));
        assert_eq!(opening_size(1366, 728, 1.0), (1093, 615));
        let (w, h) = opening_size(800, 560, 1.0);
        assert!(w >= MIN_WIDTH && h >= MIN_HEIGHT, "never under the smallest window: {w} x {h}");
    }

    #[test]
    fn each_screen_shape_gets_the_layout_that_fills_it() {
        // The window's body: the window less the header (66) and the margins (16 around).
        let body = |w: f32, h: f32| (w - 32.0, h - 66.0 - 16.0);
        let pick = |w: f32, h: f32| {
            let (bw, bh) = body(w, h);
            pick_layout(bw, bh)
        };
        assert_eq!(pick(2560.0, 1080.0), Layout::Ultrawide);
        assert_eq!(pick(3440.0, 1440.0), Layout::Ultrawide);
        assert_eq!(pick(1920.0, 1080.0), Layout::Wide);
        assert_eq!(pick(1536.0, 864.0), Layout::Wide, "the window as it opens on a 1080p screen");
        assert_eq!(pick(1680.0, 1050.0), Layout::Wide);
        assert_eq!(pick(1024.0, 768.0), Layout::Square);
        assert_eq!(pick(1280.0, 1024.0), Layout::Square);
        assert_eq!(pick(430.0, 900.0), Layout::Portrait);
        assert_eq!(pick(768.0, 1024.0), Layout::Portrait, "a tablet held upright");
        assert_eq!(pick(960.0, 600.0), Layout::Classic, "too small for the column to read well");
        assert_eq!(clock_seconds("1:47.918"), Some(107.918));
        assert_eq!(clock_seconds("-:--.---"), None);
    }

    #[test]
    fn a_click_on_a_cover_goes_there_the_nearest_way() {
        assert_eq!(carousel_steps(0, 3, 9), 3);
        assert_eq!(carousel_steps(0, 7, 9), -2, "round the other side is shorter");
        assert_eq!(carousel_steps(11, 2, 9), 0, "11 is cover 2 after going round once");
        assert_eq!(carousel_steps(-1, 0, 9), 1);
        assert_eq!(carousel_steps(5, 0, 0), 0);
    }

    #[test]
    fn a_line_for_several_games_names_only_those_installed() {
        let ids = ["ac", "acc", "acr"];
        let title = "Assetto Corsa \u{b7} ACC \u{b7} AC Rally";
        assert_eq!(line_title(title, &ids, &ids), title);
        assert_eq!(line_title(title, &ids, &["acc", "acr"]), "ACC \u{b7} AC Rally");
        assert_eq!(
            line_title(title, &ids, &["acc"]),
            "Assetto Corsa Competizione",
            "one game: its full name"
        );
        assert_eq!(line_title("iRacing", &["iracing"], &["iracing"]), "iRacing");
    }

    #[test]
    fn games_list_fits_its_room_and_scrolls_the_rest() {
        // Plenty of room: full-height lines, no scrolling.
        assert_eq!(games_layout(7, 1000.0), (50.0 + 52.0 * 7.0, 52.0, 0.0));
        // Less: lower lines, still no scrolling.
        let (h, row, max) = games_layout(7, 400.0);
        assert!((44.0..52.0).contains(&row) && max == 0.0 && h <= 400.0);
        // Too little: the card fills its room exactly and the rest of the list scrolls.
        for room in [94.0, 150.0, 250.0] {
            let (h, row, max) = games_layout(7, room);
            assert_eq!(row, 44.0);
            assert_eq!(h, room);
            assert_eq!(max, 44.0 * 7.0 - (room - 50.0), "{room}");
        }
    }

    #[test]
    fn buttons_wrap_to_a_new_line_when_the_card_is_narrow() {
        assert_eq!(button_lines(&[200.0, 180.0], 400.0), vec![(0, 0.0), (0, 210.0)]);
        assert_eq!(button_lines(&[200.0, 180.0], 300.0), vec![(0, 0.0), (1, 0.0)]);
        assert_eq!(
            button_lines(&[320.0], 300.0),
            vec![(0, 0.0)],
            "a lone button stays on the first line"
        );
    }
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
        frame.tyres = Some(
            [(84.0, 26.9, 0.91), (88.0, 27.2, 0.9), (97.0, 26.4, 0.86), (101.0, 26.6, 0.84)].map(|(t, psi, left)| crate::game::Tyre {
                brake_c: t * 3.4,
                temp_c: t,
                pressure_kpa: psi * 6.894_757,
                left,
            }),
        );
        let mut live = tracker.on_frame("Assetto Corsa", &frame, 1_000);
        let track: Vec<(f32, f32)> = (0..400)
            .map(|i| {
                let t = i as f32 / 400.0 * std::f32::consts::TAU;
                (600.0 * t.cos() + 130.0 * (3.0 * t).cos(), 300.0 * t.sin() - 110.0 * (2.0 * t).sin())
            })
            .collect();
        live.pos = Some(track[160]);
        live.map = Some(std::sync::Arc::new(track));
        live.map_complete = true;
        live.best_lap_s = Some(107.204);
        live.delta_s = Some(-0.27);
        live.fuel_per_lap_l = Some(2.9);
        live.state = crate::game::CarState {
            pit_limiter: Some(false),
            abs_active: Some(true),
            tc_active: Some(false),
            drs: Some(crate::game::Drs::Available),
            headlights: Some(true),
            handbrake: Some(false),
            engine_warning: Some(false),
            flag: Some(crate::game::Flag::Yellow),
            water_c: Some(92.0),
            oil_c: Some(108.0),
            tc_level: Some(3),
            abs_level: Some(2),
            engine_map: Some(1),
            brake_bias: Some(0.56),
            damage_body: Some(0.12),
            damage_engine: Some(0.0),
            damage_gearbox: Some(0.05),
            damage_suspension: Some(0.4),
        };
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
                    key: "lmu",
                    title: "Le Mans Ultimate".into(),
                    state: Game::Waiting,
                },
                GameRow {
                    key: "ac",
                    title: "Assetto Corsa · ACC · AC Rally".into(),
                    state: Game::Recording(4),
                },
                GameRow {
                    key: "ams2",
                    title: "Automobilista 2".into(),
                    state: Game::Waiting,
                },
                GameRow {
                    key: "iracing",
                    title: "iRacing".into(),
                    state: Game::Connected,
                },
                GameRow {
                    key: "rfactor1",
                    title: "Stock Car Extreme".into(),
                    state: Game::Unsupported,
                },
            ],
            laps: vec![
                "Lap 1  1:49.002".into(),
                "Lap 2  1:48.115 (not valid)".into(),
                "Lap 3  1:47.918".into(),
            ],
            log: vec![
                ("21:47".into(), "Lap saved: Lap 3  1:47.918".into()),
                ("21:45".into(), "Lap saved: Lap 2  1:48.115".into()),
                ("21:43".into(), "Lap saved: Lap 1  1:49.002".into()),
                ("21:41".into(), "Assetto Corsa connected".into()),
                ("21:40".into(), "Connected as RIG".into()),
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
            card: crate::connect::card(
                matches!(f.snapshot.cloud, Cloud::Idle | Cloud::Waiting(_)),
                &crate::connect::Phase::Idle,
                Some("ana@example.com"),
                "https://xpeed.skale.club",
            ),
            recent_laps: &f.laps,
            activity: &f.log,
            covers: &[],
            brands: &[],
            mouse: None,
            buttons: Default::default(),
            carousel: 0.0,
            games_scroll: 0.0,
            scroll: Default::default(),
            carousel_step: Default::default(),
            lang_open: false,
            focus: None,
        }
    }

    #[test]
    fn paints_the_dashboard_with_the_gear_in_the_accent_colour_and_the_delta_in_green() {
        let f = fixture();
        let live = live_reading();
        let (w, h) = (960, 600);
        let pixels = render(&view(&f, Some(&live), Tab::Dash, 1.0, Lang::En), w, h);
        save(&pixels, w, h, "panel-dashboard.png");
        assert!(pixels[..3].iter().all(|&c| c < 0x24), "the corner is the dark background");
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

    /// The boxes the tyre schematic gets in each layout that shows it (the area under the "Tyres" title).
    const SCHEMATIC_BOXES: [(&str, f32, f32); 5] = [
        ("side column, short", 312.0, 192.0),
        ("side column, tall", 312.0, 255.0),
        ("4:3 bottom row", 490.0, 266.0),
        ("portrait", 336.0, 276.0),
        ("narrow", 200.0, 120.0),
    ];

    fn inside_box(a: Area, x: f32, y: f32, w: f32, h: f32) -> bool {
        let eps = 0.01;
        a.0 >= x - eps && a.1 >= y - eps && a.0 + a.2 <= x + w + eps && a.1 + a.3 <= y + h + eps
    }

    fn overlap(a: Area, b: Area) -> bool {
        a.2 > 0.0 && b.2 > 0.0 && a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
    }

    #[test]
    fn the_tyre_schematic_fits_its_box_in_every_layout_without_text_over_a_tyre() {
        for brakes in [true, false] {
            for (name, w, h) in SCHEMATIC_BOXES {
                let (x, y) = (7.0, 11.0);
                let plan = schematic(x, y, w, h, brakes);
                for i in 0..4 {
                    assert!(inside_box(plan.tyres[i], x, y, w, h), "{name}: tyre {i} is inside the box");
                    assert!(inside_box(plan.readout[i], x, y, w, h), "{name}: readout {i} is inside the box");
                    assert!(plan.tyres[i].2 < plan.tyres[i].3, "{name}: a tyre is longer than it is wide");
                    assert!(!overlap(plan.readout[i], plan.tyres[i]), "{name}: readout {i} clear of its tyre");
                    assert!(inside_box(plan.body, x, y, w, h), "{name}: the car's body is inside the box");
                    for j in 0..4 {
                        if i != j {
                            assert!(!overlap(plan.tyres[i], plan.tyres[j]), "{name}: tyres {i} and {j} apart");
                            assert!(!overlap(plan.readout[i], plan.tyres[j]), "{name}: readout {i} off tyre {j}");
                        }
                    }
                    if brakes {
                        assert!(inside_box(plan.brake[i], x, y, w, h), "{name}: brake row {i} inside");
                        assert!(!overlap(plan.brake[i], plan.tyres[i]), "{name}: brake row {i} clear of the tyre");
                        for j in 0..4 {
                            assert!(!overlap(plan.brake[i], plan.readout[j]), "{name}: brake {i} clear of readout {j}");
                        }
                    } else {
                        assert_eq!(plan.brake[i].3, 0.0, "{name}: no brake row without brake temperatures");
                    }
                }
                // The readouts of a side have room for "100°" and "25.3 psi" (about 70 units), except in the
                // narrowest box.
                if w >= 300.0 {
                    assert!(plan.readout[0].2 >= 70.0 && plan.readout[1].2 >= 70.0, "{name}: room for text");
                }
            }
        }
    }

    #[test]
    fn the_tyre_schematic_is_the_car_seen_from_above_with_brakes_at_its_ends() {
        let (x, y, w, h) = (0.0, 0.0, 340.0, 240.0);
        let plan = schematic(x, y, w, h, true);
        let [fl, fr, rl, rr] = plan.tyres;
        assert_eq!(fl.1, fr.1, "the fronts side by side, level");
        assert_eq!(rl.1, rr.1, "the rears side by side, level");
        assert!(fl.1 + fl.3 < rl.1, "front above rear, the body between");
        // Symmetric around the middle.
        let mid = w / 2.0;
        assert!(((fl.0 + fl.2 / 2.0 + fr.0 + fr.2 / 2.0) / 2.0 - mid).abs() < 1e-3);
        assert!(((fl.0 + fl.2) - (mid - (fr.0 - mid))).abs() < 1e-3);
        assert!(
            (plan.body.0 + plan.body.2 / 2.0 - mid).abs() < 1e-3,
            "the body is on the centre line"
        );
        // Fronts' brake above the tyre, rears' below.
        assert!(plan.brake[0].1 + plan.brake[0].3 <= fl.1 && plan.brake[1].1 + plan.brake[1].3 <= fr.1);
        assert!(plan.brake[2].1 >= rl.1 + rl.3 && plan.brake[3].1 >= rr.1 + rr.3);
        // The tyres sit partly outside the body: the inner edge of each is inside it, the outer edge beyond it.
        let (bx, _, bw, _) = plan.body;
        for t in plan.tyres {
            let (inner, outer) = if t.0 < mid { (t.0 + t.2, t.0) } else { (t.0, t.0 + t.2) };
            assert!(inner > bx && inner < bx + bw, "the inner edge of a tyre is over the body");
            assert!(outer < bx || outer > bx + bw, "the outer edge of a tyre is outside the body");
        }
        // The body runs from the front tyres to the rear ones.
        assert!(plan.body.1 <= fl.1 + fl.3 / 2.0 && plan.body.1 + plan.body.3 >= rl.1 + rl.3 / 2.0);
        // Left tyres' readouts end before their tyre, right tyres' start after it.
        assert!(plan.readout[0].0 + plan.readout[0].2 < fl.0);
        assert!(plan.readout[1].0 > fr.0 + fr.2);
        // The outline of the car stays inside the body's box and is the same on both sides.
        let outline = body_outline(plan.body);
        assert!(outline.iter().all(|&(px, py)| inside_box(
            (px, py, 0.0, 0.0),
            plan.body.0 - 0.01,
            plan.body.1 - 0.01,
            plan.body.2 + 0.02,
            plan.body.3 + 0.02
        )));
        let n = outline.len() / 2;
        for k in 0..n {
            let (right, left) = (outline[k], outline[outline.len() - 1 - k]);
            assert!((right.0 + left.0 - 2.0 * mid).abs() < 1e-3 && (right.1 - left.1).abs() < 1e-3);
        }
    }

    #[test]
    fn the_schematic_is_painted_for_every_shape_and_a_brake_only_tyre_gets_its_row() {
        let f = fixture();
        let mut live = live_reading();
        let with_brakes = {
            let v = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
            render(&v, 1536, 864)
        };
        // A game that gives no brake temperatures: the rows are not kept and the picture still paints.
        for t in live.tyres.as_mut().unwrap() {
            t.brake_c = f32::NAN;
        }
        let without = {
            let v = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
            render(&v, 1536, 864)
        };
        assert_ne!(with_brakes, without);
        // Brake temperatures alone (no tyre temperature, pressure or wear): still a schematic.
        let tyre = crate::game::Tyre {
            brake_c: 400.0,
            temp_c: f32::NAN,
            pressure_kpa: f32::NAN,
            left: f32::NAN,
        };
        live.tyres = Some([tyre; 4]);
        for (w, h) in [(1536, 864), (1024, 768), (540, 1080)] {
            let v = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
            assert!(!render(&v, w, h).is_empty());
        }
    }

    /// With `XPEED_SIM_PANEL_PNG` set, paints the panel the way people see it (a window, full HD, an ultrawide, the
    /// other tabs) into that folder with a page that shows them and reloads itself when they change, to review the
    /// design in a browser (`.claude/launch.json`: xpeed-sim-panel-preview). Without it, nothing.
    #[test]
    fn a_whole_lap_closes_with_a_start_mark_and_a_partial_path_stays_open_and_breaks_at_jumps() {
        let lap: Vec<(f32, f32)> = (0..200)
            .map(|i| {
                let a = i as f32 / 200.0 * std::f32::consts::TAU;
                (300.0 * a.cos(), 100.0 * a.sin())
            })
            .collect();
        let whole = prepare_map(&lap, true, 200.0, 100.0, 400.0, 200.0).unwrap();
        assert_eq!(whole.runs.len(), 1);
        assert_eq!(whole.runs[0].first(), whole.runs[0].last(), "a whole lap closes");
        assert!(whole.start.is_some());
        let partial = prepare_map(&lap[..150], false, 200.0, 100.0, 400.0, 200.0).unwrap();
        assert_ne!(
            partial.runs[0].first(),
            partial.runs[0].last(),
            "a partial path is not joined back to its start"
        );
        assert!(partial.start.is_none());
        let mut jumped = lap[..100].to_vec();
        jumped.extend(lap[..100].iter().map(|&(x, z)| (x + 2000.0, z)));
        assert_eq!(prepare_map(&jumped, false, 200.0, 100.0, 400.0, 200.0).unwrap().runs.len(), 2);
        // The car is placed with the map's own transform: the first point of the lap is the start mark's place.
        let at = whole.fit.apply(lap[0]);
        assert!(whole.runs[0].iter().any(|p| (p.0 - at.0).hypot(p.1 - at.1) < 8.0));
        // Everything lies in the box, with its margin.
        assert!(whole.runs[0]
            .iter()
            .all(|p| (0.0..=400.0).contains(&p.0) && (0.0..=200.0).contains(&p.1)));
    }

    #[test]
    fn writes_the_design_preview_page() {
        let Some(dir) = std::env::var_os("XPEED_SIM_PANEL_PNG") else {
            return;
        };
        let f = fixture();
        let live = live_reading();
        let mut pits = live.clone();
        pits.in_pits = true;
        pits.lap_valid = Some(false);
        pits.delta_s = Some(0.43);
        pits.throttle = 0.0;
        pits.brake = 0.8;
        pits.state.pit_limiter = Some(true);
        pits.state.engine_warning = Some(true);
        pits.state.handbrake = Some(true);
        pits.state.drs = Some(crate::game::Drs::Open);
        pits.state.flag = Some(crate::game::Flag::Chequered);
        pits.state.water_c = Some(118.0);
        pits.state.oil_c = Some(135.0);
        pits.state.damage_body = Some(0.7);
        pits.state.damage_engine = Some(0.9);
        pits.fuel_l = 4.4;
        let mut unknown = live.clone();
        unknown.state = crate::game::CarState::UNKNOWN;
        unknown.fuel_per_lap_l = None;
        unknown.clutch = f32::NAN;
        let shots = [
            (
                "preview-window.png",
                "Window as it opens on a 1920 × 1080 screen (1536 × 864)",
                Some(&live),
                Tab::Dash,
                Lang::En,
                1536,
                864,
                1.0,
            ),
            (
                "preview-full-hd.png",
                "Full screen, 1920 × 1080",
                Some(&live),
                Tab::Dash,
                Lang::En,
                1920,
                1080,
                1.0,
            ),
            (
                "preview-ultrawide.png",
                "Full screen, ultrawide 2560 × 1080",
                Some(&pits),
                Tab::Dash,
                Lang::Pt,
                2560,
                1080,
                1.0,
            ),
            ("preview-monitor.png", "Monitor tab", None, Tab::Monitor, Lang::En, 1280, 800, 1.0),
            (
                "preview-waiting.png",
                "Waiting for a game",
                None,
                Tab::Dash,
                Lang::En,
                960,
                600,
                1.0,
            ),
            (
                "preview-4x3.png",
                "4:3 window (1024 × 768)",
                Some(&live),
                Tab::Dash,
                Lang::En,
                1024,
                768,
                1.0,
            ),
            (
                "preview-phone.png",
                "Phone held upright (540 × 1080)",
                Some(&live),
                Tab::Dash,
                Lang::En,
                540,
                1080,
                1.0,
            ),
            (
                "preview-small.png",
                "Smallest window (720 × 480)",
                Some(&live),
                Tab::Dash,
                Lang::En,
                720,
                480,
                1.0,
            ),
        ];
        let mut figures = String::new();
        for (file, caption, reading, w, h) in [
            (
                "preview-unknown-state.png",
                "A game that gives no lights, temperatures or damage (1920 × 1080)",
                &unknown,
                1920,
                1080,
            ),
            (
                "preview-unknown-phone.png",
                "The same on a phone held upright (430 × 900)",
                &unknown,
                430,
                900,
            ),
            (
                "preview-hot-phone.png",
                "Everything lit, in the pits, low on fuel (430 × 900)",
                &pits,
                430,
                900,
            ),
            (
                "preview-classic.png",
                "Classic, the smallest window that shows the whole dashboard (1032 × 602)",
                &live,
                1032,
                602,
            ),
        ] {
            let pixels = render(&view(&f, Some(reading), Tab::Dash, 1.0, Lang::En), w, h);
            save(&pixels, w, h, file);
            figures.push_str(&format!(
                "<figure><figcaption>{caption}</figcaption><img data-src=\"{file}\" width=\"{w}\" height=\"{h}\"></figure>
"
            ));
        }
        let covers = CoverArt::load(None);
        let mut hover = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
        let [_, _, _, full_button, _] = header_hits(960, 1.0);
        hover.mouse = Some((full_button.left + 5, full_button.top + 5));
        let pixels = render(&hover, 960, 600);
        save(&pixels, 960, 600, "preview-tooltip.png");
        figures.push_str("<figure><figcaption>Icon buttons, with the tooltip of the one under the mouse</figcaption><img data-src=\"preview-tooltip.png\" width=\"960\" height=\"600\"></figure>\n");
        let mut with_covers = view(&f, None, Tab::Dash, 1.0, Lang::En);
        with_covers.covers = &covers;
        with_covers.carousel = 9.0;
        let mut unpaired = fixture();
        unpaired.snapshot.cloud = Cloud::NotPaired;
        let mut monitor_covers = view(&unpaired, None, Tab::Monitor, 1.0, Lang::En);
        monitor_covers.covers = &covers;
        let pixels = render(&monitor_covers, 1280, 800);
        save(&pixels, 1280, 800, "preview-monitor-covers.png");
        figures.push_str("<figure><figcaption>Monitor tab, with the covers from the Xpeed server</figcaption><img data-src=\"preview-monitor-covers.png\" width=\"1280\" height=\"800\"></figure>\n");
        let mut waiting_card = view(&f, None, Tab::Monitor, 1.0, Lang::En);
        waiting_card.card = connect::Card::Waiting;
        let pixels = render(&waiting_card, 1280, 800);
        save(&pixels, 1280, 800, "preview-monitor-connecting.png");
        figures.push_str("<figure><figcaption>Monitor tab while the browser page waits for the click on Connect</figcaption><img data-src=\"preview-monitor-connecting.png\" width=\"1280\" height=\"800\"></figure>\n");
        let mut expired_card = view(&unpaired, None, Tab::Monitor, 1.0, Lang::En);
        expired_card.card = connect::Card::NotConnected {
            note: Some(connect::Note::Expired),
        };
        let pixels = render(&expired_card, 1280, 800);
        save(&pixels, 1280, 800, "preview-monitor-expired.png");
        figures.push_str("<figure><figcaption>Monitor tab after the request expired</figcaption><img data-src=\"preview-monitor-expired.png\" width=\"1280\" height=\"800\"></figure>\n");
        let mut open = view(&f, None, Tab::Dash, 1.0, Lang::Pt);
        open.covers = &covers;
        open.lang_open = true;
        let [_, _, lang_button, _, _] = header_hits(960, 1.0);
        open.mouse = Some((lang_button.right - 100, lang_button.bottom + 6 + 6 + 40 * 2 + 20));
        let pixels = render(&open, 960, 600);
        save(&pixels, 960, 600, "preview-languages.png");
        figures.push_str("<figure><figcaption>The language list, open (Portuguese in use, the mouse on Español)</figcaption><img data-src=\"preview-languages.png\" width=\"960\" height=\"600\"></figure>\n");
        // The dashboard on the common screen shapes, and a phone held upright.
        let mut tall_window = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
        tall_window.recent_laps = &f.laps;
        for (file, caption, w, h) in [
            ("preview-shape-21x9.png", "Ultrawide 21:9 (2560 × 1080)", 2560, 1080),
            ("preview-shape-16x9.png", "16:9 (1920 × 1080)", 1920, 1080),
            ("preview-shape-16x10.png", "16:10 (1680 × 1050)", 1680, 1050),
            ("preview-shape-4x3.png", "4:3 (1024 × 768)", 1024, 768),
            ("preview-shape-5x4.png", "5:4 (1280 × 1024)", 1280, 1024),
            ("preview-shape-phone.png", "Phone held upright (430 × 900)", 430, 900),
        ] {
            let pixels = render(&tall_window, w, h);
            save(&pixels, w, h, file);
            figures.push_str(&format!(
                "<figure><figcaption>{caption}</figcaption><img data-src=\"{file}\" width=\"{w}\" height=\"{h}\"></figure>\n"
            ));
        }
        let mut phone_monitor = view(&unpaired, None, Tab::Monitor, 1.0, Lang::En);
        phone_monitor.covers = &covers;
        let pixels = render(&phone_monitor, 430, 900);
        save(&pixels, 430, 900, "preview-phone-monitor.png");
        figures.push_str("<figure><figcaption>Monitor tab on a phone held upright</figcaption><img data-src=\"preview-phone-monitor.png\" width=\"430\" height=\"900\"></figure>\n");
        let mut phone_wait = view(&f, None, Tab::Dash, 1.0, Lang::Pt);
        phone_wait.covers = &covers;
        phone_wait.focus = Some(("ams2", "Automobilista 2", Game::Silent));
        let pixels = render(&phone_wait, 430, 900);
        save(&pixels, 430, 900, "preview-phone-open.png");
        figures.push_str("<figure><figcaption>A game open without data, on a phone held upright</figcaption><img data-src=\"preview-phone-open.png\" width=\"430\" height=\"900\"></figure>\n");
        for (file, caption, game) in [
            (
                "preview-open-no-data.png",
                "A game open without data: what to switch on",
                Game::Silent,
            ),
            (
                "preview-open-connected.png",
                "A game connected, the driver not on track yet",
                Game::Connected,
            ),
        ] {
            let mut open_game = view(&f, None, Tab::Dash, 1.0, Lang::Pt);
            open_game.covers = &covers;
            open_game.focus = Some(("ams2", "Automobilista 2", game));
            let pixels = render(&open_game, 1280, 720);
            save(&pixels, 1280, 720, file);
            figures.push_str(&format!(
                "<figure><figcaption>{caption}</figcaption><img data-src=\"{file}\" width=\"1280\" height=\"720\"></figure>\n"
            ));
        }
        monitor_covers.games_scroll = 30.0;
        let pixels = render(&monitor_covers, 720, 480);
        save(&pixels, 720, 480, "preview-monitor-small.png");
        figures.push_str("<figure><figcaption>Monitor tab in the smallest window (720 × 480): everything stays in its card, the games list scrolls</figcaption><img data-src=\"preview-monitor-small.png\" width=\"720\" height=\"480\"></figure>\n");
        let pixels = render(&with_covers, 1280, 720);
        save(&pixels, 1280, 720, "preview-covers.png");
        figures.push_str("<figure><figcaption>Waiting for a game, with the covers from the Xpeed server</figcaption><img data-src=\"preview-covers.png\" width=\"1280\" height=\"720\"></figure>\n");
        for (file, caption, reading, tab, lang, w, h, scale) in shots {
            let pixels = render(&view(&f, reading, tab, scale, lang), w, h);
            save(&pixels, w, h, file);
            figures.push_str(&format!(
                "<figure><figcaption>{caption}</figcaption><img data-src=\"{file}\" width=\"{w}\" height=\"{h}\"></figure>\n"
            ));
        }
        let stamp = crate::util::now_ms().to_string();
        let page = format!(
            r#"<!doctype html><html><head><meta charset="utf-8"><title>Xpeed Companion panel</title>
<style>
body {{ margin: 0; background: #050607; color: #c9ccd2; font: 14px "Segoe UI", sans-serif; }}
header {{ position: sticky; top: 0; padding: 12px 24px; background: #0c0d0fee; border-bottom: 1px solid #25282e; display: flex; gap: 16px; align-items: baseline; z-index: 1; }}
header b {{ color: #f5e663; font-size: 16px; }}
main {{ padding: 24px; display: grid; gap: 32px; }}
figure {{ margin: 0; }}
figcaption {{ margin-bottom: 8px; color: #7c828c; text-transform: uppercase; letter-spacing: .08em; font-size: 12px; }}
img {{ display: block; max-width: 100%; height: auto; border: 1px solid #25282e; border-radius: 8px; }}
</style></head><body>
<header><b>Xpeed Companion panel</b><span>drawn by the program's own code · updates by itself</span><span id="when"></span></header>
<main>
{figures}</main>
<script>
let shown = "";
async function look() {{
  try {{
    const stamp = (await (await fetch("stamp.txt?" + Date.now())).text()).trim();
    if (stamp && shown && stamp !== shown) {{
      // Redrawn: load the page again, since the list of pictures can change too.
      location.reload();
      return;
    }}
    if (stamp && stamp !== shown) {{
      shown = stamp;
      document.querySelectorAll("img[data-src]").forEach(img => img.src = img.dataset.src + "?" + stamp);
      document.getElementById("when").textContent = "updated " + new Date(Number(stamp)).toLocaleTimeString();
    }}
  }} catch (e) {{}}
}}
look(); setInterval(look, 1500);
</script></body></html>"#
        );
        let dir = std::path::Path::new(&dir);
        std::fs::write(dir.join("index.html"), page).unwrap();
        std::fs::write(dir.join("stamp.txt"), stamp).unwrap();
    }

    #[test]
    fn the_header_can_be_clicked_where_it_is_drawn() {
        let [dash, mon, lang, full, top] = header_hits(960, 1.0);
        assert!(inside(&dash, 20, 20) && !inside(&dash, 150, 20));
        assert!(inside(&mon, 160, 20));
        assert!(inside(&lang, 834, 20) && !inside(&lang, 853, 20));
        assert!(inside(&full, 880, 20) && !inside(&full, 899, 20));
        assert!(inside(&top, 920, 20) && !inside(&top, 920, 52));
        assert!(
            lang.right < full.left && full.right < top.left && mon.right < lang.left,
            "nothing overlaps"
        );
        let [dash2, _, _, _, top2] = header_hits(1440, 1.5);
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

    /// How long a frame takes to draw, by screen: `cargo test frame_times -- --ignored --nocapture`. Not run by
    /// default (it needs this computer's covers and measures, it does not check).
    #[test]
    #[ignore]
    fn frame_times() {
        let f = fixture();
        let live = live_reading();
        let covers = CoverArt::load(None);
        for (name, reading, tab) in [
            ("carousel", None, Tab::Dash),
            ("dashboard", Some(&live), Tab::Dash),
            ("monitor", None, Tab::Monitor),
        ] {
            let mut v = view(&f, reading, tab, 1.0, Lang::En);
            v.covers = &covers;
            let (w, h) = (1920, 1080);
            render(&v, w, h);
            let start = std::time::Instant::now();
            let frames = 30;
            for i in 0..frames {
                v.carousel = i as f32 * 0.1;
                render(&v, w, h);
            }
            println!(
                "{name}: {:.1} ms a frame at {w}x{h}",
                start.elapsed().as_secs_f64() * 1000.0 / frames as f64
            );
        }
        // The parts of a carousel frame, alone.
        let (w, h) = (1920, 1080);
        let time = |label: &str, draw: &dyn Fn(&mut Painter)| unsafe {
            let hdc = CreateCompatibleDC(null_mut());
            let bitmap = dib(hdc, w, h);
            let old = SelectObject(hdc, bitmap);
            let mut g = Painter::new(hdc, 1.0);
            let start = std::time::Instant::now();
            for _ in 0..30 {
                draw(&mut g);
            }
            println!("  {label}: {:.2} ms", start.elapsed().as_secs_f64() * 1000.0 / 30.0);
            drop(g);
            SelectObject(hdc, old);
            DeleteObject(bitmap);
            DeleteDC(hdc);
        };
        if let Some(image) = covers.iter().find(|c| !c.image.is_null()).map(|c| c.image) {
            time("one cover image 283x425", &|g| g.image_exact((100.0, 100.0, 283.0, 425.0), image));
        }
        time("one veil 283x425", &|g| g.veil_exact((100.0, 100.0, 283.0, 425.0), BG, 0.5));
        time("backdrop (kept)", &|g| g.backdrop(w, h));
        time("rev bar", &|g| g.rev_bar(0.0, 0.0, 1360.0, 36.0, 0.9, false));
        time("text 34px", &|g| {
            g.text(
                "Waiting for a game",
                rect(0, 0, 900, 60),
                34.0,
                FW_SEMIBOLD as i32,
                Face::Num,
                TEXT,
                DT_CENTER,
            )
        });
    }

    #[test]
    fn the_dashboard_canvas_fills_the_window_and_keeps_its_shape() {
        let (s, ox, oy) = canvas_fit_wh(rect(16, 58, 944, 584), CANVAS_W, CANVAS_H);
        assert!((s - 0.928).abs() < 0.001 && ox == 16, "{s} {ox}");
        assert_eq!(oy, 58 + ((526.0 - 520.0 * s) / 2.0).round() as i32);
        let (s, ox, _) = canvas_fit_wh(rect(16, 58, 1904, 1064), CANVAS_W, CANVAS_H);
        assert!((s - 1.888).abs() < 0.001, "full HD: {s}");
        assert_eq!(ox, 16);
        let (s, ox, oy) = canvas_fit_wh(rect(0, 0, 3000, 520), CANVAS_W, CANVAS_H);
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
        assert_eq!(mix(rgb(0, 0, 0), rgb(200, 100, 50), 0.5), rgb(100, 50, 25));
    }

    #[test]
    fn a_lap_label_splits_into_name_time_and_the_invalid_flag() {
        let part = |name, time, invalid| LapLabel { name, time, invalid };
        assert_eq!(lap_parts("Lap 3  1:47.918"), part("Lap 3", "1:47.918", false));
        assert_eq!(lap_parts("Lap 5  3:27.250 (not valid)"), part("Lap 5", "3:27.250", true));
        assert_eq!(lap_parts("odd"), part("odd", "", false));
        assert_eq!(lap_parts(""), part("", "", false));
        assert_eq!(lap_parts("Lap 7  (not valid)"), part("Lap 7", "", true));
        // The mark is only the label's tail, not part of its name.
        assert_eq!(lap_parts("Lap (not valid)  1:00.000"), part("Lap (not valid)", "1:00.000", false));
    }

    #[test]
    fn the_fastest_lap_is_never_an_invalid_one() {
        let laps: Vec<_> = ["Lap 1  1:49.002", "Lap 2  1:40.000 (not valid)", "Lap 3  1:47.918"]
            .into_iter()
            .map(lap_parts)
            .collect();
        assert_eq!(fastest_valid(&laps), Some(107.918));
        let only_invalid = [lap_parts("Lap 1  1:40.000 (not valid)")];
        assert_eq!(fastest_valid(&only_invalid), None);
        assert_eq!(fastest_valid(&[]), None);
    }

    #[test]
    fn a_time_that_does_not_fit_gets_a_smaller_size_but_never_below_the_floor() {
        assert_eq!(fit_size(80.0, 30.0, 100.0, 14.0), 30.0, "fits: unchanged");
        assert_eq!(fit_size(200.0, 30.0, 100.0, 14.0), 15.0, "twice too wide: half the size");
        assert_eq!(fit_size(1000.0, 30.0, 100.0, 14.0), 14.0, "far too wide: the floor");
        assert_eq!(fit_size(1000.0, 10.0, 100.0, 14.0), 10.0, "a size under the floor is left alone");
        assert_eq!(fit_size(0.0, 30.0, 100.0, 14.0), 30.0);
    }

    #[test]
    fn the_carousel_slides_with_an_ease_goes_round_and_moves_on_by_itself() {
        let mut c = Carousel::new(1_000);
        assert_eq!(c.at(1_000), 0.0);
        c.step(1, 1_000);
        let half = c.at(1_000 + SLIDE_MS / 2);
        assert!((half - 0.5).abs() < 1e-3, "eased in and out: half way at half time ({half})");
        let quarter = c.at(1_000 + SLIDE_MS / 4);
        assert!(quarter < 0.1, "gently away ({quarter})");
        assert_eq!(c.at(1_000 + SLIDE_MS), 1.0);
        c.tick(1_000 + SLIDE_MS + DWELL_MS - 1);
        assert_eq!(c.target, 1, "not yet");
        c.tick(1_000 + SLIDE_MS + DWELL_MS);
        assert_eq!(c.target, 2, "on by itself");
        // Going round: cover 0 is just right of the middle when the carousel is at the last cover.
        assert_eq!(carousel_offset(0, 10, 9.0), 1.0);
        assert_eq!(carousel_offset(9, 10, 0.0), -1.0);
        assert_eq!(carousel_offset(3, 10, 2.5), 0.5);
    }

    #[test]
    fn shows_the_gears_either_side() {
        assert_eq!(neighbour_gears(4.0, None), (Some("3".into()), Some("5".into())));
        assert_eq!(neighbour_gears(1.0, None), (Some("N".into()), Some("2".into())));
        assert_eq!(neighbour_gears(0.0, None), (Some("R".into()), Some("1".into())));
        assert_eq!(neighbour_gears(-1.0, None), (None, Some("N".into())));
        assert_eq!(neighbour_gears(f32::NAN, None), (None, None));
        assert_eq!(
            neighbour_gears(6.0, None),
            (Some("5".into()), Some("7".into())),
            "unknown count: as before"
        );
    }

    #[test]
    fn the_top_gear_has_nothing_above_it_when_the_count_is_known() {
        assert_eq!(
            neighbour_gears(6.0, Some(6)),
            (Some("5".into()), None),
            "top gear of a 6-speed: no 7"
        );
        assert_eq!(neighbour_gears(5.0, Some(6)), (Some("4".into()), Some("6".into())));
        assert_eq!(
            neighbour_gears(7.0, Some(6)),
            (Some("6".into()), None),
            "past the count is still the top"
        );
        assert_eq!(neighbour_gears(1.0, Some(1)), (Some("N".into()), None), "a one-speed car");
        // Neutral and reverse keep their neighbours whatever the count.
        assert_eq!(neighbour_gears(0.0, Some(6)), (Some("R".into()), Some("1".into())));
        assert_eq!(neighbour_gears(-1.0, Some(6)), (None, Some("N".into())));
        assert_eq!(neighbour_gears(f32::NAN, Some(6)), (None, None));
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
