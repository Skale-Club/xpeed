//! Bounded lap persistence. Readers only enqueue; the scoped worker owns disk I/O and retry waits.
use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::lapfile::Lap;
use crate::status::{SavedLap, Shared};

const MAX_LAPS: usize = 5;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const RETRY_EVERY: Duration = Duration::from_secs(20);
const RETRY_DELAYS: &[Duration] = &[Duration::from_millis(100), Duration::from_millis(400)];

struct Pending {
    lap: Arc<Lap>,
    bytes: usize,
    late: bool,
    generation: u64,
}

#[derive(Default)]
struct Queue {
    laps: VecDeque<Pending>,
    bytes: usize,
    closed: bool,
    failed: bool,
}

pub struct Saver<'a> {
    queue: Mutex<Queue>,
    ready: Condvar,
    shared: &'a Shared,
    say: &'a (dyn Fn(String) + Sync),
    max_laps: usize,
    max_bytes: usize,
}

/// Includes every owned allocation in a cloned lap, plus conservative queue/Arc overhead.
/// The worker holds an Arc to the front, so an in-flight lap remains charged to the same budget.
fn lap_bytes(lap: &Lap) -> usize {
    let mut bytes = std::mem::size_of::<Lap>() + 256;
    let mut add = |n: usize| bytes = bytes.saturating_add(n);
    for text in [&lap.game, &lap.track_name, &lap.car_name, &lap.started_at] {
        add(text.len());
    }
    for text in [
        &lap.track_variant,
        &lap.car_class,
        &lap.session_id,
        &lap.weather,
        &lap.tyre_compound,
    ]
    .into_iter()
    .flatten()
    {
        add(text.len());
    }
    if let Some(sectors) = &lap.sectors_ms {
        add(sectors.len().saturating_mul(std::mem::size_of::<u32>()));
    }
    if let Some(recorder) = &lap.recorder {
        add(std::mem::size_of_val(recorder));
        for text in [&recorder.app, &recorder.version, &recorder.build, &recorder.source] {
            add(text.len());
        }
        add(recorder.game_build.as_ref().map_or(0, String::len));
    }
    add(lap.checks.len().saturating_mul(std::mem::size_of::<String>()));
    for check in &lap.checks {
        add(check.len());
    }
    add(lap.channels.len().saturating_mul(std::mem::size_of::<crate::lapfile::Channel>()));
    for channel in &lap.channels {
        add(channel.id.len());
        add(channel.unit.len());
        add(channel.values.len().saturating_mul(std::mem::size_of::<f32>()));
    }
    bytes
}

impl<'a> Saver<'a> {
    fn new(shared: &'a Shared, say: &'a (dyn Fn(String) + Sync), max_laps: usize, max_bytes: usize) -> Self {
        Self {
            queue: Mutex::new(Queue::default()),
            ready: Condvar::new(),
            shared,
            say,
            max_laps,
            max_bytes,
        }
    }

    /// Only brief queue bookkeeping takes the lock; disk I/O and retry waits never hold it.
    /// Rejection is explicit and stops further recording.
    pub fn lap(&self, lap: &Lap) {
        let bytes = lap_bytes(lap);
        let accepted = {
            let mut queue = crate::util::lock(&self.queue);
            if !queue.closed && !queue.failed && queue.laps.len() < self.max_laps && bytes <= self.max_bytes.saturating_sub(queue.bytes) {
                queue.laps.push_back(Pending {
                    lap: Arc::new(lap.clone()),
                    bytes,
                    late: false,
                    generation: self.shared.recent_generation(),
                });
                queue.bytes += bytes;
                true
            } else {
                false
            }
        };
        if accepted {
            self.ready.notify_one();
        } else {
            self.shared.set_paused(true);
            self.shared
                .note_lap_unsaved("Recording paused: lap save queue full or writer unavailable");
            (self.say)(format!("Lap {} was NOT accepted for saving: queue full, byte budget exceeded, or writer unavailable. Recording paused; queued laps are retained.", lap.lap_number));
        }
    }

