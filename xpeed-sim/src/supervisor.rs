//! Crashes are visible and the program recovers. Three parts:
//!
//! * a panic hook (`install_panic_hook`) that writes what panicked, where and on which thread to `companion.log`, with
//!   the version and build, so a support request has the cause;
//! * a supervisor (`supervise`) for the long-lived worker threads (each family of game readers, Le Mans Ultimate, the
//!   track builder, the uploader): when one panics it is logged and the worker starts again after a wait that grows (1 s, 2 s,
//!   5 s, 10 s, 30 s), up to 5 times in 10 minutes; after that it is given up on and shown as failed in the panel. A
//!   worker that failed never takes the tray down with it;
//! * a guard (`UiGuard`) for the window procedures, which would abort the whole program if a panic unwound out of them.

use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::applog;
use crate::crashreport;

/// How a worker is looked after.
pub struct Policy {
    /// The wait before each restart, by how many restarts happened in the window (the last one repeats).
    pub delays: Vec<Duration>,
    /// How many restarts are allowed within `window`; one panic more and the worker is given up on.
    pub max_restarts: usize,
    pub window: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            delays: [1, 2, 5, 10, 30].map(Duration::from_secs).to_vec(),
            max_restarts: 5,
            window: Duration::from_secs(10 * 60),
        }
    }
}

/// What the panel is told about a worker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Health {
    Running,
    /// It panicked and is waiting to start again.
    Restarting,
    /// It panicked too often and was given up on: it stays stopped until Xpeed Companion is restarted.
    Failed,
}

/// The ids of the long-lived workers, as `Shared::set_worker` knows them. Each family of game readers (`games::Reader::family`)
/// is a worker under its own id as well.
pub const LMU: &str = "lmu";
pub const TRACKS: &str = "tracks";
pub const UPLOADER: &str = "uploader";
pub const HEARTBEAT: &str = "heartbeat";
pub const UPDATER: &str = "updater";
pub const REFERENCES: &str = "references";

/// What a worker is called in a sentence (the log, the panel, the diagnostics).
pub fn title(id: &str) -> &'static str {
    match id {
        LMU => "Le Mans Ultimate reader",
        TRACKS => "track builder",
        UPLOADER => "uploader",
        HEARTBEAT => "heartbeat sender",
        UPDATER => "update checker",
        REFERENCES => "reference lap fetcher",
        // A family of game readers is named after the games it reads.
        family => crate::games::READERS
            .iter()
            .find(|reader| reader.family == family)
            .map_or("background task", |reader| reader.title),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    /// The worker returned (it was told to stop, or it had nothing more to do).
    Finished,
    GaveUp,
}

/// The words of a panic's payload (`panic!("text")` and `panic!("{x}")` carry a string).
pub fn panic_message(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "(no message)".to_owned())
}

/// Sleeps up to `total`, in short steps, and stops early when `quitting()` says so.
fn wait(total: Duration, quitting: &dyn Fn() -> bool) {
    let until = Instant::now() + total;
    while Instant::now() < until && !quitting() {
        std::thread::sleep(Duration::from_millis(25).min(until.saturating_duration_since(Instant::now())));
    }
}

