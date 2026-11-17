import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const N = 8;
const key = cell => `${cell.x},${cell.y}`;
const mix = value => {
  let n = value >>> 0;
  n = Math.imul(n ^ n >>> 16, 0x7feb352d);
  n = Math.imul(n ^ n >>> 15, 0x846ca68b);
  return (n ^ n >>> 16) >>> 0;
};

// These helpers deliberately own the visible-board rules. They never read a
// solution, future authored tray, production hint, or adaptive supply planner.
export function legalMoves(state) {
  if (state.status === 'won') return [];
  const moves = [];
  state.pieces.forEach((piece, index) => {
    if (!piece) return;
    const w = Math.max(...piece.cells.map(cell => cell.x)) + 1;
    const h = Math.max(...piece.cells.map(cell => cell.y)) + 1;
    for (let y = 0; y <= N - h; y++) for (let x = 0; x <= N - w; x++) {
      if (piece.cells.every(cell => state.board[y + cell.y][x + cell.x] === 0)) moves.push({ index, x, y });
    }
  });
  return moves;
}

export function previewMove(state, move, definition) {
  const piece = state.pieces[move.index];
  if (!piece || !piece.cells.every(cell => move.x + cell.x >= 0 && move.x + cell.x < N &&
      move.y + cell.y >= 0 && move.y + cell.y < N && state.board[move.y + cell.y][move.x + cell.x] === 0)) return null;
  const board = state.board.map(row => row.slice());
  for (const cell of piece.cells) board[move.y + cell.y][move.x + cell.x] = (piece.color ?? 0) + 1;
  const level = state.level && { ...state.level, gems: state.level.gems.map(cell => ({ ...cell })),
    ice: state.level.ice.map(cell => ({ ...cell })), clearedColors: state.level.clearedColors.slice() };
  if (piece.star && level) level.gems.push({ x: move.x + piece.cells[0].x, y: move.y + piece.cells[0].y });
  const rows = board.flatMap((row, y) => row.every(Boolean) ? [y] : []);
  const columns = Array.from({ length: N }, (_, x) => x).filter(x => board.every(row => row[x]));
  const cleared = new Set();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (rows.includes(y) || columns.includes(x)) {
    cleared.add(`${x},${y}`);
    if (level) level.clearedColors[board[y][x] - 1]++;
    board[y][x] = 0;
  }
  if (level) {
    const gems = level.gems.filter(cell => !cleared.has(key(cell)));
    const ice = level.ice.filter(cell => !cleared.has(key(cell)));
    level.collectedGems += level.gems.length - gems.length;
    level.clearedIce += level.ice.length - ice.length;
    level.gems = gems; level.ice = ice;
  }
  const count = rows.length + columns.length, combo = count ? state.combo + 1 : 0;
  const pieces = state.pieces.slice(); pieces[move.index] = null;
  const next = { ...state, board, pieces, level, combo, moves: state.moves + 1,
    score: state.score + 10 + count * 20 + Math.max(0, combo - 1) * 10, lines: state.lines + count };
  if (definition && goalProgress(next, definition).every(goal => goal.current >= goal.target)) {
    const bonus = typeof definition.timeLimitSeconds === 'number'
      ? Math.ceil((level.timeRemainingMs ?? definition.timeLimitSeconds * 1000) / 1000) * 10 : 0;
    if (level.timeBonus === undefined) { level.timeBonus = bonus; next.score += bonus; }
    next.status = 'won';
  }
  return next;
}

export function goalProgress(state, definition) {
  return definition.goals.map(goal => {
    const current = goal.kind === 'lines' ? state.lines : goal.kind === 'gems' ? state.level.collectedGems :
      goal.kind === 'ice' ? state.level.clearedIce : state.level.clearedColors[goal.color];
    return { ...goal, current };
  });
}
export function progress(state, definition) {
  const goals = goalProgress(state, definition);
  return goals.reduce((sum, goal) => sum + Math.min(1, goal.current / goal.target), 0) / goals.length;
}

