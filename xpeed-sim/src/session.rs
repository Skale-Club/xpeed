//! The one state machine that decides what a stream of frames means: which session is being driven, which lap is in
//! progress, and when either begins, restarts or ends. The lap cutter (`lapcut.rs`, the laps that are written) and the
//! panel's tracker (`dash.rs`, the live reading) both read the frames through it, so they can no longer disagree.
//!
//! `Session::feed` takes one `Frame` and answers with a `Step`: the events the frame caused, and, when the frame is a
//! sample of a lap, the sample the machine decided on (the lap time and the distance on the lap, and how long since the
//! last sample).
//!
//! * Only `Driving` frames feed laps. A paused game keeps the lap it has (the gap in the clock is not driven). Any other
//!   phase (a menu, the garage, loading, a replay, watching another car) is time away: when it lasts longer than
//!   `AWAY_SECONDS` the lap in progress is dropped (`LapReset(Away)`), never the session.
//! * A session ends, and a new one begins at once, when the car or the track (or its layout) changes, when the kind of
//!   session changes (practice, then qualifying), when the lap number goes back, or when the lap clock jumps back on the
//!   same lap (a restart: the clock by more than a second, or the distance by more than 50 m while the clock also goes
//!   back, which is what a restart that keeps the lap number looks like).
//! * A lap ends when the lap number goes up by one (`LapClosed`, then `LapStarted`). A number that jumps further means
//!   frames were missed: the lap in progress is lost (`LapReset(JoinedMidway)`) and the new one is joined where it is.
//! * A car that moves more than `TELEPORT_METRES` in one sample is not driving there: it was put back on the track or
//!   returned to the pits, and the lap in progress is dropped (`LapReset(Teleport)`), session unchanged.
//!
//! The lap time of a sample is the game's own lap clock (a clock coarser than the physics is carried on by the host
//! clock between its ticks, never further than one tick ahead), else the time since the lap's first frame. The
//! distance is the game's (never going back inside a lap), else the speed added up over the host clock.

use crate::game::{Frame, Phase};
use crate::lapfile::SessionKind;
use crate::util::new_session_id;

/// A longer silence between two frames is not integrated into distance.
pub const MAX_GAP_SECONDS: f64 = 0.5;
/// A first frame later than this into a lap means we joined mid-lap.
pub const PARTIAL_START_SECONDS: f64 = 1.5;
/// Without a lap clock, a first frame further than this along the lap means we joined mid-lap.
const PARTIAL_START_METRES: f64 = 60.0;
/// The slowest game lap clock tick that is carried on by the host clock between ticks (a 30 Hz clock).
const COARSE_CLOCK_SECONDS: f64 = 1.0 / 30.0;
/// The least `t` moves between two samples of a lap.
const MIN_T_STEP_SECONDS: f64 = 1e-3;
/// The lap clock going back by more than this on the same lap is a restart.
const RESTART_CLOCK_BACK_SECONDS: f64 = 1.0;
/// With the lap clock going back at all (by more than a tick), the game's distance going back by more than this is a
/// restart as well.
const RESTART_DIST_BACK_METRES: f64 = 50.0;
/// The lap clock moving back by up to this is jitter of the game's clock, not a restart.
const CLOCK_JITTER_SECONDS: f64 = 0.05;
/// A move of more than this in one sample (and more than the car's speed explains) is a teleport.
pub const TELEPORT_METRES: f64 = 200.0;
/// Time not driving (and not paused) after which the lap in progress is dropped.
pub const AWAY_SECONDS: f64 = 15.0;

/// Why the lap in progress was dropped without being closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResetReason {
    /// The lap clock (or the distance with it) went back: the player restarted.
    Restart,
    /// The car jumped: it was put back on the track or taken to the pits.
    Teleport,
    /// The lap number jumped ahead (frames were missed): the new lap is joined where it is.
    JoinedMidway,
    /// The player was away from the car (a menu, the garage, a replay) for longer than `AWAY_SECONDS`.
    Away,
}

/// Why a session ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndReason {
    CarChanged,
    TrackChanged,
    /// Practice gave way to qualifying, say.
    KindChanged,
    /// A restart (see `ResetReason::Restart`).
    Restart,
}

