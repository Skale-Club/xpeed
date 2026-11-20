//! What the phone view is sent (`phone.rs` sends it): the dashboard in use, its rows for a phone held upright as the catalog's widget
//! ids, and the very model the panel draws, as JSON. Built from the reading and the laps without a window.

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

/// `phone_rows_in` with the built-in rows.
#[cfg(test)]
pub(super) fn phone_rows(dashboard: DashboardId, slots: &Slots) -> Vec<Vec<&'static str>> {
    phone_rows_in(&Views::default(), dashboard, slots)
}

/// `build_frame_with` with the built-in rows.
#[cfg(test)]
pub(super) fn build_frame(live: &Live, game: &str, ctx: &ModelCtx, manual: Option<DashboardId>) -> Option<phone::Frame> {
    build_frame_with(live, game, ctx, manual, &Views::default())
}

/// The frame for a reading: the dashboard the person chose for the game, else the one that fits the session; nothing when the reading is
/// not live or `game` is not an id the server takes.
pub(super) fn build_frame_with(
    live: &Live,
    game: &str,
    ctx: &ModelCtx,
    manual: Option<DashboardId>,
    views: &Views,
) -> Option<phone::Frame> {
    if !phone::valid_game(game) || !fresh(live, ctx.now_ms) {
        return None;
    }
    let in_use = pick(live.session_kind, live.time_trial, manual);
    let model = serde_json::to_value(dashboard(live, ctx)).ok()?;
    Some(phone::Frame {
        game: game.to_owned(),
        dashboard: in_use.id(),
        rows: phone_rows_in(views, in_use, &slots(live.caps)),
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

/// Turns what the panel shows into the frames of the phone view. The dashboards chosen by hand (`D` in the panel) are read from the
/// file now and then, so a choice made in the panel reaches the phone.
pub(crate) struct Relay {
    home: Option<PathBuf>,
    choices: Choices,
    /// The views saved in the panel: the phone gets the Portrait one.
    views: Views,
    read_at: Option<i64>,
}

impl Relay {
    pub(crate) fn new(home: Option<PathBuf>) -> Relay {
        Relay {
            home,
            choices: Choices::default(),
            views: Views::default(),
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
            self.read_at = Some(now_ms);
        }
        let laps = shared.recent_laps();
        let ctx = ModelCtx {
            lang,
            now_ms,
            units,
            laps: &laps,
        };
        build_frame_with(&live, &game, &ctx, self.choices.get(live.game), &self.views)
    }
}
