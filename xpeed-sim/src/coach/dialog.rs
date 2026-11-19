//! A modeless Win32 window owned by the Monitor. Only the window thread
//! touches its HWNDs; workers return bounded data through channels.
//!
//! The controls stay native (focus, keyboard, screen readers, text
//! editing); the window paints them in the panel's look (`panel::coach_*`):
//! its backdrop and cards, custom-drawn buttons and switch, a painted session
//! picker and dark edits and scroll bars.

use super::*;
use crate::net::MAX_COACH_QUESTION_UNITS;
use crate::panel::{self, CoachButton, CoachState};
use crate::win;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateSolidBrush, DeleteDC, DeleteObject, EndPaint, GetMonitorInfoW,
    InvalidateRect, MonitorFromWindow, SelectObject, SetBkColor, SetTextColor, HBRUSH, HDC, HFONT, HGDIOBJ, MONITORINFO,
    MONITOR_DEFAULTTONEAREST, PAINTSTRUCT, SRCCOPY,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::{
    GetComboBoxInfo, SetWindowTheme, BST_CHECKED, CDDS_PREPAINT, CDIS_DISABLED, CDIS_FOCUS, CDIS_HOT, CDIS_SELECTED, CDRF_SKIPDEFAULT,
    COMBOBOXINFO, DRAWITEMSTRUCT, EM_LIMITTEXT, EM_SCROLLCARET, EM_SETSEL, MEASUREITEMSTRUCT, NMCUSTOMDRAW, NMHDR, NM_CUSTOMDRAW,
    ODS_COMBOBOXEDIT, ODS_SELECTED, ODT_COMBOBOX, ODT_STATIC,
};
use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    EnableWindow, GetFocus, GetKeyState, IsWindowEnabled, SetFocus, VK_ESCAPE, VK_SHIFT, VK_TAB,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const CLASS: &str = "XpeedCompanionCoach";
const OLD_PROC: &[u16] = &[88, 112, 101, 101, 100, 67, 111, 97, 99, 104, 80, 114, 111, 99, 0]; // XpeedCoachProc
const TIMER: usize = 1;
const TICK_MS: u32 = 100;
const ENABLE: u16 = 100;
const SESSIONS: u16 = 101;
const REFRESH: u16 = 102;
const SEND: u16 = 103;
const RECORD: u16 = 104;
const SPEAK: u16 = 105;
const STOP: u16 = 106;
const WEBSITE: u16 = 107;
const CLOSE: u16 = 108;
const TRANSCRIPT: u16 = 109;
const DRAFT: u16 = 110;
const STATUS: u16 = 111;
const LABEL: u16 = 112;
const CHECKED: usize = 1;
/// `SS_OWNERDRAW` (WinUser.h): a static the window paints. Its constant is in a feature the Companion does not use.
const SS_OWNERDRAW: u32 = 0x0d;
const MAX_TRANSCRIPT_UNITS: usize = 48_000;
const MAX_MESSAGE_DISPLAY_UNITS: usize = 16_000;

// The window's measures, in design pixels (96 DPI), on the panel's 4 px grid.
const MARGIN: i32 = 16;
const PAD: i32 = 16;
const GAP: i32 = 12;
const ROW: i32 = 36;
const LABEL_H: i32 = 16;
const NOTE_H: i32 = 40;
const DRAFT_H: i32 = 84;
const BUTTON_GAP: i32 = 8;
/// The session picker's rows, open and closed.
const PICK_ROW: i32 = 34;
/// The size the window opens at and the smallest it can be made.
const OPEN_SIZE: (i32, i32) = (820, 760);
const MIN_SIZE: (i32, i32) = (680, 620);

/// The scale of a window: its DPI over 96.
unsafe fn scale_of(hwnd: HWND) -> f32 {
    GetDpiForWindow(hwnd).max(96) as f32 / 96.0
}

/// What the window paints under its controls, kept from the last layout.
#[derive(Clone, Copy, Default)]
struct Frame {
    cards: [RECT; 2],
    /// The draft's box.
    draft: RECT,
    rules: [RECT; 2],
}

#[derive(Clone, Copy)]
struct Controls {
    enable: HWND,
    website: HWND,
    status: HWND,
    session_label: HWND,
    sessions: HWND,
    refresh: HWND,
    transcript_label: HWND,
    transcript: HWND,
    draft_label: HWND,
    draft: HWND,
    send: HWND,
    record: HWND,
    speak: HWND,
    stop: HWND,
    close: HWND,
}

impl Controls {
    unsafe fn create(owner: HWND, font: HFONT) -> Option<Self> {
        let enable = button(owner, font, ENABLE, "Enable Coach here", BS_AUTOCHECKBOX as u32)?;
        let website = button(owner, font, WEBSITE, "Open website", BS_PUSHBUTTON as u32)?;
        let status = child(owner, font, "STATIC", "", STATUS, SS_OWNERDRAW, 0)?;
        let session_label = child(owner, font, "STATIC", "Session", LABEL, SS_OWNERDRAW, 0)?;
        let sessions = child(
            owner,
            font,
            "COMBOBOX",
            "",
            SESSIONS,
            WS_TABSTOP | WS_VSCROLL | (CBS_DROPDOWNLIST | CBS_OWNERDRAWFIXED | CBS_HASSTRINGS) as u32,
            0,
        )?;
        let refresh = button(owner, font, REFRESH, "Refresh", BS_PUSHBUTTON as u32)?;
        let transcript_label = child(owner, font, "STATIC", "Conversation", LABEL, SS_OWNERDRAW, 0)?;
        let transcript = child(
            owner,
            font,
            "EDIT",
            "",
            TRANSCRIPT,
            WS_TABSTOP | WS_VSCROLL | (ES_MULTILINE | ES_AUTOVSCROLL | ES_READONLY) as u32,
            0,
        )?;
        let draft_label = child(owner, font, "STATIC", "Question draft", LABEL, SS_OWNERDRAW, 0)?;
        let draft = child(
            owner,
            font,
            "EDIT",
            "",
            DRAFT,
            WS_TABSTOP | WS_VSCROLL | (ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN) as u32,
            0,
        )?;
        let send = button(owner, font, SEND, "Send", BS_PUSHBUTTON as u32)?;
        let record = button(owner, font, RECORD, "Record", BS_PUSHBUTTON as u32)?;
        let speak = button(owner, font, SPEAK, "Speak answer", BS_PUSHBUTTON as u32)?;
        let stop = button(owner, font, STOP, "Stop voice", BS_PUSHBUTTON as u32)?;
        let close = button(owner, font, CLOSE, "Close", BS_PUSHBUTTON as u32)?;
        SendMessageW(draft, EM_LIMITTEXT, MAX_COACH_QUESTION_UNITS, 0);
        // Dark scroll bars on the edits and on the picker's open list (Windows 10 1809 and later; older versions
        // keep their own and ignore the name).
        let dark = win::wide("DarkMode_Explorer");
        SetWindowTheme(transcript, dark.as_ptr(), null());
        SetWindowTheme(draft, dark.as_ptr(), null());
        let mut info: COMBOBOXINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<COMBOBOXINFO>() as u32;
        if GetComboBoxInfo(sessions, &mut info) != 0 && !info.hwndList.is_null() {
            SetWindowTheme(info.hwndList, dark.as_ptr(), null());
        }
        let controls = Self {
            enable,
            website,
            status,
            session_label,
            sessions,
            refresh,
            transcript_label,
            transcript,
            draft_label,
            draft,
            send,
            record,
            speak,
            stop,
            close,
        };
        controls.fit_picker(owner);
        Some(controls)
    }

