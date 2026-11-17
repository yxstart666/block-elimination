import { advanceLevelTime, applyBomb, applyBulldozer, canPlacePiece, createGame, createLevel, getLevelGoals, getLevelTimeRemaining, isLevelExpired, getPieceBounds, hasMove, hasPlacement, placePiece, refreshPieces, requestHint, reviveGame, rotatePiece, TUTORIAL_MOVE, type Cell, type Destruction, type GameState, type Hint, type Piece } from '../core/game';
import { LEVELS } from '../core/levels';
import type { LevelGoalKind } from '../core/level-types';
import type { RewardedGateway, RewardPlacement, RewardResult } from '../services/rewarded';
import { getNextLevelIndex, isLevelUnlocked, markLessonSeen, markLevelComplete, sanitizeCampaign, type CampaignProgress } from '../services/campaign';
import { completeLevel, consumeInventory, doubleReward, grantInventory, purchaseInventory, sanitizeEconomy, TOOL_PRICES, type CompletionReward, type EconomyState, type InventoryKind } from '../services/economy';
import { createUnavailableLeaderboard, type LeaderboardGateway, type LeaderboardResult, type LeaderboardScope } from '../services/leaderboard';
import { COLOR_NAMES, TILE_IDS, STAR_TILE_IDS } from '../core/colors';
import { UiAssets } from './assets';
import { isLevelUntimed } from '../core/game';

