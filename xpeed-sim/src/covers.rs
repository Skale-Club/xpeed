//! Game covers for the panel. They come only from Xpeed's own server (its database, through `GET /api/sim/games`
//! and `GET /api/sim/games/<key>/cover`), never from a store or another site, and are kept in Xpeed Sim's folder
//! (`covers\<key>.jpg`, with the server's hash of it in `covers\<key>.sha256`) so the panel has them offline. A cover
//! is fetched again only when the server's hash changes. A game with no cover yet is drawn as a designed card.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// The games Xpeed Sim reads, in the order the waiting screen shows them: the game's key (the id Xpeed Sim writes
/// in its laps, and the key of its row on the server) and its name.
pub const GAMES: &[(&str, &str)] = &[
    ("lmu", "Le Mans Ultimate"),
    ("ac", "Assetto Corsa"),
    ("acc", "Assetto Corsa Competizione"),
    ("acevo", "Assetto Corsa EVO"),
    ("acr", "Assetto Corsa Rally"),
    ("ams2", "Automobilista 2"),
    ("f1", "F1 25"),
    ("wreckfest2", "Wreckfest 2"),
    ("rfactor1", "Stock Car Extreme"),
    ("iracing", "iRacing"),
];

/// The largest cover accepted from the server (they are about 50 KB).
const MAX_COVER_BYTES: u64 = 1024 * 1024;

/// Where Xpeed Sim keeps the covers.
pub fn folder() -> Option<PathBuf> {
    crate::config::home_dir().map(|home| home.join("covers"))
}

/// A game's cover in Xpeed Sim's folder, if it was fetched.
pub fn file(key: &str) -> Option<PathBuf> {
    folder().and_then(|dir| file_in(&dir, key))
}

fn file_in(dir: &Path, key: &str) -> Option<PathBuf> {
    let path = dir.join(format!("{key}.jpg"));
    path.is_file().then_some(path)
}

/// A game key as the server writes it: what can safely be a file name and a piece of an address.
fn valid_key(key: &str) -> bool {
    (1..=32).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The server's list: each game's key and the hash of its cover. Anything malformed is left out.
fn listed(body: &str) -> Vec<(String, String)> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let Some(games) = value.get("games").and_then(Value::as_array) else {
        return Vec::new();
    };
    games
        .iter()
        .filter_map(|game| {
            let key = game.get("key")?.as_str()?;
            let hash = game.get("cover")?.get("sha256")?.as_str()?;
            (valid_key(key) && valid_hash(hash)).then(|| (key.to_owned(), hash.to_owned()))
        })
        .collect()
}

/// The covers whose copy here is missing or older than the server's.
fn wanted(dir: &Path, list: &[(String, String)]) -> Vec<(String, String)> {
    list.iter()
        .filter(|(key, hash)| {
            let kept = std::fs::read_to_string(dir.join(format!("{key}.sha256"))).unwrap_or_default();
            file_in(dir, key).is_none() || kept.trim() != hash
        })
        .cloned()
        .collect()
}

/// An image the panel can show (JPEG, PNG or WebP), by its first bytes.
fn looks_like_image(bytes: &[u8]) -> bool {
    bytes.len() >= 100
        && (bytes.starts_with(&[0xff, 0xd8, 0xff])
            || bytes.starts_with(b"\x89PNG\r\n\x1a\n")
            || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")))
}

/// Keeps one cover: the image first (through a `.part` file, so a cut download never replaces a good copy), then the
/// hash it answers to.
fn keep(dir: &Path, key: &str, hash: &str, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let part = dir.join(format!("{key}.jpg.part"));
    std::fs::write(&part, bytes)?;
    std::fs::rename(&part, dir.join(format!("{key}.jpg")))?;
    std::fs::write(dir.join(format!("{key}.sha256")), hash)
}

/// Brings the covers kept here up to date with the server's (`server` as kept in the pairing, or the default Xpeed
/// site). Nothing personal is sent: no device key, only the public list and images. Returns how many changed, or
/// None when the server's list could not be read (to try again later).
pub fn sync(server: &str) -> Option<usize> {
    let dir = folder()?;
    let agent = crate::net::agent();
    let fetch = |url: &str| -> Option<Vec<u8>> {
        let mut response = agent.get(url).call().ok()?;
        if response.status().as_u16() != 200 {
            return None;
        }
        response.body_mut().with_config().limit(MAX_COVER_BYTES).read_to_vec().ok()
    };
    let Some(body) = fetch(&format!("{server}/api/sim/games")) else {
        crate::applog::line("could not read the game covers from the server");
        return None;
    };
    let mut changed = 0;
    for (key, hash) in wanted(&dir, &listed(&String::from_utf8_lossy(&body))) {
        match fetch(&format!("{server}/api/sim/games/{key}/cover")) {
            Some(bytes) if looks_like_image(&bytes) && keep(&dir, &key, &hash, &bytes).is_ok() => changed += 1,
            _ => crate::applog::line(&format!("could not fetch the cover of {key}")),
        }
    }
    if changed > 0 {
        crate::applog::line(&format!("fetched {changed} game cover(s) from the server"));
    }
    Some(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn reads_the_servers_list_and_leaves_out_what_is_malformed() {
        let body = format!(
            r#"{{"games":[
                {{"key":"iracing","title":"iRacing","cover":{{"sha256":"{HASH_A}","path":"/api/sim/games/iracing/cover"}}}},
                {{"key":"../x","cover":{{"sha256":"{HASH_A}"}}}},
                {{"key":"lmu","cover":{{"sha256":"not a hash"}}}},
                {{"key":"ac"}},
                {{"key":"AC","cover":{{"sha256":"{HASH_B}"}}}}
            ]}}"#
        );
        assert_eq!(listed(&body), vec![("iracing".to_owned(), HASH_A.to_owned())]);
        assert!(listed("<html>").is_empty());
        assert!(listed("{}").is_empty());
    }

    #[test]
    fn fetches_only_what_is_missing_or_changed() {
        let dir = crate::config::scratch_dir("covers-sync");
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0];
        jpeg.resize(500, 7);
        keep(&dir, "lmu", HASH_A, &jpeg).unwrap();
        keep(&dir, "ac", HASH_A, &jpeg).unwrap();
        let list = vec![
            ("lmu".to_owned(), HASH_A.to_owned()),
            ("ac".to_owned(), HASH_B.to_owned()),
            ("iracing".to_owned(), HASH_A.to_owned()),
        ];
        let keys: Vec<String> = wanted(&dir, &list).into_iter().map(|(k, _)| k).collect();
        assert_eq!(keys, ["ac", "iracing"], "the same hash is not fetched again");
        assert_eq!(file_in(&dir, "lmu"), Some(dir.join("lmu.jpg")));
        assert_eq!(file_in(&dir, "iracing"), None);
        assert!(!dir.join("lmu.jpg.part").exists());
    }

    #[test]
    fn takes_only_images() {
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0];
        jpeg.resize(500, 0);
        assert!(looks_like_image(&jpeg));
        assert!(!looks_like_image(&[0xff, 0xd8, 0xff]), "too small to be a picture");
        assert!(!looks_like_image(b"<html><body>not found</body></html>".repeat(5).as_slice()));
        assert!(valid_key("wreckfest2") && !valid_key("") && !valid_key("a/b") && !valid_key("Iracing"));
    }

    #[test]
    fn lists_every_game_once() {
        let mut keys: Vec<&str> = GAMES.iter().map(|(key, _)| *key).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), GAMES.len());
        assert!(GAMES.iter().all(|(key, _)| valid_key(key)));
    }
}
