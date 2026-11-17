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
const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(localChrome) ? localChrome : undefined);
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?debug=1&test=off`);
  await page.waitForFunction(() => window.__game?.powerButtons?.length === 2 && window.__game.assets?.ready);
  await page.locator('canvas').focus();
  await page.evaluate(() => { window.__originalRewarded = window.__game.options.rewarded; });

  const read = () => page.evaluate(() => {
    const g = window.__game;
    return { state: g.state, economy: g.economy, uses: g.powerUses, grants: g.powerGrants, busy: g.rewardBusy, overlay: g.overlay, rotationMode: g.rotationMode, selected: g.selected, ghost: g.ghost ?? null, hint: g.hint ?? null };
  });
  const drawnText = () => page.evaluate(() => {
    const g = window.__game, texts = [], original = g.ctx.fillText;
    g.ctx.fillText = function (value, ...args) { texts.push(String(value)); return original.call(this, value, ...args); };
    try { g.draw(); } finally { g.ctx.fillText = original; }
    return texts;
  });
  const clickRect = async (collection, index) => {
    const p = await page.evaluate(({ collection, index }) => {
      const g = window.__game, canvas = document.querySelector('canvas').getBoundingClientRect();
      const list = collection === 'modal' ? g.modalButtons() : typeof g[collection] === 'function' ? g[collection]() : g[collection], r = list[index];
      if (!r) throw new Error(`Missing ${collection} button ${index}`);
      return { x: canvas.left + g.offsetX + (r.x + r.w / 2) * g.scale, y: canvas.top + g.offsetY + (r.y + r.h / 2) * g.scale };
    }, { collection, index });
    await page.mouse.click(p.x, p.y);
  };
  const clickPower = kind => clickRect('powerButtons', { rotate: 0, refresh: 1 }[kind]);
  const requestVideo = async kind => {
    await clickPower(kind);
    assert.equal((await read()).overlay, 'acquire', `${kind}: empty stock offers ad or coin acquisition`);
    await clickRect('acquireButtons', 0);
  };
  const closeAcquire = () => clickRect('acquireButtons', 2);
  // Independent scenarios reset through a fixture; the only user-facing restart
  // is exercised later using the actual loss dialog.
  const resetFixture = () => page.evaluate(() => window.__game.reset());
  const removedShortcutsDoNothing = async () => {
    const before = await read();
    for (const key of ['z', 'h', 'r']) {
      await page.keyboard.press(key);
      assert.deepEqual(await read(), before, `removed ${key} shortcut cannot change the game`);
    }
  };
  const installDeferredReward = () => page.evaluate(() => {
    window.__rewardCalls = []; window.__finishReward = null;
    window.__game.options.rewarded = {
      request(kind) { window.__rewardCalls.push(kind); return new Promise(resolve => { window.__finishReward = resolve; }); },
      dispose() {},
    };
  });
  const settleReward = async result => {
    await page.evaluate(result => window.__finishReward(result), result);
    await page.waitForFunction(() => !window.__game.rewardBusy);
  };
  const unchanged = (before, after, message) => {
    assert.deepEqual(after.state, before.state, message);
    assert.deepEqual(after.uses, before.uses, message);
    assert.deepEqual(after.grants, before.grants, message);
    assert.deepEqual(after.economy, before.economy, message);
  };
  const sig = cells => cells.map(c => `${c.x},${c.y}`).sort().join(';');
  const clockwise = cells => { const height = Math.max(...cells.map(c => c.y + 1)); return cells.map(c => ({ x: height - 1 - c.y, y: c.x })); };
  const makePlayable = () => page.evaluate(() => {
    const g = window.__game;
    g.state = { ...g.state, tutorial: false, status: 'playing', board: Array.from({ length: 8 }, () => Array(8).fill(0)), pieces: [
      { id: 'turnable-L', cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }] },
      { id: 'symmetric-square', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null,
    ] };
    g.selected = -1; g.ghost = null; g.hint = null; g.drag = null; g.overlay = null; g.clearFx = null; g.returnFx = null; g.invalidate();
  });
  const makeLost = () => page.evaluate(() => {
    const g = window.__game;
    g.state = { ...g.state, tutorial: false, status: 'lost', board: Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2)), pieces: Array.from({ length: 3 }, (_, i) => ({ id: `blocked-${i}`, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] })) };
    g.resultAt = Date.now() - 1000; g.overlay = null; g.invalidate();
  });
  const makeBlockedLine = () => page.evaluate(() => {
    const g = window.__game;
    const board = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => Number(x !== y)));
    for (let y = 0; y < 3; y++) board[y][3] = 0;
    g.state = { ...g.state, tutorial: false, status: 'playing', board, pieces: [
      { id: 'blocked-horizontal-line', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] },
      { id: 'available-single-cell', cells: [{ x: 0, y: 0 }] }, null,
    ] };
    g.selected = -1; g.ghost = null; g.hint = null; g.drag = null; g.overlay = null; g.clearFx = null; g.returnFx = null; g.invalidate();
  });
  const dragPiece = async (index, x, y) => {
    const points = await page.evaluate(({ index, x, y }) => {
      const g = window.__game, slot = g.slots[index], piece = g.state.pieces[index], rect = document.querySelector('canvas').getBoundingClientRect();
      const width = Math.max(...piece.cells.map(c => c.x + 1)), height = Math.max(...piece.cells.map(c => c.y + 1));
      const convert = (px, py) => ({ x: rect.left + g.offsetX + px * g.scale, y: rect.top + g.offsetY + py * g.scale });
      return { start: convert(slot.x + slot.w / 2, slot.y + slot.h / 2), end: convert(g.board.x + (x + width / 2) * g.cell, g.board.y + (y + height / 2) * g.cell) };
    }, { index, x, y });
    await page.mouse.move(points.start.x, points.start.y); await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, { steps: 8 }); await page.mouse.up();
  };

  // Five tools form a bottom dock after the three candidate slots.
  for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(80);
    const layout = await page.evaluate(() => {
      const g = window.__game;
      return {
        count: g.dockButtons().length, oldControls: g.buttons?.length || 0,
        boardBottom: g.board.y + g.board.h,
        powersTop: Math.min(...g.dockButtons().map(r => r.y)), powersBottom: Math.max(...g.dockButtons().map(r => r.y + r.h)),
        trayTop: Math.min(...g.slots.map(r => r.y)), trayBottom: Math.max(...g.slots.map(r => r.y + r.h)),
        safeBoundary: g.logicalH - g.safeBottom, left: g.powerButtons[0].x, right: g.powerButtons[1].x,
      };
    });
    assert.equal(layout.count, 5, 'the bottom dock contains all five tools');
    assert.equal(layout.oldControls, 0, 'the removed footer has no invisible hit targets');
    assert.ok(layout.left < layout.right);
    assert.ok(layout.boardBottom < layout.trayTop, `candidates sit below the board at ${viewport.width}×${viewport.height}`);
    assert.ok(layout.trayTop < layout.trayBottom && layout.trayBottom < layout.powersTop, `tools sit below the candidates at ${viewport.width}×${viewport.height}`);
    assert.ok(layout.powersTop < layout.powersBottom && layout.powersBottom <= layout.safeBoundary + .01, `tools stay above the bottom safe area at ${viewport.width}×${viewport.height}`);
  }
  const initial = await read();
  assert.equal(initial.state.tutorial, true);
  assert.deepEqual(initial.grants, { refresh: 3, rotate: 3 });
  assert.deepEqual(initial.economy.inventory, { hint: 3, rotate: 3, refresh: 3, bomb: 0, bulldozer: 0 });
  for (const kind of ['rotate', 'refresh']) {
    await clickPower(kind); unchanged(initial, await read(), 'the first-entry tutorial does not permit tools');
    assert.equal((await read()).overlay, null);
    assert.equal((await read()).rotationMode, false);
  }
  await removedShortcutsDoNothing();
  await dragPiece(1, 3, 3);
  assert.equal((await read()).state.tutorial, false);
  assert.equal((await read()).state.lines, 2);
  assert.equal((await drawnText()).some(text => /复活/.test(text)), false, 'playing UI contains no revival control');
  assert.equal((await drawnText()).some(text => ['撤回', '重来'].includes(text)), false, 'unrequested controls are absent from the dock');
  assert.ok((await drawnText()).includes('提示'), 'the hint tool is part of the new five-tool dock');

  // Rotation operates on the actual tray. Previewing and four-turn cycles cost nothing.
  await makePlayable();
  let before = await read();
  await clickPower('rotate');
  assert.equal((await read()).rotationMode, true);
  assert.equal((await read()).overlay, null, 'rotation has no confirmation dialog');
  for (let turn = 1; turn <= 4; turn++) {
    await clickRect('slots', 0);
    const snapshot = await read();
    let expected = before.state.pieces[0].cells;
    for (let n = 0; n < turn; n++) expected = clockwise(expected);
    assert.equal(sig(snapshot.state.pieces[0].cells), sig(expected));
    assert.equal(snapshot.uses.rotate, 0, 'trying a direction does not consume a rotation');
  }
  await clickRect('slots', 1);
  unchanged(before, await read(), 'a symmetric square cannot waste a rotation');
  await clickPower('rotate');
  assert.equal((await read()).rotationMode, false);
  unchanged(before, await read(), 'closing rotation mode after a full cycle consumes nothing');
  await clickPower('rotate'); await clickRect('slots', 0);
  assert.notEqual(sig((await read()).state.pieces[0].cells), sig(before.state.pieces[0].cells));
  await clickPower('rotate');
  assert.equal((await read()).rotationMode, false);
  unchanged(before, await read(), 'cancelling a changed preview restores the original direction without a charge');

  // A rotated piece consumes its use only when dropped.
  await clickPower('rotate'); await clickRect('slots', 0);
  assert.equal((await read()).uses.rotate, 0);
  await page.screenshot({ path: '.local/qa/rotation-in-tray.png' });
  const rotated = clockwise(before.state.pieces[0].cells);
  await dragPiece(0, 0, 0);
  let snapshot = await read();
  assert.equal(snapshot.uses.rotate, 1);
  assert.equal(snapshot.rotationMode, true, 'rotation mode remains active for the next block');
  assert.equal(snapshot.state.moves, before.state.moves + 1);
  assert.equal(snapshot.state.pieces[0], null);
  for (const cell of rotated) assert.equal(snapshot.state.board[cell.y][cell.x], 1);
  await removedShortcutsDoNothing();
  assert.equal((await read()).rotationMode, true, 'removed shortcuts cannot exit rotation mode');
  await clickPower('rotate');

  // An unusable gray candidate can still be selected while rotating and become playable.
  await makeBlockedLine();
  assert.equal(await page.evaluate(() => window.__game.blocked(0)), true);
  await clickPower('rotate'); await clickRect('slots', 0);
  assert.equal(await page.evaluate(() => window.__game.blocked(0)), false, 'turning a gray horizontal line makes it fit the vertical gap');
  assert.equal((await read()).uses.rotate, 1, 'rescuing the preview alone costs nothing');
  await dragPiece(0, 3, 0);
  assert.equal((await read()).uses.rotate, 2);
  for (let y = 0; y < 3; y++) assert.equal((await read()).state.board[y][3], 1);
  await clickPower('rotate');
  await makePlayable(); await clickPower('rotate'); await clickRect('slots', 0); await dragPiece(0, 0, 0);
  assert.equal((await read()).uses.rotate, 3, 'all three included rotations can be used without an ad');
  assert.equal((await read()).economy.inventory.rotate, 0, 'actual placements spend the shared saved inventory');
  assert.equal((await read()).rotationMode, false, 'using the last included rotation exits the mode');

  // Exhausted rotations offer acquisition; incomplete videos add nothing.
  await makePlayable();
  before = await read();
  await requestVideo('rotate');
  await page.waitForFunction(() => !window.__game.rewardBusy);
  unchanged(before, await read(), 'missing ad configuration cannot grant rotation credit');
  assert.equal((await read()).rotationMode, false);
  await closeAcquire();
  await installDeferredReward();
  for (const result of ['cancelled', 'error']) {
    before = await read(); await requestVideo('rotate');
    await page.waitForFunction(() => window.__game.rewardBusy);
    assert.equal((await read()).overlay, 'acquire');
    await settleReward(result); unchanged(before, await read(), `${result} rotation video grants nothing`);
    assert.equal((await read()).rotationMode, false);
    await closeAcquire();
  }
  await requestVideo('rotate'); await page.waitForFunction(() => window.__game.rewardBusy);
  before = await read();
  await settleReward('completed');
  assert.equal((await read()).economy.inventory.rotate, before.economy.inventory.rotate + 1);
  assert.equal((await read()).uses.rotate, before.uses.rotate, 'watching unlocks rotation without consuming it');
  assert.equal((await read()).rotationMode, false, 'an acquired prop is available for a later deliberate use');
  const afterGrant = await read();
  await page.evaluate(() => window.__finishReward('completed'));
  unchanged(afterGrant, await read(), 'a repeated video callback cannot add another credit');
  await clickPower('rotate');
  await clickRect('slots', 0); await dragPiece(0, 0, 0);
  assert.equal((await read()).uses.rotate, 4);
  assert.equal((await read()).economy.inventory.rotate, 0);
  assert.equal((await read()).rotationMode, false, 'using the last video rotation exits the mode');

  // Refresh means turning only the remaining choices into single cells, directly.
  await resetFixture();
  snapshot = await read();
  assert.equal(snapshot.state.tutorial, false, 'the completed first-entry tutorial does not repeat on restart');
  assert.equal(snapshot.state.score, 0);
  assert.ok(snapshot.state.board.flat().every(cell => cell === 0));
  assert.deepEqual(snapshot.uses, { refresh: 0, rotate: 0, revive: 0 });
  assert.deepEqual(snapshot.grants, { refresh: 3, rotate: 3 });
  assert.equal(snapshot.economy.inventory.rotate, 0, 'restart does not replenish the shared inventory');
  await page.evaluate(() => { window.__game.options.rewarded = window.__originalRewarded; });
  for (let use = 1; use <= 3; use++) {
    await makePlayable(); before = await read();
    await clickPower('refresh'); snapshot = await read();
    assert.equal(snapshot.overlay, null, 'refresh does not open a confirmation dialog');
    assert.equal(snapshot.uses.refresh, use);
    assert.equal(snapshot.economy.inventory.refresh, 3 - use);
    assert.equal(snapshot.state.pieces[2], null, 'refresh never refills an already-used slot');
    assert.ok(snapshot.state.pieces.filter(Boolean).every(piece => sig(piece.cells) === '0,0'));
    assert.equal(snapshot.state.batch, before.state.batch, 'refresh is not an early new deal');
    assert.deepEqual(snapshot.state.board, before.state.board);
    for (const key of ['score', 'moves', 'lines', 'combo']) assert.equal(snapshot.state[key], before.state[key]);
    await removedShortcutsDoNothing();
    await clickPower('refresh'); unchanged(snapshot, await read(), 'refreshing existing single cells consumes no use');
    if (use === 3) { assert.equal((await read()).overlay, 'acquire'); await closeAcquire(); }
  }
  await page.screenshot({ path: '.local/qa/refresh-single-cells.png' });

  await makePlayable(); before = await read();
  await requestVideo('refresh'); await page.waitForFunction(() => !window.__game.rewardBusy);
  unchanged(before, await read(), 'unconfigured ads cannot grant an exhausted refresh');
  await closeAcquire();
  await installDeferredReward();
  for (const result of ['cancelled', 'error']) {
    before = await read(); await requestVideo('refresh');
    await page.waitForFunction(() => window.__game.rewardBusy);
    await clickPower('refresh'); await page.keyboard.press('Escape'); await page.keyboard.press('r'); await page.keyboard.press('z');
    await clickRect('slots', 0);
    unchanged(before, await read(), 'input is blocked while waiting for a reward');
    await settleReward(result); unchanged(before, await read(), `${result} refresh video consumes nothing`);
    await closeAcquire();
  }
  await installDeferredReward();
  await requestVideo('refresh'); await page.waitForFunction(() => window.__game.rewardBusy);
  before = await read();
  await clickPower('refresh');
  assert.equal(await page.evaluate(() => window.__rewardCalls.length), 1, 'pending reward cannot be submitted twice');
  await page.evaluate(() => window.__game.pause());
  await settleReward('completed'); await page.evaluate(() => window.__game.resume());
  snapshot = await read();
  assert.equal(snapshot.uses.refresh, before.uses.refresh);
  assert.deepEqual(snapshot.state, before.state, 'complete viewing grants stock without changing candidates');
  assert.equal(snapshot.economy.inventory.refresh, 1);
  const afterReward = await read();
  await page.evaluate(() => window.__finishReward('completed'));
  unchanged(afterReward, await read(), 'repeated completion cannot grant two refresh props');
  await clickPower('refresh'); snapshot = await read();
  assert.equal(snapshot.uses.refresh, before.uses.refresh + 1);
  assert.equal(snapshot.economy.inventory.refresh, 0);
  assert.ok(snapshot.state.pieces.filter(Boolean).every(piece => sig(piece.cells) === '0,0'));

  // The loss dialog owns the ad-revival button. Empty IDs never give a free revival.
  await resetFixture();
  await page.evaluate(() => { window.__game.options.rewarded = window.__originalRewarded; });
  await makeLost(); before = await read();
  assert.equal(await page.evaluate(() => window.__game.modalButtons().length), 3, 'the loss dialog offers revival, a fresh challenge and the level map');
  assert.ok((await drawnText()).some(text => /看广告.*复活/.test(text)), 'the loss button explicitly offers ad revival');
  await page.screenshot({ path: '.local/qa/revive-loss-dialog.png' });
  await clickRect('modal', 2); assert.equal((await read()).overlay, 'levels');
  assert.deepEqual((await read()).state, before.state, 'visiting the map keeps the endless loss');
  await clickRect('levelMenuButtons', 1); assert.equal((await read()).overlay, null);
  before = await read();
  await clickRect('modal', 0); await page.waitForFunction(() => !window.__game.rewardBusy);
  unchanged(before, await read(), 'unconfigured revival video keeps the loss and consumes nothing');
  assert.equal((await read()).overlay, null, 'revival does not open a second confirmation dialog');
  await installDeferredReward();
  for (const result of ['cancelled', 'error']) {
    before = await read(); await clickRect('modal', 0);
    await page.waitForFunction(() => window.__game.rewardBusy);
    assert.equal((await read()).overlay, null);
    await settleReward(result); unchanged(before, await read(), `${result} revival video preserves the loss`);
    assert.equal((await read()).state.status, 'lost');
    assert.equal((await read()).uses.revive, 0);
  }
  before = await read();
  await installDeferredReward(); await clickRect('modal', 0);
  await page.waitForFunction(() => window.__game.rewardBusy);
  await clickRect('modal', 0); await page.keyboard.press('r'); await clickRect('modal', 1);
  assert.deepEqual(await page.evaluate(() => window.__rewardCalls), ['revive']);
  unchanged(before, await read(), 'the loss cannot restart or submit twice while a revival video is pending');
  await settleReward('completed');
  snapshot = await read();
  assert.equal(snapshot.state.status, 'playing');
  assert.equal(snapshot.uses.revive, 1);
  for (const key of ['score', 'moves', 'lines', 'combo']) assert.equal(snapshot.state[key], before.state[key]);
  assert.ok(snapshot.state.board.flat().reduce((a, b) => a + b, 0) < before.state.board.flat().reduce((a, b) => a + b, 0));
  await removedShortcutsDoNothing();
  await page.evaluate(() => window.__finishReward('completed'));
  unchanged(snapshot, await read(), 'a repeated close cannot revive twice');
  await page.screenshot({ path: '.local/qa/revived.png' });
  await makeLost(); before = await read(); await clickRect('modal', 0);
  unchanged(before, await read(), 'each session permits only one successful revival');
  assert.deepEqual(await page.evaluate(() => window.__rewardCalls), ['revive']);
  await removedShortcutsDoNothing();
  await clickRect('modal', 1);
  assert.equal((await read()).state.tutorial, false);
  assert.equal((await read()).state.status, 'playing');
  assert.equal((await read()).state.score, 0);
  assert.ok((await read()).state.board.flat().every(cell => cell === 0), 'the loss-dialog restart begins a new empty board');
  assert.deepEqual((await read()).uses, { refresh: 0, rotate: 0, revive: 0 });

  // Restarting or unloading while acquisition is pending discards late completion.
  await makePlayable(); await installDeferredReward();
  await page.evaluate(() => { window.__game.economy.inventory.refresh = 0; });
  await requestVideo('refresh'); await page.waitForFunction(() => window.__game.rewardBusy);
  await resetFixture(); before = await read();
  await settleReward('completed');
  unchanged(before, await read(), 'a late reward cannot apply to a restarted session');
  await makePlayable(); await installDeferredReward();
  await page.evaluate(() => { window.__game.economy.inventory.refresh = 0; });
  await requestVideo('refresh'); await page.waitForFunction(() => window.__game.rewardBusy);
  before = await read();
  await page.evaluate(() => { window.__game.destroy(); window.__finishReward('completed'); });
  await page.waitForTimeout(30);
  unchanged(before, await read(), 'a late reward after unload cannot change state');
  assert.deepEqual(errors, []);
  console.log('Powerup UI smoke passed: five-tool bottom dock, shared inventory, in-tray rotations charged on placement, single-cell refresh, acquisition choices and completed-ad grants, loss-dialog revival/restart, cancellation/error/completion, stale sessions and disposal.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
