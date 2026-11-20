//! Live layout state. Only validated simulator geometry reaches the track card.
//! Extraction and file validation run on the native-track worker.

use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use crate::game::{Frame, Phase};
use crate::perspective::{Point, PreparedPath, Road};
use crate::tracks::auto::{self, Request, Seen, SourceFailure, SourceResult};
use crate::tracks::Track;

#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    pub path: Arc<PreparedPath>,
    pub road: Option<Arc<Road>>,
}

impl Layout {
    /// Called on the worker, after the source and its complete XTRK payload have been validated.
    pub fn from_track(track: &Track) -> Option<Self> {
        let (x, z) = (&track.centerline.x, &track.centerline.z);
        if x.len() < 2 || x.len() != z.len() || x.iter().chain(z).any(|p| !p.is_finite()) {
            return None;
        }
        let points: Vec<Point> = x.iter().copied().zip(z.iter().copied()).collect();
        let path = PreparedPath::native(&points, track.closed);
        if path.is_empty() {
            return None;
        }
        Some(Self {
            path: Arc::new(path),
            road: Road::from_track(track).map(Arc::new),
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum LayoutView {
    #[default]
    WaitingForIdentity,
    Loading,
    Unavailable,
    Invalid,
    Retrying,
    Ready(Layout),
}

/// A lookup belongs to one active simulator/track/variant, independently of laps, cars and sessions.
/// Each request has its own reply channel. Changing identities drops the old receiver, including A → B → A.
#[derive(Default)]
pub(crate) struct Lookup {
    key: Option<Seen>,
    reply: Option<mpsc::Receiver<SourceResult>>,
    view: LayoutView,
    retry_at: Option<Instant>,
    retries: usize,
    phase: Phase,
}

const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(8)];

fn has_session_identity(phase: Phase) -> bool {
    matches!(phase, Phase::Driving | Phase::Paused | Phase::Garage | Phase::Loading)
}

impl Lookup {
    pub(crate) fn current(&self) -> Option<(&Seen, &LayoutView)> {
        Some((self.key.as_ref()?, &self.view))
    }

    pub(crate) fn view(&self) -> &LayoutView {
        &self.view
    }

    pub(crate) fn observe(&mut self, worker: Option<&mpsc::Sender<Request>>, game: &str, frame: &Frame, now: Instant) {
        let track = frame.track.as_str();
        let variant = frame.track_variant.as_deref();
        if track.trim().is_empty() {
            *self = Self::default();
            return;
        }
        if self
            .key
            .as_ref()
            .is_none_or(|key| (key.game.as_str(), key.track.as_str(), key.variant.as_deref()) != (game, track, variant))
        {
            *self = Self {
                key: Some(Seen {
                    game: game.into(),
                    track: track.into(),
                    variant: variant.map(str::to_owned),
                }),
                ..Self::default()
            };
        }
        if worker.is_none() || (game != "acevo" && auto::file_game(game).is_none()) {
            self.view = LayoutView::Unavailable;
            return;
        }
        let phase = if frame.driving { Phase::Driving } else { frame.phase };
        let new_session = !has_session_identity(self.phase) || (phase == Phase::Loading && self.phase != phase);
        self.phase = phase;
        // Menus and replays can still expose a previous session's static identity.
        if has_session_identity(phase)
            && (matches!(self.view, LayoutView::WaitingForIdentity)
                || (new_session && self.retry_at.is_none() && matches!(self.view, LayoutView::Unavailable | LayoutView::Invalid)))
        {
            self.retries = 0;
            self.request(worker);
        }
        self.poll(worker, now);
    }

    /// Nonblocking and safe to call even when the source is between packets.
    /// The caller can refresh just the layout in the published snapshot.
    pub(crate) fn poll(&mut self, worker: Option<&mpsc::Sender<Request>>, now: Instant) -> bool {
        let result = self.reply.as_ref().and_then(|reply| match reply.try_recv() {
            Ok(result) => Some(result),
            Err(mpsc::TryRecvError::Disconnected) => Some(Err(SourceFailure::Retryable("layout worker disconnected".into()))),
            Err(mpsc::TryRecvError::Empty) => None,
        });
        if let Some(result) = result {
            self.reply = None;
            self.view = match result {
                Ok(layout) => LayoutView::Ready(layout),
                Err(SourceFailure::Invalid(_)) => LayoutView::Invalid,
                Err(SourceFailure::Unavailable(_)) => {
                    self.schedule_retry(now);
                    LayoutView::Unavailable
                }
                Err(SourceFailure::Retryable(_)) => {
                    self.schedule_retry(now);
                    if self.retry_at.is_some() {
                        LayoutView::Retrying
                    } else {
                        LayoutView::Unavailable
                    }
                }
            };
            return true;
        }
        if self.retry_at.is_some_and(|retry_at| now >= retry_at) {
            self.retry_at = None;
            self.request(worker);
            return true;
        }
        false
    }

    fn schedule_retry(&mut self, now: Instant) {
        self.retry_at = RETRY_DELAYS.get(self.retries).map(|&delay| now + delay);
        self.retries += 1;
    }

    fn request(&mut self, worker: Option<&mpsc::Sender<Request>>) {
        let (Some(worker), Some(seen)) = (worker, self.key.clone()) else {
            self.view = LayoutView::Unavailable;
            return;
        };
        let (reply, receiver) = mpsc::channel();
        if worker.send(Request { seen, reply }).is_ok() {
            self.reply = Some(receiver);
            self.view = LayoutView::Loading;
        } else {
            self.view = LayoutView::Unavailable;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(track: &str, variant: &str, phase: Phase) -> Frame {
        let mut frame = Frame::empty();
        frame.track = track.into();
        frame.track_variant = Some(variant.into());
        frame.set_phase(phase);
        frame
    }

    fn layout() -> Layout {
        Layout {
            path: Arc::new(PreparedPath::native(&[(0.0, 0.0), (0.0, 10.0)], false)),
            road: None,
        }
    }

    #[test]
    fn trusted_identity_starts_while_parked_and_readiness_needs_no_lap() {
        let mut lookup = Lookup::default();
        let (worker, requests) = mpsc::channel();
        let now = Instant::now();
        let mut frame = identity("park", "gp", Phase::Menu);
        lookup.observe(Some(&worker), "ac", &frame, now);
        assert_eq!(lookup.view(), &LayoutView::WaitingForIdentity);
        assert!(requests.try_recv().is_err(), "menu metadata may belong to the previous session");

        frame.set_phase(Phase::Garage);
        lookup.observe(Some(&worker), "ac", &frame, now);
        assert_eq!(lookup.view(), &LayoutView::Loading);
        let request = requests.try_recv().unwrap();
        assert_eq!(request.seen.variant.as_deref(), Some("gp"));
        assert_eq!(frame.lap, 0);
        request.reply.send(Ok(layout())).unwrap();
        assert!(lookup.poll(Some(&worker), now));
        assert!(matches!(lookup.view(), LayoutView::Ready(_)));
        assert!(!lookup.poll(Some(&worker), now));
    }

    #[test]
    fn switching_variants_drops_stale_replies_even_when_returning_to_the_previous_variant() {
        let mut lookup = Lookup::default();
        let (worker, requests) = mpsc::channel();
        let now = Instant::now();
        let gp = identity("park", "gp", Phase::Driving);
        let club = identity("park", "club", Phase::Driving);
        lookup.observe(Some(&worker), "ac", &gp, now);
        let pending_gp = requests.try_recv().unwrap();
        lookup.observe(Some(&worker), "ac", &club, now);
        let pending_club = requests.try_recv().unwrap();
        lookup.observe(Some(&worker), "ac", &gp, now);
        let active = requests.try_recv().unwrap();
        assert!(pending_gp.reply.send(Ok(layout())).is_err());
        assert!(pending_club.reply.send(Ok(layout())).is_err());
        assert_eq!(lookup.view(), &LayoutView::Loading);
        active.reply.send(Ok(layout())).unwrap();
        assert!(lookup.poll(Some(&worker), now));
        assert!(matches!(lookup.view(), LayoutView::Ready(_)));
    }

    #[test]
    fn transient_worker_failures_retry_at_bounded_intervals_and_invalid_geometry_is_refused() {
        let mut lookup = Lookup::default();
        let (worker, requests) = mpsc::channel();
        let now = Instant::now();
        let frame = identity("park", "gp", Phase::Paused);
        lookup.observe(Some(&worker), "ac", &frame, now);
        drop(requests.try_recv().unwrap());
        assert!(lookup.poll(Some(&worker), now));
        assert_eq!(lookup.view(), &LayoutView::Retrying);
        assert!(!lookup.poll(Some(&worker), now + Duration::from_secs(1)));
        let first_retry = now + RETRY_DELAYS[0];
        assert!(lookup.poll(Some(&worker), first_retry));
        requests
            .try_recv()
            .unwrap()
            .reply
            .send(Err(SourceFailure::Unavailable("no source".into())))
            .unwrap();
        lookup.poll(Some(&worker), first_retry);
        assert_eq!(lookup.view(), &LayoutView::Unavailable);
        let last_retry = first_retry + RETRY_DELAYS[1];
        assert!(lookup.poll(Some(&worker), last_retry));
        requests
            .try_recv()
            .unwrap()
            .reply
            .send(Err(SourceFailure::Retryable("game files changed".into())))
            .unwrap();
        lookup.poll(Some(&worker), last_retry);
        assert_eq!(lookup.view(), &LayoutView::Unavailable);
        assert!(!lookup.poll(Some(&worker), last_retry + Duration::from_secs(60)));

        let next = identity("park", "short", Phase::Paused);
        lookup.observe(Some(&worker), "ac", &next, now);
        requests
            .try_recv()
            .unwrap()
            .reply
            .send(Err(SourceFailure::Invalid("corrupt source".into())))
            .unwrap();
        lookup.poll(Some(&worker), now);
        assert_eq!(lookup.view(), &LayoutView::Invalid);
        assert!(!lookup.poll(Some(&worker), last_retry));

        let mut reenter = next;
        reenter.set_phase(Phase::Menu);
        lookup.observe(Some(&worker), "ac", &reenter, last_retry);
        reenter.set_phase(Phase::Garage);
        lookup.observe(Some(&worker), "ac", &reenter, last_retry);
        requests.try_recv().unwrap().reply.send(Ok(layout())).unwrap();
        assert!(lookup.poll(Some(&worker), last_retry));
        assert!(matches!(lookup.view(), LayoutView::Ready(_)));
    }
}
