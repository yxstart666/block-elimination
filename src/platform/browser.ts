import { GameApp } from '../ui/game';
import { createUnavailableRewarded } from '../services/rewarded';
import { CAMPAIGN_STORAGE_KEY, sanitizeCampaign, type CampaignProgress } from '../services/campaign';
import { ECONOMY_STORAGE_KEY, sanitizeEconomy, type EconomyState } from '../services/economy';
import { createUnavailableLeaderboard } from '../services/leaderboard';
import { isBrowserTestConvenience, isBrowserTestUnlock } from '../services/testing';

const BEST_SCORE_KEY = 'wood-blocks.best.v1';
const TUTORIAL_SEEN_KEY = 'wood-blocks.tutorial-seen.v1';
function readBest() {
  try {
    const raw = localStorage.getItem(BEST_SCORE_KEY);
    const score = typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    return Number.isSafeInteger(score) && score >= 0 ? score : 0;
  } catch { return 0; }
}
function writeBest(score: number) {
  try {
    if (Number.isSafeInteger(score) && score >= 0) localStorage.setItem(BEST_SCORE_KEY, String(score));
  } catch { /* Storage restrictions must not interrupt play. */ }
}
function readTutorialSeen() {
  try { return localStorage.getItem(TUTORIAL_SEEN_KEY) === 'true'; }
  catch { return false; }
}
function writeTutorialSeen() {
  try { localStorage.setItem(TUTORIAL_SEEN_KEY, 'true'); }
  catch { /* Storage restrictions must not interrupt play. */ }
}
function readCampaign() {
  try { return sanitizeCampaign(localStorage.getItem(CAMPAIGN_STORAGE_KEY)); }
  catch { return sanitizeCampaign(null); }
}
function writeCampaign(progress: CampaignProgress) {
  try { localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(sanitizeCampaign(progress))); }
  catch { /* Storage restrictions must not interrupt play. */ }
}
function readEconomy() {
  try { return sanitizeEconomy(localStorage.getItem(ECONOMY_STORAGE_KEY)); }
  catch { return sanitizeEconomy(null); }
}
function writeEconomy(economy: EconomyState) {
  try { localStorage.setItem(ECONOMY_STORAGE_KEY, JSON.stringify(sanitizeEconomy(economy))); }
  catch { /* Storage restrictions must not interrupt play. */ }
}

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const holder = canvas.parentElement!;
const previewParams = new URLSearchParams(location.search);
const app = new GameApp({ canvas, imageFactory: typeof Image === 'function' ? () => new Image() : undefined, assetBasePath: './assets/ui/', width: holder.clientWidth, height: holder.clientHeight, pixelRatio: window.devicePixelRatio || 1, safeTop: 12, safeBottom: 12, initialBest: readBest(), onBest: writeBest, tutorialSeen: readTutorialSeen(), onTutorialSeen: writeTutorialSeen, initialCampaign: readCampaign(), onCampaignChange: writeCampaign, initialEconomy: readEconomy(), onEconomyChange: writeEconomy, leaderboard: createUnavailableLeaderboard(), testUnlockAll: isBrowserTestUnlock(location.hostname, location.search), testConvenience: isBrowserTestConvenience(location.hostname, location.search), rewarded: createUnavailableRewarded(), requestFrame: cb => requestAnimationFrame(cb), cancelFrame: id => cancelAnimationFrame(id), onStatus: text => { document.querySelector('#status')!.textContent = text; } });
const point = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
let activePointer: number | null = null;
canvas.addEventListener('pointerdown', e => { if (e.button !== 0 || activePointer !== null) return; e.preventDefault(); activePointer = e.pointerId; canvas.focus(); canvas.setPointerCapture(e.pointerId); const p = point(e); app.pointerDown(p.x, p.y, e.pointerType === 'touch'); });
canvas.addEventListener('pointermove', e => { if (activePointer !== null && e.pointerId !== activePointer) return; const p = point(e); app.pointerMove(p.x, p.y); });
canvas.addEventListener('pointerup', e => { if (e.pointerId !== activePointer) return; activePointer = null; const p = point(e); app.pointerUp(p.x, p.y); if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); });
const cancelPointer = (e: PointerEvent) => { if (e.pointerId !== activePointer) return; activePointer = null; app.pointerCancel(); };
canvas.addEventListener('pointercancel', cancelPointer);
canvas.addEventListener('lostpointercapture', cancelPointer);
canvas.addEventListener('keydown', e => { if (app.keyDown(e.key)) e.preventDefault(); });
const observer = new ResizeObserver(() => app.resize(holder.clientWidth, holder.clientHeight, window.devicePixelRatio || 1, 12, 12));
observer.observe(holder);
document.addEventListener('visibilitychange', () => { if (document.hidden) { activePointer = null; app.pause(); } else app.resume(); });
window.addEventListener('pagehide', e => { activePointer = null; if (e.persisted) app.pause(); else { observer.disconnect(); app.destroy(); } });
window.addEventListener('pageshow', e => { if (e.persisted) app.resume(); });
// Preview diagnostics are opt-in and excluded from the WeChat entry points.
if (previewParams.has('debug')) (window as any).__game = app;
if (previewParams.get('play') === 'levels') app.keyDown('l');
