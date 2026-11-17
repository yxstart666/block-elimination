import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { REWARDED_AD_UNITS } from '../src/config/ads.ts';
import { CAMPAIGN_STORAGE_KEY, sanitizeCampaign } from '../src/services/campaign.ts';
import { ECONOMY_STORAGE_KEY, sanitizeEconomy } from '../src/services/economy.ts';
import { createUnavailableLeaderboard, createWechatLeaderboard } from '../src/services/leaderboard.ts';
import { LEADERBOARD_CONFIG } from '../src/config/leaderboard.ts';
import { isBrowserTestConvenience, isBrowserTestUnlock, isWechatTestUnlock } from '../src/services/testing.ts';

type Call = { method: string; args: any[] };

function harness(name: 'wechat-miniprogram' | 'wechat-game', options: { menu?: any; menuError?: boolean; safeArea?: any; storedBest?: unknown; storedTutorialSeen?: unknown; storedCampaign?: unknown; storedEconomy?: unknown; envVersion?: unknown; accountInfoError?: boolean; storageReadError?: boolean; storageWriteError?: boolean; storageMissing?: boolean } = {}) {
  const instances: { options: any; calls: Call[] }[] = [];
  const storageReads: string[] = [];
  const storageWrites: { key: string; value: unknown }[] = [];
  const gateways: { wx: any; units: any; gateway: any }[] = [];
  const createWechatRewarded = (wx: any, units: any) => {
    const gateway = { request: async () => 'unavailable', dispose() {} };
    gateways.push({ wx, units, gateway });
    return gateway;
  };
  class GameApp {
    calls: Call[] = [];
    options: any;
    constructor(options: any) { this.options = options; instances.push(this); }
    pointerDown(...args: any[]) { this.calls.push({ method: 'down', args }); }
    pointerMove(...args: any[]) { this.calls.push({ method: 'move', args }); }
    pointerUp(...args: any[]) { this.calls.push({ method: 'up', args }); }
    pointerCancel() { this.calls.push({ method: 'cancel', args: [] }); }
    resize(...args: any[]) { this.calls.push({ method: 'resize', args }); }
    pause() { this.calls.push({ method: 'pause', args: [] }); }
    resume() { this.calls.push({ method: 'resume', args: [] }); }
    destroy() { this.calls.push({ method: 'destroy', args: [] }); }
  }
  const queries: ((value: any[]) => void)[] = [];
  const listeners = new Map<string, Set<Function>>();
  const info: any = {
    windowWidth: 390, windowHeight: 844, screenHeight: 844,
    pixelRatio: 3, statusBarHeight: 47, safeArea: options.safeArea === undefined ? { top: 47, bottom: 810 } : options.safeArea,
  };
  const canvas = { requestAnimationFrame: () => 5, cancelAnimationFrame() {} };
  const wx: any = {
    getAccountInfoSync: () => { if (options.accountInfoError) throw new Error('account unavailable'); return { miniProgram: { envVersion: options.envVersion } }; },
    getWindowInfo: () => info,
    getMenuButtonBoundingClientRect: () => { if (options.menuError) throw new Error('menu unavailable'); return options.menu === undefined ? { top: 48, height: 32, bottom: 80 } : options.menu; },
    createCanvas: () => canvas,
    getStorageSync: (key: string) => {
      storageReads.push(key);
      if (options.storageReadError) throw new Error('storage unavailable');
      if (key === 'wood-blocks.tutorial-seen.v1') return options.storedTutorialSeen;
      if (key === CAMPAIGN_STORAGE_KEY) return options.storedCampaign;
      if (key === ECONOMY_STORAGE_KEY) return options.storedEconomy;
      return key === 'wood-blocks.best.v1' ? options.storedBest : undefined;
    },
    setStorageSync: (key: string, value: unknown) => {
      if (options.storageWriteError) throw new Error('storage full');
      storageWrites.push({ key, value });
    },
    createSelectorQuery: () => {
      const query: any = {
        in: () => query, select: () => query, fields: () => query,
        exec: (callback: (value: any[]) => void) => queries.push(callback),
      };
      return query;
    },
  };
  if (options.storageMissing) { delete wx.getStorageSync; delete wx.setStorageSync; }
  for (const event of ['TouchStart', 'TouchMove', 'TouchEnd', 'TouchCancel', 'Hide', 'Show', 'WindowResize']) {
    listeners.set(event, new Set());
    wx[`on${event}`] = (callback: Function) => listeners.get(event)!.add(callback);
    wx[`off${event}`] = (callback: Function) => listeners.get(event)!.delete(callback);
  }
  let page: any;
  const source = readFileSync(new URL(`../src/platform/${name}.ts`, import.meta.url), 'utf8')
    .replace(/^import .* from .*;\s*/gm, '')
    .replace(/export function /g, 'function ');
  const context: any = vm.createContext({
    wx, GameApp, createWechatRewarded, REWARDED_AD_UNITS, CAMPAIGN_STORAGE_KEY, sanitizeCampaign, ECONOMY_STORAGE_KEY, sanitizeEconomy,
    createWechatLeaderboard, LEADERBOARD_CONFIG, isWechatTestUnlock, Page: (options: any) => { page = options; },
    requestAnimationFrame: () => 5, cancelAnimationFrame() {},
  });
  vm.runInContext(stripTypeScriptTypes(source), context);
  if (page) {
    page.setData = (data: any) => { page.data = { ...page.data, ...data }; };
    page.onLoad();
  }
  return {
    page, instances, queries, canvas, info, context, listeners, gateways, storageReads, storageWrites,
    emit(event: string, value?: any) { listeners.get(event)?.forEach(callback => callback(value)); },
    measure(index = 0, width = 390, height = 844, top = 20) {
      queries[index]([{ node: canvas, width, height, left: 10, top }]);
    },
  };
}

