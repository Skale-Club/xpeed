//! A modeless Win32 window owned by the Monitor. Only the window thread
//! touches its HWNDs; workers return bounded data through channels.

use super::*;
use crate::net::MAX_COACH_QUESTION_UNITS;
use crate::win;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, GetStockObject, MonitorFromWindow, COLOR_BTNFACE, DEFAULT_GUI_FONT, HBRUSH, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, GetKeyState, SetFocus, VK_ESCAPE, VK_SHIFT, VK_TAB};
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
// WinUser.h edit messages are in the optional Controls feature, which the
// Companion does not otherwise need.
const EDIT_LIMIT: u32 = 0x00c5;
const EDIT_SELECT: u32 = 0x00b1;
const EDIT_SCROLL_CARET: u32 = 0x00b7;
const CHECKED: usize = 1;
const MAX_TRANSCRIPT_UNITS: usize = 48_000;
const MAX_MESSAGE_DISPLAY_UNITS: usize = 16_000;

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
    unsafe fn create(owner: HWND) -> Option<Self> {
        let enable = button(owner, ENABLE, "Enable Coach here", BS_AUTOCHECKBOX as u32)?;
        let website = button(owner, WEBSITE, "Open website", BS_PUSHBUTTON as u32)?;
        let status = child(owner, "STATIC", "", 0, 0, 0)?;
        let session_label = child(owner, "STATIC", "Session", 0, 0, 0)?;
        let sessions = child(
            owner,
            "COMBOBOX",
            "",
            SESSIONS,
            WS_TABSTOP | WS_VSCROLL | CBS_DROPDOWNLIST as u32,
            0,
        )?;
        let refresh = button(owner, REFRESH, "Refresh", BS_PUSHBUTTON as u32)?;
        let transcript_label = child(owner, "STATIC", "Conversation", 0, 0, 0)?;
        let transcript = child(
            owner,
            "EDIT",
            "",
            TRANSCRIPT,
            WS_TABSTOP | WS_VSCROLL | (ES_MULTILINE | ES_AUTOVSCROLL | ES_READONLY) as u32,
            WS_EX_CLIENTEDGE,
        )?;
        let draft_label = child(owner, "STATIC", "Question draft", 0, 0, 0)?;
        let draft = child(
            owner,
            "EDIT",
            "",
            DRAFT,
            WS_TABSTOP | WS_VSCROLL | (ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN) as u32,
            WS_EX_CLIENTEDGE,
        )?;
        let send = button(owner, SEND, "Send", BS_PUSHBUTTON as u32)?;
        let record = button(owner, RECORD, "Record", BS_PUSHBUTTON as u32)?;
        let speak = button(owner, SPEAK, "Speak answer", BS_PUSHBUTTON as u32)?;
        let stop = button(owner, STOP, "Stop voice", BS_PUSHBUTTON as u32)?;
        let close = button(owner, CLOSE, "Close", BS_PUSHBUTTON as u32)?;
        SendMessageW(draft, EDIT_LIMIT, MAX_COACH_QUESTION_UNITS, 0);
        Some(Self {
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
        })
    }

    unsafe fn layout(self, hwnd: HWND) {
        let dpi = GetDpiForWindow(hwnd).max(96) as i32;
        let px = |value: i32| (value * dpi + 48) / 96;
        let mut client = RECT::default();
        if GetClientRect(hwnd, &mut client) == 0 {
            return;
        }
        let (w, h) = (client.right - client.left, client.bottom - client.top);
        let margin = px(14);
        let right = w - margin;
        let body = w - 2 * margin;
        let left = margin;
        let row = |control: HWND, x: i32, y: i32, width: i32, height: i32| {
            MoveWindow(control, x, y, width.max(1), height.max(1), 1);
        };
        row(self.enable, left, px(11), px(210), px(26));
        row(self.website, right - px(138), px(11), px(138), px(26));
        row(self.status, left, px(42), body, px(42));
        row(self.session_label, left, px(89), px(58), px(23));
        row(self.sessions, left + px(62), px(85), body - px(161), px(285));
        SendMessageW(self.sessions, CB_SETDROPPEDWIDTH, (body - px(62)).max(1) as usize, 0);
        row(self.refresh, right - px(90), px(85), px(90), px(26));
        row(self.transcript_label, left, px(123), body, px(20));
        let buttons_y = h - px(40);
        let draft_y = buttons_y - px(66);
        let draft_label_y = draft_y - px(22);
        row(self.transcript, left, px(144), body, draft_label_y - px(153));
        row(self.draft_label, left, draft_label_y, body, px(20));
        row(self.draft, left, draft_y, body, px(57));
        let mut x = left;
        for (control, width) in [(self.send, 75), (self.record, 82), (self.speak, 111), (self.stop, 92)] {
            row(control, x, buttons_y, px(width), px(27));
            x += px(width + 8);
        }
        row(self.close, right - px(75), buttons_y, px(75), px(27));
    }
}

