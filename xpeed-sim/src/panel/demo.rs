use super::*;

pub(super) const DEMO_TRACK_M: f64 = 2400.0;

/// The length of the demo's timed session: 25 minutes.
const DEMO_SESSION_S: f64 = 1500.0;

/// The player's class in the demo's field.
const DEMO_CLASS: &str = "GT3";

/// Thirteen rivals in two classes, GT3 and GTE: with the player (GT3) the field is P5 overall and P3 in the class. Each is its name,
/// its class, how far ahead of the player it is in laps (negative: behind) and how long its laps take. The first is a lap ahead
/// (it is lapping the player), the last a lap down.
const DEMO_RIVALS: [(&str, &str, f64, f64); 13] = [
    ("T. Kessler", "GTE", 1.045, 48.9),
    ("L. Moretti", "GT3", 0.10, 50.2),
    ("S. Okafor", "GTE", 0.06, 49.4),
    ("A. Dumont", "GT3", 0.025, 50.4),
    ("J. Brandt", "GT3", -0.02, 50.6),
    ("M. Silva", "GT3", -0.06, 50.9),
    ("K. Tanaka", "GTE", -0.11, 49.8),
    ("P. Novak", "GT3", -0.15, 51.1),
    ("E. Lund", "GTE", -0.25, 50.1),
    ("D. Costa", "GT3", -0.35, 51.4),
    ("H. Weber", "GTE", -0.55, 50.3),
    ("N. Ito", "GT3", -0.80, 51.7),
    ("C. Rossi", "GTE", -1.075, 50.6),
];

/// The demo's field for a player `dist` metres into lap `lap`: the rivals keep their places a little ahead of or behind the
/// player and drift a few tenths of a second from lap to lap, so the gaps move. The places, the class places and the gaps are
/// completed in the one shared place (`field::publish`).
pub(super) fn demo_field(lap: i32, dist: f64, clock_s: f64) -> std::sync::Arc<crate::field::Field> {
    let me = f64::from(lap - 1) + dist / DEMO_TRACK_M;
    let car = |slot: u16, name: &str, class: &str, raced: f64, lap_s: f64| crate::field::Car {
        class: Some(class.to_owned()),
        laps_done: Some(raced.floor() as i32),
        lap_share: Some(raced.fract() as f32),
        last_lap_s: Some(lap_s),
        best_lap_s: Some(lap_s * 0.985),
        ..crate::field::Car::named(slot, name)
    };
    let player = crate::field::Car {
        is_player: true,
        ..car(0, "You", DEMO_CLASS, me, 50.0)
    };
    let mut cars = vec![(me, player)];
    for (i, (name, class, offset_laps, lap_s)) in DEMO_RIVALS.iter().enumerate() {
        // Each one drifts a few thousandths of a lap round its place, at a pace of its own.
        let drift = 0.004 * (me * 2.0 * (1.0 + 0.37 * i as f64)).sin();
        // Before the first lap is done the cars behind sit on the line.
        let raced = (me + offset_laps + drift).max(0.0);
        cars.push((raced, car(i as u16 + 1, name, class, raced, *lap_s)));
    }
    cars.sort_by(|a, b| b.0.total_cmp(&a.0));
    let cars = cars
        .into_iter()
        .enumerate()
        .map(|(i, (_, car))| crate::field::Car {
            position: Some(i as u16 + 1),
            ..car
        })
        .collect();
    crate::field::publish(cars, clock_s, Some(DEMO_TRACK_M))
}

