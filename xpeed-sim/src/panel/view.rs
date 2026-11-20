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
    /// Picks this language (its place in `Lang::ALL`) from the language list.
    Lang(usize),
    /// Puts the support text (versions, games, connection, last log lines) on the clipboard.
    CopyDiagnostics,
    /// Installs the new version that is waiting (never while a game is running: the tray decides).
    UpdateNow,
    /// Looks for a new version now ("Check now", "Try again").
    CheckUpdates,
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
    /// The units the dashboard's values are written in.
    pub units: crate::config::Units,
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
    /// The language list under the language button is open.
    pub lang_open: bool,
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
    /// What the person has driven, per game: the line under the cover in the middle of the waiting screen.
    pub played: crate::played::History,
    /// The games list's scroll bar as drawn in this frame, when the list is longer than its card.
    pub scroll: std::cell::Cell<Option<ScrollBar>>,
}

impl View<'_> {
    /// The dashboard on screen: the manual choice, else the one that fits the session.
    pub(super) fn dashboard_in_use(&self) -> DashboardId {
        pick(self.live.and_then(|l| l.session_kind), self.dashboard)
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
