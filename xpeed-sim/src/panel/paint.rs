use super::*;

/// GDI+ is started once for the process; shapes are drawn with it (smooth edges) when it starts, with plain GDI
/// otherwise.
pub(super) fn gdiplus_ready() -> bool {
    static READY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *READY.get_or_init(|| {
        let mut token = 0usize;
        let input = GdiplusStartupInput {
            GdiplusVersion: 1,
            ..Default::default()
        };
        unsafe { GdiplusStartup(&mut token, &input, null_mut()) == 0 }
    })
}

/// A GDI colour (`0x00BBGGRR`) as GDI+ wants it (`0xAARRGGBB`, opaque).
pub(super) fn argb(color: COLORREF) -> u32 {
    0xff00_0000 | (color & 0xff) << 16 | (color & 0xff00) | (color >> 16 & 0xff)
}

/// Runs `draw` with a GDI+ surface over `hdc`, smoothing on. False when GDI+ is not there.
pub(super) fn smooth(hdc: HDC, draw: impl FnOnce(*mut GpGraphics)) -> bool {
    if !gdiplus_ready() {
        return false;
    }
    unsafe {
        let mut graphics = null_mut();
        if GdipCreateFromHDC(hdc, &mut graphics) != 0 || graphics.is_null() {
            return false;
        }
        GdipSetSmoothingMode(graphics, SmoothingModeAntiAlias);
        GdipSetPixelOffsetMode(graphics, PixelOffsetModeHalf);
        draw(graphics);
        GdipDeleteGraphics(graphics);
    }
    true
}

/// The top edge of the rev bar at `t` (0 at the left end, 1 at the right): highest in the middle, `side` lower at
/// the ends, along a parabola.
pub(super) fn dome_top(y: f32, side: f32, t: f32) -> f32 {
    let from_middle = 2.0 * t - 1.0;
    y + side * from_middle * from_middle
}

/// The part of the rev bar from `t0` to `t1` (shares of its width) as a GDI+ path: the curved top, sampled finely
/// so it stays smooth, and the flat bottom. Filled directly (no clipping, which GDI+ does by whole pixels and would
/// turn the curve into steps).
pub(super) unsafe fn dome_part(x: f32, y: f32, w: f32, h: f32, side: f32, t0: f32, t1: f32) -> *mut GpPath {
    let mut path = null_mut();
    GdipCreatePath(FillModeAlternate, &mut path);
    let steps = ((t1 - t0) * 160.0).ceil().max(2.0) as usize;
    let mut points: Vec<PointF> = (0..=steps)
        .map(|i| {
            let t = t0 + (t1 - t0) * i as f32 / steps as f32;
            PointF {
                X: x + w * t,
                Y: dome_top(y, side, t),
            }
        })
        .collect();
    points.push(PointF { X: x + w * t1, Y: y + h });
    points.push(PointF { X: x + w * t0, Y: y + h });
    GdipAddPathLine2(path, points.as_ptr(), points.len() as i32);
    GdipClosePathFigure(path);
    path
}

/// A rounded rectangle as a GDI+ path (`radius` in pixels, no more than half the shorter side).
pub(super) unsafe fn rounded_path(x: f32, y: f32, w: f32, h: f32, radius: f32) -> *mut GpPath {
    let mut path = null_mut();
    GdipCreatePath(FillModeAlternate, &mut path);
    let d = (radius * 2.0).min(w).min(h).max(0.5);
    GdipAddPathArc(path, x, y, d, d, 180.0, 90.0);
    GdipAddPathArc(path, x + w - d, y, d, d, 270.0, 90.0);
    GdipAddPathArc(path, x + w - d, y + h - d, d, d, 0.0, 90.0);
    GdipAddPathArc(path, x, y + h - d, d, d, 90.0, 90.0);
    GdipClosePathFigure(path);
    path
}

