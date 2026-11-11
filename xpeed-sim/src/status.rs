//! What Xpeed Sim is doing, shared between the thread that records, the thread that sends and the tray icon.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

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

type OnChange = Box<dyn Fn() + Send + Sync>;

/// One of these lives as long as the program. Everything is cheap to read from any thread.
pub struct Shared {
    snapshot: Mutex<Snapshot>,
    /// What each game's reader says, by game id; the snapshot shows the most interesting one.
    games: Mutex<BTreeMap<&'static str, (&'static str, Game)>>,
    notices: Mutex<VecDeque<Notice>>,
    on_change: Mutex<Option<OnChange>>,
    uploader: Mutex<Option<Uploader>>,
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
            games.insert(id, (name, state));
            let rank = |g: &Game| match g {
                Game::Recording(_) => 4,
                Game::Connected => 3,
                Game::Unsupported => 2,
                Game::Paused => 1,
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
        self.notices.lock().unwrap().push_back(notice);
        self.changed();
    }

    pub fn take_notices(&self) -> Vec<Notice> {
        self.notices.lock().unwrap().drain(..).collect()
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
