import { LEVELS } from '../core/levels.ts';

export type InventoryKind = 'hint' | 'rotate' | 'refresh' | 'bomb' | 'bulldozer';
export type LevelReward = { bestScore: number; stars: number; rewardStars: number };
export type EconomyState = {
  version: 1;
  coins: number;
  inventory: Record<InventoryKind, number>;
  levels: Record<string, LevelReward>;
  claimedRuns: string[];
  doubledRuns: string[];
  pendingDoubles: { runId: string; coins: number }[];
};
export type CompletionReward = {
  state: EconomyState;
  stars: number;
  coinsGranted: number;
  chest: { kind: InventoryKind; count: number } | null;
  canDouble: boolean;
  runId: string;
};

export const ECONOMY_STORAGE_KEY = 'wood-blocks.economy.v1';
export const TOOL_PRICES: Readonly<Record<InventoryKind, number>> = Object.freeze({ hint: 10, rotate: 15, refresh: 20, bomb: 30, bulldozer: 40 });
const INVENTORY_KINDS: readonly InventoryKind[] = ['hint', 'rotate', 'refresh', 'bomb', 'bulldozer'];
const CHEST_KINDS: readonly InventoryKind[] = ['hint', 'rotate', 'refresh'];
const TOTAL_COINS = [0, 10, 15, 40];
const HISTORY_LIMIT = 100;
const validRun = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && value === value.trim();
const nonnegative = (value: unknown, fallback = 0): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback;
const isKind = (kind: unknown): kind is InventoryKind => INVENTORY_KINDS.includes(kind as InventoryKind);
const add = (value: number, increment: number) => Math.min(Number.MAX_SAFE_INTEGER, value + increment);

function initialEconomy(): EconomyState {
  return { version: 1, coins: 0, inventory: { hint: 3, rotate: 3, refresh: 3, bomb: 0, bulldozer: 0 }, levels: {}, claimedRuns: [], doubledRuns: [], pendingDoubles: [] };
}

/** Saves own all nested data. Invalid versions start clean and never invent rewards. */
export function sanitizeEconomy(value: unknown): EconomyState {
  try {
    const source = typeof value === 'string' ? JSON.parse(value) : value;
    if (!source || typeof source !== 'object' || Array.isArray(source) || source.version !== 1) return initialEconomy();
    const inventory = source.inventory && typeof source.inventory === 'object' && !Array.isArray(source.inventory)
      ? Object.fromEntries(INVENTORY_KINDS.map(kind => [kind, nonnegative(source.inventory[kind])])) as Record<InventoryKind, number>
      : initialEconomy().inventory;
    const levels: Record<string, LevelReward> = {};
    for (const level of LEVELS) {
      const record = source.levels?.[level.id];
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      const stars = Math.min(3, nonnegative(record.stars));
      levels[level.id] = { bestScore: nonnegative(record.bestScore), stars,
        rewardStars: Math.min(stars, nonnegative(record.rewardStars, stars)) };
    }
    const history = (entries: unknown) => [...new Set(Array.isArray(entries) ? entries.filter(validRun) : [])].slice(-HISTORY_LIMIT) as string[];
    const claimedRuns = history(source.claimedRuns);
    const doubledRuns = history(source.doubledRuns).filter(id => claimedRuns.includes(id));
    const pending = new Map<string, number>();
    if (Array.isArray(source.pendingDoubles)) for (const item of source.pendingDoubles) {
      if (!item || !validRun(item.runId) || !claimedRuns.includes(item.runId) || doubledRuns.includes(item.runId) ||
        !Number.isSafeInteger(item.coins) || item.coins <= 0 || item.coins > 40) continue;
      pending.set(item.runId, item.coins);
    }
    return { version: 1, coins: nonnegative(source.coins), inventory, levels, claimedRuns, doubledRuns,
      pendingDoubles: [...pending].slice(-HISTORY_LIMIT).map(([runId, coins]) => ({ runId, coins })) };
  } catch { return initialEconomy(); }
}

