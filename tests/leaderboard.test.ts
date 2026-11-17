import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createUnavailableLeaderboard, createWechatLeaderboard } from '../src/services/leaderboard.ts';
import { LEADERBOARD_CONFIG } from '../src/config/leaderboard.ts';
import { LEVELS } from '../src/core/levels.ts';

const enabled = { enabled: true, environmentId: 'owned-environment', functionName: 'leaderboard', friendsOpenData: false };
const score = { levelId: 'level-01', score: 200, stars: 3 };
const require = createRequire(import.meta.url);
const { createHandler, validateSubmission } = require('../cloudfunctions/leaderboard/index.js');

test('browser and unconfigured WeChat leaderboards return no invented people and perform no cloud operations', async () => {
  let operations = 0;
  const wx = { cloud: { init() { operations++; }, callFunction() { operations++; } } };
  const browser = createUnavailableLeaderboard(), wechat = createWechatLeaderboard(wx, LEADERBOARD_CONFIG);
  for (const gateway of [browser, wechat]) {
    assert.deepEqual((await gateway.load('users')).entries, []);
    assert.equal((await gateway.submit(score)).status, 'unconfigured');
  }
  assert.equal(operations, 0);
});

test('ordinary Mini Programs never call Mini Game friend APIs', async () => {
  const gateway = createWechatLeaderboard({ getFriendCloudStorage() { assert.fail('private friend API must not be called'); } }, enabled, 'miniprogram');
  const result = await gateway.load('friends', 'level-01');
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(result.entries, []);
});

test('configured cloud requests use the current level and never send a caller identity', async () => {
  const calls: any[] = [], initializations: any[] = [];
  const wx = { cloud: {
    init(options: any) { initializations.push(options); },
    async callFunction(options: any) { calls.push(options); return { result: { status: 'ready', entries: [
      { rank: 2, nickname: '第二位', score: 100 }, { rank: 1, nickname: ' 我\u0000的分数 ', score: 200, isSelf: true },
      { rank: 3, nickname: 'invalid', score: -1 }, { rank: 4, nickname: '', score: 500 },
    ] } }; },
  } };
  const gateway = createWechatLeaderboard(wx, enabled);
  const result = await gateway.load('users', 'level-01');
  assert.deepEqual(result.entries, [{ rank: 1, nickname: '我的分数', score: 200, isSelf: true }, { rank: 2, nickname: '第二位', score: 100 }]);
  await gateway.load('users');
  await gateway.submit({ ...score, openid: 'forged' } as any);
  assert.deepEqual(initializations, [{ env: 'owned-environment', traceUser: false }]);
  assert.deepEqual(calls[0], { name: 'leaderboard', data: { action: 'list', levelId: 'level-01' } });
  assert.deepEqual(calls[1].data, { action: 'list' });
  assert.deepEqual(calls[2].data, { action: 'submit', ...score });
});

test('invalid scores, unsupported SDKs and cloud failures return explicit empty states', async () => {
  let requests = 0;
  const gateway = createWechatLeaderboard({ cloud: { init() {}, async callFunction() { requests++; throw new Error('offline'); } } }, enabled);
  for (const value of [{ ...score, levelId: 'level-31' }, { ...score, score: 1.5 }, { ...score, score: 21 }, { ...score, stars: 4 }]) {
    assert.equal((await gateway.submit(value)).status, 'error');
  }
  assert.equal(requests, 0);
  assert.equal((await gateway.load('users')).status, 'error');
  assert.equal((await createWechatLeaderboard({}, enabled).load('users')).status, 'unsupported');
  assert.deepEqual((await gateway.load('users', 'unknown')).entries, []);
});

test('a disposed gateway ignores late responses and does not continue drawing shared data', async () => {
  let complete!: (value: any) => void;
  const gateway = createWechatLeaderboard({ cloud: { init() {}, callFunction() { return new Promise(resolve => { complete = resolve; }); } } }, enabled);
  const operation = gateway.load('users');
  gateway.dispose?.();
  complete({ result: { status: 'ready', entries: [{ rank: 1, nickname: 'late', score: 100 }] } });
  assert.deepEqual((await operation).entries, []);
  assert.equal((await gateway.load('users')).status, 'error');
});

test('an unresponsive cloud request ends with a bounded empty failure state', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const gateway = createWechatLeaderboard({ cloud: { init() {}, callFunction() { return new Promise(() => {}); } } }, enabled);
  const operation = gateway.load('users', 'level-01');
  context.mock.timers.tick(12_001);
  const result = await operation;
  assert.equal(result.status, 'error');
  assert.deepEqual(result.entries, []);
});

