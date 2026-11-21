//! Track layouts made without anyone asking: when a reader says its game is on a track, and that game has track files
//! (Assetto Corsa's `fast_lane.ai`, Stock Car Extreme's `.AIW`), the layout is built from the game's own files with the
//! same code `track-dump` runs and put in the outbox, `<laps folder>/tracks/`. The uploader sends what is there
//! (`outbox::upload_tracks`), once per file content.
//!
//! This runs on a thread of its own and is told about tracks through a channel, so reading the game (100 Hz) never
//! waits for a disk full of game files. Every request returns the exact layout
//! or the reason it could not be prepared. The requesting reader can retry.
//!
//! EVO's verified package sources are built into the private `native-tracks` cache (its own source receipts), and only a
//! layout that passed that validation is then offered to this outbox ([`offer`]) so it reaches the account like the others.
//! Only game folders are read, never written.

use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
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

#[derive(Debug, PartialEq, Eq)]
pub enum SourceFailure {
    Unavailable(String),
    Invalid(String),
    Retryable(String),
}

impl fmt::Display for SourceFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(why) | Self::Invalid(why) | Self::Retryable(why) => f.write_str(why),
        }
    }
}

pub type SourceResult = Result<crate::maps::Layout, SourceFailure>;

pub struct Request {
    pub seen: Seen,
    pub reply: Sender<SourceResult>,
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
            ac: dump::game_folders("XPEED_AC_DIR", 244_210, "assettocorsa", "content/tracks"),
            sce: dump::game_folders("XPEED_SCE_DIR", 273_840, "Stock Car Extreme", "GameData/Locations"),
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
fn child_dir(dir: &Path, name: &str) -> io::Result<Option<PathBuf>> {
    let wanted = name.to_lowercase();
    let mut found = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().to_lowercase() == wanted {
            // Metadata follows tracks linked from a mod manager's game directory.
            let path = entry.path();
            if fs::metadata(&path)?.is_dir() {
                found.push(path);
            }
        }
    }
    // Two folders differing only in case (possible on some disks): the exact one, or none can be chosen.
    match found.iter().position(|p| p.file_name().is_some_and(|n| n == name)) {
        Some(exact) => Ok(Some(found.swap_remove(exact))),
        None if found.len() <= 1 => Ok(found.pop()),
        None => Err(io::Error::new(io::ErrorKind::InvalidData, format!("ambiguous directory {name:?}"))),
    }
}

fn name_of(path: &Path) -> String {
    path.file_name().unwrap_or_default().to_string_lossy().into_owned()
}

enum AcCandidate {
    NoLayout,
    MissingSpline(PathBuf),
    Found(ac::Layout),
}

fn ac_in_root(root: &Path, track: &str, variant: Option<&str>) -> io::Result<AcCandidate> {
    let Some(track_dir) = child_dir(root, track)? else {
        return Ok(AcCandidate::NoLayout);
    };
    let (dir, variant) = if let Some(variant) = variant {
        let Some(dir) = child_dir(&track_dir, variant)? else {
            return Ok(AcCandidate::NoLayout);
        };
        let name = name_of(&dir);
        (dir, Some(name))
    } else {
        (track_dir.clone(), None)
    };
    let ai_dir = dir.join("ai");
    // Exact direct source only. A sibling layout or an AI backup may describe a different route.
    let spline = ai_dir.join(ac::SOURCE);
    match fs::metadata(&spline) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err(io::Error::new(io::ErrorKind::InvalidData, "fast_lane.ai is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(AcCandidate::MissingSpline(spline)),
        Err(error) => return Err(error),
    }
    Ok(AcCandidate::Found(ac::Layout {
        dir,
        track: name_of(&track_dir),
        variant,
        ai_dir,
    }))
}

/// The layout folder of an Assetto Corsa track: `<tracks>/<track>/<layout>`, or `<tracks>/<track>` for a track
/// with one layout. The game reports the two folder names.
fn find_ac(roots: &[PathBuf], track: &str, variant: Option<&str>) -> Result<ac::Layout, SourceFailure> {
    let mut blocked = None;
    let mut missing = None;
    for root in roots {
        match ac_in_root(root, track, variant) {
            Ok(AcCandidate::Found(layout)) => return Ok(layout),
            Ok(AcCandidate::MissingSpline(path)) => {
                missing.get_or_insert(path);
            }
            Ok(AcCandidate::NoLayout) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                return Err(SourceFailure::Invalid(format!(
                    "cannot select AC layout under {}: {error}",
                    root.display()
                )));
            }
            Err(error) => {
                blocked.get_or_insert_with(|| format!("cannot read AC layout under {}: {error}", root.display()));
            }
        }
    }
    if let Some(path) = missing {
        return Err(SourceFailure::Unavailable(format!(
            "no direct Assetto Corsa AI source at {}",
            path.display()
        )));
    }
    let wanted = variant.map_or_else(|| track.to_owned(), |v| format!("{track}/{v}"));
    Err(blocked.map_or_else(
        || SourceFailure::Unavailable(format!("no direct Assetto Corsa AI source for {wanted:?} under {}", shown(roots))),
        SourceFailure::Retryable,
    ))
}

