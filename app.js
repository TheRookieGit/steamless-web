// Steamless 前端：原生 JS，无构建步骤。
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  games: [],
  settings: { steamLibraries: [], localFolders: [], autoScanOnStart: true, archiveFolder: '', extractFolder: '' },
  ai: false,
  tab: 'all',
  source: '',
  sort: 'recent',
  query: '',
  view: 'grid',
  openId: null,
  shots: [], // 待识别的截图 File
};

// 记住一些界面偏好（取不到也没关系）
const prefs = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem('steamless.' + key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('steamless.' + key, JSON.stringify(value));
    } catch {
      // 忽略
    }
  },
};

// ---------- 工具函数 ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(method, url, body) {
  // 自定义请求头：本地服务据此拒绝其他网站发来的跨站请求
  const opts = { method, headers: { 'x-steamless': '1' } };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth/')) showAuth();
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, type = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// 给按钮加 loading 状态并统一处理错误
async function withBusy(btn, fn) {
  btn?.classList.add('busy');
  try {
    return await fn();
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally {
    btn?.classList.remove('busy');
  }
}

const pad = (n) => String(n).padStart(2, '0');
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const toDateInput = (iso) => (iso ? fmtDate(iso) : '');
// 日期输入框的值 → ISO（按本地中午存，避免时区把日期挪一天）
const fromDateInput = (v) => (v ? new Date(`${v}T12:00:00`).toISOString() : null);

function fmtSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i < 2 ? 0 : 1)} ${units[i]}`;
}

function relDays(iso) {
  if (!iso) return '';
  const days = Math.round((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

// ---------- 中英文名：中文优先，英文小字；没有中文名就只显示英文 ----------

const isChinese = (s) => /[㐀-鿿]/.test(s || '') && !/[぀-ヿ]/.test(s || '');
const hasCJK = (s) => /[぀-ヿ㐀-鿿]/.test(s || '');

// Steam 中文名常是「英文名 + 中文名」，拆出中文部分
function chinesePart(name, nameEn) {
  if (!isChinese(name)) return null;
  if (nameEn && name.startsWith(nameEn)) {
    const rest = name.slice(nameEn.length).replace(/^[\s:：\-–—|·]+/, '').trim();
    if (isChinese(rest)) return rest;
  }
  return name;
}

function displayNames(g) {
  const primary = g.nameZh || chinesePart(g.name, g.nameEn) || g.nameEn || g.name;
  const en = g.nameEn || (!hasCJK(g.name) ? g.name : null);
  return { primary, secondary: en && en !== primary ? en : null };
}
const primaryName = (g) => displayNames(g).primary;

const steamUrl = (g) => (g.steamAppId ? `https://store.steampowered.com/app/${g.steamAppId}/` : null);

// ---------- 发售信息 ----------

function releaseInfo(g) {
  const r = g.release;
  if (!r || (!r.date && !r.text)) return { label: '未知', soon: false };
  const text = r.text || r.date;
  if (r.comingSoon) return { label: /预计|待定|即将|tba|coming/i.test(text) ? text : `预计 ${text}`, soon: true };
  return { label: text, soon: false };
}

// 排序用：把 YYYY / YYYY-MM / YYYY-MM-DD 转成时间戳；未知的排最后
function releaseSortKey(g) {
  const d = g.release?.date;
  if (!d) return g.release?.comingSoon ? 9e15 : 9.5e15;
  const [y, m = '12', day = '28'] = d.split('-');
  return new Date(`${y}-${m}-${day}T00:00:00`).getTime();
}

// 收藏里最近 60 天内已发售（之前是未发售，或者发售日很近）的游戏
function isFreshRelease(g) {
  if (g.status !== 'wishlist' || g.release?.comingSoon || !g.release?.date) return false;
  const t = releaseSortKey(g);
  return t <= Date.now() && Date.now() - t < 60 * 86400000;
}

const isUpcoming = (g) => g.status === 'wishlist' && g.release?.comingSoon;
// 特别想要：愿望单里最想先下载的（下载 / 安装后自动移出）
const isMustHave = (g) => g.status === 'wishlist' && Boolean(g.mustHaveAt);

// 已品鉴（只能手动选择）
const VERDICTS = {
  great: { label: '好玩', icon: '👍' },
  ok: { label: '尚可', icon: '👌' },
  waste: { label: '浪费时间', icon: '👎' },
};

// 最近一次游玩：这台电脑（Steam 记录 / 从 Steamless 启动 / 检测到在运行）和其他电脑里最新的一次
function lastPlayedAt(g) {
  const times = [g.lastPlayed, g.lastLaunched, ...(g.otherDevices || []).map((d) => d.lastPlayed)].filter(Boolean);
  return times.length ? times.reduce((a, b) => (new Date(a) > new Date(b) ? a : b)) : null;
}
const PLAYING_DAYS = 30;
const isPlayingRecently = (g) => {
  const t = lastPlayedAt(g);
  return Boolean(t) && Date.now() - new Date(t) < PLAYING_DAYS * 86400000;
};

// ---------- 数据 ----------

async function load() {
  const data = await api('GET', '/api/state');
  state.user = data.user;
  state.sync = data.sync;
  state.games = data.games;
  state.settings = data.settings;
  state.ai = data.ai;
  state.aiModel = data.aiModel;
  render();
  if (state.openId) renderDrawer();
  // 后台还在补全封面/发售信息时，稍后再拉一次
  if (data.enriching > 0) setTimeout(load, 2500);
}

function upsert(game) {
  const i = state.games.findIndex((g) => g.id === game.id);
  if (i === -1) state.games.push(game);
  else state.games[i] = game;
  render();
  if (state.openId === game.id) renderDrawer();
}

// ---------- 列表渲染 ----------

const descKey = (g) => {
  const k = releaseSortKey(g);
  return k >= 9e15 ? -Infinity : k;
};

