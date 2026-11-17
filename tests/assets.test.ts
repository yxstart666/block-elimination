import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { UiAssets } from '../src/ui/assets.ts';
import { UI_FRAMES } from '../src/ui/atlas-data.ts';

const manifest = JSON.parse(readFileSync(new URL('../assets/ui/atlas.json', import.meta.url), 'utf8'));
function harness(base = 'assets/ui/') {
  const images: any[] = [], calls: any[][] = [];
  let notifications = 0;
  const assets = new UiAssets(() => { const image = { src: '', onload: null, onerror: null }; images.push(image); return image; }, base, () => notifications++);
  const ctx = { drawImage: (...args: any[]) => calls.push(args) } as unknown as CanvasRenderingContext2D;
  const loadAll = () => images.forEach(image => image.onload?.());
  return { assets, images, calls, ctx, loadAll, notifications: () => notifications };
}

test('four platform image handles load once and use the supplied package-local base path', async () => {
  for (const base of ['./assets/ui/', '/assets/ui/', 'assets/ui']) {
    const h = harness(base);
    assert.equal(h.images.length, 4);
    assert.deepEqual(h.images.map(image => image.src), ['tiles.png', 'icons.png', 'ui.png', 'background.png'].map(file => `${base.replace(/\/+$/, '')}/${file}`));
    assert.equal(h.assets.ready, false);
    const firstLoad = h.images[0].onload;
    firstLoad(); firstLoad();
    h.images.slice(1).forEach(image => image.onload());
    await Promise.resolve();
    assert.equal(h.assets.ready, true);
    assert.equal(h.assets.failed, false);
    assert.equal(h.notifications(), 4, 'duplicate SDK load callbacks do not notify again');
    assert.ok(h.images.every(image => image.onload === null && image.onerror === null));
    h.assets.dispose();
  }
});

test('missing factories, factory errors, image errors and late callbacks are safe', async () => {
  const missing = new UiAssets(undefined);
  assert.equal(missing.ready, false); assert.equal(missing.failed, true);
  const broken = new UiAssets(() => { throw Error('not supported'); });
  assert.equal(broken.failed, true);
  const h = harness();
  const lateLoad = h.images[0].onload;
  h.images[1].onerror();
  h.images[2].onload(); h.images[3].onload();
  assert.equal(h.assets.failed, true); assert.equal(h.assets.ready, false);
  h.assets.dispose(); h.assets.dispose(); lateLoad();
  await Promise.resolve();
  assert.equal(h.notifications(), 0, 'queued and SDK callbacks cannot re-render a destroyed page');
  assert.equal(h.assets.background(h.ctx, 0, 0, 390, 844), false);
  assert.equal(h.assets.draw(h.ctx, 'tile_red', 0, 0, 40, 40), false);
  assert.ok(h.images.every(image => image.onload === null && image.onerror === null));
});

test('sprites crop the approved frame and reject unloaded, unknown or invalid targets', () => {
  const h = harness();
  assert.equal(h.assets.draw(h.ctx, 'tile_blue_star', 1, 2, 40, 40), false);
  h.loadAll();
  const frame = manifest.frames.tile_blue_star.frame;
  assert.equal(h.assets.draw(h.ctx, 'tile_blue_star', 1, 2, 40, 40), true);
  assert.deepEqual(h.calls[0], [h.images[0], frame.x, frame.y, frame.w, frame.h, 1, 2, 40, 40]);
  const count = h.calls.length;
  for (const [id, width, height] of [['unknown', 10, 10], ['tile_red', 0, 10], ['tile_red', 10, -1], ['tile_red', NaN, 10]] as const) {
    assert.equal(h.assets.draw(h.ctx, id, 0, 0, width, height), false);
  }
  assert.equal(h.calls.length, count);
});

