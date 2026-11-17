//! Hash-pinned Laguna Seca reader for EVO AISplineData, loose or in KSPackage.
//! The schema was recovered from the installed game's AIData.proto and Math.proto.
//! Only selected package entries are read. Installed game files are never modified.

use super::*;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

const LAYOUT: &str = "content\\tracks\\laguna_seca\\containers\\layout_laguna_seca";
const MAX_INPUT: usize = 64 * 1024 * 1024;
pub(crate) const VERIFIED_IDEAL_SHA256: &str = "b547920c27c1e5732567ad078213aa0cd3afe1b536e9f0ffc24dd22df915409e";
pub(crate) const VERIFIED_PIT_SHA256: &str = "c3c81c4a4ce1f126eab78a695fde2e4099e4d1a5ea9599e2772e44e4aaaf03bf";
pub(crate) const VERIFIED_BUILD: &str = "25170311";
type Result<T> = std::result::Result<T, Refusal>;

fn bad<T>(message: impl Into<String>) -> Result<T> {
    refuse("evo_invalid", message)
}

/// A bounded protobuf wire reader. Nested messages are borrowed slices; unknown fields
/// use their declared wire lengths, never a guessed message shape.
pub(super) struct Wire<'a> {
    bytes: &'a [u8],
    at: usize,
}
pub(super) enum Value<'a> {
    Var(u64),
    Bits64([u8; 8]),
    Bytes(&'a [u8]),
    Bits32([u8; 4]),
}
impl<'a> Wire<'a> {
    pub(super) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.at.checked_add(n).ok_or_else(|| Refusal {
            code: "evo_invalid",
            message: "wire length overflow".into(),
        })?;
        let b = self.bytes.get(self.at..end).ok_or_else(|| Refusal {
            code: "evo_invalid",
            message: "truncated protobuf field".into(),
        })?;
        self.at = end;
        Ok(b)
    }
    fn var(&mut self) -> Result<u64> {
        let mut n = 0u64;
        for i in 0..10 {
            let b = self.take(1)?[0];
            if i == 9 && b > 1 {
                return bad("protobuf varint overflow");
            }
            n |= u64::from(b & 127) << (7 * i);
            if b & 128 == 0 {
                return Ok(n);
            }
        }
        bad("unterminated protobuf varint")
    }
    pub(super) fn next(&mut self) -> Result<Option<(u32, Value<'a>)>> {
        if self.at == self.bytes.len() {
            return Ok(None);
        }
        let key = self.var()?;
        let field = key >> 3;
        if field == 0 || field > 0x1fff_ffff {
            return bad("invalid protobuf field number");
        }
        let value = match key & 7 {
            0 => Value::Var(self.var()?),
            1 => Value::Bits64(self.take(8)?.try_into().unwrap()),
            2 => {
                let n = usize::try_from(self.var()?).map_err(|_| Refusal {
                    code: "evo_invalid",
                    message: "wire length exceeds address space".into(),
                })?;
                Value::Bytes(self.take(n)?)
            }
            5 => Value::Bits32(self.take(4)?.try_into().unwrap()),
            _ => return bad("unsupported protobuf wire type (groups are not used by this schema)"),
        };
        Ok(Some((field as u32, value)))
    }
}
pub(super) fn bytes<'a>(v: Value<'a>) -> Result<&'a [u8]> {
    if let Value::Bytes(b) = v {
        Ok(b)
    } else {
        bad("expected protobuf message/string")
    }
}
pub(super) fn float(v: Value<'_>) -> Result<f32> {
    if let Value::Bits32(b) = v {
        let n = f32::from_le_bytes(b);
        if n.is_finite() {
            return Ok(n);
        }
    }
    bad("expected finite protobuf float")
}
fn text(v: Value<'_>) -> Result<String> {
    let b = bytes(v)?;
    if b.len() > 1024 {
        return bad("protobuf text too long");
    }
    std::str::from_utf8(b).map(str::to_owned).map_err(|_| Refusal {
        code: "evo_invalid",
        message: "invalid UTF-8 text".into(),
    })
}
pub(super) fn vector(b: &[u8]) -> Result<[f32; 3]> {
    let mut p = [0.0; 3]; // Proto3 omits zero components.
    let mut w = Wire::new(b);
    while let Some((f, v)) = w.next()? {
        if (1..=3).contains(&f) {
            p[f as usize - 1] = float(v)?;
        }
    }
    Ok(p)
}
#[derive(Default)]
struct Payload {
    sides: [f32; 2],
    forward: Option<[f32; 3]>,
}
struct Spline {
    points: Vec<[f32; 3]>,
    dist: Vec<f32>,
    payloads: Vec<Payload>,
    length: f64,
    closed: bool,
    layout: String,
    title: Option<String>,
}

