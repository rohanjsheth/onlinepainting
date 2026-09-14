import * as THREE from 'three';
import './style.css';
import { vertexShader, fragmentShader } from './shaders.js';

const $ = (selector) => document.querySelector(selector);
const stage = $('#stage');
const canvas = $('#gallery-canvas');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const MAX_TILT = THREE.MathUtils.degToRad(4.5);
const defaults = { weave: .30, relief: .90, roughness: .58, elevation: 30, xray: 1, aniso: .75, mode: 'tilt', surfaceOnly: false, original: false, zoom: 1 };
const state = { ...defaults };
const lightTarget = new THREE.Vector2(-.75, .55);
const tiltTarget = new THREE.Vector2();
const lightCurrent = lightTarget.clone();
const tiltCurrent = tiltTarget.clone();
const pan = new THREE.Vector2();
let recenterTarget;
let wheelTime = 0, wheelSpeed = 0;
let recenterTime = 0;
const RECENTER_EASE = 6; // Per second: ease through most of the move over roughly half a second.
const sliders = [
  ['canvas-weave', 'weave', 100, '%'],
  ['paint-relief', 'relief', 100, '%'],
  ['roughness', 'roughness', 100, '%'],
  ['light-angle', 'elevation', 1, '°'],
  ['xray-relief', 'xray', 100, '%'],
  ['anisotropy', 'aniso', 100, '%'],
];
const works = [
  {
    src: '/art/wheat-field.webp',
    artist: 'Vincent van Gogh', life: 'Dutch, 1853–1890',
    title: 'Wheat Field with Cypresses', year: '1889',
    place: 'Painted in Saint-Rémy-de-Provence, France', medium: 'Oil on canvas',
    collection: 'The Metropolitan Museum of Art, New York', room: 'The Met Fifth Avenue, Gallery 822',
    xray: '/art/wheat-field-xray.jpg',
    source: 'https://www.metmuseum.org/art/collection/search/436535',
  },
  {
    src: '/art/roses.jpg',
    artist: 'Vincent van Gogh', life: 'Dutch, 1853–1890',
    title: 'Roses', year: '1890', medium: 'Oil on canvas',
    collection: 'The Metropolitan Museum of Art, New York', room: 'The Met Fifth Avenue, Gallery 822',
    source: 'https://www.metmuseum.org/art/collection/search/436534',
  },
  {
    src: '/art/starry-night.jpg',
    artist: 'Vincent van Gogh', life: 'Dutch, 1853–1890',
    title: 'The Starry Night', year: '1889',
    place: 'Painted in Saint-Rémy-de-Provence, France', medium: 'Oil on canvas',
    collection: 'The Museum of Modern Art, New York',
    source: 'https://www.moma.org/collection/works/79802',
  },
  {
    src: '/art/rouen-cathedral.jpg',
    artist: 'Claude Monet', life: 'French, 1840–1926',
    title: 'Rouen Cathedral, West Façade, Sunlight', year: '1894', medium: 'Oil on canvas',
    collection: 'National Gallery of Art, Washington',
    source: 'https://www.nga.gov/artworks/46654-rouen-cathedral-west-facade-sunlight',
  },
  {
    src: '/art/taos-mountain.jpg',
    artist: 'Cordelia Wilson', life: 'American, 1876–1953',
    title: 'Taos Mountain Trail Home', year: 'c. 1915–1920s',
    collection: 'Private collection, Kansas City, Missouri',
    source: 'https://commons.wikimedia.org/wiki/File:Cordelia_Wilson_-_Taos_Mountain_Trail_Home.jpg',
  },
];
let workIndex = 0, currentWork;
// Neighbouring works, downloaded and decoded ahead of time, and their synthesised
// relief. Both are keyed by source path; synthesis is deterministic, so a cached
// result is always valid for its painting.
const preloaded = new Map();
const surfaceCache = new Map();
let warmQueue = Promise.resolve();
const whenIdle = window.requestIdleCallback ? window.requestIdleCallback.bind(window) : (run) => setTimeout(run, 400);