test('小程序将逻辑触摸坐标传给游戏，并忽略第二根手指', () => {
  const h = harness('wechat-miniprogram');
  h.page.onReady();
  h.measure();
  assert.equal(h.instances.length, 1);
  const game = h.instances[0];
  assert.equal(game.options.pixelRatio, 3);
  assert.equal(game.options.safeBottom, 34);
  assert.equal(game.options.safeTop, 27);
  assert.equal(game.options.headerCenterY, 44);
  h.page.onTouchStart({ changedTouches: [{ identifier: 1, x: 30, y: 40 }] });
  h.page.onTouchStart({ changedTouches: [{ identifier: 2, x: 90, y: 100 }] });
  h.page.onTouchMove({ touches: [{ identifier: 2, x: 90, y: 100 }, { identifier: 1, x: 50, y: 60 }] });
  h.page.onTouchEnd({ changedTouches: [{ identifier: 2, x: 90, y: 100 }] });
  h.page.onTouchEnd({ changedTouches: [{ identifier: 1, x: 70, y: 80 }] });
  assert.deepEqual(game.calls, [
    { method: 'down', args: [30, 40, true] },
    { method: 'move', args: [50, 60] },
    { method: 'up', args: [70, 80] },
  ]);
  h.page.onTouchStart({ changedTouches: [{ identifier: 3, clientX: 110, clientY: 220 }] });
  assert.deepEqual(game.calls.at(-1), { method: 'down', args: [100, 200, true] });
  h.page.onTouchCancel();
  assert.equal(game.calls.at(-1)?.method, 'cancel');
});

test('小程序隐藏时取消拖动并暂停，重新显示恢复，卸载释放', () => {
  const h = harness('wechat-miniprogram');
  h.page.onReady();
  h.page.onHide();
  h.measure();
  const game = h.instances[0];
  assert.equal(game.calls.at(-1)?.method, 'pause');
  h.page.onShow();
  assert.equal(game.calls.at(-1)?.method, 'resume');
  h.page.onHide();
  assert.deepEqual(game.calls.slice(-2).map(call => call.method), ['cancel', 'pause']);
  h.page.onUnload();
  assert.equal(game.calls.at(-1)?.method, 'destroy');
});