pub(super) fn inside(r: &RECT, x: i32, y: i32) -> bool {
    x >= r.left && x < r.right && y >= r.top && y < r.bottom
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Face {
    /// Labels and running text.
    Ui,
    /// Numbers.
    Num,
    /// The small upper-case labels over the values.
    Label,
}

impl Face {
    /// The font name, the GDI weight to ask for and whether it is italic. Everything is in Chakra Petch (the owner's
    /// pick, 2026-11-12, over Bahnschrift, Racing Sans One, Russo One and Saira): numbers italic, words upright.
    pub(super) fn font(self, weight: i32) -> (&'static str, i32, bool) {
        let normal = FW_NORMAL as i32;
        match self {
            Face::Ui if weight >= FW_SEMIBOLD as i32 => ("Chakra Petch SemiBold", normal, false),
            Face::Ui => ("Chakra Petch", normal, false),
            Face::Label => ("Chakra Petch SemiBold", normal, false),
            Face::Num if weight >= FW_SEMIBOLD as i32 => ("Chakra Petch", FW_BOLD as i32, true),
            Face::Num => ("Chakra Petch Medium", normal, true),
        }
    }
}

/// Chakra Petch (SIL Open Font License 1.1, `assets/fonts/OFL.txt`), carried inside the program and made known to
/// this process only, so nothing is installed and every computer draws the same.
pub(super) fn register_fonts() {
    static DONE: std::sync::Once = std::sync::Once::new();
    DONE.call_once(|| {
        const FONTS: [&[u8]; 4] = [
            include_bytes!("../../assets/fonts/ChakraPetch-BoldItalic.ttf"),
            include_bytes!("../../assets/fonts/ChakraPetch-MediumItalic.ttf"),
            include_bytes!("../../assets/fonts/ChakraPetch-SemiBold.ttf"),
            include_bytes!("../../assets/fonts/ChakraPetch-Regular.ttf"),
        ];
        for font in FONTS {
            let mut added = 0u32;
            unsafe {
                // Windows writes the count through this pointer (declared const in the bindings).
                AddFontMemResourceEx(
                    font.as_ptr().cast(),
                    font.len() as u32,
                    null(),
                    std::ptr::addr_of_mut!(added).cast_const(),
                );
            }
        }
    });
}

/// Drawing over one device context in design units: `s` pixels per unit from the origin `(ox, oy)`. The fonts it
/// made are deleted when it is dropped.
pub(super) struct Painter {
    pub(super) hdc: HDC,
    pub(super) s: f32,
    pub(super) ox: i32,
    pub(super) oy: i32,
    pub(super) fonts: Vec<((i32, i32, Face), HFONT)>,
}

impl Painter {
    pub(super) fn new(hdc: HDC, s: f32) -> Painter {
        register_fonts();
        unsafe {
            SetBkMode(hdc, TRANSPARENT as i32);
        }
        Painter {
            hdc,
            s,
            ox: 0,
            oy: 0,
            fonts: Vec::new(),
        }
    }

    /// Design units from here on: `s` pixels each, starting at pixel `(ox, oy)`.
    pub(super) fn place(&mut self, s: f32, ox: i32, oy: i32) {
        (self.s, self.ox, self.oy) = (s, ox, oy);
    }

    pub(super) fn px(&self, v: f32) -> i32 {
        (v * self.s).round() as i32
    }

    /// A box in design units, as pixels.
    pub(super) fn r(&self, x: f32, y: f32, w: f32, h: f32) -> RECT {
        rect(
            self.ox + self.px(x),
            self.oy + self.px(y),
            self.ox + self.px(x + w),
            self.oy + self.px(y + h),
        )
    }

    pub(super) fn font(&mut self, size: f32, weight: i32, face: Face) -> HFONT {
        let key = (self.px(size).max(1), weight, face);
        if let Some((_, font)) = self.fonts.iter().find(|(k, _)| *k == key) {
            return *font;
        }
        let (name, gdi_weight, italic) = face.font(weight);
        let name = win::wide(name);
        // Big text is smoothed in grey (no colour fringes on the dark background); small text keeps ClearType.
        let quality = if key.0 >= 18 {
            ANTIALIASED_QUALITY as u32
        } else {
            CLEARTYPE_NATURAL_QUALITY
        };
        let font = unsafe {
            CreateFontW(
                -key.0,
                0,
                0,
                0,
                gdi_weight,
                u32::from(italic),
                0,
                0,
                DEFAULT_CHARSET as u32,
                OUT_DEFAULT_PRECIS as u32,
                CLIP_DEFAULT_PRECIS as u32,
                quality,
                0,
                name.as_ptr(),
            )
        };
        self.fonts.push((key, font));
        font
    }

    pub(super) fn fill(&self, r: RECT, color: COLORREF) {
        unsafe {
            let brush = CreateSolidBrush(color);
            FillRect(self.hdc, &r, brush);
            DeleteObject(brush);
        }
    }

    /// A rounded box; `edge` draws a one-pixel border in that colour.
    pub(super) fn round(&self, r: RECT, radius: f32, color: COLORREF, edge: Option<COLORREF>) {
        let (x, y, w, h) = (r.left as f32, r.top as f32, (r.right - r.left) as f32, (r.bottom - r.top) as f32);
        let radius_px = radius * self.s;
        let drawn = smooth(self.hdc, |graphics| unsafe {
            let path = rounded_path(x, y, w, h, radius_px);
            let mut brush = null_mut();
            GdipCreateSolidFill(argb(color), &mut brush);
            GdipFillPath(graphics, brush.cast(), path);
            GdipDeleteBrush(brush.cast());
            GdipDeletePath(path);
            if let Some(edge) = edge {
                // Half a pixel in, so the one-pixel line falls on whole pixels.
                let path = rounded_path(x + 0.5, y + 0.5, w - 1.0, h - 1.0, radius_px - 0.5);
                let mut pen = null_mut();
                GdipCreatePen1(argb(edge), 1.0, UnitPixel, &mut pen);
                GdipDrawPath(graphics, pen, path);
                GdipDeletePen(pen);
                GdipDeletePath(path);
            }
        });
        if drawn {
            return;
        }
        unsafe {
            let brush = CreateSolidBrush(color);
            let pen = edge.map(|c| CreatePen(PS_SOLID, 1, c));
            let old_brush = SelectObject(self.hdc, brush);
            let old_pen = SelectObject(self.hdc, pen.unwrap_or_else(|| GetStockObject(NULL_PEN)));
            let d = self.px(radius * 2.0).max(1);
            let grow = i32::from(edge.is_none());
            RoundRect(self.hdc, r.left, r.top, r.right + grow, r.bottom + grow, d, d);
            SelectObject(self.hdc, old_pen);
            SelectObject(self.hdc, old_brush);
            DeleteObject(brush);
            if let Some(pen) = pen {
                DeleteObject(pen);
            }
        }
    }

    /// The rev bar in design units: the dome filled `share` (0..1) of the way with the green-to-red gradient,
    /// divided in tenths; all blue when `flash_on` (time to shift).
    pub(super) fn rev_bar(&self, x: f32, y: f32, w: f32, h: f32, share: f32, flash_on: bool) {
        let (px, py, pw, ph) = (self.ox as f32 + x * self.s, self.oy as f32 + y * self.s, w * self.s, h * self.s);
        let fill = if share.is_finite() { share.clamp(0.0, 1.0) } else { 0.0 };
        let line_w = (2.0 * self.s).max(1.5);
        let side = ph * 0.45;
        let drawn = smooth(self.hdc, |graphics| unsafe {
            let whole = dome_part(px, py, pw, ph, side, 0.0, 1.0);
            let mut brush = null_mut();
            GdipCreateSolidFill(argb(if flash_on { BLUE } else { TRACK }), &mut brush);
            GdipFillPath(graphics, brush.cast(), whole);
            GdipDeleteBrush(brush.cast());
            GdipDeletePath(whole);
            if !flash_on && fill > 0.0 {
                let lit = dome_part(px, py, pw, ph, side, 0.0, fill);
                let (from, to) = (PointF { X: px, Y: py }, PointF { X: px + pw, Y: py });
                let mut gradient = null_mut();
                GdipCreateLineBrush(&from, &to, argb(REV_STOPS[0].1), argb(REV_STOPS[3].1), WrapModeTile, &mut gradient);
                let colors = REV_STOPS.map(|(_, c)| argb(c));
                let places = REV_STOPS.map(|(at, _)| at);
                GdipSetLinePresetBlend(gradient, colors.as_ptr(), places.as_ptr(), colors.len() as i32);
                GdipFillPath(graphics, gradient.cast(), lit);
                GdipDeleteBrush(gradient.cast());
                GdipDeletePath(lit);
            }
            // The divisions, cut in the background colour from the curve down.
            let mut pen = null_mut();
            GdipCreatePen1(argb(BG), line_w, UnitPixel, &mut pen);
            for i in 1..REV_DIVISIONS {
                let t = i as f32 / REV_DIVISIONS as f32;
                let lx = px + pw * t;
                GdipDrawLine(graphics, pen, lx, dome_top(py, side, t) - 2.0, lx, py + ph);
            }
            GdipDeletePen(pen);
        });
        if !drawn {
            self.fill(self.r(x, y + h * 0.45, w, h * 0.55), TRACK);
            self.fill(self.r(x, y + h * 0.45, w * fill, h * 0.55), if flash_on { BLUE } else { GREEN });
        }
    }

    /// The track in a box (design units): the path smoothed, turned so its long side follows the box's, and scaled to
    /// fit with a margin, drawn as a dark ribbon with a lighter line on top. A whole lap is a closed shape with a
    /// start/finish tick; a partial path is open, and is not drawn across a jump. The car is a yellow dot, placed
    /// with the same transform.
    pub(super) fn track_map(&self, (x, y, w, h): (f32, f32, f32, f32), path: &[(f32, f32)], complete: bool, car: Option<(f32, f32)>) {
        let key = MapKey {
            at: path.as_ptr() as usize,
            len: path.len(),
            ends: path
                .first()
                .zip(path.last())
                .map(|(a, b)| [a.0.to_bits(), a.1.to_bits(), b.0.to_bits(), b.1.to_bits()]),
            frame: [x, y, w, h].map(f32::to_bits),
            complete,
        };
        let prepared = MAP_CACHE.with(|cell| {
            let mut kept = cell.borrow_mut();
            if kept.as_ref().is_none_or(|(k, _)| *k != key) {
                *kept = prepare_map(path, complete, x + w / 2.0, y + h / 2.0, w, h).map(|p| (key, p));
            }
            kept.as_ref().map(|(_, p)| p.clone())
        });
        let Some(map) = prepared else {
            return;
        };
        let to_px = |(px, py): (f32, f32)| PointF {
            X: self.ox as f32 + px * self.s,
            Y: self.oy as f32 + py * self.s,
        };
        let road = (11.0 * self.s).max(3.0);
        let line = (2.5 * self.s).max(1.0);
        smooth(self.hdc, |graphics| unsafe {
            for (width, color) in [(road, TRACK), (line, mix(TRACK, TEXT, 0.5))] {
                let mut pen = null_mut();
                GdipCreatePen1(argb(color), width, UnitPixel, &mut pen);
                GdipSetPenLineJoin(pen, LineJoinRound);
                GdipSetPenStartCap(pen, LineCapRound);
                GdipSetPenEndCap(pen, LineCapRound);
                for run in &map.runs {
                    let points: Vec<PointF> = run.iter().map(|&p| to_px(p)).collect();
                    GdipDrawLines(graphics, pen, points.as_ptr(), points.len() as i32);
                }
                GdipDeletePen(pen);
            }
            if let Some((a, b)) = map.start {
                let mut pen = null_mut();
                GdipCreatePen1(argb(TEXT), (2.5 * self.s).max(1.5), UnitPixel, &mut pen);
                let (a, b) = (to_px(a), to_px(b));
                GdipDrawLine(graphics, pen, a.X, a.Y, b.X, b.Y);
                GdipDeletePen(pen);
            }
            if let Some(car) = car {
                let at = to_px(map.fit.apply(car));
                for (radius, color) in [(13.0, mix(BG, ACCENT, 0.3)), (7.0, ACCENT)] {
                    let mut brush = null_mut();
                    GdipCreateSolidFill(argb(color), &mut brush);
                    let d = radius * 2.0 * self.s;
                    GdipFillEllipse(graphics, brush.cast(), at.X - d / 2.0, at.Y - d / 2.0, d, d);
                    GdipDeleteBrush(brush.cast());
                }
            }
        });
    }

    /// The window's background: a light gradient from top to bottom, with very fine diagonal lines over it.
    ///
    /// It is drawn once for each window size and kept: a frame copies it (drawing its hundreds of lines every frame
    /// took most of a frame's time).
    pub(super) fn backdrop(&self, w: i32, h: i32) {
        let key = (w, h, self.px(7.0));
        BACKDROP.with(|cell| {
            let mut kept = cell.borrow_mut();
            if kept.as_ref().is_none_or(|b| b.key != key) {
                *kept = Some(Backdrop::new(self.hdc, key, |dc| draw_backdrop(dc, w, h, (7.0 * self.s).max(5.0))));
            }
            if let Some(b) = kept.as_ref() {
                unsafe {
                    BitBlt(self.hdc, 0, 0, w, h, b.dc, 0, 0, SRCCOPY);
                }
            }
        });
    }
}

/// What a prepared map was made from: the map's data (its address, length and ends) and the box, so it is made again
/// only when one of them changes.
#[derive(Clone, PartialEq)]
pub(super) struct MapKey {
    pub(super) at: usize,
    pub(super) len: usize,
    pub(super) ends: Option<[u32; 4]>,
    pub(super) frame: [u32; 4],
    pub(super) complete: bool,
}

/// A map ready to draw, in design units: the runs to draw, the start mark, and how the world is laid in the box.
#[derive(Clone)]
pub(super) struct PreparedMap {
    pub(super) runs: Vec<Vec<(f32, f32)>>,
    pub(super) start: Option<((f32, f32), (f32, f32))>,
    pub(super) fit: crate::maps::Fit,
}

/// Cuts the path at jumps, smooths it, fits it in the box (`cx`, `cy`, `w`, `h`) and finds the start mark of a whole
/// lap. Done once per map and box, not at every redraw.
pub(super) fn prepare_map(path: &[(f32, f32)], complete: bool, cx: f32, cy: f32, w: f32, h: f32) -> Option<PreparedMap> {
    let mut runs = crate::maps::split_at_gaps(path, crate::dash::MAP_JUMP_METRES);
    if runs.is_empty() {
        return None;
    }
    // A whole lap closes on itself (when it came with its first point repeated, that is dropped first).
    let closed = complete && runs.len() == 1;
    if closed && runs[0].len() > 3 && runs[0].first() == runs[0].last() {
        runs[0].pop();
    }
    let mut runs: Vec<Vec<(f32, f32)>> = runs.iter().map(|r| crate::maps::smooth(r, 3, closed)).collect();
    if closed {
        let first = runs[0][0];
        runs[0].push(first);
    }
    let all: Vec<(f32, f32)> = runs.iter().flatten().copied().collect();
    let fit = crate::maps::fit(&all, cx, cy, w, h, 18.0)?;
    let runs: Vec<Vec<(f32, f32)>> = runs.iter().map(|r| r.iter().map(|&p| fit.apply(p)).collect()).collect();
    // The start/finish mark: a tick across the road at the first point, square to the way the lap leaves it.
    let start = closed
        .then(|| {
            let run = &runs[0];
            let (a, b) = (run[0], *run.get(3).unwrap_or(&run[run.len() - 1]));
            let (dx, dy) = (b.0 - a.0, b.1 - a.1);
            let len = dx.hypot(dy);
            (len > 0.0).then(|| {
                (
                    (a.0 - dy / len * 9.0, a.1 + dx / len * 9.0),
                    (a.0 + dy / len * 9.0, a.1 - dx / len * 9.0),
                )
            })
        })
        .flatten();
    Some(PreparedMap { runs, start, fit })
}

thread_local! {
    /// The map as last prepared, for its box; one per thread (the window's, and each test's).
    static MAP_CACHE: std::cell::RefCell<Option<(MapKey, PreparedMap)>> = const { std::cell::RefCell::new(None) };
    /// The background as last drawn, for the window's size; one per thread (the window's, and each test's).
    static BACKDROP: std::cell::RefCell<Option<Backdrop>> = const { std::cell::RefCell::new(None) };
}

/// A 32-bit bitmap in plain memory (a DIB): GDI+ draws into it directly, much faster than into a device bitmap.
pub(super) unsafe fn dib(hdc: HDC, w: i32, h: i32) -> windows_sys::Win32::Graphics::Gdi::HBITMAP {
    use windows_sys::Win32::Graphics::Gdi::{CreateDIBSection, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS};
    let mut info: BITMAPINFO = std::mem::zeroed();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w.max(1),
        biHeight: -h.max(1),
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        ..std::mem::zeroed()
    };
    let mut bits = null_mut();
    CreateDIBSection(hdc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0)
}

