//! The log file of the tray app: what happened, one line each, with the time. It never holds the device key.
//! When it passes 512 KB the old half is kept as `companion.log.old` and a new one starts. It is for support: the panel
//! shows the person's activity in plain words instead (`status::Activity`).

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::util::{iso_utc, now_ms};

const LIMIT: u64 = 512 * 1024;
static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
static EARLY: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// A line from before the log could be opened (the start-up migration). It is written when `init` runs.
pub fn early(text: &str) {
    EARLY.lock().unwrap().push(text.to_owned());
}

pub fn init(path: PathBuf) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    *FILE.lock().unwrap() = Some(path);
    let waiting = std::mem::take(&mut *EARLY.lock().unwrap());
    for text in waiting {
        line(&text);
    }
}

pub fn line(text: &str) {
    let clean = text.replace(['\r', '\n'], " ");
    let guard = FILE.lock().unwrap();
    let Some(path) = guard.as_ref() else { return };
    if std::fs::metadata(path).is_ok_and(|m| m.len() > LIMIT) {
        let _ = std::fs::rename(path, path.with_extension("log.old"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}  {}", iso_utc(now_ms()), clean);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The log is one file for the whole process, so this is one test.
    #[test]
    fn appends_lines_with_a_time_and_starts_over_when_it_gets_big() {
        let dir = crate::config::scratch_dir("log");
        let path = dir.join("companion.log");
        line("nothing is written before init");
        assert!(!path.exists());
        init(path.clone());
        line("first");
        line("two\nlines");
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("  first") && lines[0].starts_with("20"));
        assert!(lines[1].ends_with("  two lines"));
        std::fs::write(&path, vec![b'x'; (LIMIT + 1) as usize]).unwrap();
        line("after");
        assert!(path.with_extension("log.old").exists());
        assert!(std::fs::read_to_string(&path).unwrap().trim_end().ends_with("  after"));
    }
}
