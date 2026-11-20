//! Native live track view. Preparation is cached; a frame projects only the local pieces of the real paths.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use windows_sys::Win32::Graphics::GdiPlus::{
    CombineModeIntersect, FillModeAlternate, FillModeWinding, GdipAddPathPolygon, GdipCreateLineBrush, GdipCreatePath, GdipCreatePen1,
    GdipCreateSolidFill, GdipDeleteBrush, GdipDeletePath, GdipDeletePen, GdipDrawLine, GdipDrawLines, GdipFillPath, GdipFillPolygon,
    GdipSetClipRect, GdipSetLinePresetBlend, GdipSetPenEndCap, GdipSetPenLineJoin, GdipSetPenStartCap, GpGraphics, LineCapRound,
    LineJoinRound, PointF, UnitPixel, WrapModeTile,
};

use super::*;
use crate::perspective::{self, Camera, Point, PreparedPath, Road};

#[derive(Clone, PartialEq)]
struct PathKey {
    address: usize,
    count: usize,
    first: Option<[u32; 2]>,
    last: Option<[u32; 2]>,
    complete: bool,
}

// Retaining the immutable source prevents its allocation address from being reused while its geometry is cached.
type PreparedEntry = Option<(PathKey, Arc<Vec<Point>>, Rc<PreparedPath>)>;
type PathCache = [PreparedEntry; 2];

thread_local! {
    static PATHS: RefCell<PathCache> = const { RefCell::new([None, None]) };
}

fn prepared(slot: usize, path: &Arc<Vec<Point>>, complete: bool) -> Rc<PreparedPath> {
    let bits = |p: &Point| [p.0.to_bits(), p.1.to_bits()];
    let key = PathKey {
        address: Arc::as_ptr(path) as usize,
        count: path.len(),
        first: path.first().map(bits),
        last: path.last().map(bits),
        complete,
    };
    PATHS.with(|cell| {
        let mut cache = cell.borrow_mut();
        let entry = &mut cache[slot];
        if entry.as_ref().is_none_or(|(old, _, _)| *old != key) {
            *entry = Some((key, Arc::clone(path), Rc::new(PreparedPath::new(path, complete))));
        }
        Rc::clone(&entry.as_ref().unwrap().2)
    })
}

/// Split screen segments into a continuous 8/5 px dash pattern, without restarting at every telemetry vertex.
fn dashed(segments: &[(Point, Point)]) -> Vec<(Point, Point)> {
    let mut out = Vec::new();
    let mut phase = 0.0_f32;
    let mut previous: Option<Point> = None;
    for &(a, b) in segments {
        if previous.is_some_and(|p| (p.0 - a.0).hypot(p.1 - a.1) > 0.1) {
            phase = 0.0;
        }
        let length = (b.0 - a.0).hypot(b.1 - a.1);
        let mut walked = 0.0;
        while walked < length {
            let on = phase < 8.0;
            let remaining = if on { 8.0 - phase } else { 13.0 - phase };
            let step = remaining.min(length - walked).max(0.001);
            if on {
                let point = |at: f32| (a.0 + (b.0 - a.0) * at / length, a.1 + (b.1 - a.1) * at / length);
                out.push((point(walked), point((walked + step).min(length))));
            }
            walked += step;
            phase = (phase + step) % 13.0;
        }
        previous = Some(b);
    }
    out
}

