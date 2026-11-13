//! The track map the panel draws, kept between sessions: the path the car drove on a track is saved when it becomes
//! the map, and read back the next time the car is on that track, so the map is there from the first frame.
//!
//! For the games whose layouts Xpeed Sim builds (Assetto Corsa, Stock Car Extreme) the built layout's centre line is
//! the real track, so it is used instead when its copy is in the layouts outbox (`<laps folder>/tracks/`, which the
//! uploader never empties).
//!
//! Files are small (8 bytes a point) and written beside their name and renamed, like the covers.

use std::path::PathBuf;

use crate::tracks::{self, auto};
use crate::util::file_safe;

/// A path as the panel draws it: (x, z) in the game's world, in metres.
pub type Path2 = Vec<(f32, f32)>;

const MAGIC: &[u8; 4] = b"XMP1";
const EXTENSION: &str = ".map";
/// More points than this is not a map this program wrote.
const MAX_POINTS: usize = 200_000;

/// Where maps and layouts are, and which game the tracker is reading (the reader's id: `ac`, `rfactor1`, `lmu`...).
#[derive(Debug, Clone)]
pub struct Store {
    pub maps: PathBuf,
    pub layouts: PathBuf,
    pub game: &'static str,
}

impl Store {
    /// The real layout when this computer has it, else the saved driven path of this track.
    pub fn start(&self, track: &str, variant: Option<&str>) -> Option<Path2> {
        self.layout(track, variant).or_else(|| self.load(track, variant))
    }

    /// The built layout's centre line (Assetto Corsa and Stock Car Extreme only). The layout file says its axes are
    /// the game's own world, the one telemetry reports, so the car is drawn on it as it is.
    pub fn layout(&self, track: &str, variant: Option<&str>) -> Option<Path2> {
        let file_game = auto::file_game(self.game)?;
        let hash = auto::hash_hex(auto::track_key(file_game, track, variant).as_bytes());
        let ending = format!("_{}{}", &hash[..8], auto::EXTENSION);
        let prefix = format!("{}_", file_safe(file_game));
        let name = std::fs::read_dir(&self.layouts)
            .ok()?
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .find(|name| name.starts_with(&prefix) && name.ends_with(&ending))?;
        let track = tracks::gunzip(&std::fs::read(self.layouts.join(name)).ok()?, tracks::MAX_UNPACKED).ok()?;
        let line = &track.centerline;
        let mut points: Path2 = line.x.iter().copied().zip(line.z.iter().copied()).collect();
        if track.closed {
            points.extend(points.first().copied());
        }
        (points.len() >= 2 && points.iter().all(|p| p.0.is_finite() && p.1.is_finite())).then_some(points)
    }

    fn file(&self, track: &str, variant: Option<&str>) -> PathBuf {
        let key = auto::track_key(self.game, track, variant);
        let variant = variant.map(|v| format!("_{}", file_safe(v))).unwrap_or_default();
        self.maps.join(format!(
            "{}_{}{variant}_{}{EXTENSION}",
            file_safe(self.game),
            file_safe(track),
            &auto::hash_hex(key.as_bytes())[..8]
        ))
    }

    /// The saved path of this track, if there is a good one.
    pub fn load(&self, track: &str, variant: Option<&str>) -> Option<Path2> {
        decode(&std::fs::read(self.file(track, variant)).ok()?)
    }

    /// Keeps `path` as this track's map (through a `.part` file, so a cut write never replaces a good copy).
    pub fn save(&self, track: &str, variant: Option<&str>, path: &[(f32, f32)]) -> std::io::Result<()> {
        let file = self.file(track, variant);
        std::fs::create_dir_all(&self.maps)?;
        let part = file.with_extension("map.part");
        std::fs::write(&part, encode(path))?;
        std::fs::rename(&part, &file)
    }
}

fn encode(path: &[(f32, f32)]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(8 + path.len() * 8);
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&(path.len() as u32).to_le_bytes());
    for &(x, z) in path {
        bytes.extend_from_slice(&x.to_le_bytes());
        bytes.extend_from_slice(&z.to_le_bytes());
    }
    bytes
}

