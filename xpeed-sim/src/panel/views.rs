//! Saved views: the driver's own layout of a dashboard, one per window shape, kept as data in `dashboards.json` next to the
//! per-game manual choice (`"views": { "<dashboard id>": { "<layout key>": { "rows": [ { "h": 300, "cards": [["times", 1.0]] } ] } } }`).
//!
//! A view is the same thing as the built-in rows (rows of cards with a share each and a height) but owned, so it can be
//! edited. The panel draws the saved view when there is one, else the built-in rows (`Views::rows_for`). Loading checks
//! everything: a damaged file never fails, it only means defaults (`sanitise`). The limits an edit has to keep (the least
//! size of a card, the most cards in a row) are here too, in one place, and `check_view` says whether a view keeps them.
//!
//! Not every function is used until the panel's edit mode is built on top of them.
#![allow(dead_code)]

use super::*;
use std::collections::BTreeMap;
use std::path::Path;

/// The window shapes by the key the file names them with.
pub(super) const LAYOUT_KEYS: [(Layout, &str); 6] = [
    (Layout::Classic, "classic"),
    (Layout::Ultrawide, "ultrawide"),
    (Layout::Wide, "wide"),
    (Layout::Square, "square"),
    (Layout::Portrait, "portrait"),
    (Layout::Stack, "stack"),
];

pub(super) fn layout_key(layout: Layout) -> &'static str {
    LAYOUT_KEYS.iter().find(|(l, _)| *l == layout).map_or("classic", |(_, k)| *k)
}

pub(super) fn layout_from_key(key: &str) -> Option<Layout> {
    LAYOUT_KEYS.iter().find(|(_, k)| *k == key).map(|(l, _)| *l)
}

/// At most this many rows in a view and cards in a row.
pub(super) const VIEW_MAX_ROWS: usize = 12;
pub(super) const VIEW_MAX_CARDS: usize = 6;

/// A card's share of its row is kept between these (the widths follow the shares' proportions, so only the proportions matter).
pub(super) const SHARE_MIN: f32 = 0.25;
pub(super) const SHARE_MAX: f32 = 6.0;

/// A row's height in design units: never under `ROW_H_MIN` (or the tallest least height of its cards), never over `ROW_H_MAX`.
pub(super) const ROW_H_MIN: f32 = 80.0;
pub(super) const ROW_H_MAX: f32 = 900.0;

/// The least width of a card (design units). The narrowest card of a built-in dashboard is the inputs card at 156 in the
/// Square and Classic shapes, so 150 keeps every built-in view valid.
pub(super) const CARD_W_MIN: f32 = 150.0;
/// The centre card (the gear) never gets narrower than this; the narrowest the built-in dashboards give it is 204 (Square and
/// Classic). The gear's size follows the card's height, so the height is what keeps it big (`CENTRE_H_MIN`).
pub(super) const CENTRE_W_MIN: f32 = 200.0;
/// The centre card's least height: with it the gear is still half the card's inside (`GEAR_MIN_SHARE`, 124 of 236 design units).
pub(super) const CENTRE_H_MIN: f32 = 260.0;
/// The alerts card's least height in a view. The built-in Portrait shape gives it 210, under what the card likes
/// (`ALERTS_NEED_H`); it is drawn at its row's height all the same.
pub(super) const ALERTS_H_MIN: f32 = 210.0;

/// How far a number may be off before a limit counts as broken (float noise).
pub(super) const VIEW_EPS: f32 = 0.01;

/// The least width of a card.
pub(super) fn card_min_w(pane: Pane) -> f32 {
    if pane == Pane::Centre {
        CENTRE_W_MIN
    } else {
        CARD_W_MIN
    }
}

/// The least height of a card: what its widget needs (`need_h`), and for the first seven what the built-in dashboards give them.
pub(super) fn card_min_h(pane: Pane) -> f32 {
    match pane {
        Pane::Times => 200.0,
        Pane::Centre => CENTRE_H_MIN,
        Pane::Inputs => 130.0,
        Pane::Fuel => 180.0,
        Pane::Tyres => 220.0,
        Pane::Laps => laps_card_h(1),
        Pane::Track => TRACK_NEED_H,
        Pane::Alerts => ALERTS_H_MIN,
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
        Pane::DeltaRef => DELTA_REF_NEED_H,
    }
}

/// The least height of a row: the tallest least height of its cards.
pub(super) fn row_min_h(cards: &[(Pane, f32)]) -> f32 {
    cards.iter().map(|c| card_min_h(c.0)).fold(ROW_H_MIN, f32::max)
}

