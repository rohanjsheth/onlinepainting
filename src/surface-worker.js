// All relief is synthesized locally. No model or remote processing is involved.
function blur(source, width, height, radius) {
  const tmp = new Float32Array(source.length);
  const out = new Float32Array(source.length);
  const count = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += source[row + Math.max(0, Math.min(width - 1, k))];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / count;
      sum += source[row + Math.min(width - 1, x + radius + 1)] - source[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[Math.max(0, Math.min(height - 1, k)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / count;
      sum += tmp[Math.min(height - 1, y + radius + 1) * width + x] - tmp[Math.max(0, y - radius) * width + x];
    }
  }
  return out;
}

function createSurface({ pixels, width, height }) {
  const rgba = new Uint8ClampedArray(pixels);
  const count = width * height;
  const luminance = new Float32Array(count);
  for (let i = 0; i < count; i++) luminance[i] = (rgba[i * 4] * .2126 + rgba[i * 4 + 1] * .7152 + rgba[i * 4 + 2] * .0722) / 255;
  // Exclude near-black photographic backdrops connected to the image border.
  // Interior dark pigment still gets relief, while the backdrop cannot become paint.
  const backdrop = new Uint8Array(count);
  const queue = new Int32Array(count);
  let tail = 0;
  const enqueue = (i) => {
    if (backdrop[i] || Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) > 18) return;
    backdrop[i] = 1; queue[tail++] = i;
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  for (let head = 0; head < tail; head++) {
    const i = queue[head], x = i % width;
    if (x > 0) enqueue(i - 1);
    if (x < width - 1) enqueue(i + 1);
    if (i >= width) enqueue(i - width);
    if (i < count - width) enqueue(i + width);
  }
  const fine = blur(luminance, width, height, 1);
  const broad = blur(fine, width, height, 5);
  const coarse = blur(broad, width, height, 12);
  const xx = new Float32Array(count), yy = new Float32Array(count), xy = new Float32Array(count);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const dx = fine[i + 1] - fine[i - 1], dy = fine[i + width] - fine[i - width];
      xx[i] = dx * dx; yy[i] = dy * dy; xy[i] = dx * dy;
    }
  }
  // Structure tensor gives a smooth local orientation, rather than tracing every contour.
  const tx = blur(xx, width, height, 6), ty = blur(yy, width, height, 6), txy = blur(xy, width, height, 6);
  const deposits = new Float32Array(count);
  const bodies = new Float32Array(count);
  let seed = 7319;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const strokeCount = Math.round(count / 150);
  for (let n = 0; n < strokeCount; n++) {
    const cx = 3 + random() * (width - 6), cy = 3 + random() * (height - 6);
    const center = Math.floor(cy) * width + Math.floor(cx);
    if (backdrop[center]) continue;
    const energy = tx[center] + ty[center];
    const coherence = Math.sqrt((tx[center] - ty[center]) ** 2 + 4 * txy[center] ** 2) / (energy + .00001);
    let angle = .5 * Math.atan2(2 * txy[center], tx[center] - ty[center]) + Math.PI / 2;
    if (energy < .000015) angle = -.25 + .4 * Math.sin(cx * .009 + cy * .007);
    angle += (random() - .5) * .45 * (1 - coherence);
    // Mix a few broad rounded deposits with smaller bristle strokes.
    const wide = n % 4 === 0;
    const halfLength = wide ? 15 + random() * 30 : 6 + random() * 18;
    const halfWidth = wide ? 4 + random() * 7 : 1.5 + random() * 3.4;
    const c = Math.cos(angle), s = Math.sin(angle);
    const rx = Math.ceil(Math.abs(c) * halfLength + Math.abs(s) * halfWidth);
    const ry = Math.ceil(Math.abs(s) * halfLength + Math.abs(c) * halfWidth);
    const amplitude = .2 + random() * .6;
    const phase = random() * Math.PI * 2;
    const color = [rgba[center * 4], rgba[center * 4 + 1], rgba[center * 4 + 2]];
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(height - 1, Math.ceil(cy + ry)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(width - 1, Math.ceil(cx + rx)); x++) {
        const dx = x - cx, dy = y - cy;
        const along = (dx * c + dy * s) / halfLength, across = (-dx * s + dy * c) / halfWidth;
        const ellipse = along * along + across * across;
        if (ellipse >= 1) continue;
        const i = y * width + x;
        const colorDistance = (Math.abs(rgba[i * 4] - color[0]) + Math.abs(rgba[i * 4 + 1] - color[1]) + Math.abs(rgba[i * 4 + 2] - color[2])) / 765;
        const continuity = Math.max(0, 1 - colorDistance * 5);
        const bristles = .78 + .22 * Math.cos(across * 13 + phase + along * .8);
        const stamp = Math.pow(1 - ellipse, .7) * amplitude * bristles * continuity;
        deposits[i] = Math.max(deposits[i], stamp);
        if (wide) bodies[i] = Math.max(bodies[i], Math.pow(1 - ellipse, 1.3) * amplitude * continuity);
      }
    }
  }
  const paint = blur(deposits, width, height, 3);
  const rounded = blur(bodies, width, height, 5);
  const result = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    // A band-pass signal excludes broad light/dark subjects from the relief.
    const detail = Math.max(-.09, Math.min(.09, (fine[i] - broad[i]) * .20 + (broad[i] - coarse[i]) * .45));
    const heightValue = Math.max(0, Math.min(1, .3 + detail + paint[i] * .22 + rounded[i] * .42));
    result[i * 4] = Math.round(heightValue * 255);
    result[i * 4 + 1] = Math.round(Math.min(1, paint[i] * .8 + rounded[i] * 1.2) * 255);
    result[i * 4 + 2] = Math.round((.5 + detail) * 255);
    result[i * 4 + 3] = backdrop[i] ? 0 : 255;
  }
  return result;
}

self.onmessage = ({ data }) => {
  try {
    const result = createSurface(data);
    self.postMessage({ pixels: result.buffer, width: data.width, height: data.height }, [result.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message || 'Unable to prepare the surface.' });
  }
};
