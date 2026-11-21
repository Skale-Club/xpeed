//! The website's icons in the panel: the Lucide shapes of `shared/design/icons.json` (made from lucide-react by
//! `npm run design:icons`), turned into lines once and drawn with GDI+ as Lucide draws them (2 units wide in a 24-unit box,
//! round ends and corners). The sidebar uses them, so its icons are the site's, not look-alikes.

use super::*;
use std::collections::BTreeMap;
use std::sync::OnceLock;
use windows_sys::Win32::Graphics::GdiPlus::{
    GdipDrawLines, GdipSetPenEndCap, GdipSetPenLineJoin, GdipSetPenStartCap, LineCapRound, LineJoinRound,
};

/// One icon as runs of points in Lucide's 24 x 24 box; `true` when the run closes on itself.
pub(super) type Strokes = Vec<(Vec<(f32, f32)>, bool)>;

static ICONS_JSON: &str = include_str!("../../../shared/design/icons.json");

/// Lucide draws its lines this wide, in its 24-unit box.
const STROKE: f32 = 2.0;

fn icons() -> &'static BTreeMap<String, Strokes> {
    static ICONS: OnceLock<BTreeMap<String, Strokes>> = OnceLock::new();
    ICONS.get_or_init(|| {
        let doc: serde_json::Value = serde_json::from_str(ICONS_JSON).unwrap_or(serde_json::Value::Null);
        doc["icons"]
            .as_object()
            .map(|all| all.iter().map(|(name, elements)| (name.clone(), strokes_of(elements))).collect())
            .unwrap_or_default()
    })
}

/// The lines of the icon `name` (a Lucide name, as in `shared/design/nav.json`), or None when icons.json has no such icon.
pub(super) fn icon_strokes(name: &str) -> Option<&'static Strokes> {
    icons().get(name)
}

/// Draws the icon `name` centred in `r`, `side` design pixels square, in `color`. Nothing is drawn without GDI+ or the icon.
pub(super) fn draw_icon(g: &Painter, name: &str, r: RECT, side: f32, color: COLORREF) {
    let Some(strokes) = icon_strokes(name) else { return };
    let size = side * g.s;
    let k = size / 24.0;
    let ox = (r.left + r.right) as f32 / 2.0 - size / 2.0;
    let oy = (r.top + r.bottom) as f32 / 2.0 - size / 2.0;
    smooth(g.hdc, |graphics| unsafe {
        let mut pen = null_mut();
        GdipCreatePen1(argb(color), STROKE * k, UnitPixel, &mut pen);
        GdipSetPenLineJoin(pen, LineJoinRound);
        GdipSetPenStartCap(pen, LineCapRound);
        GdipSetPenEndCap(pen, LineCapRound);
        for (points, closed) in strokes {
            let mut line: Vec<PointF> = points
                .iter()
                .map(|&(x, y)| PointF {
                    X: ox + x * k,
                    Y: oy + y * k,
                })
                .collect();
            if *closed {
                if let Some(&first) = line.first() {
                    line.push(first);
                }
            }
            if line.len() >= 2 {
                GdipDrawLines(graphics, pen, line.as_ptr(), line.len() as i32);
            }
        }
        GdipDeletePen(pen);
    });
}

/// The lines of one icon's elements (`[tag, attributes]`): path, circle, ellipse, rect, line, polyline and polygon.
pub(super) fn strokes_of(elements: &serde_json::Value) -> Strokes {
    let mut out = Strokes::new();
    for element in elements.as_array().into_iter().flatten() {
        let (tag, attrs) = (element[0].as_str().unwrap_or(""), &element[1]);
        let num = |key: &str| -> Option<f32> {
            match &attrs[key] {
                serde_json::Value::String(s) => s.trim().parse().ok(),
                serde_json::Value::Number(n) => n.as_f64().map(|v| v as f32),
                _ => None,
            }
        };
        let get = |key: &str| num(key).unwrap_or(0.0);
        match tag {
            "path" => path_strokes(attrs["d"].as_str().unwrap_or(""), &mut out),
            "circle" => out.push((ellipse(get("cx"), get("cy"), get("r"), get("r")), true)),
            "ellipse" => out.push((ellipse(get("cx"), get("cy"), get("rx"), get("ry")), true)),
            "rect" => {
                let (rx, ry) = match (num("rx"), num("ry")) {
                    (Some(rx), Some(ry)) => (rx, ry),
                    (Some(r), None) | (None, Some(r)) => (r, r),
                    (None, None) => (0.0, 0.0),
                };
                out.push((rounded_rect(get("x"), get("y"), get("width"), get("height"), rx, ry), true));
            }
            "line" => out.push((vec![(get("x1"), get("y1")), (get("x2"), get("y2"))], false)),
            "polyline" | "polygon" => {
                let values = numbers(attrs["points"].as_str().unwrap_or(""));
                let points = values.as_chunks::<2>().0.iter().map(|&[x, y]| (x, y)).collect();
                out.push((points, tag == "polygon"));
            }
            _ => {}
        }
    }
    out
}

