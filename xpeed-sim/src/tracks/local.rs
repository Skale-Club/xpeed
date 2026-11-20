//! Private native geometry cache. This directory is deliberately outside the
//! upload outbox: game-derived sources are not published by discovering them.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

use super::auto::SourceFailure;
use super::{acevo, auto, dump, Track, MAX_UNPACKED};

pub const DIRECTORY: &str = "native-tracks";
const MAX_MANIFEST: usize = 32 * 1024;
const CACHE_SCHEMA: u32 = 3;
// Bump when EVO's extraction or coordinate contract changes.
const EXTRACTOR_GENERATION: u32 = 1;

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_limit(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > max {
        return Err("native cache file exceeds its bound".into());
    }
    Ok(bytes)
}

fn stamp(source: &Path) -> Result<serde_json::Value, String> {
    let requested = std::path::absolute(source).map_err(|e| e.to_string())?;
    let source = fs::canonicalize(source).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&source).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("native source must be a regular file".into());
    }
    let modified = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    // Steam can preserve asset timestamps. Its build id is an independent
    // source-generation marker; last-played/account metadata is not retained.
    let manifest = source
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(|p| p.join("appmanifest_3058630.acf"));
    let game_build = manifest
        .and_then(|p| read_limit(&p, 64 * 1024).ok())
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| {
            s.lines().find_map(|line| {
                let q: Vec<_> = line.split('"').collect();
                (q.get(1) == Some(&"buildid")).then(|| q.get(3).map(|b| b.to_string())).flatten()
            })
        });
    Ok(
        serde_json::json!({"path":source.to_string_lossy(),"requestedPath":requested.to_string_lossy(),"bytes":meta.len(),"modifiedNanos":modified.as_nanos().to_string(),"gameBuild":game_build}),
    )
}

fn names(directory: &Path, game: &str, track: &str, variant: Option<&str>) -> (PathBuf, PathBuf) {
    let id = digest(auto::track_key(game, track, variant).as_bytes());
    let label = [game, track, variant.unwrap_or("")]
        .map(|s| crate::util::file_safe(&s.trim().to_lowercase()))
        .join("_");
    (
        directory.join(format!("{label}_{id}.xtrk.gz")),
        directory.join(format!("{label}_{id}.json")),
    )
}

fn same_identity(track: &Track, game: &str, name: &str, variant: Option<&str>) -> bool {
    auto::track_key(&track.game, &track.name, track.variant.as_deref()) == auto::track_key(game, name, variant)
}

/// Load only the exact identity, extractor generation, payload digest and source
/// generation that were validated together. Stale files may stay on disk but
/// cannot become a displayed road after an update, move or interrupted write.
fn load_current(directory: &Path, game: &str, name: &str, variant: Option<&str>, source: &serde_json::Value) -> Option<Track> {
    let (file, manifest_file) = names(directory, game, name, variant);
    let m: serde_json::Value = serde_json::from_slice(&read_limit(&manifest_file, MAX_MANIFEST).ok()?).ok()?;
    if m["schema"] != CACHE_SCHEMA
        || m["extractorGeneration"] != EXTRACTOR_GENERATION
        || m["distribution"] != "local-only"
        || m["identity"] != auto::track_key(game, name, variant)
        || &m["source"] != source
        || m["verifiedGameBuild"] != acevo::VERIFIED_BUILD
        || m["idealSourceSha256"] != acevo::VERIFIED_IDEAL_SHA256
    {
        return None;
    }
    let bytes = read_limit(&file, MAX_UNPACKED).ok()?;
    if m["payloadSha256"] != digest(&bytes) {
        return None;
    }
    let track = super::gunzip(&bytes, MAX_UNPACKED).ok()?;
    if m["sourceKind"] != track.source
        || m["frame"] != track.frame
        || m["pitSourceSha256"] != serde_json::json!(track.pitlane.as_ref().map(|_| acevo::VERIFIED_PIT_SHA256))
        || (track.source == "mesh_asphalt" && m["surfaceManifest"] != super::acevo_surface::MANIFEST_VERSION)
    {
        return None;
    }
    same_identity(&track, game, name, variant).then_some(track)
}

