//! Track layouts made without anyone asking: when a reader says its game is on a track, and that game has track files
//! (Assetto Corsa's `fast_lane.ai`, Stock Car Extreme's `.AIW`), the layout is built from the game's own files with the
//! same code `track-dump` runs and put in the outbox, `<laps folder>/tracks/`. The uploader sends what is there
//! (`outbox::upload_tracks`), once per file content.
//!
//! This runs on a thread of its own and is told about tracks through a channel, so reading the game (100 Hz) never
//! waits for a disk full of game files. Each track is tried once per run of the program; a track whose files are
//! refused, or cannot be found, is said once in the log and left alone.
//!
//! Only the game's folders are read; nothing is written into them.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

use super::dump;
use super::*;
use crate::util::file_safe;

/// The outbox of track layouts, inside the laps folder.
pub const TRACKS_DIR: &str = "tracks";
pub const EXTENSION: &str = ".xtrk.gz";

/// What a reader saw: its game on a track. `game` is the reader's id (the one its lap files carry).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Seen {
    pub game: String,
    pub track: String,
    pub variant: Option<String>,
}

/// The games whose layouts can be built, by the id their reader gives, and the id the track file carries
/// (`FORMATO-DE-PISTA.md`: `ac` and `sce`). Assetto Corsa Competizione and Rally have no `fast_lane.ai` to read.
pub fn file_game(reader_game: &str) -> Option<&'static str> {
    match reader_game {
        "ac" => Some("ac"),
        "rfactor1" => Some("sce"),
        _ => None,
    }
}

/// `game|name|variant`, each part trimmed and in lower case: what a layout is known by, on the server
/// (`trackKey` of the app's reader) and in the record of what was sent.
pub fn track_key(game: &str, name: &str, variant: Option<&str>) -> String {
    [game, name, variant.unwrap_or("")].map(|part| part.trim().to_lowercase()).join("|")
}

/// FNV-1a, 64 bits, as hex: enough to tell whether a file changed. Not a defence against anyone.
pub fn hash_hex(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Where each game keeps its tracks: `content/tracks` of Assetto Corsa and `GameData/Locations` of Stock Car Extreme,
/// in every Steam library (and the folders `XPEED_AC_DIR` and `XPEED_SCE_DIR` name, first), as `track-dump` finds them.
#[derive(Debug, Clone, Default)]
pub struct Folders {
    pub ac: Vec<PathBuf>,
    pub sce: Vec<PathBuf>,
}

impl Folders {
    pub fn installed() -> Folders {
        Folders {
            ac: dump::game_folders("XPEED_AC_DIR", "assettocorsa", "content/tracks"),
            sce: dump::game_folders("XPEED_SCE_DIR", "Stock Car Extreme", "GameData/Locations"),
        }
    }
}

/// A name a game reports, used as a folder or file name: one plain part, never a path.
fn plain(name: &str, what: &str) -> Result<String, String> {
    let name = name.trim();
    let fine = !name.is_empty()
        && name.chars().count() <= 120
        && name != "."
        && name != ".."
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'));
    if fine {
        Ok(name.to_owned())
    } else {
        Err(format!("the {what} name the game reports ({name:?}) cannot be a folder name"))
    }
}

fn shown(roots: &[PathBuf]) -> String {
    roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>().join(" or ")
}

/// The folder of `dir` called `name`, in any case, with the name it has on disk: the layout file then carries the
/// folder's own name whatever case the game reports it in, so the same track always gives the same bytes.
fn child_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    let wanted = name.to_lowercase();
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| entry.file_name().to_string_lossy().to_lowercase() == wanted)
        .map(|entry| entry.path())
        .collect();
    found.sort();
    // Two folders differing only in case (possible on some disks): the exact one, or none can be chosen.
    match found.iter().position(|p| p.file_name().is_some_and(|n| n == name)) {
        Some(exact) => Some(found.swap_remove(exact)),
        None if found.len() == 1 => found.pop(),
        None => None,
    }
}

/// The layout folder of an Assetto Corsa track: `<tracks>/<track>/<layout>`, or `<tracks>/<track>` for a track
/// with one layout. The game reports the two folder names.
pub fn find_ac(roots: &[PathBuf], track: &str, variant: Option<&str>) -> Result<ac::Layout, String> {
    for root in roots {
        let Some(mut dir) = child_dir(root, track) else { continue };
        if let Some(variant) = variant {
            let Some(layout) = child_dir(&dir, variant) else { continue };
            dir = layout;
        }
        return dump::ac_from_dir(&dir);
    }
    let wanted = variant.map_or_else(|| track.to_owned(), |v| format!("{track}/{v}"));
    Err(format!("no Assetto Corsa track folder {wanted:?} under {}", shown(roots)))
}

