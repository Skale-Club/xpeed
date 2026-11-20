//! `xpeed-companion track-dump <game> <track-or-path> <out.xtrk> [--preview FILE.svg]`: reads a track from a game's own files,
//! prints what it found and what was checked, and writes the track file (and, when asked, a picture of it).
//!
//! Only reads the game's folders. The files stay on this computer.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;

use super::*;

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub game: String,
    pub source: String,
    pub out: PathBuf,
    pub preview: Option<PathBuf>,
}

/// The Steam library folders of this computer (where games are installed), from Steam's own list.
pub fn steam_libraries() -> Vec<PathBuf> {
    let mut roots: Vec<_> = crate::installed::steam_path().into_iter().collect();
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(base) = std::env::var_os(var) {
            roots.push(PathBuf::from(base).join("Steam"));
        }
    }
    let mut libraries = Vec::new();
    for root in roots {
        if libraries.contains(&root) {
            continue;
        }
        let folders = steam_text(&root.join("steamapps").join("libraryfolders.vdf"), 2 * 1024 * 1024);
        libraries.push(root);
        if let Some(text) = folders {
            for path in vdf_paths(&text) {
                if !libraries.contains(&path) {
                    libraries.push(path);
                }
            }
        }
    }
    libraries
}

fn steam_text(file: &Path, limit: u64) -> Option<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(file).ok()?.take(limit + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= limit).then(|| String::from_utf8(bytes).ok()).flatten()
}

/// The `"path"  "F:\\SteamLibrary"` values of Steam's `libraryfolders.vdf`.
pub fn vdf_paths(text: &str) -> Vec<PathBuf> {
    text.lines()
        .filter_map(|line| {
            let mut quoted = line.split('"').skip(1).step_by(2);
            (quoted.next()? == "path").then(|| quoted.next().map(|p| PathBuf::from(p.replace("\\\\", "\\"))))?
        })
        .collect()
}

fn manifest_install_dir(text: &str) -> Option<&str> {
    let folder = text.lines().find_map(|line| {
        let mut fields = line.split('"').skip(1).step_by(2);
        fields.next()?.eq_ignore_ascii_case("installdir").then(|| fields.next()).flatten()
    })?;
    let mut components = Path::new(folder).components();
    (matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !folder.contains(['/', '\\', ':', '<', '>', '|', '?', '*'])
        && !folder.ends_with(['.', ' '])
        && !folder.chars().any(char::is_control))
    .then_some(folder)
}

