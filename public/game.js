/**
 * 《拾物奇谭》前端
 * ------------------------------------------------------------------
 * 三件事：
 *   1. 把摄像头画面和 YOLO 的框画在一起，让玩家知道自己举的东西被认成了啥
 *   2. 点「献祭此物」→ 走 /api/game/act，后端跑一次真正的 Harness trace
 *   3. 把 Harness 的事件流（工具调用、权限闸门、压缩）摊在界面上
 *
 * 有一个坑是第四部分踩过的：守阁灵要写战报时会挂起等人表态，
 * 所以读流的时候遇到 confirm_request 必须 await 用户点击再 POST 回去，
 * 先把整个流收完再处理会死锁。
 */

const $ = (id) => document.getElementById(id);

const el = {
  lv: $('lv'), gName: $('gName'), gEle: $('gEle'), gTone: $('gTone'),
  gBar: $('gBar'), gHp: $('gHp'), gScene: $('gScene'),
  pBar: $('pBar'), pHp: $('pHp'),
  speech: $('speech'), log: $('log'), chips: $('chips'),
  offerName: $('offerName'), offerMeta: $('offerMeta'), btnOffer: $('btnOffer'),
  mItems: $('mItems'), progress: $('progress'), fxLayer: $('fxLayer'),
  flash: $('flash'), guardianBox: document.querySelector('.guardian'),
  gBarWrap: $('gBarWrap'), pBarWrap: document.querySelector('.player-row .bar'),
  btnReset: $('btnReset'), btnSay: $('btnSay'), chat: $('chat'),
  cam: $('cam'), camWrap: $('camWrap'), overlay: $('overlay'),
  hDot: $('hDot'), hStat: $('hStat'),
  modal: $('modal'), mTitle: $('mTitle'), mBody: $('mBody'), mPre: $('mPre'), mActs: $('mActs'),
};

/* ══════════════════════════════════════════════════════════════
   氛围：飘浮的尘埃
   一小撮光点在纸面上慢慢游，让画面"活"着。
   用 canvas 而不是 DOM，因为要跑 60fps 且元素多。
   ══════════════════════════════════════════════════════════════ */
(function motes() {
  const cv = $('motes');
  if (!cv) return;
  const g = cv.getContext('2d');
  let W, H, dots = [];
  const COUNT = 46;

  function resize() {
    W = cv.width = window.innerWidth;
    H = cv.height = window.innerHeight;
    dots = Array.from({ length: COUNT }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.7 + 0.5,
      vx: (Math.random() - 0.5) * 0.16,
      vy: -Math.random() * 0.2 - 0.04,
      a: Math.random() * 0.32 + 0.08,
      ph: Math.random() * Math.PI * 2,
    }));
  }

  function tick(t) {
    g.clearRect(0, 0, W, H);
    for (const d of dots) {
      d.x += d.vx;
      d.y += d.vy;
      if (d.y < -6) { d.y = H + 6; d.x = Math.random() * W; }
      if (d.x < -6) d.x = W + 6;
      if (d.x > W + 6) d.x = -6;
      // 呼吸般的明暗
      const alpha = d.a * (0.6 + 0.4 * Math.sin(t / 1400 + d.ph));
      g.beginPath();
      g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      g.fillStyle = `rgba(126, 155, 110, ${alpha})`;
      g.fill();
    }
    requestAnimationFrame(tick);
  }

  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(tick);
})();

/* ══════════════════════════════════════════════════════════════
   特效小工具
   ══════════════════════════════════════════════════════════════ */

/** 伤害数字飘出。x/y 是屏幕坐标 */
function floatDamage(text, x, y, kind = '') {
  const d = document.createElement('div');
  d.className = 'dmg-float' + (kind ? ' ' + kind : '');
  d.textContent = text;
  d.style.left = x + 'px';
  d.style.top = y + 'px';
  el.fxLayer.appendChild(d);
  setTimeout(() => d.remove(), 1600);
}

/** 闪屏：red = 旅人挨打，gold = 大事（升级/通关） */
function flash(kind) {
  el.flash.className = 'flash';
  void el.flash.offsetWidth;      // 强制重排，让动画能重播
  el.flash.classList.add(kind);
}

