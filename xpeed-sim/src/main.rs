//! xpeed-sim: reads racing-game telemetry on Windows and writes it as Xpeed lap files.
//!
//! * `probe`   checks that the game is sharing data and shows what it sends (nothing is written);
//! * `record`  writes every lap to a folder as a `.xlap.gz` file (and, with `--upload`, sends them to Xpeed);
//! * `inspect` shows what a lap file holds;
//! * `pair`, `unpair`, `status`, `upload` connect this computer to an Xpeed account and send the laps in a folder.
//!
//! The first game is Le Mans Ultimate. See `docs/telemetria-virtual-2026-11-10/LMU-TELEMETRIA.md`.

mod config;
mod lapfile;
mod lmu;
mod net;
mod outbox;
mod recorder;
#[cfg(test)]
mod stub;
#[cfg(test)]
mod upload_tests;
mod util;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

const HELP: &str = "\
xpeed-sim: racing-game telemetry to Xpeed lap files

USAGE:
    xpeed-sim probe [--seconds N]    Check the connection to Le Mans Ultimate and show what it sends (default 5 s)
    xpeed-sim record --out DIR       Write every lap to DIR as a .xlap.gz file (Ctrl+C to stop)
        --upload                           Also send each lap to Xpeed (pair first)
    xpeed-sim inspect FILE           Show what a lap file holds
    xpeed-sim pair --server URL --code CODE [--name NAME]
                                           Connect this computer to your Xpeed account (the code comes from the app)
    xpeed-sim status                 Show whether this computer is paired
    xpeed-sim unpair                 Forget the pairing on this computer
    xpeed-sim upload DIR             Send the laps in DIR that were not sent yet
    xpeed-sim help

For the game to share data, 'Enable external plugins' must be on (Settings > Gameplay) and the game must be running.
";

#[derive(Debug, PartialEq)]
enum Command {
    Probe {
        seconds: u64,
    },
    Record {
        out: PathBuf,
        upload: bool,
    },
    Inspect {
        file: PathBuf,
    },
    Pair {
        server: String,
        code: String,
        name: Option<String>,
    },
    Unpair,
    Status,
    Upload {
        dir: PathBuf,
    },
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
            let (mut out, mut upload) = (None, false);
            while let Some(flag) = rest.next() {
                match flag {
                    "--out" => out = Some(PathBuf::from(rest.next().ok_or("--out needs a folder")?)),
                    "--upload" => upload = true,
                    other => return Err(format!("unknown option {other:?}")),
                }
            }
            Ok(Command::Record {
                out: out.ok_or("record needs --out DIR")?,
                upload,
            })
        }
        Some("pair") => {
            let (mut server, mut code, mut name) = (None, None, None);
            while let Some(flag) = rest.next() {
                match flag {
                    "--server" => server = Some(rest.next().ok_or("--server needs an address")?.to_owned()),
                    "--code" => code = Some(rest.next().ok_or("--code needs the pairing code")?.to_owned()),
                    "--name" => name = Some(rest.next().ok_or("--name needs a name")?.to_owned()),
                    other => return Err(format!("unknown option {other:?}")),
                }
            }
            Ok(Command::Pair {
                server: server.ok_or("pair needs --server ADDRESS")?,
                code: code.ok_or("pair needs --code CODE")?,
                name,
            })
        }
        Some(word @ ("unpair" | "status")) => match rest.next() {
            None if word == "unpair" => Ok(Command::Unpair),
            None => Ok(Command::Status),
            Some(extra) => Err(format!("unexpected argument {extra:?}")),
        },
        Some("upload") => {
            let dir = rest.next().ok_or("upload needs a folder")?;
            match rest.next() {
                None => Ok(Command::Upload { dir: PathBuf::from(dir) }),
                Some(extra) => Err(format!("unexpected argument {extra:?}")),
            }
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

/// What this computer calls itself, for the person's list of devices in the app.
fn default_device_name() -> String {
    let raw = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    let name: String = raw.chars().filter(|c| !c.is_control()).take(60).collect();
    if name.trim().is_empty() {
        "Windows PC".into()
    } else {
        name.trim().to_owned()
    }
}

fn config_path() -> Result<PathBuf, String> {
    config::default_path().ok_or_else(|| "cannot tell where to keep the pairing; set XPEED_SIM_HOME to a folder".to_owned())
}

/// The pairing of this computer, or what to do about it not being there.
fn paired() -> Result<config::Config, String> {
    config::load(&config_path()?)?
        .ok_or_else(|| "this computer is not paired yet. Run: xpeed-sim pair --server ADDRESS --code CODE".to_owned())
}

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("{message}");
    ExitCode::from(1)
}

