//! The catalog's later widgets: what each shows, as data. The flag, the fuel strategy, the tyre wear, the sectors and the
//! delta bar are made here from a reading (`Live`) and the laps saved, with no pixels, fonts or positions: `widgets_view.rs`
//! draws them, and the phone view will read the same models as JSON. The sums (the fuel table, the laps left on a set of
//! tyres, the best sectors, the delta bar's fill) are small pure functions with tests.

use super::*;
use crate::field::{Car, Field};

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

/// How many laps are left to drive, counting the lap being driven for what is left of it: for a lap-based session its laps
/// less those done (and the share of this lap already driven, when the track's length is known); for a timed one the laps
/// that fit in the time left at the last lap's pace (else the best lap's), plus the lap finished after the time runs out.
/// With both given the session ends at the first, so the smaller. Nothing when the game gives neither, or a timed session
/// has no lap time to go by yet.
pub(super) fn laps_to_go(live: &Live) -> Option<f32> {
    let driven = match (live.dist_m, live.track_length_m) {
        (Some(dist), Some(track)) if dist.is_finite() && track.is_finite() && dist >= 0.0 && track > 0.0 => {
            (dist / track).clamp(0.0, 1.0) as f32
        }
        _ => 0.0,
    };
    let by_laps = live
        .session_laps
        .filter(|_| live.lap >= 1)
        .map(|laps| (f32::from(laps) - (live.lap - 1) as f32 - driven).max(0.0));
    let pace = [live.last_lap_s, live.best_lap_s]
        .into_iter()
        .flatten()
        .find(|lap| lap.is_finite() && *lap > 0.0);
    let by_time = live
        .session_time_left_s
        .filter(|left| left.is_finite())
        .zip(pace)
        .map(|(left, lap)| ((left.max(0.0) / lap).ceil() + 1.0) as f32);
    match (by_laps, by_time) {
        (Some(laps), Some(time)) => Some(laps.min(time)),
        (laps, time) => laps.or(time),
    }
}

/// The fuel to the end of the session: the litres needed for `laps` (a lap of margin included, as in the table) and the
/// litres to put in on top of what is in the tank (nothing without the fuel reading).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct FuelToEnd {
    pub(super) needed_l: f32,
    pub(super) to_add_l: Option<f32>,
}

/// Nothing without the laps left or a use per lap.
pub(super) fn fuel_to_end(laps: Option<f32>, fuel_l: Option<f32>, per_lap_l: Option<f32>) -> Option<FuelToEnd> {
    let laps = laps.filter(|n| n.is_finite() && *n >= 0.0)?;
    let per = per_lap_l.filter(|p| p.is_finite() && *p > 0.0)?;
    let needed_l = per * (laps + 1.0);
    let fuel = fuel_l.filter(|f| f.is_finite());
    Some(FuelToEnd {
        needed_l,
        to_add_l: fuel.map(|now| (needed_l - now.max(0.0)).max(0.0)),
    })
}

/// The fuel to the end of the session, written: `To the end · 23.1 L · add 4.2 L`.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FuelToEndModel {
    pub(super) label: String,
    pub(super) needed: String,
    /// The litres to put in, or nothing without a fuel reading.
    pub(super) to_add: Option<String>,
    /// The word before the litres to put in (`add`).
    pub(super) add_label: String,
    /// Amber while fuel has to be added, green when the tank already holds enough.
    pub(super) role: Role,
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
    /// The fuel to the end of the session, when the game gives its laps or its time and there is a use per lap.
    pub(super) to_end: Option<FuelToEndModel>,
    /// Why the fuel to the end of the session is not there; nothing while it is.
    pub(super) note: Option<String>,
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
    let to_end = fuel_to_end(laps_to_go(live), fuel_l, per_lap).map(|end| FuelToEndModel {
        label: say(Msg::PanelFuelToEnd),
        needed: litres(end.needed_l),
        to_add: end.to_add_l.map(litres),
        add_label: say(Msg::PanelFuelAddShort),
        role: match end.to_add_l {
            Some(add) if add > 0.0 => Role::Warn,
            Some(_) => Role::Good,
            None => Role::Text,
        },
    });
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
        note: to_end.is_none().then(|| say(Msg::PanelFuelToEndNote)),
        to_end,
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

