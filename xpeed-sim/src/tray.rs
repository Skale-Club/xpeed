//! Xpeed Companion as a program that lives in the notification area: an icon whose colour tells the state, a menu, balloons
//! for what matters, and the connection to the Xpeed account. Everything here runs on one thread (the Windows message
//! loop); recording and sending run on their own threads and reach this one through `Shared`.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::ptr::{null, null_mut};
use std::sync::{Arc, Mutex};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateIconIndirect, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyMenu, DestroyWindow,
    DispatchMessageW, FindWindowW, GetCursorPos, GetMessageW, GetSystemMetrics, GetWindowLongPtrW, LoadImageW, PostMessageW,
    PostQuitMessage, RegisterClassW, RegisterWindowMessageW, SetForegroundWindow, SetWindowLongPtrW, TrackPopupMenu, TranslateMessage,
    CREATESTRUCTW, GWLP_USERDATA, HICON, ICONINFO, IMAGE_ICON, LR_SHARED, MF_CHECKED, MF_GRAYED, MF_POPUP, MF_SEPARATOR, MF_STRING, MSG,
    SM_CXICON, SM_CXSMICON, TPM_BOTTOMALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_APP, WM_CONTEXTMENU, WM_DESTROY, WM_LBUTTONUP, WM_NCCREATE,
    WM_NULL, WM_RBUTTONUP, WNDCLASSW, WS_OVERLAPPED,
};

use crate::config::{self, Config, DEFAULT_SERVER};
use crate::icon::{self, Light};
use crate::outbox::{Backoff, Observer, Uploader};
use crate::panel::{self, Account};
use crate::present;
use crate::status::{Cloud, Game, Notice, Shared};
use crate::text::{text, Lang, Msg};
use crate::{applog, connect, engine, link, net, win};

const CLASS: &str = "XpeedSimTray";
const INSTANCE_NAME: &str = "Local\\XpeedSimTray";

const WM_TRAY: u32 = WM_APP + 1;
const WM_CHANGED: u32 = WM_APP + 2;
const WM_RELOAD: u32 = WM_APP + 3;
/// Another copy (`xpeed-companion panel`) asks this one to open its panel.
const WM_OPEN_PANEL: u32 = WM_APP + 4;
/// The panel picked a language (`wparam`: its place in `Lang::ALL`).
const WM_SET_LANG: u32 = WM_APP + 5;
/// The server said who the computer is connected as and it was saved: show it.
const WM_ACCOUNT: u32 = WM_APP + 6;

const CMD_CONNECT: usize = 1;
const CMD_LAPS: usize = 2;
const CMD_PAUSE: usize = 3;
const CMD_AUTOSTART: usize = 4;
const CMD_QUIT: usize = 5;
const CMD_PANEL: usize = 6;
/// The languages of the menu, in the order of `Lang::ALL`, from this id up.
const CMD_LANG: usize = 20;

const LIGHTS: [Light; 4] = [Light::Grey, Light::Amber, Light::Green, Light::Red];

struct App {
    hwnd: HWND,
    shared: Arc<Shared>,
    lang: Lang,
    laps_dir: PathBuf,
    config_path: PathBuf,
    exe: PathBuf,
    icons: [HICON; 4],
    server: String,
    device: Option<String>,
    /// Who the computer is connected as, when the connection page said so.
    account_label: Option<String>,
    taskbar_created: u32,
    /// The panel window, when it has been opened (it may have been closed since).
    panel: HWND,
    /// The account as the panel shows it.
    account: Arc<Mutex<Account>>,
    /// The program's own icon (no state dot), big and small, for the panel's title bar and taskbar button.
    panel_icons: [HICON; 2],
}

fn icon_for(light: Light) -> HICON {
    let size = unsafe { GetSystemMetrics(SM_CXSMICON) }.clamp(16, 64) as u32;
    icon_of(size, Some(light))
}

/// The program's own icon (no state dot), big and small, for a window's title bar and taskbar button. The caller
/// destroys both.
pub fn program_icons() -> [HICON; 2] {
    [icon_of(32, None), icon_of(16, None)]
}

