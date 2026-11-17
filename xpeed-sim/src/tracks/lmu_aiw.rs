//! Offline LMU Laguna Seca AIW adapter. Source coordinates have NOT been aligned
//! with a live LMU recording. This is separate from SCE's AIW interpretation.
use super::aiw::{parse_aiw, Waypoint};
use super::*;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

pub const SOURCE: &str = "lmu_aiw";
pub const VERIFIED_SHA256: &str = "34e6fc0f21f982f33b579e16eac9079e44bba986a83edfb98a7b0aa009289c82";
pub const VERIFIED_BUILD: &str = "25661166";
pub const VERIFIED_COMPONENT: &str = "LagunaSeca_2026/1.05";
pub const SOURCE_FRAME: &str =
    "LMU AIW source world metres: raw x/z horizontal, y up; telemetry origin, axes and timing alignment unverified";
const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

fn distance(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.iter().zip(b).map(|(a, b)| (a - b).powi(2)).sum::<f64>().sqrt()
}
fn index(value: i64, count: usize) -> Option<usize> {
    usize::try_from(value).ok().filter(|&i| i < count)
}
fn main_cycle(wps: &[Waypoint]) -> Result<Vec<usize>, Refusal> {
    let main: Vec<_> = wps.iter().enumerate().filter(|(_, w)| w.branch == 0).map(|(i, _)| i).collect();
    if main.len() < 10 || main.iter().any(|&i| wps[i].bitfields & 1 != 0) {
        return refuse("lmu_main", "main branch needs at least ten unflagged path vertices");
    }
    for (i, w) in wps.iter().enumerate() {
        for ptr in [w.prev, w.next] {
            if ptr < -1 || ptr >= wps.len() as i64 {
                return refuse("lmu_pointer", format!("waypoint {i} has an out-of-range pointer"));
            }
        }
    }
    for &i in &main {
        let w = &wps[i];
        let (Some(prev), Some(next)) = (index(w.prev, wps.len()), index(w.next, wps.len())) else {
            return refuse("lmu_main_graph", "main path has an open endpoint");
        };
        if prev == i
            || next == i
            || wps[prev].branch != 0
            || wps[next].branch != 0
            || wps[prev].next != i as i64
            || wps[next].prev != i as i64
        {
            return refuse("lmu_main_graph", "main previous/next links must be reciprocal within branch zero");
        }
    }
    let start = *main
        .iter()
        .min_by(|&&a, &&b| {
            wps[a]
                .score
                .unwrap_or(f64::INFINITY)
                .total_cmp(&wps[b].score.unwrap_or(f64::INFINITY))
        })
        .unwrap();
    let mut seen = vec![false; wps.len()];
    let mut chain = Vec::with_capacity(main.len());
    let mut at = start;
    while !seen[at] {
        seen[at] = true;
        chain.push(at);
        at = wps[at].next as usize;
    }
    if at != start || chain.len() != main.len() {
        return refuse("lmu_main_graph", "branch zero is not exactly one closed cycle");
    }
    Ok(chain)
}

/// Only a unique branch-one chain joined to the main path is a pit candidate.
/// Detached branch-one extensions and all garage/stall branches are excluded.
fn pit(wps: &[Waypoint], main: &[usize], report: &mut Report) -> Option<Pitlane> {
    let starts: Vec<_> = wps
        .iter()
        .enumerate()
        .filter(|(_, w)| w.branch == 1 && w.bitfields & 1 == 0 && index(w.prev, wps.len()).is_some_and(|i| wps[i].branch == 0))
        .map(|(i, _)| i)
        .collect();
    let build = || -> Result<Vec<usize>, String> {
        if starts.len() != 1 {
            return Err("no unique main-connected branch-one entry".into());
        }
        let mut seen = vec![false; wps.len()];
        let mut chain = Vec::new();
        let mut at = starts[0];
        loop {
            if seen[at] || wps[at].branch != 1 || wps[at].bitfields & 1 != 0 {
                return Err("pit path loops or enters a non-path branch".into());
            }
            seen[at] = true;
            chain.push(at);
            let next = index(wps[at].next, wps.len()).ok_or("pit has no main-connected exit")?;
            if wps[next].branch == 0 {
                break;
            }
            if wps[next].branch != 1 || wps[next].prev != at as i64 {
                return Err("pit interior links are not reciprocal branch-one links".into());
            }
            at = next;
        }
        if chain.len() < 2 {
            return Err("pit has fewer than two points".into());
        }
        let length = chain.windows(2).map(|p| distance(wps[p[0]].pos, wps[p[1]].pos)).sum::<f64>();
        if !(20.0..=10_000.0).contains(&length) {
            return Err("pit length is outside the diagnostic bounds".into());
        }
        for &i in &chain {
            let nearest = main
                .iter()
                .map(|&j| (wps[i].pos[0] - wps[j].pos[0]).hypot(wps[i].pos[2] - wps[j].pos[2]))
                .fold(f64::INFINITY, f64::min);
            if nearest > 300.0 {
                return Err("pit is more than 300 m from the main reference path".into());
            }
        }
        Ok(chain)
    };
    match build() {
        Ok(chain) => {
            let omitted = wps.iter().filter(|w| w.branch == 1).count() - chain.len();
            report.notes.push(format!(
                "pit: {} main-connected branch-one points; {omitted} detached extensions excluded; no stalls joined",
                chain.len()
            ));
            report
                .warnings
                .push("pit widths unknown in XTRK: source banked cross-sections cannot be represented by its pit section".into());
            Some(Pitlane {
                x: chain.iter().map(|&i| wps[i].pos[0] as f32).collect(),
                z: chain.iter().map(|&i| wps[i].pos[2] as f32).collect(),
                left: vec![f32::NAN; chain.len()],
                right: vec![f32::NAN; chain.len()],
            })
        }
        Err(why) => {
            report.warnings.push(format!("pit omitted: {why}"));
            None
        }
    }
}

