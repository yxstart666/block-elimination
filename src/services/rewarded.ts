export type RewardPlacement = 'revive' | 'refresh' | 'rotate' | 'bomb' | 'bulldozer' | 'hint' | 'doubleCoins';
export type RewardResult = 'completed' | 'cancelled' | 'unavailable' | 'busy' | 'error';
export interface RewardedGateway {
  request(placement: RewardPlacement): Promise<RewardResult>;
  dispose(): void;
}

type Ad = {
  load(): Promise<unknown>;
  show(): Promise<unknown>;
  onClose(listener: (result?: { isEnded?: boolean }) => void): void;
  offClose(listener: (result?: { isEnded?: boolean }) => void): void;
  onError(listener: (error?: unknown) => void): void;
  offError(listener: (error?: unknown) => void): void;
};
type Attempt = {
  ad: Ad;
  stage: 'loading' | 'opening' | 'visible';
  close: (result?: { isEnded?: boolean }) => void;
  error: (error?: unknown) => void;
  resolve: (result: RewardResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
};
const LOAD_TIMEOUT_MS = 30_000;

/** Used by the browser preview and by hosts without an ad SDK. */
export function createUnavailableRewarded(): RewardedGateway {
  return { request: async () => 'unavailable', dispose() {} };
}

/**
 * This adapter reports completion; the caller owns the actual game reward.
 * Only an explicit `isEnded === true` close event qualifies. No ad ID means no
 * SDK calls, and a successful show/load alone never qualifies for a reward.
 */
export function createWechatRewarded(wxApi: any, unitIds: Record<RewardPlacement, string>): RewardedGateway {
  const ids = { ...unitIds };
  const ads = new Map<string, Ad>();
  let active: Attempt | null = null;
  let disposed = false;

  const clearTimer = (attempt: Attempt) => {
    if (attempt.timer !== null) clearTimeout(attempt.timer);
    attempt.timer = null;
  };
  const settle = (attempt: Attempt, result: RewardResult) => {
    // Each request has its own callback identity, including after instance reuse.
    if (active !== attempt) return;
    active = null;
    clearTimer(attempt);
    try { attempt.ad.offClose(attempt.close); } catch { /* Best effort on old hosts. */ }
    try { attempt.ad.offError(attempt.error); } catch { /* Do not replace the result. */ }
    attempt.resolve(result);
  };
  const armOperationTimeout = (attempt: Attempt) => {
    clearTimer(attempt);
    // Bound loading/opening failures, not the duration of an already visible ad.
    attempt.timer = setTimeout(() => settle(attempt, 'error'), LOAD_TIMEOUT_MS);
  };
  const load = async (attempt: Attempt) => {
    attempt.stage = 'loading';
    armOperationTimeout(attempt);
    await attempt.ad.load();
    if (active !== attempt) return false;
    clearTimer(attempt);
    return true;
  };
  const show = async (attempt: Attempt) => {
    attempt.stage = 'opening';
    armOperationTimeout(attempt);
    await attempt.ad.show();
    if (active !== attempt) return;
    clearTimer(attempt);
    attempt.stage = 'visible';
  };
  const start = async (attempt: Attempt) => {
    try {
      if (!await load(attempt)) return;
      try { await show(attempt); }
      catch {
        if (active !== attempt) return;
        // A cached creative can expire between load and show. Retry once.
        if (await load(attempt)) await show(attempt);
      }
    } catch { settle(attempt, 'error'); }
  };

  return {
    request(placement) {
      if (disposed) return Promise.resolve('unavailable');
      if (active) return Promise.resolve('busy');
      const adUnitId = ids[placement]?.trim();
      if (!adUnitId || typeof wxApi?.createRewardedVideoAd !== 'function') return Promise.resolve('unavailable');
      let ad = ads.get(adUnitId);
      if (!ad) {
        try {
          ad = wxApi.createRewardedVideoAd({ adUnitId });
          if (!ad || ['load', 'show', 'onClose', 'offClose', 'onError', 'offError'].some(name => typeof (ad as any)[name] !== 'function')) return Promise.resolve('unavailable');
          // Some SDKs return their same singleton for another configured unit.
          // Drop its old mapping so switching back calls create with that ID.
          for (const [id, cached] of ads) if (cached === ad) ads.delete(id);
          ads.set(adUnitId, ad!);
        } catch { return Promise.resolve('error'); }
      }
      return new Promise<RewardResult>(resolve => {
        const attempt: Attempt = {
          ad: ad!, stage: 'loading', timer: null, resolve,
          close: result => {
            if (active !== attempt || attempt.stage === 'loading') return;
            settle(attempt, result?.isEnded === true ? 'completed' : 'cancelled');
          },
          error: () => settle(attempt, 'error'),
        };
        active = attempt;
        try {
          ad!.onClose(attempt.close);
          ad!.onError(attempt.error);
          if (active === attempt) void start(attempt);
        } catch { settle(attempt, 'error'); }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (active) settle(active, 'cancelled');
      // The SDK owns a global/page singleton. Remove only our listeners, leaving
      // it available to another page/gateway instead of destroying shared state.
      ads.clear();
    },
  };
}
