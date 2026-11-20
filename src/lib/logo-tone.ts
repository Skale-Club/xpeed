// Brand logos are drawn for a light page, and Xpeed is dark only, so they always sit on a dark page. A one-colour logo that is not already light
// (black Audi, Nissan, Toyota; grey Mercedes) would vanish or look dim there, so it is shown white; a dark logo with its own colours
// (the deep blue of VW) keeps them, brightened and with a thin light outline; anything else is shown as it is.

export type LogoTone = 'plain' | 'mono' | 'dark';

/** The tone of a logo from its RGBA pixels: only the opaque ones count. */
export function logoTone(pixels: ArrayLike<number>): LogoTone {
  let opaque = 0;
  let light = 0;
  let dark = 0;
  let colourful = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    opaque += 1;
    light += luminance;
    if (luminance < 0.25) dark += 1;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colourful += 1;
  }
  if (opaque === 0) return 'plain';
  // A small coloured emblem inside a grey ring (Alfa Romeo) is not one-colour: whitening it would leave a blank disc.
  if (colourful / opaque < 0.15) return light / opaque < 0.6 ? 'mono' : 'plain';
  return dark / opaque >= 0.5 ? 'dark' : 'plain';
}

/** The CSS filter that shows a logo of that tone well on a dark tile. */
export function logoToneFilter(tone: LogoTone | undefined): string | undefined {
  if (tone === 'mono') return 'brightness(0) invert(1)';
  if (tone === 'dark') return 'brightness(2.4) drop-shadow(0 0 0.6px rgba(255,255,255,0.8))';
  return undefined;
}

const tones = new Map<string, LogoTone>();

export function knownLogoTone(src: string): LogoTone | undefined {
  return tones.get(src);
}

/** Read a logo's pixels (the logo route sends CORS headers) and remember its tone; a logo that cannot be read is shown plain. */
export function readLogoTone(src: string): Promise<LogoTone> {
  const known = tones.get(src);
  if (known) return Promise.resolve(known);
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      let tone: LogoTone = 'plain';
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (context) {
          context.drawImage(image, 0, 0, 64, 64);
          tone = logoTone(context.getImageData(0, 0, 64, 64).data);
        }
      } catch {
        tone = 'plain';
      }
      tones.set(src, tone);
      resolve(tone);
    };
    image.onerror = () => resolve('plain');
    image.src = src;
  });
}
