import type { LeaderboardConfig } from '../config/leaderboard.ts';

export type LeaderboardScope = 'users' | 'friends';
export type LeaderboardEntry = { rank: number; nickname: string; score: number; isSelf?: boolean };
export type LeaderboardResult = {
  status: 'ready' | 'unconfigured' | 'unsupported' | 'error';
  entries: LeaderboardEntry[];
  message?: string;
  presentation?: 'open-data';
  bestScore?: number;
  totalScore?: number;
  bestAchievedAt?: number;
  totalAchievedAt?: number;
};
export type LeaderboardSubmission = { levelId: string; score: number; stars: number };
export interface LeaderboardGateway {
  load(scope: LeaderboardScope, levelId?: string): Promise<LeaderboardResult>;
  submit(value: LeaderboardSubmission): Promise<LeaderboardResult>;
  drawFriends?(context: any, rect: { x: number; y: number; w: number; h: number }): void;
  hideFriends?(): void;
  dispose?(): void;
}

const REQUEST_TIMEOUT_MS = 12_000;
const validLevel = (id: unknown): id is string => typeof id === 'string' && /^level-(0[1-9]|[12]\d|30)$/.test(id);
const validScore = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 50_000;
const empty = (status: LeaderboardResult['status'], message: string): LeaderboardResult => ({ status, entries: [], message });

/** Browser previews never invent online users or friend scores. */
export function createUnavailableLeaderboard(): LeaderboardGateway {
  return {
    load: async () => empty('unconfigured', '排行榜尚未连接，请配置正式微信 AppID 和云环境'),
    submit: async () => empty('unconfigured', '排行榜尚未连接，成绩已保存在本机'),
  };
}

function sanitizeResponse(value: any): LeaderboardResult {
  if (!value || value.status !== 'ready') return empty('error', '排行榜暂时无法加载，请稍后重试');
  const entries: LeaderboardEntry[] = [];
  for (const row of Array.isArray(value.entries) ? value.entries.slice(0, 50) : []) {
    if (!row || !Number.isSafeInteger(row.rank) || row.rank < 1 || !Number.isSafeInteger(row.score) || row.score < 0 || row.score > 1_500_000) continue;
    const nickname = typeof row.nickname === 'string' ? row.nickname.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16) : '';
    if (!nickname) continue;
    entries.push({ rank: row.rank, nickname, score: row.score, ...(row.isSelf === true ? { isSelf: true } : {}) });
  }
  entries.sort((a, b) => a.rank - b.rank);
  return { status: 'ready', entries,
    ...(validScore(value.bestScore) ? { bestScore: value.bestScore } : {}),
    ...(Number.isSafeInteger(value.totalScore) && value.totalScore >= 0 && value.totalScore <= 1_500_000 ? { totalScore: value.totalScore } : {}),
    ...(Number.isSafeInteger(value.bestAchievedAt) && value.bestAchievedAt > 0 ? { bestAchievedAt: value.bestAchievedAt } : {}),
    ...(Number.isSafeInteger(value.totalAchievedAt) && value.totalAchievedAt > 0 ? { totalAchievedAt: value.totalAchievedAt } : {}),
  };
}

