# 华小牛 · 本地 AI 实验室

一台 RTX 4060 Laptop（8GB 显存）上跑起来的完整 AI 栈：本地大模型 → 工具调用智能体 →
YOLO 视觉 → 自建 Harness → 一个真正能玩的游戏。

全部代码零第三方依赖（后端是 Node 22 原生 `http` + `fetch`），模型全部跑在本机。

| 作业模块 | 状态 | 产物 |
| --- | --- | --- |
| 一、本地大模型 + 智能体 | ✅ | Ollama(qwen3:8b) + 手写 ReAct 循环 + Web 三件套 |
| 二、YOLO 跑通 | ✅ | 训练 mAP@0.5=0.79 / 摄像头 31 FPS 实时检测 / 接入 Web |
| 三、硬件结合（进阶） | ⏸ | 手上没板子，暂跳过。接口已留好（加一个 `serial_write` 扩展即可） |
| 四、Harness 搭建（进阶） | ✅ | 六个模块 + 四层生命周期 10 个钩子 + 扩展热插拔 |
| 五、创意作品 | ✅ | 《拾物奇谭》：摄像头当手柄、YOLO 读招、大模型当守阁灵 |

---

## 架构总览

```
浏览器（HTML / CSS / JS 三件套）
   │
   ├─ /api/chat    NDJSON 事件流 ──────┐
   ├─ /api/camera/video  MJPEG ─────┐  │
   ├─ /api/harness/run   事件流 ─┐  │  │
   └─ /api/game/act      事件流 ─┤  │  │
                                 ▼  ▼  ▼
                    Node 22 后端 server.js（零依赖）
                       ├─ 静态托管 public/
                       ├─ /api/chat      第一部分：一次性 ReAct 循环
                       ├─ /api/detect    YOLO 单图检测
                       ├─ /api/harness/* 第四部分：完整 Harness
                       └─ /api/game/*    第五部分：游戏
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  Ollama qwen3:8b       camera_server.py          sandbox/
  （100% GPU，5.6GB）    YOLO 常驻推理 31 FPS      文件 / 存档 / 长期记忆
```

---

## 第一部分：本地大模型 + 智能体

**部署**：Ollama 0.34.0，模型 `qwen3:8b`（Q4_K_M，5.2GB），实测 100% GPU 卸载占 5.6GB 显存，
8GB 卡刚好够，还剩约 2.5GB 给 YOLO。

**智能体**：没用 Dify / n8n / 扣子，手写 ReAct 循环（约 60 行）——
模型返回 `tool_calls` → 本地执行 → 结果以 `role:'tool'` 塞回上下文 → 再问，最多 6 步。

**工具集**：`calculator`（白名单字符过滤，禁任意代码执行）、`get_current_time`、
`list_files`、`read_file`、`write_file`、`fetch_url`。所有文件工具限制在 `sandbox/` 内
（`path.resolve + startsWith` 防目录穿越）。

**实测**：一轮「查日期 → 算天数 → 写文件」3 工具 4 步，约 12 秒。

---

## 第二部分：YOLO 训练 + 实时推理

**环境捷径**：直接复用 ComfyUI 秋叶整合包的 Python（Py3.10.11 + torch 2.9.1+cu130），
用 `python -m venv --system-site-packages "D:/yolo-venv"` 建继承型 venv，
省掉约 4GB 的 torch 下载。

**训练结果**（yolo11n + coco128）：

| 指标 | 值 |
| --- | --- |
| mAP@0.5 | **0.7878** |
| mAP@0.5:0.95 | 0.6121 |
| 训练耗时 | 约 4 分钟 |
| 显存峰值 | 1.84 GB |

参数：`epochs=30 / batch=8 / imgsz=640 / amp / cos_lr / warmup 3`，理由写在 `yolo/train.py` 的 docstring 里。

**推理引擎对比**：

| 引擎 | 单帧耗时 |
| --- | --- |
| PyTorch (.pt) | 34.9 ms |
| PyTorch + FP16 | 41.0 ms |
| ONNX（同进程，4 线程） | 104 ms |
| ONNX（独立进程） | ~35 ms |
| **摄像头常驻服务** | **11.4 ms / 31.5 FPS** |

**踩坑清单**（每一条都是实测撞出来的）：

1. `workers>0` 在 Windows 上必崩（dataloader 多进程）→ 默认设 0。
2. GitHub Releases 的权重下不动 → 用 `https://ghproxy.net/<github-url>` 手动拉。
3. Python 往 stdout 打日志会让 Node 的 `JSON.parse` 失败 → 引擎信息改 `file=sys.stderr`，
   Node 侧再从后往前找第一段合法 JSON，双保险。
