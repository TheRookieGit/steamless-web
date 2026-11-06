// 网盘分享链接：从粘贴的文字里找链接和提取码，判断两条是不是同一个分享。桌面版、网页版共用，不依赖 Node。
// 游戏的 links 是一组字符串，存成 https://pan.quark.cn/s/abc?pwd=1234 这样的地址：提取码跟着链接走，心愿中枢里能直接点开。
// 中枢或 Plexus 记下的其他写法（链接后面跟着「提取码：1234」、磁力链接）原样保留。
const QUARK = /pan\.quark\.cn\/s\/([0-9A-Za-z]+)/g;
const BAIDU = /pan\.baidu\.com\/(?:s\/1([\w-]+)|share\/init\?surl=([\w-]+))/g;
const CODE = /(?:提取码|密码|访问码|pwd|passcode)\s*[:：=]?\s*([0-9A-Za-z]{4,8})/i;

function find(text) {
  const found = [
    ...[...text.matchAll(QUARK)].map((m) => [m.index, m[0].length, 'quark', m[1]]),
    ...[...text.matchAll(BAIDU)].map((m) => [m.index, m[0].length, 'baidu', m[1] || m[2]]),
  ].sort((a, b) => a[0] - b[0]);
  return found.map(([start, length, drive, id], i) => {
    const end = i + 1 < found.length ? found[i + 1][0] : text.length;
    const code = text.slice(start, end).match(CODE);
    return { start, stop: start + length, end, link: { drive, id, code: code ? code[1] : '' } };
  });
}

// 粘贴的文字里所有的分享链接，提取码写在链接后面或者 ?pwd= 里都认得
export const links = (text) => find(String(text ?? '')).map((f) => f.link);

export const hasLinks = (text) => links(text).length > 0;

export function shareUrl({ drive, id, code }) {
  const base = drive === 'quark' ? `https://pan.quark.cn/s/${id}` : `https://pan.baidu.com/s/1${id}`;
  return code ? `${base}?pwd=${code}` : base;
}

// 同一个分享的标识：换个提取码写法、前后多几个字都算同一条
export function linkKey(entry) {
  const [link] = links(entry);
  return link ? `${link.drive}:${link.id}` : String(entry ?? '').trim();
}

// 每条链接和它附近的文字（上一条链接之后到下一条链接之前），用来猜这是什么游戏
export function pasted(text) {
  text = String(text ?? '');
  const found = find(text);
  return found.map((f, i) => {
    const before = text.slice(i ? found[i - 1].stop : 0, f.start);
    return { link: f.link, url: shareUrl(f.link), context: `${before} ${text.slice(f.stop, f.end)}`.trim() };
  });
}

const clean = (list) => (Array.isArray(list) ? list : []).filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim().slice(0, 2000));

// 合并几组链接：同一个分享只留一条，带提取码的优先
export function mergeLinks(...lists) {
  const out = new Map();
  for (const entry of lists.flatMap(clean)) {
    const key = linkKey(entry);
    if (!out.has(key) || (!links(out.get(key))[0]?.code && links(entry)[0]?.code)) out.set(key, entry);
  }
  return [...out.values()].slice(0, 50);
}

// 双向同步：last 是上次同步时两边一致的内容。对方删掉、加上的照做，这里删掉、加上的也留着
export function syncLinks(mine, theirs, last) {
  if (!Array.isArray(mine)) return mergeLinks(theirs); // 这边还没有记过链接
  const here = new Set(clean(mine).map(linkKey));
  const seen = new Set(clean(last).map(linkKey));
  const removed = (l) => seen.has(linkKey(l)) && !here.has(linkKey(l));
  return mergeLinks(clean(theirs).filter((l) => !removed(l)), clean(mine).filter((l) => !seen.has(linkKey(l))));
}

export const sameLinks = (a, b) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));

const TAGS = /免安装|绿色版|绿色|中文版|简体中文|繁体中文|官方中文|中文|学习版|破解版|破解|数字豪华版|豪华版|终极版|完整版|典藏版|全\s*DLC|附\s*DLC|\+?\s*\d*\s*DLCs?|整合包|修改器|联机版|电脑版|PC版|Steam版|单机版|游戏本体|本体|安装包|压缩包|解压即玩/gi;

// 分享标题、文件名里的游戏名：去掉扩展名、方括号里的标注、版本号和「免安装」这类字样
export function cleanShareName(name) {
  const raw = String(name ?? '').trim();
  const out = raw
    .replace(/\.(zip|7z|rar|iso|exe|tar|gz|part\d+)$/i, '')
    .replace(/\[[^\]]*\]|【[^】]*】|（[^）]*）|\([^)]*\)/g, ' ')
    .replace(/(^|[\s_-])v\.?\s*\d+(\.\d+)*[a-z]?(?=$|[\s_-])/gi, ' ')
    .replace(/\b(build|ver|version)\s*\.?\s*\d+(\.\d+)*\b/gi, ' ')
    .replace(TAGS, ' ')
    .replace(/[_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:：|·.]+|[\s\-–—:：|·.]+$/g, '');
  return out || raw;
}

// 这个分享可能叫什么：「」里的名字最可靠（网盘 App 分享出来的文字都这样写），
// 其次是分享标题、链接旁边的文字、最外层的文件夹或文件名
export function guessShareName({ context = '', title = '', files = [] }) {
  const quoted = context.match(/[「『《]([^」』》]{1,80})[」』》]/);
  if (quoted) return cleanShareName(quoted[1]);
  if (title) return cleanShareName(title);
  const said = context
    .replace(/https?:\/\/\S*/g, ' ')
    .replace(/[?&]?(?:提取码|密码|访问码|pwd|passcode)\s*[:：=]?\s*[0-9A-Za-z]{4,8}/gi, ' ')
    .replace(/链接|网盘|分享|夸克|百度|[:：]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (said && said.length <= 40) return cleanShareName(said);
  return cleanShareName((files[0]?.path || '').split('/')[0]);
}
