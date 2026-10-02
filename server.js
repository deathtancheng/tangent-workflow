/**
 * 本地大模型智能体后端
 * ------------------------------------------------------------------
 * 职责：
 *   1. 静态托管 public/ 前端三件套
 *   2. 代理 Ollama 的 /api/chat 流式接口
 *   3. 实现 ReAct 工具调用循环（本地模型作为 model provider 的智能体）
 *   4. 把「思考 / 调用工具 / 工具结果 / 最终回答」分步回传给前端
 *
 * 零第三方依赖，Node 22 原生 http + fetch 即可跑。
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const PORT = Number(process.env.PORT || 5178);
const PUBLIC_DIR = path.join(__dirname, 'public');
const SANDBOX_DIR = path.join(__dirname, 'sandbox');
const MAX_AGENT_STEPS = 6;

// ── YOLO 相关配置 ──────────────────────────────────────────
// 复用 ComfyUI 整合包里现成的 torch 2.9.1+cu130，省掉 4GB 下载
const YOLO_PY = process.env.YOLO_PY || 'D:/yolo-venv/Scripts/python.exe';
const YOLO_DIR = path.join(__dirname, 'yolo');
// 优先用自己训出来的 best.pt，没有就退回预训练权重
const TRAINED_REL = 'runs/detect/runs/coco128_yolo11n/weights/best.pt';
const YOLO_WEIGHTS =
  process.env.YOLO_WEIGHTS ||
  (fs.existsSync(path.join(YOLO_DIR, TRAINED_REL)) ? TRAINED_REL : 'yolo11n.pt');
const YOLO_ENGINE = process.env.YOLO_ENGINE || 'pt';   // pt | onnx
const YOLO_CONF = Number(process.env.YOLO_CONF || 0.25);
const CAMERA_URL = process.env.CAMERA_URL || 'http://127.0.0.1:5179';

// ---------------------------------------------------------------- 工具集

/** 安全计算器：先白名单预处理，再拒绝任何残留标识符 */
function safeCalc(rawExpr) {
  let expr = String(rawExpr)
    .replace(/\^/g, '**')
    .replace(/\b(sqrt|abs|round|floor|ceil|sin|cos|tan|log|exp|pow|min|max)\b/g, 'Math.$1')
    .replace(/\b(pi|PI)\b/g, 'Math.PI')
    .replace(/\b(e|E)\b/g, 'Math.E');

  // 允许：数字、运算符、括号、空格、Math.xxx
  const allowed = /^[0-9+\-*/().%\s,]+$/;
  const stripped = expr.replace(/Math\.[A-Za-z]+/g, '');
  if (!allowed.test(stripped)) {
    throw new Error('表达式含有不允许的字符，只支持数字与 + - * / ^ % ( ) 及基础数学函数');
  }
  // eslint-disable-next-line no-new-func
  const value = Function(`"use strict"; return (${expr});`)();
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error('计算结果不是有效数字');
  }
  return value;
}

/** 目录/文件访问限制在 sandbox 内，防目录穿越 */
function resolveInSandbox(relPath) {
  const target = path.resolve(SANDBOX_DIR, relPath || '.');
  if (target !== SANDBOX_DIR && !target.startsWith(SANDBOX_DIR + path.sep)) {
    throw new Error('拒绝访问：路径超出沙箱范围');
  }
  return target;
}

async function toolListFiles() {
  const entries = await fsp.readdir(SANDBOX_DIR, { withFileTypes: true });
  if (entries.length === 0) return '沙箱目录为空';
  return entries
    .map((e) => `${e.isDirectory() ? '[目录]' : '[文件]'} ${e.name}`)
    .join('\n');
}

async function toolReadFile(relPath) {
  const target = resolveInSandbox(relPath);
  const stat = await fsp.stat(target);
  if (stat.size > 64 * 1024) throw new Error('文件超过 64KB，拒绝读取');
  return await fsp.readFile(target, 'utf8');
}