/// Made-up driving on a 2.4 km track, as one game would give it.
pub(super) fn demo_frame(lap: i32, dist: f64, lap_time: f64, last: Option<f64>, fuel: f32, pace: f64) -> crate::game::Frame {
    use std::f64::consts::TAU;
    let mut frame = crate::game::Frame::empty();
    let phase = TAU * dist / 800.0;
    let speed = (48.0 + 26.0 * phase.sin()) * pace;
    let accel = phase.cos();
    frame.driving = true;
    frame.lap = lap;
    frame.dist_m = Some(dist);
    frame.lap_time_s = Some(lap_time);
    frame.last_lap_s = last;
    frame.track = "Demo Ring".into();
    frame.car = "Demo GT3".into();
    frame.track_length_m = Some(DEMO_TRACK_M);
    frame.speed_ms = speed as f32;
    let gear = (1.0 + speed / 14.0).floor().min(6.0);
    frame.gear = gear as f32;
    frame.rpm = (4200.0 + (speed - (gear - 1.0) * 14.0) / 14.0 * 4000.0) as f32;
    frame.throttle = if accel > -0.2 {
        (0.6 + 0.4 * accel).clamp(0.0, 1.0) as f32
    } else {
        0.0
    };
    frame.brake = if accel < -0.4 {
        ((-accel - 0.4) * 1.6).min(1.0) as f32
    } else {
        0.0
    };
    frame.clutch = 0.0;
    frame.steer = (0.6 * (TAU * dist / 600.0).sin()) as f32;
    frame.fuel_l = fuel;
    // The tread wears about 1.4 % a lap, more on the rear tyres and on the right side.
    let worn = 0.014 * (f64::from(lap - 1) + dist / DEMO_TRACK_M);
    frame.tyres = Some(
        [(84.0, 1.0), (88.0, 1.1), (97.0, 1.25), (101.0, 1.35)].map(|(temp, rate): (f32, f64)| crate::game::Tyre {
            brake_c: temp * 3.4,
            temp_c: temp,
            pressure_kpa: 186.0 + (temp - 90.0) * 0.8,
            left: (1.0 - worn * rate).max(0.0) as f32,
            tread_c: None,
        }),
    );
    // The first two sectors are 800 m each, a little different on every lap.
    let sector = (800.0 / (48.0 * pace) * 1000.0).round();
    let first = (sector + 120.0 * (f64::from(lap) * 2.3).sin()).round() as u32;
    let second = (sector * 1.05 + 90.0 * (f64::from(lap) * 1.3).sin()).round() as u32;
    frame.sectors_ms = [(dist >= 800.0).then_some(first), (dist >= 1600.0).then_some(second)];
    // A yellow flag now and then, the green flag the rest of the lap.
    frame.state.flag = Some(if (lap_time / 10.0).floor() as i64 % 4 == 3 {
        crate::game::Flag::Yellow
    } else {
        crate::game::Flag::Green
    });
    // Fifth of 14 (third in its class) in a 25-minute session that counts down, a lap taking about 50 seconds.
    let field = demo_field(lap, dist, f64::from(lap - 1) * 50.0 + lap_time);
    let player = field.player();
    frame.race_position = player.and_then(|p| p.position);
    frame.class_position = player.and_then(|p| p.class_position);
    frame.cars = u16::try_from(field.cars.len()).ok();
    frame.field = Some(field);
    frame.session_time_left_s = Some((DEMO_SESSION_S - (f64::from(lap - 1) * 50.0 + lap_time)).max(0.0));
    frame
}

/// Opens the panel alone, fed with made-up driving, so it can be seen without a game. Nothing is recorded or sent.
pub fn demo(lang: Lang) -> std::process::ExitCode {
    use std::time::{Duration, Instant};
    crate::applog::line("panel demo: made-up data, nothing is recorded or sent");
    let shared = Shared::new(true);
    shared.set_game("lmu", "Le Mans Ultimate", Game::Waiting);
    shared.set_game("ac", "Assetto Corsa", Game::Connected);
    let feeder = {
        let shared = shared.clone();
        std::thread::spawn(move || {
            let mut tracker = crate::dash::Tracker::default();
            // What the demo's car gives, from the start: the cards of the sectors and the flag are there from the first frame.
            tracker.set_caps(demo_frame(1, 2000.0, 30.0, Some(50.0), 60.0, 1.0).filled());
            let (mut lap, mut dist, mut lap_time, mut last, mut fuel) = (1, 0.0, 0.0, None, 60.0f32);
            let start = Instant::now();
            let mut previous = Duration::ZERO;
            while !shared.quitting() {
                std::thread::sleep(Duration::from_millis(16));
                let now = start.elapsed();
                let dt = (now - previous).as_secs_f64();
                previous = now;
                // Each lap a little faster or slower than the one before, so the delta moves.
                let pace = 1.0 + 0.012 * (f64::from(lap) * 1.7).sin();
                let speed = f64::from(demo_frame(lap, dist, 0.0, None, fuel, pace).speed_ms);
                dist += speed * dt;
                lap_time += dt;
                fuel = (fuel - (dt * 0.004) as f32).max(0.0);
                if dist >= DEMO_TRACK_M {
                    last = Some(lap_time);
                    let saved = crate::status::SavedLap {
                        number: lap as u32,
                        time_ms: (lap_time * 1000.0).round() as u32,
                        valid: true,
                        sectors_ms: Vec::new(),
                        game: "Demo".into(),
                        track: "Demo".into(),
                        car: "Demo".into(),
                    };
                    crate::applog::line(&format!("panel demo: lap {lap} done"));
                    shared.update(|s| {
                        s.laps_saved += 1;
                        s.last_lap = Some(saved.clone());
                    });
                    shared.notify(crate::status::Notice::LapSaved(saved));
                    lap += 1;
                    dist -= DEMO_TRACK_M;
                    lap_time = 0.0;
                }
                shared.set_game("ac", "Assetto Corsa", Game::Recording(lap as u32));
                let frame = demo_frame(lap, dist, lap_time, last, fuel, pace);
                shared.offer_live(tracker.on_frame("Demo", &frame, now_ms()));
            }
        })
    };
    let [icon_big, icon_small] = crate::tray::program_icons();
    let hwnd = show(null_mut(), || Context {
        shared: shared.clone(),
        account: Arc::new(Mutex::new(Account {
            device: Some("DEMO".into()),
            server: "https://xpeed.skale.club".into(),
            label: None,
            lang,
            units: Default::default(),
        })),
        readers: crate::games::READERS.iter().map(|r| (r.title.to_owned(), r.ids.to_vec())).collect(),
        icon_big,
        icon_small,
        quit_on_close: true,
    });
    if !hwnd.is_null() {
        unsafe {
            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
    unsafe {
        DestroyIcon(icon_big);
        DestroyIcon(icon_small);
    }
    shared.quit();
    let _ = feeder.join();
    std::process::ExitCode::SUCCESS
}
