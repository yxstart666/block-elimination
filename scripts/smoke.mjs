import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { serve } from './server.mjs';
import { buildAll } from './build.mjs';
import { findHint, hasPlacement } from '../src/core/game.ts';

await buildAll();
await mkdir('.local/qa', { recursive: true });
const server = serve(0);
await once(server, 'listening');
const port = server.address().port;
const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(localChrome) ? localChrome : undefined);
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  // Fix only the session seed so this real-input run stays reproducible;
  // visual particles retain the browser's normal randomness.
  await page.addInitScript(() => {
    const random = Math.random;
    Math.random = () => { Math.random = random; return 1 / 0x100000000; };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/?debug=1`);
  await page.waitForFunction(() => window.__game?.assets?.ready);
  await page.screenshot({ path: '.local/qa/first-level.png' });

  const read = () => page.evaluate(() => {
    const g = window.__game;
    const rect = document.querySelector('canvas').getBoundingClientRect();
    const convert = (x, y) => ({ x: rect.left + g.offsetX + x * g.scale, y: rect.top + g.offsetY + y * g.scale });
    return {
      state: g.state, ghost: g.ghost, selected: g.selected, overlay: g.overlay, frame: g.frame, best: g.bestScore,
      board: g.board, slots: g.slots,
      modal: g.modalButtons().map(r => convert(r.x + r.w / 2, r.y + r.h / 2)),
    };
  });
  const readLayout = targetPage => targetPage.evaluate(() => {
    const g = window.__game;
    const labels = [], original = g.ctx.fillText;
    g.ctx.fillText = function (value, x, y, ...rest) { labels.push({ text: String(value), x, y }); return original.call(this, value, x, y, ...rest); };
    try { g.draw(); } finally { g.ctx.fillText = original; }
    const title = labels.find(label => /^(初次体验|无限挑战|第\s*\d+\s*关)$/.test(label.text));
    return {
      top: g.safeTop * g.scale, center: title.y * g.scale,
      count: g.dockButtons().length, boardBottom: g.board.y + g.board.h,
      powersTop: Math.min(...g.dockButtons().map(r => r.y)), powersBottom: Math.max(...g.dockButtons().map(r => r.y + r.h)),
      trayTop: Math.min(...g.slots.map(r => r.y)), trayBottom: Math.max(...g.slots.map(r => r.y + r.h)),
      safeBoundary: g.logicalH - g.safeBottom,
    };
  });
  const assertLayout = (layout, label) => {
    assert.equal(layout.count, 5);
    assert.ok(layout.boardBottom < layout.trayTop, `candidates sit below the board: ${label}`);
    assert.ok(layout.trayTop < layout.trayBottom && layout.trayBottom < layout.powersTop, `five tools sit below the candidates: ${label}`);
    assert.ok(layout.powersTop < layout.powersBottom && layout.powersBottom <= layout.safeBoundary + .01, `tools stay above the safe area: ${label}`);
  };
  const click = p => page.mouse.click(p.x, p.y);
  let snapshot = await read();
  assert.equal(snapshot.state.mode, 'endless');
  assert.equal(snapshot.state.seed, 1);
  assert.equal(snapshot.state.pieces.length, 3);
  // Invalid drag must preserve score and supply.
  const start = await page.evaluate(() => {
    const g = window.__game, r = g.slots[1], c = document.querySelector('canvas').getBoundingClientRect();
    return { x: c.left + g.offsetX + (r.x + r.w / 2) * g.scale, y: c.top + g.offsetY + (r.y + r.h / 2) * g.scale };
  });
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(12, 20, { steps: 8 }); await page.mouse.up();
  assert.equal((await read()).state.moves, 0);
  assert.equal((await read()).state.tutorial, true);
  // Both distractor choices are real, draggable blocks and cannot fit.
  for (const index of [0, 2]) {
    const points = await page.evaluate(index => {
      const g = window.__game, piece = g.state.pieces[index], slot = g.slots[index], r = document.querySelector('canvas').getBoundingClientRect();
      const width = Math.max(...piece.cells.map(c => c.x + 1)), height = Math.max(...piece.cells.map(c => c.y + 1));
      const convert = (x, y) => ({ x: r.left + g.offsetX + x * g.scale, y: r.top + g.offsetY + y * g.scale });
      return { start: convert(slot.x + slot.w / 2, slot.y + slot.h / 2), end: convert(g.board.x + (3 + width / 2) * g.cell, g.board.y + (3 + height / 2) * g.cell) };
    }, index);
    await page.mouse.move(points.start.x, points.start.y); await page.mouse.down(); await page.mouse.move(points.end.x, points.end.y, { steps: 8 }); await page.mouse.up();
    const result = await read();
    assert.equal(result.state.moves, 0);
    assert.equal(result.state.score, 0);
    assert.equal(result.state.pieces.filter(Boolean).length, 3);
  }

  const dragPiece = async (capture = false, explicitMove = null) => {
    // The test runner chooses a legal move without spending the player's hint inventory.
    const state = (await read()).state;
    const move = explicitMove || findHint(state);
    assert.ok(move, 'a playing fixture must have a legal move');
    if (state.tutorial) {
      const legal = [];
      assert.equal(state.pieces.filter(Boolean).length, 3);
      state.pieces.forEach((piece, index) => {
        if (!piece) return;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          if (piece.cells.every(cell => x + cell.x < 8 && y + cell.y < 8 && state.board[y + cell.y][x + cell.x] === 0)) legal.push({ index, x, y });
        }
      });
      assert.deepEqual(legal, [{ index: 1, x: 3, y: 3 }], 'the square is the sole physical opening move');
      assert.deepEqual(move, legal[0]);
    }
    const points = await page.evaluate(h => {
      const g = window.__game;
      const p = g.state.pieces[h.index];
      const width = Math.max(...p.cells.map(c => c.x + 1)), height = Math.max(...p.cells.map(c => c.y + 1));
      const slot = g.slots[h.index], rect = document.querySelector('canvas').getBoundingClientRect();
      const convert = (x, y) => ({ x: rect.left + g.offsetX + x * g.scale, y: rect.top + g.offsetY + y * g.scale });
      return { start: convert(slot.x + slot.w / 2, slot.y + slot.h / 2), end: convert(g.board.x + (h.x + width / 2) * g.cell, g.board.y + (h.y + height / 2) * g.cell) };
    }, move);
    await page.mouse.move(points.start.x, points.start.y); await page.mouse.down(); await page.mouse.move(points.end.x, points.end.y, { steps: 8 });
    if (capture) await page.screenshot({ path: '.local/qa/drag-preview.png' });
    await page.mouse.up();
  };
  // Complete the first step using only the actual drag interaction.
  await dragPiece(true);
  snapshot = await read();
  assert.equal(snapshot.state.tutorial, false);
  assert.equal(snapshot.state.score, 50);
  assert.equal(snapshot.state.lines, 2);
  assert.equal(snapshot.state.pieces.filter(Boolean).length, 3);
  await page.waitForTimeout(80);
  await page.screenshot({ path: '.local/qa/tutorial-cleared.png' });
  await page.screenshot({ path: '.local/qa/clean-tools-layout.png' });
  // Follow real input past the old target without requiring an easier game to
  // end within an arbitrary number of placements.
  let sawLongRun = false;
  for (let step = 1; step < 60; step++) {
    snapshot = await read();
    if (snapshot.state.status !== 'playing') break;
    if (snapshot.state.batch === 1 && snapshot.state.pieces.every(Boolean)) await page.screenshot({ path: '.local/qa/second-batch.png' });
    await dragPiece();
    const result = await read();
    assert.equal(result.state.moves, step + 1, `drag ${step + 1} places the runner-selected piece`);
    assert.equal(result.state.pieces.length, 3);
    assert.notEqual(result.state.status, 'won', 'the endless opening never turns into a target-score win');
    if (result.state.moves === 30) {
      assert.equal(result.state.status, 'playing');
      assert.ok(result.state.score > 210);
      assert.equal(await page.evaluate(() => window.__game.overlay), null);
      await page.screenshot({ path: '.local/qa/endless-midgame.png' });
      sawLongRun = true;
    }
  }
  snapshot = await read();
  assert.ok(sawLongRun, 'the real-input run survives at least thirty placements');
  const playedMoves = snapshot.state.moves;
  const neededLossFixture = snapshot.state.status === 'playing';
  if (neededLossFixture) {
    // Exercise the loss dialog through one genuine drop in a known no-fit
    // fixture. This is separate from measuring the adaptive supply run.
    await page.evaluate(() => {
      const g = window.__game;
      g.state = { ...g.state, board: Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2)),
        pieces: [{ id: 'last-drop', color: 3, cells: [{ x: 0, y: 0 }] },
          { id: 'no-fit-square', color: 2, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null],
        status: 'playing', tutorial: false };
      g.rotationMode = false; g.rotationOriginals = null; g.selected = -1; g.ghost = null; g.drag = null;
      g.clearFx = null; g.placeFx = null; g.gainFx = null; g.particles = []; g.invalidate();
    });
    await dragPiece(false, { index: 0, x: 0, y: 0 });
    snapshot = await read();
  }
  assert.equal(snapshot.state.status, 'lost');
  assert.ok(snapshot.state.pieces.every(piece => !piece || !hasPlacement(snapshot.state.board, piece)), 'the run ends only when every remaining candidate has no landing');
  const finalScore = snapshot.state.score;
  assert.ok(snapshot.best >= finalScore);
  await page.waitForTimeout(800);
  await page.screenshot({ path: '.local/qa/endless-finished.png' });
  await click((await read()).modal[1]); // The loss dialog offers the only restart.
  assert.equal((await read()).state.moves, 0);
  assert.equal((await read()).state.tutorial, false, 'restarting never repeats the first-entry tutorial');
  assert.ok((await read()).state.board.flat().every(cell => cell === 0));
  await page.screenshot({ path: '.local/qa/empty-restart.png' });
  assert.ok((await read()).best >= finalScore, 'restarting preserves the best score');
  await page.reload();
  await page.waitForFunction(() => window.__game?.assets?.ready);
  assert.equal((await read()).state.moves, 0);
  assert.equal((await read()).state.tutorial, false, 'reopening remembers that the tutorial was already seen');
  assert.ok((await read()).state.board.flat().every(cell => cell === 0));
  assert.ok((await read()).best >= finalScore, 'reloading restores the saved best score');

  // Keyboard placement uses the same real rules; unrelated keys have no shortcuts.
  await page.locator('canvas').focus(); await page.keyboard.press('1'); await page.keyboard.press('Enter');
  assert.equal((await read()).state.moves, 1);
  assert.equal((await read()).state.tutorial, false);
  const keyboardSnapshot = await read();
  for (const key of ['h', 'z', 'r']) {
    await page.keyboard.press(key);
    const after = await read();
    for (const field of ['state', 'ghost', 'selected', 'overlay']) assert.deepEqual(after[field], keyboardSnapshot[field], `unassigned ${key} shortcut cannot change ${field}`);
  }
  assert.equal((await read()).state.status, 'playing');

  for (const viewport of [{ width: 375, height: 667 }, { width: 320, height: 568 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(80);
    assertLayout(await readLayout(page), `${viewport.width}×${viewport.height}`);
    await page.screenshot({ path: `.local/qa/layout-${viewport.width}.png` });
  }
  // Simulate native metrics without the browser adapter replacing them.
  const safeContext = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2 });
  const safePage = await safeContext.newPage();
  safePage.on('pageerror', error => errors.push(`safe-area: ${error.message}`));
  await safePage.addInitScript(() => { window.ResizeObserver = class { observe() {} disconnect() {} }; });
  await safePage.goto(`http://127.0.0.1:${port}/?debug=1`);
  await safePage.waitForFunction(() => window.__game?.assets?.ready);
  await safePage.evaluate(() => window.__game.resize(320, 568, 2, 84, 34));
  const safeMetrics = await readLayout(safePage);
  assert.ok(safeMetrics.top >= 84);
  assertLayout(safeMetrics, '320×568 with native notch and bottom inset');
  await safePage.screenshot({ path: '.local/qa/wechat-safe-area.png' });
  // Native header placement uses actual capsule center, separately from notch.
  await safePage.evaluate(() => window.__game.resize(320, 568, 2, 44, 34, 60));
  await safePage.evaluate(() => {
    const capsule = document.createElement('div');
    capsule.style.cssText = 'position:absolute;right:12px;top:44px;width:78px;height:32px;border:1px solid #49372944;border-radius:18px;background:#ffffff55;text-align:center;line-height:30px;color:#493729;font:18px/30px system-ui';
    capsule.textContent = '···  │  ⊙'; document.querySelector('main').append(capsule);
  });
  const header = await readLayout(safePage);
  assert.ok(header.top >= 44);
  assert.ok(Math.abs(header.center - 60) < .01, 'title aligns with WeChat capsule center');
  assertLayout(header, 'native capsule-aligned header');
  await safePage.screenshot({ path: '.local/qa/wechat-header-alignment.png' });
  await safeContext.close();

  // Returning from the browser back-forward cache must keep the game playable.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  assert.equal(await page.evaluate(() => window.__game.paused && !window.__game.disposed), true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  assert.equal(await page.evaluate(() => window.__game.paused), false);

  // A real touch gesture includes the finger-occlusion offset.
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const touchPage = await touchContext.newPage();
  touchPage.on('pageerror', error => errors.push(`touch: ${error.message}`));
  await touchPage.goto(`http://127.0.0.1:${port}/?debug=1`);
  await touchPage.waitForFunction(() => window.__game?.assets?.ready);
  const touchPoints = await touchPage.evaluate(() => {
    const g = window.__game, h = { index: 1, x: 3, y: 3 }, slot = g.slots[h.index], p = g.state.pieces[h.index];
    const rect = document.querySelector('canvas').getBoundingClientRect();
    const w = Math.max(...p.cells.map(c => c.x + 1)), height = Math.max(...p.cells.map(c => c.y + 1));
    const convert = (x, y) => ({ x: rect.left + g.offsetX + x * g.scale, y: rect.top + g.offsetY + y * g.scale });
    return { start: convert(slot.x + slot.w / 2, slot.y + slot.h / 2), end: convert(g.board.x + (h.x + w / 2) * g.cell, g.board.y + (h.y + height / 2) * g.cell + 56) };
  });
  const cdp = await touchContext.newCDPSession(touchPage);
  await touchPage.evaluate(() => {
    window.__pointerLog = [];
    for (const name of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) document.querySelector('canvas').addEventListener(name, e => window.__pointerLog.push([name, e.pointerId, e.clientX, e.clientY]));
  });
  const firstFinger = { ...touchPoints.start, id: 1 };
  const secondFinger = { x: 350, y: 600, id: 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [firstFinger] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [firstFinger, secondFinger] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [firstFinger, { ...secondFinger, x: 330, y: 450 }] });
  assert.equal(await touchPage.evaluate(() => window.__game.drag.moved), false, 'second finger does not move the first drag');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ ...secondFinger, x: 330, y: 450 }] });
  assert.equal(await touchPage.evaluate(() => Boolean(window.__game.drag)), true, 'lifting second finger does not submit first drag: ' + JSON.stringify(await touchPage.evaluate(() => window.__pointerLog)));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touchPoints.end, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await touchPage.evaluate(() => window.__game.state.moves), 1);
  assert.equal(await touchPage.evaluate(() => window.__game.state.lines), 2);
  assert.equal(await touchPage.evaluate(() => window.__game.state.tutorial), false);
  assert.deepEqual(errors, []);
  // The main page is already in an ordinary session, without teaching gestures.
  await page.waitForTimeout(2400);
  assert.equal((await read()).frame, null, 'idle screen stops requesting animation frames');
  // A controlled board fixture isolates dynamic usability; all player actions
  // below are actual pointer gestures rather than direct state mutations.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    const g = window.__game;
    const board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2));
    board[1][0] = 0; board[2] = Array(8).fill(1); board[2][7] = 0;
    g.state = { ...g.state, tutorial: false, status: 'playing', board, pieces: [
      { id: 'line-finisher', cells: [{ x: 0, y: 0 }] },
      { id: 'square-after-clear', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null,
    ] };
    g.selected = -1; g.ghost = null; g.drag = null; g.overlay = null; g.clearFx = null; g.returnFx = null; g.invalidate();
  });
  assert.equal(await page.evaluate(() => window.__game.blocked(1)), true);
  const fixture = (await read()).state;
  const gray = await page.evaluate(() => {
    const g = window.__game, slot = g.slots[1], r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left + g.offsetX + (slot.x + slot.w / 2) * g.scale, y: r.top + g.offsetY + (slot.y + slot.h / 2) * g.scale };
  });
  await page.mouse.move(gray.x, gray.y); await page.mouse.down();
  assert.equal(await page.evaluate(() => window.__game.drag), null, 'a gray candidate does not start dragging');
  await page.mouse.move(gray.x, gray.y - 100); await page.mouse.up();
  assert.deepEqual((await read()).state, fixture, 'trying a gray candidate consumes nothing');
  await page.screenshot({ path: '.local/qa/blocked-candidate.png' });
  // A playable block released outside the board visibly returns to the tray.
  const returning = await page.evaluate(() => {
    const g = window.__game, slot = g.slots[0], r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left + g.offsetX + (slot.x + slot.w / 2) * g.scale, y: r.top + g.offsetY + (slot.y + slot.h / 2) * g.scale };
  });
  await page.mouse.move(returning.x, returning.y); await page.mouse.down(); await page.mouse.move(12, 20, { steps: 5 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => Boolean(window.__game.returnFx)), true);
  assert.deepEqual((await read()).state, fixture);
  await page.waitForTimeout(60);
  await page.screenshot({ path: '.local/qa/invalid-drop-return.png' });
  await page.waitForTimeout(350);
  await dragPiece(false, { index: 0, x: 7, y: 2 });
  assert.equal(await page.evaluate(() => window.__game.blocked(1)), false, 'clearing space restores the same gray candidate');
  assert.deepEqual(await page.evaluate(() => window.__game.clearFx.rows), [2]);
  await page.waitForTimeout(70);
  await page.screenshot({ path: '.local/qa/unblocked-after-clear.png' });
  await page.mouse.move(gray.x, gray.y); await page.mouse.down();
  assert.equal(await page.evaluate(() => window.__game.drag?.index), 1, 'the restored candidate can be picked up');
  await page.mouse.up();
  assert.deepEqual(errors, []);
  console.log(`UI smoke passed: ${playedMoves}-step real-input run, score beyond 210 without a win, ${neededLossFixture ? 'separate loss fixture' : 'natural loss'}, saved best score, dynamic gray candidates, return animation, touch and responsive layout.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