impl Painter {
    /// Actual source geometry only: no width is implied by the thin center path when native boundaries are absent.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn track_perspective(
        &self,
        area: (f32, f32, f32, f32),
        path: &PreparedPath,
        road: Option<&Road>,
        trail: &Arc<Vec<Point>>,
        reference: Option<&Arc<Vec<Point>>>,
        car: Point,
        heading: Point,
        mirrored: bool,
    ) -> bool {
        let (x, y, w, h) = area;
        if ![x, y, w, h, car.0, car.1, heading.0, heading.1].iter().all(|v| v.is_finite())
            || w <= 0.0
            || h <= 0.0
            || heading.0.hypot(heading.1) < 0.01
        {
            return false;
        }
        let trail = prepared(0, trail, false);
        let reference = reference.map(|p| prepared(1, p, true));
        let camera = Camera {
            width: w,
            height: h,
            car,
            heading,
            mirrored,
        };
        let scene = perspective::scene(camera, path, road, &trail, reference.as_deref());
        if !scene.has_layout() {
            return false;
        }
        let to_px = |p: Point| PointF {
            X: self.ox as f32 + (x + p.0) * self.s,
            Y: self.oy as f32 + (y + p.1) * self.s,
        };
        let strokes = |graphics: *mut GpGraphics, lines: &[(Point, Point)], color: COLORREF, width: f32| unsafe {
            // Sixteen alpha pens per series, rather than creating/deleting a GDI object for every vertex.
            for level in 1..=16 {
                let bucket: Vec<_> = lines
                    .iter()
                    .filter(|(a, b)| {
                        let alpha = perspective::ground_alpha((a.1 + b.1) * 0.5, h);
                        (alpha * 16.0).ceil() as i32 == level
                    })
                    .collect();
                if bucket.is_empty() {
                    continue;
                }
                let alpha = ((level as f32 / 16.0 * 255.0).round() as u32) << 24;
                let mut pen = null_mut();
                GdipCreatePen1(alpha | (argb(color) & 0x00ff_ffff), (width * self.s).max(0.8), UnitPixel, &mut pen);
                GdipSetPenLineJoin(pen, LineJoinRound);
                GdipSetPenStartCap(pen, LineCapRound);
                GdipSetPenEndCap(pen, LineCapRound);
                for &(a, b) in bucket {
                    let (a, b) = (to_px(a), to_px(b));
                    GdipDrawLine(graphics, pen, a.X, a.Y, b.X, b.Y);
                }
                GdipDeletePen(pen);
            }
        };
        smooth(self.hdc, |graphics| unsafe {
            let origin = to_px((0.0, 0.0));
            GdipSetClipRect(graphics, origin.X, origin.Y, w * self.s, h * self.s, CombineModeIntersect);
            if !scene.road.is_empty() {
                let bottom = to_px((0.0, h));
                let mut brush = null_mut();
                let colors = [argb(SECONDARY), argb(SECONDARY), argb(SECONDARY) & 0x00ff_ffff];
                let places = [0.0_f32, 0.72, 1.0];
                GdipCreateLineBrush(&origin, &bottom, colors[0], colors[2], WrapModeTile, &mut brush);
                GdipSetLinePresetBlend(brush, colors.as_ptr(), places.as_ptr(), 3);
                // Fill the entire strip once: antialiasing/transparency per quad
                // creates cracks and dark overlaps at shared source cross-sections.
                let mut road_path = null_mut();
                GdipCreatePath(FillModeWinding, &mut road_path);
                for polygon in &scene.road {
                    let points: Vec<_> = polygon.iter().map(|p| to_px(*p)).collect();
                    GdipAddPathPolygon(road_path, points.as_ptr(), points.len() as i32);
                }
                GdipFillPath(graphics, brush.cast(), road_path);
                GdipDeletePath(road_path);
                GdipDeleteBrush(brush.cast());
            }
            strokes(graphics, &scene.center, ROAD_LINE, 1.0);
            strokes(graphics, &scene.edges, ROAD_LINE, 1.0);
            strokes(graphics, &dashed(&scene.reference), INFO, 2.5);
            strokes(graphics, &scene.trail, PRIMARY, 3.0);
            // The arrow is intentionally outside the screen-space fade applied to all ground geometry.
            let mut brush = null_mut();
            let mut pen = null_mut();
            let mut points: Vec<_> = scene.arrow.iter().map(|p| to_px(*p)).collect();
            GdipCreateSolidFill(argb(PRIMARY), &mut brush);
            GdipFillPolygon(graphics, brush.cast(), points.as_ptr(), points.len() as i32, FillModeAlternate);
            GdipDeleteBrush(brush.cast());
            GdipCreatePen1(argb(BACKGROUND), (2.4 * self.s).max(1.0), UnitPixel, &mut pen);
            points.push(points[0]);
            GdipDrawLines(graphics, pen, points.as_ptr(), points.len() as i32);
            GdipDeletePen(pen);
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{dashed, prepared, Arc, Rc, PATHS};
    #[test]
    fn prepared_cache_retains_its_source_and_replaces_changed_interior_geometry() {
        PATHS.with(|cache| cache.borrow_mut()[0] = None);
        let source = Arc::new(vec![(0.0, 0.0), (0.0, 5.0), (0.0, 10.0)]);
        let weak = Arc::downgrade(&source);
        let first = prepared(0, &source, false);
        assert!(Rc::ptr_eq(&first, &prepared(0, &source, false)));
        drop(source);
        assert!(
            weak.upgrade().is_some(),
            "the cache owns the source allocation after the caller releases it"
        );
        let replacement = Arc::new(vec![(0.0, 0.0), (3.0, 5.0), (0.0, 10.0)]);
        let second = prepared(0, &replacement, false);
        assert!(!Rc::ptr_eq(&first, &second));
        assert!(second.local((3.0, 5.0), (0.0, 1.0)).contains(&(3.0, 5.0)));
        assert!(weak.upgrade().is_none(), "replacing the cache releases the old source");
        PATHS.with(|cache| cache.borrow_mut()[0] = None);
    }
    #[test]
    fn dashes_continue_across_telemetry_vertices() {
        let split = dashed(&[((0.0, 0.0), (3.0, 0.0)), ((3.0, 0.0), (7.0, 0.0)), ((7.0, 0.0), (16.0, 0.0))]);
        assert_eq!(
            split,
            vec![
                ((0.0, 0.0), (3.0, 0.0)),
                ((3.0, 0.0), (7.0, 0.0)),
                ((7.0, 0.0), (8.0, 0.0)),
                ((13.0, 0.0), (16.0, 0.0))
            ]
        );
    }
}
