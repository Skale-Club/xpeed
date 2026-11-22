use super::*;

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
    /// Opens the optional native session coach with its local switch off.
    Coach,
    /// Brings this cover of the waiting screen's carousel to the middle.
    Cover(usize),
    /// Opens the example of this cover's game (the one in the middle of the carousel): its dashboard on made-up driving.
    Preview(usize),
    /// Opens the example with every card ("See the dashboards").
    PreviewAll,
    /// Closes the example (the header's "Example" pill).
    ExitPreview,
    /// Picks this language (its place in `Lang::ALL`) on the Settings screen (kept as a change waiting for Save).
    Lang(usize),
    /// Puts the support text (versions, games, connection, last log lines) on the clipboard.
    CopyDiagnostics,
    /// Installs the new version that is waiting (never while a game is running: the tray decides).
    UpdateNow,
    /// Looks for a new version now ("Check now", "Try again").
    CheckUpdates,
    /// Switches one of the Settings screen's on/off choices.
    Toggle(Pref),
    /// Picks the unit at this place in its kind's list (`SpeedUnit::ALL` and the others).
    Unit(UnitKind, usize),
    /// Keeps the Settings screen's changes that wait (language, units, switches).
    Save,
    /// Forgets them: the screen shows what is kept again.
    Discard,
}

/// The Settings screen's preferences as the person left them there: what is kept until Save, then kept for good.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Draft {
    pub lang: Lang,
    pub units: crate::config::Units,
    pub prefs: Prefs,
}

/// A choice of the Settings screen that is on or off (the tray menu has the same ones, with a check mark).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pref {
    Autostart,
    AutoUpdate,
    PhoneView,
}

/// The kinds of value whose unit the person picks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnitKind {
    Speed,
    Temperature,
    Pressure,
    Fuel,
}

impl UnitKind {
    pub const ALL: [UnitKind; 4] = [UnitKind::Speed, UnitKind::Temperature, UnitKind::Pressure, UnitKind::Fuel];

    /// Its name, as the tray menu says it.
    pub fn msg(self) -> Msg {
        match self {
            UnitKind::Speed => Msg::MenuUnitSpeed,
            UnitKind::Temperature => Msg::MenuUnitTemperature,
            UnitKind::Pressure => Msg::MenuUnitPressure,
            UnitKind::Fuel => Msg::MenuUnitFuel,
        }
    }

    /// The choices' labels and the place of the one in use.
    pub fn choices(self, units: crate::config::Units) -> (Vec<&'static str>, usize) {
        use crate::config::{FuelUnit, PressureUnit, SpeedUnit, TempUnit};
        fn of<T: Copy + PartialEq>(all: &[T], now: T, label: fn(T) -> &'static str) -> (Vec<&'static str>, usize) {
            (
                all.iter().map(|u| label(*u)).collect(),
                all.iter().position(|u| *u == now).unwrap_or(0),
            )
        }
        match self {
            UnitKind::Speed => of(SpeedUnit::ALL, units.speed, SpeedUnit::label),
            UnitKind::Temperature => of(TempUnit::ALL, units.temperature, TempUnit::label),
            UnitKind::Pressure => of(PressureUnit::ALL, units.pressure, PressureUnit::label),
            UnitKind::Fuel => of(FuelUnit::ALL, units.fuel, FuelUnit::label),
        }
    }

    /// The units with the one at `index` of this kind picked (an index out of the list changes nothing).
    pub fn pick(self, units: crate::config::Units, index: usize) -> crate::config::Units {
        use crate::config::{FuelUnit, PressureUnit, SpeedUnit, TempUnit};
        let mut out = units;
        match self {
            UnitKind::Speed => out.speed = SpeedUnit::ALL.get(index).copied().unwrap_or(units.speed),
            UnitKind::Temperature => out.temperature = TempUnit::ALL.get(index).copied().unwrap_or(units.temperature),
            UnitKind::Pressure => out.pressure = PressureUnit::ALL.get(index).copied().unwrap_or(units.pressure),
            UnitKind::Fuel => out.fuel = FuelUnit::ALL.get(index).copied().unwrap_or(units.fuel),
        }
        out
    }
}

/// The on/off choices as the tray knows them, for the Settings screen to show.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Prefs {
    pub autostart: bool,
    pub auto_update: bool,
    pub phone_view: bool,
}

