//! Verified Laguna Seca collision surfaces, kept distinct from the AI envelope.
//! Source mesh coordinates stay RAW: the caller applies its reader normalization.
//! Only hashes and scene metadata are embedded; no game geometry is distributed.

use super::acevo::{bytes, float, Value, Wire};
use super::package::Package;
use super::{refuse, Boundaries, Refusal};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Seek};

type Result<T> = std::result::Result<T, Refusal>;
const MAX_FILE: usize = 8 * 1024 * 1024;
const MAX_VERTICES: usize = 500_000;
const MAX_TRIANGLES: usize = 500_000;
const MAX_GRID_REFS: usize = 2_000_000;
const MAX_OUTPUT_BANDS: usize = 100_000;
const MAX_CANDIDATE_TESTS: usize = 100_000_000;
const CELL: f64 = 20.;
const JOIN_EPSILON: f64 = 0.0001;
const MAX_ASPHALT_REFERENCE_GAP: f64 = 3.;
const MAX_HEIGHT_DIFFERENCE: f64 = 1.;
pub const MANIFEST_VERSION: &str = "evo-laguna-25170311-surfaces-v1";
const SCENE: &str = "content\\tracks\\laguna_seca\\laguna_seca.scene";
const SCENE_HASH: &str = "56a268d2b8b8f70243e11e31c5633063f24e09c5f890786991c0b9f2a22e410c";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SurfaceClass {
    Asphalt,
    OtherPaved,
    Kerb,
    FlatKerb,
    ExtraTurf,
}
#[derive(Clone, Copy)]
struct Asset {
    path: &'static str,
    sha256: &'static str,
    surface_id: &'static str,
    class: SurfaceClass,
}

#[derive(Clone, Copy, Debug)]
pub struct SurfaceSample {
    pub class: SurfaceClass,
    pub surface_id: &'static str,
    pub y: f32,
}
#[derive(Clone, Debug)]
pub struct SurfaceBand {
    pub class: SurfaceClass,
    /// Signed lateral offsets along RAW normalize((forward.z, -forward.x)).
    pub min_offset: f32,
    pub max_offset: f32,
    pub negative: [f32; 3],
    pub positive: [f32; 3],
}
pub struct SurfaceGeometry {
    /// RAW +normal edge in left*, -normal edge in right*. Reflection requires side swap.
    /// Four NaNs mark unavailable rows. These bounds exclude kerbs/turf/OtherPaved.
    pub asphalt_boundaries: Boundaries,
    /// Average Y of the two selected asphalt edges, not an interior-surface survey.
    pub asphalt_midpoint_y: Vec<f32>,
    /// Zero when the reference lies on asphalt; positive when it is adjacent (e.g. on a kerb).
    pub asphalt_reference_gap_m: Vec<f32>,
    pub point_samples: Vec<Option<SurfaceSample>>,
    /// Separate class bands near the reference, within 64 m lateral and 1 m vertical.
    pub bands: Vec<Vec<SurfaceBand>>,
    pub provenance: &'static str,
    pub triangle_count: usize,
}

