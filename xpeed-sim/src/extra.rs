//! The channels version 2 of the lap file adds to the ones of version 1: the four tyres' temperature, pressure and
//! tread left, the four brakes' temperature, the car's G, bodywork damage, DRS, and whether traction control and ABS
//! are acting.
//!
//! Both lap cutters (`lapcut.rs` for every game but one, `recorder.rs` for Le Mans Ultimate) feed one `Extras` the
//! `Frame` of each sample and take the columns out at the end. A column the game never gave is left out of the file
//! (never filled with zeros); a few missing readings inside a column the game does give stay `NaN`.

use crate::game::{Drs, Frame};
use crate::lapfile::{Channel, STANDARD_UNITS};

/// The wheels in the order of a `Frame`'s tyres and of the channel ids: front left, front right, rear left, rear right.
const WHEELS: [&str; 4] = ["fl", "fr", "rl", "rr"];

#[derive(Default)]
pub struct Extras {
    tyre_temp: [Vec<f32>; 4],
    tyre_press: [Vec<f32>; 4],
    tyre_wear: [Vec<f32>; 4],
    brake_temp: [Vec<f32>; 4],
    g_lat: Vec<f32>,
    g_long: Vec<f32>,
    damage_body: Vec<f32>,
    drs: Vec<f32>,
    tc_active: Vec<f32>,
    abs_active: Vec<f32>,
}

/// What a reading says, or `NaN` when it says nothing sensible (the lap file has no infinities).
fn finite(v: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        f32::NAN
    }
}

fn flag(on: Option<bool>) -> f32 {
    on.map_or(f32::NAN, |on| if on { 1.0 } else { 0.0 })
}

impl Extras {
    /// One sample: what `frame` says about the tyres, the brakes, the G, the damage, the DRS and the aids.
    pub fn push(&mut self, frame: &Frame) {
        for i in 0..4 {
            let tyre = frame.tyres.as_ref().map(|tyres| tyres[i]);
            self.tyre_temp[i].push(tyre.map_or(f32::NAN, |t| finite(t.temp_c)));
            self.tyre_press[i].push(tyre.map_or(f32::NAN, |t| finite(t.pressure_kpa)));
            self.tyre_wear[i].push(tyre.map_or(f32::NAN, |t| finite(t.left)));
            self.brake_temp[i].push(tyre.map_or(f32::NAN, |t| finite(t.brake_c)));
        }
        self.g_lat.push(frame.g_lat.map_or(f32::NAN, finite));
        self.g_long.push(frame.g_long.map_or(f32::NAN, finite));
        self.damage_body
            .push(frame.state.damage_body.map_or(f32::NAN, |d| finite(d).clamp(0.0, 1.0)));
        // 0: not allowed here, 1: the driver may open it, 2: open.
        self.drs.push(frame.state.drs.map_or(f32::NAN, |d| match d {
            Drs::Off => 0.0,
            Drs::Available => 1.0,
            Drs::Open => 2.0,
        }));
        self.tc_active.push(flag(frame.state.tc_active));
        self.abs_active.push(flag(frame.state.abs_active));
    }

