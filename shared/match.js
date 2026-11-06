// 游戏名比较与 Steam 匹配：桌面版和网页版共用。只依赖 shared/steam-store.js，没有 Node 专用的东西。
import * as steam from './steam-store.js';

// 名称归一化：用于判断"是不是同一款游戏"
export function normName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/\b(the|edition|remastered|definitive|goty|game of the year|deluxe|complete|ultimate)\b/g, '')
    .replace(/[^a-z0-9぀-ヿ一-鿿]/g, '');
}

export function sameName(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  // 只容许很小的差异，避免 Eternum 匹配到 Eternum EX 这种不同的游戏
  return long.startsWith(short) && short.length / long.length >= 0.9;
}

export const hasCJK = (s) => /[぀-ヿ㐀-鿿]/.test(s || '');
// 中文名：有汉字、没有假名（有假名的是日文名，不当作中文名）
export const isChinese = (s) => /[㐀-鿿]/.test(s || '') && !/[぀-ヿ]/.test(s || '');

// Steam 的中文名常写成「英文名 + 中文名」（Cities: Skylines II 都市：天际线2、Wallpaper Engine：壁纸引擎），拆出中文部分
export function chinesePart(name, nameEn) {
  if (!isChinese(name)) return null;
  if (nameEn && name.startsWith(nameEn)) {
    const rest = name.slice(nameEn.length).replace(/^[\s:：\-–—|·]+/, '').trim();
    if (isChinese(rest)) return rest;
  }
  return name;
}

// 在 Steam 上找最匹配的条目：英文搜索 + 中文搜索（商店完整搜索），名字吻合的排前面
export async function matchOnSteam(name, nameEn, hints = []) {
  const primary = [...new Set([nameEn, name].filter(Boolean))];
  const extra = hints.filter((h) => !primary.some((p) => p.toLowerCase() === h.toLowerCase()));
  const terms = [...primary, ...extra];
  const seen = new Map();
  let fullRank = 0;
  const add = (r, source) => {
    const prev = seen.get(r.steamAppId) || { ...r, names: [], sources: new Set(), rank: Infinity };
    if (source === 'full') prev.rank = Math.min(prev.rank, fullRank++); // 商店完整搜索的相关度排序
    prev.names.push(r.name);
    prev.sources.add(source);
    seen.set(r.steamAppId, prev);
  };
  for (const term of terms) {
    try {
      // 线索一般是英文/原名，只用英文搜索，减少请求
      for (const lang of primary.includes(term) ? ['english', 'schinese'] : ['english']) {
        for (const r of await steam.searchStore(term, 5, lang)) add(r, 'api');
      }
      // 中文名用商店完整搜索（storesearch 基本搜不到中文）
      if (hasCJK(term)) for (const r of await steam.searchStoreFull(term, 8)) add(r, 'full');
    } catch (err) {
      console.warn('[steam] 搜索失败', term, err.message);
    }
  }
  // 名字对得上的排前面；完整搜索里混着的推广游戏排后面
  const norm = (x) => normName(x);
  const score = (c) => {
    if (c.names.some((n) => terms.some((t) => sameName(n, t)))) return 3;
    if (c.names.some((n) => terms.some((t) => norm(t) && (norm(n).includes(norm(t)) || norm(t).includes(norm(n)))))) return 2;
    return c.sources.has('api') ? 1 : 0;
  };
  // 试玩版排在正式版后面（除非搜的就是 demo）
  const isDemo = (c) => !terms.some((t) => /\bdemo\b|试玩/i.test(t)) && c.names.some((n) => /\bdemo\b|试玩/i.test(n));
  const candidates = [...seen.values()]
    .map((c, i) => ({ c, i, s: score(c), d: isDemo(c) ? 1 : 0 }))
    .sort((x, y) => y.s - x.s || x.d - y.d || x.c.rank - y.c.rank || x.i - y.i)
    .map(({ c, s }) => ({ steamAppId: c.steamAppId, name: c.name, image: c.image, names: c.names, score: s }));
  const best = candidates.find((c) => c.score === 3);
  return { best: best || null, candidates: candidates.slice(0, 8) };
}