async function toolWriteFile(relPath, content) {
  const target = resolveInSandbox(relPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, String(content), 'utf8');
  const stat = await fsp.stat(target);
  return `已写入 ${path.relative(SANDBOX_DIR, target)}（${stat.size} 字节）`;
}

async function toolFetchUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error('URL 格式不合法');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('仅支持 http/https');
  const res = await fetch(parsed, {
    signal: AbortSignal.timeout(15000),
    headers: { 'user-agent': 'Mozilla/5.0 local-ai-lab' },
  });
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw new Error('页面没有可提取的文本');
  return text.slice(0, 3000);
}

// ---------------------------------------------------------------- YOLO 推理

/** 把图片 base64 交给 Python 跑 YOLO。走 stdin 避免中文路径在命令行里的编码问题 */
function runYolo(base64Image) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(
        YOLO_PY,
        [
          path.join(YOLO_DIR, 'detect_stdin.py'),
          '--weights', YOLO_WEIGHTS,
          '--engine', YOLO_ENGINE,
          '--conf', String(YOLO_CONF),
          '--imgsz', '640',
        ],
        { cwd: YOLO_DIR, windowsHide: true }
      );
    } catch (err) {
      reject(new Error('启动 Python 失败，检查 YOLO_PY 路径：' + err.message));
      return;
    }
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', () => {
      // 从后往前找第一段合法 JSON，前面的日志/警告一律忽略
      const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          resolve(JSON.parse(lines[i]));
          return;
        } catch {
          /* 不是 JSON，继续往上找 */
        }
      }
      reject(new Error('Python 输出解析失败：' + (err || out).slice(0, 300)));
    });
    proc.stdin.end(base64Image);
  });
}

/** 向摄像头服务要当前帧的检测结果 */
async function cameraDetect() {
  const r = await fetch(`${CAMERA_URL}/detect`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('摄像头服务返回 ' + r.status);
  return await r.json();
}

/** 抓一张摄像头快照存进沙箱 */
async function cameraSnapshot(saveAs) {
  const r = await fetch(`${CAMERA_URL}/snapshot`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('摄像头服务返回 ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const name = String(saveAs || `camera_${Date.now()}`).replace(/[\\/]/g, '_');
  const rel = name.endsWith('.jpg') ? name : name + '.jpg';
  await fsp.writeFile(resolveInSandbox(rel), buf);
  return `已保存 ${rel}（${(buf.length / 1024).toFixed(1)} KB）`;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: '计算数学表达式，例如 "12 * (3 + 4)"、"sqrt(2) * 10"、"2^10"。需要精确数值时必须调用，不要心算。',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: '要计算的数学表达式' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取本机当前的日期、时间和星期几。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出沙箱工作目录中的文件和子目录。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取沙箱工作目录中的一个文本文件内容。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对沙箱目录的文件路径，如 notes/todo.md' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把一段文本内容写入沙箱工作目录中的文件（会覆盖同名文件）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对沙箱目录的文件路径' },
          content: { type: 'string', description: '要写入的文本内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '抓取一个网页并提取正文文本（最多 3000 字），用于查资料。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整的 http/https 网址' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'detect_image',
      description: '对沙箱目录里的一张图片做 YOLO 目标检测，返回画面中有哪些物体、各有几个、位置在哪。想知道图片内容时必须调用。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对沙箱目录的图片路径，如 camera_1.jpg' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'detect_camera',
      description: '对摄像头当前这一帧做 YOLO 目标检测，返回画面里有什么东西、各有几个。用户问「你看到了什么」「摄像头前有什么」时调用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'camera_snapshot',
      description: '拍一张摄像头当前画面并保存到沙箱目录，返回文件名。之后可以用 detect_image 分析它。',
      parameters: {
        type: 'object',
        properties: { filename: { type: 'string', description: '保存的文件名，如 desk.jpg；留空则自动生成' } },
      },
    },
  },
];

async function dispatchTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'calculator':
      return String(safeCalc(a.expression));
    case 'get_current_time': {
      const now = new Date();
      const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
      return now.toLocaleString('zh-CN', { hour12: false }) + ' ' + week;
    }
    case 'list_files':
      return await toolListFiles();
    case 'read_file':
      return await toolReadFile(a.path);
    case 'write_file':
      return await toolWriteFile(a.path, a.content);
    case 'fetch_url':
      return await toolFetchUrl(a.url);
    case 'detect_image': {
      const buf = await fsp.readFile(resolveInSandbox(a.path));
      const r = await runYolo(buf.toString('base64'));
      if (r.error) return `检测失败：${r.error}`;
      const detail = (r.detections || []).map((d) => `${d.label}(${d.conf})`).join(', ');
      return `${r.summary}\n明细：${detail || '无'}\n（${r.latency_ms} ms，引擎 ${r.engine}，画面 ${r.size.w}x${r.size.h}）`;
    }
    case 'detect_camera': {
      const r = await cameraDetect();
      if (r.error) return `摄像头不可用：${r.error}`;
      const detail = (r.detections || []).map((d) => `${d.label}(${d.conf})`).join(', ');
      return `${r.summary}\n明细：${detail || '无'}\n（${r.latency_ms} ms，${r.fps} FPS）`;
    }
    case 'camera_snapshot':
      return await cameraSnapshot(a.filename);
    default:
      throw new Error(`未知工具：${name}`);
  }
}

