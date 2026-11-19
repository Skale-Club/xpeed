//! The catalog's later widgets: what each shows, as data. The flag, the fuel strategy, the tyre wear, the sectors and the
//! delta bar are made here from a reading (`Live`) and the laps saved, with no pixels, fonts or positions: `widgets_view.rs`
//! draws them, and the phone view will read the same models as JSON. The sums (the fuel table, the laps left on a set of
//! tyres, the best sectors, the delta bar's fill) are small pure functions with tests.

use super::*;

// The flag.

/// The flags a game shows. Not `crate::game::Flag` itself: this is the phone contract, with names in camelCase.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum FlagKind {
    Green,
    Yellow,
    Blue,
    White,
    Black,
    Chequered,
}

impl FlagKind {
    pub(super) fn of(flag: crate::game::Flag) -> FlagKind {
        use crate::game::Flag;
        match flag {
            Flag::Green => FlagKind::Green,
            Flag::Yellow => FlagKind::Yellow,
            Flag::Blue => FlagKind::Blue,
            Flag::White => FlagKind::White,
            Flag::Black => FlagKind::Black,
            Flag::Chequered => FlagKind::Chequered,
        }
    }

    fn word(self) -> Msg {
        match self {
            FlagKind::Green => Msg::PanelFlagGreen,
            FlagKind::Yellow => Msg::PanelFlagYellow,
            FlagKind::Blue => Msg::PanelFlagBlue,
            FlagKind::White => Msg::PanelFlagWhite,
            FlagKind::Black => Msg::PanelFlagBlack,
            FlagKind::Chequered => Msg::PanelFlagChequered,
        }
    }
}

/// The digiflag card: the flag as a block of its colour, with its word; nothing lit says "no flag".
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FlagCardModel {
    pub(super) show: Show,
    pub(super) title: String,
    /// The flag being shown; `None` when the game shows none.
    pub(super) kind: Option<FlagKind>,
    /// The flag's word in capitals (`YELLOW FLAG`), or `NO FLAG`.
    pub(super) word: String,
}

pub(super) fn flag_model(lang: Lang, flag: Option<crate::game::Flag>, show: Show) -> FlagCardModel {
    let kind = flag.map(FlagKind::of);
    let word = match kind {
        Some(kind) => text(lang, &kind.word()),
        None => text(lang, &Msg::PanelNoFlag),
    };
    FlagCardModel {
        show,
        title: text(lang, &Msg::PanelFlagTitle),
        kind,
        word: word.to_uppercase(),
    }
}

// The fuel strategy.

/// The numbers of laps the fuel table answers for.
pub(super) const FUEL_PLAN_LAPS: [u32; 4] = [5, 10, 15, 20];

/// One line of the fuel table: for `laps` laps, the litres needed (a lap of margin included) and the litres to put in on
/// top of what is in the tank. Nothing without a use per lap (or, for the litres to add, without the fuel now).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct FuelPlanRow {
    pub(super) laps: u32,
    pub(super) needed_l: Option<f32>,
    pub(super) to_add_l: Option<f32>,
}

pub(super) fn fuel_plan_rows(fuel_l: Option<f32>, per_lap_l: Option<f32>) -> [FuelPlanRow; 4] {
    let per = per_lap_l.filter(|p| p.is_finite() && *p > 0.0);
    let fuel = fuel_l.filter(|f| f.is_finite());
    FUEL_PLAN_LAPS.map(|laps| {
        let needed_l = per.map(|p| p * (laps + 1) as f32);
        FuelPlanRow {
            laps,
            needed_l,
            to_add_l: needed_l.zip(fuel).map(|(needed, now)| (needed - now.max(0.0)).max(0.0)),
        }
    })
}

/// A line of the fuel table, written.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FuelCalcRow {
    pub(super) laps: String,
    pub(super) needed: String,
    pub(super) to_add: String,
    /// Amber while fuel has to be added, green when the tank already holds enough, quiet without figures.
    pub(super) role: Role,
}

/// The fuel strategy card: the use per lap (average and last), the laps left in the tank and the table for 5, 10, 15 and
/// 20 laps.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FuelCalcModel {
    pub(super) show: Show,
    pub(super) title: String,
    /// The average use per lap, the last lap's use and the laps left, in this order.
    pub(super) stats: [Cell; 3],
    /// The table's heads: laps, litres needed, litres to add.
    pub(super) heads: [String; 3],
    pub(super) rows: Vec<FuelCalcRow>,
    /// Why the fuel to the end of the session is not there.
    pub(super) note: String,
}