fn decode(bytes: &[u8]) -> Option<Path2> {
    let rest = bytes.strip_prefix(MAGIC)?;
    let (count, body) = rest.split_first_chunk::<4>()?;
    let count = u32::from_le_bytes(*count) as usize;
    if count > MAX_POINTS || body.len() != count * 8 {
        return None;
    }
    let (pairs, _) = body.as_chunks::<8>();
    let float = |b: [u8; 4]| f32::from_le_bytes(b);
    let path: Path2 = pairs
        .iter()
        .map(|c| (float([c[0], c[1], c[2], c[3]]), float([c[4], c[5], c[6], c[7]])))
        .collect();
    path.iter().all(|p| p.0.is_finite() && p.1.is_finite()).then_some(path)
}

/// The folder maps are kept in: `maps` under where Xpeed Sim keeps its files.
pub fn default_dir() -> Option<PathBuf> {
    crate::config::home_dir().map(|home| home.join("maps"))
}

/// The path cut into runs wherever two neighbours are further apart than `max_gap` metres (a restart, the pits, a
/// teleport): each run is drawn alone, so nothing is drawn across a jump. Runs of one point are dropped.
pub fn split_at_gaps(path: &[(f32, f32)], max_gap: f32) -> Vec<Path2> {
    let mut runs: Vec<Path2> = Vec::new();
    let mut run: Path2 = Vec::new();
    for &p in path {
        if run.last().is_some_and(|&(x, z)| (x - p.0).hypot(z - p.1) > max_gap) {
            runs.push(std::mem::take(&mut run));
        }
        run.push(p);
    }
    runs.push(run);
    runs.retain(|r| r.len() >= 2);
    runs
}

/// A centred moving average over `2 * reach + 1` points, so the corners of a 4 m polyline round off. The number of
/// points stays. An open path keeps its two ends and averages what it has near them; a closed one wraps round.
pub fn smooth(path: &[(f32, f32)], reach: usize, closed: bool) -> Path2 {
    let n = path.len();
    if n < 3 || reach == 0 {
        return path.to_vec();
    }
    (0..n)
        .map(|i| {
            if !closed && (i == 0 || i == n - 1) {
                return path[i];
            }
            let r = if closed { reach } else { reach.min(i).min(n - 1 - i) };
            let (mut sx, mut sz) = (0.0, 0.0);
            for k in 0..=2 * r {
                let j = (i + n + k - r) % n;
                sx += path[j].0;
                sz += path[j].1;
            }
            let count = (2 * r + 1) as f32;
            (sx / count, sz / count)
        })
        .collect()
}

/// How a map is laid in its box: turned so its long side runs along the box's long side, scaled to fit with a
/// margin (never stretched), and centred. The car is placed with the same numbers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fit {
    cos: f32,
    sin: f32,
    /// The centre of the turned shape.
    cx: f32,
    cz: f32,
    pub scale: f32,
    /// The centre of the box.
    bx: f32,
    by: f32,
}

impl Fit {
    pub fn apply(&self, (x, z): (f32, f32)) -> (f32, f32) {
        let (u, v) = (x * self.cos - z * self.sin, x * self.sin + z * self.cos);
        (self.bx + (u - self.cx) * self.scale, self.by + (v - self.cz) * self.scale)
    }
}

/// The long axis of the points (the principal axis of their covariance), as an angle of the (x, z) plane.
pub fn principal_angle(points: &[(f32, f32)]) -> f32 {
    let n = points.len().max(1) as f32;
    let (mx, mz) = points.iter().fold((0.0, 0.0), |(a, b), p| (a + p.0, b + p.1));
    let (mx, mz) = (mx / n, mz / n);
    let (mut sxx, mut szz, mut sxz) = (0.0, 0.0, 0.0);
    for &(x, z) in points {
        let (dx, dz) = (x - mx, z - mz);
        sxx += dx * dx;
        szz += dz * dz;
        sxz += dx * dz;
    }
    0.5 * (2.0 * sxz).atan2(sxx - szz)
}

