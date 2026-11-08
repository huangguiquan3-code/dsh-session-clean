/**
 * 转录渲染：把 `session.v4.jsonl.zstd` 里的事件流变成可读文本。
 *
 * 事件形状（DSH v4）：
 *   {"type":"user/message","seq":8,"time":...,"data":{"content":[{"type":"text","text":"…"}],
 *     "source":{"kind":"user"|"runtime-context"|…},"role":"user"}}
 *   {"type":"assistant/message","seq":16,"data":{"turn":1,"step":1,"message":{"role":"assistant",
 *     "content":[{"type":"reasoning"|"text"|"tool-call", …}]},"stream":[…]}}
 *   {"type":"tool/call","data":{"name":"pwsh","arguments":"{…json…}","callId":"…"}}
 *   {"type":"tool/result","data":{"content":[{"type":"text","text":"…"}],"toolCallId":"…"}}
 *   {"type":"session/title","data":{"title":"…"}}
 *
 * 渲染只取「人看的那部分」：用户输入、助手正文、工具名与参数摘要、工具结果摘要。
 * `stream`（逐 chunk 的流式片段）、`request/header`（整份工具表）、`system/message`
 * 默认丢弃 —— 它们是运行痕迹，不是对话。
 */

const DEFAULTS = {
  reasoning: false,
  system: false,
  maxToolChars: 1200,
  maxResultChars: 1500,
  maxTextChars: 0, // 0 = 不截断
};

function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function clip(s, max) {
  const str = String(s == null ? '' : s);
  if (!max || str.length <= max) return str;
  return `${str.slice(0, max)}\n…（已截断，原长 ${str.length} 字）`;
}

function fmtTime(ms) {
  const n = Number(ms) || 0;
  if (!n) return '-';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function humanBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)}MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)}KB`;
  return `${v}B`;
}

function prettifyArgs(raw) {
  if (raw == null) return '';
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (obj && typeof obj === 'object') {
    // 工具参数里最长的一般是 command/prompt/body，优先露出来。
    const priority = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'];
    const parts = [];
    for (const k of priority) {
      if (typeof obj[k] === 'string' && obj[k]) parts.push(`${k}: ${obj[k]}`);
    }
    if (!parts.length) return JSON.stringify(obj);
    return parts.join('\n');
  }
  return String(obj);
}

/**
 * 渲染 Markdown 转录。
 * @param {object} rec 扫描记录（title/bytes/workspace/…）
 * @param {{header: object|null, events: object[]}} parsed
 * @param {object} [opts]
 * @returns {string}
 */
export function buildMarkdown(rec, parsed, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const events = (parsed && parsed.events) || [];
  const header = (parsed && parsed.header) || {};

  let title = (rec && rec.title) || '';
  let lastTitle = '';
  const turns = [];

  const lines = [];
  const out = [];

  const push = (s) => { if (s !== '' && s != null) out.push(s); };

  for (const ev of events) {
    const type = ev && ev.type;

    if (type === 'session/title') {
      const t = ev.data && ev.data.title;
      if (typeof t === 'string' && t.trim()) lastTitle = t.trim();
      continue;
    }

    if (type === 'turn/start') {
      turns.push(ev.data && ev.data.turn);
      if (out.length) push('\n---\n');
      push(`## 第 ${(ev.data && ev.data.turn) || turns.length} 轮\n`);
      continue;
    }

    if (type === 'user/message') {
      const d = ev.data || {};
      const kind = d.source && d.source.kind;
      if (kind !== 'user') {
        if (!(o.system && (kind === 'runtime-context' || kind === 'system-reminder'))) continue;
      }
      const text = clip(textOfBlocks(d.content), o.maxTextChars);
      if (!text) continue;
      push(`**你**\n\n${text}\n`);
      continue;
    }

    if (type === 'assistant/message') {
      const msg = (ev.data && ev.data.message) || {};
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const text = clip(textOfBlocks(blocks), o.maxTextChars);
      if (text) push(`**助手**\n\n${text}\n`);
      if (o.reasoning) {
        const reasoning = blocks
          .filter((b) => b && b.type === 'reasoning' && typeof b.text === 'string')
          .map((b) => b.text.trim())
          .filter(Boolean)
          .join('\n\n');
        if (reasoning) push(`> **思考**\n>\n> ${clip(reasoning, o.maxToolChars).replace(/\n/g, '\n> ')}`);
      }
      // assistant/message 里内嵌的 tool-call 块不再单独打印：每一次调用
      // 都有对应的 tool/call 事件，那里是规范记录，打两遍会重复。
      continue;
    }

    if (type === 'tool/call') {
      const d = ev.data || {};
      push(toolLine(d.name, d.arguments, o));
      continue;
    }

    if (type === 'tool/result') {
      const d = ev.data || {};
      // 两种形状都见过：data.content 与 data.message.content。
      const blocks = Array.isArray(d.content) ? d.content : (d.message && d.message.content);
      const text = clip(textOfBlocks(blocks), o.maxResultChars);
      if (!text) continue;
      push(quoteCode('📄 工具结果', text));
      continue;
    }

    if (o.system && (type === 'system/message' || type === 'developer/message')) {
      const msg = (ev.data && ev.data.message) || {};
      const text = clip(textOfBlocks(msg.content), o.maxToolChars);
      if (text) push(`> **系统/开发者**\n>\n> ${text.replace(/\n/g, '\n> ')}`);
    }
  }

  title = lastTitle || title || (rec && rec.sessionId) || '会话';

  lines.push(`# ${title}\n`);
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| 会话 ID | \`${(rec && rec.sessionId) || header.id || '-'}\` |`);
  lines.push(`| 工作目录 | \`${(rec && rec.workspace) || header.cwd || '-'}\` |`);
  lines.push(`| 创建时间 | ${fmtTime((rec && rec.createdAt) || header.createdAt)} |`);
  lines.push(`| 最后活动 | ${fmtTime(rec && rec.mtime)} |`);
  lines.push(`| 大小 | ${humanBytes((rec && rec.bytes) || 0)} |`);
  lines.push(`| 轮次 | ${turns.length || '-'} |`);
  lines.push('');

  const body = out.join('\n').trim();
  return `${lines.join('\n')}\n${body ? `\n${body}\n` : '\n_（没有可渲染的对话内容）_\n'}`;
}