test('小程序丢弃过期测量结果，卸载后的异步查询不能再创建游戏', () => {
  const h = harness('wechat-miniprogram');
  h.page.onReady();
  h.page.onResize();
  h.measure(0);
  assert.equal(h.instances.length, 0);
  h.measure(1);
  assert.equal(h.instances.length, 1);
  h.page.onResize();
  h.measure(2, 320, 640);
  const resize = h.instances[0].calls.at(-1)!;
  assert.equal(resize.method, 'resize');
  assert.deepEqual(resize.args.slice(0, 3), [320, 640, 3]);
  assert.deepEqual(resize.args.slice(3), [27, 34, 44]);
  h.page.onResize();
  h.page.onUnload();
  h.measure(3);
  assert.equal(h.instances.length, 1);
  assert.equal(h.instances[0].calls.at(-1)?.method, 'destroy');
});

test('小游戏绑定触摸和生命周期，并在销毁时解绑', () => {
  const h = harness('wechat-game');
  const game = h.instances[0];
  assert.equal(game.options.safeTop, 47);
  assert.equal(game.options.safeBottom, 34);
  assert.equal(game.options.headerCenterY, 64);
  h.emit('TouchStart', { changedTouches: [{ identifier: 1, clientX: 50, clientY: 60 }] });
  h.emit('TouchStart', { changedTouches: [{ identifier: 2, clientX: 150, clientY: 160 }] });
  h.emit('TouchMove', { touches: [{ identifier: 1, clientX: 70, clientY: 80 }] });
  h.emit('TouchEnd', { changedTouches: [{ identifier: 1, clientX: 90, clientY: 100 }] });
  assert.deepEqual(game.calls, [
    { method: 'down', args: [50, 60, true] },
    { method: 'move', args: [70, 80] },
    { method: 'up', args: [90, 100] },
  ]);
  h.emit('Hide');
  assert.deepEqual(game.calls.slice(-2).map(call => call.method), ['cancel', 'pause']);
  h.emit('Show');
  assert.equal(game.calls.at(-1)?.method, 'resume');
  h.info.windowWidth = 320;
  h.info.windowHeight = 640;
  h.emit('WindowResize');
  assert.deepEqual(game.calls.at(-1)?.args.slice(0, 3), [320, 640, 3]);
  assert.deepEqual(game.calls.at(-1)?.args.slice(3), [47, 34, 64]);
  const dispose = h.context.mountWechatGame();
  for (const callbacks of h.listeners.values()) assert.equal(callbacks.size, 2);
  dispose();
  for (const callbacks of h.listeners.values()) assert.equal(callbacks.size, 1);
  assert.equal(h.instances[1].calls.at(-1)?.method, 'destroy');
});

test('小程序胶囊坐标扣除画布偏移，安全区取刘海与状态栏较大值', () => {
  const h = harness('wechat-miniprogram', { menu: { top: 54, bottom: 86 }, safeArea: { top: 52, bottom: 810 } });
  h.page.onReady(); h.measure(0, 390, 824, 20);
  assert.equal(h.instances[0].options.safeTop, 32);
  assert.equal(h.instances[0].options.headerCenterY, 50);
  assert.equal(h.instances[0].options.safeBottom, 34);
});

test('胶囊缺失或异常时两端保留刘海和底部安全区，并使用标题默认布局', () => {
  for (const name of ['wechat-miniprogram', 'wechat-game'] as const) {
    for (const menu of [null, { top: 0, height: 32, bottom: 32 }, { top: 48, height: 0, bottom: 48 }, { top: 900, height: 32 }]) {
      const h = harness(name, { menu });
      if (h.page) { h.page.onReady(); h.measure(0, 390, 844, 0); }
      assert.equal(h.instances[0].options.safeTop, 47);
      assert.equal(h.instances[0].options.safeBottom, 34);
      assert.equal(h.instances[0].options.headerCenterY, undefined);
    }
    const h = harness(name, { menuError: true, safeArea: null });
    if (h.page) { h.page.onReady(); h.measure(0, 390, 844, 0); }
    assert.equal(h.instances[0].options.safeTop, 47);
    assert.equal(h.instances[0].options.safeBottom, 0);
    assert.equal(h.instances[0].options.headerCenterY, undefined);
  }
});