    fn all(self) -> [HWND; 15] {
        [
            self.enable,
            self.website,
            self.status,
            self.session_label,
            self.sessions,
            self.refresh,
            self.transcript_label,
            self.transcript,
            self.draft_label,
            self.draft,
            self.send,
            self.record,
            self.speak,
            self.stop,
            self.close,
        ]
    }

    /// Gives every control `font` (after a DPI change) and sizes the picker's rows again.
    unsafe fn set_font(self, owner: HWND, font: HFONT) {
        for control in self.all() {
            SendMessageW(control, WM_SETFONT, font as usize, 1);
        }
        self.fit_picker(owner);
    }

    /// The picker's closed height and its rows follow the DPI (an owner-drawn list does not size itself).
    unsafe fn fit_picker(self, owner: HWND) {
        let px = |value: i32| (value as f32 * scale_of(owner)).round() as i32;
        SendMessageW(self.sessions, CB_SETITEMHEIGHT, usize::MAX, (px(ROW) - 6).max(1) as isize);
        SendMessageW(self.sessions, CB_SETITEMHEIGHT, 0, px(PICK_ROW).max(1) as isize);
    }

    /// Places the controls and returns what the window paints under them.
    unsafe fn layout(self, hwnd: HWND) -> Frame {
        let scale = scale_of(hwnd);
        let px = |value: i32| (value as f32 * scale).round() as i32;
        let mut client = RECT::default();
        if GetClientRect(hwnd, &mut client) == 0 {
            return Frame::default();
        }
        let (w, h) = (client.right - client.left, client.bottom - client.top);
        let row = |control: HWND, x: i32, y: i32, width: i32, height: i32| {
            MoveWindow(control, x, y, width.max(1), height.max(1), 1);
        };
        let rect = |left: i32, top: i32, right: i32, bottom: i32| RECT { left, top, right, bottom };
        let (card_left, card_right) = (px(MARGIN), w - px(MARGIN));
        let (left, right) = (card_left + px(PAD), card_right - px(PAD));
        let body = right - left;
        let hair = px(1).max(1);

        // The first card: the switch and the website button, what the Coach is doing, then the session.
        let top = px(MARGIN);
        let mut y = top + px(PAD);
        row(self.enable, left, y, px(280).min(body), px(ROW));
        row(self.website, right - px(150), y, px(150), px(ROW));
        y += px(ROW) + px(8);
        row(self.status, left, y, body, px(NOTE_H));
        y += px(NOTE_H) + px(GAP);
        let first_rule = rect(left, y, right, y + hair);
        y += hair + px(GAP);
        row(self.session_label, left, y, body, px(LABEL_H));
        y += px(LABEL_H) + px(8);
        let refresh_w = px(104);
        row(self.sessions, left, y, body - refresh_w - px(BUTTON_GAP), px(PICK_ROW * 9));
        SendMessageW(self.sessions, CB_SETDROPPEDWIDTH, body.max(1) as usize, 0);
        row(self.refresh, right - refresh_w, y, refresh_w, px(ROW));
        y += px(ROW) + px(PAD);
        let first = rect(card_left, top, card_right, y);

        // The second card: the conversation, then the draft and its buttons at the bottom.
        let top = y + px(GAP);
        let bottom = (h - px(MARGIN)).max(top + px(PAD) * 2);
        let buttons_y = bottom - px(PAD) - px(ROW);
        let mut x = left;
        for (control, width) in [(self.send, 104), (self.record, 104), (self.speak, 140), (self.stop, 120)] {
            row(control, x, buttons_y, px(width), px(ROW));
            x += px(width + BUTTON_GAP);
        }
        row(self.close, right - px(104), buttons_y, px(104), px(ROW));
        let draft_box = rect(left, buttons_y - px(GAP) - px(DRAFT_H), right, buttons_y - px(GAP));
        let inset = px(10);
        row(
            self.draft,
            draft_box.left + inset,
            draft_box.top + px(8),
            body - 2 * inset,
            draft_box.bottom - draft_box.top - px(16),
        );
        let draft_label_y = draft_box.top - px(8) - px(LABEL_H);
        row(self.draft_label, left, draft_label_y, body, px(LABEL_H));
        let second_rule_y = draft_label_y - px(GAP) - hair;
        let second_rule = rect(left, second_rule_y, right, second_rule_y + hair);
        let label_y = top + px(PAD);
        row(self.transcript_label, left, label_y, body, px(LABEL_H));
        let transcript_y = label_y + px(LABEL_H) + px(8);
        row(self.transcript, left, transcript_y, body, second_rule_y - px(GAP) - transcript_y);
        let second = rect(card_left, top, card_right, bottom);
        Frame {
            cards: [first, second],
            draft: draft_box,
            rules: [first_rule, second_rule],
        }
    }
}

unsafe fn child(owner: HWND, font: HFONT, class: &str, label: &str, id: u16, style: u32, extended: u32) -> Option<HWND> {
    let control = CreateWindowExW(
        extended,
        win::wide(class).as_ptr(),
        win::wide(label).as_ptr(),
        WS_CHILD | WS_VISIBLE | style,
        0,
        0,
        1,
        1,
        owner,
        id as usize as HMENU,
        GetModuleHandleW(null()),
        null(),
    );
    if control.is_null() {
        return None;
    }
    SendMessageW(control, WM_SETFONT, font as usize, 1);
    if style & WS_TABSTOP != 0 {
        // The tray keeps its ordinary message loop. Handle tab traversal only
        // in the controls of this window, without a thread-wide keyboard hook.
        // The session picker also paints itself here.
        let previous = GetWindowLongPtrW(control, GWLP_WNDPROC);
        let saved = previous != 0 && SetPropW(control, OLD_PROC.as_ptr(), previous as _) != 0;
        if saved && SetWindowLongPtrW(control, GWLP_WNDPROC, control_proc as *const () as isize) == 0 {
            RemovePropW(control, OLD_PROC.as_ptr());
        }
    }
    Some(control)
}

unsafe fn button(owner: HWND, font: HFONT, id: u16, label: &str, style: u32) -> Option<HWND> {
    child(owner, font, "BUTTON", label, id, WS_TABSTOP | style, 0)
}

unsafe fn control_text(control: HWND) -> String {
    let mut text = [0u16; 512];
    let len = GetWindowTextW(control, text.as_mut_ptr(), text.len() as i32).max(0) as usize;
    String::from_utf16_lossy(&text[..len])
}

