// 网页版适配层：界面和桌面版是同一份（public/app.js），它发给「本地服务」的 /api 请求在这里改成：
//   数据 → 直接读写 Supabase（同一套数据库权限：只能访问自己的数据）
//   Steam 查询 → 经云函数 steam-proxy 转发（Steam 不允许网页跨域访问）
//   截图识别等 AI → 云函数 steamless-ai（用账号里的 API Key 在服务器端调用 Claude，浏览器里没有 Key）
//   收藏截图 / 自选封面 → 私有存储的临时签名链接
// 启动游戏、添加本地文件夹这类必须在电脑上做的操作，网页版会提示去电脑上的 Steamless 里操作。
import config from './config.js';

window.STEAMLESS_WEB = true;
document.documentElement.classList.add('web');

const SB_URL = config.supabaseUrl;
const SB_KEY = config.supabaseKey;
const BUCKET = 'media';
const realFetch = window.fetch.bind(window);

// ---------- 依赖（CDN 上的 ES 模块，版本固定） ----------

const libsPromise = (async () => {
  const [{ createClient }, steam, match, aiMod, flow] = await Promise.all([
    import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm'),
    import('./shared/steam-store.js'),
    import('./shared/match.js'),
    import('./shared/ai.js'),
    import('./shared/recognize-flow.js'),
  ]);
  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  steam.setSteamTransport(async (url) => {
    const { data } = await sb.auth.getSession();
    return realFetch(`${SB_URL}/functions/v1/steam-proxy?url=${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${data.session?.access_token || SB_KEY}`, apikey: SB_KEY },
    });
  });
  return { sb, steam, match, aiMod, flow };
})();

// ---------- 小工具 ----------

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const desktopOnly = (what) => fail(`网页版不能${what}，请在电脑上的 Steamless 里操作`);
const nowIso = () => new Date().toISOString();
const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

const AUTH_MESSAGES = [
  [/invalid login credentials/i, '邮箱或密码不正确'],
  [/email not confirmed/i, '邮箱还没有验证，请先点击注册邮件里的确认链接'],
  [/user already registered/i, '这个邮箱已经注册过了，请直接登录'],
  [/password should be at least/i, '密码至少需要 6 位'],
  [/unable to validate email|invalid email/i, '邮箱格式不正确'],
  [/rate limit|too many/i, '操作太频繁，请稍后再试'],
  [/signups not allowed/i, '暂不开放注册，请联系管理员'],
  [/should be different from the old password|same_password/i, '新密码不能和当前密码相同'],
  [/already been registered|already registered by another|email_exists/i, '这个邮箱已经被其他账号使用了'],
  [/failed to fetch|network/i, '无法连接到云端，请检查网络'],
];
const authError = (err) => fail(AUTH_MESSAGES.find(([re]) => re.test(err?.message || ''))?.[1] || err?.message || String(err));
const check = ({ data, error }) => {
  if (error) throw fail(`云端操作失败：${error.message}`, 502);
  return data;
};

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// ---------- 数据（和桌面版同样的结构；网页版不是一台电脑，所有安装记录都算「其他电脑」） ----------

const cache = { user: null, rows: [], installs: [], devices: [], games: [], hasKey: false, loadedAt: 0 };

function buildGames() {
  const names = new Map(cache.devices.map((d) => [d.device_id, d.name]));
  const byGame = new Map();
  for (const i of cache.installs) {
    const list = byGame.get(i.game_id) || [];
    const played = [i.data?.lastPlayed, i.data?.lastLaunched].filter(Boolean).sort().pop() || null;
    list.push({ deviceId: i.device_id, deviceName: names.get(i.device_id) || '其他电脑', installPath: i.data?.installPath || null, missing: Boolean(i.data?.missing), lastPlayed: played, deleteRequestedAt: i.data?.deleteRequestedAt || null, deleteError: i.data?.deleteError || null });
    byGame.set(i.game_id, list);
  }
  cache.games = cache.rows.map((r) => ({ ...r.data, id: r.id, otherDevices: byGame.get(r.id) || [] }));
}

