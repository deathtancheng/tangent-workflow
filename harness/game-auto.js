/**
 * 《拾物奇谭》自动通关演示
 * ------------------------------------------------------------------
 *   node harness/game-auto.js
 *
 * 人类只按一次启动键，剩下的交给 Harness：
 * 查局面 → 挑克制物件 → 献祭 → 读裁决 → 登楼 → 再查局面……
 * 直到通关或力竭。整个循环里没有一行游戏逻辑写在主流程里，
 * 全部通过 Harness 的工具与事件流完成。
 *
 * 这正是题目里那句"人类仅作启动子"的字面实现。
 */

const API = process.env.API || 'http://127.0.0.1:5178';

// 每层挑什么物件：查 COUNTERS 表挑出能压制守阁灵的那一个
const PLAN = {
  1: { label: 'bottle', why: '水克火' },
  2: { label: 'chair', why: '土克水' },
  3: { label: 'toaster', why: '火克金' },
  4: { label: 'chair', why: '土克电' },
  5: { label: 'toaster', why: '火克知' },
};

async function post(path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json().catch(() => ({}));
}

async function actOnce(label, conf, area) {
  const res = await fetch(`${API}/api/game/act`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label, conf, area_ratio: area }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let final = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'content') text += e.text;
      if (e.type === 'confirm_request') {
        await fetch(`${API}/api/game/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: e.id, allow: true }),
        });
      }
      if (e.type === 'final') final = e;
    }
  }
  return { text: text.trim(), final };
}

(async function main() {
  await post('/api/game/reset');
  console.log('阁门开启。人类按下启动键，接下来由 Harness 自己打。\n');

  const t0 = Date.now();

  for (let i = 1; i <= 20; i++) {
    const st = await (await fetch(`${API}/api/game/state`)).json();
    if (st.state.over) break;

    const plan = PLAN[st.state.level] || { label: 'chair', why: '随便' };
    console.log(
      `— 第 ${i} 发 · 第 ${st.state.level} 层 ${st.guardian.name}`
      + `（${st.elements[st.guardian.element].name}）· 献上 ${plan.label}（${plan.why}）`
    );

    const { text, final } = await actOnce(plan.label, 0.9, 55);
    if (!final) {
      console.log('   （没有返回结果，停）');
      break;
    }

    const o = final.lastOffering;
    console.log(`   ${o.elementName} · ${o.verdict} · ${o.damage} 伤害 ${o.grade} 级`);
    console.log(`   「${text.replace(/\s+/g, ' ').slice(0, 78)}…」`);
    console.log(
      `   守阁灵 ${final.state.guardianHp}/${final.guardian.hp}`
      + ` | 旅人 ${final.state.playerHp}/100`
      + ` | ${final.turns}轮 ${(final.ms / 1000).toFixed(1)}s`
    );
    if (final.state.cleared) console.log(`   ★ 登楼 → 第 ${final.state.level} 层`);
    console.log('');

    if (final.state.over) {
      console.log(
        final.state.over === 'win'
          ? `★★ 通关。共 ${final.state.offerings.length} 发，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`
          : `× 力竭于第 ${final.state.level} 层。`
      );
      break;
    }
  }
})();
