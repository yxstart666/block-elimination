import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { buildAll } from './build.mjs';
import { serve } from './server.mjs';
import { LEVELS } from '../src/core/levels.ts';
import { COLOR_NAMES } from '../src/core/colors.ts';

await buildAll();
await mkdir('.local/qa', { recursive: true });
const server = serve(0);
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/?debug=1`;
const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(localChrome) ? localChrome : undefined);
const lessonIds = [...LEVELS.filter(level => level.learning).map(level => level.id), 'level-07:colors-v1', 'level-10:colors-stars-v1'];
const errors = [];
const startedAt = Date.now();
let browser;
function driver(page) {
  const read = () => page.evaluate(() => {
    const g = window.__game;
    const state = structuredClone(g.state);
    // A stale saved clock must not affect board or progress comparisons.
    if (state.level) delete state.level.timeRemainingMs;
    let savedBest, savedCampaign;
    try { savedBest = localStorage.getItem('wood-blocks.best.v1'); savedCampaign = localStorage.getItem('wood-blocks.campaign.v1'); } catch {}
    return { state, remainingMs: g.state.level?.timeRemainingMs, clockTimer: g.levelClockTimer,
      overlay: g.overlay, page: g.levelPage, progress: g.campaignProgress, economy: g.economy,
      best: g.bestScore, uses: g.powerUses, savedBest, savedCampaign };
  });
  const click = async (collection, index = 0) => {
    const point = await page.evaluate(({ collection, index }) => {
      const g = window.__game, canvas = document.querySelector('canvas').getBoundingClientRect();
      const result = g[collection](), r = Array.isArray(result) ? result[index] : result;
      if (!r) throw new Error(`Missing ${collection} ${index}`);
      return { x: canvas.left + g.offsetX + (r.x + r.w / 2) * g.scale,
        y: canvas.top + g.offsetY + (r.y + r.h / 2) * g.scale,
        canvas: { left: canvas.left, top: canvas.top, width: canvas.width, height: canvas.height },
        game: { width: g.width, height: g.height, scale: g.scale, logicalH: g.logicalH }, rect: r };
    }, { collection, index });
    const viewport = page.viewportSize();
    assert.ok(point.x >= 0 && point.x <= viewport.width && point.y >= 0 && point.y <= viewport.height,
      `${collection} ${index} is inside the actual viewport: ${JSON.stringify({ point, viewport })}`);
    await page.mouse.click(point.x, point.y);
  };
  const openMap = async () => {
    const snapshot = await read();
    if (snapshot.overlay !== 'levels') {
      if (snapshot.state.status !== 'playing') await click('modalButtons', 2);
      else { await click('settingsButton'); await click('settingsButtons', 2); }
    }
    assert.equal((await read()).overlay, 'levels');
  };
  const goToPage = async desired => {
    await openMap();
    let current = (await read()).page;
    for (let step = 0; current !== desired && step < 4; step++) {
      await click('levelPageButtons', current < desired ? 1 : 0);
      current = (await read()).page;
    }
    assert.equal(current, desired);
  };
  const choose = async index => { await goToPage(Math.floor(index / 10)); await click('levelButtons', index % 10); };
  const dismissLesson = async definition => {
    const before = await read();
    if (before.overlay !== 'lesson') return false;
    assert.equal(definition.learning, true, 'only first-mechanic levels need a teaching panel');
    assert.equal(before.state.moves, 0);
    assert.equal(before.progress.lessonsSeen.includes(definition.id), false);
    await page.screenshot({ path: `.local/qa/campaign-${definition.id}-lesson-${page.viewportSize().width}.png` });
    await click('lessonButton');
    const after = await read();
    assert.equal(after.overlay, null);
    assert.ok(after.progress.lessonsSeen.includes(definition.id));
    assert.equal(after.state.moves, 0, 'acknowledging a rule never plays a block for the user');
    return true;
  };
  const drag = async move => {
    const points = await page.evaluate(move => {
      const g = window.__game, piece = g.state.pieces[move.index], slot = g.slots[move.index];
      if (!piece) throw new Error('Witness tried a consumed slot');
      const width = Math.max(...piece.cells.map(c => c.x + 1)), height = Math.max(...piece.cells.map(c => c.y + 1));
      const canvas = document.querySelector('canvas').getBoundingClientRect();
      const convert = (x, y) => ({ x: canvas.left + g.offsetX + x * g.scale, y: canvas.top + g.offsetY + y * g.scale });
      return { start: convert(slot.x + slot.w / 2, slot.y + slot.h / 2),
        end: convert(g.board.x + (move.x + width / 2) * g.cell, g.board.y + (move.y + height / 2) * g.cell) };
    }, move);
    await page.mouse.move(points.start.x, points.start.y); await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, { steps: 1 }); await page.mouse.up();
  };
  return { read, click, openMap, goToPage, choose, dismissLesson, drag };
}
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('wood-blocks.tutorial-seen.v1', 'true');
    if (localStorage.getItem('wood-blocks.best.v1') === null) localStorage.setItem('wood-blocks.best.v1', '1');
  });
  await page.goto(url); await page.waitForFunction(() => window.__game?.assets?.ready);
  const d = driver(page);
  const original = await d.read();
  let legalMove;
  original.state.pieces.forEach((piece, index) => {
    if (!piece || legalMove) return;
    for (let y = 0; y < 8 && !legalMove; y++) for (let x = 0; x < 8 && !legalMove; x++) {
      if (piece.cells.every(c => x + c.x < 8 && y + c.y < 8 && original.state.board[y + c.y][x + c.x] === 0)) legalMove = { index, x, y };
    }
  });
  assert.ok(legalMove); await d.drag(legalMove);
  const preservedEndless = await d.read();
  assert.equal(preservedEndless.state.moves, 1);
  assert.equal(preservedEndless.best, 10);
  assert.equal(preservedEndless.savedBest, '10');
  assert.deepEqual(preservedEndless.progress.completed, []);

  // A new install can inspect all three pages, but cannot enter later levels.
  for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => {
      const g = window.__game, canvas = document.querySelector('canvas').getBoundingClientRect();
      return g.width === innerWidth && g.height === innerHeight && canvas.bottom <= innerHeight + .01;
    });
    await d.openMap(); await d.goToPage(0);
    const layout = await page.evaluate(() => {
      const g = window.__game, canvas = document.querySelector('canvas').getBoundingClientRect();
      return { cards: g.levelButtons(), actions: g.levelMenuButtons(), pager: g.levelPageButtons(),
        top: g.safeTop, bottom: g.logicalH - g.safeBottom, actualBottom: canvas.bottom, viewportHeight: innerHeight };
    });
    assert.equal(layout.cards.length, 10);
    assert.ok(layout.actualBottom <= layout.viewportHeight + .01);
    for (const r of [...layout.cards, ...layout.actions, ...layout.pager]) {
      assert.ok(r.x >= 0 && r.x + r.w <= 390 && r.y >= layout.top && r.y + r.h <= layout.bottom,
        `${viewport.width}: map controls fit safe canvas`);
    }
    await page.screenshot({ path: `.local/qa/campaign-map-${viewport.width}-page1.png` });
    await d.click('levelButtons', 1);
    assert.equal((await d.read()).overlay, 'levels', 'clicking a locked level cannot leave the map');
    assert.deepEqual((await d.read()).state, preservedEndless.state);
    await page.keyboard.press('2');
    assert.equal((await d.read()).overlay, 'levels', 'number keys cannot bypass locks');
    await d.goToPage(2); await d.click('levelButtons', 9);
    assert.equal((await d.read()).overlay, 'levels');
    assert.deepEqual((await d.read()).state, preservedEndless.state);
    await page.screenshot({ path: `.local/qa/campaign-map-${viewport.width}-page3.png` });
    await d.click('levelMenuButtons', 1);
    assert.equal((await d.read()).overlay, null);
    assert.deepEqual((await d.read()).state, preservedEndless.state, 'returning from map preserves endless play');
  }

  await d.choose(0);
  let totalMoves = 0, lessonCount = 0, reloadEndless = null;
  const completedIds = [];
  for (const [index, definition] of LEVELS.entries()) {
    let snapshot = await d.read();
    assert.equal(snapshot.state.level.id, definition.id, `sequential play reaches ${definition.number}`);
    if (await d.dismissLesson(definition)) lessonCount++;
    snapshot = await d.read();
    assert.equal(snapshot.overlay, null);
    assert.equal(snapshot.state.tutorial, false);
    assert.equal(snapshot.state.moves, 0);
    const initial = structuredClone(snapshot.state);
    if (definition.timeLimitSeconds === null) {
      assert.equal(snapshot.remainingMs, undefined, `${definition.id}: unlimited planning has no countdown value`);
      assert.equal(snapshot.clockTimer, null, `${definition.id}: unlimited planning schedules no countdown worker`);
      await page.evaluate(maxMoves => { window.__game.state.moves = maxMoves; }, definition.maxMoves);
      await d.drag(definition.solution[0]);
      const beyondEstimate = await d.read();
      assert.equal(beyondEstimate.state.status, 'playing', `${definition.id}: the server estimate is not a hidden move limit`);
      assert.equal(beyondEstimate.state.moves, definition.maxMoves + 1);
      assert.equal(beyondEstimate.clockTimer, null);
      await d.click('settingsButton'); await d.click('settingsButtons', 1);
      snapshot = await d.read();
      assert.deepEqual(snapshot.state, initial, `${definition.id}: restart restores an untimed challenge normally`);
    }
    if ([1, 4, 7, 10, 14, 18, 25, 29, 30].includes(definition.number)) {
      await page.waitForTimeout(40); await page.screenshot({ path: `.local/qa/campaign-${definition.id}-start.png` });
    }
    if ([4, 10].includes(definition.number)) {
      assert.ok(snapshot.state.pieces.some(piece => piece?.star), `${definition.id}: an incoming star is visible in the tray`);
      assert.ok(snapshot.state.level.gems.length > 0, `${definition.id}: placed and incoming stars can be compared`);
      await page.screenshot({ path: `.local/qa/campaign-${definition.id}-candidate-stars.png` });
    }
    for (const [step, move] of definition.solution.entries()) {
      await d.drag(move); snapshot = await d.read(); totalMoves++;
      assert.equal(snapshot.state.moves, step + 1, `${definition.id}: real pointer placement ${step + 1}`);
      if (step === 0 && definition.number === 3) {
        await d.openMap(); await d.click('levelMenuButtons', 0);
        assert.deepEqual((await d.read()).state, snapshot.state, 'continue resumes the current unfinished level');
      }
      if (snapshot.state.status === 'won') break;
      assert.equal(snapshot.state.status, 'playing');
    }
    assert.equal(snapshot.state.status, 'won');
    assert.equal(snapshot.state.level.timeBonus, 0, `${definition.id}: no time points are added`);
    assert.equal(snapshot.state.score, definition.starScores[2], `${definition.id}: total score comes from placement and clears alone`);
    assert.ok(snapshot.state.score >= definition.starScores[2], `${definition.id}: the real-pointer route reaches three stars`);
    assert.equal(snapshot.economy.levels[definition.id].stars, 3);
    assert.deepEqual(snapshot.uses, { refresh: 0, rotate: 0, revive: 0 });
    completedIds.push(definition.id);
    assert.deepEqual(snapshot.progress.completed, completedIds, 'a real win saves progress immediately');
    assert.deepEqual(JSON.parse(snapshot.savedCampaign).completed, completedIds);
    assert.equal(snapshot.best, 10, 'campaign scores never write the endless personal best');
    assert.equal(snapshot.savedBest, '10');

    if ([1, 10, 14, 18, 29, 30].includes(definition.number)) {
      await page.waitForTimeout(650); await page.screenshot({ path: `.local/qa/campaign-${definition.id}-won.png` });
    }
    if ([1, 14].includes(definition.number)) {
      const labels = await page.evaluate(() => {
        const g = window.__game, labels = [], original = g.ctx.fillText;
        g.ctx.fillText = function (value, ...args) { labels.push(String(value)); return original.call(this, value, ...args); };
        try { g.draw(); g.finishCampaignVictory(); g.draw(); } finally { g.ctx.fillText = original; }
        return labels;
      });
      assert.ok(labels.includes(`${snapshot.state.score} 分`), 'settlement displays the actual pure score');
      assert.ok(!labels.some(label => /时间奖励|倒计时|不限时挑战|基础 /.test(label)), 'settlement contains no timing breakdown');
      const repeated = await d.read();
      assert.deepEqual(repeated.state, snapshot.state, 'repainting and reopening settlement does not add points twice');
      assert.deepEqual(repeated.economy, snapshot.economy, 'settlement repeats cannot duplicate coins or chests');
    }
    if (index === 0) {
      await d.click('modalButtons', 1);
      assert.equal((await d.read()).overlay, null, 'replay never repeats an acknowledged learning panel');
      assert.deepEqual((await d.read()).state, initial, 'retry restores this level and its target layers');
      assert.deepEqual((await d.read()).progress.completed, completedIds, 'replay cannot erase a win');
      await d.choose(1);
    } else if (index === 5) {
      await d.openMap(); await d.click('levelMenuButtons', 1);
      const resumed = await d.read();
      assert.deepEqual(resumed.state, preservedEndless.state);
      assert.deepEqual(resumed.uses, preservedEndless.uses);
      await d.openMap(); await d.click('levelMenuButtons', 0);
      assert.equal((await d.read()).state.level.id, LEVELS[index + 1].id, 'continue starts the next unfinished level');
    } else if (index === 9) {
      await page.reload(); await page.waitForFunction(() => window.__game?.assets?.ready);
      snapshot = await d.read(); reloadEndless = structuredClone(snapshot);
      assert.deepEqual(snapshot.progress.completed, completedIds, 'completion survives re-opening');
      assert.deepEqual(snapshot.progress.lessonsSeen, lessonIds);
      assert.equal(snapshot.state.mode, 'endless');
      await d.openMap(); await d.click('levelMenuButtons', 0);
      assert.equal((await d.read()).state.level.id, LEVELS[index + 1].id, 'reload continues at level eleven');
    } else {
      await d.click('modalButtons', 0);
      if (index < LEVELS.length - 1) assert.equal((await d.read()).state.level.id, LEVELS[index + 1].id);
      else assert.equal((await d.read()).overlay, 'levels', 'all thirty levels return to the completed map');
    }
  }
  assert.equal(lessonCount, 4);
  assert.deepEqual((await d.read()).progress.lessonsSeen, lessonIds);
  await d.click('levelMenuButtons', 0);
  assert.equal((await d.read()).state.level.id, LEVELS[29].id, 'the finished campaign has a valid replay destination');
  assert.equal((await d.read()).overlay, null);

  // This isolated blocked fixture checks that stale clock data cannot disable revival;
  // the thirty winning runs above used only genuine pointer gestures.
  const freshLast = (await d.read()).state;
  await page.evaluate(() => {
    const g = window.__game, goalColors = g.levelDefinition.goals.filter(goal => goal.kind === 'color').map(goal => goal.color);
    const color = [0, 1, 2, 3, 4].find(value => !goalColors.includes(value));
    g.state = { ...g.state, board: Array.from({ length: 8 }, () => Array(8).fill(color + 1)),
      moves: g.levelDefinition.maxMoves + 100, level: { ...g.state.level, gems: [], timeRemainingMs: 0 }, status: 'lost' };
    g.resultAt = Date.now() - 1200; g.invalidate();
  });
  const staleBlocked = await d.read();
  await d.click('modalButtons', 0);
  await page.waitForFunction(() => !window.__game.rewardBusy);
  const revived = await d.read();
  assert.equal(revived.state.status, 'playing', 'unlimited campaign revival works beyond the estimate despite stale zero clock data');
  assert.equal(revived.state.moves, staleBlocked.state.moves);
  assert.equal(revived.state.score, staleBlocked.state.score);
  assert.notDeepEqual(revived.state.board, staleBlocked.state.board, 'revival genuinely frees cells for a remaining piece');
  assert.equal(revived.clockTimer, null);
  await page.evaluate(() => { const g = window.__game; g.state.status = 'lost'; g.resultAt = Date.now() - 1200; g.invalidate(); });
  await d.click('modalButtons', 1);
  assert.deepEqual((await d.read()).state, freshLast);

  // The dual-goal HUD is the tightest phone layout. Real map input selects a
  // previously completed dual level after native capsule metrics are applied.
  const dualIndex = LEVELS.findIndex(level => level.mechanic === 'dual' && level.goals.length === 3);
  assert.ok(dualIndex >= 0, 'the maximum three-target HUD is checked on compact phones');
  for (const native of [false, true]) {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForFunction(() => window.__game.width === innerWidth && window.__game.height === innerHeight);
    if (native) await page.evaluate(() => window.__game.resize(320, 568, 2, 44, 34, 60));
    await d.choose(dualIndex);
    assert.equal((await d.read()).overlay, null, 'a completed teaching level stays acknowledged');
    const layout = await page.evaluate(() => {
      const g = window.__game, canvas = document.querySelector('canvas').getBoundingClientRect(), labels = [], original = g.ctx.fillText;
      g.ctx.fillText = function (value, x, y, ...rest) { labels.push({ text: String(value), x, y }); return original.call(this, value, x, y, ...rest); };
      try { g.draw(); } finally { g.ctx.fillText = original; }
      return { labels, board: g.board, slots: g.slots, tools: g.dockButtons(),
        titleCenter: labels.find(label => /^第\s*\d+\s*关$/.test(label.text))?.y * g.scale,
        safeBottom: g.logicalH - g.safeBottom, actualBottom: canvas.bottom, viewportHeight: innerHeight };
    });
    assert.ok(!layout.labels.some(label => /分数|金币|最高分|三星进度/.test(label.text)), 'gameplay has no score, rating progress or coin balance');
    assert.ok(!layout.labels.some(label => /倒计时|限时|自由规划|剩余时间|时间奖励/.test(label.text)), 'gameplay has no timing text');
    const names = LEVELS[dualIndex].goals.map(goal => goal.kind === 'lines' ? '消除行列' : goal.kind === 'gems' ? '收集星星' : `${COLOR_NAMES[goal.color]}方块`);
    const taskLabels = layout.labels.filter(label => label.y < layout.board.y && names.includes(label.text));
    assert.deepEqual(taskLabels.map(label => label.text), names, 'the task strip contains only the active objectives');
    taskLabels.forEach((label, i) => {
      assert.equal(label.x, 21 + 348 / names.length * (i + .5), 'objectives are evenly distributed across the full task strip');
      assert.equal(label.y, taskLabels[0].y, 'objective names share a baseline');
    });
    assert.equal(layout.tools.length, 5, 'the current five-tool dock remains available in campaign play');
    assert.ok(layout.board.y + layout.board.h < Math.min(...layout.slots.map(r => r.y)));
    assert.ok(Math.max(...layout.slots.map(r => r.y + r.h)) < Math.min(...layout.tools.map(r => r.y)));
    assert.ok(Math.max(...layout.tools.map(r => r.y + r.h)) <= layout.safeBottom, 'five tools clear the native bottom safe area');
    assert.ok(layout.actualBottom <= layout.viewportHeight + .01);
    if (native) assert.ok(Math.abs(layout.titleCenter - 60) < .01);
    await page.screenshot({ path: `.local/qa/campaign-dual-320${native ? '-native' : ''}.png` });
  }
  await d.openMap(); await d.click('levelMenuButtons', 1);
  const restored = await d.read();
  assert.deepEqual(restored.state, reloadEndless.state, 'returning restores the endless session established by reload');
  assert.deepEqual(restored.uses, reloadEndless.uses);
  assert.equal(restored.savedBest, '10');

  const blockedContext = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const blockedPage = await blockedContext.newPage();
  blockedPage.on('pageerror', error => errors.push(`blocked-storage: ${error.message}`));
  await blockedPage.addInitScript(() => {
    Storage.prototype.getItem = function () { throw new Error('Storage disabled'); };
    Storage.prototype.setItem = function () { throw new Error('Storage disabled'); };
  });
  await blockedPage.goto(`${url}&play=levels`); await blockedPage.waitForFunction(() => window.__game?.assets?.ready);
  const blocked = driver(blockedPage);
  assert.equal((await blocked.read()).overlay, 'levels');
  await blocked.choose(0); await blocked.dismissLesson(LEVELS[0]);
  for (const move of LEVELS[0].solution) {
    await blocked.drag(move);
    if ((await blocked.read()).state.status === 'won') break;
  }
  assert.equal((await blocked.read()).state.status, 'won');
  assert.deepEqual((await blocked.read()).progress.completed, [LEVELS[0].id], 'storage failures preserve current-session progress');
  await blocked.click('modalButtons', 0);
  assert.equal((await blocked.read()).state.level.id, LEVELS[1].id);
  await blockedContext.close();

  // Old completed campaigns retain their wins while seeing the replacement
  // color and combination explanations once, even if the old ice lessons were
  // already acknowledged under the same level IDs.
  const migrationContext = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const migrationPage = await migrationContext.newPage();
  migrationPage.on('pageerror', error => errors.push(`migration: ${error.message}`));
  await migrationPage.addInitScript(({ completed, lessons }) => {
    localStorage.setItem('wood-blocks.tutorial-seen.v1', 'true');
    if (!localStorage.getItem('wood-blocks.campaign.v1')) localStorage.setItem('wood-blocks.campaign.v1', JSON.stringify({ version: 1, completed, lessonsSeen: lessons }));
  }, { completed: LEVELS.slice(0, 10).map(level => level.id), lessons: LEVELS.filter(level => level.learning).map(level => level.id) });
  await migrationPage.goto(url); await migrationPage.waitForFunction(() => window.__game?.assets?.ready);
  const migrated = driver(migrationPage);
  const oldWins = (await migrated.read()).progress.completed;
  for (const [index, token] of [[6, 'level-07:colors-v1'], [9, 'level-10:colors-stars-v1']]) {
    await migrated.choose(index);
    assert.equal((await migrated.read()).overlay, 'lesson');
    await migrated.click('lessonButton');
    assert.ok((await migrated.read()).progress.lessonsSeen.includes(token));
    assert.deepEqual((await migrated.read()).progress.completed, oldWins, 'updating a lesson never clears completed levels');
  }
  await migrationPage.reload(); await migrationPage.waitForFunction(() => window.__game?.assets?.ready);
  for (const index of [6, 9]) { await migrated.choose(index); assert.equal((await migrated.read()).overlay, null); }
  await migrationContext.close();
  assert.deepEqual(errors, []);
  console.log(`Campaign UI smoke passed: thirty real-pointer wins (${totalMoves} moves, ${((Date.now() - startedAt) / 1000).toFixed(1)} seconds), no countdown or hidden move limit, pure-score stars, four one-time lessons, sequential locks, three-page map, replay/continue/reload, stale-clock revival, distributed compact/native multi-goal layouts, best-score isolation and unavailable-storage recovery.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
