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
fn a_pedal_lights_blocks_from_the_bottom_with_its_value_and_never_past_the_column() {
    let count = pedal_count(140.0);
    assert_eq!(count, 17, "6 tall with 2 between: 17 blocks in 140");
    assert_eq!(pedal_lit(0.0, count), 0);
    assert_eq!(pedal_lit(1.0, count), count);
    assert_eq!(pedal_lit(1.7, count), count, "clamped");
    assert_eq!(pedal_lit(0.5, 10), 5);
    assert_eq!(pedal_lit(0.04, 10), 1, "a pedal touched shows a block");
    assert_eq!(pedal_lit(0.01, 10), 0, "a hair above nothing is nothing");
    assert_eq!(pedal_lit(-0.3, 10), 0);
    assert_eq!(pedal_count(1.0), 1, "never none");
}

#[test]
fn a_pedal_without_a_value_counts_as_released() {
    assert_eq!(pedal_lit(f32::NAN, 10), 0);
    assert_eq!(pedal_lit(f32::INFINITY, 10), 0);
}

#[test]
fn a_pedal_tag_is_the_first_letter_in_capitals() {
    assert_eq!(pedal_tag("Brake"), "B");
    assert_eq!(pedal_tag("embreagem"), "E");
    assert_eq!(pedal_tag(""), "");
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

/// Whether a box lies between two vertical lines.
fn within_centre(a: Area, from: f32, to: f32) -> bool {
    a.0 >= from && a.0 + a.2 <= to
}

#[test]
fn the_pedal_bars_and_the_wheel_bar_stay_in_the_centre_column_clear_of_the_side_columns() {
    // The main block (used by the classic, ultrawide, wide and square layouts), then the portrait canvas.
    for (name, cx, top, frame_h, from, to) in [
        ("main", CANVAS_W / 2.0, 100.0, 140.0, MAIN_SIDE_W, CANVAS_W - MAIN_SIDE_W),
        ("portrait", PORTRAIT_W / 2.0, 100.0, 190.0, 0.0, PORTRAIT_W),
    ] {
        let plan = centre_plan(cx, top, frame_h, true);
        let (fx, fy, fw, fh) = plan.frame;
        for (what, bar) in [
            ("brake", plan.brake),
            ("throttle", plan.throttle),
            ("clutch", plan.clutch),
            ("wheel", plan.steer),
        ] {
            assert!(within_centre(bar, from, to), "{name}: the {what} bar stays in the centre column");
        }
        // The pedals are as tall as the brackets, brake on the left and throttle on the right, outside the frame.
        assert_eq!((plan.brake.1, plan.brake.3), (fy, fh));
        assert_eq!((plan.throttle.1, plan.throttle.3), (fy, fh));
        assert!(plan.brake.0 + plan.brake.2 <= fx, "{name}: the brake is left of the frame");
        assert!(plan.throttle.0 >= fx + fw, "{name}: the throttle is right of the frame");
        // The clutch sits on the outer side of the brake, apart from it, and is thinner.
        assert!(
            plan.clutch.0 + plan.clutch.2 < plan.brake.0 && plan.clutch.2 < plan.brake.2,
            "{name}: clutch"
        );
        // The wheel bar is about the frame's width, under the speed and its unit, above the bottom line.
        assert!((plan.steer.2 - fw).abs() < 1.0);
        assert!(
            plan.steer.1 >= plan.unit.1 + plan.unit.3 && plan.steer.1 + plan.steer.3 <= plan.bottom,
            "{name}: wheel"
        );
        assert!(!overlap(plan.steer, plan.brake) && !overlap(plan.steer, plan.throttle));
        // The letters under the pedals end above the wheel bar.
        assert!(plan.brake.1 + plan.brake.3 + 17.0 <= plan.steer.1 + plan.steer.3);
    }
    // The main block's middle ends above its car strip.
    assert!(centre_plan(CANVAS_W / 2.0, 100.0, 140.0, true).bottom < STRIP_TOP - 5.0);
}

#[test]
fn without_a_delta_the_gear_frame_rises_and_grows_so_the_middle_keeps_its_height() {
    for (cx, frame_h) in [(CANVAS_W / 2.0, 140.0), (PORTRAIT_W / 2.0, 190.0)] {
        let with = centre_plan(cx, 100.0, frame_h, true);
        let without = centre_plan(cx, 100.0, frame_h, false);
        assert_eq!(with.bottom, without.bottom, "the rest of the layout does not move");
        assert!(without.frame.1 < with.frame.1 && without.frame.3 > with.frame.3);
        assert_eq!(without.brake.3, without.frame.3, "the pedals follow the frame");
        assert!(without.frame.1 >= 100.0, "and stays under the top of the block");
    }
}

#[test]
fn the_car_strip_cards_fit_their_row_and_the_least_important_go_first() {
    let (row_y, row_h) = (STRIP_TOP, CANVAS_H - STRIP_TOP - 8.0);
    let every = [CarCard::Lights, CarCard::Engine, CarCard::Electronics];
    let all = strip_plan(0.0, row_y, CANVAS_W, row_h, &every);
    let kinds: Vec<CarCard> = all.iter().map(|c| c.0).collect();
    assert_eq!(
        kinds,
        [CarCard::Lights, CarCard::Engine, CarCard::Electronics],
        "the main block has room for all three"
    );
    for (card, area) in &all {
        assert!(inside_box(*area, 0.0, row_y, CANVAS_W, row_h), "{card:?} is inside its row");
        assert!(area.2 >= card.min_w(), "{card:?} is wide enough to read");
    }
    for pair in all.windows(2) {
        assert!(!overlap(pair[0].1, pair[1].1), "cards side by side, not over each other");
        assert!(pair[1].1 .0 > pair[0].1 .0 + pair[0].1 .2, "with a gap");
    }
    // Less room: the engine and fuel card goes first, then electronics; the lights never.
    let two: Vec<CarCard> = strip_plan(0.0, 0.0, 560.0, 100.0, &every).iter().map(|c| c.0).collect();
    assert_eq!(two, [CarCard::Lights, CarCard::Electronics]);
    let one: Vec<CarCard> = strip_plan(0.0, 0.0, 300.0, 100.0, &every).iter().map(|c| c.0).collect();
    assert_eq!(one, [CarCard::Lights]);
    let tiny: Vec<CarCard> = strip_plan(0.0, 0.0, 120.0, 100.0, &every).iter().map(|c| c.0).collect();
    assert_eq!(tiny, [CarCard::Lights], "the lights stay even where they are squeezed");
    // The tiles of the lights card stay inside it, in a grid that does not overlap, whatever the card's size.
    let (_, lights) = all[0];
    let main_inner = (lights.0 + 14.0, lights.1 + 32.0, lights.2 - 28.0, lights.3 - 40.0);
    let portrait_inner = (0.0, 0.0, PORTRAIT_W - 28.0, 40.0);
    for inner in [main_inner, portrait_inner] {
        for n in 1..=9 {
            let cells = light_cells(inner, n);
            assert_eq!(cells.len(), n);
            for (i, c) in cells.iter().enumerate() {
                assert!(
                    inside_box(*c, inner.0, inner.1, inner.2, inner.3),
                    "tile {i} of {n} inside the card"
                );
                for d in &cells[i + 1..] {
                    assert!(!overlap(*c, *d), "tiles of {n} do not overlap");
                }
            }
        }
    }
    // And the other two cards' figures stay inside theirs, however many are known.
    let (_, engine) = all[1];
    let inner = (engine.0 + 14.0, engine.1 + 32.0, engine.2 - 28.0, engine.3 - 40.0);
    for n in 1..=4 {
        for c in cell_grid(inner, n, 2) {
            assert!(inside_box(c, inner.0, inner.1, inner.2, inner.3), "{n} figures in the engine card");
        }
    }
    for (stats, bars) in [(true, true), (true, false), (false, true)] {
        let (s, b) = electronics_split(inner, stats, bars);
        assert!(!overlap(s, b));
        assert!(inside_box(s, inner.0, inner.1, inner.2, inner.3) && inside_box(b, inner.0, inner.1, inner.2, inner.3));
    }
}

#[test]
fn a_light_the_game_does_not_give_is_not_drawn() {
    use crate::game::{CarState, Drs, Flag};
    let mut live = live_reading();
    live.fuel_per_lap_l = None;
    live.state = CarState::UNKNOWN;
    assert!(light_pills(&live).is_empty(), "nothing known, nothing drawn (not even as off)");
    // Only what is given appears, in the fixed order, lit or off.
    live.state.headlights = Some(false);
    live.state.abs_active = Some(true);
    live.state.drs = Some(Drs::Available);
    live.state.flag = Some(Flag::Yellow);
    let kinds: Vec<(PillKind, Glow)> = light_pills(&live).iter().map(|p| (p.kind, p.glow)).collect();
    assert_eq!(
        kinds,
        [
            (PillKind::Abs, Glow::On),
            (PillKind::Drs, Glow::Ready),
            (PillKind::Headlights, Glow::Off),
            (PillKind::Flag, Glow::Off)
        ]
    );
    for hidden in [PillKind::Pit, PillKind::Tc, PillKind::Fuel, PillKind::Engine, PillKind::Handbrake] {
        assert!(light_pills(&live).iter().all(|p| p.kind != hidden), "{hidden:?} is not given");
    }
    live.state.drs = Some(Drs::Open);
    assert_eq!(light_pills(&live)[1].glow, Glow::On, "DRS open is lit");
    // The same in the picture: a light that is not given paints nothing, one that is lit paints its colour.
    let f = fixture();
    let none = {
        let mut l = live_reading();
        l.state = CarState::UNKNOWN;
        l.fuel_per_lap_l = None;
        l
    };
    let lit = {
        let mut l = none.clone();
        l.state.engine_warning = Some(true);
        l.state.handbrake = Some(true);
        l
    };
    let (w, h) = (1032, 602);
    let plain = render(&view(&f, Some(&none), Tab::Dash, 1.0, Lang::En), w, h);
    let drawn = render(&view(&f, Some(&lit), Tab::Dash, 1.0, Lang::En), w, h);
    assert!(has_color(&drawn, RED) > has_color(&plain, RED) + 200, "ENG and HB light up in red");
}

#[test]
fn laps_of_fuel_left_are_computed_and_hidden_without_the_use_per_lap() {
    assert_eq!(fuel_laps_left(30.0, Some(2.0)), Some(15.0));
    assert_eq!(fuel_laps_left(0.0, Some(2.0)), Some(0.0));
    assert_eq!(fuel_laps_left(-1.0, Some(2.0)), Some(0.0), "never below nothing");
    assert_eq!(fuel_laps_left(30.0, None), None, "no use per lap, no laps");
    assert_eq!(fuel_laps_left(30.0, Some(0.0)), None);
    assert_eq!(fuel_laps_left(30.0, Some(f32::NAN)), None);
    assert_eq!(fuel_laps_left(f32::NAN, Some(2.0)), None);
    let mut live = live_reading();
    live.fuel_l = 38.6;
    live.fuel_per_lap_l = Some(2.9);
    assert_eq!(fuel_laps_text(&live, Lang::En).as_deref(), Some("≈ 13.3 laps"));
    assert_eq!(fuel_laps_text(&live, Lang::Pt).as_deref(), Some("≈ 13.3 voltas"));
    assert_eq!(fuel_per_lap_text(&live, Lang::En).as_deref(), Some("2.9 L/lap"));
    assert_eq!(fuel_per_lap_text(&live, Lang::Pt).as_deref(), Some("2.9 L/volta"));
    live.fuel_per_lap_l = None;
    assert_eq!(fuel_laps_text(&live, Lang::En), None, "no laps until the use per lap is known");
    assert_eq!(fuel_per_lap_text(&live, Lang::En), None);
    assert!(engine_cells(&live, Lang::En)
        .iter()
        .all(|c| c.label != text(Lang::En, &Msg::PanelLapsLeft)));
    // The fuel light needs the laps too: under two laps it is lit.
    assert!(light_pills(&live).iter().all(|p| p.kind != PillKind::Fuel));
    live.fuel_per_lap_l = Some(2.9);
    live.fuel_l = 4.0;
    assert_eq!(
        light_pills(&live).iter().find(|p| p.kind == PillKind::Fuel).map(|p| p.glow),
        Some(Glow::On)
    );
    live.fuel_l = 20.0;
    assert_eq!(
        light_pills(&live).iter().find(|p| p.kind == PillKind::Fuel).map(|p| p.glow),
        Some(Glow::Off)
    );
}

#[test]
fn a_fuel_reading_taken_while_not_driving_never_warns_and_a_zero_is_not_shown() {
    let mut live = live_reading();
    live.fuel_per_lap_l = Some(2.9);
    live.fuel_l = 0.0;
    assert!(fuel_low(&live), "driving with an empty tank warns");
    live.driving = false;
    assert!(!fuel_low(&live), "no warning from a reading taken in the menu");
    assert_eq!(fuel_reading(&live), None, "a 0 in the menu is not a reading");
    assert_eq!(laps_left(&live), None);
    assert!(light_pills(&live).iter().all(|p| p.kind != PillKind::Fuel), "no FUEL light either");
    assert!(engine_cells(&live, Lang::En)
        .iter()
        .all(|c| c.label != text(Lang::En, &Msg::PanelLapsLeft)));
    // A real reading while not driving (in the pits box, say) is shown, but still never warns.
    live.fuel_l = 3.0;
    assert_eq!(fuel_reading(&live), Some(3.0));
    assert!(!fuel_low(&live));
    assert_eq!(
        light_pills(&live).iter().find(|p| p.kind == PillKind::Fuel).map(|p| p.glow),
        Some(Glow::Off)
    );
    // Driving: red under two laps, not at two.
    live.driving = true;
    live.fuel_per_lap_l = Some(2.0);
    live.fuel_l = 3.9;
    assert!(fuel_low(&live));
    live.fuel_l = 4.0;
    assert!(!fuel_low(&live));
    live.fuel_l = f32::NAN;
    assert_eq!(fuel_reading(&live), None);
}

#[test]
fn the_tank_gauge_is_the_fuel_against_the_tank_and_never_past_it() {
    assert_eq!(fuel_share(30.0, Some(60.0)), Some(0.5));
    assert_eq!(fuel_share(60.0, Some(60.0)), Some(1.0));
    assert_eq!(fuel_share(65.0, Some(60.0)), Some(1.0), "a tank known too small reads full");
    assert_eq!(fuel_share(0.0, Some(60.0)), Some(0.0));
    assert_eq!(fuel_share(30.0, None), None, "no tank, no gauge");
    assert_eq!(fuel_share(30.0, Some(0.0)), None);
    assert_eq!(fuel_share(f32::NAN, Some(60.0)), None);
}

#[test]
fn the_columns_share_their_room_among_what_is_shown() {
    // Three times in the column: a row each; fewer: taller rows, never past half again.
    assert_eq!(left_row_h(3, 98.0), 98.0);
    assert_eq!(left_row_h(2, 98.0), 147.0);
    assert_eq!(left_row_h(1, 98.0), 147.0);
    for n in 1..=3 {
        assert!(n as f32 * left_row_h(n, 98.0) <= 3.0 * 98.0 + 0.01, "{n} rows fit the column");
    }
    // The right column: fuel on top, the lap under it; one alone starts at the top.
    let (fuel, lap) = right_plan(98.0, true, true);
    let (fuel, lap) = (fuel.unwrap(), lap.unwrap());
    assert_eq!(fuel.0, 0.0);
    assert_eq!(lap.0, fuel.0 + fuel.1, "no hole between them");
    assert!(lap.0 + lap.1 <= 3.0 * 98.0 + 0.01, "inside the column");
    assert_eq!(right_plan(98.0, false, true).1.map(|(at, _)| at), Some(0.0));
    assert_eq!(right_plan(98.0, true, false).0.map(|(at, _)| at), Some(0.0));
    assert_eq!(right_plan(98.0, false, false), (None, None));
}

#[test]
fn a_game_that_gives_nothing_shows_nothing_extra() {
    use crate::game::CarState;
    let mut live = live_reading();
    live.state = CarState::UNKNOWN;
    live.fuel_per_lap_l = None;
    live.tyres = None;
    live.map = None;
    assert_eq!(present_cards(&live), Vec::<CarCard>::new(), "no card without something to show");
    assert!(strip_plan(0.0, 0.0, CANVAS_W, 100.0, &[]).is_empty());
    assert!(!has_side(&live), "no column without a map or tyres");
    assert!(main_height(&live) < CANVAS_H, "no strip, no empty band under the dashboard");
    live.state.water_c = Some(90.0);
    assert_eq!(main_height(&live), CANVAS_H);
    live.state.tc_level = Some(2);
    assert_eq!(present_cards(&live), [CarCard::Engine, CarCard::Electronics]);
    // The two that remain take the whole row.
    let plan = strip_plan(0.0, 0.0, CANVAS_W, 100.0, &present_cards(&live));
    assert_eq!(plan.len(), 2);
    assert!((plan[1].1 .0 + plan[1].1 .2 - CANVAS_W).abs() < 0.01, "right edge reached: no hole");
    live.state.headlights = Some(true);
    assert_eq!(present_cards(&live)[0], CarCard::Lights);
    // Lights alone take the row too, and the lights card is the last to go when the row is narrow.
    assert_eq!(
        strip_plan(0.0, 0.0, 300.0, 100.0, &[CarCard::Lights, CarCard::Engine])[0].0,
        CarCard::Lights
    );
    assert_eq!(strip_plan(0.0, 0.0, 300.0, 100.0, &[CarCard::Engine])[0].0, CarCard::Engine);
    // A reading without times, delta, fuel, pedals, speed or wheel paints without a placeholder.
    let f = fixture();
    let mut bare = live.clone();
    bare.lap_time_s = None;
    bare.last_lap_s = None;
    bare.best_lap_s = None;
    bare.delta_s = None;
    bare.dist_m = None;
    bare.fuel_l = f32::NAN;
    for value in [
        &mut bare.throttle,
        &mut bare.brake,
        &mut bare.clutch,
        &mut bare.steer,
        &mut bare.speed_ms,
        &mut bare.gear,
    ] {
        *value = f32::NAN;
    }
    for (w, h) in [(1536, 864), (1024, 768), (540, 1080), (960, 600), (2560, 1080)] {
        let v = view(&f, Some(&bare), Tab::Dash, 1.0, Lang::En);
        assert!(!render(&v, w, h).is_empty());
    }
    let full = render(&view(&f, Some(&live), Tab::Dash, 1.0, Lang::En), 1536, 864);
    let none = render(&view(&f, Some(&bare), Tab::Dash, 1.0, Lang::En), 1536, 864);
    assert!(has_color(&full, GREEN) > has_color(&none, GREEN) || has_color(&full, ACCENT) > has_color(&none, ACCENT));
    // Without the gear the frame's brackets are gone too, and the yellow gear letter with them.
    assert!(has_color(&none, ACCENT) < has_color(&full, ACCENT) / 2);
}

#[test]
fn the_light_tiles_are_a_grid_of_equal_tiles_without_a_lone_one_on_a_row_of_its_own() {
    for inner in [(0.0, 0.0, 297.0, 72.0), (0.0, 0.0, 572.0, 40.0), (0.0, 0.0, 200.0, 72.0)] {
        for n in 1..=9 {
            let cells = light_cells(inner, n);
            let (w, h) = (cells[0].2, cells[0].3);
            assert!(cells.iter().all(|c| c.2 == w && c.3 == h), "{n} tiles of one size");
            let rows: std::collections::BTreeSet<i32> = cells.iter().map(|c| (c.1 * 100.0) as i32).collect();
            let cols: std::collections::BTreeSet<i32> = cells.iter().map(|c| (c.0 * 100.0) as i32).collect();
            for row in &rows {
                let in_row = cells.iter().filter(|c| (c.1 * 100.0) as i32 == *row).count();
                assert!(in_row > 1 || rows.len() == 1 || cols.len() == 1, "{n} tiles: a row with one tile");
            }
            // Aligned: one x per column, one y per row.
            assert_eq!(cells.len(), n);
        }
    }
    // Counts that divide evenly fill their rows.
    let six = light_cells((0.0, 0.0, 297.0, 72.0), 6);
    assert_eq!(six.iter().filter(|c| c.1 == six[0].1).count(), 3, "six is three by two");
    let nine = light_cells((0.0, 0.0, 572.0, 40.0), 9);
    assert!(nine.iter().all(|c| c.1 == nine[0].1), "nine in a wide, short card is one row");
    // Colours by meaning.
    assert_eq!(pill_color(PillKind::Fuel), AMBER);
    assert_eq!(pill_color(PillKind::Pit), AMBER);
    assert_eq!(pill_color(PillKind::Engine), RED);
    assert_eq!(pill_color(PillKind::Abs), BLUE);
    assert_eq!(pill_color(PillKind::Tc), GREEN);
}

#[test]
fn a_lit_light_paints_its_colour_and_an_unlit_one_does_not() {
    let f = fixture();
    let mut live = live_reading();
    live.state.pit_limiter = Some(false);
    let (w, h) = (1536, 864);
    let off = render(&view(&f, Some(&live), Tab::Dash, 1.0, Lang::En), w, h);
    live.state.pit_limiter = Some(true);
    let on = render(&view(&f, Some(&live), Tab::Dash, 1.0, Lang::En), w, h);
    assert!(
        has_color(&on, AMBER) > has_color(&off, AMBER) + 400,
        "the PIT tile fills with amber"
    );
}

#[test]
fn the_engine_and_electronics_cards_keep_only_what_is_known() {
    use crate::game::CarState;
    let mut live = live_reading();
    live.state = CarState::UNKNOWN;
    assert!(electronics_cells(&live, Lang::En).is_empty() && damage_bars(&live, Lang::En).is_empty());
    live.state.water_c = Some(92.0);
    live.fuel_per_lap_l = None;
    let engine = engine_cells(&live, Lang::En);
    assert_eq!(engine.len(), 1, "water alone: oil, use and laps are left out");
    assert_eq!(engine[0].value, "92 °C");
    live.state.tc_level = Some(0);
    live.state.brake_bias = Some(0.56);
    live.state.damage_gearbox = Some(0.4);
    let cells = electronics_cells(&live, Lang::En);
    assert_eq!(cells.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["OFF", "56.0 %"]);
    assert_eq!(damage_bars(&live, Lang::En), [("Gbx".to_owned(), 0.4)]);
    assert_eq!(damage_color(0.0), GREEN);
    assert_eq!(damage_color(0.5), AMBER);
    assert_eq!(damage_color(1.0), RED);
}

#[test]
fn the_brake_disc_and_tyre_colours_follow_their_temperature() {
    assert_eq!(brake_color(100.0), STEEL);
    assert_eq!(brake_color(300.0), GREEN);
    assert_eq!(brake_color(600.0), AMBER);
    assert_eq!(brake_color(800.0), RED);
    assert_eq!(brake_color(f32::NAN), MUTED);
    assert_eq!(tyre_color(50.0), STEEL, "a cold tyre is a calm steel blue");
    assert_eq!(tyre_color(80.0), GREEN);
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
    assert_eq!(state_color(&Game::Loading), MUTED);
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
fn each_screen_shape_gets_the_layout_that_fills_it() {
    // The window's body: the window less the header (66) and the margins (16 around).
    let body = |w: f32, h: f32| (w - 32.0, h - 66.0 - 16.0);
    let pick = |w: f32, h: f32| {
        let (bw, bh) = body(w, h);
        pick_layout(bw, bh, true, CANVAS_H)
    };
    assert_eq!(pick(2560.0, 1080.0), Layout::Ultrawide);
    assert_eq!(pick(3440.0, 1440.0), Layout::Ultrawide);
    assert_eq!(pick(1920.0, 1080.0), Layout::Wide);
    assert_eq!(pick(1536.0, 864.0), Layout::Wide, "the window as it opens on a 1080p screen");
    assert_eq!(pick(1680.0, 1050.0), Layout::Wide);
    assert_eq!(pick(1024.0, 768.0), Layout::Square);
    assert_eq!(pick(1280.0, 1024.0), Layout::Square);
    assert_eq!(pick(430.0, 900.0), Layout::Portrait);
    assert_eq!(pick(768.0, 1024.0), Layout::Portrait, "a tablet held upright");
    assert_eq!(pick(960.0, 600.0), Layout::Classic, "too small for the column to read well");
    // Nothing for the column or the row (no map, no tyres): the main dashboard takes the room instead.
    let bare = |w: f32, h: f32| {
        let (bw, bh) = body(w, h);
        let layout = pick_layout(bw, bh, false, CANVAS_H);
        (layout, layout.size(false, CANVAS_H))
    };
    assert_eq!(
        bare(2560.0, 1080.0).1,
        (CANVAS_W, CANVAS_H),
        "an ultrawide shows the dashboard alone"
    );
    for (w, h) in [(1024.0, 768.0), (1280.0, 1024.0), (1920.0, 1080.0)] {
        assert_eq!(bare(w, h).1 .0, CANVAS_W, "no column at {w} x {h}");
        assert_ne!(bare(w, h).0, Layout::Square, "a row with nothing in it is no layout at {w} x {h}");
    }
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
        }),
    );
    let mut live = tracker.on_frame("Assetto Corsa", &frame, 1_000);
    let track: Vec<(f32, f32)> = (0..400)
        .map(|i| {
            let t = i as f32 / 400.0 * std::f32::consts::TAU;
            (600.0 * t.cos() + 130.0 * (3.0 * t).cos(), 300.0 * t.sin() - 110.0 * (2.0 * t).sin())
        })
        .collect();
    live.pos = Some(track[160]);
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
    }
}

