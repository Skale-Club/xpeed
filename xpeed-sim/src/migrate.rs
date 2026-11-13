//! Moves what the program kept under its old name ("Xpeed Sim") to the new folders ("Xpeed Companion"), once, at start-up,
//! before anything reads the configuration. The pairing (the login) and the laps must never be lost, so:
//!
//! * the old folder is **renamed** to the new name (the same disk, instant, nothing copied);
//! * if the rename fails (a file is open, another disk...), the whole tree is **copied**, the file count and every size
//!   are checked, and only then is the copy accepted. The old folder is **never deleted** after a copy: it stays as it was;
//! * a copy that fails or does not match is removed (it was made here, the new folder did not exist before), so the next
//!   start tries again with the old folder untouched;
//! * when both the old and the new folder exist, nothing is done (two sets of data are never merged), and a line says so.
//!
//! Every step goes to the log through the `log` callback.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::config;

/// The key of the configuration that may hold a laps folder chosen by the person.
const LAPS_KEY: &str = "lapsDir";

/// What happened to one folder.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Moved {
    /// There was no old folder to move.
    Nothing,
    /// Renamed: the data is under the new name, the old name is gone.
    Renamed,
    /// Copied and verified: the data is under the new name, the old folder is still there, untouched.
    Copied,
    /// Both exist: nothing was done.
    BothExist,
    /// Could not move or copy: the old folder is untouched, the new one does not exist.
    Failed,
}

/// The four folders involved (any may be missing: no profile, or the person chose their own place by an environment
/// variable, which is never moved).
pub struct Places {
    pub old_home: Option<PathBuf>,
    pub new_home: Option<PathBuf>,
    pub old_docs: Option<PathBuf>,
    pub new_docs: Option<PathBuf>,
}

impl Places {
    /// The real places of this person. A folder chosen by environment variable is left alone.
    pub fn real() -> Places {
        let (home, laps) = (config::home_is_overridden(), config::laps_is_overridden());
        Places {
            old_home: if home { None } else { config::legacy_home_dir() },
            new_home: if home { None } else { config::home_dir() },
            old_docs: if laps { None } else { config::legacy_documents_dir() },
            new_docs: if laps { None } else { config::documents_dir() },
        }
    }
}

/// The start-up migration of the real folders. Returns the log lines (the log file is not open yet: it lives in the folder
/// that is being moved).
pub fn run() -> Vec<String> {
    let mut lines = Vec::new();
    migrate(&Places::real(), &|from, to| std::fs::rename(from, to), &mut |line| lines.push(line));
    lines
}

/// Moves the configuration folder and the laps folder, then fixes what points at the old laps folder.
pub fn migrate(places: &Places, rename: &dyn Fn(&Path, &Path) -> io::Result<()>, log: &mut dyn FnMut(String)) {
    if let (Some(old), Some(new)) = (&places.old_home, &places.new_home) {
        let moved = move_dir(old, new, rename, log);
        if matches!(moved, Moved::Renamed | Moved::Copied) {
            rename_old_logs(new, log);
        }
    }
    if let (Some(old), Some(new)) = (&places.old_docs, &places.new_docs) {
        let moved = move_dir(old, new, rename, log);
        if matches!(moved, Moved::Renamed | Moved::Copied) {
            if let Some(home) = &places.new_home {
                rewrite_laps_path(&home.join("config.json"), &old.join("Laps"), &new.join("Laps"), log);
            }
        }
    }
}

/// Moves `old` to `new` as described at the top of this file.
pub fn move_dir(old: &Path, new: &Path, rename: &dyn Fn(&Path, &Path) -> io::Result<()>, log: &mut dyn FnMut(String)) -> Moved {
    if !old.is_dir() {
        return Moved::Nothing;
    }
    if new.exists() {
        log(format!(
            "migration: {} and {} both exist; nothing was moved (the old one is left as it is)",
            old.display(),
            new.display()
        ));
        return Moved::BothExist;
    }
    if let Some(parent) = new.parent().filter(|p| !p.as_os_str().is_empty()) {
        if let Err(error) = std::fs::create_dir_all(parent) {
            log(format!(
                "migration: cannot create {}: {error}; {} was not moved",
                parent.display(),
                old.display()
            ));
            return Moved::Failed;
        }
    }
    match rename(old, new) {
        Ok(()) => {
            log(format!("migration: moved {} to {}", old.display(), new.display()));
            return Moved::Renamed;
        }
        Err(error) => log(format!(
            "migration: could not rename {} to {} ({error}); copying instead",
            old.display(),
            new.display()
        )),
    }
    match copy_verified(old, new) {
        Ok(files) => {
            log(format!(
                "migration: copied {} to {} ({files} files, every size checked); {} was left untouched",
                old.display(),
                new.display(),
                old.display()
            ));
            Moved::Copied
        }
        Err(why) => {
            // The new folder did not exist before this copy, so what is there now is only the unfinished copy.
            let _ = std::fs::remove_dir_all(new);
            log(format!(
                "migration: the copy of {} to {} failed ({why}); the half-made copy was removed and {} is untouched; it will be tried again at the next start",
                old.display(),
                new.display(),
                old.display()
            ));
            Moved::Failed
        }
    }
}