/// The `.AIW` file of a Stock Car Extreme track: by the file's name, as `track-dump` matches it; failing that, by the
/// `TrackName` of the `.gdb` beside it (which may be the name the game reports; not checked with the game running).
pub fn find_sce(roots: &[PathBuf], name: &str) -> Result<PathBuf, String> {
    for root in roots {
        let found = dump::sce_named(root, name);
        if !found.is_empty() {
            return dump::pick_aiw(found, name);
        }
    }
    let wanted = name.to_lowercase();
    for root in roots {
        let found: Vec<PathBuf> = aiw::list(root)
            .into_iter()
            .filter(|p| {
                std::fs::read(p.with_extension("gdb"))
                    .ok()
                    .and_then(|b| aiw::gdb_title(&b.iter().map(|&c| char::from(c)).collect::<String>()))
                    .is_some_and(|title| title.to_lowercase() == wanted)
            })
            .collect();
        if !found.is_empty() {
            return dump::pick_aiw(found, name);
        }
    }
    Err(format!("no Stock Car Extreme track {name:?} under {}", shown(roots)))
}

/// The outbox file of a layout: readable, and different for every track key (the names are made safe, so two keys
/// could otherwise share one).
pub fn file_name(track: &Track) -> String {
    let key = track_key(&track.game, &track.name, track.variant.as_deref());
    let variant = track.variant.as_deref().map(|v| format!("_{}", file_safe(v))).unwrap_or_default();
    format!(
        "{}_{}{variant}_{}{EXTENSION}",
        file_safe(&track.game),
        file_safe(&track.name),
        &hash_hex(key.as_bytes())[..8]
    )
}

#[derive(Debug, PartialEq)]
pub enum Built {
    /// A new or changed layout is in the outbox.
    Written(PathBuf),
    /// The outbox already holds these very bytes.
    Unchanged(PathBuf),
}

/// Builds the layout `seen` stands for from the game's files in `folders`, and puts it in `outbox` when it is not
/// there already with the same bytes. An error says why there is none.
pub fn build(seen: &Seen, folders: &Folders, outbox: &Path) -> Result<Built, String> {
    let game = file_game(&seen.game).ok_or_else(|| format!("track layouts are not made for {}", seen.game))?;
    let track = plain(&seen.track, "track")?;
    let variant = seen.variant.as_deref().map(|v| plain(v, "layout")).transpose()?;
    let extracted = match game {
        "ac" => {
            let layout = find_ac(&folders.ac, &track, variant.as_deref())?;
            let found = ac::extract(&layout).map_err(|refusal| format!("the game's files were refused: {refusal}"))?;
            // The folders are the names: what was read must be the track the game reports, or it is someone else's.
            let (reported, read) = (
                track_key(game, &track, variant.as_deref()),
                track_key(&found.track.game, &found.track.name, found.track.variant.as_deref()),
            );
            if reported != read {
                return Err(format!("the folder found holds {read:?}, not {reported:?}"));
            }
            found
        }
        _ => aiw::extract(&find_sce(&folders.sce, &track)?).map_err(|refusal| format!("the game's files were refused: {refusal}"))?,
    };
    let bytes = dump::gzip_checked(&extracted.track)?;
    let path = outbox.join(file_name(&extracted.track));
    if std::fs::read(&path).is_ok_and(|old| old == bytes) {
        return Ok(Built::Unchanged(path));
    }
    std::fs::create_dir_all(outbox).map_err(|e| format!("cannot create {}: {e}", outbox.display()))?;
    // Written beside its final name and renamed, so the uploader never sees half a file.
    let partial = path.with_extension("gz.part");
    std::fs::write(&partial, &bytes)
        .and_then(|()| std::fs::rename(&partial, &path))
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(Built::Written(path))
}

fn label(seen: &Seen) -> String {
    match &seen.variant {
        Some(variant) => format!("{} / {}", seen.track, variant),
        None => seen.track.clone(),
    }
}