/// The numbers of an attribute such as `points` ("3 6 9 12" or "3,6 9,12").
fn numbers(s: &str) -> Vec<f32> {
    let mut reader = PathReader::new(s);
    let mut values = Vec::new();
    while let Some(v) = reader.number() {
        values.push(v);
    }
    values
}

fn ellipse(cx: f32, cy: f32, rx: f32, ry: f32) -> Vec<(f32, f32)> {
    let steps = 48;
    (0..steps)
        .map(|i| {
            let t = i as f32 / steps as f32 * std::f32::consts::TAU;
            (cx + rx * t.cos(), cy + ry * t.sin())
        })
        .collect()
}

fn rounded_rect(x: f32, y: f32, w: f32, h: f32, rx: f32, ry: f32) -> Vec<(f32, f32)> {
    let (rx, ry) = (rx.clamp(0.0, w / 2.0), ry.clamp(0.0, h / 2.0));
    if rx == 0.0 || ry == 0.0 {
        return vec![(x, y), (x + w, y), (x + w, y + h), (x, y + h)];
    }
    let mut points = Vec::new();
    // The four corners, clockwise from the top right, each a quarter turn around its own centre.
    let corners = [
        (x + w - rx, y + ry, -90.0_f32),
        (x + w - rx, y + h - ry, 0.0),
        (x + rx, y + h - ry, 90.0),
        (x + rx, y + ry, 180.0),
    ];
    for (cx, cy, from) in corners {
        for i in 0..=8 {
            let t = (from + 90.0 * i as f32 / 8.0).to_radians();
            points.push((cx + rx * t.cos(), cy + ry * t.sin()));
        }
    }
    points
}

/// Reads an SVG path's numbers and arc flags in order (`.25.25` is two numbers, `-.48` one).
struct PathReader<'a> {
    s: &'a [u8],
    at: usize,
}

impl<'a> PathReader<'a> {
    fn new(s: &'a str) -> Self {
        PathReader { s: s.as_bytes(), at: 0 }
    }

    fn skip(&mut self) {
        while self.at < self.s.len() && (self.s[self.at].is_ascii_whitespace() || self.s[self.at] == b',') {
            self.at += 1;
        }
    }

    /// The next command letter, if one comes next.
    fn command(&mut self) -> Option<u8> {
        self.skip();
        let c = *self.s.get(self.at)?;
        c.is_ascii_alphabetic().then(|| {
            self.at += 1;
            c
        })
    }

    /// Whether a number comes next (the same command goes on).
    fn has_number(&mut self) -> bool {
        self.skip();
        self.s
            .get(self.at)
            .is_some_and(|c| c.is_ascii_digit() || matches!(c, b'-' | b'+' | b'.'))
    }

    fn number(&mut self) -> Option<f32> {
        if !self.has_number() {
            return None;
        }
        let start = self.at;
        if matches!(self.s[self.at], b'-' | b'+') {
            self.at += 1;
        }
        let (mut dot, mut exp) = (false, false);
        while let Some(&c) = self.s.get(self.at) {
            match c {
                b'0'..=b'9' => {}
                b'.' if !dot && !exp => dot = true,
                b'e' | b'E' if !exp => {
                    exp = true;
                    if matches!(self.s.get(self.at + 1), Some(b'-' | b'+')) {
                        self.at += 1;
                    }
                }
                _ => break,
            }
            self.at += 1;
        }
        std::str::from_utf8(&self.s[start..self.at]).ok()?.parse().ok()
    }

    /// An arc's flag: one character, 0 or 1 (flags may be written without a space between them).
    fn flag(&mut self) -> Option<bool> {
        self.skip();
        let c = *self.s.get(self.at)?;
        self.at += 1;
        match c {
            b'0' => Some(false),
            b'1' => Some(true),
            _ => None,
        }
    }
}

