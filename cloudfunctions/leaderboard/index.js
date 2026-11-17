const { createHash } = require('node:crypto');
const savedLimits = require('./levels.json');

const levelIdValid = value => typeof value === 'string' && /^level-(0[1-9]|[12]\d|30)$/.test(value);
const unavailable = message => ({ status: 'error', entries: [], message });
const identity = openid => createHash('sha256').update(openid).digest('hex');
function grade(score, thresholds) {
  return score >= thresholds[2] ? 3 : score >= thresholds[1] ? 2 : 1;
}
function validateSubmission(event, limits) {
  if (!levelIdValid(event?.levelId)) return false;
  const level = limits[event.levelId];
  if (!level || !Array.isArray(level.starScores) || level.starScores.length !== 3 || !Number.isSafeInteger(level.maxMoves)) return false;
  const maxTimeBonus = level.maxTimeBonus === undefined ? 0 : level.maxTimeBonus;
  if (!Number.isSafeInteger(maxTimeBonus) || maxTimeBonus < 0) return false;
  const maxScore = level.maxMoves * 330 + level.maxMoves * (level.maxMoves - 1) * 5 + maxTimeBonus;
  return Number.isSafeInteger(event.score) && event.score >= 0 && event.score % 10 === 0 && event.score <= maxScore &&
    Number.isInteger(event.stars) && event.stars === grade(event.score, level.starScores);
}
async function optionalDocument(document) {
  try { const result = await document.get(); return result?.data ?? null; }
  catch (error) {
    if (/document.*(?:not.*exist|not.*found)|DOCUMENT_NOT_FOUND|DATABASE_DOCUMENT_NOT_EXIST/i.test(String(error?.errMsg || error?.message))) return null;
    throw error;
  }
}

/** Injectable SDK keeps identity, high-score merging and list behavior testable offline. */
function createHandler(cloud, options = {}) {
  const limits = options.levels || savedLimits;
  const expectedAppId = options.appId || process.env.LEADERBOARD_APPID || '';
  return async function handle(event) {
    const actor = cloud.getWXContext();
    if (!expectedAppId || actor.APPID !== expectedAppId || typeof actor.OPENID !== 'string' || !actor.OPENID) return unavailable('排行榜身份尚未配置');
    const db = cloud.database(), owner = identity(actor.OPENID);
    if (event?.action === 'submit') {
      if (!validateSubmission(event, limits)) return unavailable('成绩格式无效');
      try {
        const result = await db.runTransaction(async transaction => {
          const scoreDocument = transaction.collection('wood_block_scores').doc(`${owner}_${event.levelId}`);
          const playerDocument = transaction.collection('wood_block_players').doc(owner);
          const previous = await optionalDocument(scoreDocument);
          const player = await optionalDocument(playerDocument);
          const timestamp = Date.now(), bestScore = Math.max(previous?.score || 0, event.score);
          const bestStars = grade(bestScore, limits[event.levelId].starScores);
          const bests = { ...(player?.bests || {}), [event.levelId]: bestScore };
          const totalScore = Object.entries(bests).reduce((sum, [id, score]) => sum + (levelIdValid(id) && Number.isSafeInteger(score) && score >= 0 ? score : 0), 0);
          const nickname = `玩家${owner.slice(0, 6)}`;
          const bestAchievedAt = !previous || event.score > previous.score ? timestamp : previous.achievedAt;
          const totalAchievedAt = !player || totalScore > player.score ? timestamp : player.achievedAt;
          await scoreDocument.set({ data: { owner, levelId: event.levelId, nickname, score: bestScore, stars: bestStars,
            achievedAt: bestAchievedAt } });
          await playerDocument.set({ data: { owner, nickname, bests, score: totalScore,
            achievedAt: totalAchievedAt } });
          return { bestScore, totalScore, bestAchievedAt, totalAchievedAt };
        });
        return { status: 'ready', entries: [], ...result };
      } catch { return unavailable('成绩暂时无法上传'); }
    }
    if (event?.action === 'list') {
      if (event.levelId !== undefined && !levelIdValid(event.levelId)) return unavailable('关卡不存在');
      try {
        let query = db.collection(event.levelId ? 'wood_block_scores' : 'wood_block_players');
        if (event.levelId) query = query.where({ levelId: event.levelId });
        const result = await query.orderBy('score', 'desc').orderBy('achievedAt', 'asc').orderBy('_id', 'asc').limit(50).get();
        return { status: 'ready', entries: result.data.map((row, index) => ({ rank: index + 1, nickname: row.nickname,
          score: row.score, isSelf: row.owner === owner })) };
      } catch { return unavailable('排行榜暂时无法加载'); }
    }
    return unavailable('未知的排行榜操作');
  };
}

exports.createHandler = createHandler;
exports.validateSubmission = validateSubmission;
exports.main = async event => {
  const cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  return createHandler(cloud)(event);
};
