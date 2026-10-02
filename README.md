# MinecraftCTF

一个运行在真实 Minecraft Java Paper 服务端上的多人夺旗（CTF）插件 MVP。

项目不是独立模拟器：Paper 负责真实的 Minecraft 协议、世界、玩家实体和事件；`MinecraftCTF` 插件负责 CTF 规则、地图和比赛状态；二维 viewer 只是读取服务端状态的观战界面。

## 当前能力

- 固定地图 `ctf_arena`，比赛范围 `x=-24..24`、`z=-36..36`。
- 红队位于负 X 半场，蓝队位于正 X 半场；双方各有 8 面旗和 8 个目标点。
- 双方可以同时出发、拾取敌方旗帜并返回己方目标点插旗。
- 180 秒比赛；一队插满 8 个目标点立即获胜，超时按比分判定，比分相同为平局。
- 可变人数：支持 `1v1`、`2v2`、`3v4` 等，每队至少 1 人、最多 16 人。
- 自动拾旗、自动插旗；旗帜会在被抓捕、死亡或退出时掉落并在附近合法草地重立。
- 己方半场内靠近敌方玩家会触发抓捕；被抓捕者进入本队监狱 30 秒，踩压力板可以提前释放。
- 参赛者使用队伍色皮革护甲，装备绑定诅咒；比赛期间限制破坏、放置、物品拾取和交互。
- 服务端是规则和比分的唯一权威，关键状态会写入 `events.jsonl`。
- 提供本地二维 viewer，可显示地图、玩家、旗帜、目标点、比分、倒计时、监狱和事件流。
- 提供 Mineflayer 本地测试 bot；bot 只连接 `127.0.0.1`，不会连接公网服务器。

## 项目结构

```text
pom.xml                                      Maven 构建配置
src/main/java/com/minecraftctf/
  CtfPlugin.java                             比赛状态机、地图规则、事件日志
  CtfCommand.java                            /ctf 命令
  ViewerStateWriter.java                     viewer 快照写入
src/main/resources/
  plugin.yml                                 Paper 插件声明
  config.yml                                 默认配置
bot-test/
  local_bot_test.js                          本地双 bot smoke test
  package.json                               bot 测试依赖和命令
viewer/
  server.js                                  本地 viewer 服务和演示局入口
  public/                                    viewer 前端
ctf_bot.js                                   早期客户端参考，不由服务端执行
server/
  run-local.ps1                              本地 Paper 启动脚本
  README.md                                  本地服务端目录说明
```

## 环境要求

- Windows、PowerShell。
- Java 21 或更高版本；当前本地验证使用 Java 25。
- Maven 3.9+，用于编译插件。
- Paper `1.21.8 build 60`，放到 `server/paper-1.21.8-60.jar`。
- Node.js 18+；只有运行 bot smoke test 或 viewer 时需要。

## 编译插件

在仓库根目录执行：

```powershell
mvn -DskipTests package
```

产物：

```text
target/minecraft-ctf-0.1.0-SNAPSHOT.jar
```

`server/run-local.ps1` 会在启动前自动把这个 JAR 复制到 `server/plugins/minecraft-ctf.jar`。

## 启动真实 Paper 服务端

1. 下载 Paper `1.21.8 build 60`，放到 `server/paper-1.21.8-60.jar`。
2. 在仓库根目录运行：

   ```powershell
   .\server\run-local.ps1
   ```

3. 第一次启动会生成并接受本地 `eula.txt`。
4. Minecraft Java 客户端连接：

   ```text
   地址：127.0.0.1:25565
   ```

本地测试服务端默认使用 offline mode，仅适合本机开发，不要直接暴露到公网。offline mode 允许未认证用户名连接，因此不要在公网环境复用这套配置。

## 手动开始一局

进入服务器后：

```text
/ctf setup
/ctf join left
/ctf join right
/ctf ready
/ctf status
```

实际使用时，玩家分别加入 `left` 和 `right` 队；两队都至少有 1 人并且全部准备后自动开局。管理员也可以使用：

```text
/ctf start
/ctf stop
```

`left` 是负 X 的红队，`right` 是正 X 的蓝队。

### 兼容聊天协议

历史客户端可以发送以下消息加入大厅：

