//! Source-generation receipts for automatically built AC/SCE layouts. A file
//! without a current receipt is not evidence that the installed layout matches.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

use super::{ac, auto, Track, MAX_UNPACKED};

const SCHEMA: u32 = 2;

/// Bump only the affected adapter when its extraction, identity or validation changes.
fn extractor_generation(game: &str) -> u32 {
    match game {
        "ac" => 3,
        "sce" => 2,
        _ => 0,
    }
}

fn source_limit(path: &Path) -> u64 {
    // The AC adapter supplies these two names directly under its selected
    // layout's ai directory. Every other dependency retains the smaller bound.
    if path
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name.eq_ignore_ascii_case("ai"))
        && path
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case(ac::SOURCE) || name.eq_ignore_ascii_case(ac::PIT_SOURCE))
    {
        ac::MAX_AI_FILE_BYTES
    } else {
        MAX_UNPACKED as u64
    }
}

fn source_digest(path: &Path, expected: &fs::Metadata) -> Result<String, String> {
    let limit = source_limit(path);
    if expected.len() > limit {
        return Err("native source dependency exceeds its input bound".into());
    }
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = (&mut file).take(limit + 1);
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 16384];
    let mut total = 0u64;
    // Hash the entire file, including bytes the AC geometry reader skips.
    loop {
        let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > limit {
            return Err("native source grew past its input bound".into());
        }
        hash.update(&buffer[..n]);
    }
    let after = file.metadata().map_err(|e| e.to_string())?;
    if total != expected.len() || after.len() != expected.len() || after.modified().ok() != expected.modified().ok() {
        return Err("native source changed while its generation was being checked".into());
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(super) fn read(path: &Path, max: usize) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path).ok()?.take(max as u64 + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() <= max).then_some(bytes)
}

fn receipt(path: &Path) -> PathBuf {
    path.with_extension("gz.source.json")
}