/// Runs `body` until it returns, starting it again (after the wait `policy` says) each time it panics. `say` gets the
/// lines for the log; `health` is told how the worker stands. `body` must be able to start over from nothing: what it
/// held when it panicked is gone.
pub fn supervise(
    name: &str,
    policy: &Policy,
    quitting: &dyn Fn() -> bool,
    say: &dyn Fn(String),
    health: &dyn Fn(Health),
    mut body: impl FnMut(),
) -> Ended {
    let mut restarts: Vec<Instant> = Vec::new();
    health(Health::Running);
    loop {
        let Err(payload) = catch_unwind(AssertUnwindSafe(&mut body)) else {
            return Ended::Finished;
        };
        let now = Instant::now();
        restarts.retain(|at| now.duration_since(*at) < policy.window);
        let message = panic_message(payload.as_ref());
        if quitting() {
            say(format!("{name} panicked while closing: {message}"));
            return Ended::Finished;
        }
        if restarts.len() >= policy.max_restarts {
            say(format!(
                "{name} panicked: {message}. It stopped {} times in {} minutes: giving up on it until Xpeed Companion is restarted.",
                restarts.len() + 1,
                policy.window.as_secs().div_ceil(60)
            ));
            crashreport::record(
                name,
                &format!(
                    "{name} was given up on after {} restarts in {} minutes: {message}",
                    restarts.len(),
                    policy.window.as_secs().div_ceil(60)
                ),
                "",
            );
            health(Health::Failed);
            return Ended::GaveUp;
        }
        restarts.push(now);
        let delay = policy
            .delays
            .get(restarts.len() - 1)
            .or(policy.delays.last())
            .copied()
            .unwrap_or_default();
        say(format!(
            "{name} panicked: {message}. Starting it again in {} s ({} of {}).",
            delay.as_secs().max(1),
            restarts.len(),
            policy.max_restarts
        ));
        // A worker that fails again and again is worth telling the owner of the site about (a first-party report, sent at the next start).
        if restarts.len() >= 3 {
            crashreport::record(
                name,
                &format!(
                    "{name} restarted {} times in {} minutes: {message}",
                    restarts.len(),
                    policy.window.as_secs().div_ceil(60)
                ),
                "",
            );
        }
        health(Health::Restarting);
        wait(delay, quitting);
        if quitting() {
            return Ended::Finished;
        }
        health(Health::Running);
    }
}

/// The log line for a panic: what, where, on which thread, and which build.
pub fn panic_line(thread: &str, location: Option<&str>, message: &str, version: &str, build: &str) -> String {
    format!(
        "PANIC in thread '{thread}' at {}: {message} (Xpeed Companion {version}, build {build})",
        location.unwrap_or("an unknown place")
    )
}

/// Every panic in the program is written to the log before anything else happens (and then to the previous hook, which
/// prints it for a terminal). Call once, at the start.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let location = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        let line = panic_line(
            thread.name().unwrap_or("unnamed"),
            location.as_deref(),
            &panic_message(info.payload()),
            env!("CARGO_PKG_VERSION"),
            env!("XPEED_BUILD"),
        );
        // The log may not be open yet (a panic during start-up): the line waits for it.
        if applog::ready() {
            applog::line(&line);
        } else {
            applog::early(&line);
        }
        // The report for Xpeed's own server waits in a file and goes at the next start; nothing here touches the network.
        let worker = crashreport::worker_id(thread.name().unwrap_or("main"));
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let what = format!(
            "panicked at {}: {}",
            location.as_deref().unwrap_or("an unknown place"),
            panic_message(info.payload())
        );
        crashreport::record(&worker, &what, &backtrace);
        previous(info);
    }));
}

// ------------------------------------------------------------------------------------------- window procedures that must not die

/// How many panics inside window procedures, in `UI_PANIC_WINDOW`, mean the window is better left alone.
pub const UI_PANIC_LIMIT: usize = 5;
pub const UI_PANIC_WINDOW: Duration = Duration::from_secs(60);

/// What happened to a call that went through `UiGuard::run` and panicked.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum UiPanic {
    /// One panic; the window goes on.
    Once,
    /// The panic that made it `UI_PANIC_LIMIT` in `UI_PANIC_WINDOW`: said once. From now on `tripped()` is true.
    JustTripped,
    /// A panic after it was already tripped.
    Again,
}

/// A window procedure is `extern "system"`: a panic that unwinds out of one aborts the whole program, and with it the
/// recording. A guard runs its body inside `catch_unwind` instead. The panic itself is already in the log and in the crash
/// report (`install_panic_hook` runs before the unwinding starts), so the guard only counts them: a window that keeps
/// panicking (a paint that fails on every frame) is `tripped`, and its owner stops doing the thing that fails.
pub struct UiGuard {
    recent: Mutex<Vec<Instant>>,
    tripped: AtomicBool,
}

