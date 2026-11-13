//! Gives `xpeed-sim.exe` its icon and version info (a compiled resource, linked in) and stamps the build.
//! No crate is needed: the icon is drawn by `src/icon.rs` (the real Xpeed mark), the resource script is written by
//! `src/rcgen.rs`, and Windows' own `rc.exe` compiles it. When `rc.exe` is not there the program still builds, without
//! the resources.

#[path = "src/icon.rs"]
#[allow(dead_code)]
mod icon;
#[path = "src/rcgen.rs"]
#[allow(dead_code)]
mod rcgen;

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/icon.rs");
    println!("cargo:rerun-if-changed=src/rcgen.rs");
    println!("cargo:rerun-if-changed=Cargo.toml");

    stamp_build();

    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("windows") && target.contains("msvc") {
        embed_resources();
    }
}

/// `XPEED_BUILD`: the short hash of HEAD, `-dirty` when the tree has changes, `unknown` without git.
fn stamp_build() {
    let git = |args: &[&str]| -> Option<String> {
        let out = Command::new("git").args(args).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    };
    let build = match git(&["rev-parse", "--short", "HEAD"]) {
        Some(hash) if !hash.is_empty() => {
            let dirty = git(&["status", "--porcelain"]).is_some_and(|s| !s.is_empty());
            if dirty {
                format!("{hash}-dirty")
            } else {
                hash
            }
        }
        _ => "unknown".to_owned(),
    };
    println!("cargo:rustc-env=XPEED_BUILD={build}");
    // Refresh per commit: HEAD itself and the branch file it points at (in a worktree these live elsewhere).
    if let Some(head) = git(&["rev-parse", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={head}");
        if let Ok(text) = std::fs::read_to_string(&head) {
            if let Some(reference) = text.trim().strip_prefix("ref: ") {
                if let Some(path) = git(&["rev-parse", "--git-path", reference]) {
                    println!("cargo:rerun-if-changed={path}");
                }
            }
        }
    }
}

fn embed_resources() {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into());

    let ico = out_dir.join("xpeed.ico");
    if let Err(e) = std::fs::write(&ico, icon::ico_file(&[16, 24, 32, 48, 64, 256], None)) {
        println!("cargo:warning=xpeed-sim: could not write the icon ({e}); building without resources");
        return;
    }
    let rc = out_dir.join("app.rc");
    if let Err(e) = std::fs::write(&rc, rcgen::resource_script(&version, &ico.display().to_string())) {
        println!("cargo:warning=xpeed-sim: could not write app.rc ({e}); building without resources");
        return;
    }
    let Some(rc_exe) = find_rc() else {
        println!("cargo:warning=xpeed-sim: rc.exe was not found (set RC, or install the Windows SDK); building without the icon and version info");
        return;
    };
    let res = out_dir.join("app.res");
    let status = Command::new(&rc_exe)
        .arg("/nologo")
        .arg(format!("/fo{}", res.display()))
        .arg(&rc)
        .status();
    match status {
        Ok(s) if s.success() && res.exists() => {
            println!("cargo:rustc-link-arg-bins={}", res.display());
        }
        other => println!("cargo:warning=xpeed-sim: rc.exe failed ({other:?}); building without the icon and version info"),
    }
}

/// `RC` from the environment, then `rc.exe` on PATH, then the newest Windows SDK.
fn find_rc() -> Option<PathBuf> {
    if let Some(rc) = std::env::var_os("RC").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(rc);
    }
    if let Some(path) = std::env::var_os("PATH") {
        if let Some(found) = std::env::split_paths(&path).map(|d| d.join("rc.exe")).find(|p| p.is_file()) {
            return Some(found);
        }
    }
    for root in ["ProgramFiles(x86)", "ProgramFiles"] {
        let Some(base) = std::env::var_os(root) else { continue };
        if let Some(found) = newest_sdk_rc(&Path::new(&base).join("Windows Kits").join("10").join("bin")) {
            return Some(found);
        }
    }
    None
}

fn newest_sdk_rc(bin: &Path) -> Option<PathBuf> {
    let mut versions: Vec<(Vec<u32>, PathBuf)> = std::fs::read_dir(bin)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let parts: Vec<u32> = name.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
            let rc = entry.path().join("x64").join("rc.exe");
            rc.is_file().then_some((parts, rc))
        })
        .collect();
    versions.sort();
    versions.pop().map(|(_, rc)| rc)
}