async function loadAll() {
  const { sb } = await libsPromise;
  const uid = cache.user.id;
  const [games, installs, devices, keyStatus] = await Promise.all([
    sb.from('games').select('id, data').eq('user_id', uid),
    sb.from('installs').select('device_id, game_id, data').eq('user_id', uid),
    sb.from('devices').select('device_id, name, settings, updated_at').eq('user_id', uid),
    sb.rpc('anthropic_key_status'),
  ]);
  cache.rows = check(games);
  cache.installs = check(installs);
  cache.devices = check(devices);
  cache.hasKey = !keyStatus.error && Boolean(keyStatus.data);
  cache.loadedAt = Date.now();
  buildGames();
  await signMedia();
}

const gameById = (id) => cache.games.find((g) => g.id === id) || (() => { throw fail('找不到这个游戏', 404); })();

async function saveGame(id, patch) {
  const { sb } = await libsPromise;
  const row = cache.rows.find((r) => r.id === id);
  if (!row) throw fail('找不到这个游戏', 404);
  // 特别想要只属于愿望单：下载 / 安装后（状态离开 wishlist）自动移出
  if ('status' in patch && patch.status !== 'wishlist' && row.data.mustHaveAt) patch = { ...patch, mustHaveAt: null };
  const userChanged = Object.keys(patch).length > 0;
  row.data = { ...row.data, ...patch, ...(userChanged ? { updatedAt: nowIso() } : {}) };
  check(await sb.from('games').upsert({ id, user_id: cache.user.id, data: row.data, updated_at: nowIso() }));
  buildGames();
  await signMedia();
  return gameById(id);
}

async function insertGame(data) {
  const { sb } = await libsPromise;
  const id = crypto.randomUUID();
  const row = {
    id,
    data: { name: '', status: 'wishlist', source: 'manual', steamAppId: null, favoritedAt: null, installedAt: null, release: null, tags: [], notes: '', screenshots: [], createdAt: nowIso(), updatedAt: nowIso(), ...data },
  };
  check(await sb.from('games').insert({ id, user_id: cache.user.id, data: row.data, updated_at: nowIso() }));
  cache.rows.push(row);
  buildGames();
  await signMedia();
  return gameById(id);
}

// ---------- 图片：私有存储 → 临时签名链接 ----------