/// What a frame caused, in the order it happened.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    SessionStarted {
        id: String,
        kind: Option<SessionKind>,
    },
    /// A lap begins. `from_line`: this machine saw it begin (it follows a lap it saw end), so the whole lap can be
    /// recorded; false for a lap joined part way.
    LapStarted {
        number: i32,
        from_line: bool,
        in_pits: bool,
    },
    /// The lap in progress is dropped; no lap is made of it.
    LapReset {
        reason: ResetReason,
    },
    /// The lap in progress ended at the line; the next one begins right after (`LapStarted`).
    LapClosed {
        number: i32,
    },
    /// The session ended; the lap in progress went with it (no separate reset follows).
    SessionEnded {
        reason: EndReason,
    },
}

/// What a frame that is part of a lap adds to it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    /// Seconds into the lap.
    pub t_s: f64,
    /// Metres into the lap.
    pub dist_m: f64,
    /// Seconds since the lap's previous sample (0 for its first), at most `MAX_GAP_SECONDS`.
    pub dt_s: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Step {
    pub events: Vec<Event>,
    /// `Some` for a `Driving` frame, after the events it caused have been applied.
    pub sample: Option<Sample>,
}

struct LapRun {
    number: i32,
    first_clock: f64,
    last_clock: f64,
    /// The last `t` given, so a game clock coarser than the physics still gives a `t` that moves.
    last_t: f64,
    last_lap_time: Option<f64>,
    last_game_dist: Option<f64>,
    dist: f64,
    last_pos: Option<(f32, f32)>,
}

/// What a session is: its id and what is known of it.
#[derive(Default)]
pub struct Session {
    id: Option<String>,
    kind: Option<SessionKind>,
    car: String,
    track: String,
    variant: Option<String>,
    lap: Option<LapRun>,
    /// The clock of the first frame of the time spent away from driving.
    away_since: Option<f64>,
}

impl Session {
    pub fn new() -> Session {
        Session::default()
    }

    /// The id of the session being driven; `None` until the first driving frame.
    pub fn id(&self) -> Option<&str> {
        self.id.as_deref()
    }

    /// The kind of the session being driven, when the game said.
    pub fn kind(&self) -> Option<SessionKind> {
        self.kind
    }

    pub fn feed(&mut self, frame: &Frame) -> Step {
        let mut events = Vec::new();
        if !frame.driving {
            // A pause keeps the lap; anything else is time away from the car.
            if frame.phase == Phase::Paused {
                self.away_since = None;
            } else {
                let since = *self.away_since.get_or_insert(frame.clock_s);
                if frame.clock_s - since > AWAY_SECONDS {
                    self.drop_lap(ResetReason::Away, &mut events);
                }
            }
            return Step { events, sample: None };
        }
        if let Some(since) = self.away_since.take() {
            if frame.clock_s - since > AWAY_SECONDS {
                self.drop_lap(ResetReason::Away, &mut events);
            }
        }
        self.check_identity(frame, &mut events);
        self.check_lap(frame, &mut events);
        self.ensure_session(frame, &mut events);
        if self.lap.is_none() {
            // Joined: the first frame of a lap this machine did not see begin.
            let from_line = !joined_midway(frame);
            events.push(Event::LapStarted {
                number: frame.lap,
                from_line,
                in_pits: frame.in_pits,
            });
            self.lap = Some(LapRun::begin(frame));
        }
        let sample = self.lap.as_mut().map(|run| run.sample(frame));
        Step { events, sample }
    }

    fn drop_lap(&mut self, reason: ResetReason, events: &mut Vec<Event>) {
        if self.lap.take().is_some() {
            events.push(Event::LapReset { reason });
        }
    }

    fn end(&mut self, reason: EndReason, events: &mut Vec<Event>) {
        if self.id.take().is_some() {
            events.push(Event::SessionEnded { reason });
        }
        self.kind = None;
        self.lap = None;
    }