test('Mini Game friend rows remain in sharedCanvas and only server-confirmed bests are uploaded', async () => {
  const messages: any[] = [], uploads: any[] = [], paints: any[] = [];
  const canvas = {};
  const gateway = createWechatLeaderboard({
    getOpenDataContext: () => ({ canvas, postMessage: (message: any) => messages.push(message) }),
    cloud: { init() {}, async callFunction() { return { result: { status: 'ready', entries: [], bestScore: 300, totalScore: 700 } }; } },
    setUserCloudStorage(options: any) { uploads.push(options.KVDataList); options.success({}); },
  }, { ...enabled, friendsOpenData: true }, 'minigame');
  const result = await gateway.load('friends', 'level-01');
  assert.equal(result.presentation, 'open-data');
  assert.deepEqual(result.entries, [], 'friend profiles must not escape the open-data domain');
  const context = { drawImage: (...args: any[]) => paints.push(args) }, rect = { x: 20, y: 30, w: 250, h: 300 };
  gateway.drawFriends?.(context, rect); gateway.drawFriends?.(context, rect);
  assert.deepEqual(messages, [{ type: 'leaderboard:render', levelId: 'level-01', width: 500, height: 600 }]);
  assert.deepEqual(paints[0], [canvas, 20, 30, 250, 300]);
  await gateway.submit(score);
  assert.deepEqual(uploads, [[{ key: 'level-01', value: '{"score":300}' }, { key: 'overall', value: '{"score":700}' }]]);
  gateway.hideFriends?.(); gateway.drawFriends?.(context, rect);
  assert.equal(paints.length, 2);
});

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function delayedFriendStorage() {
  const cloudReplies: ((value: any) => void)[] = [];
  const stored = new Map<string, any>(), writes: { options: any; values: Record<string, any>; finish: () => void }[] = [];
  let active = 0, maximumActive = 0;
  const gateway = createWechatLeaderboard({
    cloud: { init() {}, callFunction() { return new Promise(resolve => { cloudReplies.push(resolve); }); } },
    setUserCloudStorage(options: any) {
      active++; maximumActive = Math.max(maximumActive, active);
      const values = Object.fromEntries(options.KVDataList.map((entry: any) => [entry.key, JSON.parse(entry.value)]));
      let finished = false;
      writes.push({ options, values, finish() {
        if (!finished) { finished = true; active--; for (const [key, value] of Object.entries(values)) stored.set(key, value); }
        options.success({});
      } });
    },
  }, { ...enabled, friendsOpenData: true }, 'minigame');
  return { gateway, writes, stored, maximumActive: () => maximumActive,
    reply(index: number, bestScore: number, totalScore = bestScore, achievedAt?: number) {
      cloudReplies[index]({ result: { status: 'ready', entries: [], bestScore, totalScore,
        ...(achievedAt ? { bestAchievedAt: achievedAt, totalAchievedAt: achievedAt } : {}) } });
    }, cloudCount: () => cloudReplies.length };
}

test('out-of-order cloud replies cannot lower the overall friend score and SDK writes never overlap', async () => {
  const h = delayedFriendStorage();
  const old = h.gateway.submit({ levelId: 'level-01', score: 100, stars: 2 });
  const recent = h.gateway.submit({ levelId: 'level-02', score: 300, stars: 3 });
  h.reply(1, 300, 300, 200); await flush();
  assert.equal(h.writes.length, 1);
  h.reply(0, 100, 100, 100); await flush();
  assert.equal(h.writes.length, 1, 'the old cloud reply waits for the active SDK write');
  h.writes[0].finish(); await flush();
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.writes[1].values.overall, { score: 300, achievedAt: 200 }, 'a lower stale total cannot replace the timestamp attached to the actual maximum');
  h.writes[1].finish();
  await Promise.all([old, recent]);
  assert.equal(h.stored.get('overall').score, 300);
  assert.equal(h.maximumActive(), 1);
});