/// Every file under `root` with its size, by path relative to `root`.
fn listing(root: &Path) -> io::Result<BTreeMap<String, u64>> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, u64>) -> io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                walk(&path, root, out)?;
            } else {
                let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                out.insert(relative, entry.metadata()?.len());
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out)?;
    Ok(out)
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Copies the whole tree and checks that the new one has the same files with the same sizes. Returns the file count.
fn copy_verified(old: &Path, new: &Path) -> Result<usize, String> {
    copy_tree(old, new).map_err(|e| e.to_string())?;
    let before = listing(old).map_err(|e| e.to_string())?;
    let after = listing(new).map_err(|e| e.to_string())?;
    if before != after {
        return Err(format!("{} files before, {} after, or sizes differ", before.len(), after.len()));
    }
    Ok(before.len())
}

/// The log file had the old name (`sim.log`); it keeps its history under the new one. Only inside the new folder.
fn rename_old_logs(home: &Path, log: &mut dyn FnMut(String)) {
    for (old, new) in [("sim.log", "companion.log"), ("sim.log.old", "companion.log.old")] {
        let (from, to) = (home.join(old), home.join(new));
        if from.is_file() && !to.exists() {
            match std::fs::rename(&from, &to) {
                Ok(()) => log(format!("migration: renamed {old} to {new}")),
                Err(error) => log(format!("migration: could not rename {old} to {new}: {error}")),
            }
        }
    }
}

fn same_place(a: &str, b: &Path) -> bool {
    let clean = |text: &str| {
        let text = text.replace('/', "\\");
        let text = text.trim_end_matches('\\').to_owned();
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text
        }
    };
    clean(a) == clean(&b.to_string_lossy())
}

