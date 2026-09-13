# Impasto

A local, interactive painting study with simulated paint relief, canvas weave, and changing light. The starting artwork is Vincent van Gogh’s *Wheat Field with Cypresses* (1889).

## Run

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. To build a static site, run `npm run build`; the output is in `dist/`. `npm run preview` serves that build locally. The artwork and fonts are bundled locally; the running gallery makes no external requests.

## Explore

The default view contains the painting and an unboxed museum label, set in Libre Franklin with only the painting title in bold. Open the small **Viewing options** disclosure below the label to access the controls.

- **Light:** move your pointer across the painting to change the light’s direction. The elevation slider moves it from grazing to frontal illumination.
- **Head tilt:** pointer movement changes your viewpoint, with a 4.5-degree maximum from center, including at the corners. Leaving the painting recenters the view. This is not an orbit control.
- **Canvas weave, paint relief, roughness:** adjust the material independently. Weave is reduced under thicker simulated paint.
- **Show surface only:** inspect the material with neutral color.
- **Compare original:** toggle the source photograph without synthesized relief or lighting. The current viewing angle and zoom are retained.
- **Look closer:** zoom up to 2× to inspect the central brushwork.
- **Keyboard:** focus the painting and use arrow keys for the active interaction; Home returns it to center/default. All controls are keyboard accessible.

On a touchscreen, touch and move over the painting. Head-tilt mode captures gestures on the artwork; the rest of the page still scrolls. Reduced-motion preferences remove movement easing. Browsers without WebGL show the original image with a clear message.

## Surface synthesis

The surface is an artistic approximation, not measured geometry. A Web Worker builds a deterministic relief map up to 2048 pixels on its longest side:

1. Thickness is read as local color deviation: the distance in CIELAB from a pixel to its blurred neighbourhood. A dark stroke laid over dark ground registers as much paint as a light one over light ground, which a luminance band-pass cannot do.
2. A smoothed structure tensor estimates local stroke direction.
3. Short bristle strokes and broader rounded deposits follow that direction. Color differences limit deposits crossing strong boundaries.
4. A shader calculates surface normals from the height field and adds procedural weave, filtered according to screen resolution to reduce shimmer.
5. A 20-step parallax ray march gives the relief depth under the fixed 4.5-degree head tilt. Ten short light-ray samples add soft shadows inside paint grooves. Normals, parallax, and shadows share the same height scale. GGX highlights vary with paint thickness, giving raised deposits a satin finish.

The painting remains a planar mesh: shadows and depth are approximated in the shader, with no displaced silhouette. Near-black regions connected to the image border are treated as photographic backdrop and excluded from added texture. This heuristic can also exclude border-connected black paint.

The default study uses 50% relief, 58% roughness, and light at 30° elevation. Smoothed stroke deposits and restrained fine detail keep the lighting from sharpening the source photograph. These remain adjustable under Viewing options. The renderer now samples more textures per pixel for depth and shadows; performance depends on the device.

## Synthesis cost

Surface synthesis runs once per painting, in a worker, and is most of the wait before the first frame. Two changes roughly halved it, from 2577 ms to 1364 ms on *Wheat Field with Cypresses* at 2048 × 1608 (3.3 million pixels).

Both were chosen from a profile rather than by inspection. An earlier guess that the CIELAB conversion was the expensive part was wrong: its three cube roots per pixel look costly, but they account for under 4% of the work. The two stages that mattered were the two that run tens of millions of times.

| stage | before | after |
| --- | --- | --- |
| stroke stamping | 1403 ms | 349 ms |
| assemble + orientation | 563 ms | 383 ms |
| thickness (3 blurs, ΔE, percentile) | 223 ms | 224 ms |
| structure tensor (3 blurs) | 142 ms | 147 ms |
| luminance pyramid (3 blurs) | 120 ms | 115 ms |
| CIELAB conversion | 103 ms | 103 ms |
| deposit blurs | 75 ms | 66 ms |
| backdrop flood fill | 5 ms | 5 ms |

### Stroke profiles and bristle grooves

**Before.** Each stamped stroke evaluated, for every pixel it covered, `Math.pow(1 - ellipse, .7)` for its cross-sectional profile, a second `Math.pow(1 - ellipse, 1.3)` for the broad deposits, and `Math.cos` for the bristle grooves running along it. At roughly 47,000 strokes covering about 290 pixels each, that is near 13.6 million evaluations of two transcendental functions — over half the total synthesis time.

