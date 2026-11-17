import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { buildAll } from './build.mjs';
import { serve } from './server.mjs';
import { LEVELS } from '../src/core/levels.ts';
import { TOOL_PRICES } from '../src/services/economy.ts';

// Explicit visual-state fixtures complement the genuine pointer/reward runs.
// All fixture names and scores remain inside this isolated test browser.
await buildAll();
await mkdir('.local/qa/design-states', { recursive: true });
const server = serve(0); await once(server, 'listening');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const kinds = ['hint', 'rotate', 'refresh', 'bomb', 'bulldozer'];
const errors = [], captures = [];
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(chrome) ? chrome : undefined), headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
  await page.addInitScript(() => localStorage.setItem('wood-blocks.tutorial-seen.v1', 'true'));
  await page.goto(`http://127.0.0.1:${server.address().port}/?debug=1&unlock=all&test=off`);
  await page.waitForFunction(() => window.__game?.assets?.ready === true);
  const read = () => page.evaluate(() => {
    const g = window.__game;
    const state = structuredClone(g.state); if (state.level) delete state.level.timeRemainingMs;
    return { state, remainingMs: g.state.level?.timeRemainingMs, overlay: g.overlay, kind: g.acquireKind, economy: g.economy,
      settlement: g.settlement, vibration: g.feedbackEnabled, loading: g.rankingLoading, ranking: g.rankingResult };
  });
  const text = () => page.evaluate(() => {
    const g = window.__game, values = [], original = g.ctx.fillText;
    g.ctx.fillText = function (value, ...args) { values.push(String(value)); return original.call(this, value, ...args); };
    try { g.draw(); } finally { g.ctx.fillText = original; }
    return values;
  });
  const click = async (method, index = 0) => {
    const point = await page.evaluate(({ method, index }) => {
      const g = window.__game, bounds = document.querySelector('canvas').getBoundingClientRect();
      const value = g[method](), r = Array.isArray(value) ? value[index] : value;
      if (!r) throw new Error(`Missing ${method}[${index}]`);
      return { x: bounds.left + g.offsetX + (r.x + r.w / 2) * g.scale,
        y: bounds.top + (r.y + r.h / 2) * g.scale };
    }, { method, index });
    assert.ok(point.x >= 0 && point.x <= 390 && point.y >= 0 && point.y <= 844, `${method} is visible`);
    await page.mouse.click(point.x, point.y);
  };
  const capture = async name => {
    await page.evaluate(() => { const g = window.__game; g.toast.at = 0; g.draw(); });
    const file = `.local/qa/design-states/${name}.png`;
    await page.screenshot({ path: file }); captures.push({ name, file, state: await read() });
  };
  const start = async definition => {
    await page.evaluate(id => {
      const g = window.__game; g.overlay = null; g.startLevel(id); g.overlay = null; g.toast.at = 0; g.draw();
    }, definition.id);
    assert.equal((await read()).state.level.id, definition.id);
  };
  const assertGameplay = async () => {
    await page.evaluate(() => {
      const g = window.__game; g.state.score = 12340; g.economy.coins = 56780;
      g.particles = []; g.clearFx = null; g.placeFx = null; g.gainFx = null; g.toast.at = 0; g.draw();
    });
    const values = await text();
    assert.ok(!values.some(value => /分数|最高分|金币|评级/.test(value)), 'gameplay hides scoring and balances');
    assert.ok(!values.some(value => /12340|56780/.test(value.replaceAll(',', ''))), 'hidden score and balance are not drawn as bare numbers');
  };
  await assertGameplay(); await capture('endless-playing');
  for (const mechanic of ['lines', 'gems', 'colors', 'dual']) {
    const definition = LEVELS.find(level => level.mechanic === mechanic);
    await start(definition); await assertGameplay(); await capture(`campaign-${mechanic}`);
    await page.evaluate(() => { const g = window.__game; g.overlay = 'lesson'; g.draw(); });
    await capture(`lesson-${mechanic}`);
    const before = (await read()).state;
    await click('lessonButton');
    assert.equal((await read()).overlay, null); assert.deepEqual((await read()).state, before);
  }
  let before = await read();
  await click('settingsButton'); await capture('settings-vibration-on');
  await click('settingsButtons', 0); assert.equal((await read()).vibration, !before.vibration);
  await capture('settings-vibration-off'); await click('settingsButtons', 4);
  assert.deepEqual((await read()).state, before.state, 'settings preserve the real board');
  for (const [index, kind] of kinds.entries()) {
    await page.evaluate(() => {
      const g = window.__game; g.economy.coins = 100; g.economy.inventory = { hint: 0, rotate: 0, refresh: 0, bomb: 0, bulldozer: 0 };
    });
    await click('dockButtons', index);
    assert.equal((await read()).kind, kind); assert.equal((await read()).overlay, 'acquire');
    assert.ok((await text()).some(value => value.includes(String(TOOL_PRICES[kind]))), `${kind} price is real config`);
    await capture(`acquire-${kind}`); await click('acquireButtons', 2);
  }
  await page.evaluate(() => { window.__game.economy.coins = 0; });
  await click('dockButtons'); before = await read(); await click('acquireButtons', 1);
  assert.deepEqual((await read()).economy, before.economy); assert.equal((await read()).overlay, 'acquire');
  await capture('acquire-insufficient'); await click('acquireButtons', 2);
  await page.evaluate(() => {
    window.__game.leaderboard = { load: () => new Promise(resolve => { window.__designRankFinish = resolve; }), submit: async () => ({ status: 'ready', entries: [] }) };
  });
  await click('settingsButton'); await click('settingsButtons', 3);
  assert.equal((await read()).loading, true); await capture('ranking-loading');
  await page.evaluate(() => window.__designRankFinish({ status: 'ready', entries: [] }));
  await page.waitForFunction(() => !window.__game.rankingLoading); await capture('ranking-empty');
  for (const status of ['unconfigured', 'error', 'unsupported', 'ready']) {
    await page.evaluate(status => {
      const g = window.__game;
      g.leaderboard = { load: async () => ({ status, entries: status === 'ready' ? [
        { rank: 1, nickname: '测试玩家甲', score: 4321 }, { rank: 2, nickname: '测试玩家乙', score: 3210, isSelf: true },
      ] : [], message: `测试状态：${status}` }), submit: async () => ({ status: 'ready', entries: [] }) };
      void g.loadRanking();
    }, status);
    await page.waitForFunction(() => !window.__game.rankingLoading); await capture(`ranking-${status}`);
  }
  await click('rankingTabs', 1); await page.waitForFunction(() => !window.__game.rankingLoading);
  assert.ok((await text()).includes('好友榜')); await capture('ranking-friends'); await click('rankingButtons', 0);
  await click('settingsButton'); await click('settingsButtons', 2);
  for (let index = 0; index < 3; index++) {
    await capture(`map-page-${index + 1}`);
    if (index < 2) await click('levelPageButtons', 1);
  }
  const definition = LEVELS[0];
  for (const stars of [1, 2, 3]) {
    await start(definition);
    await page.evaluate(({ score }) => {
      const g = window.__game;
      g.economy = { ...g.economy, levels: {}, claimedRuns: [], doubledRuns: [], pendingDoubles: [] };
      for (const goal of g.levelDefinition.goals) {
        if (goal.kind === 'lines') g.state.lines = goal.target;
        else if (goal.kind === 'gems') g.state.level.collectedGems = goal.target;
        else if (goal.kind === 'color') g.state.level.clearedColors[goal.color] = goal.target;
      }
      g.state = { ...g.state, score, status: 'won' }; g.finishCampaignVictory();
      g.resultAt = Date.now() - 2000; g.particles = []; g.draw();
    }, { score: stars === 1 ? 0 : definition.starScores[stars - 1] });
    assert.equal((await read()).settlement.stars, stars); await capture(`campaign-win-${stars}-stars`);
  }
  const lost = async () => page.evaluate(() => {
    const g = window.__game;
    g.overlay = null; g.state = { ...g.state, status: 'lost', tutorial: false, moves: 3,
      level: { ...g.state.level },
      board: Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y) % 2)),
      pieces: [{ id: 'blocked-square', color: 0, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, null, null] };
    g.powerUses.revive = 0; g.resultAt = Date.now() - 2000; g.draw();
  });
  await start(definition); await lost(); await capture('campaign-loss-blocked');
  if (!process.argv.includes('--overlays-only')) {
    const labels = await text();
    assert.ok(labels.includes('无处可放'), 'campaign failure comes from blocked placement');
    assert.ok(!labels.some(label => /时间|倒计时|步数已用尽/.test(label)), 'failure has no time or move-budget exhaustion message');
  }
  await lost(); await page.evaluate(() => { window.__game.powerUses.revive = 1; }); await capture('campaign-loss-revive-used');
  await page.evaluate(() => {
    const g = window.__game; g.state = { ...g.state, mode: 'endless', level: undefined, score: 4321 };
    g.bestScore = 5555; g.powerUses.revive = 0; g.draw();
  });
  await capture('endless-loss');
  assert.deepEqual(errors, []);
  await writeFile('.local/qa/design-states/results.json', JSON.stringify({ viewport: [390, 844], dpr: 2, captures, errors }, null, 2) + '\n');
  console.log(`Design state smoke passed: ${captures.length} live Canvas captures with real goals, settings, five acquisition dialogs, all ranking states, maps, one/two/three-star settlements and failure states.`);
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