/// The icon embedded in the program (resource 1, the Xpeed mark) at the size Windows wants for a big or a small icon;
/// the drawn icon when the program was built without resources. The embedded one is shared and must not be destroyed.
pub fn class_icon(small: bool) -> HICON {
    unsafe {
        let size = GetSystemMetrics(if small { SM_CXSMICON } else { SM_CXICON }).clamp(16, 256);
        let handle = LoadImageW(
            GetModuleHandleW(null()),
            std::ptr::without_provenance::<u16>(1),
            IMAGE_ICON,
            size,
            size,
            LR_SHARED,
        );
        if handle.is_null() {
            icon_of(size as u32, None)
        } else {
            handle as HICON
        }
    }
}

fn icon_of(size: u32, light: Option<Light>) -> HICON {
    unsafe {
        let pixels = icon::render(size, light);
        let color = CreateBitmap(size as i32, size as i32, 1, 32, pixels.as_ptr().cast());
        // The mask is not used (the alpha channel does the work); a one-bit bitmap takes rows of whole 16-bit words.
        let mask_bytes = vec![0u8; (size.div_ceil(16) * 2 * size) as usize];
        let mask = CreateBitmap(size as i32, size as i32, 1, 1, mask_bytes.as_ptr().cast());
        let info = ICONINFO {
            fIcon: 1,
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask,
            hbmColor: color,
        };
        let handle = CreateIconIndirect(&info);
        DeleteObject(mask);
        DeleteObject(color);
        handle
    }
}

fn index_of(light: Light) -> usize {
    LIGHTS.iter().position(|l| *l == light).unwrap_or(1)
}

/// Starts the thread that sends laps, reporting into the shared status and the log.
fn start_uploader(shared: &Arc<Shared>, dir: &Path, config: Config) {
    let (for_cloud, for_sent) = (shared.clone(), shared.clone());
    let observer = Observer {
        say: Arc::new(|line| applog::line(&line)),
        cloud: Arc::new(move |state| {
            if state == Cloud::Refused {
                for_cloud.notify(Notice::Refused);
            }
            for_cloud.update(|s| s.cloud = state);
        }),
        // One lap going right after it was saved needs no word; a pile that was waiting does.
        sent: Arc::new(move |n| {
            if n >= 2 {
                for_sent.notify(Notice::LapsSent(n));
            }
        }),
    };
    shared.set_uploader(Some(Uploader::start(dir.to_path_buf(), config, Backoff::default(), observer)));
}

/// Asks the server who this computer is connected as (a pairing made the old way never saved it, and an email may have
/// changed), saves the answer and tells the tray. Off the tray's thread; any failure leaves things as they are.
fn refresh_account(hwnd: HWND, config_path: &Path, config: &Config) {
    let (target, path, server, token) = (
        hwnd as isize,
        config_path.to_path_buf(),
        config.server.clone(),
        config.token.clone(),
    );
    std::thread::spawn(move || match net::whoami(&net::agent(), &server, &token) {
        Ok(account) => match config::update_account(&path, &token, &account) {
            Ok(true) => unsafe {
                PostMessageW(target as HWND, WM_ACCOUNT, 0, 0);
            },
            Ok(false) => {}
            Err(why) => applog::line(&why),
        },
        Err(why) => applog::line(&format!("could not ask the account: {why}")),
    });
}

impl App {
    fn nid(&self, flags: u32) -> NOTIFYICONDATAW {
        let mut nid: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
        nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        nid.hWnd = self.hwnd;
        nid.uID = 1;
        nid.uFlags = flags;
        nid
    }

    fn add_icon(&self) {
        let snapshot = self.shared.snapshot();
        let mut nid = self.nid(NIF_ICON | NIF_MESSAGE | NIF_TIP);
        nid.uCallbackMessage = WM_TRAY;
        nid.hIcon = self.icons[index_of(present::light_of(&snapshot))];
        win::fill(&mut nid.szTip, &present::tooltip(self.lang, &snapshot, self.device.as_deref()));
        let added = unsafe { Shell_NotifyIconW(NIM_ADD, &nid) } != 0;
        applog::line(if added {
            "tray icon added"
        } else {
            "the tray icon could not be added"
        });
    }

