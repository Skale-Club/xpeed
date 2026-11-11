//! The loop that reads Le Mans Ultimate and writes each lap to a folder. It is what both `record` (in a terminal)
//! and the tray app run; the difference is only who listens to what it says (`say`) and to the shared status.

use std::path::Path;
use std::time::{Duration, Instant};

use crate::lapfile;
use crate::lmu::layout::LAYOUT_SIZE;
use crate::lmu::reader::{LmuReader, Names, OpenError};
use crate::recorder::Recorder;
use crate::status::{Game, Notice, Shared};
use crate::util::{clock, file_safe, iso_utc, now_ms};

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
pub fn run(out: &Path, shared: &Shared, say: &dyn Fn(String), stop_on_unsupported: bool) -> Result<(), String> {
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
    while !shared.quitting() {
        if shared.paused() {
            shared.update(|s| s.game = Game::Paused);
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
                shared.update(|s| s.game = Game::Waiting);
                rest(shared, Duration::from_secs(2));
                continue;
            }
            Err(error) => {
                let why = explain(&error);
                say(why.clone());
                if stop_on_unsupported {
                    return Err(why);
                }
                shared.update(|s| s.game = Game::Unsupported);
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
            shared.update(|s| s.game = Game::Unsupported);
            rest(shared, Duration::from_secs(30));
            continue;
        }
        waiting = false;
        say(format!("Connected to Le Mans Ultimate at {}.", iso_utc(now_ms())));
        shared.update(|s| s.game = Game::Connected);
        let mut recorder = Recorder::new();
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
            if let Some(t) = &snapshot.telemetry {
                if t.lap_number > 0 && t.lap_number != lap_shown {
                    lap_shown = t.lap_number;
                    shared.update(|s| s.game = Game::Recording(lap_shown as u32));
                }
                recorder.on_telemetry(t, now_ms()).iter().for_each(saved);
            }
            if let Some(s) = &snapshot.scoring {
                recorder.on_scoring(s).iter().for_each(saved);
            }
        }
        if silent_waits >= 50 {
            say("No data from the game for 10 s; reconnecting.".into());
            shared.update(|s| s.game = Game::Waiting);
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

    #[test]
    fn a_loop_told_to_quit_does_nothing_but_make_the_folder() {
        let dir = crate::config::scratch_dir("engine-quit").join("laps");
        let shared = Shared::new(true);
        shared.quit();
        assert_eq!(run(&dir, &shared, &|_| {}, false), Ok(()));
        assert!(dir.is_dir());
    }
}