4. onnxruntime-gpu 的 CUDA EP 在本机起不来（ORT 1.23 要 CUDA 12 + cuDNN 9，本机是 cu130），
   装齐 DLL 并 `os.add_dll_directory` 注册后仍静默回退 CPU。**这条如实记录，没粉饰。**
5. ORT 与 PyTorch 同进程会线程打满：torch 占 24 个 OMP 线程，ORT 再开 24 个 → 486ms；
   `intra_op_num_threads=4` → 109ms。这个参数必须给。
6. **每帧打印的日志能把磁盘吃光**：`camera.log` 一晚上涨到 **33MB / 38 万行**，
   其中 99.99% 是同一句 `WARNING 'half' is deprecated`。
   两个原因叠加：
   - ultralytics 8.4 起 `half` 参数弃用，**只要传了（哪怕传 `False`）就报警**，
     且它用的是自家 `LOGGER.warning`，`warnings.filterwarnings` 压不住 → 改用 `quantize=16`，
     FP32 时干脆不传精度参数。
   - Windows 上客户端强断连接抛的是 `ConnectionAbortedError`（WinError 10053），
     **不在** `BrokenPipeError` / `ConnectionResetError` 里 → 覆盖 `handle_one_request` 统一兜 `OSError`。
   修完日志稳定在 184 字节，40 秒零增长。

**没上 VLM**：qwen3:8b 是纯文本模型，8GB 显存再塞 7B 视觉模型不现实。
走「YOLO 感知 → 结构化文本 → LLM 推理」，将来换 VLM 时工具接口不用动。

---

## 第四部分：自建 Harness

**Harness 是什么**：一句话，**Agent = 大模型 + Harness**。
模型负责想，Harness 负责让它想得下去——给工具、管上下文、记住上次的事、
危险动作前拦一道、把每一步摊开给人看。

第一部分那个 `/api/chat` 是写死的 ReAct 循环；这部分把它拆成可观测、可干预、可扩展的骨架。

### 六个模块

| 文件 | 职责 |
| --- | --- |
| `agent.js` | 核心主循环 ~400 行，只串钩子，不含任何业务 `if` |
| `lifecycle.js` | 四层 10 个钩子；**钩子（可干预）与事件（只读观测）是两套机制** |
| `provider.js` | 模型抽象，`for await (chunk of provider.chat())`，换模型不改主循环 |
| `tools.js` | `invoke()` **永不抛出**，失败也当普通结果返回（错误即消息） |
| `context.js` | 会话树（回退 O(1)）+ token 预算 + 模型自摘要压缩 |
| `memory.js` | 事实 + 情节两层记忆，关键词加权 + 30 天半衰，落盘 `sandbox/memory/` |
| `extensions.js` | 扩展 = 一组工具 + 若干钩子 + 一段系统提示，可热插拔 |

```
trace:start
  └─ turn:start
       ├─ model:start → model:stream* → model:end
       ├─ tool:start → tool:run → tool:end
       └─ turn:end
trace:end
```

### 三条设计纪律

1. **主循环里不许有 `if (某某业务)`**。要加能力就挂钩子或加扩展。
2. **错误即消息**。工具返回 `ok:false` 也照常塞回上下文，让模型自己判断。
3. **有状态在外，无状态在内**。turn 循环只认传进来的 messages，单轮可重放、可回退。

### 与 Pi 的两处分歧（刻意保留）

- **Pi 砍掉了权限弹窗，我保留**。这个 agent 要碰真实资源（文件、摄像头、以后的单片机），
  而且题目里写了「人类仅作启动子」——启动子不等于撒手不管。
- **Pi 面向短平快的编码会话，我要跑长任务**，所以加装了它没做的两样：上下文预算 + 长期记忆。

### 实测（HTTP 端到端，qwen3:8b）

| 场景 | 轮次 | 工具 | 耗时 |
| --- | --- | --- | --- |
| 计算 + 写文件 | 3 | 2 | 4.7 s |
| 查日期 + 算天数 + 写文件 | 4 | 3 | 12.1 s |
| 存长期记忆 | 2 | 1 | 5.0 s |
| **重置会话后回忆** | 2 | 1 | 3.5 s（短期清空，长期记忆命中） |
| 看摄像头（画面全黑） | 2 | 1 | 2.1 s（如实说没检测到，没编造） |
| bash 列目录（danger 级） | 2 | 1 | 7.4 s（权限门拦下 → 放行 → 执行） |

### 踩到的坑

6. **Ollama 要求 `tool_calls.arguments` 必须是对象**，传字符串报
   `Value looks like object, but can't find closing '}' symbol`——错误信息完全指错方向。
   对比实测：字符串版 400，对象版 200。方言差异收在 `provider.js` 里，主循环不感知。
7. **权限确认必须异步往返**：agent 等人类表态时是挂起的，前端必须在读流循环里
   `await` 用户点击再 POST 回去；先收完整个流再处理会死锁。

