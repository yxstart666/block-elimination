import { LEVELS } from './levels.ts';
import { COLOR_COUNT, migrateLegacyColor } from './colors.ts';
import type { LevelDefinition, LevelGoalProgress, LevelProgress } from './level-types.ts';

/** Platform-independent rules shared by endless play and authored challenges. */
export type Cell = { x: number; y: number };
export type Piece = { id: string; cells: Cell[]; color?: number; star?: boolean };
export type GameState = {
  mode: 'endless' | 'goal' | 'level';
  seed: number;
  rng: number;
  board: number[][];
  pieces: (Piece | null)[];
  score: number;
  target: number;
  combo: number;
  moves: number;
  lines: number;
  batch: number;
  lastLongBatch: number;
  refreshes: number;
  tutorial: boolean;
  level?: LevelProgress;
  status: 'playing' | 'won' | 'lost';
};
export type Hint = { index: number; x: number; y: number };
export type Placement = {
  state: GameState;
  placed: Cell[];
  cleared: Cell[];
  rows: number[];
  columns: number[];
  /** This placement/clear only. A final countdown bonus is recorded on state.level.timeBonus. */
  gained: number;
};

export const BOARD_SIZE = 8;
export const TARGET_SCORE = 210;
export const CANDIDATE_COUNT = 3;
export const LEVEL_TIME_BONUS_PER_SECOND = 10;
export const TUTORIAL_MOVE: Readonly<Hint> = { index: 1, x: 3, y: 3 };

/** One verified solution, expressed as supply-slot indices and board origins. */
export const LEVEL_SOLUTION: readonly Hint[] = [
  { ...TUTORIAL_MOVE },
  { index: 1, x: 0, y: 0 },
  { index: 2, x: 5, y: 0 },
  { index: 0, x: 3, y: 0 },
  { index: 1, x: 5, y: 1 },
  { index: 0, x: 1, y: 1 },
  { index: 2, x: 0, y: 1 },
  { index: 1, x: 0, y: 0 },
];

const INITIAL_BOARD = [
  '........',
  '.######.',
  '.######.',
  '###..###',
  '###..###',
  '.######.',
  '.######.',
  '........',
];

const SHAPES: Cell[][] = [
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
  [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  [{ x: 0, y: 0 }, { x: 0, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
  [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 2 }],
  [{ x: 0, y: 0 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }],
  [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }],
  [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }],
  // Large six-cell choices are solid rectangles; K-style bends use four cells.
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }],
  Array.from({ length: 9 }, (_, index) => ({ x: index % 3, y: Math.floor(index / 3) })),
];

/** Goal mode keeps its original fixed supply; endless mode uses the saved seed. */
const BATCHES = [[12, 0, 1], [17, 15, 3], [16, 19, 20], [0, 5, 6], [1, 15, 18], [17, 20, 16]];
const supplyColor = (batch: number, shape: number, index: number) => (batch + shape + index * 3) % COLOR_COUNT;

function makeBatch(batch: number): Piece[] {
  return BATCHES[batch % BATCHES.length].map((shape, index) => ({
    id: `${batch}-${index}-${shape}`,
    color: supplyColor(batch, shape, index),
    cells: SHAPES[shape].map(cell => ({ ...cell })),
  }));
}

type SupplyChoice = { shape: number; weight: number };
const LARGE_SUPPLY: SupplyChoice[] = [
  { shape: 0, weight: 3 }, { shape: 1, weight: 3 }, { shape: 18, weight: 1 }, { shape: 19, weight: 1 },
  { shape: 15, weight: 4 }, { shape: 16, weight: 4 }, { shape: 7, weight: 1 }, { shape: 22, weight: 2 },
];
const MEDIUM_SUPPLY: SupplyChoice[] = [
  { shape: 9, weight: 8 }, { shape: 12, weight: 9 }, { shape: 11, weight: 1 },
  { shape: 17, weight: 1 }, { shape: 5, weight: 1 }, { shape: 20, weight: 1 },
];
const SMALL_SUPPLY: SupplyChoice[] = [
  { shape: 3, weight: 3 }, { shape: 13, weight: 3 }, { shape: 8, weight: 3 },
  { shape: 14, weight: 3 }, { shape: 2, weight: 5 }, { shape: 10, weight: 5 },
];
const SINGLE_SUPPLY: SupplyChoice[] = [{ shape: 6, weight: 1 }];
const SUPPLY_POOLS = [
  { choices: LARGE_SUPPLY, weight: 0.28 }, { choices: MEDIUM_SUPPLY, weight: 0.5 },
  { choices: SMALL_SUPPLY, weight: 0.215 }, { choices: SINGLE_SUPPLY, weight: 0.005 },
];
const isStraight = (shape: number) => shape === 7 || shape === 8 || shape === 11 || shape === 14;
const isLongShape = (shape: number) => shape === 7 || shape === 11;
const isHardShape = (shape: number) => isLongShape(shape) || shape === 22;

function orientShape(shape: number, turns: number): Cell[] {
  let cells = SHAPES[shape].map(cell => ({ ...cell }));
  for (let turn = 0; turn < turns; turn++) {
    const height = Math.max(...cells.map(cell => cell.y)) + 1;
    cells = cells.map(cell => ({ x: height - cell.y - 1, y: cell.x }));
  }
  return cells;
}

