use super::*;

/// A game for the waiting screen: its name, and its cover once Xpeed Companion has it from the Xpeed server (a small copy,
/// made once).
pub struct CoverArt {
    pub key: &'static str,
    pub name: &'static str,
    pub(super) image: *mut GpImage,
}

/// A cached make mark, loaded once and owned by the panel (never by its paint loop).
pub struct BrandArt {
    pub brand: crate::brands::Brand,
    pub(super) image: *mut GpImage,
}

impl BrandArt {
    pub(super) fn load() -> Vec<Self> {
        let Some(dir) = crate::brands::folder() else { return Vec::new() };
        let body = std::fs::read_to_string(dir.join("catalog.json")).unwrap_or_default();
        crate::brands::listed(&body)
            .into_iter()
            .filter_map(|brand| {
                let path = crate::brands::file_in(&dir, &brand.key)?;
                let hash = std::fs::read_to_string(dir.join(format!("{}.sha256", brand.key))).ok()?;
                if hash.trim() != brand.sha256 {
                    return None;
                }
                let image = load_thumbnail(&path, 80, 48);
                (!image.is_null()).then_some(Self { brand, image })
            })
            .collect()
    }
}

impl Drop for BrandArt {
    fn drop(&mut self) {
        if !self.image.is_null() {
            unsafe {
                GdipDisposeImage(self.image);
            }
        }
    }
}

impl CoverArt {
    /// The covers of the games installed here (every game Xpeed Companion reads when none was found), from its covers
    /// folder, at about twice the size they are drawn.
    pub fn load(installed: Option<&HashSet<&'static str>>) -> Vec<CoverArt> {
        crate::covers::GAMES
            .iter()
            .filter(|(key, _)| installed.is_none_or(|set| set.is_empty() || set.contains(key)))
            .map(|&(key, name)| CoverArt {
                key,
                name,
                image: crate::covers::file(key).map_or(null_mut(), |file| load_thumbnail(&file, 240, 360)),
            })
            .collect()
    }
}

impl Drop for CoverArt {
    fn drop(&mut self) {
        if !self.image.is_null() {
            unsafe {
                GdipDisposeImage(self.image);
            }
        }
    }
}

/// An image file as a GDI+ image of `w` × `h` pixels; null when GDI+ or the file cannot be read.
pub(super) fn load_thumbnail(file: &std::path::Path, w: u32, h: u32) -> *mut GpImage {
    if !gdiplus_ready() {
        return null_mut();
    }
    unsafe {
        let mut full = null_mut();
        let name = win::wide(&file.display().to_string());
        if GdipCreateBitmapFromFile(name.as_ptr(), &mut full) != 0 || full.is_null() {
            return null_mut();
        }
        let mut small = null_mut();
        let made = GdipGetImageThumbnail(full.cast(), w, h, &mut small, 0, null_mut()) == 0;
        GdipDisposeImage(full.cast());
        if !made {
            return null_mut();
        }
        // Kept in premultiplied 32-bit pixels, the format GDI+ draws without converting: drawing a cover took about
        // 7 ms each before, converting its pixels every time.
        let mut ready = null_mut();
        let cloned = GdipCloneBitmapAreaI(0, 0, w as i32, h as i32, PIXEL_FORMAT_32BPP_PARGB, small.cast(), &mut ready) == 0;
        if cloned && !ready.is_null() {
            GdipDisposeImage(small);
            ready.cast()
        } else {
            small
        }
    }
}

/// `PixelFormat32bppPARGB` of GDI+.
pub(super) const PIXEL_FORMAT_32BPP_PARGB: i32 = 0x000e_200b;

/// The covers' carousel: it moves on by one every few seconds, or when asked, sliding there with an ease.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Carousel {
    /// The cover it is going to (counts up and down without wrapping; the drawing wraps it).
    pub(super) target: i64,
    /// Where it was when it set off.
    pub(super) from: f32,
    /// When it set off (Unix ms).
    pub(super) since: i64,
    /// Where a mouse drag holds it, while the button is down.
    pub(super) held: Option<f32>,
}

/// How long a slide takes, and how long a cover stays in the middle before the next one comes.
pub(super) const SLIDE_MS: i64 = 800;

pub(super) const DWELL_MS: i64 = 3500;

impl Carousel {
    pub(super) fn new(now: i64) -> Carousel {
        Carousel {
            target: 0,
            from: 0.0,
            since: now,
            held: None,
        }
    }

    /// Where it is at `now`: eased in and out (gently away, gently in) from where it set off to where it is going.
    pub(super) fn at(&self, now: i64) -> f32 {
        if let Some(held) = self.held {
            return held;
        }
        let t = ((now - self.since) as f32 / SLIDE_MS as f32).clamp(0.0, 1.0);
        let eased = if t < 0.5 {
            4.0 * t * t * t
        } else {
            1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
        };
        self.from + (self.target as f32 - self.from) * eased
    }

    /// One step on (or back), from wherever it is now.
    pub(super) fn step(&mut self, by: i64, now: i64) {
        self.from = self.at(now);
        self.target += by;
        self.since = now;
    }

    /// Held by a drag at `at` (in covers, fractional).
    pub(super) fn hold(&mut self, at: f32) {
        self.held = Some(at);
    }

    /// Let go after a drag that started at `start`: it eases onto the nearest cover, leaning the way it was dragged
    /// (a fifth of a cover is enough to go on to the next one).
    pub(super) fn let_go(&mut self, start: f32, now: i64) {
        let Some(at) = self.held.take() else { return };
        let moved = at - start;
        let target = if moved > 0.2 {
            at.ceil()
        } else if moved < -0.2 {
            at.floor()
        } else {
            at.round()
        };
        self.from = at;
        self.target = target as i64;
        self.since = now;
    }

    /// Moves on by itself once a cover has had its time in the middle.
    pub(super) fn tick(&mut self, now: i64) {
        if self.held.is_none() && now - self.since >= SLIDE_MS + DWELL_MS {
            self.step(1, now);
        }
    }
}
