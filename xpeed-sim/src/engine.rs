//! The loops that read the games and write each lap to a folder. They are what both `record` (in a terminal) and the
//! tray app run; the difference is only who listens to what it says (`say`) and to the shared status. Le Mans Ultimate
//! has a loop of its own (its door is a memory mapping with two streams, `lmu/source.rs`), but its frames go through the
//! same cutter and panel tracker as every other game's.

use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::dash::Tracker;
use crate::game::{Frame, Source};
use crate::games::{Reader, READERS};
use crate::lapcut::LapCutter;
use crate::lapfile;
use crate::lmu::layout::LAYOUT_SIZE;
use crate::lmu::reader::{LmuReader, Names, OpenError};
use crate::lmu::source::LmuSource;
use crate::persistence::{with_saver, Saver as AsyncSaver};
use crate::session::EndReason;
use crate::status::{Game, SavedLap, Shared};
use crate::supervisor::{self, supervise, Ended, Policy};
use crate::tracks::auto::{self, Folders, Request};
use crate::util::{clock, file_safe, iso_utc, now_ms};
use crate::watch::{detect, quiet_state, Watch};

const LMU_ID: &str = "lmu";
const LMU_NAME: &str = "Le Mans Ultimate";
/// The game's program (lower case), to tell "open, not sharing" from "not running" when its memory is missing.
pub const LMU_PROGRAMS: &[&str] = &["le mans ultimate.exe"];

/// How long a game whose program runs without sharing data is "loading" (splash screens, menus coming up) before it is
/// called "open, no data": some games create their shared memory only once loaded.
const LOADING_GRACE: Duration = Duration::from_secs(45);

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

/// The name a lap goes under in `out`: its own, or (when a file of that name is already there: another lap that began in the
/// same minute, or the same lap written before) the name with `_2`, `_3`... before the extension, so a lap never replaces one.
fn free_name(out: &Path, name: &str) -> String {
    let available = |name: &str| !out.join(name).exists() && !out.join(format!("{name}.part")).exists();
    if available(name) {
        return name.to_owned();
    }
    let stem = name.strip_suffix(".xlap.gz").unwrap_or(name);
    (2u64..)
        .map(|n| format!("{stem}_{n}.xlap.gz"))
        .find(|candidate| available(candidate))
        .expect("a free lap filename")
}

/// One try at writing the lap: next to its final name as `.part`, then renamed, so a half-written file never looks like a
/// lap. `Ok` is the lap as the panel lists it; `Err` is what went wrong. The log gets the lines of a lap written, none for a failure
/// (the caller decides what a failure is worth).
pub fn save_once(out: &Path, lap: &lapfile::Lap, say: &dyn Fn(String)) -> Result<SavedLap, String> {
    // Reader families have separate writers, but may produce the same track/car/time filename.
    // Serialize name selection and publication within this process so neither lap replaces the other.
    static PUBLISH: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _publish = crate::util::lock(&PUBLISH);
    // The folder may have been deleted while the program ran: make it again.
    let _ = std::fs::create_dir_all(out);
    let name = free_name(out, &lap_file_name(lap));
    let (path, partial) = (out.join(&name), out.join(format!("{name}.part")));
    // Stamped with this program and reader, and checked: what the checks find goes into the file's header (the server
    // sees it per lap) and into the log. It never stops the lap from being saved.
    let (stamped, findings) = crate::sanity::prepare(lap);
    let bytes = lapfile::gzip(&stamped).map_err(|e| e.to_string())?;
    publish_bytes(&partial, &path, &bytes, std::fs::rename).map_err(|e| e.to_string())?;
    let size = bytes.len();
    say(format!(
        "Saved lap {} {} ({}) -> {name} ({} KB)",
        lap.lap_number,
        clock(lap.time_ms),
        if lap.valid { "valid" } else { "not valid" },
        size.div_ceil(1024)
    ));
    for finding in &findings {
        say(format!("Data check {} (lap {}): {}", finding.id, lap.lap_number, finding.detail));
    }
    let speed = lap.channels.iter().find(|channel| channel.id == "speed");
    Ok(SavedLap {
        number: lap.lap_number,
        time_ms: lap.time_ms,
        valid: lap.valid,
        sectors_ms: lap.sectors_ms.clone().unwrap_or_default(),
        game: lap.game.clone(),
        track: lap.track_name.clone(),
        car: lap.car_name.clone(),
        speed_kmh: speed.map_or_else(Vec::new, |channel| crate::status::speed_profile(&channel.values)),
    })
}

/// Own a fresh partial exclusively and remove only our partial on write/publication failure.
fn publish_bytes<'a>(
    partial: &'a Path,
    path: &'a Path,
    bytes: &[u8],
    rename: impl FnOnce(&'a Path, &'a Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(partial)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    let result = written.and_then(|()| rename(partial, path));
    if result.is_err() {
        let _ = std::fs::remove_file(partial);
    }
    result
}

/// `save_once`, and a line in the log when it fails. Returns the lap when it worked.
#[cfg(test)]
pub fn save(out: &Path, lap: &lapfile::Lap, say: &dyn Fn(String)) -> Option<SavedLap> {
    match save_once(out, lap, say) {
        Ok(saved) => Some(saved),
        Err(error) => {
            say(format!("Could not save lap {}: {error}", lap.lap_number));
            None
        }
    }
}

/// Synchronous regression helper; live readers use the bounded asynchronous writer.
#[cfg(test)]
const HELD_MAX: usize = 5;
/// How often the laps held are tried again while the folder keeps refusing them.
#[cfg(test)]
const HELD_RETRY_EVERY: Duration = Duration::from_secs(20);

/// A reason as the person reads it in a balloon: one line, not long.
#[cfg(test)]
fn short_reason(reason: &str) -> String {
    reason.lines().next().unwrap_or("").trim().chars().take(80).collect()
}

/// Where the laps of one worker go. A lap is tried a few times with short waits; one the folder still refuses (disk full, no
/// permission) is kept in memory and retried. This synchronous helper is only used by regression tests;
/// live readers always use `persistence::Saver`, whose entire queue is bounded.
#[cfg(test)]
pub struct Saver<'a> {
    out: &'a Path,
    shared: &'a Shared,
    say: &'a (dyn Fn(String) + Sync),
    delays: &'a [Duration],
    held: std::sync::Mutex<std::collections::VecDeque<lapfile::Lap>>,
    /// Whether anything is held, to look without taking the lock on every frame.
    any_held: std::sync::atomic::AtomicBool,
    last_retry: std::sync::Mutex<Instant>,
}

