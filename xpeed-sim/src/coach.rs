//! Optional session coach for the paired Companion. This module does no work
//! on a reader, recorder, or uploader thread.

use std::fmt::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

use crate::config::{self, Config};
use crate::net::{
    self, CoachAnswer, CoachError, CoachHistory, CoachMessage, CoachPending, CoachQuestion, CoachRole, CoachSession,
};
use crate::speech::{self, SpeechError, SpeechRequest, SpeechResult};
use crate::text::Lang;
use crate::util::lock;

mod dialog;
mod process_job;
pub(crate) use dialog::{close, show};

const MAX_MESSAGES: usize = 12;
const PAIR_POLL: Duration = Duration::from_millis(300);
static HTTP_BUSY: AtomicBool = AtomicBool::new(false);
static SPEECH_BUSY: AtomicBool = AtomicBool::new(false);

/// The UI can see this public part of the binding. The bearer and its
/// fingerprint stay inside the workers.
#[derive(Clone, Default)]
struct PublicPairing {
    revision: u64,
    server: Option<String>,
}

#[derive(Default)]
struct PairingRecord {
    public: PublicPairing,
    fingerprint: Option<String>,
}

#[derive(Clone)]
struct PairingSource {
    path: PathBuf,
    record: Arc<Mutex<PairingRecord>>,
}

impl PairingSource {
    fn matches(&self, revision: u64, config: &Config) -> bool {
        let fingerprint = net::sha256_hex(config.token.as_bytes());
        let pairing = lock(&self.record);
        pairing.public.revision == revision
            && pairing.public.server.as_deref() == Some(config.server.as_str())
            && pairing.fingerprint.as_deref() == Some(fingerprint.as_str())
    }
}

struct PairingWatch {
    source: PairingSource,
    stopped: Arc<AtomicBool>,
}

impl PairingWatch {
    fn start(path: PathBuf) -> std::io::Result<Self> {
        let source = PairingSource { path, record: Arc::new(Mutex::new(PairingRecord::default())) };
        let stopped = Arc::new(AtomicBool::new(false));
        let (worker_source, worker_stopped) = (source.clone(), stopped.clone());
        thread::Builder::new().name("coach-pairing".into()).spawn(move || {
            let mut checked = None;
            while !worker_stopped.load(Ordering::Acquire) {
                let stamp = std::fs::metadata(&worker_source.path).ok().map(|metadata| {
                    (metadata.modified().ok().unwrap_or(UNIX_EPOCH), metadata.len())
                });
                if checked != Some(stamp) {
                    let config = config::load(&worker_source.path).ok().flatten();
                    let fingerprint = config.as_ref().map(|config| net::sha256_hex(config.token.as_bytes()));
                    let server = config.map(|config| config.server);
                    if worker_stopped.load(Ordering::Acquire) {
                        break;
                    }
                    let mut entry = lock(&worker_source.record);
                    if entry.public.revision == 0 || entry.fingerprint != fingerprint || entry.public.server != server {
                        entry.public.revision = entry.public.revision.wrapping_add(1);
                        entry.public.server = server;
                        entry.fingerprint = fingerprint;
                    }
                    checked = Some(stamp);
                }
                thread::sleep(PAIR_POLL);
            }
        })?;
        Ok(Self { source, stopped })
    }

    fn status(&self) -> Option<PublicPairing> {
        self.source.record.try_lock().ok().map(|pairing| pairing.public.clone())
    }
}

impl Drop for PairingWatch {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

struct WorkSlot(&'static AtomicBool);

impl WorkSlot {
    fn acquire(busy: &'static AtomicBool) -> Option<Self> {
        busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).ok().map(|()| Self(busy))
    }
}

impl Drop for WorkSlot {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Clone)]
enum CoachRequest {
    Sessions,
    History(String),
    Ask(CoachQuestion),
}

enum CoachResult {
    Sessions(Vec<CoachSession>),
    History(CoachHistory),
    Answer(CoachAnswer),
}

enum NetworkEvent {
    ChangedPairing,
    Finished(Result<CoachResult, CoachError>),
}

#[derive(Clone, Copy)]
enum StartError {
    Busy,
    Unavailable,
}

struct NetworkJob {
    request: CoachRequest,
    results: mpsc::Receiver<NetworkEvent>,
    generation: u64,
}