fn view<'a>(f: &'a Fixture, live: Option<&'a Live>, tab: Tab, scale: f32, lang: Lang) -> View<'a> {
    View {
        lang,
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
        lang_open: false,
        copied: false,
        failed: "",
        update: &f.update,
        focus: None,
    }
}

#[test]
fn paints_the_dashboard_with_the_gear_in_the_accent_colour_and_the_delta_in_green() {
    let f = fixture();
    let live = live_reading();
    let (w, h) = (960, 600);
    let pixels = render(&view(&f, Some(&live), Tab::Dash, 1.0, Lang::En), w, h);
    save(&pixels, w, h, "panel-dashboard.png");
    assert!(pixels[..3].iter().all(|&c| c < 0x24), "the corner is the dark background");
    assert!(
        has_color(&pixels, ACCENT) > 2000,
        "the selected tab and the gear are drawn in the accent"
    );
    assert!(
        has_color(&pixels, GREEN) > 300,
        "a negative delta, the throttle and the low revs are green"
    );
    assert!(has_color(&pixels, RED) < has_color(&pixels, GREEN), "no brake, revs under the red");
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
fn out_of_the_car_the_header_shows_no_lap_and_no_invalid_badge() {
    let f = fixture();
    let mut live = live_reading();
    live.lap_valid = Some(false);
    let (w, h) = (1920, 1080);
    let header = (1700, 135, 1920, 185);
    let driving = render(&view(&f, Some(&live), Tab::Dash, 1.0, Lang::En), w, h);
    let lap = region_of(&driving, w, header);
    assert!(has_color(&lap, ACCENT) > 200, "driving: the lap number is there");
    assert!(has_color(&lap, RED) > 20, "driving: and the invalid mark");
    live.driving = false;
    let menu = render(&view(&f, Some(&live), Tab::Dash, 1.0, Lang::En), w, h);
    let lap = region_of(&menu, w, header);
    assert_eq!(has_color(&lap, ACCENT), 0, "in the menu: no lap number");
    assert_eq!(has_color(&lap, RED), 0, "in the menu: no invalid badge");
}

#[test]
fn the_recent_laps_band_draws_only_the_laps_that_exist() {
    let f = fixture();
    let live = live_reading();
    let few = vec![saved_lap(3, 107_918)];
    let (w, h) = (1920, 1080);
    let mut v = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
    v.recent_laps = &few;
    let pixels = render(&v, w, h);
    // Two cards (one lap done, the lap being driven) of the normal width: the row to their right is bare.
    let empty = region_of(&pixels, w, (600, 880, 1380, 1050));
    assert_eq!(has_color(&empty, CARD), 0, "no empty card");
    assert_eq!(has_color(&empty, mix(BG, CARD, 0.45)), 0, "no placeholder");
    let cards = region_of(&pixels, w, (16, 880, 468, 1050));
    assert!(has_color(&cards, CARD) > 20_000, "the two cards are there");
}

#[test]
fn paints_the_monitor_and_scales_with_the_screen() {
    let f = fixture();
    let (w, h) = (1440, 900);
    let pixels = render(&view(&f, None, Tab::Monitor, 1.5, Lang::En), w, h);
    save(&pixels, w, h, "panel-monitor-150.png");
    assert!(has_color(&pixels, CARD) > 100_000, "the cards fill most of the window");
    assert!(has_color(&pixels, RED) > 10, "the unsupported game has a red dot");
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
    // Nothing waiting: no card, no button.
    assert!(!with(&f, Lang::En, 1280, 800).1.iter().any(|(a, _)| *a == Action::UpdateNow));
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
    let available_red = has_color(&with(&f, Lang::En, 1280, 800).0, RED);
    f.update = UpdateState::Available {
        version: "0.6.0".into(),
        required: true,
        held: false,
    };
    let (required, buttons) = with(&f, Lang::Pt, 1280, 800);
    save(&required, 1280, 800, "panel-monitor-update-required.png");
    assert!(buttons.iter().any(|(a, _)| *a == Action::UpdateNow));
    assert!(has_color(&required, RED) > available_red + 100, "a required update is shown in red");
    assert!(
        has_color(&plain, RED) < has_color(&required, RED),
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
    assert!(
        has_color(&stopped_pixels, RED) > has_color(&before, RED),
        "a stopped part is in red"
    );
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
fn says_it_waits_when_there_is_no_reading_or_it_is_old() {
    let f = fixture();
    let mut old = live_reading();
    old.at_ms = -10_000;
    let (w, h) = (960, 600);
    let waiting = render(&view(&f, None, Tab::Dash, 1.0, Lang::En), w, h);
    save(&waiting, w, h, "panel-waiting.png");
    let stale = render(&view(&f, Some(&old), Tab::Dash, 1.0, Lang::En), w, h);
    assert_eq!(waiting, stale, "a reading older than 3 s is not shown");
    assert!(
        has_color(&waiting, ACCENT) < 6000,
        "no gear while waiting: only the selected tab is in the accent"
    );
}

/// The boxes the tyre schematic gets in each layout that shows it (the area under the "Tyres" title).
const SCHEMATIC_BOXES: [(&str, f32, f32); 5] = [
    ("side column, short", 312.0, 192.0),
    ("side column, tall", 312.0, 255.0),
    ("4:3 bottom row", 490.0, 266.0),
    ("portrait", 336.0, 276.0),
    ("narrow", 200.0, 120.0),
];

fn inside_box(a: Area, x: f32, y: f32, w: f32, h: f32) -> bool {
    let eps = 0.01;
    a.0 >= x - eps && a.1 >= y - eps && a.0 + a.2 <= x + w + eps && a.1 + a.3 <= y + h + eps
}

fn overlap(a: Area, b: Area) -> bool {
    a.2 > 0.0 && b.2 > 0.0 && a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
}

#[test]
fn the_tyre_schematic_fits_its_box_in_every_layout_without_text_over_a_tyre() {
    for brakes in [true, false] {
        for (name, w, h) in SCHEMATIC_BOXES {
            let (x, y) = (7.0, 11.0);
            let plan = schematic(x, y, w, h, brakes);
            for i in 0..4 {
                assert!(inside_box(plan.tyres[i], x, y, w, h), "{name}: tyre {i} is inside the box");
                assert!(inside_box(plan.readout[i], x, y, w, h), "{name}: readout {i} is inside the box");
                assert!(plan.tyres[i].2 < plan.tyres[i].3, "{name}: a tyre is longer than it is wide");
                assert!(!overlap(plan.readout[i], plan.tyres[i]), "{name}: readout {i} clear of its tyre");
                assert!(inside_box(plan.body, x, y, w, h), "{name}: the car's body is inside the box");
                for j in 0..4 {
                    if i != j {
                        assert!(!overlap(plan.tyres[i], plan.tyres[j]), "{name}: tyres {i} and {j} apart");
                        assert!(!overlap(plan.readout[i], plan.tyres[j]), "{name}: readout {i} off tyre {j}");
                    }
                }
                if brakes {
                    assert!(inside_box(plan.brake[i], x, y, w, h), "{name}: brake row {i} inside");
                    assert!(!overlap(plan.brake[i], plan.tyres[i]), "{name}: brake row {i} clear of the tyre");
                    for j in 0..4 {
                        assert!(!overlap(plan.brake[i], plan.readout[j]), "{name}: brake {i} clear of readout {j}");
                    }
                } else {
                    assert_eq!(plan.brake[i].3, 0.0, "{name}: no brake row without brake temperatures");
                }
            }
            // The readouts of a side have room for "100°" and "25.3 psi" (about 70 units), except in the
            // narrowest box.
            if w >= 300.0 {
                assert!(plan.readout[0].2 >= 70.0 && plan.readout[1].2 >= 70.0, "{name}: room for text");
            }
        }
    }
}

#[test]
fn the_tyre_schematic_is_the_car_seen_from_above_with_brakes_at_its_ends() {
    let (x, y, w, h) = (0.0, 0.0, 340.0, 240.0);
    let plan = schematic(x, y, w, h, true);
    let [fl, fr, rl, rr] = plan.tyres;
    assert_eq!(fl.1, fr.1, "the fronts side by side, level");
    assert_eq!(rl.1, rr.1, "the rears side by side, level");
    assert!(fl.1 + fl.3 < rl.1, "front above rear, the body between");
    // Symmetric around the middle.
    let mid = w / 2.0;
    assert!(((fl.0 + fl.2 / 2.0 + fr.0 + fr.2 / 2.0) / 2.0 - mid).abs() < 1e-3);
    assert!(((fl.0 + fl.2) - (mid - (fr.0 - mid))).abs() < 1e-3);
    assert!(
        (plan.body.0 + plan.body.2 / 2.0 - mid).abs() < 1e-3,
        "the body is on the centre line"
    );
    // Fronts' brake above the tyre, rears' below.
    assert!(plan.brake[0].1 + plan.brake[0].3 <= fl.1 && plan.brake[1].1 + plan.brake[1].3 <= fr.1);
    assert!(plan.brake[2].1 >= rl.1 + rl.3 && plan.brake[3].1 >= rr.1 + rr.3);
    // The tyres sit partly outside the body: the inner edge of each is inside it, the outer edge beyond it.
    let (bx, _, bw, _) = plan.body;
    for t in plan.tyres {
        let (inner, outer) = if t.0 < mid { (t.0 + t.2, t.0) } else { (t.0, t.0 + t.2) };
        assert!(inner > bx && inner < bx + bw, "the inner edge of a tyre is over the body");
        assert!(outer < bx || outer > bx + bw, "the outer edge of a tyre is outside the body");
    }
    // The body runs from the front tyres to the rear ones.
    assert!(plan.body.1 <= fl.1 + fl.3 / 2.0 && plan.body.1 + plan.body.3 >= rl.1 + rl.3 / 2.0);
    // Left tyres' readouts end before their tyre, right tyres' start after it.
    assert!(plan.readout[0].0 + plan.readout[0].2 < fl.0);
    assert!(plan.readout[1].0 > fr.0 + fr.2);
    // The outline of the car stays inside the body's box and is the same on both sides.
    let outline = body_outline(plan.body);
    assert!(outline.iter().all(|&(px, py)| inside_box(
        (px, py, 0.0, 0.0),
        plan.body.0 - 0.01,
        plan.body.1 - 0.01,
        plan.body.2 + 0.02,
        plan.body.3 + 0.02
    )));
    let n = outline.len() / 2;
    for k in 0..n {
        let (right, left) = (outline[k], outline[outline.len() - 1 - k]);
        assert!((right.0 + left.0 - 2.0 * mid).abs() < 1e-3 && (right.1 - left.1).abs() < 1e-3);
    }
}

#[test]
fn the_schematic_is_painted_for_every_shape_and_a_brake_only_tyre_gets_its_row() {
    let f = fixture();
    let mut live = live_reading();
    let with_brakes = {
        let v = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
        render(&v, 1536, 864)
    };
    // A game that gives no brake temperatures: the rows are not kept and the picture still paints.
    for t in live.tyres.as_mut().unwrap() {
        t.brake_c = f32::NAN;
    }
    let without = {
        let v = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
        render(&v, 1536, 864)
    };
    assert_ne!(with_brakes, without);
    // Brake temperatures alone (no tyre temperature, pressure or wear): still a schematic.
    let tyre = crate::game::Tyre {
        brake_c: 400.0,
        temp_c: f32::NAN,
        pressure_kpa: f32::NAN,
        left: f32::NAN,
    };
    live.tyres = Some([tyre; 4]);
    for (w, h) in [(1536, 864), (1024, 768), (540, 1080)] {
        let v = view(&f, Some(&live), Tab::Dash, 1.0, Lang::En);
        assert!(!render(&v, w, h).is_empty());
    }
}

/// With `XPEED_SIM_PANEL_PNG` set, paints the panel the way people see it (a window, full HD, an ultrawide, the
/// other tabs) into that folder with a page that shows them and reloads itself when they change, to review the
/// design in a browser (`.claude/launch.json`: xpeed-sim-panel-preview). Without it, nothing.
#[test]
fn a_whole_lap_closes_with_a_start_mark_and_a_partial_path_stays_open_and_breaks_at_jumps() {
    let lap: Vec<(f32, f32)> = (0..200)
        .map(|i| {
            let a = i as f32 / 200.0 * std::f32::consts::TAU;
            (300.0 * a.cos(), 100.0 * a.sin())
        })
        .collect();
    let whole = prepare_map(&lap, true, 200.0, 100.0, 400.0, 200.0).unwrap();
    assert_eq!(whole.runs.len(), 1);
    assert_eq!(whole.runs[0].first(), whole.runs[0].last(), "a whole lap closes");
    assert!(whole.start.is_some());
    let partial = prepare_map(&lap[..150], false, 200.0, 100.0, 400.0, 200.0).unwrap();
    assert_ne!(
        partial.runs[0].first(),
        partial.runs[0].last(),
        "a partial path is not joined back to its start"
    );
    assert!(partial.start.is_none());
    let mut jumped = lap[..100].to_vec();
    jumped.extend(lap[..100].iter().map(|&(x, z)| (x + 2000.0, z)));
    assert_eq!(prepare_map(&jumped, false, 200.0, 100.0, 400.0, 200.0).unwrap().runs.len(), 2);
    // The car is placed with the map's own transform: the first point of the lap is the start mark's place.
    let at = whole.fit.apply(lap[0]);
    assert!(whole.runs[0].iter().any(|p| (p.0 - at.0).hypot(p.1 - at.1) < 8.0));
    // Everything lies in the box, with its margin.
    assert!(whole.runs[0]
        .iter()
        .all(|p| (0.0..=400.0).contains(&p.0) && (0.0..=200.0).contains(&p.1)));
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
    for (file, caption, reading, w, h) in [
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
    assert_eq!(delta_text(Some(-0.274)).as_deref(), Some("-0.27"));
    assert_eq!(delta_text(Some(0.0)).as_deref(), Some("+0.00"));
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
    time("one veil 283x425", &|g| g.veil_exact((100.0, 100.0, 283.0, 425.0), BG, 0.5));
    time("backdrop (kept)", &|g| g.backdrop(w, h));
    time("rev bar", &|g| g.rev_bar(0.0, 0.0, 1360.0, 36.0, 0.9, false));
    time("text 34px", &|g| {
        g.text(
            "Waiting for a game",
            rect(0, 0, 900, 60),
            34.0,
            FW_SEMIBOLD as i32,
            Face::Num,
            TEXT,
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
    assert_eq!(argb(ACCENT), 0xfff5_e663);
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
