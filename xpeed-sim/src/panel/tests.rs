use super::demo::demo_frame;
use super::*;
use crate::status::saved_lap;

#[test]
fn the_account_card_says_connected_when_the_account_is_unknown_never_the_host() {
    use crate::connect::{card, Card, Phase};
    let unknown = card(true, &Phase::Idle, None);
    assert_eq!(unknown, Card::Connected { who: None });
    let Card::Connected { who } = unknown else { unreachable!() };
    assert_eq!(connected_line(Lang::En, who.as_deref()), "Connected");
    assert_eq!(connected_line(Lang::Pt, who.as_deref()), "Conectado");
    assert_eq!(connected_line(Lang::Es, who.as_deref()), "Conectado");
    assert_eq!(connected_line(Lang::En, Some("ana@example.com")), "Connected as ana@example.com");
}

#[test]
fn the_wheel_bar_fills_toward_the_turn_and_stays_straight_without_a_value() {
    assert_eq!(steer_share(0.0), 0.0);
    assert_eq!(steer_share(0.5), 0.5);
    assert_eq!(steer_share(-1.0), -1.0);
    assert_eq!(steer_share(3.0), 1.0);
    assert_eq!(steer_share(-3.0), -1.0);
    assert_eq!(steer_share(f32::NAN), 0.0);
}

#[test]
fn a_dragged_carousel_settles_on_a_cover_leaning_the_way_it_was_dragged() {
    let mut c = Carousel::new(0);
    c.hold(0.3);
    assert_eq!(c.at(10), 0.3, "held where the mouse is");
    c.tick(1_000_000);
    assert_eq!(c.at(1_000_000), 0.3, "no moving on by itself while held");
    c.let_go(0.0, 100);
    assert_eq!(c.target, 1, "a third of a cover to the right goes on to the next");
    assert_eq!(c.at(100), 0.3, "and eases from where it was let go");
    assert!((c.at(100 + SLIDE_MS) - 1.0).abs() < 1e-6);
    let mut c = Carousel::new(0);
    c.hold(-0.1);
    c.let_go(0.0, 0);
    assert_eq!(c.target, 0, "a tenth of a cover goes back");
    let mut c = Carousel::new(0);
    c.hold(1.7);
    c.let_go(2.0, 0);
    assert_eq!(c.target, 1, "dragged back past a fifth: the previous cover");
}

#[test]
fn the_waiting_screen_is_about_the_most_interesting_open_game() {
    assert_eq!(focus_of(&[("ac", "Assetto Corsa", Game::Waiting)]), None);
    let games = [
        ("ac", "Assetto Corsa", Game::Waiting),
        ("ams2", "Automobilista 2", Game::Silent),
        ("f1", "EA SPORTS F1 25", Game::Connected),
    ];
    assert_eq!(focus_of(&games), Some(("f1", "EA SPORTS F1 25", Game::Connected)));
    assert_eq!(focus_of(&games[..2]), Some(("ams2", "Automobilista 2", Game::Silent)));
}

#[test]
fn a_game_that_is_loading_ranks_like_one_open_without_data_and_says_to_wait() {
    let loading = ("ams2", "Automobilista 2", Game::Loading);
    assert_eq!(
        focus_of(&[("ac", "Assetto Corsa", Game::Waiting), loading.clone()]),
        Some(loading.clone())
    );
    let silent = ("lmu", "Le Mans Ultimate", Game::Silent);
    // Same rank: the last of the two is the focus, whichever order (so neither beats the other).
    assert_eq!(focus_of(&[loading.clone(), silent.clone()]), Some(silent.clone()));
    assert_eq!(focus_of(&[silent.clone(), loading.clone()]), Some(loading.clone()));
    let paused = ("ac", "Assetto Corsa", Game::Paused);
    assert_eq!(focus_of(&[loading.clone(), paused.clone()]), Some(paused), "paused beats loading");
    let f = fixture();
    let view = view(&f, None, Tab::Dash, 1.0, Lang::En);
    let (title, line, note, act) = focus_words(&view, loading);
    assert_eq!(title, "Automobilista 2 is open");
    assert_eq!(line, text(Lang::En, &Msg::FocusLoading));
    assert!(line.starts_with("Loading"), "{line}");
    assert_eq!(note, None, "no note while it loads");
    assert!(!act, "muted, not the colour of something to do");
    let (_, setup, _, act) = focus_words(&view, silent);
    assert_ne!(setup, line);
    assert!(act, "no data after the wait: there is something to do");
    assert_eq!(state_text(Lang::En, &Game::Loading), "loading");
    assert_eq!(state_color(&Game::Loading), MUTED_TEXT);
}

#[test]
fn the_panel_tells_a_game_open_without_data_which_setting_to_turn_on_in_the_persons_language() {
    let f = fixture();
    for lang in Lang::ALL {
        let view = view(&f, None, Tab::Dash, 1.0, lang);
        for &(_, id, name) in crate::games::PROGRAMS {
            let (title, line, note, act) = focus_words(&view, (id, name, Game::Silent));
            assert_eq!(line, text(lang, &Msg::Setup(id)), "{name} {lang:?}");
            assert!(title.contains(name), "{title}");
            assert!(
                act && note.is_some(),
                "{name}: something to do, and the promise that it connects by itself"
            );
        }
    }
    let view = view(&f, None, Tab::Dash, 1.0, Lang::En);
    assert!(focus_words(&view, ("ams2", "Automobilista 2", Game::Silent))
        .1
        .contains("Use Shared Memory"));
    assert!(focus_words(&view, ("f1", "EA SPORTS F1 25", Game::Silent))
        .1
        .contains("UDP Telemetry"));
    // Not running, loading, connected: no instruction on the screen.
    for game in [Game::Loading, Game::Connected, Game::Paused] {
        let (_, line, _, act) = focus_words(&view, ("ams2", "Automobilista 2", game));
        assert_ne!(line, text(Lang::En, &Msg::Setup("ams2")));
        assert!(!act);
    }
}

#[test]
fn the_window_opens_16_by_9_from_the_screen_it_is_on() {
    assert_eq!(opening_size(1920, 1032, 1.0), (1536, 864), "a 1920 x 1080 screen with its taskbar");
    assert_eq!(opening_size(2560, 1392, 1.0), (2048, 1152));
    assert_eq!(opening_size(1366, 728, 1.0), (1093, 615));
    let (w, h) = opening_size(800, 560, 1.0);
    assert!(w >= MIN_WIDTH && h >= MIN_HEIGHT, "never under the smallest window: {w} x {h}");
}

#[test]
fn a_click_on_a_cover_goes_there_the_nearest_way() {
    assert_eq!(carousel_steps(0, 3, 9), 3);
    assert_eq!(carousel_steps(0, 7, 9), -2, "round the other side is shorter");
    assert_eq!(carousel_steps(11, 2, 9), 0, "11 is cover 2 after going round once");
    assert_eq!(carousel_steps(-1, 0, 9), 1);
    assert_eq!(carousel_steps(5, 0, 0), 0);
}

#[test]
fn a_line_for_several_games_names_only_those_installed() {
    let ids = ["ac", "acc", "acr"];
    let title = "Assetto Corsa \u{b7} ACC \u{b7} AC Rally";
    assert_eq!(line_title(title, &ids, &ids), title);
    assert_eq!(line_title(title, &ids, &["acc", "acr"]), "ACC \u{b7} AC Rally");
    assert_eq!(
        line_title(title, &ids, &["acc"]),
        "Assetto Corsa Competizione",
        "one game: its full name"
    );
    assert_eq!(line_title("iRacing", &["iracing"], &["iracing"]), "iRacing");
}

#[test]
fn games_list_fits_its_room_and_scrolls_the_rest() {
    // Plenty of room: full-height lines, no scrolling.
    assert_eq!(games_layout(7, 1000.0), (50.0 + 52.0 * 7.0, 52.0, 0.0));
    // Less: lower lines, still no scrolling.
    let (h, row, max) = games_layout(7, 400.0);
    assert!((44.0..52.0).contains(&row) && max == 0.0 && h <= 400.0);
    // Too little: the card fills its room exactly and the rest of the list scrolls.
    for room in [94.0, 150.0, 250.0] {
        let (h, row, max) = games_layout(7, room);
        assert_eq!(row, 44.0);
        assert_eq!(h, room);
        assert_eq!(max, 44.0 * 7.0 - (room - 50.0), "{room}");
    }
}

#[test]
fn buttons_wrap_to_a_new_line_when_the_card_is_narrow() {
    assert_eq!(button_lines(&[200.0, 180.0], 400.0), vec![(0, 0.0), (0, 210.0)]);
    assert_eq!(button_lines(&[200.0, 180.0], 300.0), vec![(0, 0.0), (1, 0.0)]);
    assert_eq!(
        button_lines(&[320.0], 300.0),
        vec![(0, 0.0)],
        "a lone button stays on the first line"
    );
}
use crate::game::Frame;

use windows_sys::Win32::Graphics::Gdi::{CreateDIBSection, GdiFlush, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS};

/// Paints a view into a bitmap and gives back its pixels (BGRA, top row first).
fn render(view: &View, width: i32, height: i32) -> Vec<u8> {
    unsafe {
        let hdc = CreateCompatibleDC(null_mut());
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut bits: *mut std::ffi::c_void = null_mut();
        let bitmap = CreateDIBSection(hdc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
        assert!(!bitmap.is_null());
        let old = SelectObject(hdc, bitmap);
        paint(hdc, width, height, view);
        GdiFlush();
        let pixels = std::slice::from_raw_parts(bits.cast::<u8>(), (width * height * 4) as usize).to_vec();
        SelectObject(hdc, old);
        DeleteObject(bitmap);
        DeleteDC(hdc);
        pixels
    }
}

/// How many pixels are clearly red (thin text never gets a pixel of exactly its colour at a small size).
fn reddish(pixels: &[u8]) -> usize {
    pixels
        .as_chunks::<4>()
        .0
        .iter()
        .filter(|p| p[2] > 170 && p[1] < 110 && p[0] < 110)
        .count()
}

fn has_color(pixels: &[u8], color: COLORREF) -> usize {
    let (r, g, b) = ((color & 0xff) as u8, (color >> 8 & 0xff) as u8, (color >> 16 & 0xff) as u8);
    pixels
        .as_chunks::<4>()
        .0
        .iter()
        .filter(|p| p[0] == b && p[1] == g && p[2] == r)
        .count()
}

/// Saves the picture when `XPEED_SIM_PANEL_PNG` names a folder (to look at it); otherwise nothing.
fn save(pixels: &[u8], width: i32, height: i32, name: &str) {
    let Some(dir) = std::env::var_os("XPEED_SIM_PANEL_PNG") else {
        return;
    };
    let path = std::path::Path::new(&dir).join(name);
    let file = std::fs::File::create(&path).unwrap();
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let rgba: Vec<u8> = pixels.as_chunks::<4>().0.iter().flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    encoder.write_header().unwrap().write_image_data(&rgba).unwrap();
}

/// Every group of values a game can give.
fn every_cap() -> crate::game::Caps {
    crate::game::Caps::ALL
        .iter()
        .fold(crate::game::Caps::NONE, |all, (cap, _)| all.or(*cap))
}

/// The dashboard model of a reading, as of the moment it arrived.
fn model(live: &Live, lang: Lang) -> DashModel {
    dashboard(live, &ctx_of(lang, live.at_ms))
}

/// What the model needs besides the reading: a language and a time, the default units and no saved laps.
fn ctx_of(lang: Lang, now_ms: i64) -> ModelCtx<'static> {
    ModelCtx {
        lang,
        now_ms,
        units: Default::default(),
        laps: &[],
    }
}

fn live_reading() -> Live {
    let mut tracker = crate::dash::Tracker::default();
    let mut frame = Frame::empty();
    frame.driving = true;
    frame.lap = 4;
    frame.track = "Autodromo Nazionale Monza".into();
    frame.car = "Ferrari 296 GT3".into();
    frame.track_length_m = Some(5793.0);
    frame.rpm = 8000.0;
    tracker.on_frame("Assetto Corsa", &frame, 0);
    frame.dist_m = Some(2310.0);
    frame.lap_time_s = Some(41.532);
    frame.last_lap_s = Some(107.918);
    frame.speed_ms = 71.4;
    frame.rpm = 7350.0;
    frame.gear = 5.0;
    frame.throttle = 0.92;
    frame.brake = 0.0;
    frame.clutch = 0.0;
    frame.steer = -0.18;
    frame.fuel_l = 38.6;
    frame.tyres = Some(
        [(84.0, 26.9, 0.91), (88.0, 27.2, 0.9), (97.0, 26.4, 0.86), (101.0, 26.6, 0.84)].map(|(t, psi, left)| crate::game::Tyre {
            brake_c: t * 3.4,
            temp_c: t,
            pressure_kpa: psi * 6.894_757,
            left,
            tread_c: None,
        }),
    );
    let mut live = tracker.on_frame("Assetto Corsa", &frame, 1_000);
    live.caps = every_cap();
    let track: Vec<(f32, f32)> = (0..400)
        .map(|i| {
            let t = i as f32 / 400.0 * std::f32::consts::TAU;
            (600.0 * t.cos() + 130.0 * (3.0 * t).cos(), 300.0 * t.sin() - 110.0 * (2.0 * t).sin())
        })
        .collect();
    live.pos = Some(track[160]);
    let direction = (track[161].0 - track[159].0, track[161].1 - track[159].1);
    let length = direction.0.hypot(direction.1);
    live.heading = Some((direction.0 / length, direction.1 / length));
    live.trail = Arc::new(track[150..=160].to_vec());
    live.map = Some(std::sync::Arc::new(track));
    live.map_complete = true;
    live.best_lap_s = Some(107.204);
    live.delta_s = Some(-0.27);
    // The delta along the lap so far: 40% of the lap, a little behind early on, ending 0.27 s ahead.
    live.delta_trace = Arc::new(
        (0..=80)
            .map(|i| {
                let at = i as f32 * 0.005;
                let k = at / 0.4;
                (at, 0.12 * (at * 40.0).sin() * (1.0 - k) - 0.27 * k)
            })
            .collect(),
    );
    live.fuel_per_lap_l = Some(2.9);
    live.fuel_last_lap_l = Some(2.84);
    // The throttle and brake of the last 5 s: flat out, a brake into a corner, then back on the throttle.
    live.inputs = Arc::new(
        (0..=125)
            .map(|i| {
                let k = i as f32 / 125.0;
                let throttle = if (0.3..0.5).contains(&k) { 0.0 } else { 1.0 };
                let brake = if (0.3..0.42).contains(&k) { 0.9 } else { 0.0 };
                (live.at_ms - 5_000 + i as i64 * 40, throttle, brake)
            })
            .collect(),
    );
    live.fuel_this_lap_l = Some(1.12);
    live.state = crate::game::CarState {
        pit_limiter: Some(false),
        abs_active: Some(true),
        tc_active: Some(false),
        drs: Some(crate::game::Drs::Available),
        headlights: Some(true),
        handbrake: Some(false),
        engine_warning: Some(false),
        flag: Some(crate::game::Flag::Yellow),
        water_c: Some(92.0),
        oil_c: Some(108.0),
        tc_level: Some(3),
        abs_level: Some(2),
        engine_map: Some(1),
        brake_bias: Some(0.56),
        damage_body: Some(0.12),
        damage_engine: Some(0.0),
        damage_gearbox: Some(0.05),
        damage_suspension: Some(0.4),
    };
    live
}

struct Fixture {
    snapshot: Snapshot,
    games: Vec<GameRow>,
    laps: Vec<SavedLap>,
    log: Vec<(String, String)>,
    update: crate::update::UpdateState,
    check: crate::update::CheckState,
    percent: Option<u8>,
}

fn fixture() -> Fixture {
    Fixture {
        snapshot: Snapshot {
            game: Game::Recording(4),
            title: Some("Assetto Corsa"),
            cloud: Cloud::Idle,
            laps_saved: 3,
            last_lap: Some(saved_lap(3, 107_918)),
        },
        games: vec![
            GameRow {
                key: "lmu",
                title: "Le Mans Ultimate".into(),
                state: Game::Waiting,
            },
            GameRow {
                key: "ac",
                title: "Assetto Corsa · ACC · AC Rally".into(),
                state: Game::Recording(4),
            },
            GameRow {
                key: "ams2",
                title: "Automobilista 2".into(),
                state: Game::Waiting,
            },
            GameRow {
                key: "iracing",
                title: "iRacing".into(),
                state: Game::Connected,
            },
            GameRow {
                key: "rfactor1",
                title: "Stock Car Extreme".into(),
                state: Game::Unsupported,
            },
        ],
        laps: vec![
            saved_lap(1, 109_002),
            SavedLap {
                valid: false,
                ..saved_lap(2, 108_115)
            },
            saved_lap(3, 107_918),
        ],
        log: vec![
            ("21:47".into(), "Lap saved: Lap 3  1:47.918".into()),
            ("21:45".into(), "Lap saved: Lap 2  1:48.115".into()),
            ("21:43".into(), "Lap saved: Lap 1  1:49.002".into()),
            ("21:41".into(), "Assetto Corsa connected".into()),
            ("21:40".into(), "Connected as RIG".into()),
        ],
        update: crate::update::UpdateState::Nothing,
        check: crate::update::CheckState::Idle,
        percent: None,
    }
}

fn view<'a>(f: &'a Fixture, live: Option<&'a Live>, tab: Tab, scale: f32, lang: Lang) -> View<'a> {
    View {
        lang,
        units: Default::default(),
        tab,
        on_top: tab == Tab::Monitor,
        full: false,
        scale,
        now_ms: 1_500,
        snapshot: &f.snapshot,
        live,
        games: &f.games,
        device: Some("RIG"),
        server: "https://xpeed.skale.club",
        coach_available: true,
        card: crate::connect::card(
            matches!(f.snapshot.cloud, Cloud::Idle | Cloud::Waiting(_)),
            &crate::connect::Phase::Idle,
            Some("ana@example.com"),
        ),
        recent_laps: &f.laps,
        activity: &f.log,
        covers: &[],
        brands: &[],
        mouse: None,
        buttons: Default::default(),
        carousel: 0.0,
        games_scroll: 0.0,
        scroll: Default::default(),
        carousel_step: Default::default(),
        layout: Default::default(),
        lang_open: false,
        copied: false,
        failed: "",
        update: &f.update,
        check: &f.check,
        download_percent: f.percent,
        focus: None,
    }
}