/// The runs of points of an SVG path's `d` (curves and arcs made into short straight steps).
pub(super) fn path_strokes(d: &str, out: &mut Strokes) {
    let mut r = PathReader::new(d);
    let mut run: Vec<(f32, f32)> = Vec::new();
    let (mut cur, mut start) = ((0.0_f32, 0.0_f32), (0.0_f32, 0.0_f32));
    // The last control point of a curve, for S and T (None after any other command).
    let mut last_cubic: Option<(f32, f32)> = None;
    let mut last_quad: Option<(f32, f32)> = None;
    let finish = |run: &mut Vec<(f32, f32)>, closed: bool, out: &mut Strokes| {
        if run.len() >= 2 {
            out.push((std::mem::take(run), closed));
        } else {
            run.clear();
        }
    };
    let mut command = 0u8;
    loop {
        if let Some(c) = r.command() {
            command = c;
        } else if !r.has_number() {
            break;
        }
        let rel = command.is_ascii_lowercase();
        let base = if rel { cur } else { (0.0, 0.0) };
        let pair = |r: &mut PathReader| -> Option<(f32, f32)> { Some((r.number()? + base.0, r.number()? + base.1)) };
        match command.to_ascii_uppercase() {
            b'M' => {
                let Some(p) = pair(&mut r) else { break };
                finish(&mut run, false, out);
                (cur, start) = (p, p);
                run.push(p);
                // More pairs after a move are lines.
                command = if rel { b'l' } else { b'L' };
                (last_cubic, last_quad) = (None, None);
            }
            b'L' => {
                let Some(p) = pair(&mut r) else { break };
                run.push(p);
                cur = p;
                (last_cubic, last_quad) = (None, None);
            }
            b'H' => {
                let Some(x) = r.number() else { break };
                cur = (x + base.0, cur.1);
                run.push(cur);
                (last_cubic, last_quad) = (None, None);
            }
            b'V' => {
                let Some(y) = r.number() else { break };
                cur = (cur.0, y + base.1);
                run.push(cur);
                (last_cubic, last_quad) = (None, None);
            }
            b'C' | b'S' => {
                let c1 = if command.eq_ignore_ascii_case(&b'C') {
                    let Some(c1) = pair(&mut r) else { break };
                    c1
                } else {
                    last_cubic.map_or(cur, |c| (2.0 * cur.0 - c.0, 2.0 * cur.1 - c.1))
                };
                let (Some(c2), Some(p)) = (pair(&mut r), pair(&mut r)) else { break };
                for i in 1..=16 {
                    let t = i as f32 / 16.0;
                    let u = 1.0 - t;
                    let (a, b, c, e) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
                    run.push((a * cur.0 + b * c1.0 + c * c2.0 + e * p.0, a * cur.1 + b * c1.1 + c * c2.1 + e * p.1));
                }
                (last_cubic, last_quad, cur) = (Some(c2), None, p);
            }
            b'Q' | b'T' => {
                let c1 = if command.eq_ignore_ascii_case(&b'Q') {
                    let Some(c1) = pair(&mut r) else { break };
                    c1
                } else {
                    last_quad.map_or(cur, |c| (2.0 * cur.0 - c.0, 2.0 * cur.1 - c.1))
                };
                let Some(p) = pair(&mut r) else { break };
                for i in 1..=12 {
                    let t = i as f32 / 12.0;
                    let u = 1.0 - t;
                    run.push((
                        u * u * cur.0 + 2.0 * u * t * c1.0 + t * t * p.0,
                        u * u * cur.1 + 2.0 * u * t * c1.1 + t * t * p.1,
                    ));
                }
                (last_cubic, last_quad, cur) = (None, Some(c1), p);
            }
            b'A' => {
                let (Some(rx), Some(ry), Some(phi)) = (r.number(), r.number(), r.number()) else {
                    break;
                };
                let (Some(large), Some(sweep)) = (r.flag(), r.flag()) else { break };
                let Some(p) = pair(&mut r) else { break };
                arc(cur, (rx, ry), phi, large, sweep, p, &mut run);
                (last_cubic, last_quad, cur) = (None, None, p);
            }
            b'Z' => {
                finish(&mut run, true, out);
                cur = start;
                run.push(start);
                (last_cubic, last_quad) = (None, None);
                // A close takes no numbers: the next thing must be a command.
                if r.has_number() {
                    break;
                }
            }
            _ => break,
        }
    }
    finish(&mut run, false, out);
}