/// The thread's loop: builds each track it is told about, once per run, until `quitting()` or until nobody can tell it
/// anything more. `ready()` is called when a layout was put in the outbox (to wake the uploader).
pub fn run(
    out: &Path,
    seen: &Receiver<Seen>,
    folders: &dyn Fn() -> Folders,
    quitting: &dyn Fn() -> bool,
    ready: &dyn Fn(),
    say: &dyn Fn(String),
) {
    let outbox = out.join(TRACKS_DIR);
    let mut tried = HashSet::new();
    while !quitting() {
        let next = match seen.recv_timeout(Duration::from_millis(500)) {
            Ok(next) => next,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        if file_game(&next.game).is_none() || !tried.insert(track_key(&next.game, &next.track, next.variant.as_deref())) {
            continue;
        }
        match build(&next, &folders(), &outbox) {
            Ok(Built::Written(path)) => {
                say(format!(
                    "Track layout of {} built from the game's files: {}",
                    label(&next),
                    path.file_name().unwrap_or_default().to_string_lossy()
                ));
                ready();
            }
            Ok(Built::Unchanged(_)) => {}
            Err(why) => say(format!("No track layout for {}: {why}", label(&next))),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::sync::Mutex;

    use super::*;
    use crate::config::scratch_dir;

    fn ac_track(root: &Path, track: &str, layout: Option<&str>, radius: f64) {
        let dir = match layout {
            Some(layout) => {
                std::fs::create_dir_all(root.join(track).join("ui").join(layout)).unwrap();
                root.join(track).join(layout)
            }
            None => root.join(track),
        };
        std::fs::create_dir_all(dir.join("ai")).unwrap();
        std::fs::write(
            dir.join("ai").join(ac::SOURCE),
            ac::tests::synthetic(600, radius, std::f64::consts::TAU, 9.0, 3.0),
        )
        .unwrap();
    }

    fn seen(game: &str, track: &str, variant: Option<&str>) -> Seen {
        Seen {
            game: game.into(),
            track: track.into(),
            variant: variant.map(str::to_owned),
        }
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn keys_and_hashes_are_the_ones_the_server_and_the_record_use() {
        // The same as `trackKeyOf` of the app's reader (src/lib/sim/track-file.ts).
        assert_eq!(track_key("ac", " Monza ", Some("GP")), "ac|monza|gp");
        assert_eq!(track_key("sce", "InterlagosGP", None), "sce|interlagosgp|");
        // Published FNV-1a 64 values.
        assert_eq!(hash_hex(b""), "cbf29ce484222325");
        assert_eq!(hash_hex(b"a"), "af63dc4c8601ec8c");
        assert_eq!(file_game("ac"), Some("ac"));
        assert_eq!(file_game("rfactor1"), Some("sce"));
        for other in ["acc", "acr", "lmu", "ams2", "f1"] {
            assert_eq!(file_game(other), None, "{other}");
        }
    }

    #[test]
    fn builds_an_assetto_corsa_layout_once_and_again_only_when_the_game_files_change() {
        let root = scratch_dir("auto-ac");
        let (tracks, outbox) = (root.join("content-tracks"), root.join("laps").join(TRACKS_DIR));
        ac_track(&tracks, "circle", None, 100.0);
        let folders = Folders {
            ac: vec![root.join("missing"), tracks.clone()],
            sce: vec![],
        };
        let Built::Written(path) = build(&seen("ac", "circle", None), &folders, &outbox).unwrap() else {
            panic!("a new layout is written");
        };
        let first = std::fs::read(&path).unwrap();
        let track = gunzip(&first, MAX_UNPACKED).unwrap();
        assert_eq!(
            (track.game.as_str(), track.name.as_str(), track.variant.as_deref()),
            ("ac", "circle", None)
        );
        assert_eq!(
            files(&outbox),
            [path.file_name().unwrap().to_string_lossy().into_owned()],
            "no .part left behind"
        );
        assert!(path.file_name().unwrap().to_string_lossy().starts_with("ac_circle_"));

        assert_eq!(
            build(&seen("ac", "CIRCLE", None), &folders, &outbox).unwrap(),
            Built::Unchanged(path.clone())
        );
        // The game's file changes (a mod updated): the same outbox file, new bytes.
        ac_track(&tracks, "circle", None, 120.0);
        assert_eq!(
            build(&seen("ac", "circle", None), &folders, &outbox).unwrap(),
            Built::Written(path.clone())
        );
        assert_ne!(std::fs::read(&path).unwrap(), first);
    }

    #[test]
    fn finds_the_layout_the_game_reports() {
        let root = scratch_dir("auto-ac-layouts");
        let outbox = root.join("out");
        ac_track(&root, "park", Some("gp"), 100.0);
        ac_track(&root, "park", Some("short"), 60.0);
        let folders = Folders {
            ac: vec![root.clone()],
            sce: vec![],
        };
        for layout in ["gp", "short"] {
            let Built::Written(path) = build(&seen("ac", "park", Some(layout)), &folders, &outbox).unwrap() else {
                panic!("{layout} is written");
            };
            let track = gunzip(&std::fs::read(&path).unwrap(), MAX_UNPACKED).unwrap();
            assert_eq!(
                track_key(&track.game, &track.name, track.variant.as_deref()),
                format!("ac|park|{layout}")
            );
        }
        assert_eq!(files(&outbox).len(), 2);
        // A track with layouts, reported without one: which layout is not known, so none is made.
        let why = build(&seen("ac", "park", None), &folders, &outbox).unwrap_err();
        assert!(why.contains("2 layouts"), "{why}");
    }

    #[test]
    fn refuses_what_it_cannot_find_or_trust_and_writes_nothing() {
        let root = scratch_dir("auto-refuse");
        let outbox = root.join("out");
        ac_track(&root, "circle", None, 100.0);
        let folders = Folders {
            ac: vec![root.clone()],
            sce: vec![root.clone()],
        };
        let why = build(&seen("ac", "nowhere", None), &folders, &outbox).unwrap_err();
        assert!(why.contains("no Assetto Corsa track folder"), "{why}");
        for bad in ["..", "../circle", "a\\b", "", "c:x", "x\u{7}"] {
            let why = build(&seen("ac", bad, None), &folders, &outbox).unwrap_err();
            assert!(why.contains("cannot be a folder name"), "{bad:?}: {why}");
        }
        assert!(build(&seen("ac", "circle", Some("..")), &folders, &outbox).is_err());
        assert!(build(&seen("acc", "circle", None), &folders, &outbox)
            .unwrap_err()
            .contains("not made for acc"));
        // The game's file is damaged: its validation refuses it.
        std::fs::write(
            root.join("circle").join("ai").join(ac::SOURCE),
            [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        )
        .unwrap();
        let why = build(&seen("ac", "circle", None), &folders, &outbox).unwrap_err();
        assert!(why.contains("refused"), "{why}");
        assert!(build(&seen("rfactor1", "Nowhere", None), &folders, &outbox)
            .unwrap_err()
            .contains("no Stock Car Extreme track"));
        assert!(!outbox.exists(), "nothing was written");
    }

    #[test]
    fn builds_a_stock_car_extreme_layout_by_file_name_or_by_track_name() {
        let root = scratch_dir("auto-sce");
        let outbox = root.join("out");
        let folder = root.join("Place").join("Circle");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("Circle.AIW"), aiw::tests::synthetic(300, 4.0, 10.0, -2.0, true)).unwrap();
        std::fs::write(folder.join("Circle.gdb"), "{\n  TrackName = Circle Park\n}\n").unwrap();
        let folders = Folders {
            ac: vec![],
            sce: vec![root.clone()],
        };
        let Built::Written(path) = build(&seen("rfactor1", "circle", None), &folders, &outbox).unwrap() else {
            panic!("written");
        };
        let track = gunzip(&std::fs::read(&path).unwrap(), MAX_UNPACKED).unwrap();
        assert_eq!(
            (track.game.as_str(), track.name.as_str(), track.title.as_deref()),
            ("sce", "Circle", Some("Circle Park"))
        );
        assert_eq!(
            build(&seen("rfactor1", "Circle Park", None), &folders, &outbox).unwrap(),
            Built::Unchanged(path)
        );
    }

    #[test]
    fn the_thread_builds_each_track_once_and_says_each_problem_once() {
        let root = scratch_dir("auto-run");
        let tracks = root.join("tracks-of-the-game");
        ac_track(&tracks, "circle", None, 100.0);
        let out = root.join("laps");
        let (tx, rx) = mpsc::channel();
        for item in [
            seen("ac", "circle", None),
            seen("ac", "Circle", None),
            seen("lmu", "Le Mans", None),
            seen("ac", "nowhere", None),
            seen("ac", "nowhere", None),
        ] {
            tx.send(item).unwrap();
        }
        drop(tx);
        let (lines, woken) = (Mutex::new(Vec::new()), Mutex::new(0));
        let folders = || Folders {
            ac: vec![tracks.clone()],
            sce: vec![],
        };
        run(&out, &rx, &folders, &|| false, &|| *woken.lock().unwrap() += 1, &|line| {
            lines.lock().unwrap().push(line)
        });
        let lines = lines.into_inner().unwrap();
        assert_eq!(*woken.lock().unwrap(), 1, "{lines:?}");
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].starts_with("Track layout of circle built"), "{lines:?}");
        assert!(lines[1].starts_with("No track layout for nowhere"), "{lines:?}");
        assert_eq!(files(&out.join(TRACKS_DIR)).len(), 1);
    }

    #[test]
    fn the_thread_stops_when_told_to() {
        let (_tx, rx) = mpsc::channel::<Seen>();
        run(Path::new("unused"), &rx, &Folders::default, &|| true, &|| {}, &|_| {});
    }
}