fn parse(input: &[u8]) -> Result<Spline> {
    if input.len() > MAX_INPUT {
        return bad("input exceeds 64 MiB");
    }
    let mut s = Spline {
        points: vec![],
        dist: vec![],
        payloads: vec![],
        length: 0.0,
        closed: false,
        layout: String::new(),
        title: None,
    };
    let mut top = Wire::new(input);
    let mut has_spline = false;
    while let Some((f, v)) = top.next()? {
        match f {
            1 => {
                if has_spline {
                    return bad("duplicate spline message");
                }
                has_spline = true;
                let mut w = Wire::new(bytes(v)?);
                while let Some((f, v)) = w.next()? {
                    match f {
                        1 => {
                            if s.points.len() >= MAX_POINTS {
                                return bad("too many spline points");
                            }
                            let mut p = None;
                            let mut d = 0.0;
                            let mut point = Wire::new(bytes(v)?);
                            while let Some((f, v)) = point.next()? {
                                match f {
                                    1 => p = Some(vector(bytes(v)?)?),
                                    2 => d = float(v)?,
                                    _ => {}
                                }
                            }
                            s.points.push(p.ok_or_else(|| Refusal {
                                code: "evo_invalid",
                                message: "spline point has no position message".into(),
                            })?);
                            s.dist.push(d);
                        }
                        2 => {
                            if let Value::Bits64(b) = v {
                                s.length = f64::from_le_bytes(b);
                            } else {
                                return bad("expected spline length double");
                            }
                        }
                        3 => {
                            if let Value::Var(b) = v {
                                if b > 1 {
                                    return bad("invalid closed boolean");
                                }
                                s.closed = b == 1;
                            } else {
                                return bad("expected closed boolean");
                            }
                        }
                        _ => {}
                    }
                }
            }
            2 => {
                if s.payloads.len() >= MAX_POINTS {
                    return bad("too many spline payloads");
                }
                let mut p = Payload::default();
                let mut w = Wire::new(bytes(v)?);
                while let Some((f, v)) = w.next()? {
                    match f {
                        3 => p.sides[0] = float(v)?,
                        4 => p.sides[1] = float(v)?,
                        9 => {
                            vector(bytes(v)?)?;
                        }
                        10 => p.forward = Some(vector(bytes(v)?)?),
                        _ => {}
                    }
                }
                s.payloads.push(p);
            }
            5 => s.layout = text(v)?,
            8 => {
                let mut w = Wire::new(bytes(v)?);
                while let Some((f, v)) = w.next()? {
                    if f == 2 {
                        s.title = Some(text(v)?);
                    }
                }
            }
            _ => {}
        }
    }
    if !(2..=MAX_POINTS).contains(&s.points.len()) || s.points.len() != s.payloads.len() {
        return bad("spline/payload counts differ or contain fewer than two points");
    }
    if !s.length.is_finite() || !(0.0..=MAX_LENGTH_M).contains(&s.length) || s.length == 0.0 {
        return bad("invalid spline length");
    }
    for (i, d) in s.dist.iter().enumerate() {
        if *d < 0.0 || (i > 0 && *d < s.dist[i - 1]) {
            return bad("point_length is negative or goes backwards");
        }
    }
    let mut chord: f64 = s
        .points
        .windows(2)
        .map(|p| (0..3).map(|a| f64::from(p[1][a] - p[0][a]).powi(2)).sum::<f64>().sqrt())
        .sum();
    if s.closed {
        let a = s.points[0];
        let b = s.points[s.points.len() - 1];
        let gap = (0..3).map(|i| f64::from(a[i] - b[i]).powi(2)).sum::<f64>().sqrt();
        if gap > MAX_CLOSE_GAP_M {
            return bad("closed spline endpoints are more than 50 m apart");
        }
        chord += gap;
    }
    if (chord - s.length).abs() > s.length * 0.02 {
        return bad("spline length differs from its polyline by more than 2%");
    }
    if f64::from(*s.dist.last().unwrap()) > s.length * 1.02 {
        return bad("point_length exceeds spline length");
    }
    Ok(s)
}