const signed = new Map();
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
window.steamlessMediaUrl = (u) => (/^\/(covers|screenshots)\//.test(u) ? signed.get(u) || BLANK : u);

async function signMedia() {
  const { sb } = await libsPromise;
  const wanted = new Set();
  for (const g of cache.games) {
    if (g.coverImage?.startsWith('/covers/')) wanted.add(g.coverImage);
    for (const s of g.screenshots || []) wanted.add(`/screenshots/${s}`);
  }
  const missing = [...wanted].filter((u) => !signed.has(u));
  if (!missing.length) return;
  const paths = missing.map((u) => `${cache.user.id}${u}`);
  const { data } = await sb.storage.from(BUCKET).createSignedUrls(paths, 60 * 60 * 6);
  (data || []).forEach((d, i) => d?.signedUrl && signed.set(missing[i], d.signedUrl));
}

async function uploadMedia(kind, file) {
  const { sb } = await libsPromise;
  const name = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}${IMAGE_EXT[file.type] || '.png'}`;
  const { error } = await sb.storage.from(BUCKET).upload(`${cache.user.id}/${kind}/${name}`, file, { contentType: file.type, upsert: true });
  if (error) throw fail(`图片上传失败：${error.message}`, 502);
  return name;
}

async function removeMedia(items) {
  if (!items.length) return;
  const { sb } = await libsPromise;
  await sb.storage.from(BUCKET).remove(items.map(([kind, name]) => `${cache.user.id}/${kind}/${name}`));
}

// ---------- Claude：云函数 steamless-ai（服务器端用账号里的 Key 调用，浏览器拿不到 Key） ----------

async function invokeAI(op, args) {
  const { sb } = await libsPromise;
  const { data, error } = await sb.functions.invoke('steamless-ai', { body: { op, ...args } });
  if (error) {
    let message = error.message;
    try {
      const body = await error.context?.json?.();
      if (body?.error) message = body.error;
    } catch {
      // 不是 JSON 响应
    }
    if (/Failed to send a request/i.test(message)) message = '无法连接到识别服务，请检查网络';
    throw fail(message, error.context?.status || 502);
  }
  return data.result;
}

const cloudAI = {
  recognizeScreenshots: (images) => invokeAI('recognize', { images }),
  lookupReleaseOnWeb: (name, nameEn) => invokeAI('release', { name, nameEn }),
  suggestNames: (items) => invokeAI('names', { items }),
  englishTitlesFor: (query) => invokeAI('titles', { query }),
};

async function getAI(required = true) {
  if (!cache.hasKey) {
    if (required) throw fail('还没有配置 API Key：点右上角 ⚙ 设置，在「截图识别」里填写');
    return null;
  }
  return cloudAI;
}

// ---------- 补全游戏信息（Steam / 联网） ----------

function detailsPatch(game, d) {
  const patch = {
    steamAppId: d.steamAppId,
    nameEn: d.nameEn,
    headerImage: d.headerImage,
    developers: d.developers,
    publishers: d.publishers,
    genres: d.genres,
    description: d.shortDescription,
    price: d.price,
    release: d.release,
  };
  if (!game.nameLocked && d.name) patch.name = d.name;
  return patch;
}

async function enrich(game, { allowWeb = true } = {}) {
  const { steam, match } = await libsPromise;
  let appId = game.steamAppId;
  if (!appId) appId = (await match.matchOnSteam(game.name, game.nameEn, game.nameHints || [])).best?.steamAppId;
  if (appId) {
    const d = await steam.getAppDetails(appId);
    if (d) return saveGame(game.id, detailsPatch(game, d));
  }
  if (allowWeb) return webRelease(game);
  return game;
}

async function webRelease(game) {
  const { steam } = await libsPromise;
  const ai = await getAI();
  const release = await ai.lookupReleaseOnWeb(game.name, game.nameEn);
  if (release.steamAppId && !game.steamAppId) {
    const d = await steam.getAppDetails(release.steamAppId).catch(() => null);
    if (d) return saveGame(game.id, detailsPatch(game, d));
  }
  return saveGame(game.id, { release, officialUrl: release.officialUrl || game.officialUrl || null });
}

// ---------- 路由 ----------

const EDITABLE = ['name', 'nameZh', 'nameEn', 'status', 'favoritedAt', 'installedAt', 'downloadedAt', 'notes', 'tags', 'rating', 'officialUrl', 'release', 'coverImage', 'coverHidden', 'coverBlur', 'verdict', 'mustHave'];
const isAllowedCover = (u) => u === null || /^https:\/\/[a-z0-9.-]+\.steamstatic\.com\//.test(u) || /^\/(covers|screenshots)\/[\w.-]+$/.test(u);

const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

on('GET', '/api/auth/session', async () => {
  const { sb } = await libsPromise;
  const { data } = await sb.auth.getSession();
  cache.user = data.session?.user || null;
  return { user: cache.user ? { id: cache.user.id, email: cache.user.email } : null, legacy: null };
});
// 「记住我」：邮箱和密码存在这个浏览器的 localStorage 里（只在本机，不会上传）
const REMEMBER_KEY = 'steamless.remember';
const rememberStore = {
  load() {
    try {
      const r = JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null');
      return r?.email && r?.password ? r : null;
    } catch {
      return null;
    }
  },
  save(email, password) {
    try { localStorage.setItem(REMEMBER_KEY, JSON.stringify({ email, password })); } catch { /* 隐私模式等拿不到存储，忽略 */ }
  },
  clear() {
    try { localStorage.removeItem(REMEMBER_KEY); } catch { /* 同上 */ }
  },
};

on('GET', '/api/auth/remembered', async () => ({ remembered: rememberStore.load() }));
on('POST', '/api/auth/signin', async ({ body }) => {
  const { sb } = await libsPromise;
  const { data, error } = await sb.auth.signInWithPassword({ email: body.email, password: body.password });
  if (error) throw authError(error);
  if (body.remember) rememberStore.save(body.email, body.password);
  else rememberStore.clear();
  cache.user = data.user;
  return { user: { id: data.user.id, email: data.user.email }, legacy: null };
});
on('POST', '/api/auth/signup', async ({ body }) => {
  const { sb } = await libsPromise;
  const { data, error } = await sb.auth.signUp({ email: body.email, password: body.password });
  if (error) throw authError(error);
  if (data.user && Array.isArray(data.user.identities) && !data.user.identities.length) throw authError({ message: 'User already registered' });
  if (!data.session) return { needsConfirmation: true };
  cache.user = data.user;
  return { user: { id: data.user.id, email: data.user.email }, legacy: null };
});
on('POST', '/api/auth/signout', async () => {
  const { sb } = await libsPromise;
  await sb.auth.signOut({ scope: 'local' });
  cache.user = null;
  return { ok: true };
});
on('POST', '/api/auth/account', async ({ body }) => {
  const { sb } = await libsPromise;
  if (!body.currentPassword) throw fail('请输入当前密码');
  if (body.newPassword && body.newPassword.length < 6) throw fail('新密码至少需要 6 位');
  const { error: verifyError } = await sb.auth.signInWithPassword({ email: cache.user.email, password: body.currentPassword });
  if (verifyError) throw /invalid login credentials/i.test(verifyError.message) ? fail('当前密码不正确') : authError(verifyError);
  const changes = {};
  if (body.newPassword) changes.password = body.newPassword;
  if (body.newEmail && body.newEmail.toLowerCase() !== cache.user.email.toLowerCase()) changes.email = body.newEmail;
  if (!Object.keys(changes).length) throw fail('没有需要修改的内容');
  const { data, error } = await sb.auth.updateUser(changes);
  if (error) throw authError(error);
  const pendingEmail = changes.email && data.user?.email?.toLowerCase() !== changes.email.toLowerCase() ? changes.email : null;
  cache.user = data.user;
  if (rememberStore.load()) rememberStore.save(data.user.email, body.newPassword || body.currentPassword);
  return { user: { id: data.user.id, email: data.user.email }, passwordChanged: Boolean(changes.password), emailChanged: Boolean(changes.email) && !pendingEmail, pendingEmail };
});

on('GET', '/api/state', async () => {
  await loadAll();
  return {
    user: { id: cache.user.id, email: cache.user.email },
    sync: { pending: 0, lastSync: nowIso(), error: null, deviceName: '网页版' },
    settings: { steamLibraries: [], localFolders: [], ignoredPaths: [], autoScanOnStart: false },
    games: cache.games,
    ai: cache.hasKey,
    aiModel: (await libsPromise).aiMod.DEFAULT_MODEL,
    enriching: 0,
  };
});

on('GET', '/api/app/update', async () => ({ version: config.version, mode: 'web' }));
on('GET', '/api/folder-suggestions', async () => []);
on('POST', '/api/legacy-import', async () => ({ count: 0 }));

on('PUT', '/api/settings/api-key', async ({ body }) => {
  const { sb } = await libsPromise;
  const key = String(body.apiKey || '').trim();
  if (key && !/^sk-ant-[\w-]{20,}$/.test(key)) throw fail('API Key 格式不对，应该以 sk-ant- 开头');
  const { error } = await sb.rpc('set_anthropic_key', { p_key: key || null });
  if (error) throw fail(/格式不对/.test(error.message) ? 'API Key 格式不对，应该以 sk-ant- 开头' : `保存 API Key 失败：${error.message}`);
  cache.hasKey = Boolean(key);
  return { ai: cache.hasKey };
});
on('PUT', '/api/settings', async () => {
  throw desktopOnly('添加本地文件夹');
});

// 游戏
on('POST', '/api/games', async ({ body }) => {
  if (!body.name?.trim()) throw fail('请填写游戏名');
  const status = ['installed', 'downloaded'].includes(body.status) ? body.status : 'wishlist';
  const game = await insertGame({
    name: body.name.trim(),
    nameEn: body.nameEn?.trim() || null,
    status,
    steamAppId: Number(body.steamAppId) || null,
    favoritedAt: body.favoritedAt || (status === 'wishlist' ? nowIso() : null),
    notes: body.notes || '',
  });
  enrich(game, { allowWeb: cache.hasKey }).catch((err) => console.warn('[enrich]', err.message));
  return game;
});
on('PATCH', '/api/games/([\\w-]+)', async ({ m, body }) => {
  const game = gameById(m[1]);
  const patch = {};
  for (const k of EDITABLE) if (k in body) patch[k] = body[k];
  if ('name' in patch) patch.nameLocked = true;
  if ('nameZh' in patch || 'nameEn' in patch) {
    for (const k of ['nameZh', 'nameEn']) if (k in patch) patch[k] = String(patch[k] ?? '').trim() || null;
    patch.namesCheckedAt = nowIso();
  }
  if ('verdict' in patch) {
    if (patch.verdict !== null && !['great', 'ok', 'waste'].includes(patch.verdict)) throw fail('品鉴只能是 好玩 / 尚可 / 浪费时间');
    patch.verdictAt = patch.verdict ? nowIso() : null;
  }
  if ('mustHave' in patch) {
    if (patch.mustHave && (patch.status || game.status) !== 'wishlist') throw fail('只有已收藏（愿望单）里的游戏才能加入特别想要');
    patch.mustHaveAt = patch.mustHave ? game.mustHaveAt || nowIso() : null;
    delete patch.mustHave;
  }
  if ('coverImage' in patch) {
    if (!isAllowedCover(patch.coverImage)) throw fail('不支持的封面地址');
    if (patch.coverImage !== game.coverImage && game.coverImage?.startsWith('/covers/')) removeMedia([['covers', game.coverImage.slice(8)]]);
  }
  if (patch.status === 'installed' && game.status !== 'installed' && !game.installedAt && !patch.installedAt) patch.installedAt = nowIso();
  if (patch.status === 'downloaded' && game.status !== 'downloaded' && !game.downloadedAt && !patch.downloadedAt) patch.downloadedAt = nowIso();
  return saveGame(game.id, patch);
});
on('DELETE', '/api/games/([\\w-]+)', async ({ m }) => {
  const { sb } = await libsPromise;
  const game = gameById(m[1]);
  check(await sb.from('games').delete().eq('id', game.id));
  cache.rows = cache.rows.filter((r) => r.id !== game.id);
  buildGames();
  removeMedia([...(game.coverImage?.startsWith('/covers/') ? [['covers', game.coverImage.slice(8)]] : []), ...(game.screenshots || []).map((s) => ['screenshots', s])]);
  return { ok: true };
});
on('POST', '/api/games/([\\w-]+)/refresh', async ({ m }) => enrich(gameById(m[1]), { allowWeb: cache.hasKey }));
on('POST', '/api/games/([\\w-]+)/web-release', async ({ m }) => webRelease(gameById(m[1])));
on('POST', '/api/games/([\\w-]+)/link-steam', async ({ m, body }) => {
  const appId = Number(body.steamAppId) || null;
  const game = await saveGame(m[1], { steamAppId: appId, nameLocked: false });
  return appId ? enrich(game, { allowWeb: false }) : game;
});
on('GET', '/api/games/([\\w-]+)/covers', async ({ m }) => {
  const { steam } = await libsPromise;
  const game = gameById(m[1]);
  const list = game.steamAppId ? await steam.getCoverCandidates(game.steamAppId) : [];
  await signMedia();
  for (const [i, s] of (game.screenshots || []).entries()) {
    const u = `/screenshots/${s}`;
    list.push({ label: `收藏截图 ${i + 1}`, url: u, thumb: window.steamlessMediaUrl(u) });
  }
  return list;
});
on('POST', '/api/games/([\\w-]+)/cover-upload', async ({ m, body }) => {
  const file = body instanceof FormData ? body.get('image') : null;
  if (!file || !IMAGE_EXT[file.type]) throw fail('请选择 PNG / JPG / WebP 图片');
  const game = gameById(m[1]);
  const name = await uploadMedia('covers', file);
  if (game.coverImage?.startsWith('/covers/')) removeMedia([['covers', game.coverImage.slice(8)]]);
  return saveGame(game.id, { coverImage: `/covers/${name}`, coverHidden: false });
});
for (const [path, what] of [
  ['/api/games/[\\w-]+/launch', '启动游戏'],
  ['/api/games/[\\w-]+/open-folder', '打开电脑上的文件夹'],
  ['/api/games/[\\w-]+/open-store', '打开商店页'],
  ['/api/games/[\\w-]+/pick-exe', '选择启动程序'],
  ['/api/games/[\\w-]+/exes', '选择启动程序'],
  ['/api/pick-folder', '选择本地文件夹'],
  ['/api/steam/detect', '检测本机 Steam'],
  ['/api/import', '从备份恢复'],
  ['/api/extract/[\\w/]+', '解压压缩包'],
]) {
  on('GET', path, async () => { throw desktopOnly(what); });
  on('POST', path, async () => { throw desktopOnly(what); });
}

// Steam 搜索 / 截图收藏
on('GET', '/api/steam/search', async ({ url }) => {
  const { flow } = await libsPromise;
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return [];
  return flow.searchSteamSmart(q, await getAI(false));
});
on('POST', '/api/recognize', async ({ body }) => {
  const { flow } = await libsPromise;
  const files = (body instanceof FormData ? body.getAll('images') : []).filter((f) => IMAGE_EXT[f.type]);
  if (!files.length) throw fail('请上传 PNG / JPG / WebP 截图');
  const ai = await getAI();
  const images = await Promise.all(files.map(async (f) => ({ mediaType: f.type, base64: await fileToBase64(f) })));
  const results = await flow.recognizeAndMatch({ ai, images, findExisting: (pred) => cache.games.find(pred) });
  const screenshots = await Promise.all(files.map((f) => uploadMedia('screenshots', f)));
  return { screenshots, results };
});
on('POST', '/api/wishlist', async ({ body }) => {
  const { match } = await libsPromise;
  const items = Array.isArray(body.items) ? body.items : [];
  const screenshots = (body.screenshots || []).map(String);
  const added = [];
  for (const item of items) {
    if (!item.name) continue;
    const existing = item.existingId && cache.games.find((g) => g.id === item.existingId);
    if (existing) {
      added.push(await saveGame(existing.id, { screenshots: [...new Set([...(existing.screenshots || []), ...screenshots])] }));
      continue;
    }
    const zh = match.chinesePart(item.name, item.nameEn) || (match.isChinese(item.ai?.name) ? item.ai.name : null);
    added.push(
      await insertGame({
        name: item.name,
        nameZh: zh,
        nameEn: item.nameEn || null,
        status: 'wishlist',
        source: item.steamAppId ? 'steam' : 'manual',
        steamAppId: Number(item.steamAppId) || null,
        favoritedAt: item.favoritedAt || nowIso(),
        headerImage: item.headerImage || null,
        developers: item.developers || [],
        genres: item.genres || [],
        price: item.price || null,
        description: item.description || '',
        officialUrl: item.officialUrl || null,
        release: item.release || null,
        screenshots,
        notes: item.notes || '',
      }),
    );
  }
  return { added };
});
on('POST', '/api/refresh-releases', async () => {
  const { steam } = await libsPromise;
  const targets = cache.games.filter((g) => g.status === 'wishlist' && g.steamAppId);
  const nowReleased = [];
  for (const g of targets) {
    const d = await steam.getAppDetails(g.steamAppId).catch(() => null);
    if (!d) continue;
    if (g.release?.comingSoon && !d.release.comingSoon) nowReleased.push(g.nameZh || g.name);
    await saveGame(g.id, { release: d.release, price: d.price });
  }
  return { checked: targets.length, nowReleased };
});

// 电脑与文件夹
const listDevices = () =>
  cache.devices.map((d) => ({
    deviceId: d.device_id,
    name: d.name || '未命名电脑',
    isThis: false,
    lastSeen: d.updated_at,
    settings: { steamLibraries: [], localFolders: [], ignoredPaths: [], ...d.settings },
  }));
on('GET', '/api/devices', async () => listDevices());
on('POST', '/api/devices/unlink', async ({ body }) => {
  const { sb } = await libsPromise;
  const { data, error } = await sb.rpc('unlink_folder', { p_device: body.deviceId, p_folder: body.folder, p_kind: body.kind === 'steam' ? 'steam' : 'local' });
  if (error) throw fail(`移除文件夹失败：${error.message}`, 502);
  await loadAll();
  return { removed: data, devices: listDevices() };
});
// 请求某台电脑删除这款游戏的文件：在它的安装记录上打标记，那台电脑同步时自己执行
on('POST', '/api/games/([\\w-]+)/delete-remote', async ({ m, body }) => {
  const { sb } = await libsPromise;
  const game = gameById(m[1]);
  const uid = cache.user.id;
  const match = (q) => q.eq('user_id', uid).eq('device_id', body.deviceId).eq('game_id', game.id);
  const row = check(await match(sb.from('installs').select('data')).maybeSingle());
  if (!row?.data?.installPath) throw fail('那台电脑上没有这款游戏的安装记录', 404);
  const now = new Date().toISOString();
  check(await match(sb.from('installs').update({ data: { ...row.data, deleteRequestedAt: now, deleteError: null }, updated_at: now })));
  await loadAll();
  return gameById(game.id);
});
on('POST', '/api/devices/request-scan', async ({ body }) => {
  const { sb } = await libsPromise;
  const { error } = await sb.rpc('request_scan', { p_device: body.deviceId });
  if (error) throw fail(`发送扫描请求失败：${error.message}`, 502);
  return { ok: true };
});
const scanAll = async () => {
  const { sb } = await libsPromise;
  const { error } = await sb.rpc('request_scan', { p_device: null });
  if (error) throw fail(`发送扫描请求失败：${error.message}`, 502);
  return { requested: true, added: [], installed: [], missing: [] };
};
on('POST', '/api/scan-all', scanAll);
on('POST', '/api/scan', scanAll);

// ---------- 拦截 fetch ----------

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

window.fetch = async (input, init = {}) => {
  const href = typeof input === 'string' ? input : input.url;
  const url = new URL(href, location.href);
  if (url.origin !== location.origin || !url.pathname.includes('/api/')) return realFetch(input, init);
  const pathname = url.pathname.slice(url.pathname.indexOf('/api/'));
  const method = (init.method || 'GET').toUpperCase();
  const route = routes.find((r) => r.method === method && r.re.test(pathname));
  if (!route) return json(404, { error: `网页版暂不支持：${method} ${pathname}` });
  try {
    await libsPromise;
    if (!cache.user && !pathname.startsWith('/api/auth/') && !pathname.startsWith('/api/app/')) {
      const { sb } = await libsPromise;
      cache.user = (await sb.auth.getSession()).data.session?.user || null;
      if (!cache.user) return json(401, { error: '请先登录' });
    }
    let body = init.body;
    if (typeof body === 'string') body = JSON.parse(body);
    return json(200, await route.fn({ m: pathname.match(route.re), body: body || {}, url }));
  } catch (err) {
    console.error('[web]', method, pathname, err);
    return json(err.status || 400, { error: err.message || String(err) });
  }
};
