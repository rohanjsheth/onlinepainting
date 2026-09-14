import { test, expect } from '@playwright/test';

async function loaded(page) {
  page.on('pageerror', error => console.log('BROWSER ERROR:', error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('BROWSER CONSOLE:', message.text()); });
  await page.goto('/');
  await expect(page.locator('#stage')).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  await expect(page.locator('#loading')).toBeHidden();
  await page.evaluate(() => document.fonts.ready);
}

test('renders paint, relights it, limits head tilt, and preserves the original comparison', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error' && /THREE|WebGL|shader/i.test(msg.text())) errors.push(msg.text()); });
  await loaded(page);
  await expect(page.locator('h1, .masthead, .intro')).toHaveCount(0);
  await expect(page.locator('#viewing-options')).not.toHaveAttribute('open', '');
  await expect(page.locator('.artwork-label')).toContainText('1853–1890');
  await expect(page.locator('.artwork-label')).toContainText('Saint-Rémy-de-Provence, France');
  await expect(page.locator('.artwork-label')).toContainText('1889');
  await expect(page.locator('.artwork-label')).toContainText('The Metropolitan Museum of Art, New York');
  expect(await page.locator('.artwork-label').evaluate(el => getComputedStyle(el).fontFamily)).toContain('Libre Franklin');
  await page.screenshot({ path: 'test-results/gallery-initial.png', fullPage: true });
  await page.locator('#viewing-options summary').click();
  await page.locator('#stage').scrollIntoViewIfNeeded();
  const area = await page.locator('#stage').boundingBox();
  const painting = page.locator('#gallery-canvas');
  await page.locator('[data-mode="light"]').click();
  await page.mouse.move(area.x + area.width * .15, area.y + area.height * .25);
  await page.waitForTimeout(800);
  const leftLight = await painting.screenshot();
  await page.mouse.move(area.x + area.width * .7, area.y + area.height * .6);
  await page.waitForTimeout(800);
  expect((await painting.screenshot()).equals(leftLight)).toBe(false);
  await page.locator('[data-mode="tilt"]').click();
  await page.locator('#stage').scrollIntoViewIfNeeded();
  const movedArea = await page.locator('#stage').boundingBox();
  Object.assign(area, movedArea);
  await page.mouse.move(area.x + area.width * .77, area.y + area.height * .25);
  await expect.poll(() => page.evaluate(() => window.__gallery.tiltDegrees)).toBeGreaterThan(4.0);
  expect(await page.evaluate(() => window.__gallery.tiltDegrees)).toBeLessThanOrEqual(4.5001);
  await page.mouse.move(area.x + area.width - 2, area.y + 2);
  await expect.poll(() => page.evaluate(() => window.__gallery.targetTiltDegrees)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__gallery.tiltDegrees)).toBeLessThan(.1);
  await page.locator('#stage').focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => window.__gallery.targetTiltDegrees)).toBeLessThanOrEqual(4.5001);
  await page.locator('[data-mode="light"]').click();
  await page.locator('#compare').click();
  await page.locator('#stage').scrollIntoViewIfNeeded();
  Object.assign(area, await page.locator('#stage').boundingBox());
  await page.mouse.move(area.x + area.width * .8, area.y + area.height * .25);
  await page.waitForTimeout(800);
  const original = await painting.screenshot();
  await page.mouse.move(area.x + area.width * .15, area.y + area.height * .25);
  await page.waitForTimeout(800);
  expect((await painting.screenshot()).equals(original)).toBe(true);
  await page.locator('#compare').click();
  await page.locator('#surface-only').click();
  await expect(page.locator('#surface-only')).toHaveAttribute('aria-checked', 'true');
  Object.assign(area, await page.locator('#stage').boundingBox());
  await page.mouse.click(area.x + area.width * .3, area.y + area.height * .35);
  expect(await page.evaluate(() => window.__gallery.zoom)).toBe(1);
  await page.mouse.wheel(0, -250);
  await expect.poll(() => page.evaluate(() => window.__gallery.zoom)).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.__gallery.pan.some(v => v !== 0))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__gallery.zoom)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__gallery.pan.map(v => v === 0 ? 0 : v))).toEqual([0, 0]);
  await page.mouse.click(area.x + area.width * .3, area.y + area.height * .35);
  await page.mouse.wheel(0, -250);
  await expect.poll(() => page.evaluate(() => window.__gallery.zoom)).toBeGreaterThan(1);
  const zoom = await page.evaluate(() => window.__gallery.zoom);
  await page.mouse.click(area.x + area.width * .5, area.y + area.height * .5);
  expect(await page.evaluate(() => window.__gallery.zoom)).toBe(zoom);
  await page.keyboard.press('Escape');
  await page.locator('#canvas-weave').fill('0');
  const withoutWeave = await painting.screenshot();
  await page.locator('#canvas-weave').fill('100');
  expect((await painting.screenshot()).equals(withoutWeave)).toBe(false);
  await page.locator('#canvas-weave').fill('30');
  await page.screenshot({ path: 'test-results/surface-desktop.png', fullPage: true });
  await page.locator('#reset').click();
  await expect(page.locator('#canvas-weave')).toHaveValue('30');
  await expect(page.locator('#surface-only')).toHaveAttribute('aria-checked', 'false');
  await page.waitForTimeout(600);
  await page.locator('#viewing-options summary').click();
  await page.screenshot({ path: 'test-results/gallery-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('scroll zoom anchors zoom-in and recenters zoom-out, including tilted views and zoom limits', async ({ page }) => {
  await loaded(page);
  const area = await page.locator('#stage').boundingBox();
  await page.evaluate(({ x, y }) => {
    const stage = document.querySelector('#stage');
    const position = { clientX: x + 2, clientY: y + 2, bubbles: true, cancelable: true };
    stage.dispatchEvent(new WheelEvent('wheel', { ...position, deltaY: -300 }));
    stage.dispatchEvent(new MouseEvent('dblclick', position));
  }, area);
  expect(await page.evaluate(() => window.__gallery.zoom)).toBe(1);
  const x = Math.round(area.x + area.width * .68), y = Math.round(area.y + area.height * .3);
  await page.mouse.move(x, y);
  await expect.poll(() => page.evaluate(() => window.__gallery.tiltDegrees)).toBeGreaterThan(1);
  // Unproject the cursor onto the canvas plane, then project that same detail after each zoom.
  await page.evaluate(async ({ x, y }) => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const rect = document.querySelector('#stage').getBoundingClientRect();
    const ndc = new THREE.Vector3((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2, -1);
    window.zoomAnchorError = () => {
      const matrix = new THREE.Matrix4().fromArray(window.__gallery.viewProjection);
      const projected = window.zoomAnchor.clone().applyMatrix4(matrix);
      return Math.hypot((projected.x - ndc.x) * rect.width / 2, (projected.y - ndc.y) * rect.height / 2);
    };
    window.captureZoomAnchor = () => {
      const inverse = new THREE.Matrix4().fromArray(window.__gallery.viewProjection).invert();
      const near = ndc.clone().applyMatrix4(inverse);
      const far = ndc.clone().setZ(1).applyMatrix4(inverse);
      window.zoomAnchor = near.clone().addScaledVector(far.sub(near), -near.z / far.z);
    };
  }, { x, y });
  // Freeze the displayed tilt and capture the anchor in the same task as the wheel event.
  for (const delta of [-40, -180, -300, -300, -300, -300, 4, 4, 4, 120, 300, 300, 300, 300, 300]) {
    await page.evaluate(({ x, y, delta }) => {
      window.captureZoomAnchor();
      document.querySelector('#stage').dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaY: delta, cancelable: true }));
    }, { x, y, delta });
    if (delta < 0 || delta === 4) {
      await expect.poll(() => page.evaluate(() => window.zoomAnchorError())).toBeLessThan(.01);
    }
    expect(await page.evaluate(() => window.__gallery.zoom)).toBeGreaterThanOrEqual(1);
    expect(await page.evaluate(() => window.__gallery.zoom)).toBeLessThanOrEqual(8);
  }
  expect(await page.evaluate(() => window.__gallery.zoom)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__gallery.pan.map(value => value || 0))).toEqual([0, 0]);
  for (const zoom of [2, 4, 8, 8]) {
    await page.mouse.dblclick(x, y);
    await expect.poll(() => page.evaluate(() => window.__gallery.zoom)).toBe(zoom);
  }
  await page.mouse.click(x, y);
  expect(await page.evaluate(() => window.__gallery.zoom)).toBe(8);
});

