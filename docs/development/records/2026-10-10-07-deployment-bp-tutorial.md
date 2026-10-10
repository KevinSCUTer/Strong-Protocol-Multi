# DEV-20261010-07 · BP 自定义音乐、教程入口与增量部署

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-10 / 2026-10-10，Asia/Shanghai |
| 状态 | 本地实现、定向回归与 macOS 实际部署/浏览器验证完成；Docker 容器验证受本机 daemon 故障阻塞 |
| 类型 | 功能 / 部署工具 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`9cc6fa22`；开始工作区干净 |
| 上游基线 | 本地已合并 v0.2.3，`1db8e510`，合并提交 `e5dcde75` |
| 提交归属 | 未提交、未推送、未部署远程服务器 |
| 关联 | [D018](../DECISIONS.md#d018)、[部署说明](../../DEPLOY.md)、[素材说明](../../ASSETS.md)、[人数规则](../../PLAYER_CAPACITY.md) |

## 需求、范围与验收

1. BP（禁盟约、选核心策略）优先使用服主 `MP3_FOLDER` 绝对路径目录内的 MP3，先检查数量，再按 `seed % count` 选择。无文件、目录不可用或播放失败时回退默认音乐。macOS 示例目录为 `/Users/kevin/code/stronghold/bp_music`。
2. 首页小按钮在新标签页打开用户提供的 `/Users/kevin/code/stronghold/Kevin/Tutorial` 多视角教程，克隆后部署也能访问。
3. 根目录 `start.sh` 支持新克隆与更新后的重复启动，首先输出 `卫戍协议，启动！！！`，继承 `PORT` 和 `MP3_FOLDER`，补齐当前版本计划的新增资源，保留既有和共享素材。用户目标端口为 3250。
4. 在 macOS 验证，并在 Alibaba Cloud Linux 3.2104 LTS 64 位的 Docker 镜像验证；如不可取得该镜像，使用已下载 Ubuntu。容器测试是否执行单独记录，不能从 macOS 结果推断 Linux 兼容性。

## 调查与决定

- 开局 seed 由 Lobby 生成；Match 原有规则 `(Number(opts.seed) >>> 0) || 1` 将零归一化为一。音乐采用同一有效 seed，不抽取或改变战斗/卡池随机流。
- 所需开局阶段为 `INFO_CHECK`、`BAND_DRAFT`、`BATTLE_CHECK`。之后沿用原有机变、休整、战斗、联防和领袖音乐选择。
- 服主 MP3 保持在仓库外，通过仅允许目录快照内编号的媒体接口访问。播放器复用现有 AudioManager 的用户操作解锁、音量、循环、淡入淡出及异步取消机制。
- 原教程含内嵌官方图片；按「No game art in git」转换为站点已有素材引用。273 张图片全部匹配（78 个原文件、195 个 96px 缩略图），103 个唯一 URL 均在已提交的 `data/assets.json` 中。
- 教程按原版四人口径撰写，入口注明本扩容分支的人数、固定分组和领袖血量规则；原教程内容及四视角链接保留，内嵌/断网阅读宣传改为图片随站点加载/在线阅读。
- 部署重跑使用 `--add-only --download-only`。准备过程中不修改已跟踪清单、锁文件或 Git 状态；运行时仍依赖维护者随版本提交的资源声明。当前仓库没有另一仓库的皮肤选择功能，新皮肤自动补齐需要进入下载计划并配套运行时清单和消费者。
- 共享 `public/assets`、`public/fonts` 根软链接需保留。部署就绪检查跟随它们核实普通非空文件；浏览器预缓存目录的 symlink 拒绝策略不在本次范围内，不能拿其 completeness 标志阻断本地部署。

## 实现或操作

| 部分 | 文件 / 行为 |
|---|---|
| 服务端音乐 | `server/bpMusic.js` 启动时快照第一层可读、非空普通 MP3；忽略隐藏文件、子目录、文件软链接；按 JS 文件名顺序排序，先判数量再取模。Match 固定保存选择，`m.public.bpBgm` 为可选字段；玩家/观战者同曲，重刷和重连保留 |
| 音乐 HTTP | `/api/bp-music/<64 位十六进制编号>` 仅解析快照内文件；访问时复核文件和目录；复用媒体 MIME、GET/HEAD、Range、ETag/304；不暴露绝对路径，不进游戏素材 ZIP |
| 客户端 | `public/js/audio.js` 的 BP key 保留解锁前请求，同曲阶段连续播放，HTTP 或解码失败回退 lobby BGM；token 防止旧失败覆盖新阶段音乐 |
| 教程 | `public/tutorial/` 五页、`tools/import-tutorial.mjs` 转换器、首页原生新标签页链接及四语言翻译；800×450 的按钮至少 44×24 px |
| 根启动 | `start.sh` 打印横幅、检查 Node≥22、调用部署准备、前台 `exec node server/index.js`；`--prepare-only`/`--check`/帮助退出而不启动 |
| 部署准备 | `tools/deploy.mjs` 检查全部生产依赖和锁文件 hash，需要时 `npm ci`，失败不回退 install；按输出缺项/时间和 vendor 工具 hash 刷新前端库；只补资源、字体、atlas 页；必需项失败退出非零 |
| 增量素材 | `tools/fetch-assets.mjs` 新增只下载不写清单的选项与未被当前清单引用的资源报告；`tools/assets/fonts.mjs` 补缺字体/WOFF2/CSS，保留已有非空共享文件 |
| 打包 | `tools/package.mjs` 将根启动与部署准备加入玩家包；原有生成 Linux 懒人包的外层启动行为保留 |
| 同步文档 | 架构、协议、客户端、META、素材、部署、0.2.3 分支说明及 D018；不改玩法模拟或 golden |

`tools/import-tutorial.mjs` 为维护者工具，缩略图匹配使用 macOS `sips`；Linux 启动只服务已转换 HTML，不运行导入器。没有把私有 MP3、官方图片、共享字体或依赖加入 Git。

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --version` / `npm --version` | macOS arm64，Node 24.14.0 / npm 11.9.0 | 可用 |
| 音乐、教程及开局重刷定向批次 | `test/bp-music.test.js`、`test/ui/audio.test.js`、`test/tutorial.test.js` 及重刷回归 | 49 pass / 0 fail / 0 skipped；包含零数量、稳定序号、GET/HEAD/Range、文件消失/软链接、同步重刷/重连及 HTTP/解码回退 |
| 实际 Chrome BP 流程 | Chrome 154.0.8037.99；`MP3_FOLDER` 为用户目录，3 首 MP3；INFO_CHECK→BAND_DRAFT→PREP | AudioContext running；自定义音轨解码为 259.042 秒、双声道、48 kHz；开局阶段同一播放源且只请求一次，PREP 恢复原曲；无页面错误。程序检查播放/解码状态，未声称人工试听 |
| 实际 Chrome 教程流程与截图 | 1440×900 / 800×450；Edge 未可用，采用已安装 Chrome | 首页原生链接新标签页、opener 为 null；四视角图片数 8/2/147/108，全部加载；窄屏入口可见且 44×24；截图打开检查；无页面错误 |
| `node tools/import-tutorial.mjs /Users/kevin/code/stronghold/Kevin/Tutorial` | macOS `sips`，本地已有素材 | 273/273 图片转换，零未匹配；在线阅读标签更新后已再跑浏览器验证 |
| `node tools/i18n.mjs check --all --strict` | en / ja / ko / zh-TW | 每包 1301/1301，无缺项或错误 |
| 文档一致性与路径批次 | `test/docs-consistency.test.js` / `test/docs-paths.test.js` | 最终收尾复核 31 pass / 0 fail |
| import / type CI 步骤 | `node tools/ci.mjs --only imports,typecheck` | exit 0；既有 sim-node import 例外按工具规则通过 |
| 最终 ESLint | 变动的 runtime、部署工具及测试 | 0 error；audio.js/lobby.js 两条既有 no-useless-assignment，fetch-assets.mjs 两条既有 warning（preserve-caught-error / no-useless-assignment）；新增部署工具/fixtures 无 warning |
| `node tools/fetch-assets.mjs --offline --add-only --download-only` | 当前共享资源与缓存索引 | exit 0；计划 9589 leaves＋711 Spine，673 模型可用、10956 文件/554.2 MiB，新增下载 0 字节；已提交清单保留。42 个可选缺项/38 个模型说明报告，未删除 178 个未引用文件 |
| `node --test test/assets.test.js test/render/assets.test.js test/match/lobby-integration.test.js` | 当前实现 | 88 pass / 0 fail / 0 skipped |
| package 完整测试 | 临时 `GIT_INDEX_FILE` 加入新 runtime 文件后运行 `node --test test/package.test.js` | 11 pass / 0 fail / 0 skipped；实际 Git 索引未更改。正常索引下此前唯一失败由未跟踪的 `server/bpMusic.js` 未进入 git ls-files 导致，未弱化打包测试 |
| 部署与字体最终 fixtures | `node --test test/deploy.test.js test/fetch-assets-fonts.test.js` | 33 pass / 0 fail / 0 skipped；包括失败检查无状态文件写入、悬空链接只读、npm ci 失败不回退 install、失败与中断清 readiness、真实 atlas 额外页下载、零字节字体产物补回 |
| 相邻资源回归 | `test/fetch-assets-shrink.test.js` / `test/assets-diy.test.js` / `test/assets.test.js` | 65 pass / 0 fail；连同当时的部署/字体版本整批 96 pass，新增状态隔离与 npm 失败场景之后按上一行重新验证 |
| 新目录源码准备和根启动 | 隔离临时目录，无 node_modules，复制当前源码与缓存索引、共享素材/字体绝对软链接；npm 包从本机缓存安装 | 两次实际执行均 exit 0：首次 npm ci 安装 197 包并生成 vendor；重复准备跳过安装/刷新；缺失 vendor 补回。PORT=34326、MP3_FOLDER 为用户目录时根脚本启动成功，3 曲目录被识别，healthz/首页/教程均 200。清单、锁 SHA-256、共享文件大小/mtime 清单及软链接保持原样；临时目录与服务器已清理。不等于从公网首次下载全部素材 |
| 最终打包选择与个人信息扫描 | 将 git ls-files 的已跟踪及未忽略新增路径传给 package plan，lite / allowDirty；保留真实索引 | 645 个包文件、6619 个扫描文件，零问题；部署示例路径和教程来源注释已改为可移植形式 |
| `docker version` / 本机 Docker 启动 | Docker CLI 29.3.1，desktop-linux | API socket 被短暂创建后立即关闭；持续 `unmarshaling start request: unexpected EOF`，最终 `/Users/kevin/.docker/run/docker.sock` 不存在；未执行 Linux 容器验证 |

实际运行验证遵循会话中的 `run` 技能；浏览器通过 puppeteer-core 驱动已安装 Chrome。截图、日志及浏览器结果保存在忽略的 `.cache/`；关键结论已在此记录，不依赖缓存长期留存。

## 结果、遗留与接手

- 本地代码、浏览器及隔离源码目录的依赖安装/重复准备/实际根启动验证已完成。最终 `data/assets.json` SHA-256 保持 `3f710e7f1c62821d915196869c01478e81fa4d7b06972078933039b3f8ee400d`，`package-lock.json` 保持 `c0a6e16361312fabfc1f421c0d4fe760d07d7c2cd9157a356bba1c8c8fc1b41a`。共享素材/字体根链接文本仍是 `../../../public/assets` 和 `../../../public/fonts`。
- Docker 启动尝试未获得可用 API；诊断用 backend 已停止，没有重新安装或替换 Docker。不能列出本地 Ubuntu 镜像，因而不能执行用户要求的容器回归。
- Docker Hub 查询超时，无法据此断言 Alibaba Cloud Linux 3.2104 镜像不存在。阿里文档列出的 `alibaba-cloud-linux-3-registry.cn-hangzhou.cr.aliyuncs.com/alinux3/alinux3:220901.1` 也未确认是用户指定的确切系统版本。daemon 恢复后优先核对所需镜像；否则按用户授权使用已有 Ubuntu，并记录实际 OS 与 Node 版本。
- 没有远程拉取版本核实、提交、推送、PR 或远程部署。本次实现位于 Increase 仓库；没有自动同步到用户示例的 Kevin 仓库。
- 未运行完整 CI/golden，没有改动玩法模拟或 golden 文件；定向回归、静态检查、实际浏览器与根启动结果分别记录。
