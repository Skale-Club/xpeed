//! A picture of a track, as SVG text: the road (from the centre line and its widths), its edges, the game's ideal line
//! and the pit lane. It is how a person looks at a track file before trusting it, not something the app ships.
//!
//! The plane is drawn the way the format's document says to draw it: `x` across, `z` down. Nothing is mirrored.

use super::*;

const SIZE: f64 = 1000.0;
const MARGIN: f64 = 40.0;

struct View {
    min_x: f64,
    min_z: f64,
    scale: f64,
    height: f64,
}

impl View {
    fn of(points: impl Iterator<Item = (f64, f64)>) -> View {
        let (mut min_x, mut max_x, mut min_z, mut max_z) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for (x, z) in points.filter(|(x, z)| x.is_finite() && z.is_finite()) {
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_z = min_z.min(z);
            max_z = max_z.max(z);
        }
        if !min_x.is_finite() {
            (min_x, max_x, min_z, max_z) = (0.0, 1.0, 0.0, 1.0);
        }
        let span = (max_x - min_x).max(max_z - min_z).max(1.0);
        let scale = (SIZE - 2.0 * MARGIN) / span;
        View {
            min_x,
            min_z,
            scale,
            height: (max_z - min_z) * scale + 2.0 * MARGIN,
        }
    }
    fn at(&self, x: f64, z: f64) -> String {
        format!(
            "{:.1},{:.1}",
            (x - self.min_x) * self.scale + MARGIN,
            (z - self.min_z) * self.scale + MARGIN
        )
    }
}

/// `M x,z L x,z ...` for a run of points.
fn path(view: &View, run: &[(f64, f64)]) -> String {
    let mut out = String::new();
    for (i, (x, z)) in run.iter().enumerate() {
        out.push_str(if i == 0 { "M" } else { " L" });
        out.push_str(&view.at(*x, *z));
    }
    out
}

