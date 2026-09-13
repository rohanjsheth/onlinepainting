# How the relief and the tilt work

This document explains the two pieces of arithmetic at the centre of this project:

1. **The texture** — how a flat photograph of a painting is turned into a fake three-dimensional paint surface that responds to light.
2. **The tilt** — how moving your pointer becomes a change of viewpoint, capped at four and a half degrees.

They are independent. The texture is about inventing a surface; the tilt is about looking at it from a slightly different place. They only meet at the very end, and I say how in the last section.

I have tried to define every term rather than assume it. Where I use a symbol like ∂ or θ, it is spelled out the first time.

---

## A note on what "height map" means

Everything in Part One is in service of producing one thing: a **height map**. That is simply a grey image, the same shape as the painting, where the brightness of each pixel means "how far the paint sticks out here". White means a high ridge of paint; black means a low valley. It is not a picture of anything; it is a table of numbers that happens to be stored as an image.

Once you have that table, a well-known piece of graphics arithmetic turns it into shading — light catches the ridges and misses the valleys. So the whole problem reduces to: *given a photograph, guess the height map.*

The photograph does not contain that information. There is no direct evidence in a flat image of how thick the paint is. So every step below is a heuristic — an informed guess — and the document is honest about which guesses are shaky.

---

# Part One: the texture

## Step 1 — Convert the colours into a space where distances mean something

A pixel in a JPEG has three numbers, red, green and blue, each from 0 to 255. Two problems make these numbers bad for measurement.

**Problem one: the numbers are not proportional to light.** Image formats store colour "gamma encoded", meaning a pixel of value 128 does not emit half the light of a pixel of value 255 — it emits about 22% of it. This encoding exists because human vision is more sensitive to differences among dark tones, so it is efficient to spend more of the 256 available steps down there. To do arithmetic on light, you must first undo it:

```
linear = c / 12.92                       when c ≤ 0.04045
linear = ((c + 0.055) / 1.055) ^ 2.4     otherwise
```

where `c` is the stored value scaled to the range 0 to 1. Because there are only 256 possible inputs, the code precomputes all 256 answers once into a lookup table (`TO_LINEAR`) rather than calling the power function millions of times.

**Problem two: distance in red-green-blue does not match perceived difference.** Two blues separated by a numeric distance of 20 may look identical, while two greens the same distance apart look obviously different. Since the next step measures *how far a pixel's colour is from its surroundings*, that distance needs to correspond to what an eye would judge.

The fix is to convert into **CIELAB**, a colour space built in the 1970s from experiments on human perception, and designed so that equal numeric distances are roughly equal perceived differences. It has three axes:

- **L\*** — lightness, 0 for black, 100 for white.
- **a\*** — how green (negative) or red (positive) the colour is.
- **b\*** — how blue (negative) or yellow (positive) the colour is.

The conversion goes through an intermediate space called XYZ, which is a fixed 3×3 matrix multiplication derived from measurements of how the three types of cone cell in the human eye respond to different wavelengths:

```
X = 0.4124·r + 0.3576·g + 0.1805·b
Y = 0.2126·r + 0.7152·g + 0.0722·b      (Y is luminance — perceived brightness)
Z = 0.0193·r + 0.1192·g + 0.9505·b
```

Then each of X, Y, Z is divided by the value that a reference white would have (0.95047, 1, 1.08883 — these describe average daylight), and passed through a curve that is a cube root over most of its range:

```
f(t) = t^(1/3)              when t > 0.008856
f(t) = 7.787·t + 16/116     otherwise (a straight line, to avoid the cube root's
                             infinite slope at zero)
```

and finally:

```
L* = 116·f(Y) − 16
a* = 500·(f(X) − f(Y))
b* = 200·(f(Y) − f(Z))
```

The cube root is doing the important work. It compresses the bright end and expands the dark end, which is precisely the behaviour needed for the next step.

**Why this matters concretely.** Van Gogh's cypress is very dark. In linear light, all the differences within it are tiny numbers — a dark green and a slightly different dark green might differ by 0.003. In L\*, the cube root stretches that same difference into something comparable to a difference between two pale clouds. Without this conversion, the most heavily loaded passage on the canvas measures as nearly flat. With it, it measures correctly.

## Step 2 — Find the backdrop and exclude it

