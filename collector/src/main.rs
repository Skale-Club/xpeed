//! xpeed-collector: reads racing-game telemetry on Windows and writes it as Xpeed lap files.
//!
//! * `probe`   checks that the game is sharing data and shows what it sends (nothing is written);
//! * `record`  writes every lap to a folder as a `.xlap.gz` file;
//! * `inspect` shows what a lap file holds.
//!
//! The first game is Le Mans Ultimate. See `docs/telemetria-virtual-2026-11-10/LMU-TELEMETRIA.md`.

mod lapfile;
mod lmu;
mod recorder;
mod util;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

const HELP: &str = "\
xpeed-collector: racing-game telemetry to Xpeed lap files

USAGE:
    xpeed-collector probe [--seconds N]    Check the connection to Le Mans Ultimate and show what it sends (default 5 s)
    xpeed-collector record --out DIR       Write every lap to DIR as a .xlap.gz file (Ctrl+C to stop)
    xpeed-collector inspect FILE           Show what a lap file holds
    xpeed-collector help

For the game to share data, 'Enable external plugins' must be on (Settings > Gameplay) and the game must be running.
";

#[derive(Debug, PartialEq)]
enum Command {
    Probe { seconds: u64 },
    Record { out: PathBuf },
    Inspect { file: PathBuf },
    Help,
}

fn parse(args: &[String]) -> Result<Command, String> {
    let mut rest = args.iter().map(String::as_str);
    match rest.next() {
        None | Some("help" | "--help" | "-h") => Ok(Command::Help),
        Some("probe") => {
            let mut seconds = 5;
            while let Some(flag) = rest.next() {
                match flag {
                    "--seconds" => {
                        seconds = rest
                            .next()
                            .and_then(|value| value.parse::<u64>().ok())
                            .filter(|n| (1..=3600).contains(n))
                            .ok_or("--seconds needs a number from 1 to 3600")?;
                    }
                    other => return Err(format!("unknown option {other:?}")),
                }
            }
            Ok(Command::Probe { seconds })
        }
        Some("record") => {
            let mut out = None;
            while let Some(flag) = rest.next() {
                match flag {
                    "--out" => out = Some(PathBuf::from(rest.next().ok_or("--out needs a folder")?)),
                    other => return Err(format!("unknown option {other:?}")),
                }
            }
            Ok(Command::Record {
                out: out.ok_or("record needs --out DIR")?,
            })
        }
        Some("inspect") => {
            let file = rest.next().ok_or("inspect needs a file")?;
            match rest.next() {
                None => Ok(Command::Inspect { file: PathBuf::from(file) }),
                Some(extra) => Err(format!("unexpected argument {extra:?}")),
            }
        }
        Some(other) => Err(format!("unknown command {other:?}")),
    }
}

/// `3:27.250` for a time in milliseconds.
fn clock(ms: u32) -> String {
    format!("{}:{:02}.{:03}", ms / 60_000, ms / 1000 % 60, ms % 1000)
}

fn inspect(file: &Path) -> ExitCode {
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("Cannot read {}: {error}", file.display());
            return ExitCode::from(1);
        }
    };
    let lap = if bytes.starts_with(&[0x1f, 0x8b]) {
        lapfile::gunzip(&bytes, lapfile::MAX_UNPACKED)
    } else {
        lapfile::unpack(&bytes)
    };
    let lap = match lap {
        Ok(lap) => lap,
        Err(error) => {
            eprintln!("{} is not a valid lap file: {error}", file.display());
            return ExitCode::from(1);
        }
    };
    println!("game        {}", lap.game);
    println!(
        "track       {}{}",
        lap.track_name,
        lap.track_length_m.map_or(String::new(), |m| format!(" ({m:.0} m)"))
    );
    println!(
        "car         {}{}",
        lap.car_name,
        lap.car_class.as_ref().map_or(String::new(), |c| format!(" [{c}]"))
    );
    println!(
        "lap         {}  {}  {}",
        lap.lap_number,
        clock(lap.time_ms),
        if lap.valid { "valid" } else { "not valid" }
    );
    if let Some(sectors) = &lap.sectors_ms {
        println!("sectors     {}", sectors.iter().map(|ms| clock(*ms)).collect::<Vec<_>>().join("  "));
    }
    println!("started     {}", lap.started_at);
    println!("samples     {} at {} Hz", lap.sample_count(), lap.sample_rate_hz);
    println!(
        "{:<10}  {:<6}  {:>12}  {:>12}  {:>12}  {:>12}",
        "channel", "unit", "first", "last", "min", "max"
    );
    for channel in &lap.channels {
        let finite = channel.values.iter().copied().filter(|v| v.is_finite());
        let min = finite.clone().fold(f32::INFINITY, f32::min);
        let max = finite.fold(f32::NEG_INFINITY, f32::max);
        let (first, last) = (channel.values[0], channel.values[channel.values.len() - 1]);
        println!(
            "{:<10}  {:<6}  {first:>12.3}  {last:>12.3}  {min:>12.3}  {max:>12.3}",
            channel.id, channel.unit
        );
    }
    ExitCode::SUCCESS
}