pub(super) fn capture(paths: &[PathBuf]) -> Result<serde_json::Value, String> {
    if paths.is_empty() || paths.len() > 8 {
        return Err("invalid native source dependency count".into());
    }
    let mut sources = Vec::new();
    for path in paths {
        let absolute = std::path::absolute(path).map_err(|e| e.to_string())?;
        let entry = match fs::metadata(path) {
            Ok(meta) if meta.is_file() => serde_json::json!({
                "path":fs::canonicalize(path).map_err(|e|e.to_string())?.to_string_lossy(),
                "requestedPath":absolute.to_string_lossy(),
                "bytes":meta.len(),
                "sha256":source_digest(path,&meta)?,
                "modifiedNanos":meta.modified().map_err(|e|e.to_string())?.duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos().to_string()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                serde_json::json!({"path":absolute.to_string_lossy(),"requestedPath":absolute.to_string_lossy(),"missing":true})
            }
            Ok(_) => return Err("native source dependency is not a regular file".into()),
            Err(e) => return Err(e.to_string()),
        };
        sources.push(entry);
    }
    Ok(serde_json::Value::Array(sources))
}

/// Published last: an interrupted export cannot attest a partial or older payload.
pub(super) fn attest(path: &Path, track: &Track, bytes: &[u8], generation: &serde_json::Value) -> Result<(), String> {
    let state = serde_json::json!({"schema":SCHEMA,"extractorGeneration":extractor_generation(&track.game),
        "identity":auto::track_key(&track.game,&track.name,track.variant.as_deref()),
        "sources":generation,"payloadSha256":format!("{:x}",Sha256::digest(bytes))});
    let target = receipt(path);
    let part = target.with_extension("json.part");
    let result = fs::write(&part, serde_json::to_vec(&state).map_err(|e| e.to_string())?).and_then(|()| fs::rename(&part, &target));
    if result.is_err() {
        let _ = fs::remove_file(part);
    }
    result.map_err(|e| e.to_string())
}

pub(super) fn load_current(path: &Path, identity: &str, sources: &serde_json::Value) -> Option<Track> {
    let state: serde_json::Value = serde_json::from_slice(&read(&receipt(path), 32 * 1024)?).ok()?;
    let (game, _) = identity.split_once('|')?;
    if state["schema"] != SCHEMA
        || state["extractorGeneration"] != extractor_generation(game)
        || state["identity"] != identity
        || &state["sources"] != sources
    {
        return None;
    }
    let bytes = read(path, MAX_UNPACKED)?;
    if state["payloadSha256"] != format!("{:x}", Sha256::digest(&bytes)) {
        return None;
    }
    let track = super::gunzip(&bytes, MAX_UNPACKED).ok()?;
    (identity == auto::track_key(&track.game, &track.name, track.variant.as_deref())).then_some(track)
}

#[cfg(test)]
pub(crate) fn load(path: &Path) -> Option<Track> {
    let state: serde_json::Value = serde_json::from_slice(&read(&receipt(path), 32 * 1024)?).ok()?;
    let sources = state["sources"].as_array()?;
    if sources.is_empty() || sources.len() > 8 {
        return None;
    }
    let paths: Option<Vec<_>> = sources.iter().map(|s| s["requestedPath"].as_str().map(PathBuf::from)).collect();
    load_current(path, state["identity"].as_str()?, &capture(&paths?).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Seek, SeekFrom, Write};

    #[test]
    fn only_the_ac_spline_dependencies_have_the_larger_streaming_bound() {
        for name in ["ai/fast_lane.ai", "ai/pit_lane.ai"] {
            assert_eq!(source_limit(Path::new(name)), ac::MAX_AI_FILE_BYTES);
        }
        for name in [
            "track.xtrk.gz",
            "track.AIW",
            "track.gdb",
            "layout/data/map.ini",
            "ui/ui_track.json",
            "fast_lane.ai",
        ] {
            assert_eq!(source_limit(Path::new(name)), MAX_UNPACKED as u64);
        }
    }

    #[test]
    fn a_same_size_edit_in_the_unused_ai_suffix_retires_the_receipt() {
        let root = crate::config::scratch_dir("native-ai-tail-receipt");
        let ai_dir = root.join("ai");
        fs::create_dir_all(&ai_dir).unwrap();
        let path = ai_dir.join(ac::SOURCE);
        let input = ac::tests::synthetic(600, 100.0, std::f64::consts::TAU, 5.0, 5.0);
        fs::write(&path, &input).unwrap();
        let layout = ac::Layout {
            dir: root.clone(),
            track: "circle".into(),
            variant: None,
            ai_dir,
        };
        let deps = ac::dependencies(&layout);
        let track = ac::extract(&layout).unwrap().track;
        let payload = super::super::gzip(&track).unwrap();
        let out = root.join("circle.xtrk.gz");
        fs::write(&out, &payload).unwrap();
        let before = capture(&deps).unwrap();
        assert_eq!(before[0]["sha256"], format!("{:x}", Sha256::digest(&input)));
        attest(&out, &track, &payload, &before).unwrap();
        assert!(load(&out).is_some());

        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let mut file = fs::File::options().write(true).open(&path).unwrap();
        file.seek(SeekFrom::End(-1)).unwrap();
        file.write_all(&[42]).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
        drop(file);
        let after = capture(&deps).unwrap();
        assert_eq!(before[0]["bytes"], after[0]["bytes"]);
        assert_eq!(before[0]["modifiedNanos"], after[0]["modifiedNanos"]);
        assert_ne!(before[0]["sha256"], after[0]["sha256"]);
        assert_eq!(super::super::gzip(&ac::extract(&layout).unwrap().track).unwrap(), payload);
        assert!(load(&out).is_none());
    }

    #[test]
    fn absent_receipt_changed_sources_and_new_optional_files_refuse_old_geometry() {
        let root = crate::config::scratch_dir("native-source-receipt");
        let source = root.join("fast_lane.ai");
        let optional = root.join("pit_lane.ai");
        fs::write(&source, b"old").unwrap();
        let paths = vec![source.clone(), optional.clone()];
        let track = super::super::tests::golden_track();
        let bytes = super::super::gzip(&track).unwrap();
        let out = root.join("track.xtrk.gz");
        fs::write(&out, &bytes).unwrap();
        assert!(load(&out).is_none());
        let before = capture(&paths).unwrap();
        attest(&out, &track, &bytes, &before).unwrap();
        assert!(load(&out).is_some());
        // Archives/mod managers can retain timestamps and sizes. Content hashes
        // still invalidate a same-sized replacement rather than reusing its road.
        let modified = fs::metadata(&source).unwrap().modified().unwrap();
        fs::write(&source, b"NEW").unwrap();
        fs::File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert!(load(&out).is_none());
        fs::write(&source, b"old").unwrap();
        fs::File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert!(load(&out).is_some());
        fs::write(&optional, b"new pit lane").unwrap();
        assert!(load(&out).is_none());
        fs::remove_file(optional).unwrap();
        fs::write(source, b"changed source generation").unwrap();
        assert!(load(&out).is_none());
    }

    #[test]
    fn only_extractor_generation_can_retire_an_otherwise_current_receipt() {
        let root = crate::config::scratch_dir("native-extractor-generation");
        let source = root.join("fast_lane.ai");
        fs::write(&source, b"test source").unwrap();
        let track = super::super::tests::golden_track();
        let bytes = super::super::gzip(&track).unwrap();
        let out = root.join("track.xtrk.gz");
        fs::write(&out, &bytes).unwrap();
        attest(&out, &track, &bytes, &capture(&[source]).unwrap()).unwrap();
        let receipt_file = receipt(&out);
        let mut metadata: serde_json::Value = serde_json::from_slice(&fs::read(&receipt_file).unwrap()).unwrap();
        assert!(metadata.get("extractorVersion").is_none());
        metadata["extractorVersion"] = serde_json::json!("arbitrary unrelated package version");
        fs::write(&receipt_file, serde_json::to_vec(&metadata).unwrap()).unwrap();
        assert!(load(&out).is_some());
        metadata["extractorGeneration"] = serde_json::json!(extractor_generation("ac") + 1);
        fs::write(&receipt_file, serde_json::to_vec(&metadata).unwrap()).unwrap();
        assert!(load(&out).is_none());
    }
}