function filtered() {
  const q = state.query.trim().toLowerCase();
  let list = state.games.filter((g) => {
    if (state.tab === 'wishlist' && g.status !== 'wishlist') return false;
    if (state.tab === 'musthave' && !isMustHave(g)) return false;
    if (state.tab === 'downloaded' && g.status !== 'downloaded') return false;
    if (state.tab === 'installed' && g.status !== 'installed') return false;
    if (state.tab === 'upcoming' && !isUpcoming(g)) return false;
    if (state.tab === 'playing' && !isPlayingRecently(g)) return false;
    if (state.tab === 'rated' && g.verdict !== (state.verdictFilter || 'great')) return false;
    if (state.source && sourceKey(g) !== state.source) return false;
    if (q) {
      const hay = [g.name, g.nameZh, g.nameEn, g.folderName, g.notes, ...(g.tags || []), ...(g.genres || []), ...(g.developers || [])].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const t = (iso) => (iso ? new Date(iso).getTime() : 0);
  const sorters = {
    recent: (a, b) => t(b.createdAt) - t(a.createdAt),
    favorited: (a, b) => t(b.favoritedAt) - t(a.favoritedAt),
    musthave: (a, b) => t(b.mustHaveAt) - t(a.mustHaveAt),
    downloaded: (a, b) => t(b.downloadedAt) - t(a.downloadedAt),
    installed: (a, b) => t(b.installedAt) - t(a.installedAt),
    // 即将发售：最近的在前；其他：最新发售的在前（未知的都排最后）
    release: (a, b) => (state.tab === 'upcoming' ? releaseSortKey(a) - releaseSortKey(b) : descKey(b) - descKey(a)),
    played: (a, b) => t(lastPlayedAt(b)) - t(lastPlayedAt(a)),
    size: (a, b) => (b.sizeOnDisk || 0) - (a.sizeOnDisk || 0),
    name: (a, b) => primaryName(a).localeCompare(primaryName(b), 'zh-CN'),
  };
  return list.sort(sorters[state.sort] || sorters.recent);
}

// 收藏截图 / 自己上传的封面：桌面版由本地服务提供；网页版（web/adapter.js）换成私有存储的临时链接
const mediaUrl = (u) => (u && window.steamlessMediaUrl ? window.steamlessMediaUrl(u) : u);

// 封面优先级：自选封面 > Steam 横幅 > 第一张收藏截图；用户也可以隐藏或模糊
function coverSrc(g) {
  if (g.coverHidden) return null;
  if (g.coverImage) return mediaUrl(g.coverImage);
  if (g.headerImage) return g.headerImage;
  return g.screenshots?.[0] ? mediaUrl(`/screenshots/${g.screenshots[0]}`) : null;
}

function coverHtml(g) {
  const src = coverSrc(g);
  const img = src ? `<img src="${esc(src)}" alt="" loading="lazy" class="${g.coverBlur ? 'blurred' : ''}" onerror="this.remove()" />` : '';
  return `<div class="placeholder">${esc(primaryName(g))}</div>${img}`;
}

// 只有装在这台电脑上的才能启动（同一账号在别的电脑上装的，这里只显示状态）
// 这台电脑上怎么启动：steam / exe。同一款游戏在不同电脑上可能不一样（这台走 Steam，那台是文件夹里的 exe）
const kindHere = (g) => g.launchVia || (g.source === 'steam' ? 'steam' : 'exe');
// 卡片上显示的来源：装在这台电脑上就按这台的启动方式，否则按账号里记的来源
const sourceKey = (g) => (g.installPath ? (kindHere(g) === 'steam' ? 'steam' : 'local') : g.source || 'manual');
const canPlayHere = (g) => g.status === 'installed' && Boolean(g.installPath) && !g.missing && (kindHere(g) === 'steam' ? g.steamAppId : g.exePath);
const elsewhere = (g) => (!g.installPath ? (g.otherDevices || []).filter((d) => !d.missing) : []);

// 装在其他电脑上的文件夹版游戏：可以请那台电脑删除游戏文件（Steam 版要在那台电脑的 Steam 里卸载）
function remoteDeleteHtml(g) {
  if (g.source === 'steam') return '';
  const list = (g.otherDevices || []).filter((d) => d.installPath && !d.missing);
  return list.map((d) => `<div class="row" style="margin-top:8px">
      <span class="muted grow" style="font-size:12px">${d.deleteRequestedAt ? `已请求 ${esc(d.deviceName)} 删除文件，等它同步后执行…` : d.deleteError ? `${esc(d.deviceName)} 上删除失败：${esc(d.deleteError)}` : ''}</span>
      <button class="btn small danger" data-act="delete-remote" data-device="${esc(d.deviceId)}" ${d.deleteRequestedAt ? 'disabled' : ''}>删除 ${esc(d.deviceName)} 上的游戏并移出库</button>
    </div>`).join('');
}

function badgesHtml(g) {
  const b = [];
  if (g.status === 'installed') b.push('<span class="badge installed">已安装</span>');
  else if (g.status === 'downloaded') b.push('<span class="badge downloaded">已下载</span>');
  else b.push('<span class="badge wishlist">已收藏</span>');
  if (isMustHave(g)) b.push('<span class="badge musthave">⭐ 特别想要</span>');
  if (g.missing) b.push('<span class="badge missing">文件夹缺失</span>');
  const others = elsewhere(g);
  if (others.length) b.push(`<span class="badge elsewhere" title="${esc(others.map((d) => d.deviceName).join('、'))}">💻 在 ${esc(others[0].deviceName)}${others.length > 1 ? ` 等 ${others.length} 台` : ''} 上</span>`);
  if (g.downloading) b.push('<span class="badge downloading">下载/更新中</span>');
  if (isUpcoming(g)) b.push('<span class="badge upcoming">未发售</span>');
  if (isFreshRelease(g)) b.push('<span class="badge fresh">新发售</span>');
  if (g.verdict && VERDICTS[g.verdict]) b.push(`<span class="badge verdict-${g.verdict}">${VERDICTS[g.verdict].icon} ${VERDICTS[g.verdict].label}</span>`);
  return b.join('');
}

// 本地游戏显示原文件夹名，方便区分同一款游戏的不同版本（如 吉原彼岸花 / 吉原彼岸花R18）
// 第三行小字：来源；本地游戏一律加上文件夹名（统一显示，也方便区分同一款游戏的不同版本）
function subtitle(g, source) {
  const parts = [];
  if (source) parts.push(source);
  if (sourceKey(g) === 'local' && g.folderName) parts.push(`📁 ${g.folderName}`);
  return parts.join(' · ');
}

function cardHtml(g) {
  const names = displayNames(g);
  const rel = releaseInfo(g);
  const canPlay = canPlayHere(g);
  const rows = [];
  if (g.favoritedAt) rows.push(['收藏', fmtDate(g.favoritedAt)]);
  if (g.downloadedAt) rows.push(['下载', fmtDate(g.downloadedAt)]);
  if (g.installedAt) rows.push(['安装', fmtDate(g.installedAt)]);
  rows.push(['发售', rel.label, rel.soon ? 'soon' : '']);
  if (g.sizeOnDisk) rows.push(['大小', fmtSize(g.sizeOnDisk)]);
  const played = lastPlayedAt(g);
  if (played) rows.push(['游玩', relDays(played)]);
  const source = { steam: 'Steam', local: '本地' }[sourceKey(g)] || '';
  return `
  <article class="card ${g.missing ? 'missing' : ''}" data-id="${g.id}">
    <div class="cover">
      ${coverHtml(g)}
      <div class="badges">${badgesHtml(g)}</div>
      <div class="quick">
        ${steamUrl(g) ? `<a class="btn small" href="${steamUrl(g)}" target="_blank" rel="noopener" data-stop>Steam ↗</a>` : ''}
        ${g.installPath ? `<button class="btn small" data-act="folder">📁</button>` : ''}
      </div>
    </div>
    <div class="card-body">
      <div class="card-titles">
        <div class="card-title" title="${esc(names.primary)}">${esc(names.primary)}</div>
        ${names.secondary ? `<div class="card-en" title="${esc(names.secondary)}">${esc(names.secondary)}</div>` : ''}
        <div class="card-sub" title="${esc(g.folderName || '')}">${esc(subtitle(g, source))}</div>
      </div>
      <dl class="meta">${rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}" title="${esc(v)}">${esc(v)}</dd>`).join('')}</dl>
      ${canPlay ? `<div class="card-actions"><button class="btn play" data-act="launch">▶ 启动</button></div>` : ''}
    </div>
  </article>`;
}

function render() {
  const counts = {
    all: state.games.length,
    wishlist: state.games.filter((g) => g.status === 'wishlist').length,
    musthave: state.games.filter(isMustHave).length,
    downloaded: state.games.filter((g) => g.status === 'downloaded').length,
    installed: state.games.filter((g) => g.status === 'installed').length,
    upcoming: state.games.filter(isUpcoming).length,
    playing: state.games.filter(isPlayingRecently).length,
    rated: state.games.filter((g) => g.verdict).length,
    great: state.games.filter((g) => g.verdict === 'great').length,
    ok: state.games.filter((g) => g.verdict === 'ok').length,
    waste: state.games.filter((g) => g.verdict === 'waste').length,
  };
  for (const [k, v] of Object.entries(counts)) $('#count-' + k).textContent = v;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  $('#verdict-filter').classList.toggle('hidden', state.tab !== 'rated');
  $$('#verdict-filter button').forEach((b) => b.classList.toggle('active', b.dataset.verdict === (state.verdictFilter || 'great')));

  const list = filtered();
  const grid = $('#grid');
  grid.classList.toggle('list', state.view === 'list');
  grid.innerHTML = list.map(cardHtml).join('');

  const empty = $('#empty');
  if (list.length) {
    empty.classList.add('hidden');
  } else {
    empty.classList.remove('hidden');
    const noFolders = !state.settings.steamLibraries.length && !state.settings.localFolders.length;
    const emptyHints = {
      musthave: '<h3>还没有特别想要的游戏</h3><div>在「已收藏」里的游戏卡片上右键，选择 ⭐ 加入特别想要；下载或安装之后会自动移出</div>',
      rated: '<h3>还没有品鉴过游戏</h3><div>在游戏卡片上右键，或打开详情，选择 👍 好玩 / 👌 尚可 / 👎 浪费时间</div>',
      playing: `<h3>最近 ${PLAYING_DAYS} 天没有玩过游戏</h3><div>Steam 游戏会读取 Steam 的游玩记录；其他游戏从 Steamless 启动，或在 Steamless 运行时玩，都会被记录下来</div>`,
    };
    empty.innerHTML = state.games.length
      ? state.tab === 'rated' && !state.query && !state.source && state.games.some((g) => g.verdict)
        ? `<h3>还没有标为「${VERDICTS[state.verdictFilter || 'great'].icon} ${VERDICTS[state.verdictFilter || 'great'].label}」的游戏</h3><div>在游戏卡片上右键就可以快速品鉴</div>`
        : emptyHints[state.tab] && !state.query && !state.source
          ? emptyHints[state.tab]
          : `<h3>没有符合条件的游戏</h3><div>换个筛选条件试试</div>`
      : `<h3>游戏库还是空的</h3>
         <div>${noFolders ? '先在设置里链接 Steam 库和你的下载文件夹，' : ''}或者上传收藏截图开始整理。</div>
         <div class="row"><button class="btn primary" data-empty="upload">📷 截图收藏</button><button class="btn" data-empty="settings">⚙ 链接文件夹</button></div>`;
  }

}

// ---------- 详情抽屉 ----------

function openDrawer(id) {
  if (state.openId !== id) state.coverPickerFor = null;
  state.openId = id;
  renderDrawer();
  $('#drawer').classList.add('open');
  $('#drawer-mask').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
  state.openId = null;
  state.coverPickerFor = null;
  $('#drawer').classList.remove('open');
  $('#drawer-mask').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
}

function renderDrawer() {
  const g = state.games.find((x) => x.id === state.openId);
  if (!g) return closeDrawer();
  const rel = releaseInfo(g);
  const relSource = { steam: 'Steam 商店', web: '网络搜索', screenshot: '截图', manual: '手动' }[g.release?.source] || '';
  const canPlay = canPlayHere(g);
  const tags = g.tags || [];

  $('#drawer-body').innerHTML = `
    <div class="drawer-cover">
      ${coverHtml(g)}
      <button class="btn icon close" data-act="close">✕</button>
      <button class="btn small change-cover" data-act="cover">🖼 更换封面</button>
    </div>
    <div id="cover-picker"></div>
    <div class="drawer-inner">
      <div>
        <div class="row" style="margin-bottom:6px">${badgesHtml(g)}</div>
        <h2>${esc(displayNames(g).primary)}</h2>
        ${displayNames(g).secondary ? `<div class="sub">${esc(displayNames(g).secondary)}</div>` : ''}
      </div>

      <div class="row">
        ${canPlay ? `<button class="btn play" data-act="launch">▶ 启动游戏</button>` : ''}
        ${g.installPath ? `<button class="btn" data-act="folder">📁 打开文件夹</button>` : ''}
        ${steamUrl(g) ? `<a class="btn" href="${steamUrl(g)}" target="_blank" rel="noopener">Steam 商店页 ↗</a>` : ''}
        ${g.steamAppId && g.status === 'wishlist' ? `<a class="btn" href="steam://install/${g.steamAppId}">⬇ 用 Steam 安装</a>` : ''}
        ${!g.steamAppId && g.officialUrl ? `<a class="btn" href="${esc(g.officialUrl)}" target="_blank" rel="noopener">官网 ↗</a>` : ''}
        <span id="drawer-archive-btn" data-desktop-only style="display:contents"></span>
      </div>

      <div id="drawer-archives" data-desktop-only></div>

      ${g.description ? `<div class="desc">${esc(g.description)}</div>` : ''}
      ${(g.genres?.length || g.developers?.length) ? `<div class="chips">${[...(g.developers || []).map((d) => '🏢 ' + d), ...(g.genres || [])].map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}

      <div class="section">
        <h3>发售信息</h3>
        <dl class="kv">
          <dt>发售日期</dt><dd class="${rel.soon ? 'soon' : ''}">${esc(rel.label)}${rel.soon ? '（未发售）' : ''}</dd>
          ${g.price ? `<dt>价格</dt><dd>${esc(g.price)}</dd>` : ''}
          ${relSource ? `<dt>数据来源</dt><dd class="muted">${relSource} · ${esc(fmtDate(g.release.checkedAt))} 更新</dd>` : ''}
        </dl>
        <div class="row">
          <button class="btn small" data-act="refresh">⟳ 刷新信息</button>
          ${state.ai ? `<button class="btn small" data-act="web-release" title="用 Claude 联网搜索发售日期">🔎 联网查询发售日期</button>` : ''}
          <button class="btn small" data-act="edit-release">✎ 手动填写</button>
        </div>
        <div id="release-editor"></div>
      </div>

      <div class="section">
        <h3>Steam 关联</h3>
        <div class="row">
          <span class="grow">${g.steamAppId ? `AppID <span class="mono">${g.steamAppId}</span>` : '<span class="muted">未关联 Steam（不在 Steam 上的游戏可以不关联）</span>'}</span>
          <button class="btn small" data-act="link-steam">${g.steamAppId ? '更换' : '搜索并关联'}</button>
          ${g.steamAppId && !(g.installPath && kindHere(g) === 'steam') ? `<button class="btn small ghost" data-act="unlink-steam">取消关联</button>` : ''}
        </div>
        <div id="steam-linker"></div>
      </div>

      <div class="section">
        <h3>我的记录</h3>
        <div class="fields">
          <label class="field">状态
            <select data-field="status">
              <option value="wishlist" ${g.status === 'wishlist' ? 'selected' : ''}>已收藏（准备下载）</option>
              <option value="downloaded" ${g.status === 'downloaded' ? 'selected' : ''}>已下载（有安装包，还没解压）</option>
              <option value="installed" ${g.status === 'installed' ? 'selected' : ''}>已安装（可以玩）</option>
            </select>
          </label>
          <div class="field full">品鉴（玩过之后给个评价）
            <div class="verdicts">
              ${Object.entries(VERDICTS)
                .map(([k, v]) => `<button type="button" class="verdict-btn verdict-${k} ${g.verdict === k ? 'selected' : ''}" data-verdict-set="${k}" title="${g.verdict === k ? '再点一次取消' : v.label}">${v.icon} ${v.label}</button>`)
                .join('')}
            </div>
            ${g.verdictAt ? `<span class="hint">品鉴于 ${fmtDate(g.verdictAt)}</span>` : ''}
          </div>
          <label class="field">收藏日期 <input type="date" data-field="favoritedAt" data-date value="${toDateInput(g.favoritedAt)}" /></label>
          <label class="field">下载日期 <input type="date" data-field="downloadedAt" data-date value="${toDateInput(g.downloadedAt)}" /></label>
          <label class="field">安装日期 <input type="date" data-field="installedAt" data-date value="${toDateInput(g.installedAt)}" /></label>
          <label class="field">中文名 <input data-field="nameZh" value="${esc(g.nameZh || chinesePart(g.name, g.nameEn) || '')}" placeholder="没有中文名可以留空" /></label>
          <label class="field">英文名 <input data-field="nameEn" value="${esc(g.nameEn || '')}" /></label>
          <div class="field full">标签
            <div class="chips" style="margin:2px 0 4px">${tags.map((t, i) => `<span class="chip removable" data-tag="${i}" title="点击移除">${esc(t)} ✕</span>`).join('') || '<span class="muted">还没有标签</span>'}</div>
            <input id="tag-input" placeholder="输入标签后回车，如：联机、二周目、等打折" />
          </div>
          <label class="field full">备注 <textarea data-field="notes" placeholder="想玩的原因、配置要求、下载来源…">${esc(g.notes || '')}</textarea></label>
        </div>
      </div>

      ${!g.installPath && elsewhere(g).length ? `
      <div class="section">
        <h3>安装位置</h3>
        <dl class="kv">
          ${elsewhere(g).map((d) => `<dt>💻 ${esc(d.deviceName)}</dt><dd class="mono">${esc(d.installPath || '')}</dd>`).join('')}
        </dl>
        <div class="callout">这款游戏装在其他电脑上，所以这台电脑上没有「启动」按钮。<br/>
          ${g.source === 'steam'
            ? '在这台电脑的 Steam 里也安装它，Steamless 扫描后就能直接启动。'
            : '如果这台电脑也能访问那个文件夹（比如网络共享），在 ⚙ 设置 →「其他下载位置」里链接它，扫描后就能直接启动。'}
        </div>
        <div class="row">${g.source === 'steam' && g.steamAppId ? `<a class="btn small" href="steam://install/${g.steamAppId}">⬇ 用 Steam 安装</a>` : '<button class="btn small" data-act="open-settings">打开设置</button>'}</div>
        ${remoteDeleteHtml(g)}
      </div>` : g.installPath || g.status === 'installed' ? `
      <div class="section">
        <h3>本地文件</h3>
        <dl class="kv">
          <dt>安装位置</dt><dd class="mono">${esc(g.installPath || '—')}</dd>
          ${kindHere(g) !== 'steam' ? `<dt>启动程序</dt><dd class="mono">${esc(g.exePath || '未设置')}</dd>` : '<dt>启动方式</dt><dd>通过 Steam 客户端启动</dd>'}
          ${g.sizeOnDisk ? `<dt>占用空间</dt><dd>${fmtSize(g.sizeOnDisk)}</dd>` : ''}
          ${lastPlayedAt(g) ? `<dt>上次游玩</dt><dd>${fmtDate(lastPlayedAt(g))}（${relDays(lastPlayedAt(g))}）</dd>` : ''}
        </dl>
        ${kindHere(g) !== 'steam' && g.installPath ? `<div class="row"><button class="btn small" data-act="choose-exe">选择启动程序…</button><button class="btn small" data-act="browse-exe">浏览…</button></div><div id="exe-picker"></div>` : ''}
        ${remoteDeleteHtml(g)}
      </div>` : ''}

      ${g.screenshots?.length ? `
      <div class="section">
        <h3>收藏截图</h3>
        <div class="shots">${g.screenshots.map((s) => `<img src="${esc(mediaUrl(`/screenshots/${s}`))}" data-zoom alt="" loading="lazy" />`).join('')}</div>
      </div>` : ''}

      <div class="section">
        <div class="row">
          <span class="muted grow" style="font-size:12px">添加于 ${fmtDate(g.createdAt)}</span>
          <button class="btn small danger" data-act="delete">从库中移除</button>
        </div>
      </div>
    </div>`;
  if (state.coverPickerFor === g.id && state.coverOptions) renderCoverPicker(g, state.coverOptions);
  loadDrawerArchives(g);
}

// ---------- 游戏页里的压缩包：只解压和这款游戏同名的 ----------

const drawerArch = { gameId: null, data: null, at: 0, loading: false };

async function loadDrawerArchives(g) {
  if (drawerArch.gameId !== g.id) Object.assign(drawerArch, { gameId: g.id, data: null, at: 0 });
  renderDrawerArchives(g);
  if (drawerArch.loading || Date.now() - drawerArch.at < 10000) return;
  drawerArch.loading = true;
  try {
    const data = await api('GET', `/api/games/${g.id}/archives`);
    if (drawerArch.gameId === g.id) Object.assign(drawerArch, { data, at: Date.now() });
    pollExtract();
  } catch {
    // 网页版或没配置：不显示
  } finally {
    drawerArch.loading = false;
  }
  if (state.openId === g.id) renderDrawerArchives(g);
}

function renderDrawerArchives(g) {
  const btnBox = $('#drawer-archive-btn');
  const box = $('#drawer-archives');
  if (!btnBox || !box) return;
  const d = drawerArch.gameId === g.id ? drawerArch.data : null;
  if (!d?.configured || !d.groups.length || (g.installPath && kindHere(g) !== 'steam' && !ex.jobs.length)) {
    btnBox.innerHTML = '';
    box.innerHTML = '';
    return;
  }
  if (box.contains(document.activeElement) && document.activeElement.matches('input')) return;
  const jobBy = Object.fromEntries(ex.jobs.map((j) => [j.id, j]));
  const many = d.groups.length > 1;
  // 按钮放在 Steam 商店页那一行；进度、密码、缺卷提示放在下面
  btnBox.innerHTML = d.groups
    .map((a) => {
      const j = jobBy[a.id];
      const label = many ? ` ${esc(a.name)}` : '';
      if (exActive(j)) return `<button class="btn" data-act="ex-cancel" data-aid="${a.id}" title="点击取消">📦 解压中 ${j.percent}%${label} ✕</button>`;
      if (j?.status === 'done' || a.missing.length || j?.status === 'needs-password') return '';
      return `<button class="btn" data-act="ex-start" data-aid="${a.id}" ${d.canExtract ? '' : 'disabled title="先在设置里选择「解压到」文件夹"'}>📦 解压${label}（${fmtSize(a.size)}）</button>`;
    })
    .join('');
  box.innerHTML = d.groups
    .map((a) => {
      const j = jobBy[a.id];
      const bar = j && j.status !== 'cancelled'
        ? `<div class="ex-bar ${j.status}"><div style="width:${j.status === 'done' ? 100 : j.percent}%"></div></div>
           <div class="hint">${esc(a.name)}：${j.status === 'running' ? `${j.percent}% · ` : ''}${esc(j.message)}${j.target ? ` → <span class="mono">${esc(j.target)}</span>` : ''}</div>`
        : '';
      const pw = j?.status === 'needs-password'
        ? `<div class="row"><input type="password" class="grow" data-ex-pw="${a.id}" placeholder="输入解压密码" autocomplete="off" style="padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel)" />
            <label class="hint"><input type="checkbox" data-ex-remember="${a.id}" checked /> 记住</label>
            <button class="btn small primary" data-act="ex-retry" data-aid="${a.id}">重试</button></div>`
        : '';
      const warn = a.missing.length ? `<div class="hint" style="color:var(--red)">${esc(a.name)} 缺少分卷：${esc(a.missing.join('、'))}</div>` : '';
      return warn + bar + pw;
    })
    .join('') + (d.canExtract ? '' : '<div class="hint">先在设置 →「压缩包解压」里选择「解压到」文件夹。</div>');
}

async function patchGame(id, patch) {
  const game = await api('PATCH', `/api/games/${id}`, patch);
  upsert(game);
  return game;
}

async function onDrawerAction(act, btn) {
  const g = state.games.find((x) => x.id === state.openId);
  if (!g) return;
  switch (act) {
    case 'close':
      return closeDrawer();
    case 'launch':
      return launch(g, btn);
    case 'folder':
      return withBusy(btn, () => api('POST', `/api/games/${g.id}/open-folder`));
    case 'refresh':
      return withBusy(btn, async () => {
        upsert(await api('POST', `/api/games/${g.id}/refresh`));
        toast('已更新', 'success');
      });
    case 'web-release':
      return withBusy(btn, async () => {
        upsert(await api('POST', `/api/games/${g.id}/web-release`));
        toast('已联网更新发售信息', 'success');
      });
    case 'ex-start':
    case 'ex-retry': {
      const id = btn.dataset.aid;
      const pwInput = act === 'ex-retry' ? document.querySelector(`[data-ex-pw="${id}"]`) : null;
      if (act === 'ex-retry' && !pwInput?.value) return toast('请输入密码', 'error');
      const remember = act === 'ex-retry' && document.querySelector(`[data-ex-remember="${id}"]`)?.checked;
      return startExtract(btn, [id], { password: pwInput?.value || '', remember, retry: act === 'ex-retry' });
    }
    case 'ex-cancel':
      return withBusy(btn, async () => {
        await api('POST', '/api/extract/cancel', { id: btn.dataset.aid });
        await pollExtract();
      });
    case 'open-settings':
      closeDrawer();
      return $('#btn-settings').click();
    case 'cover':
      return toggleCoverPicker(g, btn);
    case 'edit-release':
      return renderReleaseEditor(g);
    case 'link-steam':
      return renderSteamLinker(g);
    case 'unlink-steam':
      return withBusy(btn, async () => upsert(await api('POST', `/api/games/${g.id}/link-steam`, { steamAppId: null })));
    case 'choose-exe':
      return withBusy(btn, async () => renderExePicker(g, await api('GET', `/api/games/${g.id}/exes`)));
    case 'browse-exe':
      return withBusy(btn, async () => {
        const { path } = await api('POST', `/api/games/${g.id}/pick-exe`);
        if (path) {
          await patchGame(g.id, { exePath: path });
          toast('已设置启动程序', 'success');
        }
      });
    case 'delete-remote': {
      const d = (g.otherDevices || []).find((x) => x.deviceId === btn.dataset.device);
      if (!d) return;
      if (!confirm(`请「${d.deviceName}」删除「${g.name}」的游戏文件夹吗？\n${d.installPath}\n\n删除后无法恢复，并且会把这款游戏从库里移除（收藏、备注、品鉴等记录也会一起删除）。\n那台电脑开着 Steamless 时会在一分钟内执行。`)) return;
      return withBusy(btn, async () => {
        upsert(await api('POST', `/api/games/${g.id}/delete-remote`, { deviceId: d.deviceId }));
        toast('已发送删除请求', 'success');
      });
    }
    case 'delete':
      const hasFiles = g.installPath && kindHere(g) !== 'steam' && g.status === 'installed' && !g.missing;
      const skipNote = hasFiles ? '\n以后扫描会跳过这个文件夹（可在设置里恢复）。' : '';
      if (!confirm(`确定把「${g.name}」从库中移除吗？${skipNote}`)) return;
      // 在这台电脑上有游戏文件夹的，再问一次要不要连本体一起删
      const deleteFiles = hasFiles && confirm(`同时删除硬盘上的游戏文件夹吗？\n${g.installPath}\n\n删除后无法恢复。\n确定 = 连文件一起删除；取消 = 只从库中移除，保留文件。`);
      // 只装在其他电脑（或网页版没有本机）上的：问要不要请那些电脑删除游戏文件
      const remotes = g.installPath || g.source === 'steam' ? [] : (g.otherDevices || []).filter((d) => d.installPath && !d.missing && !d.deleteRequestedAt);
      if (remotes.length && confirm(`同时请 ${remotes.map((d) => d.deviceName).join('、')} 删除硬盘上的游戏文件夹吗？\n${remotes.map((d) => d.installPath).join('\n')}\n\n删除后无法恢复。那些电脑开着 Steamless 时会在一分钟内执行，执行后游戏会从库里移除。\n确定 = 请它们删除文件；取消 = 只从库中移除，保留文件。`)) {
        return withBusy(btn, async () => {
          for (const d of remotes) upsert(await api('POST', `/api/games/${g.id}/delete-remote`, { deviceId: d.deviceId }));
          toast('已发送删除请求', 'success');
        });
      }
      return withBusy(btn, async () => {
        await api('DELETE', `/api/games/${g.id}${deleteFiles ? '?deleteFiles=1' : ''}`);
        state.games = state.games.filter((x) => x.id !== g.id);
        closeDrawer();
        render();
        toast('已移除');
      });
  }
}

// ---------- 自选封面 ----------

async function toggleCoverPicker(g, btn) {
  const box = $('#cover-picker');
  if (state.coverPickerFor === g.id) {
    state.coverPickerFor = null;
    box.innerHTML = '';
    return;
  }
  state.coverPickerFor = g.id;
  box.innerHTML = '<div class="cover-picker"><div class="muted">正在加载可选图片…</div></div>';
  await withBusy(btn, async () => {
    const options = await api('GET', `/api/games/${g.id}/covers`);
    renderCoverPicker(g, options);
  });
}

function renderCoverPicker(g, options) {
  state.coverOptions = options;
  const box = $('#cover-picker');
  const current = g.coverHidden ? null : g.coverImage || g.headerImage;
  box.innerHTML = `
    <div class="cover-picker">
      <div class="row">
        <b class="grow">选择封面</b>
        <label class="row" title="恐怖游戏的封面可以模糊处理"><input type="checkbox" data-cover="blur" ${g.coverBlur ? 'checked' : ''} /> 模糊处理</label>
      </div>
      <div class="cover-options">
        ${options
          .map((o) => `<button type="button" class="cover-option ${o.url === current ? 'selected' : ''}" data-url="${esc(o.url)}" title="${esc(o.label)}">
            <img src="${esc(o.thumb)}" alt="" loading="lazy" onerror="this.closest('.cover-option').remove()" /><span>${esc(o.label)}</span></button>`)
          .join('')}
        <label class="cover-option upload" title="上传自己的图片（也可以在这里 Ctrl+V 粘贴）">
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-cover="upload" hidden />
          <span class="big">＋</span><span>上传图片</span>
        </label>
        <button type="button" class="cover-option none ${g.coverHidden ? 'selected' : ''}" data-cover="none"><span class="big">🚫</span><span>不显示图片</span></button>
      </div>
      <div class="row end">
        ${g.coverImage || g.coverHidden ? '<button class="btn small" data-cover="reset">恢复默认封面</button>' : ''}
        <button class="btn small" data-cover="close">完成</button>
      </div>
      ${options.length ? '' : '<div class="hint">这款游戏没有关联 Steam，只能上传自己的图片。关联 Steam 后可以从官方图片里挑。</div>'}
    </div>`;
}

async function setCover(patch, el) {
  await withBusy(el, async () => {
    await patchGame(state.openId, patch); // 抽屉重绘时会按缓存恢复选择器
  });
}

async function uploadCover(file) {
  if (!file || !state.openId) return;
  const form = new FormData();
  form.append('image', file, file.name || 'cover.png');
  await withBusy(null, async () => {
    upsert(await api('POST', `/api/games/${state.openId}/cover-upload`, form));
    toast('已更换封面', 'success');
  });
}

function onCoverPickerEvent(e) {
  const box = e.target.closest('#cover-picker');
  if (!box) return false;
  const opt = e.target.closest('[data-url]');
  const action = e.target.closest('[data-cover]')?.dataset.cover;
  if (e.type === 'click' && opt) setCover({ coverImage: opt.dataset.url, coverHidden: false }, opt);
  else if (e.type === 'click' && action === 'none') setCover({ coverHidden: true }, e.target.closest('button'));
  else if (e.type === 'click' && action === 'reset') setCover({ coverImage: null, coverHidden: false }, e.target.closest('button'));
  else if (e.type === 'click' && action === 'close') {
    state.coverPickerFor = null;
    box.innerHTML = '';
  } else if (e.type === 'change' && action === 'blur') setCover({ coverBlur: e.target.checked }, null);
  else if (e.type === 'change' && action === 'upload') uploadCover(e.target.files[0]);
  return true;
}

function renderReleaseEditor(g) {
  const box = $('#release-editor');
  const r = g.release || {};
  box.innerHTML = `
    <div class="fields" style="margin-top:6px">
      <label class="field">发售状态
        <select id="rel-soon"><option value="0" ${!r.comingSoon ? 'selected' : ''}>已发售</option><option value="1" ${r.comingSoon ? 'selected' : ''}>未发售</option></select>
      </label>
      <label class="field">日期（可只填年份或年月）<input id="rel-date" placeholder="2026-03-20 / 2026-03 / 2026" value="${esc(r.date || '')}" /></label>
      <label class="field full">显示文字 <input id="rel-text" placeholder="如：预计 2026 年第二季度" value="${esc(r.text || '')}" /></label>
    </div>
    <div class="row end" style="margin-top:8px"><button class="btn small primary" id="rel-save">保存</button></div>`;
  $('#rel-save').onclick = (e) =>
    withBusy(e.currentTarget, async () => {
      const date = $('#rel-date').value.trim();
      if (date && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(date)) throw new Error('日期格式应为 YYYY、YYYY-MM 或 YYYY-MM-DD');
      await patchGame(g.id, {
        release: {
          comingSoon: $('#rel-soon').value === '1',
          date: date || null,
          precision: date ? ['year', 'month', 'day'][date.split('-').length - 1] : null,
          text: $('#rel-text').value.trim() || date || null,
          source: 'manual',
          checkedAt: new Date().toISOString(),
        },
      });
      toast('已保存', 'success');
    });
}

function steamPickHtml(items) {
  if (!items.length) return '<div class="muted">没有找到结果</div>';
  return items
    .map((c) => `<button class="pick-item" type="button" data-appid="${c.steamAppId}" data-name="${esc(c.name)}"><img src="${esc(c.image || '')}" alt="" onerror="this.style.visibility='hidden'"/><span class="grow">${esc(c.name)}</span><span class="mono">${c.steamAppId}</span></button>`)
    .join('');
}

function renderSteamLinker(g) {
  const box = $('#steam-linker');
  box.innerHTML = `
    <div class="row"><input id="link-q" class="grow" style="padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel)" value="${esc(g.nameEn || g.name)}" placeholder="游戏名或 AppID" /><button class="btn small" id="link-go">搜索</button></div>
    <div class="pick-list" id="link-results" style="margin-top:6px"></div>`;
  const search = () =>
    withBusy($('#link-go'), async () => {
      const q = $('#link-q').value.trim();
      if (/^\d+$/.test(q)) {
        $('#link-results').innerHTML = steamPickHtml([{ steamAppId: Number(q), name: `AppID ${q}`, image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${q}/capsule_231x87.jpg` }]);
        return;
      }
      $('#link-results').innerHTML = steamPickHtml(await api('GET', '/api/steam/search?q=' + encodeURIComponent(q)));
    });
  $('#link-go').onclick = search;
  $('#link-q').onkeydown = (e) => e.key === 'Enter' && search();
  $('#link-results').onclick = (e) => {
    const item = e.target.closest('[data-appid]');
    if (!item) return;
    withBusy(item, async () => {
      upsert(await api('POST', `/api/games/${g.id}/link-steam`, { steamAppId: Number(item.dataset.appid) }));
      toast('已关联 Steam', 'success');
    });
  };
  search();
}

function renderExePicker(g, exes) {
  const box = $('#exe-picker');
  if (!exes.length) {
    box.innerHTML = '<div class="muted">文件夹里没有找到 exe，可以点「浏览…」手动选择</div>';
    return;
  }
  box.innerHTML = `<div class="pick-list">${exes
    .map((e) => `<button class="pick-item" type="button" data-exe="${esc(e.path)}"><span class="grow mono">${esc(e.relative)}</span><span class="muted">${fmtSize(e.size)}</span></button>`)
    .join('')}</div>`;
  box.onclick = (ev) => {
    const item = ev.target.closest('[data-exe]');
    if (!item) return;
    withBusy(item, async () => {
      await patchGame(g.id, { exePath: item.dataset.exe });
      toast('已设置启动程序', 'success');
    });
  };
}

async function launch(g, btn) {
  await withBusy(btn, async () => {
    const r = await api('POST', `/api/games/${g.id}/launch`);
    toast(r.via === 'steam' ? `正在通过 Steam 启动「${g.name}」…` : `已启动「${g.name}」`, 'success');
  });
}

// ---------- 截图识别 ----------

function addShots(files) {
  const images = [...files].filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
  if (!images.length) return;
  state.shots = [...state.shots, ...images].slice(0, 10);
  renderShots();
}

function renderShots() {
  const thumbs = $('#thumbs');
  thumbs.innerHTML = '';
  state.shots.forEach((file, i) => {
    const div = document.createElement('div');
    div.className = 'thumb';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '✕';
    rm.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.shots.splice(i, 1);
      renderShots();
    };
    div.append(img, rm);
    thumbs.append(div);
  });
  $('#btn-recognize').disabled = !state.shots.length;
}

function openUpload() {
  const dlg = $('#dlg-upload');
  if (!dlg.open) dlg.showModal();
  if (!state.ai) {
    $('#recognize-results').innerHTML = `<div class="callout warn">⚠ 还没有配置 Anthropic API Key，截图识别不可用。<br/>点右上角 ⚙ 设置，在「截图识别」里粘贴 API Key 保存即可。<br/>暂时也可以用「手动添加」来收藏游戏。</div>`;
  }
}

async function recognize(btn) {
  if (!state.shots.length) return;
  const form = new FormData();
  state.shots.forEach((f) => form.append('images', f, f.name || 'screenshot.png'));
  $('#recognize-results').innerHTML = '<div class="callout">🔍 正在识别截图并查询 Steam / 发售信息，通常需要 10–40 秒…</div>';
  await withBusy(btn, async () => {
    try {
      const data = await api('POST', '/api/recognize', form);
      renderResults(data);
    } catch (err) {
      $('#recognize-results').innerHTML = '';
      throw err;
    }
  });
}

function renderResults({ screenshots, results }) {
  const box = $('#recognize-results');
  if (!results.length) {
    box.innerHTML = '<div class="callout warn">没有在截图里识别到游戏，可以换一张更清晰的截图，或者用「手动添加」。</div>';
    return;
  }
  const today = toDateInput(new Date().toISOString());
  const confText = { high: '把握很大', medium: '比较确定', low: '不太确定' };
  box.innerHTML = `
    <div class="muted" style="margin-bottom:8px">识别到 ${results.length} 款游戏，确认无误后加入收藏：</div>
    ${results
      .map((r, i) => {
        const rel = releaseInfo(r);
        return `
      <div class="result" data-i="${i}">
        <input type="checkbox" ${r.existing ? '' : 'checked'} data-check />
        <div class="cover">${coverHtml(r)}</div>
        <div>
          <h4>${esc(r.name)}</h4>
          ${r.nameEn && r.nameEn !== r.name ? `<div class="muted">${esc(r.nameEn)}</div>` : ''}
          <div class="evidence"><span class="conf-${r.ai.confidence}">● ${confText[r.ai.confidence] || ''}</span> · ${esc(r.ai.evidence)}</div>
          <dl class="kv" style="margin-top:8px">
            <dt>发售</dt><dd class="${rel.soon ? 'soon' : ''}">${esc(rel.label)}${rel.soon ? '（未发售）' : ''}</dd>
            <dt>Steam</dt><dd>${r.steamAppId ? `<a href="https://store.steampowered.com/app/${r.steamAppId}/" target="_blank" rel="noopener">${r.steamAppId} ↗</a>` : '<span class="muted">未找到</span>'}
              ${r.candidates?.length ? ` <select data-candidate style="padding:2px 6px;font-size:12px"><option value="">换一个匹配…</option>${r.candidates.map((c) => `<option value="${c.steamAppId}">${esc(c.name)} (${c.steamAppId})</option>`).join('')}</select>` : ''}
            </dd>
            ${r.existing ? `<dt>提示</dt><dd class="soon">库里已有「${esc(r.existing.name)}」（${{ installed: '已安装', downloaded: '已下载' }[r.existing.status] || '已收藏'}），勾选后只会附加截图</dd>` : ''}
          </dl>
          <div class="fields">
            <label class="field">名称 <input data-name value="${esc(r.name)}" /></label>
            <label class="field">收藏日期 <input type="date" data-fav value="${today}" /></label>
          </div>
        </div>
      </div>`;
      })
      .join('')}
    <div class="row end" style="margin-top:12px"><button class="btn primary" id="btn-confirm">加入收藏</button></div>`;

  box.onchange = (e) => {
    const row = e.target.closest('.result');
    if (e.target.matches('[data-check]')) row.classList.toggle('disabled', !e.target.checked);
    if (e.target.matches('[data-candidate]') && e.target.value) {
      const r = results[row.dataset.i];
      const appId = Number(e.target.value);
      // 换匹配后清掉旧的 Steam 数据，加入后由服务端重新补全
      Object.assign(r, { steamAppId: appId, headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`, release: null, nameEn: null, description: '', developers: [], genres: [], price: null, relink: true });
      row.querySelector('.cover').innerHTML = coverHtml(r);
      toast('已更换匹配，加入后会自动刷新信息');
    }
  };
  $$('.result', box).forEach((row) => row.classList.toggle('disabled', !row.querySelector('[data-check]').checked));

  $('#btn-confirm').onclick = (e) =>
    withBusy(e.currentTarget, async () => {
      const items = $$('.result', box)
        .filter((row) => row.querySelector('[data-check]').checked)
        .map((row) => {
          const r = results[row.dataset.i];
          return { ...r, name: row.querySelector('[data-name]').value.trim() || r.name, favoritedAt: fromDateInput(row.querySelector('[data-fav]').value), existingId: r.existing?.id };
        });
      if (!items.length) throw new Error('请至少勾选一款游戏');
      const { added } = await api('POST', '/api/wishlist', { items, screenshots });
      // 更换过匹配的条目，加入后刷新一次 Steam 信息
      for (const [i, item] of items.entries()) {
        if (item.relink && added[i]) api('POST', `/api/games/${added[i].id}/link-steam`, { steamAppId: item.steamAppId }).then(upsert).catch(() => {});
      }
      added.forEach(upsert);
      toast(`已加入收藏：${added.map((g) => g.name).join('、')}`, 'success');
      state.shots = [];
      renderShots();
      box.innerHTML = '';
      $('#dlg-upload').close();
      state.tab = 'wishlist';
      state.sort = TAB_DEFAULT_SORT.wishlist;
      $('#sort').value = state.sort;
      render();
    });
}

// ---------- 手动添加 ----------

function openAdd() {
  const form = $('#form-add');
  form.reset();
  form.favoritedAt.value = toDateInput(new Date().toISOString());
  $('#add-results').innerHTML = '';
  $('#dlg-add').showModal();
  $('#add-q').focus();
}

async function addSearch() {
  const q = $('#add-q').value.trim();
  if (!q) return;
  $('#add-results').innerHTML = '<div class="muted">搜索中…</div>';
  try {
    $('#add-results').innerHTML = steamPickHtml(await api('GET', '/api/steam/search?q=' + encodeURIComponent(q)));
  } catch (err) {
    $('#add-results').innerHTML = '';
    toast(err.message, 'error');
  }
}

// ---------- 设置 ----------

function folderListHtml(list, key, action = '移除') {
  if (!list.length) return '<div class="muted">还没有链接</div>';
  return list.map((p, i) => `<div class="folder-item"><span class="mono">${esc(p)}</span><button class="btn small ${action === '移除' ? 'danger' : ''}" data-remove="${key}:${i}">${action}</button></div>`).join('');
}

function renderSettings() {
  const s = state.settings;
  const sync = state.sync || {};
  $('#settings-body').innerHTML = `
    <div class="section">
      <h3>账号</h3>
      <div class="row">
        <span class="grow">已登录：<b>${esc(state.user?.email || '')}</b><br/><span class="hint">这台电脑：${esc(sync.deviceName || '')} · ${sync.error ? `<span style="color:var(--red)">同步出错：${esc(sync.error)}</span>` : sync.pending ? `有 ${sync.pending} 项改动等待同步` : sync.lastSync ? `已同步 ${esc(fmtDate(sync.lastSync))} ${new Date(sync.lastSync).toLocaleTimeString()}` : '尚未同步'}</span></span>
        <button class="btn small" data-settings="account-edit">修改邮箱 / 密码</button>
        <button class="btn small danger" data-settings="signout">退出登录</button>
      </div>
      <div class="hint">收藏、品鉴、自选封面、备注、API Key 都跟着账号走，所有电脑和网页版共享；文件夹按电脑分别列在下面。</div>
    </div>
    <div class="section">
      <div class="row"><h3 class="grow">电脑与文件夹</h3><button class="btn small" data-settings="scan-all">⟳ 扫描所有电脑</button></div>
      <div class="hint">账号下每台电脑链接的文件夹都在这里，在任何一台电脑（或网页版）上都能移除。添加文件夹要在那台电脑自己的 Steamless 里操作。</div>
      <div id="devices-box"><div class="muted">读取中…</div></div>
    </div>
    <div class="section" data-desktop-only>
      <h3>选项</h3>
      <label class="row"><input type="checkbox" data-settings="autoscan" ${s.autoScanOnStart ? 'checked' : ''} /> 启动时自动扫描文件夹</label>
      <div class="row">
        <span class="grow">主题</span>
        <select data-settings="theme">
          <option value="dark" ${document.documentElement.dataset.theme !== 'light' ? 'selected' : ''}>深色</option>
          <option value="light" ${document.documentElement.dataset.theme === 'light' ? 'selected' : ''}>浅色</option>
        </select>
      </div>
    </div>
    <div class="section" data-desktop-only>
      <h3>压缩包解压</h3>
      <div class="hint">把下载好的游戏压缩包（含 part1 / part2 分卷）放进「压缩包文件夹」，扫描后一键解压到「解压到」文件夹，解压好的游戏会自动出现在库里。</div>
      <div id="extract-box"></div>
    </div>
    <div class="section">
      <h3>截图识别</h3>
      ${state.ai
        ? `<div class="callout ok">✓ 已配置 Anthropic API Key，可以使用截图识别和联网查询发售日期。当前模型：<code>${esc(state.aiModel)}</code></div>`
        : '<div class="callout warn">还没有配置 API Key。到 <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">platform.claude.com</a> 创建一个，粘贴到下面保存即可，不用重启。</div>'}
      <div class="row">
        <input type="password" class="grow" data-apikey placeholder="${state.ai ? '更换 API Key：粘贴新的 sk-ant-…' : '粘贴 API Key：sk-ant-…'}" autocomplete="off" style="padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel)" />
        <button class="btn small" data-settings="save-key">保存</button>
        ${state.ai ? '<button class="btn small danger" data-settings="clear-key">清除</button>' : ''}
      </div>
      <div class="hint">Key 保存在你的账号里，你登录的所有电脑和网页版都用这一个。保存后<b>任何设备都读不出来</b>（包括你自己），只有服务器端的识别服务能用它；建议在 platform.claude.com 给这个 Key 设置每月消费上限。</div>
    </div>
    <div class="section">
      <h3>版本与更新</h3>
      <div id="update-box">${updateHtml()}</div>
    </div>
    <div class="section" data-desktop-only>
      <h3>数据</h3>
      <div class="hint">游戏库、收藏截图和自选封面保存在你的账号里（云端），这台电脑上有一份缓存，断网也能用；API Key 只保存在这台电脑。</div>
      <div class="row">
        <a class="btn small" href="/api/export" download>⬇ 导出备份</a>
        <label class="btn small">⬆ 从备份恢复<input type="file" accept="application/json" data-settings="import" hidden /></label>
        <button class="btn small" data-settings="refresh-releases">⟳ 刷新所有收藏的发售信息</button>
      </div>
    </div>`;
  loadDevices();
  renderExtract();
}

// ---------- 压缩包解压 ----------

const ex = { groups: null, jobs: [], engine: null, timer: null, error: '', pwEditor: null };

const exActive = (j) => j && ['queued', 'running'].includes(j.status);

function renderExtract() {
  const box = $('#extract-box');
  if (!box) return;
  // 密码框里正在输入时不要重绘，免得清掉输入
  if (box.contains(document.activeElement) && document.activeElement.matches('input[type=password],textarea')) return;
  const s = state.settings;
  const jobBy = Object.fromEntries(ex.jobs.map((j) => [j.id, j]));
  const folderRow = (key, label) => `
    <div class="row"><span style="width:90px">${label}</span>
      <span class="grow mono">${s[key] ? esc(s[key]) : '<span class="muted">未设置</span>'}</span>
      <button class="btn small" data-settings="ex-pick:${key}">选择…</button>
      ${s[key] ? `<button class="btn small danger" data-settings="ex-clear-folder:${key}">清除</button>` : ''}
    </div>`;
  const busy = ex.jobs.some(exActive);
  const rows = (ex.groups || [])
    .map((g) => {
      const j = jobBy[g.id];
      const bar = j && j.status !== 'cancelled'
        ? `<div class="ex-bar ${j.status}"><div style="width:${j.status === 'done' ? 100 : j.percent}%"></div></div>
           <div class="hint">${j.status === 'running' ? `${j.percent}% · ` : ''}${esc(j.message)}${j.target ? ` → <span class="mono">${esc(j.target)}</span>` : ''}</div>`
        : '';
      const pw = j?.status === 'needs-password'
        ? `<div class="row"><input type="password" class="grow" data-ex-pw="${g.id}" placeholder="输入解压密码" autocomplete="off" style="padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel)" />
            <label class="hint"><input type="checkbox" data-ex-remember="${g.id}" checked /> 记住</label>
            <button class="btn small primary" data-settings="ex-retry:${g.id}">重试</button></div>`
        : '';
      const locked = g.missing.length || exActive(j) || j?.status === 'done';
      return `<div class="ex-item">
        <div class="row"><input type="checkbox" data-ex-check="${g.id}" ${locked ? 'disabled' : 'checked'} />
          <b class="grow">${esc(g.name)}</b>
          <span class="hint">${g.partCount > 1 ? `${g.partCount} 个分卷 · ` : ''}${fmtSize(g.size)}</span>
          ${exActive(j) ? `<button class="btn small danger" data-settings="ex-cancel:${g.id}">取消</button>` : ''}
        </div>
        ${g.missing.length ? `<div class="hint" style="color:var(--red)">缺少分卷：${esc(g.missing.join('、'))}，补齐后重新扫描</div>` : ''}
        ${bar}${pw}
      </div>`;
    })
    .join('');
  box.innerHTML = `
    ${folderRow('archiveFolder', '压缩包文件夹')}
    ${folderRow('extractFolder', '解压到')}
    ${ex.engine && !ex.engine.rar ? '<div class="callout warn">没检测到系统安装的 7-Zip：自带的解压程序支持 zip / 7z / tar，<b>RAR 需要安装 <a href="https://7-zip.org" target="_blank" rel="noopener">7-Zip</a></b>。</div>' : ''}
    ${ex.error ? `<div class="callout warn">${esc(ex.error)}</div>` : ''}
    <div class="row">
      <button class="btn small" data-settings="ex-scan" ${s.archiveFolder ? '' : 'disabled'}>🔍 扫描压缩包</button>
      <button class="btn small primary" data-settings="ex-start" ${ex.groups?.length && s.extractFolder && !busy ? '' : 'disabled'}>▶ 解压选中的</button>
      ${ex.jobs.some((j) => !exActive(j)) ? '<button class="btn small" data-settings="ex-clear">清除已完成</button>' : ''}
      <button class="btn small" data-settings="ex-passwords">🔑 常用密码…</button>
    </div>
    ${ex.pwEditor !== null ? `<div class="callout">
      <div class="hint">常用解压密码，每行一个。解压时先试无密码，再依次试这些；只保存在这台电脑。</div>
      <textarea data-ex-pwlist rows="4" style="width:100%;margin:6px 0;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:inherit;font-family:inherit;box-sizing:border-box">${esc(ex.pwEditor)}</textarea>
      <div class="row"><button class="btn small primary" data-settings="ex-passwords-save">保存</button><button class="btn small" data-settings="ex-passwords-cancel">取消</button></div>
    </div>` : ''}
    ${s.extractFolder ? '<div class="hint">「解压到」文件夹不参与扫描：要让解压出来的游戏进入库里，请先把它链接到上面的「其他下载位置」。</div>' : '<div class="hint">先选择「解压到」文件夹。</div>'}
    ${ex.groups ? rows || '<div class="muted">压缩包文件夹里没有找到压缩包</div>' : ''}`;
}

// 每次解压前都问一下：解压成功后要不要删除压缩包（多个分卷一起删）。返回 true / false，取消返回 null
function askDeleteArchives(count) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.innerHTML = `
      <div class="dialog-body" style="padding:20px">
        <h2 style="margin:0 0 8px;font-size:18px">解压${count > 1 ? ` ${count} 个压缩包` : ''}</h2>
        <div class="muted" style="margin-bottom:16px">解压成功后，要删除压缩包吗？${count > 1 ? '' : '（有多个分卷时会一起删除）'}<br/>解压失败或被取消时不会删除。</div>
        <div class="row" style="justify-content:flex-end;gap:8px">
          <button class="btn" data-choice="cancel">取消</button>
          <button class="btn" data-choice="keep">保留压缩包</button>
          <button class="btn primary" data-choice="delete">解压后删除</button>
        </div>
      </div>`;
    let result = null;
    dlg.addEventListener('click', (e) => {
      const c = e.target.closest('[data-choice]')?.dataset.choice;
      if (!c) return;
      result = c === 'delete' ? true : c === 'keep' ? false : null;
      dlg.close();
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

// 开始解压：新开始的先问是否删除压缩包；输入密码重试时沿用上次的选择
async function startExtract(btn, ids, { password = '', remember = false, retry = false } = {}) {
  ex.deleteChoice ??= {};
  let deleteAfter = retry ? ex.deleteChoice[ids[0]] : undefined;
  if (deleteAfter === undefined) {
    deleteAfter = await askDeleteArchives(ids.length);
    if (deleteAfter === null) return;
  }
  for (const id of ids) ex.deleteChoice[id] = deleteAfter;
  return withBusy(btn, async () => {
    ex.error = '';
    await api('POST', '/api/extract/start', { ids, password, remember: Boolean(remember), deleteAfter });
    await pollExtract();
  });
}

async function pollExtract() {
  clearTimeout(ex.timer);
  try {
    const wasBusy = ex.jobs.some(exActive);
    const r = await api('GET', '/api/extract/jobs');
    ex.jobs = r.jobs;
    renderExtract();
    const og = state.games.find((x) => x.id === state.openId);
    if (og) renderDrawerArchives(og);
    if (r.busy) {
      ex.timer = setTimeout(pollExtract, 500);
    } else if (wasBusy) {
      drawerArch.at = 0;
      await load();
      const n = r.jobs.filter((j) => j.status === 'done').length;
      toast(n ? `解压完成 ${n} 个，已加入游戏库` : '解压结束', n ? 'success' : 'info', 5000);
    }
  } catch (err) {
    ex.error = err.message;
    renderExtract();
  }
}

async function onExtractClick(action, el) {
  const cmd = action.split(':')[0];
  const arg = action.slice(cmd.length + 1);
  const saveFolder = (patch) => {
    state.foldersChanged = true;
    return saveFolders(patch);
  };
  if (cmd === 'ex-pick') {
    return withBusy(el, async () => {
      const { path } = await api('POST', '/api/pick-folder', { description: arg === 'archiveFolder' ? '选择存放压缩包的文件夹' : '选择解压到的文件夹（游戏会解压到这里）' });
      if (path) await saveFolder({ [arg]: path });
    });
  }
  if (cmd === 'ex-clear-folder') return withBusy(el, () => saveFolder({ [arg]: '' }));
  if (cmd === 'ex-scan') {
    return withBusy(el, async () => {
      ex.error = '';
      const r = await api('GET', '/api/extract/scan');
      ex.groups = r.groups;
      ex.engine = r.engine;
      await pollExtract();
    });
  }
  if (cmd === 'ex-start' || cmd === 'ex-retry') {
    const ids = cmd === 'ex-retry' ? [arg] : [...document.querySelectorAll('[data-ex-check]:checked')].map((c) => c.dataset.exCheck);
    if (!ids.length) return toast('请先勾选要解压的压缩包', 'error');
    const pwInput = cmd === 'ex-retry' ? document.querySelector(`[data-ex-pw="${arg}"]`) : null;
    if (cmd === 'ex-retry' && !pwInput?.value) return toast('请输入密码', 'error');
    const remember = cmd === 'ex-retry' && document.querySelector(`[data-ex-remember="${arg}"]`)?.checked;
    return startExtract(el, ids, { password: pwInput?.value || '', remember, retry: cmd === 'ex-retry' });
  }
  if (cmd === 'ex-cancel') {
    return withBusy(el, async () => {
      await api('POST', '/api/extract/cancel', { id: arg });
      await pollExtract();
    });
  }
  if (cmd === 'ex-clear') {
    return withBusy(el, async () => {
      ex.jobs = (await api('POST', '/api/extract/clear')).jobs;
      renderExtract();
    });
  }
  if (cmd === 'ex-passwords') {
    return withBusy(el, async () => {
      ex.pwEditor = (await api('GET', '/api/extract/passwords')).passwords.join('\n');
      renderExtract();
      document.querySelector('[data-ex-pwlist]')?.focus();
    });
  }
  if (cmd === 'ex-passwords-cancel') {
    ex.pwEditor = null;
    return renderExtract();
  }
  if (cmd === 'ex-passwords-save') {
    return withBusy(el, async () => {
      await api('PUT', '/api/extract/passwords', { passwords: document.querySelector('[data-ex-pwlist]').value });
      ex.pwEditor = null;
      renderExtract();
      toast('已保存', 'success');
    });
  }
}

// ---------- 电脑与文件夹 ----------

async function loadDevices() {
  try {
    state.devices = await api('GET', '/api/devices');
  } catch (err) {
    state.devices = [];
    const box = $('#devices-box');
    if (box) box.innerHTML = `<div class="callout warn">读取电脑列表失败：${esc(err.message)}</div>`;
    return;
  }
  renderDevices();
}

function renderDevices() {
  const box = $('#devices-box');
  if (!box) return;
  const devices = [...(state.devices || [])].sort((a, b) => Number(b.isThis) - Number(a.isThis));
  state.devicesSorted = devices;
  if (!devices.length) {
    box.innerHTML = '<div class="muted">还没有电脑。在电脑上安装 Steamless 并登录这个账号后，就会出现在这里。</div>';
    return;
  }
  const folderRows = (d, i, kind, list) =>
    list.length
      ? list.map((f, j) => `<div class="folder-item"><span class="mono">${esc(f)}</span><button class="btn small danger" data-settings="unlink:${i}:${kind}:${j}">移除</button></div>`).join('')
      : '<div class="muted" style="font-size:12px">没有</div>';
  const manual = (key, ph) =>
    `<input class="grow" data-manual="${key}" placeholder="${ph}" style="padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel)" />`;
  box.innerHTML = devices
    .map((d, i) => {
      const seen = d.lastSeen ? `最近同步 ${fmtDate(d.lastSeen)} ${new Date(d.lastSeen).toLocaleTimeString()}` : '';
      return `
      <div class="device-card ${d.isThis ? 'this' : ''}">
        <div class="row">
          <b class="grow">💻 ${esc(d.name)}${d.isThis ? ' <span class="chip">这台电脑</span>' : ''}</b>
          <span class="hint">${seen}</span>
          <button class="btn small" data-settings="scan-device:${i}">${d.isThis ? '扫描' : '让它扫描'}</button>
        </div>
        <div class="device-sub">Steam 库（steamapps 文件夹）</div>
        <div class="folder-list">${folderRows(d, i, 'steam', d.settings.steamLibraries || [])}</div>
        ${d.isThis ? `<div class="row">
          <button class="btn small" data-settings="detect">🔍 自动检测</button>
          <button class="btn small" data-settings="pick:steamLibraries">＋ 选择文件夹…</button>
          ${manual('steamLibraries', '或粘贴路径后回车，如 D:\\SteamLibrary\\steamapps')}
        </div>` : ''}
        <div class="device-sub">其他下载位置 <span class="hint">（每个子文件夹算一款游戏，支持网络共享文件夹）</span></div>
        <div class="folder-list">${folderRows(d, i, 'local', d.settings.localFolders || [])}</div>
        ${d.isThis ? `<div id="folder-suggestions"></div>
        <div class="row">
          <button class="btn small" data-settings="pick:localFolders">＋ 选择文件夹…</button>
          ${manual('localFolders', '或粘贴路径后回车，如 D:\\Games')}
        </div>` : ''}
      </div>`;
    })
    .join('');
  if (devices.some((d) => d.isThis)) loadFolderSuggestions();
}

// 其他电脑链接过、这台电脑也能访问的网络共享文件夹
async function loadFolderSuggestions() {
  try {
    state.folderSuggestions = await api('GET', '/api/folder-suggestions');
  } catch {
    state.folderSuggestions = [];
  }
  const box = $('#folder-suggestions');
  if (!box || !state.folderSuggestions.length) return;
  box.innerHTML = `<div class="callout">💡 其他电脑链接了这些网络文件夹，这台电脑也能访问。链接后，里面的游戏在这台电脑上也能直接启动：
    ${state.folderSuggestions
      .map((f, i) => `<div class="folder-item" style="margin-top:6px"><span class="mono">${esc(f.path)}</span><span class="muted">来自 ${esc(f.deviceName)}</span><button class="btn small primary" data-settings="link-suggested:${i}">链接到这台电脑</button></div>`)
      .join('')}</div>`;
}

async function saveFolders(patch) {
  if (patch.steamLibraries || patch.localFolders || patch.ignoredPaths) state.foldersChanged = true;
  const { notices = [], ...settings } = await api('PUT', '/api/settings', patch);
  state.settings = settings;
  notices.forEach((n) => toast(n, 'info', 8000));
  renderSettings();
}

async function onSettingsClick(e) {
  const el = e.target.closest('[data-settings],[data-remove]');
  if (!el) return;
  const s = state.settings;
  const action = el.dataset.settings;
  if (action?.startsWith('ex-')) return onExtractClick(action, el);
  if (el.dataset.settings?.startsWith('unlink:')) {
    const [, i, kind, j] = el.dataset.settings.split(':');
    const d = state.devicesSorted?.[Number(i)];
    const folder = d?.settings[kind === 'steam' ? 'steamLibraries' : 'localFolders']?.[Number(j)];
    if (!folder) return;
    const where = d.isThis ? '这台电脑' : `「${d.name}」`;
    if (!confirm(`从${where}移除这个文件夹？\n${folder}\n\n这个文件夹里的游戏会从${where}的记录里去掉；你品鉴过、收藏过、写过备注的游戏会保留。游戏文件本身不会被删除。`)) return;
    return withBusy(el, async () => {
      const r = await api('POST', '/api/devices/unlink', { deviceId: d.deviceId, folder, kind });
      state.devices = r.devices;
      renderDevices();
      await load();
      toast(r.removed ? `已移除，清理了 ${r.removed} 款游戏` : '已移除', 'success');
    });
  }
  if (el.dataset.settings?.startsWith('scan-device:')) {
    const d = state.devicesSorted?.[Number(el.dataset.settings.split(':')[1])];
    if (!d) return;
    if (d.isThis) return scan(el);
    return withBusy(el, async () => {
      await api('POST', '/api/devices/request-scan', { deviceId: d.deviceId });
      toast(`已通知「${d.name}」扫描：它开着 Steamless 的话，一分钟内会完成`, 'success', 6000);
    });
  }
  if (action === 'scan-all') {
    return withBusy(el, async () => {
      const r = await api('POST', '/api/scan-all');
      await load();
      toast(r.requested === false ? '这台电脑已扫描完成（通知其他电脑失败，可能需要先更新数据库）' : '已扫描这台电脑，并通知其他电脑扫描（开着 Steamless 的电脑一分钟内完成）', 'success', 7000);
    });
  }
  if (el.dataset.settings?.startsWith('link-suggested:')) {
    const f = state.folderSuggestions?.[Number(el.dataset.settings.split(':')[1])];
    if (!f) return;
    return withBusy(el, async () => {
      await saveFolders({ localFolders: [...s.localFolders, f.path] });
      toast('已链接，关闭设置窗口后会自动扫描', 'success');
    });
  }
  if (el.dataset.remove) {
    const [key, i] = el.dataset.remove.split(':');
    return withBusy(el, () => saveFolders({ [key]: s[key].filter((_, idx) => idx !== Number(i)) }));
  }
  if (action === 'detect') {
    return withBusy(el, async () => {
      const { libraries } = await api('GET', '/api/steam/detect');
      if (!libraries.length) throw new Error('没有检测到 Steam，请手动选择 steamapps 文件夹');
      await saveFolders({ steamLibraries: [...new Set([...s.steamLibraries, ...libraries])] });
      toast(`检测到 ${libraries.length} 个 Steam 库`, 'success');
    });
  }
  if (action.startsWith('pick:')) {
    const key = action.slice(5);
    return withBusy(el, async () => {
      const { path } = await api('POST', '/api/pick-folder', { description: key === 'steamLibraries' ? '选择 steamapps 文件夹' : '选择存放游戏的文件夹' });
      if (path) await saveFolders({ [key]: [...s[key], path] });
    });
  }
  if (action === 'save-key' || action === 'clear-key') {
    const input = $('[data-apikey]');
    const apiKey = action === 'save-key' ? input.value.trim() : '';
    if (action === 'save-key' && !apiKey) return toast('请先粘贴 API Key', 'error');
    if (action === 'clear-key' && !confirm('确定清除这台电脑上保存的 API Key 吗？')) return;
    return withBusy(el, async () => {
      const r = await api('PUT', '/api/settings/api-key', { apiKey });
      state.ai = r.ai;
      renderSettings();
      toast(apiKey ? '已保存，截图识别可以用了' : '已清除 API Key', 'success');
    });
  }
  if (action === 'check-update') {
    return withBusy(el, async () => {
      state.update = await api('POST', '/api/app/update/check');
      await refreshUpdateInfo();
    });
  }
  if (action === 'install-update') {
    toast('正在安装新版本，Steamless 会关闭几秒钟，然后自动重新打开', 'success', 8000);
    return withBusy(el, () => api('POST', '/api/app/update/install'));
  }
  if (action === 'account-edit') return toggleAccountForm(el);
  if (action === 'account-save') return saveAccount(el);
  if (action === 'signout') {
    $('#dlg-settings').close();
    return signOut(el);
  }
  if (action === 'refresh-releases') {
    return withBusy(el, async () => {
      const r = await api('POST', '/api/refresh-releases', { force: true });
      await load();
      toast(`已检查 ${r.checked} 款${r.nowReleased.length ? `，新发售：${r.nowReleased.join('、')}` : ''}`, 'success', 6000);
    });
  }
}

async function onSettingsChange(e) {
  const el = e.target;
  if (el.dataset.settings === 'autoscan') {
    await withBusy(null, () => saveFolders({ autoScanOnStart: el.checked }));
  } else if (el.dataset.settings === 'theme') {
    document.documentElement.dataset.theme = el.value;
    prefs.set('theme', el.value);
  } else if (el.dataset.settings === 'import' && el.files[0]) {
    if (!confirm('从备份恢复会覆盖当前的全部数据，确定吗？')) return;
    await withBusy(null, async () => {
      const data = JSON.parse(await el.files[0].text());
      const r = await api('POST', '/api/import', data);
      await load();
      renderSettings();
      toast(`已恢复 ${r.games} 款游戏`, 'success');
    });
  }
}

async function onSettingsKey(e) {
  const el = e.target;
  if (e.key !== 'Enter' || !el.dataset.manual) return;
  const key = el.dataset.manual;
  const value = el.value.trim().replace(/^"|"$/g, '');
  if (!value) return;
  await withBusy(null, () => saveFolders({ [key]: [...state.settings[key], value] }));
}

async function scan(btn) {
  if (window.STEAMLESS_WEB) {
    return withBusy(btn, async () => {
      await api('POST', '/api/scan-all');
      toast('已通知所有电脑扫描：开着 Steamless 的电脑一分钟内完成，结果会自动同步过来', 'success', 7000);
      setTimeout(() => load().catch(() => {}), 60000);
    });
  }
  await withBusy(btn, async () => {
    const r = await api('POST', '/api/scan');
    await load();
    const parts = [];
    if (r.added.length) parts.push(`新增 ${r.added.length} 款`);
    if (r.installed.length) parts.push(`收藏中已安装：${r.installed.join('、')}`);
    if (r.missing.length) parts.push(`${r.missing.length} 款文件夹缺失`);
    if (r.removed?.length) parts.push(`移除了 ${r.removed.length} 个不是游戏的文件夹`);
    if (r.unreachable?.length) toast(`无法访问：${r.unreachable.join('、')}（网络盘没连上？）`, 'error', 8000);
    toast(parts.length ? `扫描完成：${parts.join('，')}` : '扫描完成，没有变化', 'success', 6000);
  });
}

// ---------- 事件绑定 ----------

function bind() {
  $('#verdict-filter').onclick = (e) => {
    const b = e.target.closest('button[data-verdict]');
    if (!b) return;
    state.verdictFilter = b.dataset.verdict;
    render();
  };
  $('#tabs').onclick = (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    // “全部”沿用用户上次的选择；其它分类每次点击都回到各自的默认排序
    state.sort = state.tab === 'all' ? prefs.get('sort', 'recent') : TAB_DEFAULT_SORT[state.tab] || 'recent';
    if (state.tab === 'rated' && !state.verdictFilter) state.verdictFilter = 'great';
    $('#sort').value = state.sort;
    render();
  };
  $('#search').oninput = (e) => {
    state.query = e.target.value;
    render();
  };
  $('#filter-source').onchange = (e) => {
    state.source = e.target.value;
    render();
  };
  $('#sort').onchange = (e) => {
    state.sort = e.target.value;
    if (state.tab === 'all') prefs.set('sort', state.sort);
    render();
  };
  $('#btn-view').onclick = () => {
    state.view = state.view === 'grid' ? 'list' : 'grid';
    $('#btn-view').textContent = state.view === 'grid' ? '▦' : '☰';
    prefs.set('view', state.view);
    render();
  };

  // 右键卡片：快速品鉴 / 启动 / 换封面
  $('#grid').oncontextmenu = (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    const g = state.games.find((x) => x.id === card.dataset.id);
    if (g) openContextMenu(g, e.clientX, e.clientY);
  };
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#ctx-menu')) closeContextMenu();
  });
  window.addEventListener('blur', closeContextMenu);
  window.addEventListener('resize', closeContextMenu);
  document.addEventListener('scroll', closeContextMenu, true);

  $('#grid').onclick = (e) => {
    if (e.target.closest('[data-stop]')) return;
    const card = e.target.closest('.card');
    if (!card) return;
    const g = state.games.find((x) => x.id === card.dataset.id);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'launch') return launch(g, e.target.closest('button'));
    if (act === 'folder') return withBusy(null, () => api('POST', `/api/games/${g.id}/open-folder`));
    openDrawer(g.id);
  };
  $('#empty').onclick = (e) => {
    const k = e.target.closest('[data-empty]')?.dataset.empty;
    if (k === 'upload') openUpload();
    if (k === 'settings') $('#btn-settings').click();
  };

  // 抽屉
  $('#drawer-mask').onclick = closeDrawer;
  $('#drawer').addEventListener('click', (e) => {
    if (onCoverPickerEvent(e)) return;
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) {
      const lb = document.createElement('div');
      lb.className = 'lightbox';
      lb.innerHTML = `<img src="${zoom.src}" alt="" />`;
      lb.onclick = () => lb.remove();
      document.body.append(lb);
      return;
    }
    const verdictBtn = e.target.closest('[data-verdict-set]');
    if (verdictBtn) {
      const g = state.games.find((x) => x.id === state.openId);
      const v = verdictBtn.dataset.verdictSet;
      return withBusy(verdictBtn, async () => {
        await patchGame(g.id, { verdict: g.verdict === v ? null : v });
        toast(g.verdict === v ? `已品鉴：${VERDICTS[v].icon} ${VERDICTS[v].label}` : '已取消品鉴', 'success', 1800);
      });
    }
    const tag = e.target.closest('[data-tag]');
    if (tag) {
      const g = state.games.find((x) => x.id === state.openId);
      return withBusy(null, () => patchGame(g.id, { tags: g.tags.filter((_, i) => i !== Number(tag.dataset.tag)) }));
    }
    const btn = e.target.closest('[data-act]');
    if (btn) onDrawerAction(btn.dataset.act, btn);
  });
  $('#drawer').addEventListener('change', (e) => {
    if (onCoverPickerEvent(e)) return;
    const el = e.target.closest('[data-field]');
    if (!el) return;
    const field = el.dataset.field;
    let value = el.value;
    if ('date' in el.dataset) value = fromDateInput(value);
    if (field === 'rating') value = value ? Number(value) : null;
    if (field === 'name' && !value.trim()) return toast('名称不能为空', 'error');
    withBusy(null, async () => {
      await patchGame(state.openId, { [field]: value });
      toast('已保存', 'success', 1500);
    });
  });
  $('#drawer').addEventListener('keydown', (e) => {
    if (e.target.id !== 'tag-input' || e.key !== 'Enter') return;
    const v = e.target.value.trim();
    const g = state.games.find((x) => x.id === state.openId);
    if (!v || g.tags?.includes(v)) return;
    withBusy(null, () => patchGame(g.id, { tags: [...(g.tags || []), v] }));
  });

  // 截图
  $('#btn-upload').onclick = openUpload;
  $('#file-input').onchange = (e) => {
    addShots(e.target.files);
    e.target.value = '';
  };
  const dz = $('#dropzone');
  dz.ondragover = (e) => {
    e.preventDefault();
    dz.classList.add('over');
  };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    addShots(e.dataTransfer.files);
  };
  $('#btn-clear-shots').onclick = () => {
    state.shots = [];
    renderShots();
    $('#recognize-results').innerHTML = '';
  };
  $('#btn-recognize').onclick = (e) => recognize(e.currentTarget);

  // 在任何地方 Ctrl+V 粘贴截图都会打开识别窗口
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    // 封面选择器打开时，粘贴的图片用作封面
    if (state.coverPickerFor && state.coverPickerFor === state.openId && !$('#dlg-upload').open) return uploadCover(files[0]);
    openUpload();
    addShots(files);
  });
  // 把图片拖到页面任意位置也可以
  document.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (e.target.closest('#dropzone')) return;
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    openUpload();
    addShots(files);
  });

  // 手动添加
  $('#btn-add').onclick = openAdd;
  $('#add-q').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSearch();
    }
  };
  $('#add-results').onclick = (e) => {
    const item = e.target.closest('[data-appid]');
    if (!item) return;
    const form = $('#form-add');
    form.name.value = item.dataset.name;
    form.steamAppId.value = item.dataset.appid;
    $$('.pick-item', $('#add-results')).forEach((x) => (x.style.borderColor = x === item ? 'var(--accent)' : ''));
  };
  $('#form-add').onsubmit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    withBusy(form.querySelector('[type=submit]'), async () => {
      const game = await api('POST', '/api/games', {
        name: form.name.value,
        nameEn: form.nameEn.value,
        steamAppId: form.steamAppId.value,
        status: form.status.value,
        favoritedAt: fromDateInput(form.favoritedAt.value),
      });
      upsert(game);
      $('#dlg-add').close();
      toast(`已添加「${game.name}」，正在获取封面和发售信息…`, 'success');
      setTimeout(load, 3000);
    });
  };

  // 设置
  $('#btn-settings').onclick = () => {
    renderSettings();
    $('#dlg-settings').showModal();
    refreshUpdateInfo();
  };
  $('#settings-body').addEventListener('click', onSettingsClick);
  $('#settings-body').addEventListener('change', onSettingsChange);
  $('#settings-body').addEventListener('keydown', onSettingsKey);
  // 改过链接的文件夹，关闭设置时重新扫描
  $('#dlg-settings').addEventListener('close', () => {
    if (!state.foldersChanged) return;
    state.foldersChanged = false;
    scan($('#btn-scan'));
  });

  $('#btn-scan').onclick = (e) => scan(e.currentTarget);

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#ctx-menu')) return closeContextMenu();
    if (e.key === 'Escape' && state.openId && !document.querySelector('dialog[open]')) closeDrawer();
    if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      e.preventDefault();
      $('#search').focus();
    }
  });
}