fn read_bounded(path: &Path) -> Result<Vec<u8>> {
    let f = std::fs::File::open(path).map_err(|e| Refusal {
        code: "evo_read",
        message: format!("cannot read {}: {e}", path.display()),
    })?;
    let mut b = Vec::new();
    f.take(MAX_INPUT as u64 + 1).read_to_end(&mut b).map_err(|e| Refusal {
        code: "evo_read",
        message: e.to_string(),
    })?;
    if b.len() > MAX_INPUT {
        return bad("input exceeds 64 MiB");
    }
    Ok(b)
}

// Side orientation was checked against the source's named control-point sides.
// Explicit borders avoid approximating native forward vectors with line tangents.
fn convert(s: Spline, input: &[u8]) -> Result<Extracted> {
    if s.layout != LAYOUT {
        return bad("only the verified Laguna Seca GP layout is supported by this pilot");
    }
    if !s.closed {
        return bad("Laguna Seca GP ideal line must be closed");
    }
    let n = s.points.len();
    let x: Vec<f32> = s.points.iter().map(|p| -p[0]).collect();
    let y = s.points.iter().map(|p| p[1]).collect();
    let z: Vec<f32> = s.points.iter().map(|p| p[2]).collect();
    let fast = Fast {
        x: x.clone(),
        z: z.clone(),
    };
    let mut boundaries = Boundaries {
        left_x: Vec::with_capacity(n),
        left_z: Vec::with_capacity(n),
        right_x: Vec::with_capacity(n),
        right_z: Vec::with_capacity(n),
    };
    for (i, payload) in s.payloads.iter().enumerate() {
        // Named control points in the recovered source confirm sides_0 = source
        // left and sides_1 = source right. Reflecting x reverses our normal.
        // Signed sides are essential when the ideal line leaves the AI side envelope.
        let [right, left] = payload.sides;
        let span = left + right;
        if !span.is_finite() || span <= 0.0 || left.abs() > MAX_SIDE_M || right.abs() > MAX_SIDE_M {
            return bad("signed sides do not define a positive road width within 200 m of the line");
        }
        let normal = if let Some(f) = payload.forward {
            let len = f64::from(f[0]).hypot(f64::from(f[2]));
            if len <= 1e-6 {
                return bad("zero horizontal forward vector");
            }
            (f64::from(f[2]) / len, f64::from(f[0]) / len)
        } else {
            return bad("missing native forward vector: exact road edges cannot be recovered");
        };
        let (px, pz) = (f64::from(x[i]), f64::from(z[i]));
        boundaries.left_x.push((px + normal.0 * f64::from(left)) as f32);
        boundaries.left_z.push((pz + normal.1 * f64::from(left)) as f32);
        boundaries.right_x.push((px - normal.0 * f64::from(right)) as f32);
        boundaries.right_z.push((pz - normal.1 * f64::from(right)) as f32);
    }
    let mut report = Report::default();
    report.notes.push(format!(
        "source SHA256 {:x}; {} spline points; source length {:.3} m",
        Sha256::digest(input),
        n,
        s.length
    ));
    let negative = s.payloads.iter().filter(|p| p.sides.iter().any(|v| *v < 0.0)).count();
    report.notes.push(format!(
        "signed source sides retained during parsing; {negative} points have a negative side (ideal line outside the native AI side envelope)"
    ));
    report
        .notes
        .push("XTRK v2 explicit borders preserve reflected source forward-vector offsets without midpoint/tangent reconstruction; native sampled AI side envelope, not an asphalt mesh or white-line survey".into());
    report
        .notes
        .push("Verified pilot source: Steam build 25170311; telemetry identity Laguna Seca / GP".into());
    let jumps = s
        .points
        .windows(2)
        .filter(|p| (p[1][0] - p[0][0]).hypot(p[1][2] - p[0][2]) > 40.0)
        .count();
    if jumps > 0 {
        report
            .warnings
            .push(format!("{jumps} source segments exceed 40 m; local rendering may split these gaps"));
    }
    report
        .warnings
        .push("EVO pilot: sampled spline approximation; road banking and separate edge elevations are not represented".into());
    let track = Track {
        game: "acevo".into(),
        name: "Laguna Seca".into(),
        variant: Some("GP".into()),
        title: s.title,
        length_m: Some(round_cm(s.length)),
        source: "aisplinedata".into(),
        frame: "EVO world metres normalized to telemetry: x=-source.x, y=source.y, z=source.z; y is up".into(),
        closed: true,
        center_kind: "game_line".into(),
        centerline: Centerline {
            x,
            y,
            z,
            dist: s.dist,
            left: vec![f32::NAN; n],
            right: vec![f32::NAN; n],
        },
        fast: Some(fast),
        pitlane: None,
        boundaries: Some(boundaries),
    };
    check(&track).map_err(|e| Refusal {
        code: "evo_invalid",
        message: e.message,
    })?;
    Ok(Extracted { track, report })
}