test('fits a phone screen and supports touch and accessible controls', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await loaded(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('#viewing-options summary').tap();
  await page.locator('[data-mode="tilt"]').tap();
  await page.locator('#stage').scrollIntoViewIfNeeded();
  const rect = await page.locator('#stage').boundingBox();
  await page.touchscreen.tap(rect.x + rect.width * .9, rect.y + rect.height * .2);
  expect(await page.evaluate(() => window.__gallery.targetTiltDegrees)).toBeLessThanOrEqual(4.5001);
  await page.locator('#surface-only').tap();
  await expect(page.locator('#surface-only')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#viewing-options summary').tap();
  await expect(page.locator('#paint-relief')).toBeHidden();
  await page.locator('#viewing-options summary').tap();
  await page.locator('#reset').tap();
  await page.locator('#viewing-options summary').tap();
  await page.screenshot({ path: 'test-results/gallery-mobile.png', fullPage: true });
  await context.close();
});

test('names the next work before its image arrives, and warms the neighbours', async ({ page }) => {
  await loaded(page);
  await expect.poll(() => page.evaluate(() => window.__gallery.preloaded)).toEqual(['/art/roses.jpg']);
  await page.locator('#next-work').click();
  // The label leads; the painting is still on its way.
  await expect(page.locator('#artwork-title')).toHaveText('Roses', { timeout: 5000 });
  await expect(page.locator('#stage')).toHaveClass(/loading-work/);
  await expect(page.locator('#stage')).not.toHaveClass(/loading-work/, { timeout: 45000 });
  await expect.poll(() => page.evaluate(() => window.__gallery.preloaded), { timeout: 15000 })
    .toEqual(['/art/wheat-field.webp', '/art/starry-night.jpg']);
  // Both neighbours are synthesised ahead of time, not merely downloaded.
  await expect.poll(() => page.evaluate(() => [...window.__gallery.warmed].sort()), { timeout: 90000 })
    .toEqual(['/art/roses.jpg', '/art/starry-night.jpg', '/art/wheat-field.webp']);
});

test('shows the original image if WebGL is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (type.startsWith('webgl')) return null;
      return original.call(this, type, ...args);
    };
  });
  await page.goto('/');
  await expect(page.locator('#fallback-image')).toBeVisible();
  await expect(page.locator('#status')).toContainText('could not start WebGL');
  await expect(page.locator('#paint-relief')).toBeDisabled();
});