test('queued writes merge the latest per-level and total maxima when they actually start', async () => {
  const h = delayedFriendStorage();
  const submissions = [100, 200, 300, 50].map(value => h.gateway.submit({ levelId: 'level-01', score: value, stars: 1 }));
  h.reply(0, 100, 100, 10); await flush();
  h.reply(1, 200, 200, 20); await flush();
  h.reply(2, 300, 300, 30); await flush();
  assert.equal(h.writes.length, 1);
  h.writes[0].finish(); await flush();
  assert.deepEqual(h.writes[1].values, { 'level-01': { score: 300, achievedAt: 30 }, overall: { score: 300, achievedAt: 30 } },
    'the queued 200-point response must read the newer 300-point maximum at write time');
  h.writes[0].options.success({}); await flush();
  assert.equal(h.writes.length, 2, 'a duplicate old callback cannot release the currently active write');
  h.writes[1].finish(); await flush();
  h.writes[2].finish(); await flush();
  h.reply(3, 50, 50, 5); await flush();
  assert.equal(h.writes[3].values['level-01'].score, 300, 'a late older response cannot roll back the level maximum');
  assert.equal(h.writes[3].values.overall.score, 300);
  h.writes[3].finish();
  await Promise.all(submissions);
  assert.equal(h.stored.get('level-01').score, 300);
  assert.equal(h.stored.get('overall').score, 300);
  assert.equal(h.maximumActive(), 1);
});

test('dispose stops queued friend writes while allowing the already-started SDK call to finish', async () => {
  const h = delayedFriendStorage();
  const first = h.gateway.submit({ levelId: 'level-01', score: 100, stars: 1 });
  const queued = h.gateway.submit({ levelId: 'level-01', score: 200, stars: 2 });
  h.reply(0, 100); await flush();
  h.reply(1, 200); await flush();
  h.gateway.dispose?.();
  assert.equal((await first).status, 'error');
  assert.equal((await queued).status, 'error');
  assert.equal(h.writes.length, 1);
  h.writes[0].finish(); await flush();
  assert.equal(h.writes.length, 1, 'the queued SDK call must not start after disposal');
  assert.equal(h.stored.get('level-01').score, 100, 'an SDK call already in flight cannot be cancelled by the gateway');
  assert.equal((await h.gateway.submit({ levelId: 'level-01', score: 300, stars: 3 })).status, 'error');
  assert.equal(h.cloudCount(), 2);
});

test('an SDK timeout does not release the serialization lock before its late completion', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = delayedFriendStorage();
  const first = h.gateway.submit({ levelId: 'level-01', score: 100, stars: 1 });
  h.reply(0, 100); await flush();
  context.mock.timers.tick(12_001); await flush();
  assert.ok((await first).message?.includes('好友榜'));
  const queued = h.gateway.submit({ levelId: 'level-01', score: 200, stars: 2 });
  h.reply(1, 200); await flush();
  assert.equal(h.writes.length, 1, 'a timed-out but still-running SDK write cannot overlap a newer one');
  context.mock.timers.tick(12_001); await flush();
  assert.ok((await queued).message?.includes('好友榜'));
  h.writes[0].finish(); await flush();
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].values['level-01'].score, 200);
  h.writes[1].finish(); await flush();
  assert.equal(h.stored.get('overall').score, 200);
  assert.equal(h.maximumActive(), 1);
});

const limits = { 'level-01': { maxMoves: 21, starScores: [0, 100, 200] }, 'level-02': { maxMoves: 24, starScores: [0, 100, 200] } };
function cloudFixture(openid = 'actor-1') {
  const data = new Map<string, any>();
  let transactions = 0;
  const collection = (name: string) => {
    let filter: Record<string, unknown> = {}, orders: [string, string][] = [], maximum = 50;
    const query: any = {
      doc(id: string) { return {
        async get() { if (!data.has(`${name}/${id}`)) throw new Error('document does not exist'); return { data: structuredClone(data.get(`${name}/${id}`)) }; },
        async set(value: any) { data.set(`${name}/${id}`, { ...structuredClone(value.data), _id: id }); },
      }; },
      where(value: any) { filter = value; return query; },
      orderBy(field: string, direction: string) { orders.push([field, direction]); return query; },
      limit(value: number) { maximum = value; return query; },
      async get() {
        const rows = [...data].filter(([id, row]) => id.startsWith(`${name}/`) && Object.entries(filter).every(([key, value]) => row[key] === value)).map(([, row]) => structuredClone(row));
        rows.sort((a, b) => { for (const [field, direction] of orders) { if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * (direction === 'desc' ? -1 : 1); } return 0; });
        return { data: rows.slice(0, maximum) };
      },
    };
    return query;
  };
  const db: any = { collection, async runTransaction(callback: any) { transactions++; return callback({ collection }); } };
  const cloud = { getWXContext: () => ({ APPID: 'wx-owned', OPENID: openid }), database: () => db };
  return { data, cloud, db, transactionCount: () => transactions };
}