/** Global scores use your cloud function; friend data stays in the Mini Game open-data domain. */
export function createWechatLeaderboard(wxApi: any, config: LeaderboardConfig, host: 'miniprogram' | 'minigame' = 'miniprogram'): LeaderboardGateway {
  const settings = { ...config };
  let disposed = false, initialized = false;
  let openData: any = null, friendLevel: string | undefined, friendLayout = '';
  const knownFriendScores = new Map<string, { score: number; achievedAt?: number }>();
  let friendWriteTail: Promise<void> = Promise.resolve();
  const pendingWriteReports = new Set<() => void>();
  const rememberFriendScore = (key: string, score: number, achievedAt?: number) => {
    const previous = knownFriendScores.get(key);
    if (!previous || score > previous.score) knownFriendScores.set(key, { score, ...(achievedAt ? { achievedAt } : {}) });
    else if (score === previous.score && achievedAt && (!previous.achievedAt || achievedAt < previous.achievedAt)) {
      knownFriendScores.set(key, { score, achievedAt });
    }
  };
  const writeFriends = (keys: string[]): Promise<'written' | 'failed' | 'skipped'> => new Promise(resolve => {
    let reported = false;
    const finishReport = (result: 'written' | 'failed' | 'skipped') => {
      if (reported) return;
      reported = true; clearTimeout(timer); pendingWriteReports.delete(cancelReport); resolve(result);
    };
    const cancelReport = () => finishReport('skipped');
    // Bound the caller's wait, not the SDK operation. A timed-out SDK write may
    // still finish later, so it must retain the serialization lock until its
    // real callback arrives; otherwise a late old write could undo a new one.
    const timer = setTimeout(() => finishReport('failed'), REQUEST_TIMEOUT_MS);
    pendingWriteReports.add(cancelReport);
    friendWriteTail = friendWriteTail.then(() => {
      if (disposed) { finishReport('skipped'); return; }
      const entries = keys.map(key => ({ key, value: JSON.stringify(knownFriendScores.get(key)!) }));
      return new Promise<void>(release => {
        let settled = false;
        const finishSDK = (ok: boolean) => {
          if (settled) return;
          settled = true; finishReport(ok ? 'written' : 'failed'); release();
        };
        try { wxApi.setUserCloudStorage({ KVDataList: entries, success: () => finishSDK(true), fail: () => finishSDK(false) }); }
        catch { finishSDK(false); }
      });
    }).catch(() => { finishReport('failed'); });
  });
  const unavailable = () => empty('unconfigured', '排行榜尚未连接，请配置正式微信 AppID 和云环境');
  const configured = () => settings.enabled && !!settings.environmentId.trim() && !!settings.functionName.trim();
  const call = async (data: Record<string, unknown>): Promise<LeaderboardResult> => {
    if (disposed) return empty('error', '排行榜已关闭');
    if (!configured()) return unavailable();
    if (typeof wxApi?.cloud?.callFunction !== 'function' || typeof wxApi?.cloud?.init !== 'function') return empty('unsupported', '当前微信版本暂不支持在线排行榜');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!initialized) { wxApi.cloud.init({ env: settings.environmentId.trim(), traceUser: false }); initialized = true; }
      const operation = wxApi.cloud.callFunction({ name: settings.functionName.trim(), data });
      const response: any = await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), REQUEST_TIMEOUT_MS); })]);
      if (disposed) return empty('error', '排行榜已关闭');
      return sanitizeResponse(response?.result);
    } catch { return empty('error', '排行榜暂时无法加载，请稍后重试'); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  return {
    async load(scope, levelId) {
      if (levelId !== undefined && !validLevel(levelId)) return empty('error', '关卡不存在');
      if (scope === 'friends') {
        if (host !== 'minigame') return empty('unsupported', '好友榜暂未接入，当前可查看全体用户榜');
        if (!configured() || !settings.friendsOpenData) return unavailable();
        if (disposed || typeof wxApi?.getOpenDataContext !== 'function') return empty('unsupported', '当前环境暂不支持好友排行榜');
        try {
          openData = wxApi.getOpenDataContext();
          if (!openData?.canvas || typeof openData.postMessage !== 'function') return empty('unsupported', '好友排行榜尚未接通');
          friendLevel = levelId; friendLayout = '';
          return { status: 'ready', entries: [], presentation: 'open-data' };
        } catch { return empty('error', '好友排行榜暂时无法加载'); }
      }
      return call({ action: 'list', ...(levelId ? { levelId } : {}) });
    },
    async submit(value) {
      if (!validLevel(value?.levelId) || !validScore(value?.score) || value.score % 10 !== 0 || !Number.isInteger(value?.stars) || value.stars < 1 || value.stars > 3) return empty('error', '成绩格式无效');
      // No caller-supplied user identifier is sent. The server uses getWXContext().OPENID.
      const result = await call({ action: 'submit', levelId: value.levelId, score: value.score, stars: value.stars });
      if (result.status === 'ready' && host === 'minigame' && settings.friendsOpenData && typeof wxApi?.setUserCloudStorage === 'function') {
        if (disposed) return empty('error', '排行榜已关闭');
        rememberFriendScore(value.levelId, result.bestScore ?? value.score, result.bestAchievedAt);
        const keys = [value.levelId];
        if (result.totalScore !== undefined) {
          rememberFriendScore('overall', result.totalScore, result.totalAchievedAt); keys.push('overall');
        }
        const written = await writeFriends(keys);
        if (disposed || written === 'skipped') return empty('error', '排行榜已关闭');
        if (written === 'failed') return { ...result, message: '分数已上传，好友榜稍后重试更新' };
      }
      return result;
    },
    drawFriends(context, rect) {
      if (disposed || !openData?.canvas || !(rect.w > 0 && rect.h > 0)) return;
      const width = Math.round(rect.w * 2), height = Math.round(rect.h * 2), key = `${friendLevel ?? 'overall'}:${width}:${height}`;
      if (friendLayout !== key) {
        friendLayout = key;
        try { openData.postMessage({ type: 'leaderboard:render', levelId: friendLevel ?? 'overall', width, height }); }
        catch { return; }
      }
      try { context.drawImage(openData.canvas, rect.x, rect.y, rect.w, rect.h); } catch { /* A not-yet-sized shared canvas renders on the next frame. */ }
    },
    hideFriends() { friendLayout = ''; openData = null; },
    dispose() {
      disposed = true; openData = null; friendLayout = '';
      // Already-started SDK writes cannot be cancelled. Queued writes must not
      // start after disposal; callers can stop waiting without releasing the SDK lock.
      for (const cancel of [...pendingWriteReports]) cancel();
    },
  };
}