```text
match team:<team_no> enemy:<enemy_team_no> players:<num_players> map:<map_choice>
Are you ready?
I'm ready!
Game start: {"left":[...],"right":[...]}
Game over!
```

其中 `players:<num_players>` 表示每队目标人数；`enemy:none` 可以启动单队测试局。`map:fixed`、`map:any` 当前都使用固定地图，`map:random` 会提示当前 MVP 尚未提供随机地图。

## 固定地图和监狱坐标

地图核心范围：

```text
x = -24..24
z = -36..36
中央分界线：x = 0
地面高度：Y = 64
```

监狱按实测数据生成。原始资料中的 `Y=1` 按地图相对高度解释，Paper 世界中的实际地面高度为 `Y=64`：

| 队伍 | 监狱中心 | 监狱门 | 救援压力板 |
| --- | --- | --- | --- |
| 红队 / 负 X | `(-15.5, 64, 28.5)` | `(-15.5, 64, 26.5)` | `(-15.5, 64, 24.5)` |
| 蓝队 / 正 X | `(16.5, 64, 28.5)` | `(16.5, 64, 26.5)` | `(16.5, 64, 24.5)` |

目标点插旗后会保留金色边框，并用对应队伍颜色标识已插入的旗帜，方便在 viewer 中辨认。viewer 当前不显示图片中的哞菇（Mooshroom）三角标记。

## 本地二维 viewer

确保 Paper 已启动，然后在另一个 PowerShell 窗口运行：

```powershell
cd viewer
npm start
```

浏览器打开：

```text
http://127.0.0.1:3000
```

点击“开始演示局”会启动两个只连接本机 Paper 的 Mineflayer bot。演示使用双方同时行动路线；页面显示的数据来自：

```text
server/plugins/MinecraftCTF/viewer-state.json
```

viewer 是观战工具，不是 Minecraft 客户端，也不提供 WASD 操作。

## 本地 bot smoke test

首次安装依赖：

```powershell
cd bot-test
npm install
```

运行双 bot 测试：

```powershell
npm run smoke
```

默认配置：

```text
服务器：127.0.0.1:25565
bot 数量：2
每队人数：1
行动模式：双方同时行动
```

也可以通过环境变量调整：

```powershell
$env:CTF_BOTS = 2
$env:CTF_PLAYERS = 1
$env:CTF_ACTIVE_TEAM = both
npm run smoke
```

成功时会在终端输出 `PASS`，并且服务端事件日志中应出现 `flag_pickup`、`flag_capture` 和 `match_end`。

## 事件和状态文件

运行时生成文件不会纳入 Git：

```text
server/plugins/MinecraftCTF/events.jsonl       比赛事件流水
server/plugins/MinecraftCTF/viewer-state.json  viewer 快照
server/logs/                                   Paper 日志
```

事件示例包括：

```text
map_setup
match_start
flag_pickup
flag_capture
jail
release
flag_reset
match_end
```

## 架构说明

```text
Minecraft Java 客户端 / Mineflayer bot
                 │真实 Minecraft 协议
                 ▼
       Paper 1.21.8 服务端
                 │
                 └── MinecraftCTF 插件
                     ├── 地图和方块
                     ├── 旗帜、目标点和比分
                     ├── 抓捕、监狱和结算
                     ├── events.jsonl
                     └── viewer-state.json
                                  │
                                  ▼
                         本地二维 viewer
```

服务端是唯一权威；bot 和 viewer 都不能自行决定比分或比赛结果。

## 当前限制

- 当前只有一张固定地图，没有随机地图生成器。
- viewer 是二维观战界面，不渲染完整 Minecraft 3D 世界。
- 断线重连、权限分层、反作弊和正式比赛服安全加固尚未完成。
- 事件日志目前以 JSONL 保存，暂未提供回放页面和统计导出。
- 本地 `server/` 目录中的 Paper JAR、世界、日志和缓存不应提交到 Git。

## 后续计划

1. 把 `ArenaMap` 抽象成可校验的地图定义。
2. 增加断线重连、观战和更细的权限控制。
3. 为事件日志补充 `matchId`、tick、坐标和玩家 UUID。
4. 增加比赛回放、统计导出和自动化集成测试。
5. 在确认规则后再扩展随机地图和更多障碍物。