/** 某个元素在屏幕上的中心点 */
function centerOf(node) {
  const r = node.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** 给元素加一个一次性动画类 */
function bump(node, cls, ms = 600) {
  if (!node) return;
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
  setTimeout(() => node.classList.remove(cls), ms);
}

/** 画五层进度 */
function renderProgress(level, over) {
  if (!el.progress) return;
  el.progress.querySelectorAll('i').forEach((i) => {
    const n = Number(i.dataset.lv);
    i.className = n < level ? 'done' : n === level ? (over ? 'done' : 'now') : '';
  });
}

let state = null;
let guardian = null;
let elements = {};
let busy = false;
let round = 0;
let lastBest = null;
/** 手动举物：没有摄像头（或想演示特定克制）时，用户点按钮指定的祭品。
 *  存在时优先级高于摄像头，献祭一次后清空，回到摄像头模式。 */
let manualOffering = null;

// ---------------------------------------------------------------- 摄像头取物
/** 跟服务端 game-rules.js 里 pickOffering 同一套打分：认得准 + 占画面大 */
function pickBest(js) {
  const W = js.width || 640;
  const H = js.height || 480;
  let best = null;
  for (const d of js.detections || []) {
    const box = d.box || [];
    if (box.length < 4) continue;
    const ratio = Math.min(1, (Math.abs(box[2] - box[0]) * Math.abs(box[3] - box[1])) / (W * H));
    const score = (d.conf || 0) * Math.sqrt(ratio + 1e-4);
    if (!best || score > best.score) best = { label: d.label, conf: d.conf, ratio, score };
  }
  return best;
}

function drawBoxes(js) {
  const cv = el.overlay;
  const img = el.cam;
  const W = js.width || 640;
  const H = js.height || 480;
  const dw = img.clientWidth || W;
  const dh = img.clientHeight || H;
  cv.width = dw;
  cv.height = dh;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, dw, dh);
  const sx = dw / W;
  const sy = dh / H;
  for (const d of js.detections || []) {
    const box = d.box || [];
    if (box.length < 4) continue;
    const x = box[0] * sx;
    const y = box[1] * sy;
    const w = (box[2] - box[0]) * sx;
    const h = (box[3] - box[1]) * sy;
    const hot = lastBest && d.label === lastBest.label;
    g.strokeStyle = hot ? '#f0b64a' : 'rgba(160, 200, 170, .75)';
    g.lineWidth = hot ? 3 : 1.5;
    g.strokeRect(x, y, w, h);
    const text = `${d.label} ${(d.conf || 0).toFixed(2)}`;
    g.font = '12px -apple-system, "PingFang SC", sans-serif';
    const tw = g.measureText(text).width;
    g.fillStyle = hot ? 'rgba(240, 182, 74, .92)' : 'rgba(40, 60, 50, .68)';
    g.fillRect(x, Math.max(0, y - 17), tw + 10, 17);
    g.fillStyle = '#fff';
    g.fillText(text, x + 5, Math.max(11, y - 4));
  }
}

async function pollDetect() {
  // 手动举物期间不让摄像头轮询抢走祭品——用户明确指定的优先
  if (manualOffering) {
    setTimeout(pollDetect, 1200);
    return;
  }
  try {
    const r = await fetch('/api/camera/detect');
    if (!r.ok) throw new Error(r.status);
    const js = await r.json();
    el.camWrap.classList.remove('is-off');
    if (js.error) throw new Error(js.error);
    lastBest = pickBest(js);
    drawBoxes(js);
    renderOffering(lastBest, js);
  } catch {
    el.camWrap.classList.add('is-off');
    lastBest = null;
    renderOffering(null, null);
  }
  setTimeout(pollDetect, 1200);
}

let lastShownLabel = null;

function renderOffering(best, js) {
  if (!best) {
    el.offerName.textContent = '镜头前还没有东西';
    el.offerName.classList.add('empty');
    el.offerMeta.innerHTML = '';
    el.btnOffer.disabled = busy;
    lastShownLabel = null;
    return;
  }
  // 换了个东西才弹一下，不然每隔 1.2 秒轮询会一直闪
  if (best.label !== lastShownLabel) {
    lastShownLabel = best.label;
    bump(el.offerName, 'pop', 450);
  }
  el.offerName.textContent = best.label;
  el.offerName.classList.remove('empty');
  const ele = elements[elementOfLocal(best.label)];
  // 手动举物是用户自己点的，没有"识别置信度"这回事——别编数字
  el.offerMeta.innerHTML = best.manual
    ? [`手动举物`, ele ? `属性 <b>${ele.name}</b>` : '', `威力按 <b>32%</b> 画面占比计`]
      .filter(Boolean).join('')
    : [
      `识别置信度 <b>${(best.conf * 100).toFixed(0)}%</b>`,
      `占画面 <b>${(best.ratio * 100).toFixed(1)}%</b>`,
      ele ? `属性 <b>${ele.name}</b>` : '',
      js && js.detections ? `画面共 ${js.detections.length} 个目标` : '',
    ].filter(Boolean).join('');
  el.btnOffer.disabled = busy || (state && state.over);
}

