import { GameApp } from '../ui/game';
import { createWechatRewarded } from '../services/rewarded';
import { REWARDED_AD_UNITS } from '../config/ads';
import { CAMPAIGN_STORAGE_KEY, sanitizeCampaign, type CampaignProgress } from '../services/campaign';
import { ECONOMY_STORAGE_KEY, sanitizeEconomy, type EconomyState } from '../services/economy';
import { createWechatLeaderboard } from '../services/leaderboard';
import { LEADERBOARD_CONFIG } from '../config/leaderboard';
import { isWechatTestUnlock } from '../services/testing';

declare const wx: any;
declare const Page: (options: any) => void;

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

function windowMetrics() {
  const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
  const safeTop = Math.max(0, info.safeArea?.top || 0, info.statusBarHeight || 0);
  let headerCenterY: number | undefined;
  try {
    const menu = wx.getMenuButtonBoundingClientRect();
    const height = Number.isFinite(menu?.height) && menu.height > 0 ? menu.height : menu?.bottom - menu?.top;
    if (Number.isFinite(menu?.top) && menu.top >= safeTop && Number.isFinite(height) && height > 0 &&
      (!info.screenHeight || menu.top + height <= info.screenHeight)) headerCenterY = menu.top + height / 2;
  } catch { /* The simulator may not expose the menu rectangle. */ }
  return {
    pixelRatio: info.pixelRatio || 1,
    safeTop,
    headerCenterY,
    safeBottom: info.safeArea ? Math.max(0, info.screenHeight - info.safeArea.bottom) : 0,
  };
}

function feedback(kind: 'place' | 'clear' | 'win') {
  try {
    if (wx.vibrateShort) wx.vibrateShort({ type: kind === 'place' ? 'light' : 'medium', fail() {} });
  } catch { /* Haptics are optional. */ }
}

export function mountMiniProgramPage() {
  Page({
    data: { error: '' },
    onLoad(this: any) {
      this._visible = true;
      this._disposed = false;
      this._queryVersion = 0;
      this._touchId = null;
    },
    onReady(this: any) { this.measureCanvas(); },
    onShow(this: any) {
      this._visible = true;
      this._game?.resume();
    },
    onHide(this: any) {
      this._visible = false;
      this._touchId = null;
      this._game?.pointerCancel();
      this._game?.pause();
    },
    onUnload(this: any) {
      this._disposed = true;
      this._queryVersion++;
      this._game?.destroy();
      this._game = null;
      this._canvas = null;
    },
    onResize(this: any) { this.measureCanvas(); },
    measureCanvas(this: any) {
      if (this._disposed) return;
      const version = ++this._queryVersion;
      wx.createSelectorQuery().in(this).select('#game-canvas')
        .fields({ node: true, size: true, rect: true })
        .exec((result: any[]) => {
          if (this._disposed || version !== this._queryVersion) return;
          const node = result?.[0];
          if (!node?.node || !node.width || !node.height) {
            this.setData({ error: '画布初始化失败，请更新微信后重新进入。' });
            return;
          }
          const metrics = windowMetrics();
          this._rect = { left: node.left || 0, top: node.top || 0 };
          // Window/menu bounds are screen coordinates; input and rendering use
          // coordinates relative to this canvas, including embedded canvases.
          const { pixelRatio, safeBottom } = metrics;
          const safeTop = Math.max(0, metrics.safeTop - this._rect.top);
          const localHeader = metrics.headerCenterY === undefined ? undefined : metrics.headerCenterY - this._rect.top;
          const headerCenterY = localHeader !== undefined && localHeader >= 0 ? localHeader : undefined;
          if (this._game) {
            this._game.pointerCancel();
            this._touchId = null;
            this._game.resize(node.width, node.height, pixelRatio, safeTop, safeBottom, headerCenterY);
          } else {
            this._canvas = node.node;
            this._game = new GameApp({
              canvas: node.node,
              imageFactory: typeof node.node.createImage === 'function' ? () => node.node.createImage() : undefined,
              assetBasePath: '/assets/ui/',
              width: node.width,
              height: node.height,
              pixelRatio,
              safeTop,
              safeBottom,
              headerCenterY,
              initialBest: readBest(),
              onBest: writeBest,
              tutorialSeen: readTutorialSeen(),
              onTutorialSeen: writeTutorialSeen,
              initialCampaign: readCampaign(),
              onCampaignChange: writeCampaign,
              initialEconomy: readEconomy(),
              onEconomyChange: writeEconomy,
              leaderboard: createWechatLeaderboard(wx, LEADERBOARD_CONFIG, 'miniprogram'),
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
              requestFrame: (cb) => node.node.requestAnimationFrame(cb),
              cancelFrame: (id) => node.node.cancelAnimationFrame(id),
              onFeedback: feedback,
            });
          }
          if (!this._visible) this._game.pause();
        });
    },
    point(this: any, touch: any) {
      return {
        x: typeof touch.x === 'number' ? touch.x : touch.clientX - (this._rect?.left || 0),
        y: typeof touch.y === 'number' ? touch.y : touch.clientY - (this._rect?.top || 0),
      };
    },
    onTouchStart(this: any, event: any) {
      if (this._touchId !== null || !this._game) return;
      const touch = event.changedTouches?.[0] || event.touches?.[0];
      if (!touch) return;
      this._touchId = touch.identifier;
      const { x, y } = this.point(touch);
      this._game.pointerDown(x, y, true);
    },
    onTouchMove(this: any, event: any) {
      if (this._touchId === null) return;
      const touch = event.touches?.find((item: any) => item.identifier === this._touchId);
      if (!touch) return;
      const { x, y } = this.point(touch);
      this._game?.pointerMove(x, y);
    },
    onTouchEnd(this: any, event: any) {
      if (this._touchId === null) return;
      const touch = event.changedTouches?.find((item: any) => item.identifier === this._touchId);
      if (!touch) return;
      const { x, y } = this.point(touch);
      this._touchId = null;
      this._game?.pointerUp(x, y);
    },
    onTouchCancel(this: any) {
      this._touchId = null;
      this._game?.pointerCancel();
    },
  });
}

mountMiniProgramPage();
