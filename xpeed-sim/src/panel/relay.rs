//! What the phone view is sent (`phone.rs` sends it): the dashboard in use, its rows for a phone held upright as the catalog's widget
//! ids and the very model the panel draws, as JSON (what a page of before the picture draws), and, while a phone is watching, the
//! picture of the panel itself drawn for that phone's screen: the same header, cards and fonts as on the PC, only laid out for the
//! phone (`PhoneShape`), as a JPEG. Built from the reading and the laps without a window.

use std::path::PathBuf;

use super::*;
use crate::phone;

/// How often the dashboards the person chose by hand are read from `dashboards.json` again.
const CHOICES_EVERY_MS: i64 = 1000;

/// The rows of `dashboard` for the phone (the portrait layout) as widget ids: the cards the game can fill, the pairs as the dashboard
/// defines them, and no row with nothing left in it.
pub(super) fn phone_rows_in(views: &Views, dashboard: DashboardId, slots: &Slots) -> Vec<Vec<&'static str>> {
    views
        .rows_for(dashboard, Layout::Portrait)
        .rows
        .iter()
        .map(|row| {
            row.cards
                .iter()
                .filter(|(pane, _)| slots.cards.contains(pane))
                .map(|(pane, _)| catalog::id_of(*pane))
                .collect::<Vec<_>>()
        })
        .filter(|ids| !ids.is_empty())
        .collect()
}

/// Where the cards of `dashboard` sit on a phone held as `shape` says, placed the way the panel places a layout's cards
/// (`Layout::plan_view`): under the panel's header (`CARDS_TOP`), only the cards the game can fill, a row with none left goes, the
/// laps table's row as tall as its laps.
pub(super) fn phone_plan(dashboard: DashboardId, shape: PhoneShape, slots: &Slots, lap_rows: usize) -> Plan {
    let w = shape.width();
    let present: Vec<(f32, Vec<(Pane, f32)>)> = phone_shape_rows(dashboard, shape)
        .iter()
        .map(|row| {
            let cards = row
                .cards
                .iter()
                .copied()
                .filter(|(c, _)| slots.cards.contains(c))
                .collect::<Vec<_>>();
            (row.h, cards)
        })
        .filter(|(_, cards)| !cards.is_empty())
        .collect();
    let heights = row_heights(
        &present
            .iter()
            .map(|(h, c)| (*h, c.iter().map(|c| c.0).collect()))
            .collect::<Vec<_>>(),
        lap_rows,
    );
    let mut cards = Vec::new();
    let mut y = CARDS_TOP;
    for ((_, row_cards), h) in present.iter().zip(heights) {
        for ((pane, _), (x, cw)) in row_cards.iter().zip(row_places(0.0, w, GAP, row_cards)) {
            cards.push((*pane, (x, y, cw, h)));
        }
        y += h + GAP;
    }
    Plan {
        w,
        h: if cards.is_empty() { y } else { y - GAP },
        cards,
    }
}

/// The most pixels a phone picture has across (a sanity bound: a big tablet at 2x).
const PICTURE_MAX_PX: f32 = 2400.0;
/// The phone's pixels per CSS pixel the picture is drawn at, at most: sharp on a phone, light enough to send ten times a second.
const PICTURE_MAX_DPR: f32 = 1.5;
/// The JPEG quality of the picture.
const PICTURE_QUALITY: u8 = 70;

/// The size of the picture for a screen (pixels) and the scale the panel is drawn at in it: the phone layout scaled to fit the
/// screen's room at its pixels per CSS pixel (at most `PICTURE_MAX_DPR`).
pub(super) fn picture_size(plan: &Plan, screen: phone::Screen) -> (i32, i32, f32) {
    let k = if screen.dpr.is_finite() {
        screen.dpr.clamp(1.0, PICTURE_MAX_DPR)
    } else {
        1.0
    };
    let (room_w, room_h) = (screen.w as f32 * k, screen.h as f32 * k);
    let s = (room_w / plan.w).min(room_h / plan.h).min(PICTURE_MAX_PX / plan.w.max(plan.h));
    let (w, h) = ((plan.w * s).round().max(1.0), (plan.h * s).round().max(1.0));
    (w as i32, h as i32, s)
}