### 一个诚实记录的失败

问「距年底还有多少天」，模型构造了 `365-(10*30+1)`=64，正确答案 91。
calculator 忠实执行了它给的式子——**工具保证执行正确，不保证建模正确**。
Harness 能拦「哪些操作可做」，拦不住「思路错了」。这个教训直接决定了第五部分的架构。

---

## 第五部分：创意作品 —— 《拾物奇谭》

> 摄像头是手柄，YOLO 是输入解析，本地大模型是守阁灵，Harness 把这三样咬合成一个回合。

### 玩法

你是误入「万物阁」的旅人，身上没有武器。守阁灵拦在每层楼梯口，
你只能把手边真实存在的物件举到摄像头前献祭给它，由它裁定这件东西能不能伤到它。

- 举得**越近越大**（占画面比例）→ 威力越高
- 识别**越准**（置信度）→ 打得越实
- 物件**属性克制**守阁灵 → 伤害接近翻倍（水克火、土克水、火克金、土克电、火克知）

五层守阁灵：灰烬书童（火）→ 苔痕守井（水）→ 锈刃将军（金）→ 雷纹傀儡（电）→ 万物之影（知）。

### 核心设计：规则归代码，叙事归模型

这是被第四部分那个「距年底天数」的教训逼出来的。

如果让 8B 模型自己算伤害，它每回合给出的数字都会漂，血条就成了随机数，
玩家的策略（挑大件、挑对属性）也完全落空——因为模型感知不到公式。

所以 `harness/game-rules.js` 里把所有会漂移的东西锁成纯函数：
属性判定、克制表、威力曲线、暴击、反击。模型拿到的只有**已经算好的结构化裁决**，
它的活儿只是把数字翻译成故事。

顺带的好处：想改平衡性只改这张表，一个字提示词都不用动。

### 用上了前面四部分的哪些东西

| 部件 | 来自 |
| --- | --- |
| 守阁灵的脑子 | 第一部分：Ollama qwen3:8b |
| 看懂你举的是什么 | 第二部分：YOLO 实时检测（31 FPS） |
| 回合流程、工具、记忆、权限门 | 第四部分：Harness |
| `model:start` 钩子注入当前层身份 | 第四部分：钩子的**干预**能力（不是事件观测） |
| 通关后战绩写进长期记忆 | 第四部分：`memory.js` |
| 写战报前的权限弹窗 | 第四部分：三级权限闸门 |

游戏是作为一个**扩展**（`harness/extensions/quest.js`）挂上去的，内核一行没改。
这正好验证了第四部分搭扩展机制时想要的东西。

### 一次真实回合的内部流程

```
玩家举起水杯
   │
   ├─ YOLO 识别 → cup, conf 0.92, 占画面 35%
   │
   ├─ 节点侧组装 goal → 交给 Harness
   │
   ├─ model:start 钩子 → 注入「你是第 1 层守阁灵灰烬书童，属性火」
   │
   ├─ 模型调 quest_resolve(label, conf, area_ratio)
   │      └─ game-rules.js 纯函数算出：水·克制·71 伤害·S 级
   │
   ├─ 模型读裁决 → 写 60~150 字剧情
   │
   └─ trace:end 钩子 → 若通关，战绩写进长期记忆
```

### 实测：自动通关（`node harness/game-auto.js`）

人类只按一次启动键，剩下的 Harness 自己跑完：

```
— 第 1 发 · 第 1 层 灰烬书童（火）· 献上 bottle（水克火）
   水 · 克制 · 69 伤害 S 级
   「那瓶液体在空气中泛起一丝潮湿的寒意，仿佛从深井底部涌出的冷泉…」
   ★ 登楼 → 第 2 层
   …
★★ 通关。共 10 发，耗时 68.9s，旅人剩余体力 65
```

| 情况 | 伤害 |
| --- | --- |
| 属性克制（占画面 35%） | 71 |
| 属性被压制 | 19 |
| 无克制 | 29 |

通关后自动沉淀的长期记忆：

```
拾物奇谭·2026-10-02 → 通关；共献祭 10 件，旅人剩余体力 65；
                      最狠的一击是 bottle（水 68 伤害 S 级）
```

### 这一路上修掉的三个模型毛病

1. **守阁灵自己编了个名字**「玄影」，其实它叫「灰烬书童」。
   修法：用 `model:start` 钩子在每次请求前动态注入当前层的身份。
   （顺带给内核加了一行——让 `model:start` 的返回值生效，之前发完就丢了。）
2. **每回合说同一句话**。修法：每回合随机指定一个切入角度
   （从声音 / 气味 / 触感 / 光线 / 一段旧回忆写起）。
3. **写战报时编造回合**。让它写战报，它编出了 10 个回合——实际只打了 3 回合。
   修法：加 `quest_log` 工具返回**真实**回合记录，并规定战报里的每个数字必须能在记录里找到出处。
   修完再测，战报与存档逐条对得上。