test('两个微信入口注入真实广告网关，空ID关闭奖励视频入口且resize不重复创建', () => {
  for (const name of ['wechat-miniprogram', 'wechat-game'] as const) {
    const h = harness(name);
    if (h.page) { h.page.onReady(); h.measure(); }
    const game = h.instances[0];
    assert.equal(h.gateways.length, 1);
    assert.equal(game.options.rewarded, h.gateways[0].gateway);
    assert.equal(h.gateways[0].units, REWARDED_AD_UNITS);
    assert.deepEqual({ ...game.options.rewardedEnabled }, { revive: false, refresh: false, rotate: false, bomb: false, bulldozer: false, hint: false, doubleCoins: false });
    if (h.page) { h.page.onResize(); h.measure(1, 320, 640); }
    else h.emit('WindowResize');
    assert.equal(h.gateways.length, 1, 'resizing reuses the same GameApp and ad gateway');
    assert.equal(h.instances.length, 1);
  }
});

test('最高分只在创建时读取，破纪录回调写本地，存储异常不影响游戏', () => {
  for (const name of ['wechat-miniprogram', 'wechat-game'] as const) {
    const h = harness(name, { storedBest: '1516' });
    if (h.page) { h.page.onReady(); h.measure(); }
    const game = h.instances[0];
    assert.equal(game.options.initialBest, 1516);
    assert.deepEqual(h.storageReads, ['wood-blocks.best.v1', 'wood-blocks.tutorial-seen.v1', CAMPAIGN_STORAGE_KEY, ECONOMY_STORAGE_KEY]);
    assert.deepEqual(h.storageWrites, []);
    game.options.onBest(1600);
    assert.deepEqual(h.storageWrites, [{ key: 'wood-blocks.best.v1', value: 1600 }]);
    if (h.page) { h.page.onResize(); h.measure(1, 320, 640); }
    else h.emit('WindowResize');
    assert.equal(h.storageReads.length, 4, 'resizing does not reload the score, tutorial, campaign or economy storage');
    for (const value of [-1, 1.5, Infinity, NaN]) game.options.onBest(value);
    assert.equal(h.storageWrites.length, 1, 'invalid records are never persisted');

    for (const storedBest of [-10, 2.5, Infinity, NaN, 'broken', '', null, {}, true]) {
      const invalid = harness(name, { storedBest });
      if (invalid.page) { invalid.page.onReady(); invalid.measure(); }
      assert.equal(invalid.instances[0].options.initialBest, 0);
    }
    for (const options of [{ storageMissing: true }, { storageReadError: true, storageWriteError: true }]) {
      const unavailable = harness(name, options);
      if (unavailable.page) { unavailable.page.onReady(); unavailable.measure(); }
      assert.equal(unavailable.instances[0].options.initialBest, 0);
      assert.doesNotThrow(() => unavailable.instances[0].options.onBest(80));
    }
  }
});

test('两个微信入口分别保存教学已出现标记，已看过时跳过教学且不改最高分', () => {
  for (const name of ['wechat-miniprogram', 'wechat-game'] as const) {
    const h = harness(name, { storedBest: 120, storedTutorialSeen: true });
    if (h.page) { h.page.onReady(); h.measure(); }
    const game = h.instances[0];
    assert.equal(game.options.tutorialSeen, true);
    assert.equal(game.options.initialBest, 120);
    assert.equal(typeof game.options.onTutorialSeen, 'function');
    assert.deepEqual(h.storageWrites, []);
    game.options.onTutorialSeen();
    assert.deepEqual(h.storageWrites, [{ key: 'wood-blocks.tutorial-seen.v1', value: true }]);
    game.options.onBest(150);
    assert.deepEqual(h.storageWrites[1], { key: 'wood-blocks.best.v1', value: 150 });
    if (h.page) { h.page.onResize(); h.measure(1, 320, 640); }
    else h.emit('WindowResize');
    assert.deepEqual(h.storageReads, ['wood-blocks.best.v1', 'wood-blocks.tutorial-seen.v1', CAMPAIGN_STORAGE_KEY, ECONOMY_STORAGE_KEY], 'resizing reuses the tutorial decision');
  }
});

