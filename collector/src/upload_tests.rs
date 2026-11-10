//! The real client and the real outbox against a server that runs on this computer (`stub.rs`).

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::config::{scratch_dir, Config};
use crate::lapfile::{self, Channel, Lap};
use crate::net::{self, SendError};
use crate::outbox::{upload_pending, Backoff, Report, Stop, Uploader};
use crate::stub::{Recorded, Reply, Stub};

fn lap(number: u32) -> Lap {
    let channel = |id: &str, unit: &str, values: [f32; 3]| Channel {
        id: id.into(),
        unit: unit.into(),
        values: values.to_vec(),
    };
    Lap {
        game: "lmu".into(),
        track_name: "Test Track".into(),
        track_variant: None,
        track_length_m: Some(20.0),
        car_name: "Test Car".into(),
        car_class: None,
        lap_number: number,
        time_ms: 1000,
        valid: true,
        sectors_ms: None,
        started_at: "2026-11-10T12:00:00.000Z".into(),
        sample_rate_hz: 2.0,
        channels: vec![
            channel("t", "s", [0.0, 0.5, 1.0]),
            channel("dist", "m", [0.0, 10.0, 20.0]),
            channel("speed", "m/s", [0.0, 10.0, 20.0]),
        ],
    }
}

/// Saves lap `number` as the recorder would, and returns its name and bytes.
fn add_lap(dir: &Path, number: u32) -> (String, Vec<u8>) {
    let bytes = lapfile::gzip(&lap(number)).unwrap();
    let name = format!("test-track_test-car_lap{number}_20261110120000.xlap.gz");
    std::fs::write(dir.join(&name), &bytes).unwrap();
    (name, bytes)
}

fn config_for(url: &str) -> Config {
    Config {
        server: url.into(),
        token: "xpd_test".into(),
        device_name: "RIG".into(),
    }
}

