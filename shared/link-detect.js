// 贴进来的网盘链接是什么游戏：猜名字 → 在 Steam 上匹配 → 看库里是不是已经有了。结果交给页面确认，这里不改任何数据。
import { sameName, matchOnSteam } from './match.js';
import { guessShareName, linkKey } from './share-links.js';

const brief = (g) => ({ id: g.id, name: g.nameZh || g.name, status: g.status });

const inLibrary = (games, { steamAppId, names }) =>
  games.find((g) => (steamAppId && g.steamAppId === steamAppId) || names.filter(Boolean).some((n) => [g.name, g.nameZh, g.nameEn].some((m) => sameName(m, n))));

const withOwners = (games, candidates) =>
  candidates.map((c) => {
    const game = games.find((g) => g.steamAppId === c.steamAppId);
    return { steamAppId: c.steamAppId, name: c.name, image: c.image, score: c.score, existing: game ? brief(game) : null };
  });

/**
 * @param shares 转存队列读出来的分享（token、title、files、context、key）
 * @param games  库里的游戏
 * @param names  (items) => suggestNames 的回答；没配 API Key 时不给，只靠规则清理名字
 * @param match  Steam 匹配，测试时换成假的
 */
export async function detectShares({ shares, games, names = null, match = matchOnSteam }) {
  const guessed = shares.map((s) => (s.error ? '' : guessShareName(s)));
  const asked = guessed.map((name, i) => ({ id: String(i), name, nameEn: null })).filter((x) => x.name);
  const answers = new Map();
  if (names && asked.length) {
    // 补不出中英文名不影响检测，只是 Steam 上匹配得差一点
    const named = await names(asked).catch((err) => {
      console.warn('[links] 补全游戏名失败', err.message);
      return [];
    });
    for (const a of named) answers.set(a.id, a);
  }
  return Promise.all(shares.map(async (share, i) => {
    if (share.error) return share;
    const name = guessed[i];
    const a = answers.get(String(i));
    const owner = games.find((g) => (g.links || []).some((l) => linkKey(l) === share.key));
    const steam = name ? await match(a?.zh || name, a?.en || null, [name]).catch(() => null) : null;
    const best = steam?.best?.steamAppId || null;
    const found = owner || inLibrary(games, { steamAppId: best, names: [name, a?.zh, a?.en] });
    return {
      ...share,
      detect: {
        name: a?.zh || name,
        nameEn: a?.en || null,
        already: Boolean(owner), // 这条链接已经记在这款游戏上了
        existing: found ? brief(found) : null,
        best,
        candidates: withOwners(games, steam?.candidates || []),
      },
    };
  }));
}

// 确认时手动搜：库里的（不在 Steam 上的也算）和 Steam 上的
export async function searchTargets({ q, games, search }) {
  const key = q.trim().toLowerCase();
  const existing = games.filter((g) => [g.name, g.nameZh, g.nameEn].some((n) => n && (n.toLowerCase().includes(key) || sameName(n, q)))).slice(0, 8).map(brief);
  return { existing, candidates: withOwners(games, await search(q).catch(() => [])) };
}
