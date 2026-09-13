import * as THREE from 'three';
import './style.css';
import { vertexShader, fragmentShader } from './shaders.js';

const $ = (selector) => document.querySelector(selector);
const stage = $('#stage');
const canvas = $('#gallery-canvas');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const MAX_TILT = THREE.MathUtils.degToRad(3);
const defaults = { weave: .30, relief: .45, roughness: .55, elevation: 35, mode: 'tilt', surfaceOnly: false, original: false, zoom: 1 };
const state = { ...defaults };
const lightTarget = new THREE.Vector2(-.75, .55);
const tiltTarget = new THREE.Vector2();
const lightCurrent = lightTarget.clone();
const tiltCurrent = tiltTarget.clone();
const sliders = [
  ['canvas-weave', 'weave', 100, '%'],
  ['paint-relief', 'relief', 100, '%'],
  ['roughness', 'roughness', 100, '%'],
  ['light-angle', 'elevation', 1, '°'],
];
const works = [
  {
    src: '/art/wheat-field.jpg',
    artist: 'Vincent van Gogh', life: 'Dutch, 1853–1890',
    title: 'Wheat Field with Cypresses', year: '1889',
    place: 'Painted in Saint-Rémy-de-Provence, France', medium: 'Oil on canvas',
    collection: 'The Metropolitan Museum of Art, New York', room: 'The Met Fifth Avenue, Gallery 822',
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
let workIndex = 0, showingUpload = false;

let renderer, scene, camera, painting, artworkGroup, material;
let frameRequest = 0, previousTime = 0, ready = false;
let aspect = 1200 / 955, cameraDistance = 4;
let colorTexture, surfaceTexture;
let loadVersion = 0, activeWorker;
let currentObjectUrl;

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
  present.forEach((line, index) => {
    if (index) element.append(document.createElement('br'));
    element.append(...[].concat(line));
  });
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
  $('#zoom-value').value = `${state.zoom}×`;
  $('#previous-work').disabled = !ready || (!showingUpload && workIndex === 0);
  $('#next-work').disabled = !ready || (!showingUpload && workIndex === works.length - 1);
  $('#zoom-out').disabled = state.zoom <= 1;
  $('#zoom-in').disabled = state.zoom >= 2;
  stage.classList.toggle('tilt-mode', state.mode === 'tilt');
  stage.setAttribute('aria-label', `Interactive painting. ${state.mode === 'light' ? 'Move the pointer to move the light.' : 'Move the pointer to tilt your viewpoint, limited to three degrees.'} Arrow keys also control this interaction. Press Home to center.`);
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
  if (lightCurrent.distanceToSquared(lightTarget) < .000001) lightCurrent.copy(lightTarget);
  if (tiltCurrent.distanceToSquared(tiltTarget) < .000001) tiltCurrent.copy(tiltTarget);
  if (camera) {
    const distance = cameraDistance / state.zoom;
    camera.position.set(tiltCurrent.x * Math.tan(MAX_TILT) * distance, tiltCurrent.y * Math.tan(MAX_TILT) * distance, distance);
    camera.lookAt(0, 0, 0);
  }
  if (material) {
    const elevation = THREE.MathUtils.degToRad(state.elevation);
    const direction = lightCurrent.clone();
    if (direction.lengthSq() < .001) direction.set(-.75, .55);
    direction.normalize();
    material.uniforms.uLight.value.set(direction.x * Math.cos(elevation), direction.y * Math.cos(elevation), Math.sin(elevation));
    material.uniforms.uWeave.value = state.weave;
    material.uniforms.uRelief.value = state.relief;
    material.uniforms.uRoughness.value = state.roughness;
    material.uniforms.uSurfaceOnly.value = state.surfaceOnly;
    material.uniforms.uOriginal.value = state.original;
  }
  renderer.render(scene, camera);
  if (lightCurrent.distanceToSquared(lightTarget) > .000001 || tiltCurrent.distanceToSquared(tiltTarget) > .000001) requestRender();
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
  requestRender();
}

function createShadow(width, height) {
  const image = document.createElement('canvas');
  image.width = 512; image.height = 512;
  const context = image.getContext('2d');
  context.filter = 'blur(17px)';
  context.fillStyle = 'rgba(40, 43, 28, 0.24)';
  context.fillRect(57, 69, 398, 382);
  context.filter = 'blur(4px)';
  context.fillStyle = 'rgba(40, 43, 28, 0.13)';
  context.fillRect(58, 65, 396, 382);
  const texture = new THREE.CanvasTexture(image);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.28, height * 1.34), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
  shadow.position.set(0, -.025, -.035);
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
  const backing = new THREE.Mesh(new THREE.BoxGeometry(width + .026, height + .026, .026), new THREE.MeshStandardMaterial({ color: '#8b8165', roughness: .82 }));
  backing.position.z = -.015;
  artworkGroup.add(backing);
  const inset = new THREE.Mesh(new THREE.PlaneGeometry(width + .01, height + .01), new THREE.MeshBasicMaterial({ color: '#c8ba93' }));
  inset.position.z = -.0008;
  artworkGroup.add(inset);
  material = new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: {
      uColor: { value: colorTexture }, uSurface: { value: surfaceTexture },
      uTexel: { value: new THREE.Vector2(1 / surfaceTexture.image.width, 1 / surfaceTexture.image.height) },
      uSize: { value: new THREE.Vector2(width, height) },
      uLight: { value: new THREE.Vector3(-.6, .5, .6) },
      uWeave: { value: state.weave }, uRelief: { value: state.relief },
      uRoughness: { value: state.roughness }, uSurfaceOnly: { value: false }, uOriginal: { value: false },
    },
  });
  painting = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  artworkGroup.add(painting);
  scene.add(artworkGroup);
  resize();
}

