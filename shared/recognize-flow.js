// 截图收藏的完整流程（桌面版、网页版共用）：
// Claude 认出截图里的游戏 → 在 Steam 上匹配 → 补全封面 / 发售日期（Steam 没有的再联网查）→ 标出库里已经有的。
import * as steam from './steam-store.js';
import { sameName, matchOnSteam } from './match.js';

/**
 * @param ai          shared/ai.js 的 createAI() 返回值
 * @param images      [{ mediaType, base64 }]
 * @param findExisting (predicate) => 库里已有的游戏
 */
export async function recognizeAndMatch({ ai, images, findExisting }) {
  const found = await ai.recognizeScreenshots(images);
  const results = [];
  for (const g of found) {
    let details = null;
    let candidates = [];
    if (g.steamAppId) {
      details = await steam.getAppDetails(g.steamAppId).catch(() => null);
      // 模型给的 AppID 与名字对不上时，不信任它
      if (details && !sameName(details.nameEn, g.nameEn) && !sameName(details.name, g.name)) details = null;
    }
    if (!details) {
      const match = await matchOnSteam(g.name, g.nameEn);
      candidates = match.candidates;
      if (match.best) details = await steam.getAppDetails(match.best.steamAppId).catch(() => null);
    }
    let release = details?.release || null;
    if (!release) {
      release = await ai.lookupReleaseOnWeb(g.name, g.nameEn).catch((err) => {
        console.warn('[recognize] 联网查询发售日期失败', err.message);
        return g.releaseHint
          ? { text: g.releaseHint, comingSoon: /即将|coming|待定|tba/i.test(g.releaseHint), date: null, source: 'screenshot', checkedAt: new Date().toISOString() }
          : null;
      });
      // 联网查到了 Steam 页面（Steam 搜索没命中的情况），用商店数据补全
      if (release?.steamAppId) {
        details = await steam.getAppDetails(release.steamAppId).catch(() => null);
        if (details) release = details.release;
      }
    }
    const existing = findExisting((x) => (details && x.steamAppId === details.steamAppId) || sameName(x.name, g.name) || (g.nameEn && sameName(x.nameEn, g.nameEn)));
    results.push({
      ai: g,
      name: details?.name || g.name,
      nameEn: details?.nameEn || g.nameEn,
      steamAppId: details?.steamAppId || null,
      headerImage: details?.headerImage || null,
      developers: details?.developers || [],
      genres: details?.genres || [],
      price: details?.price || null,
      description: details?.shortDescription || '',
      officialUrl: release?.officialUrl || null,
      release,
      candidates,
      existing: existing ? { id: existing.id, name: existing.name, status: existing.status } : null,
    });
  }
  return results;
}

// 手动搜索 Steam：中文俗称 / 简称搜不到名字对得上的（荒野大镖客、都市天际线），让 Claude 转成英文正式名再搜
export async function searchSteamSmart(q, ai) {
  let { candidates } = await matchOnSteam(q, q);
  const hasCJK = /[぀-ヿ㐀-鿿]/.test(q);
  if (hasCJK && !candidates.some((c) => c.score >= 2) && ai) {
    try {
      const titles = await ai.englishTitlesFor(q);
      if (titles.length) {
        const more = await matchOnSteam(titles[0], titles[0], titles.slice(1));
        const seen = new Set(more.candidates.map((c) => c.steamAppId));
        candidates = [...more.candidates.filter((c) => c.score >= 2), ...candidates.filter((c) => !seen.has(c.steamAppId)), ...more.candidates.filter((c) => c.score < 2)];
      }
    } catch (err) {
      console.warn('[search] 中文名转换失败', err.message);
    }
  }
  return candidates.slice(0, 8);
}