// ---------- 修改邮箱 / 密码 ----------

function toggleAccountForm(btn) {
  const existing = $('#account-form');
  if (existing) return existing.remove();
  const box = document.createElement('div');
  box.id = 'account-form';
  box.className = 'account-form';
  box.innerHTML = `
    <div class="fields">
      <label class="field full">当前密码（必填，用来确认是你本人）<input type="password" data-acct="current" autocomplete="current-password" /></label>
      <label class="field full">新邮箱（不改就留空）<input type="email" data-acct="email" placeholder="${esc(state.user?.email || '')}" autocomplete="email" /></label>
      <label class="field">新密码（不改就留空）<input type="password" data-acct="password" autocomplete="new-password" minlength="6" /></label>
      <label class="field">再输入一次新密码<input type="password" data-acct="password2" autocomplete="new-password" /></label>
    </div>
    <div class="row end"><button class="btn small primary" data-settings="account-save">保存修改</button></div>`;
  btn.closest('.section').append(box);
  box.querySelector('[data-acct="current"]').focus();
}

async function saveAccount(btn) {
  const val = (k) => $(`[data-acct="${k}"]`).value;
  const body = { currentPassword: val('current'), newEmail: val('email').trim(), newPassword: val('password') };
  if (!body.currentPassword) return toast('请输入当前密码', 'error');
  if (!body.newEmail && !body.newPassword) return toast('请填写新邮箱或新密码', 'error');
  if (body.newPassword && body.newPassword !== val('password2')) return toast('两次输入的新密码不一样', 'error');
  await withBusy(btn, async () => {
    const r = await api('POST', '/api/auth/account', body);
    state.user = r.user;
    const parts = [];
    if (r.passwordChanged) parts.push('密码已修改');
    if (r.emailChanged) parts.push(`邮箱已改为 ${r.user.email}`);
    if (r.pendingEmail) parts.push(`确认邮件已发到 ${r.pendingEmail}，点击邮件里的链接后新邮箱才会生效`);
    renderSettings();
    toast(parts.join('；'), 'success', 8000);
  });
}