/// Paints the closed session picker: an input box with the chosen session and a chevron, as the site's select.
unsafe fn paint_picker(hwnd: HWND) {
    let mut paint: PAINTSTRUCT = std::mem::zeroed();
    let hdc = BeginPaint(hwnd, &mut paint);
    if hdc.is_null() {
        return;
    }
    let mut client = RECT::default();
    GetClientRect(hwnd, &mut client);
    let state = CoachState {
        disabled: IsWindowEnabled(hwnd) == 0,
        focus: GetFocus() == hwnd,
        ..CoachState::default()
    };
    let open = SendMessageW(hwnd, CB_GETDROPPEDSTATE, 0, 0) != 0;
    let scale = scale_of(hwnd);
    buffered(hdc, client, |dc, r| {
        panel::coach_select(dc, r, &control_text(hwnd), state, open, scale)
    });
    EndPaint(hwnd, &paint);
}

/// Draws into an off-screen bitmap the size of `area`, then copies it to `hdc` at once (no flicker). `draw` gets the
/// bitmap and `area` moved to its origin (GDI+ would not follow a moved viewport).
unsafe fn buffered(hdc: HDC, area: RECT, draw: impl FnOnce(HDC, RECT)) {
    let (w, h) = ((area.right - area.left).max(1), (area.bottom - area.top).max(1));
    let memory = CreateCompatibleDC(hdc);
    let bitmap = CreateCompatibleBitmap(hdc, w, h);
    if memory.is_null() || bitmap.is_null() {
        if !bitmap.is_null() {
            DeleteObject(bitmap);
        }
        if !memory.is_null() {
            DeleteDC(memory);
        }
        draw(hdc, area);
        return;
    }
    let old = SelectObject(memory, bitmap);
    draw(
        memory,
        RECT {
            left: 0,
            top: 0,
            right: w,
            bottom: h,
        },
    );
    BitBlt(hdc, area.left, area.top, w, h, memory, 0, 0, SRCCOPY);
    SelectObject(memory, old);
    DeleteObject(bitmap);
    DeleteDC(memory);
}

unsafe extern "system" fn control_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let previous = GetPropW(hwnd, OLD_PROC.as_ptr());
    if previous.is_null() {
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    let picker = GetDlgCtrlID(hwnd) == SESSIONS as i32;
    if picker && message == WM_PAINT {
        paint_picker(hwnd);
        return 0;
    }
    if picker && message == WM_ERASEBKGND {
        return 1;
    }
    if message == WM_KEYDOWN && wparam == VK_TAB as usize {
        let next = GetNextDlgTabItem(GetParent(hwnd), hwnd, i32::from(GetKeyState(VK_SHIFT as i32) < 0));
        if !next.is_null() {
            SetFocus(next);
        }
        return 0;
    }
    if message == WM_CHAR && wparam == VK_TAB as usize {
        return 0;
    }
    if message == WM_KEYDOWN && wparam == VK_ESCAPE as usize {
        let combo_open = picker && SendMessageW(hwnd, CB_GETDROPPEDSTATE, 0, 0) != 0;
        if !combo_open {
            PostMessageW(GetParent(hwnd), WM_CLOSE, 0, 0);
            return 0;
        }
    }
    if message == WM_NCDESTROY {
        RemovePropW(hwnd, OLD_PROC.as_ptr());
    }
    let original: WNDPROC = std::mem::transmute(previous);
    let result = CallWindowProcW(original, hwnd, message, wparam, lparam);
    if picker && matches!(message, WM_SETFOCUS | WM_KILLFOCUS | WM_ENABLE) {
        InvalidateRect(hwnd, null(), 0);
    }
    result
}

/// Paints a button, the switch or the picker's open list (`NM_CUSTOMDRAW`): needs no state, only the control.
unsafe fn custom_draw(draw: &NMCUSTOMDRAW) -> LRESULT {
    if draw.dwDrawStage != CDDS_PREPAINT {
        return 0;
    }
    let control = draw.hdr.hwndFrom;
    let scale = scale_of(control);
    let items = draw.uItemState;
    let state = CoachState {
        disabled: items & CDIS_DISABLED != 0 || IsWindowEnabled(control) == 0,
        pressed: items & CDIS_SELECTED != 0,
        hot: items & CDIS_HOT != 0,
        focus: items & CDIS_FOCUS != 0,
    };
    let label = control_text(control);
    buffered(draw.hdc, draw.rc, |dc, r| match draw.hdr.idFrom as u16 {
        ENABLE => {
            let on = SendMessageW(control, BM_GETCHECK, 0, 0) as usize == BST_CHECKED as usize;
            panel::coach_switch(dc, r, &label, on, state, scale);
        }
        id => {
            let kind = if matches!(id, SEND | WEBSITE) {
                CoachButton::Primary
            } else {
                CoachButton::Secondary
            };
            panel::coach_button(dc, r, &label, kind, state, scale);
        }
    });
    CDRF_SKIPDEFAULT as LRESULT
}

/// Paints a label, the status line or a row of the picker's open list (`WM_DRAWITEM`).
unsafe fn draw_item(item: &DRAWITEMSTRUCT) {
    let scale = scale_of(item.hwndItem);
    match item.CtlType {
        ODT_STATIC => {
            let text = control_text(item.hwndItem);
            buffered(item.hDC, item.rcItem, |dc, r| {
                if item.CtlID == u32::from(STATUS) {
                    panel::coach_note(dc, r, &text, scale);
                } else {
                    panel::coach_label(dc, r, &text, scale);
                }
            });
        }
        // The picker draws its closed box itself (`paint_picker`): send its own redraws of that box there.
        ODT_COMBOBOX if item.itemID == u32::MAX || item.itemState & ODS_COMBOBOXEDIT != 0 => {
            InvalidateRect(item.hwndItem, null(), 0);
        }
        ODT_COMBOBOX => {
            let len = SendMessageW(item.hwndItem, CB_GETLBTEXTLEN, item.itemID as usize, 0);
            let mut text = vec![0u16; len.max(0) as usize + 1];
            let copied = SendMessageW(item.hwndItem, CB_GETLBTEXT, item.itemID as usize, text.as_mut_ptr() as isize);
            let text = String::from_utf16_lossy(&text[..copied.max(0) as usize]);
            buffered(item.hDC, item.rcItem, |dc, r| {
                panel::coach_list_row(dc, r, &text, item.itemState & ODS_SELECTED != 0, scale);
            });
        }
        _ => {}
    }
}

/// The colours of the edits and of the picker's open list (`WM_CTLCOLOR*`).
unsafe fn control_colour(hdc: HDC, background: COLORREF, text: COLORREF, brush: HBRUSH) -> LRESULT {
    SetTextColor(hdc, text);
    SetBkColor(hdc, background);
    brush as LRESULT
}

unsafe fn set_text(control: HWND, value: &str) {
    SetWindowTextW(control, win::wide(value).as_ptr());
}

unsafe fn get_edit(control: HWND) -> String {
    // Typed text is limited by the edit control. A restored server draft
    // can be longer when the control expands its line endings to CRLF.
    let mut input = vec![0u16; MAX_COACH_QUESTION_UNITS * 2 + 1];
    let len = GetWindowTextW(control, input.as_mut_ptr(), input.len() as i32).max(0) as usize;
    String::from_utf16_lossy(&input[..len])
}