pub fn extract(path: &Path) -> Result<Extracted> {
    if path.is_dir() || path.extension().is_some_and(|e| e.eq_ignore_ascii_case("kspkg")) {
        let package_path = if path.is_dir() {
            path.join("content.kspkg")
        } else {
            path.to_path_buf()
        };
        return extract_package(&package_path);
    }
    let input = read_bounded(path)?;
    if format!("{:x}", Sha256::digest(&input)) != VERIFIED_IDEAL_SHA256 {
        return refuse("evo_revalidation_required", "unrecognized EVO ideal-line asset SHA256; this pilot is pinned to the verified Steam build 25170311 asset and requires revalidation after changes");
    }
    let mut found = convert(parse(&input)?, &input)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if let Some(stem) = name.strip_suffix(".ideal_line.aisplinedata") {
        let pit_path = path.with_file_name(format!("{stem}.pitlane.aisplinedata"));
        if pit_path.is_file() {
            // The pit path is optional; a refused one never prevents the main track.
            match read_bounded(&pit_path).and_then(|b| {
                if format!("{:x}", Sha256::digest(&b)) != VERIFIED_PIT_SHA256 {
                    return refuse(
                        "evo_revalidation_required",
                        "unrecognized optional pit-lane asset SHA256; revalidation required",
                    );
                }
                let p = parse(&b)?;
                Ok((p, b))
            }) {
                Ok((p, b))
                    if (p.layout == LAYOUT
                        || (p.layout.is_empty()
                            && pit_path.file_name().is_some_and(|n| n == "layout_laguna_seca.pitlane.aisplinedata")))
                        && !p.closed
                        && pit_near_track(&p, &found.track) =>
                {
                    let m = p.points.len();
                    found.track.pitlane = Some(Pitlane {
                        x: p.points.iter().map(|p| -p[0]).collect(),
                        z: p.points.iter().map(|p| p[2]).collect(),
                        left: vec![f32::NAN; m],
                        right: vec![f32::NAN; m],
                    });
                    found.report.notes.push(format!(
                        "optional pit lane: {m} points; SHA256 {:x}; widths unknown",
                        Sha256::digest(&b)
                    ));
                }
                Ok(_) => found
                    .report
                    .warnings
                    .push("pit lane omitted: layout identity, proximity or open-path flag differs".into()),
                Err(e) => found.report.warnings.push(format!("pit lane omitted: {e}")),
            }
        }
    }
    check(&found.track).map_err(|e| Refusal {
        code: "evo_invalid",
        message: e.message,
    })?;
    Ok(found)
}

