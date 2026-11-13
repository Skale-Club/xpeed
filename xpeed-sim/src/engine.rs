//! The loop that reads Le Mans Ultimate and writes each lap to a folder. It is what both `record` (in a terminal)
//! and the tray app run; the difference is only who listens to what it says (`say`) and to the shared status.

use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::game::Source;
use crate::games::{Reader, READERS};
use crate::lapcut::LapCutter;
use crate::lapfile;
use crate::lmu::layout::LAYOUT_SIZE;
use crate::lmu::reader::{LmuReader, Names, OpenError};
use crate::recorder::Recorder;
use crate::status::{Game, Notice, Shared};
use crate::supervisor::{self, supervise, Ended, Policy};
use crate::tracks::auto::{self, Folders, Seen};
use crate::util::{clock, file_safe, iso_utc, now_ms};

const LMU_ID: &str = "lmu";
const LMU_NAME: &str = "Le Mans Ultimate";
/// The game's program (lower case), to tell "open, not sharing" from "not running" when its memory is missing.
pub const LMU_PROGRAMS: &[&str] = &["le mans ultimate.exe"];

/// How long a game whose program runs without sharing data is "loading" (splash screens, menus coming up) before it is
/// called "open, no data": some games create their shared memory only once loaded.
const LOADING_GRACE: Duration = Duration::from_secs(45);

/// What a game that runs without sharing data is, given when it was first seen so.
fn quiet_state(since: Instant, grace: Duration) -> Game {
    if since.elapsed() < grace {
        Game::Loading
    } else {
        Game::Silent
    }
}

pub fn explain(error: &OpenError) -> String {
    match error {
        OpenError::NotRunning => {
            "Le Mans Ultimate is not sharing data. Is the game running, and is 'Enable external plugins' on (Settings > Gameplay)?".into()
        }
        OpenError::TooSmall { found, expected } => {
            format!("The game's shared memory is {found} bytes; this build expects {expected}. Another game version: nothing was read.")
        }
        OpenError::Os(message) => message.clone(),
    }
}

/// The file name of a lap: track, car, lap number and the minute it started.
pub fn lap_file_name(lap: &lapfile::Lap) -> String {
    let stamp: String = lap.started_at.chars().filter(char::is_ascii_digit).take(14).collect();
    format!(
        "{}_{}_lap{}_{}.xlap.gz",
        file_safe(&lap.track_name),
        file_safe(&lap.car_name),
        lap.lap_number,
        stamp
    )
}

/// What a saved lap's label ends with when the lap did not count; the panel looks for it to draw the invalid mark.
pub const NOT_VALID_MARK: &str = " (not valid)";

/// Writes the lap next to its final name as `.part` and renames it, so a half-written file never looks like a lap.
/// Returns `Lap 3  1:42.318` when it worked.
pub fn save(out: &Path, lap: &lapfile::Lap, say: &dyn Fn(String)) -> Option<String> {
    let name = lap_file_name(lap);
    let (path, partial) = (out.join(&name), out.join(format!("{name}.part")));
    let result = lapfile::gzip(lap)
        .map_err(|e| e.to_string())
        .and_then(|bytes| std::fs::write(&partial, &bytes).map(|_| bytes.len()).map_err(|e| e.to_string()))
        .and_then(|size| std::fs::rename(&partial, &path).map(|_| size).map_err(|e| e.to_string()));
    match result {
        Ok(size) => {
            say(format!(
                "Saved lap {} {} ({}) -> {name} ({} KB)",
                lap.lap_number,
                clock(lap.time_ms),
                if lap.valid { "valid" } else { "not valid" },
                size.div_ceil(1024)
            ));
            Some(format!(
                "Lap {}  {}{}",
                lap.lap_number,
                clock(lap.time_ms),
                if lap.valid { "" } else { NOT_VALID_MARK }
            ))
        }
        Err(error) => {
            say(format!("Could not save lap {}: {error}", lap.lap_number));
            None
        }
    }
}

