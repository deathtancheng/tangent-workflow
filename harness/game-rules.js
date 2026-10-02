/**
 * 游戏规则引擎 —— 《拾物奇谭》
 * ------------------------------------------------------------------
 * 这个文件的存在理由只有一个：
 *
 *     规则归代码，叙事归模型。
 *
 * 第四部分踩过一次坑：问模型"距年底还有多少天"，它构造了
 * 365-(10*30+1)=64，正确答案是 91。calculator 忠实执行了它给的式子——
 * 工具保证执行正确，不保证建模正确。
 *
 * 游戏里这件事会被放大成灾难：如果让 8B 模型自己算伤害，
 * 它每回合给出的数字都会漂，血条就成了随机数。玩家的"策略"
 * （挑大件、挑对属性）也就完全落空——因为模型感知不到公式。
 *
 * 所以这里把所有会漂移的东西都锁死：
 *   属性判定、克制关系、威力曲线、暴击、反击，全部是纯函数。
 *   模型拿到的只有已经算好的结构化裁决，它的活儿是编故事。
 *
 * 顺带一个好处：想改平衡性只改这张表，不用动一个字提示词。
 */

// ------------------------------------------------------------------ 属性
const ELEMENTS = {
  wood: { name: '木', color: '#6f9d5b', tone: '草木生长之力，柔韧而绵长' },
  fire: { name: '火', color: '#d9713f', tone: '炉火炙烈，一往无前' },
  earth: { name: '土', color: '#a8854f', tone: '厚重沉稳，能挡能压' },
  metal: { name: '金', color: '#8d97a8', tone: '锋锐凛冽，专破活物' },
  water: { name: '水', color: '#4f92b0', tone: '流转无形，能克烈火' },
  volt: { name: '电', color: '#c9a227', tone: '迅疾难测，穿金渡水' },
  life: { name: '活', color: '#c76b7a', tone: '生灵之气，破土而出' },
  lore: { name: '知', color: '#7a6fa3', tone: '书卷时序，专解虚妄' },
  guard: { name: '护', color: '#5f8c86', tone: '包容庇护，反制锋芒' },
  unknown: { name: '?', color: '#9a9a9a', tone: '来历不明，连守阁灵也认不出' },
};

/**
 * 克制表：攻击方属性 → 它压制哪些属性。
 * 用稀疏表而不是 9×9 矩阵，是因为大部分组合该是"无克制"，
 * 写全矩阵反而容易手滑填出互相克制。
 */
const COUNTERS = {
  water: ['fire', 'earth'],
  // 火除了烧草木、熔金石，也烧书——最后一层那个"没有形状的东西"怕的就是这个
  fire: ['wood', 'metal', 'lore'],
  wood: ['earth', 'water'],
  earth: ['water', 'volt'],
  metal: ['wood', 'life'],
  volt: ['water', 'metal'],
  life: ['earth', 'guard'],
  lore: ['volt', 'life'],
  guard: ['metal', 'fire'],
};

/** COCO 80 类 → 属性。查不到就归 unknown，让守阁灵自己圆。 */
const LABEL_ELEMENT = {
  // 生灵
  person: 'life', bird: 'life', cat: 'life', dog: 'life', horse: 'life',
  sheep: 'life', cow: 'life', elephant: 'life', bear: 'life', zebra: 'life', giraffe: 'life',

  // 草木与吃食 → 木
  'potted plant': 'wood', banana: 'wood', apple: 'wood', orange: 'wood',
  broccoli: 'wood', carrot: 'wood', sandwich: 'wood', pizza: 'wood',
  donut: 'wood', cake: 'wood', 'hot dog': 'wood', frisbee: 'wood',
  kite: 'wood', skateboard: 'wood', surfboard: 'wood', skis: 'wood',
  snowboard: 'wood', 'baseball bat': 'wood', 'tennis racket': 'wood',
  'sports ball': 'wood', 'teddy bear': 'wood',

  // 炉火 → 火
  oven: 'fire', toaster: 'fire', microwave: 'fire',

  // 家具重物 → 土
  chair: 'earth', couch: 'earth', bed: 'earth', 'dining table': 'earth',
  toilet: 'earth', refrigerator: 'earth', bench: 'earth', suitcase: 'earth',

  // 利器与车马 → 金
  knife: 'metal', fork: 'metal', spoon: 'metal', scissors: 'metal',
  bicycle: 'metal', car: 'metal', motorcycle: 'metal', airplane: 'metal',
  bus: 'metal', train: 'metal', truck: 'metal', boat: 'metal',

  // 容器流水 → 水
  bottle: 'water', 'wine glass': 'water', cup: 'water', bowl: 'water',
  sink: 'water', vase: 'water', 'fire hydrant': 'water',

  // 电子器械 → 电
  tv: 'volt', laptop: 'volt', mouse: 'volt', remote: 'volt', keyboard: 'volt',
  'cell phone': 'volt', 'hair drier': 'volt', 'traffic light': 'volt',
  'parking meter': 'volt',

  // 书卷时序 → 知
  book: 'lore', clock: 'lore', 'stop sign': 'lore',

  // 容具 → 护
  backpack: 'guard', umbrella: 'guard', handbag: 'guard', tie: 'guard',
  'baseball glove': 'guard',
};

