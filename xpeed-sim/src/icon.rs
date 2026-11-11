//! The icon: the real Xpeed mark (`branding/mark.svg`, the one source of every Xpeed logo) on its rounded yellow
//! square, exactly as `public/logo.svg` lays it out. In the tray a small dot in the corner tells the state (grey:
//! paused, amber: waiting for the game, green: connected or recording, red: something needs attention).
//! Drawn in code from the mark's own coordinates, so there is no image to ship, and the same drawing makes the
//! `.ico` file the installer uses (without the dot).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Light {
    Grey,
    Amber,
    Green,
    Red,
}

type Rgba = [f32; 4];
/// `#F5E663`, the square of `public/logo.svg`.
const SQUARE: Rgba = [245.0, 230.0, 99.0, 1.0];
/// `#111214`, the mark of `public/logo.svg`.
const MARK_COLOR: Rgba = [17.0, 18.0, 20.0, 1.0];
const WHITE: Rgba = [255.0, 255.0, 255.0, 1.0];

/// The points of `branding/mark.svg` (viewBox 657.39 x 657.39), in order. The file repeats the first point at the end.
const MARK: [(f32, f32); 12] = [
    (606.66, 182.39),
    (475.0, 50.74),
    (328.7, 197.04),
    (182.39, 50.74),
    (50.74, 182.39),
    (197.04, 328.7),
    (50.74, 475.0),
    (182.39, 606.66),
    (328.7, 460.35),
    (475.0, 606.66),
    (606.66, 475.0),
    (460.35, 328.7),
];
/// How `public/logo.svg` places the mark inside its 512 x 512 square: `translate(87.04 87.04) scale(0.51403...)`.
const MARK_OFFSET: f32 = 87.04;
const MARK_SCALE: f32 = 0.514_032_77;
/// The corner radius of the square: `rx="112.64"` of 512.
const CORNER: f32 = 112.64 / 512.0;

fn light_color(light: Light) -> Rgba {
    match light {
        Light::Grey => [138.0, 138.0, 138.0, 1.0],
        Light::Amber => [245.0, 166.0, 35.0, 1.0],
        Light::Green => [46.0, 204.0, 113.0, 1.0],
        Light::Red => [229.0, 72.0, 77.0, 1.0],
    }
}

fn inside_rounded_square(u: f32, v: f32) -> bool {
    let (x, y) = (u - 0.5, v - 0.5);
    let half = 0.5;
    let (dx, dy) = (x.abs() - (half - CORNER), y.abs() - (half - CORNER));
    if dx <= 0.0 || dy <= 0.0 {
        x.abs() <= half && y.abs() <= half
    } else {
        dx * dx + dy * dy <= CORNER * CORNER
    }
}

