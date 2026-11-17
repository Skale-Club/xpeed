//! Local heading-up geometry. Every point stays in the reader's world frame; only the camera is transformed.

use std::collections::{HashMap, VecDeque};

pub type Point = (f32, f32);
const GAP: f32 = 40.0;
const CELL: f32 = 50.0;
const BEHIND: f32 = 35.0;
const AHEAD: f32 = 280.0;
const MAX_VERTICES: usize = 450;

fn finite(p: Point) -> bool {
    p.0.is_finite() && p.1.is_finite()
}
fn distance(a: Point, b: Point) -> f32 {
    (a.0 - b.0).hypot(a.1 - b.1)
}
fn unit(p: Point) -> Option<Point> {
    let length = p.0.hypot(p.1);
    (length.is_finite() && length > 0.001).then(|| (p.0 / length, p.1 / length))
}
fn cell(p: Point) -> (i32, i32) {
    ((p.0 / CELL).floor() as i32, (p.1 / CELL).floor() as i32)
}

/// Direction from recent real motion, over at most 14 m. Sub-0.5 m movement holds the last direction.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MotionHeading {
    recent: VecDeque<Point>,
    last_pos: Option<Point>,
    last_at: Option<i64>,
    heading: Option<Point>,
}

impl MotionHeading {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn update(&mut self, pos: Option<Point>, at_ms: i64, driving: bool) -> Option<Point> {
        let Some(pos) = pos.filter(|p| finite(*p)) else {
            self.reset();
            return None;
        };
        if self.last_at.is_some_and(|at| at_ms < at || at_ms.saturating_sub(at) > 1500)
            || self.last_pos.is_some_and(|p| distance(p, pos) > GAP)
        {
            self.reset();
        }
        self.last_at = Some(at_ms);
        self.last_pos = Some(pos);
        if !driving {
            return self.heading;
        }
        if self.recent.back().is_some_and(|p| distance(*p, pos) < 0.5) {
            return self.heading;
        }
        self.recent.push_back(pos);
        let mut span = 0.0;
        for i in (1..self.recent.len()).rev() {
            span += distance(self.recent[i], self.recent[i - 1]);
            if span >= 14.0 {
                for _ in 0..i.saturating_sub(1) {
                    self.recent.pop_front();
                }
                break;
            }
        }
        if let Some(first) = self.recent.front().copied() {
            if distance(first, pos) >= 1.0 {
                self.heading = unit((pos.0 - first.0, pos.1 - first.1));
            }
        }
        self.heading
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Node {
    point: Point,
    arc: f32,
    source: usize,
}
#[derive(Clone, Debug, PartialEq)]
struct Run {
    nodes: Vec<Node>,
    length: f32,
    closed: bool,
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct Location {
    run: usize,
    index: usize,
}

/// Prepared once when an immutable source path changes; nearest queries visit only nearby grid cells.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PreparedPath {
    runs: Vec<Run>,
    grid: HashMap<(i32, i32), Vec<Location>>,
}

impl PreparedPath {
    pub fn new(points: &[Point], complete: bool) -> Self {
        let mut runs = Vec::new();
        let mut nodes: Vec<Node> = Vec::new();
        let mut previous = None;
        let mut arc = 0.0;
        let mut uninterrupted = true;
        let finish = |runs: &mut Vec<Run>, nodes: &mut Vec<Node>| {
            if nodes.len() >= 2 {
                let kept = std::mem::take(nodes);
                let length = kept.last().map_or(0.0, |p| p.arc);
                runs.push(Run {
                    nodes: kept,
                    length,
                    closed: false,
                });
            } else {
                nodes.clear();
            }
        };
        for (source, &point) in points.iter().enumerate() {
            if !finite(point) {
                finish(&mut runs, &mut nodes);
                previous = None;
                arc = 0.0;
                uninterrupted = false;
                continue;
            }
            if let Some(p) = previous {
                let step = distance(p, point);
                if step > GAP {
                    finish(&mut runs, &mut nodes);
                    arc = 0.0;
                    uninterrupted = false;
                } else {
                    arc += step;
                }
            }
            previous = Some(point);
            if nodes.last().is_none_or(|n| arc - n.arc >= 1.0) {
                nodes.push(Node { point, arc, source });
            }
        }
        finish(&mut runs, &mut nodes);
        if complete && uninterrupted && runs.len() == 1 {
            let run = &mut runs[0];
            let gap = distance(run.nodes[0].point, run.nodes.last().unwrap().point);
            if gap <= GAP && run.length > 2.0 {
                run.closed = true;
                run.length += gap;
            }
        }
        let mut grid: HashMap<(i32, i32), Vec<Location>> = HashMap::new();
        for (r, run) in runs.iter().enumerate() {
            for (i, n) in run.nodes.iter().enumerate() {
                grid.entry(cell(n.point)).or_default().push(Location { run: r, index: i });
            }
        }
        Self { runs, grid }
    }

