/**
 * Harness 冒烟测试（不走 HTTP，直接跑内核）
 *   node harness/smoke.js
 * 验证：装载 → 工具调用 → 权限门 → 记忆沉淀 → 报告落盘
 */

const path = require('path');
const { createHarness } = require('./index');

const GOAL =
  '帮我算一下 2 的 10 次方乘以 3 等于多少（必须用 calculator，不要心算），'
  + '然后把结果写进 notes/smoke-test.md，写一行就够。最后告诉我结果。';

(async () => {
  const t0 = Date.now();
  const harness = await createHarness({
    root: path.join(__dirname, '..', 'sandbox'),
    confirm: async (info) => {
      console.log(`  ⚠ 权限请求：${info.name}（${info.levelLabel}）`, JSON.stringify(info.args));
      return true; // 冒烟测试里自动放行
    },
  });

  console.log('=== 装载情况 ===');
  const d = harness.describe();
  console.log('模型      :', d.model);
  console.log('工作区    :', d.root);
  console.log('内核+扩展 :', d.tools.map((t) => `${t.name}(${t.level})`).join(', '));
  console.log('扩展      :', d.extensions.map((e) => e.name).join(', '));
  console.log('钩子挂载  :', d.hooks.filter((h) => h.count > 0).map((h) => `${h.hook}×${h.count}`).join(', '));

  console.log('\n=== 开始 trace ===');
  harness.lifecycle.onEvent((e) => {
    if (e.type === 'tool') {
      const flag = e.phase === 'end' ? (e.ok ? '✓' : e.blocked ? '⊘' : '✗') : '→';
      console.log(`  ${flag} [t${e.turn}] ${e.name}${e.phase === 'end' ? ` ${e.ms}ms` : ''}`);
      if (e.phase === 'end' && e.output) {
        const t = String(e.output).replace(/\n/g, ' ').slice(0, 120);
        console.log(`      ${t}`);
      }
    } else if (e.type === 'compact') {
      console.log(`  ⇲ 上下文已压缩 → ${e.tokens} tokens`);
    } else if (e.type === 'error') {
      console.log(`  ✗ 错误：${e.message}`);
    }
  });

  const result = await harness.agent.run(GOAL);

  console.log('\n=== 结果 ===');
  console.log('轮次      :', result.turns);
  console.log('工具调用  :', result.toolCalls);
  console.log('压缩次数  :', result.compactions);
  console.log('耗时      :', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('报告      :', result.reportPath || '（无）');
  console.log('中断/错误 :', result.aborted ? '中断' : result.error || '无');
  console.log('\n最终回答：\n' + (result.text || '（空）'));

  if (harness.memory) {
    console.log('\n记忆      :', JSON.stringify(harness.memory.stats()));
  }
})().catch((err) => {
  console.error('冒烟测试失败：', err);
  process.exit(1);
});