/// A row of a view: its height and its cards with the share each takes.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct OwnedRow {
    pub(super) h: f32,
    pub(super) cards: Vec<(Pane, f32)>,
}

/// A layout of one dashboard in one window shape, as rows.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct SavedView {
    pub(super) rows: Vec<OwnedRow>,
}

impl SavedView {
    pub(super) fn from_rows(rows: &[Row]) -> SavedView {
        SavedView {
            rows: rows
                .iter()
                .map(|row| OwnedRow {
                    h: row.h,
                    cards: row.cards.to_vec(),
                })
                .collect(),
        }
    }

    /// The built-in rows of a dashboard in a window shape.
    pub(super) fn default_for(dashboard: DashboardId, layout: Layout) -> SavedView {
        SavedView::from_rows(builtin(dashboard).rows_for(layout))
    }

    /// Every card of the view, in the order the rows hold them.
    pub(super) fn panes(&self) -> Vec<Pane> {
        self.rows.iter().flat_map(|r| r.cards.iter().map(|c| c.0)).collect()
    }
}

/// The widths of the cards of a row from their shares, given the room left by the gaps.
fn widths_of(cards: &[(Pane, f32)], room: f32) -> Vec<f32> {
    let sum: f32 = cards.iter().map(|c| c.1).sum();
    cards.iter().map(|c| room * c.1 / sum).collect()
}

/// Makes the shares of a row keep every card at its least width (taking the width from the others, in proportion, when a
/// card is too narrow) and inside `SHARE_MIN..=SHARE_MAX`. Only the shares change, and only when they have to: a row that
/// keeps its limits is left exactly as it is. `false` (nothing changed) when the cards cannot all have their least width in
/// a canvas `total_w` wide.
pub(super) fn settle_row(cards: &mut [(Pane, f32)], total_w: f32) -> bool {
    let n = cards.len();
    if n == 0 {
        return true;
    }
    let room = total_w - GAP * (n as f32 - 1.0);
    let mins: Vec<f32> = cards.iter().map(|c| card_min_w(c.0)).collect();
    if mins.iter().sum::<f32>() > room + VIEW_EPS {
        return false;
    }
    let mut shares: Vec<(Pane, f32)> = cards.to_vec();
    if shares.iter().any(|c| !c.1.is_finite() || c.1 <= 0.0) {
        for c in &mut shares {
            c.1 = 1.0;
        }
    }
    let mut widths = widths_of(&shares, room);
    let wide_enough = widths.iter().zip(&mins).all(|(w, m)| *w >= *m - 0.001);
    let in_range = shares.iter().all(|c| (SHARE_MIN - 0.0005..=SHARE_MAX + 0.0005).contains(&c.1));
    if wide_enough && in_range && shares == cards {
        return true;
    }
    if !wide_enough {
        // The cards that would be too narrow are held at their least width; the rest share what is left, in proportion.
        let mut held = vec![false; n];
        widths = loop {
            let held_sum: f32 = mins.iter().zip(&held).filter(|(_, h)| **h).map(|(m, _)| *m).sum();
            let free_share: f32 = shares.iter().zip(&held).filter(|(_, h)| !**h).map(|(c, _)| c.1).sum();
            if free_share <= 0.0 {
                break mins.clone();
            }
            let free_room = room - held_sum;
            let mut changed = false;
            for ((c, m), h) in shares.iter().zip(&mins).zip(held.iter_mut()) {
                if !*h && free_room * c.1 / free_share < *m - 0.001 {
                    *h = true;
                    changed = true;
                }
            }
            if !changed {
                break shares
                    .iter()
                    .zip(&mins)
                    .zip(&held)
                    .map(|((c, m), h)| if *h { *m } else { free_room * c.1 / free_share })
                    .collect::<Vec<f32>>();
            }
        };
    }
    // Back to shares, scaled so the narrowest and the widest sit as far from the limits as each other.
    let (lo, hi) = widths.iter().fold((f32::MAX, 0.0_f32), |(lo, hi), w| (lo.min(*w), hi.max(*w)));
    let k = (SHARE_MIN * SHARE_MAX / (lo * hi)).sqrt();
    for (c, w) in cards.iter_mut().zip(&widths) {
        c.1 = *w * k;
    }
    true
}

