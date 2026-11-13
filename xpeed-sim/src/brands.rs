//! Curated car-brand recognition and the Xpeed-owned brand-image catalogue.
//! Matching is deliberately conservative: only server-provided names and aliases are accepted.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

const MAX_LOGO_BYTES: u64 = 512 * 1024;
static CATALOGS: OnceLock<Mutex<HashMap<String, Vec<Brand>>>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Brand {
    pub key: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub sha256: String,
    pub bytes: u64,
}

fn valid_key(s: &str) -> bool {
    (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Reject malformed metadata and anything that could escape the fixed logo endpoint/cache directory.
pub fn listed(body: &str) -> Vec<Brand> {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let Some(rows) = v.get("brands").and_then(Value::as_array) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let key = row.get("key")?.as_str()?;
            let name = row.get("name")?.as_str()?;
            let logo = row.get("logo")?;
            let hash = logo.get("sha256")?.as_str()?;
            let bytes = logo.get("bytes")?.as_u64()?;
            if !valid_key(key)
                || !valid_hash(hash)
                || logo.get("type")?.as_str()? != "image/png"
                || bytes == 0
                || bytes > MAX_LOGO_BYTES
                || logo.get("path")?.as_str()? != format!("/api/car-brands/{key}/logo")
                || name.is_empty()
                || name.len() > 80
            {
                return None;
            }
            let aliases = row
                .get("aliases")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|s| !s.trim().is_empty() && s.len() <= 80)
                .map(str::to_owned)
                .collect();
            Some(Brand {
                key: key.to_owned(),
                name: name.to_owned(),
                aliases,
                sha256: hash.to_ascii_lowercase(),
                bytes,
            })
        })
        .collect()
}