Museum photographs are often shot against black. That black is not paint and must not be given relief.

The code uses a **flood fill**: start from every pixel on the outer border of the image, and if a pixel is nearly black (all three channels below 18 out of 255), mark it as backdrop and then check its four neighbours, and their neighbours, and so on outward. The result is a mask of every dark region *connected to the edge of the image*.

The connectivity is the whole point. A simple rule like "every dark pixel is backdrop" would punch holes through the cypress and the shadowed hedge, which are genuinely dark paint. By requiring a continuous path of darkness back to the border, interior darkness is safe.

## Step 3 — Estimate thickness from local colour deviation

Here is the core guess. **A brushstroke is a patch of colour that differs from its immediate surroundings.** That is true whether the stroke is lighter or darker than what is around it.

For each pixel:

1. Compute the **average colour of its neighbourhood** — blur the L\*, a\* and b\* channels separately with a box blur of radius 6 pixels. A box blur just replaces each value with the plain average of the values within that radius. It is used instead of a smoother Gaussian blur because it can be computed in constant time per pixel using a running sum, regardless of radius, which matters at three million pixels.

2. Compute the **distance from the pixel's own colour to that local average**, as a straight-line distance in the three-dimensional L\*a\*b\* space:

```
deviation = √( (L − L̄)² + (a − ā)² + (b − b̄)² )
```

   where the bar means "the blurred, local-average version". This quantity has a standard name, **ΔE** (delta E), and is the conventional way to express "how different do these two colours look".

3. **Normalise.** The raw deviations have no fixed upper bound, so they are scaled against the 96th percentile — the value that 96% of pixels fall below. Using the maximum would let a single bright fleck of paint set the scale and flatten everything else. The percentile is found with a histogram of 256 bins rather than by sorting three million numbers.

The critical property is that this measure is **sign-free**. It does not care whether the stroke is brighter or darker than its surroundings, only that it differs. The previous version of this code used a brightness band-pass, which treats "darker than surroundings" as a valley, and consequently rendered thickly loaded dark passages as depressions.

Measured on *Wheat Field with Cypresses*, the normalised thickness now reads:

| region | mean | median |
|---|---|---|
| cypress | 0.344 | 0.289 |
| clouds | 0.384 | 0.317 |
| wheat | 0.391 | 0.328 |
| olive tree | 0.466 | 0.409 |

The cypress now lands within about 10% of the clouds, which is roughly correct — both are heavily loaded.

## Step 4 — Find which way each brushstroke runs

This is the most mathematically interesting step, and the most necessary: without it, the synthesised surface looks like crumpled paper rather than brushwork, because crumpled paper is what you get when raised areas have no preferred direction.

### The gradient, and why it is not enough on its own

The **gradient** at a pixel is a small arrow pointing in the direction in which brightness increases fastest, whose length says how fast. It is computed by simple subtraction:

```
dx = brightness(one pixel right) − brightness(one pixel left)
dy = brightness(one pixel below) − brightness(one pixel above)
```

A brushstroke is a ridge. On one flank of the ridge the brightness rises, so the gradient points one way. On the other flank it falls, so the gradient points the *opposite* way. The gradient is always perpendicular to the stroke, but its sign flips across the stroke.

So the obvious idea — average all the gradient arrows in a neighbourhood to find the local direction — fails completely. The two flanks cancel and you get approximately zero.

### The structure tensor

The trick is to **square the gradient before averaging**, which destroys the sign so that opposite arrows reinforce instead of cancelling.

Concretely, at each pixel form three numbers from the gradient:

```
dx·dx      dx·dy      dy·dy
```

These are the entries of a 2×2 symmetric matrix, called the **outer product** of the gradient with itself:

```
⎡ dx·dx   dx·dy ⎤
⎣ dx·dy   dy·dy ⎦
```

Now blur each of those three numbers over a neighbourhood (radius 6 here). The averaged matrix is the **structure tensor**. "Tensor" here is just a word for this grid of numbers; nothing more exotic is meant. Call the blurred entries J₁₁, J₁₂, J₂₂.

### Extracting the direction

Every symmetric 2×2 matrix has two special directions, called **eigenvectors**, with this property: if you feed an eigenvector into the matrix, the matrix stretches it but does not rotate it. Each has an associated stretch factor, the **eigenvalue**. For the structure tensor:

- The eigenvector with the **larger** eigenvalue points in the direction in which brightness changes the most — that is, **across** the stroke.
- The eigenvector with the **smaller** eigenvalue points in the direction in which brightness changes the least — **along** the stroke. This is the one we want.

For a 2×2 symmetric matrix these can be written down directly, with no iteration:

```
θ = ½ · atan2( 2·J₁₂ , J₁₁ − J₂₂ )        direction across the stroke
stroke direction = θ + 90°
```

and a measure of how confident that direction is, called **coherence**:

```
coherence = √( (J₁₁ − J₂₂)² + 4·J₁₂² ) / (J₁₁ + J₂₂)
```

which runs from 0 to 1. Zero means the neighbourhood has no preferred direction at all — the two eigenvalues are equal, brightness changes equally in every direction. One means strongly directional, a clean stroke.

The code uses coherence twice: to add random jitter to the stroke angle in proportion to `1 − coherence`, so that strokes wander where the evidence is weak; and later, in the shader, to decide how strongly to apply the directional sheen.

### The doubled angle, and why it appears twice

An orientation is not a direction. A stroke lying at 10° and a stroke lying at 190° are *the same stroke*. Orientation lives on a half-circle, 0° to 180°, not a full one.

This causes a genuine problem: 179° and 1° are two degrees apart as orientations, but 178 apart as numbers. Any averaging or interpolation done on raw angles will be wrong near that seam.

The standard fix is to work with the **doubled angle**. Double both and they become 358° and 2°, which are the same point on a full circle — the seam disappears. That is why the formula above has a factor of ½ outside and a factor of 2 inside: the arithmetic happens in doubled-angle space and is halved only at the end.

The same reasoning returns when the orientation is stored in a texture for the shader to read. Textures are smoothly interpolated between pixels by the graphics hardware, so storing a raw angle would produce a garbage value anywhere the number wraps around. Instead the code stores two numbers:

```
cos(2θ)  and  sin(2θ)
```

each remapped from the range −1…1 into 0…1 so it fits in a byte. These interpolate correctly everywhere, and the shader recovers the angle with `θ = ½ · atan2(sin2θ, cos2θ)`.

## Step 5 — Stamp synthetic brushstrokes

Now the code has, for every pixel, an estimate of thickness and an estimate of direction. It uses them to paint synthetic strokes into the height map.

It places roughly **one seed point per 70 pixels**, at pseudo-random positions. The randomness comes from a **linear congruential generator**, a classic one-line recipe for a repeatable sequence of pseudo-random numbers:

```
seed = (seed · 1664525 + 1013904223)  mod  2³²
```

started from a fixed value (7319). Because the starting value is fixed and the recipe is deterministic, the same painting always produces exactly the same surface. This is not incidental — it is what would make it possible to precompute these maps and ship them.

At each seed the code reads the local angle and coherence, then stamps an **ellipse** — long in the stroke direction, narrow across it. Every fourth stroke is a broad one (half-length 15 to 45 pixels, half-width 4 to 11); the rest are fine (half-length 6 to 24, half-width 1.5 to 4.9).

To decide whether a given pixel falls inside a rotated ellipse, the code converts the pixel's offset from the stroke centre into two coordinates — distance **along** the stroke and distance **across** it — by rotating:

```
along  = ( dx·cos θ + dy·sin θ) / halfLength
across = (−dx·sin θ + dy·cos θ) / halfWidth
```

and the pixel is inside when `along² + across² < 1`. This is just the equation of a circle, applied in a stretched and rotated coordinate system, which is exactly what an ellipse is.

The height added at each pixel inside is:

```
(1 − along² − across²) ^ 0.7   ×   amplitude   ×   bristles   ×   continuity
```

Each factor has a job:

- **The power 0.7** shapes the cross-section. A value of 1 would give a cone; below 1 gives a fuller, more rounded body with a faster falloff at the rim, which is closer to how a loaded brush deposits paint.
- **amplitude** = `(0.18 + 0.42·random) × (0.25 + 1.35·thickness)`. The second bracket is where Step 3 pays off: strokes are built tall where the colour deviation says paint is loaded, and stay low where it says the paint is thin.
- **bristles** = `0.78 + 0.22·cos(across·13 + phase + along·0.8)`. This corrugates the stroke *across* its width, simulating the fine grooves a brush's individual bristles drag through wet paint. The small `along` term makes the grooves drift slightly rather than running perfectly straight.
- **continuity** = `max(0, 1 − 5 × colour distance)`. The stroke fades out where the underlying photograph changes colour sharply. This stops a synthetic stroke from running straight across the boundary between two different passages of paint, which would look obviously wrong.

