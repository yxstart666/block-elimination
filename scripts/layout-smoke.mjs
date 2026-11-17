import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { buildAll } from './build.mjs';
import { serve } from './server.mjs';
import { LEVELS } from '../src/core/levels.ts';
import { TOOL_PRICES } from '../src/services/economy.ts';

// Geometry, actual pointer hit targets, acquisition transactions, and modal
// cancellation belong together: all must work on the same Canvas page.
await buildAll();
await mkdir('.local/qa', { recursive: true });
const server = serve(0);
await once(server, 'listening');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const kinds = ['hint', 'rotate', 'refresh', 'bomb', 'bulldozer'];
const errors = [];
let browser;

try {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(chrome) ? chrome : undefined),
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('wood-blocks.tutorial-seen.v1', 'true'));
  await page.goto(`http://127.0.0.1:${server.address().port}/?debug=1&test=off`);
  await page.waitForFunction(() => typeof window.__game?.dockButtons === 'function' && window.__game.assets?.ready);

  const read = () => page.evaluate(() => {
    const g = window.__game;
    const state = structuredClone(g.state); if (state.level) delete state.level.timeRemainingMs;
    return { state, economy: g.economy, overlay: g.overlay, kind: g.acquireKind,
      busy: g.rewardBusy, saved: localStorage.getItem('wood-blocks.economy.v1') };
  });
  const click = async (method, index = 0) => {
    const point = await page.evaluate(({ method, index }) => {
      const g = window.__game, canvas = document.querySelector('canvas').getBoundingClientRect();
      const result = typeof g[method] === 'function' ? g[method]() : g[method];
      const r = Array.isArray(result) ? result[index] : result;
      if (!r) throw new Error(`Missing ${method} ${index}`);
      return { x: canvas.left + g.offsetX + (r.x + r.w / 2) * g.scale,
        y: canvas.top + g.offsetY + (r.y + r.h / 2) * g.scale };
    }, { method, index });
    const viewport = page.viewportSize();
    assert.ok(point.x >= 0 && point.x <= viewport.width && point.y >= 0 && point.y <= viewport.height,
      `${method} ${index} is a visible hit target`);
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => !window.__game.pendingDestruction);
  };
  const drag = async (index, x, y) => {
    const points = await page.evaluate(({ index, x, y }) => {
      const g = window.__game, slot = g.slots[index], piece = g.state.pieces[index];
      const canvas = document.querySelector('canvas').getBoundingClientRect();
      const width = Math.max(...piece.cells.map(cell => cell.x + 1));
      const height = Math.max(...piece.cells.map(cell => cell.y + 1));
      const convert = (x, y) => ({ x: canvas.left + g.offsetX + x * g.scale, y: canvas.top + g.offsetY + y * g.scale });
      return { start: convert(slot.x + slot.w / 2, slot.y + slot.h / 2),
        end: convert(g.board.x + (x + width / 2) * g.cell, g.board.y + (y + height / 2) * g.cell) };
    }, { index, x, y });
    await page.mouse.move(points.start.x, points.start.y); await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, { steps: 5 }); await page.mouse.up();
  };
  const fixture = async (coins = 100, inventory = {}) => page.evaluate(({ coins, inventory }) => {
    const g = window.__game;
    g.stopRotation(); g.pointerCancel();
    const board = Array.from({ length: 8 }, () => Array(8).fill(0));
    board[0][0] = 2; board[5][0] = 3; board[6][1] = 4; board[7][2] = 5;
    g.state = { ...g.state, tutorial: false, status: 'playing', board, score: 0, moves: 0,
      pieces: [
        { id: 'layout-L', color: 1, cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }] },
        { id: 'layout-square', color: 3, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] },
        { id: 'layout-line', color: 4, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] },
      ] };
    g.economy = { ...g.economy, coins, inventory: { hint: 0, rotate: 0, refresh: 0, bomb: 0, bulldozer: 0, ...inventory } };
    g.overlay = null; g.acquireKind = null; g.resultAt = 0;
    g.clearFx = null; g.placeFx = null; g.particles = []; g.hint = null;
    g.invalidate();
  }, { coins, inventory });
  const drawText = () => page.evaluate(() => {
    const g = window.__game, texts = [], original = g.ctx.fillText;
    g.ctx.fillText = function (text, x, y, ...args) {
      texts.push({ text: String(text), x, y });
      return original.call(this, text, x, y, ...args);
    };
    try { g.draw(); } finally { g.ctx.fillText = original; }
    return { texts, buttons: g.dockButtons() };
  });
  const installDeferred = () => page.evaluate(() => {
    window.__layoutCalls = []; window.__layoutFinish = null;
    window.__game.options.rewarded = {
      request(kind) {
        window.__layoutCalls.push(kind);
        return new Promise(resolve => { window.__layoutFinish = resolve; });
      }, dispose() {},
    };
  });
  const settle = async result => {
    await page.evaluate(result => window.__layoutFinish(result), result);
    await page.waitForFunction(() => !window.__game.rewardBusy);
  };

  for (const mode of ['endless', 'level']) {
    await page.evaluate(({ mode, id }) => {
      const g = window.__game;
      if (mode === 'level') g.startLevel(id);
      else if (g.state.mode === 'level') g.returnToEndless();
      g.overlay = null;
    }, { mode, id: LEVELS[0].id });
    for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(() => window.__game.width === innerWidth && window.__game.height === innerHeight);
      const layout = await page.evaluate(() => {
        const g = window.__game;
        return { board: g.board, slots: g.slots, dock: g.dockButtons(), settings: g.settingsButton(),
          safeTop: g.safeTop, safeBottom: g.safeBottom, height: g.logicalH };
      });
      const label = `${mode} ${viewport.width}x${viewport.height}`;
      assert.equal(layout.dock.length, 5, `${label}: five distinct props`);
      assert.equal(layout.slots.length, 3, `${label}: three candidates`);
      assert.ok(layout.settings.x < 80 && layout.settings.y + layout.settings.h < layout.board.y,
        `${label}: settings is at the top left`);
      assert.ok(layout.board.y >= layout.safeTop && layout.board.y + layout.board.h < layout.slots[0].y,
        `${label}: candidates follow the board`);
      assert.ok(Math.max(...layout.slots.map(r => r.y + r.h)) < Math.min(...layout.dock.map(r => r.y)),
        `${label}: all five props follow candidates`);
      for (let index = 0; index < layout.dock.length; index++) {
        const button = layout.dock[index];
        assert.ok(button.x >= 0 && button.x + button.w <= 390, `${label}: dock width fits`);
        assert.ok(button.y + button.h <= layout.height - layout.safeBottom, `${label}: dock avoids bottom inset`);
        if (index) assert.ok(layout.dock[index - 1].x + layout.dock[index - 1].w < button.x,
          `${label}: prop hit targets do not overlap`);
      }
      await fixture();
      const before = await read();
      await click('settingsButton'); assert.equal((await read()).overlay, 'settings');
      await click('settingsButtons', 4); const after = await read();
      assert.equal(after.overlay, null); assert.deepEqual(after.state, before.state, `${label}: closing settings preserves the board`);
      await page.screenshot({ path: `.local/qa/layout-${mode}-${viewport.width}.png` });
    }
  }

  // Native metrics are relative to the canvas, just as the adapters pass them.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__game.resize(390, 844, 2, 47, 34, 60));
  const native = await page.evaluate(() => {
    const g = window.__game;
    return { settings: g.settingsButton(), board: g.board, dock: g.dockButtons(),
      scale: g.scale, height: g.logicalH, bottom: g.safeBottom };
  });
  const gearCenter = (native.settings.y + native.settings.h / 2) * native.scale;
  assert.ok(Math.abs(gearCenter - 60) <= 8, 'native gear aligns with the capsule center');
  assert.ok(native.settings.y * native.scale >= 47 - 8, 'gear does not cross the status-bar area');
  assert.ok(native.dock.every(r => (r.y + r.h) * native.scale <= 844 - 34), 'native dock clears the home indicator');
  await page.screenshot({ path: '.local/qa/layout-native-safe-area.png' });

  await fixture(100, { hint: 2, rotate: 4, refresh: 6 });
  let drawn = await drawText();
  const near = (text, button) => text.x >= button.x - 10 && text.x <= button.x + button.w + 10 &&
    text.y >= button.y - 10 && text.y <= button.y + button.h + 10;
  for (const [index, value] of [2, 4, 6].entries()) {
    assert.ok(drawn.texts.some(text => text.text === String(value) && near(text, drawn.buttons[index])),
      `the ${kinds[index]} inventory badge displays its actual quantity`);
  }
  for (const index of [3, 4]) assert.ok(!drawn.texts.some(text => text.text === '0' && near(text, drawn.buttons[index])),
    `${kinds[index]} has no zero badge`);

  for (const [index, kind] of kinds.entries()) {
    await fixture(); const before = await read();
    await click('dockButtons', index);
    let snapshot = await read();
    assert.equal(snapshot.overlay, 'acquire', `${kind}: empty tool opens acquisition choices`);
    assert.equal(snapshot.kind, kind);
    assert.deepEqual(snapshot.state, before.state); assert.deepEqual(snapshot.economy, before.economy);
    await click('acquireButtons', 2);
    snapshot = await read(); assert.equal(snapshot.overlay, null);
    assert.deepEqual(snapshot.economy, before.economy, `${kind}: closing does not spend currency`);

    await click('dockButtons', index); await click('acquireButtons', 1);
    snapshot = await read();
    assert.equal(snapshot.overlay, null);
    assert.equal(snapshot.economy.coins, before.economy.coins - TOOL_PRICES[kind]);
    assert.equal(snapshot.economy.inventory[kind], 1, `${kind}: one coin purchase gives exactly one tool`);
    assert.deepEqual(snapshot.state, before.state, `${kind}: acquisition does not apply its effect`);
    assert.deepEqual(JSON.parse(snapshot.saved), snapshot.economy, `${kind}: the purchase persists`);
    await page.mouse.up();
    assert.deepEqual((await read()).economy, snapshot.economy, `${kind}: extra pointer-up cannot debit twice`);
  }

  await fixture(0);
  await click('dockButtons', 0); const poor = await read();
  await click('acquireButtons', 1);
  assert.deepEqual((await read()).economy, poor.economy, 'insufficient coins leave economy unchanged');
  assert.equal((await read()).overlay, 'acquire', 'insufficient coins keep the choices visible');
  await click('acquireButtons', 2);

  for (const result of ['cancelled', 'unavailable', 'error', 'busy', 'completed']) {
    await fixture(100); await installDeferred();
    await click('dockButtons', 0); const before = await read();
    await click('acquireButtons', 0); await page.waitForFunction(() => window.__game.rewardBusy);
    assert.deepEqual(await page.evaluate(() => window.__layoutCalls), ['hint']);
    await click('acquireButtons', 1);
    assert.deepEqual((await read()).economy, before.economy, 'coin purchase is blocked while an ad is pending');
    await settle(result); const after = await read();
    assert.deepEqual(after.state, before.state, `${result}: acquiring a tool does not alter gameplay`);
    if (result === 'completed') {
      assert.equal(after.economy.inventory.hint, 1); assert.equal(after.economy.coins, before.economy.coins);
      assert.equal(after.overlay, null);
      await page.evaluate(() => window.__layoutFinish('completed'));
      assert.deepEqual((await read()).economy, after.economy, 'a repeated callback cannot duplicate the reward');
    } else {
      assert.deepEqual(after.economy, before.economy, `${result}: uncompleted ad grants nothing`);
      assert.equal(after.overlay, 'acquire');
      await page.screenshot({ path: `.local/qa/layout-acquire-${result}.png` });
      await click('acquireButtons', 2);
    }
  }

  // A session reset makes any unresolved acquisition stale, even if the SDK
  // eventually reports a complete video for the old dialog.
  await fixture(); await installDeferred(); await click('dockButtons', 0); await click('acquireButtons', 0);
  await page.waitForFunction(() => window.__game.rewardBusy);
  await page.evaluate(() => window.__game.reset()); const reset = await read();
  await settle('completed');
  assert.deepEqual((await read()).economy, reset.economy, 'an old session cannot receive an acquisition reward');

  // Owning a prop uses stock rather than sending the player through acquisition.
  // Both modes share these same five controls and the same saved inventory.
  for (const mode of ['endless', 'level']) {
    await page.evaluate(({ mode, id }) => {
      const g = window.__game;
      if (mode === 'level') g.startLevel(id);
      else if (g.state.mode === 'level') g.returnToEndless();
      g.overlay = null;
    }, { mode, id: LEVELS[0].id });
    await fixture(100, { hint: 1, rotate: 1, refresh: 1, bomb: 1, bulldozer: 1 });
    let before = await read();
    await click('dockButtons', 0); let snapshot = await read();
    assert.equal(snapshot.economy.inventory.hint, 0, `${mode}: a hint consumes one owned prop`);
    assert.deepEqual(snapshot.state, before.state, `${mode}: a hint never places the candidate`);
    assert.ok(await page.evaluate(() => window.__game.hint));
    assert.equal(snapshot.overlay, null);

    await click('dockButtons', 1); await click('slots', 0);
    assert.equal((await read()).economy.inventory.rotate, 1, `${mode}: rotation preview has no charge`);
    await click('dockButtons', 1);
    assert.deepEqual((await read()).state, before.state, `${mode}: cancelling rotation restores candidate orientation`);
    await click('dockButtons', 1); await click('slots', 0); await drag(0, 4, 2);
    snapshot = await read();
    assert.equal(snapshot.economy.inventory.rotate, 0, `${mode}: a placed rotated piece spends exactly one prop`);
    assert.equal(snapshot.state.moves, before.state.moves + 1);

    await fixture(100, { refresh: 1, bomb: 1, bulldozer: 1 });
    before = await read(); await click('dockButtons', 2); snapshot = await read();
    assert.equal(snapshot.economy.inventory.refresh, 0, `${mode}: refresh consumes one prop`);
    assert.ok(snapshot.state.pieces.every(piece => !piece || piece.cells.length === 1));
    assert.equal(snapshot.state.moves, before.state.moves);

    await fixture(100, { bomb: 1, bulldozer: 1 });
    before = await read(); await click('dockButtons', 3); snapshot = await read();
    assert.equal(snapshot.economy.inventory.bomb, 0, `${mode}: an owned bomb consumes one prop`);
    assert.ok(snapshot.state.board.flat().filter(Boolean).length < before.state.board.flat().filter(Boolean).length);
    assert.equal(snapshot.state.moves, before.state.moves);
    assert.equal(snapshot.overlay, null);

    await fixture(100, { bulldozer: 1 });
    before = await read(); await click('dockButtons', 4); snapshot = await read();
    assert.equal(snapshot.economy.inventory.bulldozer, 0, `${mode}: a bulldozer consumes one prop`);
    assert.ok(snapshot.state.board.slice(5).flat().every(value => value === 0));
    assert.deepEqual(snapshot.state.board.slice(0, 5), before.state.board.slice(0, 5));
    assert.equal(snapshot.state.moves, before.state.moves);
  }
  assert.deepEqual(errors, [], 'the new UI generates no browser errors');
  console.log('Layout smoke passed: five props, compact/native safe areas, settings, inventory badges, coin purchases, ad outcomes, and owned prop effects in both modes.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
