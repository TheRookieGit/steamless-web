// 调用 Claude：截图识别、联网查发售日期、补全中英文名、中文叫法转英文名。
// 桌面版（Node）和网页版（浏览器）共用；调用方传入各自环境里的 Anthropic SDK 和这个用户的 API Key。

// 识别游戏名 / 查发售日期是简单任务，Haiku 又快又便宜
export const DEFAULT_MODEL = 'claude-haiku-5-5';

export function createAI({ Anthropic, apiKey, model = DEFAULT_MODEL, browser = false }) {
  const MODEL = model || DEFAULT_MODEL;
  const IS_HAIKU = /haiku/i.test(MODEL);
  // 被安全分类器误拦时，由服务端按类别自动换模型重试（Haiku 不支持服务端回退，不能发这个参数）
  const FALLBACK = IS_HAIKU ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
  // 带动态过滤的新版网页搜索只支持 Opus / Sonnet，其他模型用基础版（Haiku 上新版会静默搜索失败）
  const WEB_SEARCH_TYPE = /opus|sonnet|fable|mythos/i.test(MODEL) ? 'web_search_20260209' : 'web_search_20250305';
  // 浏览器里直接调用 Anthropic API 需要显式允许（Key 是用户自己的，只在他自己的浏览器里用）
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: browser });
  const getClient = () => client;

  function explainError(err) {
    if (err instanceof Anthropic.AuthenticationError) return new Error('Anthropic API Key 无效，请在设置里更新 API Key');
    if (err instanceof Anthropic.PermissionDeniedError) return new Error('这个 API Key 没有权限使用该模型或功能');
    if (err instanceof Anthropic.RateLimitError) return new Error('请求过于频繁，请稍后再试');
    if (err instanceof Anthropic.APIConnectionError) return new Error('无法连接到 Anthropic API，请检查网络/代理');
    if (err instanceof Anthropic.APIError) return new Error(`识别服务出错（${err.status ?? '未知'}）：${err.message}`);
    return err;
  }

  function checkStop(response) {
    if (response.stop_reason === 'refusal') throw new Error('识别请求被模型拒绝，请换一张截图再试');
    if (response.stop_reason === 'max_tokens') throw new Error('识别结果过长被截断，请减少一次上传的截图数量');
  }

  const textOf = (response) =>
    response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

  // ---------- 截图识别 ----------

  const RECOGNIZE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['games'],
    properties: {
      games: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'nameEn', 'steamAppId', 'confidence', 'evidence', 'releaseHint'],
          properties: {
            name: { type: 'string', description: '游戏的官方中文名；没有中文名则用原名' },
            nameEn: { type: 'string', description: '官方英文名 / 国际通用名，用于在 Steam 搜索' },
            steamAppId: { type: ['integer', 'null'], description: '确定知道时填写 Steam AppID，否则 null' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            evidence: { type: 'string', description: '一句话说明依据（截图中的标题文字、Logo、画面特征等）' },
            releaseHint: { type: 'string', description: '截图上能看到的发售日期/“即将推出”等文字，没有则空字符串' },
          },
        },
      },
    },
  };

  const RECOGNIZE_PROMPT = `这些截图来自我收藏/想玩的游戏（可能是 Steam 商店页、愿望单、宣传图、视频截图、社交媒体帖子或游戏画面）。
  请识别出截图中出现的每一款游戏（一张截图可能有多款，多张截图也可能是同一款——同一款只列一次）。

  要求：
  - 优先根据截图上的标题文字、Logo 判断；只有画面特征时给出最可能的答案并把 confidence 设为 low。
  - name 用官方简体中文名（没有就用原名），nameEn 用官方英文名。
  - 只有在你确定时才填写 steamAppId。
  - 截图里能看到的发售日期、"即将推出"、"抢先体验" 等文字原样写进 releaseHint。
  - 如果截图里完全没有游戏，返回空数组。`;

  async function recognizeScreenshots(images) {
    if (!images.length) throw new Error('没有收到截图');
    const content = images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    }));
    content.push({ type: 'text', text: RECOGNIZE_PROMPT });

    let response;
    try {
      response = await getClient().beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        ...FALLBACK,
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: RECOGNIZE_SCHEMA } },
        messages: [{ role: 'user', content }],
      });
    } catch (err) {
      throw explainError(err);
    }
    checkStop(response);
    const parsed = JSON.parse(textOf(response));
    return parsed.games || [];
  }

  // ---------- 联网查发售日期（用于不在 Steam 上的游戏） ----------

  const RELEASE_PROMPT = (name, nameEn) => `请联网查询游戏「${name}」${nameEn && nameEn !== name ? `（${nameEn}）` : ''}的发售信息（PC 版优先）。今天是 ${new Date().toISOString().slice(0, 10)}。

  只在最后输出一个 JSON 对象，不要其他内容，格式：
  {"released": true/false, "date": "YYYY-MM-DD 或 YYYY-MM 或 YYYY，未知则为 null", "text": "给人看的中文描述，如 2025 年 3 月 20 日 / 预计 2026 年第二季度 / 待定", "platforms": ["PC", ...], "officialUrl": "官网或商店链接，没有则 null", "steamAppId": 数字或 null}`;

  async function lookupReleaseOnWeb(name, nameEn) {
    const messages = [{ role: 'user', content: RELEASE_PROMPT(name, nameEn) }];
    const tools = [{ type: WEB_SEARCH_TYPE, name: 'web_search', max_uses: 5 }];
    let response;
    try {
      // 服务端工具循环可能以 pause_turn 暂停，带着上一轮回复重新请求即可继续
      for (let i = 0; i < 4; i++) {
        response = await getClient().beta.messages.create({
          model: MODEL,
          max_tokens: 16000,
          ...FALLBACK,
          output_config: { effort: 'medium' },
          tools,
          messages,
        });
        if (response.stop_reason !== 'pause_turn') break;
        messages.splice(1, messages.length - 1, { role: 'assistant', content: response.content });
      }
    } catch (err) {
      throw explainError(err);
    }
    checkStop(response);
    const text = textOf(response);
    const match = text.match(/\{[\s\S]*\}(?![\s\S]*\{)/);
    if (!match) throw new Error('没有查到发售信息');
    const info = JSON.parse(match[0]);
    return {
      comingSoon: info.released === false,
      date: info.date || null,
      precision: info.date ? (info.date.length === 10 ? 'day' : info.date.length === 7 ? 'month' : 'year') : null,
      text: info.text || null,
      platforms: info.platforms || [],
      officialUrl: info.officialUrl || null,
      steamAppId: Number.isInteger(info.steamAppId) ? info.steamAppId : null,
      source: 'web',
      checkedAt: new Date().toISOString(),
    };
  }

  // ---------- 联网查存档位置（本机找不到、或者想确认时用） ----------

  const SAVES_PROMPT = (name, nameEn, engine) => `请联网查询 PC 游戏「${name}」${nameEn && nameEn !== name ? `（${nameEn}）` : ''}在 Windows 上的存档位置（PCGamingWiki 的 Save game data location 最可靠）。${engine ? `这款游戏用 ${engine} 制作。` : ''}

  路径里用这些占位符，不要写具体用户名：
  %APPDATA%、%LOCALAPPDATA%、%USERPROFILE%\\AppData\\LocalLow、%DOCUMENTS%（文档）、%SAVEDGAMES%（保存的游戏）、%PUBLIC%\\Documents、%PROGRAMDATA%、
  <GAME>（游戏安装文件夹）、<STEAM>（Steam 安装文件夹）、<STEAMUSER>（Steam 账号 ID）。路径里不确定的一层（比如账号 ID、存档编号）用 *。
  存档只在注册表里的，路径写 HKEY_CURRENT_USER\\... 。

  只在最后输出一个 JSON 对象，不要其他内容，格式：
  {"locations": [{"path": "%LOCALAPPDATA%\\\\Game\\\\Saved\\\\SaveGames", "note": "一句中文说明，如 Steam 版 / GOG 版 / 设置文件"}]}
  查不到就返回 {"locations": []}，不要猜。`;

  async function lookupSavePaths(name, nameEn, engine) {
    const messages = [{ role: 'user', content: SAVES_PROMPT(name, nameEn, engine) }];
    const tools = [{ type: WEB_SEARCH_TYPE, name: 'web_search', max_uses: 5 }];
    let response;
    try {
      for (let i = 0; i < 4; i++) {
        response = await getClient().beta.messages.create({
          model: MODEL,
          max_tokens: 16000,
          ...FALLBACK,
          output_config: { effort: 'medium' },
          tools,
          messages,
        });
        if (response.stop_reason !== 'pause_turn') break;
        messages.splice(1, messages.length - 1, { role: 'assistant', content: response.content });
      }
    } catch (err) {
      throw explainError(err);
    }
    checkStop(response);
    const match = textOf(response).match(/\{[\s\S]*\}(?![\s\S]*\{)/);
    if (!match) return [];
    const list = JSON.parse(match[0]).locations;
    return (Array.isArray(list) ? list : [])
      .filter((l) => typeof l?.path === 'string' && l.path.trim())
      .slice(0, 8)
      .map((l) => ({ path: l.path.trim(), note: typeof l.note === 'string' ? l.note.trim() : '' }));
  }

  // ---------- 补全中英文名 ----------

  const NAMES_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['games'],
    properties: {
      games: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'zh', 'zhConfidence', 'en'],
          properties: {
            id: { type: 'string' },
            zh: { type: ['string', 'null'], description: '官方或玩家通用的简体中文名；确实没有中文名则 null' },
            zhConfidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high = 确定这是官方中文名或中文玩家公认的译名' },
            en: { type: ['string', 'null'], description: '官方英文名 / 国际通用名；没有则 null' },
          },
        },
      },
    },
  };

  const NAMES_PROMPT = (list) => `下面是一些游戏，有的只有英文名、有的只有中文名。请补全每款游戏的：
  - zh：官方简体中文名（游戏内 / 中国区商店 / 发行商使用的），或中文玩家公认的译名（例如 Red Dead Redemption 2 → 荒野大镖客：救赎2，Hollow Knight → 空洞骑士）。
    很多小众独立游戏根本没有中文名——这时必须填 null。绝对不要自己把英文名翻译成中文（比如把 Chef RPG 写成「厨师RPG」就是错的）。
    zhConfidence：只有你确实知道这个中文名被官方或玩家广泛使用时才填 high。
  - en：官方英文名或国际通用名（日文等原名游戏也给英文/罗马字官方名）；不确定时填 null。
  每款都按原样返回 id。

  ${JSON.stringify(list, null, 1)}`;

  async function suggestNames(items) {
    if (!items.length) return [];
    let response;
    try {
      response = await getClient().beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        ...FALLBACK,
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: NAMES_SCHEMA } },
        messages: [{ role: 'user', content: NAMES_PROMPT(items) }],
      });
    } catch (err) {
      throw explainError(err);
    }
    checkStop(response);
    // 只采用有把握的中文名：错误的中文名比没有更糟
    return (JSON.parse(textOf(response)).games || []).map((g) => ({ ...g, zh: g.zhConfidence === 'high' ? g.zh : null }));
  }

  // ---------- 中文叫法 → 英文正式名（手动搜索 Steam 搜不到时用） ----------

  const TITLES_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['titles'],
    properties: { titles: { type: 'array', items: { type: 'string' }, description: '最可能的官方英文名，最多 3 个，最可能的在前' } },
  };

  async function englishTitlesFor(query) {
    let response;
    try {
      response = await getClient().beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        ...FALLBACK,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: TITLES_SCHEMA } },
        messages: [
          {
            role: 'user',
            content: `用户想在 Steam 上找游戏「${query}」（可能是中文名、玩家俗称或简称，比如 荒野大镖客 → Red Dead Redemption 2，狂热运输 → Transport Fever）。给出它在 Steam 上的官方英文名，最多 3 个候选（系列作品可以列出多部）。不知道就返回空数组。`,
          },
        ],
      });
    } catch (err) {
      throw explainError(err);
    }
    checkStop(response);
    return (JSON.parse(textOf(response)).titles || []).filter(Boolean).slice(0, 3);
  }

  return { model: MODEL, recognizeScreenshots, lookupReleaseOnWeb, lookupSavePaths, suggestNames, englishTitlesFor };
}