/// What the fuel strategy card needs: the reading, the fuel now and the laps it lasts (as the fuel card has them) and how
/// they show.
pub(super) struct FuelCalcInput<'a> {
    pub(super) lang: Lang,
    pub(super) units: crate::config::Units,
    pub(super) live: &'a Live,
    pub(super) fuel_l: Option<f32>,
    pub(super) laps_left: Option<f32>,
    pub(super) laps_role: Role,
    pub(super) show: Show,
}

pub(super) fn fuel_calc_model(input: &FuelCalcInput) -> FuelCalcModel {
    let FuelCalcInput {
        lang,
        units,
        live,
        fuel_l,
        laps_left,
        laps_role,
        show,
    } = *input;
    let say = |msg: Msg| text(lang, &msg);
    let litres = |l: f32| format!("{} {}", fuel_text(l, units.fuel), units.fuel.label());
    let none = || "–".to_owned();
    let valid = |v: Option<f32>| v.filter(|v| v.is_finite() && *v > 0.0);
    let per_lap = valid(live.fuel_per_lap_l);
    let cell = |label: Msg, value: Option<String>, role: Role| Cell {
        label: say(label),
        value: value.unwrap_or_else(none),
        role,
        show,
    };
    let rows = fuel_plan_rows(fuel_l, per_lap)
        .iter()
        .map(|row| FuelCalcRow {
            laps: row.laps.to_string(),
            needed: row.needed_l.map_or_else(none, litres),
            to_add: row.to_add_l.map_or_else(none, litres),
            role: match row.to_add_l {
                Some(add) if add > 0.0 => Role::Warn,
                Some(_) => Role::Good,
                None => Role::Muted,
            },
        })
        .collect();
    FuelCalcModel {
        show,
        title: say(Msg::PanelFuelStrategy),
        stats: [
            cell(Msg::PanelFuelAverage, per_lap.map(litres), Role::Text),
            cell(Msg::PanelFuelLast, valid(live.fuel_last_lap_l).map(litres), Role::Text),
            cell(Msg::PanelLapsLeft, laps_left.map(|n| format!("{n:.1}")), laps_role),
        ],
        heads: [say(Msg::PanelLapsWord), say(Msg::PanelFuelNeed), say(Msg::PanelFuelAdd)],
        rows,
        note: say(Msg::PanelFuelToEndNote),
    }
}

// The tyre wear.

/// A tyre that wears less than this much of its tread per lap has no laps-left figure (it would be hundreds).
pub(super) const MIN_WEAR_PER_LAP: f32 = 0.0005;

/// How many laps the tread left (0..1) lasts at `wear_per_lap` of it per lap; nothing without both figures, or for a tyre
/// that does not wear.
pub(super) fn tyre_laps_left(left: f32, wear_per_lap: f32) -> Option<f32> {
    (left.is_finite() && wear_per_lap.is_finite() && wear_per_lap > MIN_WEAR_PER_LAP).then_some(left.max(0.0) / wear_per_lap)
}

/// The tyre that runs out first: the index of the smallest laps left, if any tyre has one.
pub(super) fn worst_tyre(laps_left: &[Option<f32>; 4]) -> Option<usize> {
    laps_left
        .iter()
        .enumerate()
        .filter_map(|(i, laps)| laps.map(|laps| (i, laps)))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
}

/// Under this many laps left a tyre is pressing (amber); under `TYRE_LOW_LAPS` it is critical (red).
pub(super) const TYRE_PRESSING_LAPS: f32 = 10.0;
pub(super) const TYRE_LOW_LAPS: f32 = 5.0;

/// Laps left written: a decimal while they are few, whole laps otherwise.
fn laps_left_text(laps: f32) -> String {
    if laps < TYRE_PRESSING_LAPS {
        format!("{laps:.1}")
    } else {
        format!("{laps:.0}")
    }
}

/// One tyre's line of the wear card.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TyreTrendRow {
    pub(super) corner: String,
    /// How much of the tread is left, 0..1.
    pub(super) tread: Option<f32>,
    /// The tread lost per lap (`1.8%`), or `–`.
    pub(super) wear: String,
    /// The laps the tread lasts at that rate, or `–`.
    pub(super) laps_left: String,
    pub(super) role: Role,
    /// The tyre that runs out first.
    pub(super) worst: bool,
}

/// The tyre wear card: per tyre the wear per lap (the last clean laps) and the laps left until the tread is gone.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TyreTrendModel {
    pub(super) show: Show,
    pub(super) title: String,
    /// The columns' heads: wear per lap, laps left.
    pub(super) heads: [String; 2],
    pub(super) rows: Vec<TyreTrendRow>,
    /// Said while no clean lap gave a wear per lap yet.
    pub(super) note: Option<String>,
}