    /// The icon, the tooltip and any balloons, to match the state.
    fn refresh(&self) {
        let snapshot = self.shared.snapshot();
        let mut nid = self.nid(NIF_ICON | NIF_TIP);
        nid.hIcon = self.icons[index_of(present::light_of(&snapshot))];
        win::fill(&mut nid.szTip, &present::tooltip(self.lang, &snapshot, self.device.as_deref()));
        unsafe {
            Shell_NotifyIconW(NIM_MODIFY, &nid);
        }
        // Windows shows one balloon at a time, so the newest wins.
        if let Some(notice) = self.shared.take_notices().last() {
            let (title, body) = present::notice_text(self.lang, notice);
            let mut nid = self.nid(NIF_INFO);
            win::fill(&mut nid.szInfoTitle, &title);
            win::fill(&mut nid.szInfo, &body);
            nid.dwInfoFlags = NIIF_INFO;
            unsafe {
                Shell_NotifyIconW(NIM_MODIFY, &nid);
            }
        }
    }

    /// Opens the panel, or brings it to the front.
    fn open_panel(&mut self) {
        let (shared, account) = (self.shared.clone(), self.account.clone());
        let [icon_big, icon_small] = self.panel_icons;
        self.panel = panel::show(self.panel, move || panel::Context {
            shared,
            account,
            readers: crate::games::READERS.iter().map(|r| (r.title.to_owned(), r.ids.to_vec())).collect(),
            icon_big,
            icon_small,
            quit_on_close: false,
        });
    }

    /// The account and language as the panel shows them, from what the tray knows now.
    fn sync_account(&self) {
        *self.account.lock().unwrap() = Account {
            device: self.device.clone(),
            server: self.server.clone(),
            label: self.account_label.clone(),
            lang: self.lang,
        };
    }

    /// The person picked a language in the menu: remember it, and show it everywhere at once.
    fn set_lang(&mut self, lang: Lang) {
        self.lang = lang;
        if let Some(home) = config::home_dir() {
            if let Err(why) = config::save_lang(&home, lang) {
                applog::line(&why);
            }
        }
        self.sync_account();
        self.refresh();
    }

    /// Reads the pairing again (a link just changed it) and starts or stops sending to match.
    fn reload_pairing(&mut self) {
        match config::load(&self.config_path) {
            Ok(Some(config)) => {
                applog::line(&format!("paired with {} as {}", config.server, config.device_name));
                self.server = config.server.clone();
                self.device = Some(config.device_name.clone());
                self.account_label = config.account.clone();
                self.shared.update(|s| s.cloud = Cloud::Idle);
                self.shared
                    .notify(Notice::Paired(config.account.clone().unwrap_or_else(|| config.device_name.clone())));
                refresh_account(self.hwnd, &self.config_path, &config);
                start_uploader(&self.shared, &self.laps_dir, config);
            }
            _ => {
                self.device = None;
                self.account_label = None;
                self.shared.set_uploader(None);
                self.shared.update(|s| s.cloud = Cloud::NotPaired);
            }
        }
        self.sync_account();
        self.refresh();
    }

