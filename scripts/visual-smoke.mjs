import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { buildAll } from './build.mjs';
import { serve } from './server.mjs';

await buildAll();
await mkdir('.local/qa', { recursive: true });
const server = serve(0);
await once(server, 'listening');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(chrome) ? chrome : undefined), headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-11-16T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-16T12:00:01Z'));
  await page.addInitScript(() => localStorage.setItem('wood-blocks.tutorial-seen.v1', 'true'));
  await page.goto(`http://127.0.0.1:${server.address().port}/?debug=1`);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => window.__game?.assets?.ready);
  await page.clock.runFor(32);
  const read = () => page.evaluate(() => ({ state: window.__game.state, frame: window.__game.frame, particles: window.__game.particles.length, overlay: window.__game.overlay }));
  const fixture = async (board, pieces, combo = 0) => {
    await page.evaluate(({ board, pieces, combo }) => {
      const g = window.__game;
      g.state = { ...g.state, board, pieces, combo, score: 480, moves: 0, lines: 0, tutorial: false, status: 'playing' };
      g.rotationMode = false; g.rotationOriginals = null; g.selected = -1; g.overlay = null;
      g.particles = []; g.clearFx = null; g.placeFx = null; g.gainFx = null; g.returnFx = null; g.flash = [];
      g.pop.at = 0; g.toast.at = 0; g.pointerCancel(); g.invalidate();
    }, { board, pieces, combo });
    await page.clock.runFor(32);
  };
  const drag = async (index, x, y) => {
    const p = await page.evaluate(({ index, x, y }) => {
      const g = window.__game, slot = g.slots[index], piece = g.state.pieces[index], rect = document.querySelector('canvas').getBoundingClientRect();
      const w = Math.max(...piece.cells.map(c => c.x + 1)), h = Math.max(...piece.cells.map(c => c.y + 1));
      const point = (x, y) => ({ x: rect.left + g.offsetX + x * g.scale, y: rect.top + g.offsetY + y * g.scale });
      return { from: point(slot.x + slot.w / 2, slot.y + slot.h / 2), to: point(g.board.x + (x + w / 2) * g.cell, g.board.y + (y + h / 2) * g.cell) };
    }, { index, x, y });
    await page.mouse.move(p.from.x, p.from.y); await page.mouse.down();
    await page.mouse.move(p.to.x, p.to.y, { steps: 6 }); await page.mouse.up();
  };
  // Both former help-button positions are ordinary, non-interactive header space.
  const original = (await read()).state;
  for (const x of [150, 350]) {
    const p = await page.evaluate(x => {
      const g = window.__game, r = document.querySelector('canvas').getBoundingClientRect();
      return { x: r.left + g.offsetX + x * g.scale, y: r.top + (g.safeTop + 13) * g.scale };
    }, x);
    await page.mouse.click(p.x, p.y);
    assert.deepEqual((await read()).state, original);
    assert.equal((await read()).overlay, null);
  }
  const texts = await page.evaluate(() => {
    const g = window.__game, values = [], fill = g.ctx.fillText;
    g.ctx.fillText = function (text, ...args) { values.push(String(text)); return fill.call(this, text, ...args); };
    try { g.draw(); } finally { g.ctx.fillText = fill; }
    return values;
  });
  assert.ok(!texts.includes('?') && !texts.includes('查看玩法'));
  const square = color => ({ id: `square-${color}`, color, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] });
  const empty = () => Array.from({ length: 8 }, () => Array(8).fill(0));
  await fixture(empty(), [square(2), square(1), square(3)]);
  await page.screenshot({ path: '.local/qa/color-ui.png' });
  await drag(0, 1, 1);
  const placed = (await read()).state;
  for (const y of [1, 2]) for (const x of [1, 2]) assert.equal(placed.board[y][x], 3, 'candidate color survives a real placement');
  const board = empty();
  for (let i = 0; i < 8; i++) {
    if (i !== 3) { board[3][i] = i % 5 + 1; board[4][i] = (i + 2) % 5 + 1; }
    if (i !== 3 && i !== 4) board[i][3] = (i + 4) % 5 + 1;
  }
  board[0][6] = 3; board[1][7] = 5; board[6][0] = 2; board[7][6] = 4;
  await fixture(board, [{ id: 'purple-domino', color: 4, cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }] }, square(0), square(4)], 3);
  await drag(0, 3, 3);
  const cleared = (await read()).state;
  assert.equal(cleared.lines, 3);
  assert.equal(cleared.combo, 4);
  assert.ok((await read()).particles > 0 && (await read()).particles <= 240);
  let elapsed = 0;
  for (const at of [40, 100, 300, 650]) {
    await page.clock.runFor(at - elapsed); elapsed = at;
    await page.screenshot({ path: `.local/qa/color-combo-${at}.png` });
  }
  // An active sweep never locks the next gesture or delays the board's rules.
  await drag(1, 0, 0);
  assert.equal((await read()).state.moves, 2);
  assert.ok((await read()).particles <= 240);
  await page.clock.runFor(2600);
  assert.equal((await read()).particles, 0);
  assert.equal((await read()).frame, null, 'visual effects stop scheduling frames after settling');
  assert.equal(await page.evaluate(() => window.__game.clearFx || window.__game.placeFx || window.__game.gainFx), null);
  assert.deepEqual(errors, []);
  console.log('Visual smoke passed: no help hit targets, candidate-to-board color, mixed-color triple clear, combo frames, responsive input during effects, bounded particles and idle rendering.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