pub(super) fn tyre_trend_model(lang: Lang, live: &Live, fresh: bool) -> TyreTrendModel {
    let say = |msg: Msg| text(lang, &msg);
    let now = live.tyres.filter(|t| t.iter().any(crate::game::Tyre::known));
    let tyres = now.or(live.last_seen.tyres);
    let known = |v: Option<f32>| v.filter(|v| v.is_finite());
    let tread: [Option<f32>; 4] = std::array::from_fn(|i| known(tyres.map(|t| t[i].left)).map(|left| left.clamp(0.0, 1.0)));
    let wear: [Option<f32>; 4] = std::array::from_fn(|i| known(live.tyre_wear_per_lap.map(|w| w[i])).map(|per| per.max(0.0)));
    let laps_left: [Option<f32>; 4] = std::array::from_fn(|i| tread[i].zip(wear[i]).and_then(|(left, per)| tyre_laps_left(left, per)));
    let worst = worst_tyre(&laps_left);
    let rows = (0..4)
        .map(|i| TyreTrendRow {
            corner: say(Msg::PanelTyreCorner(i as u8)),
            tread: tread[i],
            wear: wear[i].map_or_else(|| "–".to_owned(), |w| format!("{:.1}%", w * 100.0)),
            laps_left: laps_left[i].map_or_else(|| "–".to_owned(), laps_left_text),
            role: match laps_left[i] {
                Some(n) if n < TYRE_LOW_LAPS => Role::Danger,
                Some(n) if n < TYRE_PRESSING_LAPS => Role::Warn,
                Some(_) => Role::Text,
                None => Role::Muted,
            },
            worst: worst == Some(i),
        })
        .collect();
    TyreTrendModel {
        show: if fresh && now.is_some() { Show::Shown } else { Show::Dimmed },
        title: say(Msg::PanelTyreWear),
        heads: [say(Msg::PanelTyreWearPerLap), say(Msg::PanelLapsLeft)],
        rows,
        note: wear.iter().all(Option::is_none).then(|| say(Msg::PanelTyreWearWait)),
    }
}

// The sectors.

/// How a sector time compares: `Best` is the fastest of the run (purple), `Faster` beats the lap before (green), `Slower`
/// does not (yellow), `Plain` has nothing to compare with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum SectorTone {
    Plain,
    Best,
    Faster,
    Slower,
}

/// One sector as the card shows it: its time, whether that is the last lap's (the lap being driven has not got there
/// yet), how it compares, and the best time of that sector this run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SectorRead {
    pub(super) ms: Option<u32>,
    pub(super) from_last_lap: bool,
    pub(super) tone: SectorTone,
    pub(super) best_ms: Option<u32>,
}

/// The third sector of a lap: the lap's time less the first two; nothing unless the three are known and the third is
/// above zero.
pub(super) fn third_sector(lap_ms: Option<u32>, first: Option<u32>, second: Option<u32>) -> Option<u32> {
    let (lap, first, second) = (lap_ms?, first?, second?);
    lap.checked_sub(first)?.checked_sub(second).filter(|third| *third > 0)
}

/// The fastest time of each sector: over the laps saved that counted and the sectors the lap being driven has done.
pub(super) fn best_sectors(saved: &[SavedLap], current: [Option<u32>; 3]) -> [Option<u32>; 3] {
    std::array::from_fn(|i| {
        saved
            .iter()
            .filter(|lap| lap.valid)
            .filter_map(|lap| lap.sectors_ms.get(i).copied())
            .chain(current[i])
            .min()
    })
}

/// The best lap if every best sector came together; nothing until the three are known.
pub(super) fn theoretical_best(best: &[Option<u32>; 3]) -> Option<u32> {
    let [first, second, third] = *best;
    Some(first?.saturating_add(second?).saturating_add(third?))
}

/// The three sectors for the card: a sector the lap being driven has done is shown with that time and compared with the
/// same sector of the lap before; one it has not reached yet shows the lap before's time, and the third sector, known only
/// when a lap ends, always does.
pub(super) fn sector_reads(saved: &[SavedLap], current: [Option<u32>; 3], last: [Option<u32>; 3]) -> [SectorRead; 3] {
    let best = best_sectors(saved, current);
    std::array::from_fn(|i| {
        let (ms, from_last_lap) = match current[i] {
            Some(done) => (Some(done), false),
            None => (last[i], true),
        };
        let tone = match (ms, last[i]) {
            (Some(ms), _) if best[i] == Some(ms) => SectorTone::Best,
            (Some(ms), Some(before)) if !from_last_lap && ms < before => SectorTone::Faster,
            (Some(ms), Some(before)) if !from_last_lap && ms > before => SectorTone::Slower,
            _ => SectorTone::Plain,
        };
        SectorRead {
            ms,
            from_last_lap,
            tone,
            best_ms: best[i],
        }
    })
}

