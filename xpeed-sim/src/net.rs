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

/// Asks the server for a connection request for this computer. Only the hash of the device key goes: the key
/// itself never leaves the computer until it is used as a normal device key. Returns the request's id and when it
/// expires.
pub fn link_start(agent: &ureq::Agent, server: &str, device_name: &str, token_hash: &str) -> Result<(String, String), String> {
    let body = json!({ "device": { "name": device_name }, "tokenHash": token_hash });
    let response = agent
        .post(format!("{server}/api/sim/link"))
        .content_type("application/json")
        .send(body.to_string())
        .map_err(|error| network_problem(&error))?;
    let reply = read_reply(response);
    match reply.status {
        201 => {
            let value = serde_json::from_str::<Value>(&reply.body).ok();
            let text_of = |key: &str| {
                value
                    .as_ref()
                    .and_then(|v| v.get(key))
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                    .map(str::to_owned)
            };
            match (text_of("id"), text_of("expiresAt")) {
                (Some(id), Some(expires)) => Ok((id, expires)),
                _ => Err("the server started the connection but sent no request id".into()),
            }
        }
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

/// The SHA-256 of `data` as 64 lower-case hex digits (FIPS 180-4). The server stores the hash of a device key, so the
/// app sends this and keeps the key.
pub fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
        0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
        0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
        0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
        0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in message.chunks(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut v = h;
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
    h.iter().map(|word| format!("{word:08x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
