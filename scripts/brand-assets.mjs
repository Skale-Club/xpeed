// Regenerates every Xpeed logo and icon from branding/mark.svg, so they all
// change together: the in-app logo, favicon, PWA / home-screen icons, the
// link-preview image and the Android launcher icons and splash screens.
// Run after editing the mark (or the colors below): `npm run brand`.
// Colors match the app tokens in src/index.css (--primary, --background).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const YELLOW = '#F5E663';
const DARK = '#111214';

const source = fs.readFileSync(path.join(root, 'branding/mark.svg'), 'utf8');
const BOX = Number(/viewBox="0 0 ([\d.]+)/.exec(source)[1]);
const MARK = source.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '');

/** The mark, `size` px wide, centered at (cx, cy). */
const mark = (cx, cy, size, fill) =>
  `<g fill="${fill}" transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${size / BOX})">${MARK}</g>`;

/** Square icon: yellow tile (rounded, square or round) with the dark mark. */
function tileSvg(size, { radius = 0.22, markScale = 0.66, shape = 'rounded' } = {}) {
  const bg = shape === 'circle'
    ? `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${YELLOW}"/>`
    : `<rect width="${size}" height="${size}" rx="${shape === 'square' ? 0 : size * radius}" fill="${YELLOW}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}${mark(size / 2, size / 2, size * markScale, DARK)}</svg>`;
}

const out = (rel) => path.join(root, rel);
const png = (svg, rel) => sharp(Buffer.from(svg)).png().toFile(out(rel));

/** ICO container holding PNG images (supported by every current browser). */
async function ico(sizes, rel) {
  const images = await Promise.all(sizes.map((s) => sharp(Buffer.from(tileSvg(s))).png().toBuffer()));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(sizes[i], e);
    header.writeUInt8(sizes[i], e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(img.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  fs.writeFileSync(out(rel), Buffer.concat([header, ...images]));
}

// Web: in-app logo and tab icon, then home-screen icons. "maskable" is
// full-bleed with the mark inside the safe zone; iOS rounds corners itself.
fs.writeFileSync(out('public/logo.svg'), `${tileSvg(512)}\n`);
await ico([16, 32, 48], 'public/favicon.ico');
await png(tileSvg(192), 'public/icon-192.png');
await png(tileSvg(512), 'public/icon-512.png');
await png(tileSvg(512, { shape: 'square', markScale: 0.5 }), 'public/icon-maskable-512.png');
await png(tileSvg(180, { shape: 'square', markScale: 0.6 }), 'public/apple-touch-icon.png');

// Link previews (WhatsApp, etc.).
await png(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><radialGradient id="g" cx="50%" cy="0%" r="80%"><stop offset="0" stop-color="${YELLOW}" stop-opacity="0.12"/><stop offset="1" stop-color="${YELLOW}" stop-opacity="0"/></radialGradient></defs>
  <rect width="1200" height="630" fill="${DARK}"/><rect width="1200" height="630" fill="url(#g)"/>
  <rect x="110" y="195" width="240" height="240" rx="53" fill="${YELLOW}"/>${mark(230, 315, 158, DARK)}
  <text x="410" y="320" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="120" font-weight="800" fill="#F1F2F4" letter-spacing="-3">Xpeed</text>
  <text x="414" y="395" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="42" fill="#9A9DA6">Seu carro, sem complicação.</text>
</svg>`, 'public/og-image-default.png');

// Android launcher: legacy square and round icons, and the adaptive
// foreground (mark within the central 66 of 108 dp) on the yellow background.
const res = 'android/app/src/main/res';
// Status-bar icons are monochrome masks; keep the notification on the same brand source.
const notificationPoints = /points="([^"]+)"/.exec(source)[1].match(/[\d.]+/g);
const notificationPath = Array.from({ length: notificationPoints.length / 2 }, (_, i) =>
  `${i ? 'L' : 'M'}${notificationPoints[i * 2]},${notificationPoints[i * 2 + 1]}`).join(' ') + ' Z';
fs.writeFileSync(out(`${res}/drawable/ic_stat_xpeed.xml`),
  `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated from branding/mark.svg by npm run brand. Android tints this monochrome mark. -->\n<vector xmlns:android="http://schemas.android.com/apk/res/android"\n    android:width="24dp" android:height="24dp" android:viewportWidth="${BOX}" android:viewportHeight="${BOX}">\n    <path android:fillColor="#FFFFFFFF" android:pathData="${notificationPath}" />\n</vector>\n`);
for (const [dir, px] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
  await png(tileSvg(px, { radius: 0.2 }), `${res}/mipmap-${dir}/ic_launcher.png`);
  await png(tileSvg(px, { shape: 'circle', markScale: 0.56 }), `${res}/mipmap-${dir}/ic_launcher_round.png`);
  const fg = Math.round(px * 2.25);
  await png(`<svg xmlns="http://www.w3.org/2000/svg" width="${fg}" height="${fg}">${mark(fg / 2, fg / 2, fg * 0.42, DARK)}</svg>`, `${res}/mipmap-${dir}/ic_launcher_foreground.png`);
}
fs.writeFileSync(out(`${res}/values/ic_launcher_background.xml`),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${YELLOW}</color>\n</resources>\n`);

// Android splash screens: the tile centered on the dark background, at each existing size.
for (const dir of fs.readdirSync(out(res)).filter((d) => d.startsWith('drawable'))) {
  const file = `${res}/${dir}/splash.png`;
  if (!fs.existsSync(out(file))) continue;
  const { width, height } = await sharp(out(file)).metadata();
  const t = Math.round(Math.min(width, height) * 0.3);
  await png(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${DARK}"/>
    <rect x="${(width - t) / 2}" y="${(height - t) / 2}" width="${t}" height="${t}" rx="${t * 0.22}" fill="${YELLOW}"/>${mark(width / 2, height / 2, t * 0.66, DARK)}</svg>`, file);
}

console.log('Brand assets regenerated from branding/mark.svg');
