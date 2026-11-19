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

thread_local! {
    /// Whether the elements being drawn are not live (see `Painter::set_dim`).
    static DIMMED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// A colour as the element being drawn shows it: dimmed when it is not live.
pub(super) fn ink(color: COLORREF) -> COLORREF {
    if DIMMED.get() {
        dim(color)
    } else {
        color
    }
}

impl Role {
    /// The token a meaning is drawn in.
    pub(super) fn colour(self) -> COLORREF {
        match self {
            Role::Text => FOREGROUND,
            Role::Muted => MUTED_TEXT,
            Role::Primary => PRIMARY,
            Role::Good => SUCCESS,
            Role::Danger => DESTRUCTIVE,
            Role::Warn => WARN,
            Role::Best => BEST,
            Role::Info => INFO,
            Role::Cold => STEEL,
        }
    }
}

/// The colour a light lights in, by what it means: amber for warnings of the driver's own doing (fuel, the pit
/// limiter), red for the car's (engine, handbrake), blue, green and cyan for aids and lamps being active.
pub(super) fn pill_color(kind: PillKind) -> COLORREF {
    match kind {
        PillKind::Pit | PillKind::Fuel => WARN,
        PillKind::Abs => INFO,
        PillKind::Tc | PillKind::Drs => SUCCESS,
        PillKind::Engine | PillKind::Handbrake => DESTRUCTIVE,
        PillKind::Headlights => CYAN,
        PillKind::Flag => MUTED_TEXT,
    }
}

/// How a light looks: its fill, an outline when it needs one and the ink of its words. Off, it is dark with a quiet
/// name; ready (DRS allowed), outlined and named in its colour; on, a solid tile in its colour with dark ink (a black
/// flag is dark with a light edge and light ink).
pub(super) fn alert_look(light: &Light) -> (COLORREF, Option<COLORREF>, COLORREF) {
    use crate::game::Flag;
    match light.glow {
        Glow::Off => return (BACKGROUND, Some(BORDER), LIGHT_OFF_INK),
        Glow::Ready => return (BACKGROUND, Some(pill_color(light.kind)), pill_color(light.kind)),
        Glow::On => {}
    }
    match (light.kind, light.flag) {
        (PillKind::Flag, Some(Flag::Green)) => (SUCCESS, None, ON_PRIMARY),
        (PillKind::Flag, Some(Flag::Yellow)) => (PRIMARY, None, ON_PRIMARY),
        (PillKind::Flag, Some(Flag::Blue)) => (INFO, None, ON_PRIMARY),
        (PillKind::Flag, Some(Flag::White | Flag::Chequered)) => (FLAG_WHITE, None, ON_PRIMARY),
        (PillKind::Flag, Some(Flag::Black)) => (FLAG_BLACK, Some(MUTED_TEXT), FOREGROUND),
        (kind, _) => (pill_color(kind), None, ON_PRIMARY),
    }
}

/// A GDI colour (`0x00BBGGRR`) as GDI+ wants it (`0xAARRGGBB`, opaque).
pub(super) fn argb(color: COLORREF) -> u32 {
    let color = ink(color);
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

/// How many blocks a bar `w` design pixels wide has: `BAR_BLOCKS`, fewer on a short bar so a block is never narrower
/// than `BAR_BLOCK_MIN_W`.
pub(super) fn bar_block_count(w: f32) -> usize {
    ((w / BAR_BLOCK_MIN_W).floor() as usize).clamp(1, BAR_BLOCKS)
}

/// The left and right pixel of each of `count` blocks between `left` and `right`, `gap` whole pixels apart, so every
/// gap is the same and the last block ends on `right`.
pub(super) fn block_spans(left: i32, right: i32, count: usize, gap: i32) -> Vec<(i32, i32)> {
    let count = count.max(1);
    let pitch = ((right - left + gap) as f32 / count as f32).max(1.0);
    // Each block starts on a rounded pitch and ends a whole gap before the next one starts: the gaps are exact, a block
    // may be a pixel wider than its neighbour.
    let start = |i: usize| left + (i as f32 * pitch).round() as i32;
    (0..count)
        .map(|i| {
            let l = start(i);
            let r = if i + 1 == count { right } else { start(i + 1) - gap };
            (l, r.max(l + 1))
        })
        .collect()
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

    /// From here on every colour is drawn as an element that is not live shows it (`dim`), or as it is. Returns what it
    /// was, to put back.
    pub(super) fn set_dim(&mut self, on: bool) -> bool {
        DIMMED.replace(on)
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
            let brush = CreateSolidBrush(ink(color));
            FillRect(self.hdc, &r, brush);
            DeleteObject(brush);
        }
    }

    /// A box with the panel's one corner (`R_CORNER`); `edge` draws a one-pixel border in that colour. It takes no
    /// radius on purpose: no view can draw a second corner (owner decision, see `tokens::R_CORNER`).
    pub(super) fn round(&self, r: RECT, color: COLORREF, edge: Option<COLORREF>) {
        let (x, y, w, h) = (r.left as f32, r.top as f32, (r.right - r.left) as f32, (r.bottom - r.top) as f32);
        let radius = R_CORNER;
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
            let brush = CreateSolidBrush(ink(color));
            let pen = edge.map(|c| CreatePen(PS_SOLID, 1, ink(c)));
            let old_brush = SelectObject(self.hdc, brush);
            let old_pen = SelectObject(self.hdc, pen.unwrap_or_else(|| GetStockObject(NULL_PEN)));
            let d = self.px(radius * 2.0).min(r.right - r.left).min(r.bottom - r.top).max(1);
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
            GdipCreateSolidFill(argb(if flash_on { INFO } else { SECONDARY }), &mut brush);
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
            GdipCreatePen1(argb(BACKGROUND), line_w, UnitPixel, &mut pen);
            for i in 1..REV_DIVISIONS {
                let t = i as f32 / REV_DIVISIONS as f32;
                let lx = px + pw * t;
                GdipDrawLine(graphics, pen, lx, dome_top(py, side, t) - 2.0, lx, py + ph);
            }
            GdipDeletePen(pen);
        });
        if !drawn {
            self.fill(self.r(x, y + h * 0.45, w, h * 0.55), SECONDARY);
            self.fill(self.r(x, y + h * 0.45, w * fill, h * 0.55), if flash_on { INFO } else { SUCCESS });
        }
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

thread_local! {
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
        GdipCreateLineBrush(&from, &to, argb(BACKDROP_TOP), argb(BACKDROP_BOTTOM), WrapModeTile, &mut gradient);
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
            let brush = CreateSolidBrush(BACKGROUND);
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
            fill(COVER_PLACEHOLDER, &[pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)]);
            // Two stripes parallel to the corner's edge: a wide one at the corner, a thin one beside it.
            fill(PRIMARY, &[pt(x + w * 0.52, y), pt(x + w, y), pt(x + w, y + w * 0.48 * k)]);
            let (a, b) = (0.36, 0.44);
            fill(
                PRIMARY,
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
        let size = (T_VALUE * scale).max(T_CAPTION);
        let line = size * 1.1 * self.s;
        let top = y + h * 0.58 - line * words.len() as f32 / 2.0;
        for (i, word) in words.iter().enumerate() {
            let ly = top + line * i as f32;
            let r = rect(x as i32, ly as i32, (x + w) as i32, (ly + line) as i32);
            self.text(word, r, size, FW_SEMIBOLD as i32, Face::Num, FOREGROUND, DT_CENTER);
        }
        self.fill(
            rect(x as i32, (y + h) as i32 - self.px(3.0), (x + w) as i32, (y + h) as i32),
            PRIMARY,
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

    /// Every bar of the panel: a row of square blocks a hair apart (`BAR_BLOCKS`, `BAR_BLOCK_GAP`), a block lit in
    /// `color` when its middle falls between `from` and `to` (shares of the width), dark otherwise. Owner decision
    /// (see `tokens::BAR_BLOCKS`): bars are never one continuous rounded fill.
    fn blocks(&self, (x, y, w, h): Area, from: f32, to: f32, color: COLORREF) {
        let area = self.r(x, y, w, h);
        let count = bar_block_count(w);
        let gap = (BAR_BLOCK_GAP * self.s).round().max(1.0) as i32;
        for (i, (left, right)) in block_spans(area.left, area.right, count, gap).into_iter().enumerate() {
            let middle = (i as f32 + 0.5) / count as f32;
            let lit = from.is_finite() && to.is_finite() && middle >= from && middle <= to;
            self.fill(rect(left, area.top, right, area.bottom), if lit { color } else { SECONDARY });
        }
    }

    /// A bar filled from the left: the blocks up to `frac` (0..1) are lit; nothing is lit without a value.
    pub(super) fn solid_bar(&self, area: Area, frac: f32, color: COLORREF) {
        let frac = if frac.is_finite() { frac.clamp(0.0, 1.0) } else { 0.0 };
        self.blocks(area, 0.0, frac, color);
    }

    /// A bar with its zero in the middle: the blocks from the middle to `frac` (0..1, a half is the middle) are lit,
    /// with a tick of `tick` at the middle.
    pub(super) fn centred_bar(&self, (x, y, w, h): Area, frac: f32, color: COLORREF, tick: COLORREF) {
        let frac = if frac.is_finite() { frac.clamp(0.0, 1.0) } else { 0.5 };
        self.blocks((x, y, w, h), frac.min(0.5), frac.max(0.5), color);
        self.fill(self.r(x + w / 2.0 - 1.0, y - 3.0, 2.0, h + 6.0), tick);
    }

    /// The wheel as a slim bar with a tick at the centre and a yellow fill from the centre toward the side the wheel is
    /// turned to (-1 full left .. 1 full right; straight, and a muted tick, without a value).
    pub(super) fn steer_bar(&self, area: Area, steer: f32) {
        let tick = if steer.is_finite() { FOREGROUND } else { MUTED_TEXT };
        self.centred_bar(area, 0.5 + steer_share(steer) / 2.0, PRIMARY, tick);
    }

    /// The tank: blocks lit `share` (0..1) of the way in `color`, with a thin tick every `tick` (a share of the whole)
    /// so each tick is one lap's worth of fuel. Ticks closer than three pixels are left out.
    pub(super) fn tank_bar(&self, (x, y, w, h): Area, share: f32, tick: Option<f32>, color: COLORREF) {
        let share = if share.is_finite() { share.clamp(0.0, 1.0) } else { 0.0 };
        self.blocks((x, y, w, h), 0.0, share, color);
        if let Some(tick) = tick.filter(|t| t.is_finite() && *t > 0.0 && t * w * self.s >= 3.0) {
            let mut at = tick;
            while at < 0.999 {
                self.fill(self.r(x + at * w - 1.0, y, 2.0, h), CARD);
                at += tick;
            }
        }
    }

    /// The delta along the lap (owner-approved module 5, 2026-11-19): a zero line across the middle, the area between the
    /// delta and zero in green where the lap is ahead (under the line) and red where it is behind (over it), the delta as
    /// a light line, and a yellow mark where the car is. `trace` is (share of the lap 0..1, seconds); the graph spans the
    /// whole lap, so it grows from left to right. The scale is the largest delta, `DELTA_TRACE_MIN_S`..`DELTA_TRACE_MAX_S`.
    pub(super) fn delta_trace(&self, (x, y, w, h): Area, trace: &[(f32, f32)]) {
        let r = self.r(x, y, w, h);
        let (px, py, pw, ph) = (r.left as f32, r.top as f32, (r.right - r.left) as f32, (r.bottom - r.top) as f32);
        let zero = (py + ph / 2.0).round();
        self.fill(rect(r.left, zero as i32, r.right, zero as i32 + 1), SECONDARY);
        if trace.len() < 2 {
            return;
        }
        let largest = trace.iter().fold(0.0_f32, |m, &(_, d)| m.max(d.abs()));
        let span = largest.clamp(DELTA_TRACE_MIN_S, DELTA_TRACE_MAX_S);
        let half = ph / 2.0 - 1.0;
        let to = |&(at, d): &(f32, f32)| PointF {
            X: px + pw * at.clamp(0.0, 1.0),
            Y: zero - d.clamp(-span, span) / span * half,
        };
        let points: Vec<PointF> = trace.iter().map(to).collect();
        let (ahead, behind) = (tint(CARD, SUCCESS, DELTA_TRACE_FILL), tint(CARD, DESTRUCTIVE, DELTA_TRACE_FILL));
        let line_w = (1.5 * self.s).max(1.0);
        smooth(self.hdc, |graphics| unsafe {
            let quad = |corners: [PointF; 4], colour: COLORREF| {
                let mut path = null_mut();
                GdipCreatePath(FillModeAlternate, &mut path);
                GdipAddPathLine2(path, corners.as_ptr(), 4);
                GdipClosePathFigure(path);
                let mut brush = null_mut();
                GdipCreateSolidFill(argb(colour), &mut brush);
                GdipFillPath(graphics, brush.cast(), path);
                GdipDeleteBrush(brush.cast());
                GdipDeletePath(path);
            };
            let base = |x: f32| PointF { X: x, Y: zero };
            let shade = |d: f32| if d < 0.0 { ahead } else { behind };
            for (p, t) in points.windows(2).zip(trace.windows(2)) {
                let (a, b, da, db) = (p[0], p[1], t[0].1, t[1].1);
                if da * db < 0.0 {
                    // The delta crosses zero here: each side of the crossing in its own colour.
                    let cross = a.X + (b.X - a.X) * (da / (da - db));
                    let mid = PointF { X: cross, Y: zero };
                    quad([base(a.X), a, mid, mid], shade(da));
                    quad([mid, mid, b, base(b.X)], shade(db));
                } else {
                    quad([base(a.X), a, b, base(b.X)], shade(da + db));
                }
            }
            let mut pen = null_mut();
            GdipCreatePen1(argb(FOREGROUND), line_w, UnitPixel, &mut pen);
            let mut path = null_mut();
            GdipCreatePath(FillModeAlternate, &mut path);
            GdipAddPathLine2(path, points.as_ptr(), points.len() as i32);
            GdipDrawPath(graphics, pen, path);
            GdipDeletePath(path);
            GdipDeletePen(pen);
            let now = points[points.len() - 1].X;
            let mut mark = null_mut();
            GdipCreatePen1(argb(PRIMARY), line_w, UnitPixel, &mut mark);
            GdipDrawLine(graphics, mark, now, py, now, py + ph);
            GdipDeletePen(mark);
        });
    }

    /// A tyre seen from above (owner decision 2026-11-19, `TyreShape`): dark sidewalls around the tread, and the tread as
    /// one block or three bands a hair apart, each in the colour of its temperature, with thin grooves across.
    pub(super) fn tyre_shape(&self, (x, y, w, h): Area, shape: TyreShape) {
        self.round(self.r(x, y, w, h), TYRE_SIDEWALL, None);
        let wall = (w * 0.09).max(2.0);
        let tread = self.r(x + wall, y + wall, (w - 2.0 * wall).max(1.0), (h - 2.0 * wall).max(1.0));
        let colours: &[COLORREF] = match &shape {
            TyreShape::Solid(c) => std::slice::from_ref(c),
            TyreShape::Bands(c) => c,
        };
        let gap = (BAR_BLOCK_GAP * self.s).round().max(1.0) as i32;
        let pitch = (TYRE_GROOVE_PITCH * self.s).round().max(4.0) as i32;
        let spans = block_spans(tread.left, tread.right, colours.len(), gap);
        for ((left, right), colour) in spans.into_iter().zip(colours) {
            self.fill(rect(left, tread.top, right, tread.bottom), *colour);
            let mut gy = tread.top + pitch;
            while gy < tread.bottom - 1 {
                self.fill(rect(left, gy, right, gy + 1), groove_of(*colour));
                gy += pitch;
            }
        }
    }

    /// A light's tile, as `alert_look` says: off dark with its quiet name, ready outlined in its colour, on a solid tile
    /// in its colour with dark ink (light ink on a black flag).
    pub(super) fn alert_tile(&mut self, light: &Light, (x, y, w, h): Area) {
        let (fill, edge, ink) = alert_look(light);
        self.round(self.r(x, y, w, h), fill, edge);
        let r = self.r(x, y, w, h);
        self.caps_fit(&light.word, r, T_CAPTION, S2, ink, DT_CENTER);
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
            SetTextColor(self.hdc, ink(color));
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
            SetTextColor(self.hdc, ink(color));
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
        // Only the sizes of the type scale: the largest step that still fits.
        type_step(fit).max(floor)
    }

    /// The mark of a lap that does not count: a red square with a white "!", `size` design units on a side.
    pub(super) fn invalid_mark(&self, x: f32, y: f32, size: f32) {
        self.round(self.r(x, y, size, size), DESTRUCTIVE, None);
        let (bar, cx) = ((size * 0.14).max(1.0), x + size / 2.0);
        self.fill(self.r(cx - bar / 2.0, y + size * 0.2, bar, size * 0.38), FLAG_WHITE);
        self.fill(self.r(cx - bar / 2.0, y + size * 0.68, bar, size * 0.14), FLAG_WHITE);
    }

    /// A tile: the card colour with its border.
    pub(super) fn tile(&self, x: f32, y: f32, w: f32, h: f32, color: COLORREF) {
        self.round(self.r(x, y, w, h), color, Some(BORDER));
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
        let size = size * CAPS_SCALE;
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

    /// Where the ink of `s` (its letters and figures, not dots or signs) falls when `text` draws it in a box `box_h`
    /// design units tall: its top and bottom, in design units from the box's top. Figures (`Face::Num`) are centred on
    /// their ink, other faces on the font's line, exactly as `text` places them. Nothing without a letter or figure.
    pub(super) fn ink_span(&mut self, s: &str, size: f32, weight: i32, face: Face, box_h: f32) -> Option<(f32, f32)> {
        let font = self.font(size, weight, face);
        let identity = MAT2 {
            eM11: FIXED { fract: 0, value: 1 },
            eM12: FIXED { fract: 0, value: 0 },
            eM21: FIXED { fract: 0, value: 0 },
            eM22: FIXED { fract: 0, value: 1 },
        };
        let (mut ink, mut metrics): (Option<(i32, i32)>, TEXTMETRICW) = (None, unsafe { std::mem::zeroed() });
        let have_metrics = unsafe {
            let old = SelectObject(self.hdc, font);
            for c in s.chars().filter(|c| c.is_alphanumeric()) {
                let mut glyph: GLYPHMETRICS = std::mem::zeroed();
                if GetGlyphOutlineW(self.hdc, c as u32, GGO_METRICS, &mut glyph, 0, null_mut(), &identity) == u32::MAX {
                    continue;
                }
                let above = glyph.gmptGlyphOrigin.y;
                let below = above - glyph.gmBlackBoxY as i32;
                ink = Some(ink.map_or((above, below), |(a, b)| (a.max(above), b.min(below))));
            }
            let have = GetTextMetricsW(self.hdc, &mut metrics) != 0;
            SelectObject(self.hdc, old);
            have
        };
        let (above, below) = ink.filter(|_| have_metrics)?;
        let box_px = self.px(box_h);
        let baseline = if face == Face::Num {
            box_px / 2 + (above + below) / 2
        } else {
            (box_px - metrics.tmHeight) / 2 + metrics.tmAscent
        };
        Some(((baseline - above) as f32 / self.s, (baseline - below) as f32 / self.s))
    }

    /// `ink_span` of an upper-case label as `caps` draws it.
    pub(super) fn caps_ink_span(&mut self, s: &str, size: f32, box_h: f32) -> Option<(f32, f32)> {
        self.ink_span(&s.to_uppercase(), size * CAPS_SCALE, FW_SEMIBOLD as i32, Face::Label, box_h)
    }

    /// `caps` at `size`, or smaller (never under `T_LABEL_MIN`) when the label would not fit the box's width less `pad`
    /// on each side: a word never runs out of its tile (owner, 2026-11-19).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn caps_fit(&mut self, s: &str, r: RECT, size: f32, pad: f32, color: COLORREF, align: u32) {
        let room = ((r.right - r.left) as f32 / self.s - 2.0 * pad).max(1.0);
        let size = self.caps_fit_size(s, size, room);
        self.caps(s, r, size, color, align);
    }

    /// The size `caps_fit` draws `s` at to fit `room` design units, from `size` down to `T_LABEL_MIN`.
    pub(super) fn caps_fit_size(&mut self, s: &str, size: f32, room: f32) -> f32 {
        let mut fit = size;
        for _ in 0..6 {
            let wide = self.caps_width(s, fit);
            if wide <= room || fit <= T_LABEL_MIN {
                break;
            }
            // In proportion, then a little more while it still runs out (glyph widths round to whole pixels).
            fit = (fit * (room / wide).min(0.97)).max(T_LABEL_MIN);
        }
        fit
    }

    /// The width of an upper-case label as `caps` draws it, in design units.
    pub(super) fn caps_width(&mut self, s: &str, size: f32) -> f32 {
        let upper = s.to_uppercase();
        let extra = self.px(1.3);
        unsafe {
            SetTextCharacterExtra(self.hdc, extra);
        }
        let width = self.width_of(&upper, size * CAPS_SCALE, FW_SEMIBOLD as i32, Face::Label);
        unsafe {
            SetTextCharacterExtra(self.hdc, 0);
        }
        width - extra as f32 / self.s
    }

    /// `s` cut with an ellipsis so it is no wider than `room` design units at this size (as is when it already fits).
    pub(super) fn clipped(&mut self, s: &str, room: f32, size: f32, weight: i32, face: Face) -> String {
        if self.width_of(s, size, weight, face) <= room {
            return s.to_owned();
        }
        let mut kept: Vec<char> = s.chars().collect();
        while !kept.is_empty() {
            kept.pop();
            let candidate = kept.iter().collect::<String>().trim_end().to_owned() + "\u{2026}";
            if self.width_of(&candidate, size, weight, face) <= room {
                return candidate;
            }
        }
        String::new()
    }

    /// The width numbers are drawn with (`tabular`), in design units: every digit in a slot as wide as the widest.
    pub(super) fn tabular_width(&mut self, s: &str, size: f32, weight: i32) -> f32 {
        let font = self.font(size, weight, Face::Num);
        unsafe {
            let old = SelectObject(self.hdc, font);
            let width = |c: char| {
                let mut unit = [0u16; 2];
                let unit = c.encode_utf16(&mut unit);
                let mut extent = SIZE { cx: 0, cy: 0 };
                GetTextExtentPoint32W(self.hdc, unit.as_ptr(), unit.len() as i32, &mut extent);
                extent.cx
            };
            let digit = ('0'..='9').map(width).max().unwrap_or(0);
            let total: i32 = s.chars().map(|c| if c.is_ascii_digit() { digit } else { width(c) }).sum();
            SelectObject(self.hdc, old);
            total as f32 / self.s
        }
    }

    /// Numbers with a line struck through them in `strike`: a time that does not count.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn text_struck(&mut self, s: &str, r: RECT, size: f32, weight: i32, color: COLORREF, align: u32, strike: COLORREF) {
        if s.is_empty() {
            return;
        }
        self.text(s, r, size, weight, Face::Num, color, align);
        let total = (self.tabular_width(s, size, weight) * self.s).round() as i32;
        let left = if align == DT_RIGHT {
            r.right - total
        } else if align == DT_CENTER {
            (r.left + r.right - total) / 2
        } else {
            r.left
        };
        let thick = self.px(1.5).max(1);
        let mid = (r.top + r.bottom) / 2;
        self.fill(rect(left, mid - thick / 2, left + total, mid - thick / 2 + thick), strike);
    }

    /// The small upper-case label at the top left of a tile.
    pub(super) fn label(&mut self, s: &str, x: f32, y: f32, w: f32) {
        let r = self.r(x, y, w, 18.0);
        self.caps(s, r, T_CAPTION, MUTED_TEXT, DT_LEFT);
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

/// Chakra Petch's capitals are small for their size: `caps` draws its labels this much bigger.
pub(super) const CAPS_SCALE: f32 = 1.18;

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