fn normalized(s: &str) -> String {
    s.nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(|c| {
            if c.is_alphanumeric() {
                c.to_lowercase().collect::<Vec<_>>()
            } else {
                vec![' ']
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Match a leading make token at a word boundary, preferring the longest configured name/alias.
pub fn match_brand<'a>(car: &str, brands: &'a [Brand]) -> Option<&'a Brand> {
    let car = normalized(car);
    // Match the same two distinctive manufacturer-less racing names as the web.
    let model_make = match car.split_whitespace().next() {
        Some("gr010") => Some("toyota"),
        Some("499p") => Some("ferrari"),
        _ => None,
    };
    if let Some(brand) = model_make.and_then(|key| brands.iter().find(|brand| brand.key == key)) {
        return Some(brand);
    }
    brands
        .iter()
        .filter_map(|brand| {
            std::iter::once(&brand.name)
                .chain(std::iter::once(&brand.key))
                .chain(brand.aliases.iter())
                .map(|s| normalized(s))
                .filter(|alias| !alias.is_empty() && (car == *alias || car.strip_prefix(alias).is_some_and(|rest| rest.starts_with(' '))))
                .map(|alias| (brand, alias.len()))
                .max_by_key(|(_, n)| *n)
        })
        .max_by_key(|(_, n)| *n)
        .map(|(b, _)| b)
}

pub fn folder() -> Option<PathBuf> {
    crate::config::home_dir().map(|p| p.join("brand-logos"))
}
pub fn file_in(dir: &Path, key: &str) -> Option<PathBuf> {
    valid_key(key).then(|| dir.join(format!("{key}.png"))).filter(|p| p.is_file())
}

/// Fetch the public catalogue and missing/changed images on a worker thread. Redirects are disabled in `net::agent`.
pub fn sync(server: &str, car: Option<&str>) -> Option<usize> {
    let server = crate::config::normalize_server(server).ok()?;
    let dir = folder()?;
    let agent = crate::net::agent();
    let get = |url: &str, cap: u64| -> Option<Vec<u8>> {
        let mut r = agent.get(url).call().ok()?;
        if r.status().as_u16() != 200 {
            return None;
        }
        r.body_mut().with_config().limit(cap).read_to_vec().ok()
    };
    let catalog = dir.join("catalog.json");
    let catalogs = CATALOGS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut catalogs = catalogs.lock().ok()?;
    let list = if let Some(list) = catalogs.get(&server) {
        list.clone()
    } else {
        let fresh = get(&format!("{server}/api/car-brands"), 512 * 1024)
            .map(|body| listed(&String::from_utf8_lossy(&body)))
            .filter(|list| !list.is_empty());
        let list =
            if let Some(list) = fresh {
                std::fs::create_dir_all(&dir).ok()?;
                let entries: Vec<_> = list.iter().map(|b| serde_json::json!({
                "key": b.key, "name": b.name, "aliases": b.aliases,
                "logo": {"type":"image/png", "sha256":b.sha256, "bytes":b.bytes, "path":format!("/api/car-brands/{}/logo", b.key)}
            })).collect();
                let part = dir.join("catalog.json.part");
                std::fs::write(
                    &part,
                    serde_json::to_vec(&serde_json::json!({"server":server,"brands":entries})).ok()?,
                )
                .ok()?;
                std::fs::rename(part, &catalog).ok()?;
                list
            } else {
                let body = std::fs::read_to_string(&catalog).ok()?;
                let value = serde_json::from_str::<Value>(&body).ok()?;
                if value.get("server")?.as_str()? != server {
                    return None;
                }
                let list = listed(&body);
                if list.is_empty() {
                    return None;
                }
                list
            };
        catalogs.insert(server.clone(), list.clone());
        list
    };
    drop(catalogs);
    let Some(car) = car else { return Some(0) };
    let Some(b) = match_brand(car, &list) else { return Some(0) };
    let old = std::fs::read_to_string(dir.join(format!("{}.sha256", b.key))).unwrap_or_default();
    if old.trim() == b.sha256 && file_in(&dir, &b.key).is_some() {
        return Some(0);
    }
    let bytes = get(&format!("{server}/api/car-brands/{}/logo", b.key), MAX_LOGO_BYTES)?;
    if bytes.len() as u64 != b.bytes || bytes.len() < 100 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    if format!("{:x}", Sha256::digest(&bytes)) != b.sha256 {
        return None;
    }
    let part = dir.join(format!("{}.png.part", b.key));
    std::fs::write(&part, &bytes).ok()?;
    std::fs::rename(&part, dir.join(format!("{}.png", b.key))).ok()?;
    std::fs::write(dir.join(format!("{}.sha256", b.key)), &b.sha256).ok()?;
    Some(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    const H: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn recognizes_longest_make_and_explicit_model_aliases_without_guessing() {
        let brands = listed(&format!(
            r#"{{"brands":[
          {{"key":"toyota","name":"Toyota","aliases":["GR010"],"logo":{{"type":"image/png","sha256":"{H}","bytes":100,"path":"/api/car-brands/toyota/logo"}}}},
          {{"key":"ferrari","name":"Ferrari","aliases":["499P"],"logo":{{"type":"image/png","sha256":"{H}","bytes":100,"path":"/api/car-brands/ferrari/logo"}}}},
          {{"key":"bmw","name":"BMW","aliases":["BMW Motorsport"],"logo":{{"type":"image/png","sha256":"{H}","bytes":100,"path":"/api/car-brands/bmw/logo"}}}},
          {{"key":"bmwm","name":"BMW M","aliases":[],"logo":{{"type":"image/png","sha256":"{H}","bytes":100,"path":"/api/car-brands/bmwm/logo"}}}},
          {{"key":"citroen","name":"Citroën","aliases":[],"logo":{{"type":"image/png","sha256":"{H}","bytes":100,"path":"/api/car-brands/citroen/logo"}}}},
          {{"key":"vw","name":"Volkswagen","aliases":["VW"],"logo":{{"type":"image/png","sha256":"{H}","bytes":100,"path":"/api/car-brands/vw/logo"}}}},
          {{"key":"mercedes","name":"Mercedes-AMG","aliases":["Mercedes-Benz"],"logo":{{"type":"image/png","sha256":"{H}","bytes":100,"path":"/api/car-brands/mercedes/logo"}}}},
          {{"key":"mercedesbenz","name":"Mercedes-Benz Racing","aliases":[],"logo":{{"type":"image/png","sha256":"{H}","bytes":100,"path":"/api/car-brands/mercedesbenz/logo"}}}}
        ]}}"#
        ));
        assert_eq!(match_brand("Toyota GR010 Hybrid", &brands).unwrap().key, "toyota");
        let mut plain_brands = brands.clone();
        for brand in &mut plain_brands {
            brand.aliases.clear();
        }
        assert_eq!(match_brand("GR010 Hybrid", &plain_brands).unwrap().key, "toyota");
        assert_eq!(match_brand("499P", &plain_brands).unwrap().key, "ferrari");
        assert_eq!(match_brand("Ferrari 499P", &brands).unwrap().key, "ferrari");
        assert_eq!(match_brand("BMW M Competition", &brands).unwrap().key, "bmwm");
        assert_eq!(match_brand("Citroën C4", &brands).unwrap().key, "citroen");
        assert_eq!(match_brand("VW Golf", &brands).unwrap().key, "vw");
        assert_eq!(match_brand("Mercedes-AMG GT3", &brands).unwrap().key, "mercedes");
        assert_eq!(match_brand("Mercedes-Benz 190E", &brands).unwrap().key, "mercedes");
        assert!(match_brand("ForzaCar123", &brands).is_none());
        assert!(match_brand("Unknown GT3", &brands).is_none());
    }

    #[test]
    fn rejects_unsafe_or_malformed_catalogue_metadata() {
        assert!(listed(r#"{"brands":[{"key":"../x","name":"x","aliases":[],"logo":{"type":"image/png","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":100,"path":"/api/car-brands/../x/logo"}}]}"#).is_empty());
        assert!(listed("<html>").is_empty());
    }
}