fn extract_text(text: &str) -> Result<Extracted, Refusal> {
    let aiw = parse_aiw(text)?;
    let wps = &aiw.waypoints;
    if aiw.number_waypoints != Some(wps.len()) {
        return refuse("lmu_count", "number_waypoints is missing or disagrees with the file");
    }
    let chain = main_cycle(wps)?;
    let n = chain.len();
    let lap = aiw
        .lap_length
        .filter(|v| (100.0..=MAX_LENGTH_M).contains(v))
        .ok_or_else(|| Refusal {
            code: "lmu_length",
            message: "missing or invalid lap_length".into(),
        })?;
    let mut dist = Vec::with_capacity(n);
    let mut total = 0.0;
    for (k, &i) in chain.iter().enumerate() {
        dist.push(total);
        let j = chain[(k + 1) % n];
        let segment = distance(wps[i].pos, wps[j].pos);
        if !(0.001..=MAX_CLOSE_GAP_M).contains(&segment) {
            return refuse("lmu_spacing", "main graph contains a duplicate or excessive segment");
        }
        total += segment;
    }
    if (total - lap).abs() > lap * 0.01 {
        return refuse(
            "lmu_length",
            "closed 3D source path disagrees with lap_length by more than one percent",
        );
    }
    let origin = wps[chain[0]]
        .score
        .filter(|s| s.is_finite() && *s >= 0.0 && *s <= lap)
        .ok_or_else(|| Refusal {
            code: "lmu_score",
            message: "main path has a missing or invalid source score".into(),
        })?;
    let mut worst = 0.0f64;
    for (k, &i) in chain.iter().enumerate() {
        let s = wps[i]
            .score
            .filter(|s| s.is_finite() && *s >= 0.0 && *s <= lap + 1.0)
            .ok_or_else(|| Refusal {
                code: "lmu_score",
                message: "main path has a missing or invalid source score".into(),
            })?;
        let d = (s - origin - dist[k]).rem_euclid(lap);
        worst = worst.max(d.min(lap - d));
    }
    if worst > 0.01 * lap + 2.0 {
        return refuse("lmu_score", "source score disagrees with cumulative path distance");
    }
    let rawx: Vec<_> = chain.iter().map(|&i| wps[i].pos[0] as f32).collect();
    let rawz: Vec<_> = chain.iter().map(|&i| wps[i].pos[2] as f32).collect();
    let normals = left_units(&rawx, &rawz, true);
    let mut axes = Vec::with_capacity(n);
    let mut agree = 0.0;
    let mut valid_axes = 0;
    for (k, &i) in chain.iter().enumerate() {
        let p = wps[i].perp;
        let norm = p.iter().map(|v| v * v).sum::<f64>().sqrt();
        let dot = (p[0] * normals[k].0 + p[2] * normals[k].1) / norm.max(1e-9);
        let valid = (0.9..=1.1).contains(&norm) && dot >= 0.8;
        axes.push(valid);
        valid_axes += usize::from(valid);
        agree += dot;
    }
    if valid_axes * 10 < n * 9 || agree / (n as f64) < 0.9 {
        return refuse("lmu_perp", "source perpendiculars do not establish the main path left side");
    }
    let mut c = Centerline::default();
    let mut edges = Boundaries {
        left_x: Vec::new(),
        left_z: Vec::new(),
        right_x: Vec::new(),
        right_z: Vec::new(),
    };
    let mut known = 0;
    for (k, &i) in chain.iter().enumerate() {
        let w = &wps[i];
        let (l, r) = (w.width[0], w.width[1]);
        let width_ok = l != 0.0
            && r != 0.0
            && l.abs() <= f64::from(MAX_SIDE_M)
            && r.abs() <= f64::from(MAX_SIDE_M)
            && (1.0..=2.0 * f64::from(MAX_SIDE_M)).contains(&(l + r));
        let mut pos = w.pos;
        let (row, half) = if axes[k] && width_ok {
            let shift = (l - r) / 2.0;
            for (j, p) in pos.iter_mut().enumerate() {
                *p += shift * w.perp[j];
            }
            known += 1;
            (
                [
                    (w.pos[0] + l * w.perp[0]) as f32,
                    (w.pos[2] + l * w.perp[2]) as f32,
                    (w.pos[0] - r * w.perp[0]) as f32,
                    (w.pos[2] - r * w.perp[2]) as f32,
                ],
                ((l + r) / 2.0) as f32,
            )
        } else {
            ([f32::NAN; 4], f32::NAN)
        };
        c.x.push(pos[0] as f32);
        c.y.push(pos[1] as f32);
        c.z.push(pos[2] as f32);
        c.dist.push(dist[k] as f32);
        c.left.push(half);
        c.right.push(half);
        edges.left_x.push(row[0]);
        edges.left_z.push(row[1]);
        edges.right_x.push(row[2]);
        edges.right_z.push(row[3]);
    }
    let mut report = Report::default();
    report.notes.push(format!(
        "LMU build {VERIFIED_BUILD}, component {VERIFIED_COMPONENT}, source SHA256 {VERIFIED_SHA256}"
    ));
    report.notes.push(format!("{n} reciprocal branch-zero vertices; closed 3D length {total:.6} m, declared {lap:.6}; source-score worst circular residual {worst:.6} m"));
    report.notes.push(format!(
        "{known}/{n} explicit signed source cross-sections; banked midpoint Y preserved; invalid rows remain gaps"
    ));
    report.warnings.push("Offline source geometry only: telemetry axes/origin and live alignment are unverified; source-score start is a chosen waypoint, not a proved timing line".into());
    report.warnings.push(
        "AIW road envelope, not surveyed asphalt/white lines; edge heights/banking are not represented by planar XTRK boundaries".into(),
    );
    report
        .warnings
        .push("No ideal line: LMU wp_pathinfo2 semantics are unverified; no SCE wp_path or synthetic racing line substituted".into());
    let pitlane = pit(wps, &chain, &mut report);
    let track = Track {
        game: "lmu".into(),
        name: "LagunaSeca".into(),
        variant: Some(VERIFIED_COMPONENT.into()),
        title: Some("Laguna Seca (LMU source, alignment unverified)".into()),
        length_m: Some(total),
        source: SOURCE.into(),
        frame: SOURCE_FRAME.into(),
        closed: true,
        center_kind: "edges_midpoint".into(),
        centerline: c,
        fast: None,
        pitlane,
        boundaries: Some(edges),
    };
    check(&track).map_err(|e| Refusal {
        code: "lmu_track",
        message: e.message,
    })?;
    Ok(Extracted { track, report })
}