// ---------- 版本与自动更新 ----------

async function refreshUpdateInfo() {
  try {
    state.update = await api('GET', '/api/app/update');
    const box = $('#update-box');
    if (box) box.innerHTML = updateHtml();
    // 下载中时每秒刷新一次进度
    if (state.update.state === 'downloading' || state.update.state === 'checking') {
      clearTimeout(state.updateTimer);
      state.updateTimer = setTimeout(() => $('#dlg-settings').open && refreshUpdateInfo(), 1000);
    }
  } catch {
    // 忽略
  }
}

function updateHtml() {
  const u = state.update;
  if (!u) return '<div class="muted">读取中…</div>';
  if (u.mode === 'web') {
    return '<div class="row"><span class="grow">网页版 · 每次打开都是最新版本</span></div><div class="hint">网页版可以修改品鉴、封面等信息、截图收藏、管理各台电脑的文件夹；启动游戏、添加本地文件夹要在电脑上的 Steamless 里操作。</div>';
  }
  if (u.mode === 'source') {
    return `<div class="row"><span class="grow">当前版本 <b>v${esc(u.version)}</b> · 从项目文件夹运行</span></div>
      <div class="hint">改了代码直接生效（界面自动刷新，后台改动在托盘点「重新启动」），不需要自动更新。安装版会自动从 GitHub 获取新版本。</div>`;
  }
  const when = u.checkedAt ? `（${fmtDate(u.checkedAt)} ${new Date(u.checkedAt).toLocaleTimeString()} 检查）` : '';
  const status = {
    idle: '<span class="muted">还没检查过</span>',
    checking: '正在检查更新…',
    latest: `✓ 已是最新版本 <span class="muted">${when}</span>`,
    downloading: `正在下载 v${esc(u.available || '')}… ${u.progress ?? 0}%`,
    ready: `<b style="color:var(--green)">v${esc(u.available || '')} 已下载好</b>`,
    error: `<span style="color:var(--red)">检查更新失败：${esc(u.error || '')}</span>`,
  }[u.state || 'idle'];
  return `
    <div class="row">
      <span class="grow">当前版本 <b>v${esc(u.version)}</b> · ${status}</span>
      ${u.state === 'ready'
        ? '<button class="btn small primary" data-settings="install-update">重启并安装</button>'
        : `<button class="btn small" data-settings="check-update" ${u.state === 'checking' || u.state === 'downloading' ? 'disabled' : ''}>检查更新</button>`}
    </div>
    ${u.notes && (u.state === 'ready' || u.state === 'downloading') ? `<div class="callout"><b>v${esc(u.available || '')} 更新内容</b><div class="release-notes">${esc(u.notes)}</div></div>` : ''}
    <div class="hint">启动时和之后每 4 小时自动检查；新版本在后台下载好后，点「重启并安装」即可：自动安装并重新打开，不用做任何操作；不点的话下次退出时自动安装。</div>`;
}

