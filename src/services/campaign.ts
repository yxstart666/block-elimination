/** Local campaign progress contains completed levels and one-time lesson notices. */
export type CampaignProgress = { version: 1; completed: string[]; lessonsSeen: string[] };

export const CAMPAIGN_STORAGE_KEY = 'wood-blocks.campaign.v1';
export const CAMPAIGN_LEVEL_IDS: readonly string[] = Array.from({ length: 30 }, (_, index) => `level-${String(index + 1).padStart(2, '0')}`);
const LESSON_UPDATES = ['level-07:colors-v1', 'level-10:colors-stars-v1'];
const lessonIds = (ids: readonly string[]) => [...ids, ...LESSON_UPDATES.filter(key => ids.includes(key.split(':')[0]))];

/** Unknown versions and damaged saves start clean; valid entries remain in level order. */
export function sanitizeCampaign(value: unknown, ids: readonly string[] = CAMPAIGN_LEVEL_IDS): CampaignProgress {
  const empty = (): CampaignProgress => ({ version: 1, completed: [], lessonsSeen: [] });
  try {
    const source = typeof value === 'string' ? JSON.parse(value) : value;
    if (!source || typeof source !== 'object' || Array.isArray(source) || source.version !== 1) return empty();
    const clean = (entries: unknown) => {
      const valid = new Set(Array.isArray(entries) ? entries.filter(entry => typeof entry === 'string') : []);
      return [...new Set(ids)].filter(id => valid.has(id));
    };
    const noticed = new Set(Array.isArray(source.lessonsSeen) ? source.lessonsSeen.filter((entry: unknown) => typeof entry === 'string') : []);
    return { version: 1, completed: clean(source.completed), lessonsSeen: lessonIds(ids).filter(id => noticed.has(id)) };
  } catch { return empty(); }
}

/** A later completion cannot unlock a level while an earlier prerequisite is missing. */
export function isLevelUnlocked(progress: CampaignProgress, index: number, ids: readonly string[] = CAMPAIGN_LEVEL_IDS): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= ids.length) return false;
  const completed = new Set(sanitizeCampaign(progress, ids).completed);
  return ids.slice(0, index).every(id => completed.has(id));
}

/** Returns the earliest unfinished level; an all-complete campaign points to its finale. */
export function getNextLevelIndex(progress: CampaignProgress, ids: readonly string[] = CAMPAIGN_LEVEL_IDS): number {
  const completed = new Set(sanitizeCampaign(progress, ids).completed);
  const index = ids.findIndex(id => !completed.has(id));
  return index < 0 ? Math.max(0, ids.length - 1) : index;
}

export function markLevelComplete(progress: CampaignProgress, id: string, ids: readonly string[] = CAMPAIGN_LEVEL_IDS, allowTestSkip = false): CampaignProgress {
  const next = sanitizeCampaign(progress, ids);
  const index = ids.indexOf(id);
  if (index < 0 || (!allowTestSkip && !isLevelUnlocked(next, index, ids)) || next.completed.includes(id)) return next;
  next.completed.push(id);
  return sanitizeCampaign(next, ids);
}

export function markLessonSeen(progress: CampaignProgress, id: string, ids: readonly string[] = CAMPAIGN_LEVEL_IDS): CampaignProgress {
  const next = sanitizeCampaign(progress, ids);
  if (!lessonIds(ids).includes(id) || next.lessonsSeen.includes(id)) return next;
  next.lessonsSeen.push(id);
  return sanitizeCampaign(next, ids);
}