let renderer, scene, camera, painting, artworkGroup, material;
let frameRequest = 0, previousTime = 0, ready = false;
let aspect = 1200 / 955, cameraDistance = 4;
let colorTexture, surfaceTexture, orientTexture, xrayTexture;
// Stands in for the plate when a work has no radiograph: fully "leaded", so the gain is a no-op.
const noXray = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
noXray.needsUpdate = true;
let loadVersion = 0, activeWorker;

function status(message, error = false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', error);
}

function text(value, tag = 'span') {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function setLines(element, lines) {
  const present = lines.filter(Boolean);
  element.replaceChildren();
  for (const line of present) {
    const row = document.createElement('span');
    row.className = 'label-line';
    row.append(...[].concat(line));
    element.append(row);
  }
  element.hidden = present.length === 0;
}

function showLabel(work) {
  const title = text(work.title, 'strong');
  title.id = 'artwork-title';
  let collection = work.collection && text(work.collection);
  if (collection && work.source) {
    collection = document.createElement('a');
    collection.id = 'artwork-source';
    collection.href = work.source;
    collection.target = '_blank';
    collection.rel = 'noreferrer';
    collection.textContent = work.collection;
  }
  setLines($('#artwork-credit'), [work.artist && text(work.artist), work.life && text(work.life)]);
  setLines($('#artwork-caption'), [
    [title, work.year && text(`, ${work.year}`)].filter(Boolean),
    work.place && text(work.place),
    work.medium && text(work.medium),
  ]);
  setLines($('#artwork-exhibition'), [collection, work.room && text(work.room)]);
  document.title = work.artist ? `${work.title} — ${work.artist}` : work.title;
  canvas.setAttribute('aria-label', `${work.title} with simulated paint texture`);
  $('#fallback-image').alt = work.artist ? `${work.title} by ${work.artist}` : work.title;
}

function updateCamera() {
  const distance = cameraDistance / state.zoom;
  camera.position.set(pan.x - tiltCurrent.x * Math.tan(MAX_TILT) * distance, pan.y - tiltCurrent.y * Math.tan(MAX_TILT) * distance, distance);
  camera.lookAt(pan.x, pan.y, 0);
  camera.updateMatrixWorld();
}

function pointOnPainting(ndc) {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
}

function zoomAt(zoom, event, recenter = 1) {
  const nextZoom = THREE.MathUtils.clamp(zoom, 1, 8);
  if (nextZoom === state.zoom) return;
  const rect = stage.getBoundingClientRect();
  const ndc = event ? new THREE.Vector2(
    (event.clientX - rect.left) / rect.width * 2 - 1,
    1 - (event.clientY - rect.top) / rect.height * 2,
  ) : new THREE.Vector2();
  updateCamera();
  const before = pointOnPainting(ndc);
  // Hit-test the actual tilted painting, excluding the wall and shadow.
  if (event && nextZoom > state.zoom && (!before || Math.abs(before.x) > 1 || Math.abs(before.y) > 1 / aspect)) return;
  // Finish any pending head movement at the displayed angle so the anchor cannot drift.
  tiltTarget.copy(tiltCurrent);
  const previousZoom = state.zoom;
  const previousCenter = (recenterTarget || pan).clone();
  state.zoom = nextZoom;
  updateCamera();
  const after = pointOnPainting(ndc);
  // Precision scrolling stays anchored in either direction.
  pan.x += before.x - after.x;
  pan.y += before.y - after.y;
  if (nextZoom < previousZoom && recenter > 0) {
    const centered = previousCenter.multiplyScalar((nextZoom - 1) / (previousZoom - 1));
    recenterTarget = pan.clone().lerp(centered, recenter);
    recenterTime = performance.now();
  } else {
    recenterTarget = undefined;
  }
  updateCamera();
  updateUI();
}

function stepBack() {
  if (state.zoom > 1) {
    state.zoom = 1;
    clampPan();
    return updateUI();
  }
  setExpanded(false);
}

function setExpanded(expanded) {
  document.body.classList.toggle('expanded', expanded);
  stage.dataset.expanded = String(expanded);
}

function updateUI() {
  for (const [id, key, divisor, unit] of sliders) {
    const input = $(`#${id}`);
    input.value = Math.round(state[key] * divisor);
    $(`#${id}-value`).value = `${input.value}${unit}`;
    const fill = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100;
    input.style.setProperty('--fill', `${fill}%`);
  }
  document.querySelectorAll('[data-mode]').forEach((button) => button.setAttribute('aria-pressed', String(state.mode === button.dataset.mode)));
  $('#surface-only').setAttribute('aria-checked', String(state.surfaceOnly));
  $('#surface-only').textContent = state.surfaceOnly ? 'On' : 'Off';
  $('#compare').setAttribute('aria-pressed', String(state.original));
  $('#compare-label').textContent = state.original ? 'Return to textured view' : 'Compare original';
  $('#previous-work').disabled = !ready || workIndex === 0;
  $('#next-work').disabled = !ready || workIndex === works.length - 1;
  stage.classList.toggle('tilt-mode', state.mode === 'tilt');
  stage.classList.toggle('pan-mode', state.zoom > 1);
  $('#xray-control').hidden = !xrayTexture;
  stage.setAttribute('aria-label', `Interactive painting. Scroll or double-click to zoom at the cursor. Drag to pan when zoomed in. ${state.mode === 'light' ? 'Move the pointer to move the light.' : 'Move the pointer to tilt your viewpoint, limited to 4.5 degrees.'} Arrow keys also control this interaction. Press + or - to zoom, Home to center, or Escape to step back.`);
  requestRender();
}

function requestRender() {
  if (renderer && !frameRequest) frameRequest = requestAnimationFrame(render);
}

function render(time) {
  frameRequest = 0;
  const dt = Math.min((time - previousTime) / 1000 || .016, .05);
  previousTime = time;
  const smoothing = reducedMotion.matches ? 1 : 1 - Math.exp(-dt * 12);
  lightCurrent.lerp(lightTarget, smoothing);
  tiltCurrent.lerp(tiltTarget, smoothing);
  if (recenterTarget) {
    const elapsed = Math.max(0, (time - recenterTime) / 1000);
    recenterTime = time;
    pan.lerp(recenterTarget, reducedMotion.matches ? 1 : 1 - Math.exp(-elapsed * RECENTER_EASE));
    if (pan.distanceToSquared(recenterTarget) < .00000001) {
      pan.copy(recenterTarget);
      recenterTarget = undefined;
    }
  }
  if (lightCurrent.distanceToSquared(lightTarget) < .000001) lightCurrent.copy(lightTarget);
  if (tiltCurrent.distanceToSquared(tiltTarget) < .000001) tiltCurrent.copy(tiltTarget);
  if (camera) updateCamera();
  if (material) {
    const elevation = THREE.MathUtils.degToRad(state.elevation);
    const direction = lightCurrent.clone();
    if (direction.lengthSq() < .001) direction.set(-.75, .55);
    direction.normalize();
    material.uniforms.uLight.value.set(direction.x * Math.cos(elevation), direction.y * Math.cos(elevation), Math.sin(elevation));
    material.uniforms.uWeave.value = state.weave;
    material.uniforms.uRelief.value = state.relief;
    material.uniforms.uRoughness.value = state.roughness;
    material.uniforms.uXrayGain.value = xrayTexture ? state.xray : 0;
    material.uniforms.uAniso.value = state.aniso;
    material.uniforms.uSurfaceOnly.value = state.surfaceOnly;
    material.uniforms.uOriginal.value = state.original;
  }
  renderer.render(scene, camera);
  if (recenterTarget || lightCurrent.distanceToSquared(lightTarget) > .000001 || tiltCurrent.distanceToSquared(tiltTarget) > .000001) requestRender();
}

// Half the world-space area the camera sees at the current zoom.
function viewHalfSize() {
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const halfHeight = (cameraDistance / state.zoom) * Math.tan(halfFov);
  return new THREE.Vector2(halfHeight * camera.aspect, halfHeight);
}

// Keep the pan inside the painting, so its edges never pull away from the view.
function clampPan() {
  recenterTarget = undefined;
  if (!camera) return;
  const view = viewHalfSize();
  const limitX = Math.max(0, 1 - view.x);
  const limitY = Math.max(0, 1 / aspect - view.y);
  pan.set(THREE.MathUtils.clamp(pan.x, -limitX, limitX), THREE.MathUtils.clamp(pan.y, -limitY, limitY));
}

function resize() {
  if (!renderer) return;
  const { width, height } = stage.getBoundingClientRect();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  cameraDistance = Math.max((2 / aspect) / (2 * Math.tan(halfFov)), 2 / (2 * Math.tan(halfFov) * camera.aspect)) * 1.3;
  // Align the wall label with the left edge of the painting at its resting view.
  const artworkWidth = height / (cameraDistance * Math.tan(halfFov));
  $('main').style.setProperty('--artwork-left', `${Math.max(24, (width - artworkWidth) / 2)}px`);
  // Does the wall label still have somewhere to sit that isn't on the painting?
  const pixelsPerUnit = height / (2 * cameraDistance * Math.tan(halfFov));
  const roomBelow = (height - (2 / aspect) * pixelsPerUnit) / 2;
  const roomBeside = (width - 2 * pixelsPerUnit) / 2;
  document.body.classList.toggle('label-tight', roomBelow < 210 && roomBeside < 290);
  clampPan();
  requestRender();
}

function createShadow(width, height) {
  const image = document.createElement('canvas');
  image.width = 512; image.height = 512;
  const context = image.getContext('2d');
  context.filter = 'blur(5px)';
  context.fillStyle = 'rgba(40, 43, 28, 0.12)';
  context.fillRect(28, 32, 457, 449);
  context.filter = 'blur(2px)';
  context.fillStyle = 'rgba(40, 43, 28, 0.08)';
  context.fillRect(29, 32, 455, 449);
  const texture = new THREE.CanvasTexture(image);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.12, height * 1.14), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
  shadow.position.set(0, -.008, -.025);
  return shadow;
}

