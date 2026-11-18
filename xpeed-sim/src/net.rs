//! The calls Xpeed Companion makes to the Xpeed server: pair this computer, send one lap, send one track layout.
//! The contract is `docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md`.

use std::time::Duration;

use serde_json::{json, Value};

use crate::config::Config;

/// The most a lap file may weigh to be sent (the server refuses more).
pub const MAX_UPLOAD_BYTES: usize = 16 * 1024 * 1024;
/// The most a track layout file may weigh to be sent (the server refuses more).
pub const MAX_TRACK_UPLOAD_BYTES: usize = 32 * 1024 * 1024;
/// The longest wait a server may ask for before the next try.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(3600);
const MAX_REPLY_BYTES: u64 = 64 * 1024;

/// Why a lap did not go, and so what to do about it.
#[derive(Debug, PartialEq)]
pub enum SendError {
    /// The device key was refused or revoked: nothing can be sent until the computer is paired again.
    Unauthorized,
    /// This lap will never be accepted (not a valid lap, too big): do not try it again.
    Rejected(String),
    /// A problem that may pass: leave the lap where it is and try again later.
    Later { reason: String, after: Option<Duration> },
}

/// What a file upload can come to, in more detail than [`SendError`]: the lap outbox needs to tell "this lap only, later"
/// (the account is full) from "the server is busy" and to keep the server's code with a refusal.
#[derive(Debug, PartialEq)]
pub enum FileError {
    Unauthorized,
    /// Refused for good. `code` is what the server named it (`error` and `code` of its JSON body), when it said.
    Rejected {
        why: String,
        code: Option<String>,
    },
    /// This file cannot go now but may after the person frees space: keep it pending and ask again after `after`.
    Deferred {
        reason: String,
        after: Duration,
    },
    /// A problem that may pass for every file: stop and try again later.
    Later {
        reason: String,
        after: Option<Duration>,
    },
}

impl From<FileError> for SendError {
    fn from(error: FileError) -> SendError {
        match error {
            FileError::Unauthorized => SendError::Unauthorized,
            FileError::Rejected { why, .. } => SendError::Rejected(why),
            FileError::Deferred { reason, after } => SendError::Later {
                reason,
                after: Some(after),
            },
            FileError::Later { reason, after } => SendError::Later { reason, after },
        }
    }
}

/// How often a lap is offered again while the account has no room for it.
pub const QUOTA_RETRY: Duration = Duration::from_secs(6 * 3600);

#[derive(Debug, PartialEq)]
pub enum Sent {
    New,
    /// The server already had this lap.
    Duplicate,
}

/// One agent for every call: no redirects (the key must never follow one), bounded waits, the TLS of the system.
pub fn agent() -> ureq::Agent {
    agent_with(Duration::from_secs(120))
}

/// The agent of the heartbeat: the same rules, but a request of a few dozen bytes that the server has not answered in
/// 15 s is not going to be answered, and the next try is a minute away anyway.
pub fn heartbeat_agent() -> ureq::Agent {
    agent_with(Duration::from_secs(15))
}

fn agent_with(global: Duration) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .tls_config(ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls).build())
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(global))
        .user_agent(concat!("xpeed-companion/", env!("CARGO_PKG_VERSION")))
        .build();
    ureq::Agent::new_with_config(config)
}

/// The short text a server error carries (`{"error": "..."}`, with the `code` and `message` some answers add, as in
/// `{"error": "bad_track", "code": "bad_data", "message": "..."}`), cut to something that fits a line.
fn server_message(body: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    let part = |key: &str| value.get(key).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
    let mut text = part("error")?.to_owned();
    if let Some(code) = part("code") {
        text = format!("{text} ({code})");
    }
    if let Some(message) = part("message") {
        text = format!("{text}: {message}");
    }
    Some(text.chars().filter(|c| !c.is_control()).take(160).collect())
}

/// What the server's JSON body says about whether sending the same file again can work.
#[derive(Debug, Default, PartialEq)]
struct Detail {
    /// The `retryable` field, when the body has one.
    retryable: Option<bool>,
    /// `error` and `code` of the body, lower case, as `error/code` when both are there.
    code: Option<String>,
    quota: bool,
    transient: bool,
}

