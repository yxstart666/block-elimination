import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMPAIGN_LEVEL_IDS, CAMPAIGN_STORAGE_KEY, sanitizeCampaign, markLevelComplete, markLessonSeen, isLevelUnlocked, getNextLevelIndex } from '../src/services/campaign.ts';

const fresh = () => ({ version: 1 as const, completed: [] as string[], lessonsSeen: [] as string[] });

test('campaign progress accepts object and JSON saves, removes unknown IDs and owns its arrays', () => {
  const source = { version: 1, completed: ['level-03', 'level-01', 'level-03', 'gems', 'level-31', null], lessonsSeen: ['level-04', 'level-04', 1] };
  const clean = sanitizeCampaign(source);
  assert.deepEqual(clean, { version: 1, completed: ['level-01', 'level-03'], lessonsSeen: ['level-04'] });
  assert.deepEqual(sanitizeCampaign(JSON.stringify(source)), clean);
  clean.completed.push('level-02'); clean.lessonsSeen.length = 0;
  assert.deepEqual(source.lessonsSeen, ['level-04', 'level-04', 1]);
  assert.equal(source.completed.length, 6);
  assert.equal(CAMPAIGN_STORAGE_KEY, 'wood-blocks.campaign.v1');
  assert.equal(CAMPAIGN_LEVEL_IDS.length, 30);
});

test('malformed and incompatible saves fall back safely without invented progress', () => {
  for (const value of [undefined, null, false, 1, '', 'broken', 'null', '[]', [], {}, { version: 2, completed: ['level-01'] }]) {
    assert.deepEqual(sanitizeCampaign(value), fresh());
  }
  assert.deepEqual(sanitizeCampaign({ version: 1, completed: {}, lessonsSeen: true }), fresh());
});

test('unlocking requires all earlier levels, even when a damaged save lists a later win', () => {
  const progress = sanitizeCampaign({ version: 1, completed: ['level-01', 'level-03'], lessonsSeen: [] });
  assert.equal(isLevelUnlocked(progress, 0), true);
  assert.equal(isLevelUnlocked(progress, 1), true);
  assert.equal(isLevelUnlocked(progress, 2), false);
  assert.equal(isLevelUnlocked(progress, 3), false);
  assert.equal(getNextLevelIndex(progress), 1);
  for (const index of [-1, .5, NaN, Infinity, 30]) assert.equal(isLevelUnlocked(progress, index), false);
});

test('completion advances one level at a time, deduplicates and never mutates caller state', () => {
  const initial = fresh();
  assert.deepEqual(markLevelComplete(initial, 'level-02'), initial, 'a locked level cannot be completed through the helper');
  const next = markLevelComplete(initial, 'level-01');
  assert.deepEqual(initial, fresh());
  assert.deepEqual(next.completed, ['level-01']);
  assert.notEqual(next, initial);
  assert.equal(getNextLevelIndex(next), 1);
  assert.deepEqual(markLevelComplete(next, 'level-01'), next);
  assert.deepEqual(markLevelComplete(next, 'unknown'), next);
  const third = markLevelComplete(next, 'level-02');
  assert.deepEqual(third.completed, ['level-01', 'level-02']);
  assert.equal(isLevelUnlocked(third, 2), true);
});

test('learning notices are tracked independently and survive serialization', () => {
  const initial = fresh(), noticed = markLessonSeen(initial, 'level-04');
  assert.deepEqual(initial, fresh());
  assert.deepEqual(noticed.lessonsSeen, ['level-04']);
  assert.deepEqual(noticed.completed, []);
  assert.deepEqual(markLessonSeen(noticed, 'level-04'), noticed);
  assert.deepEqual(markLessonSeen(noticed, 'not-a-level'), noticed);
  const reloaded = sanitizeCampaign(JSON.stringify(noticed));
  assert.deepEqual(reloaded, noticed);
  assert.equal(getNextLevelIndex(reloaded), 0, 'a lesson notice does not unlock or win a level');
});

test('new color lessons preserve old wins while keeping a separate mechanism notice', () => {
  const old = sanitizeCampaign({ version: 1, completed: ['level-01', 'level-02'], lessonsSeen: ['level-07', 'level-10'] });
  assert.ok(!old.lessonsSeen.includes('level-07:colors-v1'));
  const next = markLessonSeen(markLessonSeen(old, 'level-07:colors-v1'), 'level-10:colors-stars-v1');
  assert.deepEqual(next.completed, old.completed);
  assert.ok(next.lessonsSeen.includes('level-07') && next.lessonsSeen.includes('level-07:colors-v1'));
  assert.deepEqual(sanitizeCampaign(JSON.stringify(next)), next);
  assert.deepEqual(markLessonSeen(next, 'level-07:invented-v9'), next);
});

test('finishing all thirty levels keeps the finale playable without unlocking a nonexistent level', () => {
  let progress = fresh();
  for (const id of CAMPAIGN_LEVEL_IDS) progress = markLevelComplete(progress, id);
  assert.equal(progress.completed.length, 30);
  assert.equal(getNextLevelIndex(progress), 29);
  assert.equal(isLevelUnlocked(progress, 29), true);
  assert.equal(isLevelUnlocked(progress, 30), false);
  assert.deepEqual(sanitizeCampaign(JSON.stringify(progress)), progress);
});

test('explicit campaign ID lists use their own order for completion and unlock checks', () => {
  const ids = ['alpha', 'beta', 'gamma'];
  const initial = sanitizeCampaign({ version: 1, completed: ['gamma', 'alpha', 'level-01'], lessonsSeen: ['beta'] }, ids);
  assert.deepEqual(initial.completed, ['alpha', 'gamma']);
  assert.equal(getNextLevelIndex(initial, ids), 1);
  assert.equal(isLevelUnlocked(initial, 2, ids), false);
  const next = markLevelComplete(initial, 'beta', ids);
  assert.deepEqual(next.completed, ids);
  assert.equal(getNextLevelIndex(next, ids), 2);
  assert.deepEqual(markLessonSeen(initial, 'alpha', ids).lessonsSeen, ['alpha', 'beta']);
});

test('test-only selection records a genuine later win without inventing prerequisite wins', () => {
  const progress = markLevelComplete(fresh(), 'level-30', undefined, true);
  assert.deepEqual(progress.completed, ['level-30']);
  assert.equal(getNextLevelIndex(progress), 0);
  assert.equal(isLevelUnlocked(progress, 29), false);
  assert.deepEqual(markLevelComplete(fresh(), 'level-30'), fresh());
});