    /// The columns the game gave (in the order of the spec), each with its standard unit.
    pub fn into_channels(self) -> Vec<Channel> {
        let mut named: Vec<(String, Vec<f32>)> = Vec::new();
        for (prefix, columns) in [
            ("tyre_temp", self.tyre_temp),
            ("tyre_press", self.tyre_press),
            ("tyre_wear", self.tyre_wear),
            ("brake_temp", self.brake_temp),
        ] {
            for (wheel, values) in WHEELS.iter().zip(columns) {
                named.push((format!("{prefix}_{wheel}"), values));
            }
        }
        named.push(("g_lat".into(), self.g_lat));
        named.push(("g_long".into(), self.g_long));
        named.push(("damage_body".into(), self.damage_body));
        named.push(("drs".into(), self.drs));
        named.push(("tc_active".into(), self.tc_active));
        named.push(("abs_active".into(), self.abs_active));
        named
            .into_iter()
            .filter(|(_, values)| values.iter().any(|v| v.is_finite()))
            .map(|(id, values)| {
                let unit = STANDARD_UNITS.iter().find(|(name, _)| *name == id).map_or("", |(_, unit)| *unit);
                Channel {
                    id,
                    unit: unit.into(),
                    values,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::Tyre;

    fn tyre(temp: f32, kpa: f32, left: f32, brake: f32) -> Tyre {
        Tyre {
            brake_c: brake,
            temp_c: temp,
            pressure_kpa: kpa,
            left,
        }
    }

    fn ids(channels: &[Channel]) -> Vec<&str> {
        channels.iter().map(|c| c.id.as_str()).collect()
    }

    #[test]
    fn a_frame_that_says_nothing_gives_no_channel() {
        let mut extras = Extras::default();
        for _ in 0..5 {
            extras.push(&Frame::empty());
        }
        assert!(extras.into_channels().is_empty(), "absent, not zero");
    }

    #[test]
    fn gives_each_channel_the_game_gave_with_its_unit_and_leaves_out_the_rest() {
        let mut extras = Extras::default();
        for n in 0..3 {
            let mut f = Frame::empty();
            f.tyres = Some([
                tyre(80.0 + n as f32, 200.0, 0.9, f32::NAN),
                tyre(81.0, 201.0, 0.8, f32::NAN),
                tyre(82.0, 202.0, 0.7, f32::NAN),
                tyre(83.0, 203.0, 0.6, f32::NAN),
            ]);
            f.g_lat = Some(1.5);
            f.g_long = Some(-0.5);
            f.state.tc_active = Some(n == 1);
            f.state.drs = Some(Drs::Open);
            extras.push(&f);
        }
        let channels = extras.into_channels();
        assert_eq!(
            ids(&channels),
            [
                "tyre_temp_fl",
                "tyre_temp_fr",
                "tyre_temp_rl",
                "tyre_temp_rr",
                "tyre_press_fl",
                "tyre_press_fr",
                "tyre_press_rl",
                "tyre_press_rr",
                "tyre_wear_fl",
                "tyre_wear_fr",
                "tyre_wear_rl",
                "tyre_wear_rr",
                "g_lat",
                "g_long",
                "drs",
                "tc_active"
            ],
            "no brake temperature, damage or ABS: the game gave none"
        );
        let by = |id: &str| channels.iter().find(|c| c.id == id).unwrap();
        assert_eq!(by("tyre_temp_fl").values, [80.0, 81.0, 82.0]);
        assert_eq!(by("tyre_temp_fl").unit, "\u{b0}C");
        assert_eq!(by("tyre_press_rr").values, [203.0; 3]);
        assert_eq!(by("tyre_press_rr").unit, "kPa");
        assert_eq!(by("tyre_wear_fr").values, [0.8; 3]);
        assert_eq!((by("g_lat").values[0], by("g_lat").unit.as_str()), (1.5, "g"));
        assert_eq!(by("g_long").values, [-0.5; 3]);
        assert_eq!(by("tc_active").values, [0.0, 1.0, 0.0]);
        assert_eq!((by("drs").values[0], by("drs").unit.as_str()), (2.0, "state"));
        assert!(channels.iter().all(|c| c.values.len() == 3));
    }

    #[test]
    fn a_value_the_game_stops_giving_for_a_moment_is_nan_and_the_column_stays() {
        let mut extras = Extras::default();
        for n in 0..3 {
            let mut f = Frame::empty();
            f.g_lat = Some(if n == 1 { f32::INFINITY } else { 1.0 });
            extras.push(&f);
        }
        let channels = extras.into_channels();
        assert_eq!(ids(&channels), ["g_lat"]);
        assert_eq!(channels[0].values[0], 1.0);
        assert!(channels[0].values[1].is_nan(), "an infinity is not written");
    }

    #[test]
    fn brakes_damage_drs_states_and_the_aids_map_to_their_numbers() {
        let mut extras = Extras::default();
        for (drs, abs) in [(Drs::Off, true), (Drs::Available, false), (Drs::Open, true)] {
            let mut f = Frame::empty();
            f.tyres = Some([tyre(f32::NAN, f32::NAN, f32::NAN, 400.0); 4]);
            f.state.drs = Some(drs);
            f.state.abs_active = Some(abs);
            f.state.damage_body = Some(1.5);
            extras.push(&f);
        }
        let channels = extras.into_channels();
        assert_eq!(
            ids(&channels),
            [
                "brake_temp_fl",
                "brake_temp_fr",
                "brake_temp_rl",
                "brake_temp_rr",
                "damage_body",
                "drs",
                "abs_active"
            ]
        );
        let by = |id: &str| channels.iter().find(|c| c.id == id).unwrap();
        assert_eq!(by("drs").values, [0.0, 1.0, 2.0]);
        assert_eq!(by("abs_active").values, [1.0, 0.0, 1.0]);
        assert_eq!(by("damage_body").values, [1.0; 3], "pulled into 0..1");
        assert_eq!(by("brake_temp_rl").values, [400.0; 3]);
    }

    #[test]
    fn every_channel_it_makes_is_a_standard_one_the_writer_accepts() {
        let mut extras = Extras::default();
        let mut f = Frame::empty();
        f.tyres = Some([tyre(80.0, 200.0, 0.5, 300.0); 4]);
        f.g_lat = Some(0.1);
        f.g_long = Some(0.2);
        f.state.damage_body = Some(0.1);
        f.state.drs = Some(Drs::Off);
        f.state.tc_active = Some(true);
        f.state.abs_active = Some(false);
        extras.push(&f);
        let channels = extras.into_channels();
        assert_eq!(channels.len(), 22);
        for c in &channels {
            let (_, unit) = STANDARD_UNITS
                .iter()
                .find(|(id, _)| *id == c.id)
                .unwrap_or_else(|| panic!("{} is not standard", c.id));
            assert_eq!(&c.unit, unit);
        }
    }
}