function prepareSurface(image) {
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
    activeWorker = worker;
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

async function loadPainting(work, uploaded = false) {
  const url = work.src;
  const version = ++loadVersion;
  $('#loading').hidden = false;
  $('#upload-button').disabled = true;
  $('#previous-work').disabled = true;
  $('#next-work').disabled = true;
  status('');
  let nextColor;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (image.naturalWidth < 32 || image.naturalHeight < 32) throw new Error('Please choose an image at least 32 pixels on each side.');
    const imageAspect = image.naturalWidth / image.naturalHeight;
    if (imageAspect < .2 || imageAspect > 5) throw new Error('Please choose a painting with an aspect ratio between 1:5 and 5:1.');
    const surface = await prepareSurface(image);
    if (version !== loadVersion) return;
    const maxColorSize = Math.min(4096, renderer.capabilities.maxTextureSize);
    const source = document.createElement('canvas');
    const scale = Math.min(1, maxColorSize / Math.max(image.naturalWidth, image.naturalHeight));
    source.width = Math.round(image.naturalWidth * scale); source.height = Math.round(image.naturalHeight * scale);
    const context = source.getContext('2d');
    context.fillStyle = '#f2f0e6'; context.fillRect(0, 0, source.width, source.height);
    context.drawImage(image, 0, 0, source.width, source.height);
    // Shader explicitly converts source sRGB to linear to keep comparison faithful.
    nextColor = new THREE.CanvasTexture(source);
    nextColor.colorSpace = THREE.NoColorSpace;
    nextColor.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const nextSurface = new THREE.DataTexture(new Uint8Array(surface.pixels), surface.width, surface.height, THREE.RGBAFormat);
    nextSurface.flipY = true;
    nextSurface.magFilter = THREE.LinearFilter;
    nextSurface.minFilter = THREE.LinearMipmapLinearFilter;
    nextSurface.generateMipmaps = true;
    nextSurface.anisotropy = nextColor.anisotropy;
    nextSurface.needsUpdate = true;
    const oldColor = colorTexture, oldSurface = surfaceTexture;
    colorTexture = nextColor; surfaceTexture = nextSurface;
    aspect = imageAspect;
    state.zoom = 1; state.original = false;
    mountPainting();
    oldColor?.dispose(); oldSurface?.dispose();
    ready = true;
    canvas.hidden = false;
    $('#fallback-image').hidden = true;
    document.querySelectorAll('.controls button, .controls input, #compare').forEach((control) => { control.disabled = false; });
    stage.dataset.ready = 'true';
    $('#fallback-image').src = url;
    showingUpload = uploaded;
    showLabel(work);
    if (uploaded) status('Your image is ready. Adjust the relief and canvas weave to suit the painting.');
    updateUI();
  } catch (error) {
    nextColor?.dispose();
    status(error.message || 'The image could not be loaded. Try a JPEG, PNG, or WebP image.', true);
    if (!ready) showFallback('The textured viewer could not load. You can still view the original painting.');
  } finally {
    if (version === loadVersion) {
      $('#loading').hidden = true;
      $('#upload-button').disabled = false;
    }
  }
}

