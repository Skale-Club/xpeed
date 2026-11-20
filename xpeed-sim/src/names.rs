//! The names people know a car and a track by, for the games whose shared memory gives only a folder name.
//!
//! Assetto Corsa reports the car and the track as the names of their folders (`ks_porsche_macan`, `ks_laguna_seca`,
//! `aiquenovaescala`). Those stay the lap's identity: the track layouts the Companion sends, the site's catalog and its
//! aliases are all keyed by them. The name to show is in the game's own files, and goes beside the identity as a title:
//!
//! * a car: `content/cars/<car>/ui/ui_car.json`, field `name` ("Porsche Macan Turbo");
//! * a track with one layout: `content/tracks/<track>/ui/ui_track.json`, field `name` ("Laguna Seca");
//! * a track with layouts: every `content/tracks/<track>/ui/<layout>/ui_track.json` names the track and the layout
//!   ("Brands Hatch - GP", "Brands Hatch - Indy"). The catalog has one row per track, not per layout, so the title is
//!   the words every layout's name starts with ("Brands Hatch"); when they share none, the driven layout's name.
//!
//! The files are written by hand (mods often are not valid JSON), so a strict parse is tried first and the tolerant
//! field reader of the track extractor after it. A name that is empty, too long for the lap file (120, as the site
//! checks) or has control characters is no name. Nothing here ever stops a lap: no title is the old behaviour.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::lapfile::Lap;

/// The longest title the lap file takes (the site's `isText(title, 120)`).
const MAX_TITLE: usize = 120;

/// The `name` of a `ui_*.json`, when it is one a person can read.
fn ui_name(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim_start_matches('\u{feff}');
    let strict = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_owned));
    let name = strict.or_else(|| crate::tracks::ac::json_field(text, "name"))?;
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let n = name.chars().count();
    ((1..=MAX_TITLE).contains(&n) && !name.chars().any(char::is_control)).then_some(name)
}

/// A folder name the game gave, safe to join onto a path: one component, nothing that climbs or changes drive.
fn folder(id: &str) -> Option<&str> {
    let id = id.trim();
    let bad = id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\', ':']) || id.chars().any(char::is_control);
    (!bad).then_some(id)
}

/// The words all of `names` start with, without a separator left hanging at the end ("Brands Hatch - GP" and
/// "Brands Hatch - Indy" give "Brands Hatch").
fn common_words(names: &[String]) -> Option<String> {
    let first: Vec<&str> = names.first()?.split_whitespace().collect();
    let mut n = first.len();
    for other in &names[1..] {
        let words: Vec<&str> = other.split_whitespace().collect();
        n = n.min(first.iter().zip(&words).take_while(|(a, b)| a.eq_ignore_ascii_case(b)).count());
    }
    let mut kept = first[..n].to_vec();
    while kept
        .last()
        .is_some_and(|w| w.chars().all(|c| matches!(c, '-' | '–' | '—' | ':' | '|' | '/' | ',')))
    {
        kept.pop();
    }
    let joined = kept.join(" ");
    let joined = joined.trim_end_matches([',', ':', '-']).trim_end().to_owned();
    (!joined.is_empty()).then_some(joined)
}

/// The name of an Assetto Corsa car, from the `content` folder of the game.
pub fn ac_car_title(content: &Path, car: &str) -> Option<String> {
    ui_name(&content.join("cars").join(folder(car)?).join("ui").join("ui_car.json"))
}

/// The name of an Assetto Corsa track (all its layouts), from the `content` folder of the game. `variant` is the layout
/// driven, used only when the layouts' names have nothing in common.
pub fn ac_track_title(content: &Path, track: &str, variant: Option<&str>) -> Option<String> {
    let ui = content.join("tracks").join(folder(track)?).join("ui");
    if let Some(name) = ui_name(&ui.join("ui_track.json")) {
        return Some(name);
    }
    let mut layouts: Vec<(String, String)> = std::fs::read_dir(&ui)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = ui_name(&e.path().join("ui_track.json"))?;
            Some((e.file_name().to_string_lossy().into_owned(), name))
        })
        .collect();
    layouts.sort();
    let names: Vec<String> = layouts.iter().map(|(_, name)| name.clone()).collect();
    common_words(&names).or_else(|| {
        let driven = variant.and_then(folder)?;
        layouts
            .into_iter()
            .find(|(dir, _)| dir.eq_ignore_ascii_case(driven))
            .map(|(_, name)| name)
    })
}

/// The `content` folders of the installed Assetto Corsa (the one `XPEED_AC_DIR` names first, then every Steam
/// library). None in the tests: a test never depends on the games of the computer it runs on.
fn ac_content_roots() -> Vec<PathBuf> {
    if cfg!(test) {
        return Vec::new();
    }
    crate::tracks::dump::game_folders("XPEED_AC_DIR", "assettocorsa", "content")
        .into_iter()
        .filter(|p| p.is_dir())
        .collect()
}

