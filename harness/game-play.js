/**
 * 《拾物奇谭》命令行试玩
 * ------------------------------------------------------------------
 *   node harness/game-play.js                    # 从摄像头取当前物件献祭
 *   node harness/game-play.js cup 0.9 30         # 指定物件 / 置信度 / 占画面%
 *   node harness/game-play.js --talk 你是谁      # 只搭话，不献祭
 *   node harness/game-play.js --reset            # 重开一局
 *
 * 存在的意义：浏览器之外也要能验证规则对不对。
 * 规则是纯函数，命令行跑一遍就能看出克制关系有没有生效。
 */

const API = process.env.API || 'http://127.0.0.1:5178';

async function sse(path, body, onEvent) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('ndjson')) {
    const j = await res.json().catch(() => ({}));
    console.log(j.message || j.error || '（无响应体）');
    return null;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
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
      if (e.type === 'confirm_request') {
        console.log(`\n⚠ 守阁灵请求执行 ${e.name}（${e.levelLabel}），自动放行`);
        await fetch(`${API}/api/game/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: e.id, allow: true }),
        });
        continue;
      }
      if (onEvent) onEvent(e);
      if (e.type === 'final') return e;
    }
  }
  return null;
}

(async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === '--reset') {
    await fetch(`${API}/api/game/reset`, { method: 'POST' });
    console.log('已重开一局。');
    return;
  }

  const before = await (await fetch(`${API}/api/game/state`)).json();
  if (!before.ok) {
    console.error('取不到局面：', before.error);
    process.exit(1);
  }
  const g0 = before.guardian;
  console.log(`第 ${before.state.level} 层 · 守阁灵「${g0.name}」属性${before.elements[g0.element].name} · ${before.state.guardianHp}/${g0.hp}`);
  console.log(`旅人 ${before.state.playerHp}/100\n`);

  let body;
  if (argv[0] === '--talk') {
    body = { talk: true, prompt: argv.slice(1).join(' ') };
  } else if (argv[0]) {
    body = {
      label: argv[0],
      conf: Number(argv[1] || 0.85),
      area_ratio: Number(argv[2] || 25),
    };
  } else {
    body = {}; // 让服务端自己去摄像头取
  }

  let text = '';
  const tools = [];
  const final = await sse('/api/game/act', body, (e) => {
    if (e.type === 'content') text += e.text;
    if (e.type === 'tool' && e.phase === 'start') tools.push(e.name);
    if (e.type === 'offering' && e.label) {
      console.log(`祭品：${e.label}（置信度 ${e.conf}，占画面 ${e.areaRatio}%）`);
    }
  });

  if (!final) return;

  console.log('\n── 守阁灵 ──');
  console.log(text.trim());

  if (final.lastOffering) {
    const o = final.lastOffering;
    console.log(`\n裁决：${o.elementName || ''} · ${o.verdict} · ${o.damage} 伤害 · 评级 ${o.grade}`);
  }
  console.log(
    `\n第 ${final.state.level} 层 | 守阁灵 ${final.state.guardianHp}/${final.guardian.hp}`
    + ` | 旅人 ${final.state.playerHp}/100`
    + ` | ${final.turns} 轮 ${final.toolCalls} 工具 ${(final.ms / 1000).toFixed(1)}s`
  );
  if (tools.length) console.log(`调用：${tools.join(' → ')}`);
  if (final.state.cleared) console.log('★ 守阁灵退散，登上新的一层');
  if (final.state.over) console.log(final.state.over === 'win' ? '★★ 通关' : '× 力竭');
})();
