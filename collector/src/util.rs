//! Small helpers: time as ISO text, and file names that are safe on Windows.

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_dates_like_javascript_does() {
        // The reference values come from Date.parse in Node.
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(1_794_312_000_000), "2026-11-10T12:00:00.000Z");
        assert_eq!(iso_utc(951_868_799_999), "2000-02-29T23:59:59.999Z");
        assert_eq!(iso_utc(1_798_761_599_001), "2026-12-31T23:59:59.001Z");
    }

    #[test]
    fn makes_file_names_safe() {
        assert_eq!(file_safe("Circuit de la Sarthe (24h)"), "circuit-de-la-sarthe-24h");
        assert_eq!(file_safe("  ../..\\x  "), "x");
        assert_eq!(file_safe("###"), "unknown");
        assert_eq!(file_safe(&"a".repeat(100)).len(), 40);
    }
}