/// Whether a view keeps every limit in a window shape; the first one it breaks, in words.
pub(super) fn check_view(view: &SavedView, layout: Layout) -> Result<(), String> {
    if view.rows.is_empty() {
        return Err("no rows".into());
    }
    if view.rows.len() > VIEW_MAX_ROWS {
        return Err(format!("{} rows", view.rows.len()));
    }
    let mut seen: Vec<Pane> = Vec::new();
    for (r, row) in view.rows.iter().enumerate() {
        let n = row.cards.len();
        if n == 0 || n > VIEW_MAX_CARDS {
            return Err(format!("row {r} has {n} cards"));
        }
        if !row.h.is_finite() || row.h > ROW_H_MAX + VIEW_EPS || row.h + VIEW_EPS < row_min_h(&row.cards) {
            return Err(format!("row {r} is {} tall (least {})", row.h, row_min_h(&row.cards)));
        }
        let room = layout.width() - GAP * (n as f32 - 1.0);
        let sum: f32 = row.cards.iter().map(|c| c.1).sum();
        for (pane, share) in &row.cards {
            if !catalog::ALL.iter().any(|w| w.pane == *pane) {
                return Err(format!("{pane:?} is not in the catalog"));
            }
            if seen.contains(pane) {
                return Err(format!("{pane:?} twice"));
            }
            seen.push(*pane);
            if !share.is_finite() || *share <= 0.0 || !(SHARE_MIN - VIEW_EPS..=SHARE_MAX + VIEW_EPS).contains(share) {
                return Err(format!("{pane:?} has the share {share}"));
            }
            let w = room * share / sum;
            if w + VIEW_EPS < card_min_w(*pane) {
                return Err(format!("{pane:?} is {w} wide (least {})", card_min_w(*pane)));
            }
        }
    }
    Ok(())
}

/// Makes rows of anything (a damaged file's) into a view that passes `check_view`: shares that are not numbers become 1 and
/// all are clamped, heights are clamped and raised to what their cards need, a row too full (or whose cards cannot all
/// have their least width) hands its last cards to a new row after it, empty rows go, and past 12 rows the rest is dropped.
/// `None` when nothing is left. (Unknown ids and a card seen twice are dropped when the rows are read.)
pub(super) fn sanitise(rows: Vec<OwnedRow>, layout: Layout) -> Option<SavedView> {
    let width = layout.width();
    let mut queue: std::collections::VecDeque<OwnedRow> = rows
        .into_iter()
        .filter(|r| !r.cards.is_empty())
        .map(|mut r| {
            for c in &mut r.cards {
                c.1 = if c.1.is_finite() && c.1 > 0.0 {
                    c.1.clamp(SHARE_MIN, SHARE_MAX)
                } else {
                    1.0
                };
            }
            r
        })
        .collect();
    let mut out: Vec<OwnedRow> = Vec::new();
    while let Some(mut row) = queue.pop_front() {
        if out.len() >= VIEW_MAX_ROWS {
            break;
        }
        let mut spill = Vec::new();
        while row.cards.len() > 1 && (row.cards.len() > VIEW_MAX_CARDS || !settle_row(&mut row.cards, width)) {
            if let Some(card) = row.cards.pop() {
                spill.insert(0, card);
            }
        }
        if !spill.is_empty() {
            queue.push_front(OwnedRow { h: row.h, cards: spill });
        }
        let h = if row.h.is_finite() {
            row.h.clamp(ROW_H_MIN, ROW_H_MAX)
        } else {
            ROW_H_MIN
        };
        row.h = h.max(row_min_h(&row.cards)).min(ROW_H_MAX);
        out.push(row);
    }
    (!out.is_empty()).then_some(SavedView { rows: out })
}

/// Reads one view from its JSON (`{ "rows": [ { "h": .., "cards": [[id, share], ..] } ] }`), dropping what it cannot read
/// and a card seen twice, then `sanitise`.
fn parse_view(value: &serde_json::Value, layout: Layout) -> Option<SavedView> {
    let rows = value.get("rows")?.as_array()?;
    let mut seen: Vec<Pane> = Vec::new();
    let mut out: Vec<OwnedRow> = Vec::new();
    for row in rows {
        let Some(cards_json) = row.get("cards").and_then(|c| c.as_array()) else {
            continue;
        };
        let h = row.get("h").and_then(|h| h.as_f64()).map_or(f32::NAN, |h| h as f32);
        let mut cards = Vec::new();
        for card in cards_json {
            let Some(pair) = card.as_array() else {
                continue;
            };
            let Some(pane) = pair.first().and_then(|id| id.as_str()).and_then(catalog::by_id) else {
                continue;
            };
            if seen.contains(&pane) {
                continue;
            }
            seen.push(pane);
            let share = pair.get(1).and_then(|s| s.as_f64()).map_or(1.0, |s| s as f32);
            cards.push((pane, share));
        }
        if !cards.is_empty() {
            out.push(OwnedRow { h, cards });
        }
    }
    sanitise(out, layout)
}