/// The panel drawn for a phone's screen: the dashboard in use with its phone layout, the panel's own header, cards and banner,
/// as the PC draws them (BGRA, top row first), with its width and height. `None` when the screen is not a size to draw.
pub(super) fn phone_pixels(
    live: &Live,
    ctx: &ModelCtx,
    dashboard: DashboardId,
    views: &Views,
    brands: &[BrandArt],
    screen: phone::Screen,
) -> Option<(Vec<u8>, i32, i32)> {
    if screen.w < 50 || screen.h < 50 {
        return None;
    }
    let m = super::model::dashboard(live, ctx);
    let slots = slots(live.caps);
    let shape = PhoneShape::of(screen.w as f32, screen.h as f32);
    let plan = phone_plan(dashboard, shape, &slots, m.laps.rows.len());
    if plan.cards.is_empty() {
        return None;
    }
    let (w, h, s) = picture_size(&plan, screen);
    let snapshot = Snapshot {
        game: Game::Waiting,
        title: None,
        cloud: Cloud::Idle,
        laps_saved: 0,
        last_lap: None,
    };
    let update = crate::update::UpdateState::default();
    let check = crate::update::CheckState::default();
    let view = View {
        lang: ctx.lang,
        units: ctx.units,
        prefs: Prefs::default(),
        tab: Tab::Dash,
        on_top: false,
        full: false,
        scale: s,
        now_ms: ctx.now_ms,
        snapshot: &snapshot,
        live: Some(live),
        games: &[],
        device: None,
        server: "",
        card: crate::connect::card(false, &crate::connect::Phase::Idle, None),
        coach_available: false,
        recent_laps: ctx.laps,
        activity: &[],
        covers: &[],
        brands,
        mouse: None,
        buttons: Default::default(),
        carousel: 0.0,
        games_scroll: 0.0,
        carousel_step: Default::default(),
        layout: Default::default(),
        dashboard: Some(dashboard),
        views,
        edit: None,
        edit_xf: Default::default(),
        phone_viewers: 0,
        lang_open: false,
        workspace_open: false,
        workspace_reset_until: 0,
        copied: false,
        failed: "",
        update: &update,
        check: &check,
        download_percent: None,
        focus: None,
        played: Default::default(),
        scroll: Default::default(),
        preview: None,
    };
    let d = Dash {
        live,
        view: &view,
        m: &m,
        slots: &slots,
    };
    let pixels = offscreen(w, h, |hdc| {
        let mut g = Painter::new(hdc, s);
        g.backdrop(w, h);
        let (fit, ox, oy) = canvas_fit_wh(rect(0, 0, w, h), plan.w, plan.h);
        g.place(fit, ox, oy);
        super::dash_view::header(&mut g, &d, plan.w);
        for &(card, area) in &plan.cards {
            card_frame(&mut g, area);
            draw_pane(&mut g, &d, card, area, &plan.cards);
        }
        if let Some(target) = banner_target(&plan) {
            banner(&mut g, &d, target);
        }
    })?;
    Some((pixels, w, h))
}

/// Draws into a bitmap of `w` x `h` off any window and gives back its pixels (BGRA, top row first).
fn offscreen(w: i32, h: i32, draw: impl FnOnce(HDC)) -> Option<Vec<u8>> {
    use windows_sys::Win32::Graphics::Gdi::{CreateDIBSection, GdiFlush, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS};
    unsafe {
        let hdc = CreateCompatibleDC(null_mut());
        if hdc.is_null() {
            return None;
        }
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
        if bitmap.is_null() || bits.is_null() {
            DeleteDC(hdc);
            return None;
        }
        let old = SelectObject(hdc, bitmap);
        draw(hdc);
        GdiFlush();
        let pixels = std::slice::from_raw_parts(bits.cast::<u8>(), (w * h * 4) as usize).to_vec();
        SelectObject(hdc, old);
        DeleteObject(bitmap);
        DeleteDC(hdc);
        Some(pixels)
    }
}

/// The picture as JPEG bytes.
pub(super) fn phone_jpeg(
    live: &Live,
    ctx: &ModelCtx,
    dashboard: DashboardId,
    views: &Views,
    brands: &[BrandArt],
    screen: phone::Screen,
) -> Option<Vec<u8>> {
    let (bgra, w, h) = phone_pixels(live, ctx, dashboard, views, brands, screen)?;
    let rgb: Vec<u8> = bgra.as_chunks::<4>().0.iter().flat_map(|p| [p[2], p[1], p[0]]).collect();
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, PICTURE_QUALITY)
        .encode(&rgb, u16::try_from(w).ok()?, u16::try_from(h).ok()?, jpeg_encoder::ColorType::Rgb)
        .ok()?;
    Some(jpeg)
}

/// The picture as a JPEG data URL (what the phone's page shows as it is).
pub(super) fn phone_picture(
    live: &Live,
    ctx: &ModelCtx,
    dashboard: DashboardId,
    views: &Views,
    brands: &[BrandArt],
    screen: phone::Screen,
) -> Option<String> {
    let jpeg = phone_jpeg(live, ctx, dashboard, views, brands, screen)?;
    Some(format!("data:image/jpeg;base64,{}", base64(&jpeg)))
}