/** ultralytics 的类别名带空格，别的来源可能带下划线，两种都要能命中 */
function elementOf(label) {
  const raw = String(label || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (LABEL_ELEMENT[raw]) return LABEL_ELEMENT[raw];
  const spaced = raw.replace(/_/g, ' ');
  if (LABEL_ELEMENT[spaced]) return LABEL_ELEMENT[spaced];
  const joined = raw.replace(/\s+/g, '');
  for (const k of Object.keys(LABEL_ELEMENT)) {
    if (k.replace(/\s+/g, '') === joined) return LABEL_ELEMENT[k];
  }
  return 'unknown';
}

// ------------------------------------------------------------------ 守阁灵
const GUARDIANS = [
  {
    level: 1,
    name: '灰烬书童',
    element: 'fire',
    hp: 50,
    counter: 4,
    persona: '话不多，说话带火星。最怕水，也怕被看穿心思。',
    scene: '它蹲在一堆烧了一半的家书旁，抬头看你一眼，灰烬落在睫毛上。',
  },
  {
    level: 2,
    name: '苔痕守井',
    element: 'water',
    hp: 70,
    counter: 5,
    persona: '慢声慢气，什么都往怀里吞。厚重的东西也能压住它。',
    scene: '井口的青苔一直长到它肩膀上，它说话时水面跟着一圈圈荡开。',
  },
  {
    level: 3,
    name: '锈刃将军',
    element: 'metal',
    hp: 90,
    counter: 6,
    persona: '一身旧甲，脾气硬。见不得活气，也见不得比它更利的刃。',
    scene: '它把插在地上的长刀拔出来，锈屑簌簌往下掉，刀锋却还是亮的。',
  },
  {
    level: 4,
    name: '雷纹傀儡',
    element: 'volt',
    hp: 110,
    counter: 7,
    persona: '关节里走电，吐字一顿一顿。湿的东西和铁器都能让它短路。',
    scene: '它每走一步，身上的雷纹就亮一次，把整层楼照得忽明忽暗。',
  },
  {
    level: 5,
    name: '万物之影',
    element: 'lore',
    hp: 140,
    counter: 9,
    persona: '没有固定形状，你举什么它就变成什么。只有火能把它烧出原形。',
    scene: '它站在阁楼最高处，轮廓不停变换，最后停成你自己的样子。',
  },
];

const PLAYER_HP = 100;

// ------------------------------------------------------------------ 裁决
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 从一帧检测结果里挑"主祭品"。
 * 只看置信度会选到远处的小物件；只看面积会选到糊成一团的背景。
 * 所以两个一起算：置信度 × 面积的平方根——既要求看得准，也要求是主角。
 */
function pickOffering(detections, { width = 640, height = 480 } = {}) {
  const list = Array.isArray(detections) ? detections : [];
  if (!list.length) return null;
  const W = width || 640;
  const H = height || 480;
  let best = null;
  for (const d of list) {
    const box = d.box || d.bbox || null;
    const conf = Number(d.conf ?? d.confidence ?? 0);
    let ratio = 0;
    if (Array.isArray(box) && box.length >= 4) {
      const w = Math.abs(box[2] - box[0]);
      const h = Math.abs(box[3] - box[1]);
      ratio = clamp((w * h) / (W * H), 0, 1);
    }
    const score = conf * Math.sqrt(ratio + 0.0001);
    if (!best || score > best.score) {
      best = { label: d.label || d.name || 'object', conf, ratio, box, score };
    }
  }
  return best;
}

/**
 * 核心裁决。纯函数，同样的输入永远同样的输出（除了那一点骰子抖动）。
 * @returns 一份结构化裁决，直接喂给模型让它叙事
 */
function resolveOffering({ label, conf = 0, ratio = 0 }, guardian) {
  const ele = elementOf(label);
  const gEle = guardian.element;

  const strong = (COUNTERS[ele] || []).includes(gEle);
  const weak = (COUNTERS[gEle] || []).includes(ele);

  // 威力：物件占画面比例越大（举得越近）越猛。
  // 曲线是调过的：摄像头前正常举起大约占 20%，克制时约 33 伤害，
  // 打完五层要十四五发——刚好卡在"策略对就能险胜、乱举必输"的位置。
  const power = 8 + 30 * clamp(ratio * 1.2, 0, 1);
  // 命中：认得越准，物件越"实"
  const acc = conf >= 0.75 ? 1.2 : conf >= 0.5 ? 1.0 : conf >= 0.35 ? 0.75 : 0.5;
  // 克制
  const mult = strong ? 1.8 : weak ? 0.5 : 1.0;
  // 骰子：±15% 抖动，让每回合有点悬念，但不至于盖过策略
  const roll = 0.85 + Math.random() * 0.3;

  const dmg = Math.max(1, Math.round(power * acc * mult * roll));
  const grade =
    dmg >= 50 ? 'S' : dmg >= 32 ? 'A' : dmg >= 18 ? 'B' : dmg >= 9 ? 'C' : 'D';

  const verdict =
    strong ? '克制' : weak ? '被压制' : '无克制';

  return {
    label,
    element: ele,
    elementName: ELEMENTS[ele].name,
    elementTone: ELEMENTS[ele].tone,
    conf: Number(conf.toFixed(2)),
    areaRatio: Number((ratio * 100).toFixed(1)),
    guardianElement: gEle,
    guardianElementName: ELEMENTS[gEle].name,
    verdict,
    damage: dmg,
    grade,
    // 剩下的交给模型读，它照着这些数字编故事就行
    hint:
      strong
        ? `${ELEMENTS[ele].name} 正好压住 ${ELEMENTS[gEle].name}，这一记打得极狠。`
        : weak
          ? `${ELEMENTS[gEle].name} 反过来压住了 ${ELEMENTS[ele].name}，物件像是被什么东西顶了回来。`
          : `${ELEMENTS[ele].name} 与 ${ELEMENTS[gEle].name} 互不相干，只能凭分量硬砸。`,
  };
}

/** 守阁灵的反击。同样留一点随机，但幅度比玩家小，避免运气盖过策略 */
function guardianCounter(guardian) {
  const base = guardian.counter + Math.round((Math.random() * 4 - 2));
  return Math.max(1, base);
}

/** 把当前局面渲染成给模型看的一段话 */
function describeState(state) {
  const g = GUARDIANS[clamp(state.level - 1, 0, GUARDIANS.length - 1)];
  return [
    `第 ${state.level} 层 / 共 ${GUARDIANS.length} 层`,
    `守阁灵：${g.name}（属性 ${ELEMENTS[g.element].name}，${ELEMENTS[g.element].tone}）`,
    `守阁灵体力：${state.guardianHp} / ${g.hp}`,
    `旅人体力：${state.playerHp} / ${PLAYER_HP}`,
    `已献祭：${state.offerings.length} 件`,
    state.offerings.length
      ? `近期祭品：${state.offerings.slice(-5).map((o) => `${o.label}(${o.elementName} ${o.damage}dmg ${o.grade})`).join('、')}`
      : '（还没献上任何东西）',
    state.cleared ? '本层已通过' : '',
    state.over ? `（游戏结束：${state.over}）` : '',
  ].filter(Boolean).join('\n');
}

function newState() {
  const g = GUARDIANS[0];
  return {
    level: 1,
    playerHp: PLAYER_HP,
    guardianHp: g.hp,
    offerings: [],
    cleared: false,
    over: null, // 'win' | 'lose' | null
    startedAt: new Date().toISOString(),
  };
}

module.exports = {
  ELEMENTS,
  COUNTERS,
  LABEL_ELEMENT,
  GUARDIANS,
  PLAYER_HP,
  elementOf,
  pickOffering,
  resolveOffering,
  guardianCounter,
  describeState,
  newState,
};