impl Default for UiGuard {
    fn default() -> Self {
        UiGuard::new()
    }
}

impl UiGuard {
    pub const fn new() -> UiGuard {
        UiGuard {
            recent: Mutex::new(Vec::new()),
            tripped: AtomicBool::new(false),
        }
    }

    /// Whether the window panicked `UI_PANIC_LIMIT` times in `UI_PANIC_WINDOW` (until `reset`).
    pub fn tripped(&self) -> bool {
        self.tripped.load(Ordering::SeqCst)
    }

    /// Forgets the count: a new window starts clean.
    pub fn reset(&self) {
        crate::util::lock(&self.recent).clear();
        self.tripped.store(false, Ordering::SeqCst);
    }

    /// Counts a panic that happened at `now`.
    pub fn note(&self, now: Instant) -> UiPanic {
        let mut recent = crate::util::lock(&self.recent);
        recent.retain(|at| now.duration_since(*at) < UI_PANIC_WINDOW);
        recent.push(now);
        if self.tripped.load(Ordering::SeqCst) {
            UiPanic::Again
        } else if recent.len() >= UI_PANIC_LIMIT {
            self.tripped.store(true, Ordering::SeqCst);
            UiPanic::JustTripped
        } else {
            UiPanic::Once
        }
    }

    /// Runs `body`; a panic in it is counted and handed back as an `Err` instead of unwinding into Windows.
    pub fn run<R>(&self, body: impl FnOnce() -> R) -> Result<R, UiPanic> {
        catch_unwind(AssertUnwindSafe(body)).map_err(|_| self.note(Instant::now()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn quick(max_restarts: usize) -> Policy {
        Policy {
            delays: vec![Duration::from_millis(5), Duration::from_millis(10)],
            max_restarts,
            window: Duration::from_secs(60),
        }
    }

    #[test]
    fn a_worker_that_panics_is_restarted_and_then_runs_on() {
        let runs = AtomicUsize::new(0);
        let (lines, states) = (Mutex::new(Vec::new()), Mutex::new(Vec::new()));
        let ended = supervise(
            "the uploader",
            &quick(5),
            &|| false,
            &|line| lines.lock().unwrap().push(line),
            &|state| states.lock().unwrap().push(state),
            || {
                if runs.fetch_add(1, Ordering::SeqCst) < 2 {
                    panic!("boom {}", runs.load(Ordering::SeqCst));
                }
            },
        );
        assert_eq!(ended, Ended::Finished);
        assert_eq!(runs.load(Ordering::SeqCst), 3);
        assert_eq!(
            *states.lock().unwrap(),
            [
                Health::Running,
                Health::Restarting,
                Health::Running,
                Health::Restarting,
                Health::Running
            ]
        );
        let lines = lines.lock().unwrap();
        assert!(
            lines[0].contains("the uploader panicked: boom 1") && lines[0].contains("1 of 5"),
            "{lines:?}"
        );
        assert!(lines[1].contains("boom 2") && lines[1].contains("2 of 5"), "{lines:?}");
    }

    #[test]
    fn a_worker_that_keeps_panicking_is_given_up_on_and_marked_failed() {
        // Giving up writes a crash report: it must not land in the folder of a crash-report test running at the same time.
        let _alone = crate::util::lock(&crate::crashreport::TEST_GLOBALS);
        let runs = AtomicUsize::new(0);
        let (lines, states) = (Mutex::new(Vec::new()), Mutex::new(Vec::new()));
        let ended = supervise(
            "the track builder",
            &quick(5),
            &|| false,
            &|line| lines.lock().unwrap().push(line),
            &|state| states.lock().unwrap().push(state),
            || {
                runs.fetch_add(1, Ordering::SeqCst);
                panic!("always");
            },
        );
        assert_eq!(ended, Ended::GaveUp);
        assert_eq!(runs.load(Ordering::SeqCst), 6, "the first run and 5 restarts");
        assert_eq!(states.lock().unwrap().last(), Some(&Health::Failed));
        assert!(lines.lock().unwrap().last().unwrap().contains("giving up"));
    }

    #[test]
    fn restarts_older_than_the_window_do_not_count() {
        let runs = AtomicUsize::new(0);
        let policy = Policy {
            delays: vec![Duration::from_millis(30)],
            max_restarts: 1,
            window: Duration::from_millis(10),
        };
        // Each restart waits longer than the window, so there is never more than one restart inside it.
        let ended = supervise("w", &policy, &|| false, &|_| {}, &|_| {}, || {
            if runs.fetch_add(1, Ordering::SeqCst) < 3 {
                panic!("again");
            }
        });
        assert_eq!(ended, Ended::Finished);
        assert_eq!(runs.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn a_worker_is_not_restarted_while_the_program_closes() {
        let runs = AtomicUsize::new(0);
        let ended = supervise("w", &quick(5), &|| true, &|_| {}, &|_| {}, || {
            runs.fetch_add(1, Ordering::SeqCst);
            panic!("while closing");
        });
        assert_eq!(ended, Ended::Finished);
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_panic_line_says_what_where_on_which_thread_and_which_build() {
        let line = panic_line("worker-1", Some("src/engine.rs:10:5"), "index out of bounds", "0.4.0", "abc1234");
        for part in ["worker-1", "src/engine.rs:10:5", "index out of bounds", "0.4.0", "abc1234"] {
            assert!(line.contains(part), "{part}: {line}");
        }
        assert!(!panic_line("t", None, "m", "1", "b").contains("None"));
        let text = std::panic::catch_unwind(|| panic!("with {}", "format")).unwrap_err();
        assert_eq!(panic_message(text.as_ref()), "with format");
        let literal = std::panic::catch_unwind(|| panic!("literal")).unwrap_err();
        assert_eq!(panic_message(literal.as_ref()), "literal");
    }

    #[test]
    fn the_ui_guard_turns_a_panic_into_a_value_and_lets_a_good_call_through() {
        let guard = UiGuard::new();
        assert_eq!(guard.run(|| 7), Ok(7));
        let ran_after = AtomicUsize::new(0);
        let out: Result<(), UiPanic> = guard.run(|| panic!("a window procedure blows up"));
        assert_eq!(out, Err(UiPanic::Once), "the panic did not unwind out of the guard");
        assert_eq!(guard.run(|| ran_after.fetch_add(1, Ordering::SeqCst)), Ok(0));
        assert_eq!(ran_after.load(Ordering::SeqCst), 1, "the next call runs normally");
        assert!(!guard.tripped());
    }

    #[test]
    fn the_ui_guard_trips_once_after_five_panics_in_a_minute_and_a_new_window_starts_clean() {
        let guard = UiGuard::new();
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        for second in 0..4 {
            assert_eq!(guard.note(at(second)), UiPanic::Once);
        }
        assert!(!guard.tripped());
        assert_eq!(guard.note(at(4)), UiPanic::JustTripped, "the fifth in a minute");
        assert!(guard.tripped());
        assert_eq!(guard.note(at(5)), UiPanic::Again, "said only once");
        guard.reset();
        assert!(!guard.tripped());
        assert_eq!(guard.note(at(6)), UiPanic::Once);
    }

    #[test]
    fn spread_out_ui_panics_never_trip_the_guard() {
        let guard = UiGuard::new();
        let start = Instant::now();
        // One every 20 s is three in a minute at most: never five.
        for i in 0..30 {
            assert_eq!(guard.note(start + Duration::from_secs(i * 20)), UiPanic::Once);
        }
        assert!(!guard.tripped());
    }

    #[test]
    fn the_ui_guard_counts_real_panics_through_run() {
        let guard = UiGuard::new();
        let mut last = UiPanic::Once;
        for _ in 0..UI_PANIC_LIMIT {
            last = guard.run(|| -> () { panic!("every frame fails") }).unwrap_err();
        }
        assert_eq!(last, UiPanic::JustTripped);
        assert!(guard.tripped());
    }
}