function quality(state, definition) {
  const counts = state.board.map(row => row.filter(Boolean).length);
  const columns = Array.from({ length: N }, (_, x) => state.board.reduce((n, row) => n + !!row[x], 0));
  let holes = 0, perimeter = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!state.board[y][x]) {
    let neighbors = 0;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      if (x + dx >= 0 && x + dx < N && y + dy >= 0 && y + dy < N && !state.board[y + dy][x + dx]) neighbors++;
    }
    if (neighbors <= 1) holes += 2 - neighbors;
    perimeter += 4 - neighbors;
  }
  const readiness = [...counts, ...columns].reduce((n, count) => n + count * count * count / 200, 0);
  const goals = goalProgress(state, definition);
  // Favor visible clears and objectives while retaining usable space. The
  // goal-progress cap prevents farming a completed color from dominating.
  return state.lines * 31 + goals.reduce((sum, goal) => sum + Math.min(goal.target, goal.current) *
    (goal.kind === 'gems' ? 9 : goal.kind === 'color' ? 2.5 : 10), 0) + readiness - holes * 6 - perimeter * .16 - counts.reduce((a, b) => a + b, 0) * .1;
}

export function chooseBlindMove(state, definition, seed = 1, policy = 'tray-beam') {
  const candidates = legalMoves(state).map(move => {
    const next = previewMove(state, move, definition);
    const jitter = mix(seed ^ state.moves * 131 ^ move.index * 257 ^ move.x * 17 ^ move.y * 41) / 2 ** 32;
    return { move, state: next, value: quality(next, definition) + jitter * 2.5 };
  }).sort((a, b) => b.value - a.value);
  if (!candidates.length) return null;
  if (policy === 'greedy') return candidates[0].move;
  // At most three visible pieces, a six-state beam, and no refill simulation.
  // Every root competes; only the best six are expanded beyond one placement.
  let beam = candidates.slice(0, 6).map(candidate => ({ ...candidate, first: candidate.move }));
  const slots = state.pieces.filter(Boolean).length;
  for (let depth = 1; depth < slots; depth++) {
    const expanded = [];
    for (const node of beam) for (const move of legalMoves(node.state)) {
      const next = previewMove(node.state, move, definition);
      const jitter = mix(seed ^ next.moves * 131 ^ move.index * 257 ^ move.x * 17 ^ move.y * 41) / 2 ** 32;
      expanded.push({ state: next, first: node.first, value: quality(next, definition) + jitter * 2.5 });
    }
    if (!expanded.length) return beam[0].first;
    // Diversify origins so symmetric continuations of a single first move do
    // not consume the entire beam and accidentally create a hidden route.
    expanded.sort((a, b) => b.value - a.value);
    const selected = [], perFirst = new Map();
    for (const node of expanded) {
      const id = `${node.first.index},${node.first.x},${node.first.y}`;
      if ((perFirst.get(id) ?? 0) >= 2) continue;
      selected.push(node); perFirst.set(id, (perFirst.get(id) ?? 0) + 1);
      if (selected.length === 6) break;
    }
    beam = selected;
  }
  return beam[0].first;
}

export function firstTrayBranches(state) {
  const moves = legalMoves(state), memo = new Map();
  function completes(position) {
    if (position.pieces.every(piece => !piece)) return true;
    const signature = position.pieces.map(piece => piece?.id ?? '-').join('|') + ':' +
      position.board.map(row => row.map(Boolean).map(Number).join('')).join('/');
    if (memo.has(signature)) return memo.get(signature);
    for (const move of legalMoves(position)) if (completes(previewMove(position, move))) {
      memo.set(signature, true); return true;
    }
    memo.set(signature, false); return false;
  }
  return { legalFirstMoves: moves.length, distinctOrigins: new Set(moves.map(move => `${move.x},${move.y}`)).size,
    fullTrayFirstMoves: moves.filter(move => completes(previewMove(state, move))).length };
}