fn truncate_utf16(text: &str, limit: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|character| {
            used += character.len_utf16();
            used <= limit
        })
        .collect()
}

fn clean_multiline(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\t' | '\n'))
        .collect::<String>()
        .replace('\n', "\r\n")
}

fn transcript(history: &CoachHistory) -> String {
    let mut budget = MAX_TRANSCRIPT_UNITS;
    let mut blocks = Vec::new();
    for message in history.messages.iter().rev() {
        if budget < 16 {
            break;
        }
        let label = match message.role {
            CoachRole::User => "You",
            CoachRole::Assistant => "Coach",
        };
        let body = truncate_utf16(&clean_multiline(&message.content), MAX_MESSAGE_DISPLAY_UNITS.min(budget - 14));
        let block = format!("{label}\r\n{body}\r\n\r\n");
        budget -= block.encode_utf16().count();
        blocks.push(block);
    }
    blocks.reverse();
    blocks.concat()
}

fn session_label(session: &CoachSession) -> String {
    let safe = |text: &str| {
        text.chars()
            .filter(|character| !character.is_control())
            .take(120)
            .collect::<String>()
    };
    let started = safe(&session.started_at);
    let at = if started.ends_with('Z') || started.ends_with("+00:00") || started.ends_with("+00") {
        let minute: String = started.chars().take(16).collect();
        format!("{} UTC", minute.replace('T', " "))
    } else {
        started.replace('T', " ")
    };
    format!(
        "{} · {} · {} · {} · {}",
        safe(&session.track),
        safe(&session.car),
        safe(&session.game),
        safe(&session.kind),
        at
    )
}

unsafe fn work_area(window: HWND) -> Option<RECT> {
    let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
    if monitor.is_null() {
        return None;
    }
    let mut info: MONITORINFO = std::mem::zeroed();
    info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    (GetMonitorInfoW(monitor, &mut info) != 0).then_some(info.rcWork)
}

struct State {
    controls: Option<Controls>,
    /// What the window paints under its controls, from the last layout.
    frame: Frame,
    /// The controls' font and the brushes behind the edits, made for the window's DPI and deleted with it.
    font: HFONT,
    card_brush: HBRUSH,
    input_brush: HBRUSH,
    watch: Option<PairingWatch>,
    pairing: PublicPairing,
    scope: Arc<AtomicU64>,
    enabled: bool,
    permit_required: bool,
    lang: Lang,
    sessions: Vec<CoachSession>,
    conversation: Option<Conversation>,
    questions: UncertainQuestions,
    network: Option<NetworkJob>,
    speech: Option<SpeechJob>,
    /// The window stands alone (`coach-demo`): closing it ends the message loop.
    quit_on_close: bool,
}

impl State {
    unsafe fn status(&self, message: &str) {
        if let Some(c) = self.controls {
            set_text(c.status, message);
            InvalidateRect(c.status, null(), 0);
        }
    }

    /// The font and brushes for the window's present DPI (the old ones are deleted).
    unsafe fn make_resources(&mut self, hwnd: HWND) {
        self.free_resources();
        self.font = panel::coach_font(scale_of(hwnd));
        self.card_brush = CreateSolidBrush(panel::COACH_CARD);
        self.input_brush = CreateSolidBrush(panel::COACH_INPUT);
    }

    unsafe fn free_resources(&mut self) {
        for object in [self.font as HGDIOBJ, self.card_brush as HGDIOBJ, self.input_brush as HGDIOBJ] {
            if !object.is_null() {
                DeleteObject(object);
            }
        }
        self.font = null_mut();
        self.card_brush = null_mut();
        self.input_brush = null_mut();
    }

    unsafe fn layout(&mut self, hwnd: HWND) {
        if let Some(controls) = self.controls {
            self.frame = controls.layout(hwnd);
            InvalidateRect(hwnd, null(), 0);
        }
    }

    unsafe fn paint(&self, hwnd: HWND) {
        let mut paint: PAINTSTRUCT = std::mem::zeroed();
        let hdc = BeginPaint(hwnd, &mut paint);
        if hdc.is_null() {
            return;
        }
        let mut client = RECT::default();
        GetClientRect(hwnd, &mut client);
        let scale = scale_of(hwnd);
        let frame = self.frame;
        let typing = self.controls.is_some_and(|c| GetFocus() == c.draft);
        buffered(hdc, client, |dc, r| {
            panel::coach_backdrop(dc, r.right, r.bottom, scale, &frame.cards, &[(frame.draft, typing)], &frame.rules);
        });
        EndPaint(hwnd, &paint);
    }

    /// The colours of an edit or of the picker's open list.
    unsafe fn colour(&self, message: u32, hdc: HDC, control: HWND) -> LRESULT {
        let Some(c) = self.controls else { return 0 };
        match message {
            WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX => control_colour(hdc, panel::COACH_INPUT, panel::COACH_TEXT, self.input_brush),
            _ if control == c.draft => control_colour(hdc, panel::COACH_INPUT, panel::COACH_TEXT_OFF, self.input_brush),
            _ => control_colour(hdc, panel::COACH_CARD, panel::COACH_TEXT, self.card_brush),
        }
    }

    unsafe fn update_controls(&self) {
        let Some(c) = self.controls else { return };
        let idle = self.network.is_none() && self.speech.is_none();
        let on = self.enabled && self.pairing.server.is_some();
        let can_ask = on
            && idle
            && self
                .conversation
                .as_ref()
                .is_some_and(|conversation| conversation.history.is_some());
        let can_speak = can_ask && self.conversation.as_ref().and_then(Conversation::last_answer).is_some();
        EnableWindow(c.enable, i32::from(self.pairing.server.is_some()));
        SendMessageW(c.enable, BM_SETCHECK, if self.enabled { CHECKED } else { 0 }, 0);
        EnableWindow(c.sessions, i32::from(on && idle && !self.sessions.is_empty()));
        EnableWindow(c.refresh, i32::from(on && idle));
        EnableWindow(c.draft, i32::from(can_ask));
        EnableWindow(c.send, i32::from(can_ask));
        EnableWindow(c.record, i32::from(can_ask));
        EnableWindow(c.speak, i32::from(can_speak));
        EnableWindow(c.stop, i32::from(self.speech.is_some()));
        ShowWindow(c.website, if self.permit_required && on { SW_SHOW } else { SW_HIDE });
    }

    fn cancel_work(&mut self) {
        self.scope.fetch_add(1, Ordering::AcqRel);
        self.network = None;
        self.speech = None;
    }

    unsafe fn render_transcript(&self) {
        let Some(c) = self.controls else { return };
        let history = self.conversation.as_ref().and_then(|conversation| conversation.history.as_ref());
        let text = history.map(transcript).unwrap_or_default();
        set_text(c.transcript, &text);
        let end = text.encode_utf16().count();
        SendMessageW(c.transcript, EM_SETSEL, end, end as isize);
        SendMessageW(c.transcript, EM_SCROLLCARET, 0, 0);
        // A read-only edit without focus may not follow its caret: scroll it to the last message as well.
        SendMessageW(c.transcript, WM_VSCROLL, SB_BOTTOM as usize, 0);
    }

