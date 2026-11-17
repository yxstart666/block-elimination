import { GameApp } from '../ui/game';
import { createWechatRewarded } from '../services/rewarded';
import { REWARDED_AD_UNITS } from '../config/ads';
import { CAMPAIGN_STORAGE_KEY, sanitizeCampaign, type CampaignProgress } from '../services/campaign';
import { ECONOMY_STORAGE_KEY, sanitizeEconomy, type EconomyState } from '../services/economy';
import { createWechatLeaderboard } from '../services/leaderboard';
import { LEADERBOARD_CONFIG } from '../config/leaderboard';
import { isWechatTestUnlock } from '../services/testing';

declare const wx: any;
declare function requestAnimationFrame(callback: (time: number) => void): number;
declare function cancelAnimationFrame(id: number): void;

const BEST_SCORE_KEY = 'wood-blocks.best.v1';
const TUTORIAL_SEEN_KEY = 'wood-blocks.tutorial-seen.v1';
function readBest() {
  try {
    const raw = wx.getStorageSync?.(BEST_SCORE_KEY);
    const score = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    return Number.isSafeInteger(score) && score >= 0 ? score : 0;
  } catch { return 0; }
}
function writeBest(score: number) {
  try {
    if (Number.isSafeInteger(score) && score >= 0) wx.setStorageSync?.(BEST_SCORE_KEY, score);
  } catch { /* Storage restrictions must not interrupt play. */ }
}
function readTutorialSeen() {
  try { return wx.getStorageSync?.(TUTORIAL_SEEN_KEY) === true; }
  catch { return false; }
}
function writeTutorialSeen() {
  try { wx.setStorageSync?.(TUTORIAL_SEEN_KEY, true); }
  catch { /* Storage restrictions must not interrupt play. */ }
}
function readCampaign() {
  try { return sanitizeCampaign(wx.getStorageSync?.(CAMPAIGN_STORAGE_KEY)); }
  catch { return sanitizeCampaign(null); }
}
function writeCampaign(progress: CampaignProgress) {
  try { wx.setStorageSync?.(CAMPAIGN_STORAGE_KEY, sanitizeCampaign(progress)); }
  catch { /* Storage restrictions must not interrupt play. */ }
}
function readEconomy() {
  try { return sanitizeEconomy(wx.getStorageSync?.(ECONOMY_STORAGE_KEY)); }
  catch { return sanitizeEconomy(null); }
}
function writeEconomy(economy: EconomyState) {
  try { wx.setStorageSync?.(ECONOMY_STORAGE_KEY, sanitizeEconomy(economy)); }
  catch { /* Storage restrictions must not interrupt play. */ }
}

function metrics() {
  const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
  const safeTop = Math.max(0, info.safeArea?.top || 0, info.statusBarHeight || 0);
  let headerCenterY: number | undefined;
  try {
    const menu = wx.getMenuButtonBoundingClientRect();
    const height = Number.isFinite(menu?.height) && menu.height > 0 ? menu.height : menu?.bottom - menu?.top;
    if (Number.isFinite(menu?.top) && menu.top >= safeTop && Number.isFinite(height) && height > 0 &&
      (!info.screenHeight || menu.top + height <= info.screenHeight)) headerCenterY = menu.top + height / 2;
  } catch { /* Menu geometry is unavailable on some simulator versions. */ }
  return {
    width: info.windowWidth,
    height: info.windowHeight,
    pixelRatio: info.pixelRatio || 1,
    safeTop,
    headerCenterY,
    safeBottom: info.safeArea ? Math.max(0, info.screenHeight - info.safeArea.bottom) : 0,
  };
}

export function mountWechatGame() {
  const canvas = wx.createCanvas();
  const game = new GameApp({
    canvas,
    imageFactory: typeof wx.createImage === 'function' ? () => wx.createImage() : undefined,
    assetBasePath: 'assets/ui/',
    ...metrics(),
    initialBest: readBest(),
    onBest: writeBest,
    tutorialSeen: readTutorialSeen(),
    onTutorialSeen: writeTutorialSeen,
    initialCampaign: readCampaign(),
    onCampaignChange: writeCampaign,
    initialEconomy: readEconomy(),
    onEconomyChange: writeEconomy,
    leaderboard: createWechatLeaderboard(wx, LEADERBOARD_CONFIG, 'minigame'),
    testUnlockAll: isWechatTestUnlock(wx),
    testConvenience: isWechatTestUnlock(wx),
    rewarded: createWechatRewarded(wx, REWARDED_AD_UNITS),
    rewardedEnabled: {
      revive: Boolean(REWARDED_AD_UNITS.revive),
      refresh: Boolean(REWARDED_AD_UNITS.refresh),
      rotate: Boolean(REWARDED_AD_UNITS.rotate),
      bomb: Boolean(REWARDED_AD_UNITS.bomb),
      bulldozer: Boolean(REWARDED_AD_UNITS.bulldozer),
      hint: Boolean(REWARDED_AD_UNITS.hint),
      doubleCoins: Boolean(REWARDED_AD_UNITS.doubleCoins),
    },
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (id) => cancelAnimationFrame(id),
    onFeedback(kind) {
      try {
        if (wx.vibrateShort) wx.vibrateShort({ type: kind === 'place' ? 'light' : 'medium', fail() {} });
      } catch { /* Haptics are optional. */ }
    },
  });
  let touchId: number | null = null;
  const find = (touches: any[]) => touches?.find((touch: any) => touch.identifier === touchId);
  const start = (event: any) => {
    if (touchId !== null) return;
    const touch = event.changedTouches?.[0] || event.touches?.[0];
    if (!touch) return;
    touchId = touch.identifier;
    game.pointerDown(touch.clientX, touch.clientY, true);
  };
  const move = (event: any) => {
    const touch = find(event.touches);
    if (touch) game.pointerMove(touch.clientX, touch.clientY);
  };
  const end = (event: any) => {
    const touch = find(event.changedTouches);
    if (!touch) return;
    touchId = null;
    game.pointerUp(touch.clientX, touch.clientY);
  };
  const cancel = () => { touchId = null; game.pointerCancel(); };
  const hide = () => { cancel(); game.pause(); };
  const show = () => game.resume();
  const resize = () => {
    cancel();
    const size = metrics();
    game.resize(size.width, size.height, size.pixelRatio, size.safeTop, size.safeBottom, size.headerCenterY);
  };
  wx.onTouchStart(start);
  wx.onTouchMove(move);
  wx.onTouchEnd(end);
  wx.onTouchCancel(cancel);
  wx.onHide(hide);
  wx.onShow(show);
  wx.onWindowResize(resize);
  return () => {
    wx.offTouchStart?.(start);
    wx.offTouchMove?.(move);
    wx.offTouchEnd?.(end);
    wx.offTouchCancel?.(cancel);
    wx.offHide?.(hide);
    wx.offShow?.(show);
    wx.offWindowResize?.(resize);
    game.destroy();
  };
}

mountWechatGame();