    fn close(&self) {
        crate::util::lock(&self.queue).closed = true;
        self.ready.notify_all();
    }

    fn failed(&self) {
        let mut queue = crate::util::lock(&self.queue);
        queue.failed = true;
        let remaining = queue.laps.len();
        for lap in &mut queue.laps {
            if !lap.late {
                lap.late = true;
                self.shared.note_lap_unsaved("Recording paused: lap writer stopped unexpectedly");
            }
        }
        drop(queue);
        self.shared.set_paused(true);
        (self.say)(format!("Lap writer stopped unexpectedly; {remaining} accepted laps remain unsaved in memory and will be lost on exit. Recording paused."));
    }

    fn run(&self, write: &(dyn Fn(&Lap) -> Result<SavedLap, String> + Sync), delays: &[Duration], retry_every: Duration) {
        loop {
            let (lap, late, generation, closing) = {
                let mut queue = crate::util::lock(&self.queue);
                while queue.laps.is_empty() && !queue.closed {
                    queue = self.ready.wait(queue).unwrap_or_else(std::sync::PoisonError::into_inner);
                }
                let Some(front) = queue.laps.front() else { return };
                (Arc::clone(&front.lap), front.late, front.generation, queue.closed)
            };
            let mut result = Err(String::new());
            for delay in std::iter::once(&Duration::ZERO).chain(delays) {
                if !delay.is_zero() {
                    std::thread::sleep(*delay);
                }
                // A faulty writer must not unwind through the scope and kill the readers.
                result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| write(&lap)))
                    .unwrap_or_else(|_| Err("lap writer panicked".into()));
                if result.is_ok() {
                    break;
                }
            }
            match result {
                Ok(saved) => {
                    let build = lap.recorder.as_ref().and_then(|r| r.game_build.as_deref());
                    self.shared.update(|s| {
                        s.laps_saved += 1;
                        s.last_lap = Some(saved.clone());
                    });
                    self.shared.note_lap_saved(&lap.game, build, late);
                    self.shared.note_played(&saved);
                    self.shared.notify_lap_saved(saved, generation);
                    self.shared.wake_uploader();
                    let mut queue = crate::util::lock(&self.queue);
                    if let Some(done) = queue.laps.pop_front() {
                        queue.bytes -= done.bytes;
                    }
                    let recovered = queue.laps.iter().all(|pending| !pending.late);
                    drop(queue);
                    if recovered {
                        self.shared.note_saving_works();
                    }
                }
                Err(error) => {
                    self.shared.set_paused(true);
                    if !late {
                        let reason: String = error.lines().next().unwrap_or("").chars().take(80).collect();
                        self.shared.note_lap_unsaved(&reason);
                        if let Some(front) = crate::util::lock(&self.queue).laps.front_mut() {
                            front.late = true;
                        }
                        (self.say)(format!(
                            "Could not save lap {}: {error}. Recording paused; keeping it to try again.",
                            lap.lap_number
                        ));
                    }
                    if closing {
                        let mut queue = crate::util::lock(&self.queue);
                        if let Some(lost) = queue.laps.pop_front() {
                            queue.bytes -= lost.bytes;
                        }
                        drop(queue);
                        (self.say)(format!(
                            "Lap {} could not be saved during shutdown and is lost: {error}",
                            lap.lap_number
                        ));
                    } else {
                        // New laps may wake us, but only shutdown bypasses the retry deadline.
                        let queue = crate::util::lock(&self.queue);
                        drop(
                            self.ready
                                .wait_timeout_while(queue, retry_every, |q| !q.closed)
                                .unwrap_or_else(std::sync::PoisonError::into_inner),
                        );
                    }
                }
            }
        }
    }
}