#[cfg(test)]
fn load(directory: &Path, game: &str, name: &str, variant: Option<&str>) -> Option<Track> {
    let (_, file) = names(directory, game, name, variant);
    let manifest: serde_json::Value = serde_json::from_slice(&read_limit(&file, MAX_MANIFEST).ok()?).ok()?;
    let requested_path = Path::new(manifest["source"]["requestedPath"].as_str()?);
    load_current(directory, game, name, variant, &stamp(requested_path).ok()?)
}

fn publish(directory: &Path, source: &Path, track: &Track, before: serde_json::Value) -> Result<PathBuf, String> {
    if before != stamp(source)? {
        return Err("game source changed during extraction; retry when the update finishes".into());
    }
    let bytes = dump::gzip_checked(track)?;
    let manifest = serde_json::json!({
        "schema":CACHE_SCHEMA,"extractorGeneration":EXTRACTOR_GENERATION,
        "identity":auto::track_key(&track.game,&track.name,track.variant.as_deref()),
        "source":before,"sourceKind":track.source,"frame":track.frame,
        "verifiedGameBuild":acevo::VERIFIED_BUILD,
        "idealSourceSha256":acevo::VERIFIED_IDEAL_SHA256,
        "pitSourceSha256":track.pitlane.as_ref().map(|_|acevo::VERIFIED_PIT_SHA256),
        "surfaceManifest":(track.source=="mesh_asphalt").then_some(super::acevo_surface::MANIFEST_VERSION),
        "distribution":"local-only","payloadSha256":digest(&bytes),
        "validation":if track.source=="mesh_asphalt" {"hash-pinned scene-classified asphalt triangles; kerbs/turf separate; sampled planar boundaries"}else{"verified native source hashes; AI-side envelope, not certified asphalt"}
    });
    let (file, meta) = names(directory, &track.game, &track.name, track.variant.as_deref());
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let data_part = file.with_extension("gz.part");
    let meta_part = meta.with_extension("json.part");
    let saved = (|| -> std::io::Result<()> {
        fs::write(&data_part, &bytes)?;
        fs::rename(&data_part, &file)?;
        fs::write(&meta_part, serde_json::to_vec(&manifest)?)?;
        fs::rename(&meta_part, &meta)?;
        Ok(())
    })();
    if let Err(error) = saved {
        let _ = fs::remove_file(data_part);
        let _ = fs::remove_file(meta_part);
        return Err(format!("cannot publish private native cache: {error}"));
    }
    Ok(file)
}

/// Called on the geometry worker, never the 100 Hz reader. The verified EVO
/// pilot is selected by telemetry identity; other circuits remain unsupported.
pub(super) fn prepare_evo(directory: &Path, roots: &[PathBuf], name: &str, variant: Option<&str>) -> Result<(bool, Track), SourceFailure> {
    if auto::track_key("acevo", name, variant) != "acevo|laguna seca|gp" {
        return Err(SourceFailure::Invalid(
            "native EVO source is not validated for this track/layout".into(),
        ));
    }
    let game = roots
        .iter()
        .find(|root| root.join("content.kspkg").is_file())
        .ok_or_else(|| SourceFailure::Unavailable("installed EVO package not found".into()))?;
    let source = game.join("content.kspkg");
    if dump::inside(directory, game) {
        return Err(SourceFailure::Invalid(
            "refusing to create a native cache inside the installed game".into(),
        ));
    }
    let before = stamp(&source).map_err(SourceFailure::Retryable)?;
    if before["gameBuild"].as_str().is_some_and(|build| build != acevo::VERIFIED_BUILD) {
        return Err(SourceFailure::Invalid(
            "EVO game build changed; native source/coordinate revalidation is required".into(),
        ));
    }
    if let Some(track) = load_current(directory, "acevo", name, variant, &before) {
        return Ok((false, track));
    }
    let found = acevo::extract_package_asphalt(&source).map_err(|error| {
        if error.code == "io" || error.code == "evo_package" {
            SourceFailure::Retryable(error.to_string())
        } else {
            SourceFailure::Invalid(error.to_string())
        }
    })?;
    if !same_identity(&found.track, "acevo", name, variant) {
        return Err(SourceFailure::Invalid("native EVO source identity differs from telemetry".into()));
    }
    publish(directory, &source, &found.track, before).map_err(SourceFailure::Retryable)?;
    Ok((true, found.track))
}