/// Fits `points` in a box `w` by `h` centred on (`bx`, `by`) with `pad` on every side. Of the shape turned along its
/// long axis, and the same turned a quarter more, the one that fills the box better is used. `None` for a shape with
/// no size.
pub fn fit(points: &[(f32, f32)], bx: f32, by: f32, w: f32, h: f32, pad: f32) -> Option<Fit> {
    if points.is_empty() {
        return None;
    }
    let along = -principal_angle(points);
    let mut best: Option<Fit> = None;
    for angle in [along, along + std::f32::consts::FRAC_PI_2] {
        let (sin, cos) = angle.sin_cos();
        let (mut lo_u, mut hi_u, mut lo_v, mut hi_v) = (f32::INFINITY, f32::NEG_INFINITY, f32::INFINITY, f32::NEG_INFINITY);
        for &(x, z) in points {
            let (u, v) = (x * cos - z * sin, x * sin + z * cos);
            (lo_u, hi_u, lo_v, hi_v) = (lo_u.min(u), hi_u.max(u), lo_v.min(v), hi_v.max(v));
        }
        let scale = ((w - 2.0 * pad) / (hi_u - lo_u).max(1.0)).min((h - 2.0 * pad) / (hi_v - lo_v).max(1.0));
        if !scale.is_finite() || scale <= 0.0 {
            continue;
        }
        let candidate = Fit {
            cos,
            sin,
            cx: (lo_u + hi_u) / 2.0,
            cz: (lo_v + hi_v) / 2.0,
            scale,
            bx,
            by,
        };
        if best.is_none_or(|b| candidate.scale > b.scale) {
            best = Some(candidate);
        }
    }
    best
}

#[cfg(test)]
mod draw_tests {
    #[test]
    fn breaks_the_path_at_a_jump_and_keeps_the_runs() {
        let mut path: Vec<(f32, f32)> = (0..10).map(|i| (i as f32 * 4.0, 0.0)).collect();
        path.extend((0..10).map(|i| (500.0 + i as f32 * 4.0, 300.0)));
        path.push((9000.0, 0.0));
        let runs = super::split_at_gaps(&path, 40.0);
        assert_eq!(runs.len(), 2, "the lone point after the second jump is dropped");
        assert_eq!((runs[0].len(), runs[1].len()), (10, 10));
        assert_eq!(super::split_at_gaps(&path[..10], 40.0), vec![path[..10].to_vec()]);
        assert!(super::split_at_gaps(&[], 40.0).is_empty());
    }

    #[test]
    fn smoothing_keeps_the_ends_and_the_count_and_rounds_a_corner() {
        use super::smooth;
        let corner: Vec<(f32, f32)> = (0..11)
            .map(|i| if i <= 5 { (i as f32, 0.0) } else { (5.0, (i - 5) as f32) })
            .collect();
        let soft = smooth(&corner, 2, false);
        assert_eq!(soft.len(), corner.len());
        assert_eq!((soft[0], soft[10]), (corner[0], corner[10]));
        assert!(soft[5].0 < 5.0 && soft[5].1 > 0.0, "the corner is cut: {:?}", soft[5]);
        assert_eq!(smooth(&corner[..2], 2, false), corner[..2].to_vec());
        // A closed path wraps round: a ring stays a ring.
        let ring: Vec<(f32, f32)> = (0..60)
            .map(|i| {
                let a = i as f32 / 60.0 * std::f32::consts::TAU;
                (a.cos() * 100.0, a.sin() * 100.0)
            })
            .collect();
        let round = smooth(&ring, 2, true);
        assert_eq!(round.len(), 60);
        assert!(round.iter().all(|p| (p.0.hypot(p.1) - 100.0).abs() < 2.0));
    }