// ---------- 右键菜单 ----------

function closeContextMenu() {
  $('#ctx-menu')?.remove();
}

function openContextMenu(g, x, y) {
  closeContextMenu();
  const names = displayNames(g);
  const item = (act, label, extra = '') => `<button type="button" data-ctx="${act}" ${extra}>${label}</button>`;
  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  menu.className = 'ctx-menu';
  menu.innerHTML = `
    <div class="ctx-title" title="${esc(names.primary)}">${esc(names.primary)}${names.secondary ? `<small>${esc(names.secondary)}</small>` : ''}</div>
    <div class="ctx-label">品鉴</div>
    ${Object.entries(VERDICTS)
      .map(([k, v]) => item(`verdict:${k}`, `<span class="ctx-check">${g.verdict === k ? '✓' : ''}</span>${v.icon} ${v.label}`, `class="verdict-item verdict-${k}${g.verdict === k ? ' on' : ''}"`))
      .join('')}
    ${g.verdict ? item('verdict:', '<span class="ctx-check"></span>取消品鉴') : ''}
    ${g.status === 'wishlist' ? `<div class="ctx-sep"></div>${item('musthave', `<span class="ctx-check">${isMustHave(g) ? '✓' : ''}</span>⭐ 特别想要`)}` : ''}
    <div class="ctx-sep"></div>
    ${canPlayHere(g) ? item('launch', '<span class="ctx-check"></span>▶ 启动游戏') : ''}
    ${g.installPath ? item('folder', '<span class="ctx-check"></span>📁 打开文件夹') : ''}
    ${steamUrl(g) ? item('steam', '<span class="ctx-check"></span>Steam 商店页 ↗') : ''}
    ${item('cover', '<span class="ctx-check"></span>🖼 更换封面')}
    ${item('details', '<span class="ctx-check"></span>查看详情')}`;
  document.body.append(menu);
  // 靠近屏幕边缘时往里收
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;

  menu.onclick = async (e) => {
    const act = e.target.closest('[data-ctx]')?.dataset.ctx;
    if (!act) return;
    closeContextMenu();
    if (act.startsWith('verdict:')) {
      const v = act.slice('verdict:'.length) || null;
      await withBusy(null, async () => {
        await patchGame(g.id, { verdict: v });
        toast(v ? `「${names.primary}」${VERDICTS[v].icon} ${VERDICTS[v].label}` : `已取消「${names.primary}」的品鉴`, 'success', 1800);
      });
    } else if (act === 'musthave') {
      const on = !isMustHave(g);
      await withBusy(null, async () => {
        await patchGame(g.id, { mustHave: on });
        toast(on ? `「${names.primary}」已加入 ⭐ 特别想要` : `已把「${names.primary}」移出特别想要`, 'success', 1800);
      });
    } else if (act === 'launch') launch(g, null);
    else if (act === 'folder') withBusy(null, () => api('POST', `/api/games/${g.id}/open-folder`));
    else if (act === 'steam') window.open(steamUrl(g), '_blank', 'noopener');
    else if (act === 'details') openDrawer(g.id);
    else if (act === 'cover') {
      openDrawer(g.id);
      toggleCoverPicker(g, null);
    }
  };
}