/** 前端也要知道物件属性，用来在按钮上方提示。规则以服务端为准，这里只做展示 */
function elementOfLocal(label) {
  const raw = String(label || '').toLowerCase().trim();
  const map = {
    person: 'life', bird: 'life', cat: 'life', dog: 'life', horse: 'life',
    'potted plant': 'wood', banana: 'wood', apple: 'wood', orange: 'wood',
    broccoli: 'wood', carrot: 'wood', sandwich: 'wood', pizza: 'wood',
    donut: 'wood', cake: 'wood', 'hot dog': 'wood', book: 'lore', clock: 'lore',
    oven: 'fire', toaster: 'fire', microwave: 'fire',
    chair: 'earth', couch: 'earth', bed: 'earth', 'dining table': 'earth',
    toilet: 'earth', refrigerator: 'earth', bench: 'earth', suitcase: 'earth',
    knife: 'metal', fork: 'metal', spoon: 'metal', scissors: 'metal',
    bottle: 'water', 'wine glass': 'water', cup: 'water', bowl: 'water',
    sink: 'water', vase: 'water',
    tv: 'volt', laptop: 'volt', mouse: 'volt', remote: 'volt', keyboard: 'volt',
    'cell phone': 'volt', backpack: 'guard', umbrella: 'guard', handbag: 'guard',
  };
  return map[raw] || 'unknown';
}

// ---------------------------------------------------------------- 局面渲染
// 上一次画出来的血量，用来判断这一帧该不该闪。null = 第一次画，不闪
let prevGHp = null;
let prevPHp = null;

function renderState() {
  if (!state || !guardian) return;
  el.lv.textContent = state.level;
  el.gName.textContent = guardian.name;
  const e = elements[guardian.element] || { name: '?', color: '#999' };
  el.gEle.textContent = e.name;
  el.gEle.style.background = e.color;
  el.gTone.textContent = guardian.persona || '';
  el.gScene.textContent = guardian.scene || '';

  // 把属性色喂给 CSS，血条、光晕、取景框都跟着换色
  if (el.guardianBox) el.guardianBox.style.setProperty('--ele-color', e.color);

  const gp = Math.max(0, Math.round((state.guardianHp / guardian.hp) * 100));
  el.gBar.style.width = gp + '%';
  el.gHp.textContent = `守阁灵 ${state.guardianHp} / ${guardian.hp}`;
  const pp = Math.max(0, Math.round((state.playerHp / 100 * 100)));
  el.pBar.style.width = pp + '%';
  el.pHp.textContent = `旅人 ${state.playerHp} / 100`;

  // 血量掉了就抖一下，让"挨打"有触感
  if (prevGHp !== null && state.guardianHp < prevGHp) bump(el.gBarWrap, 'hit');
  if (prevPHp !== null && state.playerHp < prevPHp) bump(el.pBarWrap, 'hit');
  prevGHp = state.guardianHp;
  prevPHp = state.playerHp;

  renderProgress(state.level, state.over);
}

function setBusy(on) {
  busy = on;
  el.btnOffer.disabled = on || !lastBest || (state && state.over);
  el.btnSay.disabled = on;
  el.hDot.className = 'dot' + (on ? ' busy' : '');
  el.hStat.textContent = on ? '守阁灵正在裁定……' : 'Harness 待命';
}

function chip(text, cls) {
  const s = document.createElement('span');
  s.className = 'chip' + (cls ? ' ' + cls : '');
  s.textContent = text;
  el.chips.appendChild(s);
  while (el.chips.children.length > 8) el.chips.removeChild(el.chips.firstChild);
  return s;
}

function addLog(item) {
  const row = document.createElement('div');
  row.className = 'row' + (item.fresh ? ' new' : '');
  row.innerHTML = `<span class="idx">${item.idx}</span>`
    + `<span class="what">${item.html}</span>`
    + `<span class="dmg">${item.right || ''}</span>`;
  el.log.appendChild(row);
  el.log.scrollTop = el.log.scrollHeight;
}