Overlapping strokes combine with **maximum**, not addition. Paint layered on paint does not stack linearly to arbitrary heights, and summing would produce runaway spikes wherever strokes happened to pile up.

## Step 6 — Assemble the height map

The stamped strokes are blurred very slightly — radius 1 for the fine strokes, radius 2 for the broad ones — purely to hide the hard edge of each stamp.

**These radii used to be 3 and 5, and that was the single biggest defect in the whole pipeline.** A blur of that width is *isotropic*, meaning it spreads equally in all directions, so it rounded the carefully oriented ellipses back into featureless blobs. The code was computing a good orientation field and then erasing it one line later. That is what made the surface read as crumpled paper. Narrowing the blur is what finally made brushwork visible.

The final height at each pixel is a weighted sum:

```
height = 0.26 + 0.46·(fine strokes) + 0.30·(broad strokes) + 0.24·(thickness)
```

clamped to the range 0 to 1. The constant 0.26 is the resting level — the height of bare canvas — so that strokes can only build upward from it.

Three other numbers are stored alongside the height in the same image, one per colour channel, because a texture has four channels and it would be wasteful to use only one:

| channel | contents | used for |
|---|---|---|
| red | the height | shading, parallax, shadows |
| green | accumulated paint thickness | burying the canvas weave, softening roughness |
| blue | a fine brightness band-pass | small roughness variation |
| alpha | the backdrop mask | zeroing relief outside the canvas |

A second texture carries the orientation field: `cos(2θ)`, `sin(2θ)`, coherence, and thickness.

## Step 7 — Turning height into light

Everything so far ran once, on the processor, when the painting loaded. Everything below runs on the graphics card, for every pixel, every frame.

### From height to surface normal

A **surface normal** is an arrow pointing straight out of a surface, perpendicular to it. It is the quantity that decides how bright a point appears: a surface facing the lamp is bright, one facing away is dark.

For a height map, the normal comes from the slope. In calculus notation the slope in each direction is written ∂h/∂x and ∂h/∂y — "how much does height change per unit of sideways movement". Here it is computed by plain subtraction of neighbouring pixels, which is the same thing at pixel resolution:

```
dx = height(right neighbour) − height(left neighbour)
dy = height(neighbour below) − height(neighbour above)
```

and the normal of a height field is:

```
N = normalise( (−dx, −dy, 1) )
```

The minus signs are the geometry: if height increases to the right, the surface is tilted so that its outward-facing arrow leans to the *left*. The 1 in the third slot represents a unit of "outward"; the steeper the slope, the more the arrow leans away from it.

The slopes are scaled by `reliefDepth`, which is `0.014 × relief slider × edge fade × backdrop mask × X-ray gain`. The painting is 2 units wide in the scene, so at the default slider setting of 0.5 the tallest paint stands about `0.007 / 2 = 0.35%` of the painting's width. On a canvas 93 cm across that is about **3 millimetres**, which is a plausible figure for van Gogh's heaviest impasto.

### Canvas weave

The weave is not in the height map. It is added directly into the slope as two sine waves, one horizontal and one vertical, at 320 cycles per scene unit — about 640 threads across the painting's width.

Two modulations make it behave:

- It is multiplied by `1 − 0.75 × paint thickness`, so thick paint buries the weave and only thin passages and bare ground show it. This is a surprisingly strong cue: much of how an eye judges paint depth is by whether it can still see the canvas underneath.
- It is faded out when a screen pixel covers more than a fraction of a thread, using `fwidth`, a shader function that reports how fast a value is changing per screen pixel. Without this, the weave would alias into shimmering moiré patterns when the painting is small on screen.

### Parallax

If the paint has height, then leaning to one side should reveal slightly different parts of it — near ridges should shift relative to the canvas behind them, and tall ridges should hide what is behind them.