// The session.

/// Time left written: `mm:ss`, or `h:mm:ss` from an hour up. Whole seconds, never below zero.
pub(super) fn session_clock(seconds: f64) -> String {
    let total = seconds.max(0.0).floor() as u64;
    let (hours, minutes, secs) = (total / 3600, total / 60 % 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes:02}:{secs:02}")
    }
}

/// The laps still to drive after the one being driven, in a lap-based session; nothing before the first lap is known.
pub(super) fn laps_after_this(session_laps: u16, lap: i32) -> Option<u16> {
    (lap >= 1).then_some(session_laps.saturating_sub(u16::try_from(lap).unwrap_or(u16::MAX)))
}

/// The session card: the place (`P3`) with the number of cars after it (`/ 24`), the place in the class under it, and what
/// is left of the session: the time (`mm:ss`) with a word after it, or, in a lap-based one, the lap (`Lap 5 / 20`) with the
/// laps still to go. A part the game does not give is `None` and is not drawn.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionCardModel {
    pub(super) show: Show,
    pub(super) title: String,
    /// `P3`.
    pub(super) position: Option<String>,
    /// `/ 24`: the cars in the session, only with a position.
    pub(super) of_cars: Option<String>,
    /// `P1 in class`.
    pub(super) class_line: Option<String>,
    /// `23:00`, or `Lap 5 / 20`.
    pub(super) remaining: Option<String>,
    /// `left`, or `15 to go`.
    pub(super) remaining_note: Option<String>,
}

pub(super) fn session_model(lang: Lang, live: &Live, fresh: bool) -> SessionCardModel {
    let say = |msg: Msg| text(lang, &msg);
    let place = |n: Option<u16>| n.filter(|n| *n >= 1);
    let position = place(live.race_position);
    let in_class = say(Msg::PanelSessionInClass);
    let (remaining, remaining_note) = match (live.session_time_left_s.filter(|t| t.is_finite()), live.session_laps) {
        (Some(left), _) => (Some(session_clock(left)), Some(say(Msg::PanelSessionLeft))),
        (None, Some(laps)) if live.lap >= 1 => {
            let lap = live.lap.min(i32::from(laps));
            let to_go = laps_after_this(laps, live.lap).unwrap_or(0);
            (
                Some(format!("{} {lap} / {laps}", say(Msg::PanelSessionLap))),
                Some(format!("{to_go} {}", say(Msg::PanelSessionToGo))),
            )
        }
        _ => (None, None),
    };
    SessionCardModel {
        show: if fresh { Show::Shown } else { Show::Dimmed },
        title: say(Msg::PanelSessionTitle),
        position: position.map(|n| format!("P{n}")),
        of_cars: position.and(place(live.cars)).map(|cars| format!("/ {cars}")),
        class_line: place(live.class_position).map(|n| format!("P{n} {in_class}")),
        remaining,
        remaining_note,
    }
}

// The rivals: the cars around the player (`Live::field`).

/// The cars shown on each side of the player in the relative card.
pub(super) const RELATIVE_SIDE: usize = 3;

/// The rows the standings card holds: the class leader, two cars ahead of the player, the player and two behind (when the
/// player is near either end of the table the rest of the rows go to that side).
pub(super) const STANDINGS_ROWS: usize = 6;

/// A gap trend under this many seconds a lap (either way) is "steady".
pub(super) const GAP_STEADY_S: f64 = 0.05;

/// How a car stands to the player in race distance (laps done plus the share of the lap): a lap or more ahead is lapping the
/// player, a lap or more behind is lapped, anything else is on the same lap.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum LapRelation {
    Level,
    Lapping,
    Lapped,
}