test('cloud score validation derives stars from the deployment thresholds rather than trusting a star count', () => {
  assert.equal(validateSubmission(score, limits), true);
  assert.equal(validateSubmission({ ...score, score: 100, stars: 3 }, limits), false);
  assert.equal(validateSubmission({ ...score, score: 50_000 }, limits), false);
  assert.equal(validateSubmission({ ...score, levelId: 'level-31' }, limits), false);
});

test('cloud score bounds include a configured countdown bonus while legacy limits default to zero', () => {
  const timed = { 'level-01': { maxMoves: 1, starScores: [0, 100, 200], maxTimeBonus: 1500 } };
  assert.equal(validateSubmission({ ...score, score: 1830 }, timed), true);
  assert.equal(validateSubmission({ ...score, score: 1840 }, timed), false);
  assert.equal(validateSubmission({ ...score, score: 330 }, { 'level-01': { maxMoves: 1, starScores: [0, 100, 200] } }), true);
  assert.equal(validateSubmission({ ...score, score: 340 }, { 'level-01': { maxMoves: 1, starScores: [0, 100, 200] } }), false);
  for (const bonus of [-1, NaN, Infinity, .5]) {
    assert.equal(validateSubmission(score, { 'level-01': { ...timed['level-01'], maxTimeBonus: bonus } }), false);
  }
});

test('the deployment star thresholds match the current thirty authored levels', () => {
  const deployed = JSON.parse(readFileSync(new URL('../cloudfunctions/leaderboard/levels.json', import.meta.url), 'utf8'));
  assert.deepEqual(deployed, Object.fromEntries(LEVELS.map(level => [level.id, { maxMoves: level.maxMoves, starScores: level.starScores,
    maxTimeBonus: typeof level.timeLimitSeconds === 'number' ? Math.ceil(level.timeLimitSeconds) * 10 : 0 }])));
});

test('cloud function uses WeChat identity and transactionally stores per-level maxima and the sum of bests', async () => {
  const fixture = cloudFixture(), handle = createHandler(fixture.cloud, { appId: 'wx-owned', levels: limits });
  assert.equal((await handle({ action: 'submit', ...score, openid: 'forged-user', owner: 'forged-owner' })).status, 'ready');
  await handle({ action: 'submit', ...score, score: 100, stars: 2 });
  const result = await handle({ action: 'submit', levelId: 'level-02', score: 300, stars: 3 });
  assert.equal(result.totalScore, 500, 'a lower replay must not reduce or accumulate the prior best');
  const overall = await handle({ action: 'list' }), level = await handle({ action: 'list', levelId: 'level-01' });
  assert.equal(overall.entries[0].score, 500);
  assert.equal(level.entries[0].score, 200);
  assert.equal(level.entries[0].isSelf, true);
  assert.ok(overall.entries[0].nickname.startsWith('玩家'));
  assert.ok([...fixture.data.keys()].every(key => !key.includes('forged')));
  assert.equal(fixture.transactionCount(), 3);
  assert.equal((await createHandler(fixture.cloud, { appId: 'wrong', levels: limits })({ action: 'list' })).status, 'error');
});

test('cloud list ordering uses score, earlier achievement and a stable record tie breaker', async () => {
  const fixture = cloudFixture();
  fixture.data.set('wood_block_scores/z', { _id: 'z', owner: 'z', levelId: 'level-01', nickname: '晚到', score: 200, achievedAt: 2 });
  fixture.data.set('wood_block_scores/b', { _id: 'b', owner: 'b', levelId: 'level-01', nickname: '同分乙', score: 200, achievedAt: 1 });
  fixture.data.set('wood_block_scores/a', { _id: 'a', owner: 'a', levelId: 'level-01', nickname: '同分甲', score: 200, achievedAt: 1 });
  const result = await createHandler(fixture.cloud, { appId: 'wx-owned', levels: limits })({ action: 'list', levelId: 'level-01' });
  assert.deepEqual(result.entries.map((row: any) => row.nickname), ['同分甲', '同分乙', '晚到']);
  assert.deepEqual(result.entries.map((row: any) => row.rank), [1, 2, 3]);
  assert.ok(result.entries.every((row: any) => !('owner' in row) && !('openid' in row)));
});