function disposeGroup(group) {
  if (!group) return;
  group.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    if (object.material !== material) object.material.map?.dispose();
    object.material.dispose();
  });
  scene.remove(group);
}

function mountPainting() {
  disposeGroup(artworkGroup);
  const width = 2, height = width / aspect;
  artworkGroup = new THREE.Group();
  artworkGroup.add(createShadow(width, height));
  material = new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: {
      uColor: { value: colorTexture }, uSurface: { value: surfaceTexture },
      uTexel: { value: new THREE.Vector2(1 / surfaceTexture.image.width, 1 / surfaceTexture.image.height) },
      uSize: { value: new THREE.Vector2(width, height) },
      uLight: { value: new THREE.Vector3(-.6, .5, .6) },
      uXray: { value: xrayTexture || noXray }, uXrayGain: { value: xrayTexture ? state.xray : 0 },
      uOrient: { value: orientTexture }, uAniso: { value: state.aniso },
      uWeave: { value: state.weave }, uRelief: { value: state.relief },
      uRoughness: { value: state.roughness }, uSurfaceOnly: { value: false }, uOriginal: { value: false },
    },
    transparent: true,
  });
  painting = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  artworkGroup.add(painting);
  scene.add(artworkGroup);
  resize();
}

function prepareSurface(image, background = false) {
  const maxSize = Math.min(2048, renderer.capabilities.maxTextureSize);
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(16, Math.round(image.naturalWidth * scale));
  const height = Math.max(16, Math.round(image.naturalHeight * scale));
  const surfaceCanvas = document.createElement('canvas');
  surfaceCanvas.width = width; surfaceCanvas.height = height;
  const context = surfaceCanvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#f2f0e6';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data.buffer;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./surface-worker.js', import.meta.url), { type: 'module' });
    if (!background) activeWorker = worker;
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Surface preparation took too long. Try a smaller image.')); }, 45000);
    worker.onmessage = ({ data }) => {
      clearTimeout(timeout); worker.terminate();
      if (activeWorker === worker) activeWorker = undefined;
      if (data.error) reject(new Error(data.error)); else resolve(data);
    };
    worker.onerror = () => { clearTimeout(timeout); worker.terminate(); reject(new Error('The surface could not be prepared. Please try again.')); };
    worker.postMessage({ pixels, width, height }, [pixels]);
  });
}