impl LapRelation {
    /// The ink of a row: blue for a car lapping the player, quiet for a lapped one.
    fn role(self) -> Role {
        match self {
            LapRelation::Level => Role::Text,
            LapRelation::Lapping => Role::Info,
            LapRelation::Lapped => Role::Muted,
        }
    }
}

/// How far a car has raced, in laps: the laps done plus the share of the lap. Nothing when either is not known.
fn raced_laps(car: &Car) -> Option<f64> {
    Some(f64::from(car.laps_done?) + f64::from(car.lap_share?))
}

pub(super) fn lap_relation(player: &Car, other: &Car) -> LapRelation {
    match (raced_laps(player), raced_laps(other)) {
        (Some(mine), Some(theirs)) if theirs - mine >= 1.0 => LapRelation::Lapping,
        (Some(mine), Some(theirs)) if mine - theirs >= 1.0 => LapRelation::Lapped,
        _ => LapRelation::Level,
    }
}

/// `P7`, or `–` for a car with no place.
fn place_text(place: Option<u16>) -> String {
    place.filter(|p| *p >= 1).map_or_else(|| "–".to_owned(), |p| format!("P{p}"))
}

/// One car of the relative card.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RelativeRow {
    /// `P7`.
    pub(super) position: String,
    pub(super) name: String,
    /// The time on the track to the player: `+1.234` for a car ahead, `-0.876` for one behind; nothing for the player's own row.
    pub(super) gap: Option<String>,
    /// Blue for a car lapping the player, quiet for a lapped one, plain otherwise.
    pub(super) role: Role,
    pub(super) relation: LapRelation,
    pub(super) is_player: bool,
}

/// The relative card: up to three cars ahead of the player on the track and three behind, the player in the middle.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RelativeModel {
    pub(super) show: Show,
    pub(super) title: String,
    /// From the farthest ahead to the farthest behind.
    pub(super) rows: Vec<RelativeRow>,
    /// Said while the game has not given the cars around the player.
    pub(super) note: Option<String>,
}

pub(super) fn relative_rows(field: &Field) -> Vec<RelativeRow> {
    let player = field.player();
    crate::field::relative(field, RELATIVE_SIDE, RELATIVE_SIDE)
        .into_iter()
        .map(|(car, seconds)| {
            let relation = match player {
                Some(me) if !car.is_player => lap_relation(me, car),
                _ => LapRelation::Level,
            };
            RelativeRow {
                position: place_text(car.position),
                name: car.name.clone(),
                gap: if car.is_player { None } else { delta_text(Some(seconds)) },
                role: relation.role(),
                relation,
                is_player: car.is_player,
            }
        })
        .collect()
}

pub(super) fn relative_model(lang: Lang, live: &Live, fresh: bool) -> RelativeModel {
    let rows = live.field.as_deref().map(relative_rows).unwrap_or_default();
    RelativeModel {
        show: if fresh { Show::Shown } else { Show::Dimmed },
        title: text(lang, &Msg::PanelRelativeTitle),
        note: (rows.len() < 2).then(|| text(lang, &Msg::PanelRivalsWait)),
        rows,
    }
}

// The standings.

/// Which of `len` cars (the player at index `player`, the leader at 0) the standings show, at most `want`: the leader, then
/// the two cars ahead of the player, the player and the two behind; when that leaves room (the player is near an end, or the
/// class is small) it goes to the cars behind the player first, then to those ahead. In order, without repeats.
pub(super) fn standings_pick(len: usize, player: usize, want: usize) -> Vec<usize> {
    if len <= want.max(1) {
        return (0..len).collect();
    }
    let player = player.min(len - 1);
    let (mut lo, mut hi) = (player.saturating_sub(2), (player + 2).min(len - 1));
    // The leader is one more row whenever the block round the player does not start at it.
    let rows = |lo: usize, hi: usize| hi - lo + 1 + usize::from(lo > 0);
    while rows(lo, hi) < want {
        if hi < len - 1 {
            hi += 1;
        } else if lo > 0 {
            lo -= 1;
        } else {
            break;
        }
    }
    let mut picked = Vec::with_capacity(want);
    if lo > 0 {
        picked.push(0);
    }
    picked.extend(lo..=hi);
    picked
}