unsafe fn child(owner: HWND, class: &str, label: &str, id: u16, style: u32, extended: u32) -> Option<HWND> {
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
    SendMessageW(control, WM_SETFONT, GetStockObject(DEFAULT_GUI_FONT) as usize, 1);
    if style & WS_TABSTOP != 0 {
        // The tray keeps its ordinary message loop. Handle tab traversal only
        // in the controls of this window, without a thread-wide keyboard hook.
        let previous = GetWindowLongPtrW(control, GWLP_WNDPROC);
        let saved = previous != 0 && SetPropW(control, OLD_PROC.as_ptr(), previous as _) != 0;
        if saved && SetWindowLongPtrW(control, GWLP_WNDPROC, control_proc as *const () as isize) == 0 {
            RemovePropW(control, OLD_PROC.as_ptr());
        }
    }
    Some(control)
}

unsafe fn button(owner: HWND, id: u16, label: &str, style: u32) -> Option<HWND> {
    child(owner, "BUTTON", label, id, WS_TABSTOP | style, 0)
}

unsafe extern "system" fn control_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let previous = GetPropW(hwnd, OLD_PROC.as_ptr());
    if previous.is_null() {
        return DefWindowProcW(hwnd, message, wparam, lparam);
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
        let combo_open = GetDlgCtrlID(hwnd) == SESSIONS as i32 && SendMessageW(hwnd, CB_GETDROPPEDSTATE, 0, 0) != 0;
        if !combo_open {
            PostMessageW(GetParent(hwnd), WM_CLOSE, 0, 0);
            return 0;
        }
    }
    if message == WM_NCDESTROY {
        RemovePropW(hwnd, OLD_PROC.as_ptr());
    }
    let original: WNDPROC = std::mem::transmute(previous);
    CallWindowProcW(original, hwnd, message, wparam, lparam)
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
}

impl State {
    unsafe fn status(&self, message: &str) {
        if let Some(c) = self.controls {
            set_text(c.status, message);
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
        SendMessageW(c.transcript, EDIT_SELECT, end, end as isize);
        SendMessageW(c.transcript, EDIT_SCROLL_CARET, 0, 0);
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
                SendMessageW(c.draft, EDIT_SELECT, end, end as isize);
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
            return 1;
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
            return 0;
        }
        WM_DPICHANGED => {
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
            info.ptMinTrackSize.x = 565 * dpi / 96;
            info.ptMinTrackSize.y = 430 * dpi / 96;
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
            let handled = if id == SESSIONS {
                code == CBN_SELCHANGE as u16
            } else {
                matches!(id, ENABLE | REFRESH | SEND | RECORD | SPEAK | STOP | WEBSITE | CLOSE) && code == BN_CLICKED as u16
            };
            if !handled || lparam == 0 || GetDlgItem(hwnd, id as i32) != lparam as HWND {
                return 0;
            }
        }
        WM_CREATE | WM_SIZE | WM_TIMER => {}
        _ => return DefWindowProcW(hwnd, message, wparam, lparam),
    }
    let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State;
    let Some(state) = state.as_mut() else {
        return DefWindowProcW(hwnd, message, wparam, lparam);
    };
    match message {
        WM_CREATE => {
            let Some(controls) = Controls::create(hwnd) else { return -1 };
            state.controls = Some(controls);
            state.render_sessions();
            state.status(if state.watch.is_some() {
                "Coach is off. Checking this computer's pairing…"
            } else {
                "The computer pairing is unavailable. You can still use the Companion monitor."
            });
            state.update_controls();
            controls.layout(hwnd);
            if SetTimer(hwnd, TIMER, TICK_MS, None) == 0 {
                return -1;
            }
        }
        WM_SIZE => {
            if let Some(controls) = state.controls {
                controls.layout(hwnd);
            }
        }
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
            hbrBackground: (COLOR_BTNFACE + 1) as usize as HBRUSH,
            lpszMenuName: null(),
            lpszClassName: class.as_ptr(),
            hIconSm: icons[1],
        };
        RegisterClassExW(&window);
        let state = Box::new(State {
            controls: None,
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
        });
        let mut creation = Create(Some(state));
        let previous_context = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let dpi = GetDpiForWindow(owner).max(96) as i32;
        let (mut width, mut height) = (790 * dpi / 96, 650 * dpi / 96);
        let (x, y) = if let Some(bounds) = work_area(owner) {
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
            SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, icons[0] as isize);
            SendMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, icons[1] as isize);
            ShowWindow(hwnd, SW_SHOWNORMAL);
            SetForegroundWindow(hwnd);
        }
        hwnd
    }
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
