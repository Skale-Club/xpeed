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
    GdipDeletePen, GdipDisposeImage, GdipDrawImageRectI, GdipDrawLine, GdipDrawPath, GdipFillPath, GdipGetImageThumbnail,
    GdipSetInterpolationMode, GdipSetLinePresetBlend, GdipSetPixelOffsetMode, GdipSetSmoothingMode, GdiplusStartup, GdiplusStartupInput,
    GpGraphics, GpImage, GpPath, InterpolationModeHighQualityBicubic, PixelOffsetModeHalf, PointF, SmoothingModeAntiAlias, UnitPixel,
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
    CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyWindow, DispatchMessageW, GetClientRect, GetMessageW, GetWindowLongPtrW, IsWindow,
    KillTimer, LoadCursorW, PostQuitMessage, RegisterClassExW, SendMessageW, SetForegroundWindow, SetTimer, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, TranslateMessage, CREATESTRUCTW, CW_USEDEFAULT, GWLP_USERDATA, HICON, HWND_NOTOPMOST, HWND_TOPMOST, ICON_BIG,
    ICON_SMALL, IDC_ARROW, MINMAXINFO, MSG, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_RESTORE, SW_SHOWNORMAL, WM_CLOSE,
    WM_CREATE, WM_DESTROY, WM_DPICHANGED, WM_ERASEBKGND, WM_GETMINMAXINFO, WM_KEYDOWN, WM_LBUTTONDOWN, WM_NCCREATE, WM_PAINT, WM_SETICON,
    WM_TIMER, WNDCLASSEXW, WS_OVERLAPPEDWINDOW,
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
use crate::status::{Activity, Cloud, Game, Notice, SavedLap, Shared, Snapshot};
use crate::text::{text, Lang, Msg};
use crate::util::{clock, lock, now_ms};
use crate::win;

mod art;
mod catalog;
mod chrome;
mod coach_look;
mod dash_view;
mod dashboards;
mod demo;
mod layout;
mod model;
mod monitor_view;
mod paint;
mod perspective_paint;
mod relay;
#[cfg(test)]
mod tests;
mod tokens;
mod view;
mod waiting_view;
mod widgets;
mod widgets_view;
mod window;

use art::*;
use chrome::*;
use dash_view::*;
use dashboards::*;
use layout::*;
use model::*;
use monitor_view::*;
use paint::*;
#[cfg(test)]
use relay::*;
use tokens::*;
use view::*;
use waiting_view::*;
use widgets::*;
use widgets_view::*;
use window::*;

pub(crate) use coach_look::*;
pub use demo::demo;
pub(crate) use relay::Relay;
pub use view::{Account, Context};
pub use window::show;