/// The indices of the stretches where a width is known, as (start, end exclusive).
fn runs(left: &[f32]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, l) in left.iter().enumerate() {
        match (l.is_finite(), start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                out.push((s, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        out.push((s, left.len()));
    }
    out
}

/// The road and its edges for a line with widths: `(filled shapes, edge strokes)` as SVG path data.
fn road(view: &View, x: &[f32], z: &[f32], left: &[f32], right: &[f32], closed: bool) -> (String, String) {
    let e = edges(x, z, left, right, closed);
    let known = runs(left);
    let (mut fill, mut stroke) = (String::new(), String::new());
    let pts = |from: usize, to: usize, side: usize| -> Vec<(f64, f64)> { (from..to).map(|i| (e[i][side], e[i][side + 1])).collect() };
    if closed && known.len() == 1 && known[0] == (0, x.len()) {
        // A ring: the two edges are two closed outlines; the road is what lies between them.
        for side in [0, 2] {
            let p = path(view, &pts(0, x.len(), side));
            fill.push_str(&format!("{p} Z "));
            stroke.push_str(&format!("{p} Z "));
        }
    } else {
        for (from, to) in known {
            if to - from < 2 {
                continue;
            }
            let (l, mut r) = (pts(from, to, 0), pts(from, to, 2));
            r.reverse();
            fill.push_str(&format!("{} L{} Z ", path(view, &l), path(view, &r).trim_start_matches('M')));
            stroke.push_str(&format!("{} {} ", path(view, &pts(from, to, 0)), path(view, &pts(from, to, 2))));
        }
    }
    (fill, stroke)
}

pub fn svg(track: &Track) -> String {
    let c = &track.centerline;
    let mut cloud: Vec<(f64, f64)> = (0..c.x.len()).map(|i| (f64::from(c.x[i]), f64::from(c.z[i]))).collect();
    let e = edges(&c.x, &c.z, &c.left, &c.right, track.closed);
    cloud.extend(e.iter().filter(|p| p[0].is_finite()).flat_map(|p| [(p[0], p[1]), (p[2], p[3])]));
    if let Some(p) = &track.pitlane {
        cloud.extend((0..p.x.len()).map(|i| (f64::from(p.x[i]), f64::from(p.z[i]))));
    }
    let view = View::of(cloud.into_iter());
    let height = view.height + 70.0;

    let mut out = String::new();
    out.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {SIZE} {height:.0}\" font-family=\"sans-serif\">\n"
    ));
    out.push_str(&format!("<rect width=\"{SIZE}\" height=\"{height:.0}\" fill=\"#ffffff\"/>\n"));

    let (fill, stroke) = road(&view, &c.x, &c.z, &c.left, &c.right, track.closed);
    if !fill.is_empty() {
        out.push_str(&format!(
            "<path d=\"{fill}\" fill=\"#d9dde3\" fill-rule=\"evenodd\" stroke=\"none\"/>\n"
        ));
        out.push_str(&format!(
            "<path d=\"{stroke}\" fill=\"none\" stroke=\"#4b5563\" stroke-width=\"1.2\"/>\n"
        ));
    }
    let centre: Vec<(f64, f64)> = (0..c.x.len()).map(|i| (f64::from(c.x[i]), f64::from(c.z[i]))).collect();
    out.push_str(&format!(
        "<path d=\"{}{}\" fill=\"none\" stroke=\"#9ca3af\" stroke-width=\"0.8\" stroke-dasharray=\"6 4\"/>\n",
        path(&view, &centre),
        if track.closed { " Z" } else { "" }
    ));
    if let Some(p) = &track.pitlane {
        let (pfill, pstroke) = road(&view, &p.x, &p.z, &p.left, &p.right, false);
        if !pfill.is_empty() {
            out.push_str(&format!("<path d=\"{pfill}\" fill=\"#fde7c8\" stroke=\"none\"/>\n"));
            out.push_str(&format!(
                "<path d=\"{pstroke}\" fill=\"none\" stroke=\"#d97706\" stroke-width=\"0.8\"/>\n"
            ));
        }
        let line: Vec<(f64, f64)> = (0..p.x.len()).map(|i| (f64::from(p.x[i]), f64::from(p.z[i]))).collect();
        out.push_str(&format!(
            "<path d=\"{}\" fill=\"none\" stroke=\"#f59e0b\" stroke-width=\"2.2\"/>\n",
            path(&view, &line)
        ));
    }
    if let Some(f) = &track.fast {
        let line: Vec<(f64, f64)> = (0..f.x.len()).map(|i| (f64::from(f.x[i]), f64::from(f.z[i]))).collect();
        out.push_str(&format!(
            "<path d=\"{}{}\" fill=\"none\" stroke=\"#dc2626\" stroke-width=\"1.6\"/>\n",
            path(&view, &line),
            if track.closed { " Z" } else { "" }
        ));
    }
    let start = view.at(f64::from(c.x[0]), f64::from(c.z[0]));
    out.push_str(&format!(
        "<circle cx=\"{}\" cy=\"{}\" r=\"6\" fill=\"#16a34a\" stroke=\"#ffffff\" stroke-width=\"1.5\"/>\n",
        start.split(',').next().unwrap_or("0"),
        start.split(',').nth(1).unwrap_or("0")
    ));

    // Title and legend.
    let w = width_stats(&c.left, &c.right);
    let title = format!(
        "{} {} - {} - {:.0} m, {} points{}",
        track.game.to_uppercase(),
        track.name,
        track.variant.as_deref().unwrap_or("-"),
        track.length_m.unwrap_or(f64::from(c.dist.last().copied().unwrap_or(0.0))),
        c.x.len(),
        if w.known > 0 {
            format!(", road {:.1}-{:.1} m", w.min, w.max)
        } else {
            ", no width".to_owned()
        }
    );
    out.push_str(&format!(
        "<text x=\"{MARGIN}\" y=\"24\" font-size=\"16\" fill=\"#111827\">{}</text>\n",
        xml(&title)
    ));
    let y = view.height + 28.0;
    let legend = [
        ("#9ca3af", "centre line"),
        ("#4b5563", "road edges"),
        ("#dc2626", "ideal line"),
        ("#f59e0b", "pit lane"),
        ("#16a34a", "start (first point)"),
    ];
    for (i, (colour, label)) in legend.iter().enumerate() {
        let x = MARGIN + i as f64 * 180.0;
        out.push_str(&format!(
            "<rect x=\"{x}\" y=\"{}\" width=\"14\" height=\"6\" fill=\"{colour}\"/><text x=\"{}\" y=\"{}\" font-size=\"12\" fill=\"#374151\">{label}</text>\n",
            y - 6.0,
            x + 20.0,
            y
        ));
    }
    out.push_str(&format!(
        "<text x=\"{MARGIN}\" y=\"{}\" font-size=\"11\" fill=\"#6b7280\">x across, z down (the game's world, not mirrored); 1 px = {:.2} m; source {}</text>\n",
        y + 22.0,
        1.0 / view.scale,
        xml(&track.source)
    ));
    out.push_str("</svg>\n");
    out
}

fn xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracks::tests::golden_track;

    #[test]
    fn draws_the_road_the_lines_and_the_legend() {
        let text = svg(&golden_track());
        assert!(text.starts_with("<svg") && text.trim_end().ends_with("</svg>"));
        assert!(text.contains("fill=\"#d9dde3\"") && text.contains("stroke=\"#dc2626\"") && text.contains("stroke=\"#f59e0b\""));
        assert!(text.contains("TEST Track") || text.contains("AC Test Track"));
        assert!(!text.contains("NaN") && !text.contains("inf"));
    }

    #[test]
    fn draws_a_track_without_widths_or_extras() {
        let mut track = golden_track();
        track.fast = None;
        track.pitlane = None;
        track.centerline.left = vec![f32::NAN; 4];
        track.centerline.right = vec![f32::NAN; 4];
        let text = svg(&track);
        assert!(!text.contains("d9dde3") && text.contains("no width") && !text.contains("NaN"));
    }

    #[test]
    fn escapes_markup_in_names() {
        let mut track = golden_track();
        track.name = "A<&>B".into();
        assert!(svg(&track).contains("A&lt;&amp;&gt;B"));
    }
}