fn sce_stem(path: &Path) -> String {
    path.file_stem().unwrap_or_default().to_string_lossy().into_owned()
}

/// SCE may report its AIW stem or the source GDB's exact TrackName. Both
/// candidates participate in the ambiguity check, even across installations.
fn find_sce(roots: &[PathBuf], name: &str) -> Result<PathBuf, SourceFailure> {
    let mut distinct = HashSet::new();
    let candidates: Vec<_> = roots
        .iter()
        .flat_map(|root| aiw::list(root))
        .filter(|path| distinct.insert(fs::canonicalize(path).unwrap_or_else(|_| path.clone())))
        .collect();
    let wanted = name.to_lowercase();
    let found: Vec<_> = candidates
        .iter()
        .filter(|path| {
            sce_stem(path).to_lowercase() == wanted
                || aiw::read_gdb_title(path)
                    .ok()
                    .flatten()
                    .is_some_and(|title| title.to_lowercase() == wanted)
        })
        .collect();
    let [file] = found.as_slice() else {
        let problem = if found.is_empty() {
            SourceFailure::Unavailable(format!("no Stock Car Extreme track {name:?} under {}", shown(roots)))
        } else {
            SourceFailure::Invalid(format!("several Stock Car Extreme layouts match {name:?}"))
        };
        return Err(problem);
    };
    let stem = sce_stem(file).to_lowercase();
    if candidates.iter().filter(|path| sce_stem(path).to_lowercase() == stem).count() > 1 {
        return Err(SourceFailure::Invalid(format!(
            "the Stock Car Extreme AIW name {stem:?} is shared by several layouts"
        )));
    }
    Ok((*file).clone())
}

/// The outbox file of a layout: readable, and different for every track key (the names are made safe, so two keys
/// could otherwise share one).
fn file_name(game: &str, name: &str, variant: Option<&str>) -> String {
    let key = track_key(game, name, variant);
    let variant = variant.map(|v| format!("_{}", file_safe(v))).unwrap_or_default();
    format!(
        "{}_{}{variant}_{}{EXTENSION}",
        file_safe(game),
        file_safe(name),
        &hash_hex(key.as_bytes())[..8]
    )
}

#[derive(Debug, PartialEq)]
enum Built {
    /// A new or changed layout is in the outbox.
    Written(PathBuf),
    /// The outbox already holds these very bytes.
    Unchanged(PathBuf),
}

enum Source {
    Ac(ac::Layout),
    Sce(PathBuf),
}

fn check_output(outbox: &Path, source: &Path, roots: &[PathBuf], suffix: &str) -> Result<(), SourceFailure> {
    let selected = roots.iter().find(|root| source.starts_with(root));
    let protected = selected
        .map(|root| {
            if root.ends_with(suffix) {
                root.parent().and_then(Path::parent).unwrap_or(root)
            } else {
                root
            }
        })
        .unwrap_or(source.parent().unwrap_or(source));
    if dump::inside(outbox, protected) || source.parent().is_some_and(|dir| dump::inside(outbox, dir)) {
        return Err(SourceFailure::Invalid("refusing to write a layout into the installed game".into()));
    }
    Ok(())
}

