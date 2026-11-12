//! The log file of the tray app: what happened, one line each, with the time. It never holds the device key.
//! When it passes 512 KB the old half is kept as `sim.log.old` and a new one starts. The last lines are also kept in
//! memory for the panel.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::util::{iso_utc, now_ms};

const LIMIT: u64 = 512 * 1024;
static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
/// The last lines, with their Unix time in ms, for the panel.
static RECENT: Mutex<VecDeque<(i64, String)>> = Mutex::new(VecDeque::new());
const RECENT_LINES: usize = 200;

pub fn init(path: PathBuf) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    *FILE.lock().unwrap() = Some(path);
}

/// The last `n` lines written (oldest first), with their Unix time in ms.
pub fn recent(n: usize) -> Vec<(i64, String)> {
    let recent = RECENT.lock().unwrap();
    recent.iter().skip(recent.len().saturating_sub(n)).cloned().collect()
}

pub fn line(text: &str) {
    let clean = text.replace(['\r', '\n'], " ");
    {
        let mut recent = RECENT.lock().unwrap();
        recent.push_back((now_ms(), clean.clone()));
        while recent.len() > RECENT_LINES {
            recent.pop_front();
        }
    }
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
        let path = dir.join("sim.log");
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
        // The panel's copy keeps the newest lines, even those written before the file was set.
        // (Other tests may log at the same time, so only the order of these lines is checked.)
        let kept: Vec<String> = recent(RECENT_LINES).into_iter().map(|(_, text)| text).collect();
        let place = |wanted: &str| kept.iter().position(|t| t == wanted).expect(wanted);
        assert!(place("nothing is written before init") < place("first"));
        assert!(place("first") < place("two lines") && place("two lines") < place("after"));
        assert_eq!(recent(1).len(), 1);
    }
}
