//! The cards of the catalog's later widgets, drawn from the models of `widgets.rs`: the digiflag, the fuel strategy, the tyre
//! wear, the sectors and the delta bar. They use the same pieces as the first seven cards (the card caption, the tokens'
//! type sizes and colours, the panel's one corner and the square-block bars) and add no colour or corner of their own.

use super::*;

/// A card's lines of text under the table or the rows, and the heights of the fuel table's parts.
const NOTE_LINE_H: f32 = 16.0;
const STAT_H: f32 = 30.0;
const TABLE_HEAD_H: f32 = 18.0;
const TABLE_ROW_H: f32 = 22.0;

/// The height of a sector's row, and of a row of the wear card at its smallest.
const SECTOR_ROW_H: f32 = 30.0;
const WEAR_ROW_MIN_H: f32 = 28.0;
const WEAR_ROW_MAX_H: f32 = 46.0;

/// A delta card this tall (inside) gets the big number and the tall bar.
const DELTA_BIG_H: f32 = 190.0;

/// The fill of a flag's block, the edge it needs to stand out on the card (a black flag), and the ink of the words on it.
pub(super) fn flag_look(kind: FlagKind) -> (COLORREF, Option<COLORREF>, COLORREF) {
    match kind {
        FlagKind::Green => (SUCCESS, None, ON_PRIMARY),
        FlagKind::Yellow => (PRIMARY, None, ON_PRIMARY),
        FlagKind::Blue => (INFO, None, ON_PRIMARY),
        FlagKind::White | FlagKind::Chequered => (FLAG_WHITE, None, ON_PRIMARY),
        FlagKind::Black => (FLAG_BLACK, Some(MUTED_TEXT), FOREGROUND),
    }
}

/// The colour of a sector time: purple for the best, green when faster than the lap before, yellow when slower; the last
/// lap's time, which the lap being driven has not reached yet, is quiet.
pub(super) fn sector_colour(tone: SectorTone, from_last_lap: bool) -> COLORREF {
    match (tone, from_last_lap) {
        (SectorTone::Best, _) => BEST,
        (SectorTone::Faster, _) => SUCCESS,
        (SectorTone::Slower, _) => WARN,
        (SectorTone::Plain, true) => MUTED_TEXT,
        (SectorTone::Plain, false) => FOREGROUND,
    }
}

/// The digiflag: the whole card is a block of the flag's colour with its word big in the middle (the chequered flag is a
/// square checker pattern, its word on a plate); with no flag the card keeps its surface and says `NO FLAG` quietly.
pub(super) fn digiflag_card(g: &mut Painter, d: &Dash, card: Area) {
    let Some(f) = &d.m.flag else {
        return;
    };
    let semi = FW_SEMIBOLD as i32;
    let (x, y, w, h) = card;
    let (ix, iy, iw, ih) = inner(card);
    let big = type_step((ih - CAPTION_H) * 0.5);
    shown(g, f.show, |g| {
        let Some(kind) = f.kind else {
            caption(g, &f.title, (ix, iy, iw, CAPTION_H), DT_LEFT);
            let size = g.fitted(&f.word, iw, big.min(T_VALUE_L), T_CAPTION, semi, Face::Num);
            let r = g.r(ix, iy + CAPTION_H, iw, ih - CAPTION_H);
            g.text(&f.word, r, size, semi, Face::Num, MUTED_TEXT, DT_CENTER);
            return;
        };
        let (fill, edge, ink) = flag_look(kind);
        g.round(g.r(x, y, w, h), fill, edge);
        let size = g.fitted(&f.word, iw, big.min(T_DISPLAY), T_CAPTION, semi, Face::Num);
        if kind == FlagKind::Chequered {
            chequered_pattern(g, (x, y, w, h));
            let (word_w, title_w) = (g.tabular_width(&f.word, size, semi), g.caps_width(&f.title, T_CAPTION));
            let word_h = size * 1.25;
            let plate_w = (word_w.max(title_w) + 2.0 * S4).min(w - 2.0 * S2);
            let plate_h = CAPTION_H + S1 + word_h + 2.0 * S2;
            let (px, py) = (x + (w - plate_w) / 2.0, y + (h - plate_h) / 2.0);
            g.round(g.r(px, py, plate_w, plate_h), FLAG_WHITE, Some(FLAG_BLACK));
            let r = g.r(px, py + S2, plate_w, CAPTION_H);
            g.caps(&f.title, r, T_CAPTION, ink, DT_CENTER);
            let r = g.r(px, py + S2 + CAPTION_H + S1, plate_w, word_h);
            g.text(&f.word, r, size, semi, Face::Num, ink, DT_CENTER);
        } else {
            let r = g.r(ix, iy, iw, CAPTION_H);
            g.caps(&f.title, r, T_CAPTION, ink, DT_LEFT);
            let r = g.r(ix, iy + CAPTION_H, iw, ih - CAPTION_H);
            g.text(&f.word, r, size, semi, Face::Num, ink, DT_CENTER);
        }
    });
}