// ---------- 账号 ----------

let authMode = 'signin';

function showAuth(message) {
  closeDrawer();
  $$('dialog[open]').forEach((d) => d.close());
  state.user = null;
  $('#auth').classList.remove('hidden');
  setAuthMode(authMode, message);
  fillRemembered();
  setTimeout(() => $('#auth-form').email.focus(), 50);
}

// 「记住我」：把上次记住的邮箱和密码填进登录框
async function fillRemembered() {
  const form = $('#auth-form');
  try {
    const { remembered } = await api('GET', '/api/auth/remembered');
    form.remember.checked = Boolean(remembered) || !form.email.value;
    if (remembered && !form.email.value) {
      form.email.value = remembered.email;
      form.password.value = remembered.password;
    }
  } catch {
    // 取不到就当没记住
  }
}

function hideAuth() {
  $('#auth').classList.add('hidden');
}

function setAuthMode(mode, message) {
  authMode = mode;
  const signup = mode === 'signup';
  $('#auth-submit').textContent = signup ? '注册' : '登录';
  $('#auth-remember-row').classList.toggle('hidden', signup);
  $('#auth-switch-text').textContent = signup ? '已经有账号了？' : '还没有账号？';
  $('#auth-switch').textContent = signup ? '登录' : '注册';
  $('#auth-form').password.autocomplete = signup ? 'new-password' : 'current-password';
  const err = $('#auth-error');
  err.classList.toggle('hidden', !message);
  err.classList.toggle('ok', Boolean(message?.ok));
  err.textContent = message?.text || message || '';
}