test('教学标记缺失或存储异常时仍可进入游戏，写入异常不会中断', () => {
  for (const name of ['wechat-miniprogram', 'wechat-game'] as const) {
    for (const storedTutorialSeen of [undefined, null, false, '', 'true', 1, {}]) {
      const h = harness(name, { storedTutorialSeen });
      if (h.page) { h.page.onReady(); h.measure(); }
      assert.equal(h.instances[0].options.tutorialSeen, false);
      assert.doesNotThrow(() => h.instances[0].options.onTutorialSeen());
      assert.deepEqual(h.storageWrites, [{ key: 'wood-blocks.tutorial-seen.v1', value: true }]);
    }
    for (const options of [{ storageMissing: true }, { storageReadError: true, storageWriteError: true }]) {
      const h = harness(name, options);
      if (h.page) { h.page.onReady(); h.measure(); }
      assert.equal(h.instances[0].options.tutorialSeen, false);
      assert.doesNotThrow(() => h.instances[0].options.onTutorialSeen());
      assert.deepEqual(h.storageWrites, []);
    }
  }
});

test('两个微信入口读取并保存闯关进度，重新创建恢复且resize不重读', () => {
  const saved = { version: 1, completed: ['level-02', 'level-01', 'unknown'], lessonsSeen: ['level-01', 'level-04'] };
  for (const name of ['wechat-miniprogram', 'wechat-game'] as const) {
    const h = harness(name, { storedCampaign: saved });
    if (h.page) { h.page.onReady(); h.measure(); }
    const options = h.instances[0].options;
    assert.deepEqual(options.initialCampaign, sanitizeCampaign(saved));
    assert.equal(typeof options.onCampaignChange, 'function');
    const advanced = { version: 1, completed: ['level-01', 'level-02', 'level-03'], lessonsSeen: ['level-01', 'level-04'] };
    options.onCampaignChange(advanced);
    assert.deepEqual(h.storageWrites, [{ key: CAMPAIGN_STORAGE_KEY, value: advanced }]);
    if (h.page) { h.page.onResize(); h.measure(1, 320, 640); }
    else h.emit('WindowResize');
    assert.equal(h.storageReads.filter(key => key === CAMPAIGN_STORAGE_KEY).length, 1);
    const reopened = harness(name, { storedCampaign: h.storageWrites[0].value });
    if (reopened.page) { reopened.page.onReady(); reopened.measure(); }
    assert.deepEqual(reopened.instances[0].options.initialCampaign, advanced);
  }
});

test('闯关存档损坏或微信存储不可用时不阻断游戏', () => {
  for (const name of ['wechat-miniprogram', 'wechat-game'] as const) {
    for (const storedCampaign of [null, 'broken', { version: 2, completed: ['level-01'] }]) {
      const h = harness(name, { storedCampaign });
      if (h.page) { h.page.onReady(); h.measure(); }
      assert.deepEqual(h.instances[0].options.initialCampaign, sanitizeCampaign(null));
    }
    for (const options of [{ storageMissing: true }, { storageReadError: true, storageWriteError: true }]) {
      const h = harness(name, options);
      if (h.page) { h.page.onReady(); h.measure(); }
      assert.deepEqual(h.instances[0].options.initialCampaign, sanitizeCampaign(null));
      assert.doesNotThrow(() => h.instances[0].options.onCampaignChange({ version: 1, completed: ['level-01'], lessonsSeen: [] }));
      assert.deepEqual(h.storageWrites, []);
    }
  }
});

