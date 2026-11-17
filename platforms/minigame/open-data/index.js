/* Friend scores remain inside WeChat's open-data domain. */
const canvas = wx.getSharedCanvas();
const context = canvas.getContext('2d');
let requestVersion = 0;
function text(value, x, y, size, color = '#e8f2ff', align = 'left') {
  context.font = `${size}px sans-serif`; context.fillStyle = color; context.textAlign = align; context.textBaseline = 'middle'; context.fillText(value, x, y);
}
function background(width, height) { context.clearRect(0, 0, width, height); context.fillStyle = '#1d3266'; context.fillRect(0, 0, width, height); }
wx.onMessage(message => {
  if (message?.type !== 'leaderboard:render' || !Number.isFinite(message.width) || !Number.isFinite(message.height)) return;
  const width = Math.min(1600, Math.max(100, Math.round(message.width))), height = Math.min(2000, Math.max(100, Math.round(message.height)));
  const key = message.levelId === 'overall' || /^level-(0[1-9]|[12]\d|30)$/.test(message.levelId) ? message.levelId : null;
  if (!key) return;
  const version = ++requestVersion;
  canvas.width = width; canvas.height = height; background(width, height);
  text('正在加载好友分数…', width / 2, 48, 23, '#b6ceef', 'center');
  wx.getFriendCloudStorage({
    keyList: [key],
    success(result) {
      if (version !== requestVersion) return;
      const rows = [];
      for (const user of result.data || []) {
        const stored = (user.KVDataList || []).find(item => item.key === key);
        if (!stored) continue;
        try {
          const value = JSON.parse(stored.value);
          if (!Number.isSafeInteger(value.score) || value.score < 0) continue;
          rows.push({ nickname: typeof user.nickname === 'string' && user.nickname.trim() ? user.nickname.slice(0, 12) : '微信好友', score: value.score,
            achievedAt: Number.isSafeInteger(value.achievedAt) && value.achievedAt > 0 ? value.achievedAt : Number.MAX_SAFE_INTEGER });
        } catch { /* Ignore records from incompatible versions. */ }
      }
      rows.sort((a, b) => b.score - a.score || a.achievedAt - b.achievedAt || a.nickname.localeCompare(b.nickname));
      background(width, height);
      if (!rows.length) { text('还没有好友分数', width / 2, 70, 24, '#b6ceef', 'center'); return; }
      const rowHeight = 64;
      rows.slice(0, Math.min(50, Math.floor(height / rowHeight))).forEach((row, index) => {
        const y = 32 + index * rowHeight;
        context.fillStyle = index % 2 ? '#243e75' : '#29457e'; context.fillRect(0, y - 27, width, 56);
        text(String(index + 1), 25, y, 22, '#ffda92');
        text(row.nickname, 70, y, 22);
        text(String(row.score), width - 20, y, 24, '#b3f4e0', 'right');
      });
    },
    fail() { if (version === requestVersion) { background(width, height); text('好友榜暂时无法加载', width / 2, 70, 24, '#b6ceef', 'center'); } },
  });
});
