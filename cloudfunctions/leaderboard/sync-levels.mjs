/** Refresh server-side star thresholds before deploying this cloud function. */
import { writeFile } from 'node:fs/promises';
import { LEVELS } from '../../src/core/levels.ts';
import { LEVEL_TIME_BONUS_PER_SECOND } from '../../src/core/game.ts';
const limits = Object.fromEntries(LEVELS.map(level => [level.id, { maxMoves: level.maxMoves, starScores: level.starScores,
  maxTimeBonus: typeof level.timeLimitSeconds === 'number' ? Math.ceil(level.timeLimitSeconds) * LEVEL_TIME_BONUS_PER_SECOND : 0 }]));
if (LEVELS.length !== 30 || Object.values(limits).some(level => !Array.isArray(level.starScores) || level.starScores.length !== 3)) throw new Error('Thirty valid star thresholds are required');
await writeFile(new URL('./levels.json', import.meta.url), JSON.stringify(limits, null, 2) + '\n');
console.log('Leaderboard limits synced for 30 levels.');
