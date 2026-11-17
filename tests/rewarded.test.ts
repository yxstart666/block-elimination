import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnavailableRewarded, createWechatRewarded } from '../src/services/rewarded.ts';
import { REWARDED_AD_UNITS } from '../src/config/ads.ts';

const ids = { revive: 'unit-a', refresh: 'unit-a', rotate: 'unit-a', bomb: 'unit-a', bulldozer: 'unit-a', hint: 'unit-a', doubleCoins: 'unit-a' };
const deferred = () => {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
  const close = new Set<(result?: { isEnded?: boolean }) => void>();
  const error = new Set<(result?: unknown) => void>();
  const recordedClose: ((result?: { isEnded?: boolean }) => void)[] = [];
  const recordedError: ((result?: unknown) => void)[] = [];
  let creates = 0, loads = 0, shows = 0, destroys = 0;
  const requested: string[] = [];
  const ad = {
    load: () => { loads++; return Promise.resolve(); },
    show: () => { shows++; return Promise.resolve(); },
    onClose(fn: (result?: { isEnded?: boolean }) => void) { close.add(fn); recordedClose.push(fn); },
    offClose(fn: (result?: { isEnded?: boolean }) => void) { close.delete(fn); },
    onError(fn: (result?: unknown) => void) { error.add(fn); recordedError.push(fn); },
    offError(fn: (result?: unknown) => void) { error.delete(fn); },
    destroy() { destroys++; },
  };
  const wx = { createRewardedVideoAd({ adUnitId }: { adUnitId: string }) { creates++; requested.push(adUnitId); return ad; } };
  return {
    wx, ad, close, error, recordedClose, recordedError, requested,
    counts: () => ({ creates, loads, shows, destroys }),
    emitClose(result?: { isEnded?: boolean }) { for (const fn of [...close]) fn(result); },
    emitError() { for (const fn of [...error]) fn({ errCode: 1004 }); },
  };
}

test('all production IDs are empty and neither missing IDs nor unavailable hosts simulate rewards', async () => {
  assert.deepEqual(REWARDED_AD_UNITS, { revive: '', refresh: '', rotate: '', bomb: '', bulldozer: '', hint: '', doubleCoins: '' });
  const h = fixture();
  const gateway = createWechatRewarded(h.wx, REWARDED_AD_UNITS);
  for (const placement of ['revive', 'refresh', 'rotate', 'bomb', 'bulldozer', 'hint', 'doubleCoins'] as const) assert.equal(await gateway.request(placement), 'unavailable');
  assert.equal(h.counts().creates, 0);
  assert.equal(await createWechatRewarded({}, ids).request('revive'), 'unavailable');
  assert.equal(await createUnavailableRewarded().request('rotate'), 'unavailable');
});

test('load/show success never rewards; only explicit complete viewing closes qualify once', async () => {
  const h = fixture(), gateway = createWechatRewarded(h.wx, ids);
  let settled = false;
  const pending = gateway.request('revive').then(result => { settled = true; return result; });
  await flush();
  assert.equal(settled, false);
  assert.deepEqual(h.counts(), { creates: 1, loads: 1, shows: 1, destroys: 0 });
  h.emitClose({ isEnded: true });
  h.emitClose({ isEnded: true });
  assert.equal(await pending, 'completed');
  assert.equal(h.close.size, 0); assert.equal(h.error.size, 0);
  gateway.dispose();
  assert.equal(h.counts().destroys, 0);
});

test('all seven placements reuse the configured singleton and return cancellation without rewards', async () => {
  const h = fixture(), gateway = createWechatRewarded(h.wx, ids);
  for (const [placement, closeResult] of [['revive', { isEnded: false }], ['refresh', undefined], ['rotate', {}], ['bomb', { isEnded: false }], ['bulldozer', undefined], ['hint', {}], ['doubleCoins', { isEnded: false }]] as const) {
    const pending = gateway.request(placement); await flush(); h.emitClose(closeResult);
    assert.equal(await pending, 'cancelled');
  }
  assert.equal(h.counts().creates, 1);
  assert.equal(h.counts().shows, 7);
});

test('rescue, hint and double-coin requests require explicit complete viewing on every use', async () => {
  const h = fixture(), gateway = createWechatRewarded(h.wx, ids);
  for (const placement of ['bomb', 'bulldozer', 'hint', 'doubleCoins', 'bomb', 'bulldozer', 'hint', 'doubleCoins'] as const) {
    let settled = false;
    const pending = gateway.request(placement).then(result => { settled = true; return result; });
    await flush(); assert.equal(settled, false, 'loading and showing do not grant a power');
    h.emitClose({ isEnded: true }); assert.equal(await pending, 'completed');
    h.emitClose({ isEnded: true });
  }
  assert.equal(h.counts().creates, 1);
  assert.equal(h.counts().shows, 8);
});

