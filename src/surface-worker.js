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

const TO_LINEAR = new Float32Array(256);
for (let v = 0; v < 256; v++) {
  const c = v / 255;
  TO_LINEAR[v] = c <= .04045 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4);
}
const labCurve = (t) => t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;

// Stroke stamping evaluates these millions of times, so both are tabulated. The profile
// argument is always in 0..1 and the wave argument wraps, which is what makes tables viable.
const PROFILE_STEPS = 1024;
const THIN_PROFILE = new Float32Array(PROFILE_STEPS);
const WIDE_PROFILE = new Float32Array(PROFILE_STEPS);
for (let i = 0; i < PROFILE_STEPS; i++) {
  const t = i / PROFILE_STEPS;
  THIN_PROFILE[i] = Math.pow(t, .7);
  WIDE_PROFILE[i] = Math.pow(t, 1.3);
}
const WAVE_STEPS = 2048;
const WAVE = new Float32Array(WAVE_STEPS);
for (let i = 0; i < WAVE_STEPS; i++) WAVE[i] = Math.cos(i / WAVE_STEPS * Math.PI * 2);
const WAVE_SCALE = WAVE_STEPS / (Math.PI * 2);

function createSurface({ pixels, width, height }) {
  const rgba = new Uint8ClampedArray(pixels);
  const count = width * height;
  const luminance = new Float32Array(count);
  // CIELAB, because thickness has to be legible in the darks. Linear RGB differences
  // collapse to nothing in a shadowed passage; L* keeps them.
  const labL = new Float32Array(count), labA = new Float32Array(count), labB = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = TO_LINEAR[rgba[i * 4]], g = TO_LINEAR[rgba[i * 4 + 1]], b = TO_LINEAR[rgba[i * 4 + 2]];
    luminance[i] = r * .2126 + g * .7152 + b * .0722;
    const fx = labCurve((r * .4124 + g * .3576 + b * .1805) / .95047);
    const fy = labCurve(r * .2126 + g * .7152 + b * .0722);
    const fz = labCurve((r * .0193 + g * .1192 + b * .9505) / 1.08883);
    labL[i] = 116 * fy - 16;
    labA[i] = 500 * (fx - fy);
    labB[i] = 200 * (fy - fz);
  }
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
  // Thickness as distance from the local colour, not from the local brightness. A dark
  // stroke laid over dark ground is as much paint as a light one over light ground.
  const meanL = blur(labL, width, height, 6), meanA = blur(labA, width, height, 6), meanB = blur(labB, width, height, 6);
  const thick = new Float32Array(count);
  const spread = new Int32Array(256);
  for (let i = 0; i < count; i++) {
    const dL = labL[i] - meanL[i], dA = labA[i] - meanA[i], dB = labB[i] - meanB[i];
    const deviation = Math.sqrt(dL * dL + dA * dA + dB * dB);
    thick[i] = deviation;
    spread[Math.min(255, Math.round(deviation * 5))]++;
  }
  // Normalise against the 96th percentile so one bright fleck cannot set the scale.
  let seen = 0, ceiling = 255;
  for (let bin = 0; bin < 256; bin++) { seen += spread[bin]; if (seen > count * .96) { ceiling = bin; break; } }
  const thickScale = 1 / Math.max(1.2, ceiling / 5);
  for (let i = 0; i < count; i++) thick[i] = Math.min(1, thick[i] * thickScale);

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
  const strokeCount = Math.round(count / 70);
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
    // Amplitude follows measured thickness, so loaded passages build and thin ones stay flat.
    const amplitude = (.18 + random() * .42) * (.25 + 1.35 * thick[center]);
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
        const profile = (1 - ellipse) * PROFILE_STEPS | 0;
        const bristles = .78 + .22 * WAVE[((across * 13 + phase + along * .8) * WAVE_SCALE + 16384) & (WAVE_STEPS - 1)];
        const stamp = THIN_PROFILE[profile] * amplitude * bristles * continuity;
        deposits[i] = Math.max(deposits[i], stamp);
        if (wide) bodies[i] = Math.max(bodies[i], WIDE_PROFILE[profile] * amplitude * continuity);
      }
    }
  }
  // These were radius 3 and 5. An isotropic blur that wide rounds the oriented stamps
  // back into blobs, which is what made the surface read as crumpled paper rather than
  // brushwork. Keep it just wide enough to hide the stamp edges.
  const paint = blur(deposits, width, height, 1);
  const rounded = blur(bodies, width, height, 2);
  const body = blur(thick, width, height, 2);
  const result = new Uint8Array(count * 4);
  const orient = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    // Retained only as a roughness cue; it no longer decides how high the paint stands.
    const detail = Math.max(-.09, Math.min(.09, (fine[i] - broad[i]) * .20 + (broad[i] - coarse[i]) * .45));
    const heightValue = Math.max(0, Math.min(1, .26 + paint[i] * .46 + rounded[i] * .30 + body[i] * .24));
    result[i * 4] = Math.round(heightValue * 255);
    result[i * 4 + 1] = Math.round(Math.min(1, paint[i] * .8 + rounded[i] * 1.2 + body[i] * .5) * 255);
    result[i * 4 + 2] = Math.round((.5 + detail) * 255);
    result[i * 4 + 3] = backdrop[i] ? 0 : 255;

    // Stroke direction stored as a double angle, which survives bilinear filtering
    // across the ±pi seam that a raw angle would tear on.
    const energy = tx[i] + ty[i];
    const gx = tx[i] - ty[i], gy = 2 * txy[i];
    const spin = Math.sqrt(gx * gx + gy * gy);
    // The stroke angle is half of atan2(gy, gx) plus a quarter turn, so the doubled angle
    // stored here is atan2(gy, gx) + pi — whose cosine and sine are just -gx/spin and
    // -gy/spin. Taking the arctangent only to undo it with a cosine is wasted work.
    const inverse = spin > 1e-12 ? 1 / spin : 0;
    orient[i * 4] = Math.round((-gx * inverse * .5 + .5) * 255);
    orient[i * 4 + 1] = Math.round((-gy * inverse * .5 + .5) * 255);
    orient[i * 4 + 2] = Math.round(Math.min(1, spin / (energy + .00001)) * 255);
    orient[i * 4 + 3] = Math.round(thick[i] * 255);
  }
  return { result, orient };
}

self.onmessage = ({ data }) => {
  try {
    const { result, orient } = createSurface(data);
    self.postMessage({ pixels: result.buffer, orient: orient.buffer, width: data.width, height: data.height },
      [result.buffer, orient.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message || 'Unable to prepare the surface.' });
  }
};