/// The player's class, ordered by class place (by the place overall where the game has no classes), and where the player is in it.
fn class_table(field: &Field) -> Option<(Vec<&Car>, usize)> {
    let player = field.player()?;
    let mut cars: Vec<&Car> = field.cars.iter().filter(|c| c.class == player.class).collect();
    cars.sort_by_key(|c| c.class_position.or(c.position).unwrap_or(u16::MAX));
    let at = cars.iter().position(|c| c.is_player)?;
    Some((cars, at))
}

/// The time behind the class leader, `+12.3`: the gap to the overall leader less the class leader's own (a leader that is
/// first overall is 0 behind itself). Nothing when either gap is not known.
fn class_gap_text(leader: &Car, car: &Car) -> Option<String> {
    let base = leader.gap_leader_s.or_else(|| (leader.position == Some(1)).then_some(0.0))?;
    let gap = (car.gap_leader_s? - base).max(0.0);
    gap.is_finite().then(|| format!("+{gap:.1}"))
}

/// One car of the standings card.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StandingsRow {
    /// The place in the class, `P3`.
    pub(super) position: String,
    pub(super) name: String,
    /// The time behind the class leader (`+12.3`), the word for the leader itself, or `–`.
    pub(super) gap: String,
    /// The car's last lap, `1:47.918`, or `–`.
    pub(super) last: String,
    pub(super) is_player: bool,
    /// Places were skipped between the row before and this one: a thin divider goes over it.
    pub(super) skipped_before: bool,
}

/// The standings card: the player's class only, the leader first, then the rows around the player.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StandingsModel {
    pub(super) show: Show,
    pub(super) title: String,
    /// The player's class, written on the right of the title.
    pub(super) class_name: Option<String>,
    /// The heads of the gap and the last lap columns.
    pub(super) heads: [String; 2],
    pub(super) rows: Vec<StandingsRow>,
    pub(super) note: Option<String>,
}

pub(super) fn standings_rows(field: &Field, leader_word: &str, want: usize) -> Vec<StandingsRow> {
    let Some((cars, player)) = class_table(field) else {
        return Vec::new();
    };
    let picks = standings_pick(cars.len(), player, want);
    let none = || "–".to_owned();
    picks
        .iter()
        .enumerate()
        .map(|(n, &i)| {
            let car = cars[i];
            StandingsRow {
                position: place_text(car.class_position.or(car.position)),
                name: car.name.clone(),
                gap: if i == 0 {
                    leader_word.to_owned()
                } else {
                    class_gap_text(cars[0], car).unwrap_or_else(none)
                },
                last: lap_clock(car.last_lap_s).unwrap_or_else(none),
                is_player: car.is_player,
                skipped_before: n > 0 && i > picks[n - 1] + 1,
            }
        })
        .collect()
}

pub(super) fn standings_model(lang: Lang, live: &Live, fresh: bool) -> StandingsModel {
    let say = |msg: Msg| text(lang, &msg);
    let field = live.field.as_deref();
    let leader_word = say(Msg::PanelStandingsLeader);
    let rows = field.map(|f| standings_rows(f, &leader_word, STANDINGS_ROWS)).unwrap_or_default();
    let class_name = field.and_then(|f| f.player()).and_then(|p| p.class.clone());
    StandingsModel {
        show: if fresh { Show::Shown } else { Show::Dimmed },
        title: say(Msg::PanelStandingsTitle),
        class_name: class_name.filter(|c| !c.trim().is_empty()),
        heads: [say(Msg::PanelColGap), say(Msg::PanelColLast)],
        note: rows.is_empty().then(|| say(Msg::PanelRivalsWait)),
        rows,
    }
}