test('nine-slice panels preserve source corners while stretching only edges and center', () => {
  const h = harness(); h.loadAll();
  h.assets.draw(h.ctx, 'ui_button_primary', 10, 20, 286, 48, true);
  assert.equal(h.calls.length, 9);
  const small = h.calls.splice(0);
  h.assets.draw(h.ctx, 'ui_button_primary', 10, 20, 786, 48, true);
  const wide = h.calls.splice(0);
  assert.deepEqual(small[0], wide[0], 'top-left corner remains fixed when the button widens');
  assert.deepEqual(small[8].slice(1, 5), wide[8].slice(1, 5), 'bottom-right corner retains source crop');
  assert.equal(wide[1][7] - small[1][7], 500, 'only the horizontal center gets wider');
  assert.equal(small[0][5], 10); assert.equal(small[0][6], 20);
  assert.ok(Math.abs(small[8][5] + small[8][7] - 296) < 1e-9);
  assert.ok(Math.abs(small[8][6] + small[8][8] - 68) < 1e-9);
  h.assets.draw(h.ctx, 'ui_modal_panel', 0, 0, 8, 8, true);
  assert.ok(h.calls.length > 0 && h.calls.every(call => call.slice(1).every(Number.isFinite) && call[3] > 0 && call[4] > 0 && call[7] > 0 && call[8] > 0));
});

test('icons retain their proportions and background uses a centered cover crop', () => {
  const h = harness(); h.loadAll();
  h.assets.fit(h.ctx, 'icon_video', 0, 0, 60, 20);
  const icon = h.calls[0], frame = manifest.frames.icon_video.frame;
  assert.ok(Math.abs(icon[7] / icon[8] - frame.w / frame.h) < 1e-9);
  assert.ok(Math.abs(icon[5] + icon[7] / 2 - 30) < 1e-9);
  h.assets.background(h.ctx, 0, 0, 390, 844);
  assert.deepEqual(h.calls[1], [h.images[3], 0, 0, 390, 844, 0, 0, 390, 844]);
  h.assets.background(h.ctx, 0, 0, 844, 390);
  const cover = h.calls[2];
  assert.equal(cover[1], 0); assert.ok(cover[2] > 0);
  assert.ok(Math.abs(cover[3] / cover[4] - 844 / 390) < 1e-9);
  assert.equal(h.assets.fit(h.ctx, 'not-an-asset', 0, 0, 10, 10), false);
});

test('nine-slice shared edges align to device pixels without transparent patch seams', () => {
  const h = harness(); h.loadAll();
  const ctx = Object.assign(h.ctx, { getTransform: () => ({ a: 1.75, b: 0, c: 0, d: 1.75, e: .3, f: .8 }) });
  h.assets.draw(ctx, 'ui_modal_panel', 32.2, 173.7, 326, 484, true);
  for (const call of h.calls) {
    for (const value of [call[5] * 1.75 + .3, (call[5] + call[7]) * 1.75 + .3,
      call[6] * 1.75 + .8, (call[6] + call[8]) * 1.75 + .8]) assert.ok(Math.abs(value - Math.round(value)) < 1e-9);
  }
});

test('typed sprite metadata and all three delivered runtime packages match the approved manifest', () => {
  const expected = Object.fromEntries(Object.entries(manifest.frames).map(([id, item]: [string, any]) => [id, {
    atlas: item.atlas, frame: item.frame, ...(item.nineSliceInsets ? { nineSliceInsets: item.nineSliceInsets } : {}),
    ...(item.suggestedLogicalSize ? { logicalSize: item.suggestedLogicalSize } : {}),
  }]));
  assert.deepEqual(UI_FRAMES, expected);
  assert.equal(Object.keys(UI_FRAMES).length, 43);
  const files = ['tiles.png', 'icons.png', 'ui.png', 'background.png', 'atlas.json'];
  let pngBytes = 0;
  for (const file of files) {
    const approved = readFileSync(new URL(`../assets/ui/${file}`, import.meta.url));
    if (file.endsWith('.png')) pngBytes += approved.length;
    const sha = createHash('sha256').update(approved).digest('hex');
    for (const directory of ['dist/web', 'platforms/miniprogram', 'platforms/minigame']) {
      const delivered = readFileSync(new URL(`../${directory}/assets/ui/${file}`, import.meta.url));
      assert.equal(createHash('sha256').update(delivered).digest('hex'), sha, `${directory}/${file}`);
    }
  }
  assert.equal(pngBytes, manifest.totals.runtimeImageBytes, 'only the four approved lightweight PNGs are delivered');
});