// Speculative fetching costs the viewer real bytes, so sit it out on a metered or slow link.
function mayPreload() {
  const link = navigator.connection;
  return !link || (!link.saveData && !/(^|-)2g$/.test(link.effectiveType || ''));
}

// Run the whole relief synthesis for a neighbour, so arriving there costs nothing.
// Failures are swallowed: a warm-up that does not finish simply means the real load
// does the work itself, which is the behaviour we already had.
async function warmSurface(work) {
  const entry = preloaded.get(work.src);
  if (!entry || surfaceCache.has(work.src) || !renderer) return;
  try {
    await entry.ready;
    if (surfaceCache.has(work.src)) return;
    surfaceCache.set(work.src, await prepareSurface(entry.image, true));
  } catch {
    surfaceCache.delete(work.src);
  }
}

// Hold the neighbours either side of the current work, and let the rest go.
function preloadNeighbours(index) {
  if (!mayPreload()) return;
  const neighbours = [works[index - 1], works[index + 1]].filter(Boolean);
  const keepImages = neighbours.map((work) => work.src);
  const keepSurfaces = [works[index], ...neighbours].filter(Boolean).map((work) => work.src);
  for (const src of [...preloaded.keys()]) if (!keepImages.includes(src)) preloaded.delete(src);
  for (const src of [...surfaceCache.keys()]) if (!keepSurfaces.includes(src)) surfaceCache.delete(src);
  for (const work of neighbours) {
    if (!preloaded.has(work.src)) {
      const image = new Image();
      image.src = work.src;
      const ready = image.decode().catch(() => { preloaded.delete(work.src); throw new Error('decode failed'); });
      preloaded.set(work.src, { image, ready });
    }
    // One at a time, so two workers never compete for the same cores.
    warmQueue = warmQueue.then(() => warmSurface(work));
  }
}