/// Codes that mean the account has no room left (the person can free space).
const QUOTA_CODES: [&str; 5] = ["quota", "quota_exceeded", "storage_full", "storage_quota", "no_space"];
/// Codes that mean the server is busy, whatever the status says.
const TRANSIENT_CODES: [&str; 6] = [
    "rate_limited",
    "rate_limit",
    "too_many_requests",
    "busy",
    "unavailable",
    "try_later",
];

fn server_detail(body: &str) -> Detail {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Detail::default();
    };
    let part = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(|t| t.trim().to_ascii_lowercase())
            .filter(|t| !t.is_empty())
    };
    let (error, code) = (part("error"), part("code"));
    let named = |list: &[&str]| [&error, &code].into_iter().flatten().any(|c| list.contains(&c.as_str()));
    let joined = match (&error, &code) {
        (Some(e), Some(c)) if e != c => Some(format!("{e}/{c}")),
        (Some(e), _) | (None, Some(e)) => Some(e.clone()),
        (None, None) => None,
    };
    Detail {
        retryable: value.get("retryable").and_then(Value::as_bool),
        code: joined.map(|c| c.chars().filter(|ch| !ch.is_control()).take(80).collect()),
        quota: named(&QUOTA_CODES),
        transient: named(&TRANSIENT_CODES),
    }
}

fn retry_after(response: &ureq::http::Response<ureq::Body>) -> Option<Duration> {
    let seconds = response.headers().get("retry-after")?.to_str().ok()?.trim().parse::<u64>().ok()?;
    Some(Duration::from_secs(seconds).min(MAX_RETRY_AFTER))
}

struct Reply {
    status: u16,
    body: String,
    after: Option<Duration>,
}

fn read_reply(mut response: ureq::http::Response<ureq::Body>) -> Reply {
    let after = retry_after(&response);
    let status = response.status().as_u16();
    // A body that cannot be read is no reason to lose the status.
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_REPLY_BYTES)
        .read_to_string()
        .unwrap_or_default();
    Reply { status, body, after }
}

pub(crate) fn network_problem(error: &ureq::Error) -> String {
    match error {
        ureq::Error::Timeout(_) => "the server did not answer in time".into(),
        ureq::Error::ConnectionFailed | ureq::Error::HostNotFound => "cannot reach the server".into(),
        // The text of a TLS or I/O error says what happened and never carries the request.
        other => format!("network problem: {other}"),
    }
}

#[cfg(any(windows, test))]
#[cfg_attr(not(windows), allow(dead_code))]
mod coach_http {
    use super::{agent_with, Config};
    use serde_json::{json, Value};
    use std::time::Duration;