**After.** The profile argument is always in 0…1, so both powers become a 1024-entry lookup table. The wave argument is unbounded but periodic, so the cosine becomes a 2048-entry table indexed by the argument wrapped with a bitwise mask, which avoids a modulo and a branch. The stage drops to 349 ms, a 4× improvement. The tables quantize the result: 1.44% of surface-map bytes change, all of them by exactly 1, which is below what the 8-bit output can represent anyway.

### Orientation without an arctangent

**Before.** The orientation field stored the stroke angle as a doubled angle, so that bilinear filtering would not tear where a raw angle wraps. It computed that by taking an arctangent and then undoing it:

```js
const angle = .5 * Math.atan2(2 * txy[i], tx[i] - ty[i]) + Math.PI / 2;
orient[i * 4]     = Math.round((Math.cos(2 * angle) * .5 + .5) * 255);
orient[i * 4 + 1] = Math.round((Math.sin(2 * angle) * .5 + .5) * 255);
```

An `atan2`, a `cos` and a `sin` on every one of 3.3 million pixels.

**After.** The arctangent is unnecessary. Writing `gx = tx - ty` and `gy = 2·txy`, the stored angle is `atan2(gy, gx) + π`, whose cosine and sine are `-gx/r` and `-gy/r` for `r = √(gx² + gy²)`. That `r` was already being computed on the next line as the numerator of coherence, so the replacement costs nothing:

```js
const gx = tx[i] - ty[i], gy = 2 * txy[i];
const spin = Math.sqrt(gx * gx + gy * gy);
const inverse = spin > 1e-12 ? 1 / spin : 0;
orient[i * 4]     = Math.round((-gx * inverse * .5 + .5) * 255);
orient[i * 4 + 1] = Math.round((-gy * inverse * .5 + .5) * 255);
```

This is exact, not an approximation. Of 3.3 million pixels, 1512 differ by one count from floating-point rounding at a `Math.round` boundary, and 222 differ by more — every one of those has coherence exactly zero, meaning the gradient vanished and no direction existed to record. The shader scales anisotropy by coherence, so they contribute nothing.

Blurs are already cheap for a related reason and were left alone: a box blur's samples all carry equal weight, so sliding the window one pixel is one subtraction and one addition regardless of radius. That makes each blur constant-time per pixel where a Gaussian would cost proportional to its radius. See `docs/how-it-works.md`.

The source photograph contains baked lighting and cannot be treated as measured albedo. Exposure normalization preserves its color reasonably well while allowing local relief shading. Some inferred ridges can still follow pigment boundaries instead of physical paint. The neutral surface view makes those artifacts easier to evaluate. Thin paint, detailed photographs, and low-resolution source images may need less relief.

Textures and geometry are disposed when replacing an image. The renderer draws on demand and while easing toward a changed view; it does not continuously animate at rest.

## Validation

```sh
npm test
```

Browser tests cover relighting, the 4.5-degree tilt bound, original-image comparison, phone layout and touch interaction, and WebGL fallback. The default executable is Google Chrome on macOS; set `CHROME_PATH` to another Chromium executable as needed. Playwright starts or reuses the local Vite server. Screenshots are written to `test-results/`.

## Sources

The wall label includes the artist’s life dates (1853–1890), the painting’s year (1889), its place of creation (Saint-Rémy-de-Provence, France), and its exhibition location (The Met Fifth Avenue, Gallery 822). The Met collection page was checked on September 13, 2026; gallery placement may change.

- Artwork: [The Metropolitan Museum of Art, object 436535](https://www.metmuseum.org/art/collection/search/436535), marked **Public Domain**. Purchase, The Annenberg Foundation Gift, 1993; accession 1993.132.
- Original image: [DP-42549-001.jpg](https://images.metmuseum.org/CRDImages/ep/original/DP-42549-001.jpg), downloaded at 4000 × 3184 pixels. The file is retained in `public/art/wheat-field.jpg`.
- Fonts: Libre Franklin, under the SIL Open Font License. License files are in `public/fonts/`.
- Renderer: [Three.js](https://threejs.org/), MIT license; exact dependencies are recorded in `package-lock.json`.

Useful reference for a future measured-surface comparison: [University of Verona RealRTI](https://github.com/Univr-RTI/RealRTI). Its canvas examples include calibrated multi-light images, rather than ready-to-use normal maps. No RealRTI data is bundled here.