async function loadPainting(work) {
  const url = work.src;
  const version = ++loadVersion;
  $('#loading').hidden = false;
  $('#previous-work').disabled = true;
  $('#next-work').disabled = true;
  status('');
  // The wall label is the receipt for the click, so it changes before the pixels arrive.
  showLabel(work);
  stage.classList.add('loading-work');
  requestRender();
  let nextColor;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (image.naturalWidth < 32 || image.naturalHeight < 32) throw new Error('Please choose an image at least 32 pixels on each side.');
    const imageAspect = image.naturalWidth / image.naturalHeight;
    if (imageAspect < .2 || imageAspect > 5) throw new Error('Please choose a painting with an aspect ratio between 1:5 and 5:1.');
    const surface = surfaceCache.get(url) || await prepareSurface(image);
    if (version !== loadVersion) return;
    // Keep what is on the wall, so stepping back to it is as cheap as stepping forward.
    surfaceCache.set(url, surface);
    // The radiograph is resampled to the surface map so the two line up texel for texel.
    let nextXray;
    if (work.xray) {
      try {
        const plate = new Image();
        plate.src = work.xray;
        await plate.decode();
        const sheet = document.createElement('canvas');
        sheet.width = surface.width; sheet.height = surface.height;
        sheet.getContext('2d').drawImage(plate, 0, 0, sheet.width, sheet.height);
        nextXray = new THREE.CanvasTexture(sheet);
        nextXray.colorSpace = THREE.NoColorSpace;
      } catch {
        status('The radiograph could not be read; showing the inferred relief alone.');
      }
    }
    if (version !== loadVersion) { nextXray?.dispose(); return; }
    const maxColorSize = Math.min(4096, renderer.capabilities.maxTextureSize);
    const source = document.createElement('canvas');
    const scale = Math.min(1, maxColorSize / Math.max(image.naturalWidth, image.naturalHeight));
    source.width = Math.round(image.naturalWidth * scale); source.height = Math.round(image.naturalHeight * scale);
    const context = source.getContext('2d');
    context.drawImage(image, 0, 0, source.width, source.height);
    // Shader explicitly converts source sRGB to linear to keep comparison faithful.
    nextColor = new THREE.CanvasTexture(source);
    nextColor.colorSpace = THREE.NoColorSpace;
    nextColor.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const nextOrient = new THREE.DataTexture(new Uint8Array(surface.orient), surface.width, surface.height, THREE.RGBAFormat);
    nextOrient.flipY = true;
    nextOrient.magFilter = THREE.LinearFilter;
    nextOrient.minFilter = THREE.LinearFilter;
    nextOrient.needsUpdate = true;
    const nextSurface = new THREE.DataTexture(new Uint8Array(surface.pixels), surface.width, surface.height, THREE.RGBAFormat);
    nextSurface.flipY = true;
    nextSurface.magFilter = THREE.LinearFilter;
    nextSurface.minFilter = THREE.LinearMipmapLinearFilter;
    nextSurface.generateMipmaps = true;
    nextSurface.anisotropy = nextColor.anisotropy;
    nextSurface.needsUpdate = true;
    const oldColor = colorTexture, oldSurface = surfaceTexture, oldXray = xrayTexture, oldOrient = orientTexture;
    colorTexture = nextColor; surfaceTexture = nextSurface; xrayTexture = nextXray; orientTexture = nextOrient;
    aspect = imageAspect;
    state.zoom = 1; state.original = false; pan.set(0, 0); recenterTarget = undefined;
    mountPainting();
    oldColor?.dispose(); oldSurface?.dispose(); oldXray?.dispose(); oldOrient?.dispose();
    ready = true;
    canvas.hidden = false;
    $('#fallback-image').hidden = true;
    document.querySelectorAll('.controls button, .controls input, #compare').forEach((control) => { control.disabled = false; });
    stage.dataset.ready = 'true';
    $('#fallback-image').src = url;
    currentWork = work;
    stage.classList.remove('loading-work');
    whenIdle(() => preloadNeighbours(workIndex));
    updateUI();
  } catch (error) {
    nextColor?.dispose();
    // Put the label back on whatever is still hanging, rather than leaving it describing a painting that never arrived.
    if (currentWork) showLabel(currentWork);
    status(error.message || 'The image could not be loaded. Try a JPEG, PNG, or WebP image.', true);
    if (!ready) showFallback('The textured viewer could not load. You can still view the original painting.');
  } finally {
    if (version === loadVersion) {
      stage.classList.remove('loading-work');
      $('#loading').hidden = true;
    }
  }
}

