import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const atlas = JSON.parse(readFileSync(new URL('../assets/ui/atlas.json', import.meta.url), 'utf8'));

// Run after `npm run build`: these checks execute the shipped CommonJS bundles,
// with the real rules and GameApp, without browser globals or a WeChat client.
function boot(kind: 'miniprogram' | 'minigame') {
  const pending = new Map<number, (time: number) => void>();
  const timers = new Map<number, () => void>();
  let nextFrame = 0;
  let nextTimer = 0;
  const texts: string[] = [];
  const textPositions: { text: string; x: number; y: number }[] = [];
  const tileRects: { x: number; y: number; w: number; h: number }[] = [];
  const emptyRects: { x: number; y: number; w: number; h: number }[] = [];
  const storage = new Map<string, unknown>();
  let boardRect: { x: number; y: number; w: number; h: number } | null = null;
  let path: { x: number; y: number }[] = [];
  let saves = 0;
  let paints = 0;
  const finite = (args: any[]) => {
    for (const value of args) if (typeof value === 'number') assert.ok(Number.isFinite(value));
  };
  const ctx: any = {};
  for (const method of ['setTransform', 'translate', 'scale', 'rotate', 'fillRect', 'beginPath', 'moveTo', 'lineTo', 'arcTo', 'arc', 'bezierCurveTo', 'closePath', 'clip', 'stroke', 'strokeText', 'fill', 'setLineDash']) {
    ctx[method] = (...args: any[]) => { finite(args); if (method === 'fillRect') paints++; };
  }
  // Record the visible board and candidate geometry rather than hard-coding
  // positions from the responsive layout into the Mini Game gesture.
  ctx.beginPath = () => { path = []; };
  ctx.moveTo = ctx.lineTo = (x: number, y: number) => { finite([x, y]); path.push({ x, y }); };
  ctx.arcTo = (x1: number, y1: number, x2: number, y2: number, radius: number) => {
    finite([x1, y1, x2, y2, radius]); path.push({ x: x1, y: y1 }, { x: x2, y: y2 });
  };
  ctx.fill = () => {
    if (ctx.fillStyle !== '#0b163b' || !path.length) return;
    const left = Math.min(...path.map(p => p.x)), top = Math.min(...path.map(p => p.y));
    const right = Math.max(...path.map(p => p.x)), bottom = Math.max(...path.map(p => p.y));
    boardRect = { x: left + 1, y: top + 1, w: right - left - 2, h: bottom - top - 2 };
  };
  ctx.save = () => { saves++; };
  ctx.restore = () => { saves--; assert.ok(saves >= 0, 'canvas restore must have a matching save'); };
  ctx.fillText = (text: string, ...args: any[]) => { finite(args); texts.push(String(text)); textPositions.push({ text: String(text), x: args[0], y: args[1] }); };
  ctx.createLinearGradient = (...args: any[]) => {
    finite(args);
    return { addColorStop(stop: number, color: string) { assert.ok(stop >= 0 && stop <= 1); assert.equal(typeof color, 'string'); } };
  };
  ctx.drawImage = (image: { src: string }, ...args: number[]) => {
    finite(args); paints++;
    assert.equal(args.length, 8, 'runtime sprites use real atlas source crops');
    const [sx, sy, sw, sh, x, y, w, h] = args;
    if (image.src.endsWith('/tiles.png') && w < 35) tileRects.push({ x, y, w, h });
    const frame = atlas.frames.ui_empty_cell.frame;
    if (image.src.endsWith('/ui.png') && sx === frame.x && sy === frame.y && sw === frame.w && sh === frame.h) {
      emptyRects.push({ x, y, w, h });
      const left = Math.min(...emptyRects.map(r => r.x)), top = Math.min(...emptyRects.map(r => r.y));
      const right = Math.max(...emptyRects.map(r => r.x + r.w)), bottom = Math.max(...emptyRects.map(r => r.y + r.h));
      boardRect = { x: left, y: top, w: right - left, h: bottom - top };
    }
  };
  const createImage = () => {
    let source = '';
    return { onload: null as null | (() => void), onerror: null as null | (() => void),
      get src() { return source; }, set src(value: string) { source = value; this.onload?.(); } };
  };
  const requestFrame = (callback: (time: number) => void) => { const id = ++nextFrame; pending.set(id, callback); return id; };
  const cancelFrame = (id: number) => pending.delete(id);
  const canvas = {
    width: 0, height: 0,
    getContext: (type: string) => { assert.equal(type, '2d'); return ctx; },
    createImage,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
  };
  const handlers = new Map<string, Function>();
  const feedback: string[] = [];
  const info: any = {
    windowWidth: 390, windowHeight: 844, screenHeight: 844,
    pixelRatio: 3, statusBarHeight: 47, safeArea: { top: 47, bottom: 810 },
  };
  const wx: any = {
    getWindowInfo: () => info,
    getMenuButtonBoundingClientRect: () => ({ top: 48, height: 32, bottom: 80 }),
    createCanvas: () => canvas,
    createImage,
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    vibrateShort: ({ type }: any) => feedback.push(type),
    createSelectorQuery: () => {
      const query: any = {
        in: () => query, select: () => query, fields: () => query,
        exec: (callback: Function) => callback([{ node: canvas, width: info.windowWidth, height: info.windowHeight, left: 0, top: 0 }]),
      };
      return query;
    },
  };
  for (const event of ['TouchStart', 'TouchMove', 'TouchEnd', 'TouchCancel', 'Hide', 'Show', 'WindowResize']) {
    wx[`on${event}`] = (callback: Function) => handlers.set(event, callback);
    wx[`off${event}`] = () => handlers.delete(event);
  }
  let page: any;
  const module = { exports: {} };
  const context = vm.createContext({
    wx, module, exports: module.exports,
    Page: (options: any) => { page = options; },
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
    setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const bundlePath = kind === 'miniprogram' ? '../platforms/miniprogram/pages/game/game.js' : '../platforms/minigame/game.js';
  const code = readFileSync(new URL(bundlePath, import.meta.url), 'utf8');
  vm.runInContext(code, context, { filename: bundlePath, timeout: 1000 });
  if (page) {
    page.setData = (data: any) => { page.data = { ...page.data, ...data }; };
    page.onLoad(); page.onShow(); page.onReady();
  }
  return {
    canvas, page, pending, timers, texts, textPositions, feedback, info, storage,
    tutorialGesture() {
      assert.ok(boardRect, 'the board must have been drawn');
      assert.equal(tileRects.length, 16, 'the opening tray displays two six-cell choices and one four-cell answer');
      const center = boardRect.x + boardRect.w / 2;
      const answer = tileRects.filter(r => r.x >= center - 45 && r.x + r.w <= center + 45);
      assert.equal(answer.length, 4, 'the center choice is the 2×2 answer');
      const left = Math.min(...answer.map(r => r.x)), top = Math.min(...answer.map(r => r.y));
      const right = Math.max(...answer.map(r => r.x + r.w)), bottom = Math.max(...answer.map(r => r.y + r.h));
      return {
        start: { x: (left + right) / 2, y: (top + bottom) / 2 },
        end: { x: boardRect.x + boardRect.w / 2, y: boardRect.y + boardRect.h / 2 + 56 },
      };
    },
    emit(event: string, value?: any) { assert.ok(handlers.has(event)); handlers.get(event)!(value); },
    tick() {
      tileRects.length = 0; emptyRects.length = 0; boardRect = null;
      const frame = pending.entries().next().value;
      assert.ok(frame, 'an invalidated game must request a frame');
      pending.delete(frame[0]);
      frame[1](1000);
      assert.equal(saves, 0, 'the canvas state stack must be balanced after drawing');
      assert.ok(paints > 0);
    },
    clearText() { texts.length = 0; },
  };
}

test('小程序发布bundle启动、真实绘制、落子、后台恢复和卸载', () => {
  const h = boot('miniprogram');
  assert.equal(h.canvas.width, 1170);
  assert.equal(h.canvas.height, 2532);
  h.tick();
  assert.ok(h.texts.includes('初次体验'));
  assert.equal(h.textPositions.find(item => item.text === '初次体验')?.y, 64, 'title shares the capsule vertical center below the notch');
  assert.ok(h.texts.includes('填满整行或整列即可消除'));
  assert.ok(!h.texts.some(text => /分数|金币|最高分/.test(text)));
  assert.ok(!h.texts.some(text => ['撤回', '重来'].includes(text)));
  const game = h.page._game;
  const slot = game.slots[1];
  const board = game.board;
  const touch = (identifier: number, x: number, y: number) => ({ identifier, x, y });
  const tap = (x: number, y: number) => {
    const point = touch(1, x, y);
    h.page.onTouchStart({ changedTouches: [point] });
    h.page.onTouchEnd({ changedTouches: [point] });
  };
  assert.equal(game.state.tutorial, true);
  const start = touch(1, slot.x + slot.w / 2, slot.y + slot.h / 2);
  const end = touch(1, board.x + game.cell * 4, board.y + game.cell * 4 + 56);
  h.page.onTouchStart({ changedTouches: [start] });
  h.page.onTouchMove({ touches: [end] });
  h.page.onTouchEnd({ changedTouches: [end] });
  assert.equal(game.state.moves, 1);
  assert.equal(game.state.score, 50);
  assert.equal(game.state.lines, 2);
  assert.equal(game.state.tutorial, false);
  assert.equal(game.state.pieces.filter(Boolean).length, 3);
  assert.equal(h.feedback.length, 1);
  h.clearText(); h.tick();
  assert.equal(h.storage.get('wood-blocks.best.v1'), 50, 'real scoring still persists the endless best');
  assert.ok(h.texts.includes('2行'));
  assert.ok(h.texts.some(text => text.includes('两行消除')));
  h.page.onHide();
  assert.equal(h.pending.size, 0);
  assert.equal(h.timers.size, 0, 'hiding the page cancels the tutorial idle wait');
  tap(slot.x + 15, slot.y + 15);
  assert.equal(game.state.moves, 1);
  h.page.onShow();
  h.tick();
  h.info.windowWidth = 320; h.info.windowHeight = 640;
  h.page.onResize(); h.tick();
  assert.equal(h.canvas.width, 960);
  assert.equal(h.canvas.height, 1920);
  h.page.onUnload();
  assert.equal(h.pending.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.page._game, null);
});

test('小游戏发布bundle无需DOM即可启动绘制，触摸落子及后台恢复', () => {
  const h = boot('minigame');
  h.tick();
  assert.ok(h.texts.includes('初次体验'));
  assert.equal(h.textPositions.find(item => item.text === '初次体验')?.y, 64, 'Mini Game title shares the capsule vertical center');
  assert.ok(h.texts.includes('填满整行或整列即可消除'));
  assert.ok(!h.texts.some(text => /分数|金币|最高分/.test(text)));
  assert.ok(!h.texts.some(text => ['撤回', '重来'].includes(text)));
  const points = h.tutorialGesture();
  const start = { identifier: 7, clientX: points.start.x, clientY: points.start.y };
  const end = { identifier: 7, clientX: points.end.x, clientY: points.end.y };
  h.emit('TouchStart', { changedTouches: [start] });
  h.emit('TouchMove', { touches: [end] });
  h.emit('TouchEnd', { changedTouches: [end] });
  h.clearText(); h.tick();
  assert.equal(h.storage.get('wood-blocks.best.v1'), 50, 'Mini Game scoring still persists the endless best');
  assert.ok(h.texts.includes('2行'));
  assert.ok(h.texts.some(text => text.includes('两行消除')));
  assert.equal(h.feedback.length, 1);
  h.emit('TouchCancel');
  h.emit('Hide');
  assert.equal(h.pending.size, 0);
  h.emit('Show'); h.tick();
  h.info.windowWidth = 320; h.info.windowHeight = 640;
  h.emit('WindowResize'); h.tick();
  assert.equal(h.canvas.width, 960);
  assert.equal(h.canvas.height, 1920);
});