function toolLine(name, args, o) {
  const pretty = clip(prettifyArgs(args), o.maxToolChars);
  if (!pretty) return `> 🔧 \`${name || 'tool'}\``;
  return quoteCode(`🔧 ${name || 'tool'}`, pretty);
}

/** 引用块里的代码块：每行都带 `> ` 前缀，否则 Markdown 会把围栏当成普通段落。 */
function quoteCode(title, body) {
  const fenced = ['```', String(body).replace(/```/g, '``\\`'), '```']
    .join('\n')
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
  return `> ${title}\n>\n${fenced}`;
}

/**
 * 渲染 JSON（无损：header + 全部事件原样）。
 * @param {object} rec
 * @param {{header: object|null, events: object[]}} parsed
 * @returns {string}
 */
export function buildJson(rec, parsed) {
  const payload = {
    exportedAt: new Date().toISOString(),
    sessionId: (rec && rec.sessionId) || null,
    title: (rec && rec.title) || '',
    workspace: (rec && rec.workspace) || '',
    createdAt: (rec && rec.createdAt) || null,
    mtime: (rec && rec.mtime) || null,
    bytes: (rec && rec.bytes) || 0,
    header: (parsed && parsed.header) || null,
    events: (parsed && parsed.events) || [],
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** 取一小段摘要（给索引表用）。 */
export function summarize(rec, parsed) {
  const events = (parsed && parsed.events) || [];
  let title = (rec && rec.title) || '';
  let firstUser = '';
  let turnCount = 0;
  for (const ev of events) {
    if (!ev) continue;
    if (ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string' && ev.data.title.trim()) {
      title = ev.data.title.trim();
    }
    if (ev.type === 'turn/start') turnCount += 1;
    if (!firstUser && ev.type === 'user/message') {
      const kind = ev.data && ev.data.source && ev.data.source.kind;
      if (kind === 'user') {
        const t = textOfBlocks(ev.data.content).replace(/\s+/g, ' ').trim();
        if (t) firstUser = t.slice(0, 120);
      }
    }
  }
  return { title: title || (rec && rec.sessionId) || '', firstUser, turnCount };
}

export { fmtTime, humanBytes };