/// Standard base64 (with padding).
fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ABC[(n >> 18) as usize & 63] as char);
        out.push(ABC[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ABC[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 { ABC[n as usize & 63] as char } else { '=' });
    }
    out
}

/// `phone_rows_in` with the built-in rows.
#[cfg(test)]
pub(super) fn phone_rows(dashboard: DashboardId, slots: &Slots) -> Vec<Vec<&'static str>> {
    phone_rows_in(&Views::default(), dashboard, slots)
}

/// `build_frame_with` with the built-in rows.
#[cfg(test)]
pub(super) fn build_frame(live: &Live, game: &str, ctx: &ModelCtx, manual: Option<DashboardId>) -> Option<phone::Frame> {
    build_frame_with(live, game, ctx, manual, &Views::default(), None)
}

/// The frame for a reading: the dashboard the person chose for the game, else the one that fits the session, and its picture for
/// `picture`'s screen (with the car brands its header draws) when a phone is watching; nothing when the reading is not live or `game`
/// is not an id the server takes.
pub(super) fn build_frame_with(
    live: &Live,
    game: &str,
    ctx: &ModelCtx,
    manual: Option<DashboardId>,
    views: &Views,
    picture: Option<(phone::Screen, &[BrandArt])>,
) -> Option<phone::Frame> {
    if !phone::valid_game(game) || !fresh(live, ctx.now_ms) {
        return None;
    }
    let in_use = pick(live.session_kind, live.time_trial, manual);
    let model = serde_json::to_value(dashboard(live, ctx)).ok()?;
    let image = picture.and_then(|(screen, brands)| phone_picture(live, ctx, in_use, views, brands, screen));
    Some(phone::Frame {
        game: game.to_owned(),
        dashboard: in_use.id(),
        rows: phone_rows_in(views, in_use, &slots(live.caps)),
        image,
        model,
    })
}

/// The id the server knows a game by, from the name the reading carries.
fn server_game(shared: &Shared, name: &str) -> Option<String> {
    let named = shared
        .games()
        .into_iter()
        .find(|(_, title, _)| *title == name)
        .map(|(id, _, _)| id.to_owned());
    named.or_else(|| shared.heartbeat_view().game.map(str::to_owned))
}

/// The make marks for the phone's picture. GDI+ images are not tied to the thread that made them; these are only ever drawn by
/// the one thread that holds the relay (the phone view's sender, behind the relay's lock), never at the same time as anything else.
struct Brands(Vec<BrandArt>);

// SAFETY: see `Brands`: one thread at a time, behind the relay's mutex; GDI+ is started for the whole process (`gdiplus_ready`).
unsafe impl Send for Brands {}

/// Turns what the panel shows into the frames of the phone view. The dashboards chosen by hand (`D` in the panel) are read from the
/// file now and then, so a choice made in the panel reaches the phone.
pub(crate) struct Relay {
    home: Option<PathBuf>,
    choices: Choices,
    /// The views saved in the panel: the phone gets the Portrait one.
    views: Views,
    /// The car brands the panel's header draws, read once.
    brands: Brands,
    read_at: Option<i64>,
}

impl Relay {
    pub(crate) fn new(home: Option<PathBuf>) -> Relay {
        Relay {
            home,
            choices: Choices::default(),
            views: Views::default(),
            brands: Brands(Vec::new()),
            read_at: None,
        }
    }

    /// The frame for what the panel shows now, in the app's language and units; nothing while no game is live.
    pub(crate) fn frame(&mut self, shared: &Shared, lang: Lang, units: crate::config::Units, now_ms: i64) -> Option<phone::Frame> {
        let live = shared.live()?;
        if !fresh(&live, now_ms) {
            return None;
        }
        let game = server_game(shared, live.game)?;
        if self.read_at.is_none_or(|at| now_ms - at >= CHOICES_EVERY_MS) {
            if let Some(home) = &self.home {
                self.choices = Choices::load(home);
                self.views = Views::load(home);
            }
            if self.read_at.is_none() {
                self.brands = Brands(BrandArt::load());
            }
            self.read_at = Some(now_ms);
        }
        let laps = shared.recent_laps();
        let ctx = ModelCtx {
            lang,
            now_ms,
            units,
            laps: &laps,
        };
        // The picture only while a phone is watching and has said its screen's size.
        let picture = phone::screen().map(|screen| (screen, self.brands.0.as_slice()));
        build_frame_with(&live, &game, &ctx, self.choices.get(live.game), &self.views, picture)
    }
}