// The gaps.

/// Where a gap is heading: closing (shrinking), opening (growing) or hardly changing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum TrendDir {
    Closing,
    Opening,
    Steady,
}

/// `seconds_per_lap` is positive while the gap shrinks.
pub(super) fn trend_dir(seconds_per_lap: f64) -> TrendDir {
    if !seconds_per_lap.is_finite() || seconds_per_lap.abs() < GAP_STEADY_S {
        TrendDir::Steady
    } else if seconds_per_lap > 0.0 {
        TrendDir::Closing
    } else {
        TrendDir::Opening
    }
}

/// The meaning of a trend for the player: the car ahead closing is good, opening bad; the car behind closing is bad,
/// opening good. Steady is quiet.
pub(super) fn trend_role(car_ahead: bool, dir: TrendDir) -> Role {
    match (dir, car_ahead) {
        (TrendDir::Steady, _) => Role::Muted,
        (TrendDir::Closing, true) | (TrendDir::Opening, false) => Role::Good,
        (TrendDir::Opening, true) | (TrendDir::Closing, false) => Role::Danger,
    }
}

/// How a gap changed over the last laps: `closing 0.3 s/lap`.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GapTrendModel {
    pub(super) dir: TrendDir,
    pub(super) text: String,
    pub(super) role: Role,
}

pub(super) fn gap_trend_model(lang: Lang, car_ahead: bool, seconds_per_lap: f64) -> GapTrendModel {
    let dir = trend_dir(seconds_per_lap);
    let amount = format!("{:.1}", seconds_per_lap.abs());
    let msg = match dir {
        TrendDir::Closing => Msg::PanelGapClosing(amount),
        TrendDir::Opening => Msg::PanelGapOpening(amount),
        TrendDir::Steady => Msg::PanelGapSteady,
    };
    GapTrendModel {
        dir,
        text: text(lang, &msg),
        role: trend_role(car_ahead, dir),
    }
}

/// The car on one side of the player.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GapCarModel {
    pub(super) position: String,
    pub(super) name: String,
    /// The gap now, in seconds: `+1.234` for the car ahead, `-0.876` for the one behind; `–` when the game gives none.
    pub(super) gap: String,
    /// Said once two laps have been seen with the same car there.
    pub(super) trend: Option<GapTrendModel>,
}

/// One side of the gaps card.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GapSideModel {
    /// `Ahead` or `Behind`.
    pub(super) label: String,
    /// Nothing for a side without a car (the leader has nobody ahead).
    pub(super) car: Option<GapCarModel>,
}

/// The gaps card: the car one place ahead and the car one place behind (overall), the gap to each and how it is changing.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GapsModel {
    pub(super) show: Show,
    pub(super) title: String,
    pub(super) ahead: GapSideModel,
    pub(super) behind: GapSideModel,
    /// Said while the game has not given the cars yet.
    pub(super) note: Option<String>,
}

pub(super) fn gaps_model(lang: Lang, live: &Live, fresh: bool) -> GapsModel {
    let say = |msg: Msg| text(lang, &msg);
    let field = live.field.as_deref().filter(|f| f.player().is_some());
    let (near_ahead, near_behind) = field.map_or((None, None), crate::dash::place_neighbours);
    let player_gap = field.and_then(|f| f.player()).and_then(|p| p.gap_ahead_s);
    let (trend_ahead, trend_behind) = live.gap_trend.unwrap_or((None, None));
    let side = |label: Msg, car: Option<&Car>, gap: Option<f64>, trend: Option<f64>, ahead: bool| GapSideModel {
        label: say(label),
        car: car.map(|car| GapCarModel {
            position: place_text(car.position),
            name: car.name.clone(),
            gap: delta_text(gap.map(|g| if ahead { g } else { -g })).unwrap_or_else(|| "–".to_owned()),
            trend: trend.map(|t| gap_trend_model(lang, ahead, t)),
        }),
    };
    GapsModel {
        show: if fresh { Show::Shown } else { Show::Dimmed },
        title: say(Msg::PanelGapsTitle),
        ahead: side(Msg::PanelGapAhead, near_ahead, player_gap, trend_ahead, true),
        behind: side(
            Msg::PanelGapBehind,
            near_behind,
            near_behind.and_then(|c| c.gap_ahead_s),
            trend_behind,
            false,
        ),
        note: field.is_none().then(|| say(Msg::PanelRivalsWait)),
    }
}

