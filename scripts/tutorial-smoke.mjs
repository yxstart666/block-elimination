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
  await page.clock.install({ time: new Date('2026-11-16T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-16T12:00:01Z'));
  await page.goto(`http://127.0.0.1:${server.address().port}/?debug=1`);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => window.__game?.guideVisible && window.__game.assets?.ready);

  const read = () => page.evaluate(() => {
    const g = window.__game;
    return { visible: g.guideVisible(), guideAt: g.guideAt, timer: g.guideTimer, hint: g.hint ?? null, selected: g.selected, drag: Boolean(g.drag), frame: g.frame, tutorial: g.state.tutorial, moves: g.state.moves, score: g.state.score, toast: g.toast.text, overlay: g.overlay ?? null };
  });
  const slotPoint = index => page.evaluate(index => {
    const g = window.__game, r = g.slots[index], canvas = document.querySelector('canvas').getBoundingClientRect();
    return { x: canvas.left + g.offsetX + (r.x + r.w / 2) * g.scale, y: canvas.top + g.offsetY + (r.y + r.h / 2) * g.scale };
  }, index);
  const dropPoint = index => page.evaluate(index => {
    const g = window.__game, p = g.state.pieces[index], canvas = document.querySelector('canvas').getBoundingClientRect();
    const width = Math.max(...p.cells.map(cell => cell.x + 1)), height = Math.max(...p.cells.map(cell => cell.y + 1));
    return { x: canvas.left + g.offsetX + (g.board.x + (3 + width / 2) * g.cell) * g.scale, y: canvas.top + g.offsetY + (g.board.y + (3 + height / 2) * g.cell) * g.scale };
  }, index);
  const drag = async index => {
    const start = await slotPoint(index), end = await dropPoint(index);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
  };
  const removedKeysHaveNoEffect = async () => {
    const before = await page.evaluate(() => window.__game.state);
    await page.locator('canvas').focus();
    for (const key of ['h', 'z', 'r']) {
      await page.keyboard.press(key);
      assert.deepEqual(await page.evaluate(() => window.__game.state), before, `${key} no longer changes the board or starts another game`);
      const status = await read();
      assert.equal(status.hint, null, `${key} does not request an active hint`);
      assert.equal(status.visible, false, `${key} does not reveal tutorial guidance`);
      assert.equal(status.overlay, null, `${key} does not open a restart dialog`);
    }
  };

  // Initial guidance must not identify the answer before the player has tried.
  let snapshot = await read();
  assert.equal(snapshot.visible, false);
  assert.equal(snapshot.guideAt, null);
  assert.equal(snapshot.hint, null);
  assert.equal(snapshot.selected, -1);
  await page.clock.runFor(16);
  await page.screenshot({ path: '.local/qa/tutorial-independent-choice.png' });
  // Reset the deadline after the one rendered frame, so the 3999/4000 boundary
  // below remains exact rather than depending on navigation wall time.
  await page.evaluate(() => window.__game.postponeGuide());
  await page.clock.runFor(3999);
  snapshot = await read();
  assert.equal(snapshot.visible, false);
  assert.equal(snapshot.frame, null, 'the idle wait does not poll animation frames');
  await page.clock.runFor(1);
  assert.equal((await read()).visible, true, 'guidance appears at four seconds of inactivity');
  await page.clock.runFor(16);
  await page.screenshot({ path: '.local/qa/tutorial-idle-guidance.png' });

  // A real pointer-down hides assistance immediately. Holding a block is still
  // active play even if more than four seconds pass during that drag.
  const start = await slotPoint(0);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  assert.equal((await read()).visible, false);
  await page.clock.runFor(5000);
  assert.equal((await read()).visible, false);
  const end = await dropPoint(0);
  await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
  snapshot = await read();
  assert.equal(snapshot.moves, 0);
  assert.equal(snapshot.score, 0);
  assert.ok(snapshot.toast.length > 0, 'a wrong choice receives a light message');
  assert.doesNotMatch(snapshot.toast, /2\s*[×x*]\s*2|中间|正确|四格/, 'the light message does not reveal the answer');
  assert.equal(snapshot.visible, false);
  await page.clock.runFor(3999); assert.equal((await read()).visible, false);
  await page.clock.runFor(1); assert.equal((await read()).visible, true, 'the idle wait restarts after a wrong attempt');

  // Background time cannot consume the player's thinking time.
  await page.evaluate(() => window.__game.pause());
  snapshot = await read();
  assert.equal(snapshot.visible, false); assert.equal(snapshot.timer, null);
  await page.clock.runFor(10000);
  await page.evaluate(() => window.__game.resume());
  assert.equal((await read()).visible, false);
  await page.clock.runFor(3999); assert.equal((await read()).visible, false);
  await page.clock.runFor(1); assert.equal((await read()).visible, true);

  // Removed hint, undo and in-game restart shortcuts do not reveal assistance
  // or change the first-entry board. The player completes teaching by dragging.
  const neutral = await slotPoint(2);
  await page.mouse.click(neutral.x, neutral.y);
  assert.equal((await read()).visible, false);
  await removedKeysHaveNoEffect();

  await drag(1);
  snapshot = await read();
  assert.equal(snapshot.tutorial, false);
  assert.equal(snapshot.score, 50);
  assert.equal(snapshot.timer, null, 'finishing the first step releases the idle timer');
  assert.equal(snapshot.visible, false);
  await page.clock.runFor(10000);
  assert.equal((await read()).visible, false, 'guidance never reappears after completing the tutorial');

  await removedKeysHaveNoEffect();
  assert.equal((await read()).tutorial, false, 'removed shortcuts cannot bring the tutorial back');
  await page.evaluate(() => window.__game.destroy());
  snapshot = await read();
  assert.equal(snapshot.timer, null);
  assert.equal(snapshot.frame, null);
  await page.clock.runFor(10000);
  assert.equal((await read()).visible, false);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => window.__game?.assets?.ready);
  snapshot = await read();
  assert.equal(snapshot.tutorial, false, 'reopening skips a tutorial that has already been shown');
  assert.equal(snapshot.moves, 0);
  assert.equal(snapshot.score, 0);
  assert.ok(await page.evaluate(() => window.__game.state.board.flat().every(cell => cell === 0)));
  await page.clock.runFor(5000);
  assert.equal((await read()).visible, false);
  assert.equal((await read()).timer, null, 'returning players have no tutorial timer');
  await removedKeysHaveNoEffect();
  assert.equal((await read()).tutorial, false, 'removed shortcuts leave returning players in the normal game');
  assert.ok(await page.evaluate(() => window.__game.state.board.flat().every(cell => cell === 0)));
  assert.deepEqual(errors, []);
  console.log('Tutorial UI smoke passed: first-entry choice and idle guidance, incorrect-choice feedback, real tutorial drag, background recovery, removed shortcuts, timer cleanup, persistent seen flag and empty-board reload.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