/// A drawn background kept in a memory bitmap.
pub(super) struct Backdrop {
    pub(super) key: (i32, i32, i32),
    pub(super) dc: HDC,
    pub(super) bitmap: windows_sys::Win32::Graphics::Gdi::HBITMAP,
    pub(super) old: windows_sys::Win32::Graphics::Gdi::HGDIOBJ,
}

impl Backdrop {
    pub(super) fn new(like: HDC, key: (i32, i32, i32), draw: impl FnOnce(HDC)) -> Backdrop {
        unsafe {
            let dc = CreateCompatibleDC(like);
            let bitmap = dib(dc, key.0, key.1);
            let old = SelectObject(dc, bitmap);
            draw(dc);
            Backdrop { key, dc, bitmap, old }
        }
    }
}

impl Drop for Backdrop {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            DeleteObject(self.bitmap);
            DeleteDC(self.dc);
        }
    }
}

/// The background itself: a light gradient from top to bottom with very fine diagonal lines over it.
pub(super) fn draw_backdrop(hdc: HDC, w: i32, h: i32, step: f32) {
    let (fw, fh) = (w as f32, h as f32);
    let drawn = smooth(hdc, |graphics| unsafe {
        let (from, to) = (PointF { X: 0.0, Y: -1.0 }, PointF { X: 0.0, Y: fh + 1.0 });
        let mut gradient = null_mut();
        GdipCreateLineBrush(&from, &to, argb(BG_TOP), argb(BG_BOTTOM), WrapModeTile, &mut gradient);
        GdipFillRectangle(graphics, gradient.cast(), 0.0, 0.0, fw, fh);
        GdipDeleteBrush(gradient.cast());
        // Hairlines one pixel wide, crisp (no smoothing), white at a few per cent.
        GdipSetSmoothingMode(graphics, SmoothingModeNone);
        let mut pen = null_mut();
        GdipCreatePen1(0x09ff_ffff, 1.0, UnitPixel, &mut pen);
        let mut x = -fh;
        while x < fw {
            GdipDrawLine(graphics, pen, x, fh, x + fh, 0.0);
            x += step;
        }
        GdipDeletePen(pen);
    });
    if !drawn {
        unsafe {
            let brush = CreateSolidBrush(BG);
            FillRect(hdc, &rect(0, 0, w, h), brush);
            DeleteObject(brush);
        }
    }
}