// The radar: the cars alongside and close, seen from above.

/// What the radar covers round the player's car, in metres: to each side, ahead and behind.
pub(super) const RADAR_SIDE_M: f32 = 12.0;
pub(super) const RADAR_AHEAD_M: f32 = 30.0;
pub(super) const RADAR_BEHIND_M: f32 = 20.0;
/// Every car is drawn this wide and this long, in metres (the games give positions, not sizes).
pub(super) const RADAR_CAR_W_M: f32 = 1.9;
pub(super) const RADAR_CAR_L_M: f32 = 4.6;
/// A car is alongside while it overlaps the player's lengthways and the gap between the two cars' sides is under this.
pub(super) const RADAR_ALONGSIDE_GAP_M: f32 = 3.0;
/// A car whose centre is within this many metres ahead or behind (lengthways) is close.
pub(super) const RADAR_NEAR_M: f32 = 8.0;
/// A box that is wide for its height shows at least this many metres of the radar's length (the longer axis is cropped, never
/// shrunk to a sliver).
pub(super) const RADAR_LEAST_LENGTH_M: f32 = 30.0;

/// What the radar draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum RadarMode {
    /// The cars round the player, from their world positions.
    Map,
    /// The player's car with a bar on the side the game's own spotter says a car is on.
    Spotter,
    /// Neither yet: the card says why.
    Waiting,
}

/// How a car stands to the player on the radar, the most urgent last.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum RadarThreat {
    Clear,
    /// Within `RADAR_NEAR_M` ahead or behind.
    Near,
    /// Overlapping the player's car lengthways, with less than `RADAR_ALONGSIDE_GAP_M` between the sides.
    Alongside,
}

impl RadarThreat {
    /// The ink of a car: quiet, amber, red.
    pub(super) fn role(self) -> Role {
        match self {
            RadarThreat::Clear => Role::Muted,
            RadarThreat::Near => Role::Warn,
            RadarThreat::Alongside => Role::Danger,
        }
    }
}

/// A car of the radar, in metres from the player's car, in the player's own frame (the player points up).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RadarCar {
    /// To the right of the player (negative: to the left).
    pub(super) right_m: f32,
    /// Ahead of the player (negative: behind).
    pub(super) ahead_m: f32,
    pub(super) threat: RadarThreat,
}

/// The radar card: from above and heading-up, the player's car in the middle and the cars of the field round it; or, for a game
/// that only gives a left and right signal, the player's car with a bar (two for two cars) along each side a car is on.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RadarModel {
    pub(super) show: Show,
    pub(super) title: String,
    pub(super) mode: RadarMode,
    /// The cars in range, the most urgent last (`Map` only).
    pub(super) cars: Vec<RadarCar>,
    /// The bars on the left and on the right of the car, 0 to 2 (`Spotter` only).
    pub(super) left_bars: u8,
    pub(super) right_bars: u8,
    /// Said while there is nothing to draw yet.
    pub(super) note: Option<String>,
}

/// The heading as a unit vector, or nothing for one that is not a direction.
fn unit_heading((x, z): (f32, f32)) -> Option<(f32, f32)> {
    let length = x.hypot(z);
    if length.is_finite() && length > 1e-3 {
        Some((x / length, z / length))
    } else {
        None
    }
}

