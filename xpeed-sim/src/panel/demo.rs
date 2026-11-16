use super::*;

pub(super) const DEMO_TRACK_M: f64 = 2400.0;

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
                    let label = format!("Lap {lap}  {}", lap_clock(Some(lap_time)).unwrap_or_default());
                    crate::applog::line(&format!("panel demo: lap {lap} done"));
                    shared.update(|s| {
                        s.laps_saved += 1;
                        s.last_lap = Some(label.clone());
                    });
                    shared.notify(crate::status::Notice::LapSaved(label));
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