/// If the saved configuration holds a laps folder equal to the old default, it is rewritten to the new default (that
/// folder was just moved, so the old path would be empty or gone). A folder the person chose themselves is left alone.
/// Returns whether the file was rewritten.
pub fn rewrite_laps_path(config_path: &Path, old_default: &Path, new_default: &Path, log: &mut dyn FnMut(String)) -> bool {
    let Ok(text) = std::fs::read_to_string(config_path) else {
        return false;
    };
    let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let stored = value.get(LAPS_KEY).and_then(Value::as_str).map(str::to_owned);
    let Some(stored) = stored.filter(|s| same_place(s, old_default)) else {
        return false;
    };
    value[LAPS_KEY] = Value::String(new_default.to_string_lossy().into_owned());
    let Ok(body) = serde_json::to_string_pretty(&value) else {
        return false;
    };
    let partial = config_path.with_extension("json.part");
    let written = std::fs::write(&partial, body + "\n").and_then(|()| std::fs::rename(&partial, config_path));
    match written {
        Ok(()) => {
            log(format!(
                "migration: the saved laps folder {stored} now points to {}",
                new_default.display()
            ));
            true
        }
        Err(error) => {
            let _ = std::fs::remove_file(&partial);
            log(format!("migration: could not update the saved laps folder: {error}"));
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::scratch_dir;

    fn put(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn real_rename() -> impl Fn(&Path, &Path) -> io::Result<()> {
        |from, to| std::fs::rename(from, to)
    }

    fn failing_rename() -> impl Fn(&Path, &Path) -> io::Result<()> {
        |_, _| Err(io::Error::other("another disk"))
    }

    #[test]
    fn the_old_folder_is_moved_with_everything_in_it() {
        let root = scratch_dir("mig-move");
        let (old, new) = (root.join("Xpeed Sim"), root.join("Xpeed Companion"));
        put(&old.join("config.json"), "{\"token\":\"xpd_a\"}");
        put(&old.join("covers/iracing.png"), "png");
        let mut lines = Vec::new();
        let moved = move_dir(&old, &new, &real_rename(), &mut |l| lines.push(l));
        assert_eq!(moved, Moved::Renamed);
        assert!(!old.exists());
        assert_eq!(std::fs::read_to_string(new.join("config.json")).unwrap(), "{\"token\":\"xpd_a\"}");
        assert_eq!(std::fs::read_to_string(new.join("covers/iracing.png")).unwrap(), "png");
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("migration: moved"));
    }

    #[test]
    fn when_renaming_fails_the_tree_is_copied_checked_and_the_old_one_stays() {
        let root = scratch_dir("mig-copy");
        let (old, new) = (root.join("Xpeed Sim"), root.join("Xpeed Companion"));
        put(&old.join("config.json"), "{\"token\":\"xpd_a\"}");
        put(&old.join("Laps/f1/2026/lap1.xlap.gz"), "lap-one");
        put(&old.join("Laps/f1/2026/lap2.xlap.gz"), "lap-two-longer");
        std::fs::create_dir_all(old.join("empty-dir")).unwrap();
        let mut lines = Vec::new();
        let moved = move_dir(&old, &new, &failing_rename(), &mut |l| lines.push(l));
        assert_eq!(moved, Moved::Copied);
        assert_eq!(listing(&old).unwrap(), listing(&new).unwrap());
        assert_eq!(listing(&new).unwrap().len(), 3);
        assert_eq!(
            std::fs::read_to_string(new.join("Laps/f1/2026/lap2.xlap.gz")).unwrap(),
            "lap-two-longer"
        );
        // The old folder is exactly as it was: never deleted after a copy.
        assert_eq!(std::fs::read_to_string(old.join("config.json")).unwrap(), "{\"token\":\"xpd_a\"}");
        assert!(old.join("Laps/f1/2026/lap1.xlap.gz").exists());
        assert!(lines.iter().any(|l| l.contains("copying instead")));
        assert!(lines.iter().any(|l| l.contains("left untouched")));
    }

    #[test]
    fn a_copy_that_does_not_match_is_dropped_and_the_old_folder_stays() {
        let root = scratch_dir("mig-copy-bad");
        let (old, new) = (root.join("Xpeed Sim"), root.join("Xpeed Companion"));
        put(&old.join("config.json"), "{}");
        // The verification itself: a target that ends up with a file the source does not have is not an exact copy.
        put(&new.join("extra"), "not in the old folder");
        assert!(
            copy_verified(&old, &new).is_err(),
            "the file lists differ, so the copy is not accepted"
        );
        assert!(old.join("config.json").exists());
        // A "new" name that is already taken (here by a plain file) is the "both exist" case: nothing is touched.
        let blocked = root.join("blocked");
        put(&blocked, "a file");
        let mut lines = Vec::new();
        assert_eq!(
            move_dir(&old, &blocked, &failing_rename(), &mut |l| lines.push(l)),
            Moved::BothExist
        );
    }

    #[test]
    fn when_both_exist_nothing_is_touched() {
        let root = scratch_dir("mig-both");
        let (old, new) = (root.join("Xpeed Sim"), root.join("Xpeed Companion"));
        put(&old.join("config.json"), "old");
        put(&new.join("config.json"), "new");
        let mut lines = Vec::new();
        assert_eq!(move_dir(&old, &new, &real_rename(), &mut |l| lines.push(l)), Moved::BothExist);
        assert_eq!(std::fs::read_to_string(old.join("config.json")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(new.join("config.json")).unwrap(), "new");
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("both exist"));
    }

    #[test]
    fn with_nothing_to_move_nothing_happens_and_nothing_is_created() {
        let root = scratch_dir("mig-none");
        let (old, new) = (root.join("Xpeed Sim"), root.join("Xpeed Companion"));
        let mut lines = Vec::new();
        assert_eq!(move_dir(&old, &new, &real_rename(), &mut |l| lines.push(l)), Moved::Nothing);
        assert!(!new.exists() && lines.is_empty());
        // An old name that is a plain file is not a folder to move either.
        put(&old, "a file");
        assert_eq!(move_dir(&old, &new, &real_rename(), &mut |l| lines.push(l)), Moved::Nothing);
    }

    #[test]
    fn the_saved_laps_folder_is_rewritten_only_when_it_was_the_old_default() {
        let root = scratch_dir("mig-config");
        let (old, new) = (root.join("Documents/Xpeed Sim/Laps"), root.join("Documents/Xpeed Companion/Laps"));
        let path = root.join("config.json");
        put(
            &path,
            &format!(
                "{{\"server\":\"https://x.example\",\"token\":\"xpd_a\",\"lapsDir\":{:?}}}",
                old.to_string_lossy()
            ),
        );
        let mut lines = Vec::new();
        assert!(rewrite_laps_path(&path, &old, &new, &mut |l| lines.push(l)));
        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value[LAPS_KEY], new.to_string_lossy().as_ref());
        assert_eq!(value["token"], "xpd_a", "the rest of the file is kept");
        assert!(!path.with_extension("json.part").exists());
        assert_eq!(lines.len(), 1);
        // Already the new one, a folder the person chose, no such key, a damaged file, no file: all left alone.
        assert!(!rewrite_laps_path(&path, &old, &new, &mut |_| {}));
        put(&path, "{\"lapsDir\":\"D:\\\\mine\"}");
        assert!(!rewrite_laps_path(&path, &old, &new, &mut |_| {}));
        assert!(std::fs::read_to_string(&path).unwrap().contains("D:"));
        put(&path, "{\"token\":\"xpd_a\"}");
        assert!(!rewrite_laps_path(&path, &old, &new, &mut |_| {}));
        put(&path, "not json");
        assert!(!rewrite_laps_path(&path, &old, &new, &mut |_| {}));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
        assert!(!rewrite_laps_path(&root.join("missing.json"), &old, &new, &mut |_| {}));
    }

    #[test]
    fn the_whole_migration_moves_both_folders_keeps_the_log_and_fixes_the_laps_path() {
        let root = scratch_dir("mig-all");
        let places = Places {
            old_home: Some(root.join("AppData/Xpeed Sim")),
            new_home: Some(root.join("AppData/Xpeed Companion")),
            old_docs: Some(root.join("Documents/Xpeed Sim")),
            new_docs: Some(root.join("Documents/Xpeed Companion")),
        };
        let old_laps = root.join("Documents/Xpeed Sim/Laps");
        put(
            &places.old_home.as_ref().unwrap().join("config.json"),
            &format!(
                "{{\"server\":\"https://x.example\",\"token\":\"xpd_a\",\"lapsDir\":{:?}}}",
                old_laps.to_string_lossy()
            ),
        );
        put(&places.old_home.as_ref().unwrap().join("sim.log"), "history");
        put(&places.old_home.as_ref().unwrap().join("sim.log.old"), "older");
        put(&old_laps.join("lap.xlap.gz"), "lap");
        let mut lines = Vec::new();
        migrate(&places, &real_rename(), &mut |l| lines.push(l));
        let (home, docs) = (places.new_home.unwrap(), places.new_docs.unwrap());
        assert_eq!(std::fs::read_to_string(docs.join("Laps/lap.xlap.gz")).unwrap(), "lap");
        assert_eq!(std::fs::read_to_string(home.join("companion.log")).unwrap(), "history");
        assert_eq!(std::fs::read_to_string(home.join("companion.log.old")).unwrap(), "older");
        assert!(!home.join("sim.log").exists());
        let config = config::load(&home.join("config.json")).unwrap().unwrap();
        assert_eq!(config.token, "xpd_a", "the pairing survived");
        let value: Value = serde_json::from_str(&std::fs::read_to_string(home.join("config.json")).unwrap()).unwrap();
        assert_eq!(value[LAPS_KEY], docs.join("Laps").to_string_lossy().as_ref());
        assert!(!places.old_home.unwrap().exists() && !places.old_docs.unwrap().exists());
        // Running it again finds nothing to do.
        let before = lines.len();
        migrate(
            &Places {
                old_home: Some(root.join("AppData/Xpeed Sim")),
                new_home: Some(home),
                old_docs: Some(root.join("Documents/Xpeed Sim")),
                new_docs: Some(docs),
            },
            &real_rename(),
            &mut |l| lines.push(l),
        );
        assert_eq!(lines.len(), before);
    }

    #[test]
    fn a_failed_laps_move_does_not_touch_the_saved_path() {
        let root = scratch_dir("mig-laps-both");
        let places = Places {
            old_home: None,
            new_home: Some(root.join("AppData/Xpeed Companion")),
            old_docs: Some(root.join("Documents/Xpeed Sim")),
            new_docs: Some(root.join("Documents/Xpeed Companion")),
        };
        let old_laps = root.join("Documents/Xpeed Sim/Laps");
        let body = format!("{{\"token\":\"xpd_a\",\"lapsDir\":{:?}}}", old_laps.to_string_lossy());
        put(&root.join("AppData/Xpeed Companion/config.json"), &body);
        put(&old_laps.join("lap"), "x");
        put(&root.join("Documents/Xpeed Companion/other"), "y");
        migrate(&places, &real_rename(), &mut |_| {});
        assert_eq!(
            std::fs::read_to_string(root.join("AppData/Xpeed Companion/config.json")).unwrap(),
            body
        );
        assert!(old_laps.join("lap").exists());
    }
}
