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

#[derive(Debug, PartialEq)]
pub enum Sent {
    New,
    /// The server already had this lap.
    Duplicate,
}

/// One agent for every call: no redirects (the key must never follow one), bounded waits, the TLS of the system.
pub fn agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .tls_config(ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls).build())
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(120)))
        .user_agent(concat!("xpeed-sim/", env!("CARGO_PKG_VERSION")))
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

fn network_problem(error: &ureq::Error) -> String {
    match error {
        ureq::Error::Timeout(_) => "the server did not answer in time".into(),
        ureq::Error::ConnectionFailed | ureq::Error::HostNotFound => "cannot reach the server".into(),
        // The text of a TLS or I/O error says what happened and never carries the request.
        other => format!("network problem: {other}"),
    }
}

fn explain(reply: &Reply, what: &str) -> String {
    match server_message(&reply.body) {
        Some(message) => format!("{what} ({}): {message}", reply.status),
        None => format!("{what} ({})", reply.status),
    }
}

/// Sends one lap file as it is on disk.
pub fn send_lap(agent: &ureq::Agent, config: &Config, file: &[u8]) -> Result<Sent, SendError> {
    send_file(agent, config, "/api/sim/laps", file, ("lap", "laps"))
}

/// Sends one track layout file (`.xtrk.gz`) as it is on disk. The server keeps one per track and replaces it.
pub fn send_track(agent: &ureq::Agent, config: &Config, file: &[u8]) -> Result<Sent, SendError> {
    send_file(agent, config, "/api/sim/tracks", file, ("track layout", "track layouts"))
}

/// The same rules for every file Xpeed Companion sends: the device key, the bytes as they are, and the answer judged by its
/// status alone. `what` names one file and several, for the messages.
fn send_file(agent: &ureq::Agent, config: &Config, path: &str, file: &[u8], what: (&str, &str)) -> Result<Sent, SendError> {
    let (one, many) = what;
    let response = agent
        .post(format!("{}{path}", config.server))
        .header("Authorization", format!("Bearer {}", config.token))
        .content_type("application/gzip")
        .send(file)
        .map_err(|error| SendError::Later {
            reason: network_problem(&error),
            after: None,
        })?;
    let reply = read_reply(response);
    match reply.status {
        201 => Ok(Sent::New),
        200 => Ok(Sent::Duplicate),
        401 | 403 => Err(SendError::Unauthorized),
        400 | 413 | 415 | 422 => Err(SendError::Rejected(explain(&reply, &format!("the server refused this {one}")))),
        404 | 405 | 501 => Err(SendError::Later {
            reason: format!("this server does not receive {many}"),
            after: None,
        }),
        300..=399 => Err(SendError::Later {
            reason: "the server moved; pair again with its final address".into(),
            after: None,
        }),
        _ => Err(SendError::Later {
            reason: explain(&reply, &format!("the server could not take the {one}")),
            after: reply.after,
        }),
    }
}

/// Trades a pairing code for this computer's device key.
pub fn pair(agent: &ureq::Agent, server: &str, code: &str, device_name: &str) -> Result<String, String> {
    let body = json!({
        "code": code,
        "device": { "name": device_name, "platform": std::env::consts::OS, "app": "xpeed-sim", "version": env!("CARGO_PKG_VERSION") },
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