/// A pattern of black squares over the white block of the chequered flag: whole squares, as many as fit, centred, with a
/// margin of white round them.
fn chequered_pattern(g: &mut Painter, (x, y, w, h): Area) {
    let (bx, by, bw, bh) = (x + STROKE_BAR, y + STROKE_BAR, w - 2.0 * STROKE_BAR, h - 2.0 * STROKE_BAR);
    let square = (bh / 5.0).floor().max(S2);
    let (cols, rows) = ((bw / square).floor().max(1.0) as usize, (bh / square).floor().max(1.0) as usize);
    let (ox, oy) = (bx + (bw - cols as f32 * square) / 2.0, by + (bh - rows as f32 * square) / 2.0);
    for row in 0..rows {
        for col in 0..cols {
            if !(row + col).is_multiple_of(2) {
                g.fill(g.r(ox + col as f32 * square, oy + row as f32 * square, square, square), FLAG_BLACK);
            }
        }
    }
}

/// The fuel strategy card: the average use per lap, the last lap's use and the laps left in the tank over a table of what 5,
/// 10, 15 and 20 laps need (with a lap of margin) and how much of it to add, and a line about the fuel to the end of the
/// session.
pub(super) fn fuel_strategy_card(g: &mut Painter, d: &Dash, card: Area) {
    let Some(m) = &d.m.fuel_calc else {
        return;
    };
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let (x, y, w, h) = inner(card);
    shown(g, m.show, |g| {
        caption(g, &m.title, (x, y, w, CAPTION_H), DT_LEFT);
        let top = y + CAPTION_H + S2;
        let col = (w - 2.0 * S2) / 3.0;
        for (i, cell) in m.stats.iter().enumerate() {
            let cx = x + i as f32 * (col + S2);
            let r = g.r(cx, top, col, CAPTION_H);
            g.caps(&cell.label, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
            let size = g.fitted(&cell.value, col, T_VALUE, T_BODY, semi, Face::Num);
            let r = g.r(cx - 1.0, top + CAPTION_H + S1, col + 1.0, STAT_H);
            g.text(&cell.value, r, size, semi, Face::Num, cell.role.colour(), DT_LEFT);
        }
        // The table: the laps on the left, the litres needed and the litres to add to the right.
        let table_top = top + CAPTION_H + S1 + STAT_H + S3;
        let widths = [w * 0.22, w * 0.39, w * 0.39];
        let mut at = x;
        let columns: Vec<(f32, f32)> = widths
            .iter()
            .map(|cw| {
                let place = (at, *cw);
                at += cw;
                place
            })
            .collect();
        for (i, (head, (cx, cw))) in m.heads.iter().zip(&columns).enumerate() {
            let r = g.r(*cx, table_top, *cw, TABLE_HEAD_H);
            g.caps(head, r, T_CAPTION, MUTED_TEXT, if i == 0 { DT_LEFT } else { DT_RIGHT });
        }
        g.fill(g.r(x, table_top + TABLE_HEAD_H - 1.0, w, STROKE_HAIR), BORDER);
        for (i, row) in m.rows.iter().enumerate() {
            let ry = table_top + TABLE_HEAD_H + i as f32 * TABLE_ROW_H;
            let cells = [(&row.laps, FOREGROUND_2), (&row.needed, FOREGROUND), (&row.to_add, row.role.colour())];
            for (j, ((value, colour), (cx, cw))) in cells.iter().zip(&columns).enumerate() {
                let r = g.r(*cx, ry, *cw, TABLE_ROW_H);
                g.text(value, r, T_BODY, semi, Face::Num, *colour, if j == 0 { DT_LEFT } else { DT_RIGHT });
            }
            g.fill(g.r(x, ry + TABLE_ROW_H - 1.0, w, STROKE_HAIR), BORDER);
        }
        // The line about the end of the session, as many lines as the card has room for.
        let note_top = table_top + TABLE_HEAD_H + m.rows.len() as f32 * TABLE_ROW_H + S2;
        let room = ((y + h - note_top) / NOTE_LINE_H).floor().max(0.0) as usize;
        for (i, line) in g.wrap_lines(&m.note, w, T_CAPTION, normal, Face::Ui).iter().take(room).enumerate() {
            let r = g.r(x, note_top + i as f32 * NOTE_LINE_H, w, NOTE_LINE_H);
            g.text(line, r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_LEFT);
        }
    });
}

/// The tyre wear card: a row per tyre with its tread left as a small bar, the wear per lap and, big, the laps left until
/// the tread is gone; the tyre that runs out first has its row lit. A line says why the figures are missing until a clean
/// lap gave a wear per lap.
pub(super) fn tyre_wear_card(g: &mut Painter, d: &Dash, card: Area) {
    let Some(m) = &d.m.tyre_trend else {
        return;
    };
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let (x, y, w, h) = inner(card);
    shown(g, m.show, |g| {
        caption(g, &m.title, (x, y, w, CAPTION_H), DT_LEFT);
        let (x0, x1) = (x + S2, x + w - S2);
        let (wear_w, left_w) = ((w * 0.3).min(84.0), (w * 0.28).min(84.0));
        let head_y = y + CAPTION_H + S2;
        let [wear_head, left_head] = &m.heads;
        let r = g.r(x1 - left_w - wear_w, head_y, wear_w, CAPTION_H);
        g.caps(wear_head, r, T_CAPTION, MUTED_TEXT, DT_RIGHT);
        let r = g.r(x1 - left_w, head_y, left_w, CAPTION_H);
        g.caps(left_head, r, T_CAPTION, MUTED_TEXT, DT_RIGHT);
        let note_lines = m
            .note
            .as_ref()
            .map(|note| g.wrap_lines(note, w, T_CAPTION, normal, Face::Ui))
            .unwrap_or_default();
        let note_h = if note_lines.is_empty() {
            0.0
        } else {
            note_lines.len() as f32 * NOTE_LINE_H + S2
        };
        let rows_top = head_y + CAPTION_H + S1;
        let pitch = ((y + h - note_h - rows_top) / m.rows.len().max(1) as f32).clamp(WEAR_ROW_MIN_H, WEAR_ROW_MAX_H);
        let row_h = pitch - S1;
        let corner_w = 30.0;
        let bar_x = x0 + corner_w + S2;
        let bar_w = x1 - left_w - wear_w - S2 - bar_x;
        for (i, row) in m.rows.iter().enumerate() {
            let ry = rows_top + i as f32 * pitch;
            if row.worst {
                tile_with_edge(g, (x, ry, w, row_h), SURFACE, row.role.colour());
            } else {
                g.round(g.r(x, ry, w, row_h), BACKGROUND, Some(BORDER));
            }
            let r = g.r(x0, ry, corner_w, row_h);
            g.caps(&row.corner, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
            if let Some(tread) = row.tread.filter(|_| bar_w >= 24.0) {
                g.solid_bar((bar_x, ry + (row_h - 8.0) / 2.0, bar_w, 8.0), tread, FOREGROUND_2);
            }
            let r = g.r(x1 - left_w - wear_w, ry, wear_w, row_h);
            g.text(&row.wear, r, T_BODY, normal, Face::Num, FOREGROUND_2, DT_RIGHT);
            let size = g.fitted(&row.laps_left, left_w, T_VALUE, T_BODY, semi, Face::Num);
            let r = g.r(x1 - left_w, ry, left_w, row_h);
            g.text(&row.laps_left, r, size, semi, Face::Num, row.role.colour(), DT_RIGHT);
        }
        for (i, line) in note_lines.iter().enumerate() {
            let r = g.r(x, y + h - note_h + S2 + i as f32 * NOTE_LINE_H, w, NOTE_LINE_H);
            g.text(line, r, T_CAPTION, normal, Face::Ui, MUTED_TEXT, DT_LEFT);
        }
    });
}

/// The sectors card: a row for S1, S2 and S3 with the time in its colour (purple best, green faster, yellow slower than the
/// lap before) and the best time of that sector this run; under them the theoretical best lap and how far the best lap is
/// from it.
pub(super) fn sector_times_card(g: &mut Painter, d: &Dash, card: Area) {
    let Some(m) = &d.m.sectors else {
        return;
    };
    let (semi, normal) = (FW_SEMIBOLD as i32, FW_NORMAL as i32);
    let (x, y, w, _) = inner(card);
    shown(g, m.show, |g| {
        caption(g, &m.title, (x, y, w, CAPTION_H), DT_LEFT);
        let best_w = (w * 0.3).min(110.0);
        let head_y = y + CAPTION_H + S2;
        let r = g.r(x + w - best_w - S2, head_y, best_w, CAPTION_H);
        g.caps(&m.best_head, r, T_CAPTION, MUTED_TEXT, DT_RIGHT);
        let rows_top = head_y + CAPTION_H + S1;
        let label_w = 30.0;
        for (i, row) in m.rows.iter().enumerate() {
            let ry = rows_top + i as f32 * (SECTOR_ROW_H + S1);
            let colour = sector_colour(row.tone, row.from_last_lap);
            let edge = if row.tone == SectorTone::Plain { BORDER } else { colour };
            tile_with_edge(g, (x, ry, w, SECTOR_ROW_H), BACKGROUND, edge);
            let r = g.r(x + S2, ry, label_w, SECTOR_ROW_H);
            g.caps(&row.label, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
            let time_w = (w - S2 - label_w - best_w - 2.0 * S2).max(1.0);
            let size = g.fitted(&row.time, time_w, T_VALUE, T_BODY, semi, Face::Num);
            let r = g.r(x + S2 + label_w, ry, time_w, SECTOR_ROW_H);
            g.text(&row.time, r, size, semi, Face::Num, colour, DT_LEFT);
            let r = g.r(x + w - best_w - S2, ry, best_w, SECTOR_ROW_H);
            g.text(&row.best, r, T_BODY, normal, Face::Num, MUTED_TEXT, DT_RIGHT);
        }
        let ty = rows_top + m.rows.len() as f32 * (SECTOR_ROW_H + S1) + S2 - S1;
        let r = g.r(x, ty, w, CAPTION_H);
        g.caps(&m.theoretical_label, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
        let half = w * 0.5;
        let size = g.fitted(&m.theoretical, half, T_VALUE_L, T_VALUE, semi, Face::Num);
        let r = g.r(x - 1.0, ty + CAPTION_H + S1, half, STAT_H);
        g.text(&m.theoretical, r, size, semi, Face::Num, BEST, DT_LEFT);
        if let Some(gap) = &m.gap {
            let line = format!("{gap} {}", m.gap_label);
            let r = g.r(x + half, ty + CAPTION_H + S1, half, STAT_H);
            g.text(&line, r, T_BODY, normal, Face::Ui, SUCCESS, DT_RIGHT);
        }
    });
}

/// The delta card: the delta to the best lap as a big number (green when faster, red when slower) over a wide bar of
/// square blocks centred on zero, filled to the left when faster and to the right when slower, to 2 seconds either side.
pub(super) fn delta_card(g: &mut Painter, d: &Dash, card: Area) {
    let Some(m) = &d.m.delta_bar else {
        return;
    };
    let semi = FW_SEMIBOLD as i32;
    let (x, y, w, h) = inner(card);
    shown(g, m.show, |g| {
        caption(g, &m.title, (x, y, w, CAPTION_H), DT_LEFT);
        caption(g, &m.caption, (x, y, w, CAPTION_H), DT_RIGHT);
        let big = h >= DELTA_BIG_H;
        let (number_h, bar_h, number_size) = if big { (84.0, 24.0, T_DISPLAY) } else { (56.0, 16.0, T_HERO) };
        let top = y + CAPTION_H + S1;
        let tops = stack(top, y + h - top, &[number_h, bar_h], S3, S8);
        let size = g.fitted(&m.value, w, number_size, T_VALUE, semi, Face::Num);
        let r = g.r(x, tops[0], w, number_h);
        g.text(&m.value, r, size, semi, Face::Num, m.role.colour(), DT_CENTER);
        g.centred_bar((x, tops[1], w, bar_h), m.frac, m.role.colour(), FOREGROUND);
    });
}