    unsafe fn render_sessions(&self) {
        let Some(c) = self.controls else { return };
        SendMessageW(c.sessions, CB_RESETCONTENT, 0, 0);
        SendMessageW(c.sessions, CB_ADDSTRING, 0, win::wide("Select a session").as_ptr() as isize);
        for session in &self.sessions {
            SendMessageW(c.sessions, CB_ADDSTRING, 0, win::wide(&session_label(session)).as_ptr() as isize);
        }
        let selected = self
            .conversation
            .as_ref()
            .and_then(|conversation| self.sessions.iter().position(|s| s.id == conversation.session_id));
        SendMessageW(c.sessions, CB_SETCURSEL, selected.map_or(0, |index| index + 1), 0);
    }

    unsafe fn clear_conversation(&mut self) {
        self.cancel_work();
        self.conversation = None;
        if let Some(c) = self.controls {
            set_text(c.draft, "");
        }
        self.render_transcript();
    }

    unsafe fn clear_all(&mut self) {
        self.clear_conversation();
        self.sessions.clear();
        self.questions = UncertainQuestions::default();
        self.permit_required = false;
        self.render_sessions();
    }

    unsafe fn turn_off(&mut self, message: &str) {
        self.enabled = false;
        self.clear_all();
        self.status(message);
    }

    unsafe fn start_network(&mut self, request: CoachRequest) {
        if !self.enabled || self.pairing.server.is_none() || self.network.is_some() || self.speech.is_some() {
            return;
        }
        if self.permit_required && !matches!(&request, CoachRequest::Sessions) {
            return;
        }
        let busy_text = match &request {
            CoachRequest::Sessions => "Loading recent uploaded sessions…",
            CoachRequest::History(_) => "Loading this session's conversation…",
            CoachRequest::Ask(_) => "Waiting for the Coach…",
        };
        let Some(watch) = &self.watch else { return };
        match NetworkJob::start(request, watch.source.clone(), self.pairing.revision, self.scope.clone()) {
            Ok(job) => {
                self.network = Some(job);
                self.status(busy_text);
            }
            Err(StartError::Busy) => self.status("A Coach request is still finishing. Try again in a moment."),
            Err(StartError::Unavailable) => self.status("Could not start the Coach request. Try again."),
        }
    }

    unsafe fn select_session(&mut self) {
        if !self.enabled || self.network.is_some() || self.speech.is_some() {
            return;
        }
        let Some(c) = self.controls else { return };
        let index = SendMessageW(c.sessions, CB_GETCURSEL, 0, 0);
        let id = if index > 0 {
            self.sessions.get(index as usize - 1).map(|session| session.id.clone())
        } else {
            None
        };
        if self.conversation.as_ref().map(|current| &current.session_id) == id.as_ref() {
            return;
        }
        self.clear_conversation();
        if let Some(id) = id {
            self.conversation = Some(Conversation {
                session_id: id.clone(),
                history: None,
            });
            self.start_network(CoachRequest::History(id));
        } else {
            self.status("Select an uploaded session to load its conversation.");
        }
    }

    unsafe fn send(&mut self) {
        if !self.enabled || self.network.is_some() || self.speech.is_some() {
            return;
        }
        let (Some(c), Some(conversation)) = (self.controls, &self.conversation) else {
            return;
        };
        let Some(history) = &conversation.history else { return };
        let draft = get_edit(c.draft);
        let message = draft.trim();
        if message.is_empty() {
            self.status("Type a question before sending.");
            SetFocus(c.draft);
            return;
        }
        let question = if let Some(previous) = self.questions.find(&conversation.session_id, message) {
            previous
        } else {
            if message.encode_utf16().count() > MAX_COACH_QUESTION_UNITS {
                self.status("Shorten the draft before starting a new request.");
                SetFocus(c.draft);
                return;
            }
            let Some(idempotency_key) = question_key() else {
                self.status("Could not start a safe request. Try again.");
                return;
            };
            CoachQuestion {
                session_id: conversation.session_id.clone(),
                conversation_id: history.conversation_id.clone(),
                message: message.to_owned(),
                idempotency_key,
                language: locales(self.lang).0,
            }
        };
        self.start_network(CoachRequest::Ask(question));
    }

    unsafe fn start_voice(&mut self, speak: bool) {
        if !self.enabled || self.network.is_some() || self.speech.is_some() {
            return;
        }
        let (Some(c), Some(conversation)) = (self.controls, &self.conversation) else {
            return;
        };
        if conversation.history.is_none() {
            return;
        }
        let locale = locales(self.lang).1;
        let request = if speak {
            let Some(text) = conversation.last_answer() else { return };
            SpeechRequest::Speak {
                locale,
                text: text.to_owned(),
            }
        } else {
            if get_edit(c.draft).encode_utf16().count() >= MAX_COACH_QUESTION_UNITS {
                self.status("The draft is full. Make room before recording.");
                return;
            }
            SpeechRequest::Dictate { locale }
        };
        let generation = self.scope.load(Ordering::Acquire);
        match SpeechJob::start(request, generation) {
            Ok(job) => {
                self.speech = Some(job);
                self.status(if speak {
                    "Reading the last answer. Use Stop voice to cancel."
                } else {
                    "Listening locally for up to 15 seconds. Review the draft before sending."
                });
            }
            Err(StartError::Busy) => self.status("Windows speech is still stopping. Try again in a moment."),
            Err(StartError::Unavailable) => self.status("Could not start local Windows speech. You can still type."),
        }
    }

    unsafe fn network_error(&mut self, request: CoachRequest, error: CoachError) {
        if let CoachRequest::Ask(question) = request {
            self.questions.after_failure(question, error);
        }
        match error {
            CoachError::PairAgain => self.turn_off("Pair this computer with your Xpeed account again."),
            CoachError::EnableOnWebsite => {
                self.clear_all();
                self.permit_required = true;
                self.status("The account owner can enable Coach for this computer on the Xpeed website. Then press Refresh here.");
            }
            CoachError::Limit => self.status("The Coach request limit was reached. Try again later."),
            CoachError::Busy => self.status("Another request is still processing. Refresh before sending this draft again."),
            CoachError::Pending => self.status("Xpeed is still processing this request. Send the same draft later to check it."),
            CoachError::Failed => self.status("The previous request failed. Press Send again to start a new request."),
            CoachError::Development => self.status("Coach AI is disabled in development."),
            CoachError::SessionUnavailable => {
                self.clear_conversation();
                self.render_sessions();
                self.status("This session is unavailable. Refresh the session list.");
            }
            CoachError::Unavailable => self.status("The Coach is unavailable right now. Try again."),
            CoachError::DeliveryUnknown => self.status("Delivery is uncertain. Send the same draft to check the original request."),
        }
    }