The code approximates this by **ray marching**: it takes the direction from the viewer to the surface, converts it into texture coordinates, and steps along that direction in 20 increments, checking at each step whether it has run into the height field yet. Where it stops is the texture coordinate actually used to look up the colour. The final position is refined by interpolating between the last two steps, so the result does not visibly quantise into 20 bands.

### The specular highlight

Diffuse shading — the matte component — is simple: brightness proportional to how directly the surface faces the light, which is the dot product `N · L` between the normal and the light direction.

The shine is harder, and uses a **microfacet model**. The idea: a surface that looks smooth is actually covered in microscopic facets, each a tiny mirror. You see a highlight where a large number of those facets happen to be angled just right to bounce light from the lamp into your eye. The model has three parts:

```
specular = D × G × F / (4 · (N·V) · (N·L))
```

- **D, the distribution** — what fraction of microfacets point in the right direction. This is where roughness enters: a low roughness means the facets are tightly clustered around the average, giving a small sharp highlight; high roughness spreads them out into a broad dull sheen.
- **G, the geometry term** — microfacets are bumpy enough to shadow each other at grazing angles. G accounts for that self-shadowing, and prevents the highlight from becoming unphysically bright at glancing views.
- **F, Fresnel** — every surface becomes more mirror-like as your viewing angle approaches grazing. This is why a matte wooden table shows reflections when you crouch and look along it. Approximated here as `0.04 + 0.96 × (1 − cos angle)⁵`, where 0.04 is the roughly 4% of light a dielectric like oil reflects head-on.

### Making the highlight directional

A brush drags its bristles along the stroke, leaving fine parallel grooves. Those grooves behave like tiny cylinders lying in the stroke direction. A cylinder scatters light in the plane perpendicular to its axis — so the highlight **spreads across the stroke, not along it**.

The code implements this by giving the distribution term two different roughnesses instead of one:

```
roughness along the stroke  = α × (1 − 0.75 · anisotropy)     — narrower
roughness across the stroke = α × (1 + 1.60 · anisotropy)     — wider
```

and replacing the circular distribution with an elliptical one:

```
shape = (T·H)²/α_along²  +  (B·H)²/α_across²  +  (N·H)²
D = 1 / (π · α_along · α_across · shape²)
```

where **T** is the stroke direction (recovered from the orientation texture), **B** is perpendicular to it, and **H** is the halfway direction between the light and the eye — the direction a microfacet must face to bounce one into the other.

The anisotropy is scaled by coherence, so the effect only appears where the stroke direction was confidently measured, and fades to an ordinary circular highlight in the passages where it was not.

### Contact shadows

Finally, 10 short rays are traced from each point toward the light. If the height map rises above the ray anywhere along its path, that point is in shadow. The rays are short, so this only produces the small dark accents where paint ridges shade the grooves right beside them, not shadows across the whole painting. Nearer obstructions produce sharper shadow edges than distant ones, matching how real contact shadows behave.

---

# Part Two: the tilt

The tilt is far simpler, and is best understood as a piece of plain geometry.

## The setup

The painting is a flat rectangle in a three-dimensional scene:

- It is centred on the origin, the point (0, 0, 0).
- It is **2 units wide**. The unit is arbitrary — it is defined by this choice — and its height is `2 / aspect ratio`.
- It lies flat in the plane where the third coordinate, z, is zero. Its normal points straight out along the z axis toward you.

The camera sits somewhere on the positive-z side, looking back at it. It is a **perspective camera** with a vertical field of view of 34°, meaning it takes in 17° above and 17° below its centre line.

## How far back the camera sits

At a distance *d*, a camera with a half-angle of 17° sees a vertical span of `2 · d · tan(17°)`. Horizontally it sees that multiplied by the window's width-to-height ratio.

To find the distance at which the painting just fits, both constraints are solved and the larger answer wins — whichever dimension runs out of room first is the one that binds:

```
d_fit = max(  (2/aspect) / (2·tan 17°)  ,   2 / (2·tan 17° · windowAspect)  )
cameraDistance = d_fit × 1.3
```

The 1.3 is a margin so the painting does not touch the edges of the window. The distance actually used is `cameraDistance / zoom`, so zooming in simply means moving the camera closer.

## From pointer position to a target

The pointer's position over the stage is converted into two numbers between −1 and +1:

```
x = 2 · (pointerX − stageLeft) / stageWidth  −  1
y = 1  −  2 · (pointerY − stageTop) / stageHeight
```

The y formula is flipped because screen coordinates count downward from the top, whereas the scene counts upward.

That pair is then **clamped to the unit circle**: if `x² + y² > 1`, both are scaled down until the length is exactly 1. This is why the corners of the stage do not produce more tilt than the edges — without it, a corner would be √2 ≈ 1.41 times further out than an edge and would tilt about 40% harder. Clamping to a circle rather than a square makes the maximum identical in every direction.

## Easing

The view does not jump to the target. Each frame it moves a fraction of the remaining distance:

```
fraction = 1 − e^(−12 · dt)
current  = current + (target − current) × fraction
```

where `dt` is the number of seconds since the previous frame and `e` is the base of natural logarithms, about 2.718.

The exponential is not decoration. A naive rule like "move 10% of the way each frame" would ease twice as fast on a 120 Hz display as on a 60 Hz one, because it would run twice as often. Writing it as `1 − e^(−rate · dt)` makes the result depend on elapsed *time* rather than on the number of frames, so the motion looks identical on any machine. The rate constant 12 means roughly 63% of the remaining distance is covered every 1/12 of a second, about 83 milliseconds.

When the viewer's system is set to reduce motion, the fraction is set to 1 and the easing is skipped entirely.

## Moving the camera

Here is the whole tilt, in one line:

```
camera position = ( pan.x − tiltX · tan(4.5°) · d ,
                    pan.y − tiltY · tan(4.5°) · d ,
                    d )
camera aims at  ( pan.x , pan.y , 0 )
```

The camera **slides sideways** by up to `tan(4.5°) · d ≈ 0.0787 · d`, while continuing to aim at the same point on the painting.

## Why the angle is exactly bounded

This is the part worth checking, because the whole claim of the interaction is that it never exceeds 4.5°.

The camera is offset sideways from the axis by `tiltLength · tan(4.5°) · d`, and remains at distance `d` along the axis. The angle between its line of sight and the painting's normal is therefore:

```
angle = atan(  sideways offset / distance along the axis  )
      = atan(  tiltLength · tan(4.5°) · d  /  d  )
      = atan(  tiltLength · tan(4.5°)  )
```

The `d` cancels — **the angle does not depend on how far away the camera is**, which is why zooming in does not change the tilt behaviour. And because the earlier clamp guarantees `tiltLength ≤ 1`:

```
angle ≤ atan( tan(4.5°) ) = 4.5°
```

exactly, with equality only at the rim of the circle. This is the quantity reported as `tiltDegrees` in the diagnostic snapshot, and it is what the test suite asserts against.

## Why it is a lean and not an orbit

The painting never moves or rotates. The camera translates and re-aims. That is deliberate, and it is what makes the illusion work: leaning your head a few degrees in front of a real canvas is a *translation* of your eye, not a rotation of the artwork. An orbit control — which is what most three-dimensional viewers give you — would spin the painting in space and immediately read as a computer graphics object rather than an object on a wall.

The 4.5° cap keeps it in the range of an actual involuntary lean. Large angles would expose the illusion, because the painting is a flat plane: it has no real thickness, no edges to see around, and its silhouette never changes. Small angles are the range in which a height map is a convincing substitute for geometry.

---

# Where the two meet

They connect at exactly one place: the view direction.

The parallax ray march and the contact-shadow rays both start from the direction between the viewer and the surface. When the camera leans, that direction changes, so:

- The parallax march steps along a different path, and the texture coordinate it lands on shifts. Tall paint appears to slide over what is behind it.
- The shadow rays sweep, so the small dark accents beside ridges move.
- The normals do not change, but the angle between them and the eye does, so the specular highlights slide across the ridges.

This is why the tilt is worth having at all. On a flat image, leaning 4.5° would be invisible — a flat plane viewed from slightly off-axis looks like the same flat plane. It is only because Part One invented a surface that Part Two has anything to reveal.

And it is worth restating the caveat that the README also makes: none of this is measured. The height map is inferred from a photograph that contains no depth information, by a chain of reasonable guesses. It is an argument about what the surface probably looks like, not a record of what it is. The one piece of genuine measurement in the system is the X-radiograph, which reports where the lead white is — and even that is a map of material, not of geometry.