// ---------------------------------------------------------------- Ollama 流式读取

/** 把 ReadableStream 按行拆成 JSON（Ollama 返回 NDJSON） */
async function* ndjson(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        try {
          yield JSON.parse(line);
        } catch {
          /* 忽略半行 */
        }
      }
    }
  }
}

// ---------------------------------------------------------------- 智能体主循环

async function runAgent({ messages, model, temperature, useTools, onEvent }) {
  const convo = messages.map((m) => ({ role: m.role, content: m.content }));
  const tools = useTools ? TOOLS : undefined;

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const upstream = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: convo,
        tools,
        stream: true,
        think: false,
        options: { temperature: Number(temperature) || 0.6 },
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      throw new Error(`Ollama 返回 ${upstream.status}: ${detail.slice(0, 300)}`);
    }

    let content = '';
    let thinking = '';
    const toolCalls = [];

    for await (const chunk of ndjson(upstream.body)) {
      const msg = chunk.message || {};
      if (msg.thinking) {
        thinking += msg.thinking;
        onEvent({ type: 'thinking', text: msg.thinking });
      }
      if (msg.content) {
        content += msg.content;
        onEvent({ type: 'token', text: msg.content });
      }
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        for (const tc of msg.tool_calls) toolCalls.push(tc);
      }
      if (chunk.done) break;
    }

    if (toolCalls.length === 0) {
      // 没有工具调用 —— 本轮即最终答案
      convo.push({ role: 'assistant', content });
      return content;
    }

    // 有工具调用：把 assistant 消息（含 tool_calls）放回上下文，再执行工具
    convo.push({ role: 'assistant', content: content || '', tool_calls: toolCalls });

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args = tc.function?.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      onEvent({ type: 'tool_start', name, args: args || {} });
      let result;
      try {
        result = await dispatchTool(name, args);
      } catch (err) {
        result = `工具执行失败：${err.message}`;
      }
      onEvent({ type: 'tool_end', name, result: String(result) });
      convo.push({ role: 'tool', content: String(result) });
    }
    onEvent({ type: 'step' });
  }

  throw new Error(`智能体达到最大步数（${MAX_AGENT_STEPS}），已停止`);
}

// ---------------------------------------------------------------- HTTP 服务

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------- Harness 装配

const { createHarness } = require('./harness');
const { SessionTree } = require('./harness/context');

let harnessInstance = null;
let harnessLoading = null;
let currentRun = null; // { controller, pending, since }
let confirmSeq = 0;