    unsafe fn network_result(&mut self, request: CoachRequest, event: NetworkEvent) {
        let result = match event {
            NetworkEvent::ChangedPairing => {
                self.turn_off("The paired account changed. Turn Coach on again after connecting.");
                return;
            }
            NetworkEvent::Finished(Err(error)) => {
                self.network_error(request, error);
                return;
            }
            NetworkEvent::Finished(Ok(result)) => result,
        };
        match (request, result) {
            (CoachRequest::Sessions, CoachResult::Sessions(sessions)) => {
                self.permit_required = false;
                if self
                    .conversation
                    .as_ref()
                    .is_some_and(|context| !sessions.iter().any(|s| s.id == context.session_id))
                {
                    self.clear_conversation();
                }
                self.sessions = sessions;
                self.render_sessions();
                if let Some(id) = self.conversation.as_ref().map(|conversation| conversation.session_id.clone()) {
                    self.start_network(CoachRequest::History(id));
                } else if self.sessions.is_empty() {
                    self.status("No uploaded sessions from this computer yet. Record and upload laps, then refresh.");
                } else {
                    self.status("Select an uploaded session to load its conversation.");
                }
            }
            (CoachRequest::History(id), CoachResult::History(mut history)) => {
                if let Some(context) = self.conversation.as_mut().filter(|context| context.session_id == id) {
                    let pending_request = history.pending_request.take();
                    context.history = Some(history);
                    let pending = pending_request.map(|pending| self.questions.restore(id, pending, self.lang));
                    self.render_transcript();
                    if let (Some(pending), Some(c)) = (pending, self.controls) {
                        let draft = get_edit(c.draft);
                        if draft.trim().is_empty() {
                            set_text(c.draft, &pending);
                            self.status("A prior request is still processing. Review the restored draft and press Send to check it.");
                        } else if same_draft(&draft, &pending) {
                            self.status("A prior request is still processing. Press Send with this draft to check it.");
                        } else {
                            self.status("A prior request is still processing. Your draft was kept. Refresh to check for its reply.");
                        }
                    } else {
                        self.status("Type a question or record a draft. Press Send when it is ready.");
                    }
                }
            }
            (CoachRequest::Ask(question), CoachResult::Answer(answer)) => {
                if let Some(context) = self
                    .conversation
                    .as_mut()
                    .filter(|context| context.session_id == question.session_id)
                {
                    let was_retry = self.questions.find(&question.session_id, &question.message).is_some();
                    self.questions.forget(&question.idempotency_key);
                    context.answer(question, answer, was_retry);
                    if let Some(c) = self.controls {
                        set_text(c.draft, "");
                    }
                    self.render_transcript();
                    self.status("Answer saved to this session. You can ask another question or speak the last answer.");
                }
            }
            _ => self.status("The Coach returned an unexpected response. Refresh the conversation."),
        }
    }

    unsafe fn speech_result(&self, result: Result<SpeechResult, SpeechError>) {
        match result {
            Ok(SpeechResult::Dictated(text)) => {
                let Some(c) = self.controls else { return };
                let dictated = clean_multiline(&text);
                if dictated.trim().is_empty() {
                    self.status("No words were recognised. Try recording again or type your question.");
                    return;
                }
                let mut draft = get_edit(c.draft);
                if !draft.is_empty() && !draft.chars().last().is_some_and(char::is_whitespace) {
                    draft.push(' ');
                }
                draft.push_str(dictated.trim());
                let shortened = draft.encode_utf16().count() > MAX_COACH_QUESTION_UNITS;
                let draft = truncate_utf16(&draft, MAX_COACH_QUESTION_UNITS);
                set_text(c.draft, &draft);
                let end = draft.encode_utf16().count();
                SendMessageW(c.draft, EM_SETSEL, end, end as isize);
                SetFocus(c.draft);
                self.status(if shortened {
                    "Dictation shortened to fit. Review the draft before sending."
                } else {
                    "Dictation added to the draft. Review it, then press Send."
                });
            }
            Ok(SpeechResult::Spoken) => self.status("Finished reading the answer."),
            Err(SpeechError::NoEngine) => self.status("No matching local Windows speech engine is installed. You can still type."),
            Err(SpeechError::NoWords) => self.status("No words were recognised. Try recording again or type your question."),
            Err(SpeechError::TimedOut) => self.status("Local speech stopped at its time limit. You can still type."),
            Err(SpeechError::Cancelled) => self.status("Voice stopped."),
            Err(SpeechError::Unavailable) => self.status("Local Windows speech is unavailable. You can still type."),
        }
    }

    unsafe fn tick(&mut self) {
        if let Some(pairing) = self.watch.as_ref().and_then(PairingWatch::status) {
            if pairing.revision != self.pairing.revision {
                let initial = self.pairing.revision == 0;
                self.pairing = pairing;
                let note = if self.pairing.server.is_none() {
                    "Pair this computer before using Coach."
                } else if initial {
                    "Coach is off. Enable it here to load your recent sessions."
                } else {
                    "The paired account changed. Turn Coach on again when you are ready."
                };
                self.turn_off(note);
                self.update_controls();
            }
        }
        if let Some(outcome) = self.network.as_ref().and_then(|job| match job.results.try_recv() {
            Ok(result) => Some(Some(result)),
            Err(mpsc::TryRecvError::Disconnected) => Some(None),
            Err(mpsc::TryRecvError::Empty) => None,
        }) {
            if let Some(job) = self.network.take() {
                if job.generation == self.scope.load(Ordering::Acquire) && self.enabled {
                    let outcome = outcome.unwrap_or({
                        NetworkEvent::Finished(Err(if matches!(&job.request, CoachRequest::Ask(_)) {
                            CoachError::DeliveryUnknown
                        } else {
                            CoachError::Unavailable
                        }))
                    });
                    self.network_result(job.request, outcome);
                }
            }
            self.update_controls();
        }
        if let Some(outcome) = self.speech.as_ref().and_then(|job| match job.results.try_recv() {
            Ok(result) => Some(result),
            Err(mpsc::TryRecvError::Disconnected) => Some(Err(SpeechError::Unavailable)),
            Err(mpsc::TryRecvError::Empty) => None,
        }) {
            let current = self
                .speech
                .take()
                .is_some_and(|job| job.generation == self.scope.load(Ordering::Acquire));
            self.update_controls();
            if current && self.enabled {
                self.speech_result(outcome);
            }
        }
    }

    unsafe fn command(&mut self, hwnd: HWND, command: u16) {
        match command {
            ENABLE => {
                if let Some(c) = self.controls {
                    if SendMessageW(c.enable, BM_GETCHECK, 0, 0) as usize == CHECKED && self.pairing.server.is_some() {
                        self.enabled = true;
                        self.start_network(CoachRequest::Sessions);
                    } else {
                        self.turn_off("Coach is off. Enable it here to load your recent sessions.");
                    }
                }
            }
            SESSIONS => self.select_session(),
            REFRESH => self.start_network(CoachRequest::Sessions),
            SEND => self.send(),
            RECORD => self.start_voice(false),
            SPEAK => self.start_voice(true),
            STOP if self.speech.is_some() => {
                self.speech = None;
                self.status("Voice stopped.");
            }
            WEBSITE if self.enabled && self.permit_required => {
                if let Some(server) = &self.pairing.server {
                    win::open(&format!("{server}/virtual/companion"));
                }
            }
            CLOSE => {
                PostMessageW(hwnd, WM_CLOSE, 0, 0);
            }
            _ => {}
        }
        self.update_controls();
    }
}