function showFallback(message) {
  $('#fallback-image').hidden = false;
  canvas.hidden = true;
  $('#loading').hidden = true;
  document.querySelectorAll('.controls button, .controls input, #compare, .works button').forEach((control) => { control.disabled = true; });
  status(message, true);
}

for (const [id, key, divisor] of sliders) {
  $(`#${id}`).addEventListener('input', (event) => { state[key] = Number(event.target.value) / divisor; updateUI(); });
}
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  state.mode = button.dataset.mode;
  if (state.mode === 'light') tiltTarget.set(0, 0);
  updateUI();
}));
$('#surface-only').addEventListener('click', () => { state.surfaceOnly = !state.surfaceOnly; state.original = false; updateUI(); });
$('#compare').addEventListener('click', () => { state.original = !state.original; updateUI(); });
function showWork(index) {
  const next = THREE.MathUtils.clamp(index, 0, works.length - 1);
  if (!ready || next === workIndex) return;
  workIndex = next;
  loadPainting(works[next]);
}
$('#previous-work').addEventListener('click', () => showWork(workIndex - 1));
$('#next-work').addEventListener('click', () => showWork(workIndex + 1));
$('#reset').addEventListener('click', () => {
  Object.assign(state, defaults);
  recenterTarget = undefined;
  lightTarget.set(-.75, .55); tiltTarget.set(0, 0); pan.set(0, 0);
  updateUI(); status('View and surface settings reset.');
});