type SupplyVariant = { shape: number; turns: number; cells: Cell[]; family: string; weight: number };
type SupplyProfile = {
  maxCells: number;
  allowLong: boolean;
  clearWeight: number;
  spaceWeight: number;
  smallPenalty: number;
  largeWeight: number;
};
const cellSignature = (cells: Cell[]) => cells.map(p => `${p.x},${p.y}`).sort().join(';');
const SUPPLY_VARIANTS: SupplyVariant[] = (() => {
  const variants = new Map<string, SupplyVariant>();
  for (const pool of SUPPLY_POOLS) {
    const total = pool.choices.reduce((sum, choice) => sum + choice.weight, 0);
    for (const choice of pool.choices) {
      const turns = new Map<string, { turns: number; cells: Cell[] }>();
      for (let turn = 0; turn < 4; turn++) {
        const cells = orientShape(choice.shape, turn);
        turns.set(cellSignature(cells), { turns: turn, cells });
      }
      const family = [...turns.keys()].sort()[0];
      for (const [signature, value] of turns) {
        const weight = pool.weight * choice.weight / total / turns.size;
        const existing = variants.get(signature);
        if (existing) existing.weight += weight;
        else variants.set(signature, { shape: choice.shape, ...value, family, weight });
      }
    }
  }
  return [...variants.values()];
})();

/** Geometry shared by actual moves and planning. It never deals another group. */
function resolveBoard(source: number[][], piece: Piece, x: number, y: number) {
  const board = source.map(row => row.slice());
  const placed = piece.cells.map(cell => ({ x: x + cell.x, y: y + cell.y }));
  for (const cell of placed) board[cell.y][cell.x] = (piece.color ?? 0) + 1;
  const rows: number[] = [], columns: number[] = [];
  for (let i = 0; i < BOARD_SIZE; i++) {
    if (board[i].every(Boolean)) rows.push(i);
    if (board.every(row => row[i] !== 0)) columns.push(i);
  }
  const cleared: Cell[] = [];
  for (let py = 0; py < BOARD_SIZE; py++) for (let px = 0; px < BOARD_SIZE; px++) {
    if (rows.includes(py) || columns.includes(px)) { cleared.push({ x: px, y: py }); board[py][px] = 0; }
  }
  return { board, placed, cleared, rows, columns };
}

function supplyPotential(board: number[][]): number {
  let occupied = 0, isolated = 0, concentration = 0;
  for (let y = 0; y < BOARD_SIZE; y++) {
    let row = 0, column = 0;
    for (let x = 0; x < BOARD_SIZE; x++) {
      row += Number(board[y][x] !== 0); column += Number(board[x][y] !== 0);
      if (board[y][x]) occupied++;
      else if ((x === 0 || board[y][x - 1]) && (x === 7 || board[y][x + 1]) &&
        (y === 0 || board[y - 1][x]) && (y === 7 || board[y + 1][x])) isolated++;
    }
    concentration += row * row + column * column;
  }
  return concentration * .14 - occupied * 2.4 - isolated * 9;
}

/** Keep only a few useful origins before doing full board simulation. */
function planningOrigins(board: number[][], cells: Cell[], salt: number): Cell[] {
  const rows = board.map(row => row.reduce((n, value) => n + Number(value !== 0), 0));
  const columns = Array.from({ length: 8 }, (_, x) => board.reduce((n, row) => n + Number(row[x] !== 0), 0));
  const height = Math.max(...cells.map(p => p.y)) + 1, width = Math.max(...cells.map(p => p.x)) + 1;
  const rowAdds = Array(height).fill(0), colAdds = Array(width).fill(0);
  for (const p of cells) { rowAdds[p.y]++; colAdds[p.x]++; }
  const origins: (Cell & { value: number })[] = [];
  const piece = { id: '', cells };
  for (let y = 0; y <= 8 - height; y++) for (let x = 0; x <= 8 - width; x++) {
    if (!canPlace(board, piece, x, y)) continue;
    let value = ((x * 17 + y * 31 + salt) % 19) * .025;
    for (let dy = 0; dy < height; dy++) value += rows[y + dy] * rowAdds[dy] * .45 + (rows[y + dy] + rowAdds[dy] === 8 ? 160 : 0);
    for (let dx = 0; dx < width; dx++) value += columns[x + dx] * colAdds[dx] * .45 + (columns[x + dx] + colAdds[dx] === 8 ? 160 : 0);
    for (const p of cells) {
      const px = x + p.x, py = y + p.y;
      value += Number(px === 0 || !!board[py][px - 1]) + Number(px === 7 || !!board[py][px + 1]);
      value += Number(py === 0 || !!board[py - 1][px]) + Number(py === 7 || !!board[py + 1][px]);
    }
    origins.push({ x, y, value });
  }
  return origins.sort((a, b) => b.value - a.value).slice(0, 2);
}