/// The same verified source, read directly from the installed package. This
/// does not unpack files, write a list or modify anything in the installation.
pub fn extract_package(path: &Path) -> Result<Extracted> {
    const IDEAL: &str = "content\\tracks\\laguna_seca\\layouts\\layout_laguna_seca.ideal_line.aisplinedata";
    const PIT: &str = "content\\tracks\\laguna_seca\\layouts\\layout_laguna_seca.pitlane.aisplinedata";
    let failure = |message| Refusal {
        code: "evo_package",
        message,
    };
    let mut package = super::package::Package::open(path).map_err(failure)?;
    let input = package.read(IDEAL, MAX_INPUT).map_err(failure)?;
    if format!("{:x}", Sha256::digest(&input)) != VERIFIED_IDEAL_SHA256 {
        return refuse(
            "evo_revalidation_required",
            "changed native EVO ideal asset; source revalidation required before using cached geometry",
        );
    }
    let mut found = convert(parse(&input)?, &input)?;
    match package.read(PIT, MAX_INPUT) {
        Ok(bytes) if format!("{:x}", Sha256::digest(&bytes)) == VERIFIED_PIT_SHA256 => {
            let pit = parse(&bytes)?;
            if !pit.closed && pit_near_track(&pit, &found.track) {
                let n = pit.points.len();
                found.track.pitlane = Some(Pitlane {
                    x: pit.points.iter().map(|p| -p[0]).collect(),
                    z: pit.points.iter().map(|p| p[2]).collect(),
                    left: vec![f32::NAN; n],
                    right: vec![f32::NAN; n],
                });
                found.report.notes.push(format!(
                    "native package pit lane: {n} points; SHA256 {:x}; widths unknown",
                    Sha256::digest(&bytes)
                ));
            } else {
                found
                    .report
                    .warnings
                    .push("native pit lane omitted: open-path/proximity checks failed".into());
            }
        }
        Ok(_) => found
            .report
            .warnings
            .push("native pit lane changed: omitted pending source revalidation".into()),
        Err(why) => found.report.warnings.push(format!("native pit lane unavailable: {why}")),
    }
    found
        .report
        .notes
        .push("selected native package entries read without extracting or modifying the installed game".into());
    Ok(found)
}

/// Physical asphalt cross-sections from independently classified collision
/// meshes. The AI line remains a distinct reference; kerbs/turf are not asphalt.
pub fn extract_package_asphalt(path: &Path) -> Result<Extracted> {
    const IDEAL: &str = "content\\tracks\\laguna_seca\\layouts\\layout_laguna_seca.ideal_line.aisplinedata";
    let mut found = extract_package(path)?;
    let failure = |message| Refusal {
        code: "evo_package",
        message,
    };
    let mut package = super::package::Package::open(path).map_err(failure)?;
    let input = package.read(IDEAL, MAX_INPUT).map_err(failure)?;
    if format!("{:x}", Sha256::digest(&input)) != VERIFIED_IDEAL_SHA256 {
        return refuse("evo_revalidation_required", "native ideal source changed during surface extraction");
    }
    let spline = parse(&input)?;
    let forwards: Result<Vec<_>> = spline
        .payloads
        .iter()
        .map(|p| {
            p.forward.ok_or_else(|| Refusal {
                code: "evo_invalid",
                message: "missing source forward vector".into(),
            })
        })
        .collect();
    let surface = super::acevo_surface::extract(&mut package, &spline.points, &forwards?)?;
    let raw = surface.asphalt_boundaries;
    let n = spline.points.len();
    let mut boundaries = Boundaries {
        left_x: Vec::with_capacity(n),
        left_z: Vec::with_capacity(n),
        right_x: Vec::with_capacity(n),
        right_z: Vec::with_capacity(n),
    };
    let mut known = 0;
    for i in 0..n {
        // Reflection reverses the side convention as well as the X coordinate.
        let (left, right) = ((-raw.right_x[i], raw.right_z[i]), (-raw.left_x[i], raw.left_z[i]));
        boundaries.left_x.push(left.0);
        boundaries.left_z.push(left.1);
        boundaries.right_x.push(right.0);
        boundaries.right_z.push(right.1);
        if left.0.is_finite() && right.0.is_finite() {
            let c = &mut found.track.centerline;
            c.x[i] = (left.0 + right.0) * 0.5;
            c.z[i] = (left.1 + right.1) * 0.5;
            c.y[i] = surface.asphalt_midpoint_y[i];
            c.left[i] = (left.0 - right.0).hypot(left.1 - right.1) * 0.5;
            c.right[i] = c.left[i];
            known += 1;
        }
    }
    found.track.boundaries = Some(boundaries);
    found.track.source = "mesh_asphalt".into();
    // Unknown sections retain the game line and NaN widths rather than a guessed midpoint.
    found.track.center_kind = "edges_midpoint".into();
    found.report.notes.push(format!(
        "{}: {} verified surface triangles; {known}/{n} asphalt sections; reflected X and swapped sides",
        surface.provenance, surface.triangle_count
    ));
    found.report.notes.push(format!(
        "{} reference samples classified by nearest compatible source surface; kerb/turf/other paved bands remain separate",
        surface.point_samples.iter().flatten().count()
    ));
    let mut classes = std::collections::BTreeMap::new();
    let mut height_range = (f32::INFINITY, f32::NEG_INFINITY);
    for sample in surface.point_samples.iter().flatten() {
        *classes.entry(format!("{:?}/{}", sample.class, sample.surface_id)).or_insert(0usize) += 1;
        height_range.0 = height_range.0.min(sample.y);
        height_range.1 = height_range.1.max(sample.y);
    }
    let mut band_classes = std::collections::BTreeMap::new();
    let mut max_bank = 0f32;
    for band in surface.bands.iter().flatten() {
        if band.max_offset > band.min_offset {
            *band_classes.entry(format!("{:?}", band.class)).or_insert(0usize) += 1;
            max_bank = max_bank.max((band.positive[1] - band.negative[1]).abs());
        }
    }
    found.report.notes.push(format!("source surface samples {classes:?}; elevation {:.3}..{:.3} m; separate class bands {band_classes:?}; max band edge-height span {max_bank:.3} m (not flattened into asphalt)",height_range.0,height_range.1));
    found.report.warnings.push("Asphalt excludes kerbs, turf and other paved areas; sampled sections omit separate edge heights/banking. Timing origin is not the AI-line origin.".into());
    check(&found.track).map_err(|e| Refusal {
        code: "evo_surface_invalid",
        message: e.message,
    })?;
    Ok(found)
}