fn classify_extraction(error: Refusal) -> SourceFailure {
    let message = format!("the game's files were refused: {error}");
    if error.code == "io" {
        SourceFailure::Retryable(message)
    } else {
        SourceFailure::Invalid(message)
    }
}

fn track_identity(track: &Track) -> String {
    track_key(&track.game, &track.name, track.variant.as_deref())
}

fn build_current(seen: &Seen, folders: &Folders, outbox: &Path) -> Result<(Built, Track), SourceFailure> {
    let game = file_game(&seen.game).ok_or_else(|| SourceFailure::Unavailable(format!("track layouts are not made for {}", seen.game)))?;
    let reported = plain(&seen.track, "track").map_err(SourceFailure::Invalid)?;
    let variant = seen
        .variant
        .as_deref()
        .map(|v| plain(v, "layout"))
        .transpose()
        .map_err(SourceFailure::Invalid)?;
    let source = match game {
        "ac" => Source::Ac(find_ac(&folders.ac, &reported, variant.as_deref())?),
        "sce" if variant.is_some() => {
            return Err(SourceFailure::Unavailable("no Stock Car Extreme variant identity mapping".into()));
        }
        "sce" => Source::Sce(find_sce(&folders.sce, &reported)?),
        _ => unreachable!(),
    };
    let (name, variant, sources) = match &source {
        Source::Ac(layout) => {
            let sources = ac::dependencies(layout);
            check_output(outbox, &sources[0], &folders.ac, "content/tracks")?;
            (layout.track.clone(), layout.variant.as_deref(), sources)
        }
        Source::Sce(path) => {
            check_output(outbox, path, &folders.sce, "GameData/Locations")?;
            (sce_stem(path), None, vec![path.clone(), path.with_extension("gdb")])
        }
    };
    let key = track_key(game, &name, variant);
    let path = outbox.join(file_name(game, &name, variant));
    let before = fresh::capture(&sources).map_err(SourceFailure::Retryable)?;
    let confirms_identity = |track: &Track| {
        key == track_identity(track)
            && (game != "sce"
                || name.to_lowercase() == reported.to_lowercase()
                || track
                    .title
                    .as_ref()
                    .is_some_and(|title| title.to_lowercase() == reported.to_lowercase()))
    };
    if let Some(track) = fresh::load_current(&path, &key, &before).filter(confirms_identity) {
        return Ok((Built::Unchanged(path), track));
    }
    let track = match &source {
        Source::Ac(layout) => ac::extract(layout),
        Source::Sce(path) => aiw::extract(path),
    }
    .map_err(classify_extraction)?
    .track;
    if !confirms_identity(&track) {
        return Err(SourceFailure::Retryable("native source identity changed during extraction".into()));
    }
    let bytes = dump::gzip_checked(&track).map_err(SourceFailure::Invalid)?;
    if fresh::capture(&sources).map_err(SourceFailure::Retryable)? != before {
        return Err(SourceFailure::Retryable("native game files changed during extraction".into()));
    }
    let unchanged = fresh::read(&path, MAX_UNPACKED).is_some_and(|old| old == bytes);
    if !unchanged {
        fs::create_dir_all(outbox).map_err(|error| SourceFailure::Retryable(format!("cannot create {}: {error}", outbox.display())))?;
        // Rename a complete payload into place, then attest it.
        let partial = path.with_extension("gz.part");
        if let Err(error) = fs::write(&partial, &bytes).and_then(|()| fs::rename(&partial, &path)) {
            let _ = fs::remove_file(partial);
            return Err(SourceFailure::Retryable(format!("cannot write {}: {error}", path.display())));
        }
    }
    fresh::attest(&path, &track, &bytes, &before).map_err(SourceFailure::Retryable)?;
    Ok((if unchanged { Built::Unchanged(path) } else { Built::Written(path) }, track))
}