function showFallback(message) {
  $('#fallback-image').hidden = false;
  canvas.hidden = true;
  $('#loading').hidden = true;
  document.querySelectorAll('.controls button, .controls input, #compare, .works button, #upload-button').forEach((control) => { control.disabled = true; });
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
$('#zoom-in').addEventListener('click', () => { state.zoom = Math.min(2, state.zoom + .5); updateUI(); });
$('#zoom-out').addEventListener('click', () => { state.zoom = Math.max(1, state.zoom - .5); updateUI(); });
function showWork(index) {
  const next = THREE.MathUtils.clamp(index, 0, works.length - 1);
  if (!ready || (next === workIndex && !showingUpload)) return;
  workIndex = next;
  loadPainting(works[next]);
}
$('#previous-work').addEventListener('click', () => showWork(showingUpload ? workIndex : workIndex - 1));
$('#next-work').addEventListener('click', () => showWork(showingUpload ? workIndex : workIndex + 1));
$('#reset').addEventListener('click', () => {
  Object.assign(state, defaults);
  lightTarget.set(-.75, .55); tiltTarget.set(0, 0);
  updateUI(); status('View and surface settings reset.');
});

function movePointer(event) {
  if (!ready || event.target.closest('button')) return;
  if (event.pointerType === 'touch' && !stage.hasPointerCapture(event.pointerId)) return;
  const rect = stage.getBoundingClientRect();
  const x = THREE.MathUtils.clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
  const y = THREE.MathUtils.clamp(1 - (event.clientY - rect.top) / rect.height * 2, -1, 1);
  if (state.mode === 'tilt') {
    tiltTarget.set(x, y).clampLength(0, 1);
  } else if (x * x + y * y > .015) {
    lightTarget.set(x, y);
  }
  requestRender();
}
let pressOrigin;
stage.addEventListener('pointermove', movePointer);
stage.addEventListener('click', (event) => {
  if (!ready || event.target.closest('button')) return;
  if (!pressOrigin || pressOrigin.pointerType === 'touch') return;
  if (Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y) > 6) return;
  setExpanded(!document.body.classList.contains('expanded'));
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setExpanded(false);
});
stage.addEventListener('pointerdown', (event) => {
  if (event.target.closest('button')) return;
  pressOrigin = { x: event.clientX, y: event.clientY, pointerType: event.pointerType };
  if (event.pointerType === 'touch' || event.pointerType === 'pen') stage.setPointerCapture(event.pointerId);
  movePointer(event);
});
stage.addEventListener('pointerleave', () => { tiltTarget.set(0, 0); requestRender(); });
stage.addEventListener('pointerup', (event) => { if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId); });
stage.addEventListener('pointercancel', () => { tiltTarget.set(0, 0); requestRender(); });
stage.addEventListener('keydown', (event) => {
  if (event.target !== stage || !ready) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    return setExpanded(!document.body.classList.contains('expanded'));
  }
  const delta = { ArrowLeft: [-.15, 0], ArrowRight: [.15, 0], ArrowUp: [0, .15], ArrowDown: [0, -.15] }[event.key];
  const target = state.mode === 'tilt' ? tiltTarget : lightTarget;
  if (delta) { event.preventDefault(); target.add(new THREE.Vector2(...delta)).clampLength(0, 1); requestRender(); }
  if (event.key === 'Home') { event.preventDefault(); target.copy(state.mode === 'tilt' ? new THREE.Vector2() : new THREE.Vector2(-.75, .55)); requestRender(); }
});

$('#upload-button').addEventListener('click', () => $('#upload').click());
$('#upload').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return status('Please choose a JPEG, PNG, or WebP image.', true);
  if (file.size > 40 * 1024 * 1024) return status('Please choose an image smaller than 40 MB.', true);
  const url = URL.createObjectURL(file);
  const previousUrl = currentObjectUrl;
  await loadPainting({ src: url, title: file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '), artist: 'Artist unknown' }, true);
  if ($('#fallback-image').getAttribute('src') === url) {
    currentObjectUrl = url;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  } else URL.revokeObjectURL(url);
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
  textureSize: surfaceTexture ? [surfaceTexture.image.width, surfaceTexture.image.height] : null,
}) });