/// The writer outlives reader restarts, then drains and joins even if the reader unwinds.
/// Retry count is bounded on shutdown; an OS disk call itself has no portable timeout.
pub fn with_saver<R>(out: &Path, shared: &Shared, say: &(dyn Fn(String) + Sync), body: impl FnOnce(&Saver<'_>) -> R) -> R {
    with_writer(
        shared,
        say,
        &|lap| crate::engine::save_once(out, lap, say),
        RETRY_DELAYS,
        RETRY_EVERY,
        body,
    )
}

fn with_writer<R>(
    shared: &Shared,
    say: &(dyn Fn(String) + Sync),
    write: &(dyn Fn(&Lap) -> Result<SavedLap, String> + Sync),
    delays: &[Duration],
    retry_every: Duration,
    body: impl FnOnce(&Saver<'_>) -> R,
) -> R {
    let saver = Saver::new(shared, say, MAX_LAPS, MAX_BYTES);
    std::thread::scope(|scope| {
        let writer = scope.spawn(|| {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| saver.run(write, delays, retry_every))).is_err() {
                saver.failed();
            }
        });
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(&saver)));
        saver.close();
        if writer.join().is_err() {
            saver.failed();
        }
        match result {
            Ok(value) => value,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;

    fn lap(number: u32) -> Lap {
        Lap {
            lap_number: number,
            game: "fake".into(),
            ..Lap::default()
        }
    }

    fn saved(lap: &Lap) -> SavedLap {
        SavedLap {
            number: lap.lap_number,
            time_ms: 0,
            valid: true,
            sectors_ms: Vec::new(),
            game: lap.game.clone(),
            track: String::new(),
            car: String::new(),
        }
    }

    fn wait_until(test: impl Fn() -> bool) {
        let until = Instant::now() + Duration::from_secs(3);
        while !test() {
            assert!(Instant::now() < until, "writer did not make progress");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn slow_disk_does_not_stall_enqueue_and_shutdown_drains() {
        let shared = Shared::new(true);
        let (entered, ready) = std::sync::mpsc::sync_channel(1);
        let (release, wait) = std::sync::mpsc::sync_channel(1);
        let wait = Mutex::new(wait);
        let write = |lap: &Lap| {
            if lap.lap_number == 1 {
                entered.send(()).unwrap();
                wait.lock().unwrap().recv_timeout(Duration::from_secs(3)).unwrap();
            }
            Ok(saved(lap))
        };
        with_writer(&shared, &|_| {}, &write, &[], Duration::from_millis(5), |saver| {
            saver.lap(&lap(1));
            ready.recv_timeout(Duration::from_secs(3)).unwrap();
            let start = Instant::now();
            saver.lap(&lap(2));
            assert!(start.elapsed() < Duration::from_millis(100));
            assert_eq!(crate::util::lock(&saver.queue).laps.len(), 2, "in-flight lap is charged");
            release.send(()).unwrap();
        });
        assert_eq!(shared.snapshot().laps_saved, 2, "scope joins after draining");
    }

    #[test]
    fn count_and_byte_limits_pause_without_evicting_accepted_laps() {
        let shared = Shared::new(true);
        let saver = Saver::new(&shared, &|_| {}, 2, usize::MAX);
        saver.lap(&lap(1));
        saver.lap(&lap(2));
        saver.lap(&lap(3));
        assert!(shared.paused());
        assert!(!shared.take_save_alerts().is_empty());
        let queue = crate::util::lock(&saver.queue);
        assert_eq!(queue.laps.iter().map(|p| p.lap.lap_number).collect::<Vec<_>>(), [1, 2]);
        drop(queue);
        let budget = lap_bytes(&lap(1));
        let saver = Saver::new(&shared, &|_| {}, 10, budget);
        saver.lap(&lap(1));
        saver.lap(&lap(2));
        let queue = crate::util::lock(&saver.queue);
        assert_eq!(queue.laps.len(), 1);
        assert!(queue.bytes <= budget);
    }

    #[test]
    fn idle_paused_writer_recovers_without_new_frames_or_eviction() {
        let shared = Shared::new(true);
        let writable = AtomicBool::new(false);
        let order = Mutex::new(Vec::new());
        let write = |lap: &Lap| {
            if !writable.load(Ordering::SeqCst) {
                return Err("disk full".into());
            }
            order.lock().unwrap().push(lap.lap_number);
            Ok(saved(lap))
        };
        with_writer(&shared, &|_| {}, &write, &[], Duration::from_millis(5), |saver| {
            saver.lap(&lap(1));
            wait_until(|| shared.paused() && shared.lap_stats().failed_save == 1);
            writable.store(true, Ordering::SeqCst);
            saver.lap(&lap(2));
            wait_until(|| shared.snapshot().laps_saved == 2 && crate::util::lock(&saver.queue).laps.is_empty());
            assert!(crate::util::lock(&saver.queue).laps.is_empty());
        });
        assert_eq!(*order.lock().unwrap(), [1, 2]);
        assert_eq!(shared.lap_stats().failed_save, 0);
    }

    #[test]
    fn persistent_failure_on_shutdown_reports_every_unsaved_lap() {
        let shared = Shared::new(true);
        let lines = Mutex::new(Vec::new());
        with_writer(
            &shared,
            &|line| lines.lock().unwrap().push(line),
            &|_| Err("disk full".into()),
            &[],
            Duration::from_secs(60),
            |saver| {
                saver.lap(&lap(1));
                saver.lap(&lap(2));
            },
        );
        assert_eq!(shared.lap_stats().failed_save, 2);
        assert_eq!(
            lines
                .lock()
                .unwrap()
                .iter()
                .filter(|s| s.contains("during shutdown and is lost"))
                .count(),
            2
        );
    }

    #[test]
    fn writer_panic_is_visible_and_can_recover() {
        let shared = Shared::new(true);
        let first = AtomicBool::new(true);
        let write = |lap: &Lap| {
            if first.swap(false, Ordering::SeqCst) {
                panic!("broken compression");
            }
            Ok(saved(lap))
        };
        with_writer(&shared, &|_| {}, &write, &[], Duration::from_millis(5), |saver| {
            saver.lap(&lap(1));
            wait_until(|| shared.paused());
            wait_until(|| !shared.take_save_alerts().is_empty());
            wait_until(|| shared.snapshot().laps_saved == 1);
        });
        assert_eq!(shared.lap_stats().failed_save, 0);
    }

    #[test]
    fn disconnected_worker_rejects_new_laps_and_keeps_accepted_laps_visible() {
        let shared = Shared::new(true);
        let saver = Saver::new(&shared, &|_| {}, MAX_LAPS, MAX_BYTES);
        saver.lap(&lap(1));
        saver.failed();
        saver.lap(&lap(2));
        assert!(shared.paused());
        assert_eq!(shared.lap_stats().failed_save, 2);
        assert_eq!(crate::util::lock(&saver.queue).laps.len(), 1);
        saver.close();
    }

    #[test]
    fn empty_shutdown_does_not_wait_for_a_sender_or_retry_timer() {
        let shared = Shared::new(true);
        with_writer(&shared, &|_| {}, &|lap| Ok(saved(lap)), &[], Duration::from_secs(60), |_| {});
    }

    #[test]
    fn brief_metadata_contention_never_rejects_a_lap_with_room() {
        let shared = Shared::new(true);
        let saver = Saver::new(&shared, &|_| {}, MAX_LAPS, MAX_BYTES);
        std::thread::scope(|scope| {
            let guard = crate::util::lock(&saver.queue);
            let (started, received) = std::sync::mpsc::sync_channel(1);
            let saver = &saver;
            let enqueue = scope.spawn(move || {
                started.send(()).unwrap();
                saver.lap(&lap(1));
            });
            received.recv_timeout(Duration::from_secs(3)).unwrap();
            drop(guard);
            enqueue.join().unwrap();
        });
        assert_eq!(crate::util::lock(&saver.queue).laps.len(), 1);
        assert_eq!(shared.lap_stats().failed_save, 0);
        assert!(!shared.paused());
    }

    #[test]
    fn reader_unwind_still_drains_and_joins_the_writer() {
        let shared = Shared::new(true);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_writer(&shared, &|_| {}, &|lap| Ok(saved(lap)), &[], Duration::from_secs(60), |saver| {
                saver.lap(&lap(1));
                panic!("reader failed");
            });
        }));
        assert!(result.is_err());
        assert_eq!(shared.snapshot().laps_saved, 1);
    }
}