impl Prefs {
    pub fn get(self, pref: Pref) -> bool {
        match pref {
            Pref::Autostart => self.autostart,
            Pref::AutoUpdate => self.auto_update,
            Pref::PhoneView => self.phone_view,
        }
    }

    /// The same choices with this one switched.
    pub fn toggled(self, pref: Pref) -> Prefs {
        let mut out = self;
        match pref {
            Pref::Autostart => out.autostart = !self.autostart,
            Pref::AutoUpdate => out.auto_update = !self.auto_update,
            Pref::PhoneView => out.phone_view = !self.phone_view,
        }
        out
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Tab {
    Dash,
    Monitor,
    Settings,
    /// A page of the website, shown inside the panel (`webview`): the place of the site's menu it is on.
    Web(super::site::WebPlace),
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
    /// The units the dashboard's values are written in.
    pub units: crate::config::Units,
    /// The on/off choices the Settings screen shows.
    pub prefs: Prefs,
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
    /// The paired tray can use Coach. The panel demo never offers it.
    pub coach_available: bool,
    pub recent_laps: &'a [SavedLap],
    /// What happened, in the person's language: `(time as HH:MM, text)`, newest first.
    pub activity: &'a [(String, String, Role)],
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
    /// The dashboard's layout in use: read at the start of a frame and set by it, so a window dragged through a
    /// threshold only changes layout when another one is clearly better (`pick_layout_sticky`).
    pub layout: std::cell::Cell<Option<Layout>>,
    /// The dashboard chosen by hand for the game that is open; `None` is automatic (picked from the session).
    pub(super) dashboard: Option<DashboardId>,
    /// The views the driver saved for the dashboards (the built-in rows where there is none).
    pub(super) views: &'a Views,
    /// The layout being edited (edit mode), else `None`: the dashboard is drawn for editing and the toolbar is shown.
    pub(super) edit: Option<&'a EditUi>,
    /// Where edit mode drew the canvas in this frame (scale and origin, pixels), for the mouse that follows.
    pub(super) edit_xf: std::cell::Cell<Option<Xf>>,
    /// How many phones are watching the panel through the Xpeed server (none unless "Show the panel on my phone" is on).
    pub phone_viewers: u32,
    /// The Settings screen's changes that wait for Save (`None` when what it shows is what is kept).
    pub draft: Option<Draft>,
    /// The workspace menu under the header's dashboard pill is open, and until when (ms) its reset waits for the second click.
    pub(super) workspace_open: bool,
    pub(super) workspace_reset_until: i64,
    /// The diagnostics were copied a moment ago: the Monitor tab says so for two seconds.
    pub copied: bool,
    /// The background parts that stopped for good, named (empty when none): the Monitor tab says so in red.
    pub failed: &'a str,
    /// A new version of Xpeed Companion that is waiting, downloading or not there: the Monitor tab shows a card for it.
    pub update: &'a crate::update::UpdateState,
    /// What the last look for a new version said, and how much of a download has arrived: the rest of the update card.
    pub check: &'a crate::update::CheckState,
    pub download_percent: Option<u8>,
    /// The game that is open, when one is (its id, name and state): the waiting screen is about it, not the list.
    pub focus: Option<(&'static str, &'static str, Game)>,
    /// The games list's scroll bar as drawn in this frame, when the list is longer than its card.
    pub scroll: std::cell::Cell<Option<ScrollBar>>,
    /// The example is on the dashboard tab (made-up driving, no game): the words of the header's pill that closes it.
    pub preview: Option<String>,
}

impl View<'_> {
    /// The dashboard on screen: the manual choice, else the one that fits the session.
    pub(super) fn dashboard_in_use(&self) -> DashboardId {
        pick(
            self.live.and_then(|l| l.session_kind),
            self.live.is_some_and(|l| l.time_trial),
            self.dashboard,
        )
    }
}

/// A list's scroll bar as drawn (pixels): the list, the bar's track and thumb, how far the list scrolls (design
/// units) and how many of those one pixel of the thumb's travel is.
#[derive(Clone, Copy)]
pub struct ScrollBar {
    pub(super) area: RECT,
    pub(super) track: RECT,
    pub(super) thumb: RECT,
    pub(super) max: f32,
    pub(super) per_px: f32,
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
    pub units: crate::config::Units,
    pub prefs: Prefs,
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