/// Where `other` is from `player` in the player's frame, in metres: `(right, ahead)`. Both positions are the game's
/// `(x, y, z)` (the ground is x and z), `heading` is the player's direction on the ground as `Live::heading` gives it, and
/// `mirrored` says the game's ground has the opposite handedness (`perspective::mirrored_ground`), exactly as the track
/// camera uses it. Nothing for a heading that is not a direction or a position that is not a number.
pub(super) fn radar_offset(player: [f32; 3], other: [f32; 3], heading: (f32, f32), mirrored: bool) -> Option<(f32, f32)> {
    let (tx, tz) = unit_heading(heading)?;
    let (dx, dz) = (other[0] - player[0], other[2] - player[2]);
    let (right, ahead) = (dx * tz - dz * tx, dx * tx + dz * tz);
    let right = if mirrored { -right } else { right };
    (right.is_finite() && ahead.is_finite()).then_some((right, ahead))
}

/// Whether a car at `(right, ahead)` is in the radar's range.
pub(super) fn radar_in_range((right, ahead): (f32, f32)) -> bool {
    right.abs() <= RADAR_SIDE_M && (-RADAR_BEHIND_M..=RADAR_AHEAD_M).contains(&ahead)
}

/// How a car at `(right, ahead)` stands to the player. Every car is taken to point the way the player does (the games give
/// positions, not headings), so the cars are all the same rectangle and overlap lengthways while their centres are less than a
/// car's length apart.
pub(super) fn radar_threat((right, ahead): (f32, f32)) -> RadarThreat {
    if ahead.abs() < RADAR_CAR_L_M && right.abs() - RADAR_CAR_W_M < RADAR_ALONGSIDE_GAP_M {
        RadarThreat::Alongside
    } else if ahead.abs() <= RADAR_NEAR_M {
        RadarThreat::Near
    } else {
        RadarThreat::Clear
    }
}

/// The cars of `field` in the radar's range, the most urgent last. Every offset is the car's position less the position of the
/// player's own car *in this same field*, never the live position (which is newer by up to a field's interval: the cars would
/// all shift by the metres the player has driven since). Nothing when the field has no position for the player, or the heading
/// is not a direction.
pub(super) fn radar_cars(field: &Field, heading: (f32, f32), mirrored: bool) -> Option<Vec<RadarCar>> {
    unit_heading(heading)?;
    let mine = field.player()?.world?;
    let mut cars: Vec<RadarCar> = field
        .cars
        .iter()
        .filter(|car| !car.is_player)
        .filter_map(|car| radar_offset(mine, car.world?, heading, mirrored))
        .filter(|at| radar_in_range(*at))
        .map(|at| RadarCar {
            right_m: at.0,
            ahead_m: at.1,
            threat: radar_threat(at),
        })
        .collect();
    cars.sort_by_key(|car| car.threat);
    Some(cars)
}

/// The bars the spotter lights on the left and on the right.
pub(super) fn radar_bars(spotter: crate::game::Spotter) -> (u8, u8) {
    use crate::game::Spotter;
    match spotter {
        Spotter::Clear => (0, 0),
        Spotter::Left => (1, 0),
        Spotter::Right => (0, 1),
        Spotter::Both => (1, 1),
        Spotter::TwoLeft => (2, 0),
        Spotter::TwoRight => (0, 2),
    }
}

/// How many design units a metre is in a drawing box `w` by `h`: the box keeps its own aspect and the radar's longer axis is
/// cropped to it, with never less than `RADAR_LEAST_LENGTH_M` of length in view.
pub(super) fn radar_scale(w: f32, h: f32) -> f32 {
    let whole = (w / (2.0 * RADAR_SIDE_M)).max(h / (RADAR_AHEAD_M + RADAR_BEHIND_M));
    whole.min(h / RADAR_LEAST_LENGTH_M).max(0.01)
}