function movePointer(event) {
  if (!ready || event.target.closest('button')) return;
  if (event.pointerType === 'touch' && !stage.hasPointerCapture(event.pointerId)) return;
  const rect = stage.getBoundingClientRect();
  const x = THREE.MathUtils.clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
  const y = THREE.MathUtils.clamp(1 - (event.clientY - rect.top) / rect.height * 2, -1, 1);
  if (state.mode === 'tilt') {
    // Use the untilted painting bounds so the active region doesn't move as it tilts.
    const view = viewHalfSize();
    const pixelsPerUnit = rect.height / (2 * view.y);
    const halfWidth = pixelsPerUnit;
    const halfHeight = pixelsPerUnit / aspect;
    const dx = event.clientX - (rect.left + rect.width / 2 - pan.x * pixelsPerUnit);
    const dy = event.clientY - (rect.top + rect.height / 2 + pan.y * pixelsPerUnit);
    const distance = Math.hypot(Math.max(0, Math.abs(dx) - halfWidth), Math.max(0, Math.abs(dy) - halfHeight));
    // Rounded margin: full interaction just outside the frame, fading to neutral at 120px.
    const influence = 1 - THREE.MathUtils.smoothstep(distance, 24, 120);
    tiltTarget.set(dx / halfWidth, -dy / halfHeight).clampLength(0, 1).multiplyScalar(influence);
  } else if (x * x + y * y > .015) {
    lightTarget.set(x, y);
  }
  requestRender();
}
let dragOrigin;

function canPan() {
  return ready && state.zoom > 1;
}

function dragPan(event) {
  const rect = stage.getBoundingClientRect();
  updateCamera();
  const ndc = (x, y) => new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2);
  const before = pointOnPainting(ndc(dragOrigin.x, dragOrigin.y));
  const after = pointOnPainting(ndc(event.clientX, event.clientY));
  pan.x += before.x - after.x;
  pan.y += before.y - after.y;
  dragOrigin = { x: event.clientX, y: event.clientY };
  requestRender();
}