function bindAuth() {
  $('#auth-switch').onclick = () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = { email: form.email.value.trim(), password: form.password.value, remember: form.remember.checked };
    const btn = $('#auth-submit');
    btn.classList.add('busy');
    try {
      const r = await api('POST', authMode === 'signup' ? '/api/auth/signup' : '/api/auth/signin', body);
      if (r.needsConfirmation) {
        setAuthMode('signin', { ok: true, text: `验证邮件已发到 ${body.email}，点击邮件里的链接完成验证后，回来登录即可。` });
        return;
      }
      form.password.value = '';
      await enterApp(r);
    } catch (err) {
      setAuthMode(authMode, err.message);
    } finally {
      btn.classList.remove('busy');
    }
  };
}

async function enterApp(session) {
  state.user = session.user;
  hideAuth();
  // 这台电脑上有旧版（登录功能之前）的本地数据：问一次要不要导入到这个账号
  if (session.legacy?.games) {
    const accept = confirm(`这台电脑上有旧版 Steamless 的本地数据（${session.legacy.games} 款游戏，以及收藏截图、自选封面、文件夹设置）。\n\n要导入到当前账号（${session.user.email}）吗？\n\n选「取消」则不导入，以后也不会再问。`);
    try {
      const r = await api('POST', '/api/legacy-import', { accept });
      if (accept) toast(`已导入 ${r.count} 款游戏，正在同步到云端…`, 'success', 6000);
    } catch (err) {
      toast('导入失败：' + err.message, 'error', 8000);
    }
  }
  await load();
}