/** Seeded supply and long-line spacing only advance when a whole new group is dealt. */
function makeEndlessBatch(batch: number, board: number[][], rng: number, tutorialOpening = false, lastLongBatch = -2,
  profile?: SupplyProfile): { pieces: Piece[]; rng: number; lastLongBatch: number } {
  let cursor = rng;
  const random = () => {
    cursor = (cursor + 0x6D2B79F5) >>> 0;
    let value = Math.imul(cursor ^ cursor >>> 15, cursor | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 0x100000000;
  };
  const pick = <T extends { weight: number }>(choices: T[]): T => {
    let value = random() * choices.reduce((sum, choice) => sum + choice.weight, 0);
    for (const choice of choices) { value -= choice.weight; if (value < 0) return choice; }
    return choices[choices.length - 1];
  };
  if (tutorialOpening) {
    // Two upright dominoes finish the exposed ends of either occupied 6×2
    // rectangle. After that clear, the square/rectangle fits in the open rows.
    // Only this first post-tutorial group gets a complete, gentle route.
    const big = [12, 15, 16][Math.floor(random() * 3)];
    const shapes = [3, 3, big];
    for (let index = shapes.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [shapes[index], shapes[other]] = [shapes[other], shapes[index]];
    }
    const pieces = shapes.map((shape, index) => {
      const turns = shape === 3 ? Math.floor(random() * 2) * 2 : Math.floor(random() * 4);
      return { id: `${batch}-${index}-${shape}-${turns}`, color: supplyColor(batch, shape, index), cells: orientShape(shape, turns) };
    });
    return { pieces, rng: cursor, lastLongBatch };
  }
  const allowed = (shape: number, others: number[]) =>
    (!isHardShape(shape) || batch >= 2 && !others.some(isHardShape)) &&
    (!isStraight(shape) || !others.some(isStraight)) &&
    (!isLongShape(shape) || batch >= 3 && lastLongBatch !== batch - 1) &&
    (!profile || SHAPES[shape].length <= profile.maxCells && (!isLongShape(shape) || profile.allowLong));
  type Plan = { board: number[][]; chosen: SupplyVariant[]; score: number };
  let plans: Plan[] = [{ board, chosen: [], score: 0 }];
  for (let depth = 0; depth < CANDIDATE_COUNT; depth++) {
    const next: Plan[] = [];
    for (const plan of plans) {
      const variants = SUPPLY_VARIANTS.filter(v => allowed(v.shape, plan.chosen.map(p => p.shape)));
      const eligible = profile ? variants.map(v => ({ ...v,
        weight: v.weight * (v.cells.length > 4 ? profile.largeWeight : 1) })) : variants;
      const sampled: SupplyVariant[] = [];
      const remaining = eligible.filter(v => v.cells.length > 1);
      // Weighted variety plus small gap-fillers. Single cells remain a rescue,
      // not a substitute for ordinary solid blocks.
      for (let draw = 0; draw < 10 && remaining.length; draw++) {
        const variant = pick(remaining); sampled.push(variant); remaining.splice(remaining.indexOf(variant), 1);
      }
      for (const variant of eligible) if (variant.cells.length <= 3 || variant.shape === 12) {
        if (!sampled.includes(variant)) sampled.push(variant);
      }
      const before = supplyPotential(plan.board);
      const crowded = !!profile && plan.board.reduce((sum, row) => sum + row.filter(Boolean).length, 0) >= 40;
      for (const variant of sampled) {
        const jitter = random() * 7;
        const repeats = plan.chosen.filter(p => p.family === variant.family).length;
        for (const origin of planningOrigins(plan.board, variant.cells, cursor)) {
          const result = resolveBoard(plan.board, { id: '', cells: variant.cells }, origin.x, origin.y);
          const lines = result.rows.length + result.columns.length;
          const smallPenalty = variant.cells.length === 1 ? (profile ? crowded ? 8 : profile.smallPenalty : 55)
            : variant.cells.length === 2 ? (profile ? crowded ? 3 : profile.smallPenalty * .25 : 16) : 0;
          const score = profile
            ? plan.score + lines * profile.clearWeight + (supplyPotential(result.board) - before) * profile.spaceWeight
              + Math.min(4, variant.cells.length) * 2.5 + jitter - repeats * 14 - smallPenalty
            : plan.score + lines * 150 + supplyPotential(result.board) - before
              + Math.min(4, variant.cells.length) * 2.5 + jitter - repeats * 14 - smallPenalty;
          next.push({ board: result.board, chosen: [...plan.chosen, variant], score });
        }
      }
    }
    plans = next.sort((a, b) => b.score - a.score).slice(0, 3);
    if (!plans.length) break;
  }
  const complete = plans.filter(plan => plan.chosen.length === CANDIDATE_COUNT);
  let chosen: SupplyVariant[];
  if (complete.length) chosen = complete[Math.floor(random() * complete.length)].chosen.slice();
  else {
    // An already-full malformed board has no possible route. Legal gameplay
    // boards always retain empty cells after simultaneous line clearing.
    chosen = [0, 1, 2].map(() => SUPPLY_VARIANTS.find(v => v.cells.length === 1)!);
  }
  for (let index = chosen.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [chosen[index], chosen[other]] = [chosen[other], chosen[index]];
  }
  const pieces = chosen.map((v, index) => ({ id: `${batch}-${index}-${v.shape}-${v.turns}`,
    color: supplyColor(batch, v.shape, index), cells: v.cells.map(cell => ({ ...cell })) }));
  return { pieces, rng: cursor, lastLongBatch: chosen.some(v => isLongShape(v.shape)) ? batch : lastLongBatch };
}

export function createGame(mode: 'endless' | 'goal' = 'endless', tutorial = true,
  seed = mode === 'goal' ? 0 : Math.floor(Math.random() * 0x100000000)): GameState {
  const initialSeed = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
  const board = tutorial ? INITIAL_BOARD.map((row, y) => [...row].map((cell, x) => {
    if (cell !== '#') return 0;
    const legacyValue = y < 3 ? 5 : y > 4 ? 2 : x < 4 ? 4 : 3;
    return migrateLegacyColor(legacyValue - 1) + 1;
  }))
    : Array.from({ length: BOARD_SIZE }, () => Array<number>(BOARD_SIZE).fill(0));
  const supply = !tutorial && mode === 'endless' ? makeEndlessBatch(0, board, initialSeed) : null;
  return {
    mode,
    seed: initialSeed,
    rng: supply?.rng ?? initialSeed,
    board,
    pieces: tutorial ? [
      { id: 'tutorial-tall', color: migrateLegacyColor(1), cells: SHAPES[4].map(cell => ({ ...cell })) },
      { id: 'tutorial-square', color: migrateLegacyColor(3), cells: SHAPES[12].map(cell => ({ ...cell })) },
      { id: 'tutorial-wide', color: migrateLegacyColor(5), cells: SHAPES[4].map(cell => ({ x: cell.y, y: cell.x })) },
    ] : supply?.pieces ?? makeBatch(0),
    score: 0,
    target: TARGET_SCORE,
    combo: 0,
    moves: 0,
    lines: 0,
    batch: 0,
    lastLongBatch: supply?.lastLongBatch ?? -2,
    refreshes: 0,
    tutorial,
    status: 'playing',
  };
}

function getLevel(state: GameState): LevelDefinition | undefined {
  return state.mode === 'level' ? LEVELS.find(level => level.id === state.level?.id) : undefined;
}

function levelDurationMs(level: LevelDefinition | undefined): number | undefined {
  const seconds = level?.timeLimitSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const duration = Math.ceil(seconds * 1000);
  return Number.isSafeInteger(duration) ? duration : undefined;
}

/** Explicit unlimited-planning challenges differ from old omitted-clock fixtures. */
export function isLevelUntimed(state: GameState): boolean {
  return state.mode === 'level' && getLevel(state)?.timeLimitSeconds === null;
}

/** Milliseconds of active play; endless and either kind of untimed level return Infinity. */
export function getLevelTimeRemaining(state: GameState): number {
  const duration = levelDurationMs(getLevel(state));
  if (duration === undefined) return Infinity;
  const remaining = state.level?.timeRemainingMs;
  return typeof remaining === 'number' && Number.isFinite(remaining)
    ? Math.max(0, Math.min(duration, Math.trunc(remaining))) : duration;
}

export function isLevelExpired(state: GameState): boolean {
  return state.mode === 'level' && state.status !== 'won' && getLevelTimeRemaining(state) === 0;
}

/** Awarded countdown points, kept separate so settlement can show the score breakdown. */
export function getLevelTimeBonus(state: GameState): number {
  const bonus = state.mode === 'level' ? state.level?.timeBonus : undefined;
  return typeof bonus === 'number' && Number.isSafeInteger(bonus) && bonus >= 0 ? bonus : 0;
}

/** Every victory path uses this pure, idempotent settlement. No RNG or clock is read. */
export function finalizeLevelWin(state: GameState): GameState {
  if (state.mode !== 'level' || state.status !== 'won' || !state.level || state.level.timeBonus !== undefined) return state;
  const goals = getLevelGoals(state);
  if (!goals.length || !goals.every(goal => goal.current >= goal.target)) return state;
  const remaining = getLevelTimeRemaining(state);
  const timeBonus = Number.isFinite(remaining) ? Math.ceil(remaining / 1000) * LEVEL_TIME_BONUS_PER_SECOND : 0;
  return { ...state, score: state.score + timeBonus, level: { ...state.level, timeBonus } };
}

/** The UI supplies elapsed active-play time; no wall clock, storage or RNG is read here. */
export function advanceLevelTime(state: GameState, elapsedMs: number): GameState {
  if (state.status !== 'playing' || !state.level || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return state;
  const before = getLevelTimeRemaining(state);
  if (!Number.isFinite(before)) return state;
  const elapsed = Math.floor(elapsedMs);
  if (!elapsed) return state;
  const timeRemainingMs = Math.max(0, before - elapsed);
  return { ...state, level: { ...state.level, timeRemainingMs }, status: timeRemainingMs ? 'playing' : 'lost' };
}

function levelBudgetAvailable(state: GameState, level: LevelDefinition | undefined, moves = state.moves): boolean {
  return !!level && (level.timeLimitSeconds === null ||
    (levelDurationMs(level) === undefined ? moves < level.maxMoves : !isLevelExpired(state)));
}

function makeLevelBatch(level: LevelDefinition, batch: number): (Piece | null)[] {
  return Array.from({ length: CANDIDATE_COUNT }, (_, index) => {
    const piece = level.batches[batch]?.[index];
    return piece ? { ...piece, cells: piece.cells.map(cell => ({ ...cell })) } : null;
  });
}

/** Retries share a seed and opening; the same actions reproduce later supply. */
export function createLevel(id: string): GameState {
  const level = LEVELS.find(entry => entry.id === id);
  if (!level) throw new RangeError(`Unknown level: ${id}`);
  const seed = level.flow && Number.isFinite(level.flow.seed) ? Math.trunc(level.flow.seed) >>> 0 : 0;
  const state: GameState = {
    ...createGame('goal', false, seed),
    mode: 'level',
    board: level.board.map(row => row.slice()),
    pieces: makeLevelBatch(level, 0),
    target: level.goals[0]?.target ?? 0,
    level: {
      id: level.id,
      gems: level.gems.map(cell => ({ ...cell })),
      ice: level.ice.map(cell => ({ ...cell })),
      collectedGems: 0,
      clearedIce: 0,
      clearedColors: Array(COLOR_COUNT).fill(0),
      ...(levelDurationMs(level) !== undefined ? { timeRemainingMs: levelDurationMs(level) } : {}),
    },
  };
  if (level.flow) {
    const supply = makeFlowBatch(state, level);
    state.pieces = supply.pieces;
    state.rng = supply.rng;
    state.lastLongBatch = supply.lastLongBatch;
  }
  if (!hasMove(state.board, state.pieces)) state.status = 'lost';
  return state;
}

export function getLevelGoals(state: GameState): LevelGoalProgress[] {
  const level = getLevel(state);
  if (!level || !state.level) return [];
  return level.goals.map(goal => ({
    ...goal,
    current: goal.kind === 'lines' ? state.lines : goal.kind === 'gems' ? state.level!.collectedGems
      : goal.kind === 'ice' ? state.level!.clearedIce : state.level!.clearedColors?.[goal.color ?? -1] ?? 0,
  }));
}

function levelProgressFraction(state: GameState): number {
  const goals = getLevelGoals(state);
  return goals.length ? goals.reduce((sum, goal) => sum + Math.max(0, Math.min(1,
    goal.current / Math.max(1, goal.target))), 0) / goals.length : 0;
}

/** Actual goal progress drives the curve; retries and rendering do not advance it. */
export function getLevelStage(state: GameState): 'opening' | 'building' | 'finish' {
  const level = getLevel(state);
  const warmupMoves = Math.max(0, level?.flow?.openingBatches ?? 0) * CANDIDATE_COUNT;
  const progress = levelProgressFraction(state);
  if (state.moves < warmupMoves || progress < .35) return 'opening';
  return progress >= .75 ? 'finish' : 'building';
}

function flowSupplyProfile(state: GameState, level: LevelDefinition): SupplyProfile {
  const stage = getLevelStage(state);
  const progress = levelProgressFraction(state);
  const difficulty = (level.difficulty - 4) / 4;
  // Keep assistance strong through the warmup. Later groups still have a full
  // legal route and small gap-fillers; pressure comes from the player's board.
  const pressure = stage === 'opening' ? 0 : Math.max(0, Math.min(1, (progress - .35) / .65));
  return {
    maxCells: stage === 'opening' ? 4 : stage === 'finish' && level.difficulty >= 7 ? 9 : 6,
    allowLong: stage === 'finish' && level.difficulty >= 6,
    clearWeight: 190 - pressure * (65 + difficulty * 20),
    spaceWeight: 1.7 - pressure * (.55 + difficulty * .2),
    smallPenalty: 40 + pressure * 15,
    largeWeight: .5 + pressure * (1 + difficulty * .5),
  };
}

function makeFlowBatch(state: GameState, level: LevelDefinition) {
  const supply = makeEndlessBatch(state.batch, state.board, state.rng, false, state.lastLongBatch,
    flowSupplyProfile(state, level));
  const goals = getLevelGoals(state);
  const colors = goals.filter(goal => goal.kind === 'color' && goal.current < goal.target &&
    Number.isInteger(goal.color) && goal.color! >= 0 && goal.color! < COLOR_COUNT);
  colors.sort((a, b) => a.current / a.target - b.current / b.target);
  for (let index = 0; index < Math.min(CANDIDATE_COUNT - 1, colors.length); index++) {
    supply.pieces[(state.batch + index) % CANDIDATE_COUNT].color = colors[index].color;
  }
  if (colors.length && supply.pieces.every(piece => piece.color === supply.pieces[0].color)) {
    supply.pieces[(state.batch + 2) % CANDIDATE_COUNT].color = ((supply.pieces[0].color ?? 0) + 1) % COLOR_COUNT;
  }
  const stars = goals.find(goal => goal.kind === 'gems');
  if (stars && stars.current < stars.target) {
    const outstanding = stars.target - stars.current;
    const catchUp = getLevelStage(state) !== 'opening' && state.batch % 3 === 2 &&
      outstanding > Math.max(2, (state.level?.gems.length ?? 0) * 2);
    const count = catchUp ? 2 : 1;
    for (let index = 0; index < count; index++) supply.pieces[(state.batch + index) % CANDIDATE_COUNT].star = true;
  }
  return supply;
}

export function getPieceBounds(piece: Piece): { width: number; height: number } {
  return {
    width: Math.max(0, ...piece.cells.map(cell => cell.x + 1)),
    height: Math.max(0, ...piece.cells.map(cell => cell.y + 1)),
  };
}

export function canPlace(board: number[][], piece: Piece, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && piece.cells.length > 0 &&
    piece.cells.every(cell => {
      const px = x + cell.x;
      const py = y + cell.y;
      return px >= 0 && py >= 0 && px < BOARD_SIZE && py < BOARD_SIZE && board[py]?.[px] === 0;
    });
}

/** All phases use the same geometry; the opening has one natural 2×2 gap. */
export function canPlacePiece(state: GameState, index: number, x: number, y: number): boolean {
  const piece = state.pieces[index];
  const level = getLevel(state);
  return state.status === 'playing' && (state.mode !== 'level' || levelBudgetAvailable(state, level)) &&
    !!piece && canPlace(state.board, piece, x, y);
}

export function hasPlacement(board: number[][], piece: Piece): boolean {
  if (!piece.cells.length) return false;
  const { width, height } = getPieceBounds(piece);
  for (let y = 0; y <= BOARD_SIZE - height; y++) {
    for (let x = 0; x <= BOARD_SIZE - width; x++) {
      if (canPlace(board, piece, x, y)) return true;
    }
  }
  return false;
}

export function hasMove(board: number[][], pieces: (Piece | null)[]): boolean {
  return pieces.some(piece => piece && hasPlacement(board, piece));
}

export function placePiece(state: GameState, index: number, x: number, y: number): Placement | null {
  return applyMove(state, index, x, y, true);
}

function applyMove(state: GameState, index: number, x: number, y: number, refill: boolean): Placement | null {
  const piece = state.pieces[index];
  if (!piece || !canPlacePiece(state, index, x, y)) return null;

  const { board, placed, cleared, rows, columns } = resolveBoard(state.board, piece, x, y);
  const lineCount = rows.length + columns.length;
  const combo = lineCount ? state.combo + 1 : 0;
  const gained = 10 + lineCount * 20 + Math.max(0, combo - 1) * 10;
  const score = state.score + gained;
  const moves = state.moves + 1;
  const lines = state.lines + lineCount;
  const level = getLevel(state);
  let progress: LevelProgress | undefined;
  if (state.level) {
    const clearedKeys = new Set(cleared.map(cell => `${cell.x},${cell.y}`));
    const existingGems = new Map(state.level.gems.map(cell => [`${cell.x},${cell.y}`, cell]));
    if (piece.star && placed[0]) existingGems.set(`${placed[0].x},${placed[0].y}`, placed[0]);
    const gems = [...existingGems.values()].filter(cell => !clearedKeys.has(`${cell.x},${cell.y}`));
    const ice = state.level.ice.filter(cell => !clearedKeys.has(`${cell.x},${cell.y}`));
    progress = {
      ...state.level,
      id: state.level.id,
      gems: gems.map(cell => ({ ...cell })),
      ice: ice.map(cell => ({ ...cell })),
      collectedGems: state.level.collectedGems + existingGems.size - gems.length,
      clearedIce: state.level.clearedIce + state.level.ice.length - ice.length,
      clearedColors: countRemovedColors(state.level.clearedColors, state.board, cleared, placed, piece.color ?? 0),
    };
  }
  const goals = getLevelGoals({ ...state, lines, ...(progress ? { level: progress } : {}) });
  const won = state.mode === 'level' ? goals.length > 0 && goals.every(goal => goal.current >= goal.target)
    : state.mode === 'goal' && score >= state.target;
  let batch = state.batch;
  let rng = state.rng;
  let lastLongBatch = state.lastLongBatch;
  let pieces = state.pieces.map((entry, entryIndex) => entryIndex === index || !entry ? null : {
    ...entry,
    cells: entry.cells.map(cell => ({ ...cell })),
  });
  if (refill && (state.tutorial || pieces.every(entry => entry === null)) &&
    !(state.mode === 'level' && (won || !levelBudgetAvailable(state, level, moves)))) {
    if (!state.tutorial) batch++;
    if (state.mode === 'endless') {
      const supply = makeEndlessBatch(batch, board, rng, state.tutorial, lastLongBatch);
      pieces = supply.pieces;
      rng = supply.rng;
      lastLongBatch = supply.lastLongBatch;
    } else if (state.mode === 'level' && level) {
      if (level.flow) {
        const supply = makeFlowBatch({ ...state, board, moves, lines, batch, rng, lastLongBatch,
          ...(progress ? { level: progress } : {}) }, level);
        pieces = supply.pieces;
        rng = supply.rng;
        lastLongBatch = supply.lastLongBatch;
      } else pieces = makeLevelBatch(level, batch);
    }
    else pieces = makeBatch(batch);
  }
  const finishedSearchGroup = !refill && pieces.every(piece => piece === null) &&
    (state.mode !== 'level' || !!level && (!!level.flow || batch + 1 < level.batches.length));
  const budgetExhausted = state.mode === 'level' && !levelBudgetAvailable(state, level, moves);
  const status = won ? 'won' : !budgetExhausted && (finishedSearchGroup || hasMove(board, pieces)) ? 'playing' : 'lost';
  return {
    state: finalizeLevelWin({ ...state, rng, board, pieces, score, combo, moves, lines, batch, lastLongBatch,
      tutorial: false, status, ...(progress ? { level: progress } : {}) }),
    placed, cleared, rows, columns, gained,
  };
}

/** Empty cells never count, and simultaneous row/column intersections count once. */
function countRemovedColors(previous: number[] | undefined, source: number[][], cells: Cell[], placed: Cell[] = [], placedColor = 0): number[] {
  const counts = Array.from({ length: COLOR_COUNT }, (_, color) => previous?.[color] ?? 0);
  const placedKeys = new Set(placed.map(cell => cell.y * BOARD_SIZE + cell.x));
  const seen = new Set<number>();
  for (const cell of cells) {
    const key = cell.y * BOARD_SIZE + cell.x;
    if (seen.has(key)) continue;
    seen.add(key);
    const value = placedKeys.has(key) ? placedColor + 1 : source[cell.y][cell.x];
    if (Number.isInteger(value) && value >= 1 && value <= COLOR_COUNT) counts[value - 1]++;
  }
  return counts;
}

function copyState(state: GameState): GameState {
  return { ...state, board: state.board.map(row => row.slice()), pieces: state.pieces.map(piece => piece && {
    ...piece, cells: piece.cells.map(cell => ({ ...cell })),
  }), ...(state.level ? { level: { ...state.level, gems: state.level.gems.map(cell => ({ ...cell })),
    ice: state.level.ice.map(cell => ({ ...cell })), clearedColors: Array.from({ length: COLOR_COUNT }, (_, color) => state.level!.clearedColors?.[color] ?? 0) } } : {}) };
}

/** Rotate clockwise around the bounding box and normalize to a top-left origin. */
export function rotatePiece(state: GameState, index: number, preview = false): GameState | null {
  const piece = state.pieces[index];
  if (state.status !== 'playing' || state.tutorial || !piece || isLevelExpired(state)) return null;
  const { height } = getPieceBounds(piece);
  const cells = piece.cells.map(cell => ({ x: height - 1 - cell.y, y: cell.x }));
  const minX = Math.min(...cells.map(cell => cell.x)), minY = Math.min(...cells.map(cell => cell.y));
  for (const cell of cells) { cell.x -= minX; cell.y -= minY; }
  const signature = (entries: Cell[]) => entries.map(cell => `${cell.x},${cell.y}`).sort().join(';');
  if (signature(cells) === signature(piece.cells)) return null;
  const next = copyState(state);
  next.pieces[index] = { ...piece, cells };
  if (!preview && !hasMove(next.board, next.pieces)) return null;
  return next;
}

/** Turn the remaining candidates into single cells without refilling used slots. */
export function refreshPieces(state: GameState): GameState | null {
  if (state.status !== 'playing' || state.tutorial || isLevelExpired(state)) return null;
  if (!state.pieces.some(piece => piece && piece.cells.length !== 1) ||
    !hasPlacement(state.board, { id: '', cells: SHAPES[6] })) return null;
  const next = copyState(state);
  next.refreshes++;
  next.pieces = state.pieces.map((piece, index) => piece ? {
    id: `refresh-${next.refreshes}-${index}-6`, color: supplyColor(next.refreshes, 6, index), cells: SHAPES[6].map(cell => ({ ...cell })),
    ...(piece.star ? { star: true } : {}),
  } : null);
  return next;
}

export type Destruction = { state: GameState; cleared: Cell[]; area: Cell[] };

function canDestroy(state: GameState): boolean {
  if (state.tutorial || (state.status !== 'playing' && state.status !== 'lost') || !state.pieces.some(Boolean)) return false;
  if (state.mode === 'endless') return true;
  const level = getLevel(state);
  return state.mode === 'level' && !!state.level && levelBudgetAvailable(state, level);
}

function hasDestructible(state: GameState, area: Cell[]): boolean {
  return area.some(cell => state.board[cell.y][cell.x] !== 0 ||
    state.mode === 'level' && state.level?.ice.some(ice => ice.x === cell.x && ice.y === cell.y));
}

/** Direct removal is a tool effect, not a placement, row clear or supply deal. */
function destroyArea(state: GameState, area: Cell[]): Destruction | null {
  if (!hasDestructible(state, area)) return null;
  const next = copyState(state);
  const keys = new Set(area.map(cell => cell.y * BOARD_SIZE + cell.x));
  const cleared = area.filter(cell => next.board[cell.y][cell.x] !== 0).map(cell => ({ ...cell }));
  for (const cell of cleared) next.board[cell.y][cell.x] = 0;
  if (next.mode === 'level' && next.level) {
    const progress = next.level;
    const removedGems = new Set(progress.gems.filter(cell => keys.has(cell.y * BOARD_SIZE + cell.x)).map(cell => cell.y * BOARD_SIZE + cell.x));
    const removedIce = new Set(progress.ice.filter(cell => keys.has(cell.y * BOARD_SIZE + cell.x)).map(cell => cell.y * BOARD_SIZE + cell.x));
    progress.gems = progress.gems.filter(cell => !keys.has(cell.y * BOARD_SIZE + cell.x));
    progress.ice = progress.ice.filter(cell => !keys.has(cell.y * BOARD_SIZE + cell.x));
    progress.collectedGems += removedGems.size;
    progress.clearedIce += removedIce.size;
    progress.clearedColors = countRemovedColors(state.level!.clearedColors, state.board, cleared);
  }
  const goals = getLevelGoals(next);
  next.status = goals.length && goals.every(goal => goal.current >= goal.target)
    ? 'won' : hasMove(next.board, next.pieces) ? 'playing' : 'lost';
  return { state: finalizeLevelWin(next), cleared, area: area.map(cell => ({ ...cell })) };
}

/** Randomly choose a useful, fully in-bounds 3×3 region. Reward approval belongs to the UI. */
export function applyBomb(state: GameState, randomValue?: number): Destruction | null {
  if (!canDestroy(state)) return null;
  const regions: Cell[][] = [];
  for (let y = 0; y <= BOARD_SIZE - 3; y++) for (let x = 0; x <= BOARD_SIZE - 3; x++) {
    const area = Array.from({ length: 9 }, (_, index) => ({ x: x + index % 3, y: y + Math.floor(index / 3) }));
    if (hasDestructible(state, area)) regions.push(area);
  }
  if (!regions.length) return null;
  const value = randomValue === undefined ? Math.random() : randomValue;
  const unit = Number.isNaN(value) ? 0 : Math.max(0, Math.min(1 - Number.EPSILON, value));
  return destroyArea(state, regions[Math.floor(unit * regions.length)]);
}

/** Clear the contacted bottom-row columns. Animation previews use one original snapshot. */
export function applyBulldozer(state: GameState, throughColumn = BOARD_SIZE - 1): Destruction | null {
  if (!canDestroy(state) || !Number.isInteger(throughColumn) || throughColumn < 0 || throughColumn >= BOARD_SIZE) return null;
  const width = throughColumn + 1;
  const area = Array.from({ length: width * 3 }, (_, index) => ({ x: index % width, y: BOARD_SIZE - 3 + Math.floor(index / width) }));
  return destroyArea(state, area);
}

/** Clear the fewest obstructing cells needed for one of the current blocks. */
export function reviveGame(state: GameState): { state: GameState; cleared: Cell[] } | null {
  if (state.status !== 'lost' || state.tutorial) return null;
  const level = getLevel(state);
  if (state.mode === 'level' && (!levelBudgetAvailable(state, level) || !state.pieces.some(Boolean))) return null;
  const next = copyState(state);
  if (!next.pieces.some(Boolean)) next.pieces = makeBatch(next.batch);
  const protectedColors = new Set(level?.goals.filter(goal => goal.kind === 'color' &&
    Number.isInteger(goal.color) && goal.color! >= 0 && goal.color! < COLOR_COUNT &&
    (state.level!.clearedColors?.[goal.color!] ?? 0) < goal.target).map(goal => goal.color!));
  let best: Cell[] | null = null;
  for (const piece of next.pieces) {
    if (!piece) continue;
    const { width, height } = getPieceBounds(piece);
    for (let y = 0; y <= BOARD_SIZE - height; y++) for (let x = 0; x <= BOARD_SIZE - width; x++) {
      const blocked = piece.cells.filter(cell => next.board[y + cell.y][x + cell.x] !== 0).map(cell => ({ x: x + cell.x, y: y + cell.y }));
      if (state.mode === 'level' && blocked.some(cell => state.level!.gems.some(gem => gem.x === cell.x && gem.y === cell.y) ||
        protectedColors.has(state.board[cell.y][cell.x] - 1))) continue;
      if (!best || blocked.length < best.length) best = blocked;
    }
  }
  if (!best) return null;
  for (const cell of best) next.board[cell.y][cell.x] = 0;
  if (!hasMove(next.board, next.pieces)) return null;
  next.status = 'playing';
  return { state: next, cleared: best };
}

function candidates(state: GameState): Hint[] {
  const result: Hint[] = [];
  state.pieces.forEach((piece, index) => {
    if (!piece) return;
    const { width, height } = getPieceBounds(piece);
    for (let y = 0; y <= BOARD_SIZE - height; y++) {
      for (let x = 0; x <= BOARD_SIZE - width; x++) {
        if (canPlace(state.board, piece, x, y)) result.push({ index, x, y });
      }
    }
  });
  return result;
}

function positionValue(state: GameState): number {
  let occupied = 0;
  let trapped = 0;
  let almostFull = 0;
  for (let y = 0; y < BOARD_SIZE; y++) {
    let rowCount = 0;
    let colCount = 0;
    for (let x = 0; x < BOARD_SIZE; x++) {
      rowCount += Number(state.board[y][x] !== 0);
      colCount += Number(state.board[x][y] !== 0);
      if (state.board[y][x]) occupied++;
      else if ((x === 0 || state.board[y][x - 1]) && (x === 7 || state.board[y][x + 1]) &&
        (y === 0 || state.board[y - 1][x]) && (y === 7 || state.board[y + 1][x])) trapped++;
    }
    almostFull += rowCount * rowCount + colCount * colCount;
  }
  if (state.mode === 'level') {
    const goals = getLevelGoals(state);
    const objectiveValue = goals.reduce((sum, goal) => sum + Math.min(1, goal.current / Math.max(1, goal.target)) * 1200 +
      (goal.current >= goal.target ? 250 : 0), 0);
    return objectiveValue + state.score * 2 + state.combo * 12 - occupied * 7 - trapped * 30 + almostFull;
  }
  // Survival needs usable space for the next supply, while goal mode can take
  // a short-term points gain. Both modes still use the exact same placements.
  return state.mode === 'endless'
    ? state.score * 5 + state.combo * 12 - occupied * 10 - trapped * 30 + almostFull
    : state.score * 20 + state.combo * 12 - occupied * 4 - trapped * 22 + almostFull;
}

/** A bounded, deterministic search; no platform, timer or randomness is needed. */
export function findHint(state: GameState): Hint | null {
  if (state.status !== 'playing' || isLevelExpired(state)) return null;
  if (state.tutorial) return { ...TUTORIAL_MOVE };
  let best: Hint | null = null;
  let bestValue = -Infinity;
  for (const move of candidates(state)) {
    const result = applyMove(state, move.index, move.x, move.y, false)!;
    if (result.state.status === 'won') return move;
    if (result.state.status === 'lost') continue;
    let value = positionValue(result.state);
    // The next-placement bonus steers corners into useful combinations rather
    // than greedily taking the largest piece or isolating one-cell holes.
    let nextValue = value - (result.state.pieces.some(Boolean) ? 100 : 0);
    for (const next of candidates(result.state)) {
      const after = applyMove(result.state, next.index, next.x, next.y, false)!.state;
      if (after.status !== 'lost') nextValue = Math.max(nextValue, positionValue(after));
    }
    value += nextValue * 0.65;
    if (value > bestValue) {
      best = move;
      bestValue = value;
    }
  }
  return best ?? candidates(state)[0] ?? null;
}

/** One legal suggestion for a live endless run or campaign, without advancing state. */
export function requestHint(state: GameState): Hint | null {
  if (state.status !== 'playing' || state.tutorial || state.mode === 'goal') return null;
  const level = getLevel(state);
  if (state.mode === 'level' && (!state.level || !levelBudgetAvailable(state, level))) return null;
  const hint = findHint(state);
  return hint && canPlacePiece(state, hint.index, hint.x, hint.y) ? { ...hint } : null;
}

export const getHint = requestHint;
