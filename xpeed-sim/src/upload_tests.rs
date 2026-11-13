//! The real client and the real outbox against a server that runs on this computer (`stub.rs`).

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::config::{scratch_dir, Config};
use crate::lapfile::{self, Channel, Lap};
use crate::net::{self, LinkStatus, SendError};
use crate::outbox::{upload_pending, upload_tracks, Backoff, Observer, Report, Stop, TrackState, Uploader};
use crate::status::Cloud;
use crate::stub::{Recorded, Reply, Stub};
use crate::tracks::{self, auto, Centerline, Track};

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
        account: None,
    }
}

fn pass(dir: &Path, config: &Config) -> Report {
    upload_pending(dir, config, &net::agent(), &mut |_| {})
}

/// An observer that remembers how the cloud side stood each time the worker said so.
fn watching() -> (Observer, Arc<Mutex<Vec<Cloud>>>) {
    let states = Arc::new(Mutex::new(Vec::new()));
    let seen = states.clone();
    let mut observer = Observer::silent();
    observer.cloud = Arc::new(move |state| seen.lock().unwrap().push(state));
    (observer, states)
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
    assert!(seen[0].headers["user-agent"].starts_with("xpeed-sim/"));
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
fn a_server_cannot_make_xpeed_sim_wait_for_days() {
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
    assert_eq!(body["device"]["app"], "xpeed-sim");
    assert_eq!(body["device"]["version"], env!("CARGO_PKG_VERSION"));
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
    let (observer, states) = watching();
    let uploader = Uploader::start(
        dir.clone(),
        config_for(&stub.url),
        Backoff {
            base: Duration::from_millis(20),
            max: Duration::from_millis(80),
        },
        observer,
    );
    wait_until("the first lap to go after two failures", || sent_count(&dir, &stub.url) == 1);
    assert_eq!(stub.requests().len(), 3);
    wait_until("the worker to say everything is sent", || {
        states.lock().unwrap().last() == Some(&Cloud::Idle)
    });
    let seen = states.lock().unwrap().clone();
    assert_eq!(
        seen.first(),
        Some(&Cloud::Waiting(1)),
        "it said the lap was waiting while the server failed: {seen:?}"
    );

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
    let (observer, states) = watching();
    let uploader = Uploader::start(
        dir.clone(),
        config_for(&stub.url),
        Backoff {
            base: Duration::from_millis(10),
            max: Duration::from_millis(20),
        },
        observer,
    );
    wait_until("the refused try", || !stub.requests().is_empty());
    wait_until("the worker to say the key was refused", || {
        states.lock().unwrap().contains(&Cloud::Refused)
    });
    uploader.wake();
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(stub.requests().len(), 1);
    drop(uploader);
    assert!(dir.join("test-track_test-car_lap1_20261110120000.xlap.gz").exists());
}

// ---------------------------------------------------------------------------------------------- track layouts

/// A small closed track (a 10 m square) as a track file; `y` changes the bytes without changing the track.
fn track_bytes(name: &str, y: f32) -> Vec<u8> {
    let track = Track {
        game: "ac".into(),
        name: name.into(),
        variant: Some("GP".into()),
        title: None,
        length_m: Some(40.0),
        source: "fast_lane.ai".into(),
        frame: tracks::FRAME.into(),
        closed: true,
        center_kind: "edges_midpoint".into(),
        centerline: Centerline {
            x: vec![0.0, 10.0, 10.0, 0.0],
            y: vec![y; 4],
            z: vec![0.0, 0.0, 10.0, 10.0],
            dist: vec![0.0, 10.0, 20.0, 30.0],
            left: vec![5.0; 4],
            right: vec![5.0; 4],
        },
        fast: None,
        pitlane: None,
    };
    tracks::gzip(&track).unwrap()
}

/// Puts a layout in the outbox of the laps folder `dir`, as `tracks::auto` would. Returns the outbox.
fn add_track(dir: &Path, file: &str, bytes: &[u8]) -> std::path::PathBuf {
    let outbox = dir.join(auto::TRACKS_DIR);
    std::fs::create_dir_all(&outbox).unwrap();
    std::fs::write(outbox.join(file), bytes).unwrap();
    outbox
}

fn track_pass(outbox: &Path, config: &Config) -> Report {
    upload_tracks(outbox, config, &net::agent(), &mut |_| {})
}

const LAYOUT: &str = "ac_test-track_gp_0000.xtrk.gz";

#[test]
fn sends_a_track_layout_once_and_again_only_when_its_file_changes() {
    let dir = scratch_dir("track-send");
    let bytes = track_bytes("Test Track", 0.0);
    let outbox = add_track(&dir, LAYOUT, &bytes);
    let stub = Stub::start(|_| Reply::new(201, r#"{"id":"t1","replaced":false}"#));
    let config = config_for(&stub.url);
    assert_eq!(
        track_pass(&outbox, &config),
        Report {
            sent: 1,
            ..Report::default()
        }
    );
    let seen = stub.requests();
    assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("POST", "/api/sim/tracks"));
    assert_eq!(seen[0].headers["authorization"], "Bearer xpd_test");
    assert_eq!(seen[0].headers["content-type"], "application/gzip");
    assert_eq!(seen[0].body, bytes, "the server gets the file untouched");
    let done = TrackState::load(&outbox, &stub.url).get(LAYOUT).cloned().unwrap();
    assert_eq!(
        (done.key.as_str(), done.hash, done.why),
        ("ac|test track|gp", auto::hash_hex(&bytes), None)
    );

    // Nothing changed: nothing goes.
    assert_eq!(track_pass(&outbox, &config), Report::default());
    assert_eq!(stub.requests().len(), 1);
    // The game's files changed and the layout was built again: it goes again, and the server replaces it.
    let changed = track_bytes("Test Track", 1.5);
    add_track(&dir, LAYOUT, &changed);
    assert_eq!(track_pass(&outbox, &config).sent, 1);
    assert_eq!(stub.requests()[1].body, changed);
    // Another server has none of them.
    let other = Stub::start(|_| Reply::new(201, "{}"));
    assert_eq!(track_pass(&outbox, &config_for(&other.url)).sent, 1);
    // The file itself is never changed or removed by sending.
    assert_eq!(std::fs::read(outbox.join(LAYOUT)).unwrap(), changed);
}

#[test]
fn a_layout_refused_for_good_is_not_offered_again_until_its_file_changes() {
    let dir = scratch_dir("track-rejected");
    let outbox = add_track(&dir, LAYOUT, &track_bytes("Test Track", 0.0));
    let stub = Stub::start(|_| Reply::new(422, r#"{"error":"bad_track","code":"bad_data","message":"the widths are wrong"}"#));
    let config = config_for(&stub.url);
    let mut lines = Vec::new();
    let report = upload_tracks(&outbox, &config, &net::agent(), &mut |line| lines.push(line));
    assert_eq!((report.sent, report.rejected, report.stopped), (0, 1, None));
    let why = TrackState::load(&outbox, &stub.url).get(LAYOUT).unwrap().why.clone().unwrap();
    assert!(
        why.contains("bad_track (bad_data): the widths are wrong") && why.contains("422"),
        "{why}"
    );
    assert!(lines.iter().any(|line| line.contains(&why)), "{lines:?}");
    assert_eq!(track_pass(&outbox, &config), Report::default());
    assert_eq!(stub.requests().len(), 1);
    add_track(&dir, LAYOUT, &track_bytes("Test Track", 2.0));
    assert_eq!(track_pass(&outbox, &config).rejected, 1, "a new file is a new try");
    assert_eq!(stub.requests().len(), 2);
}

#[test]
fn what_is_not_a_track_layout_never_leaves_the_computer() {
    let dir = scratch_dir("track-junk");
    let outbox = add_track(&dir, "junk.xtrk.gz", b"definitely not a track");
    std::fs::write(outbox.join("half.xtrk.gz.part"), b"still being written").unwrap();
    // A lap file put there by mistake is not a layout either.
    std::fs::write(outbox.join("a.xlap.gz"), lapfile::gzip(&lap(1)).unwrap()).unwrap();
    let stub = accepts_everything();
    let config = config_for(&stub.url);
    let report = track_pass(&outbox, &config);
    assert_eq!((report.sent, report.rejected), (0, 1));
    assert!(stub.requests().is_empty());
    assert_eq!(track_pass(&outbox, &config), Report::default());
    // No outbox at all (no layout was ever built) is not a problem.
    assert_eq!(track_pass(&dir.join("nothing-here"), &config), Report::default());
}

#[test]
fn a_refused_key_or_a_passing_problem_keeps_the_layouts_pending() {
    let dir = scratch_dir("track-later");
    let outbox = add_track(&dir, LAYOUT, &track_bytes("Test Track", 0.0));
    add_track(&dir, "ac_other_gp_0001.xtrk.gz", &track_bytes("Other", 0.0));
    let refused = Stub::start(|_| Reply::new(401, "{}"));
    let report = track_pass(&outbox, &config_for(&refused.url));
    assert_eq!((report.stopped, report.left), (Some(Stop::Unauthorized), 2));
    assert_eq!(refused.requests().len(), 1);
    let missing = Stub::start(|_| Reply::new(404, "Not found"));
    let Some(Stop::Later { reason, .. }) = track_pass(&outbox, &config_for(&missing.url)).stopped else {
        panic!()
    };
    assert!(reason.contains("does not receive track layouts"), "{reason}");
    assert_eq!(
        track_pass(&outbox, &config_for(&accepts_everything().url)).sent,
        2,
        "both are still there"
    );
}

#[test]
fn the_worker_sends_the_laps_and_then_the_track_layouts() {
    let dir = scratch_dir("worker-tracks");
    add_lap(&dir, 1);
    let outbox = add_track(&dir, LAYOUT, &track_bytes("Test Track", 0.0));
    let stub = accepts_everything();
    let uploader = Uploader::start(dir.clone(), config_for(&stub.url), Backoff::default(), Observer::silent());
    wait_until("the layout to go", || TrackState::load(&outbox, &stub.url).get(LAYOUT).is_some());
    let paths: Vec<String> = stub.requests().into_iter().map(|r| r.path).collect();
    assert_eq!(paths, ["/api/sim/laps", "/api/sim/tracks"]);
    // A layout built later goes when the worker is woken, like a lap.
    add_track(&dir, "ac_other_gp_0001.xtrk.gz", &track_bytes("Other", 0.0));
    uploader.wake();
    wait_until("the second layout", || stub.requests().len() == 3);
    drop(uploader);
}

#[test]
fn starting_a_connection_sends_the_hash_of_the_key_and_never_the_key() {
    let stub = Stub::start(|_| Reply::new(201, r#"{"id":"abc-123","expiresAt":"2026-11-13T12:10:00.000Z"}"#));
    let key = crate::connect::new_key().unwrap();
    let hash = net::sha256_hex(key.as_bytes());
    let (id, expires) = net::link_start(&net::agent(), &stub.url, "RIG", &hash).unwrap();
    assert_eq!((id.as_str(), expires.as_str()), ("abc-123", "2026-11-13T12:10:00.000Z"));
    let seen = stub.requests();
    assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("POST", "/api/sim/link"));
    let body: serde_json::Value = serde_json::from_slice(&seen[0].body).unwrap();
    assert_eq!(body["device"]["name"], "RIG");
    assert_eq!(body["tokenHash"], hash);
    assert_eq!(hash.len(), 64);
    assert!(hash.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    let text = String::from_utf8(seen[0].body.clone()).unwrap();
    assert!(!text.contains(&key), "the key never leaves the computer in the request");
    assert!(!seen[0].headers.contains_key("authorization"));
}

#[test]
fn starting_a_connection_explains_what_went_wrong() {
    let agent = net::agent();
    let refused = Stub::start(|_| Reply::new(409, r#"{"error":"invalid_request"}"#));
    let why = net::link_start(&agent, &refused.url, "RIG", "00").unwrap_err();
    assert!(why.contains("409") && why.contains("invalid_request"), "{why}");
    let slow = Stub::start(|_| Reply::new(429, "").header("Retry-After", "30"));
    assert!(net::link_start(&agent, &slow.url, "RIG", "00")
        .unwrap_err()
        .contains("too many attempts"));
    let broken = Stub::start(|_| Reply::new(201, "{}"));
    assert!(net::link_start(&agent, &broken.url, "RIG", "00").is_err());
}

#[test]
fn polling_sends_the_key_as_bearer_and_reads_all_four_statuses() {
    let stub = Stub::start(|request| {
        let status = request.path.rsplit('/').nth(1).unwrap_or_default().to_owned();
        match status.as_str() {
            "pending-id" => Reply::new(200, r#"{"status":"pending"}"#),
            "approved-id" => Reply::new(200, r#"{"status":"approved","account":"ana@example.com"}"#),
            "cancelled-id" => Reply::new(200, r#"{"status":"cancelled"}"#),
            "expired-id" => Reply::new(200, r#"{"status":"expired"}"#),
            "limited-id" => Reply::new(429, ""),
            _ => Reply::new(404, r#"{"error":"not_found"}"#),
        }
    });
    let agent = net::agent();
    let poll = |id: &str| net::link_poll(&agent, &stub.url, id, "xpd_the-key");
    assert_eq!(poll("pending-id"), Ok(LinkStatus::Pending));
    assert_eq!(
        poll("approved-id"),
        Ok(LinkStatus::Approved {
            account: "ana@example.com".into()
        })
    );
    assert_eq!(poll("cancelled-id"), Ok(LinkStatus::Cancelled));
    assert_eq!(poll("expired-id"), Ok(LinkStatus::Expired));
    assert!(poll("limited-id").unwrap_err().contains("too many attempts"));
    assert!(poll("nobody").unwrap_err().contains("click Connect again"));
    let seen = stub.requests();
    assert_eq!(
        (seen[0].method.as_str(), seen[0].path.as_str()),
        ("POST", "/api/sim/link/pending-id/poll")
    );
    assert_eq!(seen[0].headers["authorization"], "Bearer xpd_the-key");
    assert!(seen[0].body.is_empty());
}

#[test]
fn whoami_sends_the_key_as_bearer_and_reads_the_account() {
    let stub = Stub::start(|_| Reply::new(200, r#"{"account":"ana@example.com","deviceName":"RIG"}"#));
    let agent = net::agent();
    assert_eq!(net::whoami(&agent, &stub.url, "xpd_the-key"), Ok("ana@example.com".to_owned()));
    let seen = stub.requests();
    assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("GET", "/api/sim/me"));
    assert_eq!(seen[0].headers["authorization"], "Bearer xpd_the-key");
}

#[test]
fn whoami_with_a_refused_key_or_a_broken_answer_is_an_error() {
    let stub = Stub::start(|_| Reply::new(401, r#"{"error":"unauthorized"}"#));
    let agent = net::agent();
    assert!(net::whoami(&agent, &stub.url, "xpd_revoked")
        .unwrap_err()
        .contains("does not accept"));
    let odd = Stub::start(|_| Reply::new(200, "not json"));
    assert!(net::whoami(&agent, &odd.url, "xpd_k").is_err());
    let down = Stub::start(|_| Reply::new(503, r#"{"error":"unavailable"}"#));
    assert!(net::whoami(&agent, &down.url, "xpd_k").is_err());
}