fn read_pinned(reader: impl Read) -> Result<Vec<u8>, Refusal> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| Refusal {
            code: "io",
            message: e.to_string(),
        })?;
    if bytes.len() > MAX_FILE_BYTES {
        return refuse("lmu_too_large", "AIW exceeds 16 MiB");
    }
    if format!("{:x}", Sha256::digest(&bytes)) != VERIFIED_SHA256 {
        return refuse(
            "lmu_unverified_source",
            "AIW is not the verified LMU build/component source; do not remove the hash guard",
        );
    }
    Ok(bytes)
}

/// Extract only the exact verified local AIW. No package discovery, uploads,
/// coordinate fitting, game launch or telemetry-frame assertion occurs here.
pub fn extract(path: &Path) -> Result<Extracted, Refusal> {
    let file = std::fs::File::open(path).map_err(|e| Refusal {
        code: "io",
        message: format!("cannot open {}: {e}", path.display()),
    })?;
    if !file
        .metadata()
        .map_err(|e| Refusal {
            code: "io",
            message: e.to_string(),
        })?
        .is_file()
    {
        return refuse("lmu_file_type", "AIW must be a regular file");
    }
    let bytes = read_pinned(file)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| Refusal {
        code: "lmu_text",
        message: "verified AIW is not UTF-8".into(),
    })?;
    extract_text(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> String {
        let n = 128;
        let radius = 100.0;
        let step = std::f64::consts::TAU / n as f64;
        let chord = 2.0 * radius * (step / 2.0).sin();
        let mut s = format!("[Waypoint]\nnumber_waypoints={n}\nlap_length={}\n", chord * n as f64);
        for i in 0..n {
            let a = i as f64 * step;
            let (x, z) = (radius * a.cos(), radius * a.sin());
            let (l, r) = (4.0 + (i % 5) as f64, 6.0);
            s.push_str(&format!("wp_pos=({x},3,{z})\nwp_perp=({},{},{})\nwp_width=({l},{r},12,12)\nwp_score=(0,{})\nWP_PTRS=({},{},-1,0)\nwp_branchID=(0)\nwp_pathinfo2=(0,99,1,30)\n",a.cos(),0.0,a.sin(),i as f64*chord,(i+n-1)%n,(i+1)%n));
        }
        s
    }
    fn with_pit() -> String {
        let mut s = sample().replace("number_waypoints=128", "number_waypoints=135");
        for k in 0..6 {
            let i = 128 + k;
            let prev = if k == 0 { 0 } else { i - 1 };
            let next = if k == 5 { 8 } else { i + 1 };
            s.push_str(&format!(
                "wp_pos=(110,3,{})\nwp_perp=(1,0,0)\nwp_width=(4,4,8,8)\nWP_PTRS=({prev},{next},-1,1)\nwp_branchID=(1)\n",
                k * 5
            ));
        }
        // Detached branch-one extension, never a join to the main pit chain.
        s.push_str("wp_pos=(120,3,5)\nwp_perp=(1,0,0)\nwp_width=(4,4,8,8)\nWP_PTRS=(134,134,-1,1)\nwp_branchID=(1)\n");
        s
    }
    #[test]
    fn only_structurally_connected_nearby_branch_one_pit_and_unknown_widths() {
        let s = with_pit();
        let e = extract_text(&s).unwrap();
        let p = e.track.pitlane.unwrap();
        assert_eq!(p.x.len(), 6);
        assert!(p.left.iter().chain(&p.right).all(|v| v.is_nan()));
        assert!(e.report.notes.iter().any(|n| n.contains("1 detached extensions")));
        for bad in [
            s.replacen("WP_PTRS=(128,130,-1,1)", "WP_PTRS=(0,130,-1,1)", 1),
            s.replacen("wp_pos=(110,3,10)", "wp_pos=(5000,3,10)", 1),
            s.replacen("WP_PTRS=(132,8,-1,1)", "WP_PTRS=(132,128,-1,1)", 1),
            s.replace("wp_branchID=(1)", "wp_branchID=(2)"),
        ] {
            assert!(extract_text(&bad).unwrap().track.pitlane.is_none());
        }
    }
    #[test]
    fn source_identity_and_no_invented_ideal_line() {
        let e = extract_text(&sample()).unwrap();
        assert_eq!(e.track.game, "lmu");
        assert_eq!(e.track.source, SOURCE);
        assert_eq!(e.track.frame, SOURCE_FRAME);
        assert!(e.track.fast.is_none());
        assert!(e.track.pitlane.is_none());
        assert!(e.track.boundaries.is_some());
        assert!(e.report.warnings.iter().any(|s| s.contains("timing")));
        let bytes = pack(&e.track).unwrap();
        assert_eq!(u16::from_le_bytes(bytes[4..6].try_into().unwrap()), 2);
    }
    #[test]
    fn preserves_signed_offsets_variable_width_and_banked_midpoint() {
        let s = sample().replacen("wp_perp=(1,0,0)", "wp_perp=(0.98,0.198997487,0)", 1).replacen(
            "wp_width=(4,6,12,12)",
            "wp_width=(-1,6,12,12)",
            1,
        );
        let e = extract_text(&s).unwrap();
        let b = e.track.boundaries.unwrap();
        assert!((b.left_x[0] - 99.02).abs() < 0.00002);
        assert!((b.right_x[0] - 94.12).abs() < 0.00002);
        assert!((e.track.centerline.y[0] - (3.0 - 3.5 * 0.198_997_48)).abs() < 0.00001);
        assert_ne!(e.track.centerline.left[1], e.track.centerline.left[2]);
    }
    #[test]
    fn invalid_perp_or_width_leaves_one_complete_gap() {
        for s in [
            sample().replacen("wp_perp=(1,0,0)", "wp_perp=(0,0,0)", 1),
            sample().replacen("wp_width=(4,6,12,12)", "wp_width=(0,0,12,12)", 1),
        ] {
            let t = extract_text(&s).unwrap().track;
            let b = t.boundaries.unwrap();
            assert!([
                b.left_x[0],
                b.left_z[0],
                b.right_x[0],
                b.right_z[0],
                t.centerline.left[0],
                t.centerline.right[0]
            ]
            .iter()
            .all(|v| v.is_nan()));
            assert!(b.left_x[1].is_finite());
        }
    }
    #[test]
    fn refuses_count_graph_length_and_score_corruption() {
        let s = sample();
        for bad in [
            s.replacen("number_waypoints=128", "number_waypoints=127", 1),
            s.replacen("WP_PTRS=(127,1,-1,0)", "WP_PTRS=(127,9999,-1,0)", 1),
            s.replacen("WP_PTRS=(127,1,-1,0)", "WP_PTRS=(127,2,-1,0)", 1),
            s.replacen("wp_score=(0,0)", "wp_score=(0,250)", 1),
            s.replacen("lap_length=", "lap_length=9", 1),
        ] {
            assert!(extract_text(&bad).is_err(), "{bad}");
        }
        let disconnected = s
            .replacen("WP_PTRS=(127,1,-1,0)", "WP_PTRS=(63,1,-1,0)", 1)
            .replacen("WP_PTRS=(62,64,-1,0)", "WP_PTRS=(62,0,-1,0)", 1)
            .replacen("WP_PTRS=(63,65,-1,0)", "WP_PTRS=(127,65,-1,0)", 1)
            .replacen("WP_PTRS=(126,0,-1,0)", "WP_PTRS=(126,64,-1,0)", 1);
        assert_eq!(extract_text(&disconnected).unwrap_err().code, "lmu_main_graph");
    }
    #[test]
    fn rejects_other_source_and_bounded_oversize() {
        assert_eq!(read_pinned(&b"[Waypoint]"[..]).unwrap_err().code, "lmu_unverified_source");
        let bytes = vec![b'x'; MAX_FILE_BYTES + 2];
        assert_eq!(read_pinned(&bytes[..]).unwrap_err().code, "lmu_too_large");
    }
    #[test]
    #[ignore = "requires proprietary selectively extracted local LMU AIW"]
    fn real_verified_lmu_laguna() {
        let path = std::env::var_os("XPEED_LMU_AIW").map(std::path::PathBuf::from).unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../.codex-local/native-tracks/research-other/verified-laguna-v2/LagunaSeca.AIW")
        });
        let e = extract(&path).unwrap();
        assert_eq!(e.track.centerline.x.len(), 718);
        assert_eq!(e.track.pitlane.as_ref().unwrap().x.len(), 258);
        assert!(e.track.fast.is_none());
        assert!((e.track.length_m.unwrap() - 3590.356268).abs() < 0.001);
        assert!(e.track.boundaries.as_ref().unwrap().left_x.iter().all(|v| v.is_finite()));
        let text = std::fs::read_to_string(&path).unwrap();
        let source = parse_aiw(&text).unwrap();
        let mut i = source
            .waypoints
            .iter()
            .enumerate()
            .filter(|(_, w)| w.branch == 0)
            .min_by(|(_, a), (_, b)| a.score.unwrap().total_cmp(&b.score.unwrap()))
            .unwrap()
            .0;
        let edges = e.track.boundaries.as_ref().unwrap();
        let mut worst = 0.0f64;
        for k in 0..718 {
            let w = &source.waypoints[i];
            for (actual, expected) in [
                (edges.left_x[k], w.pos[0] + w.width[0] * w.perp[0]),
                (edges.left_z[k], w.pos[2] + w.width[0] * w.perp[2]),
                (edges.right_x[k], w.pos[0] - w.width[1] * w.perp[0]),
                (edges.right_z[k], w.pos[2] - w.width[1] * w.perp[2]),
                (e.track.centerline.y[k], w.pos[1] + (w.width[0] - w.width[1]) / 2.0 * w.perp[1]),
            ] {
                worst = worst.max((f64::from(actual) - expected).abs());
            }
            i = w.next as usize;
        }
        assert!(worst < 0.00004, "float32 source-coordinate export error {worst}");
        println!("LMU source fidelity: worst {worst:.9} m across 718 boundary/elevation rows; no telemetry overlay claim");
        let bytes = pack(&e.track).unwrap();
        let roundtrip = unpack(&bytes).unwrap();
        assert_eq!(roundtrip.game, "lmu");
        assert_eq!(roundtrip.frame, SOURCE_FRAME);
    }
}