    fn show_menu(&mut self) {
        let snapshot = self.shared.snapshot();
        let say = |msg: Msg| win::wide(&text(self.lang, &msg));
        unsafe {
            let menu = CreatePopupMenu();
            let line = |flags: u32, id: usize, label: Vec<u16>| {
                AppendMenuW(menu, flags, id, label.as_ptr());
            };
            // What is going on, in lines that cannot be clicked.
            line(MF_STRING | MF_GRAYED, 0, win::wide(&present::game_line_of(self.lang, &snapshot)));
            line(
                MF_STRING | MF_GRAYED,
                0,
                win::wide(&present::cloud_line(self.lang, &snapshot.cloud, self.device.as_deref())),
            );
            if let Some(last) = &snapshot.last_lap {
                line(MF_STRING | MF_GRAYED, 0, win::wide(last));
            }
            line(MF_SEPARATOR, 0, vec![0]);
            line(MF_STRING, CMD_PANEL, say(Msg::MenuPanel));
            if snapshot.cloud == Cloud::NotPaired || snapshot.cloud == Cloud::Refused {
                line(MF_STRING, CMD_CONNECT, say(Msg::MenuConnect));
            }
            line(MF_STRING, CMD_LAPS, say(Msg::MenuOpenLaps));
            line(
                MF_STRING,
                CMD_PAUSE,
                say(if self.shared.paused() { Msg::MenuResume } else { Msg::MenuPause }),
            );
            let on = win::autostart_enabled(win::RUN_KEY, win::RUN_NAME);
            line(MF_STRING | if on { MF_CHECKED } else { 0 }, CMD_AUTOSTART, say(Msg::MenuAutostart));
            // The language: English unless the person picks another here (each shown in its own words).
            let languages = CreatePopupMenu();
            for (i, lang) in Lang::ALL.into_iter().enumerate() {
                let checked = if lang == self.lang { MF_CHECKED } else { 0 };
                AppendMenuW(languages, MF_STRING | checked, CMD_LANG + i, win::wide(lang.name()).as_ptr());
            }
            AppendMenuW(menu, MF_POPUP, languages as usize, say(Msg::MenuLanguage).as_ptr());
            line(MF_SEPARATOR, 0, vec![0]);
            line(MF_STRING, CMD_QUIT, say(Msg::MenuQuit));

            let mut at = POINT { x: 0, y: 0 };
            GetCursorPos(&mut at);
            // The menu closes when the person clicks elsewhere only if our window was in front first.
            SetForegroundWindow(self.hwnd);
            let chosen = TrackPopupMenu(
                menu,
                TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_RETURNCMD,
                at.x,
                at.y,
                0,
                self.hwnd,
                null(),
            );
            PostMessageW(self.hwnd, WM_NULL, 0, 0);
            DestroyMenu(menu);
            self.command(chosen as usize);
        }
    }

    fn command(&mut self, id: usize) {
        match id {
            CMD_PANEL => self.open_panel(),
            CMD_CONNECT => start_connect(&self.server),
            CMD_LAPS => {
                let _ = std::fs::create_dir_all(&self.laps_dir);
                win::open(&self.laps_dir.display().to_string());
            }
            CMD_PAUSE => {
                self.shared.set_paused(!self.shared.paused());
                self.shared.update(|s| {
                    if s.game == Game::Paused {
                        s.game = Game::Waiting;
                    }
                });
                self.refresh();
            }
            CMD_AUTOSTART => {
                let on = win::autostart_enabled(win::RUN_KEY, win::RUN_NAME);
                if let Err(why) = win::set_autostart(win::RUN_KEY, win::RUN_NAME, !on, &self.exe) {
                    applog::line(&why);
                }
            }
            id if (CMD_LANG..CMD_LANG + Lang::ALL.len()).contains(&id) => self.set_lang(Lang::ALL[id - CMD_LANG]),
            CMD_QUIT => unsafe {
                DestroyWindow(self.hwnd);
            },
            _ => {}
        }
    }
}

