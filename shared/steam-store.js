// Steam 商店查询：搜索、详情、发售日期、可选封面。只用 fetch，桌面版（Node）和网页版（浏览器）共用这一份代码。

export const steamStoreUrl = (appId) => `https://store.steampowered.com/app/${appId}/`;
export const steamHeaderImage = (appId) =>
  `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`;

// 商店接口有频率限制（约 200 次 / 5 分钟），串行排队并稍作间隔
let queue = Promise.resolve();
function throttled(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 350)));
  return run;
}

// 网页版不能直接访问 Steam（跨域），由它把请求换成走云函数代理
let transport = (url) => fetch(url, { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' } });
export function setSteamTransport(fn) {
  transport = fn;
}

async function fetchJson(url) {
  return throttled(async () => {
    const res = await transport(url);
    if (!res.ok) throw new Error(`Steam 请求失败 ${res.status}`);
    return res.json();
  });
}

const EXTRA_CONTENT = /soundtrack|原声|\bost\b|artbook|art book|设定集/i;

export async function searchStore(term, limit = 5, lang = 'schinese') {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=${lang}&cc=CN`;
  const data = await fetchJson(url);
  return (data.items || [])
    .filter((i) => i.type === 'app')
    // 原声带、美术集之类的附属内容一般不是想找的游戏
    .filter((i) => EXTRA_CONTENT.test(term) || !EXTRA_CONTENT.test(i.name))
    .slice(0, limit)
    .map((i) => ({ steamAppId: i.id, name: i.name, image: i.tiny_image }));
}

// 商店完整搜索（网页搜索框用的接口）：能搜中文名和常见中文叫法（狂热运输 → Transport Fever），
// storesearch 接口基本搜不到中文。返回里没有 AppID 字段，从图片地址里取。
export async function searchStoreFull(term, limit = 8) {
  const url = `https://store.steampowered.com/search/results/?term=${encodeURIComponent(term)}&l=schinese&cc=CN&json=1`;
  const data = await fetchJson(url);
  const out = [];
  for (const item of data.items || []) {
    const appId = Number(item.logo?.match(/\/apps\/(\d+)\//)?.[1]);
    if (!appId || out.some((x) => x.steamAppId === appId)) continue; // 捆绑包等没有 /apps/ 路径
    if (!EXTRA_CONTENT.test(term) && EXTRA_CONTENT.test(item.name)) continue;
    out.push({ steamAppId: appId, name: item.name, image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_231x87.jpg` });
    if (out.length >= limit) break;
  }
  return out;
}

// 解析 Steam 英文 release_date 文本：完整日期 → YYYY-MM-DD；否则保留原文（如 "Q2 2027"）
export function parseReleaseText(text) {
  if (!text) return { date: null, precision: null };
  const t = text.trim();
  const full = Date.parse(t.replace(/(\d+)(st|nd|rd|th)/, '$1'));
  if (!Number.isNaN(full) && /\b\d{1,2}\b/.test(t) && /\d{4}/.test(t) && /[a-z]{3}/i.test(t)) {
    const d = new Date(full);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { date: iso, precision: 'day' };
  }
  const monthYear = t.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (monthYear && !Number.isNaN(Date.parse(`1 ${monthYear[1]} ${monthYear[2]}`))) {
    const d = new Date(Date.parse(`1 ${monthYear[1]} ${monthYear[2]}`));
    return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, precision: 'month' };
  }
  const year = t.match(/^(\d{4})$/);
  if (year) return { date: year[1], precision: 'year' };
  return { date: null, precision: null };
}

// 获取商店详情：中文名、英文名、发售信息、封面、开发商、类型
export async function getAppDetails(appId) {
  const base = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=CN`;
  const [zh, en] = await Promise.all([fetchJson(`${base}&l=schinese`), fetchJson(`${base}&l=english`)]);
  const zhData = zh?.[appId]?.success ? zh[appId].data : null;
  const enData = en?.[appId]?.success ? en[appId].data : null;
  if (!zhData && !enData) return null;
  const d = zhData || enData;
  const enRelease = enData?.release_date || {};
  const parsed = parseReleaseText(enRelease.date);
  return {
    steamAppId: Number(appId),
    name: zhData?.name || enData?.name,
    nameEn: enData?.name || null,
    headerImage: d.header_image || steamHeaderImage(appId),
    developers: d.developers || [],
    publishers: d.publishers || [],
    genres: (d.genres || []).map((g) => g.description),
    shortDescription: zhData?.short_description || enData?.short_description || '',
    price: d.is_free ? '免费' : d.price_overview?.final_formatted || null,
    release: {
      comingSoon: Boolean(enRelease.coming_soon),
      date: parsed.date,
      precision: parsed.precision,
      text: zhData?.release_date?.date || enRelease.date || null,
      source: 'steam',
      checkedAt: new Date().toISOString(),
    },
  };
}

// 可选封面：Steam 上这款游戏的各种官方图片 + 商店截图。
// 新游戏的部分素材路径带哈希，固定路径可能 404，前端加载失败会自动隐藏。
export async function getCoverCandidates(appId) {
  const base = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}`;
  const list = [
    { label: '默认横幅', url: `${base}/header.jpg` },
    { label: '宽版胶囊图', url: `${base}/capsule_616x353.jpg` },
    { label: '主视觉大图', url: `${base}/library_hero.jpg` },
    { label: '竖版海报', url: `${base}/library_600x900_2x.jpg` },
    { label: '商店背景', url: `${base}/page_bg_raw.jpg` },
  ];
  try {
    const data = await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=CN&l=schinese`);
    const d = data?.[appId]?.success ? data[appId].data : null;
    if (d?.header_image) list[0].url = d.header_image;
    for (const [i, s] of (d?.screenshots || []).slice(0, 16).entries()) {
      list.push({ label: `游戏截图 ${i + 1}`, url: s.path_full, thumb: s.path_thumbnail });
    }
  } catch (err) {
    console.warn('[steam] 获取截图失败', err.message);
  }
  return list.map((c) => ({ ...c, thumb: c.thumb || c.url }));
}
