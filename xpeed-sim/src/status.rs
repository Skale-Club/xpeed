//! What Xpeed Companion is doing, shared between the thread that records, the thread that sends and the tray icon.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::dash::Live;
use crate::heartbeat::{self, Heartbeat, View};
use crate::outbox::Uploader;
use crate::phone::Worker as PhoneWorker;
use crate::reference::{References, Worker as ReferenceWorker};
use crate::supervisor::Health;
use crate::update::{CheckState, UpdateState};
use crate::util::lock;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Game {
    /// The game is not running (or not sharing data).
    Waiting,
    /// The game shares data; no lap is being driven yet.
    Connected,
    Recording(u32),
    Paused,
    /// This build cannot read this version of the game.
    Unsupported,
    /// The game is running but shares no data (its option is off, its plugin is missing, or it is still loading).
    Silent,
    /// The game's program has just started: no data yet, give it time (splash screens; some games share only once loaded).
    Loading,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cloud {
    NotPaired,
    /// Everything saved has been sent.
    Idle,
    /// This many laps are waiting to be sent.
    Waiting(usize),
    /// The server no longer accepts this computer's key.
    Refused,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub game: Game,
    /// The game `game` is about (the one recorded, or connected), when there is one.
    pub title: Option<&'static str>,
    pub cloud: Cloud,
    pub laps_saved: u32,
    /// The last lap saved in this run (`text::lap_label` says it in the person's language).
    pub last_lap: Option<SavedLap>,
}

/// A lap that was written to the laps folder: what the panel and the tray say about it. Data, not a label: the words
/// ("Lap", "not valid") are made when it is shown, in the person's language.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedLap {
    pub number: u32,
    pub time_ms: u32,
    pub valid: bool,
    /// The sector times the game gave for the lap, in order (empty when it gave none).
    pub sectors_ms: Vec<u32>,
    pub game: String,
    pub track: String,
    pub car: String,
    /// The lap's speed (km/h) at `SPEED_POINTS` even steps along it, for the Monitor's mini graph (owner-approved module
    /// 10, 2026-11-19); empty when the lap has no speed.
    pub speed_kmh: Vec<u16>,
}

/// How many points of a lap's speed the Monitor keeps.
pub const SPEED_POINTS: usize = 48;

/// A lap's speed samples (m/s) as `SPEED_POINTS` averages in km/h, the samples split evenly; samples that are not
/// numbers are left out, and a lap with fewer samples than points keeps none.
pub fn speed_profile(values: &[f32]) -> Vec<u16> {
    if values.len() < SPEED_POINTS {
        return Vec::new();
    }
    (0..SPEED_POINTS)
        .map(|k| {
            let part = &values[k * values.len() / SPEED_POINTS..(k + 1) * values.len() / SPEED_POINTS];
            let (sum, count) = part.iter().filter(|v| v.is_finite()).fold((0.0, 0), |(s, n), v| (s + v, n + 1));
            if count == 0 {
                0
            } else {
                (sum / count as f32 * 3.6).round().clamp(0.0, f32::from(u16::MAX)) as u16
            }
        })
        .collect()
}

/// Something worth a short word to the person (a balloon from the tray icon). The tray puts it in their language.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notice {
    LapSaved(SavedLap),
    /// Several laps went at once (after being offline).
    LapsSent(u32),
    /// Connected under this device name.
    Paired(String),
    NotPaired,
    Refused,
    /// Xpeed Companion was updated to this version (said once, by the first start after the update).
    Updated(String),
    /// "Update now" was asked while a game is running: it waits (this version) until no game is.
    UpdateBlocked(String),
    /// A check the person asked for found nothing newer (this is the version running).
    UpToDate(String),
    /// A check the person asked for got no answer.
    UpdateCheckFailed,
    /// This game's program runs but it shares no data: a setting has to be turned on. The balloon says which one (the
    /// text of `Msg::Setup(id)`). Said once per game in a run (`Shared::set_game`).
    NeedsSetup {
        id: &'static str,
        name: &'static str,
    },
}

/// A lap the cutter let go of without writing it (`Shared::note_lap_dropped`), for the heartbeat's counts. The heartbeat already
/// sends the counts; the lap cutter (`lapcut.rs`) is the one that knows, and reports each lap it lets go with `note_lap_dropped`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LapDrop {
    /// The lap was joined in the middle (the program started, or the game came back, during it).
    Partial,
    /// Too short or too few samples to be a lap.
    Short,
    /// An unfinished lap exceeded the bounded sample/time budget.
    CaptureLimit,
}

/// What this run did with the laps it cut, and what the games reported about themselves: what the heartbeat tells the server.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LapStats {
    pub saved: u32,
    pub partial: u32,
    pub short: u32,
    /// Laps that could not be written to the folder and are not written now (held for another try, or lost).
    pub failed_save: u32,
}

/// How many games the heartbeat names at most.
pub const MAX_GAMES_REPORTED: usize = 8;