impl Painter {
    /// A cover for a game Steam has no art for here: a dark card with two yellow racing stripes across its top
    /// corner and the game's name in the racing font. Xpeed's own design, not the game's art.
    pub(super) fn cover_card(&mut self, (x, y, w, h): (f32, f32, f32, f32), name: &str, scale: f32) {
        let k = h * 0.36 / (w * 0.48);
        smooth(self.hdc, |graphics| unsafe {
            let fill = |color: COLORREF, points: &[PointF]| {
                let mut path = null_mut();
                GdipCreatePath(FillModeAlternate, &mut path);
                GdipAddPathLine2(path, points.as_ptr(), points.len() as i32);
                GdipClosePathFigure(path);
                let mut brush = null_mut();
                GdipCreateSolidFill(argb(color), &mut brush);
                GdipFillPath(graphics, brush.cast(), path);
                GdipDeleteBrush(brush.cast());
                GdipDeletePath(path);
            };
            let pt = |px: f32, py: f32| PointF { X: px, Y: py };
            fill(mix(BG, CARD, 0.8), &[pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)]);
            // Two stripes parallel to the corner's edge: a wide one at the corner, a thin one beside it.
            fill(ACCENT, &[pt(x + w * 0.52, y), pt(x + w, y), pt(x + w, y + w * 0.48 * k)]);
            let (a, b) = (0.36, 0.44);
            fill(
                ACCENT,
                &[
                    pt(x + w * a, y),
                    pt(x + w * b, y),
                    pt(x + w, y + w * (1.0 - b) * k),
                    pt(x + w, y + w * (1.0 - a) * k),
                ],
            );
        });
        // The name, upper case, one word a line, in the middle.
        let words: Vec<String> = name.split_whitespace().map(str::to_uppercase).collect();
        let size = 22.0 * scale;
        let line = size * 1.1 * self.s;
        let top = y + h * 0.58 - line * words.len() as f32 / 2.0;
        for (i, word) in words.iter().enumerate() {
            let ly = top + line * i as f32;
            let r = rect(x as i32, ly as i32, (x + w) as i32, (ly + line) as i32);
            self.text(word, r, size, FW_SEMIBOLD as i32, Face::Num, TEXT, DT_CENTER);
        }
        self.fill(
            rect(x as i32, (y + h) as i32 - self.px(3.0), (x + w) as i32, (y + h) as i32),
            ACCENT,
        );
    }

    /// A box in design units as exact pixels (x, y, w, h), not rounded.
    pub(super) fn exact(&self, x: f32, y: f32, w: f32, h: f32) -> (f32, f32, f32, f32) {
        (self.ox as f32 + x * self.s, self.oy as f32 + y * self.s, w * self.s, h * self.s)
    }

    /// An image in an exact box. The carousel draws several every frame, so the settings are the fastest that still
    /// look right, as measured (`frame_times`): high-quality bilinear without the half-pixel offset took 1.4 ms a
    /// cover at full HD, against 4.9 ms for plain bilinear and 7 ms for bicubic with the offset.
    pub(super) fn image_exact(&self, (x, y, w, h): (f32, f32, f32, f32), image: *mut GpImage) {
        use windows_sys::Win32::Graphics::GdiPlus::{InterpolationModeHighQualityBilinear, PixelOffsetModeNone};
        smooth(self.hdc, |graphics| unsafe {
            GdipSetInterpolationMode(graphics, InterpolationModeHighQualityBilinear);
            GdipSetPixelOffsetMode(graphics, PixelOffsetModeNone);
            GdipDrawImageRect(graphics, image, x, y, w, h);
        });
    }

    /// A colour over an exact box with `amount` (0..1) of opacity: the shade over a cover drawn by `image_exact`. It
    /// uses the same pixel offset as the cover and reaches half a pixel past it on every side, so no edge of the cover
    /// is left unshaded (a lighter line showed at the right edge when the two were half a pixel apart).
    pub(super) fn veil_exact(&self, (x, y, w, h): (f32, f32, f32, f32), color: COLORREF, amount: f32) {
        use windows_sys::Win32::Graphics::GdiPlus::PixelOffsetModeNone;
        let alpha = ((amount.clamp(0.0, 1.0) * 255.0).round() as u32) << 24;
        smooth(self.hdc, |graphics| unsafe {
            GdipSetPixelOffsetMode(graphics, PixelOffsetModeNone);
            let mut brush = null_mut();
            GdipCreateSolidFill(alpha | (argb(color) & 0x00ff_ffff), &mut brush);
            GdipFillRectangle(graphics, brush.cast(), x - 0.5, y - 0.5, w + 1.0, h + 1.0);
            GdipDeleteBrush(brush.cast());
        });
    }

    /// An image filling a box (pixels), smoothly scaled.
    /// The lines `s` breaks into to fit `w` design units at this size (words kept whole).
    pub(super) fn wrap_lines(&mut self, s: &str, w: f32, size: f32, weight: i32, face: Face) -> Vec<String> {
        let mut lines: Vec<String> = Vec::new();
        for word in s.split_whitespace() {
            let longer = lines.last().map(|line| format!("{line} {word}"));
            match (lines.last_mut(), longer) {
                (Some(line), Some(longer)) if self.width_of(&longer, size, weight, face) <= w => *line = longer,
                _ => lines.push(word.to_owned()),
            }
        }
        lines
    }

    /// Text in as many lines as it needs to fit `w` design units, `line_h` apart, from `y` down; the height used.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn wrapped(
        &mut self,
        s: &str,
        x: f32,
        y: f32,
        w: f32,
        size: f32,
        weight: i32,
        face: Face,
        color: COLORREF,
        align: u32,
        line_h: f32,
    ) -> f32 {
        let lines = self.wrap_lines(s, w, size, weight, face);
        for (i, line) in lines.iter().enumerate() {
            let r = self.r(x, y + line_h * i as f32, w, line_h);
            self.text(line, r, size, weight, face, color, align);
        }
        line_h * lines.len() as f32
    }

    /// Draws only inside `r` until `unclip` (GDI and GDI+ both keep to it).
    pub(super) fn clip(&self, r: RECT) {
        unsafe {
            IntersectClipRect(self.hdc, r.left, r.top, r.right, r.bottom);
        }
    }

    pub(super) fn unclip(&self) {
        unsafe {
            SelectClipRgn(self.hdc, null_mut());
        }
    }

    pub(super) fn image(&self, r: RECT, image: *mut GpImage) {
        smooth(self.hdc, |graphics| unsafe {
            GdipSetInterpolationMode(graphics, InterpolationModeHighQualityBicubic);
            GdipDrawImageRectI(graphics, image, r.left, r.top, r.right - r.left, r.bottom - r.top);
        });
    }

    /// A pedal: a column of small square blocks filling from the bottom to `value` (0..1; a value the game does not
    /// give counts as released), in the segmented look of the delta bar. The rest of the column is a dim track.
    pub(super) fn pedal_blocks(&self, (x, y, w, h): Area, value: f32, color: COLORREF) {
        let area = self.r(x, y, w, h);
        let count = pedal_count(h);
        let lit = pedal_lit(value, count);
        // Whole pixels, so every gap is the same.
        let gap = (PEDAL_GAP * self.s).round().max(1.0);
        let total = (area.bottom - area.top) as f32;
        let seg = ((total - gap * (count as f32 - 1.0)) / count as f32).max(1.0);
        for i in 0..count {
            let off = i as f32 * (seg + gap);
            let bottom = area.bottom - off.round() as i32;
            let top = area.bottom - (off + seg).round() as i32;
            self.fill(
                rect(area.left, top.min(bottom - 1), area.right, bottom),
                if i < lit { color } else { TRACK },
            );
        }
    }

    /// The wheel as a slim bar: a trough with a tick at the centre and a yellow fill from the centre toward the side
    /// the wheel is turned to (-1 full left .. 1 full right; none without a value).
    pub(super) fn steer_bar(&self, (x, y, w, h): Area, steer: f32) {
        self.round(self.r(x, y, w, h), h / 2.0, TRACK, None);
        let share = steer_share(steer);
        let (half, len) = (w / 2.0, w / 2.0 * share.abs());
        if len >= 1.0 {
            let fx = if share > 0.0 { x + half } else { x + half - len };
            self.round(self.r(fx, y, len, h), (h / 2.0).min(len / 2.0), ACCENT, None);
        }
        let tick = if steer.is_finite() { TEXT } else { MUTED };
        self.fill(self.r(x + half - 1.0, y - 3.0, 2.0, h + 6.0), tick);
    }

    /// One light of the lights card, a squared tile of `cell`: lit it is filled with its colour (dark label), off it is
    /// dim (a thin edge, a dim label), and DRS allowed but not open it is outlined in its colour. Headlights are a small
    /// lamp, the flag a swatch of its colour with its word.
    pub(super) fn light_tile(&mut self, lang: Lang, pill: Pill, (x, y, w, h): Area) {
        let color = pill_color(pill.kind);
        let off = mix(CARD, BG, 0.4);
        let (fill, edge, ink) = match pill.glow {
            Glow::On => (color, None, BG),
            Glow::Ready => (off, Some(color), color),
            Glow::Off => (off, Some(EDGE), mix(CARD, MUTED, 0.5)),
        };
        self.round(self.r(x, y, w, h), CORNER, fill, edge);
        let label = match pill.kind {
            PillKind::Pit => Some("PIT".to_owned()),
            PillKind::Abs => Some("ABS".to_owned()),
            PillKind::Tc => Some("TC".to_owned()),
            PillKind::Drs => Some("DRS".to_owned()),
            PillKind::Fuel => Some(text(lang, &Msg::PanelLightFuel)),
            PillKind::Engine => Some(text(lang, &Msg::PanelLightEngine)),
            PillKind::Handbrake => Some(text(lang, &Msg::PanelLightHandbrake)),
            PillKind::Flag | PillKind::Headlights => None,
        };
        match (pill.kind, label) {
            (PillKind::Headlights, _) => self.headlamp(x + w / 2.0, y + h / 2.0, (h * 0.5).clamp(11.0, 16.0), ink),
            (PillKind::Flag, _) => {
                let sw = (h * 0.42).clamp(10.0, 16.0);
                self.flag_swatch(x + w / 2.0 - sw / 2.0, y + h / 2.0 - sw / 2.0, sw, pill.flag);
            }
            (_, Some(label)) => {
                let r = self.r(x, y, w, h);
                self.caps(&label, r, 9.5, ink, DT_CENTER);
            }
            _ => {}
        }
    }

    /// The flag's colour as a small square at (`x`, `y`): green, yellow, blue, white, black with a light edge, or
    /// chequered.
    pub(super) fn flag_swatch(&self, x: f32, y: f32, size: f32, flag: Option<crate::game::Flag>) {
        use crate::game::Flag;
        let Some(flag) = flag else { return };
        let radius = 1.5;
        match flag {
            Flag::Green => self.round(self.r(x, y, size, size), radius, GREEN, None),
            Flag::Yellow => self.round(self.r(x, y, size, size), radius, ACCENT, None),
            Flag::Blue => self.round(self.r(x, y, size, size), radius, BLUE, None),
            Flag::White => self.round(self.r(x, y, size, size), radius, WHITE, None),
            Flag::Black => self.round(self.r(x, y, size, size), radius, rgb(0x05, 0x05, 0x06), Some(MUTED)),
            Flag::Chequered => {
                self.round(self.r(x, y, size, size), radius, WHITE, None);
                let q = size / 2.0;
                self.fill(self.r(x, y, q, q), rgb(0x10, 0x10, 0x12));
                self.fill(self.r(x + q, y + q, q, q), rgb(0x10, 0x10, 0x12));
            }
        }
    }

    /// A small headlamp glyph centred at (`cx`, `cy`), `size` design units across: a lamp with three rays.
    pub(super) fn headlamp(&self, cx: f32, cy: f32, size: f32, color: COLORREF) {
        let to_px = |x: f32, y: f32| (self.ox as f32 + x * self.s, self.oy as f32 + y * self.s);
        smooth(self.hdc, |graphics| unsafe {
            let (lx, ly) = to_px(cx - size * 0.5, cy - size * 0.36);
            let (lw, lh) = (size * 0.5 * self.s, size * 0.72 * self.s);
            let mut brush = null_mut();
            GdipCreateSolidFill(argb(color), &mut brush);
            GdipFillEllipse(graphics, brush.cast(), lx, ly, lw, lh);
            GdipDeleteBrush(brush.cast());
            let mut pen = null_mut();
            GdipCreatePen1(argb(color), (1.4 * self.s).max(1.0), UnitPixel, &mut pen);
            GdipSetPenStartCap(pen, LineCapRound);
            GdipSetPenEndCap(pen, LineCapRound);
            for k in [-1.0_f32, 0.0, 1.0] {
                let (ax, ay) = to_px(cx + size * 0.18, cy + k * size * 0.3);
                let (bx, by) = to_px(cx + size * 0.5, cy + k * size * 0.42);
                GdipDrawLine(graphics, pen, ax, ay, bx, by);
            }
            GdipDeletePen(pen);
        });
    }

    /// A brake disc glyph centred at (`cx`, `cy`), `d` design units across: a disc with a hole and a hub.
    pub(super) fn brake_disc(&self, cx: f32, cy: f32, d: f32, color: COLORREF) {
        let to_px = |x: f32, y: f32| (self.ox as f32 + x * self.s, self.oy as f32 + y * self.s);
        smooth(self.hdc, |graphics| unsafe {
            for (size, c) in [(d, color), (d * 0.5, BG), (d * 0.2, color)] {
                let (x, y) = to_px(cx - size / 2.0, cy - size / 2.0);
                let mut brush = null_mut();
                GdipCreateSolidFill(argb(c), &mut brush);
                GdipFillEllipse(graphics, brush.cast(), x, y, size * self.s, size * self.s);
                GdipDeleteBrush(brush.cast());
            }
        });
    }

    /// The car's silhouette from above in `area`: a rounded body tapering to the nose, a cockpit opening, a wing at
    /// each end, all in a colour barely lighter than the background.
    pub(super) fn car_body(&self, area: Area) {
        let (x, y, w, h) = area;
        if w < 4.0 || h < 4.0 {
            return;
        }
        let body = mix(BG, MUTED, 0.14);
        let points: Vec<PointF> = body_outline(area)
            .into_iter()
            .map(|(px, py)| PointF {
                X: self.ox as f32 + px * self.s,
                Y: self.oy as f32 + py * self.s,
            })
            .collect();
        smooth(self.hdc, |graphics| unsafe {
            let mut path = null_mut();
            GdipCreatePath(FillModeAlternate, &mut path);
            GdipAddPathLine2(path, points.as_ptr(), points.len() as i32);
            GdipClosePathFigure(path);
            let mut brush = null_mut();
            GdipCreateSolidFill(argb(body), &mut brush);
            GdipFillPath(graphics, brush.cast(), path);
            GdipDeleteBrush(brush.cast());
            GdipDeletePath(path);
        });
        let cx = x + w / 2.0;
        // The wings across the two ends, the cockpit in the middle.
        let wing = mix(BG, MUTED, 0.22);
        self.round(self.r(cx - w * 0.36, y, w * 0.72, (h * 0.03).max(3.0)), 1.5, wing, None);
        self.round(
            self.r(cx - w * 0.4, y + h - (h * 0.035).max(3.0), w * 0.8, (h * 0.035).max(3.0)),
            1.5,
            wing,
            None,
        );
        self.round(
            self.r(cx - w * 0.17, y + h * 0.38, w * 0.34, h * 0.24),
            w * 0.15,
            mix(BG, MUTED, 0.04),
            None,
        );
    }

    /// A bar of `count` small blocks in design units; a block is lit (in `color`) when its middle falls between
    /// `from` and `to` (shares of the bar's width), dark otherwise.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn blocks(&self, x: f32, y: f32, w: f32, h: f32, count: usize, from: f32, to: f32, color: COLORREF) {
        // Square blocks a hair apart, laid out in whole pixels so every gap is the same.
        let area = self.r(x, y, w, h);
        let gap = (1.5 * self.s).round().max(1.0);
        let block = ((area.right - area.left) as f32 - gap * (count as f32 - 1.0)) / count as f32;
        for i in 0..count {
            let middle = (i as f32 + 0.5) / count as f32;
            let lit = from.is_finite() && to.is_finite() && middle >= from && middle <= to;
            let left = area.left + (i as f32 * (block + gap)).round() as i32;
            let right = area.left + (i as f32 * (block + gap) + block).round() as i32;
            self.fill(
                rect(left, area.top, right.max(left + 1), area.bottom),
                if lit { color } else { TRACK },
            );
        }
    }

    /// One line of text in a box, cut with "…" when it does not fit.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn text(&mut self, s: &str, r: RECT, size: f32, weight: i32, face: Face, color: COLORREF, align: u32) {
        // An empty string has a dangling pointer, and DrawTextW reads it even with a length of zero.
        if s.is_empty() {
            return;
        }
        let font = self.font(size, weight, face);
        if face == Face::Num {
            return self.tabular(s, r, font, color, align);
        }
        let wide: Vec<u16> = s.encode_utf16().collect();
        let mut r = r;
        unsafe {
            let old = SelectObject(self.hdc, font);
            SetTextColor(self.hdc, color);
            DrawTextW(
                self.hdc,
                wide.as_ptr(),
                wide.len() as i32,
                &mut r,
                align | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX | DT_END_ELLIPSIS,
            );
            SelectObject(self.hdc, old);
        }
    }

    /// Numbers with every digit in a slot as wide as the widest digit, so a running time does not shift sideways as
    /// its digits change (the fonts' own digits are proportional, and GDI cannot ask for their tabular ones).
    ///
    /// They are centred on their own height (the capital height), not on the font's line, which also holds room
    /// for descenders and would leave figures sitting high in their box.
    pub(super) fn tabular(&mut self, s: &str, r: RECT, font: HFONT, color: COLORREF, align: u32) {
        unsafe {
            let old = SelectObject(self.hdc, font);
            SetTextColor(self.hdc, color);
            let width = |c: char| {
                let mut unit = [0u16; 2];
                let unit = c.encode_utf16(&mut unit);
                let mut extent = SIZE { cx: 0, cy: 0 };
                GetTextExtentPoint32W(self.hdc, unit.as_ptr(), unit.len() as i32, &mut extent);
                extent.cx
            };
            let digit = ('0'..='9').map(width).max().unwrap_or(0);
            // The real ink of the letters and figures (not dots, colons or signs): how far above and below the
            // baseline it reaches. The text is placed so that ink is centred in the box.
            let identity = MAT2 {
                eM11: FIXED { fract: 0, value: 1 },
                eM12: FIXED { fract: 0, value: 0 },
                eM21: FIXED { fract: 0, value: 0 },
                eM22: FIXED { fract: 0, value: 1 },
            };
            let mut ink: Option<(i32, i32)> = None;
            for c in s.chars().filter(|c| c.is_alphanumeric()) {
                let mut glyph: GLYPHMETRICS = std::mem::zeroed();
                if GetGlyphOutlineW(self.hdc, c as u32, GGO_METRICS, &mut glyph, 0, null_mut(), &identity) == u32::MAX {
                    continue;
                }
                let above = glyph.gmptGlyphOrigin.y;
                let below = above - glyph.gmBlackBoxY as i32;
                ink = Some(ink.map_or((above, below), |(a, b)| (a.max(above), b.min(below))));
            }
            let mut metrics: TEXTMETRICW = std::mem::zeroed();
            let have_metrics = GetTextMetricsW(self.hdc, &mut metrics) != 0;
            let (vertical, top, line) = match ink {
                Some((above, below)) if have_metrics => {
                    let baseline = (r.top + r.bottom) / 2 + (above + below) / 2;
                    (DT_TOP, baseline - metrics.tmAscent, metrics.tmHeight)
                }
                _ => (DT_VCENTER, r.top, r.bottom - r.top),
            };
            let slots: Vec<(char, i32)> = s.chars().map(|c| (c, if c.is_ascii_digit() { digit } else { width(c) })).collect();
            let total: i32 = slots.iter().map(|(_, w)| w).sum();
            let mut x = if align == DT_RIGHT {
                r.right - total
            } else if align == DT_CENTER {
                (r.left + r.right - total) / 2
            } else {
                r.left
            };
            for (c, w) in slots {
                let mut unit = [0u16; 2];
                let unit = c.encode_utf16(&mut unit);
                let mut cell = if vertical == DT_TOP {
                    rect(x, top, x + w, top + line)
                } else {
                    rect(x, r.top, x + w, r.bottom)
                };
                DrawTextW(
                    self.hdc,
                    unit.as_ptr(),
                    unit.len() as i32,
                    &mut cell,
                    DT_CENTER | DT_SINGLELINE | vertical | DT_NOPREFIX | DT_NOCLIP,
                );
                x += w;
            }
            SelectObject(self.hdc, old);
        }
    }

    /// The width of a text, in design units.
    pub(super) fn width_of(&mut self, s: &str, size: f32, weight: i32, face: Face) -> f32 {
        if s.is_empty() {
            return 0.0;
        }
        let font = self.font(size, weight, face);
        let wide: Vec<u16> = s.encode_utf16().collect();
        let mut extent = SIZE { cx: 0, cy: 0 };
        unsafe {
            let old = SelectObject(self.hdc, font);
            GetTextExtentPoint32W(self.hdc, wide.as_ptr(), wide.len() as i32, &mut extent);
            SelectObject(self.hdc, old);
        }
        extent.cx as f32 / self.s
    }

    /// The font size, from `size` down to `floor`, at which `s` fits in `room` design units; never above `size`.
    pub(super) fn fitted(&mut self, s: &str, room: f32, size: f32, floor: f32, weight: i32, face: Face) -> f32 {
        let mut fit = fit_size(self.width_of(s, size, weight, face), size, room, floor);
        // Glyph widths round to whole pixels, so one more look at the result, and a step down while it still runs out.
        for _ in 0..3 {
            if fit <= floor || self.width_of(s, fit, weight, face) <= room {
                break;
            }
            fit = (fit * 0.95).max(floor);
        }
        fit
    }

    /// The mark of a lap that does not count: a red square with a white "!", `size` design units on a side.
    pub(super) fn invalid_mark(&self, x: f32, y: f32, size: f32) {
        self.round(self.r(x, y, size, size), size * 0.22, RED, None);
        let (bar, cx) = ((size * 0.14).max(1.0), x + size / 2.0);
        self.fill(self.r(cx - bar / 2.0, y + size * 0.2, bar, size * 0.38), WHITE);
        self.fill(self.r(cx - bar / 2.0, y + size * 0.68, bar, size * 0.14), WHITE);
    }

    /// A tile: the card colour with its border.
    pub(super) fn tile(&self, x: f32, y: f32, w: f32, h: f32, color: COLORREF) {
        self.round(self.r(x, y, w, h), CORNER, color, Some(EDGE));
    }

    /// A small upper-case label with its letters spaced out.
    ///
    /// The spacing also follows the last letter, which right or centred alignment would count as text and push the
    /// label off its place (and cut it); so the label is measured and placed by hand, without that last space.
    pub(super) fn caps(&mut self, s: &str, r: RECT, size: f32, color: COLORREF, align: u32) {
        let upper = s.to_uppercase();
        let extra = self.px(1.3);
        unsafe {
            SetTextCharacterExtra(self.hdc, extra);
        }
        // Chakra Petch's capitals are small for their size: drawn a little bigger to read like the old labels.
        let size = size * 1.18;
        let width = (self.width_of(&upper, size, FW_SEMIBOLD as i32, Face::Label) * self.s).round() as i32 - extra;
        let left = if align == DT_RIGHT {
            r.right - width
        } else if align == DT_CENTER {
            (r.left + r.right - width) / 2
        } else {
            r.left
        };
        let placed = rect(left.max(r.left), r.top, left + width + extra + self.px(4.0), r.bottom);
        self.text(&upper, placed, size, FW_SEMIBOLD as i32, Face::Label, color, DT_LEFT);
        unsafe {
            SetTextCharacterExtra(self.hdc, 0);
        }
    }

    /// The small upper-case label at the top left of a tile.
    pub(super) fn label(&mut self, s: &str, x: f32, y: f32, w: f32) {
        let r = self.r(x, y, w, 18.0);
        self.caps(s, r, 11.0, MUTED, DT_LEFT);
    }
}