pub(super) fn radar_model(lang: Lang, live: &Live, fresh: bool) -> RadarModel {
    let mirrored = crate::perspective::mirrored_ground(live.game);
    let map = live
        .field
        .as_deref()
        .zip(live.heading)
        .and_then(|(field, heading)| radar_cars(field, heading, mirrored));
    let has_spotter = live.caps.has(crate::game::Caps::SPOTTER);
    let (mode, cars, bars) = match map {
        Some(cars) => (RadarMode::Map, cars, (0, 0)),
        None if has_spotter => (RadarMode::Spotter, Vec::new(), live.spotter.map_or((0, 0), radar_bars)),
        None => (RadarMode::Waiting, Vec::new(), (0, 0)),
    };
    RadarModel {
        show: if fresh { Show::Shown } else { Show::Dimmed },
        title: text(lang, &Msg::PanelRadarTitle),
        mode,
        cars,
        left_bars: bars.0,
        right_bars: bars.1,
        note: (mode == RadarMode::Waiting).then(|| text(lang, &Msg::PanelRadarWait)),
    }
}

// The delta to the reference lap.

/// The reference card: the delta to the lap the Xpeed board shows as the best (or, with none, to the person's own best) in big figures,
/// a line naming that lap and, when the person's own best is another lap, a second smaller line with its time and the delta to it.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeltaRefModel {
    pub(super) show: Show,
    pub(super) title: String,
    /// `-0.054`, or `–` while there is no delta (no reference lap, or no distance into the lap yet).
    pub(super) value: String,
    pub(super) role: Role,
    /// `Xpeed best · L. Moretti · 2:01.234`, or `Your best · 2:02.100` when the lap is the person's own.
    pub(super) line: Option<String>,
    /// `Your best · 2:02.100 · -0.054`, only when the person's own best is not the lap above.
    pub(super) personal_line: Option<String>,
    /// Said while there is no reference lap.
    pub(super) note: Option<String>,
}

pub(super) fn delta_ref_model(lang: Lang, live: &Live, fresh: bool) -> DeltaRefModel {
    use crate::reference::{Kind, Reference};
    let say = |msg: Msg| text(lang, &msg);
    let found = live.references.as_deref();
    let (best, personal) = (found.and_then(|r| r.best.as_ref()), found.and_then(|r| r.personal.as_ref()));
    let main = best.or(personal);
    // The time on this lap against a reference lap at the same distance; nothing before the game gives both.
    let delta_to = |reference: &Reference| live.dist_m.zip(live.lap_time_s).and_then(|(dist, time)| reference.delta(dist, time));
    let delta = main.and_then(delta_to).filter(|d| d.is_finite());
    let time_of = |reference: &Reference| lap_clock(Some(f64::from(reference.time_ms) / 1000.0)).unwrap_or_default();
    let line = main.map(|reference| match (reference.kind, reference.driver.as_deref()) {
        (Kind::Best, Some(driver)) => format!("{} · {driver} · {}", say(Msg::PanelRefBest), time_of(reference)),
        (Kind::Best, None) => format!("{} · {}", say(Msg::PanelRefBest), time_of(reference)),
        (Kind::Personal, _) => format!("{} · {}", say(Msg::PanelRefYours), time_of(reference)),
    });
    let personal_line = personal
        .filter(|own| main.is_some_and(|lap| lap.lap_id != own.lap_id))
        .map(|own| match delta_text(delta_to(own)) {
            Some(delta) => format!("{} · {} · {delta}", say(Msg::PanelRefYours), time_of(own)),
            None => format!("{} · {}", say(Msg::PanelRefYours), time_of(own)),
        });
    DeltaRefModel {
        show: if fresh && delta.is_some() { Show::Shown } else { Show::Dimmed },
        title: say(Msg::PanelRefTitle),
        value: delta_text(delta).unwrap_or_else(|| "–".to_owned()),
        role: match delta {
            Some(d) if d < 0.0 => Role::Good,
            Some(_) => Role::Danger,
            None => Role::Muted,
        },
        line,
        personal_line,
        note: main.is_none().then(|| say(Msg::PanelRefWait)),
    }
}