export function runBlind(engine, definition, seed, policy, maxMoves = definition.maxMoves) {
  let state = engine.createLevel(definition.id), firstClear = null, at12 = null, survivedFirstTray = false, survivedSecondTray = false;
  const actions = [], refills = [];
  while (state.status === 'playing' && state.moves < maxMoves) {
    if (engine.advanceLevelTime) {
      state = engine.advanceLevelTime(state, 4000);
      if (state.status !== 'playing') break;
    }
    if (!refills.some(entry => entry.batch === state.batch)) {
      const fraction = progress(state, definition), pieces = state.pieces.filter(Boolean);
      refills.push({ batch: state.batch, moves: state.moves, progress: fraction,
        band: fraction < .35 ? 'below35' : fraction < .75 ? 'from35to75' : 'atLeast75',
        stage: engine.getLevelStage?.(state) ?? null,
        occupied: state.board.flat().filter(Boolean).length, legalActions: legalMoves(state).length,
        pieces: pieces.length, large: pieces.filter(piece => piece.cells.length >= 5).length,
        long: pieces.filter(piece => piece.cells.length >= 4 && (piece.cells.every(cell => cell.x === piece.cells[0].x) ||
          piece.cells.every(cell => cell.y === piece.cells[0].y))).length,
        meanCells: pieces.reduce((sum, piece) => sum + piece.cells.length, 0) / pieces.length });
    }
    const move = chooseBlindMove(state, definition, seed, policy);
    if (!move) break;
    const result = engine.placePiece(state, move.index, move.x, move.y);
    if (!result) throw new Error(`${definition.id}: independent legal move rejected`);
    actions.push(move); state = result.state;
    if (firstClear === null && state.lines > 0) firstClear = state.moves;
    if (state.moves === 3 || state.status === 'won') survivedFirstTray ||= state.status !== 'lost';
    if (state.moves === 6 || state.status === 'won') survivedSecondTray ||= state.status !== 'lost';
    if (state.moves === 12 || state.status !== 'playing') at12 ??= { lines: state.lines, progress: progress(state, definition), moves: state.moves };
  }
  at12 ??= { lines: state.lines, progress: progress(state, definition), moves: state.moves };
  return { seed, policy, moves: state.moves, status: state.status, progress: progress(state, definition),
    firstClear, at12, survivedFirstTray, survivedSecondTray, actions, refills,
    failureCause: state.status !== 'lost' ? null : state.level?.timeRemainingMs === 0 ? 'timeout'
      : definition.timeLimitSeconds === undefined && state.moves >= definition.maxMoves ? 'budget' : 'blocked' };
}

