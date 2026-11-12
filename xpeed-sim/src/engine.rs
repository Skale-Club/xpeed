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
use crate::tracks::auto::{self, Folders, Seen};
use crate::util::{clock, file_safe, iso_utc, now_ms};

const LMU_ID: &str = "lmu";
const LMU_NAME: &str = "Le Mans Ultimate";
/// The game's program (lower case), to tell "open, not sharing" from "not running" when its memory is missing.
const LMU_PROGRAMS: &[&str] = &["le mans ultimate.exe"];

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
                if lap.valid { "" } else { " (not valid)" }
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
            auto::run(
                out,
                seen,
                &Folders::installed,
                &|| shared.quitting(),
                &|| shared.wake_uploader(),
                say,
            );
        });
        // The other games have a reader each, looked after by one loop of its own; Le Mans Ultimate has its own.
        scope.spawn(move || run_games(READERS, out, shared, say, Some(&tracks)));
        let result = run_lmu(out, shared, say, stop_on_unsupported);
        shared.quit();
        result
    })
}

/// Reads whichever of the other games is running, and writes its laps like Le Mans Ultimate's. Each track a game is
/// driven on is told to `tracks` once (and again when it changes), for its layout to be built.
pub fn run_games(readers: &[Reader], out: &Path, shared: &Shared, say: &(dyn Fn(String) + Sync), tracks: Option<&mpsc::Sender<Seen>>) {
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
                        if game == Game::Silent && reader.ids.contains(&id) {
                            shared.set_game(id, name, Game::Waiting);
                        }
                    }
                    continue;
                }
                let opened = (reader.open)();
                if opened.is_none() {
                    // Its program runs but there is no data: the panel names the game and tells how to switch it on.
                    if let Some((id, name)) = crate::games::running_game(&running, reader) {
                        let told = shared.games().iter().any(|(i, _, g)| *i == id && *g == Game::Silent);
                        if !told {
                            say(format!("{name} is open but shares no data yet."));
                        }
                        shared.set_game(id, name, Game::Silent);
                    }
                }
                if let Some(source) = opened {
                    let quiet = reopen_quietly.contains(&reader.family);
                    reopen_quietly.retain(|f| *f != reader.family);
                    let listens = source.listens();
                    let mut silent_as = None;
                    if listens {
                        // Only a socket is open: the game may send nothing. Say so until the first packet.
                        let (id, name) = crate::games::running_game(&running, reader).unwrap_or((source.game_id(), source.game_name()));
                        let told = shared.games().iter().any(|(i, _, g)| *i == id && *g == Game::Silent);
                        if !told && !quiet {
                            say(format!("{name} is open but shares no data yet."));
                        }
                        shared.set_game(id, name, Game::Silent);
                        silent_as = Some((id, name));
                    } else {
                        if !quiet {
                            say(format!("Connected to {}.", source.game_name()));
                        }
                        shared.set_game(source.game_id(), source.game_name(), Game::Connected);
                    }
                    live.push(Live {
                        heard: !listens,
                        quiet,
                        silent_as,
                        family: reader.family,
                        programs: reader.programs,
                        cutter: LapCutter::new(source.game_id()),
                        source,
                        last_frame: Instant::now(),
                        lap_shown: 0,
                        track_told: None,
                        tracker: crate::dash::Tracker::default(),
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
                    l.tracker = crate::dash::Tracker::default();
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
                // Open, nothing heard yet: stays "no data" for as long as its program runs (and after a pause).
                if let Some((id, name)) = l.silent_as {
                    shared.set_game(id, name, Game::Silent);
                }
            } else if l.last_frame.elapsed() > Duration::from_secs(10) {
                // A door that stays open but says nothing (a game sending UDP, stopped or in a menu).
                shared.set_game(l.source.game_id(), l.source.game_name(), Game::Waiting);
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
                if running && !told_silent {
                    say("Le Mans Ultimate is open but shares no data yet.".into());
                }
                told_silent = running;
                shared.set_game(LMU_ID, LMU_NAME, if running { Game::Silent } else { Game::Waiting });
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
                "The game's shared memory is not the size this build knows ({} bytes, expected {}). Nothing is recorded; update Xpeed Sim.",
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
        let mut tracker = crate::dash::Tracker::default();
        let mut last_scoring = None;
        let mut silent_waits = 0;
        let mut lap_shown = 0;
        // Without a frame for 10 s (the game closed, or sits in a menu) start over from a clean connection.
        while silent_waits < 50 && !shared.quitting() && !shared.paused() {
            if !reader.wait_frame(200) {
                silent_waits += 1;
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
        if silent_waits >= 50 {
            say("No data from the game for 10 s; reconnecting.".into());
            shared.set_game(LMU_ID, LMU_NAME, Game::Waiting);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
                run_games(&readers, &dir, &shared, &|_| {}, Some(&tracks));
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