#[cfg(test)]
impl<'a> Saver<'a> {
    pub fn with_delays(out: &'a Path, shared: &'a Shared, say: &'a (dyn Fn(String) + Sync), delays: &'a [Duration]) -> Saver<'a> {
        Saver {
            out,
            shared,
            say,
            delays,
            held: std::sync::Mutex::new(std::collections::VecDeque::new()),
            any_held: std::sync::atomic::AtomicBool::new(false),
            last_retry: std::sync::Mutex::new(Instant::now()),
        }
    }

    /// How many laps wait for another try.
    #[cfg(test)]
    pub fn held(&self) -> usize {
        crate::util::lock(&self.held).len()
    }

    fn written(&self, lap: &lapfile::Lap, saved: SavedLap, late: bool) {
        let build = lap.recorder.as_ref().and_then(|r| r.game_build.as_deref());
        self.shared.update(|s| {
            s.laps_saved += 1;
            s.last_lap = Some(saved.clone());
        });
        self.shared.note_lap_saved(&lap.game, build, late);
        self.shared.notify(crate::status::Notice::LapSaved(saved));
        self.shared.wake_uploader();
    }

    /// One lap with its tries and their waits.
    fn try_hard(&self, lap: &lapfile::Lap) -> Result<SavedLap, String> {
        let mut last = String::new();
        for (index, wait) in std::iter::once(&Duration::ZERO).chain(self.delays).enumerate() {
            if index > 0 {
                std::thread::sleep(*wait);
            }
            match save_once(self.out, lap, self.say) {
                Ok(saved) => return Ok(saved),
                Err(error) => last = error,
            }
        }
        Err(last)
    }

    /// A lap just cut: written, or held for another try.
    pub fn lap(&self, lap: &lapfile::Lap) {
        self.retry_held(true);
        match self.try_hard(lap) {
            Ok(saved) => {
                self.written(lap, saved, false);
                self.shared.note_saving_works();
            }
            Err(error) => self.hold(lap, &error),
        }
    }

    fn hold(&self, lap: &lapfile::Lap, error: &str) {
        (self.say)(format!("Could not save lap {}: {error}. Keeping it to try again.", lap.lap_number));
        {
            let mut held = crate::util::lock(&self.held);
            held.push_back(lap.clone());
            self.any_held.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        self.shared.note_lap_unsaved(&short_reason(error));
    }

    /// Tries the laps held once each, oldest first, and stops at the first the folder still refuses. Without `force` it does
    /// so only every `HELD_RETRY_EVERY` (the loops call it all the time).
    pub fn retry_held(&self, force: bool) {
        if !self.any_held.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        {
            let mut last = crate::util::lock(&self.last_retry);
            if !force && last.elapsed() < HELD_RETRY_EVERY {
                return;
            }
            *last = Instant::now();
        }
        loop {
            let Some(lap) = crate::util::lock(&self.held).front().cloned() else {
                self.any_held.store(false, std::sync::atomic::Ordering::SeqCst);
                return;
            };
            match save_once(self.out, &lap, self.say) {
                Ok(saved) => {
                    crate::util::lock(&self.held).pop_front();
                    self.written(&lap, saved, true);
                    self.shared.note_saving_works();
                }
                Err(_) => return,
            }
        }
    }

    /// The worker is ending: one last go at what is held, with the waits, and a word in the log for what is lost.
    pub fn finish(&self) {
        for lap in std::mem::take(&mut *crate::util::lock(&self.held)) {
            match self.try_hard(&lap) {
                Ok(saved) => self.written(&lap, saved, true),
                Err(error) => (self.say)(format!("Lap {} could not be saved and is lost: {error}", lap.lap_number)),
            }
        }
        self.any_held.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The game whose laps the panel's recent list holds. A frame of another game starts the list over.
static LAST_DRIVEN: std::sync::Mutex<Option<&'static str>> = std::sync::Mutex::new(None);

fn note_game_driven(shared: &Shared, game: &'static str) {
    let mut last = LAST_DRIVEN.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if *last != Some(game) {
        if last.is_some() {
            shared.clear_recent_laps();
        }
        *last = Some(game);
    }
}

/// One frame of a game, through the panel's tracker and the lap cutter; the laps it finishes are written. When a session
/// ends on another track or with another car, the panel's list of recent laps starts over.
fn handle_frame(
    frame: &Frame,
    source: &dyn Source,
    cutter: &mut LapCutter,
    tracker: &mut Tracker,
    shared: &Shared,
    saved: &dyn Fn(&lapfile::Lap),
    tracks: Option<&mpsc::Sender<Request>>,
) {
    tracker.set_caps(source.caps());
    let game = source.game_id();
    tracker.layout.observe(tracks, game, frame, Instant::now());
    let at_ms = now_ms();
    shared.offer_live(tracker.on_game_frame(game, source.game_name(), frame, at_ms));
    for mut lap in cutter.on_frame(frame, at_ms) {
        source.finish_lap(&mut lap);
        saved(&lap);
    }
    for why in cutter.take_drops() {
        shared.note_lap_dropped(why);
    }
    if cutter
        .take_session_ends()
        .iter()
        .any(|reason| matches!(reason, EndReason::CarChanged | EndReason::TrackChanged))
    {
        shared.clear_recent_laps();
    }
}

#[cfg(test)]
pub(crate) fn assert_live_source_frame(source: &dyn Source, frame: &Frame, identity: (&str, &str), right_x: Option<f32>) {
    let shared = Shared::new(false);
    let mut cutter = LapCutter::new(source.game_id());
    let mut tracker = Tracker::default();
    handle_frame(frame, source, &mut cutter, &mut tracker, &shared, &|_| {}, None);
    let live = shared.live().unwrap();
    assert_eq!((live.game_id, live.game), identity);
    assert_eq!((&live.track, &live.track_variant), (&frame.track, &frame.track_variant));
    let position = (frame.x.is_finite() && frame.z.is_finite()).then_some((frame.x, frame.z));
    assert_eq!(live.pos, position);

    if let Some(right_x) = right_x {
        use crate::perspective::Camera;
        let car = live.pos.unwrap();
        let camera = Camera {
            width: 736.0,
            height: 400.0,
            car,
            heading: (0.0, 1.0),
            mirrored: live.mirrored_ground(),
        };
        let [left, right] = [-right_x, right_x].map(|offset| {
            camera
                .segment((car.0 + offset, car.1 + 40.0), (car.0 + offset, car.1 + 50.0))
                .unwrap()
                .1
        });
        assert!(
            left.0 < camera.anchor().0 && right.0 > camera.anchor().0,
            "{identity:?}: left {left:?}, right {right:?}"
        );
    }
}

/// A game closed or its source died: the lap that still waited for its official time is written as it stands.
fn flush(cutter: LapCutter, source: &dyn Source, shared: &Shared, saved: &dyn Fn(&lapfile::Lap)) {
    let (laps, dropped) = cutter.finish_counted(now_ms());
    for why in dropped {
        shared.note_lap_dropped(why);
    }
    for mut lap in laps {
        source.finish_lap(&mut lap);
        saved(&lap);
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
        // The other games: each family of readers has a thread of its own, looked after on its own (a family that panics or
        // is given up on never touches another); Le Mans Ultimate has its own loop here.
        scope.spawn(move || run_readers(READERS, out, shared, say, Some(&tracks), LOADING_GRACE, &Policy::default()));
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
    watched_as(shared, id, supervisor::title(id), &Policy::default(), say, body)
}

/// `watched` under the name and the policy given.
fn watched_as(shared: &Shared, id: &'static str, name: &str, policy: &Policy, say: &(dyn Fn(String) + Sync), body: impl FnMut()) -> Ended {
    supervise(
        name,
        policy,
        &|| shared.quitting(),
        &|line| say(line),
        &|health| shared.set_worker(id, health),
        body,
    )
}

/// The running programs, listed at most once a second however many threads ask (each family of readers looks every couple of
/// seconds, and the list of processes is not free).
fn running_now() -> Vec<String> {
    static CACHE: std::sync::Mutex<Option<(Instant, Vec<String>)>> = std::sync::Mutex::new(None);
    let mut cache = crate::util::lock(&CACHE);
    if let Some((at, list)) = cache.as_ref() {
        if at.elapsed() < Duration::from_secs(1) {
            return list.clone();
        }
    }
    let list = crate::win::running_programs();
    *cache = Some((Instant::now(), list.clone()));
    list
}

/// Reads the other games, one thread for each family of readers, each under the supervisor on its own: a panic in one
/// family (a reader fed bytes it did not expect) restarts that family only, after a wait that grows; a family that keeps
/// failing is given up on and shown as failed while every other family goes on; and a reader that blocks holds up nobody
/// else. A family's laps still waiting to be written when it restarts are kept (`Saver`).
pub fn run_readers(
    readers: &[Reader],
    out: &Path,
    shared: &Shared,
    say: &(dyn Fn(String) + Sync),
    tracks: Option<&mpsc::Sender<Request>>,
    grace: Duration,
    policy: &Policy,
) {
    std::thread::scope(|scope| {
        for reader in readers {
            scope.spawn(move || {
                with_saver(out, shared, say, |saver| {
                    let name = format!("{} reader", reader.family);
                    let ended = watched_as(shared, reader.family, &name, policy, say, || {
                        games_loop(std::slice::from_ref(reader), saver, shared, say, tracks, grace)
                    });
                    if ended == Ended::GaveUp {
                        // Its games are no longer read: the panel must not go on showing them as connected.
                        for (id, name, game) in shared.games() {
                            if reader.ids.contains(&id) && game != Game::Waiting {
                                shared.set_game(id, name, Game::Waiting);
                            }
                        }
                    }
                });
            });
        }
    });
}

/// Reads whichever of `readers` is running (all in this thread), and writes its laps like Le Mans Ultimate's.
/// A game that runs without data is shown as loading for `grace`, then as open without data.
#[cfg(test)]
pub fn run_games(
    readers: &[Reader],
    out: &Path,
    shared: &Shared,
    say: &(dyn Fn(String) + Sync),
    tracks: Option<&mpsc::Sender<Request>>,
    grace: Duration,
) {
    with_saver(out, shared, say, |saver| games_loop(readers, saver, shared, say, tracks, grace));
}

fn games_loop(
    readers: &[Reader],
    saver: &AsyncSaver,
    shared: &Shared,
    say: &(dyn Fn(String) + Sync),
    tracks: Option<&mpsc::Sender<Request>>,
    grace: Duration,
) {
    struct Live {
        family: &'static str,
        programs: &'static [&'static str],
        source: Box<dyn Source>,
        cutter: LapCutter,
        last_frame: Instant,
        lap_shown: i32,
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
    let saved = |lap: &lapfile::Lap| saver.lap(lap);
    // A loop that starts again after a panic finds its games still shown as they were: they are not known to be there.
    for (id, name, game) in shared.games() {
        if readers.iter().any(|r| r.ids.contains(&id)) && game != Game::Waiting {
            shared.set_game(id, name, Game::Waiting);
        }
    }
    let mut live: Vec<Live> = Vec::new();
    // Families let go while their game still ran: opened again without a word.
    let mut reopen_quietly: Vec<&'static str> = Vec::new();
    // When each game's program was first seen running without data (cleared when it stops running or shares).
    let mut watch = Watch::default();
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
            let running = running_now();
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
            let (kept, closed): (Vec<Live>, Vec<Live>) = live
                .drain(..)
                .partition(|l| l.programs.is_empty() || crate::win::any_running(&running, l.programs));
            live = kept;
            for l in closed {
                flush(l.cutter, &*l.source, shared, &saved);
            }
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
                        watch.forget(id);
                    }
                    continue;
                }
                let opened = (reader.open)();
                // Not running, sharing, or running without data (`watch.rs`). In the last case the panel names the game
                // and tells how to switch it on, and the tray says it once.
                match detect(reader, &running, opened.is_some(), &mut watch, Instant::now(), grace) {
                    Some((id, name, state)) if state != Game::Connected => {
                        let told = shared.games().iter().any(|(i, _, g)| *i == id && *g == Game::Silent);
                        if state == Game::Silent && !told {
                            say(format!("{name} is open but shares no data yet."));
                        }
                        shared.set_game(id, name, state);
                    }
                    _ => {}
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
                        let state = quiet_state(opened_at, Instant::now(), grace);
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
                        tracker: Tracker::default(),
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
            let frame = l.source.next(slice);
            if frame.is_none() && l.tracker.layout.poll(tracks, Instant::now()) {
                if let Some((key, layout)) = l.tracker.layout.current() {
                    shared.refresh_live_layout(key, layout);
                }
            }
            if let Some(frame) = frame {
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
                    flush(std::mem::replace(&mut l.cutter, LapCutter::new(game)), &*l.source, shared, &saved);
                    l.tracker = Tracker::default();
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
                note_game_driven(shared, l.source.game_id());
                handle_frame(&frame, &*l.source, &mut l.cutter, &mut l.tracker, shared, &saved, tracks);
            } else if !l.heard {
                // Open, nothing heard yet: loading for the grace period, then "no data" for as long as its program runs
                // (and after a pause).
                if let Some((id, name)) = l.silent_as {
                    let state = quiet_state(l.opened_at, Instant::now(), grace);
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
        let running = running_now();
        let mut kept = Vec::new();
        for l in live.drain(..) {
            if l.source.alive() {
                kept.push(l);
                continue;
            }
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
            // What still waited for its official time is written as it stands.
            flush(l.cutter, &*l.source, shared, &saved);
        }
        live = kept;
    }
    // Told to quit: the same for every game still open.
    for l in live {
        flush(l.cutter, &*l.source, shared, &saved);
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

/// What a memory named `LMU_Data` that cannot be read means, given whether the game's program runs.
#[derive(Debug, PartialEq, Eq)]
enum Unreadable {
    /// The program is not running, so the memory is not the game's (another program made one under its name, or still
    /// holds a closed game's open). It is waited out as if there were no memory: never "this version cannot be read".
    NotTheGame,
    /// The program runs and its memory is not complete yet (it is being made, or taken down: the events are missing). It is
    /// waited for like a game that is loading.
    Incomplete,
    /// The program runs and its memory is not the size this build knows: another version of the game.
    OtherVersion,
}

/// `wrong_size`: the memory is smaller than, or not the size of, the layout this build knows.
fn lmu_unreadable(program_running: bool, wrong_size: bool) -> Unreadable {
    match (program_running, wrong_size) {
        (false, _) => Unreadable::NotTheGame,
        (true, false) => Unreadable::Incomplete,
        (true, true) => Unreadable::OtherVersion,
    }
}

/// Handles a memory `LMU_Data` the reader cannot use (`why`, for the log; each line is logged once until it changes).
/// Ends the loop with the reason only for `stop_on_unsupported` and the running game being another version.
fn on_unreadable(
    shared: &Shared,
    say: &(dyn Fn(String) + Sync),
    watch: &mut Watch,
    said: &mut Option<String>,
    why: String,
    wrong_size: bool,
    stop_on_unsupported: bool,
) -> Result<(), String> {
    let running = crate::win::any_running(&crate::win::running_programs(), LMU_PROGRAMS);
    let verdict = lmu_unreadable(running, wrong_size);
    let line = match verdict {
        Unreadable::NotTheGame => format!("{why} Le Mans Ultimate is not running, so this memory is not the game's: still waiting."),
        _ => why.clone(),
    };
    if said.as_deref() != Some(line.as_str()) {
        say(line.clone());
        *said = Some(line);
    }
    match verdict {
        Unreadable::OtherVersion => {
            if stop_on_unsupported {
                return Err(why);
            }
            watch.forget(LMU_ID);
            shared.set_game(LMU_ID, LMU_NAME, Game::Unsupported);
            rest(shared, Duration::from_secs(30));
        }
        Unreadable::NotTheGame | Unreadable::Incomplete => {
            let state = watch.without_data(LMU_ID, running, Instant::now(), LOADING_GRACE);
            shared.set_game(LMU_ID, LMU_NAME, state);
            rest(shared, Duration::from_secs(2));
        }
    }
    Ok(())
}

fn run_lmu(out: &Path, shared: &Shared, say: &(dyn Fn(String) + Sync), stop_on_unsupported: bool) -> Result<(), String> {
    with_saver(out, shared, say, |saver| run_lmu_loop(out, shared, say, stop_on_unsupported, saver))
}

fn run_lmu_loop(
    out: &Path,
    shared: &Shared,
    say: &(dyn Fn(String) + Sync),
    stop_on_unsupported: bool,
    saver: &AsyncSaver,
) -> Result<(), String> {
    std::fs::create_dir_all(out).map_err(|e| format!("Cannot create {}: {e}", out.display()))?;
    say(format!("Writing laps to {}.", out.display()));
    let saved = |lap: &lapfile::Lap| saver.lap(lap);
    let mut waiting = false;
    let mut told_silent = false;
    // When the game's program was first seen running without its memory.
    let mut watch = Watch::default();
    // The last line logged about a memory that could not be read (so a memory that stays unreadable is logged once).
    let mut said: Option<String> = None;
    while !shared.quitting() {
        if shared.paused() {
            shared.set_game(LMU_ID, LMU_NAME, Game::Paused);
            rest(shared, Duration::from_millis(500));
            continue;
        }
        let reader = match LmuReader::open(&Names::lmu()) {
            Ok(reader) => reader,
            Err(OpenError::NotRunning) => {
                if !waiting {
                    say("Waiting for Le Mans Ultimate ('Enable external plugins' must be on)...".into());
                    waiting = true;
                }
                said = None;
                // No memory. With the game's program running, it is open and not sharing: the panel says how to switch
                // that on. Without it, the game is simply not there.
                let running = crate::win::any_running(&crate::win::running_programs(), LMU_PROGRAMS);
                let state = watch.without_data(LMU_ID, running, Instant::now(), LOADING_GRACE);
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
                // Only a memory of the wrong size says "another version"; missing events say it is not complete.
                let wrong_size = matches!(error, OpenError::TooSmall { .. });
                on_unreadable(shared, say, &mut watch, &mut said, explain(&error), wrong_size, stop_on_unsupported)?;
                continue;
            }
        };
        if !reader.layout_matches() {
            let why = format!(
                "The game's shared memory is not the size this build knows ({} bytes, expected {}). Nothing is recorded; update Xpeed Companion.",
                reader.mapped_bytes(),
                LAYOUT_SIZE
            );
            // Let the memory go before waiting: holding it open would keep a closed game's memory alive.
            drop(reader);
            on_unreadable(shared, say, &mut watch, &mut said, why, true, stop_on_unsupported)?;
            continue;
        }
        waiting = false;
        told_silent = false;
        said = None;
        watch.forget(LMU_ID);
        say(format!("Connected to Le Mans Ultimate at {}.", iso_utc(now_ms())));
        shared.set_game(LMU_ID, LMU_NAME, Game::Connected);
        let mut source = LmuSource::new(reader);
        let mut cutter = LapCutter::new(LMU_ID);
        // The panel reads the same frames as the cutter.
        let mut tracker = Tracker::default();
        let mut silent_waits = 0;
        let mut lap_shown = 0;
        let mut gone = false;
        // Without a frame for 10 s the game is either closed or sitting in a menu. The process list is looked at once
        // per quiet period (never every 200 ms). A game that still runs stays connected on the same reader, quietly:
        // Waiting is only for a game whose program closed, which starts over from a clean connection.
        while !shared.quitting() && !shared.paused() {
            let frame = source.next(Duration::from_millis(200));
            if source.timed_out() {
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
            // A reading that makes no frame (scoring alone) only updates what the next frame will carry.
            let Some(frame) = frame else { continue };
            if frame.driving && frame.lap > 0 && frame.lap != lap_shown {
                lap_shown = frame.lap;
                shared.set_game(LMU_ID, LMU_NAME, Game::Recording(lap_shown as u32));
            }
            note_game_driven(shared, LMU_ID);
            handle_frame(&frame, &source, &mut cutter, &mut tracker, shared, &saved, None);
        }
        // The reader is let go (paused, told to quit, or the game is gone): a lap that still waited for its official
        // time is written as it stands.
        flush(cutter, &source, shared, &saved);
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
    use crate::text::Lang;

    #[test]
    fn lmu_quiet_period_keeps_reading_while_the_game_runs() {
        assert_eq!(lmu_quiet_action(true), QuietAction::KeepReading);
        assert_eq!(lmu_quiet_action(false), QuietAction::Reconnect);
        // 50 waits of 200 ms are the 10 s quiet period.
        assert_eq!(LMU_QUIET_WAITS * 200, 10_000);
    }

    #[test]
    fn an_unreadable_lmu_memory_without_the_game_running_is_never_another_version() {
        // Seen on the owner's PC: a memory named LMU_Data, without its events, came and went with the game closed, and the
        // panel said "Le Mans Ultimate is open / this version cannot be read yet".
        assert_eq!(lmu_unreadable(false, false), Unreadable::NotTheGame);
        assert_eq!(lmu_unreadable(false, true), Unreadable::NotTheGame);
        // With the game running, missing events are a memory still being made; only the wrong size is another version.
        assert_eq!(lmu_unreadable(true, false), Unreadable::Incomplete);
        assert_eq!(lmu_unreadable(true, true), Unreadable::OtherVersion);
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
        let label = label.map(|l| crate::text::lap_label(Lang::En, &l));
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
    fn a_saved_lap_says_who_recorded_it_and_which_checks_it_failed() {
        let dir = crate::config::scratch_dir("engine-save-stamp");
        let lines = std::sync::Mutex::new(Vec::new());
        // Two samples at 2 Hz: the sample rate is too low for a lap, and the checks say so.
        save(&dir, &lap(3), &|line| lines.lock().unwrap().push(line));
        let name = std::fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
        let back = lapfile::gunzip(&std::fs::read(name).unwrap(), lapfile::MAX_UNPACKED).unwrap();
        let recorder = back.recorder.expect("stamped");
        assert_eq!(recorder.app, "xpeed-companion");
        assert_eq!(recorder.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(recorder.build, env!("XPEED_BUILD"));
        assert_eq!(recorder.source, "lmu");
        assert!(back.checks.contains(&"sample_rate".to_string()));
        let lines = lines.lock().unwrap();
        assert!(lines.iter().skip(1).any(|l| l.starts_with("Data check sample_rate (lap 3)")));
    }

    /// A "folder" no lap can go into: a file stands where it should be (a read-only folder does not stop a file from being
    /// created on Windows, so this is what a refusing disk looks like to the tests).
    fn refusing_folder(name: &str) -> std::path::PathBuf {
        let path = crate::config::scratch_dir(name).join("laps");
        std::fs::write(&path, b"not a folder").unwrap();
        path
    }

    /// Makes the refusing folder a real one, as if the disk had room again.
    fn make_room(path: &Path) {
        std::fs::remove_file(path).unwrap();
        std::fs::create_dir_all(path).unwrap();
    }

    #[test]
    fn says_so_when_a_lap_cannot_be_saved_and_does_not_count_it() {
        let dir = refusing_folder("engine-save-fail");
        let lines = std::sync::Mutex::new(Vec::new());
        assert_eq!(save(&dir, &lap(4), &|line| lines.lock().unwrap().push(line)), None);
        assert!(lines.lock().unwrap()[0].starts_with("Could not save lap 4"));
    }

    #[test]
    fn a_folder_that_was_deleted_while_running_is_made_again() {
        let dir = crate::config::scratch_dir("engine-save-remake").join("gone").join("laps");
        let saved = save(&dir, &lap(2), &|_| {}).map(|l| crate::text::lap_label(Lang::En, &l));
        assert_eq!(saved.as_deref(), Some("Lap 2  3:27.250"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn a_lap_never_replaces_a_file_of_the_same_name() {
        let dir = crate::config::scratch_dir("engine-save-twice");
        assert!(save(&dir, &lap(3), &|_| {}).is_some());
        assert!(save(&dir, &lap(3), &|_| {}).is_some());
        assert!(save(&dir, &lap(3), &|_| {}).is_some());
        let mut names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "circuit-de-la-sarthe_porsche-963-6_lap3_20261110123456.xlap.gz",
                "circuit-de-la-sarthe_porsche-963-6_lap3_20261110123456_2.xlap.gz",
                "circuit-de-la-sarthe_porsche-963-6_lap3_20261110123456_3.xlap.gz",
            ]
        );
    }

    #[test]
    fn failed_publication_cleans_its_partial_and_later_recovery_succeeds() {
        let dir = crate::config::scratch_dir("engine-part-cleanup");
        let partial = dir.join("lap.xlap.gz.part");
        let final_path = dir.join("lap.xlap.gz");
        for _ in 0..5 {
            let result = publish_bytes(&partial, &final_path, b"lap bytes", |_, _| {
                Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "injected rename failure"))
            });
            assert!(result.is_err());
            assert!(!partial.exists(), "failed retries do not consume disk space");
            assert!(!final_path.exists());
        }
        publish_bytes(&partial, &final_path, b"lap bytes", std::fs::rename).unwrap();
        assert_eq!(std::fs::read(&final_path).unwrap(), b"lap bytes");
        assert!(!partial.exists());
    }

    #[test]
    fn another_writers_partial_is_never_overwritten_or_removed() {
        let dir = crate::config::scratch_dir("engine-part-owner");
        let partial = dir.join("lap.xlap.gz.part");
        std::fs::write(&partial, b"other writer").unwrap();
        assert!(publish_bytes(&partial, &dir.join("lap.xlap.gz"), b"new", std::fs::rename).is_err());
        assert_eq!(std::fs::read(&partial).unwrap(), b"other writer");
    }

    #[test]
    fn a_lap_the_folder_refuses_is_kept_told_once_and_written_when_the_folder_takes_it() {
        let dir = refusing_folder("engine-held");
        let shared = Shared::new(true);
        let lines = std::sync::Mutex::new(Vec::new());
        let say = |line: String| lines.lock().unwrap().push(line);
        let delays = [Duration::from_millis(5), Duration::from_millis(5)];
        let saver = Saver::with_delays(&dir, &shared, &say, &delays);
        saver.lap(&lap(1));
        saver.lap(&lap(2));
        assert_eq!(saver.held(), 2, "both wait in memory");
        let stats = shared.lap_stats();
        assert_eq!((stats.saved, stats.failed_save), (0, 2));
        assert_eq!(shared.snapshot().laps_saved, 0);
        let alerts = shared.take_save_alerts();
        assert_eq!(alerts.len(), 1, "the tray is told once while it keeps failing: {alerts:?}");
        assert!(!alerts[0].is_empty() && alerts[0].chars().count() <= 80 && !alerts[0].contains('\n'));
        make_room(&dir);
        // The next lap goes after the ones that waited.
        saver.lap(&lap(3));
        assert_eq!(saver.held(), 0);
        let stats = shared.lap_stats();
        assert_eq!((stats.saved, stats.failed_save), (3, 0), "{stats:?}");
        assert_eq!(shared.snapshot().laps_saved, 3);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 3);
        assert!(lines.lock().unwrap().iter().any(|l| l.contains("Keeping it to try again")));
        // Saving works again: a later failure is told again.
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::write(&dir, b"not a folder").unwrap();
        saver.lap(&lap(4));
        assert_eq!(shared.take_save_alerts().len(), 1);
    }

    #[test]
    fn previously_accepted_laps_are_never_evicted() {
        let dir = refusing_folder("engine-held-max");
        let shared = Shared::new(true);
        let lines = std::sync::Mutex::new(Vec::new());
        let say = |line: String| lines.lock().unwrap().push(line);
        let saver = Saver::with_delays(&dir, &shared, &say, &[]);
        for n in 1..=(HELD_MAX as u32 + 2) {
            saver.lap(&lap(n));
        }
        assert_eq!(saver.held(), HELD_MAX + 2);
        make_room(&dir);
        saver.retry_held(true);
        assert_eq!(saver.held(), 0);
        let mut numbers: Vec<u32> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| {
                let name = e.unwrap().file_name().into_string().unwrap();
                name.split("_lap").nth(1).unwrap().split('_').next().unwrap().parse().unwrap()
            })
            .collect();
        numbers.sort_unstable();
        assert_eq!(numbers, [1, 2, 3, 4, 5, 6, 7], "all accepted laps survive recovery");
        assert!(!lines.lock().unwrap().iter().any(|line| line.contains("let go")));
    }

    #[test]
    fn what_is_held_is_tried_again_by_the_clock_not_before() {
        let dir = refusing_folder("engine-held-clock");
        let shared = Shared::new(true);
        let saver = Saver::with_delays(&dir, &shared, &|_| {}, &[]);
        saver.lap(&lap(1));
        make_room(&dir);
        saver.retry_held(false);
        assert_eq!(saver.held(), 1, "not yet: the last go was a moment ago");
        saver.retry_held(true);
        assert_eq!(saver.held(), 0);
    }

    #[test]
    fn a_worker_ending_makes_a_last_go_at_the_laps_it_holds() {
        let dir = refusing_folder("engine-held-finish");
        let shared = Shared::new(true);
        let lines = std::sync::Mutex::new(Vec::new());
        let say = |line: String| lines.lock().unwrap().push(line);
        let saver = Saver::with_delays(&dir, &shared, &say, &[]);
        saver.lap(&lap(1));
        saver.finish();
        assert!(lines
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.starts_with("Lap 1 could not be saved and is lost")));
        assert_eq!(saver.held(), 0);
    }

    #[test]
    fn a_lap_that_is_not_valid_is_labelled_so() {
        let dir = crate::config::scratch_dir("engine-invalid");
        let mut invalid = lap(5);
        invalid.valid = false;
        let saved = save(&dir, &invalid, &|_| {}).map(|l| crate::text::lap_label(Lang::En, &l));
        assert_eq!(saved.as_deref(), Some("Lap 5  3:27.250 (not valid)"));
        let pt = save(&dir, &invalid, &|_| {}).map(|l| crate::text::lap_label(Lang::Pt, &l));
        assert_eq!(pt.as_deref(), Some("Volta 5  3:27.250 (inválida)"));
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
    // A second script, for a test that runs at the same time as the first.
    static SCRIPT_B: std::sync::Mutex<Vec<crate::game::Frame>> = std::sync::Mutex::new(Vec::new());
    // The tests that use it take turns.
    static SCRIPT_B_TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());
    struct Scripted {
        done: bool,
        script: &'static std::sync::Mutex<Vec<crate::game::Frame>>,
    }
    impl Source for Scripted {
        fn game_id(&self) -> &'static str {
            "fake"
        }
        fn game_name(&self) -> &'static str {
            "Fake Racing"
        }
        fn next(&mut self, _timeout: Duration) -> Option<crate::game::Frame> {
            let mut script = self.script.lock().unwrap();
            if script.is_empty() {
                self.done = true;
                return None;
            }
            Some(script.remove(0))
        }
        fn alive(&self) -> bool {
            !self.done
        }
        fn caps(&self) -> crate::game::Caps {
            crate::game::Caps::NONE
        }
    }
    #[test]
    fn the_laps_the_cutter_lets_go_of_are_counted_for_the_heartbeat_with_their_reason() {
        let shared = Shared::new(true);
        let source = Scripted {
            done: false,
            script: &SCRIPT,
        };
        let mut cutter = LapCutter::new("fake");
        let mut tracker = crate::dash::Tracker::default();
        let saved = std::cell::Cell::new(0);
        let count = |_: &lapfile::Lap| saved.set(saved.get() + 1);
        let mut clock = 0.0;
        // A lap joined at 17 s (partial), then a 3 s lap (short), then a whole one.
        for (lap, from, seconds, last) in [
            (3, 17.0, 13.0, None),
            (4, 0.0, 3.0, Some(30.0)),
            (5, 0.0, 30.0, Some(3.0)),
            (6, 0.0, 1.0, Some(30.0)),
        ] {
            for i in 0..(seconds * 20.0) as usize {
                let mut f = crate::game::Frame::empty();
                f.clock_s = clock;
                f.driving = true;
                f.lap = lap;
                f.lap_time_s = Some(from + i as f64 / 20.0);
                f.last_lap_s = last;
                f.dist_m = Some((from + i as f64 / 20.0) * 50.0);
                f.speed_ms = 50.0;
                handle_frame(&f, &source, &mut cutter, &mut tracker, &shared, &count, None);
                clock += 0.05;
            }
        }
        let stats = shared.lap_stats();
        assert_eq!((stats.partial, stats.short), (1, 1), "{stats:?}");
        assert_eq!(saved.get(), 1, "the whole lap was written");
        // A lap still waiting when the game closes is counted by `flush` too.
        let mut short = LapCutter::new("fake");
        for lap in [1, 2] {
            for i in 0..40 {
                let mut f = crate::game::Frame::empty();
                f.clock_s = clock;
                f.driving = true;
                f.lap = lap;
                f.lap_time_s = Some(i as f64 / 20.0);
                f.dist_m = Some(i as f64);
                short.on_frame(&f, 0);
                clock += 0.05;
            }
        }
        flush(short, &source, &shared, &count);
        assert_eq!(shared.lap_stats().short, 2);
    }

    fn open_scripted() -> Option<Box<dyn Source>> {
        Some(Box::new(Scripted {
            done: false,
            script: &SCRIPT,
        }))
    }
    fn open_scripted_b() -> Option<Box<dyn Source>> {
        Some(Box::new(Scripted {
            done: false,
            script: &SCRIPT_B,
        }))
    }

    // A game that only listens (like a UDP reader): silent until the test lets it "send".
    static SENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    // The same for the test of a family that goes on while another is given up on.
    static SENDING_OTHER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    struct Listening(&'static std::sync::atomic::AtomicBool);
    impl Source for Listening {
        fn game_id(&self) -> &'static str {
            "fakeudp"
        }
        fn game_name(&self) -> &'static str {
            "Fake UDP Racing"
        }
        fn next(&mut self, timeout: Duration) -> Option<crate::game::Frame> {
            std::thread::sleep(timeout.min(Duration::from_millis(5)));
            self.0.load(std::sync::atomic::Ordering::SeqCst).then(crate::game::Frame::empty)
        }
        fn alive(&self) -> bool {
            true
        }
        fn listens(&self) -> bool {
            true
        }
        fn caps(&self) -> crate::game::Caps {
            crate::game::Caps::NONE
        }
    }
    fn open_listening() -> Option<Box<dyn Source>> {
        Some(Box::new(Listening(&SENDING)))
    }
    fn open_listening_other() -> Option<Box<dyn Source>> {
        Some(Box::new(Listening(&SENDING_OTHER)))
    }

    // A reader that falls over as soon as it is asked for a frame (what an indexing bug on bytes from the network does).
    struct Panicking;
    impl Source for Panicking {
        fn game_id(&self) -> &'static str {
            "boom"
        }
        fn game_name(&self) -> &'static str {
            "Boom Racing"
        }
        fn next(&mut self, _timeout: Duration) -> Option<crate::game::Frame> {
            panic!("index out of bounds in a packet");
        }
        fn alive(&self) -> bool {
            true
        }
        fn caps(&self) -> crate::game::Caps {
            crate::game::Caps::NONE
        }
    }
    fn open_panicking() -> Option<Box<dyn Source>> {
        Some(Box::new(Panicking))
    }

    // A reader that blocks for a long time in each call to `next`.
    struct Slow;
    impl Source for Slow {
        fn game_id(&self) -> &'static str {
            "slow"
        }
        fn game_name(&self) -> &'static str {
            "Slow Racing"
        }
        fn next(&mut self, _timeout: Duration) -> Option<crate::game::Frame> {
            std::thread::sleep(Duration::from_secs(3));
            None
        }
        fn alive(&self) -> bool {
            true
        }
        fn caps(&self) -> crate::game::Caps {
            crate::game::Caps::NONE
        }
    }
    fn open_slow() -> Option<Box<dyn Source>> {
        Some(Box::new(Slow))
    }

    // A third script, for the tests of the families.
    static SCRIPT_C: std::sync::Mutex<Vec<crate::game::Frame>> = std::sync::Mutex::new(Vec::new());
    fn open_scripted_c() -> Option<Box<dyn Source>> {
        Some(Box::new(Scripted {
            done: false,
            script: &SCRIPT_C,
        }))
    }

    fn quick_policy(max_restarts: usize) -> Policy {
        Policy {
            delays: vec![Duration::from_millis(5)],
            max_restarts,
            window: Duration::from_secs(60),
        }
    }

    fn reader(family: &'static str, id: &'static str, open: fn() -> Option<Box<dyn Source>>) -> Reader {
        Reader {
            family,
            title: family,
            ids: std::slice::from_ref(Box::leak(Box::new(id))),
            programs: &[],
            open,
        }
    }

    #[test]
    fn a_reader_that_panics_does_not_stop_another_readers_laps_nor_one_that_blocks() {
        let dir = crate::config::scratch_dir("engine-families");
        let mut script: Vec<_> = (0..600)
            .map(|i| scripted_frame("Test Ring", f64::from(i) * 0.05, 1, None))
            .collect();
        script.extend((600..640).map(|i| scripted_frame("Test Ring", f64::from(i) * 0.05, 2, Some(30.0))));
        *SCRIPT_C.lock().unwrap() = script;
        let readers = [
            reader("boomfam", "boom", open_panicking),
            reader("slowfam", "slow", open_slow),
            reader("goodfam", "fake", open_scripted_c),
        ];
        let shared = Shared::new(true);
        let lines = std::sync::Mutex::new(Vec::<String>::new());
        let started = Instant::now();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                run_readers(
                    &readers,
                    &dir,
                    &shared,
                    &|line| lines.lock().unwrap().push(line),
                    None,
                    LOADING_GRACE,
                    &quick_policy(1000),
                )
            });
            while shared.snapshot().laps_saved == 0 && started.elapsed() < Duration::from_secs(20) {
                std::thread::sleep(Duration::from_millis(20));
            }
            // The slow reader sits in a call that lasts 3 s: the good one did not wait for it.
            assert!(started.elapsed() < Duration::from_millis(2500), "{:?}", started.elapsed());
            assert_eq!(shared.snapshot().laps_saved, 1);
            shared.quit();
        });
        let lines = lines.into_inner().unwrap();
        assert!(
            lines
                .iter()
                .filter(|l| l.starts_with("boomfam reader panicked: index out of bounds"))
                .count()
                >= 2,
            "it was started again and fell over again: {lines:?}"
        );
        assert!(shared.failed_workers().is_empty(), "never given up on at 1000 restarts");
        assert!(
            shared.workers().iter().any(|(id, _)| *id == "boomfam") && shared.workers().iter().any(|(id, _)| *id == "goodfam"),
            "each family is a worker of its own: {:?}",
            shared.workers()
        );
    }

    #[test]
    fn a_family_given_up_on_leaves_the_others_running() {
        let dir = crate::config::scratch_dir("engine-giveup");
        let readers = [
            reader("boomfam", "boom", open_panicking),
            Reader {
                family: "otherfam",
                title: "Other",
                ids: &["fakeudp"],
                programs: &[],
                open: open_listening_other,
            },
        ];
        let shared = Shared::new(true);
        let state = || shared.games().into_iter().find(|(id, _, _)| *id == "fakeudp").map(|(_, _, g)| g);
        let wait = |until: &dyn Fn() -> bool| {
            let started = Instant::now();
            while !until() && started.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(10));
            }
            until()
        };
        std::thread::scope(|scope| {
            scope.spawn(|| run_readers(&readers, &dir, &shared, &|_| {}, None, LOADING_GRACE, &quick_policy(2)));
            assert!(
                wait(&|| shared.failed_workers() == ["boomfam"]),
                "the family that keeps failing is given up on"
            );
            // The other family never noticed: it reads its game as before.
            assert_eq!(shared.failed_workers(), ["boomfam"], "only that one");
            assert!(wait(&|| state() == Some(Game::Loading)), "{:?}", state());
            SENDING_OTHER.store(true, std::sync::atomic::Ordering::SeqCst);
            assert!(wait(&|| state() == Some(Game::Connected)), "{:?}", state());
            assert_eq!(shared.failed_workers(), ["boomfam"]);
            shared.quit();
        });
        assert_eq!(
            crate::supervisor::title("kunos"),
            "Assetto Corsa \u{b7} ACC \u{b7} AC Rally",
            "the panel names the family"
        );
        assert_eq!(crate::supervisor::title("nothing"), "background task");
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
            let last = seen.last_lap.as_ref().map(|l| crate::text::lap_label(Lang::En, l));
            assert_eq!(last.as_deref(), Some("Lap 1  0:30.000"));
            shared.quit();
        });
        assert!(finished.load(std::sync::atomic::Ordering::SeqCst));
        assert!(seen.try_recv().is_err(), "a game without a layout adapter skips the worker");
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
    fn a_parked_readers_layout_appears_without_another_frame_or_a_lap() {
        use crate::maps::{Layout, LayoutView};
        use crate::perspective::PreparedPath;
        use std::sync::Arc;

        struct Parked(Option<Frame>);
        impl Source for Parked {
            fn game_id(&self) -> &'static str {
                "ac"
            }
            fn game_name(&self) -> &'static str {
                "Assetto Corsa"
            }
            fn next(&mut self, timeout: Duration) -> Option<Frame> {
                if self.0.is_none() {
                    std::thread::sleep(timeout);
                }
                self.0.take()
            }
            fn alive(&self) -> bool {
                true
            }
            fn caps(&self) -> crate::game::Caps {
                crate::game::Caps::NONE
            }
        }

        let readers = [Reader {
            family: "parked",
            title: "Assetto Corsa",
            ids: &["ac"],
            programs: &[],
            open: || {
                let mut frame = Frame::empty();
                frame.set_phase(crate::game::Phase::Garage);
                frame.track = "Park".into();
                frame.track_variant = Some("short".into());
                Some(Box::new(Parked(Some(frame))))
            },
        }];
        let dir = crate::config::scratch_dir("engine-layout-quiet");
        let shared = Shared::new(false);
        let (worker, requests) = mpsc::channel();
        let wait_for = |predicate: &dyn Fn(&LayoutView) -> bool| {
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(3) {
                if let Some(live) = shared.live().filter(|live| predicate(&live.layout)) {
                    return Some(live);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            None
        };
        let (initial, completed) = std::thread::scope(|scope| {
            scope.spawn(|| run_games(&readers, &dir, &shared, &|_| {}, Some(&worker), LOADING_GRACE));
            let initial = wait_for(&|view| matches!(view, LayoutView::Loading));
            let completed = requests.recv_timeout(Duration::from_secs(1)).ok().and_then(|request| {
                request
                    .reply
                    .send(Ok(Layout {
                        path: Arc::new(PreparedPath::native(&[(0.0, 0.0), (0.0, 10.0)], false)),
                        road: None,
                    }))
                    .ok()?;
                wait_for(&|view| matches!(view, LayoutView::Ready(_)))
            });
            shared.quit();
            (initial, completed)
        });
        let initial = initial.expect("parked identity starts the layout lookup");
        let completed = completed.expect("the reply reaches the live snapshot without another frame");
        assert_eq!(completed.at_ms, initial.at_ms);
        assert_eq!((completed.game_id, completed.track_variant.as_deref()), ("ac", Some("short")));
        assert_eq!(shared.snapshot().laps_saved, 0);
    }

    #[test]
    fn a_loop_told_to_quit_does_nothing_but_make_the_folder() {
        let dir = crate::config::scratch_dir("engine-quit").join("laps");
        let shared = Shared::new(true);
        shared.quit();
        assert_eq!(run(&dir, &shared, &|_| {}, false), Ok(()));
        assert!(dir.is_dir());
    }

    /// A frame of the scripted game: lap `lap` of 30 s at 50 m/s, `last` the official time showing.
    fn scripted_frame(track: &str, clock: f64, lap: i32, last: Option<f64>) -> crate::game::Frame {
        let mut f = crate::game::Frame::empty();
        f.clock_s = clock;
        f.driving = true;
        f.lap = lap;
        f.lap_time_s = Some(clock - 30.0 * f64::from(lap - 1));
        f.last_lap_s = last;
        f.dist_m = Some((clock - 30.0 * f64::from(lap - 1)) * 50.0);
        f.speed_ms = 50.0;
        f.car = "Test Car".into();
        f.track = track.into();
        f
    }

    fn run_script_b(dir: &Path, shared: &Shared) {
        let readers = [Reader {
            family: "fake",
            title: "Fake",
            ids: &["fake"],
            programs: &[],
            open: open_scripted_b,
        }];
        std::thread::scope(|scope| {
            scope.spawn(|| run_games(&readers, dir, shared, &|_| {}, None, LOADING_GRACE));
            // The script is read, the source dies, the loop sees it and (nothing more to do) goes on until told to quit.
            let started = Instant::now();
            while !SCRIPT_B.lock().unwrap().is_empty() && started.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(20));
            }
            std::thread::sleep(Duration::from_millis(500));
            shared.quit();
        });
    }

    #[test]
    fn a_lap_still_waiting_for_its_time_is_saved_when_the_source_goes_away() {
        let _turn = SCRIPT_B_TURN.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = crate::config::scratch_dir("engine-flush");
        // Lap 1 is driven whole and lap 2 begins, but its official time never comes: the game closes.
        let mut script: Vec<_> = (0..600)
            .map(|i| scripted_frame("Test Ring", f64::from(i) * 0.05, 1, None))
            .collect();
        script.extend((600..620).map(|i| scripted_frame("Test Ring", f64::from(i) * 0.05, 2, None)));
        *SCRIPT_B.lock().unwrap() = script;
        let shared = Shared::new(true);
        run_script_b(&dir, &shared);
        assert_eq!(shared.snapshot().laps_saved, 1, "the waiting lap was written as the source died");
        let name = std::fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
        let lap = lapfile::gunzip(&std::fs::read(name).unwrap(), lapfile::MAX_UNPACKED).unwrap();
        assert_eq!((lap.lap_number, lap.valid, lap.time_ms), (1, false, 29_950));
    }

    #[test]
    fn the_recent_laps_start_over_when_the_session_goes_on_to_another_track() {
        let _turn = SCRIPT_B_TURN.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = crate::config::scratch_dir("engine-recent");
        let mut script: Vec<_> = (0..600)
            .map(|i| scripted_frame("Test Ring", f64::from(i) * 0.05, 1, None))
            .collect();
        script.extend((600..1200).map(|i| scripted_frame("Test Ring", f64::from(i) * 0.05, 2, Some(30.0))));
        // Laps 1 and 2 are written as their times show; then the game is on another track.
        script.extend((1200..1220).map(|i| scripted_frame("Test Ring", f64::from(i) * 0.05, 3, Some(31.0))));
        script.extend((1220..1240).map(|i| scripted_frame("Another Ring", f64::from(i) * 0.05, 3, Some(31.0))));
        *SCRIPT_B.lock().unwrap() = script;
        let shared = Shared::new(true);
        run_script_b(&dir, &shared);
        assert_eq!(shared.snapshot().laps_saved, 2, "laps 1 and 2 were written");
        assert!(shared.recent_laps().is_empty(), "{:?}", shared.recent_laps());
    }
}