fn pass(dir: &Path, config: &Config) -> Report {
    upload_pending(dir, config, &net::agent(), &mut |_| {})
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < Duration::from_secs(10), "gave up waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn accepts_everything() -> Stub {
    Stub::start(|_| Reply::new(201, r#"{"id":"x","duplicate":false}"#))
}

#[test]
fn sends_a_lap_exactly_as_it_is_on_disk() {
    let dir = scratch_dir("send");
    let (name, bytes) = add_lap(&dir, 1);
    let stub = accepts_everything();
    let report = pass(&dir, &config_for(&stub.url));
    assert_eq!(
        report,
        Report {
            sent: 1,
            ..Report::default()
        }
    );

    let seen = stub.requests();
    assert_eq!(seen.len(), 1);
    assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("POST", "/api/sim/laps"));
    assert_eq!(seen[0].headers["authorization"], "Bearer xpd_test");
    assert_eq!(seen[0].headers["content-type"], "application/gzip");
    assert!(seen[0].headers["user-agent"].starts_with("xpeed-collector/"));
    assert_eq!(seen[0].body, bytes, "the server gets the file untouched");
    // The lap file itself is never changed or removed by sending.
    assert_eq!(std::fs::read(dir.join(&name)).unwrap(), bytes);
}

#[test]
fn tells_a_lap_the_server_already_had_from_a_new_one() {
    let dir = scratch_dir("duplicate");
    add_lap(&dir, 1);
    let stub = Stub::start(|_| Reply::new(200, r#"{"id":"x","duplicate":true}"#));
    assert_eq!(
        pass(&dir, &config_for(&stub.url)),
        Report {
            duplicates: 1,
            ..Report::default()
        }
    );
}

#[test]
fn does_not_send_again_what_was_sent() {
    let dir = scratch_dir("again");
    add_lap(&dir, 1);
    add_lap(&dir, 2);
    let stub = accepts_everything();
    let config = config_for(&stub.url);
    assert_eq!(pass(&dir, &config).sent, 2);
    assert_eq!(pass(&dir, &config), Report::default());
    assert_eq!(stub.requests().len(), 2);

    // A lap saved later is the only one that goes.
    add_lap(&dir, 3);
    assert_eq!(pass(&dir, &config).sent, 1);
    assert_eq!(stub.requests().len(), 3);
}

#[test]
fn a_different_server_gets_the_laps_again() {
    let dir = scratch_dir("other-server");
    add_lap(&dir, 1);
    let (first, second) = (accepts_everything(), accepts_everything());
    assert_eq!(pass(&dir, &config_for(&first.url)).sent, 1);
    assert_eq!(pass(&dir, &config_for(&second.url)).sent, 1);
    assert_eq!((first.requests().len(), second.requests().len()), (1, 1));
}

#[test]
fn a_refused_key_stops_everything_and_loses_nothing() {
    let dir = scratch_dir("unauthorized");
    for number in 1..=3 {
        add_lap(&dir, number);
    }
    let revoked = Arc::new(AtomicUsize::new(1));
    let flag = revoked.clone();
    let stub = Stub::start(move |_| {
        if flag.load(Ordering::SeqCst) == 1 {
            Reply::new(401, r#"{"error":"revoked"}"#)
        } else {
            Reply::new(201, "{}")
        }
    });
    let config = config_for(&stub.url);
    let report = pass(&dir, &config);
    assert_eq!(report.stopped, Some(Stop::Unauthorized));
    assert_eq!((report.sent, report.left), (0, 3));
    assert_eq!(stub.requests().len(), 1, "it does not keep knocking with a refused key");

    // After pairing again, every lap is still there to be sent.
    revoked.store(0, Ordering::SeqCst);
    assert_eq!(pass(&dir, &config).sent, 3);
}

#[test]
fn a_lap_refused_for_good_is_marked_and_the_others_still_go() {
    let dir = scratch_dir("rejected");
    let (bad_name, bad_bytes) = add_lap(&dir, 1);
    add_lap(&dir, 2);
    add_lap(&dir, 3);
    let stub = Stub::start(move |request: &Recorded| {
        if request.body == bad_bytes {
            Reply::new(422, r#"{"error":"not a lap\u0007"}"#)
        } else {
            Reply::new(201, "{}")
        }
    });
    let config = config_for(&stub.url);
    let mut lines = Vec::new();
    let report = upload_pending(&dir, &config, &net::agent(), &mut |line| lines.push(line));
    assert_eq!((report.sent, report.rejected, report.stopped), (2, 1, None));
    let why = lines.iter().find(|line| line.contains(&bad_name)).unwrap();
    assert!(why.contains("not a lap") && why.contains("422") && !why.contains('\u{7}'), "{why}");

    // Next time the refused lap is not offered again.
    assert_eq!(pass(&dir, &config), Report::default());
    assert_eq!(stub.requests().len(), 3);
}

#[test]
fn a_passing_problem_stops_the_pass_and_keeps_the_laps_pending() {
    let dir = scratch_dir("later");
    for number in 1..=3 {
        add_lap(&dir, number);
    }
    let stub = Stub::start(|_| Reply::new(503, "<html>maintenance</html>").header("Retry-After", "7"));
    let report = pass(&dir, &config_for(&stub.url));
    let Some(Stop::Later { reason, after }) = report.stopped else {
        panic!("{report:?}")
    };
    assert!(reason.contains("503"), "{reason}");
    assert_eq!(after, Some(Duration::from_secs(7)));
    assert_eq!((report.sent, report.left), (0, 3));
    assert_eq!(stub.requests().len(), 1);
}

#[test]
fn a_server_cannot_make_the_collector_wait_for_days() {
    let dir = scratch_dir("retry-after");
    add_lap(&dir, 1);
    let stub = Stub::start(|_| Reply::new(429, "{}").header("Retry-After", "999999"));
    let Some(Stop::Later { after, .. }) = pass(&dir, &config_for(&stub.url)).stopped else {
        panic!()
    };
    assert_eq!(after, Some(net::MAX_RETRY_AFTER));
}

#[test]
fn a_server_that_does_not_take_laps_says_so() {
    let dir = scratch_dir("no-endpoint");
    add_lap(&dir, 1);
    let stub = Stub::start(|_| Reply::new(404, "Not found"));
    let Some(Stop::Later { reason, .. }) = pass(&dir, &config_for(&stub.url)).stopped else {
        panic!()
    };
    assert!(reason.contains("does not receive laps"), "{reason}");
}

#[test]
fn a_redirect_is_not_followed_so_the_key_never_goes_elsewhere() {
    let dir = scratch_dir("redirect");
    add_lap(&dir, 1);
    let elsewhere = accepts_everything();
    let target = format!("{}/api/sim/laps", elsewhere.url);
    let stub = Stub::start(move |_| Reply::new(307, "").header("Location", &target));
    let Some(Stop::Later { reason, .. }) = pass(&dir, &config_for(&stub.url)).stopped else {
        panic!()
    };
    assert!(reason.contains("moved"), "{reason}");
    assert!(
        elsewhere.requests().is_empty(),
        "nothing, least of all the key, was sent to the other address"
    );
}

#[test]
fn a_server_that_cannot_be_reached_is_a_passing_problem() {
    let dir = scratch_dir("unreachable");
    add_lap(&dir, 1);
    // A port nobody listens on: bind to get a free one, then let it go.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let report = pass(&dir, &config_for(&format!("http://127.0.0.1:{port}")));
    assert!(matches!(report.stopped, Some(Stop::Later { .. })), "{report:?}");
    assert_eq!(report.left, 1);
}

#[test]
fn what_is_not_a_lap_never_leaves_the_computer() {
    let dir = scratch_dir("junk");
    std::fs::write(dir.join("junk.xlap.gz"), b"definitely not a lap").unwrap();
    std::fs::write(dir.join("half.xlap.gz.part"), b"still being written").unwrap();
    std::fs::write(dir.join("notes.txt"), b"hello").unwrap();
    let stub = accepts_everything();
    let config = config_for(&stub.url);
    let report = pass(&dir, &config);
    assert_eq!((report.sent, report.rejected), (0, 1));
    assert!(stub.requests().is_empty());
    assert!(dir.join("half.xlap.gz.part").exists() && dir.join("junk.xlap.gz").exists());
    // And it is not examined again.
    assert_eq!(pass(&dir, &config), Report::default());
}

#[test]
fn send_lap_tells_the_classes_of_answer_apart() {
    let agent = net::agent();
    let answer = |status: u16| {
        let stub = Stub::start(move |_| Reply::new(status, "{}"));
        let config = config_for(&stub.url);
        let result = net::send_lap(&agent, &config, b"x");
        drop(stub);
        result
    };
    assert_eq!(answer(201), Ok(net::Sent::New));
    assert_eq!(answer(200), Ok(net::Sent::Duplicate));
    for status in [401, 403] {
        assert_eq!(answer(status), Err(SendError::Unauthorized), "{status}");
    }
    for status in [400, 413, 415, 422] {
        assert!(matches!(answer(status), Err(SendError::Rejected(_))), "{status}");
    }
    for status in [408, 429, 500, 502, 503, 504, 404, 301] {
        assert!(matches!(answer(status), Err(SendError::Later { .. })), "{status}");
    }
}

#[test]
fn pairing_trades_a_code_for_a_key() {
    let stub = Stub::start(|_| Reply::new(200, r#"{"token":"xpd_new","deviceId":"d1"}"#));
    let token = net::pair(&net::agent(), &stub.url, "ABCD2345", "RIG").unwrap();
    assert_eq!(token, "xpd_new");
    let seen = &stub.requests()[0];
    assert_eq!((seen.method.as_str(), seen.path.as_str()), ("POST", "/api/sim/pair"));
    assert!(!seen.headers.contains_key("authorization"), "there is no key yet");
    let body: serde_json::Value = serde_json::from_slice(&seen.body).unwrap();
    assert_eq!(body["code"], "ABCD2345");
    assert_eq!(body["device"]["name"], "RIG");
    assert_eq!(body["device"]["collector"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn pairing_explains_what_went_wrong() {
    let agent = net::agent();
    let attempt = |status: u16, body: &'static str| {
        let stub = Stub::start(move |_| Reply::new(status, body));
        net::pair(&agent, &stub.url, "ABCD2345", "RIG")
    };
    for status in [400, 404, 410] {
        assert!(attempt(status, "{}").unwrap_err().contains("not valid"), "{status}");
    }
    assert!(attempt(429, "{}").unwrap_err().contains("too many"));
    assert!(attempt(500, r#"{"error":"database down"}"#).unwrap_err().contains("database down"));
    assert!(attempt(200, "{}").unwrap_err().contains("no device key"));
    assert!(attempt(200, "not json").unwrap_err().contains("no device key"));
}

fn sent_count(dir: &Path, server: &str) -> usize {
    std::fs::read_to_string(dir.join(".xpeed-upload.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter(|v| v["server"] == server)
        .and_then(|v| v["sent"].as_array().map(Vec::len))
        .unwrap_or(0)
}

#[test]
fn the_worker_sends_when_told_and_keeps_trying_after_a_failure() {
    let dir = scratch_dir("worker");
    add_lap(&dir, 1);
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    // The first two answers are a failure; after that the server takes everything.
    let stub = Stub::start(move |_| {
        if counter.fetch_add(1, Ordering::SeqCst) < 2 {
            Reply::new(503, "{}")
        } else {
            Reply::new(201, "{}")
        }
    });
    let uploader = Uploader::start(
        dir.clone(),
        config_for(&stub.url),
        Backoff {
            base: Duration::from_millis(20),
            max: Duration::from_millis(80),
        },
    );
    wait_until("the first lap to go after two failures", || sent_count(&dir, &stub.url) == 1);
    assert_eq!(stub.requests().len(), 3);

    // Idle until the recorder saves another lap and says so.
    add_lap(&dir, 2);
    uploader.wake();
    wait_until("the second lap", || sent_count(&dir, &stub.url) == 2);
    assert_eq!(stub.requests().len(), 4);
    drop(uploader);
}

#[test]
fn the_worker_gives_up_on_a_refused_key_instead_of_knocking_forever() {
    let dir = scratch_dir("worker-401");
    add_lap(&dir, 1);
    let stub = Stub::start(|_| Reply::new(401, "{}"));
    let uploader = Uploader::start(
        dir.clone(),
        config_for(&stub.url),
        Backoff {
            base: Duration::from_millis(10),
            max: Duration::from_millis(20),
        },
    );
    wait_until("the refused try", || !stub.requests().is_empty());
    uploader.wake();
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(stub.requests().len(), 1);
    drop(uploader);
    assert!(dir.join("test-track_test-car_lap1_20261110120000.xlap.gz").exists());
}
