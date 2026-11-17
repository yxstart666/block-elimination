import type { Cell, Hint, Piece } from './game.ts';

export type LevelGoalKind = 'lines' | 'gems' | 'ice' | 'color';
export type LevelGoal = { kind: LevelGoalKind; target: number; color?: number };
export type LevelGoalProgress = LevelGoal & { current: number };
export type LevelMechanic = 'lines' | 'gems' | 'ice' | 'dual' | 'colors';
export type LevelDifficulty = 4 | 5 | 6 | 7 | 8;

/** Fixed challenges and seeded, board-aware campaign levels share a replayable witness. */
export type LevelDefinition = {
  id: string;
  number: number;
  mechanic: LevelMechanic;
  learning: boolean;
  title: string;
  subtitle: string;
  description: string;
  difficulty: LevelDifficulty;
  starScores: [number, number, number];
  board: number[][];
  gems: Cell[];
  ice: Cell[];
  goals: LevelGoal[];
  batches: Piece[][];
  solution: Hint[];
  /** Positive = countdown; null = unlimited planning; omitted = legacy placement budget. */
  timeLimitSeconds?: number | null;
  /** Offline witness/server score estimate; only legacy levels with an omitted clock enforce it. */
  maxMoves: number;
  /** Runtime supply follows the board; batches/solution remain a verified example route. */
  flow?: { seed: number; openingBatches: number };
};

export type LevelProgress = {
  id: string;
  gems: Cell[];
  ice: Cell[];
  collectedGems: number;
  clearedIce: number;
  clearedColors: number[];
  /** Remaining active-play time. Pure core only changes this through advanceLevelTime. */
  timeRemainingMs?: number;
  /** Issued once on victory; absent before settlement, zero for an untimed level. */
  timeBonus?: number;
};