impl NetworkJob {
    fn start(
        request: CoachRequest, pairing: PairingSource, revision: u64, scope: Arc<AtomicU64>,
    ) -> Result<Self, StartError> {
        let slot = WorkSlot::acquire(&HTTP_BUSY).ok_or(StartError::Busy)?;
        let (sender, results) = mpsc::sync_channel(1);
        let generation = scope.load(Ordering::Acquire);
        let worker_request = request.clone();
        thread::Builder::new().name("coach-http".into()).spawn(move || {
            let current = || scope.load(Ordering::Acquire) == generation;
            let run = || {
                // Binding is checked before transmitting and once more
                // after the request, independent of the polling UI.
                if !current() {
                    return NetworkEvent::ChangedPairing;
                }
                let Some(config) = config::load(&pairing.path).ok().flatten() else {
                    return NetworkEvent::ChangedPairing;
                };
                if !current() || !pairing.matches(revision, &config) {
                    return NetworkEvent::ChangedPairing;
                }
                let agent = net::coach_agent();
                let may_send = || current() && pairing.matches(revision, &config);
                if !may_send() {
                    return NetworkEvent::ChangedPairing;
                }
                let result = match &worker_request {
                    CoachRequest::Sessions => net::coach_sessions(&agent, &config).map(CoachResult::Sessions),
                    CoachRequest::History(id) => net::coach_history(&agent, &config, id).map(CoachResult::History),
                    CoachRequest::Ask(question) => net::coach_ask(&agent, &config, question, may_send).map(CoachResult::Answer),
                };
                if !current() { return NetworkEvent::ChangedPairing; }
                match config::load(&pairing.path).ok().flatten() {
                    Some(latest) if pairing.matches(revision, &latest) => NetworkEvent::Finished(result),
                    _ => NetworkEvent::ChangedPairing,
                }
            };
            let result = run();
            drop(slot);
            if current() {
                let _ = sender.send(result);
            }
        }).map_err(|_| StartError::Unavailable)?;
        Ok(Self { request, results, generation })
    }
}

struct SpeechJob {
    cancelled: Arc<AtomicBool>,
    results: mpsc::Receiver<Result<SpeechResult, SpeechError>>,
    generation: u64,
}

impl SpeechJob {
    fn start(request: SpeechRequest, generation: u64) -> Result<Self, StartError> {
        let slot = WorkSlot::acquire(&SPEECH_BUSY).ok_or(StartError::Busy)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = cancelled.clone();
        let (sender, results) = mpsc::sync_channel(1);
        thread::Builder::new().name("coach-speech".into()).spawn(move || {
            let result = speech::run(request, worker_cancelled.clone(), process_job::assign);
            drop(slot);
            if !worker_cancelled.load(Ordering::Acquire) {
                let _ = sender.send(result);
            }
        }).map_err(|_| StartError::Unavailable)?;
        Ok(Self { cancelled, results, generation })
    }
}

impl Drop for SpeechJob {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

fn locales(lang: Lang) -> (&'static str, &'static str) {
    match lang {
        Lang::En => ("en", "en-US"),
        Lang::Pt => ("pt-BR", "pt-BR"),
        Lang::Es => ("es-ES", "es-ES"),
    }
}

fn make_v4(bytes: [u8; 16]) -> String {
    let mut bytes = bytes;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut id = String::with_capacity(36);
    for (i, byte) in bytes.into_iter().enumerate() {
        if matches!(i, 4 | 6 | 8 | 10) { id.push('-'); }
        let _ = write!(id, "{byte:02x}");
    }
    id
}

fn question_key() -> Option<String> {
    let mut bytes = [0; 16];
    crate::connect::fill_random(&mut bytes).ok()?;
    Some(make_v4(bytes))
}

#[derive(Default)]
struct UncertainQuestions(Vec<CoachQuestion>);

fn same_draft(first: &str, second: &str) -> bool {
    // The edit control can convert LF to CRLF. Compare the visual draft
    // while retaining the exact server-saved string in the retry payload.
    let normalize = |text: &str| text.trim().replace("\r\n", "\n").replace('\r', "\n");
    first == second || normalize(first) == normalize(second)
}

impl UncertainQuestions {
    fn find(&self, session: &str, message: &str) -> Option<CoachQuestion> {
        self.0.iter().find(|question| question.session_id == session && same_draft(&question.message, message)).cloned()
    }

    fn remember(&mut self, question: CoachQuestion) {
        self.0.retain(|previous| {
            previous.idempotency_key != question.idempotency_key
                && (previous.session_id != question.session_id || !same_draft(&previous.message, &question.message))
        });
        if self.0.len() == MAX_MESSAGES { self.0.remove(0); }
        self.0.push(question);
    }

    fn restore(&mut self, session_id: String, pending: CoachPending, lang: Lang) -> String {
        let message = pending.message.clone();
        self.remember(CoachQuestion {
            session_id,
            conversation_id: Some(pending.conversation_id),
            message: pending.message,
            idempotency_key: pending.idempotency_key,
            language: locales(lang).0,
        });
        message
    }