#[cfg(windows)]
mod live {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::lmu::layout::LAYOUT_SIZE;
    use crate::lmu::reader::{LmuReader, Names, OpenError};
    use crate::lmu::snapshot::PlayerTelemetry;
    use crate::recorder::Recorder;
    use crate::util::{file_safe, iso_utc, now_ms};

    fn explain(error: &OpenError) -> String {
        match error {
            OpenError::NotRunning => {
                "Le Mans Ultimate is not sharing data. Is the game running, and is 'Enable external plugins' on (Settings > Gameplay)?"
                    .into()
            }
            OpenError::TooSmall { found, expected } => {
                format!("The game's shared memory is {found} bytes; this build expects {expected}. Another game version: nothing was read.")
            }
            OpenError::Os(message) => message.clone(),
        }
    }

    pub fn probe(seconds: u64) -> ExitCode {
        let mut reader = match LmuReader::open(&Names::lmu()) {
            Ok(reader) => reader,
            Err(error) => {
                println!("{}", explain(&error));
                return ExitCode::from(1);
            }
        };
        println!("Connected to Le Mans Ultimate.");
        println!(
            "Shared memory: {} bytes, this build expects {} ({}).",
            reader.mapped_bytes(),
            LAYOUT_SIZE,
            if reader.layout_matches() {
                "same size"
            } else {
                "DIFFERENT: values may be wrong, `record` will refuse"
            }
        );

        let started = Instant::now();
        let (mut telemetry_total, mut scoring_total) = (0u64, 0u64);
        let (mut telemetry_now, mut scoring_now) = (0u64, 0u64);
        let mut last_print = Instant::now();
        let mut latest: Option<PlayerTelemetry> = None;
        let mut latest_scoring = None;
        let mut version = None;
        while started.elapsed() < Duration::from_secs(seconds) {
            if !reader.wait_frame(200) {
                continue;
            }
            let Some(snapshot) = reader.read() else { continue };
            version = Some(snapshot.game_version);
            if let Some(t) = snapshot.telemetry {
                telemetry_total += 1;
                telemetry_now += 1;
                latest = Some(t);
            }
            if let Some(s) = snapshot.scoring {
                scoring_total += 1;
                scoring_now += 1;
                latest_scoring = Some(s);
            }
            if last_print.elapsed() >= Duration::from_secs(1) {
                let elapsed = last_print.elapsed().as_secs_f64();
                print!(
                    "telemetry {:>5.1} Hz  scoring {:>4.1} Hz",
                    telemetry_now as f64 / elapsed,
                    scoring_now as f64 / elapsed
                );
                if let Some(t) = &latest {
                    print!(
                        "  | lap {}  {:>5.0} km/h  {:>5.0} rpm  gear {}",
                        t.lap_number,
                        t.speed_ms() * 3.6,
                        t.rpm,
                        t.gear
                    );
                }
                if let Some(p) = latest_scoring
                    .as_ref()
                    .and_then(|s: &crate::lmu::snapshot::ScoringFrame| s.player.as_ref())
                {
                    print!("  dist {:>6.0} m{}", p.lap_dist, if p.in_pits { "  (pits)" } else { "" });
                }
                println!();
                (telemetry_now, scoring_now, last_print) = (0, 0, Instant::now());
            }
        }

        println!();
        if let Some(version) = version {
            println!("Game version number in the shared memory: {version}");
        }
        if let Some(t) = &latest {
            println!("Car:   {}", t.vehicle_name);
            println!("Track: {}", t.track_name);
        }
        if let Some(s) = &latest_scoring {
            println!(
                "Track length (scoring): {:.0} m   session {}   in realtime: {}",
                s.session.track_length_m, s.session.session, s.session.in_realtime
            );
        }
        let secs = started.elapsed().as_secs_f64();
        println!(
            "Over {secs:.0} s: {telemetry_total} telemetry frames ({:.1} Hz), {scoring_total} scoring updates ({:.1} Hz).",
            telemetry_total as f64 / secs,
            scoring_total as f64 / secs
        );
        if telemetry_total == 0 {
            println!("No telemetry: is the player in a session with a car (garage or track)?");
            return ExitCode::from(1);
        }
        ExitCode::SUCCESS
    }