    const PATH: &str = "/api/sim/coach";
    const MAX_COACH_REPLY_BYTES: u64 = 128 * 1024;
    pub(crate) const MAX_COACH_QUESTION_UNITS: usize = 2000;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum CoachError {
        PairAgain,
        EnableOnWebsite,
        Limit,
        Busy,
        Pending,
        Failed,
        Development,
        SessionUnavailable,
        Unavailable,
        DeliveryUnknown,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(crate) struct CoachSession {
        pub id: String,
        pub game: String,
        pub track: String,
        pub car: String,
        pub kind: String,
        pub started_at: String,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum CoachRole {
        User,
        Assistant,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(crate) struct CoachMessage {
        pub role: CoachRole,
        pub content: String,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(crate) struct CoachHistory {
        pub conversation_id: Option<String>,
        pub messages: Vec<CoachMessage>,
        pub pending_request: Option<CoachPending>,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(crate) struct CoachPending {
        pub idempotency_key: String,
        pub conversation_id: String,
        pub message: String,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub(crate) struct CoachQuestion {
        pub session_id: String,
        pub conversation_id: Option<String>,
        pub message: String,
        pub idempotency_key: String,
        pub language: &'static str,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(crate) struct CoachAnswer {
        pub conversation_id: String,
        pub reply: String,
    }

    fn uuid(text: &str) -> bool {
        text.len() == 36
            && text.bytes().enumerate().all(|(i, byte)| {
                if matches!(i, 8 | 13 | 18 | 23) { byte == b'-' } else { byte.is_ascii_hexdigit() }
            })
    }

    fn required_id(value: &Value) -> Option<String> {
        value.as_str().filter(|text| uuid(text)).map(str::to_owned)
    }

    fn connection_error(asked: bool) -> CoachError {
        if asked { CoachError::DeliveryUnknown } else { CoachError::Unavailable }
    }

    fn failure(status: u16, body: Option<&Value>, asked: bool) -> CoachError {
        let code = body.and_then(|value| value["code"].as_str().or_else(|| value["error"].as_str()));
        match (status, code) {
            (401, _) => CoachError::PairAgain,
            (403, Some("assistant_disabled")) => CoachError::EnableOnWebsite,
            (404, _) => CoachError::SessionUnavailable,
            (429, _) => CoachError::Limit,
            (409, Some("device_busy")) => CoachError::Busy,
            (409, Some("request_pending")) => CoachError::Pending,
            (409, Some("request_failed")) => CoachError::Failed,
            (503, Some("development_disabled")) => CoachError::Development,
            (500..=599, _) => connection_error(asked),
            _ => CoachError::Unavailable,
        }
    }

    fn read_response(mut response: ureq::http::Response<ureq::Body>, asked: bool) -> Result<Value, CoachError> {
        let status = response.status().as_u16();
        let body = response.body_mut().with_config().limit(MAX_COACH_REPLY_BYTES).read_to_string().ok();
        let value = body.as_deref().and_then(|body| serde_json::from_str(body).ok());
        if (200..300).contains(&status) {
            value.ok_or_else(|| connection_error(asked))
        } else {
            Err(failure(status, value.as_ref(), asked))
        }
    }

    pub(crate) fn coach_agent() -> ureq::Agent {
        agent_with(Duration::from_secs(90))
    }

    fn get(agent: &ureq::Agent, config: &Config, query: &str) -> Result<Value, CoachError> {
        let response = agent
            .get(format!("{}{PATH}{query}", config.server))
            .header("Authorization", format!("Bearer {}", config.token))
            .call()
            .map_err(|_| CoachError::Unavailable)?;
        read_response(response, false)
    }

    fn sessions(value: &Value) -> Option<Vec<CoachSession>> {
        let sessions = value["sessions"].as_array()?;
        if sessions.len() > 20 { return None; }
        sessions.iter().map(|row| Some(CoachSession {
            id: required_id(&row["id"])?,
            game: row["game"].as_str()?.to_owned(),
            track: row["track"].as_str()?.to_owned(),
            car: row["car"].as_str()?.to_owned(),
            kind: row["kind"].as_str()?.to_owned(),
            started_at: row["startedAt"].as_str()?.to_owned(),
        })).collect()
    }

    fn history(value: &Value) -> Option<CoachHistory> {
        let conversation_id = if value.get("conversationId")?.is_null() { None } else { Some(required_id(&value["conversationId"])?) };
        let pending_request = match value.get("pendingRequest") {
            None | Some(Value::Null) => None,
            Some(row) => {
                let pending_conversation = required_id(&row["conversationId"])?;
                let message = row["message"].as_str()?;
                if conversation_id.as_deref() != Some(pending_conversation.as_str())
                    || message.trim().is_empty() || message.contains('\0')
                    || message.encode_utf16().count() > MAX_COACH_QUESTION_UNITS {
                    return None;
                }
                Some(CoachPending {
                    idempotency_key: required_id(&row["idempotencyKey"])?,
                    conversation_id: pending_conversation,
                    message: message.to_owned(),
                })
            }
        };
        let messages = value["messages"].as_array()?;
        if messages.len() > 12 { return None; }
        let messages = messages.iter().map(|row| {
            let role = match row["role"].as_str()? {
                "user" => CoachRole::User,
                "assistant" => CoachRole::Assistant,
                _ => return None,
            };
            Some(CoachMessage { role, content: row["content"].as_str()?.to_owned() })
        }).collect::<Option<Vec<_>>>()?;
        Some(CoachHistory { conversation_id, messages, pending_request })
    }

    fn answer(value: &Value) -> Option<CoachAnswer> {
        Some(CoachAnswer {
            conversation_id: required_id(&value["conversationId"])?,
            reply: value["reply"].as_str().filter(|reply| !reply.trim().is_empty())?.to_owned(),
        })
    }

    pub(crate) fn coach_sessions(agent: &ureq::Agent, config: &Config) -> Result<Vec<CoachSession>, CoachError> {
        sessions(&get(agent, config, "")?).ok_or(CoachError::Unavailable)
    }

    pub(crate) fn coach_history(agent: &ureq::Agent, config: &Config, session_id: &str) -> Result<CoachHistory, CoachError> {
        if !uuid(session_id) { return Err(CoachError::SessionUnavailable); }
        history(&get(agent, config, &format!("?sessionId={session_id}"))?).ok_or(CoachError::Unavailable)
    }

    fn question_body(item: &CoachQuestion) -> Option<Value> {
        if !uuid(&item.session_id) || !uuid(&item.idempotency_key)
            || item.conversation_id.as_deref().is_some_and(|id| !uuid(id))
            || !matches!(item.language, "en" | "pt-BR" | "es-ES")
            || item.message.trim().is_empty() || item.message.encode_utf16().count() > MAX_COACH_QUESTION_UNITS {
            return None;
        }
        let mut value = json!({
            "sessionId": item.session_id, "message": item.message,
            "idempotencyKey": item.idempotency_key, "language": item.language,
        });
        if let Some(id) = &item.conversation_id { value["conversationId"] = json!(id); }
        Some(value)
    }

    pub(crate) fn coach_ask(
        agent: &ureq::Agent, config: &Config, question: &CoachQuestion, may_send: impl FnOnce() -> bool,
    ) -> Result<CoachAnswer, CoachError> {
        let body = question_body(question).ok_or(CoachError::Unavailable)?.to_string();
        let request = agent
            .post(format!("{}{PATH}", config.server))
            .header("Authorization", format!("Bearer {}", config.token))
            .content_type("application/json");
        if !may_send() { return Err(CoachError::Unavailable); }
        let response = request
            .send(body.as_bytes())
            .map_err(|_| CoachError::DeliveryUnknown)?;
        answer(&read_response(response, true)?).ok_or(CoachError::DeliveryUnknown)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const ID: &str = "83b34059-293f-4b31-8257-80ec66b7435c";

        #[test]
        fn coach_question_uses_utf16_bound_and_only_an_explicit_conversation() {
            let mut item = CoachQuestion {
                session_id: ID.into(), conversation_id: None, message: "🏁".repeat(1000),
                idempotency_key: ID.into(), language: "pt-BR",
            };
            assert!(question_body(&item).unwrap().get("conversationId").is_none());
            item.conversation_id = Some(ID.into());
            assert_eq!(question_body(&item).unwrap()["conversationId"], ID);
            item.message.push('x');
            assert!(question_body(&item).is_none());
        }

        #[test]
        fn coach_reply_ignores_raw_provider_errors_and_rejects_invalid_history() {
            assert_eq!(failure(403, Some(&json!({"code":"assistant_disabled"})), false), CoachError::EnableOnWebsite);
            assert_eq!(failure(409, Some(&json!({"code":"request_pending"})), true), CoachError::Pending);
            assert_eq!(failure(409, Some(&json!({"error":"device_busy"})), true), CoachError::Busy);
            assert_eq!(failure(502, Some(&json!({"error":"internal provider detail"})), true), CoachError::DeliveryUnknown);
            assert_eq!(failure(502, None, false), CoachError::Unavailable);
            assert!(history(&json!({"conversationId": ID, "messages":[{"role":"system", "content":"hidden"}]})).is_none());
            assert!(history(&json!({"conversationId":null, "messages":[]})).is_some());
            assert!(history(&json!({"conversationId":null, "messages":vec![json!({"role":"user","content":"hi"});13]})).is_none());
        }

        #[test]
        fn history_restores_an_exact_pending_payload_only_for_its_conversation() {
            let message = format!("Driver asked\n{}", "🏁".repeat(900));
            let mut value = json!({
                "conversationId": ID, "messages": [],
                "pendingRequest": {"idempotencyKey": ID, "conversationId": ID, "message": message},
            });
            let exact = history(&value).unwrap().pending_request.unwrap();
            assert_eq!(exact.message, message);
            assert_eq!(exact.idempotency_key, ID);
            value["pendingRequest"]["conversationId"] = json!("83b34059-293f-4b31-8257-80ec66b7435d");
            assert!(history(&value).is_none());
            value["pendingRequest"]["conversationId"] = json!(ID);
            value["pendingRequest"]["message"] = json!("🏁".repeat(1001));
            assert!(history(&value).is_none());
            value["pendingRequest"] = Value::Null;
            assert!(history(&value).unwrap().pending_request.is_none());
        }
    }
}

#[cfg(windows)]
pub(crate) use coach_http::*;

fn explain(reply: &Reply, what: &str) -> String {
    match server_message(&reply.body) {
        Some(message) => format!("{what} ({}): {message}", reply.status),
        None => format!("{what} ({})", reply.status),
    }
}

/// Sends one lap file as it is on disk.
#[cfg(test)]
pub fn send_lap(agent: &ureq::Agent, config: &Config, file: &[u8]) -> Result<Sent, SendError> {
    send_lap_detailed(agent, config, file).map_err(SendError::from)
}

/// [`send_lap`], with the detail the lap outbox needs to decide between waiting and giving up.
pub fn send_lap_detailed(agent: &ureq::Agent, config: &Config, file: &[u8]) -> Result<Sent, FileError> {
    send_file(agent, config, "/api/sim/laps", file, ("lap", "laps"))
}

/// Sends one track layout file (`.xtrk.gz`) as it is on disk. The server keeps one per track and replaces it.
pub fn send_track(agent: &ureq::Agent, config: &Config, file: &[u8]) -> Result<Sent, SendError> {
    send_file(agent, config, "/api/sim/tracks", file, ("track layout", "track layouts")).map_err(SendError::from)
}

/// The same rules for every file Xpeed Companion sends: the device key, the bytes as they are, and the answer judged by its
/// status and, for a refusal, by the `retryable` and `code` the server's JSON body carries. `what` names one file and
/// several, for the messages.
fn send_file(agent: &ureq::Agent, config: &Config, path: &str, file: &[u8], what: (&str, &str)) -> Result<Sent, FileError> {
    let (one, many) = what;
    let response = agent
        .post(format!("{}{path}", config.server))
        .header("Authorization", format!("Bearer {}", config.token))
        .content_type("application/gzip")
        .send(file)
        .map_err(|error| FileError::Later {
            reason: network_problem(&error),
            after: None,
        })?;
    let reply = read_reply(response);
    match reply.status {
        201 => Ok(Sent::New),
        200 => Ok(Sent::Duplicate),
        401 | 403 => Err(FileError::Unauthorized),
        400 | 413 | 415 | 422 => {
            let detail = server_detail(&reply.body);
            if detail.quota {
                Err(FileError::Deferred {
                    reason: explain(&reply, &format!("the account has no room for this {one} yet")),
                    after: reply.after.unwrap_or(QUOTA_RETRY),
                })
            } else if detail.retryable == Some(true) || detail.transient {
                Err(FileError::Later {
                    reason: explain(&reply, &format!("the server could not take the {one} now")),
                    after: reply.after,
                })
            } else {
                Err(FileError::Rejected {
                    why: explain(&reply, &format!("the server refused this {one}")),
                    code: detail.code,
                })
            }
        }
        404 | 405 | 501 => Err(FileError::Later {
            reason: format!("this server does not receive {many}"),
            after: None,
        }),
        300..=399 => Err(FileError::Later {
            reason: "the server moved; pair again with its final address".into(),
            after: None,
        }),
        _ => Err(FileError::Later {
            reason: explain(&reply, &format!("the server could not take the {one}")),
            after: reply.after,
        }),
    }
}

/// Says to the server that this computer is running (`POST /api/sim/heartbeat`, contract in `ENVIO-DE-VOLTAS.md`, section 2c).
/// `body` is the JSON from `heartbeat::payload`. Judged by the status alone, like a lap: a refused key stops the heartbeat, a
/// server that does not know the route (an older one) or is busy is a later try, and anything else the server finds wrong
/// with it is reported as a refusal (the caller treats that as a later try too: a heartbeat is never worth giving up on).
pub fn send_heartbeat(agent: &ureq::Agent, config: &Config, body: &str) -> Result<(), SendError> {
    let response = agent
        .post(format!("{}/api/sim/heartbeat", config.server))
        .header("Authorization", format!("Bearer {}", config.token))
        .content_type("application/json")
        .send(body)
        .map_err(|error| SendError::Later {
            reason: network_problem(&error),
            after: None,
        })?;
    let reply = read_reply(response);
    match reply.status {
        200..=299 => Ok(()),
        401 | 403 => Err(SendError::Unauthorized),
        400 | 413 | 415 | 422 => Err(SendError::Rejected(explain(&reply, "the server refused the heartbeat"))),
        404 | 405 | 501 => Err(SendError::Later {
            reason: "this server does not take heartbeats yet".into(),
            after: Some(Duration::from_secs(300)),
        }),
        300..=399 => Err(SendError::Later {
            reason: "the server moved; pair again with its final address".into(),
            after: None,
        }),
        _ => Err(SendError::Later {
            reason: explain(&reply, "the server could not take the heartbeat"),
            after: reply.after,
        }),
    }
}

/// Sends one error report (`POST /api/sim/companion-errors`, see `crashreport.rs`) with the device key. Judged by the status alone, like
/// the heartbeat: a refused key is `Unauthorized`; a report the server will never take (it is not one, or it is too big) is `Rejected` and
/// is dropped by the caller; a busy, older or unreachable server (and a rate limit) is a later try.
pub fn send_error_report(agent: &ureq::Agent, config: &Config, body: &str) -> Result<(), SendError> {
    let response = agent
        .post(format!("{}/api/sim/companion-errors", config.server))
        .header("Authorization", format!("Bearer {}", config.token))
        .content_type("application/json")
        .send(body)
        .map_err(|error| SendError::Later {
            reason: network_problem(&error),
            after: None,
        })?;
    let reply = read_reply(response);
    match reply.status {
        200..=299 => Ok(()),
        401 | 403 => Err(SendError::Unauthorized),
        400 | 413 | 415 | 422 => Err(SendError::Rejected(explain(&reply, "the server refused the report"))),
        404 | 405 | 501 => Err(SendError::Later {
            reason: "this server does not take error reports yet".into(),
            after: Some(Duration::from_secs(300)),
        }),
        _ => Err(SendError::Later {
            reason: explain(&reply, "the server could not take the report"),
            after: reply.after,
        }),
    }
}

/// Trades a pairing code for this computer's device key.
pub fn pair(agent: &ureq::Agent, server: &str, code: &str, device_name: &str) -> Result<String, String> {
    let body = json!({
        "code": code,
        "device": { "name": device_name, "platform": std::env::consts::OS, "app": "xpeed-companion", "version": env!("CARGO_PKG_VERSION") },
    });
    let response = agent
        .post(format!("{server}/api/sim/pair"))
        .content_type("application/json")
        .send(body.to_string())
        .map_err(|error| network_problem(&error))?;
    let reply = read_reply(response);
    match reply.status {
        200 => serde_json::from_str::<Value>(&reply.body)
            .ok()
            .and_then(|v| v.get("token").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_owned))
            .ok_or_else(|| "the server accepted the code but sent no device key".to_owned()),
        400 | 404 | 410 => Err("that code is not valid: it may have expired or been used. Ask for a new one in the app.".into()),
        429 => Err("too many attempts; wait a little and try again".into()),
        300..=399 => Err("the server moved; use its final address".into()),
        status if status < 500 => Err(explain(&reply, "the server refused the pairing")),
        _ => Err(explain(&reply, "the server could not pair now")),
    }
}

/// Where a connection request stands, as the poll says.
#[derive(Debug, PartialEq)]
pub enum LinkStatus {
    Pending,
    /// The person clicked Connect on the page; `account` is the email or name they are connected as.
    Approved {
        account: String,
    },
    Cancelled,
    Expired,
}

/// What the server answers to a connection request.
#[derive(Debug, PartialEq)]
pub struct LinkStart {
    pub id: String,
    pub expires_at: String,
    /// The 4 characters the connection page shows too, for the person to compare (older servers do not send it).
    pub verify_code: Option<String>,
}

/// The server's `201 {"id","expiresAt","verifyCode"}`. `verifyCode` is optional: a missing, empty or odd one is no code.
fn parse_link_start(body: &str) -> Result<LinkStart, String> {
    let value = serde_json::from_str::<Value>(body).ok();
    let text_of = |key: &str| {
        value
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
    };
    let verify_code = text_of("verifyCode")
        .map(|code| code.trim().to_owned())
        .filter(|code| (1..=8).contains(&code.chars().count()) && code.chars().all(|c| c.is_ascii_alphanumeric()));
    match (text_of("id"), text_of("expiresAt")) {
        (Some(id), Some(expires_at)) => Ok(LinkStart {
            id,
            expires_at,
            verify_code,
        }),
        _ => Err("the server started the connection but sent no request id".into()),
    }
}

/// Asks the server for a connection request for this computer. Only the hash of the device key goes: the key
/// itself never leaves the computer until it is used as a normal device key. Returns the request's id, when it
/// expires and the code to compare with the page.
pub fn link_start(agent: &ureq::Agent, server: &str, device_name: &str, token_hash: &str) -> Result<LinkStart, String> {
    let body = json!({ "device": { "name": device_name }, "tokenHash": token_hash });
    let response = agent
        .post(format!("{server}/api/sim/link"))
        .content_type("application/json")
        .send(body.to_string())
        .map_err(|error| network_problem(&error))?;
    let reply = read_reply(response);
    match reply.status {
        201 => parse_link_start(&reply.body),
        429 => Err("too many attempts; wait a little and try again".into()),
        300..=399 => Err("the server moved; use its final address".into()),
        status if status < 500 => Err(explain(&reply, "the server refused the connection request")),
        _ => Err(explain(&reply, "the server could not start the connection now")),
    }
}

/// Asks where a connection request stands, with the device key as proof that it is ours.
pub fn link_poll(agent: &ureq::Agent, server: &str, id: &str, key: &str) -> Result<LinkStatus, String> {
    let response = agent
        .post(format!("{server}/api/sim/link/{id}/poll"))
        .header("Authorization", format!("Bearer {key}"))
        .send_empty()
        .map_err(|error| network_problem(&error))?;
    let reply = read_reply(response);
    match reply.status {
        200 => {
            let value = serde_json::from_str::<Value>(&reply.body).ok();
            let status = value.as_ref().and_then(|v| v.get("status")).and_then(Value::as_str);
            match status {
                Some("pending") => Ok(LinkStatus::Pending),
                Some("approved") => {
                    let account = value
                        .as_ref()
                        .and_then(|v| v.get("account"))
                        .and_then(Value::as_str)
                        .map(|a| a.chars().filter(|c| !c.is_control()).take(120).collect::<String>())
                        .unwrap_or_default();
                    Ok(LinkStatus::Approved { account })
                }
                Some("cancelled") => Ok(LinkStatus::Cancelled),
                Some("expired") => Ok(LinkStatus::Expired),
                _ => Err("the server answered the connection request in a way this app does not know".into()),
            }
        }
        404 => Err("the server does not know this connection request; click Connect again".into()),
        429 => Err("too many attempts; wait a little and try again".into()),
        300..=399 => Err("the server moved; use its final address".into()),
        status if status < 500 => Err(explain(&reply, "the server refused the connection request")),
        _ => Err(explain(&reply, "the server could not answer now")),
    }
}

/// Asks the server who this device key belongs to: the account's email (else its name), for the Account card. A key
/// the server refuses is an error like any other; the caller changes nothing then (the uploader deals with a refused
/// key when it sends a lap).
pub fn whoami(agent: &ureq::Agent, server: &str, key: &str) -> Result<String, String> {
    let response = agent
        .get(format!("{server}/api/sim/me"))
        .header("Authorization", format!("Bearer {key}"))
        .call()
        .map_err(|error| network_problem(&error))?;
    let reply = read_reply(response);
    match reply.status {
        200 => {
            let value = serde_json::from_str::<Value>(&reply.body).ok();
            let account = value
                .as_ref()
                .and_then(|v| v.get("account"))
                .and_then(Value::as_str)
                .ok_or_else(|| "the server answered who this computer is in a way this app does not know".to_owned())?;
            Ok(account
                .chars()
                .filter(|c| !c.is_control())
                .take(120)
                .collect::<String>()
                .trim()
                .to_owned())
        }
        401 | 403 => Err("the server does not accept this computer's key".into()),
        429 => Err("too many attempts; wait a little and try again".into()),
        404 | 405 | 501 => Err("this server cannot say who this computer is connected as".into()),
        300..=399 => Err("the server moved; use its final address".into()),
        _ => Err(explain(&reply, "the server could not say who this computer is connected as")),
    }
}

/// SHA-256 (FIPS 180-4) fed in pieces, for a file too big to hold in memory (the installer of an update).
pub struct Sha256 {
    h: [u32; 8],
    block: [u8; 64],
    filled: usize,
    length: u64,
}

impl Default for Sha256 {
    fn default() -> Self {
        Sha256 {
            h: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
            ],
            block: [0; 64],
            filled: 0,
            length: 0,
        }
    }
}

impl Sha256 {
    pub fn new() -> Sha256 {
        Sha256::default()
    }

    fn compress(h: &mut [u32; 8], block: &[u8; 64]) {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
            0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
            0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
            0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
            0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
            0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
        ];
        let mut w = [0u32; 64];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut v = *h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [t1.wrapping_add(t2), v[0], v[1], v[2], v[3].wrapping_add(t1), v[4], v[5], v[6]];
        }
        for (slot, add) in h.iter_mut().zip(v) {
            *slot = slot.wrapping_add(add);
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.length = self.length.wrapping_add(data.len() as u64);
        if self.filled > 0 {
            let take = (64 - self.filled).min(data.len());
            self.block[self.filled..self.filled + take].copy_from_slice(&data[..take]);
            self.filled += take;
            data = &data[take..];
            if self.filled < 64 {
                return;
            }
            let block = self.block;
            Sha256::compress(&mut self.h, &block);
            self.filled = 0;
        }
        let (blocks, rest) = data.as_chunks::<64>();
        for block in blocks {
            Sha256::compress(&mut self.h, block);
        }
        self.block[..rest.len()].copy_from_slice(rest);
        self.filled = rest.len();
    }

    /// The digest as 64 lower-case hex digits.
    pub fn finish_hex(mut self) -> String {
        let bits = self.length.wrapping_mul(8);
        let mut tail = vec![0x80u8];
        while (self.filled + tail.len()) % 64 != 56 {
            tail.push(0);
        }
        tail.extend_from_slice(&bits.to_be_bytes());
        self.update(&tail);
        self.h.iter().map(|word| format!("{word:08x}")).collect()
    }
}

/// The SHA-256 of `data` as 64 lower-case hex digits (FIPS 180-4). The server stores the hash of a device key, so the
/// app sends this and keeps the key.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(data);
    hash.finish_hex()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_connection_request_with_and_without_the_verification_code() {
        let with = parse_link_start(r#"{"id":"abc-123","expiresAt":"2026-11-13T12:10:00.000Z","verifyCode":"K7QX"}"#).unwrap();
        assert_eq!(
            with,
            LinkStart {
                id: "abc-123".into(),
                expires_at: "2026-11-13T12:10:00.000Z".into(),
                verify_code: Some("K7QX".into())
            }
        );
        // An older server sends none.
        let without = parse_link_start(r#"{"id":"abc-123","expiresAt":"x"}"#).unwrap();
        assert_eq!((without.id.as_str(), without.verify_code), ("abc-123", None));
        // A code that is empty, too long or not plain letters and digits is ignored, never shown.
        for odd in [r#""""#, r#""K7QXK7QXK""#, r#""K7 Q""#, r#""<b>""#, "7", "null"] {
            let body = format!(r#"{{"id":"a","expiresAt":"x","verifyCode":{odd}}}"#);
            assert_eq!(parse_link_start(&body).unwrap().verify_code, None, "{odd}");
        }
        assert!(parse_link_start(r#"{"expiresAt":"x","verifyCode":"K7QX"}"#).is_err());
        assert!(parse_link_start("not json").is_err());
    }

    #[test]
    fn calls_itself_xpeed_companion() {
        use crate::stub::{Recorded, Reply, Stub};
        let stub = Stub::start(|_: &Recorded| Reply::new(200, r#"{"token":"xpd_x"}"#));
        let agent = agent();
        pair(&agent, &stub.url, "ABCD2345", "RIG").unwrap();
        let seen = stub.requests();
        let agent_name = seen[0].headers.get("user-agent").cloned().unwrap_or_default();
        assert_eq!(agent_name, format!("xpeed-companion/{}", env!("CARGO_PKG_VERSION")));
        let sent: Value = serde_json::from_slice(&seen[0].body).unwrap();
        assert_eq!(sent["device"]["app"], "xpeed-companion");
    }

    #[test]
    fn hashes_like_sha256() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // Longer than one block, and a length that needs a second padding block.
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn hashing_in_pieces_gives_the_same_digest_wherever_the_pieces_break() {
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 7 + 3) as u8).collect();
        let whole = sha256_hex(&data);
        for size in [1, 2, 3, 55, 56, 63, 64, 65, 127, 128, 333, 999, 1000] {
            let mut hash = Sha256::new();
            for piece in data.chunks(size) {
                hash.update(piece);
            }
            assert_eq!(hash.finish_hex(), whole, "pieces of {size}");
        }
    }
}
