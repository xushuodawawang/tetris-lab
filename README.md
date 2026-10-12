# Tetris Lab · 俄罗斯方块 v0.2

JavaScript + HTML5 Canvas 课程项目，提供人类模式、独立 WebSocket AI、跨语言 AI 示例、遗传算法调参与自动评测。

## 启动与试玩

需要 Node.js 20 或更新版本。在项目目录执行：

```sh
npm install
npm start
```

打开 http://localhost:5173 。浏览器端使用原生 JavaScript、Canvas 与 WebSocket；Node.js 服务端使用 `ws`，计算在独立 worker 中执行。
Windows 若阻止 `npm.ps1`，使用 `npm.cmd install`、`npm.cmd start`。
请通过本地服务器访问，不要双击 HTML 文件。

右上方可选择人类模式或 AI 模式。AI 默认使用 JavaScript 两步前瞻，可选择单步/三步搜索、调整播放速度、暂停和查看实际 JSON 通信。
两种模式分别保存最高分；模式切换需要确认清空当前局。

## 操作与规则

| 按键 | 功能 |
| --- | --- |
| ← / → | 左右移动，可按住连续移动 |
| ↑ | 顺时针旋转 |
| ↓ | 按住加速下落，每格加 1 分 |
| Space | 直接落下，每格加 2 分 |
| P / Esc | 暂停、继续 |
| R | 重新开始（进行中的游戏需要确认） |
| Enter | 开始、结束后再来一局 |

棋盘为 10 列 × 20 行，使用 7-bag 随机方块，预览后续 3 块。
每消除 10 行升级；一次消除 1 / 2 / 3 / 4 行，分别获得 100 / 300 / 500 / 800 × 消除前等级的分数。
旋转采用简单水平修正，不是完整 SRS；没有 Hold、T-spin 或对战。
人类模式采用重力与锁定等待；AI 演示/评测采用每块决策、等待响应时暂停重力的同一规则约定。

## AI 算法

1. BFS 搜索当前高度可执行的左右移动和旋转路径，再计算硬降落点；不包含地面滑入、下移后的 tuck 搜索。
2. 十位行掩码模拟碰撞、放置和消行；候选路径经真实游戏核心验证后才执行。
3. 使用高度总和、空洞、表面起伏、最高列、井深和消行奖励进行线性评价。
4. 默认只对前 8 个候选进行两步前瞻，使用已公开的下一块。三步模式继续前瞻第二个预览块；不读取 RNG 或隐藏序列。

默认权重是人工设定的基线。遗传算法工具可以优化参数，但不会自动覆盖已部署策略。
本次三代小规模训练没有改善最优适应度，正式评测仍使用冻结的默认权重。

## 自动评测

页面点击“自动评测”可运行 10 或 200 局、查看进度、停止任务并导出 JSON/CSV。关闭窗口后任务继续，重新打开可查看进度。

命令行运行相同协议的评测，默认自行启动临时 WebSocket 服务：

```sh
npm run evaluate -- --games 200 --start-seed 10000 --max-pieces 5000 --output results/benchmark-200
```

每局的随机种子、消行数、分数、落块数、结束原因和决策耗时均保存到文件。
`--max-pieces 0` 表示运行到自然结束，可用于要求完整局寿命的验收；高水平策略可能运行很久。
`--transport direct` 用于快速开发验证，正式通信测试使用默认 `websocket`。

**已运行 200 局：观测平均 1998.395 行，最少 1996 行，最多 2000 行；200 局均超过 1000 行。**
本次预先设置每局 5000 块上限，200 局全部截断、自然结束 0 局。因此平均值是整局表现的下界，不能称为“200 局自然结束后的精确平均”。
测试种子为 10000～10199，开发/训练种子另用 100 等；规则为 7-bag、有预览。改变随机方式、预览或动作时序后需要重新验证。
结果文件：[JSON](results/benchmark-200.json)、[CSV](results/benchmark-200.csv)。详细条件见 [VALIDATION.md](VALIDATION.md)。

## Python 独立 AI 示例

游戏端保持 JavaScript。为覆盖题目“其它语言通过 AI 接口实现 AI”，另外提供 Python 3.10+ 的独立算法进程：

```sh
python -m pip install -r ai/requirements.txt
python ai/python_bot.py
```

先启动 Node.js 游戏服务，再启动 Python 程序，然后在 AI 控制台选择 Python AI。
Python 自行计算落点并返回 JSON，Node.js 只负责转发；Python 不依赖或调用 JavaScript AI。
Python 未启动时，游戏明确暂停并提示，不会静默回退。

```sh
npm run evaluate -- --provider python --url ws://127.0.0.1:5173/ai --games 10 --start-seed 500 --max-pieces 3000 --output results/python
```

Python 已通过 60 次独立 WebSocket 落子的接入测试，尚未运行 Python 的 200 局性能评测。上述 200 局结果属于 JavaScript 策略。

## 遗传算法与验证

```sh
npm run train -- --population 8 --generations 4 --games 3 --max-pieces 1500
npm test
npm run test:python
```

训练结果保存为 `results/training.json`。用独立开发种子复核后，可用 `--weights results/training.json` 评测。
不要依据正式测试种子反复选参数，再将结果当作独立测试。

## 模块

```text
src/engine.js          共用游戏规则、种子随机、状态快照
src/protocol.js        消息校验与动作路径的原子验证执行
src/ai-client.js       浏览器 WebSocket 客户端
src/app.js             绘制、输入、模式与 AI 播放
src/benchmark-ui.js    后台评测界面与 JSON/CSV 导出
ai/search.js           JavaScript 位掩码搜索与评价函数
ai/service.js          WebSocket 服务与 Python 转发
ai/worker.js           JavaScript AI 计算线程
ai/python_bot.py       Python 独立 AI
ai/evaluation.js       可复现单局与批量评测
scripts/evaluate.js    命令行评测入口
scripts/train.js       遗传算法参数优化
tests/                 核心、协议、服务与 Python 接入测试
PROTOCOL.md            WebSocket/JSON 接口约定
DESIGN.md              视觉与规则设计
VALIDATION.md          验证结果与范围
results/               实际评测及训练记录
.agents/skills/         项目内前端设计 skills
```

前端沿用项目内 [Anthropic frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) 和 [Vercel web-design-guidelines](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines)。
WebSocket 使用 [ws](https://github.com/websockets/ws)。启发式特征思路参考 [LeeYiyuan/tetrisai](https://github.com/LeeYiyuan/tetrisai)，游戏和搜索实现由本项目编写。
