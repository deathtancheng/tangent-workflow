/**
 * quest 扩展 —— 把 Harness 变成一个游戏主持人
 * ------------------------------------------------------------------
 * 这个扩展自己不懂任何游戏流程。它只做了三件 Harness 允许的事：
 *
 *   1. 注册几个工具（看镜头 / 裁决 / 查局面 / 摇骰子）
 *   2. 往系统提示里加一段守阁灵人格
 *   3. 把局面存成文件
 *
 * 至于"什么时候该调用哪个工具""剧情怎么写"，全交给模型。
 * 内核一行没改——这正是第四部分搭扩展机制时要的东西。
 *
 * 另外一个刻意的设计：伤害数字由 game-rules.js 的纯函数算好再交给模型，
 * 模型只负责把它翻译成故事。规则归代码，叙事归模型。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { LEVEL } = require('../tools');
const { HOOKS } = require('../lifecycle');
const { cameraDetect } = require('../yolo');
const {
  ELEMENTS,
  GUARDIANS,
  elementOf,
  pickOffering,
  resolveOffering,
  guardianCounter,
  describeState,
  newState,
} = require('../game-rules');

const SYSTEM = `你现在是「万物阁」的守阁灵。旅人身上没有武器，只能把现实中的物件举到镜头前献祭给你，由你裁定它能否伤到你。

每一回合严格按这个顺序做：
1. 调用 quest_resolve，把旅人举起的物件传进去（label / conf / area_ratio 三个字段都要给）。工具会返回已经算好的裁决：伤害、评级、克制关系。
2. 读裁决，用守阁灵的口吻写 60~150 字剧情：这东西怎么飞过来、你被伤到没有、最后一句挑衅或叹息。
3. 把这段剧情作为最终回答直接输出，不要再调用别的工具。

硬性规则：
- 伤害、体力、克制一律以 quest_resolve 返回的为准。不许自己算，不许改数字，不许编造没返回的数值。
- 剧情里不要把数字原样报出来（不要写"造成 34 点伤害"），要化成画面和感受。
- 物件被认错时不许纠正旅人。识别成什么，它就真的是什么——把杯子认成马桶，你就当它真抬来了一座马桶，认真接住。
- 第一次登场或被问到身份时，报一下自己的名号和属性，之后不要每回合重复。
- 你的名号、属性、所在层数由每回合系统给出的【当前身份】决定，不要自己编名字。
- 人称：用「我」指守阁灵自己，「你」指旅人。飞过来的是旅人的东西，被砸到的是我。
- 不要重复上一回合已经用过的句子，每回合换一个角度写。
- 要写战报或回顾战况时，先调 quest_log。战报里的每个数字都得能在记录里找到出处，找不到就别写。
- 全程中文，守阁灵口吻，不要出现"作为一个 AI""我无法"这类话。`;

// 每回合要往系统提示里塞的当前身份。用这个标记定位上次塞进去的块，好替换掉
const MARK = '【当前身份】';
const stripIntro = (s) => {
  const i = String(s).indexOf(MARK);
  return i >= 0 ? String(s).slice(0, i).trimEnd() : String(s);
};

module.exports = function questExtension({ root, memory } = {}) {
  const ROOT = path.resolve(root || path.join(__dirname, '..', '..', 'sandbox'));
  const SAVE_DIR = path.join(ROOT, 'game');
  const SAVE_FILE = path.join(SAVE_DIR, 'save.json');

  let state = newState();

  function resolveIn(rel) {
    const target = path.resolve(ROOT, rel || '.');
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      throw new Error(`拒绝访问：${rel} 超出工作区范围`);
    }
    return target;
  }

  function guardian() {
    return GUARDIANS[Math.min(state.level, GUARDIANS.length) - 1];
  }

  function load() {
    try {
      if (fs.existsSync(SAVE_FILE)) {
        state = { ...newState(), ...JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')) };
      }
    } catch {
      /* 存档坏了就开新局，不影响玩 */
    }
    return state;
  }

  async function persist() {
    await fsp.mkdir(SAVE_DIR, { recursive: true });
    await fsp.writeFile(SAVE_FILE, JSON.stringify(state, null, 2), 'utf8');
  }

  load();

  return {
    name: 'quest',
    description: '《拾物奇谭》：用摄像头里的实物跟守阁灵对战',
    system: SYSTEM,

    // 给 HTTP 层用的把手：它要拿状态渲染血条，也要能重开
    getState: () => state,
    setState: (s) => {
      state = s;
      return persist();
    },
    reset: () => {
      state = newState();
      return persist();
    },
    saveFile: SAVE_FILE,

    tools: [
      {
        name: 'quest_look',
        level: LEVEL.SAFE,
        description:
          '看一眼摄像头当前画面，挑出最适合献祭的那一件东西，'
          + '返回它的名称、置信度和占画面比例（比例越大威力越高）。',
        params: { type: 'object', properties: {} },
        async run() {
          const js = await cameraDetect();
          if (js.error) return `看不了：${js.error}`;
          const best = pickOffering(js.detections, js);
          if (!best) return '画面里没有可识别的物件（可能太暗，或者没举东西）。';
          return [
            `主祭品：${best.label}`,
            `置信度 ${best.conf.toFixed(2)}`,
            `占画面 ${(best.ratio * 100).toFixed(1)}%`,
            `（画面共识别出 ${js.detections.length} 个目标）`,
            '接下来调用 quest_resolve，把这三个值传进去。',
          ].join('\n');
        },
      },

      {
        name: 'quest_resolve',
        level: LEVEL.SAFE,
        description:
          '裁定一件祭品对当前守阁灵的效果。必须传 label（物件名）、conf（置信度 0~1）、'
          + 'area_ratio（占画面百分比 0~100）。返回伤害、评级、克制关系，以及守阁灵的反击。'
          + '拿到结果后据此写剧情，不要自己算数。',
        params: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '物件名称，例如 cup、book、scissors' },
            conf: { type: 'number', description: 'YOLO 置信度，0~1' },
            area_ratio: { type: 'number', description: '物件占画面面积的百分比，0~100' },
          },
          required: ['label'],
        },
        async run({ label, conf = 0.6, area_ratio: areaRatio = 20 }) {
          if (state.over) return `这一局已经结束了（${state.over}），不能再献祭。请告诉旅人重开一局。`;

          const g = guardian();
          const c = Math.max(0, Math.min(1, Number(conf) || 0));
          const a = Math.max(0, Math.min(100, Number(areaRatio) || 0));
          const hpBefore = state.guardianHp;

          // —— 玩家出手（纯函数算，模型碰不到公式）
          const r = resolveOffering({ label, conf: c, ratio: a / 100 }, g);
          state.guardianHp = Math.max(0, state.guardianHp - r.damage);
          state.offerings.push({
            round: state.offerings.length + 1,
            level: state.level, // 跨层之后记录要能看出这一发是打哪一层的
            label: r.label,
            element: r.element,
            elementName: r.elementName,
            damage: r.damage,
            grade: r.grade,
            verdict: r.verdict,
            playerHp: state.playerHp,
            guardianHp: state.guardianHp,
            at: new Date().toISOString(),
          });

          // —— 守阁灵反击（还活着才还手）
          let counter = 0;
          if (state.guardianHp > 0) {
            counter = guardianCounter(g);
            state.playerHp = Math.max(0, state.playerHp - counter);
            // 把反击补记进这一条，事后写战报才有据可查
            const rec = state.offerings[state.offerings.length - 1];
            if (rec) {
              rec.counter = counter;
              rec.playerHp = state.playerHp;
              rec.guardianHp = state.guardianHp;
            }
          }

          // —— 层间推进
          const lines = [];
          let cleared = false;
          let won = false;
          if (state.guardianHp <= 0) {
            if (state.level >= GUARDIANS.length) {
              state.over = 'win';
              won = true;
              lines.push('守阁灵倒下了。万物阁最高层再无人把守——旅人通关了。');
            } else {
              state.level += 1;
              state.guardianHp = guardian().hp;
              cleared = true;
              lines.push(`守阁灵退散，楼梯显形。旅人登上了第 ${state.level} 层。`);
            }
          }
          if (state.playerHp <= 0) {
            state.over = 'lose';
            lines.push('旅人倒了下去，手里的东西滚落一地。这一局结束。');
          }

          state.cleared = cleared;
          await persist();

          return JSON.stringify(
            {
              offering: {
                label: r.label,
                element: `${r.elementName}（${ELEMENTS[r.element].tone}）`,
                conf: r.conf,
                area: `${r.areaRatio}%`,
              },
              verdict: r.verdict,
              hint: r.hint,
              damage: r.damage,
              grade: r.grade,
              guardian: {
                name: g.name,
                element: ELEMENTS[g.element].name,
                hpLeft: state.guardianHp,
                counter,
              },
              playerHpLeft: state.playerHp,
              level: state.level,
              events: lines,
              cleared,
              won,
              over: state.over,
              round: state.offerings.length,
              instruction:
                `以上数字是最终事实，不许改写。这一击确实打在你身上：`
                + `你的体力从 ${hpBefore} 掉到 ${state.guardianHp}（${r.verdict}），`
                + '所以不要写"毫发无伤""未伤到我"这类话。'
                + `这是旅人第 ${state.offerings.length} 次献祭，用守阁灵口吻写 60~150 字剧情，`
                + '换一个跟前面几回合不同的角度和句式，也不要把数字原样报出来。',
            },
            null,
            2
          );
        },
      },

      {
        name: 'quest_state',
        level: LEVEL.SAFE,
        description: '查看当前局面：第几层、守阁灵是谁、双方体力、已经献祭过什么。',
        params: { type: 'object', properties: {} },
        async run() {
          load();
          return describeState(state);
        },
      },

      {
        name: 'quest_log',
        level: LEVEL.SAFE,
        description:
          '调出这一局每一回合的真实记录（回合数、物件、属性、伤害、评级、双方剩余体力）。'
          + '要写战报、回顾战况前必须先调它，只能基于这里的数据写，不许自己补回合或编数字。',
        params: { type: 'object', properties: {} },
        async run() {
          if (!state.offerings.length) return '这一局还没有任何回合记录。';
          return JSON.stringify(
            {
              level: state.level,
              guardian: guardian().name,
              playerHp: state.playerHp,
              guardianHp: state.guardianHp,
              over: state.over,
              rounds: state.offerings,
            },
            null,
            2
          );
        },
      },

      {
        name: 'roll',
        level: LEVEL.SAFE,
        description: '摇一次骰子，返回 1 到 sides 之间的整数。用于给剧情增加偶然性。',
        params: {
          type: 'object',
          properties: { sides: { type: 'number', description: '骰子面数，默认 20' } },
        },
        async run({ sides = 20 }) {
          const n = Math.max(2, Math.min(100, Math.round(Number(sides) || 20)));
          return String(1 + Math.floor(Math.random() * n));
        },
      },

      {
        name: 'quest_write_report',
        level: LEVEL.WRITE,
        description:
          '把这一局写成战报存到工作区。写之前必须先调用 quest_log 拿到真实回合记录，'
          + '战报里的回合数、伤害、体力一律照抄记录，缺什么就少写什么，绝不能编。'
          + '需要用户确认。',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '保存路径，例如 game/report-2026-10-02.md' },
            content: { type: 'string', description: '战报正文（Markdown）' },
          },
          required: ['path', 'content'],
        },
        async run({ path: rel, content }) {
          const target = resolveIn(rel);
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(target, String(content), 'utf8');
          return `战报已写入 ${rel}（${String(content).length} 字）`;
        },
      },
    ],

    // 守阁灵的身份是随层数变的，不能写死在启动时的系统提示里。
    // 所以每次请求模型前，用 model:start 钩子把当前这一层的身份塞进 system。
    // 这正是"钩子可干预"和"事件只观测"的区别——这里是真的改了要发出去的东西。
    hooks: [
      {
        hook: HOOKS.MODEL_START,
        async fn(ctx) {
          const g = guardian();
          const ele = ELEMENTS[g.element];
          const intro = [
            MARK,
            `你是万物阁第 ${state.level} 层（共 ${GUARDIANS.length} 层）的守阁灵「${g.name}」。`,
            `属性「${ele.name}」——${ele.tone}。`,
            `脾性：${g.persona}`,
            `此刻：${g.scene}`,
            `你的体力 ${state.guardianHp}/${g.hp}，旅人的体力 ${state.playerHp}/100。`,
          ].join('\n');

          const messages = ctx.messages || [];
          if (!messages.length || messages[0].role !== 'system') return;
          const merged = {
            messages: [
              { ...messages[0], content: `${stripIntro(messages[0].content)}\n\n${intro}` },
              ...messages.slice(1),
            ],
          };
          return merged;
        },
      },

      // 一局结束就把成绩写进长期记忆。下次开新局时守阁灵会想起来——
      // 或者说，Harness 会替它想起来。这是"人类只当启动子"的那一环。
      {
        hook: HOOKS.TRACE_END,
        async fn(ctx) {
          if (!state.over || !memory) return;
          const best = [...state.offerings].sort((a, b) => b.damage - a.damage)[0];
          const day = new Date().toISOString().slice(0, 10);
          try {
            memory.remember(
              `拾物奇谭·${day}`,
              [
                state.over === 'win' ? '通关' : `力竭于第 ${state.level} 层`,
                `共献祭 ${state.offerings.length} 件，旅人剩余体力 ${state.playerHp}`,
                best ? `最狠的一击是 ${best.label}（${best.elementName} ${best.damage} 伤害 ${best.grade} 级）` : '',
              ].filter(Boolean).join('；')
            );
            await memory.save();
          } catch {
            /* 记忆写不进去不影响游戏 */
          }
        },
      },
    ],
  };
};
