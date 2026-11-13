//! Small helpers: time as ISO text, and file names that are safe on Windows.

use std::time::{SystemTime, UNIX_EPOCH};

/// `3:27.250` for a time in milliseconds.
pub fn clock(ms: u32) -> String {
    format!("{}:{:02}.{:03}", ms / 60_000, ms / 1000 % 60, ms % 1000)
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// A new id for a game session: 32 lower-case hexadecimal characters, 16 random bytes from the operating system. Made
/// once per run of one session (see `lapcut.rs`) and written into every lap of it as `sessionId`. Without the system's
/// random numbers (they never fail in practice) it is made from the time and a counter, which is still not repeated
/// inside one run of the program.
pub fn new_session_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut bytes = [0u8; 16];
    if crate::connect::fill_random(&mut bytes).is_err() {
        let now = now_ms() as u64;
        bytes[..8].copy_from_slice(&now.to_be_bytes());
        bytes[8..].copy_from_slice(&COUNTER.fetch_add(1, Ordering::Relaxed).to_be_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Days since 1970-01-01 to a civil date (proleptic Gregorian), after Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// `2026-11-10T12:00:00.000Z` for a Unix time in milliseconds.
pub fn iso_utc(unix_ms: i64) -> String {
    let secs = unix_ms.div_euclid(1000);
    let ms = unix_ms.rem_euclid(1000);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    let in_day = secs.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        in_day / 3600,
        in_day % 3600 / 60,
        in_day % 60
    )
}

/// Keeps letters and digits, turns anything else into one dash; never empty, never long.
pub fn file_safe(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let trimmed = out.trim_end_matches('-');
    if trimmed.is_empty() {
        "unknown".into()
    } else {
        trimmed.chars().take(40).collect()
    }
}

/// Locks a mutex even when a thread panicked while holding it. The data it guards is plain state (counters, lists, the
/// last reading), so carrying on with what was there is better than taking the whole tray down with one panic.
pub fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (RFC 4648).
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(BASE64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Standard base64 with padding, strictly: anything that is not exactly what `base64_encode` could have written is
/// refused, so a damaged value is never half-read.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let text = text.trim().as_bytes();
    if text.is_empty() || !text.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let blocks = text.len() / 4;
    for (index, block) in text.chunks(4).enumerate() {
        let padding = block.iter().rev().take_while(|&&b| b == b'=').count();
        if padding > 2 || (padding > 0 && index + 1 != blocks) {
            return None;
        }
        let mut n = 0u32;
        for (i, &b) in block.iter().enumerate() {
            let digit = if i >= 4 - padding {
                0
            } else {
                BASE64.iter().position(|&c| c == b)? as u32
            };
            n = n << 6 | digit;
        }
        out.extend_from_slice(&n.to_be_bytes()[1..4 - padding]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_and_matches_the_standard_examples() {
        for (plain, coded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64_encode(plain.as_bytes()), coded);
            if !plain.is_empty() {
                assert_eq!(base64_decode(coded).as_deref(), Some(plain.as_bytes()));
            }
        }
        let all: Vec<u8> = (0..=255).collect();
        assert_eq!(base64_decode(&base64_encode(&all)), Some(all));
        for bad in ["", "Zg=", "Zg", "Z===", "Zm9v!A==", "Zg==Zg==", "Zm9v Zm9v", "=Zm9"] {
            assert_eq!(base64_decode(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_poisoned_mutex_is_still_readable_through_the_helper() {
        let mutex = std::sync::Arc::new(std::sync::Mutex::new(7));
        let held = mutex.clone();
        let _ = std::thread::spawn(move || {
            let mut guard = held.lock().unwrap();
            *guard = 8;
            panic!("poisoning on purpose");
        })
        .join();
        assert!(mutex.lock().is_err(), "the mutex is poisoned");
        assert_eq!(*lock(&mutex), 8);
        *lock(&mutex) += 1;
        assert_eq!(*lock(&mutex), 9);
    }

    #[test]
    fn formats_dates_like_javascript_does() {
        // The reference values come from Date.parse in Node.
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(1_794_312_000_000), "2026-11-10T12:00:00.000Z");
        assert_eq!(iso_utc(951_868_799_999), "2000-02-29T23:59:59.999Z");
        assert_eq!(iso_utc(1_798_761_599_001), "2026-12-31T23:59:59.001Z");
    }

    #[test]
    fn writes_a_lap_time_like_a_clock() {
        assert_eq!(clock(207_250), "3:27.250");
        assert_eq!(clock(59_999), "0:59.999");
        assert_eq!(clock(3_600_000), "60:00.000");
    }

    #[test]
    fn makes_file_names_safe() {
        assert_eq!(file_safe("Circuit de la Sarthe (24h)"), "circuit-de-la-sarthe-24h");
        assert_eq!(file_safe("  ../..\\x  "), "x");
        assert_eq!(file_safe("###"), "unknown");
        assert_eq!(file_safe(&"a".repeat(100)).len(), 40);
    }

    #[test]
    fn a_session_id_is_32_hexadecimal_characters_and_is_not_repeated() {
        let ids: std::collections::HashSet<String> = (0..2000).map(|_| new_session_id()).collect();
        assert_eq!(ids.len(), 2000);
        assert!(ids
            .iter()
            .all(|id| id.len() == 32 && id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))));
    }
}
