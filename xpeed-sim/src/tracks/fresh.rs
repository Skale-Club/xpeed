//! Source-generation receipts for automatically built AC/SCE layouts. A file
//! without a current receipt is not evidence that the installed layout matches.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

use super::{auto, Track, MAX_UNPACKED};

fn source_digest(path: &Path, expected: &fs::Metadata) -> Result<String, String> {
    if expected.len() > MAX_UNPACKED as u64 {
        return Err("native source dependency exceeds its input bound".into());
    }
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 16384];
    let mut total = 0usize;
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total += n;
        if total > MAX_UNPACKED {
            return Err("native source grew past its input bound".into());
        }
        hash.update(&buffer[..n]);
    }
    let after = file.metadata().map_err(|e| e.to_string())?;
    if total as u64 != expected.len() || after.len() != expected.len() || after.modified().ok() != expected.modified().ok() {
        return Err("native source changed while its generation was being checked".into());
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn read(path: &Path, max: usize) -> Option<Vec<u8>> {
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

/// Published last: an interrupted export or game update cannot attest old data.
pub(super) fn attest(path: &Path, track: &Track, bytes: &[u8], paths: &[PathBuf], before: &serde_json::Value) -> Result<(), String> {
    if &capture(paths)? != before {
        return Err("native game files changed during extraction; retry after the update".into());
    }
    let state = serde_json::json!({"schema":1,"extractorVersion":env!("CARGO_PKG_VERSION"),
        "identity":auto::track_key(&track.game,&track.name,track.variant.as_deref()),
        "sources":before,"payloadSha256":format!("{:x}",Sha256::digest(bytes))});
    let target = receipt(path);
    let part = target.with_extension("json.part");
    fs::write(&part, serde_json::to_vec(&state).map_err(|e| e.to_string())?)
        .and_then(|()| fs::rename(&part, &target))
        .map_err(|e| e.to_string())
}

pub(crate) fn load(path: &Path) -> Option<Track> {
    let state: serde_json::Value = serde_json::from_slice(&read(&receipt(path), 32 * 1024)?).ok()?;
    if state["schema"] != 1 || state["extractorVersion"] != env!("CARGO_PKG_VERSION") {
        return None;
    }
    let sources = state["sources"].as_array()?;
    if sources.is_empty() || sources.len() > 8 {
        return None;
    }
    let paths: Option<Vec<_>> = sources.iter().map(|s| s["requestedPath"].as_str().map(PathBuf::from)).collect();
    if capture(&paths?).ok()? != state["sources"] {
        return None;
    }
    let bytes = read(path, MAX_UNPACKED)?;
    if state["payloadSha256"] != format!("{:x}", Sha256::digest(&bytes)) {
        return None;
    }
    let track = super::gunzip(&bytes, MAX_UNPACKED).ok()?;
    (state["identity"] == auto::track_key(&track.game, &track.name, track.variant.as_deref())).then_some(track)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        attest(&out, &track, &bytes, &paths, &before).unwrap();
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
        assert!(attest(&out, &track, &bytes, &paths, &before).is_err());
        fs::remove_file(optional).unwrap();
        fs::write(source, b"changed source generation").unwrap();
        assert!(load(&out).is_none());
    }
}