// ---------------------------------------------------------------- 权限闸门
/** 弹一个模态，返回用户是否同意。会挂起读流循环——这是必须的 */
function askConfirm(info) {
  return new Promise((resolve) => {
    el.mTitle.textContent = '守阁灵想动笔';
    el.mBody.textContent = `它请求执行「${info.name}」（${info.levelLabel}）。同意吗？`;
    el.mPre.style.display = 'block';
    el.mPre.textContent = JSON.stringify(info.args || {}, null, 2).slice(0, 600);
    el.mActs.innerHTML = '';
    const yes = document.createElement('button');
    yes.className = 'yes';
    yes.textContent = '准了';
    const no = document.createElement('button');
    no.className = 'no';
    no.textContent = '驳回';
    yes.onclick = () => { close(); resolve(true); };
    no.onclick = () => { close(); resolve(false); };
    el.mActs.append(yes, no);
    el.modal.classList.add('show');
  });
}

function showEnding(win) {
  el.mTitle.textContent = win ? '通关' : '力竭';
  el.mBody.textContent = win
    ? '万物阁五层皆已空无一人。你把手里的东西放下，阁门在身后合上了。'
    : '旅人倒在楼梯上。守阁灵俯身看了你一眼，什么也没说。';
  el.mPre.style.display = 'none';
  el.mActs.innerHTML = '';
  const again = document.createElement('button');
  again.className = 'yes';
  again.textContent = '再来一局';
  again.onclick = async () => { close(); await doReset(); };
  el.mActs.append(again);
  el.modal.classList.add('show');
}

function close() {
  el.modal.classList.remove('show');
}

// ---------------------------------------------------------------- 一次行动
async function act({ offering = null, prompt = null, talk = false }) {
  if (busy) return;
  setBusy(true);
  el.chips.innerHTML = '';
  el.speech.textContent = '';
  el.speech.insertAdjacentHTML('beforeend', '<span class="cursor"></span>');
  const cursor = el.speech.querySelector('.cursor');

  const body = { talk };
  if (offering) {
    body.label = offering.label;
    body.conf = offering.conf;
    body.area_ratio = Number((offering.ratio * 100).toFixed(1));
  }
  if (prompt) body.prompt = prompt;

  const res = await fetch('/api/game/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // 有些失败（没识别到东西 / 已结束）不是流，是普通 JSON
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('ndjson')) {
    const j = await res.json().catch(() => ({}));
    el.speech.textContent = j.message || j.error || '这一回没成。';
    setBusy(false);
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let spoken = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }

      if (evt.type === 'tool' && evt.phase === 'start') {
        chip(evt.name, 'live');
      } else if (evt.type === 'tool' && evt.phase === 'end') {
        const c = el.chips.lastElementChild;
        if (c) c.className = 'chip ' + (evt.ok && !evt.blocked ? 'ok' : 'no');
      } else if (evt.type === 'content') {
        spoken += evt.text || '';
        cursor.remove();
        el.speech.textContent = spoken;
        el.speech.appendChild(cursor);
      } else if (evt.type === 'confirm_request') {
        const ok = await askConfirm(evt);   // ← 必须在这里等，不能收完流再处理
        await fetch('/api/game/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: evt.id, allow: ok }),
        });
      } else if (evt.type === 'compact') {
        chip('上下文压缩', 'ok');
      } else if (evt.type === 'final') {
        cursor.remove();
        state = evt.state;
        guardian = evt.guardian;
        renderState();
        if (evt.lastOffering) {
          round += 1;
          const o = evt.lastOffering;
          const tag = o.verdict === '克制'
            ? '<span class="tag strong">克制</span>'
            : o.verdict === '被压制' ? '<span class="tag weak">被压制</span>' : '';
          addLog({
            idx: round,
            html: `献上 <b>${o.label}</b> <span class="tag">${o.elementName || ''}</span> ${tag}`,
            right: `<span class="grade ${o.grade}">${o.grade}</span>${o.damage} 伤害`,
            fresh: true,
          });

          // ---- 打击感 ----
          // 伤害先从守阁灵身上飘出来，克制时更大更金
          const crit = o.verdict === '克制' ? 'crit' : '';
          if (el.guardianBox) {
            const g = centerOf(el.guardianBox);
            floatDamage(`-${o.damage}`, g.x - 20, g.y - 10, crit);
            if (o.damage > 0) bump(el.guardianBox, 'struck', 500);
          }
          // 旅人自己挨的反伤，从血条那儿飘，并且闪红
          if (o.counter > 0) {
            const p = el.pBarWrap ? centerOf(el.pBarWrap) : { x: window.innerWidth / 2, y: 200 };
            floatDamage(`-${o.counter}`, p.x - 20, p.y, 'counter');
            flash('red');
          } else if (o.damage > 0) {
            flash(crit ? 'gold' : '');
          }
        }
        el.hStat.textContent = `${evt.turns} 轮 · ${evt.toolCalls} 次工具 · ${(evt.ms / 1000).toFixed(1)}s`;
        if (evt.state && evt.state.over) {
          setTimeout(() => showEnding(evt.state.over === 'win'), 900);
        } else if (evt.state && evt.state.cleared) {
          addLog({ idx: '↑', html: `<b>守阁灵退散，登上第 ${evt.state.level} 层。</b>`, right: '' });
        }
      } else if (evt.type === 'error') {
        cursor.remove();
        el.speech.textContent += `\n（出错了：${evt.message}）`;
      }
    }
  }
  cursor.remove();
  setBusy(false);
}

