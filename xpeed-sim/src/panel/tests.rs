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
    live.fuel_per_lap_l = Some(2.9);
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
        dashboard: None,
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
    // The dashboard's name in the header: picked by hand, and picked from the session ("Auto").
    for (file, caption, manual, lang) in [
        (
            "preview-dashboard-race.png",
            "Header: the Race dashboard picked by hand",
            Some(DashboardId::Race),
            Lang::En,
        ),
        (
            "preview-dashboard-auto.png",
            "Header: the dashboard picked from the session (Auto), Portuguese",
            None,
            Lang::Pt,
        ),
    ] {
        let mut v = view(&f, Some(&live), Tab::Dash, 1.0, lang);
        v.dashboard = manual;
        let pixels = render(&v, 1920, 1080);
        save(&pixels, 1920, 1080, file);
        figures.push_str(&format!(
            "<figure><figcaption>{caption}</figcaption><img data-src=\"{file}\" width=\"1920\" height=\"1080\"></figure>
"
        ));
    }
    // The catalog's later widgets, on the dashboards that hold them: a reading that fills every one (a yellow flag, the
    // fuel and tyre figures per lap, the sectors), and the Race dashboard on a phone held upright.
    let full = full_reading();
    let full_laps = rich_laps();
    for (file, caption, dash, w, h) in [
        (
            "preview-race.png",
            "Race: the digiflag (a yellow flag), the relative, standings and gaps, the fuel strategy and the tyre wear (1920 × 1080)",
            DashboardId::Race,
            1920,
            1080,
        ),
        (
            "preview-qualifying.png",
            "Qualifying: the sectors with the theoretical best, the delta bar and the standings (1920 × 1080)",
            DashboardId::Qualifying,
            1920,
            1080,
        ),
        (
            "preview-time-trial.png",
            "Time trial: the delta bar on top, the sectors, the laps (1920 × 1080)",
            DashboardId::TimeTrial,
            1920,
            1080,
        ),
        (
            "preview-race-portrait.png",
            "Race in Portrait, one column with pairs (540 × 1080)",
            DashboardId::Race,
            540,
            1080,
        ),
    ] {
        let mut v = view(&f, Some(&full), Tab::Dash, 1.0, Lang::En);
        v.dashboard = Some(dash);
        v.recent_laps = &full_laps;
        if file == "preview-race-portrait.png" {
            v.layout.set(Some(Layout::Portrait));
        }
        let pixels = render(&v, w, h);
        save(&pixels, w, h, file);
        figures.push_str(&format!(
            "<figure><figcaption>{caption}</figcaption><img data-src=\"{file}\" width=\"{w}\" height=\"{h}\"></figure>\n"
        ));
    }
    use crate::game::{Caps, Spotter};
    // A game that gives no rivals (AC): the Race dashboard's middle row keeps only the session.
    let mut no_rivals = full.clone();
    no_rivals.caps = every_cap().minus(Caps::RIVALS.or(Caps::RIVALS_WORLD).or(Caps::SPOTTER));
    no_rivals.field = None;
    no_rivals.gap_trend = None;
    let mut v = view(&f, Some(&no_rivals), Tab::Dash, 1.0, Lang::En);
    v.dashboard = Some(DashboardId::Race);
    v.recent_laps = &full_laps;
    let pixels = render(&v, 1920, 1080);
    save(&pixels, 1920, 1080, "preview-race-no-rivals.png");
    figures.push_str("<figure><figcaption>Race, no rivals (AC): the middle row keeps only the session (1920 × 1080)</figcaption><img data-src=\"preview-race-no-rivals.png\" width=\"1920\" height=\"1080\"></figure>
");
    // A game that only gives the spotter's left and right signal (iRacing): the radar is the player's car with a bar on the side a
    // car is on, here the left; the rivals' cards are there, without positions.
    let mut spotter_only = full.clone();
    spotter_only.caps = every_cap().minus(Caps::RIVALS_WORLD);
    spotter_only.field = full.field.as_deref().map(|f| Arc::new(without_world(f)));
    spotter_only.spotter = Some(Spotter::Left);
    let mut v = view(&f, Some(&spotter_only), Tab::Dash, 1.0, Lang::En);
    v.dashboard = Some(DashboardId::Race);
    v.recent_laps = &full_laps;
    let pixels = render(&v, 1920, 1080);
    save(&pixels, 1920, 1080, "preview-race-radar-spotter.png");
    figures.push_str("<figure><figcaption>Radar, iRacing spotter only: a car on the left (Race, 1920 × 1080)</figcaption><img data-src=\"preview-race-radar-spotter.png\" width=\"1920\" height=\"1080\"></figure>\n");
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
        ("widgets_view.rs", include_str!("widgets_view.rs")),
        ("widgets.rs", include_str!("widgets.rs")),
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
        ("widgets_view.rs", include_str!("widgets_view.rs")),
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
    assert_eq!(
        live_row.sectors[0],
        Some(("27.811".to_owned(), Role::Good)),
        "faster than the best first sector"
    );
    assert_eq!(live_row.sectors[1], Some(("44.597".to_owned(), Role::Good)));
    assert_eq!(live_row.sectors[2], None);
    let best = &m.laps.rows[1];
    assert_eq!((best.gap.as_str(), best.time_role), ("Best", Role::Best));
    assert!(best.sectors.iter().all(|s| s.as_ref().is_some_and(|(_, role)| *role == Role::Best)));
    let done = &m.laps.rows[2];
    assert_eq!(done.gap, "+0.419");
    assert_eq!(done.sectors[0].as_ref().map(|s| s.1), Some(Role::Text));
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

#[test]
fn only_the_alerts_that_are_lit_are_there_with_their_words() {
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
    assert!(
        model(&live, Lang::En).alerts.is_empty(),
        "the game can give them, none is lit: nothing is drawn"
    );
    live.state.abs_active = Some(true);
    live.state.drs = Some(Drs::Available);
    live.state.headlights = Some(false);
    live.state.pit_limiter = Some(false);
    live.state.flag = Some(Flag::Yellow);
    let m = model(&live, Lang::En);
    let words: Vec<&str> = m.alerts.iter().map(|a| a.word.as_str()).collect();
    assert_eq!(words, ["ABS active", "DRS available", "Yellow flag"]);
    assert!(m.alerts.iter().all(|a| a.show == Show::Shown));
    live.state.drs = Some(Drs::Open);
    assert!(model(&live, Lang::En).alerts.iter().any(|a| a.word == "DRS open"));
    assert_eq!(model(&live, Lang::Pt).alerts[0].word, "ABS atuando");
    // Pit limiter, engine, fuel low and handbrake have their words too.
    live.caps = live.caps.or(Caps::ENGINE_WARNING).or(Caps::HANDBRAKE).or(Caps::FUEL);
    live.state.pit_limiter = Some(true);
    live.state.engine_warning = Some(true);
    live.state.handbrake = Some(true);
    live.fuel_per_lap_l = Some(2.9);
    live.fuel_l = 3.0;
    let words: Vec<String> = model(&live, Lang::En).alerts.into_iter().map(|a| a.word).collect();
    for want in ["Pit limiter", "Engine", "Fuel low", "Handbrake"] {
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
        assert!(p.records.1 - (p.bar.1 + p.bar.3) <= 2.0 * S8 + 0.01, "h {h}: delta to records");
        assert!(!overlap(p.lap, p.delta) && !overlap(p.bar, p.records) && !overlap(p.delta, p.records));
        assert_eq!(p.big, h - 2.0 * S3 >= TIMES_BIG_H, "tall cards get the big figures");
        let rule = p.rule.expect("the line over the records");
        assert!(rule.1 > p.bar.1 + p.bar.3 && rule.1 < p.records.1);
    }
    // The fuel card: the group and the temperatures, close together and centred.
    for h in [262.0, 300.0, 460.0] {
        let card = (0.0, 0.0, 400.0, h);
        let p = fuel_plan(card, 98.0, true);
        let t = p.temps.unwrap();
        let (x, y, w, ih) = inner(card);
        assert!(inside_box(p.group, x, y + CAPTION_H, w, ih - CAPTION_H) && inside_box(t, x, y, w, ih));
        assert!(
            t.1 - (p.group.1 + p.group.3) <= S8 + 0.01,
            "h {h}: the water and oil follow the fuel"
        );
        assert!(!overlap(p.group, t));
        assert_eq!(fuel_plan(card, 98.0, false).temps, None);
    }
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
                let first_seven = s.cards.iter().filter(|c| catalog::ALL[..7].iter().any(|w| w.pane == **c)).count();
                assert_eq!(plan.cards.len(), first_seven, "{layout:?}: every card of Practice has a place");
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
            let mut current = Some(pick_layout_sticky(DashboardId::Practice, pair[0] - 4.0, bh, &s, None));
            let mut plain = current;
            for step in 0..40 {
                let width = pair[1] + if step % 2 == 0 { 4.0 } else { -6.0 };
                let next = pick_layout_sticky(DashboardId::Practice, width, bh, &s, current);
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
    assert_eq!(
        pick_layout_sticky(DashboardId::Practice, 1920.0, 1080.0, &s, None),
        pick_layout(1920.0, 1080.0, &s)
    );
    // The smallest layout is left as soon as another one reads.
    assert_eq!(
        pick_layout_sticky(DashboardId::Practice, 1888.0, 998.0, &s, Some(Layout::Classic)),
        Layout::Wide
    );
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

#[test]
fn the_widget_ids_are_a_contract() {
    let ids: Vec<&str> = catalog::ALL.iter().map(|w| w.id).collect();
    assert_eq!(ids.len(), 17);
    assert_eq!(
        ids[..7],
        ["times", "centre", "fuel", "tyres", "laps", "track", "alerts"],
        "the first seven never change"
    );
    assert_eq!(
        ids[7..12],
        ["flag", "fuel_calc", "tyre_trend", "sectors", "delta_bar"],
        "the five of phase 2 keep their order"
    );
    assert_eq!(ids[12], "session");
    assert_eq!(ids[13..16], ["relative", "standings", "gaps"], "the rivals widgets of phase 4");
    assert_eq!(ids[16], "radar", "the radar follows them");
    for w in catalog::ALL {
        assert_eq!(catalog::by_id(w.id), Some(w.pane));
        assert_eq!(catalog::id_of(w.pane), w.id);
    }
    let unique: HashSet<&str> = ids.iter().copied().collect();
    assert_eq!(unique.len(), ids.len());
    assert_eq!(catalog::by_id("nope"), None);
}

#[test]
fn the_dashboard_ids_are_a_contract() {
    let ids: Vec<&str> = DashboardId::ALL.iter().map(|d| d.id()).collect();
    assert_eq!(ids, ["race", "qualifying", "practice", "time_trial"]);
    for d in DashboardId::ALL {
        assert_eq!(DashboardId::from_id(d.id()), Some(d));
        assert_eq!(builtin(d).id, d);
    }
    assert_eq!(DashboardId::from_id("nope"), None);
}

#[test]
fn a_dashboard_follows_the_session_unless_picked_by_hand() {
    use crate::lapfile::SessionKind as K;
    assert_eq!(pick(Some(K::Practice), None), DashboardId::Practice);
    assert_eq!(pick(Some(K::Qualifying), None), DashboardId::Qualifying);
    assert_eq!(pick(Some(K::Race), None), DashboardId::Race);
    assert_eq!(pick(Some(K::Unknown), None), DashboardId::Practice);
    assert_eq!(pick(None, None), DashboardId::Practice);
    assert_eq!(pick(Some(K::Race), Some(DashboardId::TimeTrial)), DashboardId::TimeTrial);
    assert_eq!(pick(None, Some(DashboardId::Race)), DashboardId::Race);
}

#[test]
fn d_cycles_through_the_dashboards_and_back_to_automatic() {
    let mut at = None;
    let mut seen = Vec::new();
    for _ in 0..5 {
        at = next_manual(at);
        seen.push(at.map(|d| d.id()));
    }
    assert_eq!(seen, [Some("race"), Some("qualifying"), Some("practice"), Some("time_trial"), None]);
}

#[test]
fn the_choice_is_kept_per_game_and_a_damaged_file_means_automatic() {
    let home = std::env::temp_dir().join(format!("xpeed-dashboards-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    assert_eq!(Choices::load(&home), Choices::default());
    let mut choices = Choices::default();
    choices.set("ac", Some(DashboardId::Race));
    choices.set("lmu", Some(DashboardId::TimeTrial));
    choices.save(&home).unwrap();
    let back = Choices::load(&home);
    assert_eq!(back.get("ac"), Some(DashboardId::Race));
    assert_eq!(back.get("lmu"), Some(DashboardId::TimeTrial));
    assert_eq!(back.get("acc"), None);
    let mut back = back;
    back.set("ac", None);
    assert_eq!(back.get("ac"), None);
    std::fs::write(home.join("dashboards.json"), "{ not json").unwrap();
    assert_eq!(Choices::load(&home), Choices::default());
    std::fs::write(home.join("dashboards.json"), r#"{"manual":{"ac":"bogus","lmu":"race"}}"#).unwrap();
    assert_eq!(Choices::load(&home).get("ac"), None);
    assert_eq!(Choices::load(&home).get("lmu"), Some(DashboardId::Race));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn the_dashboard_model_serialises_for_the_phone() {
    let f = fixture();
    let live = live_reading();
    let m = model_with(&live, Default::default(), &f.laps);
    let json = serde_json::to_value(&m).unwrap();
    for key in [
        "track",
        "car",
        "lap",
        "lapTime",
        "gear",
        "speed",
        "fuel",
        "fuelTitle",
        "alerts",
        "laps",
        "mapTitle",
    ] {
        assert!(json.get(key).is_some(), "{key} is in the model's JSON");
    }
    assert!(json["laps"]["rows"].is_array());
    assert_eq!(json["gear"]["show"], "shown", "enum values are camelCase too");
}

#[test]
fn the_header_names_the_dashboard_in_use() {
    let f = fixture();
    let live = live_reading();
    let mut v = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
    assert_eq!(v.dashboard_in_use(), pick(live.session_kind, None));
    v.dashboard = Some(DashboardId::TimeTrial);
    assert_eq!(v.dashboard_in_use(), DashboardId::TimeTrial);
    assert!(dashboard_hit(1536, 1.0).is_some(), "there is room for the name in a normal window");
}

// The catalog's later widgets: the flag, the fuel strategy, the tyre wear, the sectors and the delta bar.

/// The six layouts, for the tests that go through all of them.
const ALL_LAYOUTS: [Layout; 6] = [
    Layout::Classic,
    Layout::Ultrawide,
    Layout::Wide,
    Layout::Square,
    Layout::Portrait,
    Layout::Stack,
];

/// The least height a card of the later widgets needs, 0 for the first seven.
fn least_height(pane: Pane) -> f32 {
    match pane {
        Pane::Flag => FLAG_NEED_H,
        Pane::FuelCalc => FUEL_CALC_NEED_H,
        Pane::TyreTrend => TYRE_TREND_NEED_H,
        Pane::Sectors => SECTORS_NEED_H,
        Pane::DeltaBar => DELTA_NEED_H,
        Pane::Session => SESSION_NEED_H,
        Pane::Relative => RELATIVE_NEED_H,
        Pane::Standings => STANDINGS_NEED_H,
        Pane::Gaps => GAPS_NEED_H,
        Pane::Radar => RADAR_NEED_H,
        _ => 0.0,
    }
}

/// A reading that fills every widget: the sectors, the fuel and tyre figures per lap, a yellow flag, the demo's field of 14
/// cars (fifth, third in the class), the gaps' trends and 23 minutes left.
fn full_reading() -> Live {
    let mut live = rich_reading();
    // The demo's field: P5 of 14, third in the GT3 class, a car lapping the player and a lapped one; the cars that sit round the
    // player on the radar are placed round this reading's own car and heading (one alongside on the left, one 6 m behind on the
    // right, one 25 m ahead).
    let pose = (live.pos.unwrap(), live.heading.unwrap());
    let field = super::demo::demo_field_at(3, 1200.0, 0.0, pose);
    live.race_position = field.player().and_then(|p| p.position);
    live.class_position = field.player().and_then(|p| p.class_position);
    live.cars = u16::try_from(field.cars.len()).ok();
    live.field = Some(field);
    live.gap_trend = Some((Some(0.3), Some(-0.2)));
    live.session_time_left_s = Some(1_380.0);
    live.fuel_last_lap_l = Some(3.1);
    live.tyre_wear_per_lap = Some([0.018, 0.02, 0.026, 0.031]);
    live.last_sectors_ms = [Some(28_100), Some(44_900)];
    live
}

#[test]
fn the_fuel_table_adds_a_lap_of_margin_and_says_how_much_to_put_in() {
    let rows = fuel_plan_rows(Some(20.0), Some(2.0));
    let laps: Vec<u32> = rows.iter().map(|r| r.laps).collect();
    assert_eq!(laps, [5, 10, 15, 20]);
    let needed: Vec<Option<f32>> = rows.iter().map(|r| r.needed_l).collect();
    assert_eq!(needed, [Some(12.0), Some(22.0), Some(32.0), Some(42.0)], "(laps + 1) x 2 l");
    let to_add: Vec<Option<f32>> = rows.iter().map(|r| r.to_add_l).collect();
    assert_eq!(to_add, [Some(0.0), Some(2.0), Some(12.0), Some(22.0)], "never less than nothing");
    // Without a use per lap there are no figures at all.
    for per in [None, Some(0.0), Some(-1.0), Some(f32::NAN)] {
        let rows = fuel_plan_rows(Some(20.0), per);
        assert!(rows.iter().all(|r| r.needed_l.is_none() && r.to_add_l.is_none()), "{per:?}");
    }
    // Without a fuel reading the need is known and the amount to add is not.
    let blind = fuel_plan_rows(None, Some(2.0));
    assert!(blind.iter().all(|r| r.needed_l.is_some() && r.to_add_l.is_none()));
}

#[test]
fn the_fuel_strategy_card_writes_the_average_the_last_lap_the_laps_left_and_the_table() {
    let mut live = live_reading();
    live.fuel_l = 38.6;
    live.fuel_per_lap_l = Some(2.9);
    live.fuel_last_lap_l = Some(3.1);
    let card = model(&live, Lang::En).fuel_calc.expect("the game gives the fuel");
    assert_eq!(card.title, "Fuel strategy");
    let values: Vec<&str> = card.stats.iter().map(|c| c.value.as_str()).collect();
    assert_eq!(values, ["2.9 L", "3.1 L", "13.3"]);
    let laps: Vec<&str> = card.rows.iter().map(|r| r.laps.as_str()).collect();
    assert_eq!(laps, ["5", "10", "15", "20"]);
    assert_eq!((card.rows[0].needed.as_str(), card.rows[0].to_add.as_str()), ("17.4 L", "0.0 L"));
    assert_eq!((card.rows[3].needed.as_str(), card.rows[3].to_add.as_str()), ("60.9 L", "22.3 L"));
    assert_eq!((card.rows[0].role, card.rows[3].role), (Role::Good, Role::Warn));
    let note = card.note.as_deref().expect("without the session's laps or time the card says why");
    assert!(note.contains("session"), "{note}");
    assert!(card.to_end.is_none());
    // No use per lap known yet: a dash, never a made-up figure.
    live.fuel_per_lap_l = None;
    live.fuel_last_lap_l = None;
    let card = model(&live, Lang::En).fuel_calc.unwrap();
    assert!(card.stats.iter().all(|c| c.value == "–"));
    assert!(card
        .rows
        .iter()
        .all(|r| r.needed == "–" && r.to_add == "–" && r.role == Role::Muted));
    // In gallons the figures follow the units the person picked.
    live.fuel_per_lap_l = Some(3.785_412);
    let units = crate::config::Units {
        fuel: crate::config::FuelUnit::Gallon,
        ..Default::default()
    };
    let card = model_with(&live, units, &[]).fuel_calc.unwrap();
    assert_eq!(card.stats[0].value, "1.0 gal");
}

#[test]
fn the_laps_left_on_a_tyre_are_its_tread_over_its_wear_and_the_worst_tyre_is_found() {
    assert_eq!(tyre_laps_left(0.5, 0.0625), Some(8.0));
    assert_eq!(tyre_laps_left(0.0, 0.0625), Some(0.0));
    assert_eq!(tyre_laps_left(0.5, 0.0), None, "a tyre that does not wear has no laps left");
    assert_eq!(tyre_laps_left(f32::NAN, 0.0625), None);
    assert_eq!(tyre_laps_left(0.5, f32::NAN), None);
    assert_eq!(worst_tyre(&[Some(25.0), Some(9.5), None, Some(12.0)]), Some(1));
    assert_eq!(worst_tyre(&[None; 4]), None);
}

#[test]
fn the_tyre_wear_card_has_the_wear_per_lap_the_laps_left_and_marks_the_worst_tyre() {
    let mut live = live_reading();
    live.tyre_wear_per_lap = Some([0.02, 0.02, 0.025, 0.03]);
    let card = model(&live, Lang::En).tyre_trend.expect("the game gives the tread");
    assert_eq!(card.title, "Tyre wear");
    assert_eq!(card.rows.len(), 4);
    assert_eq!((card.rows[0].corner.as_str(), card.rows[3].corner.as_str()), ("FL", "RR"));
    assert_eq!((card.rows[0].wear.as_str(), card.rows[3].wear.as_str()), ("2.0%", "3.0%"));
    // The rear right has 0.84 of its tread left and wears 3 % a lap: 28 laps, the fewest.
    assert_eq!(card.rows[3].laps_left, "28");
    assert_eq!(card.rows[3].role, Role::Text);
    assert!(card.rows[3].worst && card.rows.iter().filter(|r| r.worst).count() == 1);
    assert_eq!(card.rows[3].tread, Some(0.84));
    assert!(card.note.is_none());
    // Wearing fast: the laps left press, then run out.
    live.tyre_wear_per_lap = Some([0.2; 4]);
    let card = model(&live, Lang::En).tyre_trend.unwrap();
    assert!(card.rows.iter().all(|r| r.role == Role::Danger));
    // A tyre with no wear figure has dashes; no figure at all says why.
    live.tyre_wear_per_lap = Some([0.02, f32::NAN, 0.02, 0.02]);
    let card = model(&live, Lang::En).tyre_trend.unwrap();
    assert_eq!((card.rows[1].wear.as_str(), card.rows[1].laps_left.as_str()), ("–", "–"));
    assert!(!card.rows[1].worst && card.note.is_none());
    live.tyre_wear_per_lap = None;
    let card = model(&live, Lang::En).tyre_trend.unwrap();
    assert!(card.rows.iter().all(|r| r.wear == "–" && r.laps_left == "–" && !r.worst));
    assert!(card.rows.iter().all(|r| r.tread.is_some()), "the tread left is still known");
    assert!(card.note.is_some());
}

#[test]
fn the_sectors_come_from_the_lap_being_driven_and_the_lap_before_and_the_best_of_the_run() {
    let saved = rich_laps();
    let last = [Some(28_000), Some(44_800), Some(51_300)];
    // The lap being driven has done S1 in 27.950: faster than the lap before (28.000), not the best (27.903).
    let reads = sector_reads(&saved, [Some(27_950), None, None], last);
    assert_eq!(
        (reads[0].ms, reads[0].from_last_lap, reads[0].tone),
        (Some(27_950), false, SectorTone::Faster)
    );
    // S2 and S3 are not reached: the lap before's times, quiet.
    assert_eq!(
        (reads[1].ms, reads[1].from_last_lap, reads[1].tone),
        (Some(44_800), true, SectorTone::Plain)
    );
    assert_eq!(
        (reads[2].ms, reads[2].from_last_lap, reads[2].tone),
        (Some(51_300), true, SectorTone::Plain)
    );
    // A new best is purple; slower than the lap before is yellow.
    let reads = sector_reads(&saved, [Some(27_800), None, None], last);
    assert_eq!((reads[0].tone, reads[0].best_ms), (SectorTone::Best, Some(27_800)));
    let reads = sector_reads(&saved, [Some(28_300), None, None], last);
    assert_eq!((reads[0].tone, reads[0].best_ms), (SectorTone::Slower, Some(27_903)));
    // The sectors of a lap that did not count are never a best.
    assert_eq!(best_sectors(&saved, [None; 3]), [Some(27_903), Some(44_721), Some(51_288)]);
    let invalid = [SavedLap {
        valid: false,
        sectors_ms: vec![1, 1, 1],
        ..saved_lap(1, 0)
    }];
    assert_eq!(best_sectors(&invalid, [None; 3]), [None; 3]);
    // The theoretical best adds the three best sectors; the third sector is the lap less the first two.
    assert_eq!(theoretical_best(&[Some(27_903), Some(44_721), Some(51_288)]), Some(123_912));
    assert_eq!(theoretical_best(&[Some(1), None, Some(3)]), None);
    assert_eq!(third_sector(Some(123_912), Some(27_903), Some(44_721)), Some(51_288));
    assert_eq!(third_sector(None, Some(1), Some(1)), None);
    assert_eq!(
        third_sector(Some(10), Some(8), Some(5)),
        None,
        "the sectors cannot be longer than the lap"
    );
    assert_eq!(
        third_sector(Some(10), Some(5), Some(5)),
        None,
        "a third sector of nothing is not a time"
    );
}

#[test]
fn the_sectors_card_writes_the_rows_the_theoretical_best_and_the_gap_to_the_best_lap() {
    let mut live = rich_reading();
    live.last_sectors_ms = [Some(28_100), Some(44_900)];
    let card = model_with(&live, Default::default(), &rich_laps())
        .sectors
        .expect("the game gives sectors");
    assert_eq!(card.title, "Sectors");
    let times: Vec<&str> = card.rows.iter().map(|r| r.time.as_str()).collect();
    // S3 is the last lap (124.331) less its S1 and S2.
    assert_eq!(times, ["27.811", "44.597", "51.331"]);
    assert_eq!(card.rows.iter().map(|r| r.from_last_lap).collect::<Vec<_>>(), [false, false, true]);
    assert_eq!(
        card.rows.iter().map(|r| r.tone).collect::<Vec<_>>(),
        [SectorTone::Best, SectorTone::Best, SectorTone::Plain]
    );
    assert_eq!(card.rows[2].best, "51.288");
    // 27.811 + 44.597 + 51.288, and the best lap (123.912) is 0.216 slower than that.
    assert_eq!(card.theoretical, clock(123_696));
    assert_eq!(card.gap.as_deref(), Some("-0.216"));
    // Before any sector: the laps saved still give the best of each, nothing for the lap being driven.
    live.sectors_ms = [None, None];
    live.last_sectors_ms = [None, None];
    live.last_lap_s = None;
    let card = model_with(&live, Default::default(), &rich_laps()).sectors.unwrap();
    assert!(card.rows.iter().all(|r| r.time == "–" && r.tone == SectorTone::Plain));
    assert_eq!(card.rows[0].best, "27.903");
    assert_eq!(card.theoretical, clock(123_912));
}

#[test]
fn the_delta_bar_is_centred_on_zero_runs_two_seconds_either_side_and_never_leaves_the_bar() {
    assert_eq!(DELTA_BAR_RANGE_S, 2.0);
    assert_eq!(delta_bar_frac(None), 0.5);
    assert_eq!(delta_bar_frac(Some(0.0)), 0.5);
    assert_eq!(delta_bar_frac(Some(-1.0)), 0.25, "faster: the fill goes left of the middle");
    assert_eq!(delta_bar_frac(Some(1.0)), 0.75, "slower: to the right");
    assert_eq!((delta_bar_frac(Some(-2.0)), delta_bar_frac(Some(2.0))), (0.0, 1.0));
    assert_eq!(
        (delta_bar_frac(Some(-9.0)), delta_bar_frac(Some(9.0))),
        (0.0, 1.0),
        "past the scale the bar is full"
    );
    assert_eq!(delta_bar_frac(Some(f64::NAN)), 0.5);
    let mut live = live_reading();
    let card = model(&live, Lang::En).delta_bar.expect("the game gives the delta's inputs");
    assert_eq!(
        (card.value.as_str(), card.role, card.caption.as_str()),
        ("-0.270", Role::Good, "vs best lap")
    );
    assert!((card.frac - (0.5 - 0.27 / 4.0)).abs() < 1e-4, "{}", card.frac);
    live.delta_s = Some(0.5);
    let card = model(&live, Lang::En).delta_bar.unwrap();
    assert_eq!((card.value.as_str(), card.role), ("+0.500", Role::Danger));
    assert!(card.frac > 0.5);
    live.delta_s = None;
    let card = model(&live, Lang::En).delta_bar.unwrap();
    assert_eq!((card.value.as_str(), card.frac, card.show), ("–", 0.5, Show::Dimmed));
}

#[test]
fn the_flag_card_names_the_flag_or_says_there_is_none() {
    use crate::game::Flag;
    let mut live = live_reading();
    let card = model(&live, Lang::En).flag.expect("the game gives flags");
    assert_eq!(
        (card.kind, card.word.as_str(), card.show),
        (Some(FlagKind::Yellow), "YELLOW FLAG", Show::Shown)
    );
    assert_eq!(model(&live, Lang::Pt).flag.unwrap().word, "BANDEIRA AMARELA");
    for (flag, kind) in [
        (Flag::Green, FlagKind::Green),
        (Flag::Yellow, FlagKind::Yellow),
        (Flag::Blue, FlagKind::Blue),
        (Flag::White, FlagKind::White),
        (Flag::Black, FlagKind::Black),
        (Flag::Chequered, FlagKind::Chequered),
    ] {
        live.state.flag = Some(flag);
        assert_eq!(model(&live, Lang::En).flag.unwrap().kind, Some(kind));
    }
    live.state.flag = None;
    let card = model(&live, Lang::En).flag.unwrap();
    assert_eq!((card.kind, card.word.as_str(), card.show), (None, "NO FLAG", Show::Dimmed));
}

#[test]
fn a_card_the_game_cannot_fill_is_not_there() {
    use crate::game::Caps;
    let cards = |caps: Caps| slots(caps).cards;
    assert_eq!(cards(Caps::FLAG), [Pane::Alerts, Pane::Flag]);
    assert_eq!(cards(Caps::FUEL), [Pane::Fuel, Pane::Alerts, Pane::FuelCalc]);
    assert_eq!(cards(Caps::TYRE_WEAR), [Pane::Tyres, Pane::TyreTrend]);
    assert_eq!(cards(Caps::SECTORS), [Pane::Sectors]);
    assert_eq!(cards(Caps::LAP_TIME), [Pane::Times, Pane::Laps], "no delta without the distance");
    assert_eq!(cards(Caps::LAP_TIME.or(Caps::DIST)), [Pane::Times, Pane::Laps, Pane::DeltaBar]);
    assert!(cards(Caps::NONE).is_empty());
    assert_eq!(cards(Caps::RIVALS), [Pane::Relative, Pane::Standings, Pane::Gaps]);
    assert_eq!(
        cards(Caps::RIVALS_WORLD),
        [Pane::Radar],
        "the cars' positions alone are only the radar"
    );
    assert_eq!(cards(Caps::SPOTTER), [Pane::Radar], "so is the game's own spotter");
    assert_eq!(cards(Caps::RIVALS_WORLD.or(Caps::SPOTTER)), [Pane::Radar]);
    assert_eq!(
        cards(Caps::RIVALS.or(Caps::RIVALS_WORLD)),
        [Pane::Relative, Pane::Standings, Pane::Gaps, Pane::Radar]
    );
    // The model has a part for a card exactly when the card is there.
    let mut live = live_reading();
    live.caps = Caps::GEAR.or(Caps::LAP_TIME);
    let m = model(&live, Lang::En);
    assert!(m.flag.is_none() && m.fuel_calc.is_none() && m.tyre_trend.is_none() && m.sectors.is_none() && m.delta_bar.is_none());
    assert!(m.session_card.is_none());
    assert!(m.relative.is_none() && m.standings.is_none() && m.gaps.is_none() && m.radar.is_none());
    live.caps = every_cap();
    let m = model(&live, Lang::En);
    assert!(m.flag.is_some() && m.fuel_calc.is_some() && m.tyre_trend.is_some() && m.sectors.is_some() && m.delta_bar.is_some());
    assert!(m.session_card.is_some());
    assert!(m.relative.is_some() && m.standings.is_some() && m.gaps.is_some() && m.radar.is_some());
    live.caps = every_cap().minus(Caps::RIVALS);
    let m = model(&live, Lang::En);
    assert!(
        m.relative.is_none() && m.standings.is_none() && m.gaps.is_none(),
        "no rivals, no rivals cards"
    );
    assert!(
        m.radar.is_some(),
        "the radar needs the positions or the spotter, not the rivals' places"
    );
    live.caps = every_cap().minus(Caps::RIVALS_WORLD.or(Caps::SPOTTER));
    assert!(
        model(&live, Lang::En).radar.is_none(),
        "neither the positions nor the spotter: no radar"
    );
    assert!(m.session_card.is_some());
}

#[test]
fn practice_keeps_its_rows_and_every_dashboard_holds_only_catalog_widgets() {
    let wide = builtin(DashboardId::Practice).rows_for(Layout::Wide);
    assert_eq!(wide.len(), 2);
    assert_eq!(
        wide[0].cards,
        [(Pane::Times, 1.0), (Pane::Centre, 1.3), (Pane::Fuel, 0.95), (Pane::Tyres, 1.05)]
    );
    assert_eq!(wide[1].cards, [(Pane::Laps, 2.25), (Pane::Track, 1.0), (Pane::Alerts, 1.05)]);
    let later_nine = [
        Pane::Flag,
        Pane::FuelCalc,
        Pane::TyreTrend,
        Pane::Sectors,
        Pane::DeltaBar,
        Pane::Session,
        Pane::Relative,
        Pane::Standings,
        Pane::Gaps,
    ];
    for layout in ALL_LAYOUTS {
        assert!(
            std::ptr::eq(builtin(DashboardId::Practice).rows_for(layout), layout.default_rows()),
            "{layout:?}: Practice has the rows it always had"
        );
        let mut used: Vec<Pane> = Vec::new();
        for dash in DashboardId::ALL {
            let rows = builtin(dash).rows_for(layout);
            assert!(!rows.is_empty(), "{dash:?} {layout:?} has rows");
            let mut seen: Vec<Pane> = Vec::new();
            for row in rows {
                assert!(row.h > 0.0 && !row.cards.is_empty(), "{dash:?} {layout:?}");
                for (pane, share) in row.cards {
                    assert!(
                        catalog::ALL.iter().any(|w| w.pane == *pane),
                        "{dash:?} {layout:?}: {pane:?} is not in the catalog"
                    );
                    assert!(*share > 0.0);
                    assert!(!seen.contains(pane), "{dash:?} {layout:?}: {pane:?} twice");
                    seen.push(*pane);
                }
            }
            used.extend(seen);
        }
        for pane in later_nine {
            // Classic, the smallest window, leaves the tyre wear and the rivals out; a phone held upright, the tyre wear.
            let left_out = match layout {
                Layout::Classic => matches!(pane, Pane::TyreTrend | Pane::Relative | Pane::Standings | Pane::Gaps),
                Layout::Portrait => pane == Pane::TyreTrend,
                _ => false,
            };
            if left_out {
                continue;
            }
            assert!(used.contains(&pane), "{layout:?}: {pane:?} is on some dashboard");
        }
    }
    // The Wide rows of the three dashboards, by widget id.
    let ids = |dash: DashboardId, row: usize| -> Vec<&'static str> {
        builtin(dash).rows_for(Layout::Wide)[row]
            .cards
            .iter()
            .map(|(p, _)| catalog::id_of(*p))
            .collect()
    };
    assert_eq!(ids(DashboardId::Race, 0), ["times", "centre", "flag", "tyres"]);
    assert_eq!(ids(DashboardId::Race, 1), ["relative", "standings", "gaps", "radar", "session"]);
    assert_eq!(ids(DashboardId::Race, 2), ["fuel_calc", "tyre_trend", "track", "alerts"]);
    assert_eq!(ids(DashboardId::Qualifying, 0), ["times", "centre", "sectors", "tyres"]);
    assert_eq!(ids(DashboardId::Qualifying, 1), ["delta_bar", "standings", "session", "flag"]);
    assert_eq!(ids(DashboardId::TimeTrial, 0), ["delta_bar"]);
    assert_eq!(ids(DashboardId::TimeTrial, 1), ["times", "centre", "sectors", "tyres"]);
    assert_eq!(ids(DashboardId::TimeTrial, 2), ["laps", "track"]);
}

#[test]
fn every_dashboard_puts_its_cards_in_the_canvas_without_overlap_and_tall_enough_in_every_layout() {
    for caps in [every_cap(), evo_like_caps()] {
        let s = slots(caps);
        for layout in ALL_LAYOUTS {
            for dash in DashboardId::ALL {
                let plan = layout.plan_in(dash, &s, usize::MAX);
                let wanted = builtin(dash)
                    .rows_for(layout)
                    .iter()
                    .flat_map(|row| row.cards.iter())
                    .filter(|(pane, _)| s.cards.contains(pane))
                    .count();
                assert_eq!(
                    plan.cards.len(),
                    wanted,
                    "{dash:?} {layout:?}: every card the game can fill has a place"
                );
                for (i, (card, area)) in plan.cards.iter().enumerate() {
                    assert!(
                        inside_box(*area, 0.0, 0.0, plan.w, plan.h),
                        "{dash:?} {layout:?} {card:?} inside the canvas"
                    );
                    assert!(
                        area.3 + 0.01 >= least_height(*card),
                        "{dash:?} {layout:?}: {card:?} is {} tall",
                        area.3
                    );
                    for (other, b) in &plan.cards[i + 1..] {
                        assert!(!overlap(*area, *b), "{dash:?} {layout:?}: {card:?} over {other:?}");
                    }
                }
            }
        }
    }
    // A dashboard none of whose widgets the game can fill is only the header.
    for dash in DashboardId::ALL {
        let s = slots(crate::game::Caps::NONE);
        assert_eq!(Layout::Wide.plan_in(dash, &s, 3).h, CARDS_TOP);
    }
    // A row whose widgets are all missing is dropped and the next row moves up.
    let s = slots(crate::game::Caps::SECTORS.or(crate::game::Caps::TYRE_WEAR));
    let plan = Layout::Wide.plan_in(DashboardId::Qualifying, &s, 3);
    let (sectors, tyres) = (plan.area(Pane::Sectors).unwrap(), plan.area(Pane::Tyres).unwrap());
    assert_eq!(plan.cards.len(), 2);
    assert_eq!(sectors.1, CARDS_TOP, "the second row has nothing the game can fill and is gone");
    assert_eq!(tyres.1, CARDS_TOP);
}

#[test]
fn the_layout_is_picked_from_the_dashboard_in_use() {
    let s = slots(every_cap());
    // A phone held upright: the Time trial dashboard is taller than Practice, so it has its own canvas.
    let (practice, trial) = (
        Layout::Stack.size_in(DashboardId::Practice, &s),
        Layout::Stack.size_in(DashboardId::TimeTrial, &s),
    );
    assert_ne!(practice, trial);
    for dash in DashboardId::ALL {
        let layout = pick_layout_in(dash, 1888.0, 998.0, &s);
        assert_eq!(layout, pick_layout_sticky(dash, 1888.0, 998.0, &s, None));
        assert_eq!(pick_layout_sticky(dash, 1888.0, 998.0, &s, Some(Layout::Classic)), layout);
    }
}

#[test]
fn the_new_widgets_serialise_for_the_phone_in_camel_case() {
    let live = full_reading();
    let json = serde_json::to_value(model_with(&live, Default::default(), &rich_laps())).unwrap();
    for key in [
        "flag",
        "fuelCalc",
        "tyreTrend",
        "sectors",
        "deltaBar",
        "sessionCard",
        "relative",
        "standings",
        "gaps",
        "radar",
    ] {
        assert!(json[key].is_object(), "{key} is in the model's JSON");
    }
    assert_eq!(json["flag"]["kind"], "yellow");
    assert_eq!(json["flag"]["show"], "shown");
    assert_eq!(json["fuelCalc"]["stats"][0]["label"], "Avg / lap");
    assert!(json["fuelCalc"]["rows"][0]["toAdd"].is_string());
    assert!(json["tyreTrend"]["rows"][3]["lapsLeft"].is_string());
    assert_eq!(json["tyreTrend"]["rows"][3]["worst"], true);
    assert_eq!(json["sectors"]["rows"][0]["tone"], "best");
    assert_eq!(json["sectors"]["rows"][2]["fromLastLap"], true);
    assert_eq!(json["deltaBar"]["role"], "good");
    assert_eq!(json["sessionCard"]["position"], "P5");
    assert_eq!(json["sessionCard"]["ofCars"], "/ 14");
    assert_eq!(json["sessionCard"]["classLine"], "P3 in class");
    assert_eq!(json["sessionCard"]["remainingNote"], "left");
    assert_eq!(json["fuelCalc"]["toEnd"]["addLabel"], "add");
    assert!(
        json["fuelCalc"]["note"].is_null(),
        "the line about the end is there, so the note is not"
    );
    // The rivals: the cars round the player, the player's class and the two sides.
    assert_eq!(json["relative"]["rows"].as_array().map(Vec::len), Some(7));
    assert_eq!(json["relative"]["rows"][3]["isPlayer"], true);
    assert_eq!(json["relative"]["rows"][1]["relation"], "lapping");
    assert_eq!(json["relative"]["rows"][1]["role"], "info");
    assert_eq!(json["relative"]["rows"][6]["relation"], "lapped");
    assert!(json["relative"]["rows"][3]["gap"].is_null());
    assert_eq!(json["standings"]["className"], "GT3");
    assert_eq!(json["standings"]["rows"][0]["gap"], "Leader");
    assert!(json["standings"]["rows"][2]["skippedBefore"].is_boolean());
    assert_eq!(json["gaps"]["ahead"]["label"], "Ahead");
    assert_eq!(json["gaps"]["ahead"]["car"]["trend"]["dir"], "closing");
    assert_eq!(json["gaps"]["behind"]["car"]["trend"]["dir"], "opening");
    assert_eq!(json["gaps"]["behind"]["car"]["trend"]["role"], "good");
    assert!(json["gaps"]["note"].is_null());
}

/// The dashboard `dash` painted on a 1920 × 1080 screen for `live` and the recent laps `laps`.
fn dashboard_pixels(dash: DashboardId, live: &Live, laps: &[SavedLap]) -> Vec<u8> {
    let f = fixture();
    let mut v = view(&f, Some(live), Tab::Dash, 1.0, Lang::En);
    v.dashboard = Some(dash);
    v.recent_laps = laps;
    render(&v, 1920, 1080)
}

#[test]
fn the_flag_card_is_a_block_of_the_flags_colour_and_the_chequered_flag_is_a_checker_pattern() {
    use crate::game::Flag;
    let laps = rich_laps();
    let mut live = full_reading();
    live.state.flag = Some(Flag::Green);
    let green = dashboard_pixels(DashboardId::Race, &live, &laps);
    live.state.flag = Some(Flag::Blue);
    let blue = dashboard_pixels(DashboardId::Race, &live, &laps);
    save(&blue, 1920, 1080, "panel-flag-blue.png");
    assert!(
        has_color(&blue, INFO) > has_color(&green, INFO) + 20_000,
        "a blue flag fills its card with blue: {} against {}",
        has_color(&blue, INFO),
        has_color(&green, INFO)
    );
    live.state.flag = Some(Flag::Chequered);
    let chequered = dashboard_pixels(DashboardId::Race, &live, &laps);
    save(&chequered, 1920, 1080, "panel-flag-chequered.png");
    assert!(
        has_color(&chequered, FLAG_BLACK) > 10_000,
        "black squares: {}",
        has_color(&chequered, FLAG_BLACK)
    );
    assert!(
        has_color(&chequered, FLAG_WHITE) > 10_000,
        "white squares: {}",
        has_color(&chequered, FLAG_WHITE)
    );
    assert!(has_color(&green, FLAG_BLACK) < 2_000, "no checkers on a green flag");
    // No flag: the card keeps the card surface, there is no block.
    live.state.flag = None;
    let none = dashboard_pixels(DashboardId::Race, &live, &laps);
    assert!(has_color(&none, INFO) < has_color(&blue, INFO) - 20_000);
}

#[test]
fn the_delta_bar_fills_toward_the_side_of_the_delta() {
    let laps = rich_laps();
    let mut live = full_reading();
    live.delta_s = Some(-1.5);
    let faster = dashboard_pixels(DashboardId::TimeTrial, &live, &laps);
    save(&faster, 1920, 1080, "panel-time-trial.png");
    live.delta_s = Some(1.5);
    let slower = dashboard_pixels(DashboardId::TimeTrial, &live, &laps);
    assert!(
        has_color(&faster, SUCCESS) > has_color(&slower, SUCCESS) + 5_000,
        "a delta of -1.5 s lights green blocks: {} against {}",
        has_color(&faster, SUCCESS),
        has_color(&slower, SUCCESS)
    );
    assert!(
        has_color(&slower, DESTRUCTIVE) > has_color(&faster, DESTRUCTIVE) + 5_000,
        "a delta of +1.5 s lights red blocks"
    );
}

#[test]
fn every_dashboard_paints_at_every_shape() {
    let laps = rich_laps();
    let live = full_reading();
    let f = fixture();
    for dash in DashboardId::ALL {
        for (w, h) in [
            (2560, 1080),
            (1920, 1080),
            (1536, 864),
            (1024, 768),
            (1280, 1024),
            (960, 600),
            (540, 1080),
            (430, 900),
        ] {
            let mut v = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
            v.dashboard = Some(dash);
            v.recent_laps = &laps;
            let pixels = render(&v, w, h);
            assert!(has_color(&pixels, CARD) > 1000, "{dash:?} {w}x{h}: cards are drawn");
        }
    }
}

// The session card and the fuel to the end of the session.

#[test]
fn the_laps_to_go_follow_the_session_laps_or_the_time_left() {
    let mut live = live_reading();
    live.session_laps = None;
    live.session_time_left_s = None;
    assert_eq!(laps_to_go(&live), None, "the game gives neither");
    // Lap-based: lap 4 of 20 with 2310 of 5793 m driven leaves 20 - 3 laps less the share of this one.
    live.session_laps = Some(20);
    let share = (2310.0_f64 / 5793.0) as f32;
    assert!((laps_to_go(&live).unwrap() - (17.0 - share)).abs() < 0.001);
    live.track_length_m = None;
    assert_eq!(laps_to_go(&live), Some(17.0), "without the track's length this lap counts whole");
    live.lap = 0;
    assert_eq!(laps_to_go(&live), None, "before the first lap is known");
    live.lap = 25;
    assert_eq!(laps_to_go(&live), Some(0.0), "never below nothing");
    // Timed: the laps that fit in the time left at the last lap's pace, and the one finished after the time runs out.
    live.lap = 4;
    live.session_laps = None;
    live.session_time_left_s = Some(539.0);
    live.last_lap_s = Some(107.918);
    live.best_lap_s = Some(107.204);
    assert_eq!(laps_to_go(&live), Some(6.0), "ceil(539 / 107.918) + 1");
    live.last_lap_s = None;
    assert_eq!(
        laps_to_go(&live),
        Some(7.0),
        "the best lap's pace when there is no last lap: ceil(539 / 107.204) + 1"
    );
    live.best_lap_s = None;
    assert_eq!(laps_to_go(&live), None, "a timed session without a lap time to go by");
    live.last_lap_s = Some(f64::NAN);
    live.best_lap_s = Some(0.0);
    assert_eq!(laps_to_go(&live), None, "no figure from a lap time that means nothing");
    // With both the session ends at the first: the smaller.
    live.last_lap_s = Some(100.0);
    live.session_time_left_s = Some(900.0);
    live.session_laps = Some(6);
    live.lap = 5;
    live.dist_m = Some(0.0);
    assert_eq!(laps_to_go(&live), Some(2.0), "6 - 4 laps against ceil(9) + 1 = 10");
    live.session_time_left_s = Some(0.0);
    assert_eq!(laps_to_go(&live), Some(1.0), "the time is up: the lap that finishes it");
}

#[test]
fn the_fuel_to_the_end_is_the_laps_to_go_and_a_lap_of_margin_less_the_tank() {
    let end = fuel_to_end(Some(10.0), Some(20.0), Some(2.0)).unwrap();
    assert_eq!((end.needed_l, end.to_add_l), (22.0, Some(2.0)), "(10 + 1) x 2 l, 20 l in the tank");
    assert_eq!(fuel_to_end(Some(10.0), Some(30.0), Some(2.0)).unwrap().to_add_l, Some(0.0));
    assert_eq!(
        fuel_to_end(Some(10.0), None, Some(2.0)).unwrap().to_add_l,
        None,
        "no fuel reading, no amount to add"
    );
    assert_eq!(
        fuel_to_end(Some(0.0), Some(1.0), Some(2.0)).unwrap().needed_l,
        2.0,
        "the margin lap alone"
    );
    for per in [None, Some(0.0), Some(-1.0), Some(f32::NAN)] {
        assert_eq!(fuel_to_end(Some(10.0), Some(20.0), per), None, "{per:?}");
    }
    for laps in [None, Some(f32::NAN), Some(-1.0)] {
        assert_eq!(fuel_to_end(laps, Some(20.0), Some(2.0)), None, "{laps:?}");
    }
}

#[test]
fn the_fuel_card_says_the_fuel_to_the_end_when_it_can_and_keeps_the_caption_when_it_cannot() {
    let mut live = live_reading();
    live.fuel_l = 38.6;
    live.fuel_per_lap_l = Some(2.9);
    live.session_laps = Some(20);
    let card = model(&live, Lang::En).fuel_calc.unwrap();
    let end = card.to_end.expect("the laps and the use per lap are known");
    assert_eq!((end.label.as_str(), end.add_label.as_str()), ("To the end", "add"));
    // 20 - 3 laps less 40 % of this one, and a lap of margin, at 2.9 l: 51.0 l, of which 12.4 l are to add.
    assert_eq!(
        (end.needed.as_str(), end.to_add.as_deref(), end.role),
        ("51.0 L", Some("12.4 L"), Role::Warn)
    );
    assert!(card.note.is_none(), "the line replaces the caption");
    // Enough in the tank: green, nothing to add.
    live.session_laps = Some(5);
    let end = model(&live, Lang::En).fuel_calc.unwrap().to_end.unwrap();
    assert_eq!((end.to_add.as_deref(), end.role), (Some("0.0 L"), Role::Good));
    // A timed session works the same way.
    live.session_laps = None;
    live.session_time_left_s = Some(539.0);
    assert!(model(&live, Lang::En).fuel_calc.unwrap().to_end.is_some());
    // Portuguese words.
    let end = model(&live, Lang::Pt).fuel_calc.unwrap().to_end.unwrap();
    assert_eq!((end.label.as_str(), end.add_label.as_str()), ("Até o fim", "abastecer"));
    // Neither the session's laps nor its time: the caption.
    live.session_time_left_s = None;
    let card = model(&live, Lang::En).fuel_calc.unwrap();
    assert!(card.to_end.is_none() && card.note.is_some());
    // The laps but no use per lap yet: the caption too.
    live.session_laps = Some(20);
    live.fuel_per_lap_l = None;
    let card = model(&live, Lang::En).fuel_calc.unwrap();
    assert!(card.to_end.is_none() && card.note.is_some());
}

#[test]
fn the_time_left_is_written_as_minutes_and_seconds_and_hours_from_an_hour() {
    assert_eq!(session_clock(0.0), "00:00");
    assert_eq!(session_clock(59.9), "00:59", "whole seconds, never rounded up");
    assert_eq!(session_clock(1_380.0), "23:00");
    assert_eq!(session_clock(3_599.0), "59:59");
    assert_eq!(session_clock(3_600.0), "1:00:00");
    assert_eq!(session_clock(3_725.0), "1:02:05");
    assert_eq!(session_clock(-5.0), "00:00");
    assert_eq!(laps_after_this(20, 5), Some(15));
    assert_eq!(laps_after_this(20, 20), Some(0));
    assert_eq!(laps_after_this(20, 25), Some(0));
    assert_eq!(laps_after_this(20, 0), None);
    assert_eq!(laps_after_this(20, -1), None);
}

#[test]
fn the_session_card_writes_the_place_the_class_and_what_is_left() {
    let mut live = live_reading();
    live.race_position = Some(3);
    live.class_position = Some(1);
    live.cars = Some(24);
    live.session_time_left_s = Some(1_380.0);
    let card = model(&live, Lang::En).session_card.expect("the game gives the place");
    assert_eq!(card.title, "Session");
    assert_eq!((card.position.as_deref(), card.of_cars.as_deref()), (Some("P3"), Some("/ 24")));
    assert_eq!(card.class_line.as_deref(), Some("P1 in class"));
    assert_eq!(
        (card.remaining.as_deref(), card.remaining_note.as_deref()),
        (Some("23:00"), Some("left"))
    );
    assert_eq!(card.show, Show::Shown);
    // Over an hour.
    live.session_time_left_s = Some(3_725.0);
    assert_eq!(model(&live, Lang::En).session_card.unwrap().remaining.as_deref(), Some("1:02:05"));
    // A lap-based session: the lap and the laps still to go (lap 5 of 20 leaves 15).
    live.session_time_left_s = None;
    live.session_laps = Some(20);
    live.lap = 5;
    let card = model(&live, Lang::En).session_card.unwrap();
    assert_eq!(
        (card.remaining.as_deref(), card.remaining_note.as_deref()),
        (Some("Lap 5 / 20"), Some("15 to go"))
    );
    // The lap never runs past the session's laps.
    live.lap = 22;
    let card = model(&live, Lang::En).session_card.unwrap();
    assert_eq!(
        (card.remaining.as_deref(), card.remaining_note.as_deref()),
        (Some("Lap 20 / 20"), Some("0 to go"))
    );
    // The time wins when the game gives both.
    live.session_time_left_s = Some(61.0);
    assert_eq!(model(&live, Lang::En).session_card.unwrap().remaining.as_deref(), Some("01:01"));
    // Portuguese.
    let card = model(&live, Lang::Pt).session_card.unwrap();
    assert_eq!((card.title.as_str(), card.class_line.as_deref()), ("Sessão", Some("P1 na classe")));
    // What the game does not give is simply not there.
    live.race_position = None;
    live.class_position = None;
    live.session_time_left_s = None;
    live.session_laps = None;
    let card = model(&live, Lang::En).session_card.unwrap();
    assert!(card.position.is_none() && card.of_cars.is_none() && card.class_line.is_none());
    assert!(card.remaining.is_none() && card.remaining_note.is_none());
    // The cars without the place say nothing; a place of 0 is no place.
    live.cars = Some(24);
    live.race_position = Some(0);
    let card = model(&live, Lang::En).session_card.unwrap();
    assert!(card.position.is_none() && card.of_cars.is_none());
    // A reading that is no longer live is dimmed.
    live.race_position = Some(2);
    let late = dashboard(&live, &ctx_of(Lang::En, live.at_ms + STALE_MS + 1));
    assert_eq!(late.session_card.unwrap().show, Show::Dimmed);
}

#[test]
fn the_session_card_is_there_when_the_game_gives_the_place_the_time_or_the_laps() {
    use crate::game::Caps;
    let cards = |caps: Caps| slots(caps).cards;
    assert_eq!(cards(Caps::RACE_POSITION), [Pane::Session]);
    assert_eq!(cards(Caps::SESSION_TIME_LEFT), [Pane::Session]);
    assert_eq!(cards(Caps::SESSION_LAPS), [Pane::Session]);
    assert!(
        cards(Caps::CLASS_POSITION).is_empty(),
        "the class place alone is not a session card"
    );
    assert!(cards(Caps::CARS).is_empty(), "nor is the number of cars");
    assert!(!cards(Caps::GEAR.or(Caps::LAP_TIME)).contains(&Pane::Session));
}

#[test]
fn race_and_qualifying_hold_the_session_in_every_layout_and_the_tyres_never_get_narrower_for_it() {
    use crate::game::Caps;
    let with = slots(every_cap());
    let without = slots(every_cap().minus(Caps::RACE_POSITION.or(Caps::SESSION_TIME_LEFT).or(Caps::SESSION_LAPS)));
    assert!(!without.cards.contains(&Pane::Session));
    for layout in ALL_LAYOUTS {
        for dash in [DashboardId::Race, DashboardId::Qualifying] {
            let (a, b) = (layout.plan_in(dash, &with, usize::MAX), layout.plan_in(dash, &without, usize::MAX));
            let session = a
                .area(Pane::Session)
                .unwrap_or_else(|| panic!("{dash:?} {layout:?}: the session is on the dashboard"));
            assert!(
                session.3 + 0.01 >= SESSION_NEED_H,
                "{dash:?} {layout:?}: the session is {} tall",
                session.3
            );
            assert!(b.area(Pane::Session).is_none());
            let (tyres_with, tyres_without) = (a.area(Pane::Tyres).unwrap(), b.area(Pane::Tyres).unwrap());
            assert!(
                tyres_with.2 + 0.01 >= tyres_without.2,
                "{dash:?} {layout:?}: the tyres lose room to the session"
            );
        }
        for dash in [DashboardId::Practice, DashboardId::TimeTrial] {
            assert!(
                layout.plan_in(dash, &with, usize::MAX).area(Pane::Session).is_none(),
                "{dash:?} {layout:?}"
            );
        }
    }
}

// The rivals: the relative card, the standings and the gaps.

/// A car of a hand-made field: its slot, name, place overall, class, laps done and how far round the current lap it is. Its
/// best lap is 100 seconds, so a share of a lap of 0.125 is 12.5 seconds.
fn rival_car(slot: u16, name: &str, position: u16, class: Option<&str>, laps: i32, share: f32) -> crate::field::Car {
    crate::field::Car {
        position: Some(position),
        class: class.map(str::to_owned),
        laps_done: Some(laps),
        lap_share: Some(share),
        best_lap_s: Some(100.0),
        ..crate::field::Car::named(slot, name)
    }
}

fn the_player(car: crate::field::Car) -> crate::field::Car {
    crate::field::Car { is_player: true, ..car }
}

fn hand_field(cars: Vec<crate::field::Car>) -> crate::field::Field {
    crate::field::Field { cars, at_s: 0.0 }
}

/// The reading `live_reading` is, with a field.
fn live_with_field(field: crate::field::Field) -> Live {
    let mut live = live_reading();
    live.field = Some(Arc::new(field));
    live
}

fn row_names(rows: &[RelativeRow]) -> Vec<&str> {
    rows.iter().map(|r| r.name.as_str()).collect()
}

#[test]
fn the_relative_rows_are_the_cars_round_the_player_with_the_time_to_each_across_the_line() {
    // The player is 15/16 of the way round lap 5. A car just across the line is ahead of it (by 1/8 of a lap, 12.5 s), not
    // 7/8 of a lap behind; the car on the straight behind is 12.5 s back.
    let field = hand_field(vec![
        rival_car(1, "Across", 2, None, 5, 0.0625),
        the_player(rival_car(0, "You", 3, None, 4, 0.9375)),
        rival_car(2, "Behind", 4, None, 4, 0.8125),
    ]);
    let rows = relative_rows(&field);
    assert_eq!(row_names(&rows), ["Across", "You", "Behind"]);
    assert_eq!(rows[0].gap.as_deref(), Some("+12.500"));
    assert_eq!(rows[1].gap, None, "the player's own row has no time");
    assert_eq!(rows[2].gap.as_deref(), Some("-12.500"));
    assert_eq!(rows.iter().map(|r| r.position.as_str()).collect::<Vec<_>>(), ["P2", "P3", "P4"]);
    assert!(rows[1].is_player && !rows[0].is_player);
    // Nothing is lapping or lapped: 5.0625 against 4.9375 is not a lap.
    assert!(rows.iter().all(|r| r.relation == LapRelation::Level && r.role == Role::Text));
}

#[test]
fn the_relative_rows_hold_three_cars_either_side_the_farthest_ahead_first() {
    let mut cars = vec![the_player(rival_car(0, "You", 6, None, 3, 0.5))];
    for i in 1..=5_u16 {
        // Ahead on the track by an eighth of a lap each.
        let share = 0.5 + 0.0625 * f32::from(i);
        cars.push(rival_car(i, &format!("Ahead {i}"), 6 - i, None, 3, share.min(0.99)));
        cars.push(rival_car(
            10 + i,
            &format!("Behind {i}"),
            6 + i,
            None,
            3,
            0.5 - 0.0625 * f32::from(i),
        ));
    }
    let rows = relative_rows(&hand_field(cars));
    assert_eq!(
        row_names(&rows),
        ["Ahead 3", "Ahead 2", "Ahead 1", "You", "Behind 1", "Behind 2", "Behind 3"]
    );
}

#[test]
fn a_car_a_lap_ahead_is_blue_a_lapped_car_is_quiet_and_the_same_lap_is_plain() {
    // The player has done 4 laps and half of the fifth (4.5).
    let me = the_player(rival_car(0, "You", 5, None, 4, 0.5));
    let other = |laps: i32, share: f32| rival_car(1, "X", 1, None, laps, share);
    assert_eq!(lap_relation(&me, &other(5, 0.5625)), LapRelation::Lapping, "1.0625 laps ahead");
    assert_eq!(lap_relation(&me, &other(5, 0.5)), LapRelation::Lapping, "exactly a lap ahead");
    assert_eq!(lap_relation(&me, &other(5, 0.4375)), LapRelation::Level, "just under a lap ahead");
    assert_eq!(lap_relation(&me, &other(3, 0.4375)), LapRelation::Lapped, "1.0625 laps behind");
    assert_eq!(lap_relation(&me, &other(3, 0.5)), LapRelation::Lapped, "exactly a lap behind");
    assert_eq!(lap_relation(&me, &other(3, 0.5625)), LapRelation::Level);
    assert_eq!(lap_relation(&me, &other(4, 0.5625)), LapRelation::Level);
    let unknown = crate::field::Car {
        laps_done: None,
        ..other(9, 0.5)
    };
    assert_eq!(lap_relation(&me, &unknown), LapRelation::Level, "no laps, no verdict");
    // In the rows: the car a lap ahead is blue (`Info`), the lapped one muted, wherever they are on the track.
    let field = hand_field(vec![
        rival_car(1, "Lapping", 1, None, 5, 0.5625),
        rival_car(2, "Same lap", 2, None, 4, 0.5625),
        me,
        rival_car(3, "Lapped", 6, None, 3, 0.4375),
    ]);
    let rows = relative_rows(&field);
    let role = |name: &str| rows.iter().find(|r| r.name == name).map(|r| r.role);
    assert_eq!(role("Lapping"), Some(Role::Info));
    assert_eq!(role("Same lap"), Some(Role::Text));
    assert_eq!(role("Lapped"), Some(Role::Muted));
    assert_eq!(role("You"), Some(Role::Text));
}

#[test]
fn the_relative_model_says_why_it_is_empty_and_follows_the_reading() {
    let mut live = live_reading();
    live.field = None;
    let m = model(&live, Lang::En).relative.expect("the game gives rivals");
    assert_eq!(m.title, "Relative");
    assert!(m.rows.is_empty() && m.note.is_some());
    let live = live_with_field(hand_field(vec![
        rival_car(1, "Ahead", 1, None, 4, 0.5625),
        the_player(rival_car(0, "You", 2, None, 4, 0.5)),
    ]));
    let m = model(&live, Lang::En).relative.unwrap();
    assert_eq!(m.rows.len(), 2);
    assert!(m.note.is_none());
    assert_eq!(m.show, Show::Shown);
    // The player alone, or a player with no share of the lap, is no relative yet.
    let alone = live_with_field(hand_field(vec![the_player(rival_car(0, "You", 1, None, 4, 0.5))]));
    assert!(model(&alone, Lang::En).relative.unwrap().note.is_some());
    // A reading that is no longer live is dimmed.
    let late = dashboard(&live, &ctx_of(Lang::En, live.at_ms + STALE_MS + 1));
    assert_eq!(late.relative.unwrap().show, Show::Dimmed);
    // Portuguese.
    assert_eq!(model(&live, Lang::Pt).relative.unwrap().title, "Relativo");
}

#[test]
fn the_standings_pick_the_leader_the_player_and_the_cars_round_it() {
    assert_eq!(standings_pick(0, 0, 6), Vec::<usize>::new());
    assert_eq!(standings_pick(1, 0, 6), [0]);
    assert_eq!(standings_pick(3, 1, 6), [0, 1, 2], "a small class is shown whole");
    assert_eq!(standings_pick(6, 4, 6), [0, 1, 2, 3, 4, 5]);
    // In the middle: the leader, two ahead, the player, two behind; the places in between are skipped.
    assert_eq!(standings_pick(10, 5, 6), [0, 3, 4, 5, 6, 7]);
    // The player leads: the rows go to the cars behind.
    assert_eq!(standings_pick(10, 0, 6), [0, 1, 2, 3, 4, 5]);
    assert_eq!(standings_pick(10, 1, 6), [0, 1, 2, 3, 4, 5]);
    // Near the front the window reaches the leader.
    assert_eq!(standings_pick(10, 3, 6), [0, 1, 2, 3, 4, 5]);
    assert_eq!(standings_pick(7, 3, 6), [0, 1, 2, 3, 4, 5]);
    // Last, or nearly: the rows go to the cars ahead.
    assert_eq!(standings_pick(10, 9, 6), [0, 5, 6, 7, 8, 9]);
    assert_eq!(standings_pick(10, 8, 6), [0, 5, 6, 7, 8, 9]);
    // Never more than wanted, never a repeat, always in order.
    for len in 0..14 {
        for player in 0..len.max(1) {
            let picked = standings_pick(len, player, STANDINGS_ROWS);
            assert!(picked.len() <= STANDINGS_ROWS.max(1).min(len.max(1)), "{len} {player}: {picked:?}");
            assert!(picked.windows(2).all(|w| w[0] < w[1]), "{len} {player}: {picked:?}");
            assert!(len == 0 || picked.contains(&player), "{len} {player}: the player is in {picked:?}");
            assert!(len == 0 || picked[0] == 0, "{len} {player}: the leader is first in {picked:?}");
        }
    }
}

/// A car of a hand-made class table: its class place, the gap to the overall leader and its last lap.
fn classed(slot: u16, name: &str, position: u16, class: &str, class_position: u16, behind: f64, last: f64) -> crate::field::Car {
    crate::field::Car {
        class_position: Some(class_position),
        gap_leader_s: Some(behind),
        last_lap_s: Some(last),
        ..rival_car(slot, name, position, Some(class), 4, 0.5)
    }
}

#[test]
fn the_standings_show_only_the_players_class_with_the_gap_to_the_class_leader() {
    // Two classes: the GT3 leader is second overall, 4.0 s behind the GTE leader.
    let field = hand_field(vec![
        classed(1, "Gte One", 1, "GTE", 1, 0.0, 99.0),
        classed(2, "Gt3 One", 2, "GT3", 1, 4.0, 101.0),
        classed(3, "Gte Two", 3, "GTE", 2, 8.0, 99.5),
        classed(4, "Gt3 Two", 4, "GT3", 2, 10.0, 107.918),
        the_player(classed(0, "You", 6, "GT3", 3, 15.5, 102.25)),
        classed(5, "Gte Three", 5, "GTE", 3, 12.0, 100.0),
        classed(6, "Gt3 Four", 7, "GT3", 4, 18.0, 103.0),
    ]);
    let rows = standings_rows(&field, "Leader", STANDINGS_ROWS);
    let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(
        names,
        ["Gt3 One", "Gt3 Two", "You", "Gt3 Four"],
        "the GTE cars are not in the table"
    );
    let places: Vec<&str> = rows.iter().map(|r| r.position.as_str()).collect();
    assert_eq!(places, ["P1", "P2", "P3", "P4"], "class places");
    let gaps: Vec<&str> = rows.iter().map(|r| r.gap.as_str()).collect();
    assert_eq!(gaps, ["Leader", "+6.0", "+11.5", "+14.0"], "less the class leader's own 4.0 s");
    assert_eq!(rows[1].last, "1:47.918");
    assert_eq!(rows[2].last, "1:42.250");
    assert!(rows[2].is_player && rows.iter().filter(|r| r.is_player).count() == 1);
    assert!(rows.iter().all(|r| !r.skipped_before), "a small class skips no place");
    // The model names the class and heads the columns.
    let live = live_with_field(field);
    let m = model(&live, Lang::En).standings.unwrap();
    assert_eq!(m.class_name.as_deref(), Some("GT3"));
    assert_eq!(
        (m.title.as_str(), m.heads[0].as_str(), m.heads[1].as_str()),
        ("Standings", "Gap", "Last")
    );
    assert_eq!(m.rows.len(), 4);
    assert!(m.note.is_none());
    assert_eq!(model(&live, Lang::Pt).standings.unwrap().rows[0].gap, "Líder");
}

#[test]
fn the_standings_without_classes_follow_the_place_overall_and_mark_the_skipped_places() {
    // Ten cars, no classes: the player is sixth (index 5), the leader has no gap of its own.
    let car = |slot: u16, position: u16, gap: Option<f64>| crate::field::Car {
        gap_leader_s: gap,
        ..rival_car(slot, &format!("Car {position}"), position, None, 4, 0.5)
    };
    let mut cars: Vec<crate::field::Car> = (1..=10).map(|p| car(p, p, Some(f64::from(p - 1) * 2.5))).collect();
    cars[0].gap_leader_s = None;
    cars[5].is_player = true;
    let rows = standings_rows(&hand_field(cars), "Leader", STANDINGS_ROWS);
    let places: Vec<&str> = rows.iter().map(|r| r.position.as_str()).collect();
    assert_eq!(places, ["P1", "P4", "P5", "P6", "P7", "P8"]);
    assert_eq!(rows[0].gap, "Leader");
    assert_eq!(
        rows[1].gap, "+7.5",
        "a leader first overall is 0 behind itself, with a gap of its own or not"
    );
    let skipped: Vec<bool> = rows.iter().map(|r| r.skipped_before).collect();
    assert_eq!(
        skipped,
        [false, true, false, false, false, false],
        "a divider over the row after the skipped places"
    );
    assert_eq!(rows[1].last, "–", "no last lap, no time");
    // The player leads: the leader is the player and the rows go behind it.
    let mut cars: Vec<crate::field::Car> = (1..=10).map(|p| car(p, p, Some(f64::from(p - 1) * 2.0))).collect();
    cars[0].is_player = true;
    let rows = standings_rows(&hand_field(cars), "Leader", STANDINGS_ROWS);
    assert_eq!(rows.len(), 6);
    assert!(rows[0].is_player && rows[0].gap == "Leader");
    assert_eq!(rows[5].position, "P6");
    // The player is last: the rows go ahead of it.
    let mut cars: Vec<crate::field::Car> = (1..=10).map(|p| car(p, p, Some(f64::from(p - 1) * 2.0))).collect();
    cars[9].is_player = true;
    let rows = standings_rows(&hand_field(cars), "Leader", STANDINGS_ROWS);
    let places: Vec<&str> = rows.iter().map(|r| r.position.as_str()).collect();
    assert_eq!(places, ["P1", "P6", "P7", "P8", "P9", "P10"]);
    assert!(rows[5].is_player && rows[5].gap == "+18.0");
    // No gaps from the game: a dash, never a made-up number.
    let cars: Vec<crate::field::Car> = (1..=3)
        .map(|p| crate::field::Car {
            is_player: p == 2,
            ..car(p, p, None)
        })
        .collect();
    let rows = standings_rows(&hand_field(cars), "Leader", STANDINGS_ROWS);
    assert_eq!((rows[1].gap.as_str(), rows[2].gap.as_str()), ("–", "–"));
}

#[test]
fn a_reading_without_a_player_or_a_field_has_empty_standings_and_a_note() {
    let mut live = live_reading();
    live.field = None;
    let m = model(&live, Lang::En).standings.unwrap();
    assert!(m.rows.is_empty() && m.note.is_some() && m.class_name.is_none());
    let nobody = live_with_field(hand_field(vec![rival_car(1, "A", 1, None, 4, 0.5)]));
    assert!(model(&nobody, Lang::En).standings.unwrap().rows.is_empty());
}

#[test]
fn the_gaps_write_the_car_ahead_and_behind_with_the_gap_now_and_the_trend() {
    let mut live = live_with_field(hand_field(vec![
        crate::field::Car {
            gap_ahead_s: Some(2.0),
            ..rival_car(1, "Ahead", 4, None, 4, 0.6)
        },
        the_player(crate::field::Car {
            gap_ahead_s: Some(1.234),
            ..rival_car(0, "You", 5, None, 4, 0.5)
        }),
        crate::field::Car {
            gap_ahead_s: Some(0.876),
            ..rival_car(2, "Behind", 6, None, 4, 0.4)
        },
        rival_car(3, "Far", 9, None, 4, 0.1),
    ]));
    live.gap_trend = Some((Some(0.3), Some(-0.2)));
    let m = model(&live, Lang::En).gaps.expect("the game gives rivals");
    assert_eq!(
        (m.title.as_str(), m.ahead.label.as_str(), m.behind.label.as_str()),
        ("Gaps", "Ahead", "Behind")
    );
    let (ahead, behind) = (m.ahead.car.unwrap(), m.behind.car.unwrap());
    assert_eq!(
        (ahead.name.as_str(), ahead.position.as_str(), ahead.gap.as_str()),
        ("Ahead", "P4", "+1.234")
    );
    assert_eq!(
        (behind.name.as_str(), behind.position.as_str(), behind.gap.as_str()),
        ("Behind", "P6", "-0.876")
    );
    // The car ahead is closing (good), the one behind is opening (good for the player).
    let (closing, opening) = (ahead.trend.unwrap(), behind.trend.unwrap());
    assert_eq!(
        (closing.dir, closing.text.as_str(), closing.role),
        (TrendDir::Closing, "closing 0.3 s/lap", Role::Good)
    );
    assert_eq!(
        (opening.dir, opening.text.as_str(), opening.role),
        (TrendDir::Opening, "opening 0.2 s/lap", Role::Good)
    );
    assert!(m.note.is_none());
    // Portuguese.
    let pt = model(&live, Lang::Pt).gaps.unwrap();
    assert_eq!(pt.ahead.label, "À frente");
    assert_eq!(pt.ahead.car.unwrap().trend.unwrap().text, "aproximando 0.3 s/volta");
    assert_eq!(pt.behind.car.unwrap().trend.unwrap().text, "afastando 0.2 s/volta");
}

#[test]
fn a_gap_trend_is_closing_opening_or_steady_and_what_it_means_depends_on_the_side() {
    assert_eq!(trend_dir(0.3), TrendDir::Closing);
    assert_eq!(trend_dir(-0.3), TrendDir::Opening);
    assert_eq!(trend_dir(0.04), TrendDir::Steady);
    assert_eq!(trend_dir(-0.04), TrendDir::Steady);
    assert_eq!(trend_dir(0.0), TrendDir::Steady);
    assert_eq!(trend_dir(f64::NAN), TrendDir::Steady);
    // The car ahead: closing is good, opening bad. The car behind: closing is bad, opening good.
    assert_eq!(trend_role(true, TrendDir::Closing), Role::Good);
    assert_eq!(trend_role(true, TrendDir::Opening), Role::Danger);
    assert_eq!(trend_role(false, TrendDir::Closing), Role::Danger);
    assert_eq!(trend_role(false, TrendDir::Opening), Role::Good);
    assert_eq!(trend_role(true, TrendDir::Steady), Role::Muted);
    assert_eq!(trend_role(false, TrendDir::Steady), Role::Muted);
    let behind_closing = gap_trend_model(Lang::En, false, 0.46);
    assert_eq!(
        (behind_closing.text.as_str(), behind_closing.role),
        ("closing 0.5 s/lap", Role::Danger)
    );
    let steady = gap_trend_model(Lang::En, true, 0.02);
    assert_eq!((steady.text.as_str(), steady.dir), ("steady", TrendDir::Steady));
}

#[test]
fn the_leader_has_nobody_ahead_and_a_gap_the_game_does_not_give_is_a_dash() {
    let live = live_with_field(hand_field(vec![
        the_player(crate::field::Car {
            gap_ahead_s: Some(0.0),
            ..rival_car(0, "You", 1, None, 4, 0.5)
        }),
        rival_car(1, "Behind", 2, None, 4, 0.4),
    ]));
    let m = model(&live, Lang::En).gaps.unwrap();
    assert!(m.ahead.car.is_none(), "nobody ahead of the leader");
    let behind = m.behind.car.unwrap();
    assert_eq!(behind.gap, "–");
    assert!(behind.trend.is_none(), "no trend without two laps");
    // No field: both sides are empty and a note says why.
    let mut empty = live_reading();
    empty.field = None;
    let m = model(&empty, Lang::En).gaps.unwrap();
    assert!(m.ahead.car.is_none() && m.behind.car.is_none() && m.note.is_some());
}

#[test]
fn the_demo_field_is_two_classes_with_the_player_fifth_and_third_in_its_class() {
    let field = super::demo::demo_field(3, 1200.0, 0.0);
    assert_eq!(field.cars.len(), 14);
    let player = field.player().expect("the player is in the field");
    assert_eq!((player.position, player.class_position), (Some(5), Some(3)));
    assert_eq!(player.class.as_deref(), Some("GT3"));
    let classes: HashSet<&str> = field.cars.iter().filter_map(|c| c.class.as_deref()).collect();
    assert_eq!(classes, HashSet::from(["GT3", "GTE"]));
    let places: Vec<u16> = field.cars.iter().filter_map(|c| c.position).collect();
    assert_eq!(places, (1..=14).collect::<Vec<u16>>());
    // The relative card: three cars either side, a car a lap ahead among them and a lapped one.
    let rows = relative_rows(&field);
    assert_eq!(
        row_names(&rows),
        ["S. Okafor", "T. Kessler", "A. Dumont", "You", "J. Brandt", "M. Silva", "C. Rossi"]
    );
    assert_eq!(rows[1].relation, LapRelation::Lapping);
    assert_eq!(rows[6].relation, LapRelation::Lapped);
    assert!(rows[..3].iter().all(|r| r.gap.as_deref().is_some_and(|g| g.starts_with('+'))));
    assert!(rows[4..].iter().all(|r| r.gap.as_deref().is_some_and(|g| g.starts_with('-'))));
    // The gaps drift from lap to lap, the places stay.
    let later = super::demo::demo_field(4, 1200.0, 0.0);
    let gap = |f: &crate::field::Field| f.player().and_then(|p| p.gap_ahead_s);
    assert_ne!(gap(&field), gap(&later));
    assert_eq!(later.player().and_then(|p| p.position), Some(5));
    // The first lap, with the cars behind still on the line, is a field all the same.
    assert_eq!(super::demo::demo_field(1, 0.0, 0.0).cars.len(), 14);
}

#[test]
fn the_rivals_cards_are_on_race_and_qualifying_and_in_no_other_dashboard() {
    use crate::game::Caps;
    let with = slots(every_cap());
    let without = slots(every_cap().minus(Caps::RIVALS));
    let rivals = [Pane::Relative, Pane::Standings, Pane::Gaps];
    for layout in ALL_LAYOUTS {
        for dash in DashboardId::ALL {
            let (a, b) = (layout.plan_in(dash, &with, usize::MAX), layout.plan_in(dash, &without, usize::MAX));
            for pane in rivals {
                assert!(b.area(pane).is_none(), "{dash:?} {layout:?}: {pane:?} needs the game's rivals");
                let wanted = match (dash, pane) {
                    (DashboardId::Race, _) => layout != Layout::Classic,
                    (DashboardId::Qualifying, Pane::Standings) => layout != Layout::Classic,
                    _ => false,
                };
                assert_eq!(a.area(pane).is_some(), wanted, "{dash:?} {layout:?}: {pane:?}");
                if let Some(area) = a.area(pane) {
                    assert!(
                        area.3 + 0.01 >= least_height(pane),
                        "{dash:?} {layout:?}: {pane:?} is {} tall",
                        area.3
                    );
                }
            }
            // The rivals take no room from the tyres.
            if matches!(dash, DashboardId::Race | DashboardId::Qualifying) {
                let (tyres_with, tyres_without) = (a.area(Pane::Tyres).unwrap(), b.area(Pane::Tyres).unwrap());
                assert!(
                    tyres_with.2 + 0.01 >= tyres_without.2,
                    "{dash:?} {layout:?}: the tyres lose room to the rivals"
                );
            }
        }
    }
    // The Wide Race dashboard: the rivals and the session in the middle row, which holds only the session without rivals.
    let plan = Layout::Wide.plan_in(DashboardId::Race, &without, usize::MAX);
    assert!(plan.area(Pane::Session).is_some());
    let plan = Layout::Wide.plan_in(DashboardId::Race, &with, usize::MAX);
    let (relative, standings, gaps, session) = (
        plan.area(Pane::Relative).unwrap(),
        plan.area(Pane::Standings).unwrap(),
        plan.area(Pane::Gaps).unwrap(),
        plan.area(Pane::Session).unwrap(),
    );
    assert!(relative.1 == standings.1 && standings.1 == gaps.1 && gaps.1 == session.1, "one row");
    assert!(
        relative.0 < standings.0 && standings.0 < gaps.0 && gaps.0 < session.0,
        "in that order"
    );
}

#[test]
fn the_race_dashboard_lights_the_players_row_and_the_edge_of_a_trend() {
    let laps = rich_laps();
    let live = full_reading();
    let mut none = live.clone();
    none.field = None;
    none.gap_trend = None;
    let with = dashboard_pixels(DashboardId::Race, &live, &laps);
    save(&with, 1920, 1080, "panel-race-rivals.png");
    let without = dashboard_pixels(DashboardId::Race, &none, &laps);
    assert!(
        has_color(&with, PRIMARY) > has_color(&without, PRIMARY) + 100,
        "the player's row is lit in the relative and in the standings: {} against {}",
        has_color(&with, PRIMARY),
        has_color(&without, PRIMARY)
    );
    assert!(
        has_color(&with, SUCCESS) > has_color(&without, SUCCESS) + 100,
        "the gaps' two sides have a green edge: {} against {}",
        has_color(&with, SUCCESS),
        has_color(&without, SUCCESS)
    );
    // Without rivals the dashboard still paints, the middle row holding only the session.
    let mut ac = full_reading();
    ac.caps = every_cap().minus(crate::game::Caps::RIVALS);
    ac.field = None;
    let pixels = dashboard_pixels(DashboardId::Race, &ac, &laps);
    assert!(has_color(&pixels, CARD) > 1000);
}

#[test]
fn the_rivals_cards_paint_in_every_shape_with_and_without_the_cars() {
    let f = fixture();
    let laps = rich_laps();
    let with = full_reading();
    let mut none = with.clone();
    none.field = None;
    none.gap_trend = None;
    for dash in [DashboardId::Race, DashboardId::Qualifying] {
        for live in [&with, &none] {
            for (w, h) in [(2560, 1080), (1920, 1080), (1024, 768), (540, 1080), (430, 900), (960, 600)] {
                let mut v = view(&f, Some(live), Tab::Dash, 1.0, Lang::Pt);
                v.dashboard = Some(dash);
                v.recent_laps = &laps;
                let pixels = render(&v, w, h);
                assert!(has_color(&pixels, CARD) > 1000, "{dash:?} {w}x{h}");
            }
        }
    }
}

#[test]
fn a_race_with_rivals_keeps_the_phone_layout_on_a_phone_held_upright() {
    // Too tall a canvas falls back to Classic, which has no rivals: the race rows for a phone must stay short enough.
    let s = slots(full_reading().caps);
    assert_eq!(pick_layout_in(DashboardId::Race, 540.0, 1014.0, &s), Layout::Portrait);
}

// The radar: the cars alongside and close, from the cars' world positions or the game's own spotter.

fn near(a: f32, b: f32) -> bool {
    (a - b).abs() < 1e-3
}

fn near_at(got: Option<(f32, f32)>, want: (f32, f32)) -> bool {
    got.is_some_and(|(right, ahead)| near(right, want.0) && near(ahead, want.1))
}

/// A car with a world position (x and z; the height does not matter).
fn world_car(slot: u16, name: &str, x: f32, z: f32) -> crate::field::Car {
    crate::field::Car {
        world: Some([x, 0.0, z]),
        ..crate::field::Car::named(slot, name)
    }
}

/// `field` with no world positions.
fn without_world(field: &crate::field::Field) -> crate::field::Field {
    crate::field::Field {
        cars: field
            .cars
            .iter()
            .map(|car| crate::field::Car {
                world: None,
                ..car.clone()
            })
            .collect(),
        at_s: field.at_s,
    }
}

/// A field with the player at `(100, 200)` and cars round it: one alongside on the left, one 6 m behind, one 25 m ahead, one far
/// ahead (out of range) and one with no position. The player faces north (+z), the game's ground not mirrored.
fn radar_field() -> crate::field::Field {
    hand_field(vec![
        crate::field::Car {
            is_player: true,
            ..world_car(0, "You", 100.0, 200.0)
        },
        world_car(1, "Left", 96.4, 200.0),
        world_car(2, "Behind", 100.0, 194.0),
        world_car(3, "Ahead", 100.0, 225.0),
        world_car(4, "Far", 100.0, 260.0),
        crate::field::Car::named(5, "Nowhere"),
    ])
}

const NORTH: (f32, f32) = (0.0, 1.0);

#[test]
fn a_car_is_put_where_the_players_heading_says_it_is() {
    let me = [100.0, 0.0, 200.0];
    let at = |x: f32, z: f32, heading: (f32, f32), mirrored: bool| radar_offset(me, [x, 0.0, z], heading, mirrored);
    // Facing north, with x east: ahead is +z, right is +x.
    assert!(near_at(at(100.0, 210.0, NORTH, false), (0.0, 10.0)), "straight ahead");
    assert!(near_at(at(100.0, 195.0, NORTH, false), (0.0, -5.0)), "behind");
    assert!(near_at(at(97.0, 200.0, NORTH, false), (-3.0, 0.0)), "alongside on the left");
    assert!(near_at(at(103.0, 200.0, NORTH, false), (3.0, 0.0)), "alongside on the right");
    // A game whose ground has the other handedness (iRacing, Assetto Corsa) swaps the sides, never ahead and behind.
    assert!(near_at(at(97.0, 200.0, NORTH, true), (3.0, 0.0)), "mirrored: the left is the right");
    assert!(near_at(at(103.0, 200.0, NORTH, true), (-3.0, 0.0)));
    assert!(near_at(at(100.0, 210.0, NORTH, true), (0.0, 10.0)), "mirrored: ahead stays ahead");
    // Turned 90 degrees, to face east: +x is ahead and north (+z) is the left.
    let east = (1.0, 0.0);
    assert!(near_at(at(107.0, 200.0, east, false), (0.0, 7.0)));
    assert!(
        near_at(at(100.0, 205.0, east, false), (-5.0, 0.0)),
        "facing east, north is on the left"
    );
    assert!(near_at(at(100.0, 205.0, east, true), (5.0, 0.0)));
    // The length of the heading does not matter, and a heading that is not a direction gives nothing.
    assert!(near_at(at(107.0, 200.0, (4.0, 0.0), false), (0.0, 7.0)));
    assert_eq!(at(107.0, 200.0, (0.0, 0.0), false), None);
    assert_eq!(at(107.0, 200.0, (f32::NAN, 1.0), false), None);
    assert_eq!(at(f32::NAN, 200.0, NORTH, false), None);
}

#[test]
fn the_radar_covers_12_m_each_side_30_ahead_and_20_behind() {
    for inside in [(0.0, 0.0), (12.0, 30.0), (-12.0, -20.0), (-3.0, 29.9)] {
        assert!(radar_in_range(inside), "{inside:?}");
    }
    for outside in [(0.0, 30.1), (0.0, -20.1), (12.1, 0.0), (-12.1, 5.0), (0.0, 80.0)] {
        assert!(!radar_in_range(outside), "{outside:?}");
    }
}

#[test]
fn a_car_overlapping_the_players_close_beside_it_is_alongside_and_one_within_8_m_is_close() {
    use RadarThreat::{Alongside, Clear, Near};
    // Alongside: the centres less than a car length (4.6 m) apart lengthways and less than 3 m between the two cars' sides
    // (1.9 m wide each, so a centre distance under 4.9 m).
    assert_eq!(radar_threat((-3.6, 0.0)), Alongside, "the next lane, level");
    assert_eq!(radar_threat((3.6, 4.0)), Alongside);
    assert_eq!(radar_threat((-4.8, -4.5)), Alongside);
    assert_eq!(radar_threat((0.0, 2.0)), Alongside, "on top of it");
    assert_eq!(radar_threat((5.0, 0.0)), Near, "two lanes over, level: 3.1 m between the sides");
    assert_eq!(radar_threat((-3.6, 4.6)), Near, "a car length ahead no longer overlaps");
    assert_eq!(radar_threat((0.0, -6.0)), Near);
    assert_eq!(radar_threat((0.0, 8.0)), Near, "8 m is still close");
    assert_eq!(radar_threat((0.0, 8.1)), Clear);
    assert_eq!(radar_threat((-10.0, -20.0)), Clear);
    // Red is more urgent than amber, amber than quiet.
    assert!(Alongside > Near && Near > Clear);
    assert_eq!(
        (Clear.role(), Near.role(), Alongside.role()),
        (Role::Muted, Role::Warn, Role::Danger)
    );
}

#[test]
fn the_radar_lists_the_cars_in_range_the_most_urgent_last() {
    let cars = radar_cars(&radar_field(), NORTH, false).expect("the player has a position");
    let seen: Vec<(RadarThreat, f32, f32)> = cars.iter().map(|c| (c.threat, c.right_m, c.ahead_m)).collect();
    assert_eq!(cars.len(), 3, "the far car and the car with no position are left out: {seen:?}");
    assert_eq!(cars[0].threat, RadarThreat::Clear);
    assert!(near(cars[0].right_m, 0.0) && near(cars[0].ahead_m, 25.0));
    assert_eq!(cars[1].threat, RadarThreat::Near);
    assert!(near(cars[1].right_m, 0.0) && near(cars[1].ahead_m, -6.0));
    assert_eq!(cars[2].threat, RadarThreat::Alongside);
    assert!(near(cars[2].right_m, -3.6) && near(cars[2].ahead_m, 0.0));
    // The other handedness mirrors the sides.
    let mirrored = radar_cars(&radar_field(), NORTH, true).unwrap();
    assert!(near(mirrored[2].right_m, 3.6));
    // No position for the player, or no heading: nothing to draw.
    let mut nobody = radar_field();
    nobody.cars[0].world = None;
    assert_eq!(radar_cars(&nobody, NORTH, false), None);
    assert_eq!(radar_cars(&radar_field(), (0.0, 0.0), false), None);
    assert_eq!(radar_cars(&hand_field(vec![world_car(1, "Only", 0.0, 0.0)]), NORTH, false), None);
}

#[test]
fn the_radar_measures_every_car_from_the_player_in_the_same_field_never_from_the_live_position() {
    let mut live = live_reading();
    live.caps = crate::game::Caps::RIVALS_WORLD;
    live.heading = Some(NORTH);
    live.field = Some(Arc::new(radar_field()));
    live.pos = Some((100.0, 200.0));
    let cars = |live: &Live| model(live, Lang::En).radar.expect("the radar is there").cars;
    let before = cars(&live);
    assert_eq!(before.len(), 3);
    // The player has driven 60 m since the field was read: the live position is far ahead of the player's car in the field.
    live.pos = Some((100.0, 260.0));
    assert_eq!(cars(&live), before, "the live position is not used");
    // A field read somewhere else on the ground is the same picture.
    let moved = crate::field::Field {
        cars: radar_field()
            .cars
            .into_iter()
            .map(|c| crate::field::Car {
                world: c.world.map(|[x, y, z]| [x + 500.0, y, z - 300.0]),
                ..c
            })
            .collect(),
        at_s: 0.0,
    };
    live.field = Some(Arc::new(moved));
    for (a, b) in cars(&live).iter().zip(&before) {
        assert!(near(a.right_m, b.right_m) && near(a.ahead_m, b.ahead_m) && a.threat == b.threat);
    }
}

#[test]
fn the_radar_follows_the_games_handedness_and_the_players_heading() {
    let mut live = live_reading();
    live.caps = crate::game::Caps::RIVALS_WORLD;
    live.field = Some(Arc::new(radar_field()));
    live.heading = Some(NORTH);
    let left_of = |live: &Live| model(live, Lang::En).radar.unwrap().cars.last().map(|c| c.right_m);
    live.game = "acc";
    assert!(left_of(&live).is_some_and(|r| near(r, -3.6)));
    live.game = "iracing";
    assert!(left_of(&live).is_some_and(|r| near(r, 3.6)), "the same mirror as the track camera");
    live.game = "ac";
    assert!(left_of(&live).is_some_and(|r| near(r, 3.6)));
    // Facing west (-x), the car 3.6 m to the west of the player is ahead of it, not beside it.
    live.game = "acc";
    live.heading = Some((-1.0, 0.0));
    let radar = model(&live, Lang::En).radar.unwrap();
    assert!(
        radar.cars.iter().any(|c| near(c.ahead_m, 3.6) && near(c.right_m, 0.0)),
        "{:?}",
        radar.cars
    );
}

#[test]
fn the_radar_draws_the_cars_the_spotter_or_a_note_by_what_the_game_gives() {
    use crate::game::{Caps, Spotter};
    let mut live = live_reading();
    live.heading = Some(NORTH);
    // The cars' positions.
    live.caps = Caps::RIVALS_WORLD;
    live.field = Some(Arc::new(radar_field()));
    let radar = model(&live, Lang::En).radar.unwrap();
    assert_eq!((radar.mode, radar.cars.len(), radar.note.as_deref()), (RadarMode::Map, 3, None));
    assert_eq!((radar.title.as_str(), radar.show), ("Radar", Show::Shown));
    // The positions are there but the car has no direction yet: neither picture, and the card says why.
    live.heading = None;
    let radar = model(&live, Lang::En).radar.unwrap();
    assert_eq!((radar.mode, radar.cars.len()), (RadarMode::Waiting, 0));
    assert!(radar.note.as_deref().is_some_and(|n| n.contains("moving")));
    // Only the spotter (iRacing): no positions, bars by the signal.
    live.caps = Caps::SPOTTER;
    live.field = None;
    for (signal, bars) in [
        (None, (0, 0)),
        (Some(Spotter::Clear), (0, 0)),
        (Some(Spotter::Left), (1, 0)),
        (Some(Spotter::Right), (0, 1)),
        (Some(Spotter::Both), (1, 1)),
        (Some(Spotter::TwoLeft), (2, 0)),
        (Some(Spotter::TwoRight), (0, 2)),
    ] {
        live.spotter = signal;
        let radar = model(&live, Lang::En).radar.unwrap();
        assert_eq!(radar.mode, RadarMode::Spotter, "{signal:?}");
        assert_eq!((radar.left_bars, radar.right_bars), bars, "{signal:?}");
        assert!(radar.cars.is_empty() && radar.note.is_none());
    }
    // A game that gives both (the positions win) and a stale reading dims the card.
    live.caps = Caps::SPOTTER.or(Caps::RIVALS_WORLD);
    live.heading = Some(NORTH);
    live.field = Some(Arc::new(radar_field()));
    assert_eq!(model(&live, Lang::En).radar.unwrap().mode, RadarMode::Map);
    let stale = dashboard(&live, &ctx_of(Lang::Pt, live.at_ms + 60_000));
    assert_eq!(stale.radar.map(|r| (r.show, r.title)), Some((Show::Dimmed, "Radar".to_owned())));
}

#[test]
fn the_radar_scale_keeps_the_boxs_aspect_and_crops_the_longer_axis() {
    // A box with the radar's own aspect (24 m by 50 m) shows all of it.
    assert!(near(radar_scale(240.0, 500.0), 10.0));
    // A square box is cropped lengthways to 30 m, so the cars are as big as a 30 m view makes them.
    assert!(near(radar_scale(200.0, 200.0), 200.0 / 30.0));
    // A narrow box is cropped sideways.
    assert!(near(radar_scale(100.0, 500.0), 10.0));
    // A very wide one never shows less than 30 m of length.
    assert!(near(radar_scale(2000.0, 150.0), 5.0));
    assert!(radar_scale(0.0, 0.0) > 0.0);
}

#[test]
fn the_radar_is_on_race_only_beside_the_gaps_and_in_no_other_dashboard() {
    use crate::game::Caps;
    let with = slots(every_cap());
    let no_radar = slots(every_cap().minus(Caps::RIVALS_WORLD.or(Caps::SPOTTER)));
    assert!(!no_radar.cards.contains(&Pane::Radar));
    for layout in ALL_LAYOUTS {
        for dash in DashboardId::ALL {
            let plan = layout.plan_in(dash, &with, usize::MAX);
            let wanted = dash == DashboardId::Race && !matches!(layout, Layout::Classic | Layout::Stack);
            assert_eq!(plan.area(Pane::Radar).is_some(), wanted, "{dash:?} {layout:?}");
            assert!(layout.plan_in(dash, &no_radar, usize::MAX).area(Pane::Radar).is_none());
            if let Some(radar) = plan.area(Pane::Radar) {
                assert!(radar.3 + 0.01 >= RADAR_NEED_H, "{dash:?} {layout:?}: the radar is {} tall", radar.3);
                assert!(radar.2 >= 150.0, "{dash:?} {layout:?}: the radar is {} wide", radar.2);
                // The radar sits in the rivals' row, after the gaps.
                let gaps = plan.area(Pane::Gaps).unwrap();
                assert!(near(gaps.1, radar.1) && gaps.0 < radar.0, "{dash:?} {layout:?}");
            }
        }
    }
    // The rows.
    let wide = builtin(DashboardId::Race).rows_for(Layout::Wide)[1].cards;
    assert_eq!(
        wide,
        [
            (Pane::Relative, 1.2),
            (Pane::Standings, 1.3),
            (Pane::Gaps, 0.85),
            (Pane::Radar, 0.85),
            (Pane::Session, 0.8),
        ]
    );
    let portrait = builtin(DashboardId::Race).rows_for(Layout::Portrait);
    assert!(portrait.iter().any(|row| row.cards == [(Pane::Gaps, 1.0), (Pane::Radar, 1.0)]));
    assert_eq!(
        portrait.iter().map(|row| row.h).sum::<f32>(),
        220.0 + 170.0 + 244.0 + 200.0 + 242.0 + 280.0 + 262.0
    );
    // Without the radar the phone's gaps card takes the whole row, as before.
    let gaps_width = |s: &Slots| {
        Layout::Portrait
            .plan_in(DashboardId::Race, s, usize::MAX)
            .area(Pane::Gaps)
            .unwrap()
            .2
    };
    assert!(gaps_width(&no_radar) > gaps_width(&with));
    // The tyres lose no room to it, in any layout.
    for layout in ALL_LAYOUTS {
        let (a, b) = (
            layout.plan_in(DashboardId::Race, &with, usize::MAX),
            layout.plan_in(DashboardId::Race, &no_radar, usize::MAX),
        );
        assert!(
            a.area(Pane::Tyres).unwrap().2 + 0.01 >= b.area(Pane::Tyres).unwrap().2,
            "{layout:?}"
        );
    }
    // A phone held upright still gets the phone layout.
    assert_eq!(pick_layout_in(DashboardId::Race, 540.0, 1014.0, &with), Layout::Portrait);
}

#[test]
fn the_radar_serialises_for_the_phone_in_camel_case() {
    let live = full_reading();
    let json = serde_json::to_value(model_with(&live, Default::default(), &rich_laps())).unwrap();
    assert_eq!(json["radar"]["mode"], "map");
    assert_eq!(json["radar"]["show"], "shown");
    assert_eq!(json["radar"]["title"], "Radar");
    // The demo's three cars round the player: one 25 m ahead (quiet), one 6 m behind (close), one alongside on the left.
    let cars = json["radar"]["cars"].as_array().unwrap();
    assert_eq!(cars.len(), 3);
    assert_eq!(cars[0]["threat"], "clear");
    assert_eq!(cars[1]["threat"], "near");
    assert_eq!(cars[2]["threat"], "alongside");
    assert!(cars[2]["rightM"].as_f64().unwrap() < -3.0 && cars[2]["aheadM"].as_f64().unwrap().abs() < 0.1);
    assert!(cars[1]["aheadM"].as_f64().unwrap() < -5.0);
    assert_eq!(json["radar"]["leftBars"], 0);
    assert!(json["radar"]["note"].is_null());
    let mut spotter = live.clone();
    spotter.caps = every_cap().minus(crate::game::Caps::RIVALS_WORLD);
    spotter.field = live.field.as_deref().map(|f| Arc::new(without_world(f)));
    spotter.spotter = Some(crate::game::Spotter::TwoRight);
    let json = serde_json::to_value(model_with(&spotter, Default::default(), &rich_laps())).unwrap();
    assert_eq!(
        (json["radar"]["mode"].as_str(), json["radar"]["rightBars"].as_u64()),
        (Some("spotter"), Some(2))
    );
}

#[test]
fn the_demo_puts_three_cars_round_the_player_and_they_move_a_little() {
    let field = super::demo::demo_field(3, 1200.0, 0.0);
    let pose = super::demo::demo_pose(1200.0);
    assert!(field.player().and_then(|p| p.world).is_some());
    let cars = |t: f64| radar_cars(&super::demo::demo_field(3, 1200.0, t), pose.1, false).unwrap();
    let (a, b) = (cars(0.0), cars(3.0));
    assert_eq!((a.len(), b.len()), (3, 3));
    assert!(a.iter().zip(&b).any(|(x, y)| !near(x.ahead_m, y.ahead_m)), "the cars move");
    for t in [0.0, 1.0, 2.0, 3.5, 7.0, 11.0] {
        let cars = cars(t);
        assert!(cars.iter().any(|c| c.threat == RadarThreat::Alongside), "t = {t}");
        assert!(cars.iter().any(|c| c.threat == RadarThreat::Near), "t = {t}");
        assert!(cars.iter().any(|c| c.threat == RadarThreat::Clear), "t = {t}");
    }
    // The demo's frame carries its position, so the live heading comes out of its driving, and a spotter that cycles.
    let seen: HashSet<String> = (0..20)
        .map(|i| format!("{:?}", demo_frame(2, 100.0, f64::from(i) * 2.0, Some(55.0), 40.0, 1.0).spotter))
        .collect();
    assert_eq!(seen.len(), 6, "every state of the spotter: {seen:?}");
}

#[test]
fn the_radar_paints_red_for_a_car_alongside_amber_for_a_close_one_and_bars_for_the_spotter() {
    use crate::game::Spotter;
    let laps = rich_laps();
    let with = full_reading();
    let mut flat = with.clone();
    flat.caps = every_cap().minus(crate::game::Caps::RIVALS_WORLD);
    flat.field = with.field.as_deref().map(|f| Arc::new(without_world(f)));
    let (a, b) = (
        dashboard_pixels(DashboardId::Race, &with, &laps),
        dashboard_pixels(DashboardId::Race, &flat, &laps),
    );
    save(&a, 1920, 1080, "panel-race-radar.png");
    for (colour, what) in [(DESTRUCTIVE, "the car alongside"), (WARN, "the close car")] {
        assert!(
            has_color(&a, colour) > has_color(&b, colour) + 100,
            "{what} is drawn: {} against {}",
            has_color(&a, colour),
            has_color(&b, colour)
        );
    }
    // The spotter: nothing extra while clear, one bar for a car on the left, two for two.
    let red = |signal: Spotter| {
        let mut live = flat.clone();
        live.spotter = Some(signal);
        has_color(&dashboard_pixels(DashboardId::Race, &live, &laps), DESTRUCTIVE)
    };
    let (clear, left, two) = (red(Spotter::Clear), red(Spotter::Left), red(Spotter::TwoLeft));
    assert!(left > clear + 50, "a bar for the car on the left: {left} against {clear}");
    assert!(two > left + 50, "two bars for two cars: {two} against {left}");
    assert!(red(Spotter::Right) > clear + 50, "and on the right");
    // A reading that gives nothing for the radar yet draws the note and still paints.
    let mut waiting = with.clone();
    waiting.heading = None;
    waiting.caps = every_cap().minus(crate::game::Caps::SPOTTER);
    assert!(has_color(&dashboard_pixels(DashboardId::Race, &waiting, &laps), CARD) > 1000);
}

#[test]
fn the_radar_paints_in_every_shape_with_every_kind_of_reading() {
    let f = fixture();
    let laps = rich_laps();
    let with = full_reading();
    let mut spotter = with.clone();
    spotter.caps = every_cap().minus(crate::game::Caps::RIVALS_WORLD);
    spotter.field = None;
    spotter.spotter = Some(crate::game::Spotter::Both);
    let mut waiting = with.clone();
    waiting.heading = None;
    waiting.caps = every_cap().minus(crate::game::Caps::SPOTTER);
    for live in [&with, &spotter, &waiting] {
        for (w, h) in [(2560, 1080), (1920, 1080), (1024, 768), (540, 1080), (430, 900), (960, 600)] {
            let mut v = view(&f, Some(live), Tab::Dash, 1.0, Lang::Es);
            v.dashboard = Some(DashboardId::Race);
            v.recent_laps = &laps;
            let pixels = render(&v, w, h);
            assert!(has_color(&pixels, CARD) > 1000, "{w}x{h}");
        }
    }
}