    /// A new car or track (or layout) ends the session; a name the game has not said yet is not a change.
    fn check_identity(&mut self, frame: &Frame, events: &mut Vec<Event>) {
        let car_changed = !frame.car.is_empty() && !self.car.is_empty() && frame.car != self.car;
        let track_changed = !frame.track.is_empty() && !self.track.is_empty() && frame.track != self.track;
        let layout_changed = matches!((&frame.track_variant, &self.variant), (Some(now), Some(before)) if now != before);
        if car_changed || track_changed || layout_changed {
            self.end(
                if car_changed {
                    EndReason::CarChanged
                } else {
                    EndReason::TrackChanged
                },
                events,
            );
            self.car.clear();
            self.track.clear();
            self.variant = None;
        }
        if self.car.is_empty() {
            self.car.clone_from(&frame.car);
        }
        if self.track.is_empty() {
            self.track.clone_from(&frame.track);
        }
        if self.variant.is_none() {
            self.variant.clone_from(&frame.track_variant);
        }
        // Another kind of session (practice, then qualifying) is another session; a game that says nothing for a
        // moment does not end one, and a kind said late is learned.
        if let (Some(_), Some(kind)) = (&self.id, frame.session_kind) {
            match self.kind {
                Some(before) if before != kind => {
                    self.end(EndReason::KindChanged, events);
                    // The car and the track go on being the same.
                    self.car.clone_from(&frame.car);
                    self.track.clone_from(&frame.track);
                    self.variant.clone_from(&frame.track_variant);
                }
                None => self.kind = Some(kind),
                _ => {}
            }
        }
    }

    /// Restarts, teleports and the lap number going up.
    fn check_lap(&mut self, frame: &Frame, events: &mut Vec<Event>) {
        let Some(run) = &self.lap else { return };
        let same_lap = frame.lap == run.number;
        let clock_back = same_lap
            && matches!((frame.lap_time_s, run.last_lap_time), (Some(now), Some(before)) if now + RESTART_CLOCK_BACK_SECONDS < before);
        let clock_went_back =
            same_lap && matches!((frame.lap_time_s, run.last_lap_time), (Some(now), Some(before)) if now + CLOCK_JITTER_SECONDS < before);
        let dist_back = same_lap
            && clock_went_back
            && matches!((frame.dist_m, run.last_game_dist), (Some(now), Some(before)) if now + RESTART_DIST_BACK_METRES < before);
        if frame.lap < run.number || clock_back || dist_back {
            // The lap in progress goes with the session it belonged to.
            self.drop_lap(ResetReason::Restart, events);
            self.end(EndReason::Restart, events);
            return;
        }
        if same_lap {
            if teleported(frame, run) {
                self.drop_lap(ResetReason::Teleport, events);
            }
            return;
        }
        let number = run.number;
        if frame.lap == number + 1 {
            events.push(Event::LapClosed { number });
            events.push(Event::LapStarted {
                number: frame.lap,
                from_line: true,
                in_pits: frame.in_pits,
            });
            self.lap = Some(LapRun::begin(frame));
        } else {
            // Frames were missed: this lap is joined where it is.
            self.drop_lap(ResetReason::JoinedMidway, events);
        }
    }

    fn ensure_session(&mut self, frame: &Frame, events: &mut Vec<Event>) {
        if self.id.is_none() {
            let id = new_session_id();
            self.id = Some(id.clone());
            self.kind = frame.session_kind;
            self.car.clone_from(&frame.car);
            self.track.clone_from(&frame.track);
            self.variant.clone_from(&frame.track_variant);
            events.push(Event::SessionStarted { id, kind: self.kind });
        }
    }
}

/// A first frame of a lap this machine did not see begin: well into it by the lap clock, else (no lap clock) by the
/// distance, else (neither) assumed to be.
fn joined_midway(frame: &Frame) -> bool {
    match frame.lap_time_s {
        Some(t) => t > PARTIAL_START_SECONDS,
        None => frame.dist_m.is_none_or(|d| d > PARTIAL_START_METRES),
    }
}

fn teleported(frame: &Frame, run: &LapRun) -> bool {
    let (Some((x, z)), true) = (run.last_pos, frame.x.is_finite() && frame.z.is_finite()) else {
        return false;
    };
    let jump = f64::from((frame.x - x).hypot(frame.z - z));
    let dt = (frame.clock_s - run.last_clock).clamp(0.0, 30.0);
    let reach = f64::from(frame.speed_ms.max(0.0)) * dt * 2.0 + 50.0;
    jump > TELEPORT_METRES && jump > reach
}