async function signOut(btn) {
  if (!confirm('确定退出登录吗？这台电脑上的数据会保留，下次登录继续使用。')) return;
  await withBusy(btn, async () => {
    await api('POST', '/api/auth/signout');
    state.games = [];
    render();
    showAuth();
  });
}

async function start() {
  try {
    const session = await api('GET', '/api/auth/session');
    if (session.user) await enterApp(session);
    else showAuth();
  } catch (err) {
    toast('加载失败：' + err.message, 'error', 8000);
  }
  // 切回窗口时拉取在其他电脑上做的改动
  window.addEventListener('focus', () => {
    if (state.user && !document.querySelector('dialog[open]')) load().catch(() => {});
  });
}

// ---------- 启动 ----------

const TAB_DEFAULT_SORT = { playing: 'played', rated: 'played', downloaded: 'downloaded', installed: 'installed', upcoming: 'release', wishlist: 'favorited', musthave: 'musthave' };

document.documentElement.dataset.theme = prefs.get('theme', 'dark');
state.sort = prefs.get('sort', 'recent');
state.view = prefs.get('view', 'grid');
$('#sort').value = state.sort;
$('#btn-view').textContent = state.view === 'grid' ? '▦' : '☰';
// 分类栏吸顶：贴在顶栏下面（顶栏在窄窗口会换行，高度要实时量），固定后加一道阴影
const topbar = $('.topbar');
new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`)).observe(topbar);
window.addEventListener('scroll', () => $('#sticky-bar').classList.toggle('stuck', window.scrollY > 4), { passive: true });

bind();
bindAuth();
start();