/// Something the person would want to know happened, for the panel's activity list (put in their language there).
/// The technical log stays in the log file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Activity {
    GameConnected(&'static str),
    GameClosed(&'static str),
    /// This build cannot read the version of the game that is running.
    GameUnsupported(&'static str),
    /// A background part panicked and is being started again.
    WorkerRestarting(&'static str),
    /// A background part panicked too often and was given up on.
    WorkerFailed(&'static str),
    Notice(Notice),
}

/// How many activities the panel can list.
const ACTIVITY: usize = 50;

type OnChange = Box<dyn Fn() + Send + Sync>;

/// How many saved laps the panel lists.
const RECENT_LAPS: usize = 12;

/// One of these lives as long as the program. Everything is cheap to read from any thread.
pub struct Shared {
    snapshot: Mutex<Snapshot>,
    /// What each game's reader says, by game id; the snapshot shows the most interesting one.
    games: Mutex<BTreeMap<&'static str, (&'static str, Game)>>,
    /// The games that were told to switch their data on in this run: the balloon is not said twice for one game.
    told_setup: Mutex<BTreeSet<&'static str>>,
    notices: Mutex<VecDeque<Notice>>,
    on_change: Mutex<Option<OnChange>>,
    uploader: Mutex<Option<Uploader>>,
    /// The thread that tells the server this computer is running, and what the heartbeat last said it was doing (so that it is woken
    /// only when that changes).
    heartbeat: Mutex<Option<Heartbeat>>,
    heartbeat_view: Mutex<View>,
    /// The thread that fetches the reference laps, and what it last found for the car on the panel.
    references_worker: Mutex<Option<ReferenceWorker>>,
    references: Mutex<Option<Arc<References>>>,
    /// The thread that sends the panel to the phone view, and how many phones it last heard were watching.
    phone_worker: Mutex<Option<PhoneWorker>>,
    phone_viewers: AtomicU32,
    /// The latest reading of the car, for the panel. Not a change worth waking the tray for.
    live: Mutex<Option<Live>>,
    /// The last laps saved in this run, newest last.
    recent_laps: Mutex<VecDeque<SavedLap>>,
    recent_generation: AtomicU64,
    /// What happened in this run worth telling the person, with the Unix time in ms, newest last.
    activity: Mutex<VecDeque<(i64, Activity)>>,
    /// How each long-lived worker thread stands, by worker id (`supervisor`).
    workers: Mutex<BTreeMap<&'static str, Health>>,
    /// What the person is told about a new version (the Monitor tab and the tray menu show it).
    update: Mutex<UpdateState>,
    /// What the last look for a new version said, and how much of a download has arrived (percent, -1 when none): the
    /// Monitor tab's update card reads them every frame, so they wake nobody.
    check: Mutex<CheckState>,
    download_percent: AtomicI32,
    /// What this run did with its laps (the heartbeat's counts) and the game build each game last reported (when it did).
    lap_stats: Mutex<LapStats>,
    game_builds: Mutex<BTreeMap<String, Option<String>>>,
    /// A lap that could not be saved was announced and none has been saved since: the balloon is not said again.
    save_failing: AtomicBool,
    /// What the person has driven, per game (the waiting screen's line), and the file that keeps it (none in tests).
    played: Mutex<crate::played::History>,
    played_path: Mutex<Option<std::path::PathBuf>>,
    /// Balloons about a lap that could not be saved (the short reason), waiting for the tray. Kept apart from `notices`: they are
    /// problems, not news, and a later "lap saved" must not hide them.
    save_alerts: Mutex<VecDeque<String>>,
    paused: AtomicBool,
    quit: AtomicBool,
}

impl Shared {
    pub fn new(paired: bool) -> Arc<Shared> {
        Arc::new(Shared {
            snapshot: Mutex::new(Snapshot {
                game: Game::Waiting,
                title: None,
                cloud: if paired { Cloud::Idle } else { Cloud::NotPaired },
                laps_saved: 0,
                last_lap: None,
            }),
            games: Mutex::new(BTreeMap::new()),
            told_setup: Mutex::new(BTreeSet::new()),
            notices: Mutex::new(VecDeque::new()),
            on_change: Mutex::new(None),
            uploader: Mutex::new(None),
            heartbeat: Mutex::new(None),
            heartbeat_view: Mutex::new(View::WAITING),
            references_worker: Mutex::new(None),
            references: Mutex::new(None),
            phone_worker: Mutex::new(None),
            phone_viewers: AtomicU32::new(0),
            live: Mutex::new(None),
            recent_laps: Mutex::new(VecDeque::new()),
            recent_generation: AtomicU64::new(0),
            activity: Mutex::new(VecDeque::new()),
            workers: Mutex::new(BTreeMap::new()),
            update: Mutex::new(UpdateState::Nothing),
            check: Mutex::new(CheckState::Idle),
            download_percent: AtomicI32::new(-1),
            lap_stats: Mutex::new(LapStats::default()),
            game_builds: Mutex::new(BTreeMap::new()),
            save_failing: AtomicBool::new(false),
            played: Mutex::new(BTreeMap::new()),
            played_path: Mutex::new(None),
            save_alerts: Mutex::new(VecDeque::new()),
            paused: AtomicBool::new(false),
            quit: AtomicBool::new(false),
        })
    }

    pub fn snapshot(&self) -> Snapshot {
        lock(&self.snapshot).clone()
    }

    /// Changes the snapshot and tells whoever listens (the tray icon) only if something actually changed.
    pub fn update(&self, change: impl FnOnce(&mut Snapshot)) {
        let changed = {
            let mut snapshot = lock(&self.snapshot);
            let before = snapshot.clone();
            change(&mut snapshot);
            *snapshot != before
        };
        if changed {
            self.changed();
        }
    }

    /// One game's reader reports its state; the snapshot shows the most interesting of all the readers' states
    /// (recording beats connected beats a game this build cannot read beats paused beats waiting).
    pub fn set_game(&self, id: &'static str, name: &'static str, state: Game) {
        let (game, title) = {
            let mut games = lock(&self.games);
            let was = games.insert(id, (name, state.clone())).map_or(Game::Waiting, |(_, g)| g);
            // A game coming, going, or a version this build cannot read is worth a line in the activity list.
            let on = |g: &Game| matches!(g, Game::Connected | Game::Recording(_) | Game::Paused);
            let event = if state == Game::Unsupported && was != Game::Unsupported {
                Some(Activity::GameUnsupported(name))
            } else if on(&state) && !on(&was) {
                Some(Activity::GameConnected(name))
            } else if state == Game::Waiting && was != Game::Waiting {
                Some(Activity::GameClosed(name))
            } else {
                None
            };
            if let Some(event) = event {
                self.remember(event);
            }
            let rank = |g: &Game| match g {
                Game::Recording(_) => 5,
                Game::Connected => 4,
                Game::Unsupported => 3,
                Game::Paused => 2,
                Game::Silent | Game::Loading => 1,
                Game::Waiting => 0,
            };
            let best = games.values().max_by_key(|(_, g)| rank(g)).cloned().unwrap_or(("", Game::Waiting));
            // A game that is only waited for has no name worth showing.
            let title = (best.1 != Game::Waiting).then_some(best.0);
            (best.1, title)
        };
        self.update(|s| {
            s.game = game;
            s.title = title;
        });
        // Open and sharing nothing after the wait: say once, in a balloon, what to switch on (and keep it in the activity list).
        if state == Game::Silent && lock(&self.told_setup).insert(id) {
            self.notify(Notice::NeedsSetup { id, name });
        }
        self.view_changed();
    }

    /// A lap was written (`late`: after an earlier try failed). `build` is the game's own version string when the reader knew it.
    /// Keeps the per-game history in `path` from now on, starting from what the file holds.
    pub fn use_played(&self, path: Option<std::path::PathBuf>) {
        *lock(&self.played) = path.as_deref().map(crate::played::load).unwrap_or_default();
        *lock(&self.played_path) = path;
    }

    /// A lap was saved: the waiting screen's line for its game counts it, and the file keeps it when there is one.
    pub fn note_played(&self, lap: &SavedLap) {
        let mut played = lock(&self.played);
        crate::played::record(&mut played, &lap.game, &lap.track, lap.time_ms, lap.valid, crate::util::now_ms());
        if let Some(path) = lock(&self.played_path).as_deref() {
            if let Err(e) = crate::played::save(path, &played) {
                crate::applog::line(&format!("played history not saved: {e}"));
            }
        }
    }

    /// The per-game history, for the waiting screen.
    pub fn played(&self) -> crate::played::History {
        lock(&self.played).clone()
    }

    pub fn note_lap_saved(&self, game: &str, build: Option<&str>, late: bool) {
        {
            let mut stats = lock(&self.lap_stats);
            stats.saved = stats.saved.saturating_add(1);
            if late {
                stats.failed_save = stats.failed_save.saturating_sub(1);
            }
        }
        let mut builds = lock(&self.game_builds);
        let known = builds.entry(game.to_owned()).or_insert(None);
        if build.is_some() {
            *known = build.map(str::to_owned);
        }
    }

    /// The cutter let a lap go without writing it.
    pub fn note_lap_dropped(&self, why: LapDrop) {
        match why {
            LapDrop::Partial => {
                let mut stats = lock(&self.lap_stats);
                stats.partial = stats.partial.saturating_add(1);
            }
            LapDrop::Short => {
                let mut stats = lock(&self.lap_stats);
                stats.short = stats.short.saturating_add(1);
            }
            LapDrop::CaptureLimit => self.note_lap_unsaved("Lap exceeded the recording limit; waiting for the next lap"),
        }
    }

    /// A lap could not be written and waits for another try. The tray says so once, until a lap is written again.
    pub fn note_lap_unsaved(&self, reason: &str) {
        {
            let mut stats = lock(&self.lap_stats);
            stats.failed_save = stats.failed_save.saturating_add(1);
        }
        if !self.save_failing.swap(true, Ordering::SeqCst) {
            lock(&self.save_alerts).push_back(reason.to_owned());
            self.changed();
        }
    }

    /// The reasons of the "a lap could not be saved" balloons not shown yet, oldest first.
    pub fn take_save_alerts(&self) -> Vec<String> {
        lock(&self.save_alerts).drain(..).collect()
    }

    /// Writing works again (the folder took a lap): the next failure is told again.
    pub fn note_saving_works(&self) {
        self.save_failing.store(false, Ordering::SeqCst);
    }

    pub fn lap_stats(&self) -> LapStats {
        lock(&self.lap_stats).clone()
    }

    /// The games that gave laps in this run with their build when known, by id (at most `MAX_GAMES_REPORTED`).
    pub fn game_builds(&self) -> Vec<(String, Option<String>)> {
        lock(&self.game_builds)
            .iter()
            .take(MAX_GAMES_REPORTED)
            .map(|(id, build)| (id.clone(), build.clone()))
            .collect()
    }

    /// What the heartbeat says about the program now: waiting, connected to a game (which), or paused by the person.
    pub fn heartbeat_view(&self) -> View {
        heartbeat::view_of(lock(&self.games).iter().map(|(id, (_, game))| (id, game)), self.paused())
    }

    /// Wakes the heartbeat when what it would say has changed since it last looked (a game connected or went away, reading was paused).
    fn view_changed(&self) {
        let now = self.heartbeat_view();
        let changed = {
            let mut seen = lock(&self.heartbeat_view);
            let changed = *seen != now;
            *seen = now;
            changed
        };
        if changed {
            if let Some(heartbeat) = lock(&self.heartbeat).as_ref() {
                heartbeat.wake();
            }
        }
    }

    pub fn set_on_change(&self, callback: impl Fn() + Send + Sync + 'static) {
        *lock(&self.on_change) = Some(Box::new(callback));
    }

    fn changed(&self) {
        if let Some(callback) = lock(&self.on_change).as_ref() {
            callback();
        }
    }

    pub fn notify(&self, notice: Notice) {
        self.notify_in_generation(notice, None);
    }

    pub fn recent_generation(&self) -> u64 {
        self.recent_generation.load(Ordering::SeqCst)
    }

    /// A delayed disk write remains an activity, but must not repopulate a previous session's table.
    pub fn notify_lap_saved(&self, lap: SavedLap, generation: u64) {
        self.notify_in_generation(Notice::LapSaved(lap), Some(generation));
    }

    fn notify_in_generation(&self, notice: Notice, generation: Option<u64>) {
        if let Notice::LapSaved(lap) = &notice {
            let mut recent = lock(&self.recent_laps);
            if generation.is_none_or(|value| value == self.recent_generation.load(Ordering::SeqCst)) {
                recent.push_back(lap.clone());
                while recent.len() > RECENT_LAPS {
                    recent.pop_front();
                }
            }
        }
        self.remember(Activity::Notice(notice.clone()));
        lock(&self.notices).push_back(notice);
        self.changed();
    }

    fn remember(&self, event: Activity) {
        let mut activity = lock(&self.activity);
        activity.push_back((crate::util::now_ms(), event));
        while activity.len() > ACTIVITY {
            activity.pop_front();
        }
    }

    /// What happened in this run worth telling the person, with the Unix time in ms, newest last.
    pub fn activity(&self) -> Vec<(i64, Activity)> {
        lock(&self.activity).iter().cloned().collect()
    }

    pub fn take_notices(&self) -> Vec<Notice> {
        lock(&self.notices).drain(..).collect()
    }

    /// The last laps saved in this run, newest last.
    pub fn recent_laps(&self) -> Vec<SavedLap> {
        lock(&self.recent_laps).iter().cloned().collect()
    }

    /// Forgets the laps saved in this run: the session they were driven in is over (another track, another
    /// car or another game), and the panel must not show them as the laps of the new one.
    pub fn clear_recent_laps(&self) {
        {
            let mut recent = lock(&self.recent_laps);
            self.recent_generation.fetch_add(1, Ordering::SeqCst);
            recent.clear();
        }
        self.changed();
    }

    /// What every reader that has reported says: `(id, name, state)`, by id.
    pub fn games(&self) -> Vec<(&'static str, &'static str, Game)> {
        lock(&self.games)
            .iter()
            .map(|(id, (name, game))| (*id, *name, game.clone()))
            .collect()
    }

    /// One of the long-lived worker threads (see `supervisor`) reports how it stands. A restart or a failure is a line in
    /// the activity list; the panel shows a worker that failed until the program is restarted.
    pub fn set_worker(&self, id: &'static str, health: Health) {
        let was = lock(&self.workers).insert(id, health);
        if was == Some(health) || (was.is_none() && health == Health::Running) {
            return;
        }
        match health {
            Health::Restarting => self.remember(Activity::WorkerRestarting(id)),
            Health::Failed => self.remember(Activity::WorkerFailed(id)),
            Health::Running => {}
        }
        self.changed();
    }

    /// The workers that were given up on, by id.
    pub fn failed_workers(&self) -> Vec<&'static str> {
        lock(&self.workers)
            .iter()
            .filter(|(_, health)| **health == Health::Failed)
            .map(|(id, _)| *id)
            .collect()
    }

    /// How every worker that has reported stands, by id.
    pub fn workers(&self) -> Vec<(&'static str, Health)> {
        lock(&self.workers).iter().map(|(id, health)| (*id, *health)).collect()
    }

    /// A new reading of a car. It replaces the one shown when it is being driven, comes from the same game, or the
    /// one shown is older than two seconds (so a second game sitting in its menu does not hide the one being driven).
    pub fn offer_live(&self, live: Live) {
        let mut shown = lock(&self.live);
        let replace = shown
            .as_ref()
            .is_none_or(|old| live.driving || old.game == live.game || live.at_ms - old.at_ms > 2000);
        if replace {
            *shown = Some(live);
        }
    }

    /// A layout may finish while its reader is quiet. Update only the snapshot of that exact layout,
    /// without changing telemetry freshness or making it take focus from another game.
    pub(crate) fn refresh_live_layout(&self, key: &crate::tracks::auto::Seen, layout: &crate::maps::LayoutView) {
        if let Some(live) = lock(&self.live)
            .as_mut()
            .filter(|live| live.game_id == key.game && live.track == key.track && live.track_variant == key.variant)
        {
            live.layout = layout.clone();
        }
    }

    /// The latest reading, with the reference laps when they are for the track and car it shows (a car just changed has none until the
    /// fetcher has looked).
    pub fn live(&self) -> Option<Live> {
        let mut live = lock(&self.live).clone()?;
        live.references = lock(&self.references)
            .clone()
            .filter(|found| found.track == live.track && found.car == live.car);
        Some(live)
    }

    /// What the fetcher found for the car it is looking at (or nothing).
    pub fn set_references(&self, references: Option<Arc<References>>) {
        *lock(&self.references) = references;
    }

    /// Puts the reference fetcher in place (or takes it away); the old one is told to finish.
    pub fn set_references_worker(&self, worker: Option<ReferenceWorker>) {
        *lock(&self.references_worker) = worker;
    }

    /// Puts the phone view's sender in place (or takes it away: no phone is watching then); the old one is told to finish.
    pub fn set_phone_worker(&self, worker: Option<PhoneWorker>) {
        *lock(&self.phone_worker) = worker;
        self.set_phone_viewers(0);
    }

    /// How many phones watched the panel as of the last frame the server took (none when nothing is being sent).
    pub fn phone_viewers(&self) -> u32 {
        self.phone_viewers.load(Ordering::Relaxed)
    }

    pub fn set_phone_viewers(&self, viewers: u32) {
        self.phone_viewers.store(viewers, Ordering::Relaxed);
    }

    /// What the person is told about a new version.
    pub fn update_state(&self) -> UpdateState {
        lock(&self.update).clone()
    }

    /// A new version is waiting, downloading or no longer there; the listener (the tray icon) hears of a change only.
    pub fn set_update(&self, state: UpdateState) {
        let changed = {
            let mut shown = lock(&self.update);
            let changed = *shown != state;
            *shown = state;
            changed
        };
        if changed {
            self.changed();
        }
    }

    /// What the last look for a new version said.
    pub fn check_state(&self) -> CheckState {
        lock(&self.check).clone()
    }

    pub fn set_check(&self, state: CheckState) {
        *lock(&self.check) = state;
    }

    /// How much of the update being downloaded has arrived, in percent; `None` when nothing is downloading.
    pub fn download_percent(&self) -> Option<u8> {
        u8::try_from(self.download_percent.load(Ordering::Relaxed)).ok()
    }

    pub fn set_download_percent(&self, percent: Option<u8>) {
        self.download_percent
            .store(percent.map_or(-1, |p| i32::from(p.min(100))), Ordering::Relaxed);
    }

    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
        self.view_changed();
    }
    pub fn quitting(&self) -> bool {
        self.quit.load(Ordering::SeqCst)
    }
    pub fn quit(&self) {
        self.quit.store(true, Ordering::SeqCst);
    }

    /// Puts the thread that sends laps in place (or takes it away); the old one is told to finish.
    pub fn set_uploader(&self, uploader: Option<Uploader>) {
        *lock(&self.uploader) = uploader;
    }
    /// Puts the heartbeat thread in place (or takes it away); the old one is told to finish.
    pub fn set_heartbeat(&self, heartbeat: Option<Heartbeat>) {
        *lock(&self.heartbeat) = heartbeat;
    }
    /// A lap or a track layout was saved: let the uploader look at the folders.
    pub fn wake_uploader(&self) {
        if let Some(uploader) = lock(&self.uploader).as_ref() {
            uploader.wake();
        }
    }
}

/// A saved lap for tests.
#[cfg(test)]
pub fn saved_lap(number: u32, time_ms: u32) -> SavedLap {
    SavedLap {
        number,
        time_ms,
        valid: true,
        sectors_ms: Vec::new(),
        game: "Assetto Corsa".into(),
        track: "Monza".into(),
        car: "Ferrari 488 GT3".into(),
        speed_kmh: demo_speed(number),
    }
}

/// A believable lap of speeds for tests, a little different for each `seed`.
#[cfg(test)]
fn demo_speed(seed: u32) -> Vec<u16> {
    (0..SPEED_POINTS)
        .map(|i| {
            let x = i as f32 / SPEED_POINTS as f32 * std::f32::consts::TAU * 3.0 + seed as f32 * 0.4;
            (180.0 + 100.0 * x.sin()) as u16
        })
        .collect()
}

#[cfg(test)]
#[test]
fn a_lap_speed_is_kept_as_even_averages_in_kmh() {
    let ramp: Vec<f32> = (0..480).map(|i| i as f32 / 10.0).collect();
    let profile = speed_profile(&ramp);
    assert_eq!(profile.len(), SPEED_POINTS);
    // The first tenth of a lap of 480 samples: 0.0 to 0.9 m/s, 0.45 m/s on average, 1.6 km/h.
    assert_eq!((profile[0], profile[SPEED_POINTS - 1]), (2, 171));
    assert!(speed_profile(&[10.0; 10]).is_empty(), "too few samples");
    let mut gaps = vec![10.0; 96];
    gaps[0] = f32::NAN;
    assert_eq!(speed_profile(&gaps)[0], 36, "a sample that is not a number is left out");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_what_happened_in_plain_events() {
        let shared = Shared::new(true);
        shared.set_game("ac", "Assetto Corsa", Game::Waiting);
        shared.set_game("ac", "Assetto Corsa", Game::Connected);
        shared.set_game("ac", "Assetto Corsa", Game::Recording(1));
        shared.notify(Notice::LapSaved(saved_lap(1, 109_002)));
        shared.set_game("ac", "Assetto Corsa", Game::Paused);
        shared.set_game("ac", "Assetto Corsa", Game::Connected);
        shared.set_game("ac", "Assetto Corsa", Game::Waiting);
        shared.set_game("rfactor1", "Stock Car Extreme", Game::Unsupported);
        shared.set_game("rfactor1", "Stock Car Extreme", Game::Unsupported);
        let events: Vec<Activity> = shared.activity().into_iter().map(|(_, a)| a).collect();
        assert_eq!(
            events,
            [
                Activity::GameConnected("Assetto Corsa"),
                Activity::Notice(Notice::LapSaved(saved_lap(1, 109_002))),
                Activity::GameClosed("Assetto Corsa"),
                Activity::GameUnsupported("Stock Car Extreme"),
            ],
            "waiting at start, laps starting and pauses are not news"
        );
    }
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn tells_the_listener_only_when_something_changed() {
        let shared = Shared::new(true);
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        shared.set_on_change(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        shared.update(|s| s.game = Game::Recording(3));
        shared.update(|s| s.game = Game::Recording(3));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(shared.snapshot().game, Game::Recording(3));
        shared.update(|s| s.laps_saved += 1);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn delayed_saves_do_not_repopulate_the_previous_sessions_recent_laps() {
        let shared = Shared::new(true);
        let old = shared.recent_generation();
        shared.clear_recent_laps();
        shared.notify_lap_saved(saved_lap(1, 109_002), old);
        assert!(shared.recent_laps().is_empty());
        shared.notify_lap_saved(saved_lap(2, 108_000), shared.recent_generation());
        assert_eq!(shared.recent_laps().len(), 1);
        assert_eq!(shared.recent_laps()[0].number, 2);
        assert_eq!(shared.take_notices().len(), 2, "both writes remain visible as activities");
    }

    #[test]
    fn a_capture_limit_is_a_visible_counted_recording_failure() {
        let shared = Shared::new(true);
        shared.note_lap_dropped(LapDrop::CaptureLimit);
        assert_eq!(shared.lap_stats().failed_save, 1);
        assert_eq!(shared.take_save_alerts().len(), 1);
    }

    #[test]
    fn keeps_what_the_person_is_told_about_a_new_version_and_wakes_the_listener_on_a_change_only() {
        let shared = Shared::new(true);
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        shared.set_on_change(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(shared.update_state(), UpdateState::Nothing);
        shared.set_update(UpdateState::Nothing);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let available = UpdateState::Available {
            version: "0.6.0".into(),
            required: false,
            held: false,
        };
        shared.set_update(available.clone());
        shared.set_update(available.clone());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(shared.update_state(), available);
        shared.set_update(UpdateState::Downloading { version: "0.6.0".into() });
        // The card's other half: what the last look said and how much of a download arrived (clamped, `None` when idle).
        assert_eq!(shared.check_state(), crate::update::CheckState::Idle);
        shared.set_check(crate::update::CheckState::Failed);
        assert_eq!(shared.check_state(), crate::update::CheckState::Failed);
        assert_eq!(shared.download_percent(), None);
        shared.set_download_percent(Some(140));
        assert_eq!(shared.download_percent(), Some(100));
        shared.set_download_percent(None);
        assert_eq!(shared.download_percent(), None);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn shows_the_most_interesting_game_of_several() {
        let shared = Shared::new(true);
        shared.set_game("lmu", "Le Mans Ultimate", Game::Waiting);
        shared.set_game("ac", "Assetto Corsa", Game::Waiting);
        assert_eq!((shared.snapshot().game, shared.snapshot().title), (Game::Waiting, None));
        shared.set_game("ac", "Assetto Corsa", Game::Connected);
        assert_eq!(
            (shared.snapshot().game, shared.snapshot().title),
            (Game::Connected, Some("Assetto Corsa"))
        );
        shared.set_game("lmu", "Le Mans Ultimate", Game::Recording(3));
        assert_eq!(
            (shared.snapshot().game, shared.snapshot().title),
            (Game::Recording(3), Some("Le Mans Ultimate"))
        );
        // The other reader going back to waiting does not hide a game that is being recorded.
        shared.set_game("ac", "Assetto Corsa", Game::Waiting);
        assert_eq!(shared.snapshot().game, Game::Recording(3));
        shared.set_game("lmu", "Le Mans Ultimate", Game::Waiting);
        assert_eq!((shared.snapshot().game, shared.snapshot().title), (Game::Waiting, None));
    }

    #[test]
    fn a_game_open_without_data_is_told_what_to_switch_on_once_per_run() {
        let shared = Shared::new(true);
        // Loading is not the person's problem yet: no balloon.
        shared.set_game("ams2", "Automobilista 2", Game::Loading);
        assert!(shared.take_notices().is_empty());
        shared.set_game("ams2", "Automobilista 2", Game::Silent);
        let wanted = Notice::NeedsSetup {
            id: "ams2",
            name: "Automobilista 2",
        };
        assert_eq!(shared.take_notices(), std::slice::from_ref(&wanted));
        // The loop repeats the same state every couple of seconds, and the game may come and go: still one balloon.
        shared.set_game("ams2", "Automobilista 2", Game::Silent);
        shared.set_game("ams2", "Automobilista 2", Game::Waiting);
        shared.set_game("ams2", "Automobilista 2", Game::Loading);
        shared.set_game("ams2", "Automobilista 2", Game::Silent);
        assert!(shared.take_notices().is_empty(), "said once for this game in this run");
        // Another game has its own; the activity list keeps both.
        shared.set_game("f1", "EA SPORTS F1 25", Game::Silent);
        assert_eq!(
            shared.take_notices(),
            [Notice::NeedsSetup {
                id: "f1",
                name: "EA SPORTS F1 25"
            }]
        );
        let kept: Vec<Activity> = shared.activity().into_iter().map(|(_, a)| a).collect();
        assert!(kept.contains(&Activity::Notice(wanted)), "{kept:?}");
        // A game that shares is never told anything.
        shared.set_game("ac", "Assetto Corsa", Game::Connected);
        assert!(shared.take_notices().is_empty());
    }

    #[test]
    fn counts_laps_and_says_a_failed_save_once_until_saving_works_again() {
        let shared = Shared::new(true);
        shared.note_lap_saved("ac", Some("1.16.3"), false);
        shared.note_lap_saved("ac", None, false);
        shared.note_lap_dropped(LapDrop::Partial);
        shared.note_lap_dropped(LapDrop::Short);
        shared.note_lap_dropped(LapDrop::Short);
        shared.note_lap_unsaved("disk full");
        shared.note_lap_unsaved("disk full");
        let stats = shared.lap_stats();
        assert_eq!((stats.saved, stats.partial, stats.short, stats.failed_save), (2, 1, 2, 2));
        assert_eq!(shared.take_save_alerts(), ["disk full"], "once");
        assert_eq!(
            shared.game_builds(),
            [("ac".to_owned(), Some("1.16.3".to_owned()))],
            "a later lap without a build keeps it"
        );
        shared.note_lap_saved("ac", None, true);
        shared.note_saving_works();
        assert_eq!(shared.lap_stats().failed_save, 1);
        shared.note_lap_unsaved("again");
        assert_eq!(shared.take_save_alerts(), ["again"], "told again after it worked");
        shared.note_lap_saved("lmu", None, false);
        assert_eq!(shared.game_builds().len(), 2);
    }

    #[test]
    fn a_worker_that_failed_is_marked_and_a_restart_is_news() {
        let shared = Shared::new(true);
        shared.set_worker("uploader", Health::Running);
        shared.set_worker("uploader", Health::Restarting);
        shared.set_worker("uploader", Health::Restarting);
        shared.set_worker("uploader", Health::Running);
        assert!(shared.failed_workers().is_empty());
        shared.set_worker("tracks", Health::Running);
        shared.set_worker("tracks", Health::Failed);
        assert_eq!(shared.failed_workers(), ["tracks"]);
        assert_eq!(shared.workers(), [("tracks", Health::Failed), ("uploader", Health::Running)]);
        let events: Vec<Activity> = shared.activity().into_iter().map(|(_, a)| a).collect();
        assert_eq!(events, [Activity::WorkerRestarting("uploader"), Activity::WorkerFailed("tracks")]);
        // A new uploader (after connecting again) clears the mark.
        shared.set_worker("tracks", Health::Running);
        assert!(shared.failed_workers().is_empty());
    }

    #[test]
    fn a_panic_while_the_status_is_locked_does_not_take_the_status_down() {
        let shared = Shared::new(true);
        let other = shared.clone();
        let _ = std::thread::spawn(move || {
            let _held = other.snapshot.lock().unwrap();
            let _also = other.games.lock().unwrap();
            panic!("poisoning on purpose");
        })
        .join();
        assert!(shared.snapshot.lock().is_err() && shared.games.lock().is_err(), "both are poisoned");
        // Everything still reads and writes.
        shared.update(|s| s.laps_saved = 3);
        shared.set_game("lmu", "Le Mans Ultimate", Game::Recording(2));
        assert_eq!(shared.snapshot().laps_saved, 3);
        assert_eq!(shared.snapshot().game, Game::Recording(2));
        assert_eq!(shared.games(), [("lmu", "Le Mans Ultimate", Game::Recording(2))]);
    }

    #[test]
    fn starts_by_saying_whether_the_computer_is_paired() {
        assert_eq!(Shared::new(false).snapshot().cloud, Cloud::NotPaired);
        assert_eq!(Shared::new(true).snapshot().cloud, Cloud::Idle);
    }

    #[test]
    fn holds_notices_until_they_are_taken() {
        let shared = Shared::new(true);
        shared.notify(Notice::LapSaved(saved_lap(3, 102_318)));
        shared.notify(Notice::Paired("RIG".into()));
        let taken = shared.take_notices();
        assert_eq!(taken, [Notice::LapSaved(saved_lap(3, 102_318)), Notice::Paired("RIG".into())]);
        assert!(shared.take_notices().is_empty());
    }

    #[test]
    fn keeps_the_last_laps_saved_for_the_panel() {
        let shared = Shared::new(true);
        for lap in 1..=15 {
            shared.notify(Notice::LapSaved(saved_lap(lap, 100_000)));
        }
        shared.notify(Notice::LapsSent(3));
        let recent = shared.recent_laps();
        assert_eq!(recent.len(), RECENT_LAPS);
        assert_eq!((recent[0].number, recent[RECENT_LAPS - 1].number), (4, 15));
    }

    #[test]
    fn the_car_being_driven_wins_the_panel() {
        let shared = Shared::new(true);
        let reading = |game: &'static str, driving: bool, at_ms: i64| {
            let mut tracker = crate::dash::Tracker::default();
            let mut frame = crate::game::Frame::empty();
            frame.driving = driving;
            tracker.on_frame(game, &frame, at_ms)
        };
        assert!(shared.live().is_none());
        shared.offer_live(reading("Le Mans Ultimate", true, 1000));
        shared.offer_live(reading("Assetto Corsa", false, 1500));
        assert_eq!(
            shared.live().unwrap().game,
            "Le Mans Ultimate",
            "a game in its menu does not take over"
        );
        shared.offer_live(reading("Assetto Corsa", false, 3500));
        assert_eq!(shared.live().unwrap().game, "Assetto Corsa", "the other one went quiet");
        shared.offer_live(reading("Le Mans Ultimate", true, 3600));
        assert_eq!(shared.live().unwrap().game, "Le Mans Ultimate");
        shared.set_game("lmu", "Le Mans Ultimate", Game::Recording(2));
        assert_eq!(shared.games(), [("lmu", "Le Mans Ultimate", Game::Recording(2))]);
    }

    #[test]
    fn pause_and_quit_are_flags_any_thread_can_set() {
        let shared = Shared::new(true);
        assert!(!shared.paused() && !shared.quitting());
        shared.set_paused(true);
        shared.quit();
        assert!(shared.paused() && shared.quitting());
        shared.set_paused(false);
        assert!(!shared.paused());
    }
}