/// One row of the sectors card, written.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SectorRowModel {
    pub(super) label: String,
    pub(super) time: String,
    pub(super) best: String,
    pub(super) tone: SectorTone,
    pub(super) from_last_lap: bool,
}

/// The sectors card: S1, S2 and S3 against the best of each this run, the theoretical best lap and how far the best lap
/// is from it.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SectorsModel {
    pub(super) show: Show,
    pub(super) title: String,
    /// The head of the column of the best times.
    pub(super) best_head: String,
    pub(super) rows: Vec<SectorRowModel>,
    pub(super) theoretical_label: String,
    pub(super) theoretical: String,
    /// The best lap less the theoretical best (`-0.152`), and the words after it.
    pub(super) gap: Option<String>,
    pub(super) gap_label: String,
}

pub(super) fn sectors_model(lang: Lang, live: &Live, saved: &[SavedLap], fresh: bool) -> SectorsModel {
    let say = |msg: Msg| text(lang, &msg);
    let ms_of = |s: f64| (s.is_finite() && s > 0.0).then_some((s * 1000.0).round() as u32);
    let current = [live.sectors_ms[0], live.sectors_ms[1], None];
    let [first, second] = live.last_sectors_ms;
    let last = [first, second, third_sector(live.last_lap_s.and_then(ms_of), first, second)];
    let reads = sector_reads(saved, current, last);
    let best_lap_ms = fastest_valid(saved).into_iter().chain(live.best_lap_s.and_then(ms_of)).min();
    let best = reads.map(|read| read.best_ms);
    let theoretical = theoretical_best(&best);
    let none = || "–".to_owned();
    SectorsModel {
        show: if fresh { Show::Shown } else { Show::Dimmed },
        title: say(Msg::PanelSectors),
        best_head: say(Msg::PanelBestLap),
        rows: reads
            .iter()
            .enumerate()
            .map(|(i, read)| SectorRowModel {
                label: format!("S{}", i + 1),
                time: read.ms.map_or_else(none, sector_text),
                best: read.best_ms.map_or_else(none, sector_text),
                tone: read.tone,
                from_last_lap: read.from_last_lap,
            })
            .collect(),
        theoretical_label: say(Msg::PanelSectorTheoretical),
        theoretical: theoretical.map_or_else(none, |ms| lap_clock(Some(f64::from(ms) / 1000.0)).unwrap_or_else(none)),
        gap: best_lap_ms
            .zip(theoretical)
            .and_then(|(lap, theory)| delta_text(Some(-f64::from(lap.saturating_sub(theory)) / 1000.0))),
        gap_label: say(Msg::PanelVsBestLap),
    }
}

// The delta bar.

/// The bar runs this many seconds either side of zero; a delta beyond it fills the bar and no more.
pub(super) const DELTA_BAR_RANGE_S: f64 = 2.0;

/// Where the delta's fill ends along the bar, 0..1 with the middle (0.5) at zero: left of it faster, right slower. A
/// delta past the range is clamped; no delta is the middle.
pub(super) fn delta_bar_frac(delta_s: Option<f64>) -> f32 {
    match delta_s.filter(|d| d.is_finite()) {
        Some(d) => 0.5 + (d / DELTA_BAR_RANGE_S).clamp(-1.0, 1.0) as f32 / 2.0,
        None => 0.5,
    }
}

/// The delta card: the delta as a number over a wide bar centred on zero.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeltaBarModel {
    pub(super) show: Show,
    pub(super) title: String,
    /// `vs best lap`.
    pub(super) caption: String,
    /// `-0.270`, or `–` while there is no delta.
    pub(super) value: String,
    pub(super) role: Role,
    /// Where the fill ends, 0..1, the middle at zero (`delta_bar_frac`).
    pub(super) frac: f32,
}

/// From the delta the times card already has (`delta`: its text, its meaning and how it shows) and the reading's own.
pub(super) fn delta_bar_model(lang: Lang, live: &Live, delta: &Elem) -> DeltaBarModel {
    let say = |msg: Msg| text(lang, &msg);
    let known = delta.visible();
    DeltaBarModel {
        show: if known { delta.show } else { Show::Dimmed },
        title: say(Msg::PanelDeltaTitle),
        caption: say(Msg::PanelVsBestLap),
        value: if known { delta.text.clone() } else { "–".to_owned() },
        role: if known { delta.role } else { Role::Muted },
        frac: if known { delta_bar_frac(live.delta_s) } else { 0.5 },
    }
}
