# WebSocket AI 接口 v1

游戏与评测器连接 `ws://127.0.0.1:5173/ai`，其它语言 AI 程序连接 `/bot`。
通信使用 JSON 文本帧，单条消息上限 64 KiB。服务只监听本机。

## 初始化

`/ai` 连接成功后服务发送：

```json
{"type":"ready","protocolVersion":1,"rules":{"width":10,"height":20,"randomizer":"7-bag","rotation":"horizontal-kicks-v1","preview":3,"hold":false,"gravity":"paused-during-ai-decision"},"providers":["builtin"]}
```

`providers` 在连接时列出可用程序；已连接 Python 时包含 `python`。
`/bot` 收到同版本 `hello` 和规则后等待 `decide` 请求。

## 请求

`type=decide` 请求字段如下。构造见 `src/protocol.js` 的 `requestFor()`。

| 字段 | 类型与含义 |
| --- | --- |
| protocolVersion | 整数 1 |
| gameId | 本局唯一字符串；重开产生新值 |
| requestId | 此次决策唯一字符串 |
| provider | builtin 或 python |
| state.stateVersion | 引擎状态版本；移动、旋转和生成方块时更新 |
| state.width / height | 10 / 20 |
| state.board | 20 行 × 10 列；0 表示空，I/O/T/S/Z/J/L 表示已锁定格 |
| state.current | type、matrix、x、y、rotation；matrix 与旋转编号一致 |
| state.next | 已公开的后续方块，最多 3 个 |
| state.score / lines / level / status | 分数、消行数、等级和 playing 状态 |
| options.depth | 1、2、3；包含当前块 |
| options.beam | 1～32；默认 8 |
| options.weights | 可选六个有限数值权重；绝对值不超过 100 |

原点是左上方，x 向右、y 向下；x/y 表示方块矩阵左上方。编号 0 是原始矩阵，每次顺时针旋转增加 1（模 4）。O 块不改变旋转编号。
矩阵和旋转规则在 `src/engine.js` 中定义。请求不含 RNG、完整队列或未来种子。

## 响应与执行

I 块从出生位置直接下落到空棋盘底部的响应示例（analysis 数值仅演示字段）：

```json
{"type":"action","protocolVersion":1,"gameId":"example","requestId":"1","stateVersion":1,"actions":["drop"],"target":{"x":3,"y":18,"rotation":0},"analysis":{"policy":"linear-preview-v1","depth":2,"candidates":17,"evaluated":153,"computeMs":0.8,"value":-5.1}}
```

动作只允许 `left`、`right`、`rotate`、`down`、`drop`。序列最多 200 步，必须以唯一的 `drop` 结束。
游戏在副本上验证整条路径和最终坐标，再执行；非法路径、错配编号、过期版本不能部分修改棋盘。
等待 AI 时不运行重力；操作序列在一个逻辑决策中执行。暂停期间保留响应，继续后再次验证；重开或更换设置后丢弃旧响应。
`analysis` 可包含评价值、特征、候选数和耗时，不参与动作合法性判断。

## Python 转发

选择 `provider=python` 时，服务将同一请求转发给 `/bot`，额外加入 `brokerId`。
Python 自行搜索，响应带原请求 gameId、requestId、stateVersion 和 brokerId；服务删除 brokerId 后原样转发。
最多连接一个外部 bot；不同玩家/评测连接通过 brokerId 分流，避免跨局串包。

## 错误与恢复

```json
{"type":"error","protocolVersion":1,"gameId":"example","requestId":"1","code":"BOT_OFFLINE","message":"Start the Python bot before using this provider"}
```

错误包括 `INVALID_MESSAGE`、`INVALID_BOT_RESPONSE`、`BOT_OFFLINE`、`TIMEOUT`、`SEARCH_ERROR`、`NO_MOVE`。
每个玩家连接只能有一个未完成请求。服务超时 15 秒，客户端 16 秒；错误暂停演示，不随机落子或静默回退。
`NO_MOVE` 表示搜索器没有找到路径，不是所有可能 tuck 动作都不存在的数学证明。

## 后台评测 HTTP 接口

- `POST /api/evaluation`：传入 games、maxPieces、depth、provider，可选 startSeed，启动任务。
- `GET /api/evaluation`：获取进度、结束状态或完整报告。
- `DELETE /api/evaluation`：停止任务，标为 cancelled，不宣称完成评测。

页面入口最多 200 局，每局上限 3000～20000 块；命令行可用 `--max-pieces 0` 运行至自然结束。
报告明确分开 completed 与 truncated，并记录规则、权重、随机种子和通信方式。