impl Drop for State {
    fn drop(&mut self) {
        self.cancel_work();
        // The window and its controls are gone (this runs on WM_NCDESTROY): nothing uses the font or brushes now.
        unsafe { self.free_resources() };
    }
}

struct Create(Option<Box<State>>);

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match catch_unwind(AssertUnwindSafe(|| window_message(hwnd, message, wparam, lparam))) {
        Ok(result) => result,
        Err(_) if message == WM_NCCREATE => 0,
        Err(_) if message == WM_CREATE => -1,
        Err(_) => {
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
            0
        }
    }
}

unsafe fn window_message(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_NCCREATE => {
            let create = &*(lparam as *const CREATESTRUCTW);
            let initial = &mut *(create.lpCreateParams as *mut Create);
            let Some(state) = initial.0.take() else { return 0 };
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(state) as isize);
            // The default handling sets the window's title.
            return DefWindowProcW(hwnd, message, wparam, lparam);
        }
        WM_NCDESTROY => {
            let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            if !state.is_null() {
                drop(Box::from_raw(state));
            }
            return DefWindowProcW(hwnd, message, wparam, lparam);
        }
        WM_CLOSE => {
            DestroyWindow(hwnd);
            return 0;
        }
        WM_DESTROY => {
            KillTimer(hwnd, TIMER);
            let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const State;
            if state.as_ref().is_some_and(|state| state.quit_on_close) {
                PostQuitMessage(0);
            }
            return 0;
        }
        WM_ERASEBKGND => return 1,
        WM_NOTIFY => {
            let header = &*(lparam as *const NMHDR);
            if header.code == NM_CUSTOMDRAW && GetParent(header.hwndFrom) == hwnd {
                return custom_draw(&*(lparam as *const NMCUSTOMDRAW));
            }
            return DefWindowProcW(hwnd, message, wparam, lparam);
        }
        WM_DRAWITEM => {
            draw_item(&*(lparam as *const DRAWITEMSTRUCT));
            return 1;
        }
        WM_MEASUREITEM => {
            let item = &mut *(lparam as *mut MEASUREITEMSTRUCT);
            if item.CtlType == ODT_COMBOBOX {
                let px = |value: i32| (value as f32 * scale_of(hwnd)).round() as i32;
                item.itemHeight = if item.itemID == u32::MAX { px(ROW) - 6 } else { px(PICK_ROW) }.max(1) as u32;
            }
            return 1;
        }
        WM_DPICHANGED => {
            let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State;
            if let Some(state) = state.as_mut() {
                state.make_resources(hwnd);
                if let Some(controls) = state.controls {
                    controls.set_font(hwnd, state.font);
                }
            }
            let bounds = &*(lparam as *const RECT);
            SetWindowPos(
                hwnd,
                null_mut(),
                bounds.left,
                bounds.top,
                bounds.right - bounds.left,
                bounds.bottom - bounds.top,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
            return 0;
        }
        WM_GETMINMAXINFO => {
            let info = &mut *(lparam as *mut MINMAXINFO);
            let dpi = GetDpiForWindow(hwnd).max(96) as i32;
            info.ptMinTrackSize.x = MIN_SIZE.0 * dpi / 96;
            info.ptMinTrackSize.y = MIN_SIZE.1 * dpi / 96;
            if let Some(bounds) = work_area(hwnd) {
                info.ptMinTrackSize.x = info.ptMinTrackSize.x.min(bounds.right - bounds.left);
                info.ptMinTrackSize.y = info.ptMinTrackSize.y.min(bounds.bottom - bounds.top);
            }
            return 0;
        }
        WM_COMMAND => {
            // Programmatic changes to edit/combobox controls can send other
            // notifications synchronously. Ignore them before borrowing State.
            let (id, code) = (wparam as u16, (wparam >> 16) as u16);
            if id == SESSIONS && (code == CBN_DROPDOWN as u16 || code == CBN_CLOSEUP as u16) && lparam != 0 {
                // The picker's chevron turns while its list is open.
                InvalidateRect(lparam as HWND, null(), 0);
                return 0;
            }
            if id == DRAFT && (code == EN_SETFOCUS as u16 || code == EN_KILLFOCUS as u16) {
                // The draft's box has a yellow edge while it is typed in.
                InvalidateRect(hwnd, null(), 0);
                return 0;
            }
            let handled = if id == SESSIONS {
                code == CBN_SELCHANGE as u16
            } else {
                matches!(id, ENABLE | REFRESH | SEND | RECORD | SPEAK | STOP | WEBSITE | CLOSE) && code == BN_CLICKED as u16
            };
            if !handled || lparam == 0 || GetDlgItem(hwnd, id as i32) != lparam as HWND {
                return 0;
            }
        }
        WM_CREATE | WM_SIZE | WM_TIMER | WM_PAINT | WM_CTLCOLOREDIT | WM_CTLCOLORSTATIC | WM_CTLCOLORLISTBOX => {}
        _ => return DefWindowProcW(hwnd, message, wparam, lparam),
    }
    let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State;
    let Some(state) = state.as_mut() else {
        return DefWindowProcW(hwnd, message, wparam, lparam);
    };
    match message {
        WM_CREATE => {
            state.make_resources(hwnd);
            let Some(controls) = Controls::create(hwnd, state.font) else {
                return -1;
            };
            state.controls = Some(controls);
            state.render_sessions();
            state.status(if state.quit_on_close {
                "Demo: made-up sessions and answers. Nothing is sent."
            } else if state.watch.is_some() {
                "Coach is off. Checking this computer's pairing…"
            } else {
                "The computer pairing is unavailable. You can still use the Companion monitor."
            });
            state.update_controls();
            state.layout(hwnd);
            // After the layout, so the conversation opens scrolled to its last message.
            state.render_transcript();
            if SetTimer(hwnd, TIMER, TICK_MS, None) == 0 {
                return -1;
            }
        }
        WM_SIZE => state.layout(hwnd),
        WM_PAINT => state.paint(hwnd),
        WM_CTLCOLOREDIT | WM_CTLCOLORSTATIC | WM_CTLCOLORLISTBOX => return state.colour(message, wparam as HDC, lparam as HWND),
        WM_TIMER if wparam == TIMER => state.tick(),
        WM_COMMAND => state.command(hwnd, wparam as u16),
        _ => {}
    }
    0
}

unsafe fn owned_coach(owner: HWND, hwnd: HWND) -> bool {
    if hwnd.is_null() || IsWindow(hwnd) == 0 || GetWindow(hwnd, GW_OWNER) != owner {
        return false;
    }
    let mut class = [0u16; 64];
    let len = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
    len > 0 && String::from_utf16_lossy(&class[..len as usize]) == CLASS
}

pub(crate) fn close(owner: HWND, existing: HWND) {
    unsafe {
        if owned_coach(owner, existing) {
            DestroyWindow(existing);
        }
    }
}

