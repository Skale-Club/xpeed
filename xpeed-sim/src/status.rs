//! What Xpeed Companion is doing, shared between the thread that records, the thread that sends and the tray icon.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::dash::Live;
use crate::outbox::Uploader;

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
    /// `Lap 3  1:42.318` for the last lap saved in this run.
    pub last_lap: Option<String>,
}

/// Something worth a short word to the person (a balloon from the tray icon). The tray puts it in their language.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notice {
    /// `Lap 3  1:42.318`
    LapSaved(String),
    /// Several laps went at once (after being offline).
    LapsSent(u32),
    /// Connected under this device name.
    Paired(String),
    NotPaired,
    Refused,
}

/// Something the person would want to know happened, for the panel's activity list (put in their language there).
/// The technical log stays in the log file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Activity {
    GameConnected(&'static str),
    GameClosed(&'static str),
    /// This build cannot read the version of the game that is running.
    GameUnsupported(&'static str),
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
    notices: Mutex<VecDeque<Notice>>,
    on_change: Mutex<Option<OnChange>>,
    uploader: Mutex<Option<Uploader>>,
    /// The latest reading of the car, for the panel. Not a change worth waking the tray for.
    live: Mutex<Option<Live>>,
    /// The labels of the last laps saved in this run, newest last.
    recent_laps: Mutex<VecDeque<String>>,
    /// What happened in this run worth telling the person, with the Unix time in ms, newest last.
    activity: Mutex<VecDeque<(i64, Activity)>>,
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
            notices: Mutex::new(VecDeque::new()),
            on_change: Mutex::new(None),
            uploader: Mutex::new(None),
            live: Mutex::new(None),
            recent_laps: Mutex::new(VecDeque::new()),
            activity: Mutex::new(VecDeque::new()),
            paused: AtomicBool::new(false),
            quit: AtomicBool::new(false),
        })
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().unwrap().clone()
    }

    /// Changes the snapshot and tells whoever listens (the tray icon) only if something actually changed.
    pub fn update(&self, change: impl FnOnce(&mut Snapshot)) {
        let changed = {
            let mut snapshot = self.snapshot.lock().unwrap();
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
            let mut games = self.games.lock().unwrap();
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
    }

    pub fn set_on_change(&self, callback: impl Fn() + Send + Sync + 'static) {
        *self.on_change.lock().unwrap() = Some(Box::new(callback));
    }

    fn changed(&self) {
        if let Some(callback) = self.on_change.lock().unwrap().as_ref() {
            callback();
        }
    }

    pub fn notify(&self, notice: Notice) {
        if let Notice::LapSaved(label) = &notice {
            let mut recent = self.recent_laps.lock().unwrap();
            recent.push_back(label.clone());
            while recent.len() > RECENT_LAPS {
                recent.pop_front();
            }
        }
        self.remember(Activity::Notice(notice.clone()));
        self.notices.lock().unwrap().push_back(notice);
        self.changed();
    }

    fn remember(&self, event: Activity) {
        let mut activity = self.activity.lock().unwrap();
        activity.push_back((crate::util::now_ms(), event));
        while activity.len() > ACTIVITY {
            activity.pop_front();
        }
    }

    /// What happened in this run worth telling the person, with the Unix time in ms, newest last.
    pub fn activity(&self) -> Vec<(i64, Activity)> {
        self.activity.lock().unwrap().iter().cloned().collect()
    }

    pub fn take_notices(&self) -> Vec<Notice> {
        self.notices.lock().unwrap().drain(..).collect()
    }

    /// The labels of the last laps saved in this run, newest last.
    pub fn recent_laps(&self) -> Vec<String> {
        self.recent_laps.lock().unwrap().iter().cloned().collect()
    }

    /// What every reader that has reported says: `(id, name, state)`, by id.
    pub fn games(&self) -> Vec<(&'static str, &'static str, Game)> {
        self.games
            .lock()
            .unwrap()
            .iter()
            .map(|(id, (name, game))| (*id, *name, game.clone()))
            .collect()
    }

    /// A new reading of a car. It replaces the one shown when it is being driven, comes from the same game, or the
    /// one shown is older than two seconds (so a second game sitting in its menu does not hide the one being driven).
    pub fn offer_live(&self, live: Live) {
        let mut shown = self.live.lock().unwrap();
        let replace = shown
            .as_ref()
            .is_none_or(|old| live.driving || old.game == live.game || live.at_ms - old.at_ms > 2000);
        if replace {
            *shown = Some(live);
        }
    }

    pub fn live(&self) -> Option<Live> {
        self.live.lock().unwrap().clone()
    }

    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }
    pub fn quitting(&self) -> bool {
        self.quit.load(Ordering::SeqCst)
    }
    pub fn quit(&self) {
        self.quit.store(true, Ordering::SeqCst);
    }

    /// Puts the thread that sends laps in place (or takes it away); the old one is told to finish.
    pub fn set_uploader(&self, uploader: Option<Uploader>) {
        *self.uploader.lock().unwrap() = uploader;
    }
    /// A lap or a track layout was saved: let the uploader look at the folders.
    pub fn wake_uploader(&self) {
        if let Some(uploader) = self.uploader.lock().unwrap().as_ref() {
            uploader.wake();
        }
    }
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
        shared.notify(Notice::LapSaved("Lap 1  1:49.002".into()));
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
                Activity::Notice(Notice::LapSaved("Lap 1  1:49.002".into())),
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
    fn starts_by_saying_whether_the_computer_is_paired() {
        assert_eq!(Shared::new(false).snapshot().cloud, Cloud::NotPaired);
        assert_eq!(Shared::new(true).snapshot().cloud, Cloud::Idle);
    }

    #[test]
    fn holds_notices_until_they_are_taken() {
        let shared = Shared::new(true);
        shared.notify(Notice::LapSaved("Lap 3  1:42.318".into()));
        shared.notify(Notice::Paired("RIG".into()));
        let taken = shared.take_notices();
        assert_eq!(taken, [Notice::LapSaved("Lap 3  1:42.318".into()), Notice::Paired("RIG".into())]);
        assert!(shared.take_notices().is_empty());
    }

    #[test]
    fn keeps_the_last_laps_saved_for_the_panel() {
        let shared = Shared::new(true);
        for lap in 1..=15 {
            shared.notify(Notice::LapSaved(format!("Lap {lap}")));
        }
        shared.notify(Notice::LapsSent(3));
        let recent = shared.recent_laps();
        assert_eq!(recent.len(), RECENT_LAPS);
        assert_eq!((recent[0].as_str(), recent[RECENT_LAPS - 1].as_str()), ("Lap 4", "Lap 15"));
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
