//! What a racing game is, as far as Xpeed Companion can tell, in three states: **not running**, **running and
//! sharing data**, and **running but not sharing data**. The third is the one where a first-time player gives up (each
//! game has a setting that must be switched on), so it is told apart from the others and, after a short grace period for
//! splash screens and loading, shown with the exact setting to turn on (`Msg::Setup`, in `text.rs`).
//!
//! This module is the pure part: what the program list says, whether the reader found data, and the clock (passed in,
//! never read here) give the state. The engine's loops call it; the tests move the clock and the process list by hand.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::games::{running_game, Reader};
use crate::status::Game;

/// What a game that runs without sharing data is, given when it was first seen so: loading for `grace` (splash
/// screens, menus coming up: some games create their shared memory only once loaded), then open without data.
pub fn quiet_state(since: Instant, now: Instant, grace: Duration) -> Game {
    if now.saturating_duration_since(since) < grace {
        Game::Loading
    } else {
        Game::Silent
    }
}

/// When each game's program was first seen running without data (forgotten when it stops running or starts sharing).
#[derive(Default)]
pub struct Watch {
    since: HashMap<&'static str, Instant>,
}

impl Watch {
    /// The state of a game whose reader finds no data: waiting when its program is not running, else loading or silent.
    pub fn without_data(&mut self, id: &'static str, running: bool, now: Instant, grace: Duration) -> Game {
        if !running {
            self.since.remove(id);
            return Game::Waiting;
        }
        quiet_state(*self.since.entry(id).or_insert(now), now, grace)
    }

    /// The game is not running, or it shares data: whatever was counted for it is over.
    pub fn forget(&mut self, id: &str) {
        self.since.remove(id);
    }
}

/// What `reader` says about the game that runs, from the programs running now (`running`, lower case) and whether the
/// reader found data (`sharing`): the game's id and name and its state. `None` when none of the reader's games runs.
pub fn detect(
    reader: &Reader,
    running: &[String],
    sharing: bool,
    watch: &mut Watch,
    now: Instant,
    grace: Duration,
) -> Option<(&'static str, &'static str, Game)> {
    let Some((id, name)) = running_game(running, reader) else {
        for id in reader.ids {
            watch.forget(id);
        }
        return None;
    };
    if sharing {
        watch.forget(id);
        return Some((id, name, Game::Connected));
    }
    Some((id, name, watch.without_data(id, true, now, grace)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::{PROGRAMS, READERS};
    use crate::status::Shared;
    use crate::text::{text, Lang, Msg};

    const GRACE: Duration = Duration::from_secs(45);

    fn list(programs: &[&str]) -> Vec<String> {
        programs.iter().map(|p| (*p).to_owned()).collect()
    }

    #[test]
    fn a_game_that_runs_without_data_is_loading_then_open_without_data() {
        let start = Instant::now();
        assert_eq!(quiet_state(start, start, GRACE), Game::Loading);
        assert_eq!(quiet_state(start, start + Duration::from_secs(44), GRACE), Game::Loading);
        assert_eq!(quiet_state(start, start + GRACE, GRACE), Game::Silent);
        assert_eq!(quiet_state(start, start + Duration::from_secs(600), GRACE), Game::Silent);
        // A clock that did not move forward never makes a game silent.
        assert_eq!(quiet_state(start + Duration::from_secs(5), start, GRACE), Game::Loading);
    }

    #[test]
    fn every_game_is_told_apart_when_it_is_not_running_when_it_shares_and_when_it_runs_without_data() {
        let start = Instant::now();
        for reader in READERS {
            for (program, id, name) in PROGRAMS.iter().filter(|(p, _, _)| reader.programs.contains(p)) {
                let program = *program;
                let mut watch = Watch::default();
                let tag = format!("{name} ({program})");
                // Not running: another program is, or none.
                assert_eq!(
                    detect(reader, &list(&["explorer.exe"]), false, &mut watch, start, GRACE),
                    None,
                    "{tag}"
                );
                assert_eq!(detect(reader, &[], true, &mut watch, start, GRACE), None, "{tag}");
                // Running without data: loading first, then the third state.
                let running = list(&["explorer.exe", program]);
                let first = detect(reader, &running, false, &mut watch, start, GRACE);
                assert_eq!(first, Some((*id, *name, Game::Loading)), "{tag}");
                let later = detect(reader, &running, false, &mut watch, start + Duration::from_secs(46), GRACE);
                assert_eq!(later, Some((*id, *name, Game::Silent)), "{tag}: running but not sharing data");
                // It starts sharing: connected, and the wait starts from nothing if it stops again.
                let sharing = detect(reader, &running, true, &mut watch, start + Duration::from_secs(50), GRACE);
                assert_eq!(sharing, Some((*id, *name, Game::Connected)), "{tag}");
                let again = detect(reader, &running, false, &mut watch, start + Duration::from_secs(60), GRACE);
                assert_eq!(again, Some((*id, *name, Game::Loading)), "{tag}: counted again from now");
                // It closes: not running, and the next time it runs it is loading again.
                assert_eq!(
                    detect(reader, &[], false, &mut watch, start + Duration::from_secs(70), GRACE),
                    None,
                    "{tag}"
                );
                let reopened = detect(reader, &running, false, &mut watch, start + Duration::from_secs(200), GRACE);
                assert_eq!(reopened, Some((*id, *name, Game::Loading)), "{tag}: a new run, a new wait");
            }
        }
    }

    #[test]
    fn two_games_of_one_reader_are_waited_for_on_their_own() {
        let ams2 = READERS.iter().find(|r| r.family == "ams2").unwrap();
        let pcars = READERS.iter().find(|r| r.family == "pcars").unwrap();
        let start = Instant::now();
        let mut watch = Watch::default();
        let running = list(&["ams2avx.exe", "pcars2.exe"]);
        assert_eq!(
            detect(ams2, &running, false, &mut watch, start, GRACE).map(|d| d.2),
            Some(Game::Loading)
        );
        let late = start + Duration::from_secs(60);
        assert_eq!(
            detect(pcars, &running, false, &mut watch, late, GRACE).map(|d| d.2),
            Some(Game::Loading),
            "its own clock"
        );
        assert_eq!(
            detect(ams2, &running, false, &mut watch, late, GRACE).map(|d| d.2),
            Some(Game::Silent)
        );
    }

    #[test]
    fn a_game_open_without_data_tells_the_person_once_and_in_its_own_words() {
        let shared = Shared::new(true);
        let start = Instant::now();
        let mut watch = Watch::default();
        let reader = READERS.iter().find(|r| r.family == "ams2").unwrap();
        let running = list(&["ams2avx.exe"]);
        for second in [0, 10, 44, 45, 50, 120] {
            let at = start + Duration::from_secs(second);
            if let Some((id, name, state)) = detect(reader, &running, false, &mut watch, at, GRACE) {
                shared.set_game(id, name, state);
            }
        }
        let balloons = shared.take_notices();
        assert_eq!(balloons.len(), 1, "{balloons:?}: one balloon, after the wait");
        assert!(text(Lang::En, &Msg::Setup("ams2")).contains("Shared Memory"));
    }
}