test('only one request may load or show at a time across reward placements', async () => {
  const h = fixture(), gateway = createWechatRewarded(h.wx, ids);
  const operation = deferred(); h.ad.load = () => operation.promise as Promise<void>;
  const pending = gateway.request('revive');
  assert.equal(await gateway.request('rotate'), 'busy');
  assert.equal(await gateway.request('bomb'), 'busy');
  assert.equal(await gateway.request('hint'), 'busy');
  operation.resolve(); await flush();
  assert.equal(await gateway.request('refresh'), 'busy');
  assert.equal(await gateway.request('bulldozer'), 'busy');
  assert.equal(await gateway.request('doubleCoins'), 'busy');
  h.emitClose({ isEnded: true }); assert.equal(await pending, 'completed');
});

test('show rejection reloads and retries at most once', async () => {
  const h = fixture(), gateway = createWechatRewarded(h.wx, ids);
  let calls = 0;
  h.ad.show = () => ++calls === 1 ? Promise.reject(new Error('expired')) : Promise.resolve();
  const pending = gateway.request('refresh'); await flush();
  assert.equal(calls, 2); assert.equal(h.counts().loads, 2);
  h.emitClose({ isEnded: true }); assert.equal(await pending, 'completed');
  h.ad.show = () => { calls++; return Promise.reject(new Error('still unavailable')); };
  assert.equal(await gateway.request('rotate'), 'error');
  assert.equal(calls, 4);
  assert.equal(h.close.size, 0);
});

test('load failures, SDK error events and creation failures report error without rewards', async () => {
  const h = fixture(), gateway = createWechatRewarded(h.wx, ids);
  h.ad.load = () => Promise.reject(new Error('offline'));
  assert.equal(await gateway.request('revive'), 'error');
  h.ad.load = () => Promise.resolve();
  const pending = gateway.request('rotate'); await flush(); h.emitError();
  assert.equal(await pending, 'error');
  h.emitClose({ isEnded: true });
  assert.equal(h.close.size, 0); assert.equal(h.error.size, 0);
  assert.equal(await createWechatRewarded({ createRewardedVideoAd() { throw new Error('SDK rejected'); } }, ids).request('refresh'), 'error');
});

test('dispose cancels a pending request and ignores its late SDK work and callbacks', async () => {
  const h = fixture(), gateway = createWechatRewarded(h.wx, ids);
  const operation = deferred(); h.ad.load = () => operation.promise as Promise<void>;
  const pending = gateway.request('revive');
  gateway.dispose(); gateway.dispose();
  assert.equal(await pending, 'cancelled');
  assert.equal(await gateway.request('revive'), 'unavailable');
  operation.resolve(); await flush();
  h.recordedClose[0]({ isEnded: true }); h.recordedError[0]();
  assert.equal(h.counts().shows, 0);
  assert.equal(h.close.size, 0); assert.equal(h.error.size, 0);
});

test('old callback identities cannot settle a newer request using the same instance', async () => {
  const h = fixture(), gateway = createWechatRewarded(h.wx, ids);
  const first = gateway.request('revive'); await flush(); h.emitClose({ isEnded: true });
  assert.equal(await first, 'completed');
  let settled = false;
  const next = gateway.request('rotate').then(result => { settled = true; return result; }); await flush();
  h.recordedClose[0]({ isEnded: true }); h.recordedError[0](); await flush();
  assert.equal(settled, false);
  h.emitClose({ isEnded: false }); assert.equal(await next, 'cancelled');
});

test('an early close while only loading cannot be counted as completion', async () => {
  const h = fixture(), gateway = createWechatRewarded(h.wx, ids);
  const operation = deferred(); h.ad.load = () => operation.promise as Promise<void>;
  let settled = false;
  const pending = gateway.request('revive').then(result => { settled = true; return result; });
  h.emitClose({ isEnded: true }); await flush(); assert.equal(settled, false);
  operation.resolve(); await flush(); h.emitClose({ isEnded: false }); assert.equal(await pending, 'cancelled');
});

test('SDK singleton aliases are rebound when switching configured ad unit IDs', async () => {
  const h = fixture(), gateway = createWechatRewarded(h.wx, { revive: 'a', refresh: 'b', rotate: 'a', bomb: 'a', bulldozer: 'b', hint: 'b', doubleCoins: 'a' });
  for (const placement of ['revive', 'refresh', 'rotate', 'bomb', 'bulldozer', 'hint', 'doubleCoins'] as const) {
    const pending = gateway.request(placement); await flush(); h.emitClose({ isEnded: true }); assert.equal(await pending, 'completed');
  }
  assert.deepEqual(h.requested, ['a', 'b', 'a', 'b', 'a']);
});

test('loading and opening have bounded failure waits, while visible videos have no reward timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture(), gateway = createWechatRewarded(h.wx, ids);
  const never = deferred(); h.ad.load = () => never.promise as Promise<void>;
  const failed = gateway.request('revive'); t.mock.timers.tick(30_000);
  assert.equal(await failed, 'error');
  h.ad.load = () => Promise.resolve(); h.ad.show = () => never.promise as Promise<void>;
  const opening = gateway.request('refresh'); await flush(); t.mock.timers.tick(30_000);
  assert.equal(await opening, 'error');
  h.ad.show = () => Promise.resolve();
  let settled = false;
  const visible = gateway.request('rotate').then(result => { settled = true; return result; }); await flush();
  t.mock.timers.tick(120_000); await flush(); assert.equal(settled, false);
  h.emitClose({ isEnded: true }); assert.equal(await visible, 'completed');
});