/// Sleeps up to `total`, but wakes early to notice the person pausing or quitting.
fn rest(shared: &Shared, total: Duration) {
    let until = Instant::now() + total;
    while Instant::now() < until && !shared.quitting() && !shared.paused() {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Records until `shared.quit()`. With `stop_on_unsupported` a game this build cannot read ends the loop with the
/// reason (the terminal wants to hear it); without it the loop keeps looking, because the tray app has no one to tell.
pub fn run(out: &Path, shared: &Shared, say: &(dyn Fn(String) + Sync), stop_on_unsupported: bool) -> Result<(), String> {
    std::fs::create_dir_all(out).map_err(|e| format!("Cannot create {}: {e}", out.display()))?;
    std::thread::scope(|scope| {
        // The tracks the games are on go to a thread of their own, which builds their layouts from the game's files:
        // reading a game never waits for that.
        let (tracks, seen) = mpsc::channel();
        scope.spawn(move || {
            watched(shared, supervisor::TRACKS, say, || {
                auto::run(
                    out,
                    &seen,
                    &Folders::installed,
                    &|| shared.quitting(),
                    &|| shared.wake_uploader(),
                    say,
                );
            });
        });
        // The other games have a reader each, looked after by one loop of its own; Le Mans Ultimate has its own.
        scope.spawn(move || {
            watched(shared, supervisor::GAMES, say, || {
                run_games(READERS, out, shared, say, Some(&tracks), LOADING_GRACE)
            });
        });
        let mut result = Ok(());
        let ended = watched(shared, supervisor::LMU, say, || {
            result = run_lmu(out, shared, say, stop_on_unsupported);
        });
        if ended == Ended::GaveUp {
            // The Le Mans Ultimate reader is out for good, but the other readers go on: the tray stays up until it is closed.
            while !shared.quitting() {
                std::thread::sleep(Duration::from_millis(200));
            }
        }
        shared.quit();
        result
    })
}

/// Runs one of the long-lived workers under the supervisor: a panic is logged and the worker starts again after a wait;
/// when it keeps panicking it is given up on and the panel shows it as failed.
fn watched(shared: &Shared, id: &'static str, say: &(dyn Fn(String) + Sync), body: impl FnMut()) -> Ended {
    let name = supervisor::title(id);
    supervise(
        name,
        &Policy::default(),
        &|| shared.quitting(),
        &|line| say(line),
        &|health| shared.set_worker(id, health),
        body,
    )
}

/// A panel tracker that keeps each track's map in `maps` (under the Xpeed Companion folder) and takes the built layout from
/// the outbox in `out`; with no Xpeed Companion folder the maps are just not kept.
fn tracker_for(game: &'static str, out: &Path) -> crate::dash::Tracker {
    match crate::maps::default_dir() {
        Some(maps) => crate::dash::Tracker::stored(crate::maps::Store {
            maps,
            layouts: out.join(auto::TRACKS_DIR),
            game,
        }),
        None => crate::dash::Tracker::default(),
    }
}

/// Reads whichever of the other games is running, and writes its laps like Le Mans Ultimate's. Each track a game is
/// driven on is told to `tracks` once (and again when it changes), for its layout to be built. A game that runs without
/// data is shown as loading for `grace`, then as open without data.
pub fn run_games(
    readers: &[Reader],
    out: &Path,
    shared: &Shared,
    say: &(dyn Fn(String) + Sync),
    tracks: Option<&mpsc::Sender<Seen>>,
    grace: Duration,
) {
    struct Live {
        family: &'static str,
        programs: &'static [&'static str],
        source: Box<dyn Source>,
        cutter: LapCutter,
        last_frame: Instant,
        lap_shown: i32,
        track_told: Option<(String, Option<String>)>,
        /// The panel's view of this game (the delta to the best lap).
        tracker: crate::dash::Tracker,
        /// A frame has arrived. A source that only listens (`Source::listens`) is "open, no data yet" until then.
        heard: bool,
        /// Opened again after being let go while its game ran: no "Connected" line when the data comes back.
        quiet: bool,
        /// The game shown as open without data while no frame has come (it may differ from the source's own id).
        silent_as: Option<(&'static str, &'static str)>,
        /// When this source was opened: a listening source is loading for the grace period after that.
        opened_at: Instant,
        /// The "open but shares no data yet" line was said for this source.
        told_silent: bool,
    }
    let saved = |lap: &lapfile::Lap| {
        if let Some(label) = save(out, lap, say) {
            shared.update(|s| {
                s.laps_saved += 1;
                s.last_lap = Some(label.clone());
            });
            shared.notify(Notice::LapSaved(label));
            shared.wake_uploader();
        }
    };
    let mut live: Vec<Live> = Vec::new();
    // Families let go while their game still ran: opened again without a word.
    let mut reopen_quietly: Vec<&'static str> = Vec::new();
    // When each game's program was first seen running without data (cleared when it stops running or shares).
    let mut first_seen: std::collections::HashMap<&'static str, Instant> = std::collections::HashMap::new();
    let mut last_look = Instant::now().checked_sub(Duration::from_secs(10)).unwrap_or_else(Instant::now);
    while !shared.quitting() {
        if shared.paused() {
            for l in &live {
                shared.set_game(l.source.game_id(), l.source.game_name(), Game::Paused);
            }
            rest(shared, Duration::from_millis(500));
            continue;
        }
        // Look again, every couple of seconds, for the games that are running and not open yet.
        if last_look.elapsed() >= Duration::from_secs(2) {
            last_look = Instant::now();
            let running = crate::win::running_programs();
            for l in &live {
                if !l.programs.is_empty() && !crate::win::any_running(&running, l.programs) {
                    // The game closed: its reader lets go of its door (and of its UDP port).
                    if let Some((id, name)) = l.silent_as {
                        shared.set_game(id, name, Game::Waiting);
                    }
                    shared.set_game(l.source.game_id(), l.source.game_name(), Game::Waiting);
                    say(format!("{} closed.", l.source.game_name()));
                }
            }
            live.retain(|l| l.programs.is_empty() || crate::win::any_running(&running, l.programs));
            for reader in readers {
                if live.iter().any(|l| l.family == reader.family) {
                    continue;
                }
                if !reader.programs.is_empty() && !crate::win::any_running(&running, reader.programs) {
                    // Not running (any more): a game that was open without data goes back to waiting.
                    for (id, name, game) in shared.games() {
                        if matches!(game, Game::Silent | Game::Loading) && reader.ids.contains(&id) {
                            shared.set_game(id, name, Game::Waiting);
                        }
                    }
                    for id in reader.ids {
                        first_seen.remove(id);
                    }
                    continue;
                }
                let opened = (reader.open)();
                if opened.is_none() {
                    // Its program runs but there is no data: the panel names the game and tells how to switch it on.
                    if let Some((id, name)) = crate::games::running_game(&running, reader) {
                        let since = *first_seen.entry(id).or_insert_with(Instant::now);
                        let state = quiet_state(since, grace);
                        let told = shared.games().iter().any(|(i, _, g)| *i == id && *g == Game::Silent);
                        if state == Game::Silent && !told {
                            say(format!("{name} is open but shares no data yet."));
                        }
                        shared.set_game(id, name, state);
                    }
                } else {
                    for id in reader.ids {
                        first_seen.remove(id);
                    }
                }
                if let Some(source) = opened {
                    let quiet = reopen_quietly.contains(&reader.family);
                    reopen_quietly.retain(|f| *f != reader.family);
                    let listens = source.listens();
                    let mut silent_as = None;
                    let mut state_silent = false;
                    // A source opened again after a stop is not loading: its game has been running for a while.
                    let opened_at = if quiet {
                        Instant::now().checked_sub(grace).unwrap_or_else(Instant::now)
                    } else {
                        Instant::now()
                    };
                    if listens {
                        // Only a socket is open: the game may send nothing. It is loading for a while, then "no data",
                        // until the first packet.
                        let (id, name) = crate::games::running_game(&running, reader).unwrap_or((source.game_id(), source.game_name()));
                        let state = quiet_state(opened_at, grace);
                        let told = shared.games().iter().any(|(i, _, g)| *i == id && *g == Game::Silent);
                        if state == Game::Silent && !told && !quiet {
                            say(format!("{name} is open but shares no data yet."));
                        }
                        state_silent = state == Game::Silent;
                        shared.set_game(id, name, state);
                        silent_as = Some((id, name));
                    } else {
                        if !quiet {
                            say(format!("Connected to {}.", source.game_name()));
                        }
                        shared.set_game(source.game_id(), source.game_name(), Game::Connected);
                    }
                    let game_id = source.game_id();
                    live.push(Live {
                        heard: !listens,
                        quiet,
                        silent_as,
                        opened_at,
                        told_silent: state_silent,
                        family: reader.family,
                        programs: reader.programs,
                        cutter: LapCutter::new(source.game_id()),
                        source,
                        last_frame: Instant::now(),
                        lap_shown: 0,
                        track_told: None,
                        tracker: tracker_for(game_id, out),
                    });
                }
            }
        }
        if live.is_empty() {
            rest(shared, Duration::from_millis(250));
            continue;
        }
        let slice = Duration::from_millis((40 / live.len() as u64).clamp(5, 40));
        for l in live.iter_mut() {
            if let Some(frame) = l.source.next(slice) {
                l.last_frame = Instant::now();
                if !l.heard {
                    // The first packet: the game shares after all.
                    l.heard = true;
                    if let Some((id, name)) = l.silent_as.take() {
                        if id != l.source.game_id() {
                            shared.set_game(id, name, Game::Waiting);
                        }
                    }
                    if !l.quiet {
                        say(format!("Connected to {}.", l.source.game_name()));
                    }
                }
                // One door can serve several games (the F1 reader reads F1 25, 24 and 23 on one UDP port, and names
                // itself after the game of the packets): when the game changes, its laps start over under its own id.
                let game = l.source.game_id();
                if l.cutter.game() != game {
                    shared.set_game(l.cutter.game(), l.source.game_name(), Game::Waiting);
                    say(format!("Now reading {}.", l.source.game_name()));
                    l.cutter = LapCutter::new(game);
                    l.tracker = tracker_for(game, out);
                    l.track_told = None;
                    l.lap_shown = 0;
                }
                if frame.driving && frame.lap > 0 && frame.lap != l.lap_shown {
                    l.lap_shown = frame.lap;
                }
                let state = if frame.driving && l.lap_shown > 0 {
                    Game::Recording(l.lap_shown as u32)
                } else {
                    Game::Connected
                };
                shared.set_game(l.source.game_id(), l.source.game_name(), state);
                if let Some(tracks) = tracks.filter(|_| frame.driving && !frame.track.is_empty()) {
                    // Compared without copying: this runs for every frame.
                    let here = (frame.track.as_str(), frame.track_variant.as_deref());
                    if l.track_told.as_ref().map(|(t, v)| (t.as_str(), v.as_deref())) != Some(here) {
                        // A send never blocks; if the other thread is gone, there is just no layout.
                        let _ = tracks.send(Seen {
                            game: l.source.game_id().to_owned(),
                            track: frame.track.clone(),
                            variant: frame.track_variant.clone(),
                        });
                        l.track_told = Some((frame.track.clone(), frame.track_variant.clone()));
                    }
                }
                shared.offer_live(l.tracker.on_frame(l.source.game_name(), &frame, now_ms()));
                for mut lap in l.cutter.on_frame(&frame, now_ms()) {
                    l.source.finish_lap(&mut lap);
                    saved(&lap);
                }
            } else if !l.heard {
                // Open, nothing heard yet: loading for the grace period, then "no data" for as long as its program runs
                // (and after a pause).
                if let Some((id, name)) = l.silent_as {
                    let state = quiet_state(l.opened_at, grace);
                    if state == Game::Silent && !l.told_silent && !l.quiet {
                        say(format!("{name} is open but shares no data yet."));
                    }
                    l.told_silent |= state == Game::Silent;
                    shared.set_game(id, name, state);
                }
            } else if l.last_frame.elapsed() > Duration::from_secs(10) {
                // A door that stays open but says nothing for a while: the game is in a menu, paused, or between
                // sessions (Automobilista 2 stops writing there). It is still open and connected, only not on track,
                // so it stays Connected (the panel says "connected, get in the car"), never Waiting: Waiting is for a
                // game that is not running, set when its program closes.
                shared.set_game(l.source.game_id(), l.source.game_name(), Game::Connected);
                l.lap_shown = 0;
            }
        }
        // A source that stopped answering is let go. When its program still runs (a game that stops writing in a
        // menu, or after its data option was switched on mid-session) it is not "closed": it is opened again at the
        // next look, quietly, and the game stays connected meanwhile.
        if live.iter().all(|l| l.source.alive()) {
            continue;
        }
        let running = crate::win::running_programs();
        live.retain(|l| {
            let alive = l.source.alive();
            if !alive {
                let still_open = !l.programs.is_empty() && crate::win::any_running(&running, l.programs);
                if still_open {
                    reopen_quietly.push(l.family);
                } else {
                    say(format!("{} closed.", l.source.game_name()));
                    if let Some((id, name)) = l.silent_as {
                        shared.set_game(id, name, Game::Waiting);
                    }
                    shared.set_game(l.source.game_id(), l.source.game_name(), Game::Waiting);
                }
            }
            alive
        });
    }
}

/// Waits of 200 ms without a frame that make a 10 s quiet period.
const LMU_QUIET_WAITS: u32 = 50;

/// What to do when Le Mans Ultimate has been quiet for a whole quiet period.
#[derive(Debug, PartialEq, Eq)]
enum QuietAction {
    /// The program still runs (a menu, a pause): keep the same reader and stay connected.
    KeepReading,
    /// The program is gone: let the reader go and start over.
    Reconnect,
}

fn lmu_quiet_action(program_running: bool) -> QuietAction {
    if program_running {
        QuietAction::KeepReading
    } else {
        QuietAction::Reconnect
    }
}

fn run_lmu(out: &Path, shared: &Shared, say: &(dyn Fn(String) + Sync), stop_on_unsupported: bool) -> Result<(), String> {
    std::fs::create_dir_all(out).map_err(|e| format!("Cannot create {}: {e}", out.display()))?;
    say(format!("Writing laps to {}.", out.display()));
    let saved = |lap: &lapfile::Lap| {
        if let Some(label) = save(out, lap, say) {
            shared.update(|s| {
                s.laps_saved += 1;
                s.last_lap = Some(label.clone());
            });
            shared.notify(Notice::LapSaved(label));
            shared.wake_uploader();
        }
    };
    let mut waiting = false;
    let mut told_silent = false;
    // When the game's program was first seen running without its memory.
    let mut loading_since: Option<Instant> = None;
    while !shared.quitting() {
        if shared.paused() {
            shared.set_game(LMU_ID, LMU_NAME, Game::Paused);
            rest(shared, Duration::from_millis(500));
            continue;
        }
        let mut reader = match LmuReader::open(&Names::lmu()) {
            Ok(reader) => reader,
            Err(OpenError::NotRunning) => {
                if !waiting {
                    say("Waiting for Le Mans Ultimate ('Enable external plugins' must be on)...".into());
                    waiting = true;
                }
                // No memory. With the game's program running, it is open and not sharing: the panel says how to switch
                // that on. Without it, the game is simply not there.
                let running = crate::win::any_running(&crate::win::running_programs(), LMU_PROGRAMS);
                let state = if running {
                    quiet_state(*loading_since.get_or_insert_with(Instant::now), LOADING_GRACE)
                } else {
                    loading_since = None;
                    Game::Waiting
                };
                let silent = state == Game::Silent;
                if silent && !told_silent {
                    say("Le Mans Ultimate is open but shares no data yet.".into());
                }
                told_silent = silent;
                shared.set_game(LMU_ID, LMU_NAME, state);
                rest(shared, Duration::from_secs(2));
                continue;
            }
            Err(error) => {
                let why = explain(&error);
                say(why.clone());
                if stop_on_unsupported {
                    return Err(why);
                }
                shared.set_game(LMU_ID, LMU_NAME, Game::Unsupported);
                rest(shared, Duration::from_secs(30));
                continue;
            }
        };
        if !reader.layout_matches() {
            let why = format!(
                "The game's shared memory is not the size this build knows ({} bytes, expected {}). Nothing is recorded; update Xpeed Companion.",
                reader.mapped_bytes(),
                LAYOUT_SIZE
            );
            say(why.clone());
            if stop_on_unsupported {
                return Err(why);
            }
            shared.set_game(LMU_ID, LMU_NAME, Game::Unsupported);
            rest(shared, Duration::from_secs(30));
            continue;
        }
        waiting = false;
        told_silent = false;
        say(format!("Connected to Le Mans Ultimate at {}.", iso_utc(now_ms())));
        shared.set_game(LMU_ID, LMU_NAME, Game::Connected);
        let mut recorder = Recorder::new();
        // The panel needs the distance and times of the scoring stream alongside each telemetry update.
        let mut tracker = tracker_for(LMU_ID, out);
        let mut last_scoring = None;
        let mut silent_waits = 0;
        let mut lap_shown = 0;
        let mut gone = false;
        // Without a frame for 10 s the game is either closed or sitting in a menu. The process list is looked at once
        // per quiet period (never every 200 ms). A game that still runs stays connected on the same reader, quietly:
        // Waiting is only for a game whose program closed, which starts over from a clean connection.
        while !shared.quitting() && !shared.paused() {
            if !reader.wait_frame(200) {
                silent_waits += 1;
                if silent_waits >= LMU_QUIET_WAITS {
                    let running = crate::win::any_running(&crate::win::running_programs(), LMU_PROGRAMS);
                    match lmu_quiet_action(running) {
                        QuietAction::KeepReading => {
                            // Open but not on track: it may have been recording a lap.
                            shared.set_game(LMU_ID, LMU_NAME, Game::Connected);
                            lap_shown = 0;
                            silent_waits = 0;
                        }
                        QuietAction::Reconnect => {
                            gone = true;
                            break;
                        }
                    }
                }
                continue;
            }
            silent_waits = 0;
            let Some(snapshot) = reader.read() else { continue };
            if let Some(s) = &snapshot.scoring {
                last_scoring = Some(s.clone());
            }
            if let Some(t) = &snapshot.telemetry {
                let frame = crate::dash::lmu_frame(t, last_scoring.as_ref());
                shared.offer_live(tracker.on_frame(LMU_NAME, &frame, now_ms()));
                if t.lap_number > 0 && t.lap_number != lap_shown {
                    lap_shown = t.lap_number;
                    shared.set_game(LMU_ID, LMU_NAME, Game::Recording(lap_shown as u32));
                }
                recorder.on_telemetry(t, now_ms()).iter().for_each(saved);
            }
            if let Some(s) = &snapshot.scoring {
                recorder.on_scoring(s).iter().for_each(saved);
            }
        }
        if gone {
            say("No data from the game for 10 s; reconnecting.".into());
            shared.set_game(LMU_ID, LMU_NAME, Game::Waiting);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lmu_quiet_period_keeps_reading_while_the_game_runs() {
        assert_eq!(lmu_quiet_action(true), QuietAction::KeepReading);
        assert_eq!(lmu_quiet_action(false), QuietAction::Reconnect);
        // 50 waits of 200 ms are the 10 s quiet period.
        assert_eq!(LMU_QUIET_WAITS * 200, 10_000);
    }
    use crate::lapfile::{Channel, Lap};

    fn lap(number: u32) -> Lap {
        let channel = |id: &str, unit: &str| Channel {
            id: id.into(),
            unit: unit.into(),
            values: vec![0.0, 1.0],
        };
        Lap {
            game: "lmu".into(),
            track_name: "Circuit de la Sarthe".into(),
            track_variant: None,
            track_length_m: Some(13626.0),
            car_name: "Porsche 963 #6".into(),
            car_class: None,
            lap_number: number,
            time_ms: 207_250,
            valid: true,
            sectors_ms: None,
            started_at: "2026-11-10T12:34:56.789Z".into(),
            sample_rate_hz: 2.0,
            channels: vec![channel("t", "s"), channel("dist", "m")],
            ..Lap::default()
        }
    }

    #[test]
    fn names_a_lap_file_after_the_track_the_car_the_lap_and_the_start() {
        assert_eq!(
            lap_file_name(&lap(3)),
            "circuit-de-la-sarthe_porsche-963-6_lap3_20261110123456.xlap.gz"
        );
    }

    #[test]
    fn saves_a_lap_as_a_whole_file_and_says_what_it_is() {
        let dir = crate::config::scratch_dir("engine-save");
        let lines = std::sync::Mutex::new(Vec::new());
        let label = save(&dir, &lap(3), &|line| lines.lock().unwrap().push(line));
        assert_eq!(label.as_deref(), Some("Lap 3  3:27.250"));
        let written: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(
            written,
            ["circuit-de-la-sarthe_porsche-963-6_lap3_20261110123456.xlap.gz"],
            "no .part file is left"
        );
        assert!(lines.lock().unwrap()[0].starts_with("Saved lap 3 3:27.250 (valid)"));
        // And it is a lap the strict reader accepts.
        let bytes = std::fs::read(dir.join(&written[0])).unwrap();
        assert!(lapfile::gunzip(&bytes, lapfile::MAX_UNPACKED).is_ok());
    }

    #[test]
    fn says_so_when_a_lap_cannot_be_saved_and_does_not_count_it() {
        let dir = crate::config::scratch_dir("engine-save-fail").join("missing-folder");
        let lines = std::sync::Mutex::new(Vec::new());
        assert_eq!(save(&dir, &lap(4), &|line| lines.lock().unwrap().push(line)), None);
        assert!(lines.lock().unwrap()[0].starts_with("Could not save lap 4"));
    }

    #[test]
    fn a_lap_that_is_not_valid_is_labelled_so() {
        let dir = crate::config::scratch_dir("engine-invalid");
        let mut invalid = lap(5);
        invalid.valid = false;
        assert_eq!(save(&dir, &invalid, &|_| {}).as_deref(), Some("Lap 5  3:27.250 (not valid)"));
    }

    #[test]
    fn rests_but_wakes_when_the_person_quits() {
        let shared = Shared::new(true);
        shared.quit();
        let started = Instant::now();
        rest(&shared, Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    // A scripted game: the frames a test hands over, delivered one per call.
    static SCRIPT: std::sync::Mutex<Vec<crate::game::Frame>> = std::sync::Mutex::new(Vec::new());
    struct Scripted {
        done: bool,
    }
    impl Source for Scripted {
        fn game_id(&self) -> &'static str {
            "fake"
        }
        fn game_name(&self) -> &'static str {
            "Fake Racing"
        }
        fn next(&mut self, _timeout: Duration) -> Option<crate::game::Frame> {
            let mut script = SCRIPT.lock().unwrap();
            if script.is_empty() {
                self.done = true;
                return None;
            }
            Some(script.remove(0))
        }
        fn alive(&self) -> bool {
            !self.done
        }
    }
    fn open_scripted() -> Option<Box<dyn Source>> {
        Some(Box::new(Scripted { done: false }))
    }

    // A game that only listens (like a UDP reader): silent until the test lets it "send".
    static SENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    struct Listening;
    impl Source for Listening {
        fn game_id(&self) -> &'static str {
            "fakeudp"
        }
        fn game_name(&self) -> &'static str {
            "Fake UDP Racing"
        }
        fn next(&mut self, timeout: Duration) -> Option<crate::game::Frame> {
            std::thread::sleep(timeout.min(Duration::from_millis(5)));
            SENDING.load(std::sync::atomic::Ordering::SeqCst).then(crate::game::Frame::empty)
        }
        fn alive(&self) -> bool {
            true
        }
        fn listens(&self) -> bool {
            true
        }
    }
    fn open_listening() -> Option<Box<dyn Source>> {
        Some(Box::new(Listening))
    }

    #[test]
    fn a_game_that_only_listens_is_open_without_data_until_its_first_packet() {
        let dir = crate::config::scratch_dir("engine-listening");
        let shared = Shared::new(true);
        let readers = [Reader {
            family: "fakeudp",
            title: "Fake UDP",
            ids: &["fakeudp"],
            programs: &[],
            open: open_listening,
        }];
        let said = std::sync::Mutex::new(Vec::<String>::new());
        let grace = Duration::from_millis(600);
        let state = || shared.games().into_iter().find(|(id, _, _)| *id == "fakeudp").map(|(_, _, g)| g);
        let wait_for = |want: Game| {
            let started = Instant::now();
            while state() != Some(want.clone()) && started.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(20));
            }
            state()
        };
        std::thread::scope(|scope| {
            scope.spawn(|| run_games(&readers, &dir, &shared, &|line| said.lock().unwrap().push(line), None, grace));
            assert_eq!(wait_for(Game::Loading), Some(Game::Loading), "just opened: still loading");
            assert!(
                !said.lock().unwrap().iter().any(|l| l.ends_with("is open but shares no data yet.")),
                "nothing is said while it loads"
            );
            assert_eq!(
                wait_for(Game::Silent),
                Some(Game::Silent),
                "open, nothing heard after the grace period"
            );
            std::thread::sleep(Duration::from_millis(300));
            assert_eq!(state(), Some(Game::Silent), "stays without data while nothing comes");
            assert!(
                !said.lock().unwrap().iter().any(|l| l.starts_with("Connected")),
                "{:?}",
                said.lock().unwrap()
            );
            SENDING.store(true, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(wait_for(Game::Connected), Some(Game::Connected), "the first packet connects it");
            std::thread::sleep(Duration::from_millis(300));
            shared.quit();
        });
        let said = said.into_inner().unwrap();
        assert_eq!(
            said.iter().filter(|l| l.as_str() == "Connected to Fake UDP Racing.").count(),
            1,
            "{said:?}"
        );
        assert_eq!(
            said.iter().filter(|l| l.ends_with("is open but shares no data yet.")).count(),
            1,
            "{said:?}"
        );
    }

    #[test]
    fn a_game_with_a_reader_gets_its_laps_written_and_its_name_shown() {
        use crate::game::Frame;
        let dir = crate::config::scratch_dir("engine-games");
        let frame = |clock: f64, lap: i32, last: Option<f64>| {
            let mut f = Frame::empty();
            f.clock_s = clock;
            f.driving = true;
            f.lap = lap;
            f.lap_time_s = Some(clock - 30.0 * f64::from(lap - 1));
            f.last_lap_s = last;
            f.dist_m = Some((clock - 30.0 * f64::from(lap - 1)) * 50.0);
            f.speed_ms = 50.0;
            f.car = "Test Car".into();
            f.track = "Test Ring".into();
            f
        };
        // Lap 1 from the start, then lap 2 begins carrying lap 1's official time.
        let mut script: Vec<Frame> = (0..600).map(|i| frame(f64::from(i) * 0.05, 1, None)).collect();
        script.extend((600..640).map(|i| frame(f64::from(i) * 0.05, 2, Some(30.0))));
        *SCRIPT.lock().unwrap() = script;
        let shared = Shared::new(true);
        let readers = [Reader {
            family: "fake",
            title: "Fake",
            ids: &["fake"],
            programs: &[],
            open: open_scripted,
        }];
        let finished = std::sync::atomic::AtomicBool::new(false);
        let (tracks, seen) = mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                run_games(&readers, &dir, &shared, &|_| {}, Some(&tracks), LOADING_GRACE);
                finished.store(true, std::sync::atomic::Ordering::SeqCst);
            });
            // The loop ends when told to quit; give it time to read the script, and to see the game go away.
            let started = Instant::now();
            while shared.snapshot().laps_saved == 0 && started.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(20));
            }
            let seen = shared.snapshot();
            assert_eq!(seen.laps_saved, 1);
            assert_eq!(seen.last_lap.as_deref(), Some("Lap 1  0:30.000"));
            shared.quit();
        });
        assert!(finished.load(std::sync::atomic::Ordering::SeqCst));
        // 640 frames on one track: the track is told once, for its layout.
        assert_eq!(
            seen.try_iter().collect::<Vec<_>>(),
            [Seen {
                game: "fake".into(),
                track: "Test Ring".into(),
                variant: None
            }]
        );
        let written: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(
            written,
            ["test-ring_test-car_lap1_20261110120000.xlap.gz"
                .replace("20261110120000", &written[0][written[0].len() - 22..written[0].len() - 8])]
        );
        let bytes = std::fs::read(dir.join(&written[0])).unwrap();
        let lap = lapfile::gunzip(&bytes, lapfile::MAX_UNPACKED).unwrap();
        assert_eq!((lap.game.as_str(), lap.time_ms, lap.valid), ("fake", 30_000, true));
        // Version 2: the lap carries the id of the session it was driven in, and says it is neither an out nor an in lap.
        assert_eq!(lap.session_id.as_deref().map(str::len), Some(32));
        assert_eq!((lap.out_lap, lap.in_lap), (Some(false), Some(false)));
    }

    #[test]
    fn a_loop_told_to_quit_does_nothing_but_make_the_folder() {
        let dir = crate::config::scratch_dir("engine-quit").join("laps");
        let shared = Shared::new(true);
        shared.quit();
        assert_eq!(run(&dir, &shared, &|_| {}, false), Ok(()));
        assert!(dir.is_dir());
    }
}