async function getHarness() {
  if (harnessInstance) return harnessInstance;
  if (harnessLoading) return harnessLoading;
  harnessLoading = createHarness({
    root: SANDBOX_DIR,
    model: process.env.HARNESS_MODEL || 'qwen3:8b',
    maxTurns: Number(process.env.HARNESS_TURNS || 10),
  }).then((h) => {
    harnessInstance = h;
    console.log(
      `  Harness 就绪：${h.tools.list().length} 个工具，`
      + `扩展 [${h.extensions.list().map((e) => e.name).join(', ')}]`
    );
    return h;
  });
  return harnessLoading;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 静态资源
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/public/'))) {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/public\//, '');
    const target = path.join(PUBLIC_DIR, rel);
    if (!target.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const data = await fsp.readFile(target);
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    }
    return;
  }

  // 模型列表
  if (req.method === 'GET' && url.pathname === '/api/models') {
    try {
      const r = await fetch(`${OLLAMA}/api/tags`);
      const j = await r.json();
      sendJson(res, 200, { models: (j.models || []).map((m) => m.name) });
    } catch (err) {
      sendJson(res, 502, { error: '无法连接 Ollama：' + err.message });
    }
    return;
  }

  // 对话（SSE 风格 NDJSON 流）
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const emit = (evt) => {
      if (!res.writableEnded) res.write(JSON.stringify(evt) + '\n');
    };

    try {
      await runAgent({
        messages: payload.messages || [],
        model: payload.model || 'qwen3:8b',
        temperature: payload.temperature ?? 0.6,
        useTools: payload.useTools !== false,
        onEvent: emit,
      });
      emit({ type: 'done' });
    } catch (err) {
      emit({ type: 'error', message: err.message });
    }
    res.end();
    return;
  }

  // 单张图片检测（前端上传 / 拍照用）
  if (req.method === 'POST' && url.pathname === '/api/detect') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }
    if (!payload.image) {
      sendJson(res, 400, { error: '缺少 image(base64) 字段' });
      return;
    }
    try {
      const r = await runYolo(String(payload.image).replace(/^data:image\/\w+;base64,/, ''));
      sendJson(res, 200, r);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // 摄像头服务代理（统一端口，前端不用记两个地址）
  if (req.method === 'GET' && url.pathname.startsWith('/api/camera/')) {
    const tail = url.pathname.replace('/api/camera/', '');
    if (!['detect', 'stats', 'snapshot', 'video'].includes(tail)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    try {
      const r = await fetch(`${CAMERA_URL}/${tail}`, { signal: AbortSignal.timeout(10000) });
      if (tail === 'snapshot') {
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length });
        res.end(buf);
      } else if (tail === 'video') {
        // MJPEG 流：直接把 Python 那边的字节流透传给浏览器
        res.writeHead(200, {
          'content-type': r.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=--frame',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        Readable.fromWeb(r.body).pipe(res);
      } else {
        sendJson(res, 200, await r.json());
      }
    } catch (err) {
      sendJson(res, 503, { error: '摄像头服务未启动：' + err.message });
    }
    return;
  }

  // ================================================================ Harness
  //
  // 第四部分的入口。和上面 /api/chat 那个"一次性 ReAct 循环"的区别：
  // 这里跑的是完整 Harness——有生命周期钩子、会话树、上下文预算、长期记忆、
  // 可插拔扩展、以及写操作前的人类闸门。前端能实时看到每一层的事件。

  if (req.method === 'GET' && url.pathname === '/api/harness/state') {
    try {
      const h = await getHarness();
      sendJson(res, 200, { ok: true, ...h.describe() });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // 跑一次 trace，事件以 NDJSON 逐条推给前端
  if (req.method === 'POST' && url.pathname === '/api/harness/run') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }
    const goal = String(payload.goal || '').trim();
    if (!goal) {
      sendJson(res, 400, { error: 'goal 不能为空' });
      return;
    }

    const h = await getHarness();
    const controller = new AbortController();
    currentRun = { controller, pending: null, since: Date.now() };

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const emit = (evt) => {
      if (!res.writableEnded) res.write(JSON.stringify(evt) + '\n');
    };

    // 把 Harness 的只读事件流接到这条 SSE 上。注意是订阅（onEvent）不是钩子，
    // 观测者不会影响 agent 的判断，它炸了也不会拖垮 agent
    const off = h.lifecycle.onEvent(emit);

    try {
      const result = await h.agent.run(goal, {
        signal: controller.signal,
        // 写文件 / 执行命令前回来敲门。这里只负责"问"，答案由前端 POST 回来
        confirm: (info) =>
          new Promise((resolve) => {
            const id = `c${++confirmSeq}`;
            currentRun.pending = { id, resolve, info };
            emit({
              type: 'confirm_request',
              id,
              name: info.name,
              level: info.level,
              levelLabel: info.levelLabel,
              args: info.args,
            });
          }),
      });
      emit({ type: 'final', ...result, tree: undefined });
    } catch (err) {
      emit({ type: 'error', message: err.message });
    }
    off();
    currentRun = null;
    res.end();
    return;
  }

  // 人类对权限请求的表态
  if (req.method === 'POST' && url.pathname === '/api/harness/confirm') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }
    if (!currentRun || !currentRun.pending || currentRun.pending.id !== payload.id) {
      sendJson(res, 409, { error: '没有待确认的请求（可能已超时或已被处理）' });
      return;
    }
    const { resolve } = currentRun.pending;
    currentRun.pending = null;
    resolve(payload.allow === true);
    sendJson(res, 200, { ok: true });
    return;
  }

  // 中断当前 trace
  if (req.method === 'POST' && url.pathname === '/api/harness/abort') {
    if (currentRun) {
      currentRun.controller.abort();
      if (currentRun.pending) {
        currentRun.pending.resolve(false);
        currentRun.pending = null;
      }
      sendJson(res, 200, { ok: true, message: '已请求中断' });
    } else {
      sendJson(res, 409, { error: '当前没有在跑的 trace' });
    }
    return;
  }

  // 开新会话：清空短期上下文，长期记忆保留
  if (req.method === 'POST' && url.pathname === '/api/harness/reset') {
    const h = await getHarness();
    h.agent.session = new (require('./harness/context').SessionTree)();
    sendJson(res, 200, { ok: true, session: h.agent.session.stats() });
    return;
  }

  // 记忆管理：查看 / 手动增删
  if (url.pathname === '/api/harness/memory') {
    const h = await getHarness();
    if (req.method === 'GET') {
      sendJson(res, 200, { ...h.memory.stats(), facts: h.memory.data.facts, episodes: h.memory.data.episodes.slice(-10) });
      return;
    }
    if (req.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: '请求体不是合法 JSON' });
        return;
      }
      if (payload.action === 'forget') {
        h.memory.forget(payload.key);
      } else if (payload.action === 'remember') {
        h.memory.remember(payload.key, payload.value);
      } else if (payload.action === 'recall') {
        sendJson(res, 200, { hits: h.memory.recall(payload.query || '', 8) });
        return;
      } else {
        sendJson(res, 400, { error: 'action 必须是 remember / forget / recall' });
        return;
      }
      await h.memory.save();
      sendJson(res, 200, { ok: true, stats: h.memory.stats() });
      return;
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
});

fs.mkdirSync(SANDBOX_DIR, { recursive: true });

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  本地智能体已就绪 → http://127.0.0.1:${PORT}`);
  console.log(`  Ollama 上游：${OLLAMA}`);
  console.log(`  YOLO 引擎　：${YOLO_ENGINE} | 权重 ${YOLO_WEIGHTS} | 置信度 ${YOLO_CONF}`);
  console.log(`  摄像头服务：${CAMERA_URL}`);
  console.log(`  沙箱目录　：${SANDBOX_DIR}\n`);
});