/// Even-odd test of the point against the mark's polygon (the point is in 0..1 of the whole square).
fn inside_mark(u: f32, v: f32) -> bool {
    let (px, py) = (u * 512.0, v * 512.0);
    let at = |i: usize| (MARK_OFFSET + MARK_SCALE * MARK[i].0, MARK_OFFSET + MARK_SCALE * MARK[i].1);
    let mut inside = false;
    let mut j = MARK.len() - 1;
    for i in 0..MARK.len() {
        let ((xi, yi), (xj, yj)) = (at(i), at(j));
        if (yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// The colour of one point of the icon, with its alpha (0 outside the square).
fn sample(u: f32, v: f32, light: Option<Light>) -> Rgba {
    if !inside_rounded_square(u, v) {
        return [0.0; 4];
    }
    let mut color = if inside_mark(u, v) { MARK_COLOR } else { SQUARE };
    if let Some(light) = light {
        let to_dot = ((u - 0.8).powi(2) + (v - 0.8).powi(2)).sqrt();
        if to_dot <= 0.19 {
            color = WHITE;
        }
        if to_dot <= 0.14 {
            color = light_color(light);
        }
    }
    color
}

/// `size` x `size` pixels, B G R A, top row first, not premultiplied. `None` draws the plain logo, with no dot.
pub fn render(size: u32, light: Option<Light>) -> Vec<u8> {
    const SUB: u32 = 3;
    let mut pixels = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let (mut r, mut g, mut b, mut a) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
            for sy in 0..SUB {
                for sx in 0..SUB {
                    let u = (x as f32 + (sx as f32 + 0.5) / SUB as f32) / size as f32;
                    let v = (y as f32 + (sy as f32 + 0.5) / SUB as f32) / size as f32;
                    let c = sample(u, v, light);
                    r += c[0] * c[3];
                    g += c[1] * c[3];
                    b += c[2] * c[3];
                    a += c[3];
                }
            }
            let count = (SUB * SUB) as f32;
            if a > 0.0 {
                pixels.extend_from_slice(&[
                    (b / a).round() as u8,
                    (g / a).round() as u8,
                    (r / a).round() as u8,
                    (a / count * 255.0).round() as u8,
                ]);
            } else {
                pixels.extend_from_slice(&[0, 0, 0, 0]);
            }
        }
    }
    pixels
}

/// An `.ico` file with one 32-bit image per size (each at most 256).
pub fn ico_file(sizes: &[u32], light: Option<Light>) -> Vec<u8> {
    let images: Vec<(u32, Vec<u8>)> = sizes
        .iter()
        .map(|&size| {
            let pixels = render(size, light);
            let mut data = Vec::new();
            // BITMAPINFOHEADER: the height counts the colour rows and the mask rows.
            data.extend_from_slice(&40u32.to_le_bytes());
            data.extend_from_slice(&size.to_le_bytes());
            data.extend_from_slice(&(size * 2).to_le_bytes());
            data.extend_from_slice(&1u16.to_le_bytes());
            data.extend_from_slice(&32u16.to_le_bytes());
            data.extend_from_slice(&[0; 24]);
            // Colour rows run bottom-up.
            for row in (0..size as usize).rev() {
                data.extend_from_slice(&pixels[row * size as usize * 4..(row + 1) * size as usize * 4]);
            }
            // The AND mask: all zero, because the alpha channel does the work.
            data.extend(std::iter::repeat_n(0u8, (size.div_ceil(32) * 4 * size) as usize));
            (size, data)
        })
        .collect();
    let mut file = Vec::new();
    file.extend_from_slice(&[0, 0, 1, 0]);
    file.extend_from_slice(&(images.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * images.len() as u32;
    for (size, data) in &images {
        file.extend_from_slice(&[
            if *size >= 256 { 0 } else { *size as u8 },
            if *size >= 256 { 0 } else { *size as u8 },
            0,
            0,
        ]);
        file.extend_from_slice(&1u16.to_le_bytes());
        file.extend_from_slice(&32u16.to_le_bytes());
        file.extend_from_slice(&(data.len() as u32).to_le_bytes());
        file.extend_from_slice(&offset.to_le_bytes());
        offset += data.len() as u32;
    }
    for (_, data) in images {
        file.extend_from_slice(&data);
    }
    file
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(size: u32, light: Option<Light>, fx: f32, fy: f32) -> [u8; 4] {
        let pixels = render(size, light);
        let (x, y) = ((fx * size as f32) as usize, (fy * size as f32) as usize);
        let at = (y * size as usize + x) * 4;
        [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]]
    }
    const G: Option<Light> = Some(Light::Green);
    const SQUARE_BGRA: [u8; 4] = [99, 230, 245, 255];
    const MARK_BGRA: [u8; 4] = [20, 18, 17, 255];

    #[test]
    fn draws_a_square_of_the_asked_size() {
        assert_eq!(render(16, G).len(), 16 * 16 * 4);
        assert_eq!(render(32, None).len(), 32 * 32 * 4);
    }

    #[test]
    fn the_corners_are_see_through_and_the_body_is_the_logo_yellow() {
        assert_eq!(pixel(64, None, 0.0, 0.0)[3], 0);
        assert_eq!(pixel(64, None, 0.99, 0.0)[3], 0);
        assert_eq!(pixel(64, None, 0.08, 0.5), SQUARE_BGRA);
    }

    #[test]
    fn the_mark_is_there_in_all_four_arms_and_the_middle() {
        for (x, y) in [(0.5, 0.5), (0.32, 0.32), (0.672, 0.32), (0.32, 0.672), (0.672, 0.672)] {
            assert_eq!(pixel(64, None, x, y), MARK_BGRA, "({x}, {y})");
        }
        // Between two arms, the square shows through.
        for (x, y) in [(0.5, 0.2), (0.2, 0.5), (0.8, 0.5), (0.5, 0.8)] {
            assert_eq!(pixel(64, None, x, y), SQUARE_BGRA, "({x}, {y})");
        }
    }

    #[test]
    fn the_corner_dot_tells_the_state_and_leaves_the_other_arms_alone() {
        let (green, red) = (pixel(64, G, 0.8, 0.8), pixel(64, Some(Light::Red), 0.8, 0.8));
        assert_eq!(green, [113, 204, 46, 255]);
        assert_eq!(red, [77, 72, 229, 255]);
        assert_ne!(pixel(64, Some(Light::Amber), 0.8, 0.8), pixel(64, Some(Light::Grey), 0.8, 0.8));
        for (x, y) in [(0.32, 0.32), (0.672, 0.32), (0.32, 0.672), (0.08, 0.5)] {
            assert_eq!(pixel(64, G, x, y), pixel(64, None, x, y), "({x}, {y})");
        }
    }

    fn repo_file(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }
    fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
        let from = text.find(start).unwrap_or_else(|| panic!("`{start}` not found")) + start.len();
        &text[from..from + text[from..].find(end).unwrap_or_else(|| panic!("`{end}` not found"))]
    }
    fn numbers(text: &str) -> Vec<f32> {
        text.split(|c: char| c.is_whitespace() || c == ',')
            .filter(|t| !t.is_empty())
            .map(|t| t.parse().unwrap_or_else(|_| panic!("not a number: {t}")))
            .collect()
    }
    fn hex(text: &str) -> [f32; 3] {
        let v = u32::from_str_radix(text.trim_start_matches('#'), 16).unwrap();
        [(v >> 16) as f32, (v >> 8 & 255) as f32, (v & 255) as f32]
    }

    /// The single source of the Xpeed mark is `branding/mark.svg`; this copy of its points must be that file's, point
    /// for point. Change the mark there (and run `npm run brand`), never here: this test then tells you to update the
    /// copy.
    #[test]
    fn the_polygon_is_the_one_in_branding_mark_svg() {
        let svg = repo_file("branding/mark.svg");
        let points = numbers(between(&svg, "points=\"", "\""));
        assert_eq!(points.len(), 26, "12 points and the closing repeat of the first");
        for (i, (x, y)) in MARK.iter().enumerate() {
            assert_eq!((points[i * 2], points[i * 2 + 1]), (*x, *y), "point {i}");
        }
        assert_eq!(
            (points[24], points[25]),
            (points[0], points[1]),
            "the file closes the shape on its first point"
        );
        assert_eq!(numbers(between(&svg, "viewBox=\"", "\"")), [0.0, 0.0, 657.39, 657.39]);
    }

    /// And the layout and colours are those of `public/logo.svg`, which `npm run brand` writes from the mark.
    #[test]
    fn the_square_the_colours_and_the_placement_are_those_of_public_logo_svg() {
        let logo = repo_file("public/logo.svg");
        let rx: f32 = between(&logo, "rx=\"", "\"").parse().unwrap();
        assert!((rx / 512.0 - CORNER).abs() < 1e-6, "corner radius {rx}");
        let square = hex(between(&logo, "rx=\"112.64\" fill=\"", "\""));
        assert_eq!(square, [SQUARE[0], SQUARE[1], SQUARE[2]]);
        let mark = hex(between(&logo, "<g fill=\"", "\""));
        assert_eq!(mark, [MARK_COLOR[0], MARK_COLOR[1], MARK_COLOR[2]]);
        let translate = numbers(between(&logo, "translate(", ")"));
        assert!(translate.iter().all(|t| (t - MARK_OFFSET).abs() < 0.001), "translate {translate:?}");
        let scale = numbers(between(&logo, "scale(", ")"));
        assert!((scale[0] - MARK_SCALE).abs() < 1e-6, "scale {scale:?}");
    }

    /// The drawing must be the real logo, not a look-alike: compared with the PNG every other Xpeed icon comes from.
    #[test]
    fn matches_the_official_icon_of_the_app() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/icon-512.png");
        let decoder = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).expect("public/icon-512.png")));
        let mut reader = decoder.read_info().unwrap();
        let mut official = vec![0u8; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut official).unwrap();
        assert_eq!((info.width, info.height), (512, 512));
        let mine = render(512, None);
        let (mut total, mut off) = (0u64, 0u64);
        for (i, px) in official.chunks_exact(4).enumerate() {
            // The PNG is R G B A; the drawing is B G R A.
            let drawn = [mine[i * 4 + 2], mine[i * 4 + 1], mine[i * 4], mine[i * 4 + 3]];
            let diff: u64 = px.iter().zip(drawn).map(|(a, b)| u64::from(a.abs_diff(b))).sum();
            total += diff;
            if diff > 120 {
                off += 1;
            }
        }
        let mean = total as f64 / (512.0 * 512.0 * 4.0);
        // Only anti-aliased edge pixels may differ.
        assert!(mean < 1.5, "mean difference per channel {mean}");
        assert!(off < 3000, "{off} pixels differ a lot");
    }

    #[test]
    fn writes_an_ico_file_windows_can_read() {
        let file = ico_file(&[16, 32, 256], None);
        assert_eq!(&file[..6], &[0, 0, 1, 0, 3, 0]);
        let entry = |n: usize| &file[6 + 16 * n..6 + 16 * (n + 1)];
        assert_eq!((entry(0)[0], entry(1)[0], entry(2)[0]), (16, 32, 0), "256 is written as 0");
        let mut end = 6 + 48;
        for n in 0..3 {
            let size = u32::from_le_bytes(entry(n)[8..12].try_into().unwrap()) as usize;
            let offset = u32::from_le_bytes(entry(n)[12..16].try_into().unwrap()) as usize;
            assert_eq!(offset, end, "images follow each other");
            assert_eq!(&file[offset..offset + 4], &40u32.to_le_bytes());
            end = offset + size;
        }
        assert_eq!(end, file.len());
        // 16 x 16: header 40 + 16*16*4 colour + 16 rows of a 4-byte mask.
        assert_eq!(u32::from_le_bytes(entry(0)[8..12].try_into().unwrap()), 40 + 1024 + 64);
    }

    /// For looking at the icons: `XPEED_ICON_PREVIEW=dir cargo test writes_icons_to_look_at -- --ignored` writes one
    /// `.ico` per state (and the plain logo) into `dir`.
    #[test]
    #[ignore]
    fn writes_icons_to_look_at() {
        let dir = std::path::PathBuf::from(std::env::var("XPEED_ICON_PREVIEW").expect("set XPEED_ICON_PREVIEW to a folder"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plain.ico"), ico_file(&[256, 48, 32, 16], None)).unwrap();
        for (name, light) in [
            ("grey", Light::Grey),
            ("amber", Light::Amber),
            ("green", Light::Green),
            ("red", Light::Red),
        ] {
            std::fs::write(dir.join(format!("{name}.ico")), ico_file(&[256, 48, 32, 16], Some(light))).unwrap();
        }
    }
}