impl Drop for App {
    fn drop(&mut self) {
        for icon in self.icons.into_iter().chain(self.panel_icons) {
            unsafe {
                DestroyIcon(icon);
            }
        }
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_NCCREATE {
        let create = lparam as *const CREATESTRUCTW;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, (*create).lpCreateParams as isize);
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    let app = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut App;
    if app.is_null() {
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    let app = &mut *app;
    match message {
        WM_TRAY => {
            let event = (lparam & 0xffff) as u32;
            // A click opens the panel; the right button (or the menu key) opens the menu.
            if event == WM_LBUTTONUP {
                app.open_panel();
            } else if event == WM_RBUTTONUP || event == WM_CONTEXTMENU {
                app.show_menu();
            }
            0
        }
        WM_CHANGED => {
            app.refresh();
            0
        }
        WM_RELOAD => {
            app.reload_pairing();
            0
        }
        WM_ACCOUNT => {
            if let Ok(Some(config)) = config::load(&app.config_path) {
                app.account_label = config.account;
                app.sync_account();
                app.refresh();
            }
            0
        }
        WM_OPEN_PANEL => {
            app.open_panel();
            0
        }
        WM_SET_LANG => {
            if let Some(&lang) = Lang::ALL.get(wparam) {
                app.set_lang(lang);
            }
            0
        }
        WM_DESTROY => {
            let nid = app.nid(0);
            Shell_NotifyIconW(NIM_DELETE, &nid);
            PostQuitMessage(0);
            0
        }
        other if other == app.taskbar_created => {
            // Explorer restarted: its notification area is empty again.
            app.add_icon();
            0
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

fn find_running() -> HWND {
    unsafe { FindWindowW(win::wide(CLASS).as_ptr(), null()) }
}

/// Where laps are written when nobody chose a folder: `Documents\Xpeed Companion\Laps`.
pub fn laps_dir() -> PathBuf {
    config::default_laps_dir()
}

/// Tells the tray of this program that the panel picked a language. False when there is none (the panel demo).
pub fn set_lang_of_running(lang: Lang) -> bool {
    let Some(index) = Lang::ALL.iter().position(|l| *l == lang) else {
        return false;
    };
    let running = find_running();
    !running.is_null() && unsafe { PostMessageW(running, WM_SET_LANG, index, 0) } != 0
}

/// Asks the copy that is running to open its panel. False when none is running.
pub fn open_panel_of_running() -> bool {
    let running = find_running();
    !running.is_null() && unsafe { PostMessageW(running, WM_OPEN_PANEL, 0, 0) } != 0
}

/// Runs the tray app until the person quits it, with the panel open from the start when `open_panel` is set.
pub fn run(open_panel: bool) -> ExitCode {
    let Some(_only_copy) = win::single_instance(INSTANCE_NAME) else {
        return ExitCode::SUCCESS;
    };
    let Some(home) = config::home_dir() else {
        win::tell_error("Xpeed Companion", "Cannot tell where to keep Xpeed Companion's files.");
        return ExitCode::from(1);
    };
    applog::init(home.join("companion.log"));
    applog::line(&format!(
        "Xpeed Companion {} ({}) starting",
        env!("CARGO_PKG_VERSION"),
        env!("XPEED_BUILD")
    ));

    // The old "Xpeed Sim" start-up value: carried to the new name when it was on, and removed either way.
    match win::migrate_autostart(
        win::RUN_KEY,
        win::LEGACY_RUN_NAME,
        win::RUN_NAME,
        &std::env::current_exe().unwrap_or_default(),
    ) {
        Ok(true) => applog::line("start with Windows: the old start-up entry was replaced by the new one"),
        Ok(false) => {}
        Err(why) => applog::line(&format!("start with Windows: could not replace the old start-up entry: {why}")),
    }

    let config_path = home.join("config.json");
    let config = match config::load(&config_path) {
        Ok(config) => config,
        Err(why) => {
            applog::line(&why);
            None
        }
    };
    let lang = config::load_lang(&home);
    let laps_dir = laps_dir();
    let shared = Shared::new(config.is_some());

    unsafe {
        let instance = GetModuleHandleW(null());
        let class = win::wide(CLASS);
        let window_class = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: class_icon(false),
            hCursor: null_mut(),
            hbrBackground: null_mut(),
            lpszMenuName: null(),
            lpszClassName: class.as_ptr(),
        };
        if RegisterClassW(&window_class) == 0 {
            applog::line("could not register the window class");
            return ExitCode::from(1);
        }
        let app = Box::new(App {
            hwnd: null_mut(),
            shared: shared.clone(),
            lang,
            laps_dir: laps_dir.clone(),
            config_path,
            exe: std::env::current_exe().unwrap_or_default(),
            icons: LIGHTS.map(icon_for),
            server: config.as_ref().map_or_else(|| DEFAULT_SERVER.to_owned(), |c| c.server.clone()),
            device: config.as_ref().map(|c| c.device_name.clone()),
            account_label: config.as_ref().and_then(|c| c.account.clone()),
            taskbar_created: RegisterWindowMessageW(win::wide("TaskbarCreated").as_ptr()),
            panel: null_mut(),
            account: Arc::new(Mutex::new(Account::default())),
            panel_icons: program_icons(),
        });
        app.sync_account();
        let app = Box::into_raw(app);
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            win::wide("Xpeed Companion").as_ptr(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            null_mut(),
            null_mut(),
            instance,
            app.cast(),
        );
        if hwnd.is_null() {
            applog::line("could not create the window");
            drop(Box::from_raw(app));
            return ExitCode::from(1);
        }
        (*app).hwnd = hwnd;
        (*app).add_icon();
        if open_panel {
            (*app).open_panel();
        }

        // The other threads wake this one by posting a message; the window handle travels as a number.
        let target = hwnd as isize;
        shared.set_on_change(move || {
            PostMessageW(target as HWND, WM_CHANGED, 0, 0);
        });

        if let Some(config) = config {
            applog::line(&format!("paired with {} as {}", config.server, config.device_name));
            refresh_account(hwnd, &(*app).config_path, &config);
            start_uploader(&shared, &laps_dir, config);
        } else {
            shared.notify(Notice::NotPaired);
        }
        let recorder = {
            let (shared, dir) = (shared.clone(), laps_dir.clone());
            std::thread::spawn(move || {
                if let Err(why) = engine::run(&dir, &shared, &|line| applog::line(&line), false) {
                    applog::line(&why);
                }
            })
        };

        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        applog::line("quitting");
        shared.quit();
        let _ = recorder.join();
        shared.set_uploader(None);
        drop(Box::from_raw(app));
    }
    ExitCode::SUCCESS
}

/// What happens when the Xpeed site opens an `xpeedsim://pair?...` link: ask, connect, and tell the running copy
/// (or start one).
pub fn pair_from_link(url: &str) -> ExitCode {
    let lang = config::home_dir().map_or(Lang::En, |home| config::load_lang(&home));
    let failed = |why: String| {
        win::tell_error(&text(lang, &Msg::PairFailedTitle), &text(lang, &Msg::PairFailed(why)));
        ExitCode::from(1)
    };
    let link = match link::parse(url) {
        Ok(link) => link,
        Err(why) => return failed(why),
    };
    let host = link.server.split("://").nth(1).unwrap_or(&link.server).to_owned();
    if !win::ask_yes_no(&text(lang, &Msg::AskPairTitle), &text(lang, &Msg::AskPair(host))) {
        return ExitCode::SUCCESS;
    }
    let Some(path) = config::default_path() else {
        return failed("cannot tell where to keep the pairing".into());
    };
    let name = config::device_name();
    let token = match net::pair(&net::agent(), &link.server, &link.code, &name) {
        Ok(token) => token,
        Err(why) => return failed(why),
    };
    if let Err(why) = config::save(
        &path,
        &Config {
            server: link.server,
            token,
            device_name: name,
            account: None,
        },
    ) {
        return failed(why);
    }
    let running = find_running();
    if running.is_null() {
        // Not running: start it, and it reads the pairing it was just given.
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::process::Command::new(exe).arg("run").spawn();
        }
    } else {
        unsafe {
            PostMessageW(running, WM_RELOAD, 0, 0);
        }
    }
    ExitCode::SUCCESS
}

/// The person asked to connect this computer (the panel's button or the tray menu): the short way, with a page where
/// they click Connect once. With a request already open this only opens its page again. When the server says yes the
/// running copy of this program is told to read the new pairing (`WM_RELOAD`).
pub fn start_connect(server: &str) {
    let hooks = connect::Hooks {
        open: Box::new(win::open),
        connected: Box::new(|config| {
            applog::line(&format!("connected to {} by the connection page", config.server));
            let running = find_running();
            if !running.is_null() {
                unsafe {
                    PostMessageW(running, WM_RELOAD, 0, 0);
                }
            }
        }),
    };
    connect::click(
        &connect::Flow::global(),
        server,
        config::default_path(),
        std::sync::Arc::new(hooks),
        connect::Timing::default(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_programs_own_icons_are_made_for_the_big_and_the_small_slot() {
        let icons = program_icons();
        assert!(icons.iter().all(|i| !i.is_null()), "both icons exist");
        for icon in icons {
            unsafe {
                DestroyIcon(icon);
            }
        }
    }
}