---

## 目录结构

```
local-ai-lab/
├─ server.js              # 后端：静态托管 + Ollama 代理 + ReAct 循环 + Harness + 游戏路由
├─ public/
│  ├─ index.html / style.css / app.js      # 主工作台（对话 + 视觉面板 + Harness 面板）
│  └─ game.html / game.css / game.js       # 《拾物奇谭》
├─ harness/
│  ├─ agent.js            # 核心主循环
│  ├─ lifecycle.js        # 四层 10 个钩子
│  ├─ provider.js         # 模型抽象（吸收 Ollama / OpenAI 方言差异）
│  ├─ tools.js            # 工具注册表（invoke 永不抛出）
│  ├─ context.js          # 会话树 + token 预算
│  ├─ memory.js           # 长期记忆
│  ├─ extensions.js       # 扩展管理器
│  ├─ builtin.js          # 内核六工具
│  ├─ yolo.js             # YOLO 能力封装
│  ├─ game-rules.js       # 【第五部分】规则引擎（纯函数）
│  ├─ extensions/
│  │  ├─ vision.js        # 让 agent 长眼睛
│  │  ├─ research.js      # 自动科研
│  │  └─ quest.js         # 【第五部分】守阁灵
│  ├─ smoke.js            # 内核冒烟测试
│  ├─ e2e.js              # HTTP 端到端测试
│  ├─ game-play.js        # 【第五部分】命令行试玩
│  └─ game-auto.js        # 【第五部分】自动通关演示
├─ yolo/
│  ├─ train.py            # 训练（参数理由写在 docstring）
│  ├─ infer.py            # 推理封装，pt / onnx 双引擎
│  ├─ camera_server.py    # 摄像头 MJPEG + 检测服务
│  ├─ detect_stdin.py     # 给 Node 调用的单图检测（stdin 传图）
│  ├─ export_onnx.py      # 导出 ONNX
│  └─ benchmark.py        # 引擎性能对比
└─ sandbox/               # agent 能读写的沙箱：文件 / 存档 / 记忆
```

## 怎么跑

**只想玩游戏：双击 `game.bat`**（确保 Web 服务在跑 → 打开游戏页）。

**全都要：双击 `start.bat`**（自动检查 Ollama、拉起摄像头和 Web 服务、
游戏页 + 智能体工作台都打开）。也可以带参数只开一个：
`start.bat game` / `start.bat agent`。

结束运行 `stop.bat`。

> 没有 exe。这项目是 Node + Python 脚本，不打包成 exe——
> 两个 bat 就是它的"启动器"，双击即用。

手动启动：

```bash
# 1. Ollama（模型已拉过就不用再跑）
ollama serve
ollama pull qwen3:8b

# 2. 摄像头 YOLO 服务（第五部分要玩就得开）
cd yolo
D:/yolo-venv/Scripts/python.exe camera_server.py \
    --weights runs/detect/runs/coco128_yolo11n/weights/best.pt

# 3. Web 服务
node server.js          # → http://127.0.0.1:5178
```

> 别用 `node server.js &` 后台启动 —— 进程会随终端关闭被回收（本机实测过）。
> 要么独立窗口，要么直接用 bat。

然后：

- `http://127.0.0.1:5178/public/game.html` —— 《拾物奇谭》
- `http://127.0.0.1:5178/` —— **智能体工作台**（对话、YOLO 视觉面板、🧩 Harness 工作台）。
  智能体没有单独的开关——打开这个页面它就在了，左边输入框直接使唤，
  它会真的去调工具（算数、读文件、识图、动摄像头）。游戏里的守阁灵也是它扮的。
- `node harness/smoke.js` —— 内核冒烟
- `node harness/e2e.js "目标"` —— Harness 端到端
- `node harness/game-auto.js` —— 自动通关（人类只按一次启动键，约 70 秒）
- `node harness/game-play.js cup 0.9 32` —— 单回合命令行试玩

**没有摄像头也能玩**：游戏页上有「手动举物」按钮，能完整通关五层。

**要拿去演示给人看**：见 [`DEMO.md`](DEMO.md) —— 里面有 5 分钟演示脚本、
每层该举什么、故障预案，以及对方可能追问的问题怎么答。
- `node harness/game-auto.js` —— 自动通关演示（人类只按一次启动键）

## 后续

- **第三部分**：拿到板子（建议 ESP32）后加一个 `serial_write` 扩展即可，内核不用动
- 换 VLM（`qwen2.5vl:3b`）做真正的图文问答
- 补 RAG：把 `sandbox/` 里的文档切片，加 `search_notes` 工具
- 游戏加「结果审核器」：在 `tool:end` 钩子上检查模型有没有篡改裁决数字
