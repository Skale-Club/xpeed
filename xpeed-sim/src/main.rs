#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]
//! Xpeed Companion: reads racing-game telemetry on Windows and sends it to your Xpeed account.
//!
//! Started with no arguments (from the Start menu, or with Windows) it runs as a tray icon: it records every lap
//! while Le Mans Ultimate runs and sends the laps to the account it is connected to. With arguments it is a command
//! line tool:
//!
//! * `run`     the tray app (what no arguments mean);
//! * `probe`   checks that the game is sharing data and shows what it sends (nothing is written);
//! * `record`  writes every lap to a folder as a `.xlap.gz` file (and, with `--upload`, sends them to Xpeed);
//! * `inspect` shows what a lap file holds;
//! * `track-dump` reads a track's layout from a game's own files and writes it as a `.xtrk` file;
//!   while recording, the layout of each Assetto Corsa or Stock Car Extreme track driven is also built by itself and sent
//!   with the laps (`tracks::auto`);
//! * `pair`, `unpair`, `status`, `upload` connect this computer to an Xpeed account and send the laps in a folder.
//!
//! The first game is Le Mans Ultimate. See `docs/telemetria-virtual-2026-11-10/LMU-TELEMETRIA.md`.

mod applog;
mod brands;
mod config;
mod connect;
mod covers;
mod dash;
#[cfg(windows)]
mod engine;
mod game;
#[cfg(windows)]
mod games;
mod icon;
mod installed;
mod lapcut;
mod lapfile;
mod link;
mod lmu;
mod maps;
mod net;
mod outbox;
#[cfg(windows)]
mod panel;
mod present;
#[cfg(test)]
mod rcgen;
mod recorder;
#[cfg(windows)]
mod shm;
mod status;
#[cfg(test)]
mod stub;
mod text;
mod tracks;
#[cfg(windows)]
mod tray;
#[cfg(test)]
mod upload_tests;
mod util;
#[cfg(windows)]
mod win;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::util::clock;

const HELP: &str = "\
Xpeed Companion: racing-game telemetry to your Xpeed account

With no arguments Xpeed Companion runs as a tray icon. Command line:

USAGE:
    xpeed-sim run                    The tray app (the same as no arguments)
    xpeed-sim panel                  Open the panel (dashboard and monitor) of the running tray app, or start it
    xpeed-sim panel-demo             Open the panel alone with made-up driving, to see it without a game
    xpeed-sim probe [--seconds N]    Check the connection to Le Mans Ultimate and show what it sends (default 5 s)
    xpeed-sim record --out DIR       Write every lap to DIR as a .xlap.gz file (Ctrl+C to stop)
        --upload                           Also send each lap to Xpeed (pair first)
    xpeed-sim inspect FILE           Show what a lap file holds
    xpeed-sim track-dump GAME TRACK OUT.xtrk [--preview FILE.svg]
                                     Read a track's layout (centre line, road width, ideal line, pit lane) from the
                                     game's own files and write it as a track file. GAME is ac or sce; TRACK is a
                                     folder or file of the game, or its name. Only reads the game's folders.
    xpeed-sim pair --server URL --code CODE [--name NAME]
                                           Connect this computer to your Xpeed account (the code comes from the app)
    xpeed-sim status                 Show whether this computer is paired
    xpeed-sim unpair                 Forget the pairing on this computer
    xpeed-sim upload DIR             Send the laps in DIR (and the track layouts in DIR\tracks) that were not sent yet
    xpeed-sim make-icon FILE         Write the Xpeed Companion icon to FILE (.ico)
    xpeed-sim help

For the game to share data, 'Enable external plugins' must be on (Settings > Gameplay) and the game must be running.
";

