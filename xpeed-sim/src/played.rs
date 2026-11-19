//! What the person has driven, per game, for the waiting screen (owner-approved module 8, 2026-11-19): when each game
//! was last driven, how many laps the Companion saved of it, the track of the last lap and the best valid lap on each
//! track. Kept in `played.json` beside the configuration. It starts empty (laps saved before it existed are not in
//! it), and a missing or broken file reads as empty: losing it only loses the line under the cover.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// One game's line.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Played {
    /// When the last lap of the game was saved (Unix ms).
    pub last_ms: i64,
    pub laps: u32,
    pub last_track: String,
    /// The best valid lap on each track (ms).
    pub best_ms: BTreeMap<String, u32>,
}

impl Played {
    /// The best valid lap on the track last driven, with that track, when there is one: a best from another track
    /// would not compare.
    pub fn best_here(&self) -> Option<(u32, &str)> {
        self.best_ms.get(&self.last_track).map(|&ms| (ms, self.last_track.as_str()))
    }
}

/// Every game's line, by game id (the lap files' `game`, the covers' key).
pub type History = BTreeMap<String, Played>;

/// Where the history is kept.
pub fn path() -> Option<PathBuf> {
    crate::config::home_dir().map(|home| home.join("played.json"))
}

/// The history in `path`; empty when the file is missing or cannot be read.
pub fn load(path: &Path) -> History {
    std::fs::read_to_string(path).ok().map_or_else(History::new, |text| parse(&text))
}

/// The history in `text`; what does not read is left out.
pub fn parse(text: &str) -> History {
    let Ok(Value::Object(games)) = serde_json::from_str::<Value>(text) else {
        return History::new();
    };
    let mut history = History::new();
    for (game, entry) in games {
        let (Some(last_ms), Some(laps)) = (entry["last_ms"].as_i64(), entry["laps"].as_u64()) else {
            continue;
        };
        let best_ms = entry["best_ms"]
            .as_object()
            .map(|tracks| {
                tracks
                    .iter()
                    .filter_map(|(track, ms)| Some((track.clone(), u32::try_from(ms.as_u64()?).ok()?)))
                    .collect()
            })
            .unwrap_or_default();
        let played = Played {
            last_ms,
            laps: u32::try_from(laps).unwrap_or(u32::MAX),
            last_track: entry["last_track"].as_str().unwrap_or_default().to_owned(),
            best_ms,
        };
        history.insert(game, played);
    }
    history
}

/// The history as the file keeps it.
pub fn to_json(history: &History) -> String {
    let games: Map<String, Value> = history
        .iter()
        .map(|(game, p)| {
            let best: Map<String, Value> = p.best_ms.iter().map(|(track, ms)| (track.clone(), json!(ms))).collect();
            let entry = json!({ "last_ms": p.last_ms, "laps": p.laps, "last_track": p.last_track, "best_ms": best });
            (game.clone(), entry)
        })
        .collect();
    Value::Object(games).to_string()
}

/// A lap of `game` on `track` saved at `at_ms`: the count goes up, the game was driven now, and a valid lap faster
/// than the track's best is the new best.
pub fn record(history: &mut History, game: &str, track: &str, time_ms: u32, valid: bool, at_ms: i64) {
    let played = history.entry(game.to_owned()).or_default();
    played.last_ms = at_ms;
    played.laps = played.laps.saturating_add(1);
    played.last_track = track.to_owned();
    if valid && time_ms > 0 {
        let best = played.best_ms.entry(track.to_owned()).or_insert(time_ms);
        *best = (*best).min(time_ms);
    }
}

/// Writes the history to `path` through a file beside it, so a crash midway never leaves half a file.
pub fn save(path: &Path, history: &History) -> std::io::Result<()> {
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let part = path.with_extension("json.part");
    std::fs::write(&part, to_json(history))?;
    std::fs::rename(&part, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lap_counts_and_only_a_valid_one_can_be_the_best() {
        let mut history = History::new();
        record(&mut history, "ac", "Monza", 107_918, true, 1_000);
        record(&mut history, "ac", "Monza", 101_000, false, 2_000);
        record(&mut history, "ac", "Monza", 107_204, true, 3_000);
        let ac = &history["ac"];
        assert_eq!((ac.laps, ac.last_ms), (3, 3_000));
        assert_eq!(ac.best_here(), Some((107_204, "Monza")), "the invalid 1:41.000 is not the best");
        // Another track: its own best, and the line shows the track driven last.
        record(&mut history, "ac", "Spa", 140_000, true, 4_000);
        assert_eq!(history["ac"].best_here(), Some((140_000, "Spa")));
        record(&mut history, "ac", "Imola", 99_000, false, 5_000);
        assert_eq!(history["ac"].best_here(), None, "no valid lap on the last track yet");
    }

    #[test]
    fn the_file_reads_back_and_a_missing_or_broken_one_is_empty() {
        let mut history = History::new();
        record(&mut history, "lmu", "Le Mans", 210_500, true, 7_000);
        record(&mut history, "acc", "Spa", 138_100, true, 8_000);
        assert_eq!(parse(&to_json(&history)), history);
        assert!(parse("not json").is_empty());
        assert!(parse("[1, 2]").is_empty());
        assert!(load(Path::new("no/such/folder/played.json")).is_empty());
        let folder = std::env::temp_dir().join(format!("xpeed-played-{}", std::process::id()));
        let file = folder.join("played.json");
        save(&file, &history).unwrap();
        assert_eq!(load(&file), history);
        let _ = std::fs::remove_dir_all(&folder);
    }
}
