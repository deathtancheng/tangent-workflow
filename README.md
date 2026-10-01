# tangent-workflow
a hub of the secondly interview of AIU
# 华小牛 · 本地智能体工作台

跑在自己显卡上的 **大模型 + 视觉模型 + 自建智能体**，全程数据不出本机。

- **第一部分**：Ollama 本地推理 → Node 实现 ReAct 工具调用 → 纯前端三件套交互
一、大模型
1.根据自身设备的情况，完成本地大模型的部署(Llama.cpp、ollama、LMstudio等）
  社区可参考：
  1.魔搭社区：https://www.modelscope.cn/）
  2.hugging face(https://huggingface.co/)

2.搭建自己的智能体（dify、n8n、扣子等）
  
  将上述作为model provider
  通过API的形式，接入到自己的应用中
  应用形式可有（按难度递增）：
  1.Cli 
2.小程序对话（当然微信不会给你轻易过审）
  3.web（前端三件套、vue、react等）
  4.桌面应用内嵌（electron、tauri等不限）
- 
- **第二部分**：ultralytics 训练 YOLO11 → 实时摄像头检测 → 接入同一个 Web 应用，让大模型能"看"
- 二、yolo的跑通
1.完成ultralytics的一次训练（训练参数自己决定）
可参考：https://blog.csdn.net/linmoqian/article/details/157656782?spm=1001.2014.3001.5501
2.进行yolo的实时推理部署（可用python快速实现，再用cpp或Rust优化性能，注意参考开源库，而不是自研一坨大的）
3.接入应用中:
1.web（前端三件套、vue、react等）
2.桌面应用内嵌（electron、tauri等不限）
- **第三部分**：硬件结合--无法使用单片机制作故略
- 三、硬件的结合 （进阶）
如果你也玩单片机，那便再尝试此组合
在前面所提及的基础上，让AI控制单片机点灯。
再进阶点，让AI调参PID
再进阶点，在你的单片机上部署本地模型！
技术路线自由选择。
- **第四部分**：参考 pi agent 架构自建 **Harness**（四层生命周期 + 会话树 + 上下文预算 + 长期记忆 + 可插拔扩展 + 人类闸门）
- 四、Harness 的搭建 (进阶）
既然大鲸鱼那么火，我们能不能有自己的华小牛？
请参考pi agent的架构，搭建自己的Harness（Harness是什么呢？）
尽情结合你的专业方向和兴趣方向。

以下仅供参考：
1.自动科研：从收集论文，下载到本地，转好格式，整理好，自主设计实验，自主比较实验，自主调用机械臂，完成实验，收集实验结果，进行下一轮设计，最后完成论文撰写，自主发表，全程只需要人类作为启动子。
（你AI大人会自己赚钱，养活吃白饭的大学生）

---

## 架构总览

```
浏览器（HTML / CSS / JS 三件套）
   │
   ├─ fetch 流式请求（NDJSON）──────────────┐
   ├─ <img src="/api/camera/video"> MJPEG ──┼──┐
   │                                        │  │
   ▼                                        ▼  │
Node 22 后端 server.js                  Python 摄像头服务 camera_server.py
   ├─ 静态托管 public/                      └─ YOLO 逐帧推理 + MJPEG 推流
   ├─ /api/chat   → ReAct 智能体循环             （11 ms / 31 FPS）
   ├─ /api/detect → 图片检测（调 Python）
   ├─ /api/camera/* → 摄像头代理
   └─ /api/harness/* → 第四部分的 Harness
                    │            │
                    ▼            ▼
              Ollama（qwen3:8b，100% GPU）
                                 └─ YOLO（best.pt，pt 引擎 35 ms）
```

## 本机环境

| 项        | 值                                                             |
| -------- | ------------------------------------------------------------- |
| GPU      | NVIDIA GeForce RTX 4060 Laptop，8 GB 显存（50W 功耗墙）               |
| CPU / 内存 | 24 核 / 16 GB                                                  |
| 大模型      | Ollama 0.34.0 + `qwen3:8b`（Q4_K_M，5.2 GB，100% GPU 卸载占 5.6 GB） |
| 视觉模型     | ultralytics 8.4.171 + torch 2.9.1+cu130                       |

> **省了 4 GB 下载**：torch 直接复用 ComfyUI 秋叶整合包里现成的 `python 3.10 + torch 2.9.1+cu130`，  
> 用 `python -m venv --system-site-packages` 建一个继承型虚拟环境，装 ultralytics 时不污染 ComfyUI。

---

# 第一部分：本地大模型 + 智能体

## 快速开始

```bash
ollama serve                 # 托盘版会自动常驻，可跳过
ollama pull qwen3:8b         # 约 5.2 GB，官方源实测 ~9.5 MB/s
node server.js               # → http://127.0.0.1:5178
```

自定义：`PORT=8080 OLLAMA_HOST=http://127.0.0.1:11434 node server.js`

## ReAct 智能体

没用 Dify / n8n / 扣子。低代码平台要跑 Docker 全家桶，16 GB 内存会和 Ollama 抢资源；  
更要紧的是它们把工具编排、上下文拼接封装成了黑盒——而这恰恰是这份作业要练的东西。

`server.js` 里的 `runAgent` 手写了一个约 60 行的 ReAct 循环：

```
模型返回 tool_calls → 本地执行工具 → 结果以 role:'tool' 塞回上下文 → 再问一次 → 最多 6 步
```

## 内置工具

| 工具                                        | 作用        | 安全约束                           |
| ----------------------------------------- | --------- | ------------------------------ |
| `calculator`                              | 计算数学表达式   | 白名单字符过滤 + 仅允许 `Math.*`，拒绝任意代码  |
| `get_current_time`                        | 当前日期时间与星期 | —                              |
| `list_files` / `read_file` / `write_file` | 读写沙箱文件    | 限制在 `sandbox/`，单文件 ≤ 64 KB     |
| `fetch_url`                               | 抓网页正文     | 仅 http/https，15 s 超时，截断 3000 字 |
| `detect_image`                            | 检测沙箱里的图片  | 走 stdin 传图，绕开中文路径编码问题          |
| `detect_camera`                           | 看摄像头当前帧   | 通过摄像头服务取结果                     |
| `camera_snapshot`                         | 拍一张照存进沙箱  | 自动清洗文件名                        |

---

# 第二部分：YOLO 训练 + 实时推理

## 1. 训练

```bash
python train.py --data coco128.yaml --epochs 30 --batch 8 --imgsz 640
```

**本机实测结果**（RTX 4060 Laptop 8 GB）：

| 指标           | 值                                                       |
| ------------ | ------------------------------------------------------- |
| mAP@0.5      | **0.7878**                                              |
| mAP@0.5:0.95 | **0.6121**                                              |
| 训练耗时         | 约 4 分钟（30 epoch，~7 s/epoch）                             |
| 显存占用峰值       | 1.84 GB                                                 |
| 最佳权重         | `yolo/runs/detect/runs/coco128_yolo11n/weights/best.pt` |

参数为什么这么定（都写在 `train.py` 的 docstring 里）：

- `yolo11n` —— n 系列 2.6M 参数，8 GB 显存能开 batch=8；换 s/m 就得把 batch 砍到 2~4，不划算
- `imgsz=640` —— COCO 预训练权重的原生分辨率，降到 320 掉点明显
- `amp=True` + `cos_lr` + `warmup_epochs=3` —— 混合精度省显存提速，余弦退火在小数据集上更稳
- **`workers=0`** —— Windows 上 dataloader 多进程实测会直接崩（`workers=2` 崩过一次），128 张图单进程加载完全够

## 2. 推理与性能

`infer.py` 封装了两种引擎，接口统一：

```bash
python infer.py --source 0                       # 摄像头窗口实时检测（按 q 退出）
python infer.py --source bus.jpg --json          # 单图输出 JSON
python infer.py --source bus.jpg --engine onnx   # 走 ONNX Runtime
```

导出 ONNX（10.2 MB）：

```bash
python export_onnx.py --weights runs/detect/runs/coco128_yolo11n/weights/best.pt --simplify
```

**实测对比**（640×480 真实图，6 次预热 + 40 次迭代，端到端含前后处理）：

| 引擎                           | 平均          | P95      | 最快      | FPS  |
| ---------------------------- | ----------- | -------- | ------- | ---- |
| PyTorch (.pt)                | **34.9 ms** | 48.9 ms  | 25.0 ms | 28.7 |
| PyTorch FP16                 | 41.0 ms     | 55.9 ms  | 30.5 ms | 24.4 |
| ONNX Runtime（限 4 线程）         | 104.0 ms    | 108.3 ms | 99.5 ms | 9.6  |
| ONNX Runtime（独立进程，无 PyTorch） | ~35 ms      | —        | —       | ~28  |

**关于"用 C++/Rust 优化"，说点实话**：

ONNX 这条路的标准打法是 onnxruntime 挂 CUDA EP 或转 TensorRT——都是成熟开源 C++ 库，  
不需要自己写算子。本机卡在了运行时依赖上：

```
Failed to create CUDAExecutionProvider.
Require cuDNN 9.* and CUDA 12.* ... cublasLt64_12.dll is missing
```

本机 torch 是 cu130（CUDA 13），ORT 1.23 只认 CUDA 12 + cuDNN 9。我装了  
`nvidia-cublas-cu12` / `nvidia-cudnn-cu12` 并在 `infer.py` 里用 `os.add_dll_directory` 注册了  
DLL 目录，但 ORT 依然**静默回退**到 CPU EP（明确指定 `providers=['CUDAExecutionProvider']`  
也不报错，直接给你 CPU）。这是环境层面的坑，不是代码问题。

过程中倒是挖出一个更有价值的结论：**ONNX 那 104 ms 根本不是模型慢，是 CPU 线程争用**。  
PyTorch 的 OMP 线程池占着 24 个线程，ORT 默认再按核数开 24 个，48 个线程抢 24 核，  
延迟直接被拖到 486 ms。把 ORT 的 `intra_op_num_threads` 压到 4 → 109 ms；  
完全不加载 PyTorch 的独立进程里跑 → **35 ms，和 PyTorch GPU 持平**。  
所以 `Detector(..., num_threads=4)` 这个参数不是摆设，同进程混用两个推理引擎时必调。

FP16 那一行没拉开差距，是因为 ultralytics 的 `half` 参数已经废弃，且 34 ms 里的大头是  
`predict()` 的 Python 侧封装开销，不是卷积计算。

真正把延迟压下来的是**常驻进程**：摄像头服务把模型常驻显存，单帧 **11.4 ms / 31.5 FPS**，  
比每次重新加载的 3 s 冷启动快两个数量级。

## 3. 接入 Web 应用

```bash
python camera_server.py --weights runs/detect/runs/coco128_yolo11n/weights/best.pt --source 0
node server.js
```

浏览器打开 <http://127.0.0.1:5178，点侧栏「👁> 视觉面板」：

- 左侧是 MJPEG 实时流（已画框）
- 右下「让 AI 描述画面」会把 YOLO 的检测结果（`检测到：person×2、laptop×1…`）拼成提示词  
  发给 qwen3:8b，让文本大模型据此推断场景并作答

> 为什么不是端到端多模态：qwen3:8b 是纯文本模型，看不了图。这里走的是  
> **YOLO 感知 → 结构化文本 → LLM 推理** 的路子，8 GB 显存下比再塞一个 7B 视觉模型现实得多。  
> 想升级成真·看图，把 Ollama 换成 `qwen2.5vl:3b` 之类的 VLM 即可，工具接口不用动。

---

# 第四部分：Harness

## Harness 是什么

一句话：**Agent = 大模型 + Harness**。

模型负责"想"，Harness 负责让它想得**下去**——  
给它工具、管住上下文、记住上次的事、在危险动作前拦一道、把每一步摊开给人看。  
模型换个版本只是换一个 provider；真正决定这个 Agent 能干什么的，是外面这一圈。

第一部分那个 `/api/chat` 是个写死的 ReAct 循环，能跑但不长；  
这一部分是把它拆成可观测、可干预、可扩展的骨架。

## 四层生命周期 + 10 个钩子节点

```
trace:start                      一次完整会话（人给目标 → agent 干完）
  └─ turn:start                  一轮 = 一次模型调用 + 它触发的所有工具
       ├─ model:start → model:stream* → model:end
       ├─ tool:start → tool:run → tool:end        （每个工具各一次）
       └─ turn:end
trace:end
```

钩子（可干预，能改 ctx、能抛错阻断）和事件（只读观测，推给 UI）是两套机制：

|    | 注册方式                     | 能不能改流程                 |
| -- | ------------------------ | ---------------------- |
| 钩子 | `lifecycle.on(HOOK, fn)` | 能，返回补丁对象会合并回 ctx，抛错即阻断 |
| 事件 | `lifecycle.onEvent(fn)`  | 不能，观察者自己炸了也不会拖垮 agent  |

区分这两者是刻意的：给 UI 推进度不应该有能力改写 agent 的判断。

## 六个模块

| 文件              | 职责                                                   |
| --------------- | ---------------------------------------------------- |
| `lifecycle.js`  | 钩子节点定义与调度，区分干预/观测                                    |
| `provider.js`   | 模型抽象。`for await (chunk of provider.chat())`，换模型不改主循环 |
| `tools.js`      | 工具注册与执行。**`invoke()` 永不抛出**，失败也当普通结果返回               |
| `context.js`    | 会话树 + token 预算 + 压缩                                  |
| `memory.js`     | 长期记忆：事实 + 情节，关键词加权检索，JSON 落盘                         |
| `extensions.js` | 扩展热插拔：一组工具 + 若干钩子 + 一段系统提示                           |

核心循环在 `agent.js`，约 400 行。

## 四个设计决策（以及和 Pi 的分歧）

**1. 极简内核，能力靠插。**  
内核只有 `read / write / edit / bash / calculator / now` 六个工具。  
YOLO 视觉和科研流程都在 `extensions/` 里，装上才有、卸掉就退回纯文本，内核一行不用改。  
这是内核能一直维持几百行的唯一保证——主循环里不许出现任何业务判断。

**2. 错误即消息。**  
工具炸了不抛异常，报错原文照常喂回模型让它自己绕。  
实测有效：摄像头没检测到目标时，agent 如实回答"画面可能太暗"，没有编造。

**3. 对话是树，不是列表。**  
回退只是把指针挪到另一个节点，O(1) 操作，不破坏已有数据。  
配合"有状态在外、无状态在内"的切分——turn 循环只认传进来的 messages，  
所以单轮可以重放、可以回退、可以并行。

**4. 窗口是预算，不是容器。**  
超预算时不砍头，而是让模型把中间段压成摘要塞回去，系统提示和最近 8 条永远保留。

### 我和 Pi 唱反调的地方

Pi 主动砍掉了权限弹窗。我保留一个极简权限门，理由是：  
这个 agent 要碰**真实资源**（文件、摄像头、以后还有单片机），  
而且题目里写了「人类仅作启动子」——启动子不等于撒手不管。  
工具分三级：`safe` 直接跑，`write` / `danger` 回来敲门。

另外 Pi 面向短平快的编码会话；我要跑自动科研这类长任务，  
所以加装了**上下文预算**和**长期记忆**两样它没有的东西。

## 扩展：自动科研流水线

`extensions/research.js` 是对「人类仅作启动子」的直接回答：  
你给一句话目标，它自己跑完 检索 → 记笔记 → 做实验 → 沉淀记忆 → 出报告，  
全程只有写文件和执行命令时才回来敲门。

它证明的是扩展能承载**方法论**，不只是多几个工具：  
工具（`read_web` / `save_note` / `remember` / `recall`）

- 钩子（`tool:end` 写审计流水，`trace:end` 自动落结构化报告）
- 系统提示（把科研流程的约定注入模型）。

换一个专业方向，复制这个文件改掉流程和笔记模板即可，内核不用动。

## 实测

| 场景              | 轮次 | 工具 | 耗时     | 结果                        |
| --------------- | -- | -- | ------ | ------------------------- |
| 计算 + 写文件        | 3  | 2  | 4.7 s  | 权限门拦下 write，放行后写入成功       |
| 查日期 + 算天数 + 写文件 | 4  | 3  | 12.1 s | 报告自动落盘                    |
| 存长期记忆           | 2  | 1  | 5.0 s  | 事实写入 `memory/memory.json` |
| **重置会话后回忆**     | 2  | 1  | 3.5 s  | 短期上下文清空，长期记忆命中并答出路径与 mAP  |
| 看摄像头（服务在线、画面全黑） | 2  | 1  | 2.1 s  | 如实回答"没检测到目标"，未编造          |
| bash 列目录（危险级）   | 2  | 1  | 7.4 s  | 权限门拦下，放行后执行               |

### 一个诚实的失败案例

问「距年底还有多少天」，模型自己构造了 `365 - (10*30 + 1)` 得到 64，  
正确答案是 91。`calculator` 忠实算出了它给的式子——**工具保证执行正确，不保证建模正确**。  
Harness 拦不住这类错误，能拦住的只是"哪些操作可以做"。  
这恰恰说明权限门和结果审核是两件事，后者要靠 hook 外接校验器，目前没做。

---

## 目录

```
local-ai-lab/
├─ server.js             # Node 后端：静态托管 + Ollama 代理 + ReAct 智能体 + YOLO + Harness 路由
├─ public/               # 前端三件套
│  ├─ index.html  ├─ style.css  └─ app.js
├─ harness/              # 第四部分：自建 Harness
│  ├─ index.js           # 组装入口 createHarness()
│  ├─ agent.js           # 核心主循环（10 个钩子在这里被串起来）
│  ├─ lifecycle.js       # 四层生命周期 + 10 个钩子节点
│  ├─ provider.js        # 模型抽象（ollama / openai 兼容）
│  ├─ tools.js           # 工具注册表，invoke() 永不抛出
│  ├─ builtin.js         # 内核工具：read/write/edit/bash/calculator/now
│  ├─ context.js         # 会话树 + token 预算 + 压缩
│  ├─ memory.js          # 长期记忆：事实 + 情节 + 检索
│  ├─ extensions.js      # 扩展管理器
│  ├─ extensions/
│  │  ├─ vision.js       # YOLO 视觉：look / capture / detect_image
│  │  └─ research.js     # 自动科研：read_web / save_note / remember / recall
│  ├─ yolo.js            # YOLO 能力封装（stdin 传图，避开中文路径坑）
│  ├─ smoke.js           # 冒烟测试（不走 HTTP）
│  └─ e2e.js             # 端到端测试（走真实 HTTP，含权限确认往返）
├─ yolo/
│  ├─ train.py           # 训练（参数在 docstring 里写清了理由）
│  ├─ infer.py           # 推理封装，pt / onnx 双引擎
│  ├─ camera_server.py   # 摄像头 MJPEG 服务
│  ├─ detect_stdin.py    # 给 Node 调用的单图检测（stdin 传图）
│  ├─ export_onnx.py     # 导出 ONNX
│  └─ benchmark.py       # 引擎性能对比
├─ sandbox/              # 智能体能读写的沙箱（notes/ + memory/）
└─ README.md
```

## 怎么跑

```bash
node server.js                  # 后端 + 前端，http://127.0.0.1:5178
node harness/smoke.js           # 纯内核冒烟测试
node harness/e2e.js "你的目标"   # 走 HTTP 的端到端测试
```

Web 界面右侧「🧩 Harness 工作台」面板可以实时看到  
trace / turn / tool 每一层的事件，以及权限闸门弹窗。

## 踩过的坑

1. **GitHub 权重下不动** —— ultralytics 默认从 GitHub Releases 拉 `yolo11n.pt`，国内会超时重试。  
   用 ghproxy 镜像手动拉下来放本地即可：`https://ghproxy.net/<github-url>`。
2. **Windows dataloader 多进程崩溃** —— `workers>0` 直接崩，设 `workers=0`。
3. **onnxruntime-gpu 装成 1.16.3** —— pip 解析出了旧版本（要 CUDA 11），得显式 `==1.23.2`；  
   它还会把 numpy 升到 2.x，导致 ComfyUI 的 cv2 4.7（`numpy.core.multiarray failed to import`）直接废掉，  
   解决办法是在 venv 里另装一个支持 numpy 2 的 opencv。
4. **Python 往 stdout 打日志** —— 会让 Node 解析 JSON 失败。引擎信息必须走 stderr，  
   Node 侧也从后往前找第一段合法 JSON，双保险。
5. **MSYS 路径坑** —— 原生 exe 不认 `/d/xxx`，要写 `D:/xxx`；`taskkill` 得配  
   `MSYS_NO_PATHCONV=1` + 单斜杠 `/PID`。
6. **Ollama 要求 `tool_calls.arguments` 是对象** —— 传字符串会被它自己的 JSON 解析拒绝，  
   报 `Value looks like object, but can't find closing '}' symbol`（这条错误信息完全指错了方向，  
   实际是参数格式问题）。OpenAI 兼容接口则相反，要字符串。  
   这类方言差异一律收在 `provider.js` 里，主循环只认一种内部格式。
7. **权限确认必须走异步往返** —— agent 在等人类表态时是挂起的，  
   前端必须在读流循环里 `await` 用户的点击再 POST 回 `/api/harness/confirm`，  
   不能先收完整个流再处理，否则会死锁。

## 后续

- 换 VLM（`qwen2.5vl:3b`）做真正的图文问答
- 补 RAG：把 `sandbox/` 里的文档切片做检索，加 `search_notes` 工具
- YOLO 换自己的数据集：把 `--data` 指向自己的 yaml 即可，其余不用动
- Harness：结果审核器（挂 `tool:end` 校验工具输出是否合理，补上"建模错误"那一环）
- Harness：把 `bash` 换成真正的沙箱（容器 / 受限用户），目前只靠黑名单
- Harness：会话树的分支可视化，现在只有回退 API，界面上还没画出树