fn bad<T>(message: impl Into<String>) -> Result<T> {
    refuse("evo_surface_invalid", message)
}
fn check_hash(data: &[u8], expected: &str) -> Result<()> {
    if format!("{:x}", Sha256::digest(data)) != expected {
        return refuse("evo_surface_unverified", "EVO surface asset changed; source revalidation required");
    }
    Ok(())
}
fn varint(input: &[u8], at: &mut usize) -> Result<u32> {
    let mut value = 0u32;
    for shift in [0, 7, 14, 21, 28] {
        let b = *input.get(*at).ok_or_else(|| Refusal {
            code: "evo_surface_invalid",
            message: "truncated packed index".into(),
        })?;
        *at += 1;
        if shift == 28 && b > 15 {
            return bad("packed index overflow");
        }
        value |= u32::from(b & 127) << shift;
        if b & 128 == 0 {
            return Ok(value);
        }
    }
    bad("unterminated packed index")
}
fn read_floats(value: Value<'_>, output: &mut Vec<f64>, maximum: usize) -> Result<()> {
    match value {
        Value::Bits32(_) => {
            if output.len() >= maximum {
                return bad("too many mesh coordinates");
            }
            output.push(f64::from(float(value)?));
        }
        Value::Bytes(raw) => {
            if raw.len() % 4 != 0 || raw.len() / 4 > maximum.saturating_sub(output.len()) {
                return bad("invalid packed mesh coordinate count");
            }
            for word in raw.as_chunks::<4>().0 {
                let n = f32::from_le_bytes(*word);
                if !n.is_finite() || n.abs() > 100_000. {
                    return bad("invalid mesh coordinate");
                }
                output.push(f64::from(n));
            }
        }
        _ => return bad("invalid mesh coordinate wire type"),
    }
    Ok(())
}
fn read_indices(value: Value<'_>, output: &mut Vec<u32>) -> Result<()> {
    match value {
        Value::Var(n) => {
            if output.len() >= MAX_TRIANGLES * 3 || n > u64::from(u32::MAX) {
                return bad("mesh index bound exceeded");
            }
            output.push(n as u32);
        }
        Value::Bytes(raw) => {
            let mut at = 0;
            while at < raw.len() {
                if output.len() >= MAX_TRIANGLES * 3 {
                    return bad("too many mesh indices");
                }
                output.push(varint(raw, &mut at)?);
            }
        }
        _ => return bad("invalid mesh index wire type"),
    }
    Ok(())
}
#[derive(Clone, Debug)]
struct Triangle {
    p: [[f64; 3]; 3],
    class: SurfaceClass,
    surface_id: &'static str,
}
fn decode_mesh(data: &[u8], asset: Asset) -> Result<Vec<Triangle>> {
    if data.len() > MAX_FILE {
        return bad("mesh exceeds input bound");
    }
    let mut mesh = Wire::new(data);
    let mut lod = None;
    while let Some((field, value)) = mesh.next()? {
        if field == 5 && lod.is_none() {
            lod = Some(bytes(value)?);
        }
    }
    let mut wire = Wire::new(lod.ok_or_else(|| Refusal {
        code: "evo_surface_invalid",
        message: "mesh has no LOD".into(),
    })?);
    let (mut positions, mut indices, mut batches) = (Vec::new(), Vec::new(), Vec::new());
    while let Some((field, value)) = wire.next()? {
        match field {
            5 => read_floats(value, &mut positions, MAX_VERTICES * 3)?,
            11 => read_indices(value, &mut indices)?,
            4 => {
                if batches.len() >= 4096 {
                    return bad("too many mesh batches");
                }
                let (mut start, mut count) = (0u64, 0u64);
                let mut batch = Wire::new(bytes(value)?);
                while let Some((field, value)) = batch.next()? {
                    if field == 2 || field == 3 {
                        let Value::Var(n) = value else {
                            return bad("invalid mesh batch range");
                        };
                        if field == 2 {
                            start = n;
                        } else {
                            count = n;
                        }
                    }
                }
                batches.push((start, count));
            }
            _ => {}
        }
    }
    if positions.is_empty() || positions.len() % 3 != 0 || indices.is_empty() || indices.len() % 3 != 0 {
        return bad("incomplete mesh vertices/triangles");
    }
    if positions.iter().any(|n| !n.is_finite() || n.abs() > 100_000.) {
        return bad("invalid mesh coordinate");
    }
    for (start, count) in batches {
        if start % 3 != 0 || count % 3 != 0 || start.checked_add(count).is_none_or(|end| end > indices.len() as u64) {
            return bad("mesh batch outside index buffer");
        }
    }
    let mut result = Vec::with_capacity(indices.len() / 3);
    for face in indices.as_chunks::<3>().0 {
        let mut p = [[0.; 3]; 3];
        for (row, &index) in p.iter_mut().zip(face) {
            let start = (index as usize).checked_mul(3).ok_or_else(|| Refusal {
                code: "evo_surface_invalid",
                message: "index overflow".into(),
            })?;
            let xyz = positions.get(start..start + 3).ok_or_else(|| Refusal {
                code: "evo_surface_invalid",
                message: "mesh index outside vertices".into(),
            })?;
            row.copy_from_slice(xyz);
        }
        result.push(Triangle {
            p,
            class: asset.class,
            surface_id: asset.surface_id,
        });
    }
    Ok(result)
}