function browserStorageHarness(storedCampaign?: unknown, failStorage = false, storedEconomy?: unknown, preview: { hostname?: string; search?: string } = {}) {
  const storage = new Map<string, string>();
  if (storedCampaign !== undefined) storage.set(CAMPAIGN_STORAGE_KEY, typeof storedCampaign === 'string' ? storedCampaign : JSON.stringify(storedCampaign));
  if (storedEconomy !== undefined) storage.set(ECONOMY_STORAGE_KEY, typeof storedEconomy === 'string' ? storedEconomy : JSON.stringify(storedEconomy));
  const instances: { options: any }[] = [];
  const canvas = { parentElement: { clientWidth: 390, clientHeight: 844 }, addEventListener() {} };
  const context = vm.createContext({
    GameApp: class { constructor(options: any) { instances.push({ options }); } },
    createUnavailableRewarded: () => ({}), CAMPAIGN_STORAGE_KEY, sanitizeCampaign, ECONOMY_STORAGE_KEY, sanitizeEconomy, createUnavailableLeaderboard, isBrowserTestUnlock, isBrowserTestConvenience,
    document: { querySelector: (selector: string) => selector === '#game' ? canvas : {}, addEventListener() {} },
    window: { devicePixelRatio: 1, addEventListener() {} },
    localStorage: {
      getItem(key: string) { if (failStorage) throw new Error('read blocked'); return storage.get(key) ?? null; },
      setItem(key: string, value: string) { if (failStorage) throw new Error('write blocked'); storage.set(key, value); },
    },
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    URLSearchParams, location: { search: preview.search ?? '', hostname: preview.hostname },
  });
  const source = readFileSync(new URL('../src/platform/browser.ts', import.meta.url), 'utf8').replace(/^import .* from .*;\s*/gm, '');
  vm.runInContext(stripTypeScriptTypes(source), context);
  return { options: instances[0].options, storage };
}

test('浏览器闯关进度以JSON持久化，重新打开恢复且存储失败可继续', () => {
  const first = browserStorageHarness();
  assert.deepEqual(first.options.initialCampaign, sanitizeCampaign(null));
  const progress = { version: 1, completed: ['level-01', 'level-02'], lessonsSeen: ['level-01'] };
  first.options.onCampaignChange(progress);
  const stored = first.storage.get(CAMPAIGN_STORAGE_KEY)!;
  assert.deepEqual(JSON.parse(stored), progress);
  const reopened = browserStorageHarness(stored);
  assert.deepEqual(reopened.options.initialCampaign, progress);
  assert.deepEqual(browserStorageHarness('broken').options.initialCampaign, sanitizeCampaign(null));
  const restricted = browserStorageHarness(progress, true);
  assert.deepEqual(restricted.options.initialCampaign, sanitizeCampaign(null));
  assert.doesNotThrow(() => restricted.options.onCampaignChange(progress));
});

test('两微信入口持久保存金币和道具，重开恢复且窗口变化不重新读取', () => {
  const saved = sanitizeEconomy({ version: 1, coins: 120, inventory: { hint: 2, rotate: 4, refresh: 1 }, levels: {}, claimedRuns: [], doubledRuns: [], pendingDoubles: [] });
  for (const name of ['wechat-miniprogram', 'wechat-game'] as const) {
    const h = harness(name, { storedEconomy: saved });
    if (h.page) { h.page.onReady(); h.measure(); }
    const options = h.instances[0].options;
    assert.deepEqual(options.initialEconomy, saved);
    assert.equal(typeof options.leaderboard.load, 'function');
    const changed = { ...saved, coins: 140, inventory: { ...saved.inventory, hint: 1 } };
    options.onEconomyChange(changed);
    assert.deepEqual(h.storageWrites, [{ key: ECONOMY_STORAGE_KEY, value: changed }]);
    if (h.page) { h.page.onResize(); h.measure(1, 320, 640); } else h.emit('WindowResize');
    assert.equal(h.storageReads.filter(key => key === ECONOMY_STORAGE_KEY).length, 1);
    const reopened = harness(name, { storedEconomy: h.storageWrites[0].value });
    if (reopened.page) { reopened.page.onReady(); reopened.measure(); }
    assert.deepEqual(reopened.instances[0].options.initialEconomy, changed);
  }
});