type Rect = { x: number; y: number; w: number; h: number };
type Drag = { index: number; startX: number; startY: number; x: number; y: number; touch: boolean; moved: boolean };
type Particle = { x: number; y: number; vx: number; vy: number; size: number; color: string; born: number; life: number; star?: boolean };
type ColorCell = Cell & { tone: number };
type ClearFx = { at: number; cells: ColorCell[]; rows: number[]; columns: number[]; combo: number; tone: number };
type ReturnFx = { at: number; index: number; piece: Piece; x: number; y: number };
type DestructivePower = 'bomb' | 'bulldozer';
type Options = {
  canvas: any; width: number; height: number; pixelRatio: number; safeTop?: number; safeBottom?: number; headerCenterY?: number;
  requestFrame: (callback: (time: number) => void) => number; cancelFrame: (id: number) => void;
  onFeedback?: (kind: 'place' | 'clear' | 'win') => void; onStatus?: (text: string) => void;
  rewarded?: RewardedGateway;
  rewardedEnabled?: Partial<Record<RewardPlacement, boolean>>;
  initialBest?: number; onBest?: (score: number) => void;
  tutorialSeen?: boolean; onTutorialSeen?: () => void;
  initialCampaign?: unknown; onCampaignChange?: (progress: CampaignProgress) => void;
  initialEconomy?: unknown; onEconomyChange?: (economy: EconomyState) => void;
  leaderboard?: LeaderboardGateway;
  testUnlockAll?: boolean;
  testConvenience?: boolean;
  imageFactory?: () => any;
  assetBasePath?: string;
};
const C = { bg: '#1c275b', ink: '#f4f7ff', muted: '#a8b9e3', line: '#526bb5', gold: '#ffd477', cream: '#263d79', green: '#62efcf', board: '#0b163b', empty: '#172b55' };
const TONES = [
  { light: '#ffaaa2', base: '#f75e58', dark: '#b83132', edge: '#ffddd4' },
  { light: '#ffe58c', base: '#fdc321', dark: '#bd8615', edge: '#fff2b4' },
  { light: '#b3ee77', base: '#75d239', dark: '#438d24', edge: '#e2ffba' },
  { light: '#86c5ff', base: '#2d86ef', dark: '#1455a7', edge: '#d9edff' },
  { light: '#e4a0ff', base: '#b857e9', dark: '#73339d', edge: '#f4dbff' },
];
const FONT = '"PingFang SC","Microsoft YaHei",system-ui,sans-serif';
const DOCK_KINDS: readonly InventoryKind[] = ['hint', 'rotate', 'refresh', 'bomb', 'bulldozer'];
const TOOL_NAMES: Record<InventoryKind, string> = { hint: '提示', rotate: '旋转', refresh: '换块', bomb: '炸弹', bulldozer: '推土机' };
const TOOL_DETAILS: Record<InventoryKind, string> = { hint: '标出一块方块和它的可放位置', rotate: '试转候选方块，放入后消耗一次', refresh: '将剩余候选变成容易放入的单格', bomb: '清除一片 3×3 区域，腾出新空间', bulldozer: '清空底部三排，让棋盘重新舒展' };
let appSequence = 0;
const GUIDE_IDLE_MS = 4000;
const GUIDE_ANIMATION_MS = 6500;
const within = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** All visible game UI is drawn here. No DOM or WeChat globals. */
export class GameApp {
  state: GameState;
  private options: Options;
  private ctx: CanvasRenderingContext2D;
  private assets: UiAssets;
  private width = 390;
  private height = 844;
  private ratio = 1;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private logicalH = 844;
  private safeTop = 20;
  private safeBottom = 12;
  private headerScale = 1;
  private nativeHeader = false;
  private resizeMetrics: { safeTop: number; safeBottom: number; headerCenterY?: number } = { safeTop: 20, safeBottom: 12 };
  private board: Rect = { x: 22, y: 188, w: 346, h: 346 };
  private slots: Rect[] = [];
  private powerButtons: Rect[] = [];
  private dock: Rect[] = [];
  private feedbackEnabled = true;
  private acquireKind: InventoryKind | null = null;
  private acquireMessage = '';
  private acquiredAt = 0;
  private acquiredKind: InventoryKind | null = null;
  private goalPulseAt = 0;
  private earnedStarAt = 0;
  private powerUses = { refresh: 0, rotate: 0, revive: 0 };
  private powerGrants = { refresh: 3, rotate: 3 };
  private rewardBusy = false;
  private sessionVersion = 0;
  private rotationMode = false;
  private rotationOriginals: (Piece | null)[] | null = null;
  private rotationGuideAt = 0;
  private powerMessage = '';
  private frame: number | null = null;
  private paused = false;
  private disposed = false;
  private selected = -1;
  private ghost: Hint | null = null;
  private hint: Hint | null = null;
  private drag: Drag | null = null;
  private pendingButton = -1;
  private pendingBoard = false;
  private particles: Particle[] = [];
  private flash: Cell[] = [];
  private flashAt = 0;
  private clearFx: ClearFx | null = null;
  private destructionFx: { kind: DestructivePower; at: number; area: Cell[] } | null = null;
  private pendingDestruction: { kind: DestructivePower; at: number; impactMs: number; before: GameState; currentBoard: number[][]; column: number; charged: boolean; effect: Destruction; economy: EconomyState; version: number } | null = null;
  private levelClockAt: number | null = null;
  private levelClockTimer: ReturnType<typeof setTimeout> | null = null;
  private levelClockStarted = false;
  private placeFx: { at: number; cells: ColorCell[] } | null = null;
  private gainFx: { at: number; x: number; y: number; tone: number; star?: boolean; goalIndex?: number } | null = null;
  private returnFx: ReturnFx | null = null;
  private rejected = { index: -1, at: 0 };
  private scoreAt = 0;
  private bestScore = 0;
  private pop: { text: string; at: number; detail?: string } = { text: '', at: 0 };
  private toast = { text: '', at: 0 };
  private overlay: 'levels' | 'lesson' | 'leaderboard' | 'settings' | 'acquire' | null = null;
  private campaignProgress: CampaignProgress;
  private testUnlockAll = false;
  private economy: EconomyState;
  private settlement: CompletionReward | null = null;
  private levelRunId = '';
  private leaderboard: LeaderboardGateway;
  private rankingScope: LeaderboardScope = 'users';
  private rankingResult: LeaderboardResult | null = null;
  private rankingLoading = false;
  private rankingVersion = 0;
  private rankingReturn: 'levels' | null = null;
  private rankingLevelId: string | undefined;
  private runPrefix = '';
  private levelPage = 0;
  private suspendedEndless: { state: GameState; uses: Record<'refresh' | 'rotate' | 'revive', number>; grants: Record<'refresh' | 'rotate', number> } | null = null;
  private resultAt = 0;
  private keyboardCell = { x: 0, y: 0 };
  private guideAt: number | null = null;
  private guideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: Options) {
    this.options = options;
    this.testUnlockAll = options.testUnlockAll === true;
    this.campaignProgress = sanitizeCampaign(options.initialCampaign);
    this.economy = sanitizeEconomy(options.initialEconomy);
    this.leaderboard = options.leaderboard ?? createUnavailableLeaderboard();
    this.levelPage = Math.floor(getNextLevelIndex(this.campaignProgress) / 10);
    this.state = createGame('endless', !options.tutorialSeen);
    this.runPrefix = `${Date.now().toString(36)}-${this.state.seed.toString(36)}-${++appSequence}`;
    if (this.state.tutorial) { try { options.onTutorialSeen?.(); } catch { /* Local storage must not block play. */ } }
    this.bestScore = Number.isFinite(options.initialBest) ? Math.max(0, Math.floor(options.initialBest!)) : 0;
    this.ctx = options.canvas.getContext('2d');
    this.assets = new UiAssets(options.imageFactory, options.assetBasePath, () => this.invalidate());
    this.resize(options.width, options.height, options.pixelRatio, options.safeTop, options.safeBottom, options.headerCenterY);
    this.announce(this.state.tutorial ? '无限挑战。从三块中选出能填满空位的一块，学会消除后继续挑战最高分。' : '无限挑战。从空棋盘开始，填满整行或整列消除。');
  }

  resize(width: number, height: number, pixelRatio: number, safeTop = 20, safeBottom = 12, headerCenterY?: number) {
    if (this.disposed || width <= 0 || height <= 0) return;
    this.pointerCancel();
    this.width = width; this.height = height; this.ratio = Math.min(3, Math.max(1, pixelRatio));
    this.resizeMetrics = { safeTop, safeBottom, headerCenterY };
    // Fit landscape and compact screens without clipping controls or safe areas.
    this.scale = Math.min(width / 390, height / 670);
    this.logicalH = height / this.scale;
    this.offsetX = (width - 390 * this.scale) / 2; this.offsetY = 0;
    this.nativeHeader = typeof headerCenterY === 'number' && Number.isFinite(headerCenterY);
    this.safeTop = this.nativeHeader ? Math.max((safeTop - 8) / this.scale, headerCenterY! / this.scale - 18) : Math.max(28, safeTop / this.scale + 18);
    this.safeBottom = Math.max(14, safeBottom / this.scale);
    const available = this.logicalH - this.safeTop - this.safeBottom;
    const compact = available < 700;
    this.headerScale = compact ? .8 : 1;
    const headerHeight = compact ? 114 : 128;
    const slotHeight = compact ? 72 : 94;
    const trayGap = compact ? 20 : 36, toolGap = compact ? 20 : 30, toolHeight = compact ? 82 : 94;
    const slotCount = this.state.pieces.length;
    const budget = headerHeight + toolGap + toolHeight + trayGap + slotHeight;
    const size = Math.min(360, Math.max(170, available - budget));
    const extra = Math.max(0, available - size - budget);
    this.board = { x: (390 - size) / 2, y: this.safeTop + headerHeight, w: size, h: size };
    const trayY = this.board.y + size + trayGap + extra * .34;
    this.slots = Array.from({ length: slotCount }, (_, i) => ({ x: 8 + i * 126, y: trayY, w: 122, h: slotHeight }));
    const toolY = this.logicalH - this.safeBottom - toolHeight;
    this.dock = DOCK_KINDS.map((_, i) => ({ x: 17 + i * 73, y: toolY, w: 64, h: toolHeight }));
    this.powerButtons = [this.dock[1], this.dock[2]];
    this.options.canvas.width = Math.round(width * this.ratio);
    this.options.canvas.height = Math.round(height * this.ratio);
    this.invalidate();
  }

  private point(x: number, y: number) { return { x: (x - this.offsetX) / this.scale, y: (y - this.offsetY) / this.scale }; }
  private invalidate() {
    if (this.paused || this.disposed || this.frame !== null) return;
    this.frame = this.options.requestFrame(() => {
      this.frame = null;
      if (this.paused || this.disposed) return;
      this.draw();
      const now = Date.now();
      if ((this.rotationMode && !this.overlay && this.state.status === 'playing') || (this.overlay === 'leaderboard' && this.rankingResult?.presentation === 'open-data') || (this.guideVisible() && now - this.guideAt! < GUIDE_ANIMATION_MS) || this.particles.length || now - this.flashAt < 320 || now - this.pop.at < 1000 || now - this.toast.at < 2300 || now - this.scoreAt < 420 || now - this.goalPulseAt < 700 || now - this.earnedStarAt < 850 || now - this.acquiredAt < 700 || now - this.rejected.at < 280 || (this.clearFx && now - this.clearFx.at < 1000) || (this.destructionFx && now - this.destructionFx.at < 1200) || (this.placeFx && now - this.placeFx.at < 280) || (this.gainFx && now - this.gainFx.at < 780) || (this.returnFx && now - this.returnFx.at < 230) || (this.state.status !== 'playing' && now - this.resultAt < 1100)) this.invalidate();
    });
  }
  pause() { this.updateLevelClock(); this.paused = true; this.stopLevelClock(); this.pointerCancel(); if (this.frame !== null) this.options.cancelFrame(this.frame); this.frame = null; }
  resume() { if (this.disposed) return; this.paused = false; this.levelClockAt = null; this.postponeGuide(); this.invalidate(); }
  destroy() { this.pause(); this.disposed = true; this.pendingDestruction = null; this.assets.dispose(); this.sessionVersion++; this.rankingVersion++; this.options.rewarded?.dispose(); this.leaderboard.dispose?.(); this.particles = []; this.clearFx = null; this.destructionFx = null; this.placeFx = null; this.gainFx = null; this.returnFx = null; }
  private stopLevelClock() {
    if (this.levelClockTimer !== null) clearTimeout(this.levelClockTimer);
    this.levelClockTimer = null; this.levelClockAt = null;
  }
  private updateLevelClock(now = Date.now()) {
    const running = !this.disposed && !this.paused && !this.overlay && !this.rewardBusy &&
      this.levelClockStarted && !this.pendingDestruction && this.state.status === 'playing' && Number.isFinite(getLevelTimeRemaining(this.state));
    if (!running) { this.stopLevelClock(); return; }
    if (this.levelClockAt !== null && now > this.levelClockAt) this.state = advanceLevelTime(this.state, now - this.levelClockAt);
    this.levelClockAt = now;
    if (this.levelClockTimer !== null) clearTimeout(this.levelClockTimer);
    this.levelClockTimer = null;
    if (isLevelExpired(this.state)) {
      this.stopLevelClock(); this.stopRotation(); this.pointerCancel(); this.selected = -1; this.ghost = null; this.hint = null;
      this.resultAt = now; this.announce('本关时间用尽，可以免费重试。'); this.invalidate(); return;
    }
    const remaining = getLevelTimeRemaining(this.state);
    this.levelClockTimer = setTimeout(() => { this.levelClockTimer = null; this.updateLevelClock(); this.invalidate(); },
      Math.max(20, Math.min(1000, remaining % 1000 || 1000)));
  }
  private beginLevelClock() {
    if (this.levelClockStarted || this.state.mode !== 'level' || this.state.status !== 'playing' || !Number.isFinite(getLevelTimeRemaining(this.state))) return;
    this.levelClockStarted = true; this.levelClockAt = Date.now(); this.updateLevelClock();
  }
  private announce(text: string) { this.options.onStatus?.(text); }
  private notify(text: string) { this.toast = { text, at: Date.now() }; this.announce(text); this.invalidate(); }
  private feedback(kind: 'place' | 'clear' | 'win') { if (this.feedbackEnabled) this.options.onFeedback?.(kind); }
  private blocked(index: number) { const piece = this.state.pieces[index]; return !!piece && !this.state.tutorial && !hasPlacement(this.state.board, piece); }
  private rejectPiece(index: number) {
    this.rejected = { index, at: Date.now() }; this.selected = -1; this.ghost = null;
    this.notify('这块暂时放不下，先试试亮着的木块');
  }
  private get levelDefinition() { return LEVELS.find(level => level.id === this.state.level?.id); }
  private levelUnlocked(index: number) { return this.testUnlockAll || isLevelUnlocked(this.campaignProgress, index); }
  private difficultyLabel(level = this.levelDefinition) { return level ? `${level.learning ? '学习' : level.difficulty >= 8 ? '超难' : level.difficulty >= 7 ? '困难' : '普通'} · ${level.difficulty}/10` : ''; }
  private saveCampaign(progress: CampaignProgress) {
    this.campaignProgress = progress;
    try { this.options.onCampaignChange?.(progress); } catch { /* Storage failure leaves this session playable. */ }
  }
  private saveEconomy(economy: EconomyState) {
    this.economy = economy;
    try { this.options.onEconomyChange?.(economy); } catch { /* Keep in-memory rewards and inventory usable. */ }
  }
  private lessonKey() {
    return this.levelDefinition?.mechanic === 'colors' ? 'level-07:colors-v1' : this.levelDefinition?.mechanic === 'dual' ? 'level-10:colors-stars-v1' : this.levelDefinition?.id ?? '';
  }
  private needsLesson() {
    return !!this.levelDefinition && (this.levelDefinition.learning || this.levelDefinition.mechanic === 'colors' || this.levelDefinition.mechanic === 'dual') && !this.campaignProgress.lessonsSeen.includes(this.lessonKey());
  }
  private finishCampaignVictory() {
    if (!this.levelDefinition || this.state.status !== 'won') return;
    this.saveCampaign(markLevelComplete(this.campaignProgress, this.levelDefinition.id, undefined, this.testUnlockAll));
    if (this.settlement?.runId === this.levelRunId) return;
    const reward = completeLevel(this.economy, this.levelDefinition.id, this.state.score, this.levelRunId);
    if (reward) { this.settlement = reward; this.saveEconomy(reward.state); }
    try { void this.leaderboard.submit({ levelId: this.levelDefinition.id, score: this.state.score, stars: reward?.stars ?? 1 }).catch(() => {}); } catch { /* Cloud availability never blocks settlement. */ }
  }
  private modeButton(): Rect { return { x: -1000, y: -1000, w: 0, h: 0 }; }
  private hintButton(): Rect { return this.dock[0]; }
  private dockButtons(): Rect[] { return this.dock; }
  private settingsButton(): Rect { return { x: 12, y: this.safeTop - 2, w: 40, h: 40 }; }
  private sheetRect(height: number): Rect {
    const h = Math.min(height, this.logicalH - this.safeTop - this.safeBottom - 28);
    const shift = this.overlay === 'settings' || this.overlay === 'acquire' ? -12 : 0;
    return { x: 28, y: this.safeTop + (this.logicalH - this.safeTop - this.safeBottom - h) / 2 + shift, w: 334, h };
  }
  private settingsButtons(): Rect[] {
    const b = this.sheetRect(374);
    return [...[0, 1, 2, 3, 4].map(i => ({ x: b.x + 16, y: b.y + 94 + i * 52, w: b.w - 32, h: 44 })),
      { x: b.x + b.w - 50, y: b.y + 5, w: 44, h: 44 }];
  }
  private acquireButtons(): Rect[] {
    const b = this.sheetRect(374);
    return [
      { x: b.x + 16, y: b.y + 208, w: b.w - 32, h: 50 },
      { x: b.x + 16, y: b.y + 294, w: b.w - 32, h: 48 },
      { x: b.x + b.w - 42, y: b.y - 1, w: 44, h: 44 },
    ];
  }
  private openSettings() {
    this.stopRotation(); this.pointerCancel(); this.overlay = 'settings'; this.toast.at = 0;
    this.postponeGuide(); this.announce('游戏设置。可调整震动反馈、重新开始、查看地图和排行榜。'); this.invalidate();
  }
  private settingsAction(index: number) {
    if (index === 0) { this.feedbackEnabled = !this.feedbackEnabled; this.announce(`震动反馈已${this.feedbackEnabled ? '开启' : '关闭'}`); }
    else if (index === 1) this.reset();
    else if (index === 2) this.openLevels();
    else if (index === 3) this.openRanking();
    else { this.overlay = null; this.postponeGuide(); }
    this.invalidate();
  }
  private openAcquire(kind: InventoryKind) {
    this.acquireKind = kind; this.acquireMessage = ''; this.overlay = 'acquire'; this.toast.at = 0;
    this.pointerCancel(); this.postponeGuide();
    this.announce(this.testConvenience ? `测试模式：${TOOL_NAMES[kind]}可点击广告或金币入口直接领取，不播放广告、不扣金币。` : `${TOOL_NAMES[kind]}已用完，可观看完整广告获得一个，或用${TOOL_PRICES[kind]}金币购买一个。当前${this.economy.coins}金币。`);
    this.invalidate();
  }
  private async acquireAction(index: number) {
    const kind = this.acquireKind;
    if (!kind || this.rewardBusy || this.overlay !== 'acquire') return;
    if (index === 2) { this.overlay = null; this.acquireKind = null; this.postponeGuide(); this.invalidate(); return; }
    if (index === 1) {
      const purchased = this.testConvenience ? grantInventory(this.economy, kind) : purchaseInventory(this.economy, kind);
      if (!purchased) { this.acquireMessage = '金币不足，闯关获得星星可领取金币'; this.announce(this.acquireMessage); this.invalidate(); return; }
      this.saveEconomy(purchased);
    } else if (index === 0) {
      const version = this.sessionVersion;
      this.rewardBusy = true; this.acquireMessage = '正在打开视频…'; this.invalidate();
      let result: RewardResult;
      try { result = await this.requestReward(kind); }
      catch { result = 'error'; }
      if (this.disposed || version !== this.sessionVersion) return;
      this.rewardBusy = false;
      if (this.overlay !== 'acquire' || this.acquireKind !== kind) return;
      if (result !== 'completed') {
        this.acquireMessage = result === 'cancelled' ? '视频未看完，道具和金币均未变化' : result === 'busy' ? '视频正在播放，请稍后再试' : '广告暂不可用，可稍后重试或使用金币';
        this.announce(this.acquireMessage); this.invalidate(); return;
      }
      this.saveEconomy(grantInventory(this.economy, kind));
    } else return;
    this.acquiredKind = kind; this.acquiredAt = Date.now(); this.acquireKind = null; this.overlay = null;
    this.postponeGuide(); this.notify(`${TOOL_NAMES[kind]} +1，点击道具即可使用`);
  }
  private destructiveButtons(): Rect[] {
    if (this.state.mode !== 'level' || this.state.status !== 'lost') return [];
    return this.modalButtons().slice(3, 5);
  }
  private rankButton(): Rect { return this.overlay === 'levels' ? { x: 274, y: this.levelMenuRect().y + 24, w: 78, h: 30 } : { x: -1000, y: -1000, w: 0, h: 0 }; }
  private openRanking() {
    this.rankingReturn = this.overlay === 'levels' ? 'levels' : null;
    this.stopRotation(); this.pointerCancel(); this.overlay = 'leaderboard';
    this.rankingLevelId = this.levelDefinition?.id; void this.loadRanking(); this.invalidate();
  }
  private async loadRanking() {
    const version = ++this.rankingVersion; this.rankingLoading = true; this.rankingResult = null; this.invalidate();
    let result: LeaderboardResult;
    try { result = await this.leaderboard.load(this.rankingScope, this.rankingLevelId); }
    catch { result = { status: 'error', entries: [], message: '排行榜暂时无法加载，请稍后重试' }; }
    if (this.disposed || this.overlay !== 'leaderboard' || version !== this.rankingVersion) return;
    this.rankingLoading = false; this.rankingResult = result; this.invalidate();
  }
  private closeRanking() {
    this.rankingVersion++; this.leaderboard.hideFriends?.(); this.overlay = this.rankingReturn; this.postponeGuide(); this.invalidate();
  }
  private openLevels() {
    this.stopRotation(); this.pointerCancel(); this.overlay = 'levels'; this.toast.at = 0; this.postponeGuide(); this.invalidate();
    const current = this.state.status === 'playing' ? LEVELS.findIndex(level => level.id === this.state.level?.id) : -1;
    this.levelPage = Math.floor((current >= 0 ? current : getNextLevelIndex(this.campaignProgress)) / 10);
    this.announce(`闯关模式，共30关，已完成${this.campaignProgress.completed.length}关。消线、星星、颜色与组合目标交替，完成前关解锁下一关。`);
  }
  private startLevel(id: string) {
    const index = LEVELS.findIndex(level => level.id === id);
    if (index < 0 || !this.levelUnlocked(index)) { this.notify('先完成前面的关卡，就能解锁这里'); return; }
    if (this.state.mode !== 'level') this.suspendedEndless = { state: this.originalState(), uses: { ...this.powerUses }, grants: { ...this.powerGrants } };
    this.reset(createLevel(id));
    this.announce(`${this.levelDefinition!.title}。${this.levelDefinition!.description}。`);
  }
  private continueCampaign() {
    if (this.state.mode === 'level' && this.state.status === 'playing') { this.overlay = null; this.invalidate(); return; }
    this.startLevel(LEVELS[getNextLevelIndex(this.campaignProgress)].id);
  }
  private dismissLesson() {
    if (this.overlay !== 'lesson' || !this.levelDefinition) return;
    this.saveCampaign(markLessonSeen(markLessonSeen(this.campaignProgress, this.levelDefinition.id), this.lessonKey()));
    this.overlay = null; this.announce(this.levelDefinition.description); this.invalidate();
  }
  private returnToEndless() {
    if (this.state.mode !== 'level') { this.overlay = null; this.postponeGuide(); this.invalidate(); return; }
    const session = this.suspendedEndless;
    this.reset(session?.state ?? createGame('endless', false));
    if (session) { this.powerUses = { ...session.uses }; this.powerGrants = { ...session.grants }; }
    this.suspendedEndless = null;
    this.announce('已返回无限挑战，保留进入闯关前的进度。'); this.invalidate();
  }
  private guideVisible() { return this.state.tutorial && this.guideAt !== null && !this.drag && !this.overlay && !this.paused && !this.disposed; }
  private postponeGuide() {
    const hadGuide = this.guideAt !== null;
    this.guideAt = null;
    if (this.guideTimer !== null) clearTimeout(this.guideTimer);
    this.guideTimer = null;
    if (hadGuide) this.invalidate();
    if (!this.state.tutorial || this.paused || this.disposed || this.drag || this.overlay) return;
    this.guideTimer = setTimeout(() => {
      this.guideTimer = null;
      if (!this.state.tutorial || this.paused || this.disposed || this.drag || this.overlay) return;
      this.guideAt = Date.now(); this.invalidate();
    }, GUIDE_IDLE_MS);
  }

  pointerDown(x: number, y: number, isTouch = false) {
    this.updateLevelClock();
    if (this.disposed || this.paused || this.drag || this.rewardBusy) return;
    this.postponeGuide();
    this.returnFx = null;
    const p = this.point(x, y);
    if (this.overlay === 'settings' || this.overlay === 'acquire') {
      this.pendingButton = (this.overlay === 'settings' ? this.settingsButtons() : this.acquireButtons()).findIndex(r => within(p, r)); return;
    }
    if (this.overlay === 'leaderboard') { this.pendingButton = [...this.rankingTabs(), ...this.rankingButtons()].findIndex(r => within(p, r)); return; }
    if (this.overlay === 'lesson') { this.pendingButton = within(p, this.lessonButton()) ? 0 : -1; return; }
    if (this.overlay === 'levels') {
      if (within(p, this.rankButton())) { this.pendingButton = 50; return; }
      this.pendingButton = [...this.levelButtons(), ...this.levelPageButtons(), ...this.levelMenuButtons()].findIndex(r => within(p, r));
      return;
    }
    if (this.overlay || this.state.status !== 'playing') {
      this.pendingButton = this.modalButtons().findIndex(r => within(p, r));
      return;
    }
    if (within(p, this.settingsButton())) { this.pendingButton = 60; return; }
    if (within(p, this.modeButton())) { this.pendingButton = 10; return; }
    if (within(p, this.rankButton())) { this.pendingButton = 50; return; }
    const hint = this.hintButton();
    if (hint && within(p, hint)) { this.pendingButton = 30; return; }
    const destructive = this.destructiveButtons().findIndex(r => within(p, r));
    if (destructive >= 0) { this.pendingButton = 20 + destructive; return; }
    const power = this.powerButtons.findIndex(r => within(p, r));
    if (power >= 0) { this.pendingButton = power; this.invalidate(); return; }
    const dock = this.dockButtons().findIndex(r => within(p, r));
    if (dock >= 0) { this.pendingButton = 70 + dock; this.invalidate(); return; }
    const index = this.slots.findIndex((r, i) => this.state.pieces[i] && within(p, r));
    if (index >= 0) {
      if (this.blocked(index) && !this.rotationMode) { this.rejectPiece(index); return; }
      this.beginLevelClock();
      this.selected = index; this.ghost = null;
      this.drag = { index, startX: p.x, startY: p.y, x: p.x, y: p.y, touch: isTouch, moved: false };
      this.invalidate(); return;
    }
    if (within(p, this.board) && this.selected >= 0) {
      this.pendingBoard = true;
      this.ghost = { index: this.selected, x: Math.floor((p.x - this.board.x) / this.cell), y: Math.floor((p.y - this.board.y) / this.cell) };
      this.invalidate();
    }
  }
  pointerMove(x: number, y: number) {
    if (this.disposed || this.paused || this.overlay || this.state.status !== 'playing' || this.rewardBusy) return;
    const p = this.point(x, y);
    if (this.drag) {
      this.postponeGuide();
      this.drag.x = p.x; this.drag.y = p.y;
      if (Math.hypot(p.x - this.drag.startX, p.y - this.drag.startY) > 6) this.drag.moved = true;
      if (this.drag.moved) this.updateGhost();
      this.invalidate();
    } else if (this.selected >= 0 && within(p, this.board)) {
      this.postponeGuide();
      this.ghost = { index: this.selected, x: Math.floor((p.x - this.board.x) / this.cell), y: Math.floor((p.y - this.board.y) / this.cell) }; this.invalidate();
    }
  }
  pointerUp(x: number, y: number) {
    if (this.disposed || this.paused || this.rewardBusy) return;
    this.postponeGuide();
    const p = this.point(x, y);
    if (this.overlay === 'settings' || this.overlay === 'acquire') {
      const index = (this.overlay === 'settings' ? this.settingsButtons() : this.acquireButtons()).findIndex(r => within(p, r));
      const active = this.overlay; const pending = this.pendingButton; this.pendingButton = -1;
      if (index >= 0 && index === pending) { if (active === 'settings') this.settingsAction(index); else void this.acquireAction(index); }
      return;
    }
    if (this.overlay === 'leaderboard') {
      const index = [...this.rankingTabs(), ...this.rankingButtons()].findIndex(r => within(p, r));
      if (index >= 0 && index === this.pendingButton) {
        if (index < 2) { this.rankingScope = index === 0 ? 'users' : 'friends'; void this.loadRanking(); }
        else if (index === 2 || index === 4) this.closeRanking();
        else if (index === 5) { this.rankingLevelId = undefined; void this.loadRanking(); }
        else if (index === 6) { this.rankingLevelId = this.levelDefinition?.id ?? LEVELS[getNextLevelIndex(this.campaignProgress)].id; void this.loadRanking(); }
        else { this.rankingLevelId = this.rankingLevelId ? undefined : this.levelDefinition?.id ?? LEVELS[getNextLevelIndex(this.campaignProgress)].id; void this.loadRanking(); }
      }
      this.pendingButton = -1; return;
    }
    if (this.pendingButton === 50) { this.pendingButton = -1; if (within(p, this.rankButton())) this.openRanking(); return; }
    if (this.overlay === 'lesson') {
      if (this.pendingButton === 0 && within(p, this.lessonButton())) this.dismissLesson();
      this.pendingButton = -1; return;
    }
    if (this.overlay === 'levels') {
      const cards = this.levelButtons().length;
      const index = [...this.levelButtons(), ...this.levelPageButtons(), ...this.levelMenuButtons()].findIndex(r => within(p, r));
      if (index >= 0 && index === this.pendingButton) {
        if (index < cards) this.startLevel(LEVELS[this.levelPage * 10 + index].id);
        else if (index < cards + 2) { this.levelPage = Math.max(0, Math.min(2, this.levelPage + (index === cards ? -1 : 1))); this.invalidate(); }
        else if (index === cards + 2) this.continueCampaign();
        else this.returnToEndless();
      }
      this.pendingButton = -1; return;
    }
    if (this.overlay || this.state.status !== 'playing') {
      const index = this.modalButtons().findIndex(r => within(p, r));
      if (index >= 0 && index === this.pendingButton) this.modalAction(index);
      this.pendingButton = -1; return;
    }
    if (this.pendingButton >= 0) {
      const index = this.pendingButton; this.pendingButton = -1;
      if (index === 60) { if (within(p, this.settingsButton())) this.openSettings(); return; }
      if (index >= 70) { const i = index - 70; if (this.dock[i] && within(p, this.dock[i])) this.openPower(DOCK_KINDS[i]); return; }
      if (index === 10) { if (within(p, this.modeButton())) this.openLevels(); return; }
      if (index === 30) { const hint = this.hintButton(); if (hint && within(p, hint)) this.openPower('hint'); return; }
      if (index >= 20) {
        const button = this.destructiveButtons()[index - 20];
        if (button && within(p, button)) this.openPower(index === 20 ? 'bomb' : 'bulldozer');
        return;
      }
      if (within(p, this.powerButtons[index])) this.openPower((['rotate', 'refresh'] as const)[index]);
      this.invalidate(); return;
    }
    if (this.drag) {
      const moved = this.drag.moved, index = this.drag.index;
      this.drag.x = p.x; this.drag.y = p.y;
      if (moved) {
        this.updateGhost(); const target = this.ghost, position = this.dragPosition(), piece = this.state.pieces[index]!; this.drag = null;
        if (target && this.commit(target)) return;
        this.returnFx = { at: Date.now(), index, piece, ...position };
        this.notify(this.state.tutorial ? target?.index === TUTORIAL_MOVE.index ? '对齐虚线空位再试试' : '这块放不下，换个形状试试' : '这里放不下，换个位置试试'); this.ghost = null; this.selected = -1;
      } else {
        this.drag = null;
        if (this.rotationMode && within(p, this.slots[index])) this.tryRotation(index);
        if (this.state.tutorial && index !== TUTORIAL_MOVE.index) this.notify('这块放不下，换个形状试试');
      }
      this.postponeGuide();
      this.invalidate(); return;
    }
    if (this.pendingBoard) {
      this.pendingBoard = false;
      if (within(p, this.board) && this.ghost) {
        if (!this.commit(this.ghost)) this.notify('需要把整块放进空格中');
      }
      this.invalidate();
    }
  }
  pointerCancel() { this.drag = null; this.pendingBoard = false; this.pendingButton = -1; this.ghost = null; this.returnFx = null; this.postponeGuide(); this.invalidate(); }
  private get cell() { return this.board.w / 8; }
  private dragPosition() {
    const d = this.drag!; const bounds = getPieceBounds(this.state.pieces[d.index]!);
    return { x: d.x - bounds.width * this.cell / 2, y: d.y - (d.touch ? 56 : 0) - bounds.height * this.cell / 2 };
  }
  private updateGhost() {
    if (!this.drag) return;
    const p = this.dragPosition();
    this.ghost = { index: this.drag.index, x: Math.round((p.x - this.board.x) / this.cell), y: Math.round((p.y - this.board.y) / this.cell) };
  }
  private originalState(): GameState {
    if (!this.rotationOriginals) return this.state;
    return { ...this.state, pieces: this.state.pieces.map((piece, i) => piece && this.rotationOriginals?.[i]?.id === piece.id ? this.rotationOriginals[i] : piece) };
  }
  private stopRotation() {
    this.state = this.originalState(); this.rotationMode = false; this.rotationOriginals = null;
    this.rotationGuideAt = 0;
    this.selected = -1; this.ghost = null;
    if (!this.state.tutorial && this.state.status !== 'won' && !(this.levelDefinition && (this.levelDefinition.timeLimitSeconds ? isLevelExpired(this.state) : !isLevelUntimed(this.state) && this.state.moves >= this.levelDefinition.maxMoves))) {
      this.state = { ...this.state, status: hasMove(this.state.board, this.state.pieces) ? 'playing' : 'lost' };
      if (this.state.status === 'lost') this.resultAt = Date.now();
    }
    this.invalidate();
  }
  private tryRotation(index: number) {
    if (!this.rotationMode || this.needsVideo('rotate')) return;
    const rotated = rotatePiece(this.state, index, true);
    if (!rotated) { this.notify('这块旋转后没有变化，不消耗次数'); return; }
    this.state = rotated; this.selected = index; this.ghost = null; this.hint = null;
    this.notify('可以继续点选试转，放入棋盘后扣 1 次');
  }
  private commit(hint: Hint) {
    this.updateLevelClock();
    const wasTutorial = this.state.tutorial;
    const previousGoals = getLevelGoals(this.state);
    const signature = (piece?: Piece | null) => piece?.cells.map(c => `${c.x},${c.y}`).sort().join(';');
    const rotated = this.rotationMode && signature(this.state.pieces[hint.index]) !== signature(this.rotationOriginals?.[hint.index]);
    if (rotated && this.needsVideo('rotate')) return false;
    const result = placePiece(this.state, hint.index, hint.x, hint.y);
    if (!result) return false;
    this.beginLevelClock();
    const tone = this.state.pieces[hint.index]?.color ?? 0;
    const cleared = result.cleared.map(p => ({ ...p, tone: (this.state.board[p.y][p.x] || tone + 1) - 1 }));
    if (rotated) {
      const next = consumeInventory(this.economy, 'rotate'); if (!next) return false; this.saveEconomy(next);
      this.powerUses.rotate++;
    }
    this.state = result.state;
    if (getLevelGoals(this.state).some((goal, i) => goal.current > previousGoals[i].current)) this.goalPulseAt = Date.now();
    if (this.starScores().some(score => this.state.score >= score && this.state.score - result.gained < score)) this.earnedStarAt = Date.now();
    this.powerMessage = '';
    if (this.rotationMode) {
      this.rotationOriginals = this.state.pieces.map((piece, i) => piece && this.rotationOriginals?.[i]?.id === piece.id ? this.rotationOriginals[i] : piece);
      if (this.needsVideo('rotate') || this.state.status !== 'playing') this.stopRotation();
    }
    this.toast.at = 0;
    this.scoreAt = Date.now();
    if (this.state.mode === 'endless' && this.state.score > this.bestScore) { this.bestScore = this.state.score; try { this.options.onBest?.(this.bestScore); } catch { /* Storage must not interrupt a move. */ } }
    this.postponeGuide();
    this.selected = -1; this.ghost = null; this.hint = null; this.drag = null; this.pendingBoard = false;
    this.flash = result.cleared.length ? result.cleared : result.placed;
    this.flashAt = Date.now();
    const lines = result.rows.length + result.columns.length;
    this.placeFx = { at: Date.now(), cells: result.placed.map(p => ({ ...p, tone })) };
    if (lines) this.clearFx = { at: Date.now(), cells: cleared, rows: result.rows, columns: result.columns, combo: this.state.combo, tone };
    this.gainFx = lines ? { at: Date.now(), x: this.board.x + (hint.x + 1) * this.cell, y: this.board.y + (hint.y + 1) * this.cell, tone } : null;
    this.pop = { text: lines ? wasTutorial ? '两行消除！' : this.state.combo > 1 ? `连消 ×${this.state.combo}` : lines > 1 ? `同时消除 ${lines} 线！` : '漂亮！' : '', at: Date.now() };
    const collected = getLevelGoals(this.state).map((goal, i) => ({ ...goal, delta: goal.current - previousGoals[i].current })).filter(goal => goal.kind !== 'lines' && goal.delta > 0);
    if (collected.length) this.pop.detail = collected.map(goal => `${goal.kind === 'gems' ? '星星' : goal.kind === 'color' ? COLOR_NAMES[goal.color ?? 0] : '薄冰'} +${goal.delta}`).join(' · ');
    const starGoal = getLevelGoals(this.state).findIndex((goal, i) => goal.kind === 'gems' && goal.current > previousGoals[i].current);
    if (starGoal >= 0 && this.gainFx) this.gainFx = { ...this.gainFx, star: true, goalIndex: starGoal };
    if (lines) this.burst(cleared, this.state.combo);
    this.feedback(lines ? 'clear' : 'place');
    this.announce(this.levelDefinition ? `${this.levelDefinition.title}，${getLevelGoals(this.state).map(goal => `${this.goalName(goal.kind, goal.color)}${Math.min(goal.current, goal.target)}/${goal.target}`).join('，')}。${this.state.status === 'won' ? '挑战成功！' : this.state.status === 'lost' ? '挑战结束，可以重试本关或选择其他玩法。' : ''}` : `${this.state.score}分，已消除${this.state.lines}条线。${this.state.status === 'won' ? '挑战成功！' : this.state.status === 'lost' ? '没有可放位置，可看广告复活或重新挑战。' : ''}`);
    if (wasTutorial) this.notify('学会啦！填满整行或整列，就会消除');
    if (this.state.status !== 'playing') {
      this.resultAt = Date.now();
      if (this.state.status === 'won') {
        if (this.levelDefinition) this.finishCampaignVictory();
        this.feedback('win'); this.celebrate();
      }
    }
    this.invalidate(); return true;
  }
  private reset(nextState = this.state.level ? createLevel(this.state.level.id) : createGame('endless', false)) {
    this.stopLevelClock(); this.levelClockStarted = false; this.pendingDestruction = null;
    this.rotationGuideAt = 0;
    this.sessionVersion++; this.powerUses = { refresh: 0, rotate: 0, revive: 0 }; this.powerGrants = { refresh: 3, rotate: 3 }; this.rewardBusy = false; this.powerMessage = ''; this.rotationMode = false; this.rotationOriginals = null;
    this.levelRunId = `${this.runPrefix}-${this.sessionVersion}`; this.settlement = null;
    this.state = nextState; this.selected = -1; this.ghost = null; this.hint = null; this.drag = null; this.overlay = null; this.acquireKind = null; this.acquireMessage = ''; this.particles = []; this.flash = []; this.clearFx = null; this.destructionFx = null; this.placeFx = null; this.gainFx = null; this.returnFx = null; this.rejected.at = 0; this.flashAt = 0; this.pop.at = 0; this.toast.at = 0; this.resultAt = 0; this.keyboardCell = { x: 0, y: 0 }; this.pendingButton = -1; this.pendingBoard = false; this.postponeGuide();
    this.resize(this.width, this.height, this.ratio, this.resizeMetrics.safeTop, this.resizeMetrics.safeBottom, this.resizeMetrics.headerCenterY);
    if (this.needsLesson()) this.overlay = 'lesson';
    this.announce(this.levelDefinition ? `第${this.levelDefinition.number}关，${this.difficultyLabel()}。${this.levelDefinition.description}` : '已从空棋盘重新开始无限挑战。'); this.invalidate();
  }
  keyDown(key: string): boolean {
    this.updateLevelClock();
    if (this.disposed || this.paused) return false;
    if (this.rewardBusy) return true;
    this.postponeGuide();
    if (this.overlay === 'settings' || this.overlay === 'acquire') {
      if (key === 'Escape') { this.overlay = null; this.acquireKind = null; this.postponeGuide(); this.invalidate(); }
      return true;
    }
    if (this.overlay === 'leaderboard') { if (key === 'Escape') this.closeRanking(); return true; }
    if (this.overlay === 'lesson') {
      if (key === 'Escape' || key === 'Enter' || key === ' ') this.dismissLesson();
      return true;
    }
    if (key === 'Escape') { this.overlay = null; this.stopRotation(); this.pointerCancel(); this.invalidate(); return true; }
    if (this.overlay === 'levels') {
      if (/^[0-9]$/.test(key)) this.startLevel(LEVELS[this.levelPage * 10 + (key === '0' ? 9 : Number(key) - 1)].id);
      else if (key === 'ArrowLeft' || key === 'ArrowRight') { this.levelPage = Math.max(0, Math.min(2, this.levelPage + (key === 'ArrowLeft' ? -1 : 1))); this.invalidate(); }
      else if (key === 'Enter') this.continueCampaign();
      return true;
    }
    if (key.toLowerCase() === 'l') { this.openLevels(); return true; }
    if (key.toLowerCase() === 'v') { this.openPower('revive'); return true; }
    if (this.state.status === 'won' && key === 'Enter') { this.modalAction(0); return true; }
    if (this.state.status === 'lost' && key === 'Enter') { this.modalAction(this.levelDefinition ? 1 : 0); return true; }
    if (this.state.status !== 'playing') return false;
    if (key.toLowerCase() === 'x') { this.openPower('refresh'); return true; }
    if (key.toLowerCase() === 't') { this.openPower('rotate'); return true; }
    if (/^[1-6]$/.test(key)) {
      const index = Number(key) - 1;
      if (this.rotationMode) { if (this.state.pieces[index]) this.beginLevelClock(); this.tryRotation(index); return true; }
      if (this.blocked(index)) { this.rejectPiece(index); return true; }
      if (this.state.pieces[index]) { this.beginLevelClock(); this.selected = index; this.ghost = { index, ...this.keyboardCell }; this.invalidate(); }
      return true;
    }
    if (key.startsWith('Arrow') && this.selected >= 0) {
      const point = this.ghost || this.keyboardCell;
      this.keyboardCell = { x: Math.max(0, Math.min(7, point.x + (key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0))), y: Math.max(0, Math.min(7, point.y + (key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0))) };
      this.ghost = { index: this.selected, ...this.keyboardCell }; this.invalidate(); return true;
    }
    if (key === 'Enter' && this.ghost) { if (!this.commit(this.ghost!)) this.notify('这个位置放不下'); return true; }
    return false;
  }

  private get testConvenience() { return this.options.testConvenience === true; }
  private requestReward(kind: RewardPlacement): Promise<RewardResult> {
    if (this.testConvenience) return Promise.resolve('completed');
    return this.options.rewarded ? this.options.rewarded.request(kind) : Promise.resolve('unavailable');
  }
  private needsVideo(kind: RewardPlacement) {
    return kind === 'revive' || kind === 'doubleCoins' || this.economy.inventory[kind] <= 0;
  }
  private powerEffect(kind: 'refresh' | 'revive' | DestructivePower): { state: GameState; cleared: Cell[]; area?: Cell[] } | null {
    if (kind === 'revive') return reviveGame(this.state);
    if (kind === 'bomb') return applyBomb(this.state, 0);
    if (kind === 'bulldozer') return applyBulldozer(this.state);
    const state = refreshPieces(this.state);
    return state ? { state, cleared: [] } : null;
  }
  private openPower(kind: RewardPlacement) {
    if (this.disposed || this.rewardBusy || this.overlay) return;
    if (kind === 'doubleCoins') { void this.doubleCoins(); return; }
    if (this.state.tutorial) return this.notify('先完成这一步，就能使用道具啦');
    if (kind !== 'revive' && this.needsVideo(kind)) { this.stopRotation(); this.openAcquire(kind); return; }
    if (kind === 'hint') {
      if (this.state.status !== 'playing') return;
      if (!requestHint(this.state)) return this.notify('当前没有可提示的落点');
      this.stopRotation(); this.pointerCancel(); void this.confirmPower(kind); return;
    }
    if (kind === 'bomb' || kind === 'bulldozer') {
      if (this.state.status !== 'lost' && this.state.status !== 'playing') return;
      this.stopRotation();
      if (!this.powerEffect(kind)) { this.powerMessage = isLevelExpired(this.state) ? '时间已用尽，可以免费重试本关' : kind === 'bomb' ? '没有可清除区域，可以免费重试' : '底部三排已经清空，无需使用'; this.notify(this.powerMessage); return; }
      this.pointerCancel(); this.powerMessage = ''; void this.confirmPower(kind); return;
    }
    if (kind === 'revive') {
      if (this.powerUses.revive >= 1) return this.notify('本局的复活机会已用完，可以免费重来');
      if (this.state.status !== 'lost') return this.notify('没有位置可放时，可以用复活继续挑战');
      if (this.levelDefinition && !this.powerEffect('revive')) return this.notify('本关已无法复活，可以免费重试');
      this.powerMessage = ''; void this.confirmPower(kind); return;
    } else if (this.state.status !== 'playing') return;
    if (kind === 'rotate') {
      if (this.rotationMode) { this.stopRotation(); this.notify('已退出旋转，未放置的木块恢复原方向'); return; }
      if (!this.state.pieces.some((_, i) => rotatePiece(this.state, i, true))) return this.notify('这一组旋转后没有变化，不消耗次数');
    } else {
      this.stopRotation();
      if (this.state.status !== 'playing') return;
      if (!this.powerEffect(kind)) return this.notify('剩余木块已经是单格，不消耗次数');
    }
    this.pointerCancel(); this.powerMessage = ''; void this.confirmPower(kind);
  }
  private async confirmPower(kind: RewardPlacement) {
    if (kind === 'doubleCoins') { await this.doubleCoins(); return; }
    const destructivePower = kind === 'bomb' || kind === 'bulldozer';
    if (this.rewardBusy || this.disposed || this.overlay || this.state.tutorial || (kind === 'revive' ? this.state.status !== 'lost' : destructivePower ? this.state.status !== 'lost' && this.state.status !== 'playing' : this.state.status !== 'playing')) return;
    if (kind === 'revive' && this.powerUses.revive >= 1) return;
    const effect = kind === 'rotate' || kind === 'hint' ? null : this.powerEffect(kind);
    if (kind !== 'rotate' && kind !== 'hint' && !effect) return;
    const state = this.state, version = this.sessionVersion;
    if (kind !== 'revive' && this.needsVideo(kind)) { this.openAcquire(kind); return; }
    if (kind === 'revive') {
      this.rewardBusy = true; this.powerMessage = '正在打开广告，请稍候'; this.notify(this.powerMessage);
      let result: RewardResult;
      try { result = await this.requestReward(kind); }
      catch { result = 'error'; }
      if (this.disposed || version !== this.sessionVersion) return;
      this.rewardBusy = false;
      if (this.state !== state) { this.powerMessage = '游戏进度已变化，请重新选择道具'; this.invalidate(); return; }
      if (result !== 'completed') {
        this.powerMessage = result === 'cancelled' ? '未看完广告，次数未扣除' : result === 'busy' ? '广告正在播放，请稍后再试' : '广告暂不可用，请稍后再试';
        this.notify(this.powerMessage); return;
      }
    }
    if (this.disposed || this.state !== state || version !== this.sessionVersion) return;
    if (kind === 'hint') {
      const hint = requestHint(this.state), next = consumeInventory(this.economy, 'hint');
      if (!hint || !next) return;
      this.saveEconomy(next); this.hint = hint; this.selected = -1; this.ghost = null;
      this.notify(`已标出第 ${hint.index + 1} 块方块的落点，拖入即可`); return;
    }
    if (kind === 'rotate') {
      this.rotationMode = true; this.rotationOriginals = this.state.pieces.slice(); this.powerMessage = '';
      this.rotationGuideAt = Date.now();
      this.notify('点木块试转，再拖入棋盘；点旋转按钮退出'); return;
    }
    if (kind === 'bomb' || kind === 'bulldozer') {
      this.stopRotation();
      const destructive = kind === 'bomb' ? applyBomb(this.state) : applyBulldozer(this.state);
      if (!destructive) return;
      const next = consumeInventory(this.economy, kind); if (!next) return;
      const at = Date.now();
      this.pendingDestruction = { kind, at, impactMs: kind === 'bomb' ? 460 : 650,
        before: this.state, currentBoard: this.state.board, column: -1, charged: false,
        effect: destructive, economy: next, version: this.sessionVersion };
      this.rewardBusy = true; this.stopLevelClock(); this.pointerCancel();
      this.selected = -1; this.hint = null; this.clearFx = null; this.placeFx = null; this.gainFx = null; this.returnFx = null;
      this.destructionFx = { kind, at, area: destructive.area };
      this.resultAt = at + 2000; this.pop.at = 0; this.powerMessage = '';
      this.invalidate(); return;
    }
    if (kind === 'refresh') {
      const next = consumeInventory(this.economy, 'refresh'); if (!next) return; this.saveEconomy(next);
    }
    this.state = effect!.state; this.powerUses[kind]++; this.rotationMode = false; this.rotationOriginals = null;
    this.pointerCancel(); this.selected = -1; this.hint = null; this.overlay = null; this.powerMessage = ''; this.resultAt = 0; this.pop.at = 0;
    this.flash = effect!.cleared; this.flashAt = Date.now();
    if (effect!.cleared.length) this.burst(effect!.cleared);
    this.feedback(kind === 'revive' ? 'clear' : 'place');
    this.notify(kind === 'revive' ? '空间腾好啦，保留分数继续挑战' : '剩余木块变为单格，找个空位放进去');
    this.invalidate();
  }
  private async doubleCoins() {
    const reward = this.settlement;
    if (this.rewardBusy || this.disposed || this.overlay || this.state.status !== 'won' || !reward?.canDouble) return;
    const state = this.state, version = this.sessionVersion;
    this.rewardBusy = true; this.powerMessage = '正在打开广告，请稍候'; this.invalidate();
    let result: RewardResult;
    try { result = await this.requestReward('doubleCoins'); } catch { result = 'error'; }
    if (this.disposed || version !== this.sessionVersion) return;
    this.rewardBusy = false;
    if (this.state !== state || this.settlement?.runId !== reward.runId) return;
    if (result !== 'completed') { this.powerMessage = result === 'cancelled' ? '未看完广告，金币未变化' : '广告暂不可用，金币未变化'; this.invalidate(); return; }
    const doubled = doubleReward(this.economy, reward.runId);
    if (doubled) { this.saveEconomy(doubled.state); this.settlement = { ...reward, canDouble: false }; this.powerMessage = `双倍已领取，额外 +${doubled.coinsGranted} 金币`; }
    this.invalidate();
  }

  private advanceDestruction(now: number) {
    const pending = this.pendingDestruction;
    if (!pending) return;
    if (this.disposed || pending.version !== this.sessionVersion || this.state.mode !== pending.before.mode ||
      this.state.level?.id !== pending.before.level?.id || this.state.board !== pending.currentBoard || isLevelExpired(this.state)) {
      this.pendingDestruction = null; this.rewardBusy = false; this.destructionFx = null; return;
    }
    const age = now - pending.at;
    let effect: Destruction | null = null, cleared: Cell[] = [];
    if (pending.kind === 'bulldozer') {
      // The blade is .41 model-width in front of its center. Match its visible
      // position in drawDestruction, clearing each contacted column immediately.
      const progress = Math.min(1, Math.max(0, age / 1100 * 1.5));
      const column = Math.max(-1, Math.min(7, Math.floor(-1.5 + progress * 11 + 1.23)));
      if (column > pending.column) {
        const previous = pending.column; pending.column = column;
        effect = applyBulldozer(pending.before, column);
        if (effect) cleared = effect.cleared.filter(cell => cell.x > previous);
      }
    } else {
      if (age < pending.impactMs) return;
      effect = pending.effect; cleared = effect.cleared;
    }
    if (effect) {
      const remaining = this.state.level?.timeRemainingMs;
      this.state = effect.state;
      if (this.state.level && remaining !== undefined) this.state = { ...this.state, level: { ...this.state.level, timeRemainingMs: remaining } };
      pending.currentBoard = this.state.board;
      if (!pending.charged) { this.saveEconomy(pending.economy); pending.charged = true; }
      if (cleared.length) {
        this.flash = cleared; this.flashAt = now; this.goalPulseAt = now;
        this.burst(cleared.map(cell => ({ ...cell, tone: Math.max(0, pending.before.board[cell.y][cell.x] - 1) })), 2);
        this.feedback('clear');
      }
    }
    if (pending.kind === 'bulldozer' && age < 740) return;
    this.pendingDestruction = null; this.rewardBusy = false; this.levelClockAt = null;
    this.resultAt = this.state.status === 'playing' ? 0 : now;
    this.notify(pending.kind === 'bomb' ? '炸弹已清除一片 3×3 区域' : '推土机已清除底部三排');
    if (this.state.status === 'won') { this.finishCampaignVictory(); this.feedback('win'); this.celebrate(); }
  }
  private rounded(x: number, y: number, w: number, h: number, r: number) {
    const c = this.ctx; r = Math.min(r, w / 2, h / 2);
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  private panel(r: Rect, fill: string, radius = 12, stroke?: string) {
    this.rounded(r.x, r.y, r.w, r.h, radius); this.ctx.fillStyle = fill; this.ctx.fill(); if (stroke) { this.ctx.strokeStyle = stroke; this.ctx.lineWidth = 1; this.ctx.stroke(); }
  }
  private skin(r: Rect, id = 'ui_modal_panel') {
    if (!this.assets.draw(this.ctx, id, r.x, r.y, r.w, r.h, true)) this.panel(r, '#174184', 15, '#5b9bdd');
  }
  private icon(id: string, cx: number, cy: number, w: number, h = w) {
    this.assets.fit(this.ctx, id, cx - w / 2, cy - h / 2, w, h);
  }
  private drawRotateGlyph(x: number, y: number, size: number, now: number) {
    const angle = Math.max(0, now - this.rotationGuideAt) / 1200 * Math.PI * 2;
    this.ctx.save(); this.ctx.translate(x, y); this.ctx.rotate(angle);
    this.icon('icon_rotate', 0, 0, size); this.ctx.restore();
  }
  private button(r: Rect, label: string, style: 'primary' | 'secondary' | 'gold' = 'primary', enabled = true, textSize = 14) {
    this.skin(r, 'ui_button_' + (enabled ? style : 'disabled'));
    this.text(label, r.x + r.w / 2, r.y + r.h / 2 - .5, textSize,
      !enabled ? '#a3bbdb' : style === 'primary' ? '#073f3d' : style === 'gold' ? '#5c3809' : '#f2f7ff', 'center', 700);
  }
  private text(text: string, x: number, y: number, size = 14, color = C.ink, align: CanvasTextAlign = 'left', weight = 400) {
    const c = this.ctx; c.font = `${weight} ${size}px ${FONT}`; c.textAlign = align; c.textBaseline = 'middle'; c.fillStyle = color; c.fillText(text, x, y);
  }
  private line(x1: number, y1: number, x2: number, y2: number, color: string, width = 1) {
    const c = this.ctx; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.strokeStyle = color; c.lineWidth = width; c.stroke();
  }
  private tile(x: number, y: number, size: number, tone = 0, muted = false) {
    const c = this.ctx, color = ((tone % TILE_IDS.length) + TILE_IDS.length) % TILE_IDS.length;
    c.save();
    if (muted) { c.globalAlpha *= .42; if ('filter' in c) c.filter = 'grayscale(1)'; }
    if (!this.assets.draw(c, TILE_IDS[color], x, y, size, size))
      this.panel({ x: x + 1, y: y + 1, w: size - 2, h: size - 2 }, muted ? '#526687' : TONES[color].base, size * .1);
    c.restore();
  }
  private piece(piece: Piece, x: number, y: number, size: number, opacity = 1, muted = false) {
    this.ctx.save(); this.ctx.globalAlpha = opacity;
    for (const cell of piece.cells) this.tile(x + cell.x * size, y + cell.y * size, size, piece.color ?? 0, muted);
    const star = piece.star && piece.cells[0];
    if (star) {
      this.ctx.save(); if (muted) { this.ctx.globalAlpha *= .42; if ('filter' in this.ctx) this.ctx.filter = 'grayscale(1)'; }
      this.collectibleStar(x + (star.x + .5) * size, y + (star.y + .5) * size, size, piece.color ?? 0);
      this.ctx.restore();
    }
    this.ctx.restore();
  }
  private preview(hint: Hint, isHint: boolean) {
    const piece = this.state.pieces[hint.index]; if (!piece) return;
    const valid = canPlacePiece(this.state, hint.index, hint.x, hint.y); const c = this.ctx;
    if (!valid) return;
    const color = TONES[piece.color ?? 0].light;
    for (const cell of piece.cells) {
      const x = hint.x + cell.x, y = hint.y + cell.y;
      if (x < 0 || y < 0 || x >= 8 || y >= 8) continue;
      if (!isHint) { c.save(); c.globalAlpha = .55; this.tile(this.board.x + x * this.cell, this.board.y + y * this.cell, this.cell, piece.color ?? 0); c.restore(); }
      else this.panel({ x: this.board.x + x * this.cell + 2, y: this.board.y + y * this.cell + 2, w: this.cell - 4, h: this.cell - 4 }, this.levelDefinition ? `${TONES[piece.color ?? 0].base}44` : '#76d9ff44', 4);
      c.save(); c.setLineDash(isHint ? [4, 3] : []); c.lineWidth = 1.5; c.strokeStyle = isHint && !this.levelDefinition ? '#b2f7ff' : color; this.rounded(this.board.x + x * this.cell + 3, this.board.y + y * this.cell + 3, this.cell - 6, this.cell - 6, 4); c.stroke(); c.restore();
    }
    const star = piece.star && piece.cells[0];
    if (star) {
      c.save(); c.globalAlpha = isHint ? .8 : .55;
      this.collectibleStar(this.board.x + (hint.x + star.x + .5) * this.cell,
        this.board.y + (hint.y + star.y + .5) * this.cell, this.cell, piece.color ?? 0);
      c.restore();
    }
    if (valid && !isHint) {
      const occupied = (x: number, y: number) => this.state.board[y][x] || piece.cells.some(p => p.x + hint.x === x && p.y + hint.y === y);
      for (let i = 0; i < 8; i++) {
        if (Array.from({ length: 8 }, (_, x) => occupied(x, i)).every(Boolean)) this.panel({ x: this.board.x, y: this.board.y + i * this.cell, w: this.board.w, h: this.cell }, `${TONES[piece.color ?? 0].base}88`, 2);
        if (Array.from({ length: 8 }, (_, y) => occupied(i, y)).every(Boolean)) this.panel({ x: this.board.x + i * this.cell, y: this.board.y, w: this.cell, h: this.board.h }, `${TONES[piece.color ?? 0].base}88`, 2);
      }
    }
  }
  private draw() {
    const c = this.ctx; const now = Date.now();
    this.advanceDestruction(now); this.updateLevelClock(now);
    c.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    c.fillStyle = '#10275e'; c.fillRect(0, 0, this.width, this.height);
    this.assets.background(c, 0, 0, this.width, this.height);
    c.translate(this.offsetX, this.offsetY); c.scale(this.scale, this.scale);
    this.drawHeader(now); this.drawBoard(now); this.drawTray(now); this.drawPowers();
    if (this.guideVisible()) this.drawTutorialGuide(now);
    if (this.drag?.moved) {
      const p = this.dragPosition(); c.save(); c.shadowColor = '#30201455'; c.shadowBlur = 15; c.shadowOffsetY = 9; this.piece(this.state.pieces[this.drag.index]!, p.x, p.y, this.cell, .94); c.restore();
    }
    this.drawReturn(now);
    this.drawParticles(now);
    this.drawGain(now);
    this.drawPop(now);
    if (now - this.toast.at < 2300 && this.state.status === 'playing' && !this.overlay) {
      c.save(); c.globalAlpha = Math.min(1, (2300 - (now - this.toast.at)) / 220);
      const tw = Math.min(350, this.toast.text.length * 13 + 34); const ty = this.board.y + this.board.h - 42;
      this.panel({ x: (390 - tw) / 2, y: ty, w: tw, h: 32 }, '#0b163bf0', 16); this.text(this.toast.text, 195, ty + 16, 12, '#edf7ff', 'center'); c.restore();
    }
    if (this.overlay === 'settings') this.drawSettings();
    else if (this.overlay === 'acquire') this.drawAcquire();
    else if (this.overlay === 'levels') this.drawLevelMenu();
    else if (this.overlay === 'lesson') this.drawLesson();
    else if (this.overlay === 'leaderboard') this.drawRanking();
    else if (this.state.status !== 'playing' && now - this.resultAt > 520) this.drawModal();
  }
  private starScores(): [number, number, number] {
    return this.levelDefinition?.starScores ?? [300, 800, 1500];
  }
  private scoreProgress(): number {
    const bands = this.starScores();
    let previous = 0;
    for (let i = 0; i < 3; i++) {
      if (this.state.score < bands[i]) return (i + (this.state.score - previous) / Math.max(1, bands[i] - previous)) / 3;
      previous = bands[i];
    }
    return 1;
  }
  private drawHeader(now: number) {
    const c = this.ctx, top = this.safeTop, settings = this.settingsButton();
    this.skin(settings, 'ui_icon_button');
    this.icon('icon_settings', settings.x + settings.w / 2, settings.y + settings.h / 2, 32);
    this.text(this.state.tutorial ? '初次体验' : this.levelDefinition ? '第 ' + this.levelDefinition.number + ' 关' : '无限挑战',
      195, top + 18, 22, '#f2f6ff', 'center', 750);
    const y = top + 42, h = this.headerScale < 1 ? 60 : 67, valueY = y + h * .68;
    const task = { x: 10, y: y - 5, w: 370, h: h + 10 };
    c.save();
    c.shadowColor = '#78f4d3'; c.shadowBlur = Math.max(0, 1 - (now - this.goalPulseAt) / 700) * 8;
    this.skin(task, 'ui_task_strip'); c.restore();
    if (this.state.tutorial) {
      this.text('填满整行或整列即可消除', 195, y + h / 2, 13, '#eef8ff', 'center', 600);
      return;
    }
    const goals = getLevelGoals(this.state);
    if (this.levelDefinition) {
      const width = 348 / Math.max(1, goals.length), countSize = 21;
      goals.forEach((goal, i) => {
        const x = 21 + width * i, done = goal.current >= goal.target;
        if (i) this.line(x, y + 12, x, y + h - 11, '#8fc7ff44');
        this.text(this.goalName(goal.kind, goal.color), x + width / 2, y + 17, 13, '#d2e5ff', 'center', 600);
        const center = x + width / 2;
        const progress = goal.current + '/' + goal.target, iconWidth = goal.kind === 'gems' ? 28 : 24, gap = 4;
        c.font = `750 ${countSize}px ${FONT}`;
        const progressWidth = done ? 19 : typeof c.measureText === 'function' ? c.measureText(progress).width : progress.length * countSize * .58;
        const left = center - (iconWidth + gap + progressWidth) / 2;
        this.goalIcon(goal.kind, left + iconWidth / 2, valueY, goal.color);
        if (done) this.check(left + iconWidth + gap + progressWidth / 2, valueY, '#8ff1cf');
        else this.text(progress, left + iconWidth + gap, valueY + 1.5, countSize, '#f5f8ff', 'left', 750);
      });
    } else {
      const stats = [
        { label: '消除行列', value: this.state.lines + '行' },
        { label: '当前连消', value: this.state.combo + '次' },
        { label: '挑战', value: '无步数限制' },
      ];
      stats.forEach((stat, i) => {
        const x = 74 + i * 121;
        if (i) this.line(x - 60, y + 12, x - 60, y + h - 11, '#8fc7ff44');
        this.text(stat.label, x, y + 17, 12, '#c0d9f6', 'center');
        this.text(stat.value, x, valueY + 1.5, i === 2 ? 13 : 19, i === 2 ? '#ffe58a' : '#f2f7ff', 'center', 700);
      });
    }
  }
  private coinIcon(x: number, y: number, r: number) {
    this.icon('icon_coin', x, y, r * 2.5);
  }
  private check(x: number, y: number, _color: string) {
    this.icon('icon_check', x, y, 19);
  }
  private goalIcon(kind: LevelGoalKind, x: number, y: number, color = 0) {
    if (kind === 'gems') this.icon('goal_star_outline', x, y, 28);
    else if (kind === 'color') this.tile(x - 12, y - 12, 24, color);
    else if (kind === 'lines') this.icon('goal_lines', x, y, 24);
    else this.icon('goal_star_outline', x, y, 24);
  }
  private drawBoard(now: number) {
    const b = this.board, c = this.ctx;
    c.save();
    const impact = this.clearFx ? now - this.clearFx.at : 1000;
    if (impact < 160 && this.clearFx && (this.clearFx.combo > 1 || this.clearFx.rows.length + this.clearFx.columns.length > 1)) {
      const power = (1 - impact / 160) * 2.3;
      c.translate(Math.sin(impact * .12) * power, Math.cos(impact * .16) * power * .5);
    }
    this.skin({ x: b.x - 9, y: b.y - 9, w: b.w + 18, h: b.h + 18 }, 'ui_icon_button');
    this.panel({ x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 }, '#071b45', 6);
    const placing = this.placeFx && now - this.placeFx.at < 280 ? this.placeFx : null;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      this.assets.draw(c, 'ui_empty_cell', b.x + x * this.cell, b.y + y * this.cell, this.cell, this.cell);
      const value = this.state.board[y][x];
      if (value && !placing?.cells.some(p => p.x === x && p.y === y)) this.tile(b.x + x * this.cell, b.y + y * this.cell, this.cell, value - 1);
    }
    if (placing) {
      const t = (now - placing.at) / 280, scale = 1 + Math.sin(t * Math.PI) * .075;
      for (const p of placing.cells) if (this.state.board[p.y][p.x]) {
        const size = this.cell * scale, offset = (this.cell - size) / 2;
        this.tile(b.x + p.x * this.cell + offset, b.y + p.y * this.cell + offset, size, p.tone);
        if (t < .5) {
          c.save(); c.globalAlpha = (.5 - t) * .6;
          this.panel({ x: b.x + p.x * this.cell + 2, y: b.y + p.y * this.cell + 2, w: this.cell - 4, h: this.cell - 4 }, '#ffffff', 4); c.restore();
        }
      }
    } else this.placeFx = null;
    if (this.state.tutorial) {
      c.save(); c.globalAlpha = this.guideVisible() ? .8 + Math.sin((now - this.guideAt!) / 340) * .2 : .8;
      this.preview(TUTORIAL_MOVE, true); c.restore();
    }
    if (this.ghost) this.preview(this.ghost, false);
    if (this.hint && !this.drag && !this.rotationMode) this.preview(this.hint, true);
    if (this.state.level) this.drawObjectives();
    if (this.clearFx && now - this.clearFx.at < 1000) this.drawClear(now, this.clearFx);
    else {
      this.clearFx = null;
      if (now - this.flashAt < 300) {
        c.save(); c.globalAlpha = (1 - (now - this.flashAt) / 300) * .5;
        for (const p of this.flash) this.panel({ x: b.x + p.x * this.cell + 1, y: b.y + p.y * this.cell + 1, w: this.cell - 2, h: this.cell - 2 }, '#c4f4ff', 4);
        c.restore();
      }
    }
    if (this.destructionFx) this.drawDestruction(now);
    c.restore();
  }
  private drawDestruction(now: number) {
    const fx = this.destructionFx!, age = now - fx.at, c = this.ctx;
    const minX = Math.min(...fx.area.map(p => p.x)), minY = Math.min(...fx.area.map(p => p.y));
    const maxX = Math.max(...fx.area.map(p => p.x)) + 1, maxY = Math.max(...fx.area.map(p => p.y)) + 1;
    const x = this.board.x + minX * this.cell, y = this.board.y + minY * this.cell;
    const w = (maxX - minX) * this.cell, h = (maxY - minY) * this.cell;
    if (fx.kind === 'bomb' && age < 460) {
      const t = Math.max(0, age / 460), dock = this.dock[3];
      const start = { x: dock.x + dock.w / 2, y: dock.y + 30 }, end = { x: x + w / 2, y: y + h / 2 };
      const bx = start.x + (end.x - start.x) * t;
      const by = start.y + (end.y - start.y) * t - 4 * Math.max(120, this.board.h * .42) * t * (1 - t);
      c.save();
      c.globalAlpha = .35; c.strokeStyle = '#ffdc87'; c.lineWidth = 1.5;
      this.rounded(x + 2, y + 2, w - 4, h - 4, 7); c.stroke();
      c.globalAlpha = 1; c.translate(bx, by); c.rotate(-.35 + t * 1.1);
      c.shadowColor = '#ffcb64'; c.shadowBlur = 12;
      this.icon('icon_bomb', 0, 0, 46 * (1 - t * .12)); c.restore();
      return;
    }
    const t = fx.kind === 'bomb' ? (age - 460) / 660 : age / 1100;
    if (t >= 1) { this.destructionFx = null; return; }
    c.save(); this.rounded(this.board.x, this.board.y, this.board.w, this.board.h, 6); c.clip();
    if (fx.kind === 'bomb') {
      c.globalAlpha = Math.max(0, 1 - t);
      this.panel({ x, y, w, h }, '#ffb65a55', 4);
      const radius = Math.max(2, w * .64 * Math.min(1, t * 2));
      c.shadowColor = '#ffad54'; c.shadowBlur = 24; c.strokeStyle = '#fff0b4'; c.lineWidth = 4 * (1 - t) + 1;
      c.beginPath(); c.arc(x + w / 2, y + h / 2, radius, 0, Math.PI * 2); c.stroke();
      for (let i = 0; i < 10; i++) {
        const angle = i * Math.PI / 5;
        this.star(x + w / 2 + Math.cos(angle) * radius, y + h / 2 + Math.sin(angle) * radius, 2 + (1 - t) * 4, '#ffe6a6');
      }
    } else {
      const modelW = this.cell * 3, modelH = modelW * .9;
      const progress = Math.min(1, t * 1.5), sweep = x - modelW / 2 + progress * (w + modelW);
      c.globalAlpha = Math.min(1, (1 - t) * 5);
      this.panel({ x: x, y: y + 2, w: Math.max(0, sweep - x), h: h - 4 }, '#ffe29a22', 3);
      this.icon('icon_bulldozer', sweep, y + h / 2, modelW, modelH);
      c.shadowColor = '#ffe08e'; c.shadowBlur = 10;
      this.line(sweep + modelW * .41, y + 6, sweep + modelW * .41, y + h - 6, '#fff0b488', 3);
    }
    c.restore();
  }
  private goalName(kind: LevelGoalKind, color?: number) { return kind === 'lines' ? '消除行列' : kind === 'gems' ? '收集星星' : kind === 'color' ? `${COLOR_NAMES[color ?? 0]}方块` : '清除薄冰'; }
  private inventoryName(kind: InventoryKind) { return TOOL_NAMES[kind]; }
  private collectibleStar(x: number, y: number, size: number, tone?: number) {
    if (tone === undefined) this.icon('goal_star_outline', x, y, size * .78);
    else this.assets.draw(this.ctx, STAR_TILE_IDS[((tone % STAR_TILE_IDS.length) + STAR_TILE_IDS.length) % STAR_TILE_IDS.length],
      x - size / 2, y - size / 2, size, size);
  }
  private drawObjectives() {
    const c = this.ctx, size = this.cell, b = this.board;
    for (const p of this.state.level!.ice) {
      const x = b.x + p.x * size + 2, y = b.y + p.y * size + 2, side = size - 4;
      this.panel({ x, y, w: side, h: side }, '#8ee7ff55', 3, '#c6f7ff');
      this.line(x + side * .15, y + side * .12, x + side * .54, y + side * .46, '#f2fdff', Math.max(1, size * .035));
      this.line(x + side * .54, y + side * .46, x + side * .42, y + side * .84, '#effcff', Math.max(1, size * .035));
      this.line(x + side * .54, y + side * .46, x + side * .85, y + side * .39, '#f2fdff', Math.max(1, size * .035));
      c.save(); c.globalAlpha = .7; this.star(x + side * .8, y + side * .18, size * .055, '#ffffff'); c.restore();
    }
    for (const p of this.state.level!.gems) this.collectibleStar(b.x + (p.x + .5) * size, b.y + (p.y + .5) * size, size, Math.max(0, this.state.board[p.y][p.x] - 1));
  }
  private drawTray(now: number) {
    const c = this.ctx;
    const labelY = this.board.y + this.board.h + 14;
    const hasBlocked = this.state.pieces.some((_, i) => this.blocked(i));
    const label = this.state.tutorial ? '选出能填满空位的一块' : this.rotationMode ? '点选试转 · 拖入放置' : hasBlocked ? '灰块暂不可放' : '';
    if (label) this.text(label, 195, labelY, 10, this.state.tutorial || this.rotationMode ? '#a4f7e3' : C.muted, 'center');
    this.slots.forEach((originalSlot, i) => {
      const elapsed = now - this.rejected.at;
      const offset = this.rejected.index === i && elapsed < 280 ? Math.sin(elapsed / 23) * 3 * (1 - elapsed / 280) : 0;
      const slot = { ...originalSlot, x: originalSlot.x + offset };
      const piece = this.state.pieces[i];
      if (this.state.tutorial && !piece) return;
      const blocked = this.blocked(i);
      if (!piece) return;
      const bounds = getPieceBounds(piece); const size = Math.min(30, 108 / bounds.width, (slot.h - 6) / bounds.height);
      const returning = this.returnFx?.index === i && now - this.returnFx.at < 230;
      const pieceX = slot.x + (slot.w - bounds.width * size) / 2, pieceY = slot.y + (slot.h - bounds.height * size) / 2 - 1;
      this.piece(piece, pieceX, pieceY, size, this.drag?.index === i && this.drag.moved || returning ? .2 : blocked ? .65 : 1, blocked);
      if (this.hint?.index === i && !this.drag) {
        c.save(); c.strokeStyle = TONES[piece.color ?? 0].light; c.lineWidth = 2;
        this.rounded(pieceX - 5, pieceY - 5, bounds.width * size + 10, bounds.height * size + 10, 6); c.stroke(); c.restore();
        this.text('提示方块', slot.x + slot.w / 2, pieceY - 13, 10, TONES[piece.color ?? 0].light, 'center', 600);
      }
      if (this.rotationMode && !(this.drag?.index === i && this.drag.moved)) {
        c.save(); c.globalAlpha = .5;
        c.shadowColor = '#031d51'; c.shadowBlur = 5;
        this.drawRotateGlyph(slot.x + slot.w / 2, slot.y + slot.h / 2, 30, now); c.restore();
      }
    });
  }
  private drawReturn(now: number) {
    const effect = this.returnFx;
    if (!effect) return;
    const elapsed = now - effect.at;
    if (elapsed >= 230 || !this.slots[effect.index]) { this.returnFx = null; return; }
    const slot = this.slots[effect.index], bounds = getPieceBounds(effect.piece);
    const targetSize = Math.min(30, 108 / bounds.width, (slot.h - 6) / bounds.height);
    const t = 1 - Math.pow(1 - elapsed / 230, 3);
    const x = slot.x + (slot.w - bounds.width * targetSize) / 2;
    const y = slot.y + (slot.h - bounds.height * targetSize) / 2 - 1;
    this.piece(effect.piece, effect.x + (x - effect.x) * t, effect.y + (y - effect.y) * t, this.cell + (targetSize - this.cell) * t, .94);
  }
  private drawClear(now: number, effect: ClearFx) {
    const c = this.ctx, b = this.board, elapsed = now - effect.at;
    const multiple = effect.rows.length + effect.columns.length > 1 || effect.combo > 1;
    const duration = multiple ? 940 : 780;
    if (elapsed >= duration) return;
    const tone = TONES[effect.tone % TONES.length], fade = Math.max(0, 1 - elapsed / duration);
    c.save();
    if (elapsed < 225) {
      const t = Math.max(0, (elapsed - 35) / 190), scale = Math.max(.04, 1.08 * (1 - t * t));
      c.globalAlpha = 1 - t;
      for (const p of effect.cells) if (!this.state.board[p.y][p.x]) {
        const size = Math.max(10, this.cell * scale), offset = (this.cell - size) / 2;
        this.tile(b.x + p.x * this.cell + offset, b.y + p.y * this.cell + offset, size, p.tone);
      }
    }
    this.rounded(b.x, b.y, b.w, b.h, 4); c.clip();
    const flash = Math.max(0, 1 - elapsed / 95);
    c.globalAlpha = flash * .86;
    for (const row of effect.rows) this.panel({ x: b.x, y: b.y + row * this.cell, w: b.w, h: this.cell }, '#f4fcff', 1);
    for (const column of effect.columns) this.panel({ x: b.x + column * this.cell, y: b.y, w: this.cell, h: b.h }, '#f4fcff', 1);
    const travel = Math.min(1, Math.max(0, (elapsed - 35) / 430));
    c.globalAlpha = fade * .94; c.shadowColor = tone.base; c.shadowBlur = multiple ? 24 : 16;
    const tail = this.cell * (multiple ? 2.8 : 2.1);
    for (const row of effect.rows) {
      const y = b.y + row * this.cell, head = b.x - this.cell + (b.w + this.cell * 2) * travel;
      this.panel({ x: b.x, y: y + 2, w: b.w, h: this.cell - 4 }, `${tone.base}44`, 3);
      const beam = c.createLinearGradient(head - tail, y, head + this.cell * .55, y);
      beam.addColorStop(0, `${tone.base}00`); beam.addColorStop(.5, `${tone.base}77`); beam.addColorStop(.8, tone.light); beam.addColorStop(.89, '#ffffff'); beam.addColorStop(1, `${tone.light}00`);
      this.panel({ x: b.x, y: y + 1, w: b.w, h: this.cell - 2 }, beam as unknown as string, 2);
      if (travel < 1) this.line(head - this.cell * .38, y + this.cell / 2, head + this.cell * .24, y + this.cell / 2, '#ffffff', 3);
    }
    for (const column of effect.columns) {
      const x = b.x + column * this.cell, head = b.y - this.cell + (b.h + this.cell * 2) * travel;
      this.panel({ x: x + 2, y: b.y, w: this.cell - 4, h: b.h }, `${tone.base}44`, 3);
      const beam = c.createLinearGradient(x, head - tail, x, head + this.cell * .55);
      beam.addColorStop(0, `${tone.base}00`); beam.addColorStop(.5, `${tone.base}77`); beam.addColorStop(.8, tone.light); beam.addColorStop(.89, '#ffffff'); beam.addColorStop(1, `${tone.light}00`);
      this.panel({ x: x + 1, y: b.y, w: this.cell - 2, h: b.h }, beam as unknown as string, 2);
      if (travel < 1) this.line(x + this.cell / 2, head - this.cell * .38, x + this.cell / 2, head + this.cell * .24, '#ffffff', 3);
    }
    c.restore();
    if (multiple) {
      c.save(); c.globalAlpha = Math.sin(Math.min(1, elapsed / duration) * Math.PI) * .85;
      c.shadowColor = tone.base; c.shadowBlur = 22;
      this.rounded(b.x - 6, b.y - 6, b.w + 12, b.h + 12, 10);
      c.strokeStyle = tone.light; c.lineWidth = 2.5; c.stroke();
      const progress = Math.min(1, elapsed / 430);
      for (const x of [b.x, b.x + b.w]) for (const y of [b.y, b.y + b.h]) this.star(x, y, 3 + (1 - progress) * 6, '#e7fcff');
      c.restore();
    }
  }
  private drawGain(now: number) {
    const fx = this.gainFx;
    if (!fx) return;
    const t = (now - fx.at) / 780;
    if (t >= 1) { this.gainFx = null; return; }
    const c = this.ctx, tone = TONES[fx.tone % TONES.length];
    const goalCount = Math.max(1, getLevelGoals(this.state).length), goalWidth = 348 / goalCount;
    const endX = this.levelDefinition ? 21 + goalWidth * ((fx.goalIndex ?? 0) + .5) - 26 : 74;
    const endY = this.safeTop + 42 + (this.headerScale < 1 ? 60 : 67) * .68;
    c.save(); c.shadowColor = tone.base; c.shadowBlur = 12;
    for (let tail = 0; tail < 6; tail++) {
      const at = Math.max(0, t - tail * .035), eased = at * at * (3 - 2 * at);
      const x = fx.x + (endX - fx.x) * eased + Math.sin(eased * Math.PI) * 32;
      const y = fx.y + (endY - fx.y) * eased;
      c.globalAlpha = (1 - tail / 7) * Math.sin(Math.min(1, t * 2) * Math.PI / 2) * Math.min(1, (1 - t) * 5);
      if (fx.star && !tail) this.icon('goal_star_outline', x, y, 19);
      else { c.fillStyle = tail ? tone.light : '#ffffff'; c.beginPath(); c.arc(x, y, Math.max(1, 3.4 - tail * .45), 0, Math.PI * 2); c.fill(); }
    }
    c.restore();
  }
  private drawPop(now: number) {
    const t = (now - this.pop.at) / 1000;
    if (!this.pop.text || t < 0 || t >= 1) return;
    const c = this.ctx, scoring = this.pop.text.startsWith('+');
    const enter = Math.min(1, t / .18), scale = enter < 1 ? .65 + Math.sin(enter * Math.PI * .7) * .55 : 1;
    c.save(); c.globalAlpha = Math.min(1, (1 - t) * 3.5);
    c.translate(195, this.board.y + this.board.h * .45 - t * 24); c.scale(scale, scale); c.rotate(-.035);
    const size = scoring ? 22 : this.pop.text.length > 7 ? 25 : 32;
    c.font = `850 ${size}px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
    c.lineWidth = 6; c.strokeStyle = '#142052'; c.strokeText(this.pop.text, 0, 0);
    const fill = c.createLinearGradient(0, -size / 2, 0, size / 2);
    fill.addColorStop(0, '#ffffff'); fill.addColorStop(.45, scoring ? '#b7faff' : '#fff1a3'); fill.addColorStop(1, scoring ? '#63d9ff' : '#ffb65b');
    c.shadowColor = scoring ? '#54cfff' : '#f2a5ff'; c.shadowBlur = scoring ? 10 : 18;
    c.fillStyle = fill; c.fillText(this.pop.text, 0, 0);
    if (this.pop.detail) { c.shadowBlur = 10; this.text(this.pop.detail, 0, 33, Math.min(20, 330 / this.pop.detail.length), '#edfcff', 'center', 800); }
    if (!scoring) { this.star(-88, -22, 5, '#a6f9ff'); this.star(91, 12, 4, '#fff0b4'); }
    c.restore();
  }
  private drawTutorialGuide(now: number) {
    const c = this.ctx, source = this.slots[TUTORIAL_MOVE.index];
    const start = { x: source.x + source.w / 2, y: source.y + source.h / 2 };
    const end = { x: this.board.x + (TUTORIAL_MOVE.x + 1) * this.cell, y: this.board.y + (TUTORIAL_MOVE.y + 1) * this.cell };
    c.save(); c.strokeStyle = '#f9df83aa'; c.lineWidth = 1.5; c.setLineDash([3, 5]);
    c.beginPath(); c.moveTo(start.x, start.y - 20); c.lineTo(end.x, end.y + 10); c.stroke(); c.setLineDash([]);
    const elapsed = now - this.guideAt!;
    const phase = elapsed < GUIDE_ANIMATION_MS ? (elapsed % 2100) / 2100 : 0;
    const progress = Math.min(1, phase / .72), t = progress * progress * (3 - 2 * progress);
    c.globalAlpha = phase > .84 ? Math.max(.15, (1 - phase) / .16) : .95;
    this.icon('tutorial_hand', start.x + (end.x - start.x) * t + 9, start.y + (end.y - start.y) * t + 15, 36, 44);
    c.restore();
  }
  private drawPowers() {
    const c = this.ctx, now = Date.now();
    if (!this.dock.length) return;
    this.dock.forEach((r, index) => {
      const kind = DOCK_KINDS[index], active = kind === 'rotate' && this.rotationMode || kind === 'hint' && !!this.hint;
      const cx = r.x + r.w / 2, elapsed = now - this.acquiredAt;
      const pop = this.acquiredKind === kind && elapsed < 700 ? Math.sin(elapsed / 700 * Math.PI) : 0;
      c.save(); c.globalAlpha = this.state.tutorial ? .44 : 1;
      c.save(); c.translate(cx, r.y + 30); c.scale(1 + pop * .12, 1 + pop * .12);
      if (active) { c.shadowColor = '#83ffe2'; c.shadowBlur = 12; }
      this.skin({ x: -28, y: -25, w: 56, h: 56 }, 'ui_icon_button');
      this.toolIcon(kind, 0, 2, 1.65); c.restore();
      this.text(TOOL_NAMES[kind], cx, r.y + r.h - 15, 13, '#f1f6ff', 'center', 700);
      const count = this.economy.inventory[kind];
      if (count > 0) {
        this.icon('ui_count_badge', r.x + r.w - 3, r.y + 7, 24);
        this.text(count > 99 ? '99+' : String(count), r.x + r.w - 3, r.y + 7, count > 99 ? 8 : 12, '#164c45', 'center', 800);
      }
      c.restore();
    });
  }
  private toolIcon(kind: InventoryKind, x: number, y: number, scale = 1) {
    this.icon('icon_' + kind, x, y, 27 * scale, 28 * scale);
  }
  private drawSheet(rect: Rect) {
    const c = this.ctx;
    c.fillStyle = '#020a2399'; c.fillRect(-this.offsetX / this.scale, 0, this.width / this.scale, this.logicalH);
    // Frame shadows are transparent. Expand the painted surface around the
    // layout rectangle so its visible border matches the approved sheet size.
    const padX = this.overlay === 'settings' ? 8 : this.overlay === 'acquire' ? 20 : 0;
    const padY = padX ? 11 : 0;
    this.skin({ x: rect.x - padX, y: rect.y - padY, w: rect.w + padX * 2, h: rect.h + padY * 2 });
  }
  private drawSettings() {
    const b = this.sheetRect(374); this.drawSheet(b);
    this.text('稍作休息', 195, b.y + 36, 25, '#fff8e7', 'center', 750);
    this.text('下一步，依旧由你决定', 195, b.y + 66, 13, '#e1edff', 'center', 600);
    const labels = ['震动反馈', '重新开始', '关卡地图', '排行榜', '继续游戏'];
    this.settingsButtons().forEach((r, i) => {
      if (i === 5) { this.skin({ x: r.x + 5, y: r.y + 5, w: 34, h: 34 }, 'ui_icon_button'); this.icon('icon_close', r.x + r.w / 2, r.y + r.h / 2, 18); return; }
      const painted = { x: r.x - 4, y: r.y - 5, w: r.w + 8, h: r.h + 10 };
      if (i === 0) {
        this.skin(painted, 'ui_button_secondary');
        this.text(labels[i], r.x + 19, r.y + r.h / 2, 16, '#fff8e7', 'left', 650);
        this.icon(this.feedbackEnabled ? 'ui_toggle_on' : 'ui_toggle_off', r.x + r.w - 40, r.y + r.h / 2, 50, 27);
      } else this.button(painted, labels[i], i === 4 ? 'primary' : 'secondary', true, i === 4 ? 18 : 17);
    });
  }
  private drawAcquire() {
    const kind = this.acquireKind; if (!kind) return;
    const b = this.sheetRect(374); this.drawSheet(b);
    this.icon(`icon_${kind}`, 195, b.y + 59, 86, 86);
    this.text(`获取${TOOL_NAMES[kind]}`, 195, b.y + 121, 25, '#fff8e7', 'center', 750);
    this.text(TOOL_DETAILS[kind], 195, b.y + 152, 13, '#e0edff', 'center', 550);
    this.text(`持有 ${this.economy.coins} 金币`, 195, b.y + 183, 13, '#a9c7ee', 'center', 600);
    const [ad, coin, close] = this.acquireButtons(), enough = this.testConvenience || this.economy.coins >= TOOL_PRICES[kind];
    const paintedAd = { x: ad.x - 4, y: ad.y - 5, w: ad.w + 8, h: ad.h + 10 };
    const paintedCoin = { x: coin.x - 4, y: coin.y - 5, w: coin.w + 8, h: coin.h + 10 };
    this.button(paintedAd, this.rewardBusy ? '正在领取…' : this.testConvenience ? '测试领取 · 获得 1 个' : '观看广告 · 获得 1 个', 'primary', !this.rewardBusy, 16);
    if (!this.rewardBusy) this.icon('icon_video', ad.x + 32, ad.y + ad.h / 2, 24, 22);
    this.text(this.testConvenience ? '测试阶段，点击即可领取' : '完整观看后领取', 195, b.y + 273, 12, '#b3ccef', 'center');
    this.button(paintedCoin, this.testConvenience ? '测试领取 · 不扣金币' : `${TOOL_PRICES[kind]} 金币购买 1 个`, 'gold', enough && !this.rewardBusy, 15);
    this.icon('icon_coin', coin.x + 32, coin.y + coin.h / 2, 27);
    this.ctx.save(); this.ctx.globalAlpha = this.rewardBusy ? .4 : 1;
    this.skin({ x: close.x + 5, y: close.y + 5, w: 34, h: 34 }, 'ui_icon_button'); this.icon('icon_close', close.x + 22, close.y + 22, 20); this.ctx.restore();
    if (this.acquireMessage) {
      const parts = this.acquireMessage.match(/.{1,26}/g) ?? [];
      parts.slice(0, 2).forEach((part, i) => this.text(part, 195, b.y + 352 + i * 13, 9, '#ffe0a0', 'center'));
    }
  }
  private destructiveIcon(kind: DestructivePower, x: number, y: number) {
    this.icon('icon_' + kind, x, y, 25);
  }
  private powerIcon(kind: 'refresh' | 'rotate', x: number, y: number) {
    this.icon('icon_' + kind, x, y, 25);
  }
  private levelMenuRect(): Rect {
    const y = this.safeTop + 46;
    return { x: 14, y, w: 362, h: this.logicalH - this.safeBottom - y - 8 };
  }
  private levelButtons(): Rect[] {
    const b = this.levelMenuRect(), h = (b.h - 320) / 5, w = (b.w - 10) / 2;
    return LEVELS.slice(this.levelPage * 10, this.levelPage * 10 + 10).map((_, i) => ({ x: b.x + i % 2 * (w + 10), y: b.y + 88 + Math.floor(i / 2) * (h + 9), w, h }));
  }
  private levelPageButtons(): Rect[] {
    const b = this.levelMenuRect();
    return [b.x + 8, b.x + b.w - 116].map(x => ({ x, y: b.y + b.h - 178, w: 108, h: 36 }));
  }
  private levelMenuButtons(): Rect[] {
    const b = this.levelMenuRect();
    return [{ x: b.x + 6, y: b.y + b.h - 116, w: b.w - 12, h: 48 },
      { x: b.x + 6, y: b.y + b.h - 58, w: b.w - 12, h: 48 },
      { x: b.x + 2, y: this.safeTop, w: 36, h: 36 }];
  }
  private drawLevelMenu() {
    const c = this.ctx;
    c.fillStyle = '#0a286f'; c.fillRect(-this.offsetX / this.scale, 0, this.width / this.scale, this.logicalH);
    this.assets.background(c, -this.offsetX / this.scale, 0, this.width / this.scale, this.logicalH);
    const b = this.levelMenuRect();
    const next = getNextLevelIndex(this.campaignProgress), completed = this.campaignProgress.completed.length;
    this.text(completed === LEVELS.length ? '闯关全部完成' : '闯关旅程', 195, this.safeTop + 18, 23, '#fff8e7', 'center', 750);
    const progress = { x: b.x, y: b.y + 16, w: 246, h: 56 };
    this.skin(progress, 'ui_task_strip');
    this.text(`已完成 ${completed} / ${LEVELS.length} 关`, progress.x + 20, progress.y + 20, 15, '#f4f8ff', 'left', 650);
    this.panel({ x: progress.x + 18, y: progress.y + 38, w: progress.w - 36, h: 8 }, '#06265b', 4, '#4a9ee7');
    if (completed) this.panel({ x: progress.x + 18, y: progress.y + 38, w: (progress.w - 36) * completed / LEVELS.length, h: 8 }, '#64f5c4', 4);
    const rank = this.rankButton(); this.button(rank, '排行榜', 'secondary', true, 13);
    this.icon('trophy', rank.x + 18, rank.y + rank.h / 2, 24);
    const message = Date.now() - this.toast.at < 2300 ? this.toast.text : '';
    if (message) this.text(message, 195, b.y + 80, 9, '#ffdf9d', 'center');
    const names = { lines: '消线', gems: '星星', colors: '颜色', ice: '破冰', dual: '组合' };
    this.levelButtons().forEach((r, i) => {
      const index = this.levelPage * 10 + i, level = LEVELS[index], active = this.state.level?.id === level.id;
      const unlocked = this.levelUnlocked(index), done = this.campaignProgress.completed.includes(level.id);
      c.save(); c.globalAlpha = unlocked ? 1 : .75;
      this.skin(r, 'ui_task_strip');
      if (active || index === next) { c.strokeStyle = '#78ffcf'; c.lineWidth = 2; this.rounded(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 15); c.stroke(); }
      const compact = r.h < 70, sample = level.batches[0]?.[0], sampleH = Math.min(40, r.h - 24);
      if (level.goals.some(goal => goal.kind === 'gems')) {
        const tone = level.goals.find(goal => goal.kind === 'color')?.color ?? (level.number % 5);
        this.icon(STAR_TILE_IDS[tone], r.x + 33, r.y + r.h / 2 - 7, sampleH);
      } else if (level.mechanic === 'dual') {
        this.icon(TILE_IDS[level.goals.find(goal => goal.kind === 'color')?.color ?? 0], r.x + 33, r.y + r.h / 2 - 7, sampleH);
      } else if (sample) {
        const bounds = getPieceBounds(sample), unit = Math.min(17, 51 / bounds.width, sampleH / bounds.height);
        this.piece(sample, r.x + 33 - bounds.width * unit / 2, r.y + r.h / 2 - 7 - bounds.height * unit / 2, unit);
      }
      this.line(r.x + 67, r.y + 13, r.x + 67, r.y + r.h - 13, '#68a6e877');
      this.text(`第 ${level.number} 关`, r.x + 77, r.y + (compact ? 13 : 19), compact ? 13 : 15, '#fff8e7', 'left', 700);
      this.text(`${names[level.mechanic]}${level.goals.length > 1 ? ` · ${level.goals.length} 项` : ` · ${level.goals[0].target}`}`, r.x + 77, r.y + (compact ? 28 : 40), compact ? 10 : 12, '#e2edff', 'left', 550);
      const difficulty = level.learning ? '学习' : level.difficulty >= 8 ? '超难' : level.difficulty >= 7 ? '困难' : '普通';
      this.text(difficulty, r.x + 79, r.y + r.h - 13, 10, level.difficulty >= 7 ? '#ffe089' : '#89f3d3', 'left', 650);
      if (done || !unlocked) this.icon(done ? 'icon_check' : 'icon_lock', r.x + r.w - 18, r.y + r.h - 16, done ? 19 : 17);
      else this.text('挑战', r.x + r.w - 10, r.y + r.h - 13, 9, '#8bf2d1', 'right', 650);
      const earnedStars = this.economy.levels[level.id]?.stars ?? 0;
      if (earnedStars) for (let s = 0; s < 3; s++) this.icon(s < earnedStars ? 'rating_star_gold' : 'rating_star_dim', r.x + 20 + s * 14, r.y + r.h - 12, 12);
      c.restore();
    });
    this.levelPageButtons().forEach((r, i) => {
      const enabled = i === 0 ? this.levelPage > 0 : this.levelPage < 2;
      this.button(r, i === 0 ? '上一页' : '下一页', 'secondary', enabled, 15);
    });
    this.text(`${this.levelPage + 1} / 3`, 195, b.y + b.h - 160, 19, '#d9e8ff', 'center', 650);
    this.levelMenuButtons().forEach((r, i) => {
      if (i === 2) { this.skin(r, 'ui_icon_button'); this.icon('icon_back', r.x + 18, r.y + 18, 24); return; }
      const resume = this.state.mode === 'level' && this.state.status === 'playing';
      this.button(r, i === 1 ? '返回无尽模式' : resume ? `继续第 ${this.levelDefinition!.number} 关` : completed === LEVELS.length ? '重玩第 30 关' : `挑战第 ${next + 1} 关`, i ? 'secondary' : 'primary', true, 19);
    });
  }
  private lessonRect(): Rect { return this.sheetRect(330); }
  private lessonButton(): Rect { const b = this.lessonRect(); return { x: b.x + 32, y: b.y + b.h - 58, w: b.w - 64, h: 42 }; }
  private drawLesson() {
    const level = this.levelDefinition!, b = this.lessonRect(); this.drawSheet(b);
    const names = { lines: '消线', gems: '星星收集', colors: '颜色消除', ice: '破冰', dual: '组合目标' };
    this.text(`新玩法 · ${names[level.mechanic]}`, 195, b.y + 31, 23, '#fff8e7', 'center', 750);
    const color = level.goals.find(goal => goal.kind === 'color')?.color ?? 2;
    if (level.mechanic === 'gems') this.icon(STAR_TILE_IDS[2], 195, b.y + 108, 70);
    else if (level.mechanic === 'dual') {
      level.goals.forEach((goal, i) => {
        const x = 195 + (i - (level.goals.length - 1) / 2) * 62;
        if (goal.kind === 'gems') this.icon(STAR_TILE_IDS[2], x, b.y + 108, 55);
        else if (goal.kind === 'color') this.icon(TILE_IDS[goal.color ?? 0], x, b.y + 108, 55);
        else { [0, 1, 3].forEach((tone, j) => this.tile(x - 26 + j * 18, b.y + 99, 18, tone)); this.icon('fx_line_clear', x, b.y + 108, 56, 16); }
      });
    } else if (level.mechanic === 'colors') {
      const colors = level.goals.filter(goal => goal.kind === 'color').map(goal => goal.color ?? 0);
      colors.forEach((tone, i) => this.icon(TILE_IDS[tone], 195 + (i - (colors.length - 1) / 2) * 61, b.y + 108, 57));
    } else if (level.mechanic === 'ice') this.goalIcon('ice', 195, b.y + 108);
    else {
      [0, 1, 3].forEach((tone, i) => this.icon(TILE_IDS[tone], 146 + i * 49, b.y + 108, 47));
      this.icon('fx_line_clear', 195, b.y + 108, 180, 24);
    }
    const rules = {
      lines: ['把方块放入空格，填满整行或整列。', '消除一行或一列，目标进度就会增加。', '三块用完再补牌，先看好落子顺序。'],
      gems: ['棋盘和新方块上都可能带五角星。', '填满它所在的行或列，就能收集星星。', '带星方块会继续出现，不用单独点击。'],
      colors: ['操作和消线相同，填满整行或整列。', '消除时，指定颜色的方块计入目标。', '相邻同色不用配对，看准颜色数量就好。'],
      ice: ['浅蓝色描边的格子覆盖着薄冰。', '空冰格可以放块；铺满所在行或列，', '消除方块时就会一起清除薄冰。'],
      dual: ['同时完成任务栏中的所有目标。', '消线、星星与颜色数量可以叠加。', '一次消除可以同时推进多项目标。'],
    };
    rules[level.mechanic].forEach((text, i) => this.text(text, 195, b.y + 174 + i * 23, 12, '#eef4ff', 'center', 500));
    this.text('完成全部目标 · 可以免费重试', 195, b.y + 248, 11, '#a9c8eb', 'center');
    this.button(this.lessonButton(), '开始挑战', 'primary', true, 18);
  }
  private rankingTabs(): Rect[] {
    const b = this.levelMenuRect();
    return [{ x: b.x + 4, y: b.y + 16, w: 177, h: 48 }, { x: b.x + 181, y: b.y + 16, w: 177, h: 48 }];
  }
  private rankingButtons(): Rect[] {
    const b = this.levelMenuRect();
    return [{ x: b.x + 2, y: b.y + b.h - 58, w: 173, h: 48 }, { x: b.x + 187, y: b.y + b.h - 58, w: 173, h: 48 },
      { x: b.x + 2, y: this.safeTop, w: 36, h: 36 },
      { x: 64, y: b.y + 82, w: 131, h: 36 }, { x: 195, y: b.y + 82, w: 131, h: 36 }];
  }
  private drawRanking() {
    const c = this.ctx, b = this.levelMenuRect(), result = this.rankingResult;
    c.fillStyle = '#0a286f'; c.fillRect(-this.offsetX / this.scale, 0, this.width / this.scale, this.logicalH);
    this.assets.background(c, -this.offsetX / this.scale, 0, this.width / this.scale, this.logicalH);
    const selected = LEVELS.find(level => level.id === this.rankingLevelId);
    this.text('排行榜', 195, this.safeTop + 18, 24, '#fff8e7', 'center', 750);
    this.rankingTabs().forEach((r, i) => {
      const active = this.rankingScope === (i === 0 ? 'users' : 'friends');
      this.button(r, i === 0 ? '全服榜' : '好友榜', active ? 'primary' : 'secondary', true, 19);
    });
    const buttons = this.rankingButtons();
    this.button(buttons[3], '总积分', selected ? 'secondary' : 'primary', true, 16);
    this.button(buttons[4], selected ? `第 ${selected.number} 关` : '当前关', selected ? 'primary' : 'secondary', true, 16);
    this.text(selected ? '保留本关最高分 · 同分先达到者优先' : '各关最佳分数累计 · 同分先达到者优先', 195, b.y + 136, 12, '#b6cff2', 'center');
    const body = { x: b.x - 4, y: b.y + 154, w: b.w + 8, h: Math.max(170, b.h - 370) };
    if (this.rankingLoading) {
      this.icon('icon_refresh', 195, body.y + body.h / 2 - 30, 46);
      this.text('正在读取排行榜…', 195, body.y + body.h / 2 + 23, 15, '#dceaff', 'center');
    }
    else if (result?.presentation === 'open-data') this.leaderboard.drawFriends?.(c, body);
    else if (result?.status === 'ready' && result.entries.length) {
      const rows = result.entries.slice(0, 5), h = (body.h - 32) / 5, compact = h < 50;
      rows.forEach((row, i) => {
        const r = { x: body.x, y: body.y + i * (h + 8), w: body.w, h }, cy = r.y + r.h / 2;
        this.skin(r, 'ui_task_strip');
        if (row.isSelf) { c.strokeStyle = '#77f5d4'; c.lineWidth = 1.8; this.rounded(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 13); c.stroke(); }
        if (row.rank <= 3 && !compact) this.icon('trophy', r.x + 30, cy, 37);
        this.text(String(row.rank), r.x + 30, cy + (row.rank <= 3 && !compact ? 2 : 0), compact ? 16 : 18, row.rank <= 3 && !compact ? '#704c0d' : '#fff5d6', 'center', 700);
        const tile = compact ? 11 : 17, ax = r.x + 83, ay = cy;
        for (let n = 0; n < 4; n++) this.tile(ax + (n % 2 - 1) * tile, ay + (Math.floor(n / 2) - 1) * tile, tile, (row.rank + n) % 5);
        this.text(row.nickname.slice(0, 8), r.x + 111, cy, compact ? 11 : 16, '#fff8e7', 'left', row.isSelf ? 700 : 600);
        this.text(String(row.score), r.x + r.w - 14, cy, compact ? 16 : 22, '#ffe084', 'right', 700);
      });
    } else {
      const message = result?.message ?? (result?.status === 'ready' ? '暂时还没有排名，通关后刷新最佳分数吧' : '排行榜尚未连接');
      this.icon('trophy', 195, body.y + body.h / 2 - 53, 62);
      const title = result?.status === 'ready' ? '暂无成绩' : result?.status === 'error' ? '读取失败' : result?.status === 'unsupported' ? '暂不支持' : '暂未连接';
      this.text(title, 195, body.y + body.h / 2, 22, '#fff8e7', 'center', 650);
      const parts = message.match(/.{1,25}/g) ?? [];
      parts.slice(0, 3).forEach((part, i) => this.text(part, 195, body.y + body.h / 2 + 32 + i * 21, 11, '#b9d0eb', 'center'));
    }
    const localScore = selected ? this.economy.levels[selected.id]?.bestScore ?? 0 : Object.values(this.economy.levels).reduce((sum, level) => sum + level.bestScore, 0);
    this.text('努力刷新每一关的最佳成绩', 195, b.y + b.h - 196, 12, '#b8cef1', 'center');
    const local = { x: b.x - 4, y: b.y + b.h - 166, w: b.w + 8, h: 68 };
    this.skin(local, 'ui_task_strip');
    c.strokeStyle = '#77f5d4'; c.lineWidth = 1.5; this.rounded(local.x + 1, local.y + 1, local.w - 2, local.h - 2, 15); c.stroke();
    const self = result?.status === 'ready' ? result.entries.find(row => row.isSelf) : undefined;
    this.text(self ? '我的排名' : '本机最佳', local.x + 20, local.y + 19, 13, '#e5f1ff', 'left', 600);
    this.text(self ? `第 ${self.rank} 名` : '我的成绩', local.x + 20, local.y + 45, 14, '#88f1d0', 'left', 650);
    this.text(String(self?.score ?? localScore), local.x + local.w - 18, local.y + local.h / 2, 26, '#ffe084', 'right', 700);
    this.button(buttons[0], '返回游戏', 'secondary', true, 17);
    this.button(buttons[1], selected ? '查看总积分' : '查看当前关', 'secondary', true, 17);
    this.skin(buttons[2], 'ui_icon_button'); this.icon('icon_back', buttons[2].x + 18, buttons[2].y + 18, 24);
  }
  private modalRect(): Rect {
    const desired = this.levelDefinition ? this.state.status === 'won' ? 484 + (this.levelDefinition.goals.length - 1) * 24
      : 390 + Math.max(0, this.levelDefinition.goals.length - 2) * 30 : 360;
    const h = Math.min(desired, this.logicalH - this.safeTop - this.safeBottom - 24);
    return { x: 32, y: this.safeTop + (this.logicalH - this.safeTop - this.safeBottom - h) / 2, w: 326, h };
  }
  private modalButtons(): Rect[] {
    const b = this.modalRect();
    if (this.levelDefinition) {
      if (this.state.status === 'won') return [
        { x: b.x + 28, y: b.y + b.h - 128, w: 270, h: 44 },
        { x: b.x + 28, y: b.y + b.h - 82, w: 129, h: 40 },
        { x: b.x + 169, y: b.y + b.h - 82, w: 129, h: 40 },
        { x: b.x + 28, y: b.y + b.h - 182, w: 270, h: 42 },
      ];
      return [
        { x: b.x + 26, y: b.y + b.h - 220, w: 274, h: 46 },
        { x: b.x + 24, y: b.y + b.h - 82, w: 278, h: 40 },
        { x: b.x + 84, y: b.y + b.h - 36, w: 158, h: 26 },
        { x: b.x + 18, y: b.y + b.h - 138, w: 139, h: 40 },
        { x: b.x + 169, y: b.y + b.h - 138, w: 139, h: 40 },
      ];
    }
    return [{ x: b.x + 34, y: b.y + b.h - 160, w: 258, h: 44 },
      { x: b.x + 34, y: b.y + b.h - 92, w: 258, h: 42 },
      { x: b.x + 84, y: b.y + b.h - 40, w: 158, h: 26 }];
  }
  private modalAction(index: number) {
    if (this.rewardBusy || this.disposed) return;
    if (index === 2) { this.openLevels(); return; }
    if (this.levelDefinition) {
      if (index === 3 || index === 4) { this.openPower(this.state.status === 'won' ? 'doubleCoins' : index === 3 ? 'bomb' : 'bulldozer'); return; }
      if (index === 1) { this.reset(); return; }
      if (index === 0 && this.state.status === 'won') {
        const next = LEVELS[LEVELS.findIndex(level => level.id === this.state.level!.id) + 1];
        if (next) this.startLevel(next.id); else this.openLevels();
      } else if (index === 0) this.openPower('revive');
      return;
    }
    if (this.state.status === 'won' || index === 1) this.reset();
    else this.openPower('revive');
  }
  private drawModal() {
    const c = this.ctx, b = this.modalRect(), won = this.state.status === 'won'; this.drawSheet(b);
    if (this.levelDefinition) {
      const level = this.levelDefinition;
      const goals = getLevelGoals(this.state), buttons = this.modalButtons();
      if (won) {
        const all = this.campaignProgress.completed.length === LEVELS.length;
        this.text(all ? '30 关全部完成' : `第 ${level.number} 关完成`, 195, b.y + 31, 24, '#fff8e7', 'center', 750);
        const stars = this.settlement?.stars ?? 1;
        for (let i = 0; i < 3; i++) this.icon(i < stars ? 'rating_star_gold' : 'rating_star_dim', 133 + i * 62, b.y + 87, i === 1 ? 54 : 48);
        this.text(`${this.state.score} 分`, 195, b.y + 135, 27, '#fff7d6', 'center', 700);
        goals.forEach((goal, i) => {
          const r = { x: b.x + 28, y: b.y + 155 + i * 34, w: 270, h: 30 };
          this.skin(r, 'ui_task_strip'); this.goalIcon(goal.kind, r.x + 23, r.y + 15, goal.color);
          this.text(`${this.goalName(goal.kind, goal.color)} ${Math.min(goal.current, goal.target)}/${goal.target}`, r.x + 48, r.y + 15, 12, '#eef6ff', 'left', 600);
          this.icon('icon_check', r.x + r.w - 23, r.y + 15, 21);
        });
        const coins = this.settlement?.coinsGranted ?? 0;
        this.coinIcon(131, b.y + b.h - 246, 15);
        this.text(coins ? `+${coins} 金币` : '奖励已领取', 162, b.y + b.h - 246, 22, '#ffe092', 'left', 750);
        const chest = this.settlement?.chest;
        if (chest) this.icon('treasure_chest_closed', b.x + 54, b.y + b.h - 210, 40, 34);
        this.text(chest ? `三星宝箱：${this.inventoryName(chest.kind)} ×${chest.count}` : stars === 3 ? '三星宝箱已领取' : '达到三星，可获得关卡宝箱', chest ? b.x + 84 : 195, b.y + b.h - 210, 12, '#d5e6ff', chest ? 'left' : 'center', 600);
        const doubled = this.economy.doubledRuns.includes(this.settlement?.runId ?? ''), canDouble = !!this.settlement?.canDouble && !doubled;
        this.button(buttons[3], this.rewardBusy ? '正在领取…' : doubled ? '双倍已领取' : canDouble ? '观看广告 · 金币翻倍' : '本关奖励已领取', 'gold', canDouble && !this.rewardBusy, 15);
        if (canDouble && !this.rewardBusy) this.icon('icon_video', buttons[3].x + 32, buttons[3].y + 21, 24, 20);
        const last = LEVELS[LEVELS.length - 1].id === level.id;
        this.button(buttons[0], last ? '查看通关地图' : '下一关', 'primary', !this.rewardBusy, 21);
        this.button(buttons[1], '重试本关', 'secondary', !this.rewardBusy, 16);
        this.button(buttons[2], '关卡地图', 'secondary', !this.rewardBusy, 16);
        const footer = this.powerMessage || (doubled ? '双倍金币已领取，宝箱不重复发放' : coins ? '本次奖励只可翻倍一次' : '重玩可刷新最佳分数，奖励不重复发放');
        const parts = footer.match(/.{1,27}/g) ?? [];
        parts.slice(0, 2).forEach((part, i) => this.text(part, 195, b.y + b.h - 40 + i * 12, 10, this.powerMessage ? '#ffe0a0' : '#adc8ee', 'center'));
      } else {
        this.text('无处可放', 195, b.y + 33, 28, '#fff8e7', 'center', 750);
        this.text('剩余方块都没有可放位置', 195, b.y + 66, 14, '#e2edff', 'center', 600);
        goals.forEach((goal, i) => {
          const count = goals.length === 1 ? 1 : 2, w = count === 1 ? 240 : 136;
          const x = count === 1 ? b.x + 43 : b.x + 20 + i % 2 * 150;
          const r = { x, y: b.y + 93 + Math.floor(i / count) * 37, w, h: 32 };
          this.skin(r, 'ui_task_strip'); this.goalIcon(goal.kind, r.x + 21, r.y + 16, goal.color);
          const label = goals.length === 1 ? this.goalName(goal.kind, goal.color) : goal.kind === 'gems' ? '星星' : goal.kind === 'lines' ? '行列' : goal.kind === 'color' ? COLOR_NAMES[goal.color ?? 0][0] : '冰层';
          this.text(`${label} ${Math.min(goal.current, goal.target)}/${goal.target}`, r.x + 42, r.y + 16, count === 1 ? 13 : 12, goal.current >= goal.target ? '#8cf2d2' : '#edf5ff', 'left', 600);
        });
        this.text('腾出空间，继续本关', 195, b.y + b.h - 242, 14, '#e3eeff', 'center', 600);
        const canRevive = this.powerUses.revive < 1 && !!this.powerEffect('revive');
        this.button(buttons[0], this.rewardBusy ? '正在打开视频…' : this.powerUses.revive >= 1 ? '复活已用完' : canRevive ? '观看广告复活' : '本关无法复活', 'primary', canRevive && !this.rewardBusy, 19);
        if (canRevive && !this.rewardBusy) this.icon('icon_video', buttons[0].x + 45, buttons[0].y + 23, 27, 22);
        const note = this.powerMessage || '保留目标继续规划 · 本局限1次';
        const parts = note.match(/.{1,27}/g) ?? [];
        parts.slice(0, 2).forEach((part, i) => this.text(part, 195, b.y + b.h - 160 + i * 12, 10, this.powerMessage ? '#ffe0a0' : '#b2cbee', 'center'));
        for (const [i, kind] of ['bomb', 'bulldozer'].entries()) {
          const tool = kind as DestructivePower, r = buttons[i + 3], stock = this.economy.inventory[tool];
          const enabled = !this.rewardBusy && !!this.powerEffect(tool);
          this.button(r, '', 'secondary', enabled);
          c.save(); c.globalAlpha = enabled ? 1 : .45; this.icon(`icon_${tool}`, r.x + 23, r.y + 20, 31);
          this.text(TOOL_NAMES[tool], r.x + 82, r.y + 13, 12, '#edf5ff', 'center', 650);
          this.text(stock > 0 ? `使用 ×${stock}` : '获取', r.x + 82, r.y + 29, 10, '#b9d6f4', 'center', 550); c.restore();
        }
        this.button(buttons[1], '免费重试', 'secondary', !this.rewardBusy, 19);
        this.text('关卡地图', 195, buttons[2].y + 13, 14, '#bbdcff', 'center', 650);
        this.line(164, buttons[2].y + 23, 226, buttons[2].y + 23, '#8abde8');
      }
      return;
    }
    this.text(won ? '目标完成' : '本局挑战结束', 195, b.y + 36, 25, '#fff8e7', 'center', 750);
    this.text(won ? '再挑战一次，刷新最佳成绩' : '剩余方块都无处可放', 195, b.y + 68, 13, '#e3eeff', 'center', 550);
    this.skin({ x: b.x + 24, y: b.y + 91, w: b.w - 48, h: 65 }, 'ui_task_strip');
    this.text(String(this.state.lines), 125, b.y + 113, 27, '#ffe084', 'center', 700);
    this.text(String(this.state.score), 265, b.y + 113, 27, '#ffe084', 'center', 700);
    this.text('消除行列', 125, b.y + 140, 13, '#e4efff', 'center', 600);
    this.text('本局得分', 265, b.y + 140, 13, '#e4efff', 'center', 600);
    this.text(this.powerMessage || `历史最高 ${this.bestScore} 分`, 195, b.y + 177, 11, this.powerMessage ? '#ffe0a0' : '#b9d2f1', 'center');
    const buttons = this.modalButtons(), canRevive = this.powerUses.revive < 1 && !!this.powerEffect('revive');
    this.button(buttons[0], won ? '再玩一次' : this.rewardBusy ? '正在打开视频…' : this.powerUses.revive >= 1 ? '复活已用完' : '观看广告复活', 'primary', (won || canRevive) && !this.rewardBusy, 19);
    if (!won && canRevive && !this.rewardBusy) this.icon('icon_video', buttons[0].x + 38, buttons[0].y + 22, 27, 22);
    this.text(won ? '继续拼出更好的成绩' : '保留盘面继续 · 本局限1次', 195, b.y + b.h - 103, 11, '#c4daf7', 'center');
    this.button(buttons[1], '免费重新挑战', 'secondary', !this.rewardBusy, 18);
    this.text('关卡地图', 195, buttons[2].y + 13, 14, '#bbdcff', 'center', 650);
    this.line(164, buttons[2].y + 23, 226, buttons[2].y + 23, '#8abde8');
  }
  private star(x: number, y: number, r: number, color = '#ffd77c') {
    const c = this.ctx; c.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5; const n = i % 2 ? r * .47 : r; if (!i) c.moveTo(x + Math.cos(a) * n, y + Math.sin(a) * n); else c.lineTo(x + Math.cos(a) * n, y + Math.sin(a) * n); }
    c.closePath(); c.fillStyle = color; c.fill();
  }
  private burst(cells: (Cell & { tone?: number })[], combo = 0) {
    const now = Date.now();
    for (const p of cells) {
      const tone = TONES[(p.tone ?? 0) % TONES.length];
      for (let i = 0; i < (combo > 1 ? 3 : 2); i++) {
        const angle = Math.random() * Math.PI * 2, speed = 35 + Math.random() * (combo > 1 ? 155 : 115);
        this.particles.push({ x: this.board.x + (p.x + .5) * this.cell, y: this.board.y + (p.y + .5) * this.cell,
          vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 65, size: 1.8 + Math.random() * 3.2,
          color: i === 0 ? tone.light : i === 1 ? tone.base : '#ecfbff', born: now, life: 430 + Math.random() * 270,
          star: i === 0 && (p.x + p.y) % 3 === 0 });
      }
    }
    this.particles = this.particles.slice(-160);
  }
  private celebrate() {
    const now = Date.now();
    for (let i = 0; i < 45; i++) this.particles.push({ x: 50 + Math.random() * 290, y: this.board.y + Math.random() * 60, vx: (Math.random() - .5) * 130, vy: -30 - Math.random() * 140, size: 2 + Math.random() * 4, color: ['#7ce9ff', '#c397ff', '#ffcf81'][i % 3], born: now, life: 900 + Math.random() * 500 });
    this.particles = this.particles.slice(-160);
  }
  private drawParticles(now: number) {
    const c = this.ctx; this.particles = this.particles.filter(p => now - p.born < p.life);
    for (const p of this.particles) { const elapsed = (now - p.born) / 1000; c.save(); c.globalCompositeOperation = 'lighter'; c.globalAlpha = Math.min(1, (p.life - (now - p.born)) / 200); c.shadowColor = p.color; c.shadowBlur = p.star ? 8 : 3; c.translate(p.x + p.vx * elapsed, p.y + p.vy * elapsed + 150 * elapsed * elapsed); c.rotate(elapsed * 3); c.fillStyle = p.color; if (p.star) this.star(0, 0, p.size * 1.4, p.color); else c.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * .65); c.restore(); }
  }
}