    fn save(out: &Path, lap: &lapfile::Lap) {
        let stamp: String = lap.started_at.chars().filter(char::is_ascii_digit).take(14).collect();
        let name = format!(
            "{}_{}_lap{}_{}.xlap.gz",
            file_safe(&lap.track_name),
            file_safe(&lap.car_name),
            lap.lap_number,
            stamp
        );
        let (path, partial) = (out.join(&name), out.join(format!("{name}.part")));
        let result = lapfile::gzip(lap)
            .map_err(|e| e.to_string())
            .and_then(|bytes| std::fs::write(&partial, &bytes).map(|_| bytes.len()).map_err(|e| e.to_string()))
            .and_then(|size| std::fs::rename(&partial, &path).map(|_| size).map_err(|e| e.to_string()));
        match result {
            Ok(size) => println!(
                "Saved lap {} {} ({}) -> {name} ({} KB)",
                lap.lap_number,
                clock(lap.time_ms),
                if lap.valid { "valid" } else { "not valid" },
                size.div_ceil(1024)
            ),
            Err(error) => eprintln!("Could not save lap {}: {error}", lap.lap_number),
        }
    }

    pub fn record(out: &Path) -> ExitCode {
        if let Err(error) = std::fs::create_dir_all(out) {
            eprintln!("Cannot create {}: {error}", out.display());
            return ExitCode::from(1);
        }
        println!("Writing laps to {} (Ctrl+C to stop).", out.display());
        let mut waiting = false;
        loop {
            let mut reader = match LmuReader::open(&Names::lmu()) {
                Ok(reader) => reader,
                Err(OpenError::NotRunning) => {
                    if !waiting {
                        println!("Waiting for Le Mans Ultimate ('Enable external plugins' must be on)...");
                        waiting = true;
                    }
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                }
                Err(error) => {
                    eprintln!("{}", explain(&error));
                    return ExitCode::from(2);
                }
            };
            if !reader.layout_matches() {
                eprintln!("The game's shared memory is not the size this build knows ({} bytes, expected {}). Nothing is recorded; update the collector.", reader.mapped_bytes(), LAYOUT_SIZE);
                return ExitCode::from(2);
            }
            waiting = false;
            println!("Connected to Le Mans Ultimate at {}.", iso_utc(now_ms()));
            let mut recorder = Recorder::new();
            let mut silent_waits = 0;
            // Without a frame for 10 s (the game closed, or sits in a menu) start over from a clean connection.
            while silent_waits < 50 {
                if !reader.wait_frame(200) {
                    silent_waits += 1;
                    continue;
                }
                silent_waits = 0;
                let Some(snapshot) = reader.read() else { continue };
                if let Some(t) = &snapshot.telemetry {
                    recorder.on_telemetry(t, now_ms()).iter().for_each(|lap| save(out, lap));
                }
                if let Some(s) = &snapshot.scoring {
                    recorder.on_scoring(s).iter().for_each(|lap| save(out, lap));
                }
            }
            println!("No data from the game for 10 s; reconnecting.");
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match parse(&args) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("{message}\n\n{HELP}");
            return ExitCode::from(2);
        }
    };
    match command {
        Command::Help => {
            print!("{HELP}");
            ExitCode::SUCCESS
        }
        Command::Inspect { file } => inspect(&file),
        #[cfg(windows)]
        Command::Probe { seconds } => live::probe(seconds),
        #[cfg(windows)]
        Command::Record { out } => live::record(&out),
        #[cfg(not(windows))]
        Command::Probe { .. } | Command::Record { .. } => {
            eprintln!("Reading the game needs Windows. `inspect` works everywhere.");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_the_commands() {
        assert_eq!(parse(&args(&[])), Ok(Command::Help));
        assert_eq!(parse(&args(&["help"])), Ok(Command::Help));
        assert_eq!(parse(&args(&["probe"])), Ok(Command::Probe { seconds: 5 }));
        assert_eq!(parse(&args(&["probe", "--seconds", "30"])), Ok(Command::Probe { seconds: 30 }));
        assert_eq!(
            parse(&args(&["record", "--out", "laps"])),
            Ok(Command::Record { out: "laps".into() })
        );
        assert_eq!(
            parse(&args(&["inspect", "a.xlap.gz"])),
            Ok(Command::Inspect { file: "a.xlap.gz".into() })
        );
    }

    #[test]
    fn refuses_what_it_does_not_understand() {
        for bad in [
            &["probe", "--seconds"][..],
            &["probe", "--seconds", "0"],
            &["probe", "--seconds", "x"],
            &["probe", "--fast"],
            &["record"],
            &["record", "--out"],
            &["inspect"],
            &["inspect", "a", "b"],
            &["dance"],
        ] {
            assert!(parse(&args(bad)).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn writes_a_lap_time_like_a_clock() {
        assert_eq!(clock(207_250), "3:27.250");
        assert_eq!(clock(59_999), "0:59.999");
        assert_eq!(clock(3_600_000), "60:00.000");
    }
}