impl Drop for Painter {
    fn drop(&mut self) {
        for (_, font) in &self.fonts {
            unsafe {
                DeleteObject(*font);
            }
        }
    }
}

pub(super) fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
    RECT { left, top, right, bottom }
}

/// The font size for a text measured `measured` wide at `size`, so that it fits in `room`: `size` itself when it
/// already fits, smaller in proportion when it does not, and never below `floor`.
pub(super) fn fit_size(measured: f32, size: f32, room: f32, floor: f32) -> f32 {
    if measured <= room || measured <= 0.0 {
        return size;
    }
    (size * room / measured).max(floor.min(size))
}

/// The flags of the languages, in the order of `Lang::ALL`: Nucleo's flag icons (`assets/flags/*.svg`), drawn once
/// into premultiplied 32-bit pixels at 120 x 96 (`*.bgra`, made from the SVGs with headless Chrome; `*.png` are the
/// same pixels to look at).
pub(super) const FLAG_W: i32 = 120;

pub(super) const FLAG_H: i32 = 96;

pub(super) static FLAG_PIXELS: [&[u8]; 3] = [
    include_bytes!("../../assets/flags/us.bgra"),
    include_bytes!("../../assets/flags/br.bgra"),
    include_bytes!("../../assets/flags/es.bgra"),
];