// ---------------------------------------------------------------- 局面同步
async function fetchState() {
  const r = await fetch('/api/game/state');
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '取不到局面');
  state = j.state;
  guardian = j.guardian;
  elements = j.elements || {};
  renderState();
}

async function doReset() {
  setBusy(true);
  el.speech.textContent = '阁门重新开启……';
  el.log.innerHTML = '';
  round = 0;
  manualOffering = null;
  lastShownLabel = null;
  // 新的一局：血量重新从满开始，别把上一局的血当成"掉血"闪一下
  prevGHp = null;
  prevPHp = null;
  if (el.mItems) el.mItems.querySelectorAll('.m-item').forEach((b) => b.classList.remove('on'));
  await fetch('/api/game/reset', { method: 'POST' });
  await fetchState();
  setBusy(false);
  await act({ talk: true, prompt: '有旅人推开了阁门。报上你的名号，说一句开场白，一句话就够。' });
}

// ---------------------------------------------------------------- 绑定
el.btnOffer.addEventListener('click', () => {
  if (!lastBest || busy) return;
  act({ offering: lastBest });
  // 手动举物是一次性的：献祭完就交还给摄像头
  if (manualOffering) {
    manualOffering = null;
    el.mItems.querySelectorAll('.m-item').forEach((b) => b.classList.remove('on'));
  }
});

// 手动举物：没有摄像头 / 想演示特定克制关系时的降级入口
el.mItems.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.m-item');
  if (!btn || busy || (state && state.over)) return;
  el.mItems.querySelectorAll('.m-item').forEach((b) => b.classList.remove('on'));
  btn.classList.add('on');
  manualOffering = {
    label: btn.dataset.label,
    conf: 0.9,
    ratio: 0.32,
    manual: true,
  };
  lastBest = manualOffering;
  renderOffering(lastBest, null);
});

el.btnSay.addEventListener('click', () => {
  const v = el.chat.value.trim();
  if (!v || busy) return;
  el.chat.value = '';
  act({ talk: true, prompt: v });
});

el.chat.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.btnSay.click();
});

el.btnReset.addEventListener('click', () => doReset());

// ---------------------------------------------------------------- 启动
(async function boot() {
  await fetchState();
  pollDetect();
  // 只在全新一局时让守阁灵自报家门，刷新页面不会重复开场
  if (!state.offerings.length) {
    await act({ talk: true, prompt: '有旅人推开了阁门。报上你的名号，说一句开场白，一句话就够。' });
  } else {
    el.speech.textContent = '你又回来了。守阁灵抬眼看你。';
    for (const o of state.offerings.slice(-4)) {
      round += 1;
      addLog({
        idx: round,
        html: `献上 <b>${o.label}</b> <span class="tag">${o.elementName || ''}</span>`,
        right: `<span class="grade ${o.grade}">${o.grade}</span>${o.damage} 伤害`,
      });
    }
  }
})().catch((err) => {
  el.speech.textContent = '起不来：' + err.message + '（确认 server.js 与 camera_server.py 都在跑）';
});