/// A validated layout made outside the outbox (EVO's private cache) offered to it, so the uploader sends it to the account:
/// the same file name a layout of that identity always has, written whole (a partial file never shows) and only when its
/// bytes changed. True when the file was written.
pub(crate) fn offer(outbox: &Path, track: &Track) -> Result<bool, String> {
    let bytes = dump::gzip_checked(track)?;
    let path = outbox.join(file_name(&track.game, &track.name, track.variant.as_deref()));
    if fresh::read(&path, MAX_UNPACKED).is_some_and(|old| old == bytes) {
        return Ok(false);
    }
    fs::create_dir_all(outbox).map_err(|error| format!("cannot create {}: {error}", outbox.display()))?;
    let partial = path.with_extension("gz.part");
    if let Err(error) = fs::write(&partial, &bytes).and_then(|()| fs::rename(&partial, &path)) {
        let _ = fs::remove_file(partial);
        return Err(format!("cannot write {}: {error}", path.display()));
    }
    Ok(true)
}

#[cfg(test)]
fn build(seen: &Seen, folders: &Folders, outbox: &Path) -> Result<Built, String> {
    build_current(seen, folders, outbox)
        .map(|(state, _)| state)
        .map_err(|error| error.to_string())
}

fn label(seen: &Seen) -> String {
    match &seen.variant {
        Some(variant) => format!("{} / {}", seen.track, variant),
        None => seen.track.clone(),
    }
}

