import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { buildAll } from './build.mjs';
import { serve } from './server.mjs';

await buildAll(); await mkdir('.local/qa/rotation-icon', { recursive: true });
const manifest = JSON.parse(await readFile('assets/ui/atlas.json', 'utf8'));
const source = manifest.frames.icon_rotate.frame;
const server = serve(0); await once(server, 'listening');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const errors = [], samples = [];
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(chrome) ? chrome : undefined), headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-11-17T09:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-17T09:00:01Z'));
  await page.addInitScript(() => localStorage.setItem('wood-blocks.tutorial-seen.v1', 'true'));
  await page.goto(`http://127.0.0.1:${server.address().port}/?debug=1&test=off`);
  await page.waitForLoadState('networkidle');
  assert.equal(await page.evaluate(() => window.__game.assets.ready), true);
  await page.clock.runFor(32);
  const read = () => page.evaluate(() => {
    const g = window.__game;
    return { state: g.state, stock: g.economy.inventory.rotate, rotationMode: g.rotationMode,
      guideAt: g.rotationGuideAt, time: Date.now(), overlay: g.overlay, frame: g.frame };
  });
  const point = (name, index = 0) => page.evaluate(({ name, index }) => {
    const g = window.__game, b = document.querySelector('canvas').getBoundingClientRect();
    const result = typeof g[name] === 'function' ? g[name]() : g[name], r = Array.isArray(result) ? result[index] : result;
    return { x: b.left + g.offsetX + (r.x + r.w / 2) * g.scale, y: b.top + (r.y + r.h / 2) * g.scale };
  }, { name, index });
  const click = async (name, index = 0) => { const p = await point(name, index); await page.mouse.click(p.x, p.y); };
  const signature = piece => piece?.cells.map(c => `${c.x},${c.y}`).sort().join(';');
  const fixture = async (symmetricOnly = false) => {
    await page.evaluate(symmetricOnly => {
      const g = window.__game; g.reset();
      const square = { id: 'symmetric-square', color: 1, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] };
      g.state = { ...g.state, mode: 'endless', level: undefined, tutorial: false, status: 'playing', score: 0, moves: 0,
        board: Array.from({ length: 8 }, () => Array(8).fill(0)),
        pieces: [symmetricOnly ? structuredClone(square) : { id: 'asymmetric-L', color: 4, cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] },
          square, { id: 'symmetric-single', color: 0, cells: [{ x: 0, y: 0 }] }] };
      g.economy.inventory.rotate = 2; g.overlay = null; g.toast.at = 0;
      g.scoreAt = 0; g.goalPulseAt = 0; g.earnedStarAt = 0; g.acquiredAt = 0; g.invalidate();
    }, symmetricOnly);
    await page.clock.runFor(32);
  };
  const snapshot = async name => {
    const glyphs = await page.evaluate(source => {
      const g = window.__game, calls = [], original = g.ctx.drawImage;
      g.ctx.drawImage = function (image, ...args) {
        const [sx, sy, sw, sh, x, y, w, h] = args;
        if (String(image.src).endsWith('/icons.png') && sx === source.x && sy === source.y && sw === source.w && sh === source.h) {
          const m = this.getTransform(), cx = x + w / 2, cy = y + h / 2;
          const px = ((m.a * cx + m.c * cy + m.e) / g.ratio - g.offsetX) / g.scale;
          const py = (m.b * cx + m.d * cy + m.f) / g.ratio / g.scale;
          calls.push({ x: px, y: py, angle: Math.atan2(m.b, m.a), alpha: this.globalAlpha, source: [sx, sy, sw, sh],
            role: py >= g.dockButtons()[1].y - 10 ? 'dock' : 'candidate' });
        }
        return original.call(this, image, ...args);
      };
      try { g.draw(); } finally { g.ctx.drawImage = original; }
      return calls;
    }, source);
    const data = { name, glyphs, ...(await read()) }; samples.push(data);
    if (['guide-000', 'guide-240', 'guide-600', 'guide-1320', 'exited'].includes(name))
      await page.screenshot({ path: `.local/qa/rotation-icon/${name}.png` });
    return data;
  };
  const dock = sample => sample.glyphs.find(glyph => glyph.role === 'dock');
  const candidate = (sample, index) => sample.glyphs.filter(glyph => glyph.role === 'candidate').sort((a, b) => a.x - b.x)[index];
  const delta = (a, b) => { let value = b - a; while (value < -.01) value += Math.PI * 2; return value; };
  await fixture(); const original = await read();
  const idle = await snapshot('idle'); assert.equal(idle.glyphs.length, 1, 'idle draws the shared icon in the dock only');
  assert.equal(idle.frame, null, 'the idle rotate icon does not animate'); assert.ok(Math.abs(dock(idle).angle) < .002);
  await click('dockButtons', 1);
  await page.evaluate(() => { window.__game.toast.at = 0; }); // Isolate the guide from the existing toast animation.
  const entered = await read();
  assert.equal(entered.rotationMode, true); assert.equal(entered.stock, 2); assert.equal(entered.guideAt, entered.time);
  assert.deepEqual(entered.state.pieces, original.state.pieces, 'entering rotation changes no pieces or stock');
  const entering = [await snapshot('guide-000')];
  assert.equal(entering[0].glyphs.length, 4, 'dock and all three candidate marks draw the same atlas crop');
  let elapsed = 0;
  for (const at of [120, 240, 360, 600, 900, 1200, 1320]) {
    await page.clock.runFor(at - elapsed); elapsed = at; entering.push(await snapshot(`guide-${String(at).padStart(3, '0')}`));
  }
  for (const sample of entering) {
    assert.ok(Math.abs(dock(sample).angle) < .002, 'the bottom button remains static throughout rotation mode');
    assert.equal(dock(sample).alpha, 1);
    assert.ok(sample.glyphs.filter(glyph => glyph.role === 'candidate').every(glyph => glyph.alpha === .5), 'all moving candidate marks remain half transparent');
    assert.notEqual(sample.frame, null, 'candidate guidance continues to schedule animation frames while the mode is active');
  }
  for (let index = 0; index < 3; index++) {
    let turned = 0;
    for (let i = 1; i < entering.length; i++) {
      const step = delta(candidate(entering[i - 1], index).angle, candidate(entering[i], index).angle);
      assert.ok(step > 0, 'every candidate mark keeps rotating clockwise after 240 ms'); turned += step;
      const expected = (entering[i].time - entering[0].time) / 1200 * Math.PI * 2;
      assert.ok(Math.abs(turned - expected) < .002, 'candidate guidance makes one clockwise turn every 1200 ms');
    }
  }
  await click('slots', 0); await page.evaluate(() => { window.__game.toast.at = 0; });
  const trial = await read();
  assert.notEqual(signature(trial.state.pieces[0]), signature(original.state.pieces[0]));
  assert.equal(trial.stock, 2, 'a successful preview spends no stock');
  assert.equal(trial.guideAt, entered.guideAt, 'successful preview does not restart or replace the continuous guide');
  let before = await read(); await click('slots', 1); let after = await read();
  assert.equal(after.guideAt, before.guideAt, 'a symmetric square does not restart the continuous guide');
  assert.deepEqual(after.state.pieces, before.state.pieces); assert.equal(after.stock, 2);
  await page.evaluate(() => { const g = window.__game; g.state.pieces[2] = null; g.rotationOriginals[2] = null; g.toast.at = 0; });
  before = await read(); await click('slots', 2); await page.keyboard.press('3'); after = await read();
  assert.equal(after.guideAt, before.guideAt, 'empty-slot click and shortcut do not restart the guide');
  assert.deepEqual(after.state.pieces, before.state.pieces); assert.equal(after.stock, 2);
  const p = await point('slots', 0);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(12, 20, { steps: 3 }); await page.mouse.up();
  after = await read(); assert.equal(after.guideAt, before.guideAt, 'invalid drag does not restart the continuous guide');
  assert.equal(after.stock, 2); assert.equal(after.state.moves, 0); await page.clock.runFor(300);
  const end = await page.evaluate(() => {
    const g = window.__game, b = document.querySelector('canvas').getBoundingClientRect(), piece = g.state.pieces[0];
    const w = Math.max(...piece.cells.map(c => c.x + 1)), h = Math.max(...piece.cells.map(c => c.y + 1));
    return { x: b.left + g.offsetX + (g.board.x + (4 + w / 2) * g.cell) * g.scale,
      y: b.top + (g.board.y + (3 + h / 2) * g.cell) * g.scale };
  });
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 3 }); await page.mouse.up();
  after = await read(); assert.equal(after.stock, 1, 'placing the changed orientation consumes exactly one rotation');
  assert.equal(after.state.moves, 1); assert.equal(after.state.pieces[0], null);
  await click('dockButtons', 1); assert.equal((await read()).rotationMode, false); assert.equal((await read()).stock, 1);
  const exited = await snapshot('exited'); assert.equal(exited.guideAt, 0); assert.equal(exited.glyphs.length, 1, 'exiting removes candidate marks');
  await page.clock.runFor(2600); assert.equal((await read()).frame, null, 'exit stops guide RAF after unrelated toast/placement feedback settles');
  await fixture(); await click('dockButtons', 1); await click('settingsButton');
  assert.equal((await read()).rotationMode, false); assert.equal((await read()).guideAt, 0); assert.equal((await read()).overlay, 'settings');
  await click('settingsButtons', 4); await page.evaluate(() => { window.__game.toast.at = 0; }); await page.clock.runFor(300);
  assert.equal((await read()).frame, null, 'opening settings stops the guide');
  await fixture(); await click('dockButtons', 1); await page.keyboard.press('l');
  assert.equal((await read()).overlay, 'levels'); assert.equal((await read()).rotationMode, false); assert.equal((await read()).guideAt, 0);
  await click('levelMenuButtons', 1); await page.evaluate(() => { window.__game.toast.at = 0; }); await page.clock.runFor(300);
  assert.equal((await read()).frame, null, 'opening the map stops the guide');
  await fixture(); await page.evaluate(() => {
    const g = window.__game;
    g.state.board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2));
    g.state.pieces = [{ id: 'last-single', color: 0, cells: [{ x: 0, y: 0 }] },
      { id: 'blocked-L', color: 4, cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null];
  });
  await click('dockButtons', 1); assert.equal((await read()).rotationMode, true);
  const lastStart = await point('slots', 0), lastEnd = await page.evaluate(() => {
    const g = window.__game, b = document.querySelector('canvas').getBoundingClientRect();
    return { x: b.left + g.offsetX + (g.board.x + g.cell / 2) * g.scale, y: b.top + (g.board.y + g.cell / 2) * g.scale };
  });
  await page.mouse.move(lastStart.x, lastStart.y); await page.mouse.down(); await page.mouse.move(lastEnd.x, lastEnd.y, { steps: 3 }); await page.mouse.up();
  after = await read(); assert.equal(after.state.status, 'lost'); assert.equal(after.rotationMode, false); assert.equal(after.guideAt, 0);
  assert.equal((await snapshot('terminal')).glyphs.length, 1); await page.clock.runFor(2600);
  assert.equal((await read()).frame, null, 'terminal play cannot keep candidate guidance running');
  await fixture(true); before = await read(); await click('dockButtons', 1); after = await read();
  assert.equal(after.rotationMode, false); assert.equal(after.guideAt, before.guideAt, 'an all-symmetric tray cannot enter rotation mode');
  assert.equal(after.stock, 2); await page.evaluate(() => { window.__game.toast.at = 0; });
  await page.clock.runFor(300); assert.equal((await read()).frame, null, 'no ambient spin or continuing RAF remains');
  assert.deepEqual(errors, []);
  await writeFile('.local/qa/rotation-icon/results.json', JSON.stringify({ source, samples, errors }, null, 2) + '\n');
  console.log('Rotation icon UI smoke passed: static opaque dock icon, half-transparent candidate guides rotating clockwise every 1200ms only in rotation mode, continued motion after 240ms, exit/settings/map/terminal cleanup, symmetric/invalid guards and placement-only inventory charge.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