fn pair_command(server: &str, code: &str, name: Option<String>) -> ExitCode {
    let server = match config::normalize_server(server) {
        Ok(server) => server,
        Err(why) => return fail(why),
    };
    let code = match config::normalize_code(code) {
        Ok(code) => code,
        Err(why) => return fail(why),
    };
    let path = match config_path() {
        Ok(path) => path,
        Err(why) => return fail(why),
    };
    let device_name = name
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(default_device_name);
    println!("Pairing {device_name:?} with {server} ...");
    let token = match net::pair(&net::agent(), &server, &code, &device_name) {
        Ok(token) => token,
        Err(why) => return fail(why),
    };
    match config::save(
        &path,
        &config::Config {
            server: server.clone(),
            token,
            device_name,
        },
    ) {
        Ok(()) => {
            println!("Paired. The device key is kept in {}; it is never shown.", path.display());
            println!("Send laps with: xpeed-sim record --out DIR --upload   (or: xpeed-sim upload DIR)");
            ExitCode::SUCCESS
        }
        Err(why) => fail(format!(
            "{why}\nThe server accepted the code, which cannot be used again: ask for a new one after fixing this."
        )),
    }
}

fn status_command() -> ExitCode {
    match config_path().and_then(|path| config::load(&path).map(|found| (path, found))) {
        Ok((_, Some(config))) => {
            println!("Paired with {} as {:?}.", config.server, config.device_name);
            ExitCode::SUCCESS
        }
        Ok((path, None)) => {
            println!("Not paired (no {}).", path.display());
            ExitCode::from(1)
        }
        Err(why) => fail(why),
    }
}

fn unpair_command() -> ExitCode {
    match config_path().and_then(|path| config::remove(&path)) {
        Ok(true) => {
            println!("Forgot the pairing on this computer. To stop the server accepting this device, remove it in the app (Virtual > Xpeed Sim).");
            ExitCode::SUCCESS
        }
        Ok(false) => {
            println!("This computer was not paired.");
            ExitCode::SUCCESS
        }
        Err(why) => fail(why),
    }
}

fn upload_command(dir: &Path) -> ExitCode {
    let config = match paired() {
        Ok(config) => config,
        Err(why) => return fail(why),
    };
    if !dir.is_dir() {
        return fail(format!("{} is not a folder", dir.display()));
    }
    let report = outbox::upload_pending(dir, &config, &net::agent(), &mut |line| println!("{line}"));
    println!(
        "Sent {}, already on the server {}, not sendable {}, still waiting {}.",
        report.sent, report.duplicates, report.rejected, report.left
    );
    match report.stopped {
        None => ExitCode::SUCCESS,
        Some(outbox::Stop::Unauthorized) => fail("The server no longer accepts this computer's key. Run `xpeed-sim pair` again."),
        Some(outbox::Stop::Later { reason, .. }) => fail(format!("Stopped: {reason}. Run the command again later; nothing was lost.")),
    }
}

#[cfg(windows)]
mod live {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::lmu::layout::LAYOUT_SIZE;
    use crate::lmu::reader::{LmuReader, Names, OpenError};
    use crate::lmu::snapshot::PlayerTelemetry;
    use crate::outbox::{Backoff, Uploader};
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