/// Build or load each requested track. The reply belongs to that request, so a
/// reader that changes layouts can discard the old receiver. Wake the uploader
/// only when a layout file in the outbox was written (AC, SCE, or a validated EVO layout offered from its cache).
pub fn run(
    out: &Path,
    seen: &Receiver<Request>,
    folders: &dyn Fn() -> Folders,
    quitting: &dyn Fn() -> bool,
    ready: &dyn Fn(),
    say: &dyn Fn(String),
) {
    let outbox = out.join(TRACKS_DIR);
    while !quitting() {
        let next = match seen.recv_timeout(Duration::from_millis(500)) {
            Ok(next) => next,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let Request { seen, reply } = next;
        let track = if seen.game == "acevo" {
            local::prepare_evo(
                &out.join(local::DIRECTORY),
                &local::evo_roots(),
                &seen.track,
                seen.variant.as_deref(),
            )
            .map(|(written, track)| {
                if written {
                    say(format!("Native EVO layout cached locally for {}", label(&seen)));
                }
                // The account gets the validated layout too; a failure here never takes the map off the panel.
                match offer(&outbox, &track) {
                    Ok(true) => {
                        say(format!("Track layout of {} ready to send to your account", label(&seen)));
                        ready();
                    }
                    Ok(false) => {}
                    Err(error) => say(format!(
                        "Could not queue the track layout of {} for your account: {error}",
                        label(&seen)
                    )),
                }
                track
            })
        } else {
            build_current(&seen, &folders(), &outbox).map(|(built, track)| {
                if let Built::Written(path) = built {
                    say(format!(
                        "Track layout of {} built from the game's files: {}",
                        label(&seen),
                        path.file_name().unwrap_or_default().to_string_lossy()
                    ));
                    ready();
                }
                track
            })
        };
        let outcome = track.and_then(|track| {
            crate::maps::Layout::from_track(&track).ok_or_else(|| SourceFailure::Invalid("native layout has no drawable centerline".into()))
        });
        if let Err(error) = &outcome {
            say(format!("No track layout for {}: {error}", label(&seen)));
        }
        let _ = reply.send(outcome);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::sync::Mutex;

    use super::*;
    use crate::config::scratch_dir;

    #[test]
    fn a_validated_layout_from_outside_is_offered_once_under_its_identity_and_again_only_when_it_changes() {
        let root = scratch_dir("offer-outbox");
        let outbox = root.join(TRACKS_DIR);
        let mut track = super::super::tests::golden_track();
        track.game = "acevo".into();
        track.name = "Laguna Seca".into();
        track.variant = Some("GP".into());
        assert_eq!(offer(&outbox, &track), Ok(true));
        let files: Vec<_> = fs::read_dir(&outbox)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(
            files,
            vec![file_name("acevo", "Laguna Seca", Some("GP"))],
            "one whole file, no partial left"
        );
        let sent = gunzip(&fs::read(outbox.join(&files[0])).unwrap(), MAX_UNPACKED).unwrap();
        assert_eq!(track_key(&sent.game, &sent.name, sent.variant.as_deref()), "acevo|laguna seca|gp");
        assert_eq!(offer(&outbox, &track), Ok(false), "the same bytes are not written again");
        track.length_m = Some(3555.0);
        assert_eq!(offer(&outbox, &track), Ok(true), "a changed layout replaces the file");
        assert_eq!(fs::read_dir(&outbox).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

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
            [
                path.file_name().unwrap().to_string_lossy().into_owned(),
                format!("{}.source.json", path.file_name().unwrap().to_string_lossy())
            ],
            "no .part left behind"
        );
        assert!(path.file_name().unwrap().to_string_lossy().starts_with("ac_circle_"));

        assert_eq!(
            build(&seen("ac", "CIRCLE", None), &folders, &outbox).unwrap(),
            Built::Unchanged(path.clone())
        );
        // The game's file changes (a mod updated): the same outbox file, new bytes.
        ac_track(&tracks, "circle", None, 120.0);
        assert!(fresh::load(&path).is_none(), "an old geometry cannot survive its source update");
        assert_eq!(
            build(&seen("ac", "circle", None), &folders, &outbox).unwrap(),
            Built::Written(path.clone())
        );
        assert_ne!(std::fs::read(&path).unwrap(), first);
        assert!(fresh::load(&path).is_some());
    }

    #[test]
    fn finds_the_layout_the_game_reports() {
        let root = scratch_dir("auto-ac-layouts");
        let outbox = root.join("out");
        let incomplete = root.join("incomplete");
        let tracks = root.join("complete");
        fs::create_dir_all(incomplete.join("park/gp/ai")).unwrap();
        ac_track(&tracks, "park", Some("gp"), 100.0);
        ac_track(&tracks, "park", Some("short"), 60.0);
        // A mod without UI metadata still identifies its explicit layout directory.
        fs::create_dir_all(tracks.join("no-ui/local/ai")).unwrap();
        fs::copy(tracks.join("park/gp/ai/fast_lane.ai"), tracks.join("no-ui/local/ai/fast_lane.ai")).unwrap();
        let folders = Folders {
            ac: vec![incomplete.clone(), tracks],
            sce: vec![],
        };
        for (name, layout) in [("park", "gp"), ("park", "short"), ("no-ui", "local")] {
            let Built::Written(path) = build(&seen("ac", name, Some(layout)), &folders, &outbox).unwrap() else {
                panic!("{layout} is written");
            };
            let track = gunzip(&std::fs::read(&path).unwrap(), MAX_UNPACKED).unwrap();
            assert_eq!(
                track_key(&track.game, &track.name, track.variant.as_deref()),
                format!("ac|{name}|{layout}")
            );
        }
        assert_eq!(files(&outbox).len(), 6, "three layouts and their source receipts");
        for missing in [
            seen("ac", "park", None),
            seen("ac", "park", Some("touring")),
            seen("ac", "no-ui", None),
        ] {
            assert!(matches!(
                build_current(&missing, &folders, &outbox),
                Err(SourceFailure::Unavailable(_))
            ));
        }
        // A newly available higher-priority root replaces the previous generation.
        ac_track(&incomplete, "park", Some("gp"), 150.0);
        assert!(matches!(
            build(&seen("ac", "park", Some("gp")), &folders, &outbox),
            Ok(Built::Written(_))
        ));
    }

    #[test]
    fn exact_layout_without_a_spline_takes_precedence_over_an_unreadable_library() {
        let root = scratch_dir("auto-ac-unreadable-library");
        let tracks = root.join("tracks");
        let missing = tracks.join("island").join("freeroam").join("ai");
        fs::create_dir_all(&missing).unwrap();
        let unreadable = root.join("bad\0library");
        assert!(matches!(
            find_ac(std::slice::from_ref(&unreadable), "island", Some("freeroam")),
            Err(SourceFailure::Retryable(_))
        ));
        let result = find_ac(&[unreadable, tracks], "island", Some("freeroam"));
        assert_eq!(
            result,
            Err(SourceFailure::Unavailable(format!(
                "no direct Assetto Corsa AI source at {}",
                missing.join(ac::SOURCE).display()
            )))
        );
    }

    #[test]
    fn records_metadata_and_both_ui_candidates_in_the_source_receipt() {
        let root = scratch_dir("auto-ac-metadata");
        let tracks = root.join("tracks");
        let outbox = root.join("out");
        ac_track(&tracks, "park", Some("gp"), 100.0);
        let ui = tracks.join("park/ui");
        fs::write(ui.join("ui_track.json"), r#"{"name":"Fallback title","length":"628 m"}"#).unwrap();
        let folders = Folders {
            ac: vec![tracks.clone()],
            sce: vec![],
        };
        let request = seen("ac", "park", Some("gp"));
        let (Built::Written(path), first) = build_current(&request, &folders, &outbox).unwrap() else {
            panic!("expected a new layout");
        };
        assert_eq!(first.title.as_deref(), Some("Fallback title"));
        fs::write(ui.join("gp/ui_track.json"), r#"{"name":"Exact layout"}"#).unwrap();
        assert!(fresh::load(&path).is_none());
        let (_, rebuilt) = build_current(&request, &folders, &outbox).unwrap();
        assert_eq!(rebuilt.title.as_deref(), Some("Exact layout"));
        fs::write(ui.join("ui_track.json"), r#"{"name":"New fallback title"}"#).unwrap();
        assert!(fresh::load(&path).is_none(), "the fallback candidate is attested too");
        assert!(matches!(build(&request, &folders, &outbox), Ok(Built::Unchanged(_))));
        let data = tracks.join("park/gp/data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("map.ini"), "WIDTH=1\nHEIGHT=1\nSCALE_FACTOR=1\nX_OFFSET=0\nZ_OFFSET=0").unwrap();
        assert!(
            fresh::load(&path).is_none(),
            "the former receipt must not bypass the new cross-check"
        );
        assert!(matches!(build_current(&request, &folders, &outbox), Err(SourceFailure::Invalid(_))));
    }

    #[test]
    fn refuses_what_it_cannot_find_or_trust_and_writes_nothing() {
        let root = scratch_dir("auto-refuse");
        let outbox = root.join("out");
        let tracks = root.join("tracks");
        ac_track(&tracks, "circle", None, 100.0);
        let folders = Folders {
            ac: vec![tracks.clone()],
            sce: vec![tracks.clone()],
        };
        let why = build(&seen("ac", "nowhere", None), &folders, &outbox).unwrap_err();
        assert!(why.contains("no direct Assetto Corsa AI source"), "{why}");
        for bad in ["..", "../circle", "a\\b", "", "c:x", "x\u{7}"] {
            let why = build(&seen("ac", bad, None), &folders, &outbox).unwrap_err();
            assert!(why.contains("cannot be a folder name"), "{bad:?}: {why}");
        }
        assert!(build(&seen("ac", "circle", Some("..")), &folders, &outbox).is_err());
        assert!(build(&seen("acc", "circle", None), &folders, &outbox)
            .unwrap_err()
            .contains("not made for acc"));
        assert!(build(&seen("ac", "circle", None), &folders, &tracks.join("out"))
            .unwrap_err()
            .contains("into the installed game"));
        // The game's file is damaged: its validation refuses it.
        std::fs::write(
            tracks.join("circle").join("ai").join(ac::SOURCE),
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
        let locations = root.join("game").join("GameData").join("Locations");
        let folder = locations.join("Place").join("Circle");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("Circle.AIW"), aiw::tests::synthetic(300, 4.0, 10.0, -2.0, true)).unwrap();
        std::fs::write(folder.join("Circle.gdb"), "{\n  TrackName = Circle Park\n}\n").unwrap();
        let folders = Folders {
            ac: vec![],
            sce: vec![locations.clone()],
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
            Built::Unchanged(path.clone())
        );
        let (_, track) = build_current(&seen("rfactor1", "Circle Park", None), &folders, &outbox).unwrap();
        assert_eq!(
            track.name, "Circle",
            "the reply reuses the local source without a second upload identity"
        );
        let another = locations.join("Place/Other");
        fs::create_dir_all(&another).unwrap();
        fs::copy(folder.join("Circle.AIW"), another.join("Other.AIW")).unwrap();
        fs::write(another.join("Other.gdb"), "TrackName = Circle Park").unwrap();
        assert!(matches!(
            build_current(&seen("rfactor1", "Circle Park", None), &folders, &outbox),
            Err(SourceFailure::Invalid(_))
        ));
        fs::write(another.join("Other.gdb"), "TrackName = Circle").unwrap();
        assert!(matches!(
            build_current(&seen("rfactor1", "Circle", None), &folders, &outbox),
            Err(SourceFailure::Invalid(_))
        ));
        assert!(fresh::load(&path).is_some());
    }

    #[test]
    fn the_thread_can_retry_missing_source_and_temporary_write_failure() {
        let root = scratch_dir("auto-run");
        let tracks = root.join("tracks-of-the-game");
        let out = root.join("laps");
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join(TRACKS_DIR), b"temporary output blocker").unwrap();
        let (lines, woken) = (Mutex::new(Vec::new()), Mutex::new(0));
        let folders = || Folders {
            ac: vec![tracks.clone()],
            sce: vec![],
        };
        std::thread::scope(|scope| {
            let (tx, rx) = mpsc::channel();
            let (worker_out, log, wakes) = (&out, &lines, &woken);
            scope.spawn(move || {
                run(worker_out, &rx, &folders, &|| false, &|| *wakes.lock().unwrap() += 1, &|line| {
                    log.lock().unwrap().push(line)
                });
            });
            let request = || {
                let (reply, result) = mpsc::channel();
                tx.send(Request {
                    seen: seen("ac", "circle", None),
                    reply,
                })
                .ok()
                .unwrap();
                result.recv_timeout(Duration::from_secs(5)).unwrap()
            };
            assert!(matches!(request(), Err(SourceFailure::Unavailable(_))));
            ac_track(&tracks, "circle", None, 100.0);
            assert!(matches!(request(), Err(SourceFailure::Retryable(_))));
            fs::remove_file(out.join(TRACKS_DIR)).unwrap();
            assert!(request().is_ok());
            assert!(request().is_ok(), "warm cache completes independently");
            drop(tx);
        });
        let lines = lines.into_inner().unwrap();
        assert_eq!(*woken.lock().unwrap(), 1, "{lines:?}");
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert!(lines[2].starts_with("Track layout of circle built"), "{lines:?}");
        assert_eq!(files(&out.join(TRACKS_DIR)).len(), 2, "one layout and its source receipt");
    }

    #[test]
    fn the_thread_stops_when_told_to() {
        let (_tx, rx) = mpsc::channel::<Request>();
        run(Path::new("unused"), &rx, &Folders::default, &|| true, &|| {}, &|_| {});
    }

    #[test]
    #[ignore = "reads the installed Union Island mod; scratch outputs only"]
    fn installed_union_island_drops_duplicate_pit_and_keeps_freeroam_unavailable() {
        let folders = Folders::installed();
        let request = seen("ac", "union_island", Some("traffic"));
        let root = scratch_dir("installed-ac-union-island");
        let (_, traffic) = build_current(&request, &folders, &root).unwrap();
        assert_eq!(track_identity(&traffic), "ac|union_island|traffic");
        assert!(traffic.pitlane.is_none());
        let freeroam =
            build_current(&seen("ac", "union_island", Some("freeroam")), &folders, &root).map(|(_, track)| track_identity(&track));
        assert!(
            matches!(&freeroam, Err(SourceFailure::Unavailable(why)) if why.contains(ac::SOURCE)),
            "{freeroam:?}"
        );
    }
}
