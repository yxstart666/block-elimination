import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { buildAll } from './build.mjs';
import { serve } from './server.mjs';
import { LEVELS } from '../src/core/levels.ts';
import { advanceLevelTime, createLevel, getLevelTimeBonus, getLevelTimeRemaining } from '../src/core/game.ts';

// The npm entry keeps its old name, but the shipped campaign is now unlimited.
assert.equal(LEVELS.length, 30);
for (const definition of LEVELS) {
  assert.equal(definition.timeLimitSeconds, null, `${definition.id}: every campaign level is unlimited`);
  const state = createLevel(definition.id);
  assert.equal(getLevelTimeRemaining(state), Infinity);
  assert.equal(state.level.timeRemainingMs, undefined);
  assert.deepEqual(advanceLevelTime(state, 3_600_000), state);
  assert.equal(getLevelTimeBonus(state), 0);
}

await buildAll(); await mkdir('.local/qa/timer-vfx', { recursive: true });
const server = serve(0); await once(server, 'listening');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const errors = [], samples = [], headers = [], wins = [];
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(chrome) ? chrome : undefined), headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-11-17T08:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-17T08:00:01Z'));
  await page.addInitScript(() => localStorage.setItem('wood-blocks.tutorial-seen.v1', 'true'));
  await page.goto(`http://127.0.0.1:${server.address().port}/?debug=1&unlock=all&test=off`);
  await page.waitForLoadState('networkidle');
  assert.equal(await page.evaluate(() => window.__game.assets.ready), true);
  await page.clock.runFor(32);
  const read = () => page.evaluate(() => {
    const g = window.__game;
    if (!g.disposed) g.draw();
    return { state: g.state, economy: g.economy, overlay: g.overlay, busy: g.rewardBusy,
      pending: g.pendingDestruction && { kind: g.pendingDestruction.kind, at: g.pendingDestruction.at,
        impactMs: g.pendingDestruction.impactMs, area: g.pendingDestruction.effect.area },
      remaining: g.state.level?.timeRemainingMs, timer: g.levelClockTimer, frame: g.frame, uses: g.powerUses };
  });
  const click = async (method, index = 0) => {
    const point = await page.evaluate(({ method, index }) => {
      const g = window.__game, canvas = document.querySelector('canvas').getBoundingClientRect();
      const value = typeof g[method] === 'function' ? g[method]() : g[method], r = Array.isArray(value) ? value[index] : value;
      return { x: canvas.left + g.offsetX + (r.x + r.w / 2) * g.scale,
        y: canvas.top + (r.y + r.h / 2) * g.scale };
    }, { method, index });
    await page.mouse.click(point.x, point.y);
  };
  const capture = async name => {
    await page.evaluate(() => window.__game.draw());
    await page.screenshot({ path: `.local/qa/timer-vfx/${name}.png` });
    samples.push({ name, ...(await read()) });
  };
  const noClock = snapshot => {
    assert.ok(snapshot.timer == null, 'campaign actions never create a countdown timer');
    assert.equal(snapshot.remaining, undefined, 'campaign state has no remaining-time budget');
  };
  const start = async definition => {
    await page.evaluate(id => { const g = window.__game; g.overlay = null; g.startLevel(id); }, definition.id);
    if ((await read()).overlay === 'lesson') await click('lessonButton');
    await page.clock.runFor(32); noClock(await read());
  };
  const measure = async (modal = false) => page.evaluate(modal => {
    const g = window.__game, labels = [], sprites = [], original = g.ctx.fillText, draw = g.assets.draw, drawModal = g.drawModal;
    let recording = !modal;
    g.ctx.fillText = function (value, x, y, ...rest) {
      if (recording) { const text = String(value), m = this.measureText(text); labels.push({ text, x, y,
        left: x - m.actualBoundingBoxLeft, right: x + m.actualBoundingBoxRight,
        top: y - m.actualBoundingBoxAscent, bottom: y + m.actualBoundingBoxDescent }); }
      return original.call(this, value, x, y, ...rest);
    };
    g.assets.draw = function (ctx, id, x, y, w, h, ...rest) {
      if (recording) sprites.push({ id, left: x, right: x + w, top: y, bottom: y + h });
      return draw.call(this, ctx, id, x, y, w, h, ...rest);
    };
    if (modal) g.drawModal = function () { recording = true; try { return drawModal.call(this); } finally { recording = false; } };
    try { g.draw(); } finally { g.ctx.fillText = original; g.assets.draw = draw; g.drawModal = drawModal; }
    return { labels, sprites, board: g.board, scale: g.scale, modal: g.modalRect(), buttons: g.modalButtons(),
      safeTop: g.safeTop, safeBottom: g.logicalH - g.safeBottom };
  }, modal);
  const definitions = [1, 2, 3].map(count => LEVELS.find(level => level.goals.length === count &&
    (count !== 3 || level.goals.some(goal => goal.kind === 'lines'))));
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 414, height: 896 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(({ width, height }) => window.__game.resize(width, height, 2, width === 320 ? 44 : 12,
      width === 320 ? 34 : 12, width === 320 ? 60 : undefined), viewport);
    for (const definition of definitions) {
      assert.ok(definition); await start(definition);
      const result = await measure(), count = definition.goals.length;
      const labels = result.labels.filter(label => label.y < result.board.y), tasks = labels.filter(label => !/^第\s*\d+\s*关$/.test(label.text));
      assert.equal(tasks.length, count * 2, 'the task strip contains only actual goals, without a timing placeholder');
      assert.ok(!tasks.some(label => /倒计时|自由规划|不限时|时间|\d+:\d\d/.test(label.text)));
      const captions = tasks.filter(label => !/^\d+\/\d+$/.test(label.text)).sort((a, b) => a.x - b.x);
      const progress = tasks.filter(label => /^\d+\/\d+$/.test(label.text)).sort((a, b) => a.left - b.left);
      const icons = result.sprites.filter(sprite => sprite.top < result.board.y && /^(tile_|goal_star_outline|goal_lines)/.test(sprite.id)).sort((a, b) => a.left - b.left);
      assert.equal(captions.length, count); assert.equal(progress.length, count); assert.equal(icons.length, count);
      for (let i = 0; i < count; i++) {
        assert.ok(Math.abs(captions[i].x - (21 + 348 * (i + .5) / count)) < .01, 'goal groups spread evenly over the full strip');
        assert.ok(progress[i].left - icons[i].right >= 3 && progress[i].left - icons[i].right <= 6, 'each icon keeps a small clear gap before its progress');
      }
      const boxes = [...labels, ...icons], overlap = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) + .1 &&
        Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + .1;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++)
        assert.ok(!overlap(boxes[i], boxes[j]), 'goal titles, icons and progress never overlap');
      assert.ok(boxes.every(box => box.left >= 0 && box.right <= 390 && box.bottom < result.board.y), 'goals fit above the unchanged board');
      const name = `unlimited-${count}-goals-${viewport.width}`;
      await page.screenshot({ path: `.local/qa/timer-vfx/${name}.png`, clip: { x: 0, y: 0,
        width: viewport.width, height: Math.ceil((result.board.y + 8) * result.scale) } });
      headers.push({ name, count, viewport, ...result });
      if (viewport.width === 320 && count > 1) {
        await page.evaluate(score => {
          const g = window.__game;
          for (const goal of g.levelDefinition.goals) {
            if (goal.kind === 'lines') g.state.lines = goal.target;
            else if (goal.kind === 'gems') g.state.level.collectedGems = goal.target;
            else if (goal.kind === 'color') g.state.level.clearedColors[goal.color] = goal.target;
          }
          g.state = { ...g.state, score, status: 'won' }; g.finishCampaignVictory();
          g.resultAt = Date.now() - 2000; g.particles = []; g.toast.at = 0;
        }, definition.starScores[2]);
        const win = await measure(true);
        assert.ok(win.labels.every(label => !/时间奖励|倒计时|剩余.*秒/.test(label.text)), 'settlement has no time bonus text');
        assert.ok(win.labels.every(label => label.left >= 0 && label.right <= 390 && label.top >= win.modal.y && label.bottom <= win.modal.y + win.modal.h), 'multi-goal settlement text is not clipped');
        assert.ok(win.buttons.every(r => r.y >= win.safeTop && r.y + r.h <= win.safeBottom), 'settlement actions remain inside native safe areas');
        await page.screenshot({ path: `.local/qa/timer-vfx/unlimited-win-${count}-goals-320.png` }); wins.push({ count, ...win });
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__game.resize(390, 844, 2, 12, 12));
  await start(LEVELS[0]);
  let before = await read(); noClock(before); await page.clock.runFor(3_600_000);
  assert.deepEqual((await read()).state, before.state, 'an hour of planning cannot fail the level or alter score');
  const candidate = await page.evaluate(() => {
    const g = window.__game, r = g.slots[0], b = document.querySelector('canvas').getBoundingClientRect();
    return { x: b.left + g.offsetX + (r.x + r.w / 2) * g.scale, y: b.top + (r.y + r.h / 2) * g.scale };
  });
  await page.mouse.move(candidate.x, candidate.y); await page.mouse.down();
  await page.clock.runFor(3_600_000); noClock(await read());
  assert.deepEqual((await read()).state, before.state, 'operating a candidate does not create a hidden countdown');
  await page.mouse.move(12, 20); await page.mouse.up(); await page.clock.runFor(32);
  const drag = async move => {
    const points = await page.evaluate(move => {
      const g = window.__game, r = g.slots[move.index], p = g.state.pieces[move.index], b = document.querySelector('canvas').getBoundingClientRect();
      const w = Math.max(...p.cells.map(c => c.x + 1)), h = Math.max(...p.cells.map(c => c.y + 1));
      return { start: { x: b.left + g.offsetX + (r.x + r.w / 2) * g.scale, y: b.top + (r.y + r.h / 2) * g.scale },
        end: { x: b.left + g.offsetX + (g.board.x + (move.x + w / 2) * g.cell) * g.scale, y: b.top + (g.board.y + (move.y + h / 2) * g.cell) * g.scale } };
    }, move);
    await page.mouse.move(points.start.x, points.start.y); await page.mouse.down(); await page.mouse.move(points.end.x, points.end.y, { steps: 2 }); await page.mouse.up();
  };
  let expectedScore = 0, combo = 0, after;
  for (const move of LEVELS[0].solution) {
    const state = (await read()).state, piece = state.pieces[move.index], board = state.board.map(row => row.slice());
    for (const cell of piece.cells) board[move.y + cell.y][move.x + cell.x] = (piece.color ?? 0) + 1;
    const lines = board.filter(row => row.every(Boolean)).length + Array.from({ length: 8 }, (_, x) => x).filter(x => board.every(row => row[x])).length;
    combo = lines ? combo + 1 : 0; expectedScore += 10 + lines * 20 + Math.max(0, combo - 1) * 10;
    await drag(move); after = await read(); noClock(after);
    assert.equal(after.state.score, expectedScore, 'winning score includes only real placement, line and combo points');
  }
  assert.equal(after.state.status, 'won'); assert.equal(after.state.level.timeBonus ?? 0, 0, 'no time bonus is awarded');
  await page.clock.runFor(1200); const won = await measure(true);
  assert.ok(!won.labels.some(label => /倒计时|时间奖励|剩余.*秒/.test(label.text))); await capture('unlimited-real-win');
  await click('modalButtons', 1); noClock(await read());
  const fixture = async () => page.evaluate(() => {
    const g = window.__game; g.stopLevelClock?.(); g.overlay = null; g.pendingDestruction = null; g.rewardBusy = false;
    const board = Array.from({ length: 8 }, () => Array(8).fill(0));
    for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) board[y][x] = (x + y) % 5 + 1;
    const gems = [];
    for (let x = 0; x < 8; x++) { const y = 5 + x % 3; board[y][x] = x % 5 + 1; gems.push({ x, y }); }
    g.state = { ...g.state, board, tutorial: false, status: 'playing', score: 0, lines: 0, combo: 0, moves: 0,
      pieces: [{ id: 'vfx-square', color: 0, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null, null],
      level: { ...g.state.level, gems, collectedGems: 0, clearedColors: Array(5).fill(0) } };
    g.economy.inventory.bomb = 1; g.economy.inventory.bulldozer = 1;
    g.particles = []; g.clearFx = null; g.placeFx = null; g.destructionFx = null; g.resultAt = 0; g.draw();
  });
  await fixture(); before = await read(); await click('dockButtons', 3); after = await read();
  assert.equal(after.pending.kind, 'bomb'); assert.equal(after.busy, true);
  assert.deepEqual(after.state.board, before.state.board, 'bomb launch does not clear cells');
  assert.equal(after.economy.inventory.bomb, 1, 'stock is committed at impact');
  await capture('bomb-launch'); await page.clock.runFor(200);
  const flight = await page.evaluate(() => {
    const g = window.__game, points = [], original = g.icon;
    g.icon = function (id, cx, cy, w, h) {
      if (id === 'icon_bomb' && cx === 0 && cy === 0) {
        const m = this.ctx.getTransform(); points.push({ x: (m.e / this.ratio - this.offsetX) / this.scale, y: m.f / this.ratio / this.scale, w });
      }
      return original.call(this, id, cx, cy, w, h);
    };
    try { g.draw(); } finally { g.icon = original; }
    const r = g.dockButtons()[3], cells = g.pendingDestruction.effect.area;
    return { point: points[0], start: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
      end: { x: g.board.x + cells.reduce((n, c) => n + c.x + .5, 0) / cells.length * g.cell,
        y: g.board.y + cells.reduce((n, c) => n + c.y + .5, 0) / cells.length * g.cell },
      t: (Date.now() - g.pendingDestruction.at) / g.pendingDestruction.impactMs };
  });
  assert.ok(flight.point, 'the flying bomb is rendered as a separate sprite');
  const straightY = flight.start.y + (flight.end.y - flight.start.y) * flight.t;
  assert.ok(flight.point.y < straightY - 20, 'bomb flight follows an upward arc instead of a straight slide');
  assert.deepEqual((await read()).state.board, before.state.board);
  noClock(await read());
  await capture('bomb-midflight');
  await page.evaluate(() => { const g = window.__game; g.state = { ...g.state }; });
  await page.clock.runFor(300); after = await read();
  assert.equal(after.pending, null); assert.equal(after.busy, false); assert.equal(after.economy.inventory.bomb, 0);
  assert.ok(after.state.board.flat().filter(Boolean).length < before.state.board.flat().filter(Boolean).length);
  for (const field of ['score', 'lines', 'moves', 'combo', 'rng', 'batch']) assert.equal(after.state[field], before.state[field]);
  const area = new Set(samples.find(item => item.name === 'bomb-launch').pending.area.map(c => `${c.x},${c.y}`));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (before.state.board[y][x] !== after.state.board[y][x]) assert.ok(area.has(`${x},${y}`));
  await capture('bomb-impact'); await page.clock.runFor(1000); assert.equal((await read()).economy.inventory.bomb, 0);
  await fixture(); before = await read(); await click('dockButtons', 4);
  const swept = [];
  for (const at of [150, 300, 450]) {
    await page.clock.runFor(at - (swept.at(-1)?.at ?? 0)); after = await read();
    const column = await page.evaluate(() => window.__game.pendingDestruction?.column);
    assert.ok(Number.isInteger(column) && column >= 0 && column < 7, 'the moving plow has reached some columns while later columns remain');
    if (swept.length) assert.ok(column > swept.at(-1).column, 'the cleared front advances across the board');
    for (let y = 5; y < 8; y++) for (let x = 0; x < 8; x++)
      assert.equal(after.state.board[y][x], x <= column ? 0 : before.state.board[y][x], 'only columns already passed by the plow are cleared');
    assert.equal(after.economy.inventory.bulldozer, 0, 'the first effective contact charges once');
    assert.equal(after.state.level.collectedGems, column + 1, 'stars advance once for each newly swept column');
    assert.equal(after.state.level.clearedColors.reduce((a, b) => a + b, 0), column + 1, 'color collection accumulates without double counting earlier columns');
    assert.deepEqual(after.state.board.slice(0, 5), before.state.board.slice(0, 5));
    swept.push({ at, column, stars: after.state.level.collectedGems }); await capture(`bulldozer-${at}`);
  }
  const bulldozer = await page.evaluate(() => {
    const g = window.__game, widths = [], original = g.icon;
    g.icon = function (id, cx, cy, w, h) { if (id === 'icon_bulldozer' && w > this.cell * 2) widths.push(w); return original.call(this, id, cx, cy, w, h); };
    try { g.draw(); } finally { g.icon = original; }
    return { widths, cell: g.cell };
  });
  assert.ok(bulldozer.widths.some(w => Math.abs(w - bulldozer.cell * 3) < .01), 'bulldozer model spans exactly three cell columns');
  await page.evaluate(() => { const g = window.__game; g.state = { ...g.state }; });
  await page.clock.runFor(400); after = await read();
  assert.equal(after.pending, null); assert.equal(after.busy, false);
  assert.equal(after.economy.inventory.bulldozer, 0); assert.ok(after.state.board.slice(5).flat().every(value => value === 0));
  assert.equal(after.state.level.collectedGems, 8); assert.equal(after.state.level.clearedColors.reduce((a, b) => a + b, 0), 8);
  assert.deepEqual(after.state.board.slice(0, 5), before.state.board.slice(0, 5));
  await fixture(); await click('dockButtons', 3); assert.ok((await read()).pending);
  await page.evaluate(() => window.__game.reset()); before = await read();
  assert.equal(before.pending, null); noClock(before); assert.equal(before.economy.inventory.bomb, 1);
  await page.clock.runFor(1000); after = await read(); assert.deepEqual(after.state.board, before.state.board);
  assert.equal(after.economy.inventory.bomb, 1, 'reset cancels uncommitted stock and old blast');
  await fixture(); await click('dockButtons', 4); await page.clock.runFor(150);
  assert.equal((await read()).economy.inventory.bulldozer, 0);
  await page.evaluate(() => window.__game.reset()); before = await read(); await page.clock.runFor(1000); after = await read();
  assert.deepEqual(after.state.board, before.state.board); assert.equal(after.pending, null);
  assert.equal(after.economy.inventory.bulldozer, 0, 'reset preserves the already consumed plow but cancels its later columns');
  await fixture(); await click('dockButtons', 3); await page.evaluate(() => window.__game.destroy()); before = await read();
  await page.clock.runFor(2000); assert.deepEqual(await read(), before); assert.ok(before.timer == null); assert.equal(before.frame, null);
  assert.deepEqual(errors, []);
  await writeFile('.local/qa/timer-vfx/results.json', JSON.stringify({ protocol: 'unlimited-campaign-ui-v1', headers, wins, samples, flight, bulldozer, swept, errors }, null, 2) + '\n');
  console.log('Unlimited/VFX UI smoke passed: all thirty levels untimed, no clock before/after real input, evenly spread one/two/three goals at 320/390/414, unclipped native settlements, no time score bonus, bomb arc/impact, progressive three-column bulldozer and reset/destroy guards.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