    fn nearest(&self, car: Point, heading: Point) -> Option<Location> {
        let (cx, cz) = cell(car);
        let mut best = None;
        let mut score = f32::INFINITY;
        for dx in -1..=1 {
            for dz in -1..=1 {
                let Some(bucket) = self.grid.get(&(cx.saturating_add(dx), cz.saturating_add(dz))) else {
                    continue;
                };
                // Corrupt/repeated paths may put thousands of vertices in one cell; work stays bounded per frame.
                for &at in bucket.iter().step_by(bucket.len().div_ceil(256).max(1)) {
                    let run = &self.runs[at.run];
                    let point = run.nodes[at.index].point;
                    let d = distance(point, car);
                    if d > 50.0 {
                        continue;
                    }
                    let (a, b) = neighbours(run, at.index);
                    let tangent = unit((b.0 - a.0, b.1 - a.1)).unwrap_or(heading);
                    let agreement = tangent.0 * heading.0 + tangent.1 * heading.1;
                    // Avoid picking the opposite arm of a nearby hairpin solely because its centre is a metre closer.
                    let value = d + (1.0 - agreement).max(0.0) * 12.0;
                    if value < score {
                        score = value;
                        best = Some(at);
                    }
                }
            }
        }
        best
    }

    fn local_nodes(&self, car: Point, heading: Point) -> Vec<&Node> {
        let Some(at) = self.nearest(car, heading) else {
            return Vec::new();
        };
        let run = &self.runs[at.run];
        let anchor = run.nodes[at.index].arc;
        let mut nodes = Vec::new();
        // At most one lap, even on a very small closed circuit.
        let span = (BEHIND + AHEAD).min(run.length);
        let before = BEHIND.min(span * 0.25);
        let after = span - before;
        let lower = anchor - before;
        let upper = anchor + after;
        let mut ranges = Vec::with_capacity(3);
        if run.closed && lower < 0.0 {
            ranges.push((run.length + lower, run.length));
        }
        ranges.push((lower.max(0.0), upper.min(run.length)));
        if run.closed && upper > run.length {
            ranges.push((0.0, upper - run.length));
        }
        for (from, to) in ranges {
            let start = run.nodes.partition_point(|n| n.arc < from);
            let end = run.nodes.partition_point(|n| n.arc <= to);
            nodes.extend(run.nodes[start..end].iter());
        }
        if nodes.len() > MAX_VERTICES {
            let step = nodes.len().div_ceil(MAX_VERTICES);
            nodes = nodes.into_iter().step_by(step).collect();
        }
        nodes
    }