thread_local! {
    static FLAGS: std::cell::OnceCell<[usize; 3]> = const { std::cell::OnceCell::new() };
}

/// The flag of a language as a GDI+ image (made on first use, kept for the program's life); null without GDI+.
pub(super) fn flag_image(lang: Lang) -> *mut GpImage {
    let index = Lang::ALL.iter().position(|l| *l == lang).unwrap_or(0);
    FLAGS.with(|flags| {
        flags.get_or_init(|| {
            FLAG_PIXELS.map(|pixels| {
                if !gdiplus_ready() || pixels.len() != (FLAG_W * FLAG_H * 4) as usize {
                    return 0;
                }
                unsafe {
                    // A bitmap over the embedded pixels, copied at once into one GDI+ owns (the pixels are only read).
                    let mut over = null_mut();
                    let made = GdipCreateBitmapFromScan0(
                        FLAG_W,
                        FLAG_H,
                        FLAG_W * 4,
                        PIXEL_FORMAT_32BPP_PARGB,
                        pixels.as_ptr().cast_mut(),
                        &mut over,
                    ) == 0;
                    if !made || over.is_null() {
                        return 0;
                    }
                    let mut own = null_mut();
                    let copied = GdipCloneBitmapAreaI(0, 0, FLAG_W, FLAG_H, PIXEL_FORMAT_32BPP_PARGB, over, &mut own) == 0;
                    GdipDisposeImage(over.cast());
                    if copied {
                        own as usize
                    } else {
                        0
                    }
                }
            })
        })[index] as *mut GpImage
    })
}