fn xz(p: [f64; 3]) -> [f64; 2] {
    [p[0], p[2]]
}
fn sub(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] - b[0], a[1] - b[1]]
}
fn dot(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
fn cross(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}
fn cell(p: [f64; 2]) -> (i32, i32) {
    ((p[0] / CELL).floor() as i32, (p[1] / CELL).floor() as i32)
}
struct Grid {
    cells: HashMap<(i32, i32), Vec<usize>>,
    broad: Vec<usize>,
    low: [f64; 2],
    high: [f64; 2],
}
impl Grid {
    fn new(triangles: &[Triangle]) -> Result<Self> {
        if triangles
            .iter()
            .flat_map(|t| t.p.iter().flatten())
            .any(|n| !n.is_finite() || n.abs() > 100_000.)
        {
            return bad("invalid spatial triangle coordinate");
        }
        let mut grid = Self {
            cells: HashMap::new(),
            broad: vec![],
            low: [f64::INFINITY; 2],
            high: [f64::NEG_INFINITY; 2],
        };
        let mut references = 0;
        for (i, triangle) in triangles.iter().enumerate() {
            let mut lo = [f64::INFINITY; 2];
            let mut hi = [f64::NEG_INFINITY; 2];
            for p in triangle.p {
                for d in 0..2 {
                    lo[d] = lo[d].min(xz(p)[d] - 1e-6);
                    hi[d] = hi[d].max(xz(p)[d] + 1e-6);
                }
            }
            for d in 0..2 {
                grid.low[d] = grid.low[d].min(lo[d]);
                grid.high[d] = grid.high[d].max(hi[d]);
            }
            let (a, b) = (cell(lo), cell(hi));
            let count = i64::from(b.0 - a.0 + 1) * i64::from(b.1 - a.1 + 1);
            if count > 4096 {
                grid.broad.push(i);
                continue;
            }
            references += count as usize;
            if references > MAX_GRID_REFS {
                return bad("surface spatial index bound exceeded");
            }
            for x in a.0..=b.0 {
                for z in a.1..=b.1 {
                    if grid.cells.len() >= 65_536 && !grid.cells.contains_key(&(x, z)) {
                        return bad("surface spatial cell bound exceeded");
                    }
                    grid.cells.entry((x, z)).or_default().push(i);
                }
            }
        }
        Ok(grid)
    }
    fn point(&self, p: [f64; 3]) -> Vec<usize> {
        let mut result = self.cells.get(&cell(xz(p))).cloned().unwrap_or_default();
        result.extend_from_slice(&self.broad);
        result
    }
    fn line(&self, position: [f64; 2], direction: [f64; 2]) -> Result<Vec<usize>> {
        let (mut lo, mut hi) = (f64::NEG_INFINITY, f64::INFINITY);
        for d in 0..2 {
            if direction[d].abs() < 1e-12 {
                if position[d] < self.low[d] || position[d] > self.high[d] {
                    return Ok(self.broad.clone());
                }
            } else {
                let a = (self.low[d] - position[d]) / direction[d];
                let b = (self.high[d] - position[d]) / direction[d];
                lo = lo.max(a.min(b));
                hi = hi.min(a.max(b));
            }
        }
        if lo > hi {
            return Ok(self.broad.clone());
        }
        let mut times = vec![lo, hi];
        for d in 0..2 {
            if direction[d].abs() < 1e-12 {
                continue;
            }
            let start = (self.low[d] / CELL).floor() as i32 + 1;
            let end = (self.high[d] / CELL).ceil() as i32;
            if end - start > 20_000 {
                return bad("surface query grid extent exceeded");
            }
            for boundary in start..end {
                let t = (f64::from(boundary) * CELL - position[d]) / direction[d];
                if t > lo && t < hi {
                    times.push(t);
                }
            }
        }
        times.sort_by(f64::total_cmp);
        let mut result = self.broad.clone();
        for span in times.windows(2) {
            let t = (span[0] + span[1]) / 2.;
            let key = cell([position[0] + direction[0] * t, position[1] + direction[1] * t]);
            if let Some(ids) = self.cells.get(&key) {
                if result.len() + ids.len() > MAX_GRID_REFS {
                    return bad("surface line candidates exceeded bound");
                }
                result.extend_from_slice(ids);
            }
        }
        result.sort_unstable();
        result.dedup();
        Ok(result)
    }
}
fn height(p: [f64; 3], triangle: &Triangle) -> Option<f64> {
    let [a, b, c] = triangle.p;
    let (v, w, d) = (sub(xz(b), xz(a)), sub(xz(c), xz(a)), sub(xz(p), xz(a)));
    let det = cross(v, w);
    if det.abs() <= 1e-10 {
        return None;
    }
    let (u, t) = (cross(d, w) / det, cross(v, d) / det);
    if u < -1e-6 || t < -1e-6 || u + t > 1.000001 {
        return None;
    }
    Some(a[1] * (1. - u - t) + b[1] * u + c[1] * t)
}
#[derive(Clone, Debug)]
struct Interval {
    class: SurfaceClass,
    low: f64,
    high: f64,
    low_y: f64,
    high_y: f64,
}
fn intersect(p: [f64; 3], forward: [f64; 2], normal: [f64; 2], triangle: &Triangle) -> Option<Interval> {
    let mut hits = Vec::with_capacity(3);
    for edge in [[0, 1], [1, 2], [2, 0]] {
        let a = triangle.p[edge[0]];
        let b = triangle.p[edge[1]];
        let av = dot(sub(xz(a), xz(p)), forward);
        let bv = dot(sub(xz(b), xz(p)), forward);
        let span = bv - av;
        if av * bv > 0. || span.abs() <= 1e-10 {
            continue;
        }
        let t = -av / span;
        let at = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        hits.push((dot(sub(xz(at), xz(p)), normal), at[1]));
    }
    if hits.len() < 2 {
        return None;
    }
    hits.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (a, b) = (hits[0], hits[hits.len() - 1]);
    Some(Interval {
        class: triangle.class,
        low: a.0,
        high: b.0,
        low_y: a.1,
        high_y: b.1,
    })
}
fn merge(mut intervals: Vec<Interval>) -> Vec<Interval> {
    intervals.sort_by(|a, b| (a.class as u8).cmp(&(b.class as u8)).then(a.low.total_cmp(&b.low)));
    let mut result: Vec<Interval> = vec![];
    for interval in intervals {
        if let Some(last) = result.last_mut() {
            if last.class == interval.class
                && interval.low <= last.high + JOIN_EPSILON
                && (interval.low_y - last.high_y).abs() <= MAX_HEIGHT_DIFFERENCE
            {
                if interval.high > last.high {
                    last.high = interval.high;
                    last.high_y = interval.high_y;
                }
                continue;
            }
        }
        result.push(interval);
    }
    result
}
fn gap(interval: &Interval) -> f64 {
    interval.low.max(-interval.high).max(0.)
}
fn at_offset(p: [f64; 3], normal: [f64; 2], offset: f64, y: f64) -> [f32; 3] {
    [(p[0] + normal[0] * offset) as f32, y as f32, (p[2] + normal[1] * offset) as f32]
}

/// Decode the hash-pinned assets and intersect their actual LOD0 triangles.
/// Call from offline/background extraction and cache the result; never call per frame.
pub fn extract<R: Read + Seek>(package: &mut Package<R>, points: &[[f32; 3]], forwards: &[[f32; 3]]) -> Result<SurfaceGeometry> {
    let scene = package.read(SCENE, MAX_FILE).map_err(|e| Refusal {
        code: "evo_surface_missing",
        message: format!("{SCENE}: {e}"),
    })?;
    check_hash(&scene, SCENE_HASH)?;
    drop(scene);
    let mut triangles = Vec::new();
    for &asset in ASSETS {
        let data = package.read(asset.path, MAX_FILE).map_err(|e| Refusal {
            code: "evo_surface_missing",
            message: format!("{}: {e}", asset.path),
        })?;
        check_hash(&data, asset.sha256)?;
        let decoded = decode_mesh(&data, asset)?;
        if triangles.len() + decoded.len() > MAX_TRIANGLES {
            return bad("total surface triangle bound exceeded");
        }
        triangles.extend(decoded);
    }
    compute(&triangles, points, forwards)
}
fn compute(triangles: &[Triangle], points: &[[f32; 3]], forwards: &[[f32; 3]]) -> Result<SurfaceGeometry> {
    if points.is_empty() || points.len() > 8192 || points.len() != forwards.len() || triangles.is_empty() || triangles.len() > MAX_TRIANGLES
    {
        return bad("invalid surface sample/triangle count");
    }
    let grid = Grid::new(triangles)?;
    let mut output = SurfaceGeometry {
        asphalt_boundaries: Boundaries {
            left_x: vec![],
            left_z: vec![],
            right_x: vec![],
            right_z: vec![],
        },
        asphalt_midpoint_y: vec![],
        asphalt_reference_gap_m: vec![],
        point_samples: vec![],
        bands: vec![],
        provenance: MANIFEST_VERSION,
        triangle_count: triangles.len(),
    };
    let mut tests = 0usize;
    let mut output_bands = 0usize;
    for (&p, &f) in points.iter().zip(forwards) {
        if p.iter().chain(f.iter()).any(|n| !n.is_finite() || n.abs() > 100_000.) {
            return bad("invalid surface reference/forward");
        }
        let p = p.map(f64::from);
        let f = [f64::from(f[0]), f64::from(f[2])];
        let length = f[0].hypot(f[1]);
        if length <= 1e-8 {
            return bad("surface reference has no horizontal forward");
        }
        let forward = [f[0] / length, f[1] / length];
        let normal = [forward[1], -forward[0]];
        let candidates = grid.point(p);
        tests += candidates.len();
        let mut sample: Option<(f64, SurfaceSample)> = None;
        for i in candidates {
            let triangle = &triangles[i];
            if let Some(y) = height(p, triangle) {
                let error = (y - p[1]).abs();
                if error <= MAX_HEIGHT_DIFFERENCE && sample.as_ref().is_none_or(|(old, _)| error < *old) {
                    sample = Some((
                        error,
                        SurfaceSample {
                            class: triangle.class,
                            surface_id: triangle.surface_id,
                            y: y as f32,
                        },
                    ));
                }
            }
        }
        output.point_samples.push(sample.map(|(_, sample)| sample));
        let candidates = grid.line(xz(p), normal)?;
        tests += candidates.len();
        if tests > MAX_CANDIDATE_TESTS {
            return bad("surface computation work bound exceeded");
        }
        let intervals = merge(
            candidates
                .into_iter()
                .filter_map(|i| intersect(p, forward, normal, &triangles[i]))
                .filter(|v| {
                    v.low <= 64.
                        && v.high >= -64.
                        && (v.low_y - p[1]).abs() <= MAX_HEIGHT_DIFFERENCE
                        && (v.high_y - p[1]).abs() <= MAX_HEIGHT_DIFFERENCE
                })
                .collect(),
        );
        let asphalt = intervals
            .iter()
            .filter(|v| v.class == SurfaceClass::Asphalt && gap(v) <= MAX_ASPHALT_REFERENCE_GAP)
            .min_by(|a, b| gap(a).total_cmp(&gap(b)));
        let (left, right, y, g) = if let Some(v) = asphalt {
            (
                at_offset(p, normal, v.high, v.high_y),
                at_offset(p, normal, v.low, v.low_y),
                ((v.low_y + v.high_y) / 2.) as f32,
                gap(v) as f32,
            )
        } else {
            ([f32::NAN; 3], [f32::NAN; 3], f32::NAN, f32::NAN)
        };
        output.asphalt_boundaries.left_x.push(left[0]);
        output.asphalt_boundaries.left_z.push(left[2]);
        output.asphalt_boundaries.right_x.push(right[0]);
        output.asphalt_boundaries.right_z.push(right[2]);
        output.asphalt_midpoint_y.push(y);
        output.asphalt_reference_gap_m.push(g);
        output_bands += intervals.len();
        if output_bands > MAX_OUTPUT_BANDS {
            return bad("surface output band bound exceeded");
        }
        output.bands.push(
            intervals
                .into_iter()
                .map(|v| SurfaceBand {
                    class: v.class,
                    min_offset: v.low as f32,
                    max_offset: v.high as f32,
                    negative: at_offset(p, normal, v.low, v.low_y),
                    positive: at_offset(p, normal, v.high, v.high_y),
                })
                .collect(),
        );
    }
    Ok(output)
}

// Scene-verified identity actors. Source enums: Asphalt=0, ExtraTurf=1, Kerb=2, FlatKerb=5.
const ASSETS: &[Asset] = &[
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_001.mesh",
        sha256: "1ea6ba18f0dc33ca29493f13886eebaa6c22377179e220430e52a8b356293b69",
        surface_id: "OUT",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_002.mesh",
        sha256: "a800e6c1ce18627b88fbbebd4eb63ebce3c11f9185f44b51a814a20ecc8cba49",
        surface_id: "OUT",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_broken.mesh",
        sha256: "27819430ccd323824240386b3c3b8cdab52ac00c81dda605c85134dfaec0af7e",
        surface_id: "CNC_OLD",
        class: SurfaceClass::ExtraTurf,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_dark001.mesh",
        sha256: "e954996a886407a3573ece8fb2ebf5f8064fae9b13de91d0037e0155ca353f6b",
        surface_id: "OUT",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_dark002.mesh",
        sha256: "c8a60e68a7f7bc0fdfc4d5219646ecd08920f9dcdc9ac1d3933a80fb601fef0c",
        surface_id: "OUT",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_mid.mesh",
        sha256: "07d90b2aa8587203c4ee4e761fd3e4443c46c98742d9cc6dd177712bdf4b9786",
        surface_id: "ASPH_MID",
        class: SurfaceClass::Asphalt,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_norm001.mesh",
        sha256: "a9da870f532f1da620bbabed4c450be69b52e48c6f2dbcb2722b88c3b6d12f9b",
        surface_id: "ASPH_OLD",
        class: SurfaceClass::Asphalt,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_norm002.mesh",
        sha256: "a0b0075e949955d6b61d4048fa0d6e54f79a73ef0e1cee12642474de0f31f5fc",
        surface_id: "ASPH_OLD",
        class: SurfaceClass::Asphalt,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_norm003.mesh",
        sha256: "d168f019212052663c70cad7679077c0481bba97e4751f3f9b768f1fa620c711",
        surface_id: "ASPH_OLD",
        class: SurfaceClass::Asphalt,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_norm004.mesh",
        sha256: "e0ed9573fe6b93f20c3a153b4590cde1864ff4f030e69e2d8a10ce92ee55b158",
        surface_id: "ASPH_OLD",
        class: SurfaceClass::Asphalt,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_norm005.mesh",
        sha256: "c2fe2892824236aeba9e5987b6587a9cfb14b358d3051e18fda451da8a455fa9",
        surface_id: "ASPH_OLD",
        class: SurfaceClass::Asphalt,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_norm006.mesh",
        sha256: "0031059516d9aaf142a45d2f74e89b72454dcf18a914044e9a7390b1736dc174",
        surface_id: "ASPH_OLD",
        class: SurfaceClass::Asphalt,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_norm007.mesh",
        sha256: "f9ba943a574d62a0e285a9f5dfaeadbfa8cb90e4cf564d93269468a114e25a74",
        surface_id: "ASPH_OLD",
        class: SurfaceClass::Asphalt,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_special.mesh",
        sha256: "dd41d7928da5badb4f833782d499fa604d123125cef4306af94af7674389e2a2",
        surface_id: "OUT",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\concrete001.mesh",
        sha256: "cadf16063bc06b4c907ff51a398dd631e34e8e0109695a90db4d0b729015b2ff",
        surface_id: "CONCRETE",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\concrete002.mesh",
        sha256: "ce0f48fe005f42d74c51506110a65efbd8cc3262f805f317bd1f3f2d76299ee0",
        surface_id: "CONCRETE",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\concrete_box002.mesh",
        sha256: "98badd018c693a67c76fa5550412f27147da938443f0e7280f9d26ec11e98035",
        surface_id: "CONCRETE",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb001.mesh",
        sha256: "b43f90c88f0251653824c9b4588ed2bc26b83be7601f466ae95113939c758043",
        surface_id: "CURB",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb002.mesh",
        sha256: "f47a4fd8bc55f59d64f116866ff83152a0f62ca872c388411d39d05fabba2846",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb003.mesh",
        sha256: "14e8225ddf2d4a2ed245de4f9d008fbd78f93ff25204eb183af0ab262a59b4f4",
        surface_id: "CURB",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb004.mesh",
        sha256: "fc6e36cc320c1d2ed780f9810480e7fb5552c77d266713e3854eb0da9112f096",
        surface_id: "CURB",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb005.mesh",
        sha256: "43a28136066c4722448d4a2e76236b6605fdfb4fea048b1098ee8125acd38351",
        surface_id: "CURB",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb006.mesh",
        sha256: "0d15f0ed0307a7ebc9688799c01ba9aeb144a16367c9f1196840b3d19ed09b68",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb007.mesh",
        sha256: "91fa75f50145b12558541260494ec80edfe3257de86ac0b8c5f77c6ab69ce0bc",
        surface_id: "CURB",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb008.mesh",
        sha256: "bb4c19bc3302be9663b25d81554765155b61243dbfa75a35fb0c3009af383b5f",
        surface_id: "CURB",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb009.mesh",
        sha256: "b0fbd551b591fe83230e39fab17b67195ce384814120bb0ef2200469cb4014d6",
        surface_id: "CURB",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb010.mesh",
        sha256: "aaae5d9b7ea45a86ec67878b00f381811dd5f19c9587362a5771d0c536689df3",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb011.mesh",
        sha256: "7bbdd7a54f85a71d7a40901410bdcbd5edc401f907cbb7546579b0412b88bcbb",
        surface_id: "CURB",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb012.mesh",
        sha256: "06bd7e48edb02b5f0283341b862a197c289724c93ea3894d048dd6830474eaf8",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb013.mesh",
        sha256: "2ba9c3763e7d315e4f5362d84b77375cf2515b71a7b2cafab1563031c566671b",
        surface_id: "CURB",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb014.mesh",
        sha256: "f37fe8fa03425fc398745930a88b83540b25a25e4e6cb25eb84f82ec3298ebd2",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\drains001.mesh",
        sha256: "1d41f4ceb28e7bcef8d465363a6ed8791dcbd3044a0211f058b3563f55dd1c24",
        surface_id: "DRAIN",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\drains002.mesh",
        sha256: "f2178ca09234cf2700b555489130c2237598538ddec71c5575d256067411175e",
        surface_id: "DRAIN",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\drains003.mesh",
        sha256: "01500e59b777ab6a4d8398993e097b34a0c3f46c7260ef5eb036fa449bb61eac",
        surface_id: "DRAIN",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\drains004.mesh",
        sha256: "d9be81286daa77e02d4723b50a2ed26ada50abb07e6775ce9d6ff9b44bede539",
        surface_id: "DRAIN",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\green_concrete002.mesh",
        sha256: "f686fcce1a824284da8d37bad89761767455747d7593a1da783376cce017b66f",
        surface_id: "CONCRETE",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\mesh81749.mesh",
        sha256: "e5963554d9943e333372839b70becec76361bb32d2ad48cdbf5c8b96534b476e",
        surface_id: "CONCRETE",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\mesh81750.mesh",
        sha256: "150cbb5389a1bda711aa9e8ec076841c018fe8fb88c71c851cffe83ec2fef23f",
        surface_id: "CONCRETE",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\mesh81752.mesh",
        sha256: "6095e1c605efa6c057fdc32059db27c9c4eafffbf600715f6415ef78d944e116",
        surface_id: "CONCRETE",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\mesh81753.mesh",
        sha256: "fbca4b73b49b11912f5b4aeeb89819c0dd0ee01d9eb8313fd7adc7301532513a",
        surface_id: "CONCRETE",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\mesh81754.mesh",
        sha256: "0f5cc7c9a2e90d26861a1d1f9efbc0f08a5e313a8682b32bf52caf9af2c8d5d6",
        surface_id: "CONCRETE",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\red_curb001.mesh",
        sha256: "a3ee3e24f5000429f91679076a0dfba7610af1fb6ed822c93525a2226f7c9e43",
        surface_id: "RUMBLE",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\red_curb002.mesh",
        sha256: "c911b90734efab6b4840ff939cfa0d0038ff602eb1e80faea45ffd72a510db7b",
        surface_id: "RUMBLE",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\red_curb003.mesh",
        sha256: "a4b3ff51caba5a31330da18c91bde70b8fecce839eae1d1fd99e61bd28b8b04c",
        surface_id: "RUMBLE",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\red_curb004.mesh",
        sha256: "6d299255ef5df23d7b06840d06bd063941e5f2b183bfcf2ca1e8496eace281fe",
        surface_id: "RUMBLE",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\red_curb005.mesh",
        sha256: "2277a5bd7966ff89617b2734b46e4d7181624bf69afd0df7b9c8ee0bf6894db0",
        surface_id: "RUMBLE",
        class: SurfaceClass::FlatKerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\Asphalt_special_2.mesh",
        sha256: "184db1d6b2d0ed63a3c3145cead21019a386d1056097615433e14208366d1db0",
        surface_id: "OUT",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_special_3.mesh",
        sha256: "7d4fc5eb36ebad8807424ea68070757ebc9970dab2f6230d7bf41bd074aaa405",
        surface_id: "OUT",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_norm002b.mesh",
        sha256: "b2567eae34dd1b313210e31923417fe2c82725e2c94b73b03454b55b48ae93b4",
        surface_id: "ASPH_OLD",
        class: SurfaceClass::Asphalt,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\asphalt_norm002c.mesh",
        sha256: "413f61118af9219145888ee020977e534e8826fda4a31e197832a65fc6e7190e",
        surface_id: "ASPH_OLD",
        class: SurfaceClass::Asphalt,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\physics\\box_ground_collision.mesh",
        sha256: "5bac2d4b364a4b74b7b5bd9c229cfc7938cfd59723353c16041863c75ac3da40",
        surface_id: "OUT",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\sensor_green.mesh",
        sha256: "c1fc9169b4a94538213ac548bfa51886bc2c9a11e2a5a18e93d571243e536eb4",
        surface_id: "CONCRETE",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\sensor_yellow.mesh",
        sha256: "f1a9a8f4efd11a31018015ab40540f17488bb2f275ad6b77372c9a3b07252beb",
        surface_id: "CONCRETE",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\bump_yellow.mesh",
        sha256: "9941e4bfeeb3170888360d7d506d55a2aa4743b671d3f92c5d75995aaecee00e",
        surface_id: "CONCRETE",
        class: SurfaceClass::OtherPaved,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb004_b.mesh",
        sha256: "308cbf70e058a2c1b89903d42b5d977444b7d020d005af5e593d16f3ba62e1b9",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb004_c.mesh",
        sha256: "29d8925ac75da96d8aa0e8c13a326f610de11e822ca8ed0a32e24c46bcca7153",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb004_d.mesh",
        sha256: "3c64158846441e8fa4dbbbe32b0aaa815be156bc0023d786fae5d2e200963873",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb004_e.mesh",
        sha256: "21ee8363443b35c4fa764c8db41b320ba358149d96b435b77e2717d257639937",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb004_f.mesh",
        sha256: "484847358103ab6f5147975d0e964d6e7fa3bcb022f09896243ca50986adabd4",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb004_g.mesh",
        sha256: "9bbd4e33e481532b9439be3af65a2472a9f3fd45a8df0c57e349e28de10598e7",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb006_b.mesh",
        sha256: "fb6705aa61e4cf8acd591b66f530907d59de68585f6f934a2b688046b25a38d0",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb006_b001.mesh",
        sha256: "684c985ba247787ac7f1674b743725484560959d5faa71fe994a7a970aa84422",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb006_c.mesh",
        sha256: "479c77ea89acc492ae5421c9982b07e0c2136b3c4179eae3904e21c4249f3abd",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb006_e.mesh",
        sha256: "228f659ce353225f53dd8575fd9f2985fd1e256d18be72a324e3e0bd9c848749",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb008_b.mesh",
        sha256: "844d66e30023141943ef27821e68e7a093872a85a7f7ef7e2ea16c120f76b1dd",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb008_c.mesh",
        sha256: "4514898c3c85a9a88f466da326db9479012e6f478e21b1c65c705089bababb6d",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb008_d.mesh",
        sha256: "0eac226b66b291aca5ac3bb377a333e8b597181399d1811a30265a97802f0de5",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb008_e.mesh",
        sha256: "973b2a589f4599a540ec2190b4f87882cb331d34d53f8321b21ed6b4b385a68a",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb008_f.mesh",
        sha256: "d108e2b82d8d8e350f8b000385cdebe3caacb75470cbf5293e1eef1cc85dbbba",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb010_b.mesh",
        sha256: "d98cedc620d904c599658162bb369c603266d09145943019b9031cfd1b0c397c",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb010_c.mesh",
        sha256: "d12bf7402f78fb2fd0ce050f3635fab1951bc4e30c7e682f29ef74529c9496b1",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb012_b.mesh",
        sha256: "774849346046a970f7d9ec77b250377045afc11f4256581c21ef49db8ea374c4",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb012_c.mesh",
        sha256: "29ffa927caaaca7310bbc93665385663a14f30c29d848952b5af2e7e145daaf5",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb012_d.mesh",
        sha256: "2f23c1f2e92b171325cab6447d0c44e471c0df35d1b5a299eeb4291004507934",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb014_b.mesh",
        sha256: "4090c2e510b55c631835945849051433c34717fdf1719b4e7edc58da8746fcfd",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb014_c.mesh",
        sha256: "6dcb6f5f185945f48d822afd779add22243ee513bbbe04e3579d0d948983573a",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb014_e.mesh",
        sha256: "eb3abb9bd13b23ca199090077a0d771d210923bda529517c08b6b13ca735b1bd",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
    Asset {
        path: "content\\tracks\\laguna_seca\\static_mesh\\curb014_f.mesh",
        sha256: "ca467316bcf1542c76eeedff0a3f9abc7b2d6e38b8a8adfa37b50227ffb6e847",
        surface_id: "KERB",
        class: SurfaceClass::Kerb,
    },
];

#[cfg(test)]
mod tests {
    use super::*;
    fn triangle(p: [[f64; 3]; 3], class: SurfaceClass) -> Triangle {
        Triangle {
            p,
            class,
            surface_id: "SYNTHETIC",
        }
    }
    fn rectangle(x0: f64, x1: f64, z0: f64, z1: f64, y: f64, class: SurfaceClass) -> Vec<Triangle> {
        vec![
            triangle([[x0, y, z0], [x1, y, z0], [x1, y, z1]], class),
            triangle([[x0, y, z0], [x1, y, z1], [x0, y, z1]], class),
        ]
    }
    fn interval(low: f64, high: f64, y: f64, class: SurfaceClass) -> Interval {
        Interval {
            class,
            low,
            high,
            low_y: y,
            high_y: y,
        }
    }
    #[test]
    fn asphalt_edges_are_raw_and_preserve_reference_on_kerb() {
        let mut mesh = rectangle(-4., 4., -5., 5., 10., SurfaceClass::Asphalt);
        mesh.extend(rectangle(4., 5., -5., 5., 10.1, SurfaceClass::Kerb));
        let out = compute(&mesh, &[[4.5, 10.1, 0.]], &[[0., 0., 1.]]).unwrap();
        assert_eq!(out.asphalt_boundaries.left_x, vec![4.]);
        assert_eq!(out.asphalt_boundaries.right_x, vec![-4.]);
        assert!((out.asphalt_reference_gap_m[0] - 0.5).abs() < 1e-5);
        assert_eq!(out.point_samples[0].unwrap().class, SurfaceClass::Kerb);
        assert!(out.bands[0].iter().any(|b| b.class == SurfaceClass::Kerb));
        assert_eq!(out.asphalt_midpoint_y, vec![10.]);
    }
    #[test]
    fn classes_small_real_gaps_and_bridge_layers_remain_distinct() {
        let merged = merge(vec![
            interval(-4., 0., 0., SurfaceClass::Asphalt),
            interval(0.001, 4., 0., SurfaceClass::Asphalt),
            interval(4., 5., 0., SurfaceClass::Kerb),
        ]);
        assert_eq!(merged.len(), 3); // A 1 mm physical gap is not filled by a 2 cm tolerance.
        let touching = merge(vec![
            interval(-4., 0., 0., SurfaceClass::Asphalt),
            interval(0.00005, 4., 0., SurfaceClass::Asphalt),
        ]);
        assert_eq!(touching.len(), 1);
        let mut mesh = rectangle(-4., 4., -5., 5., 0., SurfaceClass::Asphalt);
        mesh.extend(rectangle(-10., 10., -5., 5., 5., SurfaceClass::Asphalt));
        let out = compute(&mesh, &[[0., 0., 0.]], &[[0., 0., 1.]]).unwrap();
        assert_eq!(out.asphalt_boundaries.left_x, vec![4.]);
        assert_eq!(out.asphalt_boundaries.right_x, vec![-4.]);
        assert_eq!(out.point_samples[0].unwrap().y, 0.);
    }
    #[test]
    fn unknown_rows_are_four_nans_and_bad_forwards_refuse() {
        let mesh = rectangle(-4., 4., -5., 5., 0., SurfaceClass::Asphalt);
        let out = compute(&mesh, &[[20., 0., 0.]], &[[0., 0., 1.]]).unwrap();
        assert!(out.asphalt_boundaries.left_x[0].is_nan());
        assert!(out.asphalt_boundaries.left_z[0].is_nan());
        assert!(out.asphalt_boundaries.right_x[0].is_nan());
        assert!(out.asphalt_boundaries.right_z[0].is_nan());
        assert!(compute(&mesh, &[[0., 0., 0.]], &[[0.; 3]]).is_err());
        assert!(compute(&mesh, &[[f32::NAN, 0., 0.]], &[[0., 0., 1.]]).is_err());
        assert!(compute(&mesh, &[], &[]).is_err());
    }
    fn var(mut n: u64) -> Vec<u8> {
        let mut out = vec![];
        loop {
            let more = n >> 7;
            out.push((n as u8 & 127) | if more > 0 { 128 } else { 0 });
            if more == 0 {
                return out;
            }
            n = more;
        }
    }
    fn blob(field: u32, data: &[u8]) -> Vec<u8> {
        let mut out = var(u64::from(field) * 8 + 2);
        out.extend(var(data.len() as u64));
        out.extend(data);
        out
    }
    fn mesh(positions: &[f32], indices: &[u8]) -> Vec<u8> {
        let bytes: Vec<_> = positions.iter().flat_map(|n| n.to_le_bytes()).collect();
        let mut lod = blob(5, &bytes);
        lod.extend(blob(11, indices));
        blob(5, &lod)
    }
    const SYNTHETIC: Asset = Asset {
        path: "synthetic",
        sha256: "",
        surface_id: "ROAD",
        class: SurfaceClass::Asphalt,
    };
    #[test]
    fn bounded_mesh_wire_handles_packed_fields_and_rejects_hostile_input() {
        let valid = mesh(&[0., 0., 0., 1., 0., 0., 0., 0., 1.], &[0, 1, 2]);
        assert_eq!(decode_mesh(&valid, SYNTHETIC).unwrap().len(), 1);
        for invalid in [
            vec![],
            vec![42, 255],
            mesh(&[0., 0.], &[0, 0, 0]),
            mesh(&[0., 0., 0.], &[0, 1, 0]),
            mesh(&[f32::NAN, 0., 0.], &[0, 0, 0]),
            mesh(&[0., 0., 0.], &[255, 255, 255, 255, 255, 0, 0]),
        ] {
            assert!(decode_mesh(&invalid, SYNTHETIC).is_err());
        }
        let huge = vec![0; MAX_FILE + 1];
        assert!(decode_mesh(&huge, SYNTHETIC).is_err());
        assert!(check_hash(b"changed", SCENE_HASH).is_err());
    }
    #[test]
    fn grid_covers_negative_cells_and_exact_boundaries() {
        let mesh = rectangle(-40., 40., -40., 40., 0., SurfaceClass::Asphalt);
        let grid = Grid::new(&mesh).unwrap();
        for p in [[-20., 0., -20.], [0., 0., 0.], [20., 0., 20.]] {
            let candidates = grid.point(p);
            assert!(!candidates.is_empty());
            for f in [[0., 1.], [1., 0.], [1., 1.]] {
                let candidates = grid.line(xz(p), f).unwrap();
                assert_eq!(candidates, vec![0, 1]);
            }
        }
    }
    #[test]
    #[ignore = "requires local proprietary EVO package; no game assets committed"]
    fn real_source_surfaces_match_independent_local_geometry() {
        let path = std::env::var("XPEED_EVO_SURFACE_PACKAGE").expect("set XPEED_EVO_SURFACE_PACKAGE");
        let mut package = Package::open(std::path::Path::new(&path)).unwrap();
        let ideal = package
            .read(
                "content\\tracks\\laguna_seca\\layouts\\layout_laguna_seca.ideal_line.aisplinedata",
                8 * 1024 * 1024,
            )
            .unwrap();
        check_hash(&ideal, super::super::acevo::VERIFIED_IDEAL_SHA256).unwrap();
        let (mut points, mut forwards) = (vec![], vec![]);
        let mut top = Wire::new(&ideal);
        while let Some((field, value)) = top.next().unwrap() {
            if field == 1 {
                let mut spline = Wire::new(bytes(value).unwrap());
                while let Some((field, value)) = spline.next().unwrap() {
                    if field != 1 {
                        continue;
                    }
                    let mut point = Wire::new(bytes(value).unwrap());
                    while let Some((field, value)) = point.next().unwrap() {
                        if field == 1 {
                            points.push(super::super::acevo::vector(bytes(value).unwrap()).unwrap());
                        }
                    }
                }
            } else if field == 2 {
                let mut payload = Wire::new(bytes(value).unwrap());
                while let Some((field, value)) = payload.next().unwrap() {
                    if field == 10 {
                        forwards.push(super::super::acevo::vector(bytes(value).unwrap()).unwrap());
                    }
                }
            }
        }
        let result = extract(&mut package, &points, &forwards).unwrap();
        assert_eq!(result.provenance, MANIFEST_VERSION);
        assert!(result.point_samples.iter().flatten().all(|s| !s.surface_id.is_empty()));
        assert_eq!(result.triangle_count, 90_646);
        assert_eq!(points.len(), 2_135);
        assert_eq!(result.point_samples.iter().filter(|s| s.is_some()).count(), 2_135);
        let max_height = result
            .point_samples
            .iter()
            .zip(&points)
            .map(|(s, p)| (s.unwrap().y - p[1]).abs())
            .fold(0f32, f32::max);
        assert!(max_height < 0.0001, "max source height error={max_height}");
        let gaps = result.asphalt_reference_gap_m.iter().filter(|n| !n.is_finite()).count();
        eprintln!(
            "surface triangles={} asphalt unavailable={} max point-height error={max_height}",
            result.triangle_count, gaps
        );
        if let Ok(path) = std::env::var("XPEED_EVO_SURFACE_OUTPUT") {
            let rows:Vec<_>=(0..points.len()).map(|i|serde_json::json!({"asphalt":[result.asphalt_boundaries.left_x[i],result.asphalt_boundaries.left_z[i],result.asphalt_boundaries.right_x[i],result.asphalt_boundaries.right_z[i]],"midpointY":result.asphalt_midpoint_y[i],"referenceGapM":result.asphalt_reference_gap_m[i],"sampleY":result.point_samples[i].map(|p|p.y),"sampleClass":result.point_samples[i].map(|p|format!("{:?}",p.class)),"bands":result.bands[i].iter().map(|b|serde_json::json!({"class":format!("{:?}",b.class),"min":b.min_offset,"max":b.max_offset,"negative":b.negative,"positive":b.positive})).collect::<Vec<_>>()})).collect();
            std::fs::write(path, serde_json::to_vec(&rows).unwrap()).unwrap();
        }
    }
}