impl LapRun {
    fn begin(frame: &Frame) -> LapRun {
        LapRun {
            number: frame.lap,
            first_clock: frame.clock_s,
            last_clock: frame.clock_s,
            last_t: f64::NEG_INFINITY,
            last_lap_time: None,
            last_game_dist: None,
            dist: 0.0,
            last_pos: None,
        }
    }

    fn sample(&mut self, frame: &Frame) -> Sample {
        let dt = (frame.clock_s - self.last_clock).clamp(0.0, MAX_GAP_SECONDS);
        let t = match frame.lap_time_s {
            // A game clock that has not moved past the last `t` (it ticks slower than the physics) is carried on by the
            // host clock, never further than one tick of the game clock (1/30 s at most) ahead of what the game says.
            Some(game) if game <= self.last_t => (self.last_t + dt)
                .min(game + COARSE_CLOCK_SECONDS - MIN_T_STEP_SECONDS)
                .max(self.last_t + MIN_T_STEP_SECONDS),
            Some(game) => game,
            None => frame.clock_s - self.first_clock,
        };
        self.last_t = t;
        self.dist = match frame.dist_m {
            // Never backwards inside a lap, whatever the game says (a distance that wraps at the line before the lap
            // number does).
            Some(d) => {
                self.last_game_dist = Some(d);
                d.max(0.0).max(self.dist)
            }
            None => self.dist + f64::from(frame.speed_ms.max(0.0)) * dt,
        };
        self.last_clock = frame.clock_s;
        self.last_lap_time = frame.lap_time_s;
        if frame.x.is_finite() && frame.z.is_finite() {
            self.last_pos = Some((frame.x, frame.z));
        }
        Sample {
            t_s: t,
            dist_m: self.dist,
            dt_s: dt,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(clock: f64, lap: i32, lap_time: Option<f64>, dist: Option<f64>) -> Frame {
        let mut f = Frame::empty();
        f.clock_s = clock;
        f.set_phase(Phase::Driving);
        f.lap = lap;
        f.lap_time_s = lap_time;
        f.dist_m = dist;
        f.speed_ms = 50.0;
        f.car = "Car".into();
        f.track = "Track".into();
        f
    }

    /// `seconds` of lap `lap` at 20 Hz from clock `from`, the lap clock starting at `t0`; returns every event.
    fn drive(s: &mut Session, from: f64, lap: i32, t0: f64, seconds: f64) -> (Vec<Event>, f64) {
        let mut events = Vec::new();
        let mut clock = from;
        for i in 0..(seconds * 20.0) as usize {
            let t = t0 + i as f64 / 20.0;
            events.extend(s.feed(&frame(clock, lap, Some(t), Some(t * 50.0))).events);
            clock += 0.05;
        }
        (events, clock)
    }

    fn kinds(events: &[Event]) -> Vec<&'static str> {
        events
            .iter()
            .map(|e| match e {
                Event::SessionStarted { .. } => "started",
                Event::LapStarted { from_line: true, .. } => "lap",
                Event::LapStarted { from_line: false, .. } => "lap-joined",
                Event::LapReset {
                    reason: ResetReason::Restart,
                } => "reset-restart",
                Event::LapReset {
                    reason: ResetReason::Teleport,
                } => "reset-teleport",
                Event::LapReset {
                    reason: ResetReason::JoinedMidway,
                } => "reset-joined",
                Event::LapReset { reason: ResetReason::Away } => "reset-away",
                Event::LapClosed { .. } => "closed",
                Event::SessionEnded { .. } => "ended",
            })
            .collect()
    }

    #[test]
    fn the_first_frame_starts_a_session_and_a_lap_and_a_lap_number_up_closes_one() {
        let mut s = Session::new();
        let first = s.feed(&frame(0.0, 1, Some(0.0), Some(0.0)));
        assert_eq!(kinds(&first.events), ["started", "lap"]);
        assert_eq!(
            first.sample,
            Some(Sample {
                t_s: 0.0,
                dist_m: 0.0,
                dt_s: 0.0
            })
        );
        let id = s.id().unwrap().to_owned();
        assert_eq!(id.len(), 32);
        let (events, clock) = drive(&mut s, 0.05, 1, 0.05, 10.0);
        assert!(events.is_empty(), "nothing happens inside a lap");
        let next = s.feed(&frame(clock, 2, Some(0.0), Some(0.0)));
        assert_eq!(kinds(&next.events), ["closed", "lap"]);
        assert_eq!(next.events[0], Event::LapClosed { number: 1 });
        assert_eq!(s.id(), Some(id.as_str()), "the same session");
    }

    #[test]
    fn a_lap_joined_midway_is_said_so_and_one_that_follows_a_lap_seen_to_end_is_not() {
        let mut s = Session::new();
        let first = s.feed(&frame(0.0, 3, Some(17.0), Some(900.0)));
        assert_eq!(kinds(&first.events), ["started", "lap-joined"]);
        let next = s.feed(&frame(1.0, 4, Some(0.0), Some(0.0)));
        assert_eq!(kinds(&next.events), ["closed", "lap"]);
        // Without a lap clock: the distance says; with neither it is assumed joined.
        let mut s = Session::new();
        assert_eq!(kinds(&s.feed(&frame(0.0, 1, None, Some(10.0))).events), ["started", "lap"]);
        let mut s = Session::new();
        assert_eq!(kinds(&s.feed(&frame(0.0, 1, None, None)).events), ["started", "lap-joined"]);
    }

    #[test]
    fn the_lap_clock_going_back_on_the_same_lap_is_a_restart_and_a_new_session() {
        let mut s = Session::new();
        let (_, clock) = drive(&mut s, 0.0, 1, 0.0, 20.0);
        let before = s.id().unwrap().to_owned();
        let step = s.feed(&frame(clock, 1, Some(0.5), Some(25.0)));
        assert_eq!(kinds(&step.events), ["reset-restart", "ended", "started", "lap"]);
        assert_ne!(s.id().unwrap(), before);
        assert_eq!(step.sample.unwrap().dist_m, 25.0, "the lap begins again from here");
    }

    #[test]
    fn the_lap_number_going_back_is_a_restart() {
        let mut s = Session::new();
        let (_, clock) = drive(&mut s, 0.0, 4, 0.0, 20.0);
        let step = s.feed(&frame(clock, 1, Some(0.0), Some(0.0)));
        assert_eq!(kinds(&step.events), ["reset-restart", "ended", "started", "lap"]);
    }

    #[test]
    fn a_restart_that_keeps_the_lap_number_and_the_clock_is_seen_by_the_distance_going_back() {
        // The clock goes back by half a second only (less than the restart threshold), but the distance by 400 m.
        let mut s = Session::new();
        let (_, clock) = drive(&mut s, 0.0, 1, 0.0, 20.0);
        let step = s.feed(&frame(clock, 1, Some(19.5), Some(600.0)));
        assert_eq!(kinds(&step.events)[..2], ["reset-restart", "ended"]);
        // The distance wrapping at the line while the lap clock goes on is not one.
        let mut s = Session::new();
        let (_, clock) = drive(&mut s, 0.0, 1, 0.0, 20.0);
        let step = s.feed(&frame(clock, 1, Some(20.0), Some(3.0)));
        assert!(step.events.is_empty(), "{:?}", step.events);
        assert_eq!(step.sample.unwrap().dist_m, 997.5, "and the distance holds where it was");
    }

    #[test]
    fn a_lap_number_that_jumps_ahead_loses_the_lap_but_not_the_session() {
        let mut s = Session::new();
        let (_, clock) = drive(&mut s, 0.0, 1, 0.0, 10.0);
        let id = s.id().unwrap().to_owned();
        let step = s.feed(&frame(clock, 3, Some(0.0), Some(0.0)));
        assert_eq!(kinds(&step.events), ["reset-joined", "lap"]);
        assert_eq!(s.id(), Some(id.as_str()));
    }

    #[test]
    fn a_car_that_jumps_is_a_teleport_and_one_that_is_just_fast_is_not() {
        let at = |clock: f64, x: f32, speed: f32| {
            let mut f = frame(clock, 1, Some(clock), Some(clock * 50.0));
            (f.x, f.z, f.speed_ms) = (x, 0.0, speed);
            f
        };
        let mut s = Session::new();
        s.feed(&at(0.0, 0.0, 80.0));
        // 5 m in a sample, then 100 m at 0.05 s and 80 m/s (4 m): too far for the speed but under the threshold.
        assert!(s.feed(&at(0.05, 5.0, 80.0)).events.is_empty());
        assert!(s.feed(&at(0.10, 105.0, 80.0)).events.is_empty());
        // 600 m in one sample.
        let step = s.feed(&at(0.15, 705.0, 80.0));
        assert_eq!(kinds(&step.events), ["reset-teleport", "lap"]);
        // A frame gap of 3 s at 80 m/s is 240 m: the speed explains it.
        let mut s = Session::new();
        s.feed(&at(0.0, 0.0, 80.0));
        assert!(s.feed(&at(3.0, 240.0, 80.0)).events.is_empty());
    }

    #[test]
    fn a_new_car_track_layout_or_kind_ends_the_session() {
        let mut s = Session::new();
        let mut f = frame(0.0, 1, Some(0.0), Some(0.0));
        f.session_kind = Some(SessionKind::Practice);
        s.feed(&f);
        let id = s.id().unwrap().to_owned();
        // Saying nothing about the kind does not end it; the same kind neither.
        f.clock_s = 0.05;
        f.session_kind = None;
        assert!(s.feed(&f).events.is_empty());
        f.session_kind = Some(SessionKind::Practice);
        f.clock_s = 0.1;
        assert!(s.feed(&f).events.is_empty());
        f.session_kind = Some(SessionKind::Qualifying);
        f.clock_s = 0.15;
        let step = s.feed(&f);
        assert_eq!(kinds(&step.events), ["ended", "started", "lap"]);
        assert!(matches!(
            step.events[0],
            Event::SessionEnded {
                reason: EndReason::KindChanged
            }
        ));
        assert_ne!(s.id().unwrap(), id);
        assert_eq!(s.kind(), Some(SessionKind::Qualifying));
        let id = s.id().unwrap().to_owned();
        f.car = "Another".into();
        f.clock_s = 0.2;
        assert!(matches!(
            s.feed(&f).events[0],
            Event::SessionEnded {
                reason: EndReason::CarChanged
            }
        ));
        f.track = "Elsewhere".into();
        f.clock_s = 0.25;
        assert!(matches!(
            s.feed(&f).events[0],
            Event::SessionEnded {
                reason: EndReason::TrackChanged
            }
        ));
        f.track_variant = Some("A".into());
        f.clock_s = 0.3;
        assert!(s.feed(&f).events.is_empty(), "a layout said for the first time is not a change");
        f.track_variant = Some("B".into());
        f.clock_s = 0.35;
        assert!(matches!(s.feed(&f).events[0], Event::SessionEnded { .. }));
        assert_ne!(s.id().unwrap(), id);
    }

    #[test]
    fn a_name_the_game_has_not_said_yet_is_not_a_change() {
        let mut s = Session::new();
        let mut f = frame(0.0, 1, Some(0.0), Some(0.0));
        (f.car, f.track) = (String::new(), String::new());
        s.feed(&f);
        f.clock_s = 0.05;
        f.car = "Car".into();
        f.track = "Track".into();
        assert!(s.feed(&f).events.is_empty());
        f.clock_s = 0.1;
        f.car = String::new();
        assert!(s.feed(&f).events.is_empty(), "and one that goes missing is not either");
    }

    #[test]
    fn a_pause_keeps_the_lap_and_a_long_time_away_drops_it_but_not_the_session() {
        let mut s = Session::new();
        let (_, clock) = drive(&mut s, 0.0, 1, 0.0, 10.0);
        let id = s.id().unwrap().to_owned();
        // A pause of a minute: the lap and the distance stand, and the gap is not driven.
        let mut paused = frame(clock, 1, Some(10.0), None);
        paused.set_phase(Phase::Paused);
        for i in 0..10 {
            paused.clock_s = clock + f64::from(i) * 6.0;
            let step = s.feed(&paused);
            assert!(step.events.is_empty() && step.sample.is_none());
        }
        let back = s.feed(&frame(clock + 60.0, 1, Some(10.05), None));
        assert!(back.events.is_empty());
        assert!(back.sample.unwrap().dt_s <= MAX_GAP_SECONDS);
        // A menu for a few seconds keeps it too; a menu for a minute drops it.
        let mut menu = frame(clock + 61.0, 1, None, None);
        menu.set_phase(Phase::Menu);
        assert!(s.feed(&menu).events.is_empty());
        menu.clock_s += 5.0;
        assert!(s.feed(&menu).events.is_empty());
        let back = s.feed(&frame(clock + 70.0, 1, Some(10.5), None));
        assert!(back.events.is_empty(), "back after 9 s: the lap goes on");
        for phase in [Phase::Garage, Phase::Replay, Phase::Spectating, Phase::Loading, Phase::Unknown] {
            let mut s = Session::new();
            let (_, clock) = drive(&mut s, 0.0, 1, 0.0, 10.0);
            let mut away = frame(clock, 1, None, None);
            away.set_phase(phase);
            assert!(s.feed(&away).events.is_empty());
            away.clock_s += AWAY_SECONDS + 1.0;
            assert_eq!(kinds(&s.feed(&away).events), ["reset-away"], "{phase:?}");
            assert!(s.id().is_some(), "{phase:?}: the session is not over");
            // Coming back: the lap is joined where the car is.
            let back = s.feed(&frame(away.clock_s + 1.0, 1, Some(40.0), Some(2000.0)));
            assert_eq!(kinds(&back.events), ["lap-joined"], "{phase:?}");
        }
        assert_eq!(s.id(), Some(id.as_str()));
    }

    #[test]
    fn a_source_that_goes_quiet_in_a_menu_and_comes_back_late_loses_the_lap_too() {
        let mut s = Session::new();
        let (_, clock) = drive(&mut s, 0.0, 1, 0.0, 10.0);
        let mut menu = frame(clock, 1, None, None);
        menu.set_phase(Phase::Menu);
        s.feed(&menu);
        // No frame for a minute (the game wrote nothing), then driving again.
        let back = s.feed(&frame(clock + 60.0, 1, Some(10.5), Some(600.0)));
        assert_eq!(kinds(&back.events), ["reset-away", "lap-joined"]);
    }

    #[test]
    fn the_samples_are_the_games_clock_and_distance_else_the_host_clock_and_the_speed() {
        let mut s = Session::new();
        // No lap clock, no distance: both are measured, from 50 m/s over a host clock.
        let mut last = Sample {
            t_s: 0.0,
            dist_m: 0.0,
            dt_s: 0.0,
        };
        for i in 0..200 {
            last = s.feed(&frame(f64::from(i) * 0.05, 1, None, None)).sample.unwrap();
        }
        assert!((last.t_s - 9.95).abs() < 1e-9);
        assert!((last.dist_m - 497.5).abs() < 1e-6, "{}", last.dist_m);
        // A silence is not integrated.
        let after = s.feed(&frame(100.0, 1, None, None)).sample.unwrap();
        assert!((after.dist_m - last.dist_m - 25.0).abs() < 1e-6, "0.5 s at most");
    }

    #[test]
    fn a_game_clock_slower_than_the_physics_still_gives_a_t_that_moves() {
        let mut s = Session::new();
        let (tick, step) = (1.0 / 60.0, 1.0 / 97.0);
        let mut ts = Vec::new();
        for i in 0..(30.0 / step) as usize {
            let clock = i as f64 * step;
            let game = (clock / tick + 1e-9).floor() * tick;
            ts.push((s.feed(&frame(clock, 1, Some(game), None)).sample.unwrap().t_s, game));
        }
        assert!(ts.windows(2).all(|w| w[1].0 > w[0].0), "strictly increasing");
        assert!(ts.iter().all(|(t, g)| (t - g).abs() <= 1.0 / 30.0 + 1e-6));
    }
}