    fn forget(&mut self, key: &str) {
        self.0.retain(|question| question.idempotency_key != key);
    }

    fn after_failure(&mut self, question: CoachQuestion, error: CoachError) {
        match error {
            CoachError::Pending | CoachError::DeliveryUnknown => self.remember(question),
            // The server has resolved this ID, so the next deliberate Send
            // may start a new request. Limits or other errors while checking
            // an older ID do not establish what happened to its first send.
            CoachError::Failed => self.forget(&question.idempotency_key),
            _ => {}
        }
    }
}

struct Conversation {
    session_id: String,
    history: Option<CoachHistory>,
}

impl Conversation {
    fn last_answer(&self) -> Option<&str> {
        self.history.as_ref()?.messages.iter().rev()
            .find(|message| message.role == CoachRole::Assistant)
            .map(|message| message.content.as_str())
    }

    fn answer(&mut self, question: CoachQuestion, answer: CoachAnswer, was_retry: bool) {
        let Some(history) = &mut self.history else { return };
        history.conversation_id = Some(answer.conversation_id);
        // Refresh may already have loaded the two lines of a confirmed request.
        let already_shown = was_retry && history.messages.windows(2).any(|pair| {
            pair[0].role == CoachRole::User && pair[0].content == question.message
                && pair[1].role == CoachRole::Assistant && pair[1].content == answer.reply
        });
        if !already_shown {
            history.messages.push(CoachMessage { role: CoachRole::User, content: question.message });
            history.messages.push(CoachMessage { role: CoachRole::Assistant, content: answer.reply });
            let excess = history.messages.len().saturating_sub(MAX_MESSAGES);
            history.messages.drain(..excess);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_rfc4122_idempotency_keys_and_the_panel_language() {
        assert_eq!(make_v4([0; 16]), "00000000-0000-4000-8000-000000000000");
        assert_eq!(make_v4([255; 16]), "ffffffff-ffff-4fff-bfff-ffffffffffff");
        assert_eq!(locales(Lang::Pt), ("pt-BR", "pt-BR"));
    }

    #[test]
    fn reuses_only_the_original_payload_for_same_session_and_question() {
        let mut pending = UncertainQuestions::default();
        let question = CoachQuestion {
            session_id: "session-a".into(), conversation_id: Some("original".into()), message: "Help".into(),
            idempotency_key: "same-key".into(), language: "en",
        };
        pending.remember(question.clone());
        assert_eq!(pending.find("session-a", "Help"), Some(question.clone()));
        assert_eq!(pending.find("session-b", "Help"), None);
        assert_eq!(pending.find("session-a", "Changed"), None);
        pending.forget(&question.idempotency_key);
        assert_eq!(pending.find("session-a", "Help"), None);
    }

    #[test]
    fn a_limit_while_checking_delivery_does_not_change_the_original_key() {
        let mut pending = UncertainQuestions::default();
        let question = CoachQuestion {
            session_id: "session".into(), conversation_id: None, message: "Help".into(),
            idempotency_key: "first-key".into(), language: "en",
        };
        pending.after_failure(question.clone(), CoachError::Limit);
        assert!(pending.find("session", "Help").is_none());
        pending.after_failure(question.clone(), CoachError::DeliveryUnknown);
        pending.after_failure(question.clone(), CoachError::Limit);
        assert_eq!(pending.find("session", "Help"), Some(question.clone()));
        pending.after_failure(question, CoachError::Failed);
        assert!(pending.find("session", "Help").is_none());
    }

    #[test]
    fn busy_does_not_mark_a_new_question_as_admitted() {
        let mut pending = UncertainQuestions::default();
        let question = CoachQuestion {
            session_id: "session".into(), conversation_id: None, message: "Help".into(),
            idempotency_key: "unused-key".into(), language: "en",
        };
        pending.after_failure(question, CoachError::Busy);
        assert!(pending.find("session", "Help").is_none());
    }

    #[test]
    fn resumed_question_preserves_server_text_and_id_for_manual_resend() {
        let mut questions = UncertainQuestions::default();
        let message = "Line one\nLine two";
        assert_eq!(questions.restore("session".into(), CoachPending {
            conversation_id: "saved-thread".into(), idempotency_key: "recorded-key".into(), message: message.into(),
        }, Lang::Pt), message);
        let retry = questions.find("session", "Line one\r\nLine two").unwrap();
        assert_eq!(retry.idempotency_key, "recorded-key");
        assert_eq!(retry.conversation_id.as_deref(), Some("saved-thread"));
        assert_eq!(retry.message, message);
        assert_eq!(retry.language, "pt-BR");
        assert!(questions.find("other-session", message).is_none());
        assert!(questions.find("session", "Edited").is_none());
    }
}
