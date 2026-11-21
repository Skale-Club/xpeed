//! Gives `xpeed-companion.exe` its icon and version info (a compiled resource, linked in) and stamps the build.
//! No crate is needed: the icon is drawn by `src/icon.rs` (the real Xpeed mark), the resource script is written by
//! `src/rcgen.rs`, and Windows' own `rc.exe` compiles it. When `rc.exe` is not there the program still builds, without
//! the resources.
//!
//! It also brings in what the panel shares with the website, so a change on the site shows in the Companion at its next build
//! (`site_design`): the site's colours from `src/index.css` and its Virtual menu from `shared/design/nav.json`, named in the
//! site's own words (`src/locales/*.json`).

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
    site_design();

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
        println!("cargo:warning=xpeed-companion: could not write the icon ({e}); building without resources");
        return;
    }
    let manifest = out_dir.join("app.manifest");
    if let Err(e) = std::fs::write(&manifest, rcgen::MANIFEST) {
        println!("cargo:warning=xpeed-companion: could not write the manifest ({e}); building without resources");
        return;
    }
    let rc = out_dir.join("app.rc");
    let script = rcgen::resource_script(&version, &ico.display().to_string(), &manifest.display().to_string());
    if let Err(e) = std::fs::write(&rc, script) {
        println!("cargo:warning=xpeed-companion: could not write app.rc ({e}); building without resources");
        return;
    }
    let Some(rc_exe) = find_rc() else {
        println!("cargo:warning=xpeed-companion: rc.exe was not found (set RC, or install the Windows SDK); building without the icon and version info");
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
        other => println!("cargo:warning=xpeed-companion: rc.exe failed ({other:?}); building without the icon and version info"),
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

/// Writes `site_design.rs` into `OUT_DIR` for `panel::tokens` and `panel::nav`: every HSL colour of the site's `:root`
/// (`src/index.css`) as a GDI colour, and the Virtual menu of `shared/design/nav.json` with each place's name in English,
/// Portuguese and Spanish. A menu entry whose name the site does not have stops the build: the two would not match.
fn site_design() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let css_path = root.join("src/index.css");
    let nav_path = root.join("shared/design/nav.json");
    let locales = ["en.json", "pt-BR.json", "es-ES.json"].map(|f| root.join("src/locales").join(f));
    for path in [&css_path, &nav_path].into_iter().chain(locales.iter()) {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let read = |path: &Path| std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));

    let mut out = String::from("// Made by build.rs from src/index.css and shared/design/nav.json; do not edit.\n\n");
    for (name, color) in site_colours(&read(&css_path)) {
        out.push_str(&format!("pub const {name}: u32 = 0x{color:06x};\n"));
    }

    let nav: serde_json::Value = serde_json::from_str(&read(&nav_path)).expect("shared/design/nav.json is JSON");
    let words: Vec<serde_json::Value> = locales
        .iter()
        .map(|p| serde_json::from_str(&read(p)).unwrap_or_else(|e| panic!("{}: {e}", p.display())))
        .collect();
    let label = |key: &str| -> [String; 3] {
        let find = |locale: &serde_json::Value| {
            key.split('.')
                .try_fold(locale, |at, k| at.get(k))
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        };
        let en = find(&words[0]).unwrap_or_else(|| panic!("src/locales/en.json has no {key} (a menu entry of shared/design/nav.json)"));
        [
            en.clone(),
            find(&words[1]).unwrap_or_else(|| en.clone()),
            find(&words[2]).unwrap_or(en),
        ]
    };
    let text = |v: &serde_json::Value, field: &str| {
        v[field]
            .as_str()
            .unwrap_or_else(|| panic!("nav.json: an entry has no {field}"))
            .to_owned()
    };

    out.push_str("\n/// The website's Virtual menu, in its order.\npub static WEB_PLACES: &[WebPlace] = &[\n");
    for entry in nav["virtual"].as_array().expect("nav.json: virtual is a list") {
        let [en, pt, es] = label(&text(entry, "i18nKey"));
        out.push_str(&format!(
            "    WebPlace {{ to: {:?}, group: {:?}, icon: {:?}, label: [{en:?}, {pt:?}, {es:?}] }},\n",
            text(entry, "to"),
            entry["group"].as_str().unwrap_or(""),
            text(entry, "icon"),
        ));
    }
    out.push_str("];\n\n/// The icons of the Companion's own screens, by screen id.\npub static SCREEN_ICONS: &[(&str, &str)] = &[\n");
    for entry in nav["companion"].as_array().expect("nav.json: companion is a list") {
        out.push_str(&format!("    ({:?}, {:?}),\n", text(entry, "id"), text(entry, "icon")));
    }
    out.push_str(&format!(
        "];\n\n/// The icon of Settings.\npub const SETTINGS_ICON: &str = {:?};\n",
        text(&nav["settings"], "icon")
    ));

    let dest = Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("site_design.rs");
    std::fs::write(dest, out).expect("write site_design.rs");
}

/// The `--name: H S% L%;` colours of the first `:root` block, as (`SITE_NAME`, `0x00BBGGRR`), rounded as browsers do.
fn site_colours(css: &str) -> Vec<(String, u32)> {
    let block = css.find(":root").map(|at| &css[at..]).expect("src/index.css has a :root block");
    let block = &block[..block.find('}').expect("the :root block ends")];
    let mut colours = Vec::new();
    for line in block.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("--") else { continue };
        let Some((name, value)) = rest.split_once(':') else { continue };
        let value = value.split(';').next().unwrap_or("").trim();
        let parts: Vec<&str> = value.split_whitespace().collect();
        let [h, s, l] = parts[..] else { continue };
        let (Ok(h), Some(Ok(s)), Some(Ok(l))) = (
            h.parse::<f64>(),
            s.strip_suffix('%').map(str::parse::<f64>),
            l.strip_suffix('%').map(str::parse::<f64>),
        ) else {
            continue;
        };
        let (r, g, b) = hsl(h, s / 100.0, l / 100.0);
        let name = format!("SITE_{}", name.trim().to_uppercase().replace('-', "_"));
        colours.push((name, u32::from(r) | u32::from(g) << 8 | u32::from(b) << 16));
    }
    colours
}

/// HSL (degrees, 0..1, 0..1) to 8-bit red, green and blue, as the CSS spec converts it.
fn hsl(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (h.rem_euclid(360.0)) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    let byte = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    (byte(r), byte(g), byte(b))
}
