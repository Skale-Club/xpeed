//! Hash-pinned offline F1 2025 Brazil white-line source. No telemetry-frame or
//! season/layout association is implied by this manually selected export.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::Path,
};

pub const SOURCE: &str = "ego_white_line";
pub const VERIFIED_SHA256: &str = "a213971176184e152d112dc83d9e898492ccee71faf8d955d7bed6600194904f";
pub const VERIFIED_BUILD: &str = "26566308";
pub const SOURCE_FRAME: &str = "EGO F1 2025 source world: raw xyz metres, x/z horizontal and y up; telemetry axes, origin, timing and season/layout binding unverified";
const MAX_FILE: usize = 8 * 1024 * 1024;
const MAX_NODES: usize = 100_000;
const MAX_DEPTH: usize = 32;
const MAX_STRING: usize = 16_384;
const EOF: &[u8] = &[4, 0, 6, 0, 0, 0, 4, 0, 6, 0, 0, 0];
fn no<T>(code: &'static str, text: impl Into<String>) -> Result<T, Refusal> {
    refuse(code, text)
}
#[derive(Debug)]
struct Node<'a> {
    tag: &'a str,
    attrs: Vec<(&'a str, &'a str)>,
    children: Vec<Node<'a>>,
}
impl<'a> Node<'a> {
    fn attr(&self, key: &str) -> Result<&'a str, Refusal> {
        self.attrs.iter().find(|(k, _)| *k == key).map(|(_, v)| *v).ok_or_else(|| Refusal {
            code: "ego_field",
            message: format!("{} lacks {key}", self.tag),
        })
    }
    fn unique(&self, name: &str) -> Result<&Node<'a>, Refusal> {
        let mut nodes = self.children.iter().filter(|c| c.tag == name);
        let n = nodes.next().ok_or_else(|| Refusal {
            code: "ego_field",
            message: format!("{} lacks {name}", self.tag),
        })?;
        if nodes.next().is_some() {
            return no("ego_field", format!("duplicate {name}"));
        }
        Ok(n)
    }
    fn count(&self, key: &str) -> Result<usize, Refusal> {
        self.attr(key)?
            .parse::<usize>()
            .ok()
            .filter(|&n| n <= MAX_NODES)
            .ok_or_else(|| Refusal {
                code: "ego_count",
                message: format!("invalid {key}"),
            })
    }
    fn number(&self, key: &str) -> Result<f64, Refusal> {
        self.attr(key)?
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .ok_or_else(|| Refusal {
                code: "ego_number",
                message: format!("invalid {key}"),
            })
    }
    fn xyz(&self) -> Result<[f64; 3], Refusal> {
        Ok([self.number("x")?, self.number("y")?, self.number("z")?])
    }
}
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
    nodes: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], Refusal> {
        let end = self
            .at
            .checked_add(n)
            .filter(|&end| end <= self.bytes.len())
            .ok_or_else(|| Refusal {
                code: "ego_bxml",
                message: "truncated BXML record".into(),
            })?;
        let b = &self.bytes[self.at..end];
        self.at = end;
        Ok(b)
    }
    fn string(&mut self) -> Result<&'a str, Refusal> {
        let rest = &self.bytes[self.at..];
        let length = rest.iter().take(MAX_STRING + 1).position(|&b| b == 0).ok_or_else(|| Refusal {
            code: "ego_bxml",
            message: "unterminated or excessive BXML string".into(),
        })?;
        let b = self.take(length + 1)?;
        std::str::from_utf8(&b[..length]).map_err(|_| Refusal {
            code: "ego_bxml",
            message: "non-UTF8 BXML string".into(),
        })
    }
    fn node(&mut self, depth: usize) -> Result<Option<Node<'a>>, Refusal> {
        self.nodes += 1;
        if depth > MAX_DEPTH || self.nodes > MAX_NODES {
            return no("ego_bxml_limit", "BXML node/depth bound");
        }
        let start = self.at;
        let h = self.take(6)?;
        let length = i16::from_le_bytes([h[0], h[1]]);
        let count = i16::from_le_bytes([h[4], h[5]]);
        let kind = h[2];
        if length < 4 || h[3] != 0 || !(0..=1024).contains(&count) {
            return no("ego_bxml", "invalid BXML record header");
        }
        if kind == 5 {
            if length != 4 || count != 0 {
                return no("ego_bxml", "invalid closing record");
            }
            return Ok(None);
        }
        let mut n = match kind {
            0 => {
                let tag = self.string()?;
                if tag.is_empty() {
                    return no("ego_bxml", "empty element name");
                }
                let mut attrs = Vec::new();
                for _ in 0..count {
                    let k = self.string()?;
                    let v = self.string()?;
                    if k.is_empty() || attrs.iter().any(|(old, _)| *old == k) {
                        return no("ego_bxml", "empty or duplicate attribute");
                    }
                    attrs.push((k, v));
                }
                Node {
                    tag,
                    attrs,
                    children: Vec::new(),
                }
            }
            1 => {
                if count != 0 {
                    return no("ego_bxml", "text node has attributes");
                }
                let value = self.string()?;
                Node {
                    tag: "#text",
                    attrs: vec![("value", value)],
                    children: Vec::new(),
                }
            }
            _ => return no("ego_bxml", "unverified BXML node type"),
        };
        if self.at != start + 2 + length as usize {
            return no("ego_bxml", "record length disagrees with its fields");
        }
        if kind == 0 {
            while let Some(child) = self.node(depth + 1)? {
                n.children.push(child);
            }
        }
        Ok(Some(n))
    }
}
fn bxml(bytes: &[u8]) -> Result<Node<'_>, Refusal> {
    if bytes.len() > MAX_FILE || !bytes.starts_with(b"\x01BXML") {
        return no("ego_bxml", "expected bounded little-endian BXML");
    }
    let mut r = Reader { bytes, at: 5, nodes: 0 };
    let root = r.node(0)?.ok_or_else(|| Refusal {
        code: "ego_bxml",
        message: "missing root".into(),
    })?;
    if &bytes[r.at..] != EOF {
        return no("ego_bxml", "missing exact double document terminator or trailing bytes");
    }
    Ok(root)
}
#[derive(Clone, Debug)]
struct Gate {
    pos: [f64; 3],
    normal: [f64; 3],
    offsets: BTreeMap<String, f64>,
}
#[derive(Debug)]
struct Route {
    kind: String,
    first: usize,
    last: usize,
}
#[derive(Debug)]
struct Data {
    gates: BTreeMap<usize, Gate>,
    links: BTreeMap<usize, (usize, usize)>,
    routes: Vec<Route>,
}
fn data(root: &Node<'_>) -> Result<Data, Refusal> {
    if root.tag != "track" {
        return no("ego_schema", "root is not track");
    }
    let gs = root.unique("gates")?;
    let ls = root.unique("links")?;
    let rs = root.unique("routes")?;
    let mut gates = BTreeMap::new();
    let mut links = BTreeMap::new();
    let mut routes = Vec::new();
    for node in gs.children.iter().filter(|n| n.tag == "gate") {
        let id = node.count("id")?;
        let ways = node.unique("waypoints")?;
        let mut offsets = BTreeMap::new();
        let mut ids = BTreeSet::new();
        for w in ways.children.iter().filter(|n| n.tag == "waypoint") {
            if !ids.insert(w.count("id")?) || offsets.insert(w.attr("type")?.into(), w.number("length")?).is_some() {
                return no("ego_schema", "duplicate waypoint id/type");
            }
        }
        if ways.count("num_waypoints")? != offsets.len() {
            return no("ego_count", "waypoint count mismatch");
        }
        let gate = Gate {
            pos: node.unique("position")?.xyz()?,
            normal: node.unique("normal")?.xyz()?,
            offsets,
        };
        if gates.insert(id, gate).is_some() {
            return no("ego_schema", "duplicate gate id");
        }
    }
    for node in ls.children.iter().filter(|n| n.tag == "link") {
        let a = node.count("from_gate")?;
        let b = node.count("to_gate")?;
        if !gates.contains_key(&a) || !gates.contains_key(&b) || links.insert(node.count("id")?, (a, b)).is_some() {
            return no("ego_graph", "duplicate link or out-of-range gate");
        }
    }
    let mut routeids = BTreeSet::new();
    for node in rs.children.iter().filter(|n| n.tag == "route") {
        if !routeids.insert(node.count("id")?) {
            return no("ego_graph", "duplicate route id");
        }
        let (first, last) = (node.count("from_link")?, node.count("to_link")?);
        if first > last || last - first >= MAX_NODES || node.attr("from_route")? != "track" || node.attr("to_route")? != "track" {
            return no("ego_graph", "unverified route range/join type");
        }
        routes.push(Route {
            kind: node.attr("type")?.into(),
            first,
            last,
        });
    }
    if gs.count("num_gates")? != gates.len() || ls.count("num_links")? != links.len() || rs.count("num_routes")? != routes.len() {
        return no("ego_count", "gate/link/route declaration mismatch");
    }
    Ok(Data { gates, links, routes })
}
fn route_links(d: &Data, r: &Route) -> Result<Vec<(usize, usize)>, Refusal> {
    (r.first..=r.last)
        .map(|id| {
            d.links.get(&id).copied().ok_or_else(|| Refusal {
                code: "ego_graph",
                message: "route references a missing link".into(),
            })
        })
        .collect()
}
fn main_chain(d: &Data) -> Result<Vec<usize>, Refusal> {
    let routes: Vec<_> = d.routes.iter().filter(|r| r.kind == "track").collect();
    if routes.len() != 1 {
        return no("ego_graph", "no unique main track route");
    }
    let links = route_links(d, routes[0])?;
    let mut next = BTreeMap::new();
    let mut incoming = BTreeSet::new();
    for (a, b) in links {
        if a == b || next.insert(a, b).is_some() || !incoming.insert(b) {
            return no("ego_graph", "main route needs one incoming/outgoing edge per gate");
        }
    }
    if next.len() < 10 || next.keys().any(|i| !incoming.contains(i)) {
        return no("ego_graph", "main graph is open or too small");
    }
    let first = *next.keys().next().unwrap();
    let mut chain = Vec::new();
    let mut seen = BTreeSet::new();
    let mut at = first;
    while seen.insert(at) {
        chain.push(at);
        at = *next.get(&at).ok_or_else(|| Refusal {
            code: "ego_graph",
            message: "main graph leaves its route".into(),
        })?;
    }
    if at != first || chain.len() != next.len() {
        return no("ego_graph", "main route has disconnected cycles");
    }
    Ok(chain)
}
fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.iter().zip(b).map(|(a, b)| (a - b).powi(2)).sum::<f64>().sqrt()
}
fn pit(d: &Data, main: &[usize], report: &mut Report) -> Option<Pitlane> {
    let build = || -> Result<Vec<usize>, Refusal> {
        let routes: Vec<_> = d.routes.iter().filter(|r| r.kind == "pit").collect();
        if routes.len() != 1 {
            return no("ego_pit", "no unique pit route");
        }
        let links = route_links(d, routes[0])?;
        if links.len() < 3 {
            return no("ego_pit", "pit route too short");
        }
        let members: BTreeSet<_> = main.iter().copied().collect();
        if !members.contains(&links[0].0) || !members.contains(&links.last().unwrap().1) {
            return no("ego_pit", "pit entry/exit not on the main route");
        }
        for pair in links.windows(2) {
            if pair[0].1 != pair[1].0 {
                return no("ego_pit", "pit links are not one ordered chain");
            }
        }
        let chain: Vec<_> = links[..links.len() - 1].iter().map(|&(_, b)| b).collect();
        let unique: BTreeSet<_> = chain.iter().copied().collect();
        if unique.len() != chain.len() || chain.iter().any(|i| members.contains(i)) {
            return no("ego_pit", "pit loops or traverses main gates internally");
        }
        for &i in &chain {
            let g = &d.gates[&i];
            let near = main
                .iter()
                .map(|j| {
                    let m = &d.gates[j];
                    (g.pos[0] - m.pos[0]).hypot(g.pos[2] - m.pos[2])
                })
                .fold(f64::INFINITY, f64::min);
            if near > 300.0 {
                return no("ego_pit", "pit gate farther than 300 m from main source");
            }
        }
        Ok(chain)
    };
    match build() {
        Ok(chain) => {
            report.notes.push(format!(
                "pit: {} source gates on the unique main-connected route; open path",
                chain.len()
            ));
            report
                .warnings
                .push("pit widths unknown: no tangent-derived replacement for signed source cross-sections".into());
            Some(Pitlane {
                x: chain.iter().map(|i| d.gates[i].pos[0] as f32).collect(),
                z: chain.iter().map(|i| d.gates[i].pos[2] as f32).collect(),
                left: vec![f32::NAN; chain.len()],
                right: vec![f32::NAN; chain.len()],
            })
        }
        Err(e) => {
            report.warnings.push(format!("pit omitted: {}", e.message));
            None
        }
    }
}
fn extract_bytes(bytes: &[u8]) -> Result<Extracted, Refusal> {
    let root = bxml(bytes)?;
    let d = data(&root)?;
    let chain = main_chain(&d)?;
    let n = chain.len();
    let x: Vec<_> = chain.iter().map(|i| d.gates[i].pos[0] as f32).collect();
    let z: Vec<_> = chain.iter().map(|i| d.gates[i].pos[2] as f32).collect();
    let left = left_units(&x, &z, true);
    let mut axes = Vec::new();
    let mut agreement = 0.0;
    let mut valid = 0;
    let mut distances = Vec::new();
    let mut total = 0.0;
    for (k, i) in chain.iter().enumerate() {
        let g = &d.gates[i];
        let norm = g.normal.iter().map(|v| v * v).sum::<f64>().sqrt();
        let dot = -(g.normal[0] * left[k].0 + g.normal[2] * left[k].1) / norm.max(1e-9);
        let ok = (0.9..=1.1).contains(&norm) && dot >= 0.8;
        axes.push(ok);
        valid += usize::from(ok);
        agreement += dot;
        distances.push(total);
        let segment = dist(g.pos, d.gates[&chain[(k + 1) % n]].pos);
        if !(0.001..=MAX_CLOSE_GAP_M).contains(&segment) {
            return no("ego_spacing", "main route duplicate/excessive source segment");
        }
        total += segment;
    }
    if valid * 10 < n * 9 || agreement / (n as f64) < 0.9 {
        return no("ego_normal", "source normals do not establish right-side orientation");
    }
    if !(100.0..=MAX_LENGTH_M).contains(&total) {
        return no("ego_length", "main gate chord length is outside bounds");
    }
    let mut c = Centerline::default();
    let mut b = Boundaries {
        left_x: Vec::new(),
        left_z: Vec::new(),
        right_x: Vec::new(),
        right_z: Vec::new(),
    };
    let mut fast = Fast::default();
    let mut fast_known = true;
    let mut known = 0;
    for (k, i) in chain.iter().enumerate() {
        let g = &d.gates[i];
        let l = *g.offsets.get("left_white_line").ok_or_else(|| Refusal {
            code: "ego_white_line",
            message: "missing explicit left white-line offset".into(),
        })?;
        let r = *g.offsets.get("right_white_line").ok_or_else(|| Refusal {
            code: "ego_white_line",
            message: "missing explicit right white-line offset".into(),
        })?;
        let ok = axes[k]
            && l.abs() <= f64::from(MAX_SIDE_M)
            && r.abs() <= f64::from(MAX_SIDE_M)
            && r - l > 0.0
            && r - l <= 2.0 * f64::from(MAX_SIDE_M);
        let mut p = g.pos;
        let (row, half) = if ok {
            let shift = (l + r) / 2.0;
            for (j, p) in p.iter_mut().enumerate() {
                *p += shift * g.normal[j];
            }
            known += 1;
            (
                [
                    (g.pos[0] + l * g.normal[0]) as f32,
                    (g.pos[2] + l * g.normal[2]) as f32,
                    (g.pos[0] + r * g.normal[0]) as f32,
                    (g.pos[2] + r * g.normal[2]) as f32,
                ],
                ((r - l) / 2.0) as f32,
            )
        } else {
            ([f32::NAN; 4], f32::NAN)
        };
        c.x.push(p[0] as f32);
        c.y.push(p[1] as f32);
        c.z.push(p[2] as f32);
        c.dist.push(distances[k] as f32);
        c.left.push(half);
        c.right.push(half);
        b.left_x.push(row[0]);
        b.left_z.push(row[1]);
        b.right_x.push(row[2]);
        b.right_z.push(row[3]);
        if let Some(offset) = g.offsets.get("racing_line").filter(|o| axes[k] && o.abs() <= f64::from(MAX_SIDE_M)) {
            fast.x.push((g.pos[0] + offset * g.normal[0]) as f32);
            fast.z.push((g.pos[2] + offset * g.normal[2]) as f32);
        } else {
            fast_known = false;
        }
    }
    let mut report = Report::default();
    report.notes.push(format!(
        "F1 2025 build {VERIFIED_BUILD}, Brazil 2025_asset_groups; AI source SHA256 {VERIFIED_SHA256}"
    ));
    report.notes.push(format!("{n} main source gates in one directed cycle; gate chord 3D length {total:.6} m; {known}/{n} explicit signed white-line cross-sections"));
    report.notes.push(format!(
        "stored normal right-side mean agreement {:.6}; midpoint source Y retained",
        agreement / n as f64
    ));
    report
        .warnings
        .push("Offline source-world export: telemetry axes/origin, timing line, annual/season mode and layout binding unverified".into());
    report.warnings.push("Source-labelled white lines are distinct from racing/track/runoff limits; physical line centre/edge and asphalt semantics unverified".into());
    report.warnings.push(
        "Distance is cumulative gate chords from the lowest gate id; not TrackSpace spline length or a proved timing/finish origin".into(),
    );
    report
        .warnings
        .push("Boundary heights/banking cannot be stored by planar XTRK v2 edges; unusable rows remain gaps".into());
    if fast_known {
        report
            .notes
            .push("fast section is the explicit source racing_line offset, not an invented optimal path".into());
    } else {
        report
            .warnings
            .push("fast section omitted because a source racing_line offset or normal is unusable".into());
    }
    let pitlane = pit(&d, &chain, &mut report);
    let track = Track {
        game: "f1".into(),
        name: "Brazil".into(),
        variant: Some("2025-source/season-layout-unverified".into()),
        title: Some("Brazil (F1 2025 source white lines; alignment unverified)".into()),
        length_m: Some(total),
        source: SOURCE.into(),
        frame: SOURCE_FRAME.into(),
        closed: true,
        center_kind: "edges_midpoint".into(),
        centerline: c,
        fast: fast_known.then_some(fast),
        pitlane,
        boundaries: Some(b),
    };
    check(&track).map_err(|e| Refusal {
        code: "ego_track",
        message: e.message,
    })?;
    Ok(Extracted { track, report })
}
fn read_pinned(reader: impl Read) -> Result<Vec<u8>, Refusal> {
    let mut b = Vec::new();
    reader.take((MAX_FILE + 1) as u64).read_to_end(&mut b).map_err(|e| Refusal {
        code: "io",
        message: e.to_string(),
    })?;
    if b.len() > MAX_FILE {
        return no("ego_too_large", "F1 BXML exceeds 8 MiB");
    }
    if format!("{:x}", Sha256::digest(&b)) != VERIFIED_SHA256 {
        return no(
            "ego_unverified_source",
            "not the verified F1 2025 Brazil source; keep the hash guard",
        );
    }
    Ok(b)
}
/// Manual offline source export only. No ERP discovery, upload or frame fitting.
pub fn extract(path: &Path) -> Result<Extracted, Refusal> {
    let f = std::fs::File::open(path).map_err(|e| Refusal {
        code: "io",
        message: format!("cannot open {}: {e}", path.display()),
    })?;
    if !f
        .metadata()
        .map_err(|e| Refusal {
            code: "io",
            message: e.to_string(),
        })?
        .is_file()
    {
        return no("ego_file_type", "source must be a regular file");
    }
    extract_bytes(&read_pinned(f)?)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn element(tag: &str, attrs: Vec<(&str, String)>, children: Vec<Vec<u8>>) -> Vec<u8> {
        let mut body = vec![0, 0];
        body.extend_from_slice(&(attrs.len() as i16).to_le_bytes());
        body.extend_from_slice(tag.as_bytes());
        body.push(0);
        for (k, v) in attrs {
            body.extend_from_slice(k.as_bytes());
            body.push(0);
            body.extend_from_slice(v.as_bytes());
            body.push(0);
        }
        let mut out = (body.len() as i16).to_le_bytes().to_vec();
        out.extend(body);
        for c in children {
            out.extend(c);
        }
        out.extend_from_slice(&[4, 0, 5, 0, 0, 0]);
        out
    }
    fn source(with_pit: bool, signed: bool, bad_axis: bool) -> Vec<u8> {
        let n = 128;
        let total = n + if with_pit { 6 } else { 0 };
        let mut gates = Vec::new();
        for i in 0..total {
            let (pos, normal) = if i < n {
                let a = i as f64 * std::f64::consts::TAU / n as f64;
                (
                    [100.0 * a.cos(), 3.0, 100.0 * a.sin()],
                    if bad_axis && i == 0 {
                        [0.0; 3]
                    } else if signed && i == 0 {
                        [-0.98, 0.198997487, 0.0]
                    } else {
                        [-a.cos(), 0.0, -a.sin()]
                    },
                )
            } else {
                ([110.0, 3.0, (i - n) as f64 * 5.0], [1.0, 0.0, 0.0])
            };
            let xyz = |tag: &str, p: [f64; 3]| {
                element(
                    tag,
                    vec![("x", p[0].to_string()), ("y", p[1].to_string()), ("z", p[2].to_string())],
                    vec![],
                )
            };
            let l = if signed && i == 0 { 1.0 } else { -8.0 - (i % 3) as f64 };
            let ways = vec![
                ("left_white_line", l),
                ("right_white_line", 6.0),
                ("racing_line", 2.0),
                ("left_track_limit", -20.0),
                ("right_track_limit", 20.0),
            ]
            .into_iter()
            .enumerate()
            .map(|(id, (kind, len))| {
                element(
                    "waypoint",
                    vec![("id", id.to_string()), ("type", kind.into()), ("length", len.to_string())],
                    vec![],
                )
            })
            .collect();
            gates.push(element(
                "gate",
                vec![("id", i.to_string()), ("name", format!("synthetic_{i}"))],
                vec![
                    xyz("position", pos),
                    xyz("normal", normal),
                    element("waypoints", vec![("num_waypoints", "5".into())], ways),
                ],
            ));
        }
        let mut links = Vec::new();
        for i in 0..n {
            links.push(element(
                "link",
                vec![
                    ("id", i.to_string()),
                    ("from_gate", ((i + n - 1) % n).to_string()),
                    ("to_gate", i.to_string()),
                ],
                vec![],
            ));
        }
        if with_pit {
            for k in 0..7 {
                links.push(element(
                    "link",
                    vec![
                        ("id", (n + k).to_string()),
                        ("from_gate", if k == 0 { "0".into() } else { (n + k - 1).to_string() }),
                        ("to_gate", if k == 6 { "8".into() } else { (n + k).to_string() }),
                    ],
                    vec![],
                ));
            }
        }
        let route = |id: usize, kind: &str, first: usize, last: usize| {
            element(
                "route",
                vec![
                    ("id", id.to_string()),
                    ("type", kind.into()),
                    ("from_link", first.to_string()),
                    ("to_link", last.to_string()),
                    ("from_route", "track".into()),
                    ("to_route", "track".into()),
                ],
                vec![],
            )
        };
        let routes = if with_pit {
            vec![route(0, "track", 0, n - 1), route(1, "pit", n, n + 6)]
        } else {
            vec![route(0, "track", 0, n - 1)]
        };
        let root = element(
            "track",
            vec![("name", "synthetic".into())],
            vec![
                element("gates", vec![("num_gates", total.to_string())], gates),
                element("links", vec![("num_links", (n + if with_pit { 7 } else { 0 }).to_string())], links),
                element("routes", vec![("num_routes", if with_pit { "2" } else { "1" }.into())], routes),
                element("unknown_metadata", vec![("future", "ignored safely".into())], vec![]),
            ],
        );
        let mut b = b"\x01BXML".to_vec();
        b.extend(root);
        b.extend_from_slice(EOF);
        b
    }
    fn replace_equal(b: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
        assert_eq!(from.len(), to.len());
        let mut out = b.to_vec();
        let at = out.windows(from.len()).position(|v| v == from).unwrap();
        out[at..at + from.len()].copy_from_slice(to);
        out
    }
    #[test]
    fn title_source_frame_and_source_racing_line_are_explicit() {
        let e = extract_bytes(&source(true, false, false)).unwrap();
        let t = e.track;
        assert_eq!(t.game, "f1");
        assert_eq!(t.source, SOURCE);
        assert_eq!(t.frame, SOURCE_FRAME);
        assert_eq!(t.centerline.x.len(), 128);
        assert_eq!(t.pitlane.as_ref().unwrap().x.len(), 6);
        assert!(t
            .pitlane
            .as_ref()
            .unwrap()
            .left
            .iter()
            .chain(&t.pitlane.as_ref().unwrap().right)
            .all(|v| v.is_nan()));
        assert!((t.fast.unwrap().x[0] - 98.0).abs() < 1e-6);
        assert!(e.report.warnings.iter().any(|w| w.contains("TrackSpace")));
    }
    #[test]
    fn signed_white_lines_and_banked_midpoint_are_not_clamped_or_replaced_by_track_limits() {
        let t = extract_bytes(&source(false, true, false)).unwrap().track;
        let e = t.boundaries.as_ref().unwrap();
        assert!((e.left_x[0] - 99.02).abs() < 0.00002);
        assert!((e.right_x[0] - 94.12).abs() < 0.00002);
        assert!((t.centerline.y[0] - (3.0 + 3.5 * 0.198_997_48)).abs() < 0.00001);
        assert_ne!(t.centerline.left[1], t.centerline.left[2]);
        assert!((t.centerline.left[0] - 2.5).abs() < 1e-6);
        let packed = pack(&t).unwrap();
        assert_eq!(u16::from_le_bytes(packed[4..6].try_into().unwrap()), 2);
        let read = unpack(&packed).unwrap();
        assert_eq!(read.source, SOURCE);
        assert_eq!(read.frame, SOURCE_FRAME);
    }
    #[test]
    fn unusable_axis_leaves_complete_gap_and_no_fake_fast_line() {
        let t = extract_bytes(&source(false, false, true)).unwrap().track;
        let e = t.boundaries.unwrap();
        assert!([
            e.left_x[0],
            e.left_z[0],
            e.right_x[0],
            e.right_z[0],
            t.centerline.left[0],
            t.centerline.right[0]
        ]
        .iter()
        .all(|v| v.is_nan()));
        assert!(e.left_x[1].is_finite());
        assert!(t.fast.is_none());
    }
    #[test]
    fn bxml_rejects_truncation_bad_lengths_duplicate_attributes_and_depth() {
        let b = source(false, false, false);
        let mut wrong = b.clone();
        wrong[5] = 255;
        wrong[6] = 127;
        for bad in [&b[..b.len() - 1], &wrong, b"\x01BXML"] {
            assert!(bxml(bad).is_err());
        }
        let duplicate = element("track", vec![("a", "1".into()), ("a", "2".into())], vec![]);
        let mut bad = b"\x01BXML".to_vec();
        bad.extend(duplicate);
        bad.extend_from_slice(EOF);
        assert!(bxml(&bad).is_err());
        let mut deep = element("leaf", vec![], vec![]);
        for _ in 0..MAX_DEPTH + 1 {
            deep = element("branch", vec![], vec![deep]);
        }
        let mut bad = b"\x01BXML".to_vec();
        bad.extend(deep);
        bad.extend_from_slice(EOF);
        assert_eq!(bxml(&bad).unwrap_err().code, "ego_bxml_limit");
    }
    #[test]
    fn bxml_enforces_string_attribute_and_node_budgets() {
        let oversized = element("future", vec![("value", "x".repeat(MAX_STRING + 1))], vec![]);
        let mut bytes = b"\x01BXML".to_vec();
        bytes.extend(oversized);
        bytes.extend_from_slice(EOF);
        assert_eq!(bxml(&bytes).unwrap_err().code, "ego_bxml");
        let mut bytes = source(false, false, false);
        bytes[9..11].copy_from_slice(&1025i16.to_le_bytes());
        assert_eq!(bxml(&bytes).unwrap_err().code, "ego_bxml");
        let leaf = element("leaf", vec![], vec![]);
        let root = element("future", vec![], vec![leaf; MAX_NODES / 2 + 1]);
        let mut bytes = b"\x01BXML".to_vec();
        bytes.extend(root);
        bytes.extend_from_slice(EOF);
        assert_eq!(bxml(&bytes).unwrap_err().code, "ego_bxml_limit");
    }
    #[test]
    fn schema_counts_missing_white_fields_and_corrupt_graphs_are_refused() {
        let b = source(false, false, false);
        let bad = replace_equal(&b, b"num_gates\x00128\0", b"num_gates\x00127\0");
        assert_eq!(extract_bytes(&bad).unwrap_err().code, "ego_count");
        let bad = replace_equal(&b, b"left_white_line", b"left_while_line");
        assert_eq!(extract_bytes(&bad).unwrap_err().code, "ego_white_line");
        let root = bxml(&b).unwrap();
        let mut d = data(&root).unwrap();
        d.links.insert(1, (0, 9999));
        assert!(main_chain(&d).is_err());
        let mut d = data(&root).unwrap();
        d.links.insert(0, (63, 0));
        d.links.insert(64, (127, 64));
        assert_eq!(main_chain(&d).unwrap_err().code, "ego_graph");
    }
    #[test]
    fn malformed_pit_joins_are_omitted_not_closed() {
        let b = source(true, false, false);
        let root = bxml(&b).unwrap();
        let mut d = data(&root).unwrap();
        let main = main_chain(&d).unwrap();
        d.links.insert(134, (133, 128));
        assert!(pit(&d, &main, &mut Report::default()).is_none());
        let mut d = data(&root).unwrap();
        d.gates.get_mut(&130).unwrap().pos[0] = 5000.0;
        assert!(pit(&d, &main, &mut Report::default()).is_none());
    }
    #[test]
    fn unverified_hash_and_oversized_input_are_refused() {
        assert_eq!(read_pinned(&b"not source"[..]).unwrap_err().code, "ego_unverified_source");
        let bytes = vec![b'x'; MAX_FILE + 2];
        assert_eq!(read_pinned(&bytes[..]).unwrap_err().code, "ego_too_large");
    }
    #[test]
    #[ignore = "requires selectively extracted proprietary F1 2025 Brazil BXML"]
    fn real_verified_f1_brazil() {
        let p = std::env::var_os("XPEED_F125_AI_BXML")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../.codex-local/native-tracks/research-other/unreal-f1/AISplineData-0.zstd.raw")
            });
        let e = extract(&p).unwrap();
        let t = &e.track;
        assert_eq!(t.centerline.x.len(), 287);
        assert_eq!(t.pitlane.as_ref().unwrap().x.len(), 106);
        assert!((t.length_m.unwrap() - 4216.539441).abs() < 0.001);
        assert!(t.fast.is_some());
        let bytes = std::fs::read(&p).unwrap();
        let root = bxml(&bytes).unwrap();
        let d = data(&root).unwrap();
        let edges = t.boundaries.as_ref().unwrap();
        let mut worst = 0.0f64;
        let mut signed_exceptions = 0;
        for id in 0..287 {
            let g = &d.gates[&id];
            let l = g.offsets["left_white_line"];
            let r = g.offsets["right_white_line"];
            signed_exceptions += usize::from(l > 0.0 || r < 0.0);
            for (actual, expected) in [
                (edges.left_x[id], g.pos[0] + l * g.normal[0]),
                (edges.left_z[id], g.pos[2] + l * g.normal[2]),
                (edges.right_x[id], g.pos[0] + r * g.normal[0]),
                (edges.right_z[id], g.pos[2] + r * g.normal[2]),
                (t.centerline.y[id], g.pos[1] + (l + r) / 2.0 * g.normal[1]),
            ] {
                worst = worst.max((f64::from(actual) - expected).abs());
            }
        }
        assert!(worst < 0.00004, "float32 export error {worst}");
        assert!(signed_exceptions > 0);
        assert!(edges.left_x.iter().all(|v| v.is_finite()));
        let packed = pack(t).unwrap();
        let read = unpack(&packed).unwrap();
        assert_eq!(read.game, "f1");
        assert_eq!(read.frame, SOURCE_FRAME);
        println!("F1 source fidelity: {worst:.9} m worst across287 rows; {signed_exceptions} signed-offset exceptions preserved; no telemetry frame claim");
    }
}