    pub fn local(&self, car: Point, heading: Point) -> Vec<Point> {
        self.local_nodes(car, heading).into_iter().map(|n| n.point).collect()
    }
}

fn neighbours(run: &Run, index: usize) -> (Point, Point) {
    let n = run.nodes.len();
    let a = if run.closed { (index + n - 1) % n } else { index.saturating_sub(1) };
    let b = if run.closed { (index + 1) % n } else { (index + 1).min(n - 1) };
    (run.nodes[a].point, run.nodes[b].point)
}

/// Native layout boundaries. Unknown widths remain unknown; no road is inferred from a driven line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoadKind {
    AiEnvelope,
    Asphalt,
    WhiteLine,
    Estimated,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Road {
    pub kind: RoadKind,
    path: PreparedPath,
    edges: Vec<Option<(Point, Point)>>,
    unknown_prefix: Vec<usize>,
}

impl Road {
    pub fn from_track(track: &crate::tracks::Track) -> Option<Self> {
        let c = &track.centerline;
        let count = c.x.len();
        if count < 2 || c.z.len() != count || c.left.len() != count || c.right.len() != count {
            return None;
        }
        let points: Vec<Point> = c.x.iter().copied().zip(c.z.iter().copied()).collect();
        if track.boundaries.as_ref().is_some_and(|b| {
            [b.left_x.len(), b.left_z.len(), b.right_x.len(), b.right_z.len()]
                .iter()
                .any(|&n| n != count)
        }) {
            return None;
        }
        let edges = (0..count)
            .map(|i| {
                // V2 retains source cross-sections. Recomputing normals here would move EVO's borders.
                if let Some(b) = &track.boundaries {
                    let (left, right) = ((b.left_x[i], b.left_z[i]), (b.right_x[i], b.right_z[i]));
                    return (finite(points[i]) && finite(left) && finite(right)).then_some((left, right));
                }
                if !finite(points[i]) || !c.left[i].is_finite() || !c.right[i].is_finite() || c.left[i] <= 0.0 || c.right[i] <= 0.0 {
                    return None;
                }
                let a = if track.closed {
                    (i + count - 1) % count
                } else {
                    i.saturating_sub(1)
                };
                let b = if track.closed { (i + 1) % count } else { (i + 1).min(count - 1) };
                let (tx, tz) = unit((points[b].0 - points[a].0, points[b].1 - points[a].1))?;
                let p = points[i];
                Some((
                    (p.0 + tz * c.left[i], p.1 - tx * c.left[i]),
                    (p.0 - tz * c.right[i], p.1 + tx * c.right[i]),
                ))
            })
            .collect::<Vec<_>>();
        if !edges.windows(2).any(|w| w[0].is_some() && w[1].is_some()) {
            return None;
        }
        let mut unknown_prefix = Vec::with_capacity(count + 1);
        unknown_prefix.push(0);
        for edge in &edges {
            unknown_prefix.push(unknown_prefix.last().copied().unwrap_or(0) + usize::from(edge.is_none()));
        }
        Some(Self {
            kind: if track.source == "mesh_asphalt" {
                RoadKind::Asphalt
            } else if track.source == "ego_white_line" {
                RoadKind::WhiteLine
            } else if track.boundaries.is_some() {
                RoadKind::AiEnvelope
            } else {
                RoadKind::Estimated
            },
            path: PreparedPath::new(&points, track.closed),
            edges,
            unknown_prefix,
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub width: f32,
    pub height: f32,
    pub car: Point,
    pub heading: Point,
    /// Opposite planar handedness (iRacing uses x=east, z=minus north). Source coordinates stay untouched.
    pub mirrored: bool,
}

impl Camera {
    pub fn anchor(&self) -> Point {
        (self.width * 0.5, self.height * 0.76)
    }
    fn camera(&self, p: Point) -> [f32; 3] {
        let (tx, tz) = unit(self.heading).unwrap_or((0.0, 1.0));
        let (dx, dz) = (p.0 - self.car.0, p.1 - self.car.1);
        let (lateral, forward) = (dx * tz - dz * tx, dx * tx + dz * tz);
        let lateral = if self.mirrored { -lateral } else { lateral };
        let (s, c) = 32.0_f32.to_radians().sin_cos();
        [lateral, s * (forward + 49.0) - c * 29.0, c * (forward + 49.0) + s * 29.0]
    }
    fn screen(&self, p: [f32; 3]) -> Point {
        let focal = (self.width * 0.95).min(self.height * 1.05);
        let zero = self.camera(self.car);
        let anchor = self.anchor();
        (
            anchor.0 + focal * p[0] / p[2],
            anchor.1 + focal * zero[1] / zero[2] - focal * p[1] / p[2],
        )
    }
    #[cfg(test)]
    pub fn project(&self, p: Point) -> Option<Point> {
        if !finite(p) || !finite(self.car) || !self.width.is_finite() || !self.height.is_finite() || self.width <= 0.0 || self.height <= 0.0
        {
            return None;
        }
        let q = self.camera(p);
        (q[2] >= 8.0).then(|| self.screen(q)).filter(|p| finite(*p))
    }
    pub fn segment(&self, a: Point, b: Point) -> Option<(Point, Point)> {
        if !finite(a) || !finite(b) {
            return None;
        }
        let (mut a, mut b) = (self.camera(a), self.camera(b));
        if a[2] < 8.0 && b[2] < 8.0 {
            return None;
        }
        if a[2] < 8.0 || b[2] < 8.0 {
            let f = (8.0 - a[2]) / (b[2] - a[2]);
            let p = std::array::from_fn(|i| a[i] + (b[i] - a[i]) * f);
            if a[2] < 8.0 {
                a = p;
            } else {
                b = p;
            }
        }
        let out = (self.screen(a), self.screen(b));
        (finite(out.0) && finite(out.1)).then_some(out)
    }
    pub fn polygon(&self, points: &[Point]) -> Vec<Point> {
        if points.iter().any(|p| !finite(*p)) {
            return Vec::new();
        }
        let input: Vec<_> = points.iter().map(|p| self.camera(*p)).collect();
        let mut out = Vec::new();
        for i in 0..input.len() {
            let a = input[i];
            let b = input[(i + 1) % input.len()];
            let (ain, bin) = (a[2] >= 8.0, b[2] >= 8.0);
            if ain {
                out.push(a);
            }
            if ain != bin {
                let f = (8.0 - a[2]) / (b[2] - a[2]);
                out.push(std::array::from_fn(|j| a[j] + (b[j] - a[j]) * f));
            }
        }
        out.into_iter().map(|p| self.screen(p)).filter(|p| finite(*p)).collect()
    }
}

pub fn ground_alpha(y: f32, height: f32) -> f32 {
    if !y.is_finite() || !height.is_finite() || height <= 0.0 {
        0.0
    } else {
        ((height - y) / (height * 0.28)).clamp(0.0, 1.0)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub center: Vec<(Point, Point)>,
    pub trail: Vec<(Point, Point)>,
    pub reference: Vec<(Point, Point)>,
    pub road: Vec<Vec<Point>>,
    pub edges: Vec<(Point, Point)>,
    pub arrow: Vec<Point>,
}

pub fn scene(camera: Camera, path: &PreparedPath, road: Option<&Road>, trail: &PreparedPath, reference: Option<&PreparedPath>) -> Scene {
    let line = |path: &PreparedPath| {
        path.local(camera.car, camera.heading)
            .windows(2)
            .filter_map(|w| camera.segment(w[0], w[1]))
            .collect()
    };
    let mut result = Scene {
        center: line(path),
        trail: line(trail),
        reference: reference.map_or_else(Vec::new, line),
        ..Scene::default()
    };
    if let Some(road) = road {
        let nodes = road.path.local_nodes(camera.car, camera.heading);
        for pair in nodes.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            // A thinned path must still respect unknown widths between the selected vertices.
            let unknown = &road.unknown_prefix;
            let valid = if b.source >= a.source {
                unknown[b.source + 1] == unknown[a.source]
            } else {
                unknown[road.edges.len()] == unknown[a.source] && unknown[b.source + 1] == 0
            };
            if !valid {
                continue;
            }
            if let (Some((al, ar)), Some((bl, br))) = (road.edges[a.source], road.edges[b.source]) {
                let polygon = camera.polygon(&[al, bl, br, ar]);
                if polygon.len() >= 3 {
                    result.road.push(polygon);
                }
                result
                    .edges
                    .extend([camera.segment(al, bl), camera.segment(ar, br)].into_iter().flatten());
            }
        }
    }
    let (x, y) = camera.anchor();
    result.arrow = vec![(x, y - 19.0), (x + 12.0, y + 15.0), (x, y + 8.0), (x - 12.0, y + 15.0)];
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires XPEED_EVO_PILOT_TRACK; measures local source queries over a 20-minute-equivalent replay"]
    fn native_surface_long_replay_keeps_scene_queries_bounded() {
        let file = std::env::var_os("XPEED_EVO_PILOT_TRACK").expect("set local native asphalt XTRK path");
        let track = crate::tracks::gunzip(&std::fs::read(file).unwrap(), crate::tracks::MAX_UNPACKED).unwrap();
        assert_eq!(track.source, "mesh_asphalt");
        let road = Road::from_track(&track).unwrap();
        let points: Vec<_> = track.centerline.x.iter().copied().zip(track.centerline.z.iter().copied()).collect();
        let path = PreparedPath::new(&points, true);
        let empty = PreparedPath::default();
        let lap = crate::lapfile::gunzip(
            include_bytes!("../fixtures/laps/acevo-real-lap-3.xlap.gz"),
            crate::lapfile::MAX_UNPACKED,
        )
        .unwrap();
        let x = &lap.channel("x").unwrap().values;
        let z = &lap.channel("z").unwrap().values;
        let start = std::time::Instant::now();
        let mut maximum = (0, 0);
        let mut drawn = 0usize;
        for tick in 0..120_000 {
            let i = tick % x.len();
            let next = (i + 8) % x.len();
            let car = (-x[i], z[i]); // Historical recording; normalization stays in validation memory.
            let heading = unit((-x[next] + x[i], z[next] - z[i])).unwrap_or((0., 1.));
            let result = scene(
                Camera {
                    width: 736.,
                    height: 400.,
                    car,
                    heading,
                    mirrored: false,
                },
                &path,
                Some(&road),
                &empty,
                None,
            );
            maximum.0 = maximum.0.max(result.road.len());
            maximum.1 = maximum.1.max(result.edges.len());
            assert!(result.road.len() < MAX_VERTICES && result.edges.len() < 2 * MAX_VERTICES);
            assert!(result.road.iter().flatten().copied().all(finite));
            drawn += usize::from(!result.road.is_empty());
        }
        assert!(drawn > 118_000, "native road must remain available around the recorded lap");
        let elapsed = start.elapsed();
        eprintln!(
            "120000 queries (20 min at 100 Hz): {elapsed:?}; {:.3} ms/query; max {} road strips / {} edges; immutable source {} points",
            elapsed.as_secs_f64() * 1000. / 120_000.,
            maximum.0,
            maximum.1,
            points.len()
        );
    }
    fn track(widths: Vec<f32>) -> crate::tracks::Track {
        let count = widths.len();
        crate::tracks::Track {
            boundaries: None,
            game: "ac".into(),
            name: "Test track".into(),
            variant: None,
            title: None,
            length_m: None,
            source: "test".into(),
            frame: "game world".into(),
            closed: false,
            center_kind: "edges_midpoint".into(),
            centerline: crate::tracks::Centerline {
                x: vec![0.0; count],
                y: vec![0.0; count],
                z: (0..count).map(|i| i as f32 * 5.0).collect(),
                dist: (0..count).map(|i| i as f32 * 5.0).collect(),
                left: widths.clone(),
                right: widths,
            },
            fast: None,
            pitlane: None,
        }
    }
    #[test]
    fn explicit_boundaries_keep_oblique_source_sections_and_missing_rows() {
        let mut t = track(vec![f32::NAN; 30]);
        let mut b = crate::tracks::Boundaries {
            left_x: vec![8.0; 30],
            left_z: (0..30).map(|i| i as f32 * 5.0 + 2.0).collect(),
            right_x: vec![-3.0; 30],
            right_z: (0..30).map(|i| i as f32 * 5.0 - 1.0).collect(),
        };
        for col in [&mut b.left_x, &mut b.left_z, &mut b.right_x, &mut b.right_z] {
            col[10] = f32::NAN;
        }
        t.boundaries = Some(b);
        let road = Road::from_track(&t).unwrap();
        assert_eq!(road.edges[0], Some(((8.0, 2.0), (-3.0, -1.0))));
        assert_eq!(road.edges[10], None);
        let camera = Camera {
            width: 736.0,
            height: 400.0,
            car: (0.0, 35.0),
            heading: (0.0, 1.0),
            mirrored: false,
        };
        let path = PreparedPath::new(&[(0.0, 30.0), (0.0, 35.0), (0.0, 40.0)], false);
        let drawn = scene(camera, &path, Some(&road), &path, None);
        assert_eq!(drawn.road.len(), 27, "no quads bridge the missing cross-section");
    }

    #[test]
    fn road_retains_native_widths_and_never_fills_unknown_sections() {
        assert!(Road::from_track(&track(vec![f32::NAN; 20])).is_none());
        let mut widths = vec![7.0; 30];
        widths[10] = f32::NAN;
        let road = Road::from_track(&track(widths)).unwrap();
        assert_eq!(road.edges[0], Some(((7.0, 0.0), (-7.0, 0.0))));
        assert_eq!(road.edges[10], None);
        let camera = Camera {
            width: 736.0,
            height: 400.0,
            car: (0.0, 35.0),
            heading: (0.0, 1.0),
            mirrored: false,
        };
        let path = PreparedPath::new(&[(0.0, 30.0), (0.0, 35.0), (0.0, 40.0)], false);
        let drawn = scene(camera, &path, Some(&road), &path, None);
        assert_eq!(drawn.road.len(), 27, "the two quads touching the unknown cross-section are absent");
    }
    #[test]
    fn heading_is_real_motion_and_holds_at_rest_then_resets_on_bad_input() {
        let mut h = MotionHeading::default();
        assert_eq!(h.update(Some((0.0, 0.0)), 0, true), None);
        assert_eq!(h.update(Some((0.0, 5.0)), 100, true), Some((0.0, 1.0)));
        assert_eq!(h.update(Some((0.01, 5.0)), 200, true), Some((0.0, 1.0)));
        assert_eq!(h.update(Some((100.0, 5.0)), 300, true), None);
        h.update(Some((100.0, 10.0)), 400, true);
        assert_eq!(h.update(None, 500, true), None);
        assert_eq!(h.update(Some((0.0, 0.0)), 3000, true), None);
    }
    #[test]
    fn camera_anchors_and_points_forward_up_for_both_bend_directions() {
        for width in [320.0, 736.0] {
            for heading in [(-0.6, 0.8), (0.6, 0.8)] {
                let camera = Camera {
                    width,
                    height: 400.0,
                    car: (20.0, 30.0),
                    heading,
                    mirrored: false,
                };
                let p = camera.project(camera.car).unwrap();
                assert!((p.0 - width * 0.5).abs() < 0.001 && (p.1 - 304.0).abs() < 0.001);
                let ahead = camera.project((20.0 + heading.0 * 20.0, 30.0 + heading.1 * 20.0)).unwrap();
                assert!((ahead.0 - width * 0.5).abs() < 0.001 && ahead.1 < p.1);
            }
        }
    }
    #[test]
    fn iracing_east_stays_right_when_north_is_negative_z() {
        for width in [320.0, 736.0] {
            let camera = Camera {
                width,
                height: 400.0,
                car: (0.0, 0.0),
                heading: (0.0, -1.0),
                mirrored: true,
            };
            let anchor = camera.project(camera.car).unwrap();
            let east = camera.project((10.0, -20.0)).unwrap();
            let west = camera.project((-10.0, -20.0)).unwrap();
            let north = camera.project((0.0, -20.0)).unwrap();
            assert!(east.0 > anchor.0 && west.0 < anchor.0);
            assert!((north.0 - anchor.0).abs() < 0.001 && north.1 < anchor.1);
            assert!((anchor.1 - 304.0).abs() < 0.001);
        }
    }
    #[test]
    fn local_window_wraps_a_closed_real_coordinate_path_but_not_an_open_one() {
        let points: Vec<_> = (0..360)
            .map(|i| {
                let a = (i as f32).to_radians();
                (100.0 * a.cos(), 100.0 * a.sin())
            })
            .collect();
        let closed = PreparedPath::new(&points, true);
        let open = PreparedPath::new(&points, false);
        let car = points[358];
        let heading = unit((-car.1, car.0)).unwrap();
        let c = closed.local(car, heading);
        let o = open.local(car, heading);
        assert!(c.iter().any(|p| p.1 > 50.0));
        assert!(!o.iter().any(|p| p.1 > 50.0));
        assert!(c.len() <= MAX_VERTICES);
    }
    #[test]
    fn missing_positions_and_teleports_never_become_chords() {
        let points = [
            (0.0, 0.0),
            (0.0, 5.0),
            (f32::NAN, 0.0),
            (0.0, 10.0),
            (0.0, 15.0),
            (500.0, 500.0),
            (500.0, 505.0),
        ];
        let path = PreparedPath::new(&points, false);
        assert_eq!(path.runs.len(), 3);
        assert!(path.local((0.0, 5.0), (0.0, 1.0)).iter().all(|p| p.1 <= 5.0));
        let leading_gap = PreparedPath::new(&[(f32::NAN, 0.0), (0.0, 0.0), (0.0, 5.0), (5.0, 5.0)], true);
        assert!(
            !leading_gap.runs[0].closed,
            "a missing endpoint is not repaired by closing the remaining run"
        );
    }
    #[test]
    fn fade_is_screen_space_and_near_clipping_stays_finite() {
        assert_eq!(ground_alpha(280.0, 400.0), 1.0);
        assert!((ground_alpha(344.0, 400.0) - 0.5).abs() < 0.001);
        assert_eq!(ground_alpha(400.0, 400.0), 0.0);
        let camera = Camera {
            width: 320.0,
            height: 400.0,
            car: (0.0, 0.0),
            heading: (0.0, 1.0),
            mirrored: false,
        };
        assert_eq!(camera.project((f32::NAN, 0.0)), None);
        assert_eq!(camera.project((0.0, -1000.0)), None);
        assert!(camera
            .polygon(&[(-5.0, -100.0), (-5.0, 20.0), (5.0, 20.0), (5.0, -100.0)])
            .iter()
            .all(|p| finite(*p)));
        let path = PreparedPath::new(&[(0.0, 0.0), (0.0, 5.0)], false);
        let drawn = scene(camera, &path, None, &path, None);
        assert!(drawn.road.is_empty());
        assert_eq!(drawn.arrow[2], (160.0, 312.0));
    }
}