/// What was found, per (kind, id): the files are read once per car and per track in a run of the program.
fn remembered(key: String, find: impl FnOnce() -> Option<String>) -> Option<String> {
    static SEEN: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let seen = SEEN.get_or_init(Default::default);
    if let Some(found) = crate::util::lock(seen).get(&key) {
        return found.clone();
    }
    let found = find();
    crate::util::lock(seen).insert(key, found.clone());
    found
}

/// A title that says something the name does not (the same text, case and punctuation aside, is no title).
fn differs(name: &str, title: Option<String>) -> Option<String> {
    let squash = |s: &str| {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    title.filter(|t| squash(t) != squash(name))
}

/// Gives a lap the titles of its car and its track, from `roots` (the game's `content` folders, the first that knows
/// wins). Titles already there are kept; games that report readable names are left alone.
pub fn fill_from(lap: &mut Lap, roots: &[PathBuf]) {
    if lap.game != "ac" || roots.is_empty() {
        return;
    }
    if lap.car_title.is_none() {
        let car = lap.car_name.clone();
        let title = remembered(format!("{roots:?} car {car}"), || roots.iter().find_map(|r| ac_car_title(r, &car)));
        lap.car_title = differs(&car, title);
    }
    if lap.track_title.is_none() {
        let (track, variant) = (lap.track_name.clone(), lap.track_variant.clone());
        let key = format!("{roots:?} track {track}|{}", variant.as_deref().unwrap_or(""));
        let title = remembered(key, || roots.iter().find_map(|r| ac_track_title(r, &track, variant.as_deref())));
        lap.track_title = differs(&track, title);
    }
}

/// [`fill_from`] with the game folders of this computer.
pub fn fill(lap: &mut Lap) {
    if lap.game == "ac" && (lap.car_title.is_none() || lap.track_title.is_none()) {
        fill_from(lap, &ac_content_roots());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn content(name: &str) -> PathBuf {
        let root = crate::config::scratch_dir(name);
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    #[test]
    fn reads_a_cars_name_even_from_json_that_is_not_quite_json() {
        let root = content("names-cars");
        write(
            &root.join("cars/ks_porsche_macan/ui/ui_car.json"),
            "\u{feff}{\"name\": \"Porsche Macan Turbo\", \"brand\": \"Porsche\"}",
        );
        // A literal line break inside a string: not JSON, as many mods write it.
        write(
            &root.join("cars/fsr_copa_hb20/ui/ui_car.json"),
            "{\n\"name\": \"Hyundai Copa HB20\",\n\"description\": \"one\ntwo\"\n}",
        );
        write(&root.join("cars/escaped/ui/ui_car.json"), r#"{"name": "Nürburg  Special"}"#);
        write(&root.join("cars/blank/ui/ui_car.json"), r#"{"name": "   "}"#);
        assert_eq!(ac_car_title(&root, "ks_porsche_macan").as_deref(), Some("Porsche Macan Turbo"));
        assert_eq!(ac_car_title(&root, "fsr_copa_hb20").as_deref(), Some("Hyundai Copa HB20"));
        assert_eq!(ac_car_title(&root, "escaped").as_deref(), Some("Nürburg Special"));
        assert_eq!(ac_car_title(&root, "blank"), None);
        assert_eq!(ac_car_title(&root, "not_installed"), None);
        assert_eq!(
            ac_car_title(&root, "../cars/ks_porsche_macan"),
            None,
            "never climbs out of the folder"
        );
    }

    #[test]
    fn a_track_is_named_by_its_own_file_or_by_what_its_layouts_share() {
        let root = content("names-tracks");
        write(
            &root.join("tracks/ks_laguna_seca/ui/ui_track.json"),
            r#"{"name": "Laguna Seca", "length": "3602"}"#,
        );
        write(
            &root.join("tracks/aiquenovaescala/ui/ui_track.json"),
            r#"{"name": "Circuito Raul Boesel"}"#,
        );
        for (layout, name) in [
            ("gp", "Brands Hatch - GP"),
            ("indy", "Brands Hatch - Indy"),
            ("indy_osrw", "Brands Hatch - Indy OSRW"),
        ] {
            write(
                &root.join(format!("tracks/ks_brands_hatch/ui/{layout}/ui_track.json")),
                &format!(r#"{{"name": "{name}"}}"#),
            );
        }
        for (layout, name) in [("nordschleife", "Nordschleife"), ("endurance", "Nordschleife - Endurance")] {
            write(
                &root.join(format!("tracks/ks_nordschleife/ui/{layout}/ui_track.json")),
                &format!(r#"{{"name": "{name}"}}"#),
            );
        }
        for (layout, name) in [("north", "Alpha Ring"), ("south", "Beta Loop")] {
            write(
                &root.join(format!("tracks/twins/ui/{layout}/ui_track.json")),
                &format!(r#"{{"name": "{name}"}}"#),
            );
        }
        assert_eq!(ac_track_title(&root, "ks_laguna_seca", None).as_deref(), Some("Laguna Seca"));
        assert_eq!(
            ac_track_title(&root, "aiquenovaescala", None).as_deref(),
            Some("Circuito Raul Boesel")
        );
        assert_eq!(
            ac_track_title(&root, "ks_brands_hatch", Some("indy")).as_deref(),
            Some("Brands Hatch")
        );
        assert_eq!(
            ac_track_title(&root, "ks_nordschleife", Some("endurance")).as_deref(),
            Some("Nordschleife")
        );
        assert_eq!(
            ac_track_title(&root, "twins", Some("south")).as_deref(),
            Some("Beta Loop"),
            "nothing shared: the driven layout"
        );
        assert_eq!(ac_track_title(&root, "twins", None), None);
    }

    #[test]
    fn a_lap_of_assetto_corsa_gets_titles_and_keeps_its_identity() {
        let root = content("names-fill");
        write(
            &root.join("cars/ks_porsche_macan/ui/ui_car.json"),
            r#"{"name": "Porsche Macan Turbo"}"#,
        );
        write(&root.join("tracks/ks_laguna_seca/ui/ui_track.json"), r#"{"name": "Laguna Seca"}"#);
        write(&root.join("tracks/monza/ui/ui_track.json"), r#"{"name": "Monza"}"#);
        let mut lap = Lap {
            game: "ac".into(),
            track_name: "ks_laguna_seca".into(),
            car_name: "ks_porsche_macan".into(),
            ..Lap::default()
        };
        fill_from(&mut lap, std::slice::from_ref(&root));
        assert_eq!(
            (lap.track_name.as_str(), lap.car_name.as_str()),
            ("ks_laguna_seca", "ks_porsche_macan")
        );
        assert_eq!(
            (lap.track_title.as_deref(), lap.car_title.as_deref()),
            (Some("Laguna Seca"), Some("Porsche Macan Turbo"))
        );

        // A title that is the name again says nothing; another game is never looked up.
        let mut same = Lap {
            game: "ac".into(),
            track_name: "monza".into(),
            car_name: "gone".into(),
            ..Lap::default()
        };
        fill_from(&mut same, std::slice::from_ref(&root));
        assert_eq!((same.track_title, same.car_title), (None, None));
        let mut other = Lap {
            game: "ams2".into(),
            track_name: "ks_laguna_seca".into(),
            ..Lap::default()
        };
        fill_from(&mut other, std::slice::from_ref(&root));
        assert_eq!(other.track_title, None);
    }

    /// The titles of the installed game: `cargo test -- --ignored --nocapture names_of_the_installed_game`.
    #[test]
    #[ignore = "reads the installed game; run by hand"]
    fn names_of_the_installed_game() {
        let roots = crate::tracks::dump::game_folders("XPEED_AC_DIR", "assettocorsa", "content");
        let Some(root) = roots.iter().find(|p| p.is_dir()) else {
            eprintln!("Assetto Corsa is not installed here");
            return;
        };
        for car in ["ks_porsche_macan", "fsr_copa_hb20", "ks_mazda_mx5_cup"] {
            eprintln!("car {car}: {:?}", ac_car_title(root, car));
        }
        for track in ["ks_laguna_seca", "aiquenovaescala", "ks_brands_hatch", "ks_nordschleife", "monza"] {
            eprintln!("track {track}: {:?}", ac_track_title(root, track, None));
        }
    }

    /// Every car and track of the installed game with the title the Companion would send, one `kind<TAB>folder<TAB>title`
    /// line each, into the file `XPEED_TITLES_OUT` names (what the catalog backfill of 2026-11-20 was built from):
    /// `XPEED_TITLES_OUT=titles.tsv cargo test -- --ignored export_installed_titles`.
    #[test]
    #[ignore = "reads the installed game; run by hand"]
    fn export_installed_titles() {
        let Ok(out) = std::env::var("XPEED_TITLES_OUT") else {
            eprintln!("set XPEED_TITLES_OUT");
            return;
        };
        let roots = crate::tracks::dump::game_folders("XPEED_AC_DIR", "assettocorsa", "content");
        let Some(root) = roots.iter().find(|p| p.is_dir()) else {
            eprintln!("Assetto Corsa is not installed here");
            return;
        };
        let folders = |kind: &str| {
            let mut list: Vec<String> = std::fs::read_dir(root.join(kind))
                .map(|dir| dir.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
                .unwrap_or_default();
            list.sort();
            list
        };
        let mut lines = Vec::new();
        for car in folders("cars") {
            if let Some(title) = differs(&car, ac_car_title(root, &car)) {
                lines.push(format!("car\t{car}\t{title}"));
            }
        }
        for track in folders("tracks") {
            if let Some(title) = differs(&track, ac_track_title(root, &track, None)) {
                lines.push(format!("track\t{track}\t{title}"));
            }
        }
        std::fs::write(&out, lines.join("\n") + "\n").unwrap();
        eprintln!("{} titles -> {out}", lines.len());
    }

    #[test]
    fn shared_words_never_end_on_a_separator() {
        let names = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(common_words(&names(&["Spa - GP", "Spa – Short"])).as_deref(), Some("Spa"));
        assert_eq!(common_words(&names(&["Imola", "Imola"])).as_deref(), Some("Imola"));
        assert_eq!(common_words(&names(&["Alpha", "Beta"])), None);
        assert_eq!(common_words(&[]), None);
    }
}