/** Completion is established by the caller's won state; these are score bands. */
export function rateLevelStars(levelId: string, score: number): number {
  const level = LEVELS.find(entry => entry.id === levelId);
  if (!level || !Number.isSafeInteger(score) || score < 0 || !Array.isArray(level.starScores) || level.starScores.length !== 3 ||
    level.starScores.some(value => !Number.isSafeInteger(value) || value < 0) || level.starScores[1] < level.starScores[0] || level.starScores[2] < level.starScores[1]) return 0;
  return score >= level.starScores[2] ? 3 : score >= level.starScores[1] ? 2 : 1;
}

/** A level's coin total rises 10→15→40; replaying the same star band grants zero. */
export function completeLevel(economy: EconomyState, levelId: string, score: number, runId: string, random: () => number = Math.random): CompletionReward | null {
  const stars = rateLevelStars(levelId, score);
  if (!stars || !validRun(runId)) return null;
  const state = sanitizeEconomy(economy);
  if (state.claimedRuns.includes(runId)) return { state, stars, coinsGranted: 0, chest: null,
    canDouble: state.pendingDoubles.some(entry => entry.runId === runId), runId };
  const previous = state.levels[levelId] ?? { bestScore: 0, stars: 0, rewardStars: 0 };
  const rewardStars = Math.max(previous.rewardStars, stars);
  const earned = TOTAL_COINS[rewardStars] - TOTAL_COINS[previous.rewardStars];
  const nextCoins = add(state.coins, earned), coinsGranted = nextCoins - state.coins;
  state.coins = nextCoins;
  state.levels[levelId] = { bestScore: Math.max(previous.bestScore, score), stars: Math.max(previous.stars, stars), rewardStars };
  state.claimedRuns = [...state.claimedRuns, runId].slice(-HISTORY_LIMIT);
  state.doubledRuns = state.doubledRuns.filter(id => state.claimedRuns.includes(id));
  state.pendingDoubles = state.pendingDoubles.filter(entry => state.claimedRuns.includes(entry.runId));
  if (coinsGranted > 0) state.pendingDoubles.push({ runId, coins: coinsGranted });
  let chest: CompletionReward['chest'] = null;
  if (previous.rewardStars < 3 && rewardStars === 3) {
    const value = random();
    const unit = Number.isNaN(value) ? 0 : Math.max(0, Math.min(1 - Number.EPSILON, value));
    const kind = CHEST_KINDS[Math.floor(unit * CHEST_KINDS.length)];
    state.inventory[kind] = add(state.inventory[kind], 1);
    chest = { kind, count: 1 };
  }
  return { state, stars, coinsGranted, chest, canDouble: coinsGranted > 0, runId };
}

/** Only an explicitly completed ad may call this; each new coin grant doubles once. */
export function doubleReward(economy: EconomyState, runId: string): { state: EconomyState; coinsGranted: number } | null {
  if (!validRun(runId)) return null;
  const state = sanitizeEconomy(economy), pending = state.pendingDoubles.find(entry => entry.runId === runId);
  if (!pending || state.doubledRuns.includes(runId)) return null;
  const nextCoins = add(state.coins, pending.coins), coinsGranted = nextCoins - state.coins;
  state.coins = nextCoins;
  state.pendingDoubles = state.pendingDoubles.filter(entry => entry.runId !== runId);
  state.doubledRuns = [...state.doubledRuns, runId].slice(-HISTORY_LIMIT);
  return { state, coinsGranted };
}

export function consumeInventory(economy: EconomyState, kind: InventoryKind): EconomyState | null {
  if (!isKind(kind)) return null;
  const state = sanitizeEconomy(economy);
  if (state.inventory[kind] <= 0) return null;
  state.inventory[kind]--;
  return state;
}

/** Grants must be called only after a completed ad or another established reward. */
export function grantInventory(economy: EconomyState, kind: InventoryKind, count = 1): EconomyState {
  const state = sanitizeEconomy(economy);
  if (isKind(kind) && Number.isSafeInteger(count) && count > 0) state.inventory[kind] = add(state.inventory[kind], count);
  return state;
}

/** A coin purchase grants one tool and debits its price together, without mutating the save. */
export function purchaseInventory(economy: EconomyState, kind: InventoryKind): EconomyState | null {
  if (!isKind(kind)) return null;
  const state = sanitizeEconomy(economy), price = TOOL_PRICES[kind];
  if (state.coins < price || state.inventory[kind] === Number.MAX_SAFE_INTEGER) return null;
  state.coins -= price;
  state.inventory[kind]++;
  return state;
}