test('金币存储损坏或无法读写不阻断微信入口，也不覆盖最高分或关卡存档', () => {
  for (const name of ['wechat-miniprogram', 'wechat-game'] as const) {
    for (const storedEconomy of ['invalid', { version: 9, coins: 9999 }, null]) {
      const h = harness(name, { storedEconomy, storedBest: 400, storedCampaign: { version: 1, completed: ['level-01'], lessonsSeen: [] } });
      if (h.page) { h.page.onReady(); h.measure(); }
      assert.deepEqual(h.instances[0].options.initialEconomy, sanitizeEconomy(null));
      assert.equal(h.instances[0].options.initialBest, 400);
      assert.deepEqual(h.instances[0].options.initialCampaign.completed, ['level-01']);
    }
    for (const options of [{ storageMissing: true }, { storageReadError: true, storageWriteError: true }]) {
      const h = harness(name, options);
      if (h.page) { h.page.onReady(); h.measure(); }
      assert.doesNotThrow(() => h.instances[0].options.onEconomyChange(sanitizeEconomy(null)));
      assert.deepEqual(h.storageWrites, []);
    }
  }
});

test('浏览器金币与道具使用独立JSON存档，存储失败仍保留安全的会话初值', () => {
  const first = browserStorageHarness();
  const changed = sanitizeEconomy({ version: 1, coins: 50, inventory: { hint: 1, rotate: 2, refresh: 3 }, levels: {}, claimedRuns: [], doubledRuns: [], pendingDoubles: [] });
  assert.deepEqual(first.options.initialEconomy, sanitizeEconomy(null));
  first.options.onEconomyChange(changed);
  const stored = first.storage.get(ECONOMY_STORAGE_KEY)!;
  assert.deepEqual(JSON.parse(stored), changed);
  assert.deepEqual(browserStorageHarness(undefined, false, stored).options.initialEconomy, changed);
  assert.deepEqual(browserStorageHarness(undefined, false, 'invalid').options.initialEconomy, sanitizeEconomy(null));
  const restricted = browserStorageHarness(undefined, true, stored);
  assert.deepEqual(restricted.options.initialEconomy, sanitizeEconomy(null));
  assert.doesNotThrow(() => restricted.options.onEconomyChange(changed));
});

test('平台仅在明确测试环境注入全解锁，不改动真实通关存档', () => {
  for (const name of ['wechat-miniprogram', 'wechat-game'] as const) {
    for (const envVersion of ['develop', 'trial', 'release', undefined]) {
      const h = harness(name, { envVersion });
      if (h.page) { h.page.onReady(); h.measure(); }
      assert.equal(h.instances[0].options.testUnlockAll, envVersion === 'develop' || envVersion === 'trial');
      assert.equal(h.instances[0].options.testConvenience, envVersion === 'develop' || envVersion === 'trial');
      assert.deepEqual(h.instances[0].options.initialCampaign.completed, []);
      assert.deepEqual(h.storageWrites, []);
    }
    const unavailable = harness(name, { accountInfoError: true });
    if (unavailable.page) { unavailable.page.onReady(); unavailable.measure(); }
    assert.equal(unavailable.instances[0].options.testUnlockAll, false);
    assert.equal(unavailable.instances[0].options.testConvenience, false);
  }
  const local = browserStorageHarness(undefined, false, undefined, { hostname: '127.0.0.1', search: '?unlock=all' });
  assert.equal(local.options.testUnlockAll, true);
  assert.equal(local.options.testConvenience, true);
  assert.deepEqual(local.options.initialCampaign.completed, []);
  assert.equal(local.storage.size, 0);
  assert.equal(browserStorageHarness(undefined, false, undefined, { hostname: 'example.com', search: '?unlock=all' }).options.testUnlockAll, false);
});

test('browser test convenience is independent of unlock progress and explicitly disabled for real-flow checks', () => {
  const local = browserStorageHarness(undefined, false, undefined, { hostname: 'localhost', search: '' });
  assert.equal(local.options.testConvenience, true);
  assert.equal(local.options.testUnlockAll, false);
  assert.equal(local.storage.size, 0);
  const realFlow = browserStorageHarness(undefined, false, undefined, { hostname: '127.0.0.1', search: '?unlock=all&test=off' });
  assert.equal(realFlow.options.testConvenience, false);
  assert.equal(realFlow.options.testUnlockAll, true);
  for (const hostname of ['example.com', 'localhost.example.com', undefined]) {
    assert.equal(browserStorageHarness(undefined, false, undefined, { hostname, search: '?test=on' }).options.testConvenience, false);
  }
});