#[derive(Debug, PartialEq)]
enum Command {
    Run,
    Panel,
    PanelDemo,
    /// `xpeedsim://pair?...`, opened by Windows when the Xpeed site asks to connect this computer.
    Link {
        url: String,
    },
    MakeIcon {
        file: PathBuf,
    },
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
    TrackDump(tracks::dump::Request),
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
        None | Some("run") => match rest.next() {
            None => Ok(Command::Run),
            Some(extra) => Err(format!("unexpected argument {extra:?}")),
        },
        Some("help" | "--help" | "-h") => Ok(Command::Help),
        Some(word @ ("panel" | "panel-demo")) => match rest.next() {
            None if word == "panel" => Ok(Command::Panel),
            None => Ok(Command::PanelDemo),
            Some(extra) => Err(format!("unexpected argument {extra:?}")),
        },
        Some("link") => {
            let url = rest.next().ok_or("link needs an address")?;
            match rest.next() {
                None => Ok(Command::Link { url: url.to_owned() }),
                Some(extra) => Err(format!("unexpected argument {extra:?}")),
            }
        }
        Some("make-icon") => {
            let file = rest.next().ok_or("make-icon needs a file name")?;
            match rest.next() {
                None => Ok(Command::MakeIcon { file: PathBuf::from(file) }),
                Some(extra) => Err(format!("unexpected argument {extra:?}")),
            }
        }
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
        Some("track-dump") => {
            let game = rest.next().ok_or("track-dump needs a game (ac or sce)")?;
            let source = rest.next().ok_or("track-dump needs a track (a folder, a file or a name)")?;
            let out = rest.next().ok_or("track-dump needs the file to write (OUT.xtrk)")?;
            let mut preview = None;
            while let Some(flag) = rest.next() {
                match flag {
                    "--preview" => preview = Some(PathBuf::from(rest.next().ok_or("--preview needs a file name")?)),
                    other => return Err(format!("unknown option {other:?}")),
                }
            }
            Ok(Command::TrackDump(tracks::dump::Request {
                game: game.to_owned(),
                source: source.to_owned(),
                out: PathBuf::from(out),
                preview,
            }))
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
        .unwrap_or_else(config::device_name);
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
            account: None,
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
            println!("Forgot the pairing on this computer. To stop the server accepting this device, remove it in the app (Virtual > Xpeed Companion).");
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
    let agent = net::agent();
    let mut report = outbox::upload_pending(dir, &config, &agent, &mut |line| println!("{line}"));
    println!(
        "Sent {}, already on the server {}, not sendable {}, still waiting {}.",
        report.sent, report.duplicates, report.rejected, report.left
    );
    // Then the track layouts Xpeed Companion built while recording (the `tracks` folder inside the laps folder).
    let layouts_dir = dir.join(tracks::auto::TRACKS_DIR);
    if report.stopped.is_none() && layouts_dir.is_dir() {
        let layouts = outbox::upload_tracks(&layouts_dir, &config, &agent, &mut |line| println!("{line}"));
        println!(
            "Track layouts: sent {}, not sendable {}, still waiting {}.",
            layouts.sent + layouts.duplicates,
            layouts.rejected,
            layouts.left
        );
        report.stopped = layouts.stopped;
    }
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
    use crate::engine::explain;
    use crate::lmu::layout::LAYOUT_SIZE;
    use crate::lmu::reader::{LmuReader, Names};
    use crate::lmu::snapshot::PlayerTelemetry;
    use crate::outbox::{Backoff, Observer, Uploader};
    use crate::status::Shared;

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
        println!("Writing laps to {} (Ctrl+C to stop).", out.display());
        let shared = Shared::new(config.is_some());
        // A thread of its own: a slow network must never make the reading of the game miss a sample.
        if let Some(config) = config {
            println!(
                "Sending laps to {} as {:?}; laps that cannot go now stay here and go later.",
                config.server, config.device_name
            );
            shared.set_uploader(Some(Uploader::start(
                out.to_path_buf(),
                config,
                Backoff::default(),
                Observer::console(),
            )));
        }
        match engine::run(out, &shared, &|line| println!("{line}"), true) {
            Ok(()) => ExitCode::SUCCESS,
            Err(why) => {
                eprintln!("{why}");
                ExitCode::from(2)
            }
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
    // The program has no console of its own; a command typed in a terminal borrows that terminal's.
    #[cfg(windows)]
    if !matches!(command, Command::Run | Command::Panel | Command::PanelDemo | Command::Link { .. }) {
        win::attach_terminal();
    }
    match command {
        #[cfg(windows)]
        Command::Run => tray::run(false),
        #[cfg(windows)]
        Command::Panel => {
            if tray::open_panel_of_running() {
                ExitCode::SUCCESS
            } else {
                tray::run(true)
            }
        }
        #[cfg(windows)]
        Command::PanelDemo => panel::demo(config::home_dir().map_or(text::Lang::En, |home| config::load_lang(&home))),
        #[cfg(windows)]
        Command::Link { url } => tray::pair_from_link(&url),
        #[cfg(not(windows))]
        Command::Run | Command::Panel | Command::PanelDemo | Command::Link { .. } => {
            eprintln!("The tray app needs Windows. `inspect` works everywhere.");
            ExitCode::from(2)
        }
        Command::MakeIcon { file } => match std::fs::write(&file, icon::ico_file(&[16, 24, 32, 48, 64, 256], None)) {
            Ok(()) => {
                println!("Wrote {}", file.display());
                ExitCode::SUCCESS
            }
            Err(error) => fail(format!("Cannot write {}: {error}", file.display())),
        },
        Command::Help => {
            print!("{HELP}");
            ExitCode::SUCCESS
        }
        Command::Inspect { file } => inspect(&file),
        Command::TrackDump(request) => tracks::dump::run(&request),
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
        assert_eq!(parse(&args(&[])), Ok(Command::Run));
        assert_eq!(parse(&args(&["run"])), Ok(Command::Run));
        assert_eq!(parse(&args(&["panel"])), Ok(Command::Panel));
        assert_eq!(parse(&args(&["panel-demo"])), Ok(Command::PanelDemo));
        assert!(parse(&args(&["panel", "x"])).is_err());
        assert_eq!(
            parse(&args(&["link", "xpeedsim://pair?x=1"])),
            Ok(Command::Link {
                url: "xpeedsim://pair?x=1".into()
            })
        );
        assert_eq!(
            parse(&args(&["make-icon", "a.ico"])),
            Ok(Command::MakeIcon { file: "a.ico".into() })
        );
        assert_eq!(parse(&args(&["--help"])), Ok(Command::Help));
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
        assert_eq!(
            parse(&args(&["track-dump", "ac", "monza", "m.xtrk"])),
            Ok(Command::TrackDump(tracks::dump::Request {
                game: "ac".into(),
                source: "monza".into(),
                out: "m.xtrk".into(),
                preview: None
            }))
        );
        assert_eq!(
            parse(&args(&["track-dump", "sce", "a.AIW", "a.xtrk", "--preview", "a.svg"])),
            Ok(Command::TrackDump(tracks::dump::Request {
                game: "sce".into(),
                source: "a.AIW".into(),
                out: "a.xtrk".into(),
                preview: Some("a.svg".into())
            }))
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
            &["track-dump"],
            &["track-dump", "ac"],
            &["track-dump", "ac", "monza"],
            &["track-dump", "ac", "monza", "m.xtrk", "--preview"],
            &["track-dump", "ac", "monza", "m.xtrk", "--fast"],
            &["pair"],
            &["pair", "--server", "https://x.example"],
            &["pair", "--code", "ABCD2345"],
            &["pair", "--server"],
            &["pair", "--token", "x"],
            &["status", "now"],
            &["unpair", "now"],
            &["upload"],
            &["upload", "a", "b"],
            &["run", "now"],
            &["link"],
            &["link", "a", "b"],
            &["make-icon"],
            &["dance"],
        ] {
            assert!(parse(&args(bad)).is_err(), "{bad:?} should be refused");
        }
    }
}