fn pit_near_track(p: &Spline, track: &Track) -> bool {
    // At most 200 m from the known main line, allowing a pit building and paddock
    // while refusing a neighboring or otherwise unrelated circuit.
    let c = &track.centerline;
    // Bound work even for hostile files at the format's maximum point count.
    // A pit too costly to verify is optional and is omitted with a warning.
    let mut remaining = 20_000_000usize;
    for point in &p.points {
        let mut near = false;
        for (x, z) in c.x.iter().zip(&c.z) {
            if remaining == 0 {
                return false;
            }
            remaining -= 1;
            if (-point[0] - x).hypot(point[2] - z) <= MAX_SIDE_M {
                near = true;
                break;
            }
        }
        if !near {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    fn var(mut v: u64) -> Vec<u8> {
        let mut b = vec![];
        while v >= 128 {
            b.push((v as u8) | 128);
            v >>= 7;
        }
        b.push(v as u8);
        b
    }
    fn field(n: u32, wire: u8, value: &[u8]) -> Vec<u8> {
        let mut b = var(u64::from(n) * 8 + u64::from(wire));
        if wire == 2 {
            b.extend(var(value.len() as u64));
        }
        b.extend(value);
        b
    }
    fn f(n: u32, v: f32) -> Vec<u8> {
        field(n, 5, &v.to_le_bytes())
    }
    fn vec3(p: [f32; 3]) -> Vec<u8> {
        [f(1, p[0]), f(2, p[1]), f(3, p[2])].concat()
    }
    fn fixture() -> Vec<u8> {
        let points = [[10., 2., 0.], [0., 2., 10.], [-10., 2., 0.], [0., 2., -10.]];
        let mut spline = vec![];
        let mut payloads = vec![];
        for (i, p) in points.iter().enumerate() {
            let point = [field(1, 2, &vec3(*p)), f(2, i as f32 * 14.142136)].concat();
            spline.extend(field(1, 2, &point));
            payloads.extend(field(2, 2, &[f(3, -1.), f(4, 11.), field(10, 2, &vec3([0., 0., 1.]))].concat()));
        }
        spline.extend(field(2, 1, &(40.0f64 * 2.0f64.sqrt()).to_le_bytes()));
        spline.extend(field(3, 0, &[1]));
        [
            field(1, 2, &spline),
            payloads,
            field(5, 2, LAYOUT.as_bytes()),
            field(8, 2, &field(2, 2, b"Laguna Seca")),
        ]
        .concat()
    }
    #[test]
    fn parses_proto3_signed_sides_and_skips_unknown_fields() {
        let mut b = fixture();
        b.extend(field(100, 2, b"unknown"));
        b.extend(field(101, 0, &var(500)));
        let s = parse(&b).unwrap();
        assert_eq!(s.points[0], [10., 2., 0.]);
        assert_eq!(s.payloads[0].sides, [-1., 11.]);
        assert_eq!(s.title.as_deref(), Some("Laguna Seca"));
        assert!(s.closed);
    }
    #[test]
    fn rejects_truncated_malformed_and_excess_input() {
        let b = fixture();
        for cut in [0, 1, 2, 3, b.len() - 1] {
            assert!(parse(&b[..cut]).is_err());
        }
        assert!(parse(&[0]).is_err());
        assert!(parse(&[15]).is_err());
        assert!(parse(&[128; 11]).is_err());
        assert!(parse(&vec![0; MAX_INPUT + 1]).is_err());
        assert!(vector(&f(1, f32::INFINITY)).is_err());
    }
    #[test]
    fn refuses_payload_mismatch_and_other_layout_identity() {
        let mut b = fixture();
        b.extend(field(2, 2, &[]));
        assert!(parse(&b).is_err());
        let b = fixture();
        let mut s = parse(&b).unwrap();
        s.layout = "other".into();
        assert!(convert(s, &b).is_err());
    }
    #[test]
    fn reflects_geometry_once_and_keeps_signed_native_edges_in_v2() {
        let b = fixture();
        let mut s = parse(&b).unwrap();
        // Source forward +z maps to the project's left normal +x. Negative
        // source-left puts the final right edge on that same side of the line.
        for payload in &mut s.payloads {
            payload.forward = Some([0., 0., 1.]);
        }
        let found = convert(s, &b).unwrap();
        let t = &found.track;
        assert_eq!(t.centerline.x[0], -10.);
        assert_eq!(t.centerline.y[0], 2.);
        assert_eq!(t.centerline.z[0], 0.);
        assert!(t.centerline.left.iter().all(|v| v.is_nan()));
        let edges = t.boundaries.as_ref().unwrap();
        assert_eq!(edges.left_x[0], 1.);
        assert_eq!(edges.right_x[0], -9.);
        assert_eq!(edges.left_z[0], 0.);
        assert_eq!(edges.right_z[0], 0.);
        assert_eq!(t.center_kind, "game_line");
        let raw = pack(t).unwrap();
        assert_eq!(u16::from_le_bytes([raw[4], raw[5]]), 2);
        assert_eq!(pack(&unpack(&raw).unwrap()).unwrap(), raw);
        assert!(found.report.notes.iter().any(|v| v.contains("SHA256")));
    }
    #[test]
    fn refuses_bad_direction_width_distance_and_closure() {
        let b = fixture();
        let mut s = parse(&b).unwrap();
        s.payloads[0].forward = Some([0., 1., 0.]);
        assert!(convert(s, &b).is_err());
        let mut s = parse(&b).unwrap();
        s.payloads[0].forward = None;
        assert!(convert(s, &b).is_err());
        let mut s = parse(&b).unwrap();
        s.payloads[0].sides = [-11., 1.];
        assert!(convert(s, &b).is_err());
        let mut s = parse(&b).unwrap();
        s.closed = false;
        assert!(convert(s, &b).is_err());
        let mut bad = b.clone();
        bad.extend(field(5, 2, b"wrong"));
        assert!(extract_bytes_for_test(&bad).is_err());
    }
    #[test]
    fn malformed_prefixes_and_wire_types_never_panic() {
        let good = fixture();
        for cut in 0..good.len() {
            let _ = extract_bytes_for_test(&good[..cut]);
        }
        for wire in [3, 4, 6, 7] {
            assert!(Wire::new(&[8 | wire]).next().is_err());
        }
        let mut truncated = field(100, 2, b"payload");
        truncated.pop();
        assert!(Wire::new(&truncated).next().is_err());
    }
    #[test]
    fn public_pilot_requires_revalidation_for_changed_source_asset() {
        let dir = crate::config::scratch_dir("evo-unverified-source");
        let path = dir.join("layout_laguna_seca.ideal_line.aisplinedata");
        std::fs::write(&path, fixture()).unwrap();
        assert_eq!(extract(&path).unwrap_err().code, "evo_revalidation_required");
    }
    fn extract_bytes_for_test(b: &[u8]) -> Result<Extracted> {
        convert(parse(b)?, b)
    }
}
