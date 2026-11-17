/** Shared gameplay and art semantics: board cells store these indices plus one. */
export const COLOR_COUNT = 5;
export const COLOR_NAMES = ['红色', '黄色', '绿色', '蓝色', '紫色'] as const;
export const TILE_IDS = ['tile_red', 'tile_yellow', 'tile_green', 'tile_blue', 'tile_purple'] as const;
export const STAR_TILE_IDS = ['tile_red_star', 'tile_yellow_star', 'tile_green_star', 'tile_blue_star', 'tile_purple_star'] as const;
export const COLOR_BASES = ['#F75E58', '#FDC321', '#75D239', '#2D86EF', '#B857E9'] as const;

/** Legacy v1: blue, cyan, purple, orange, pink, indigo, green → approved five colors.
 * Existing persisted saves contain progress/rewards, not boards or color goals;
 * they keep their v1 keys and records. Use this only for explicitly legacy art/state.
 */
export const LEGACY_COLOR_MAP = [3, 2, 4, 1, 0, 3, 2] as const;
export function migrateLegacyColor(color: number): number {
  if (!Number.isInteger(color) || color < 0 || color >= LEGACY_COLOR_MAP.length) {
    throw new RangeError(`Unknown legacy color: ${color}`);
  }
  return LEGACY_COLOR_MAP[color];
}