/// Explicit game root first, then Steam's install directory for the title in each library.
pub(crate) fn game_folders(env: &str, app_id: u32, folder: &str, below: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut fallback = Vec::new();
    if let Some(dir) = std::env::var_os(env).filter(|dir| !dir.is_empty()) {
        out.push(PathBuf::from(dir).join(below));
    }
    for library in steam_libraries() {
        let steamapps = library.join("steamapps");
        let manifest = steam_text(&steamapps.join(format!("appmanifest_{app_id}.acf")), 64 * 1024);
        let installed = manifest.as_deref().and_then(manifest_install_dir);
        let path = steamapps.join("common").join(installed.unwrap_or(folder)).join(below);
        if installed.is_none() {
            fallback.push(path);
        } else if !out.contains(&path) {
            out.push(path);
        }
    }
    for path in fallback {
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

fn has_ai(dir: &Path) -> bool {
    dir.join("ai").join(ac::SOURCE).is_file()
}

/// A folder given by hand: the `ai` folder itself, a layout, or a track with a single layout.
pub(crate) fn ac_from_dir(dir: &Path) -> Result<ac::Layout, String> {
    let bad = || format!("{} does not look like an Assetto Corsa track folder", dir.display());
    if dir.join(ac::SOURCE).is_file() {
        return ac::layout_of_ai_dir(dir).ok_or_else(bad);
    }
    if has_ai(dir) {
        return ac::layout_of_ai_dir(&dir.join("ai")).ok_or_else(bad);
    }
    let mut layouts: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|_| bad())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && has_ai(p))
        .collect();
    layouts.sort();
    match layouts.as_slice() {
        [] => Err(bad()),
        [only] => ac::layout_of_ai_dir(&only.join("ai")).ok_or_else(bad),
        many => Err(format!(
            "{} has {} layouts; name one: {}",
            dir.display(),
            many.len(),
            many.iter()
                .map(|p| p.file_name().unwrap_or_default().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

pub fn resolve_ac(spec: &str) -> Result<ac::Layout, String> {
    let path = Path::new(spec);
    if path.is_file() {
        return ac_from_dir(path.parent().unwrap_or(Path::new(".")));
    }
    if path.is_dir() {
        return ac_from_dir(path);
    }
    let relative = spec.replace('\\', "/");
    let roots = game_folders("XPEED_AC_DIR", 244_210, "assettocorsa", "content/tracks");
    for root in &roots {
        let dir = root.join(&relative);
        if dir.is_dir() {
            return ac_from_dir(&dir);
        }
    }
    Err(format!(
        "no Assetto Corsa track {spec:?}: it is not a folder, and not under {}; give the path of the track folder, or set XPEED_AC_DIR to the game's folder",
        roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>().join(" or ")
    ))
}

/// The one `.AIW` file of a list, or why there is not exactly one.
pub(crate) fn pick_aiw(files: Vec<PathBuf>, what: &str) -> Result<PathBuf, String> {
    match files.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err(format!("no .AIW file for {what}")),
        many => Err(format!(
            "{} has several .AIW files; name one: {}",
            what,
            many.iter()
                .map(|p| p.file_stem().unwrap_or_default().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// The `.AIW` files under a game's `GameData/Locations` that a name stands for: the file's own name without the
/// extension (`InterlagosGP`), or `<place>/<name>`, in any case.
pub(crate) fn sce_named(root: &Path, spec: &str) -> Vec<PathBuf> {
    let wanted = spec.replace('\\', "/").to_lowercase();
    aiw::list(root)
        .into_iter()
        .filter(|p| {
            let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_lowercase();
            let place = p
                .parent()
                .and_then(|t| t.parent())
                .and_then(|t| t.file_name())
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            stem == wanted || format!("{place}/{stem}") == wanted
        })
        .collect()
}

pub fn resolve_sce(spec: &str) -> Result<PathBuf, String> {
    let path = Path::new(spec);
    if path.is_file() {
        return Ok(path.to_path_buf());
    }
    if path.is_dir() {
        let direct: Vec<PathBuf> = std::fs::read_dir(path)
            .map(|d| {
                d.flatten()
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("aiw")))
                    .collect()
            })
            .unwrap_or_default();
        if !direct.is_empty() {
            return pick_aiw(direct, &path.display().to_string());
        }
        return pick_aiw(aiw::list(path), &path.display().to_string());
    }
    let roots = game_folders("XPEED_SCE_DIR", 273_840, "Stock Car Extreme", "GameData/Locations");
    for root in &roots {
        let found = sce_named(root, spec);
        if !found.is_empty() {
            return pick_aiw(found, spec);
        }
    }
    Err(format!(
        "no Stock Car Extreme track {spec:?}: it is not a file or folder, and not under {}; give the path of the .AIW file, or set XPEED_SCE_DIR to the game's folder",
        roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>().join(" or ")
    ))
}

/// The folder whose files were read: nothing may be written into it.
pub(crate) fn inside(out: &Path, folder: &Path) -> bool {
    fn target(path: &Path) -> std::io::Result<PathBuf> {
        match std::fs::canonicalize(path) {
            Ok(path) => Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let absolute = std::path::absolute(path)?;
                let parent = absolute.parent().ok_or(error)?;
                let name = absolute
                    .file_name()
                    .ok_or_else(|| std::io::Error::other("unresolved output path"))?;
                Ok(target(parent)?.join(name))
            }
            Err(error) => Err(error),
        }
    }
    match (target(out), target(folder)) {
        (Ok(out), Ok(folder)) => out.starts_with(folder),
        _ => true, // An unresolved alias is not permission to write into a game.
    }
}

/// The track as it is stored and sent (gzip), once it reads back as the same bytes: the same check the readers of the
/// file will do.
pub(crate) fn gzip_checked(track: &Track) -> Result<Vec<u8>, String> {
    let bytes = gzip(track).map_err(|why| why.to_string())?;
    match gunzip(&bytes, MAX_UNPACKED)
        .and_then(|back| pack(&back))
        .and_then(|again| pack(track).map(|first| again == first))
    {
        Ok(true) => Ok(bytes),
        Ok(false) => Err("the file does not read back as the same track".to_owned()),
        Err(why) => Err(format!("the file does not read back: {why}")),
    }
}

pub fn run(request: &Request) -> ExitCode {
    let fail = |message: String| {
        eprintln!("{message}");
        ExitCode::from(1)
    };
    let (extracted, read_from) = match request.game.as_str() {
        "ac" => {
            let layout = match resolve_ac(&request.source) {
                Ok(layout) => layout,
                Err(why) => return fail(why),
            };
            println!(
                "Assetto Corsa: track {} layout {} ({})",
                layout.track,
                layout.variant.as_deref().unwrap_or("-"),
                layout.ai_dir.display()
            );
            (ac::extract(&layout), layout.dir)
        }
        "acevo" | "acevo-asphalt" => {
            let file = PathBuf::from(&request.source);
            let folder = if file.is_dir() {
                file.clone()
            } else {
                file.parent().unwrap_or(Path::new(".")).to_path_buf()
            };
            println!("Assetto Corsa EVO offline Laguna Seca pilot: {}", file.display());
            let extracted = if request.game == "acevo-asphalt" {
                let package = if file.is_dir() { file.join("content.kspkg") } else { file };
                acevo::extract_package_asphalt(&package)
            } else {
                acevo::extract(&file)
            };
            (extracted, folder)
        }
        "lmu-aiw" => {
            let file = PathBuf::from(&request.source);
            let folder = file.parent().unwrap_or(Path::new(".")).to_path_buf();
            (lmu_aiw::extract(&file), folder)
        }
        "f125-spline" => {
            let file=PathBuf::from(&request.source);
            let folder=file.parent().unwrap_or(Path::new(".")).to_path_buf();
            (f125_spline::extract(&file),folder)
        }
        "sce" | "rf1" | "rfactor1" => {
            let file = match resolve_sce(&request.source) {
                Ok(file) => file,
                Err(why) => return fail(why),
            };
            println!("Stock Car Extreme: {}", file.display());
            let folder = file.parent().unwrap_or(Path::new(".")).to_path_buf();
            (aiw::extract(&file), folder)
        }
        other => {
            return fail(format!(
                "unknown game {other:?}; track files can be made for: ac, sce, acevo, acevo-asphalt, lmu-aiw, f125-spline (offline source adapters)"
            ))
        }
    };
    if inside(&request.out, &read_from) || request.preview.as_deref().is_some_and(|p| inside(p, &read_from)) {
        return fail(format!(
            "refusing to write inside the game's folder {}: choose another place for the output",
            read_from.display()
        ));
    }
    let found = match extracted {
        Ok(found) => found,
        Err(refusal) => return fail(format!("Not written. This track was refused: {refusal}")),
    };
    for note in &found.report.notes {
        println!("  checked   {note}");
    }
    for warning in &found.report.warnings {
        println!("  warning   {warning}");
    }
    println!();
    print!("{}", found.track.summary());

    let bytes = match gzip_checked(&found.track) {
        Ok(bytes) => bytes,
        Err(why) => return fail(format!("Not written: {why}")),
    };
    if let Err(error) = std::fs::write(&request.out, &bytes) {
        return fail(format!("Cannot write {}: {error}", request.out.display()));
    }
    println!("Wrote {} ({} bytes)", request.out.display(), bytes.len());
    if let Some(preview) = &request.preview {
        if let Err(error) = std::fs::write(preview, preview::svg(&found.track)) {
            return fail(format!("Cannot write {}: {error}", preview.display()));
        }
        println!("Wrote {}", preview.display());
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("xpeed-track-dump-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_steam_library_paths() {
        let text = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t\t\"label\"\t\t\"\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"F:\\\\SteamLibrary\"\n\t}\n}\n";
        assert_eq!(
            vdf_paths(text),
            vec![PathBuf::from("C:\\Program Files (x86)\\Steam"), PathBuf::from("F:\\SteamLibrary")]
        );
        assert!(vdf_paths("nothing here").is_empty());
    }

    #[test]
    fn parses_custom_steam_install_folder_and_refuses_non_leaf_paths() {
        let manifest = |folder| format!("\"AppState\"\n{{\n  \"installdir\" \"{folder}\"\n}}");
        assert_eq!(manifest_install_dir(&manifest("AC Custom Install")), Some("AC Custom Install"));
        for path in ["../outside", "X:\\outside", "a/b", "..", "alias.", "alias ", ""] {
            assert_eq!(manifest_install_dir(&manifest(path)), None, "{path:?}");
        }
    }

    #[test]
    fn dumps_an_ac_layout_from_a_folder_and_writes_a_track_and_a_picture() {
        let root = temp("ac");
        let ai = root.join("circle").join("ai");
        std::fs::create_dir_all(&ai).unwrap();
        std::fs::create_dir_all(root.join("circle").join("ui")).unwrap();
        std::fs::write(
            ai.join("fast_lane.ai"),
            ac::tests::synthetic(600, 100.0, std::f64::consts::TAU, 9.0, 3.0),
        )
        .unwrap();
        std::fs::write(ai.join("pit_lane.ai"), ac::tests::synthetic(40, 105.0, 0.3, 3.0, 3.0)).unwrap();
        let out = root.join("out").join("circle.xtrk");
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        let svg = root.join("out").join("circle.svg");
        let request = Request {
            game: "ac".into(),
            source: root.join("circle").display().to_string(),
            out: out.clone(),
            preview: Some(svg.clone()),
        };
        assert_eq!(run(&request), ExitCode::SUCCESS);
        let track = gunzip(&std::fs::read(&out).unwrap(), MAX_UNPACKED).unwrap();
        assert_eq!((track.game.as_str(), track.name.as_str()), ("ac", "circle"));
        assert!(track.closed && track.pitlane.is_some());
        assert!(std::fs::read_to_string(&svg).unwrap().starts_with("<svg"));
        // The same through the ai folder and through the file.
        for source in [ai.clone(), ai.join("fast_lane.ai")] {
            let again = Request {
                source: source.display().to_string(),
                preview: None,
                ..request.clone()
            };
            assert_eq!(run(&again), ExitCode::SUCCESS);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_to_write_inside_the_game_folder_and_unknown_games_and_missing_tracks() {
        let root = temp("refuse");
        let ai = root.join("circle").join("ai");
        std::fs::create_dir_all(&ai).unwrap();
        std::fs::write(
            ai.join("fast_lane.ai"),
            ac::tests::synthetic(600, 100.0, std::f64::consts::TAU, 9.0, 3.0),
        )
        .unwrap();
        let inside_game = Request {
            game: "ac".into(),
            source: root.join("circle").display().to_string(),
            out: root.join("circle").join("x.xtrk"),
            preview: None,
        };
        assert_eq!(run(&inside_game), ExitCode::from(1));
        assert!(!root.join("circle").join("x.xtrk").exists());
        assert_eq!(
            run(&Request {
                game: "lmu".into(),
                ..inside_game.clone()
            }),
            ExitCode::from(1)
        );
        assert_eq!(
            run(&Request {
                source: "no-such-track-xyz".into(),
                ..inside_game.clone()
            }),
            ExitCode::from(1)
        );
        // A damaged file is refused and nothing is written.
        std::fs::write(ai.join("fast_lane.ai"), [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).unwrap();
        let out = root.join("o.xtrk");
        assert_eq!(
            run(&Request {
                out: out.clone(),
                ..inside_game.clone()
            }),
            ExitCode::from(1)
        );
        assert!(!out.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn names_the_layouts_when_a_track_has_several() {
        let root = temp("layouts");
        for layout in ["gp", "short"] {
            let ai = root.join("track").join(layout).join("ai");
            std::fs::create_dir_all(&ai).unwrap();
            std::fs::write(ai.join("fast_lane.ai"), b"x").unwrap();
        }
        let why = ac_from_dir(&root.join("track")).unwrap_err();
        assert!(why.contains("2 layouts") && why.contains("gp, short"), "{why}");
        assert!(ac_from_dir(&root.join("track").join("gp")).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dumps_a_stock_car_extreme_track_from_an_aiw_file() {
        let root = temp("sce");
        let folder = root.join("Place").join("Circle");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("Circle.AIW"), aiw::tests::synthetic(300, 4.0, 10.0, -2.0, true)).unwrap();
        std::fs::write(folder.join("Circle.gdb"), "{\n  TrackName = Circle Park\n}\n").unwrap();
        let out = root.join("circle.xtrk");
        for source in [folder.join("Circle.AIW"), folder.clone(), root.join("Place")] {
            let request = Request {
                game: "sce".into(),
                source: source.display().to_string(),
                out: out.clone(),
                preview: None,
            };
            assert_eq!(run(&request), ExitCode::SUCCESS, "{}", source.display());
        }
        let track = gunzip(&std::fs::read(&out).unwrap(), MAX_UNPACKED).unwrap();
        assert_eq!(
            (track.game.as_str(), track.name.as_str(), track.title.as_deref()),
            ("sce", "Circle", Some("Circle Park"))
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