/// An SVG arc from `p0` to `p1` as short steps (the spec's endpoint-to-centre conversion), appended to `run`.
fn arc(p0: (f32, f32), radii: (f32, f32), phi: f32, large: bool, sweep: bool, p1: (f32, f32), run: &mut Vec<(f32, f32)>) {
    let (mut rx, mut ry) = (radii.0.abs(), radii.1.abs());
    if rx == 0.0 || ry == 0.0 || p0 == p1 {
        run.push(p1);
        return;
    }
    let (sin, cos) = phi.to_radians().sin_cos();
    let (dx, dy) = ((p0.0 - p1.0) / 2.0, (p0.1 - p1.1) / 2.0);
    let (x1, y1) = (cos * dx + sin * dy, -sin * dx + cos * dy);
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if lambda > 1.0 {
        rx *= lambda.sqrt();
        ry *= lambda.sqrt();
    }
    let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let coef = (num / den).max(0.0).sqrt() * if large == sweep { -1.0 } else { 1.0 };
    let (cxp, cyp) = (coef * rx * y1 / ry, -coef * ry * x1 / rx);
    let (cx, cy) = (
        cos * cxp - sin * cyp + (p0.0 + p1.0) / 2.0,
        sin * cxp + cos * cyp + (p0.1 + p1.1) / 2.0,
    );
    let angle = |u: (f32, f32), v: (f32, f32)| (u.0 * v.1 - u.1 * v.0).atan2(u.0 * v.0 + u.1 * v.1);
    let from = ((x1 - cxp) / rx, (y1 - cyp) / ry);
    let to = ((-x1 - cxp) / rx, (-y1 - cyp) / ry);
    let theta = angle((1.0, 0.0), from);
    let mut delta = angle(from, to);
    if !sweep && delta > 0.0 {
        delta -= std::f32::consts::TAU;
    } else if sweep && delta < 0.0 {
        delta += std::f32::consts::TAU;
    }
    let steps = (delta.abs() / (std::f32::consts::PI / 16.0)).ceil().max(2.0) as i32;
    for i in 1..steps {
        let t = theta + delta * i as f32 / steps as f32;
        let (ex, ey) = (rx * t.cos(), ry * t.sin());
        run.push((cx + cos * ex - sin * ey, cy + sin * ex + cos * ey));
    }
    run.push(p1);
}

#[cfg(test)]
mod icon_tests {
    use super::*;

    #[test]
    fn has_every_icon_the_sidebar_names() {
        for (item, _) in sidebar_layout(1.0).buttons {
            let strokes = icon_strokes(item.icon()).unwrap_or_else(|| panic!("icons.json has no {}", item.icon()));
            assert!(!strokes.is_empty(), "{} has lines", item.icon());
        }
    }

    #[test]
    fn reads_lucide_paths_as_lucide_draws_them() {
        // Gauge: a short needle and a 10-unit arc round (12, 14) from (3.34, 19) over the top to (20.66, 19).
        let gauge = icon_strokes("Gauge").unwrap();
        assert_eq!(gauge[0], (vec![(12.0, 14.0), (16.0, 10.0)], false));
        let dial = &gauge[1].0;
        assert_eq!(dial.first(), Some(&(3.34, 19.0)));
        assert_eq!(dial.last(), Some(&(20.66, 19.0)));
        let top = dial.iter().map(|p| p.1).fold(f32::MAX, f32::min);
        assert!((top - 4.0).abs() < 0.05, "the long way round, over the top of the circle: {top}");
        for &(x, y) in dial {
            assert!(((x - 12.0).hypot(y - 14.0) - 10.0).abs() < 0.02, "every step on the circle");
        }
        // A packed number list: ".25.25" is two numbers and "-.48" one.
        let mut out = Strokes::new();
        path_strokes("M1 1a.25.25 0 0 1-.48 0", &mut out);
        assert_eq!(out[0].0.last(), Some(&(0.52, 1.0)));
        // A dot (Lucide's "h.01") stays a two-point run, which round ends draw as a dot.
        let car = icon_strokes("CarFront").unwrap();
        assert!(car
            .iter()
            .any(|(run, _)| run.len() == 2 && (run[1].0 - run[0].0 - 0.01).abs() < 1e-4));
        // A rounded rect closes on itself.
        assert!(car.iter().any(|(run, closed)| *closed && run.len() > 8));
    }

    #[test]
    fn keeps_every_icon_inside_its_box() {
        for (name, strokes) in icons() {
            for (run, _) in strokes {
                for &(x, y) in run {
                    assert!((0.0..=24.0).contains(&x) && (0.0..=24.0).contains(&y), "{name}: ({x}, {y})");
                }
            }
        }
    }
}