stage.addEventListener('pointermove', (event) => {
  if (dragOrigin) return dragPan(event);
  movePointer(event);
});
stage.addEventListener('wheel', (event) => {
  if (!ready || event.deltaY === 0) return;
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
  const delta = THREE.MathUtils.clamp(event.deltaY * unit, -300, 300);
  const now = performance.now();
  // A short, decaying window distinguishes a flick from small precision adjustments.
  // Normalize wheel units first so mouse wheels and trackpads share the same curve.
  wheelSpeed = delta > 0 ? wheelSpeed * Math.exp(-(now - wheelTime) / 120) + delta / .12 : 0;
  wheelTime = now;
  const recenter = THREE.MathUtils.smoothstep(wheelSpeed, 700, 2200);
  zoomAt(state.zoom * Math.exp(-delta * .002), event, recenter);
}, { passive: false });
stage.addEventListener('dblclick', (event) => {
  if (!ready || event.button !== 0) return;
  event.preventDefault();
  zoomAt(state.zoom * 2, event);
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') stepBack();
});
stage.addEventListener('pointerdown', (event) => {
  if (!ready || event.button !== 0 || event.target.closest('button')) return;
  if (canPan()) {
    recenterTarget = undefined;
    tiltTarget.copy(tiltCurrent);
    dragOrigin = { x: event.clientX, y: event.clientY };
    stage.setPointerCapture(event.pointerId);
    return;
  }
  if (event.pointerType === 'touch' || event.pointerType === 'pen') stage.setPointerCapture(event.pointerId);
  movePointer(event);
});
stage.addEventListener('pointerleave', () => { if (!dragOrigin) { tiltTarget.set(0, 0); requestRender(); } });
stage.addEventListener('pointerup', (event) => { dragOrigin = undefined; if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId); });
stage.addEventListener('pointercancel', () => { dragOrigin = undefined; tiltTarget.set(0, 0); requestRender(); });
stage.addEventListener('keydown', (event) => {
  if (event.target !== stage || !ready) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (!document.body.classList.contains('expanded')) return setExpanded(true);
    return state.zoom > 1 ? stepBack() : zoomAt(2);
  }
  if (['+', '=', '-', '_'].includes(event.key)) {
    event.preventDefault();
    return zoomAt(state.zoom * (event.key === '-' || event.key === '_' ? 1 / 1.25 : 1.25));
  }
  const delta = { ArrowLeft: [-.15, 0], ArrowRight: [.15, 0], ArrowUp: [0, .15], ArrowDown: [0, -.15] }[event.key];
  if (delta && canPan()) {
    event.preventDefault();
    pan.x += delta[0] * viewHalfSize().x;
    pan.y += delta[1] * viewHalfSize().y;
    clampPan();
    return requestRender();
  }
  const target = state.mode === 'tilt' ? tiltTarget : lightTarget;
  if (delta) { event.preventDefault(); target.add(new THREE.Vector2(...delta)).clampLength(0, 1); requestRender(); }
  if (event.key === 'Home') { event.preventDefault(); recenterTarget = undefined; pan.set(0, 0); target.copy(state.mode === 'tilt' ? new THREE.Vector2() : new THREE.Vector2(-.75, .55)); requestRender(); }
});

try {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(34, 1, .01, 100);
  scene.add(new THREE.HemisphereLight('#ffffff', '#89816b', 2));
  const frameLight = new THREE.DirectionalLight('#fff3dc', 2);
  frameLight.position.set(-2, 4, 5); scene.add(frameLight);
  new ResizeObserver(resize).observe(stage);
  canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); showFallback('Graphics rendering was interrupted. Refresh to restore the textured viewer.'); });
  setExpanded(true);
  updateUI();
  loadPainting(works[workIndex]);
} catch {
  showFallback('This browser could not start WebGL. The original image is shown instead.');
}

// A small read-only diagnostic snapshot for browser checks, with no rendering internals exposed.
Object.defineProperty(window, '__gallery', { get: () => ({
  ready, ...state,
  tiltDegrees: THREE.MathUtils.radToDeg(Math.atan(tiltCurrent.length() * Math.tan(MAX_TILT))),
  targetTiltDegrees: THREE.MathUtils.radToDeg(Math.atan(tiltTarget.length() * Math.tan(MAX_TILT))),
  pan: [pan.x, pan.y], canPan: renderer ? canPan() : false, hasXray: Boolean(xrayTexture),
  viewProjection: camera ? new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).toArray() : null,
  warmed: [...surfaceCache.keys()],
  preloaded: [...preloaded.keys()],
  textureSize: surfaceTexture ? [surfaceTexture.image.width, surfaceTexture.image.height] : null,
}) });