/// Historical output drives the same tracker and native renderer used by live telemetry; no generated circuit.
#[test]
fn real_laguna_positions_move_the_native_perspective_and_keep_the_arrow() {
    let lap = crate::lapfile::gunzip(
        include_bytes!("../../fixtures/laps/acevo-real-lap-3.xlap.gz"),
        crate::lapfile::MAX_UNPACKED,
    )
    .unwrap();
    let xs = &lap.channel("x").unwrap().values;
    let zs = &lap.channel("z").unwrap().values;
    let times = &lap.channel("t").unwrap().values;
    // This historical output predates the EVO x-axis correction. Match the current reader's documented frame.
    let positions: Arc<Vec<_>> = Arc::new(xs.iter().map(|x| -*x).zip(zs.iter().copied()).step_by(4).collect());
    let mut tracker = crate::dash::Tracker::default();
    let mut f = fixture();
    f.laps.clear();
    let mut previous = None;
    for target in [2500, 5500, 8000] {
        let mut live = None;
        for i in target - 80..=target {
            let mut frame = Frame::empty();
            frame.driving = true;
            frame.phase = crate::game::Phase::Driving;
            frame.track = lap.track_name.clone();
            frame.car = lap.car_name.clone();
            frame.lap = 3;
            frame.x = -xs[i];
            frame.z = zs[i];
            let value = |id| lap.channel(id).map_or(f32::NAN, |c| c.values[i]);
            frame.speed_ms = value("speed");
            frame.rpm = value("rpm");
            frame.gear = value("gear");
            frame.throttle = value("throttle");
            frame.brake = value("brake");
            frame.clutch = value("clutch");
            frame.steer = value("steer");
            frame.fuel_l = value("fuel");
            frame.track_length_m = lap.track_length_m;
            frame.dist_m = Some(f64::from(value("dist"))).filter(|d| d.is_finite());
            frame.lap_time_s = Some(f64::from(times[i]));
            live = Some(tracker.on_frame("acevo", &frame, (times[i] * 1000.0) as i64));
        }
        let mut live = live.unwrap();
        assert!(live.heading.is_some(), "real movement establishes a forward direction");
        live.map = Some(positions.clone());
        live.map_complete = true;
        let mut native_view = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
        native_view.now_ms = live.at_ms;
        let pixels = render(&native_view, 1280, 800);
        save(&pixels, 1280, 800, &format!("panel-laguna-{target}.png"));
        assert!(has_color(&pixels, PRIMARY) > 100, "the opaque arrow and live values are painted");
        if let Some(before) = previous {
            assert_ne!(pixels, before, "the native frame follows the actual position");
        }
        previous = Some(pixels);
    }
}

/// Local acceptance using proprietary assets kept outside the committed fixtures.
#[test]
#[ignore = "requires XPEED_EVO_PILOT_TRACK: a locally extracted, uncommitted EVO XTRK v2 file"]
fn native_evo_pilot_replays_real_lap_with_source_boundaries() {
    let path = std::env::var_os("XPEED_EVO_PILOT_TRACK").expect("set XPEED_EVO_PILOT_TRACK");
    let track = crate::tracks::gunzip(&std::fs::read(path).unwrap(), crate::tracks::MAX_UNPACKED).unwrap();
    assert_eq!((track.game.as_str(), track.name.as_str()), ("acevo", "Laguna Seca"));
    assert!(track.boundaries.is_some());
    let road = Arc::new(crate::perspective::Road::from_track(&track).expect("native source road"));
    let layout = Arc::new(track.centerline.x.iter().copied().zip(track.centerline.z.iter().copied()).collect());
    let lap = crate::lapfile::gunzip(
        include_bytes!("../../fixtures/laps/acevo-real-lap-3.xlap.gz"),
        crate::lapfile::MAX_UNPACKED,
    )
    .unwrap();
    let xs = &lap.channel("x").unwrap().values;
    let zs = &lap.channel("z").unwrap().values;
    let times = &lap.channel("t").unwrap().values;
    let mut tracker = crate::dash::Tracker::default();
    let mut f = fixture();
    f.laps.clear();
    for target in [2500, 5500, 8000] {
        let mut live = None;
        for i in target - 80..=target {
            let mut frame = Frame::empty();
            frame.driving = true;
            frame.phase = crate::game::Phase::Driving;
            frame.track = lap.track_name.clone();
            frame.car = lap.car_name.clone();
            frame.lap = 3;
            frame.x = -xs[i];
            frame.z = zs[i]; // Historical recordings predate the reader's x reflection.
            frame.speed_ms = lap.channel("speed").unwrap().values[i];
            frame.dist_m = Some(lap.channel("dist").unwrap().values[i] as f64);
            frame.lap_time_s = Some(times[i] as f64);
            live = Some(tracker.on_frame("acevo", &frame, (times[i] * 1000.0) as i64));
        }
        let mut live = live.unwrap();
        live.map = Some(Arc::clone(&layout));
        live.map_complete = true;
        live.road = Some(Arc::clone(&road));
        let heading = live.heading.expect("motion provides heading");
        let points = crate::perspective::PreparedPath::new(&layout, true);
        let camera = crate::perspective::Camera {
            width: 736.0,
            height: 400.0,
            car: (-xs[target], zs[target]),
            heading,
            mirrored: false,
        };
        let scene = crate::perspective::scene(camera, &points, Some(&road), &Default::default(), None);
        assert!(
            scene.road.len() > 20 && scene.edges.len() > 40,
            "real source boundaries project into view"
        );
        let mut native_view = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
        native_view.now_ms = live.at_ms;
        let pixels = render(&native_view, 1280, 800);
        save(&pixels, 1280, 800, &format!("panel-evo-native-{target}.png"));
    }
}

/// The pixels of `region` (x0, y0, x1, y1) of a `width`-wide render.
fn region_of(pixels: &[u8], width: i32, region: (i32, i32, i32, i32)) -> Vec<u8> {
    let mut out = Vec::new();
    for y in region.1..region.3 {
        let from = ((y * width + region.0) * 4) as usize;
        out.extend_from_slice(&pixels[from..from + ((region.2 - region.0) * 4) as usize]);
    }
    out
}

#[test]
fn paints_the_monitor_and_scales_with_the_screen() {
    let f = fixture();
    let (w, h) = (1440, 900);
    let pixels = render(&view(&f, None, Tab::Monitor, 1.5, Lang::En), w, h);
    save(&pixels, w, h, "panel-monitor-150.png");
    assert!(has_color(&pixels, CARD) > 100_000, "the cards fill most of the window");
    assert!(has_color(&pixels, DESTRUCTIVE) > 10, "the unsupported game has a red dot");
}

#[test]
fn the_monitor_shows_a_card_for_a_new_version_with_the_button_that_installs_it() {
    use crate::update::UpdateState;
    let mut f = fixture();
    let plain = render(&view(&f, None, Tab::Monitor, 1.0, Lang::En), 1280, 800);
    let with = |f: &Fixture, lang: Lang, w: i32, h: i32| {
        let v = view(f, None, Tab::Monitor, 1.0, lang);
        let pixels = render(&v, w, h);
        let buttons: Vec<(Action, RECT)> = v.buttons.borrow().iter().map(|(a, r)| (*a, *r)).collect();
        (pixels, buttons)
    };
    // Nothing waiting: no "Update now"; the card offers "Check now" instead (it is always there, as in Xdeck).
    let idle = with(&f, Lang::En, 1280, 800).1;
    assert!(!idle.iter().any(|(a, _)| *a == Action::UpdateNow));
    assert!(idle.iter().any(|(a, _)| *a == Action::CheckUpdates));
    // Available: the button is drawn, inside the window, clear of the other buttons, and the account card still fits.
    f.update = UpdateState::Available {
        version: "0.6.0".into(),
        required: false,
        held: false,
    };
    for (w, h) in [(1280, 800), (1024, 640), (720, 480), (430, 900)] {
        let (pixels, buttons) = with(&f, Lang::En, w, h);
        if (w, h) == (1280, 800) {
            save(&pixels, w, h, "panel-monitor-update.png");
        }
        let update = buttons
            .iter()
            .find(|(a, _)| *a == Action::UpdateNow)
            .unwrap_or_else(|| panic!("{w}x{h}: the button is drawn"))
            .1;
        assert!(
            update.left >= 0 && update.top >= 0 && update.right <= w && update.bottom <= h,
            "{w}x{h}: inside the window"
        );
        for (action, r) in &buttons {
            if *action != Action::UpdateNow {
                let apart = r.right <= update.left || r.left >= update.right || r.bottom <= update.top || r.top >= update.bottom;
                assert!(apart, "{w}x{h}: {action:?} does not touch the update button");
            }
        }
    }
    // Required: the same button, and red where it was not.
    let available_red = has_color(&with(&f, Lang::En, 1280, 800).0, DESTRUCTIVE);
    f.update = UpdateState::Available {
        version: "0.6.0".into(),
        required: true,
        held: false,
    };
    let (required, buttons) = with(&f, Lang::Pt, 1280, 800);
    save(&required, 1280, 800, "panel-monitor-update-required.png");
    assert!(buttons.iter().any(|(a, _)| *a == Action::UpdateNow));
    assert!(
        has_color(&required, DESTRUCTIVE) > available_red + 100,
        "a required update is shown in red"
    );
    assert!(
        has_color(&plain, DESTRUCTIVE) < has_color(&required, DESTRUCTIVE),
        "and the same screen without an update has less red"
    );
    // Downloading, or waiting for a game to close: told, with no button to press.
    for state in [
        UpdateState::Downloading { version: "0.6.0".into() },
        UpdateState::Available {
            version: "0.6.0".into(),
            required: false,
            held: true,
        },
    ] {
        f.update = state;
        let (pixels, buttons) = with(&f, Lang::Es, 1280, 800);
        assert!(!buttons.iter().any(|(a, _)| *a == Action::UpdateNow), "{:?}", f.update);
        assert!(has_color(&pixels, CARD) > 100_000);
    }
}

#[test]
fn the_monitor_has_the_diagnostics_button_the_waiting_card_shows_the_code_and_a_stopped_part_is_in_red() {
    let f = fixture();
    let (w, h) = (1280, 800);
    let buttons_of = |view: &View| {
        let pixels = render(view, w, h);
        (
            pixels,
            view.buttons.borrow().iter().map(|(action, r)| (*action, *r)).collect::<Vec<_>>(),
        )
    };
    // Always there on the Monitor tab, inside the window, under the cards.
    let plain = view(&f, None, Tab::Monitor, 1.0, Lang::En);
    let (before, buttons) = buttons_of(&plain);
    let copy = buttons
        .iter()
        .find(|(a, _)| *a == Action::CopyDiagnostics)
        .expect("the button is drawn")
        .1;
    assert!(
        copy.left >= 0 && copy.right < w && copy.bottom <= h && copy.top >= h - 40,
        "({}, {}, {}, {})",
        copy.left,
        copy.top,
        copy.right,
        copy.bottom
    );
    // "Copied" is drawn after a copy, and a part that stopped is said in red.
    let mut copied = view(&f, None, Tab::Monitor, 1.0, Lang::Pt);
    copied.copied = true;
    let mut stopped = view(&f, None, Tab::Monitor, 1.0, Lang::En);
    stopped.failed = "uploader";
    let (copied_pixels, _) = buttons_of(&copied);
    let (stopped_pixels, _) = buttons_of(&stopped);
    assert_ne!(copied_pixels, render(&view(&f, None, Tab::Monitor, 1.0, Lang::Pt), w, h));
    assert!(reddish(&stopped_pixels) > reddish(&before), "a stopped part is in red");
    // The waiting card with a code has a line of its own for it, so its buttons are lower, and still above the footer.
    let mut without = view(&f, None, Tab::Monitor, 1.0, Lang::En);
    without.card = connect::Card::Waiting { code: None };
    let mut with = view(&f, None, Tab::Monitor, 1.0, Lang::En);
    with.card = connect::Card::Waiting { code: Some("K7QX".into()) };
    let (without_pixels, without_buttons) = buttons_of(&without);
    let (with_pixels, with_buttons) = buttons_of(&with);
    assert_ne!(with_pixels, without_pixels, "the code is drawn");
    let open_again = |list: &[(Action, RECT)]| {
        list.iter()
            .find(|(a, _)| *a == Action::OpenConnectPage)
            .map(|(_, r)| (r.top, r.bottom))
    };
    assert!(
        open_again(&with_buttons) > open_again(&without_buttons),
        "the code pushes the buttons down"
    );
    assert!(
        open_again(&with_buttons).is_some_and(|(_, bottom)| bottom < h - 24),
        "and they are above the footer"
    );
}

#[test]
fn says_it_waits_when_there_is_no_reading_or_the_game_is_gone_and_dims_the_dashboard_through_a_silence() {
    let mut f = fixture();
    let mut old = live_reading();
    old.at_ms = -10_000;
    let (w, h) = (960, 600);
    let waiting = render(&view(&f, None, Tab::Dash, 1.0, Lang::En), w, h);
    save(&waiting, w, h, "panel-waiting.png");
    // The game is no longer connected: an old reading is not shown.
    f.snapshot.game = Game::Waiting;
    let gone = render(&view(&f, Some(&old), Tab::Dash, 1.0, Lang::En), w, h);
    assert_eq!(waiting, gone, "no game, no dashboard from an old reading");
    assert!(
        has_color(&waiting, PRIMARY) < 6000,
        "no gear while waiting: only the selected tab is in the accent"
    );
    // The game is still connected and only the frames stopped: the dashboard stays, every value dimmed, with its line.
    f.snapshot.game = Game::Recording(4);
    let silent = render(&view(&f, Some(&old), Tab::Dash, 1.0, Lang::En), w, h);
    save(&silent, w, h, "panel-silent.png");
    assert_ne!(waiting, silent, "the dashboard is not replaced by the waiting screen");
    assert!(
        has_color(&silent, PRIMARY) < 6000,
        "nothing is lit: the gear and the lap are dimmed"
    );
    let m = dashboard(&old, &ctx_of(Lang::En, 0));
    assert_eq!(m.status, Some((StatusKind::NoData, "No data from the game".to_owned())));
    for elem in [&m.gear, &m.speed, &m.lap_time, &m.fuel, &m.brake] {
        assert_eq!(elem.show, Show::Dimmed, "{elem:?}");
    }
    assert!(m.alerts.iter().all(|l| l.show == Show::Dimmed));
    assert!(m.tyres.is_some_and(|t| t.show == Show::Dimmed));
    assert!(dashboard_shown(Some(&old), &Game::Connected, 0));
    assert!(dashboard_shown(Some(&old), &Game::Paused, 0));
    assert!(!dashboard_shown(Some(&old), &Game::Silent, 0));
    assert!(!dashboard_shown(Some(&old), &Game::Waiting, 0));
    assert!(!dashboard_shown(None, &Game::Recording(1), 0));
    assert!(
        dashboard_shown(Some(&live_reading()), &Game::Waiting, 1_500),
        "a fresh reading always shows"
    );
}