    /// True when the lap is now a file in `out`.
    fn save(out: &Path, lap: &lapfile::Lap) -> bool {
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
            Ok(size) => {
                println!(
                    "Saved lap {} {} ({}) -> {name} ({} KB)",
                    lap.lap_number,
                    clock(lap.time_ms),
                    if lap.valid { "valid" } else { "not valid" },
                    size.div_ceil(1024)
                );
                true
            }
            Err(error) => {
                eprintln!("Could not save lap {}: {error}", lap.lap_number);
                false
            }
        }
    }

    pub fn record(out: &Path, upload: bool) -> ExitCode {
        // Checked first: asking to upload without a pairing is a mistake to hear about now, not after the first lap.
        let config = if upload {
            match paired() {
                Ok(config) => Some(config),
                Err(why) => return fail(why),
            }
        } else {
            None
        };
        if let Err(error) = std::fs::create_dir_all(out) {
            eprintln!("Cannot create {}: {error}", out.display());
            return ExitCode::from(1);
        }
        println!("Writing laps to {} (Ctrl+C to stop).", out.display());
        // A thread of its own: a slow network must never make the reading of the game miss a sample.
        let uploader = config.map(|config| {
            println!(
                "Sending laps to {} as {:?}; laps that cannot go now stay here and go later.",
                config.server, config.device_name
            );
            Uploader::start(out.to_path_buf(), config, Backoff::default())
        });
        let saved = |lap: &lapfile::Lap| {
            if save(out, lap) {
                if let Some(uploader) = &uploader {
                    uploader.wake();
                }
            }
        };
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
                eprintln!("The game's shared memory is not the size this build knows ({} bytes, expected {}). Nothing is recorded; update Xpeed Sim.", reader.mapped_bytes(), LAYOUT_SIZE);
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
                    recorder.on_telemetry(t, now_ms()).iter().for_each(saved);
                }
                if let Some(s) = &snapshot.scoring {
                    recorder.on_scoring(s).iter().for_each(saved);
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
        Command::Pair { server, code, name } => pair_command(&server, &code, name),
        Command::Status => status_command(),
        Command::Unpair => unpair_command(),
        Command::Upload { dir } => upload_command(&dir),
        #[cfg(windows)]
        Command::Probe { seconds } => live::probe(seconds),
        #[cfg(windows)]
        Command::Record { out, upload } => live::record(&out, upload),
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
            Ok(Command::Record {
                out: "laps".into(),
                upload: false
            })
        );
        assert_eq!(
            parse(&args(&["record", "--upload", "--out", "laps"])),
            Ok(Command::Record {
                out: "laps".into(),
                upload: true
            })
        );
        assert_eq!(
            parse(&args(&["pair", "--server", "https://x.example", "--code", "ABCD-2345"])),
            Ok(Command::Pair {
                server: "https://x.example".into(),
                code: "ABCD-2345".into(),
                name: None
            })
        );
        assert_eq!(
            parse(&args(&["pair", "--name", "RIG", "--code", "C", "--server", "S"])),
            Ok(Command::Pair {
                server: "S".into(),
                code: "C".into(),
                name: Some("RIG".into())
            })
        );
        assert_eq!(parse(&args(&["status"])), Ok(Command::Status));
        assert_eq!(parse(&args(&["unpair"])), Ok(Command::Unpair));
        assert_eq!(parse(&args(&["upload", "laps"])), Ok(Command::Upload { dir: "laps".into() }));
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
            &["pair"],
            &["pair", "--server", "https://x.example"],
            &["pair", "--code", "ABCD2345"],
            &["pair", "--server"],
            &["pair", "--token", "x"],
            &["status", "now"],
            &["unpair", "now"],
            &["upload"],
            &["upload", "a", "b"],
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