fn view_to_json(view: &SavedView) -> serde_json::Value {
    let rows: Vec<serde_json::Value> = view
        .rows
        .iter()
        .map(|row| {
            let cards: Vec<serde_json::Value> = row
                .cards
                .iter()
                .map(|(pane, share)| serde_json::json!([catalog::id_of(*pane), f64::from(*share)]))
                .collect();
            serde_json::json!({ "h": f64::from(row.h), "cards": cards })
        })
        .collect();
    serde_json::json!({ "rows": rows })
}

/// The views the driver saved, per dashboard and window shape. A view equal to the built-in rows is not kept (nothing is
/// modified then).
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Views(BTreeMap<(&'static str, &'static str), SavedView>);

impl Views {
    pub(super) fn get(&self, dashboard: DashboardId, layout: Layout) -> Option<&SavedView> {
        self.0.get(&(dashboard.id(), layout_key(layout)))
    }

    /// The rows to draw: the saved view, else the built-in rows.
    pub(super) fn rows_for(&self, dashboard: DashboardId, layout: Layout) -> SavedView {
        self.get(dashboard, layout)
            .cloned()
            .unwrap_or_else(|| SavedView::default_for(dashboard, layout))
    }

    /// Keeps `view` as the driver's layout (or, when it is the built-in one, forgets any saved view).
    pub(super) fn set(&mut self, dashboard: DashboardId, layout: Layout, view: SavedView) {
        let key = (dashboard.id(), layout_key(layout));
        if view == SavedView::default_for(dashboard, layout) {
            self.0.remove(&key);
        } else {
            self.0.insert(key, view);
        }
    }

    /// Back to the built-in rows: of one window shape, or (`None`) of all of them.
    pub(super) fn reset(&mut self, dashboard: DashboardId, layout: Option<Layout>) {
        match layout {
            Some(layout) => {
                self.0.remove(&(dashboard.id(), layout_key(layout)));
            }
            None => self.0.retain(|key, _| key.0 != dashboard.id()),
        }
    }

    /// The dashboard has a saved view in some window shape (the dot after its name).
    pub(super) fn is_modified(&self, dashboard: DashboardId) -> bool {
        self.0.keys().any(|key| key.0 == dashboard.id())
    }

    /// The dashboard has a saved view in this window shape.
    pub(super) fn is_modified_in(&self, dashboard: DashboardId, layout: Layout) -> bool {
        self.get(dashboard, layout).is_some()
    }

    /// The views of the file's `"views"` value; what cannot be read is left out, never an error.
    pub(super) fn from_value(value: &serde_json::Value) -> Views {
        let mut views = Views::default();
        let Some(dashboards) = value.as_object() else {
            return views;
        };
        for (id, layouts) in dashboards {
            let (Some(dashboard), Some(layouts)) = (DashboardId::from_id(id), layouts.as_object()) else {
                continue;
            };
            for (key, json) in layouts {
                let Some(layout) = layout_from_key(key) else {
                    continue;
                };
                if let Some(view) = parse_view(json, layout) {
                    views.set(dashboard, layout, view);
                }
            }
        }
        views
    }

    /// The views of a file's text; text that is not a dashboards file means no views.
    pub(super) fn parse(text: &str) -> Views {
        serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|file| file.get("views").map(Views::from_value))
            .unwrap_or_default()
    }

    pub(super) fn to_value(&self) -> serde_json::Value {
        let mut dashboards = serde_json::Map::new();
        for ((dashboard, layout), view) in &self.0 {
            let entry = dashboards
                .entry((*dashboard).to_owned())
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let Some(layouts) = entry.as_object_mut() {
                layouts.insert((*layout).to_owned(), view_to_json(view));
            }
        }
        serde_json::Value::Object(dashboards)
    }

    /// Reads the file; a missing or damaged one means no saved views, never an error.
    pub(super) fn load(home: &Path) -> Views {
        read_file(home).get("views").map(Views::from_value).unwrap_or_default()
    }

    /// Writes the views into the file, keeping its other keys (the manual choices).
    pub(super) fn save(&self, home: &Path) -> Result<(), String> {
        write_key(home, "views", self.to_value())
    }
}
