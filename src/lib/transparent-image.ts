/** Verify that a same-origin/CORS-enabled PNG or WebP has meaningful transparent pixels. */
export function hasTransparentPixels(data: Uint8ClampedArray, threshold = 16): boolean {
  let transparent = 0;
  const count = data.length / 4;
  if (!count) return false;
  for (let index = 3; index < data.length; index += 4) if (data[index] < threshold) transparent++;
  return transparent / count >= 0.01;
}

export function isTransparentImage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const extension = new URL(url, window.location.href).pathname.toLowerCase().split('.').pop();
    if (extension !== 'png' && extension !== 'webp') return resolve(false);
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return resolve(false);
        context.drawImage(image, 0, 0, 64, 64);
        resolve(hasTransparentPixels(context.getImageData(0, 0, 64, 64).data));
      } catch { resolve(false); }
    };
    image.onerror = () => resolve(false);
    image.src = url;
  });
}