const average = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const median = values => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
export function summarize(results) {
  const runs = results.flatMap(result => result.runs), failed = runs.filter(run => run.status !== 'won');
  const refills = runs.flatMap(run => run.refills);
  const bands = Object.fromEntries(['below35', 'from35to75', 'atLeast75'].map(band => {
    const entries = refills.filter(entry => entry.band === band), pieces = entries.reduce((sum, entry) => sum + entry.pieces, 0);
    return [band, { trays: entries.length, averageOccupied: average(entries.map(entry => entry.occupied)),
      averageLegalActions: average(entries.map(entry => entry.legalActions)), averagePieceCells: average(entries.map(entry => entry.meanCells)),
      largePieceFraction: entries.reduce((sum, entry) => sum + entry.large, 0) / Math.max(1, pieces),
      longPieceFraction: entries.reduce((sum, entry) => sum + entry.long, 0) / Math.max(1, pieces) }];
  }));
  return { levels: results.length, runs: runs.length,
    averageInitialOccupied: average(results.map(result => result.initialOccupied)),
    minimumViableFirstMoves: Math.min(...results.map(result => result.branches.fullTrayFirstMoves)),
    averageViableFirstMoves: average(results.map(result => result.branches.fullTrayFirstMoves)),
    levelsWithOnlyOneViableOpening: results.filter(result => result.branches.fullTrayFirstMoves <= 1).length,
    medianFirstClear: median(runs.filter(run => run.firstClear !== null).map(run => run.firstClear)),
    runsWithoutClear: runs.filter(run => run.firstClear === null).length,
    firstTraySurvival: average(runs.map(run => +run.survivedFirstTray)),
    nextTraySurvival: average(runs.map(run => +run.survivedSecondTray)),
    averageLinesByMove12: average(runs.map(run => run.at12.lines)),
    averageTargetProgressByMove12: average(runs.map(run => run.at12.progress)),
    proxyCompletions: runs.filter(run => run.status === 'won').length,
    averageRunMoves: average(runs.map(run => run.moves)),
    pressureByTargetProgress: bands,
    failureCauses: { budget: failed.filter(run => run.failureCause === 'budget').length,
      timeout: failed.filter(run => run.failureCause === 'timeout').length,
      blocked: failed.filter(run => run.failureCause === 'blocked').length },
    failedProgress: { below35: failed.filter(run => run.progress < .35).length,
      from35to75: failed.filter(run => run.progress >= .35 && run.progress < .75).length,
      atLeast75: failed.filter(run => run.progress >= .75).length },
    failedMoves: { firstTray: failed.filter(run => run.moves <= 3).length,
      before12: failed.filter(run => run.moves > 3 && run.moves < 12).length,
      from12: failed.filter(run => run.moves >= 12).length } };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const before = args.has('--before');
  const engine = await import(before ? '../.local/pacing-before/game.ts' : '../src/core/game.ts');
  const candidateArg = process.argv.find(arg => arg.startsWith('--candidate='));
  let definitions = before ? JSON.parse(await readFile('.local/pacing-before/levels.json', 'utf8')) :
    (await import('../src/core/levels.ts')).LEVELS;
  if (candidateArg && !before) {
    const candidate = JSON.parse(await readFile(candidateArg.slice('--candidate='.length), 'utf8'));
    definitions.splice(0, definitions.length, ...candidate);
  }
  const seedArg = process.argv.find(arg => arg.startsWith('--seeds='));
  const count = seedArg ? Number(seedArg.split('=')[1]) : 3;
  const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
  const selected = limitArg ? definitions.slice(0, Number(limitArg.split('=')[1])) : definitions;
  const policies = args.has('--greedy-only') ? ['greedy'] : args.has('--beam-only') ? ['tray-beam'] : ['greedy', 'tray-beam'];
  const results = [];
  for (const definition of selected) {
    const state = engine.createLevel(definition.id), branches = firstTrayBranches(state), runs = [];
    for (const policy of policies) for (let index = 0; index < count; index++) {
      runs.push(runBlind(engine, definition, 19 + index * 101, policy));
    }
    const result = { id: definition.id, difficulty: definition.difficulty, mechanic: definition.mechanic,
      initialOccupied: state.board.flat().filter(Boolean).length, branches, runs };
    results.push(result);
    console.log(`${definition.id}: branches ${branches.fullTrayFirstMoves}/${branches.legalFirstMoves}, clear ${runs.map(run => run.firstClear ?? '-').join('/')}, end ${runs.map(run => `${run.moves}:${run.status}:${Math.round(run.progress * 100)}`).join('/')}`);
  }
  const output = { protocol: 'visible tray only; greedy + width-6 beam through at most 3 current pieces; fixed paired policy seeds; no tools or solution/hints',
    caveat: 'Deterministic policy proxies, not measured human win rates. Supply is not altered by policy seed.',
    version: before ? 'before' : candidateArg ? 'candidate' : 'after', createdAt: new Date().toISOString(), summary: summarize(results), results };
  await mkdir('.local/pacing-qa', { recursive: true });
  const destination = `.local/pacing-qa/${before ? 'before' : candidateArg ? 'candidate' : 'after'}${limitArg ? '-sample' : ''}${args.has('--greedy-only') ? '-greedy' : args.has('--beam-only') ? '-beam' : ''}.json`;
  await writeFile(destination, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ destination, ...output.summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