    #[test]
    fn turns_the_long_side_of_the_shape_along_the_long_side_of_the_box() {
        use super::{fit, principal_angle};
        // A long thin diagonal strip, in a wide box and in a tall one.
        let strip: Vec<(f32, f32)> = (0..100)
            .map(|i| (i as f32 * 10.0, i as f32 * 10.0 + (i % 2) as f32 * 20.0))
            .collect();
        let extent = |points: &[(f32, f32)], pick: fn(&(f32, f32)) -> f32| {
            let v: Vec<f32> = points.iter().map(pick).collect();
            v.iter().copied().fold(f32::NEG_INFINITY, f32::max) - v.iter().copied().fold(f32::INFINITY, f32::min)
        };
        for (w, h) in [(400.0, 100.0), (100.0, 400.0)] {
            let fitted = fit(&strip, 0.0, 0.0, w, h, 10.0).unwrap();
            let moved: Vec<(f32, f32)> = strip.iter().map(|&p| fitted.apply(p)).collect();
            let (sx, sy) = (extent(&moved, |p| p.0), extent(&moved, |p| p.1));
            assert!((sx > sy) == (w > h), "{w}x{h}: {sx} by {sy}");
            assert!(
                moved.iter().all(|p| p.0.abs() <= w / 2.0 - 9.9 && p.1.abs() <= h / 2.0 - 9.9),
                "inside the margin"
            );
            let plain = ((w - 20.0) / 990.0).min((h - 20.0) / 1010.0);
            assert!(fitted.scale > plain * 1.5, "{} against {plain}", fitted.scale);
        }
        assert!(fit(&[], 0.0, 0.0, 100.0, 100.0, 5.0).is_none());
        assert!(principal_angle(&[(0.0, 0.0), (10.0, 0.0), (20.0, 0.0)]).abs() < 1e-6);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::scratch_dir;
    use crate::tracks::auto::{Built, Folders, Seen};

    fn store(dir: &std::path::Path, game: &'static str) -> Store {
        Store {
            maps: dir.join("maps"),
            layouts: dir.join("tracks"),
            game,
        }
    }

    #[test]
    fn saves_and_loads_a_path_by_game_track_and_layout() {
        let dir = scratch_dir("maps-save");
        let s = store(&dir, "lmu");
        let path: Vec<(f32, f32)> = (0..500).map(|i| (i as f32 * 4.0, -(i as f32))).collect();
        assert_eq!(s.load("Sarthe", None), None);
        s.save("Sarthe", None, &path).unwrap();
        assert_eq!(s.load("Sarthe", None), Some(path.clone()));
        assert_eq!(s.load("  SARTHE", None), Some(path.clone()), "the key is trimmed and lower case");
        assert_eq!(s.load("Sarthe", Some("short")), None, "another layout is another map");
        assert_eq!(s.load("Spa", None), None);
        assert_eq!(store(&dir, "ac").load("Sarthe", None), None, "another game is another map");
        assert!(std::fs::read_dir(&s.maps)
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().ends_with(".part")));
        // A cut or damaged file is no map.
        let file = std::fs::read_dir(&s.maps).unwrap().next().unwrap().unwrap().path();
        let bytes = std::fs::read(&file).unwrap();
        std::fs::write(&file, &bytes[..bytes.len() - 3]).unwrap();
        assert_eq!(s.load("Sarthe", None), None);
        std::fs::write(&file, b"nonsense").unwrap();
        assert_eq!(s.load("Sarthe", None), None);
    }

    #[test]
    fn the_built_layout_is_the_map_when_its_copy_is_in_the_outbox() {
        let dir = scratch_dir("maps-layout");
        let tracks = dir.join("game");
        std::fs::create_dir_all(tracks.join("circle").join("ai")).unwrap();
        std::fs::write(
            tracks.join("circle").join("ai").join(crate::tracks::ac::SOURCE),
            crate::tracks::ac::tests::synthetic(600, 100.0, std::f64::consts::TAU, 9.0, 3.0),
        )
        .unwrap();
        let s = store(&dir, "ac");
        assert_eq!(s.start("circle", None), None, "no layout and no saved path yet");
        let seen = Seen {
            game: "ac".into(),
            track: "circle".into(),
            variant: None,
        };
        let folders = Folders {
            ac: vec![tracks],
            sce: vec![],
        };
        let Built::Written(_) = crate::tracks::auto::build(&seen, &folders, &s.layouts).unwrap() else {
            panic!("the layout should be written");
        };
        let map = s.start("Circle", None).expect("the layout is there");
        assert!(map.len() > 100);
        let radius = f64::from(map[10].0).hypot(f64::from(map[10].1));
        // The ideal line is at radius 100 with 9 m to one edge and 3 m to the other: the road's middle is 103 m out.
        assert!((radius - 103.0).abs() < 0.1, "the centre line, in the game's own world: {radius}");
        assert_eq!(map.first(), map.last(), "a closed track closes");
        // It wins over a driven path, and only for its own track and game.
        s.save("circle", None, &[(1.0, 1.0), (2.0, 2.0)]).unwrap();
        assert!(s.start("circle", None).unwrap().len() > 100);
        assert_eq!(s.layout("other", None), None);
        assert_eq!(store(&dir, "lmu").layout("circle", None), None, "a game with no built layouts");
    }
}