#[test]
fn writes_the_design_preview_page() {
    let Some(dir) = std::env::var_os("XPEED_SIM_PANEL_PNG") else {
        return;
    };
    let f = fixture();
    let live = live_reading();
    let mut pits = live.clone();
    pits.in_pits = true;
    pits.lap_valid = Some(false);
    pits.delta_s = Some(0.43);
    pits.throttle = 0.0;
    pits.brake = 0.8;
    pits.state.pit_limiter = Some(true);
    pits.state.engine_warning = Some(true);
    pits.state.handbrake = Some(true);
    pits.state.drs = Some(crate::game::Drs::Open);
    pits.state.flag = Some(crate::game::Flag::Chequered);
    pits.state.water_c = Some(118.0);
    pits.state.oil_c = Some(135.0);
    pits.state.damage_body = Some(0.7);
    pits.state.damage_engine = Some(0.9);
    pits.fuel_l = 4.4;
    let mut unknown = live.clone();
    unknown.state = crate::game::CarState::UNKNOWN;
    unknown.fuel_per_lap_l = None;
    unknown.clutch = f32::NAN;
    let shots = [
        (
            "preview-window.png",
            "Window as it opens on a 1920 × 1080 screen (1536 × 864)",
            Some(&live),
            Tab::Dash,
            Lang::En,
            1536,
            864,
            1.0,
        ),
        (
            "preview-full-hd.png",
            "Full screen, 1920 × 1080",
            Some(&live),
            Tab::Dash,
            Lang::En,
            1920,
            1080,
            1.0,
        ),
        (
            "preview-ultrawide.png",
            "Full screen, ultrawide 2560 × 1080",
            Some(&pits),
            Tab::Dash,
            Lang::Pt,
            2560,
            1080,
            1.0,
        ),
        ("preview-monitor.png", "Monitor tab", None, Tab::Monitor, Lang::En, 1280, 800, 1.0),
        (
            "preview-waiting.png",
            "Waiting for a game",
            None,
            Tab::Dash,
            Lang::En,
            960,
            600,
            1.0,
        ),
        (
            "preview-4x3.png",
            "4:3 window (1024 × 768)",
            Some(&live),
            Tab::Dash,
            Lang::En,
            1024,
            768,
            1.0,
        ),
        (
            "preview-phone.png",
            "Phone held upright (540 × 1080)",
            Some(&live),
            Tab::Dash,
            Lang::En,
            540,
            1080,
            1.0,
        ),
        (
            "preview-small.png",
            "Smallest window (720 × 480)",
            Some(&live),
            Tab::Dash,
            Lang::En,
            720,
            480,
            1.0,
        ),
    ];
    let mut figures = String::new();
    let rich = rich_reading();
    for (file, caption, reading, w, h) in [
        (
            "preview-tyre-bands.png",
            "A game that gives the tread (AC, ACC, EVO, R3E, LMU): each tyre in three bands (1920 × 1080)",
            &rich,
            1920,
            1080,
        ),
        (
            "preview-unknown-state.png",
            "A game that gives no lights, temperatures or damage (1920 × 1080)",
            &unknown,
            1920,
            1080,
        ),
        (
            "preview-unknown-phone.png",
            "The same on a phone held upright (430 × 900)",
            &unknown,
            430,
            900,
        ),
        (
            "preview-hot-phone.png",
            "Everything lit, in the pits, low on fuel (430 × 900)",
            &pits,
            430,
            900,
        ),
        (
            "preview-classic.png",
            "Classic, the smallest window that shows the whole dashboard (1032 × 602)",
            &live,
            1032,
            602,
        ),
    ] {
        let pixels = render(&view(&f, Some(reading), Tab::Dash, 1.0, Lang::En), w, h);
        save(&pixels, w, h, file);
        figures.push_str(&format!(
            "<figure><figcaption>{caption}</figcaption><img data-src=\"{file}\" width=\"{w}\" height=\"{h}\"></figure>
"
        ));
    }
    // No best lap, one lap done, and out of the car (menu, garage).
    let mut fresh = live.clone();
    fresh.best_lap_s = None;
    fresh.delta_s = None;
    let mut menu = fresh.clone();
    menu.driving = false;
    menu.lap_valid = Some(false);
    let few = vec![saved_lap(3, 107_918)];
    for (file, caption, reading) in [
        ("preview-no-best.png", "No best lap yet, one lap done (1920 × 1080)", &fresh),
        ("preview-menu.png", "Out of the car: only the state line shows (1920 × 1080)", &menu),
    ] {
        let mut v = view(&f, Some(reading), Tab::Dash, 1.0, Lang::En);
        v.recent_laps = &few;
        let pixels = render(&v, 1920, 1080);
        save(&pixels, 1920, 1080, file);
        figures.push_str(&format!(
            "<figure><figcaption>{caption}</figcaption><img data-src=\"{file}\" width=\"1920\" height=\"1080\"></figure>\n"
        ));
    }
    // Laps with sectors: purple the fastest, green faster than the best lap, yellow slower, and the gap bars.
    let mut timed = rich_laps();
    for (number, s) in [(4, [27_880, 45_000, 52_000]), (5, [27_850, 44_800, 52_600])] {
        timed.push(SavedLap {
            valid: true,
            sectors_ms: s.to_vec(),
            time_ms: s.iter().sum(),
            ..saved_lap(number, 0)
        });
    }
    let mut sectors_view = view(&f, Some(&rich), Tab::Dash, 1.0, Lang::En);
    sectors_view.recent_laps = &timed;
    let pixels = render(&sectors_view, 1920, 1080);
    save(&pixels, 1920, 1080, "preview-laps-sectors.png");
    figures.push_str("<figure><figcaption>Laps with sectors: purple the fastest, green faster than the best lap, yellow slower (1920 × 1080)</figcaption><img data-src=\"preview-laps-sectors.png\" width=\"1920\" height=\"1080\"></figure>\n");
    let covers = CoverArt::load(None);
    let mut hover = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
    let [_, _, _, full_button, _] = header_hits(960, 1.0);
    hover.mouse = Some((full_button.left + 5, full_button.top + 5));
    let pixels = render(&hover, 960, 600);
    save(&pixels, 960, 600, "preview-tooltip.png");
    figures.push_str("<figure><figcaption>Icon buttons, with the tooltip of the one under the mouse</figcaption><img data-src=\"preview-tooltip.png\" width=\"960\" height=\"600\"></figure>\n");
    let mut with_covers = view(&f, None, Tab::Dash, 1.0, Lang::En);
    with_covers.covers = &covers;
    with_covers.carousel = 9.0;
    let mut unpaired = fixture();
    unpaired.snapshot.cloud = Cloud::NotPaired;
    let mut monitor_covers = view(&unpaired, None, Tab::Monitor, 1.0, Lang::En);
    monitor_covers.covers = &covers;
    let pixels = render(&monitor_covers, 1280, 800);
    save(&pixels, 1280, 800, "preview-monitor-covers.png");
    figures.push_str("<figure><figcaption>Monitor tab, with the covers from the Xpeed server</figcaption><img data-src=\"preview-monitor-covers.png\" width=\"1280\" height=\"800\"></figure>\n");
    let mut waiting_card = view(&f, None, Tab::Monitor, 1.0, Lang::En);
    waiting_card.card = connect::Card::Waiting { code: Some("K7QX".into()) };
    let pixels = render(&waiting_card, 1280, 800);
    save(&pixels, 1280, 800, "preview-monitor-connecting.png");
    figures.push_str("<figure><figcaption>Monitor tab while the browser page waits for the click on Connect</figcaption><img data-src=\"preview-monitor-connecting.png\" width=\"1280\" height=\"800\"></figure>\n");
    let mut waiting_update = fixture();
    waiting_update.update = crate::update::UpdateState::Available {
        version: "0.6.0".into(),
        required: false,
        held: false,
    };
    let pixels = render(&view(&waiting_update, None, Tab::Monitor, 1.0, Lang::En), 1280, 800);
    save(&pixels, 1280, 800, "preview-monitor-update.png");
    figures.push_str("<figure><figcaption>Monitor tab with an update waiting: Update available: 0.6.0 · Update now</figcaption><img data-src=\"preview-monitor-update.png\" width=\"1280\" height=\"800\"></figure>\n");
    waiting_update.update = crate::update::UpdateState::Available {
        version: "0.6.0".into(),
        required: true,
        held: false,
    };
    let pixels = render(&view(&waiting_update, None, Tab::Monitor, 1.0, Lang::Pt), 1280, 800);
    save(&pixels, 1280, 800, "preview-monitor-update-required.png");
    figures.push_str("<figure><figcaption>Monitor tab, an update that is required (Portuguese)</figcaption><img data-src=\"preview-monitor-update-required.png\" width=\"1280\" height=\"800\"></figure>\n");
    waiting_update.update = crate::update::UpdateState::Downloading { version: "0.6.0".into() };
    let pixels = render(&view(&waiting_update, None, Tab::Monitor, 1.0, Lang::En), 1280, 800);
    save(&pixels, 1280, 800, "preview-monitor-update-downloading.png");
    figures.push_str("<figure><figcaption>Monitor tab while the update downloads</figcaption><img data-src=\"preview-monitor-update-downloading.png\" width=\"1280\" height=\"800\"></figure>\n");
    let mut expired_card = view(&unpaired, None, Tab::Monitor, 1.0, Lang::En);
    expired_card.card = connect::Card::NotConnected {
        note: Some(connect::Note::Expired),
    };
    let pixels = render(&expired_card, 1280, 800);
    save(&pixels, 1280, 800, "preview-monitor-expired.png");
    figures.push_str("<figure><figcaption>Monitor tab after the request expired</figcaption><img data-src=\"preview-monitor-expired.png\" width=\"1280\" height=\"800\"></figure>\n");
    let mut open = view(&f, None, Tab::Dash, 1.0, Lang::Pt);
    open.covers = &covers;
    open.lang_open = true;
    let [_, _, lang_button, _, _] = header_hits(960, 1.0);
    open.mouse = Some((lang_button.right - 100, lang_button.bottom + 6 + 6 + 40 * 2 + 20));
    let pixels = render(&open, 960, 600);
    save(&pixels, 960, 600, "preview-languages.png");
    figures.push_str("<figure><figcaption>The language list, open (Portuguese in use, the mouse on Español)</figcaption><img data-src=\"preview-languages.png\" width=\"960\" height=\"600\"></figure>\n");
    // The dashboard on the common screen shapes, and a phone held upright.
    let mut tall_window = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
    tall_window.recent_laps = &f.laps;
    for (file, caption, w, h) in [
        ("preview-shape-21x9.png", "Ultrawide 21:9 (2560 × 1080)", 2560, 1080),
        ("preview-shape-16x9.png", "16:9 (1920 × 1080)", 1920, 1080),
        ("preview-shape-16x10.png", "16:10 (1680 × 1050)", 1680, 1050),
        ("preview-shape-4x3.png", "4:3 (1024 × 768)", 1024, 768),
        ("preview-shape-5x4.png", "5:4 (1280 × 1024)", 1280, 1024),
        ("preview-shape-phone.png", "Phone held upright (430 × 900)", 430, 900),
    ] {
        let pixels = render(&tall_window, w, h);
        save(&pixels, w, h, file);
        figures.push_str(&format!(
            "<figure><figcaption>{caption}</figcaption><img data-src=\"{file}\" width=\"{w}\" height=\"{h}\"></figure>\n"
        ));
    }
    let mut phone_monitor = view(&unpaired, None, Tab::Monitor, 1.0, Lang::En);
    phone_monitor.covers = &covers;
    let pixels = render(&phone_monitor, 430, 900);
    save(&pixels, 430, 900, "preview-phone-monitor.png");
    figures.push_str("<figure><figcaption>Monitor tab on a phone held upright</figcaption><img data-src=\"preview-phone-monitor.png\" width=\"430\" height=\"900\"></figure>\n");
    let mut phone_wait = view(&f, None, Tab::Dash, 1.0, Lang::Pt);
    phone_wait.covers = &covers;
    phone_wait.focus = Some(("ams2", "Automobilista 2", Game::Silent));
    let pixels = render(&phone_wait, 430, 900);
    save(&pixels, 430, 900, "preview-phone-open.png");
    figures.push_str("<figure><figcaption>A game open without data, on a phone held upright</figcaption><img data-src=\"preview-phone-open.png\" width=\"430\" height=\"900\"></figure>\n");
    for (file, caption, game) in [
        (
            "preview-open-no-data.png",
            "A game open without data: what to switch on",
            Game::Silent,
        ),
        (
            "preview-open-connected.png",
            "A game connected, the driver not on track yet",
            Game::Connected,
        ),
    ] {
        let mut open_game = view(&f, None, Tab::Dash, 1.0, Lang::Pt);
        open_game.covers = &covers;
        open_game.focus = Some(("ams2", "Automobilista 2", game));
        let pixels = render(&open_game, 1280, 720);
        save(&pixels, 1280, 720, file);
        figures.push_str(&format!(
            "<figure><figcaption>{caption}</figcaption><img data-src=\"{file}\" width=\"1280\" height=\"720\"></figure>\n"
        ));
    }
    monitor_covers.games_scroll = 30.0;
    let pixels = render(&monitor_covers, 720, 480);
    save(&pixels, 720, 480, "preview-monitor-small.png");
    figures.push_str("<figure><figcaption>Monitor tab in the smallest window (720 × 480): everything stays in its card, the games list scrolls</figcaption><img data-src=\"preview-monitor-small.png\" width=\"720\" height=\"480\"></figure>\n");
    let pixels = render(&with_covers, 1280, 720);
    save(&pixels, 1280, 720, "preview-covers.png");
    figures.push_str("<figure><figcaption>Waiting for a game, with the covers from the Xpeed server</figcaption><img data-src=\"preview-covers.png\" width=\"1280\" height=\"720\"></figure>\n");
    for (file, caption, reading, tab, lang, w, h, scale) in shots {
        let pixels = render(&view(&f, reading, tab, scale, lang), w, h);
        save(&pixels, w, h, file);
        figures.push_str(&format!(
            "<figure><figcaption>{caption}</figcaption><img data-src=\"{file}\" width=\"{w}\" height=\"{h}\"></figure>\n"
        ));
    }
    let stamp = crate::util::now_ms().to_string();
    let page = format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>Xpeed Companion panel</title>
<style>
body {{ margin: 0; background: #050607; color: #c9ccd2; font: 14px "Segoe UI", sans-serif; }}
header {{ position: sticky; top: 0; padding: 12px 24px; background: #0c0d0fee; border-bottom: 1px solid #25282e; display: flex; gap: 16px; align-items: baseline; z-index: 1; }}
header b {{ color: #f5e663; font-size: 16px; }}
main {{ padding: 24px; display: grid; gap: 32px; }}
figure {{ margin: 0; }}
figcaption {{ margin-bottom: 8px; color: #7c828c; text-transform: uppercase; letter-spacing: .08em; font-size: 12px; }}
img {{ display: block; max-width: 100%; height: auto; border: 1px solid #25282e; border-radius: 8px; }}
</style></head><body>
<header><b>Xpeed Companion panel</b><span>drawn by the program's own code · updates by itself</span><span id="when"></span></header>
<main>
{figures}</main>
<script>
let shown = "";
async function look() {{
  try {{
const stamp = (await (await fetch("stamp.txt?" + Date.now())).text()).trim();
if (stamp && shown && stamp !== shown) {{
  // Redrawn: load the page again, since the list of pictures can change too.
  location.reload();
  return;
}}
if (stamp && stamp !== shown) {{
  shown = stamp;
  document.querySelectorAll("img[data-src]").forEach(img => img.src = img.dataset.src + "?" + stamp);
  document.getElementById("when").textContent = "updated " + new Date(Number(stamp)).toLocaleTimeString();
}}
  }} catch (e) {{}}
}}
look(); setInterval(look, 1500);
</script></body></html>"#
    );
    let dir = std::path::Path::new(&dir);
    std::fs::write(dir.join("index.html"), page).unwrap();
    std::fs::write(dir.join("stamp.txt"), stamp).unwrap();
}

#[test]
fn the_header_can_be_clicked_where_it_is_drawn() {
    let [dash, mon, lang, full, top] = header_hits(960, 1.0);
    assert!(inside(&dash, 20, 20) && !inside(&dash, 150, 20));
    assert!(inside(&mon, 160, 20));
    assert!(inside(&lang, 834, 20) && !inside(&lang, 853, 20));
    assert!(inside(&full, 880, 20) && !inside(&full, 899, 20));
    assert!(inside(&top, 920, 20) && !inside(&top, 920, 52));
    assert!(
        lang.right < full.left && full.right < top.left && mon.right < lang.left,
        "nothing overlaps"
    );
    let [dash2, _, _, _, top2] = header_hits(1440, 1.5);
    assert_eq!((dash2.left, dash2.right), (30, 204));
    assert_eq!(top2.right, 1440 - 24);
}

#[test]
fn writes_times_gears_and_deltas_like_a_dashboard() {
    assert_eq!(lap_clock(Some(107.918)).as_deref(), Some("1:47.918"));
    assert_eq!(lap_clock(None), None, "no placeholder");
    assert_eq!(lap_clock(Some(f64::NAN)), None);
    assert_eq!(delta_text(Some(-0.274)).as_deref(), Some("-0.274"));
    assert_eq!(delta_text(Some(0.0)).as_deref(), Some("+0.000"));
    assert_eq!(delta_text(None), None, "no placeholder");
    assert_eq!(
        (gear_text(-1.0), gear_text(0.0), gear_text(5.0), gear_text(f32::NAN)),
        ("R".into(), "N".into(), "5".into(), "–".into())
    );
}

/// How long a frame takes to draw, by screen: `cargo test frame_times -- --ignored --nocapture`. Not run by
/// default (it needs this computer's covers and measures, it does not check).
#[test]
#[ignore]
fn frame_times() {
    let f = fixture();
    let live = live_reading();
    let covers = CoverArt::load(None);
    for (name, reading, tab) in [
        ("carousel", None, Tab::Dash),
        ("dashboard", Some(&live), Tab::Dash),
        ("monitor", None, Tab::Monitor),
    ] {
        let mut v = view(&f, reading, tab, 1.0, Lang::En);
        v.covers = &covers;
        let (w, h) = (1920, 1080);
        render(&v, w, h);
        let start = std::time::Instant::now();
        let frames = 30;
        for i in 0..frames {
            v.carousel = i as f32 * 0.1;
            render(&v, w, h);
        }
        println!(
            "{name}: {:.1} ms a frame at {w}x{h}",
            start.elapsed().as_secs_f64() * 1000.0 / frames as f64
        );
    }
    // The parts of a carousel frame, alone.
    let (w, h) = (1920, 1080);
    let time = |label: &str, draw: &dyn Fn(&mut Painter)| unsafe {
        let hdc = CreateCompatibleDC(null_mut());
        let bitmap = dib(hdc, w, h);
        let old = SelectObject(hdc, bitmap);
        let mut g = Painter::new(hdc, 1.0);
        let start = std::time::Instant::now();
        for _ in 0..30 {
            draw(&mut g);
        }
        println!("  {label}: {:.2} ms", start.elapsed().as_secs_f64() * 1000.0 / 30.0);
        drop(g);
        SelectObject(hdc, old);
        DeleteObject(bitmap);
        DeleteDC(hdc);
    };
    if let Some(image) = covers.iter().find(|c| !c.image.is_null()).map(|c| c.image) {
        time("one cover image 283x425", &|g| g.image_exact((100.0, 100.0, 283.0, 425.0), image));
    }
    time("one veil 283x425", &|g| g.veil_exact((100.0, 100.0, 283.0, 425.0), BACKGROUND, 0.5));
    time("backdrop (kept)", &|g| g.backdrop(w, h));
    time("rev bar", &|g| g.rev_bar(0.0, 0.0, 1360.0, 36.0, 0.9, false));
    time("text 34px", &|g| {
        g.text(
            "Waiting for a game",
            rect(0, 0, 900, 60),
            34.0,
            FW_SEMIBOLD as i32,
            Face::Num,
            FOREGROUND,
            DT_CENTER,
        )
    });
}

#[test]
fn the_dashboard_canvas_fills_the_window_and_keeps_its_shape() {
    let (s, ox, oy) = canvas_fit_wh(rect(16, 58, 944, 584), CANVAS_W, CANVAS_H);
    assert!((s - 0.928).abs() < 0.001 && ox == 16, "{s} {ox}");
    assert_eq!(oy, 58 + ((526.0 - 520.0 * s) / 2.0).round() as i32);
    let (s, ox, _) = canvas_fit_wh(rect(16, 58, 1904, 1064), CANVAS_W, CANVAS_H);
    assert!((s - 1.888).abs() < 0.001, "full HD: {s}");
    assert_eq!(ox, 16);
    let (s, ox, oy) = canvas_fit_wh(rect(0, 0, 3000, 520), CANVAS_W, CANVAS_H);
    assert_eq!((s, oy), (1.0, 0), "a wide window keeps the height");
    assert_eq!(ox, 1000, "and centres the canvas");
}

#[test]
fn turns_gdi_colours_into_gdiplus_colours() {
    assert_eq!(argb(rgb(0x12, 0x34, 0x56)), 0xff12_3456);
    assert_eq!(argb(PRIMARY), 0xfff5_e663);
}

#[test]
fn the_shift_lights_fill_up_and_flash_at_the_top() {
    assert_eq!(lights_lit(0.3), (0, false));
    assert_eq!(lights_lit(LIGHTS_FROM), (0, false));
    assert_eq!(lights_lit(0.761), (10, false));
    assert_eq!(lights_lit(0.969), (19, false));
    assert_eq!(lights_lit(0.98), (LIGHTS, true));
    assert_eq!(lights_lit(f32::NAN), (0, false));
    assert_eq!(mix(rgb(0, 0, 0), rgb(200, 100, 50), 0.5), rgb(100, 50, 25));
}

#[test]
fn the_fastest_lap_is_never_an_invalid_one() {
    let invalid = SavedLap {
        valid: false,
        ..saved_lap(2, 100_000)
    };
    let laps = [saved_lap(1, 109_002), invalid.clone(), saved_lap(3, 107_918)];
    assert_eq!(fastest_valid(&laps), Some(107_918));
    assert_eq!(fastest_valid(&[invalid]), None);
    assert_eq!(fastest_valid(&[]), None);
}

#[test]
fn a_time_that_does_not_fit_gets_a_smaller_size_but_never_below_the_floor() {
    assert_eq!(fit_size(80.0, 30.0, 100.0, 14.0), 30.0, "fits: unchanged");
    assert_eq!(fit_size(200.0, 30.0, 100.0, 14.0), 15.0, "twice too wide: half the size");
    assert_eq!(fit_size(1000.0, 30.0, 100.0, 14.0), 14.0, "far too wide: the floor");
    assert_eq!(fit_size(1000.0, 10.0, 100.0, 14.0), 10.0, "a size under the floor is left alone");
    assert_eq!(fit_size(0.0, 30.0, 100.0, 14.0), 30.0);
}

#[test]
fn the_carousel_slides_with_an_ease_goes_round_and_moves_on_by_itself() {
    let mut c = Carousel::new(1_000);
    assert_eq!(c.at(1_000), 0.0);
    c.step(1, 1_000);
    let half = c.at(1_000 + SLIDE_MS / 2);
    assert!((half - 0.5).abs() < 1e-3, "eased in and out: half way at half time ({half})");
    let quarter = c.at(1_000 + SLIDE_MS / 4);
    assert!(quarter < 0.1, "gently away ({quarter})");
    assert_eq!(c.at(1_000 + SLIDE_MS), 1.0);
    c.tick(1_000 + SLIDE_MS + DWELL_MS - 1);
    assert_eq!(c.target, 1, "not yet");
    c.tick(1_000 + SLIDE_MS + DWELL_MS);
    assert_eq!(c.target, 2, "on by itself");
    // Going round: cover 0 is just right of the middle when the carousel is at the last cover.
    assert_eq!(carousel_offset(0, 10, 9.0), 1.0);
    assert_eq!(carousel_offset(9, 10, 0.0), -1.0);
    assert_eq!(carousel_offset(3, 10, 2.5), 0.5);
}

#[test]
fn shows_the_gears_either_side() {
    assert_eq!(neighbour_gears(4.0, None), (Some("3".into()), Some("5".into())));
    assert_eq!(neighbour_gears(1.0, None), (Some("N".into()), Some("2".into())));
    assert_eq!(neighbour_gears(0.0, None), (Some("R".into()), Some("1".into())));
    assert_eq!(neighbour_gears(-1.0, None), (None, Some("N".into())));
    assert_eq!(neighbour_gears(f32::NAN, None), (None, None));
    assert_eq!(
        neighbour_gears(6.0, None),
        (Some("5".into()), Some("7".into())),
        "unknown count: as before"
    );
}

#[test]
fn the_top_gear_has_nothing_above_it_when_the_count_is_known() {
    assert_eq!(
        neighbour_gears(6.0, Some(6)),
        (Some("5".into()), None),
        "top gear of a 6-speed: no 7"
    );
    assert_eq!(neighbour_gears(5.0, Some(6)), (Some("4".into()), Some("6".into())));
    assert_eq!(
        neighbour_gears(7.0, Some(6)),
        (Some("6".into()), None),
        "past the count is still the top"
    );
    assert_eq!(neighbour_gears(1.0, Some(1)), (Some("N".into()), None), "a one-speed car");
    // Neutral and reverse keep their neighbours whatever the count.
    assert_eq!(neighbour_gears(0.0, Some(6)), (Some("R".into()), Some("1".into())));
    assert_eq!(neighbour_gears(-1.0, Some(6)), (None, Some("N".into())));
    assert_eq!(neighbour_gears(f32::NAN, Some(6)), (None, None));
}

#[test]
fn the_demo_drives_a_believable_car() {
    for i in 0..240 {
        let frame = demo_frame(2, i as f64 * 10.0, i as f64 * 0.2, Some(55.0), 40.0, 1.0);
        assert!((20.0..=75.0).contains(&frame.speed_ms), "{}", frame.speed_ms);
        assert!((1.0..=6.0).contains(&frame.gear));
        assert!((0.0..=1.0).contains(&frame.throttle) && (0.0..=1.0).contains(&frame.brake));
        assert!(frame.throttle == 0.0 || frame.brake == 0.0, "never both pedals at once");
        assert!((-1.0..=1.0).contains(&frame.steer));
    }
}

#[test]
fn shows_log_times_on_the_local_clock() {
    let text = local_time(1_794_000_000_000);
    assert_eq!(text.len(), 8);
    assert_eq!(text.as_bytes()[2], b':');
}

/// A frame of a car on the track, as the readers build them.
fn frame_of(lap: i32, dist: f64, t: f64) -> Frame {
    let mut f = Frame::empty();
    f.set_phase(crate::game::Phase::Driving);
    f.lap = lap;
    f.dist_m = Some(dist);
    f.lap_time_s = Some(t);
    f.track = "Spa".into();
    f.car = "GT3".into();
    f.track_length_m = Some(7000.0);
    f.rpm = 7000.0;
    f.speed_ms = 60.0;
    f.gear = 4.0;
    f.throttle = 0.8;
    f.brake = 0.0;
    f.steer = 0.1;
    f.fuel_l = 40.0;
    f.tyres = Some([84.0, 85.0, 90.0, 91.0].map(|t| crate::game::Tyre {
        brake_c: f32::NAN,
        temp_c: t,
        pressure_kpa: 180.0,
        left: 0.9,
        tread_c: None,
    }));
    f
}

fn evo_like_caps() -> crate::game::Caps {
    use crate::game::Caps;
    [
        Caps::LAP_TIME,
        Caps::LAST_LAP,
        Caps::DIST,
        Caps::SPEED,
        Caps::RPM,
        Caps::GEAR,
        Caps::THROTTLE,
        Caps::BRAKE,
        Caps::STEER,
        Caps::FUEL,
        Caps::TRACK_LENGTH,
        Caps::TYRE_TEMP,
        Caps::TYRE_PRESSURE,
        Caps::TYRE_WEAR,
        Caps::PIT_LIMITER,
        Caps::DRS,
    ]
    .into_iter()
    .fold(Caps::NONE, Caps::or)
}

#[test]
fn the_tokens_are_the_one_place_for_colours_sizes_radii_and_spacing() {
    // The type scale: at most nine sizes, rising, labels never below 12.
    assert!(SCALE.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(type_step(13.0), T_CAPTION);
    assert_eq!(type_step(23.9), T_VALUE);
    assert_eq!(type_step(500.0), T_DISPLAY);
    assert_eq!(type_step(60.0), T_HERO);
    assert_eq!(type_step(1.0), T_CAPTION);
    // Spacing is on a 4 px grid (the corner has its own test: one_near_square_corner).
    for s in [S1, S2, S3, S4, S6, S8] {
        assert_eq!(s % 4.0, 0.0);
    }
    // The site's colours.
    assert_eq!(BACKGROUND, rgb(0x10, 0x11, 0x13));
    assert_eq!(CARD, rgb(0x18, 0x19, 0x1b));
    assert_eq!(MUTED_TEXT, rgb(0x93, 0x97, 0x9f));
    assert_eq!(PRIMARY, rgb(0xf5, 0xe6, 0x63));
    assert_eq!(ON_PRIMARY, rgb(0x12, 0x13, 0x16));
    assert_eq!(BEST, rgb(0xa4, 0x74, 0xe7));
    assert_eq!(GREY, rgb(0x7f, 0x84, 0x8c));
    // A dimmed colour is between the card and the colour, never the colour itself.
    assert_ne!(dim(PRIMARY), PRIMARY);
    assert_eq!(dim(CARD), CARD);
    // Nothing outside the tokens writes a colour: no `rgb(` and no `mix(` of its own (the damage gradient is the one mix).
    for (file, source) in [
        ("dash_view.rs", include_str!("dash_view.rs")),
        ("monitor_view.rs", include_str!("monitor_view.rs")),
        ("waiting_view.rs", include_str!("waiting_view.rs")),
        ("chrome.rs", include_str!("chrome.rs")),
        ("layout.rs", include_str!("layout.rs")),
        ("model.rs", include_str!("model.rs")),
        ("window.rs", include_str!("window.rs")),
        ("art.rs", include_str!("art.rs")),
    ] {
        assert!(!source.contains("rgb("), "{file} writes a colour of its own");
        assert!(!source.contains("mix("), "{file} mixes a colour of its own");
    }
}

/// The owner's "square pill": one near-square corner for every shape (decision 2026-11-12, fec259a). A token pass once
/// replaced it with the site's 4/6/8/10 radii (539eb8a, 2026-11-16) and nothing failed; this test is why that cannot
/// happen again. Changing the corner is an owner decision: record it in the journal first, then change this test.
#[test]
fn one_near_square_corner() {
    assert_eq!(R_CORNER, 2.5);
    // Drawn, not only declared: two pixels in along the chosen tab's top edge is already pure yellow; any rounder
    // corner (the site's 6 px) leaves it at least partly dark.
    let f = fixture();
    let (w, h) = (960, 600);
    let pixels = render(&view(&f, None, Tab::Dash, 1.0, Lang::En), w, h);
    let [dash, ..] = header_hits(w, 1.0);
    let i = (((dash.top + 1) * w + dash.left + 2) * 4) as usize;
    let got = [pixels[i + 2], pixels[i + 1], pixels[i]];
    let yellow = [(PRIMARY & 0xff) as u8, (PRIMARY >> 8 & 0xff) as u8, (PRIMARY >> 16 & 0xff) as u8];
    assert!(
        got.iter().zip(yellow).all(|(g, y)| g.abs_diff(y) <= 12),
        "the chosen tab's corner is rounder than R_CORNER: {got:?} instead of {yellow:?}"
    );
    // No view brings a second corner back: no radius of the site's scale, no rounded shape outside the painter.
    for (file, source) in [
        ("dash_view.rs", include_str!("dash_view.rs")),
        ("monitor_view.rs", include_str!("monitor_view.rs")),
        ("waiting_view.rs", include_str!("waiting_view.rs")),
        ("chrome.rs", include_str!("chrome.rs")),
        ("coach_look.rs", include_str!("coach_look.rs")),
        ("perspective_paint.rs", include_str!("perspective_paint.rs")),
        ("layout.rs", include_str!("layout.rs")),
        ("art.rs", include_str!("art.rs")),
        ("tokens.rs", include_str!("tokens.rs")),
    ] {
        for other in [
            "R_XS",
            "R_SM",
            "R_MD",
            "R_LG",
            "R_CARD",
            "R_TILE",
            "rounded_path(",
            "RoundRect(",
            "GdipAddPathArc",
        ] {
            assert!(!source.contains(other), "{file} draws a corner of its own ({other})");
        }
    }
}

/// The owner's bars: square blocks a hair apart (2026-11-12, ac5c6b5). The stage-2 rebuild (37cc6fc, 2026-11-16) turned
/// them into one rounded fill and nothing failed; this test is why that cannot happen again.
#[test]
fn bars_are_square_blocks() {
    assert_eq!((BAR_BLOCKS, BAR_BLOCK_GAP, BAR_BLOCK_MIN_W), (20, 1.5, 6.0));
    assert_eq!(bar_block_count(300.0), 20);
    assert_eq!(bar_block_count(60.0), 10, "a short bar has fewer blocks, never slivers");
    let spans = block_spans(0, 300, 20, 2);
    assert_eq!((spans.len(), spans[0].0, spans[19].1), (20, 0, 300));
    assert!(spans.windows(2).all(|p| p[1].0 - p[0].1 == 2), "every gap is the same: {spans:?}");
    // Drawn: a bar half full is lit square from its very first pixel, dark at its end, with black hairs between blocks.
    let (w, h) = (300, 9);
    let at = painted_by(w, h, |g| g.solid_bar((0.0, 0.0, w as f32, h as f32), 0.5, PRIMARY));
    assert_eq!(at(0, 0), PRIMARY, "the first block is square: its corner pixel is lit");
    assert_eq!(at(w - 1, h - 1), SECONDARY, "the last block is dark and square");
    let hairs = (0..w).filter(|x| at(*x, h / 2) == 0).count();
    assert_eq!(hairs, 19 * 2, "19 hairs of 2 px between 20 blocks");
}

/// What `draw` paints on a black bitmap of `w` × `h` at scale 1, read back a pixel at a time as a `COLORREF`.
fn painted_by(w: i32, h: i32, draw: impl FnOnce(&mut Painter)) -> impl Fn(i32, i32) -> COLORREF {
    let pixels = unsafe {
        let hdc = CreateCompatibleDC(null_mut());
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut bits: *mut std::ffi::c_void = null_mut();
        let bitmap = CreateDIBSection(hdc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
        let old = SelectObject(hdc, bitmap);
        draw(&mut Painter::new(hdc, 1.0));
        GdiFlush();
        let pixels = std::slice::from_raw_parts(bits.cast::<u8>(), (w * h * 4) as usize).to_vec();
        SelectObject(hdc, old);
        DeleteObject(bitmap);
        DeleteDC(hdc);
        pixels
    };
    move |x, y| {
        let i = ((y * w + x) * 4) as usize;
        u32::from(pixels[i]) << 16 | u32::from(pixels[i + 1]) << 8 | u32::from(pixels[i + 2])
    }
}

/// The owner's tyres (approved mockup, 2026-11-19): only the tyre, seen from above; three bands across the tread for a
/// game that gives them, one block otherwise; the colour follows the temperature, steel cold to red over.
#[test]
fn a_tyre_is_drawn_in_the_colours_of_its_temperatures() {
    assert_eq!(heat_colour(50.0), STEEL);
    assert_eq!(heat_colour(80.0), SUCCESS);
    assert_eq!(heat_colour(100.0), WARN);
    assert_eq!(heat_colour(120.0), DESTRUCTIVE);
    assert_eq!(heat_colour(f32::NAN), SECONDARY, "no temperature: a quiet tyre");
    let between = heat_colour(68.5);
    assert!(between != STEEL && between != SUCCESS, "it blends between the steps");
    // Three bands: each band's middle is its own colour, the sidewall around them is dark.
    let bands = TyreShape::Bands([STEEL, SUCCESS, DESTRUCTIVE]);
    let at = painted_by(40, 80, |g| g.tyre_shape((0.0, 0.0, 40.0, 80.0), bands));
    let tread = (4, 36); // inside the 3.6 px sidewall, so 4 to 36 across
    let third = (tread.1 - tread.0) / 3;
    assert_eq!(at(tread.0 + third / 2, 5), STEEL);
    assert_eq!(at(tread.0 + third + third / 2, 5), SUCCESS);
    assert_eq!(at(tread.1 - third / 2, 5), DESTRUCTIVE);
    assert_eq!(at(1, 40), TYRE_SIDEWALL, "the sidewall frames the tread");
    // Solid: one colour across the whole tread.
    let at = painted_by(40, 80, |g| g.tyre_shape((0.0, 0.0, 40.0, 80.0), TyreShape::Solid(WARN)));
    assert!((5..35).all(|x| at(x, 5) == WARN), "a solid tyre has no bands");
}

/// The owner's centre card (module 7, 2026-11-19): shift lights over the gear and the throttle and brake of the last
/// seconds under the wheel.
#[test]
fn the_centre_card_has_shift_lights_and_the_last_seconds_of_inputs() {
    assert_eq!(shift_lit(0.5), (0, false));
    assert_eq!(shift_lit(SHIFT_LIGHTS_FROM), (0, false));
    assert_eq!(shift_lit(0.885), (8, false));
    assert_eq!(shift_lit(0.97), (SHIFT_LIGHTS, true), "the shift point: all, flashing");
    assert_eq!(shift_lit(f32::NAN), (0, false));
    let plan = centre_plan((0.0, 0.0, 552.0, 432.0), &slots(every_cap()));
    let shift = plan.shift.expect("shift lights over the gear");
    assert!(shift.1 + shift.3 <= plan.gear.1, "over the gear");
    let (_, graph) = plan.inputs.expect("room for the inputs under the wheel");
    assert!(graph.1 > plan.steer.1 && plan.gear.3 >= GEAR_MIN_WITH_TRACE);
    let short = centre_plan((0.0, 0.0, 552.0, 260.0), &slots(every_cap()));
    assert!(short.inputs.is_none(), "a short card keeps its gear and drops the trace");
    // Drawn: eight lights on at 0.885, green first and red last unlit.
    let at = painted_by(300, 10, |g| g.shift_lights((0.0, 0.0, 300.0, 10.0), 8, false, true));
    assert_eq!((at(2, 5), at(150, 5), at(297, 5)), (SUCCESS, WARN, SECONDARY));
    // The trace: the throttle along the top, flat out at the right edge.
    let live = live_reading();
    let at = painted_by(200, 40, |g| g.input_trace((0.0, 0.0, 200.0, 40.0), &live.inputs, live.at_ms));
    let greenish = |c: COLORREF| (c >> 8 & 0xff) > 0x80 && (c & 0xff) < 0x80;
    assert!((1..5).any(|y| greenish(at(190, y))), "flat out at the end, along the top");
}

/// The owner's fuel card (module 6, 2026-11-19): the use as three numbers, how long the fuel lasts, and a stint plan.
#[test]
fn the_fuel_card_shows_the_use_the_minutes_and_a_stint_plan() {
    let live = live_reading();
    let m = model(&live, Lang::En);
    let stats: Vec<(&str, &str, &str)> = m
        .fuel_stats
        .iter()
        .map(|s| (s.label.as_str(), s.value.as_str(), s.note.as_str()))
        .collect();
    assert_eq!(
        stats,
        [
            ("Avg / lap", "2.90", ""),
            ("Last lap", "2.84", "-0.06"),
            ("This lap", "1.12", "40%"),
        ]
    );
    assert_eq!(m.fuel_stats[1].note_role, Role::Good, "under the average: green");
    assert_eq!(m.fuel_minutes.as_deref(), Some("~24 min"), "13.3 laps at 1:47.918");
    let plan = m.fuel_planner.expect("a stint plan");
    assert_eq!(plan.at, "at 2.9 L/lap");
    let rows: Vec<(&str, &str, Role)> = plan.rows.iter().map(|(a, b, r)| (a.as_str(), b.as_str(), *r)).collect();
    assert_eq!(
        rows,
        [
            ("10 laps", "29.0 L · you have it", Role::Good),
            ("20 laps", "58.0 L · add 19.4 L", Role::Warn),
            ("Full tank", "13.3 laps", Role::Text),
        ],
        "20 laps need more than the tank holds: amber"
    );
    // A last lap over the average is red with a plus; without a use per lap there is no plan.
    let mut thirsty = live.clone();
    thirsty.fuel_last_lap_l = Some(2.97);
    let m = model(&thirsty, Lang::En);
    assert_eq!((m.fuel_stats[1].note.as_str(), m.fuel_stats[1].note_role), ("+0.07", Role::Danger));
    thirsty.fuel_per_lap_l = None;
    assert!(model(&thirsty, Lang::En).fuel_planner.is_none());
}

/// The owner's times card (module 5, 2026-11-19): the lap this lap is heading for, and the delta along the lap drawn
/// green under zero where ahead, red over it where behind, with a yellow mark where the car is.
#[test]
fn the_times_card_shows_the_projected_lap_and_the_delta_along_it() {
    let live = live_reading();
    let m = model(&live, Lang::En);
    assert_eq!(m.projected.as_deref(), Some("Projected 1:46.934"), "best less 0.270");
    assert_eq!(model(&live, Lang::Pt).projected.as_deref(), Some("Projetada 1:46.934"));
    let mut first = live.clone();
    first.delta_s = None;
    assert_eq!(model(&first, Lang::En).projected, None, "no delta, no projection");
    // A tall card has room for it, under the delta and over the last and best laps.
    let plan = times_plan((0.0, 0.0, 424.0, 432.0), &slots(live.caps));
    let trace = plan.trace.expect("room for the delta along the lap");
    assert!(trace.1 > plan.bar.1 && trace.1 + trace.3 < plan.records.1);
    // Drawn: ahead (under zero) in green, the car's place in yellow.
    let (w, h) = (300, 60);
    let at = painted_by(w, h, |g| {
        g.delta_trace((0.0, 0.0, w as f32, h as f32), &[(0.0, 0.0), (0.2, -0.3), (0.4, -0.3)]);
    });
    let zero = h / 2;
    let green = tint(CARD, SUCCESS, DELTA_TRACE_FILL);
    assert_eq!(at(90, zero + 4), green, "ahead: green under the line");
    assert_eq!(at(90, zero - 4), 0, "nothing over the line where the lap is ahead");
    // A thin smoothed line shares its colour between two pixel columns: look for its yellow hue there.
    let yellowish = |c: COLORREF| {
        let (r, g, b) = (c & 0xff, c >> 8 & 0xff, c >> 16 & 0xff);
        r > 0x50 && g > 0x40 && b * 2 < r
    };
    assert!((118..=121).any(|x| yellowish(at(x, 2))), "the car's place on the lap");
    assert_eq!(at(200, zero), SECONDARY, "the rest of the lap is only the zero line");
}

/// The owner's tyre tile (2026-11-19): the drawn tyre runs from the top of the F of "FL" to the bottom of the wear bar,
/// and the tyre with its words sits in the middle of the tile, not at its top.
#[test]
fn a_tyre_tile_groups_the_tyre_with_its_words_in_the_middle() {
    let tiles = model(&rich_reading(), Lang::En).tyres.unwrap().tiles;
    let (w, h) = (220, 200);
    let at = painted_by(w, h, |g| {
        tyre_tile_view(g, &tiles[0], "Brake", (0.0, 0.0, w as f32, h as f32), true);
    });
    let rows = |x0: i32, x1: i32, hit: &dyn Fn(COLORREF) -> bool| -> Vec<i32> {
        (4..h - 2).filter(|y| (x0..x1).any(|x| hit(at(x, *y)))).collect()
    };
    let tyre = rows(18, 22, &|c| c != BACKGROUND);
    let (tyre_top, tyre_bottom) = (tyre[0], *tyre.last().unwrap());
    // The words start past the tyre: the first column on the right of it that is not background is the F.
    let tyre_right = (18..w).find(|x| at(*x, tyre_top + 5) == BACKGROUND).unwrap();
    let head = tyre_top - 2..tyre_top + 12;
    let words_x = (tyre_right..w).find(|x| head.clone().any(|y| at(*x, y) != BACKGROUND)).unwrap();
    let corner_top = rows(words_x, words_x + 18, &|c| c != BACKGROUND)[0];
    let bar = rows(words_x, words_x + 4, &|c| c == FOREGROUND_2 || c == SECONDARY);
    let bar_bottom = *bar.last().unwrap();
    assert!(tyre_top.abs_diff(corner_top) <= 1, "tyre top {tyre_top}, top of FL {corner_top}");
    assert!(
        tyre_bottom.abs_diff(bar_bottom) <= 1,
        "tyre bottom {tyre_bottom}, wear bar bottom {bar_bottom}"
    );
    let (above, below) = (tyre_top - STROKE_ACCENT as i32, h - 1 - tyre_bottom);
    assert!(
        above.abs_diff(below) <= 2,
        "centred in the tile: {above} px above, {below} px below"
    );
}

// ---- Stage 2: the cards of the rebuilt dashboard ----

fn inside_box(a: Area, x: f32, y: f32, w: f32, h: f32) -> bool {
    let eps = 0.01;
    a.0 >= x - eps && a.1 >= y - eps && a.0 + a.2 <= x + w + eps && a.1 + a.3 <= y + h + eps
}

fn overlap(a: Area, b: Area) -> bool {
    a.2 > 0.0 && b.2 > 0.0 && a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
}

/// A reading with everything a rich game gives: tread temperatures, sectors, a session, a compound.
fn rich_reading() -> Live {
    let mut live = live_reading();
    live.tyres = Some(
        [(84.0, 26.9, 0.91), (88.0, 27.2, 0.9), (97.0, 26.4, 0.86), (106.0, 26.6, 0.84)].map(|(t, psi, left)| crate::game::Tyre {
            brake_c: t * 3.4,
            temp_c: t,
            pressure_kpa: psi * 6.894_757,
            left,
            tread_c: Some([t - 6.0, t, t + 6.0]),
        }),
    );
    live.sectors_ms = [Some(27_811), Some(44_597)];
    live.session_kind = Some(crate::game::SessionKind::Practice);
    live.tyre_compound = Some("Medium".into());
    live.best_lap_s = Some(123.912);
    live.last_lap_s = Some(124.331);
    live
}

fn rich_laps() -> Vec<SavedLap> {
    let lap = |number: u32, valid: bool, s: [u32; 3]| SavedLap {
        valid,
        sectors_ms: s.to_vec(),
        time_ms: s.iter().sum(),
        ..saved_lap(number, 0)
    };
    vec![
        lap(1, false, [29_410, 47_002, 53_368]),
        lap(2, true, [28_102, 44_880, 51_349]),
        lap(3, true, [27_903, 44_721, 51_288]),
    ]
}

fn model_with(live: &Live, units: crate::config::Units, laps: &[SavedLap]) -> DashModel {
    dashboard(
        live,
        &ModelCtx {
            lang: Lang::En,
            now_ms: live.at_ms,
            units,
            laps,
        },
    )
}

#[test]
fn values_are_written_in_the_units_the_person_picked() {
    use crate::config::{FuelUnit, PressureUnit, SpeedUnit, TempUnit, Units};
    assert_eq!(speed_text(50.0, SpeedUnit::Kmh), "180");
    assert_eq!(speed_text(50.0, SpeedUnit::Mph), "112");
    assert_eq!(temp_text(90.0, TempUnit::C), "90 °C");
    assert_eq!(temp_text(90.0, TempUnit::F), "194 °F");
    assert_eq!(temp_short(84.0, TempUnit::C), "84°");
    assert_eq!(pressure_text(185.0, PressureUnit::Psi), ("26.8".to_owned(), "psi"));
    assert_eq!(pressure_text(185.0, PressureUnit::Bar), ("1.85".to_owned(), "bar"));
    assert_eq!(pressure_text(185.0, PressureUnit::Kpa), ("185".to_owned(), "kPa"));
    assert_eq!(fuel_text(60.0, FuelUnit::Litre), "60.0");
    assert_eq!(fuel_text(60.0, FuelUnit::Gallon), "15.9");
    assert_eq!(tank_text(60.0, FuelUnit::Litre), "60 L");
    assert_eq!(tank_text(60.0, FuelUnit::Gallon), "15.9 gal");
    // The model carries them everywhere a value is written.
    let live = rich_reading();
    let imperial = Units {
        speed: SpeedUnit::Mph,
        temperature: TempUnit::F,
        pressure: PressureUnit::Bar,
        fuel: FuelUnit::Gallon,
    };
    let m = model_with(&live, imperial, &[]);
    assert_eq!((m.speed.text.as_str(), m.speed.unit), ("160", "mph"));
    assert_eq!(m.fuel.unit, "gal");
    assert_eq!(m.fuel.text, fuel_text(38.6, FuelUnit::Gallon));
    assert_eq!(m.engine[0].value, "198 °F");
    let tyres = m.tyres.unwrap();
    assert_eq!(tyres.tiles[0].temp, "183°");
    assert_eq!(tyres.tiles[0].pressure, Some(("1.85".to_owned(), "bar")));
    // The default is today's look.
    let m = model(&live, Lang::En);
    assert_eq!((m.speed.text.as_str(), m.speed.unit, m.fuel.unit), ("257", "km/h", "L"));
    assert_eq!(m.engine[0].value, "92 °C");
}

#[test]
fn the_fuel_card_has_laps_as_its_hero_and_warns_only_while_driving() {
    let mut live = live_reading();
    live.fuel_per_lap_l = Some(2.9);
    live.fuel_l = 38.6;
    live.fuel_tank_l = Some(60.0);
    let m = model(&live, Lang::En);
    assert_eq!((m.fuel_laps.text.as_str(), m.fuel_laps.label.as_str()), ("13.3", "laps"));
    assert_eq!(m.fuel_laps.role, Role::Good);
    assert_eq!(m.fuel_title, "Fuel");
    assert_eq!(m.fuel_tank.text, "of 60 L");
    assert_eq!(m.fuel_per_lap.text, "2.9 L per lap \u{b7} each tick = 1 lap");
    let tick = m.fuel_tick.expect("a tick for each lap's fuel");
    assert!((tick - 2.9 / 60.0).abs() < 1e-5);
    assert_eq!(model(&live, Lang::Pt).fuel_laps.label, "voltas");
    assert!(model(&live, Lang::Es).fuel_per_lap.text.contains("cada marca"));
    // Amber under five laps, red under two; never from a reading taken out of the car.
    live.fuel_l = 12.0;
    assert_eq!(model(&live, Lang::En).fuel_laps.role, Role::Warn);
    live.fuel_l = 4.0;
    assert_eq!(model(&live, Lang::En).fuel_laps.role, Role::Danger);
    live.driving = false;
    live.fuel_l = 5.0;
    assert_eq!(model(&live, Lang::En).fuel_laps.role, Role::Good, "paused or in a menu: no warning");
    live.driving = true;
    // Without the tank there is no bar and no ticks, and the line does not talk about them.
    live.fuel_tank_l = None;
    let m = model(&live, Lang::En);
    assert!(m.fuel_share.is_none() && m.fuel_tick.is_none() && !m.fuel_tank.visible());
    assert_eq!(m.fuel_per_lap.text, "2.9 L per lap");
    // Without the use per lap there are no laps, no ticks and no line, and the litres stay.
    live.fuel_per_lap_l = None;
    let m = model(&live, Lang::En);
    assert!(!m.fuel_laps.visible() && !m.fuel_per_lap.visible() && m.fuel.visible());
    assert_eq!(fuel_role(None, true), Role::Good);
    assert_eq!(fuel_share(30.0, Some(60.0)), Some(0.5));
    assert_eq!(fuel_share(65.0, Some(60.0)), Some(1.0), "a tank known too small reads full");
    assert_eq!(fuel_share(30.0, None), None);
    assert_eq!(fuel_laps_left(30.0, Some(2.0)), Some(15.0));
    assert_eq!(fuel_laps_left(30.0, None), None);
}

#[test]
fn a_game_without_fuel_has_no_fuel_hero_and_one_with_only_temperatures_calls_the_card_engine() {
    use crate::game::Caps;
    let mut live = live_reading();
    live.caps = Caps::WATER_TEMP.or(Caps::OIL_TEMP).or(Caps::LAP_TIME);
    let m = model(&live, Lang::En);
    assert!(!m.fuel.visible() && !m.fuel_laps.visible() && !m.fuel_per_lap.visible());
    assert_eq!(m.fuel_title, "Engine");
    assert_eq!(m.engine.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), ["Water", "Oil"]);
    assert!(
        slots(live.caps).cards.contains(&Pane::Fuel),
        "the card is there for the temperatures"
    );
    live.caps = Caps::LAP_TIME.or(Caps::GEAR);
    assert!(!slots(live.caps).cards.contains(&Pane::Fuel), "nothing to put in it: no card");
    assert!(model(&live, Lang::En).engine.is_empty());
}

#[test]
fn the_tyre_tiles_say_cold_ok_hot_or_over_and_have_a_bar_only_where_the_game_gives_the_tread() {
    assert_eq!(TyreState::of(50.0), Some(TyreState::Cold));
    assert_eq!(TyreState::of(80.0), Some(TyreState::Ok));
    assert_eq!(TyreState::of(97.0), Some(TyreState::Hot));
    assert_eq!(TyreState::of(106.0), Some(TyreState::Over));
    assert_eq!(TyreState::of(f32::NAN), None);
    let m = model(&rich_reading(), Lang::En);
    let tyres = m.tyres.unwrap();
    assert_eq!(tyres.compound.as_deref(), Some("Medium"));
    let words: Vec<&str> = tyres.tiles.iter().map(|t| t.word.as_str()).collect();
    assert_eq!(words, ["ok", "ok", "hot", "over"]);
    assert_eq!(tyres.tiles[0].corner, "FL");
    assert_eq!(tyres.tiles[3].role, Role::Danger);
    // The tyre drawn in three bands, outer to inner on a left tyre (inner faces the car), inner to outer on a right one.
    let h = heat_colour;
    let front_left = TyreShape::Bands([h(90.0), h(84.0), h(78.0)]);
    let front_right = TyreShape::Bands([h(82.0), h(88.0), h(94.0)]);
    assert_eq!(tyres.tiles[0].shape, front_left, "FL: inner 78 on its right");
    assert_eq!(tyres.tiles[1].shape, front_right, "FR: inner 82 on its left");
    let texts = tyres.tiles[2].tread_text.clone().unwrap().map(|(s, _)| s);
    assert_eq!(texts, ["103", "97", "91"], "RL as drawn");
    assert_eq!(tyres.tiles[0].heat, h(84.0));
    assert_eq!(tyres.tiles[0].brake.as_deref(), Some("286°"));
    assert_eq!(tyres.tiles[0].wear, Some(0.91));
    let pt = model(&rich_reading(), Lang::Pt).tyres.unwrap();
    assert_eq!(
        (pt.tiles[0].corner.as_str(), pt.tiles[2].word.as_str(), pt.tiles[3].word.as_str()),
        ("DE", "quente", "passou")
    );
    // A game with one value per tyre: no bar; no wear: no wear bar; no brakes: no brake text.
    let mut live = live_reading();
    for t in live.tyres.as_mut().unwrap() {
        t.left = f32::NAN;
        t.brake_c = f32::NAN;
    }
    let tiles = model(&live, Lang::En).tyres.unwrap().tiles;
    let bare = |t: &TyreTile| t.tread_text.is_none() && t.wear.is_none() && t.brake.is_none();
    assert!(tiles.iter().all(bare));
    assert!(
        tiles.iter().all(|t| t.shape == TyreShape::Solid(t.heat)),
        "one temperature per tyre: a solid tyre in its colour"
    );
    assert!(tiles.iter().all(|t| t.pressure.is_some()));
    // A game without tyres has none, whatever a frame carries.
    live.caps = crate::game::Caps::GEAR;
    assert!(model(&live, Lang::En).tyres.is_none());
    assert!(!slots(live.caps).cards.contains(&Pane::Tyres));
}

#[test]
fn the_laps_table_is_newest_first_with_the_best_the_gaps_and_the_sectors() {
    let live = rich_reading();
    let laps = rich_laps();
    let m = model_with(&live, Default::default(), &laps);
    assert!(m.laps.sectors);
    assert_eq!(m.laps.heads, ["Lap", "Time", "Gap"]);
    let numbers: Vec<&str> = m.laps.rows.iter().map(|r| r.number.as_str()).collect();
    assert_eq!(numbers, ["4", "3", "2", "1"], "the lap being driven first, then the newest");
    let kinds: Vec<LapKind> = m.laps.rows.iter().map(|r| r.kind).collect();
    assert_eq!(kinds, [LapKind::Live, LapKind::Best, LapKind::Done, LapKind::Invalid]);
    let live_row = &m.laps.rows[0];
    assert_eq!(live_row.time_role, Role::Primary);
    assert_eq!(live_row.gap, "-0.270");
    // Timing colours (module 4): purple the fastest of any lap, green faster than the best lap, yellow slower.
    assert_eq!(
        live_row.sectors[0],
        Some(("27.811".to_owned(), Role::Best)),
        "faster than every first sector so far: purple"
    );
    assert_eq!(live_row.sectors[1], Some(("44.597".to_owned(), Role::Best)));
    assert_eq!(live_row.sectors[2], None);
    assert_eq!(live_row.gap_bar, None, "the lap being driven has its delta, not a bar");
    let best = &m.laps.rows[1];
    assert_eq!((best.gap.as_str(), best.time_role, best.gap_bar), ("Best", Role::Best, None));
    assert!(best.sectors.iter().all(|s| s.as_ref().is_some_and(|(_, role)| *role == Role::Best)));
    let done = &m.laps.rows[2];
    assert_eq!(done.gap, "+0.419");
    let roles: Vec<Role> = done.sectors.iter().map(|s| s.as_ref().unwrap().1).collect();
    assert_eq!(roles, [Role::Warn; 3], "every sector slower than the best lap's: yellow");
    assert!((done.gap_bar.unwrap() - 0.419 / LAP_GAP_FULL_S).abs() < 0.001);
    // Lap 5 is faster than the best lap (lap 3, 27.903) in the first sector but not the fastest there (lap 6, 27.850):
    // green; lap 6 holds the fastest first sector: purple. Both are slower laps overall.
    let mut more = rich_laps();
    for (number, s) in [(5, [27_880, 45_000, 52_000]), (6, [27_850, 44_800, 52_000])] {
        more.push(SavedLap {
            valid: true,
            sectors_ms: s.to_vec(),
            time_ms: s.iter().sum(),
            ..saved_lap(number, 0)
        });
    }
    let rows = model_with(&live, Default::default(), &more).laps.rows;
    let roles_of = |n: &str| -> Vec<Role> {
        let row = rows.iter().find(|r| r.number == n && r.kind != LapKind::Live).unwrap();
        row.sectors.iter().map(|s| s.as_ref().unwrap().1).collect()
    };
    assert_eq!(roles_of("5"), [Role::Good, Role::Warn, Role::Warn]);
    assert_eq!(roles_of("6"), [Role::Best, Role::Warn, Role::Warn]);
    let invalid = &m.laps.rows[3];
    assert_eq!(
        (invalid.gap.as_str(), invalid.time_role, invalid.gap_role),
        ("invalid", Role::Muted, Role::Danger)
    );
    assert!(
        invalid.sectors.iter().all(|s| s.as_ref().is_some_and(|(_, r)| *r != Role::Best)),
        "an invalid lap sets no best sector"
    );
    // Without sectors in the game: no columns for them.
    let mut plain = live.clone();
    plain.caps = plain.caps.minus(crate::game::Caps::SECTORS);
    assert!(!model_with(&plain, Default::default(), &laps).laps.sectors);
    // The first lap: only the lap being driven, with no gap yet.
    let mut first = live.clone();
    first.delta_s = None;
    first.best_lap_s = None;
    let m = model_with(&first, Default::default(), &[]);
    assert_eq!(m.laps.rows.len(), 1);
    assert_eq!(m.laps.rows[0].gap, "–");
    // Out of the car there is no lap being driven.
    let mut menu = live.clone();
    menu.driving = false;
    menu.phase = crate::game::Phase::Menu;
    assert!(model_with(&menu, Default::default(), &laps)
        .laps
        .rows
        .iter()
        .all(|r| r.kind != LapKind::Live));
    // Paused: it stays, dimmed.
    let mut paused = live;
    paused.driving = false;
    paused.phase = crate::game::Phase::Paused;
    let m = model_with(&paused, Default::default(), &laps);
    assert_eq!((m.laps.rows[0].kind, m.laps.rows[0].show), (LapKind::Live, Show::Dimmed));
    assert_eq!(sector_text(27_811), "27.811");
}

/// The owner's lights card (2026-11-19): no light's name runs out of its tile, in any language. A short name first, and
/// the font shrinks (never under `T_LABEL_MIN`) for what is still too wide.
#[test]
fn every_light_name_fits_its_tile_in_every_language() {
    let names = [
        Msg::AlertPit,
        Msg::AlertAbs,
        Msg::AlertTc,
        Msg::LightDrs,
        Msg::AlertHeadlights,
        Msg::AlertFuel,
        Msg::AlertEngine,
        Msg::AlertHandbrake,
        Msg::LightFlag,
        Msg::PanelFlagGreen,
        Msg::PanelFlagYellow,
        Msg::PanelFlagBlue,
        Msg::PanelFlagWhite,
        Msg::PanelFlagBlack,
        Msg::PanelFlagChequered,
    ];
    // The narrowest tile of the grid in a real layout, less its padding.
    let room = 96.0 - 2.0 * S2;
    let mut misses = Vec::new();
    let _ = painted_by(10, 10, |g| {
        for lang in Lang::ALL {
            for msg in &names {
                let word = text(lang, msg);
                assert!(word.chars().count() <= 10, "{lang:?}: {word} is not a short name");
                let size = g.caps_fit_size(&word, T_CAPTION, room);
                if g.caps_width(&word, size) > room || size < T_LABEL_MIN {
                    misses.push(format!("{lang:?} {word} at {size}"));
                }
            }
        }
    });
    assert!(misses.is_empty(), "these run out of a light's tile: {misses:?}");
}

/// The owner's lights card (2026-11-19): every light the game can give keeps its place, lit or not.
#[test]
fn every_light_the_game_gives_keeps_its_place_lit_or_not() {
    use crate::game::{Caps, CarState, Drs, Flag};
    let mut live = live_reading();
    live.fuel_per_lap_l = None;
    live.state = CarState::UNKNOWN;
    live.caps = Caps::NONE;
    assert!(model(&live, Lang::En).alerts.is_empty() && model(&live, Lang::En).electronics.is_empty());
    live.caps = Caps::ABS_ACTIVE
        .or(Caps::DRS)
        .or(Caps::HEADLIGHTS)
        .or(Caps::FLAG)
        .or(Caps::PIT_LIMITER);
    let m = model(&live, Lang::En);
    let words: Vec<&str> = m.alerts.iter().map(|a| a.word.as_str()).collect();
    assert_eq!(words, ["Limiter", "ABS", "DRS", "Lights", "Flag"], "all there, all off");
    assert!(m.alerts.iter().all(|a| a.glow == Glow::Off));
    live.state.abs_active = Some(true);
    live.state.drs = Some(Drs::Available);
    live.state.headlights = Some(false);
    live.state.pit_limiter = Some(false);
    live.state.flag = Some(Flag::Yellow);
    let m = model(&live, Lang::En);
    let looks: Vec<(&str, Glow)> = m.alerts.iter().map(|a| (a.word.as_str(), a.glow)).collect();
    assert_eq!(
        looks,
        [
            ("Limiter", Glow::Off),
            ("ABS", Glow::On),
            ("DRS", Glow::Ready),
            ("Lights", Glow::Off),
            ("Yellow", Glow::On),
        ],
        "the same places and names; the lit ones in their colour"
    );
    assert!(m.alerts.iter().all(|a| a.show == Show::Shown));
    live.state.drs = Some(Drs::Open);
    assert!(model(&live, Lang::En).alerts.iter().any(|a| a.word == "DRS" && a.glow == Glow::On));
    assert_eq!(model(&live, Lang::Pt).alerts[0].word, "Limitador");
    // The grid: nine lights are three rows of three; with no room for it, none.
    let cells = light_grid((0.0, 0.0, 300.0, 120.0), 9).unwrap();
    assert_eq!((cells[2].1, cells[3].1 > cells[2].1, cells[8].0), (0.0, true, cells[2].0));
    assert!(light_grid((0.0, 0.0, 300.0, 30.0), 9).is_none(), "three rows do not fit in 30 px");
    // Off, ready and on, as drawn.
    let tile = |glow: Glow| Light {
        kind: PillKind::Drs,
        glow,
        flag: None,
        word: "DRS".into(),
        show: Show::Shown,
    };
    let looks = [
        (Glow::Off, BACKGROUND, BORDER),
        (Glow::Ready, BACKGROUND, SUCCESS),
        (Glow::On, SUCCESS, SUCCESS),
    ];
    let near = |a: COLORREF, b: COLORREF| (0..3).all(|i| ((a >> (8 * i)) & 0xff).abs_diff((b >> (8 * i)) & 0xff) <= 12);
    for (glow, fill, edge) in looks {
        let light = tile(glow);
        let at = painted_by(80, 30, |g| g.alert_tile(&light, (0.0, 0.0, 80.0, 30.0)));
        assert!(near(at(6, 4), fill) && near(at(40, 0), edge), "{glow:?}");
    }
    // The limiter, engine, fuel and handbrake have their names too.
    live.caps = live.caps.or(Caps::ENGINE_WARNING).or(Caps::HANDBRAKE).or(Caps::FUEL);
    live.state.pit_limiter = Some(true);
    live.state.engine_warning = Some(true);
    live.state.handbrake = Some(true);
    live.fuel_per_lap_l = Some(2.9);
    live.fuel_l = 3.0;
    let words: Vec<String> = model(&live, Lang::En).alerts.into_iter().map(|a| a.word).collect();
    for want in ["Limiter", "Engine", "Fuel", "Handbrake"] {
        assert!(words.iter().any(|w| w == want), "{want} in {words:?}");
    }
    // Out of the car they are the last known, dimmed.
    live.driving = false;
    assert!(model(&live, Lang::En).alerts.iter().all(|a| a.show == Show::Dimmed));
}

#[test]
fn the_electronics_row_and_the_damage_line_keep_only_what_the_game_can_give() {
    use crate::game::{Caps, CarState};
    let mut live = live_reading();
    live.state = CarState::UNKNOWN;
    live.caps = Caps::NONE;
    let m = model(&live, Lang::En);
    assert!(m.electronics.is_empty() && !m.damage.visible());
    live.caps = Caps::TC_LEVEL.or(Caps::BRAKE_BIAS).or(Caps::DAMAGE_GEARBOX).or(Caps::DAMAGE_BODY);
    live.state.tc_level = Some(0);
    live.state.brake_bias = Some(0.56);
    live.state.damage_gearbox = Some(0.0);
    live.state.damage_body = Some(0.0);
    let m = model(&live, Lang::En);
    assert_eq!(
        m.electronics.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(),
        ["OFF", "56.0 %"]
    );
    assert_eq!(m.damage.text, "Damage: none");
    assert_eq!(model(&live, Lang::Pt).damage.text, "Avarias: nenhuma");
    live.state.damage_gearbox = Some(0.4);
    live.state.damage_body = Some(0.125);
    assert_eq!(model(&live, Lang::En).damage.text, "Damage: Body 12%, Gbx 40%");
    // A setting the game can give but has no value for now keeps its place, dimmed.
    live.state.brake_bias = None;
    let m = model(&live, Lang::En);
    assert_eq!((m.electronics[1].value.as_str(), m.electronics[1].show), ("–", Show::Dimmed));
}

#[test]
fn the_header_says_the_session_and_nothing_when_the_game_does_not() {
    use crate::game::SessionKind;
    let mut live = live_reading();
    assert_eq!(model(&live, Lang::En).session, None);
    for (kind, en, pt) in [
        (SessionKind::Practice, "Practice", "Treino"),
        (SessionKind::Qualifying, "Qualifying", "Classificação"),
        (SessionKind::Race, "Race", "Corrida"),
    ] {
        live.session_kind = Some(kind);
        assert_eq!(model(&live, Lang::En).session.as_deref(), Some(en));
        assert_eq!(model(&live, Lang::Pt).session.as_deref(), Some(pt));
    }
    live.session_kind = Some(SessionKind::Unknown);
    assert_eq!(model(&live, Lang::En).session, None);
}

#[test]
fn a_game_without_a_clutch_or_sectors_or_a_best_lap_hides_exactly_those() {
    use crate::game::Caps;
    let live = rich_reading();
    let m = model(&live, Lang::En);
    assert!(m.clutch.visible() && m.brake.visible() && m.throttle.visible());
    assert_eq!((m.throttle.text.as_str(), m.throttle.label.as_str()), ("92%", "Throttle"));
    let mut no_clutch = live.clone();
    no_clutch.caps = no_clutch.caps.minus(Caps::CLUTCH);
    let m = model(&no_clutch, Lang::En);
    assert!(!m.clutch.visible() && m.brake.visible());
    let plan = centre_plan((0.0, 0.0, 400.0, 300.0), &slots(no_clutch.caps));
    assert_eq!(plan.pedals.iter().filter(|p| p.is_some()).count(), 2);
    assert!(plan.pedals[2].is_none());
    // The first lap: the delta says why it is not there, the best lap is hidden, the places stay.
    let mut first = live.clone();
    first.delta_s = None;
    first.best_lap_s = None;
    first.last_lap_s = None;
    let m = model(&first, Lang::En);
    assert!(!m.delta.visible() && !m.best_lap.visible() && !m.last_lap.visible());
    assert_eq!(m.delta_note.as_deref(), Some("The delta shows after your first full lap."));
    assert!(model(&live, Lang::En).delta_note.is_none());
    let s = slots(first.caps);
    assert!(s.delta && s.best && s.last, "the places are there: the game can give them");
    // A game that gives no lap clock has no times card, no delta and no laps table.
    let mut little = live;
    little.caps = Caps::GEAR.or(Caps::SPEED).or(Caps::RPM);
    let s = slots(little.caps);
    assert_eq!(s.cards, [Pane::Centre]);
    let m = model(&little, Lang::En);
    assert!(!m.lap_time.visible() && !m.delta.visible() && m.delta_note.is_none() && m.laps.show == Show::Hidden);
    assert!(m.tyres.is_none() && !m.fuel.visible() && m.alerts.is_empty());
}

#[test]
fn a_paused_game_dims_the_live_readings_and_keeps_the_slow_ones() {
    use crate::game::Phase;
    let mut tracker = crate::dash::Tracker::default();
    tracker.set_caps(evo_like_caps());
    let driving = frame_of(2, 3000.0, 80.0);
    let live = tracker.on_frame("Assetto Corsa EVO", &driving, 100);
    let m = dashboard(&live, &ctx_of(Lang::En, 100));
    assert_eq!(
        (m.gear.show, m.gear.text.as_str(), m.speed.text.as_str()),
        (Show::Shown, "4", "216")
    );
    assert_eq!(m.status, None);
    let mut paused = driving.clone();
    paused.set_phase(Phase::Paused);
    paused.withhold_car_values_unless_driving();
    let live = tracker.on_frame("Assetto Corsa EVO", &paused, 200);
    let m = dashboard(&live, &ctx_of(Lang::En, 200));
    assert_eq!(
        (m.gear.show, m.gear.text.as_str()),
        (Show::Dimmed, "4"),
        "the last gear, never an R"
    );
    assert_eq!(
        (m.speed.show, m.throttle.show, m.steer.show, m.rev.show),
        (Show::Dimmed, Show::Dimmed, Show::Dimmed, Show::Dimmed)
    );
    assert!(m.alerts.iter().all(|a| a.show == Show::Dimmed));
    let tyres = m.tyres.as_ref().expect("the game can give tyres");
    assert_eq!((tyres.show, tyres.tiles[0].temp.as_str()), (Show::Shown, "84°"));
    assert_eq!((m.fuel.show, m.fuel.text.as_str()), (Show::Shown, "40.0"));
    assert_eq!(m.status, Some((StatusKind::Paused, "Paused".to_owned())));
    assert_eq!(m.lap.show, Show::Dimmed);
    // A frame without the tyres and the fuel: the last ones stay, dimmed.
    let mut menu = paused.clone();
    menu.set_phase(Phase::Menu);
    menu.tyres = None;
    menu.fuel_l = f32::NAN;
    let live = tracker.on_frame("Assetto Corsa EVO", &menu, 300);
    let m = dashboard(&live, &ctx_of(Lang::En, 300));
    let tyres = m.tyres.expect("the game can give tyres");
    assert_eq!((tyres.show, tyres.tiles[3].temp.as_str()), (Show::Dimmed, "91°"));
    assert_eq!((m.fuel.show, m.fuel.text.as_str()), (Show::Dimmed, "40.0"));
    assert_eq!(m.lap.show, Show::Hidden, "out of the car there is no lap to number");
    // The same reading and the same context always give the same model.
    let again = dashboard(&live, &ctx_of(Lang::En, 300));
    assert_eq!(format!("{:?}", dashboard(&live, &ctx_of(Lang::En, 300))), format!("{again:?}"));
}

#[test]
fn the_cards_of_a_row_always_share_the_whole_width_with_no_margins_at_the_sides() {
    for (total, cards) in [
        (1440.0, vec![(Pane::Times, 1.0), (Pane::Centre, 1.3)]),
        (1440.0, vec![(Pane::Times, 1.0)]),
        (1900.0, vec![(Pane::Times, 1.0), (Pane::Centre, 1.2), (Pane::Fuel, 1.0)]),
        (
            1440.0,
            vec![(Pane::Times, 1.0), (Pane::Centre, 1.3), (Pane::Fuel, 0.95), (Pane::Tyres, 1.05)],
        ),
        (600.0, vec![(Pane::Times, 1.0)]),
    ] {
        let places = row_places(0.0, total, GAP, &cards);
        assert!(places[0].0.abs() < 0.01, "starts at the left edge: {places:?}");
        let end = places.last().map(|p| p.0 + p.1).unwrap();
        assert!((end - total).abs() < 0.01, "ends at the right edge: {places:?}");
        for pair in places.windows(2) {
            assert!((pair[1].0 - pair[0].0 - pair[0].1 - GAP).abs() < 0.01, "the gap is the token");
        }
    }
    // Each takes its share.
    let two = row_places(0.0, 1000.0, 0.0, &[(Pane::Times, 1.0), (Pane::Centre, 3.0)]);
    assert!((two[1].1 / two[0].1 - 3.0).abs() < 0.001);
    // And in a whole plan: the cards of every row span the canvas, whatever the game can fill.
    for caps in [
        every_cap(),
        evo_like_caps(),
        crate::game::Caps::GEAR.or(crate::game::Caps::LAP_TIME),
    ] {
        let s = slots(caps);
        for layout in [
            Layout::Ultrawide,
            Layout::Wide,
            Layout::Square,
            Layout::Portrait,
            Layout::Stack,
            Layout::Classic,
        ] {
            let plan = layout.plan_for(&s, 1);
            let mut rows: Vec<(f32, Vec<Area>)> = Vec::new();
            for (_, a) in &plan.cards {
                match rows.iter_mut().find(|r| (r.0 - a.1).abs() < 0.01) {
                    Some(r) => r.1.push(*a),
                    None => rows.push((a.1, vec![*a])),
                }
            }
            for (_, cards) in rows {
                assert!(
                    cards.iter().map(|a| a.0).fold(f32::MAX, f32::min).abs() < 0.01,
                    "{layout:?}: left edge"
                );
                let right = cards.iter().map(|a| a.0 + a.2).fold(0.0, f32::max);
                assert!((right - plan.w).abs() < 0.01, "{layout:?}: right edge {right} of {}", plan.w);
            }
        }
    }
}

#[test]
fn a_row_is_as_tall_as_its_content_needs_and_the_height_it_does_not_need_goes_to_the_row_above() {
    // The laps table alone in its row takes only the rows it has.
    let rows = [(300.0, vec![Pane::Times, Pane::Centre]), (262.0, vec![Pane::Laps])];
    let one = row_heights(&rows, 1);
    assert!((one[1] - laps_card_h(1)).abs() < 0.01, "one row: {one:?}");
    assert!((one[0] + one[1] - 562.0).abs() < 0.01, "the canvas keeps its height");
    assert!(one[0] > 300.0, "the row above grows");
    let three = row_heights(&rows, 3);
    assert!(three[1] > one[1] && (three[1] - laps_card_h(3)).abs() < 0.01);
    // Never past its own height, and never under one row (the line that says there are no laps).
    let many = row_heights(&rows, 99);
    assert!(many[1] <= 262.0 + 0.01 && (many[0] + many[1] - 562.0).abs() < 0.01);
    assert!(laps_card_h(lap_rows_fit(262.0)) <= 262.0 + 0.01);
    assert_eq!(row_heights(&rows, 0), one, "no laps still has the line that says so");
    // A row with a card that needs all its height keeps it.
    let mixed = [(300.0, vec![Pane::Times]), (262.0, vec![Pane::Laps, Pane::Tyres])];
    assert_eq!(row_heights(&mixed, 1), vec![300.0, 262.0]);
    // Track and alerts hold their floor.
    let with_track = [(300.0, vec![Pane::Times]), (262.0, vec![Pane::Laps, Pane::Track])];
    let h = row_heights(&with_track, 1);
    assert!((h[1] - TRACK_NEED_H).abs() < 0.01);
    // A laps row with nothing above it gives its spare height to the row below, else keeps it.
    assert_eq!(row_heights(&[(262.0, vec![Pane::Laps])], 1), vec![262.0]);
    let below = row_heights(&[(262.0, vec![Pane::Laps]), (300.0, vec![Pane::Times])], 1);
    assert!((below[0] + below[1] - 562.0).abs() < 0.01 && below[1] > 300.0);
    // In a real layout: a game with few cards, one lap.
    let s = slots(
        crate::game::Caps::LAP_TIME
            .or(crate::game::Caps::SPEED)
            .or(crate::game::Caps::GEAR)
            .or(crate::game::Caps::THROTTLE),
    );
    for layout in [Layout::Wide, Layout::Square, Layout::Portrait, Layout::Stack] {
        let few = layout.plan_for(&s, 1);
        let full = layout.plan(&s);
        assert!((few.h - full.h).abs() < 0.01, "{layout:?}: the canvas does not change size");
        let laps = few.area(Pane::Laps).unwrap();
        assert!(laps.3 < full.area(Pane::Laps).unwrap().3 - 20.0, "{layout:?}: the table is short");
        // The card right above the table took the height the table gave up.
        let above = few
            .cards
            .iter()
            .find(|(_, a)| (a.1 + a.3 + GAP - laps.1).abs() < 0.01)
            .map(|(c, a)| (*c, *a))
            .expect("a card right above the table");
        assert!(above.1 .3 > full.area(above.0).unwrap().3 + 20.0, "{layout:?}: the card above grew");
    }
}

#[test]
fn blocks_are_stacked_with_an_even_gap_and_centred_never_with_a_hole() {
    // Tall room: the gap stops at its cap, the group is centred.
    let tops = stack(0.0, 400.0, &[60.0, 48.0, 52.0], S3, S8);
    assert_eq!(tops[1] - tops[0] - 60.0, S8);
    assert_eq!(tops[2] - tops[1] - 48.0, S8);
    let (first, last) = (tops[0], 400.0 - (tops[2] + 52.0));
    assert!((first - last).abs() < 0.01, "equal margins");
    // Tight room: the gap is never under its floor.
    let tops = stack(0.0, 170.0, &[60.0, 48.0, 52.0], S3, S8);
    assert!((tops[1] - tops[0] - 60.0 - S3).abs() < 0.01);
    // One block is just centred.
    assert_eq!(stack(10.0, 100.0, &[40.0], S3, S8), vec![40.0]);
    // The times card, whatever its height: the lap time, the delta and the records are never further apart than the cap.
    let s = slots(every_cap());
    for h in [260.0, 300.0, 380.0, 466.0, 560.0] {
        let card = (0.0, 0.0, 480.0, h);
        let p = times_plan(card, &s);
        let (x, y, w, ih) = inner(card);
        assert!(inside_box(p.lap, x, y, w, ih) && inside_box(p.delta, x, y, w, ih) && inside_box(p.records, x, y, w, ih));
        assert!(p.delta.1 - (p.lap.1 + p.lap.3) <= S8 + 0.01, "h {h}: lap time to delta");
        // With the delta along the lap (module 5) between them, each step keeps the same even gap.
        let above_records = match p.trace {
            Some(t) => {
                assert!(t.1 - (p.bar.1 + p.bar.3) <= S8 + 0.01, "h {h}: delta to its graph");
                t.1 + t.3
            }
            None => p.bar.1 + p.bar.3,
        };
        assert!(p.records.1 - above_records <= 2.0 * S8 + 0.01, "h {h}: delta to records");
        assert!(!overlap(p.lap, p.delta) && !overlap(p.bar, p.records) && !overlap(p.delta, p.records));
        assert_eq!(p.big, h - 2.0 * S3 >= TIMES_BIG_H, "tall cards get the big figures");
        let rule = p.rule.expect("the line over the records");
        assert!(rule.1 > p.bar.1 + p.bar.3 && rule.1 < p.records.1);
    }
    // The fuel card (module 6): the group, the use tiles, the planner and the temperatures, in that order with even
    // gaps; a short card drops the planner first, then the tiles, never the fuel or the temperatures.
    for h in [262.0, 300.0, 460.0] {
        let card = (0.0, 0.0, 400.0, h);
        let p = fuel_rows(card, 74.0, true, 3, true);
        let t = p.temps.unwrap();
        let (x, y, w, ih) = inner(card);
        assert!(inside_box(p.group, x, y + CAPTION_H, w, ih - CAPTION_H) && inside_box(t, x, y, w, ih));
        let mut order = vec![p.group];
        order.extend(p.stats);
        order.extend(p.planner);
        order.push(t);
        for pair in order.windows(2) {
            let gap = pair[1].1 - (pair[0].1 + pair[0].3);
            assert!((S3 - 0.01..=S8 + 0.01).contains(&gap), "h {h}: an even gap ({gap})");
        }
        assert_eq!(fuel_rows(card, 74.0, true, 3, false).temps, None);
    }
    let tall = fuel_rows((0.0, 0.0, 400.0, 460.0), 74.0, true, 3, true);
    assert!(
        tall.stats.is_some() && tall.planner.is_some(),
        "a tall card has room for everything"
    );
    let short = fuel_rows((0.0, 0.0, 400.0, 262.0), 74.0, true, 3, true);
    assert!(short.planner.is_none(), "the planner goes first");
}

#[test]
fn the_pedals_are_throttle_brake_clutch_from_left_to_right() {
    let plan = centre_plan((0.0, 0.0, 576.0, 300.0), &slots(every_cap()));
    let [Some(throttle), Some(brake), Some(clutch)] = plan.pedals else {
        panic!("three pedals");
    };
    assert!(throttle.1 .0 < brake.1 .0 && brake.1 .0 < clutch.1 .0, "left to right");
    // Pixels: the throttle bar (green) is in the left third of the pedals, the clutch (blue) in the right third.
    let f = fixture();
    let mut live = rich_reading();
    live.throttle = 1.0;
    live.brake = 0.0;
    live.clutch = 1.0;
    let (w, h) = (1536, 864);
    let pixels = render(&view(&f, Some(&live), Tab::Dash, 1.0, Lang::En), w, h);
    let s = slots(live.caps);
    let body = rect(16, 66, w - 16, h - 16);
    let layout = pick_layout((body.right - body.left) as f32, (body.bottom - body.top) as f32, &s);
    let plan_all = layout.plan_for(&s, model_with(&live, Default::default(), &f.laps).laps.rows.len());
    let (scale, ox, oy) = canvas_fit_wh(body, plan_all.w, plan_all.h);
    let card = plan_all.area(Pane::Centre).unwrap();
    let cp = centre_plan(card, &s);
    let px = |a: Area| {
        (
            ox + (a.0 * scale) as i32,
            oy + (a.1 * scale) as i32,
            ox + ((a.0 + a.2) * scale) as i32,
            oy + ((a.1 + a.3) * scale) as i32,
        )
    };
    let bar = |i: usize| px(cp.pedals[i].unwrap().1);
    assert!(
        has_color(&region_of(&pixels, w, bar(0)), SUCCESS) > 50,
        "the first bar is the throttle"
    );
    assert_eq!(has_color(&region_of(&pixels, w, bar(1)), SUCCESS), 0, "the brake is not first");
    assert!(has_color(&region_of(&pixels, w, bar(2)), INFO) > 50, "the third is the clutch");
}

#[test]
fn a_paused_or_silent_game_gets_a_banner_and_the_other_states_keep_the_state_line() {
    let mut live = rich_reading();
    // Driving: no banner.
    assert_eq!(model(&live, Lang::En).banner, None);
    // Paused: the title and the sentence, in every language.
    live.driving = false;
    live.phase = crate::game::Phase::Paused;
    for (lang, title, note) in [
        (Lang::En, "PAUSED", "Tyres, fuel and laps show the last value read."),
        (Lang::Pt, "PAUSADO", "Pneus, combustível e voltas mostram o último valor lido."),
        (
            Lang::Es,
            "EN PAUSA",
            "Neumáticos, combustible y vueltas muestran el último valor leído.",
        ),
    ] {
        let b = model(&live, lang).banner.expect("a banner while paused");
        assert_eq!((b.kind, b.title.as_str(), b.note.as_str()), (StatusKind::Paused, title, note));
    }
    // Menu and garage: the state line, no banner.
    live.phase = crate::game::Phase::default();
    let m = model(&live, Lang::En);
    assert_eq!((m.banner, m.status.map(|s| s.0)), (None, Some(StatusKind::NotDriving)));
    // In the pits: the state line.
    live.in_pits = true;
    assert_eq!(model(&live, Lang::En).banner, None);
    live.in_pits = false;
    // A silent game: the same banner with its own words.
    live.driving = true;
    let silent = dashboard(&live, &ctx_of(Lang::En, live.at_ms + 60_000));
    let b = silent.banner.expect("a banner while the game is silent");
    assert_eq!(b.kind, StatusKind::NoData);
    assert_eq!(b.title, "NO DATA FROM THE GAME");
    assert_ne!(b.note, "Tyres, fuel and laps show the last value read.");
    // The box is centred in its card and always inside it.
    let card = (100.0, 200.0, 420.0, 300.0);
    for (tw, th) in [(100.0, 60.0), (900.0, 400.0)] {
        let (x, y, w, h) = banner_box(card, tw, th);
        assert!((x * 2.0 + w - (card.0 * 2.0 + card.2)).abs() < 0.01);
        assert!((y * 2.0 + h - (card.1 * 2.0 + card.3)).abs() < 0.01);
        assert!(inside_box(
            (x, y, w, h),
            card.0 + S3,
            card.1 + S3,
            card.2 - 2.0 * S3,
            card.3 - 2.0 * S3
        ));
    }
}

#[test]
fn the_banner_is_painted_over_the_dimmed_cards_without_moving_them() {
    let mut f = fixture();
    // The game is connected and its frames stopped: the dashboard stays, dimmed.
    f.snapshot.game = Game::Recording(4);
    let mut driving = rich_reading();
    driving.caps = every_cap();
    let mut paused = driving.clone();
    paused.driving = false;
    paused.phase = crate::game::Phase::Paused;
    let mut stale = driving.clone();
    stale.at_ms = -10_000;
    let silent_at = view(&f, Some(&stale), Tab::Dash, 1.0, Lang::En);
    for (w, h) in [(1536, 864), (1024, 768), (430, 900), (2560, 1080)] {
        let live_px = render(&view(&f, Some(&driving), Tab::Dash, 1.0, Lang::En), w, h);
        let paused_px = render(&view(&f, Some(&paused), Tab::Dash, 1.0, Lang::En), w, h);
        let silent_px = render(&silent_at, w, h);
        // The title is in the caution colour; driving has no such colour in the middle of the cards.
        let s = slots(paused.caps);
        let body = rect(16, 66, w - 16, h - 16);
        let layout = pick_layout((body.right - body.left) as f32, (body.bottom - body.top) as f32, &s);
        let rows = model_with(&paused, Default::default(), &f.laps).laps.rows.len();
        let plan = layout.plan_for(&s, rows);
        let (scale, ox, oy) = canvas_fit_wh(body, plan.w, plan.h);
        let target = banner_target(&plan).expect("a card to put it over");
        assert_eq!(Some(target), plan.area(Pane::Centre), "over the centre card");
        // Never over a card whose readings stay readable.
        for (pane, other) in &plan.cards {
            if *pane != Pane::Centre {
                assert!(!overlap(target, *other), "{w}x{h}: the banner stays off {pane:?}");
            }
        }
        let b = banner_box(target, 200.0, 70.0);
        let middle = (
            ox + (b.0 * scale) as i32,
            oy + ((b.1 + b.3 * 0.2) * scale) as i32,
            ox + ((b.0 + b.2) * scale) as i32,
            oy + ((b.1 + b.3 * 0.6) * scale) as i32,
        );
        assert!(
            has_color(&region_of(&paused_px, w, middle), WARN) > 30,
            "{w}x{h}: PAUSED in the caution colour"
        );
        assert!(
            has_color(&region_of(&silent_px, w, middle), WARN) > 30,
            "{w}x{h}: the silent banner has the same style"
        );
        assert_eq!(
            has_color(&region_of(&live_px, w, middle), WARN),
            0,
            "{w}x{h}: no banner while driving"
        );
        // The box is card-coloured: its inside is the card colour next to the text.
        let inside = (middle.0 + 2, middle.1, middle.0 + 6, middle.3);
        assert!(
            has_color(&region_of(&paused_px, w, inside), CARD) > 0,
            "{w}x{h}: a card-coloured box"
        );
        // Nothing underneath moves: the cards are where they are with and without it (their frames match at an edge strip
        // away from the box).
        let edge = (ox, oy + (CARDS_TOP * scale) as i32 - 4, ox + 40, oy + (plan.h * scale) as i32);
        let live_edge = region_of(&live_px, w, edge);
        let paused_edge = region_of(&paused_px, w, edge);
        assert_eq!(
            has_color(&live_edge, BORDER) > 0,
            has_color(&paused_edge, BORDER) > 0,
            "{w}x{h}: the card frames are in the same place"
        );
    }
    // The header keeps no second word for it: the state line is for the other states.
    let m = model(&paused, Lang::En);
    assert!(m.banner.is_some() && m.status.is_some());
}

#[test]
fn every_layout_puts_every_card_the_game_can_fill_inside_the_canvas_without_overlap() {
    for caps in [
        every_cap(),
        evo_like_caps(),
        crate::game::Caps::GEAR.or(crate::game::Caps::LAP_TIME),
    ] {
        let s = slots(caps);
        for layout in [
            Layout::Classic,
            Layout::Ultrawide,
            Layout::Wide,
            Layout::Square,
            Layout::Portrait,
            Layout::Stack,
        ] {
            let plan = layout.plan(&s);
            if layout != Layout::Classic {
                assert_eq!(plan.cards.len(), s.cards.len(), "{layout:?}: every card has a place");
            }
            for (i, (card, area)) in plan.cards.iter().enumerate() {
                assert!(inside_box(*area, 0.0, 0.0, plan.w, plan.h), "{layout:?} {card:?} inside the canvas");
                for (other, b) in &plan.cards[i + 1..] {
                    assert!(!overlap(*area, *b), "{layout:?}: {card:?} over {other:?}");
                }
            }
        }
    }
    let s = slots(every_cap());
    let wide = Layout::Wide.plan(&s);
    let (times, laps) = (wide.area(Pane::Times).unwrap(), wide.area(Pane::Laps).unwrap());
    assert!(
        times.3 >= 300.0 && laps.1 == times.1 + times.3 + GAP,
        "the laps are right under the first row"
    );
    // Nothing the game can give: no cards and a canvas that is only the header.
    assert_eq!(Layout::Wide.plan(&slots(crate::game::Caps::NONE)).h, CARDS_TOP);
}

#[test]
fn each_screen_shape_gets_the_layout_that_fills_it() {
    let s = slots(every_cap());
    // The window's body: the window less the header (66) and the margins (16 around).
    let pick = |w: f32, h: f32| pick_layout(w - 32.0, h - 66.0 - 16.0, &s);
    assert_eq!(pick(2560.0, 1080.0), Layout::Ultrawide);
    assert_eq!(pick(3440.0, 1440.0), Layout::Ultrawide);
    assert_eq!(pick(1920.0, 1080.0), Layout::Wide);
    assert_eq!(pick(1536.0, 864.0), Layout::Wide, "the window as it opens on a 1080p screen");
    assert_eq!(pick(1680.0, 1050.0), Layout::Wide);
    assert_eq!(pick(1280.0, 720.0), Layout::Wide);
    assert_eq!(pick(1024.0, 768.0), Layout::Square);
    assert_eq!(pick(1280.0, 1024.0), Layout::Square);
    assert_eq!(pick(430.0, 900.0), Layout::Portrait);
    assert_eq!(pick(540.0, 1080.0), Layout::Portrait);
    assert_eq!(pick(960.0, 600.0), Layout::Classic, "too small for the others to read well");
    // Whatever the shape, the dashboard scales to a size that can be read.
    for (w, h) in [(2560.0, 1080.0), (1920.0, 1080.0), (1024.0, 768.0), (430.0, 900.0), (960.0, 600.0)] {
        let (bw, bh) = (w - 32.0, h - 82.0);
        let layout = pick_layout(bw, bh, &s);
        let (cw, ch) = layout.size(&s);
        assert!((bw / cw).min(bh / ch) >= 0.5, "{w}x{h} {layout:?}");
    }
}

#[test]
fn a_phone_with_few_cards_gets_one_column_at_a_size_text_reads_at() {
    let few = slots(
        crate::game::Caps::LAP_TIME
            .or(crate::game::Caps::SPEED)
            .or(crate::game::Caps::GEAR)
            .or(crate::game::Caps::RPM)
            .or(crate::game::Caps::THROTTLE)
            .or(crate::game::Caps::BRAKE)
            .or(crate::game::Caps::LAST_LAP),
    );
    let all = slots(every_cap());
    for (w, h) in [(430.0, 900.0), (390.0, 844.0), (412.0, 915.0)] {
        let (bw, bh) = (w - 32.0, h - 66.0 - 16.0);
        let layout = pick_layout(bw, bh, &few);
        assert_eq!(layout, Layout::Stack, "{w}x{h}: one column, not two scaled down");
        let (cw, ch) = layout.size(&few);
        let scale = (bw / cw).min(bh / ch);
        assert!(
            scale * T_CAPTION >= 10.0,
            "{w}x{h}: the smallest text is {} px on screen",
            scale * T_CAPTION
        );
        // With every card the single column would shrink the text further, so the two columns stay.
        assert_eq!(pick_layout(bw, bh, &all), Layout::Portrait);
    }
    // The single column never has a card beside another.
    let plan = Layout::Stack.plan(&all);
    assert!(plan.cards.iter().all(|(_, a)| a.0 == 0.0 && (a.2 - plan.w).abs() < 0.01));
}

#[test]
fn the_layout_only_changes_when_the_window_crosses_a_threshold_by_a_margin() {
    let s = slots(every_cap());
    let (mut sticky_flips, mut plain_flips, mut edges) = (0, 0, 0);
    for bh in [600.0, 760.0, 900.0, 1080.0] {
        let widths: Vec<f32> = (600..2800).map(|w| w as f32).collect();
        for pair in widths.windows(2) {
            let (was, now) = (pick_layout(pair[0], bh, &s), pick_layout(pair[1], bh, &s));
            if was == now {
                continue;
            }
            edges += 1;
            let mut current = Some(pick_layout_sticky(pair[0] - 4.0, bh, &s, None));
            let mut plain = current;
            for step in 0..40 {
                let width = pair[1] + if step % 2 == 0 { 4.0 } else { -6.0 };
                let next = pick_layout_sticky(width, bh, &s, current);
                sticky_flips += usize::from(Some(next) != current);
                current = Some(next);
                let best = pick_layout(width, bh, &s);
                plain_flips += usize::from(Some(best) != plain);
                plain = Some(best);
            }
        }
    }
    assert!(edges >= 4, "the layouts do change with the window ({edges})");
    assert!(
        plain_flips > sticky_flips * 3,
        "the margin stops the flipping: {sticky_flips} against {plain_flips}"
    );
    assert_eq!(pick_layout_sticky(1920.0, 1080.0, &s, None), pick_layout(1920.0, 1080.0, &s));
    // The smallest layout is left as soon as another one reads.
    assert_eq!(pick_layout_sticky(1888.0, 998.0, &s, Some(Layout::Classic)), Layout::Wide);
}

#[test]
fn the_centre_card_keeps_its_parts_apart_and_inside_it() {
    for card in [(0.0, 0.0, 420.0, 300.0), (0.0, 0.0, 330.0, 280.0), (0.0, 0.0, 576.0, 280.0)] {
        let plan = centre_plan(card, &slots(every_cap()));
        let (x, y, w, h) = inner(card);
        let mut parts = vec![plan.gear, plan.speed, plan.unit, plan.steer];
        for (label, bar) in plan.pedals.iter().flatten() {
            parts.push(*label);
            parts.push(*bar);
        }
        for (i, a) in parts.iter().enumerate() {
            assert!(inside_box(*a, x, y, w, h), "{a:?} inside the card {card:?}");
            for b in &parts[i + 1..] {
                assert!(!overlap(*a, *b), "{a:?} over {b:?}");
            }
        }
        // The gears either side stay in the gear's row and clear of the gear's own glyph.
        assert!(inside_box(plan.below, x, y, w, h) && inside_box(plan.above, x, y, w, h));
        assert!(plan.below.0 + plan.below.2 < x + w / 2.0 - 50.0 && plan.above.0 > x + w / 2.0 + 50.0);
        assert!(plan.gear.3 >= 40.0 && plan.speed.1 >= plan.gear.1 + plan.gear.3);
    }
    // Without the pedals and the wheel the gear takes their room.
    let with = centre_plan((0.0, 0.0, 420.0, 300.0), &slots(every_cap()));
    let bare = centre_plan(
        (0.0, 0.0, 420.0, 300.0),
        &slots(crate::game::Caps::GEAR.or(crate::game::Caps::SPEED)),
    );
    assert!(bare.gear.3 > with.gear.3);
}

#[test]
fn the_tyre_tiles_are_two_by_two_or_one_row_and_stay_in_their_card() {
    for card in [(0.0, 0.0, 346.0, 300.0), (0.0, 0.0, 323.0, 260.0), (0.0, 0.0, 800.0, 200.0)] {
        let tiles = tyre_tiles(card);
        let (x, y, w, h) = inner(card);
        for (i, a) in tiles.iter().enumerate() {
            assert!(inside_box(*a, x, y + CAPTION_H, w, h - CAPTION_H), "{a:?} in {card:?}");
            for b in &tiles[i + 1..] {
                assert!(!overlap(*a, *b));
            }
        }
    }
    let [fl, fr, rl, rr] = tyre_tiles((0.0, 0.0, 346.0, 300.0));
    assert!(fl.1 == fr.1 && rl.1 == rr.1 && fl.0 == rl.0 && fr.0 == rr.0 && rl.1 > fl.1 && fr.0 > fl.0);
    let [a, b, c, d] = tyre_tiles((0.0, 0.0, 800.0, 200.0));
    assert!(a.1 == b.1 && b.1 == c.1 && c.1 == d.1, "a wide, short card: one row");
}

#[test]
fn the_laps_table_columns_fill_its_width_and_its_rows_fit_its_height() {
    for sectors in [false, true] {
        let cols = lap_columns(500.0, sectors);
        assert_eq!(cols.len(), if sectors { 6 } else { 3 });
        assert!((cols.last().map(|c| c.0 + c.1).unwrap() - 500.0).abs() < 0.01);
        assert!(cols.windows(2).all(|p| (p[0].0 + p[0].1 - p[1].0).abs() < 0.01));
    }
    assert_eq!(lap_rows_fit(262.0), 7);
    assert_eq!(lap_rows_fit(40.0), 0);
    let places = flow((0.0, 0.0, 100.0, 70.0), &[60.0, 60.0, 30.0, 60.0, 60.0], 28.0, 8.0);
    assert_eq!(places[0], Some((0.0, 0.0, 60.0, 28.0)));
    assert_eq!(places[1].map(|p| p.1), Some(36.0), "a tile that does not fit goes to the next line");
    assert!(places.iter().flatten().all(|p| inside_box(*p, 0.0, 0.0, 100.0, 70.0)));
    assert!(places[4].is_none(), "no room for a third line");
}

/// Where a pane is on a `w` x `h` window, in pixels, for the picture to be compared there.
fn pane_region(caps: crate::game::Caps, w: i32, h: i32, pane: Pane, lap_rows: usize) -> (i32, i32, i32, i32) {
    let s = slots(caps);
    let body = rect(16, 66, w - 16, h - 16);
    let layout = pick_layout((body.right - body.left) as f32, (body.bottom - body.top) as f32, &s);
    let plan = layout.plan_for(&s, lap_rows);
    let (scale, ox, oy) = canvas_fit_wh(body, plan.w, plan.h);
    let (x, y, aw, ah) = plan.area(pane).expect("the pane is there");
    let p = |v: f32, o: i32| o + (v * scale).round() as i32;
    (p(x, ox), p(y, oy), p(x + aw, ox), p(y + ah, oy))
}

#[test]
fn values_that_come_and_go_never_move_another_card() {
    let f = fixture();
    let mut base = rich_reading();
    base.caps = every_cap();
    let (w, h) = (1536, 864);
    let still = render(&view(&f, Some(&base), Tab::Dash, 1.0, Lang::En), w, h);
    let rows = model_with(&base, Default::default(), &f.laps).laps.rows.len();
    // The tyres, the fuel, the temperatures, the alerts and the best lap go missing: the other cards do not shift.
    let mut gone = base.clone();
    gone.tyres = None;
    gone.fuel_l = f32::NAN;
    gone.state = crate::game::CarState::UNKNOWN;
    gone.last_seen = Default::default();
    gone.best_lap_s = None;
    gone.delta_s = None;
    gone.last_lap_s = None;
    let after = render(&view(&f, Some(&gone), Tab::Dash, 1.0, Lang::En), w, h);
    for pane in [Pane::Centre, Pane::Track] {
        let region = pane_region(base.caps, w, h, pane, rows);
        assert_eq!(region_of(&still, w, region), region_of(&after, w, region), "{pane:?} did not move");
    }
    assert_eq!(slots(base.caps), slots(gone.caps), "the layout is chosen from the caps");
    // The times card keeps the lap time where it was (the top of the card) when the records appear.
    let (x0, y0, x1, y1) = pane_region(base.caps, w, h, Pane::Times, rows);
    let top = (x0, y0, x1, y0 + (y1 - y0) / 3);
    assert_eq!(region_of(&still, w, top), region_of(&after, w, top), "the lap time did not move");
}

#[test]
fn the_dashboard_paints_each_card_in_its_colours() {
    let f = fixture();
    let live = rich_reading();
    let (w, h) = (1920, 1080);
    let pixels = render(&view(&f, Some(&live), Tab::Dash, 1.0, Lang::En), w, h);
    save(&pixels, w, h, "panel-dashboard.png");
    assert!(pixels[..3].iter().all(|&c| c < 0x24), "the corner is the dark background");
    assert!(
        has_color(&pixels, PRIMARY) > 2000,
        "the gear, the lap and the tab are in the accent"
    );
    for (colour, what) in [
        (SUCCESS, "the throttle bar, the delta, the fuel, an ok tyre"),
        (BEST, "the best lap"),
        (WARN, "a hot tyre"),
        (DESTRUCTIVE, "an over tyre and the invalid lap"),
    ] {
        let n = has_color(&pixels, colour);
        assert!(n > 100, "{what}: {n}");
    }
    // A lit alert is a solid tile in its colour; one that is off is not drawn at all.
    let mut off = live.clone();
    off.state.abs_active = Some(false);
    off.state.drs = Some(crate::game::Drs::Off);
    let quiet = render(&view(&f, Some(&off), Tab::Dash, 1.0, Lang::En), w, h);
    assert!(
        has_color(&pixels, INFO) > has_color(&quiet, INFO) + 1500,
        "ABS ACTIVE is a solid blue tile"
    );
    // Out of the car: the gear is dim.
    let mut menu = live.clone();
    menu.driving = false;
    let dim = render(&view(&f, Some(&menu), Tab::Dash, 1.0, Lang::En), w, h);
    assert!(has_color(&dim, PRIMARY) < has_color(&pixels, PRIMARY) / 2);
}

#[test]
fn out_of_the_car_the_header_shows_no_lap_and_no_invalid_badge() {
    let f = fixture();
    let mut live = live_reading();
    live.lap_valid = Some(false);
    let (w, h) = (1920, 1080);
    let s = slots(live.caps);
    let body = rect(16, 66, w - 16, h - 16);
    let layout = pick_layout((body.right - body.left) as f32, (body.bottom - body.top) as f32, &s);
    let plan = layout.plan(&s);
    let (scale, ox, oy) = canvas_fit_wh(body, plan.w, plan.h);
    let lap_box = (
        ox + ((plan.w - 260.0) * scale) as i32,
        oy + (TITLE_Y * scale) as i32,
        ox + (plan.w * scale) as i32,
        oy + ((TITLE_Y + 34.0) * scale) as i32,
    );
    let driving = render(&view(&f, Some(&live), Tab::Dash, 1.0, Lang::En), w, h);
    let lap = region_of(&driving, w, lap_box);
    assert!(has_color(&lap, PRIMARY) > 200, "driving: the lap number is there");
    assert!(has_color(&lap, DESTRUCTIVE) > 20, "driving: and the invalid mark");
    live.driving = false;
    let menu = render(&view(&f, Some(&live), Tab::Dash, 1.0, Lang::En), w, h);
    let lap = region_of(&menu, w, lap_box);
    assert_eq!(has_color(&lap, PRIMARY), 0, "in the menu: no lap number");
    assert_eq!(has_color(&lap, DESTRUCTIVE), 0, "in the menu: no invalid badge");
}

#[test]
fn a_lap_that_does_not_count_has_its_time_struck_through_in_red() {
    let f = fixture();
    let live = rich_reading();
    let laps = rich_laps();
    let mut with_invalid = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
    with_invalid.recent_laps = &laps;
    let all_valid: Vec<SavedLap> = laps.iter().cloned().map(|l| SavedLap { valid: true, ..l }).collect();
    let mut without = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
    without.recent_laps = &all_valid;
    let (w, h) = (1920, 1080);
    let a = render(&with_invalid, w, h);
    let b = render(&without, w, h);
    let laps_model_rows = model_with(&live, Default::default(), &laps).laps.rows.len();
    let region = pane_region(live.caps, w, h, Pane::Laps, laps_model_rows);
    let (ra, rb) = (region_of(&a, w, region), region_of(&b, w, region));
    assert!(reddish(&ra) > reddish(&rb) + 40, "the strike and the word invalid are red");
}

#[test]
fn every_preview_state_paints_at_every_shape() {
    let mut f = fixture();
    f.snapshot.game = Game::Recording(4);
    let rich = rich_reading();
    let mut paused = rich.clone();
    paused.driving = false;
    paused.phase = crate::game::Phase::Paused;
    let mut first = rich.clone();
    first.best_lap_s = None;
    first.delta_s = None;
    first.last_lap_s = None;
    let mut little = live_reading();
    little.caps = crate::game::Caps::LAP_TIME
        .or(crate::game::Caps::SPEED)
        .or(crate::game::Caps::GEAR)
        .or(crate::game::Caps::RPM)
        .or(crate::game::Caps::THROTTLE)
        .or(crate::game::Caps::BRAKE)
        .or(crate::game::Caps::LAST_LAP);
    let laps = rich_laps();
    let none: Vec<SavedLap> = Vec::new();
    let states: [(&str, &Live, &Vec<SavedLap>); 5] = [
        ("driving", &rich, &laps),
        ("paused", &paused, &laps),
        ("first-lap", &first, &none),
        ("silent", &rich, &laps),
        ("little-data", &little, &none),
    ];
    let shapes = [
        ("21x9", 2560, 1080),
        ("16x9", 1920, 1080),
        ("window", 1536, 864),
        ("16x10", 1680, 1050),
        ("4x3", 1024, 768),
        ("5x4", 1280, 1024),
        ("small", 960, 600),
        ("phone", 430, 900),
    ];
    for (state, live, laps) in states {
        for (shape, w, h) in shapes {
            let mut v = view(&f, Some(live), Tab::Dash, 1.0, Lang::En);
            v.recent_laps = laps;
            if state == "silent" {
                v.now_ms = live.at_ms + 60_000;
            }
            let pixels = render(&v, w, h);
            save(&pixels, w, h, &format!("state-{state}-{shape}.png"));
            assert!(has_color(&pixels, CARD) > 1000, "{state} {shape}: cards are drawn");
        }
    }
}

#[test]
fn the_update_card_is_always_there_with_check_now_try_again_and_a_bar_while_busy() {
    use crate::update::{CheckState, UpdateState};
    let mut f = fixture();
    let buttons_of = |f: &Fixture, w: i32, h: i32| {
        let v = view(f, None, Tab::Monitor, 1.0, Lang::Pt);
        let pixels = render(&v, w, h);
        let buttons: Vec<(Action, RECT)> = v.buttons.borrow().iter().map(|(a, r)| (*a, *r)).collect();
        (pixels, buttons)
    };
    // Up to date and failed: "Check now" / "Try again", inside the window and clear of the other buttons.
    for check in [CheckState::Idle, CheckState::UpToDate { at_ms: 0 }, CheckState::Failed] {
        f.check = check.clone();
        for (w, h) in [(1280, 800), (720, 480), (430, 900)] {
            let (pixels, buttons) = buttons_of(&f, w, h);
            if (w, h) == (1280, 800) && check == CheckState::Failed {
                save(&pixels, w, h, "panel-monitor-update-failed.png");
            }
            let check_button = buttons
                .iter()
                .find(|(a, _)| *a == Action::CheckUpdates)
                .unwrap_or_else(|| panic!("{check:?} {w}x{h}: the check button is drawn"))
                .1;
            assert!(check_button.left >= 0 && check_button.right <= w && check_button.bottom <= h);
            for (action, r) in &buttons {
                if *action != Action::CheckUpdates {
                    let apart = r.right <= check_button.left
                        || r.left >= check_button.right
                        || r.bottom <= check_button.top
                        || r.top >= check_button.bottom;
                    assert!(apart, "{check:?} {w}x{h}: {action:?} does not touch the check button");
                }
            }
        }
    }
    // Checking, or downloading: no button, and a yellow bar under the line.
    f.check = CheckState::Idle;
    let quiet_yellow = has_color(&buttons_of(&f, 1280, 800).0, PRIMARY);
    for (update, check, percent) in [
        (UpdateState::Nothing, CheckState::Checking, None),
        (UpdateState::Downloading { version: "0.6.0".into() }, CheckState::Idle, Some(60)),
    ] {
        f.update = update;
        f.check = check;
        f.percent = percent;
        let (pixels, buttons) = buttons_of(&f, 1280, 800);
        if percent.is_some() {
            save(&pixels, 1280, 800, "panel-monitor-update-downloading.png");
        }
        assert!(!buttons.iter().any(|(a, _)| matches!(a, Action::CheckUpdates | Action::UpdateNow)));
        assert!(has_color(&pixels, PRIMARY) > quiet_yellow, "the bar is drawn in yellow");
    }
}