#[cfg(test)]
fn ensure_evo(directory: &Path, roots: &[PathBuf], name: &str, variant: Option<&str>) -> Result<bool, String> {
    prepare_evo(directory, roots, name, variant)
        .map(|(written, _)| written)
        .map_err(|error| error.to_string())
}

pub fn evo_roots() -> Vec<PathBuf> {
    dump::game_folders("XPEED_EVO_DIR", 3_058_630, "Assetto Corsa EVO", "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::scratch_dir;

    fn cleanup(root: PathBuf) {
        let resolved = root.canonicalize().unwrap();
        assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(&format!("xpeed-companion-test-{}-", std::process::id())));
        fs::remove_dir_all(resolved).unwrap();
    }

    #[test]
    fn source_version_and_digest_control_loading_without_any_outbox_copy() {
        let root = scratch_dir("private-native-cache");
        let source = root.join("game-source");
        fs::write(&source, b"first generation").unwrap();
        let mut track = super::super::tests::golden_track();
        track.game = "acevo".into();
        track.name = "Laguna Seca".into();
        track.variant = Some("GP".into());
        let directory = root.join(DIRECTORY);
        let file = publish(&directory, &source, &track, stamp(&source).unwrap()).unwrap();
        assert!(load(&directory, "acevo", "laguna seca", Some("gp")).is_some());
        assert!(load(&directory, "ac", "laguna seca", Some("gp")).is_none());
        assert!(load(&directory, "acevo", "Laguna Seca", None).is_none());
        assert!(
            !root.join(auto::TRACKS_DIR).exists(),
            "private sources never enter the upload outbox"
        );
        let original = fs::read(&file).unwrap();
        fs::write(&file, b"damaged").unwrap();
        assert!(load(&directory, "acevo", "Laguna Seca", Some("GP")).is_none());
        fs::write(&file, original).unwrap();
        fs::write(&source, b"second generation has a different size").unwrap();
        assert!(load(&directory, "acevo", "Laguna Seca", Some("GP")).is_none());
        cleanup(root);
    }

    #[test]
    fn changed_during_extraction_and_unknown_layout_never_publish() {
        let root = scratch_dir("native-update-race");
        let source = root.join("game");
        fs::write(&source, b"a").unwrap();
        let before = stamp(&source).unwrap();
        fs::write(&source, b"changed").unwrap();
        assert!(publish(&root.join(DIRECTORY), &source, &super::super::tests::golden_track(), before).is_err());
        assert!(ensure_evo(&root.join(DIRECTORY), &[], "Spa", Some("GP")).is_err());
        assert!(!root.join(DIRECTORY).exists());
        cleanup(root);
    }

    #[test]
    #[cfg(windows)]
    fn retargeted_game_junction_invalidates_even_when_old_sources_still_exist() {
        fn link(alias: &Path, target: &Path) {
            let result = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(alias)
                .arg(target)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "cannot create test directory junction: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        let root = scratch_dir("native-junction-generation");
        let first = root.join("version-a");
        let second = root.join("version-b");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(first.join("content.kspkg"), b"first").unwrap();
        fs::write(second.join("content.kspkg"), b"second").unwrap();
        let alias = root.join("selected-game");
        link(&alias, &first);
        let source = alias.join("content.kspkg");
        let receipt = super::super::fresh::capture(std::slice::from_ref(&source)).unwrap();
        let mut track = super::super::tests::golden_track();
        track.game = "acevo".into();
        track.name = "Laguna Seca".into();
        track.variant = Some("GP".into());
        let directory = root.join(DIRECTORY);
        publish(&directory, &source, &track, stamp(&source).unwrap()).unwrap();
        assert!(load(&directory, "acevo", "Laguna Seca", Some("GP")).is_some());
        fs::remove_dir(&alias).unwrap();
        link(&alias, &second);
        assert!(first.join("content.kspkg").is_file(), "the old version still exists");
        assert_ne!(super::super::fresh::capture(std::slice::from_ref(&source)).unwrap(), receipt);
        assert!(load(&directory, "acevo", "Laguna Seca", Some("GP")).is_none());
        fs::remove_dir(alias).unwrap();
        cleanup(root);
    }

    #[test]
    #[ignore = "requires the verified installed EVO package; private cache only"]
    fn installed_package_builds_a_private_current_source_cache() {
        let out = scratch_dir("installed-evo-private");
        let dir = out.join(DIRECTORY);
        assert!(ensure_evo(&dir, &evo_roots(), "Laguna Seca", Some("GP")).unwrap());
        assert!(!ensure_evo(&dir, &evo_roots(), "Laguna Seca", Some("GP")).unwrap());
        let track = load(&dir, "acevo", "Laguna Seca", Some("GP")).unwrap();
        assert_eq!(track.centerline.x.len(), 2135);
        assert_eq!(track.pitlane.as_ref().unwrap().x.len(), 552);
        let layout = crate::maps::Layout::from_track(&track).unwrap();
        assert!(!layout.path.is_empty());
        assert!(track.closed);
        assert!(layout.road.is_some());
        assert!(load(&dir, "acevo", "Laguna Seca", None).is_none());
        assert!(!out.join(auto::TRACKS_DIR).exists());
        cleanup(out);
    }

    #[test]
    fn steam_build_and_extractor_generation_invalidate_the_cache() {
        let root = scratch_dir("native-generations");
        let steamapps = root.join("steamapps");
        let game = steamapps.join("common").join("Assetto Corsa EVO");
        fs::create_dir_all(&game).unwrap();
        let source = game.join("content.kspkg");
        fs::write(&source, b"same source bytes").unwrap();
        let manifest = steamapps.join("appmanifest_3058630.acf");
        fs::write(&manifest, format!("\"buildid\" \"{}\"\n", acevo::VERIFIED_BUILD)).unwrap();
        let mut track = super::super::tests::golden_track();
        track.game = "acevo".into();
        track.name = "Laguna Seca".into();
        track.variant = Some("GP".into());
        let directory = root.join(DIRECTORY);
        publish(&directory, &source, &track, stamp(&source).unwrap()).unwrap();
        assert!(load(&directory, "acevo", "Laguna Seca", Some("GP")).is_some());
        fs::write(&manifest, "\"buildid\" \"future-build\"\n").unwrap();
        assert!(load(&directory, "acevo", "Laguna Seca", Some("GP")).is_none());
        assert!(ensure_evo(&directory, std::slice::from_ref(&game), "Laguna Seca", Some("GP"))
            .unwrap_err()
            .contains("build changed"));
        fs::write(&manifest, format!("\"buildid\" \"{}\"\n", acevo::VERIFIED_BUILD)).unwrap();
        let (_, meta) = names(&directory, "acevo", "Laguna Seca", Some("GP"));
        let mut metadata: serde_json::Value = serde_json::from_slice(&fs::read(&meta).unwrap()).unwrap();
        metadata["extractorGeneration"] = serde_json::json!(EXTRACTOR_GENERATION + 1);
        fs::write(meta, serde_json::to_vec(&metadata).unwrap()).unwrap();
        assert!(load(&directory, "acevo", "Laguna Seca", Some("GP")).is_none());
        assert!(ensure_evo(&game.join("new-cache"), &[game], "Laguna Seca", Some("GP"))
            .unwrap_err()
            .contains("inside the installed game"));
        cleanup(root);
    }
}
