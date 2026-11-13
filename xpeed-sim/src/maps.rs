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