pub(crate) fn show(owner: HWND, existing: HWND, lang: Lang, icons: [HICON; 2]) -> HWND {
    unsafe {
        if owned_coach(owner, existing) {
            ShowWindow(existing, SW_RESTORE);
            SetForegroundWindow(existing);
            return existing;
        }
        let state = Box::new(State {
            controls: None,
            frame: Frame::default(),
            font: null_mut(),
            card_brush: null_mut(),
            input_brush: null_mut(),
            watch: config::default_path().and_then(|path| PairingWatch::start(path).ok()),
            pairing: PublicPairing::default(),
            scope: Arc::new(AtomicU64::new(1)),
            enabled: false,
            permit_required: false,
            lang,
            sessions: Vec::new(),
            conversation: None,
            questions: UncertainQuestions::default(),
            network: None,
            speech: None,
            quit_on_close: false,
        });
        open(owner, state, icons)
    }
}

/// Opens the Coach window alone with made-up sessions and a made-up conversation, so it can be seen without an account.
/// Nothing is read from the pairing and nothing is sent: with no pairing watch no request can start.
pub(crate) fn demo(lang: Lang) -> std::process::ExitCode {
    let session = |id: &str, track: &str, car: &str, game: &str, kind: &str, at: &str| CoachSession {
        id: id.into(),
        track: track.into(),
        car: car.into(),
        game: game.into(),
        kind: kind.into(),
        started_at: at.into(),
    };
    let message = |role, content: &str| CoachMessage {
        role,
        content: content.into(),
    };
    let state = Box::new(State {
        controls: None,
        frame: Frame::default(),
        font: null_mut(),
        card_brush: null_mut(),
        input_brush: null_mut(),
        watch: None,
        pairing: PublicPairing {
            revision: 1,
            server: Some("https://xpeed.skale.club".into()),
        },
        scope: Arc::new(AtomicU64::new(1)),
        enabled: true,
        permit_required: false,
        lang,
        sessions: vec![
            session(
                "demo-1",
                "Spa-Francorchamps",
                "Porsche 911 GT3 R",
                "Le Mans Ultimate",
                "Practice",
                "2026-11-18T19:42:00Z",
            ),
            session(
                "demo-2",
                "Monza",
                "Ferrari 296 GT3",
                "Assetto Corsa Competizione",
                "Race",
                "2026-11-16T21:05:00Z",
            ),
            session(
                "demo-3",
                "Interlagos",
                "Ginetta G55",
                "Automobilista 2",
                "Qualifying",
                "2026-11-12T18:30:00Z",
            ),
        ],
        conversation: Some(Conversation {
            session_id: "demo-1".into(),
            history: Some(CoachHistory {
                conversation_id: Some("demo".into()),
                pending_request: None,
                messages: vec![
                    message(CoachRole::User, "Where am I losing the most time on this lap?"),
                    message(
                        CoachRole::Assistant,
                        "Mostly in sector 2. Into Les Combes you brake about 15 m earlier than on your best lap and carry 6 km/h \
                         less to the apex. On Pouhon you lift twice; one smooth lift is worth about 0.3 s.",
                    ),
                    message(CoachRole::User, "How should I take Eau Rouge?"),
                    message(
                        CoachRole::Assistant,
                        "Flat in this car if the line is right: keep to the left on the way in, let the car run wide at the top \
                         and do not touch the brake. Your fastest laps all had full throttle there.",
                    ),
                ],
            }),
        }),
        questions: UncertainQuestions::default(),
        network: None,
        speech: None,
        quit_on_close: true,
    });
    let icons = crate::tray::program_icons();
    let hwnd = unsafe { open(null_mut(), state, icons) };
    if !hwnd.is_null() {
        unsafe {
            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
    unsafe {
        DestroyIcon(icons[0]);
        DestroyIcon(icons[1]);
    }
    if hwnd.is_null() {
        std::process::ExitCode::FAILURE
    } else {
        std::process::ExitCode::SUCCESS
    }
}

unsafe fn open(owner: HWND, state: Box<State>, icons: [HICON; 2]) -> HWND {
    let class = win::wide(CLASS);
    let instance = GetModuleHandleW(null());
    let window = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: 0,
        lpfnWndProc: Some(window_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: icons[0],
        hCursor: LoadCursorW(null_mut(), IDC_ARROW),
        hbrBackground: null_mut(),
        lpszMenuName: null(),
        lpszClassName: class.as_ptr(),
        hIconSm: icons[1],
    };
    RegisterClassExW(&window);
    let mut creation = Create(Some(state));
    let previous_context = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    let anchor = if owner.is_null() { GetDesktopWindow() } else { owner };
    let dpi = if owner.is_null() {
        96
    } else {
        GetDpiForWindow(owner).max(96) as i32
    };
    let (mut width, mut height) = (OPEN_SIZE.0 * dpi / 96, OPEN_SIZE.1 * dpi / 96);
    let (x, y) = if let Some(bounds) = work_area(anchor) {
        let (area_w, area_h) = (bounds.right - bounds.left, bounds.bottom - bounds.top);
        width = width.min(area_w);
        height = height.min(area_h);
        (bounds.left + (area_w - width) / 2, bounds.top + (area_h - height) / 2)
    } else {
        (CW_USEDEFAULT, CW_USEDEFAULT)
    };
    let hwnd = CreateWindowExW(
        0,
        class.as_ptr(),
        win::wide("Xpeed Session Coach").as_ptr(),
        WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
        x,
        y,
        width,
        height,
        owner,
        null_mut(),
        instance,
        (&mut creation as *mut Create).cast(),
    );
    if !previous_context.is_null() {
        SetThreadDpiAwarenessContext(previous_context);
    }
    if !hwnd.is_null() {
        // A dark title bar in the window's colour, as the panel's (Windows 11; older versions ignore it).
        let dark: i32 = 1;
        DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE as u32, (&dark as *const i32).cast(), 4);
        let caption = panel::COACH_BACKGROUND;
        DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR as u32, (&caption as *const COLORREF).cast(), 4);
        SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, icons[0] as isize);
        SendMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, icons[1] as isize);
        ShowWindow(hwnd, SW_SHOWNORMAL);
        SetForegroundWindow(hwnd);
    }
    hwnd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_is_bounded_and_shows_the_most_recent_lines() {
        let history = CoachHistory {
            conversation_id: None,
            pending_request: None,
            messages: (0..12)
                .map(|index| CoachMessage {
                    role: CoachRole::Assistant,
                    content: format!("{index}{}\0\nend", "🚗".repeat(25_000)),
                })
                .collect(),
        };
        let text = transcript(&history);
        assert!(text.contains("Coach\r\n11"));
        assert!(!text.contains("Coach\r\n0"));
        assert!(!text.contains('\0'));
        assert!(text.encode_utf16().count() <= MAX_TRANSCRIPT_UNITS);
    }

    #[test]
    fn draft_limit_never_splits_a_surrogate_pair() {
        assert_eq!(truncate_utf16("a🚗b", 2), "a");
        assert_eq!(truncate_utf16("a🚗b", 3), "a🚗");
    }
}
