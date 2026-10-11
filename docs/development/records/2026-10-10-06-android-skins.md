# DEV-20261010-06 · 移植安卓民间版干员皮肤功能（Paper-Yuan → main）

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-10 / 2026-10-10，Asia/Shanghai |
| 状态 | 已完成（ci 全绿、golden 一致；推送见下） |
| 类型 | 跨源功能移植（cherry-pick + 人工适配） |
| 分支与开始 HEAD | `main`（KevinSCUTer/Strong-Protocol-Multi），起点 = `2f20488c`（DEV-20261010-05 记录收尾） |
| 来源 | `Paper-Yuan/Stronghold-Protocol` master `55d9d2c2`，皮肤提交 `53d9e350`（v0.1.6-pre-skin），头像素材提交 `0d155d81` |
| 提交归属 | 新增 `android` 镜像分支（= `55d9d2c2`，已推送）；功能移植单提交，按路径查询 |
| 关联 | [上游同步流程](../UPSTREAM.md)（本次新增多源拓扑说明）；前次合并 [DEV-20261010-05](2026-10-10-05-upstream-v0.2.3.md)；[docs/SKINS.md](../../SKINS.md) |

## 需求、范围与授权

用户要求：把安卓民间版的**干员皮肤自定义功能**合并进 `main`，并单独开 `android` 分支及时同步该 repo 进展。授权范围：本地移植与验证、向小组仓推送 `main` 与新增 `android` 分支；不改 Paper-Yuan 仓库，未部署。按既定边界：游戏美术不入 git，174 张皮肤头像落在共享素材目录（Git 忽略）。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 移植方式：整体合并还是单提交挑选 | Paper-Yuan `master`（`55d9d2c2`，基于上游 0.1.x）与本仓 0.2.3 无共同近祖；其 `feature/v0.2.1-fusion-master`（`06cd3d0a`）是手工移植、merge-base 为 `9f93096e`（feedback4），直接合并会把 0.2.0/0.2.1 重复套用 | 已确认：`git cherry-pick -n 53d9e350` 单提交挑选 + 人工适配；不碰其融合分支 |
| 皮肤提交混带无关工作 | `53d9e350` 共 77 文件、+11088 行：语音系统（audio.js 507 行、双语音工具）、WebView `inset` 兼容（compat.js + 9 个 CSS）、`finishAttack` 攻击动画修复、CGNAT、安卓壳工程（android/ 目录）等 | 已确认：严格只保留皮肤相关；其余一律还原为本仓版本（含其 `finishAttack`——spine.js 在皮肤链路中无职责） |
| 其「调配面板分 Tab 低配适配」是否随迁 | 同一提交捆绑的 `lo-dtabs` 重构；本仓 Detail 已演进出上游没有的语音、潜能练度、 Garrison、补位说明四节 | 已确认：不迁。皮肤节以既有竖排布局追加 `<SkinSection>`，避免对后续上游 loadout.js 合并制造大面积冲突；Tab 需求如小组要可另立任务 |
| 渲染链路 `skin` 字段 | `public/js/assets.js` 的 `avatarUrl`/`spineEntry`/`hasBackSpine`/`unitPictureUrl` 四处 skin 查找被 cherry-pick 干净自动合入（本仓 0.2.3 该文件与上游差异小） | 已确认：直接保留自动合并结果；`spineEntry` 皮肤缺骨骼时回退原皮（`fallback` 字段） |
| 服务端皮肤校验 | `basics.js setSkins`：跳过黄金/不可见/隐藏/自选/baseId 重映射棋子；`shared/protocol.js` `isSkinId`/`isSkinSelection` + C2S `room.skins`；平台层 `setSkins` 任意阶段可换、公开视图携带 | 已确认：原样移植（0.2.3 的 `PlayerState` 拆分后落入 `player/basics.js`、`player/round.js`、`player/views.js`、`match/platform.js`） |
| 174 张头像 PNG 去哪 | 仓库硬规则「游戏美术不入 git」；本机三仓共享 `stronghold/public/assets` 软链接 | 已确认：从 `0d155d81` 提取至共享目录 `char/skin_avatar/`（Git 外）；`data/assets.json` 只提交 URL 清单 |
| `data/assets.json` 皮肤条目如何维护 | 其清单由本仓 `fetch-assets` 流水再生成，直接手改会被下次再生成覆盖 | 已确认：保留上游 `tools/inject-skins-assets.mjs`，作为再生成后的固定补注入步骤（写入记录与 SKINS.md）；本次已执行（115 名干员 174 套） |
| Spine 皮肤模型 | `fetch-skin-spines.mjs`（已由 `install-skin-spines.mjs` 取代） 需联网下载骨骼文件，本次未执行；注入器按磁盘实际存在与否决定是否写 `skin.spine` | 已确认：本次只有头像，战斗内模型回退原皮骨骼、头像用皮肤图；骨骼后续按需补 |
| `test/ui/playtest3.test.js` GAME_FILES 断言 | 扫描 `public/js/ui/*.js` 的 `data.*(…)` 调用并要求全部 ∈ GAME_FILES；`skins.js`/`skinPicker.js` 读 `skins.json` | 已确认：`skins` 加入 GAME_FILES（`gameComponents.js`）——进房预热目录文件，开销可忽略 |
| `test/ui/standin-ui.test.js` sig 断言 | 正则钉死渲染缓存键模板；本次键加入 `|${info.skin \|\| ''}`（皮肤必须参与缓存失效） | 已确认：更新正则以匹配新键，不变量（键变化即重绘）不变 |
| i18n 字符串 | 上游 skinPicker 硬编码中文；本仓硬规则 `t()` + 四语言包 strict | 已确认：13 条新 msgid（皮肤/已装配/导入组合文案等）四包 100% 补齐；错误文案「里面没有有效的调配或皮肤条目」随上游改键 |

既有能力边界核对：二十人座位、D010 卡池组、D012 机变、D013 联防、公告与素材缓存均未回退；皮肤选择 `{ [chessId]: skinId }` 与 loadout/ops 互不占用协议字段。

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `shared/protocol.js` | 新增 `SKIN_LIMITS`/`isSkinId`/`isSkinSelection` 与 C2S `room.skins` | 协议层与 loadout 同构的防御校验 |
| `server/lobby.js` | `freezeSkins` + `skins()` 处理器 + 座位视图携带 skins | 大厅→对局一体的选择同步 |
| `server/match/PlayerState.js`、`player/basics.js` | 构造初始化 `skins`；`setSkins` 重校验后冻结并 `dirty()` | 服务端权威，bot 不参与 |
| `server/match/player/round.js`、`player/views.js` | 出战单位与棋盘视图携带 `skin`（baseId 或本 id 命中） | 0.2.3 拆分后的装配点 |
| `server/match/match/platform.js`、`match/views.js` | `setSkins` 平台方法（任意阶段）；公共/备战视图携带 | 与上游一致 |
| `public/js/ui/skins.js`、`skinPicker.js` | 新文件：localStorage 选择 + `room.skins` 防抖同步；详情面板皮肤节；字符串全部 `t()` | 上游原文件 + i18n 适配 |
| `public/js/ui/loadoutModel.js` | `sanitizeSkins`/`mergeSkins`；`exportPayload`/`parseImport` 支持 `skins` 字段 | 调配导入导出带上皮肤（增量合并，只覆盖声明了的干员） |
| `public/js/screens/loadout.js` | 详情面板追加 `<SkinSection>`；导出带 skins；导入合并 + 组合提示文案；`useData` 加 `skins` | 不迁 Tab 重构（见调查表），其余随上游 |
| `public/js/render/app.js`、`app/info.js`、`units.js` | `info.skin` 进入渲染信息与缓存键、三处贴图、spine/hasBack | 与 assets.js 四处查找配套 |
| `public/js/main.js`、`data.js` | 启动载入 `skins` 目录；`installSkinsSync({ net })` | 大厅即同步，进房已就绪 |
| `public/js/ui/gameComponents.js` | GAME_FILES + `skins` | playtest3 契约：ui/ 读的文件进房预热 |
| `public/css/screens/loadout.css` | 追加 `.lo-skins`/`.lo-skin` 约 100 行（`max(rem,px)` 形式，与本文件既有约定一致） | 未迁 Tab 的 `.lo-dtabs` 块 |
| `public/i18n/{en,ja,ko,zh-TW}.json` | 各 +13 条 | 硬规则 |
| `data/skins.json`、`skins-installed.json`、`docs/SKINS.md`、`docs/research/08-skins.json`、`tools/{build,fetch-*,inject}-skins*.mjs`、`test/skins.test.js` | 上游新文件原样保留 | 目录、研究数据与工具链 |
| `data/assets.json` | 注入器写入 115 干员 174 套皮肤 URL 条目 | 素材本体在共享目录 |
| 共享素材目录 | `stronghold/public/assets/char/skin_avatar/` +174 PNG（Git 外） | 硬规则：美术不入 git |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `npm run ci` | 本地 macOS，Node 24，干净树 | 全绿：test 3m40s、smoke、lint、imports、typecheck 均过（首轮 2 处失败见调查表，均已按契约适配） |
| `npm run golden` | 同上 | 236 场景（bonds 46 / fields 22 / matches 18 / standins 10 / diy 140）全部一致，零移动 |
| `node tools/i18n.mjs check --all --strict` | 移植后 | 四语言包 1311 msgid 100%，0 缺失 0 错误 |
| `node --test test/skins.test.js` | 同上 | 5/5 过（174 套元数据、mergeSkins、导入导出、资源回退、协议校验） |
| `tools/inject-skins-assets.mjs` | 共享目录头像在场 | 注入 115 干员 174 套；spine 骨骼未下载，全部走原皮回退 |
| 浏览器 E2E | 未运行 | 本机未配 Chrome 套件；皮肤节 UI 与战斗内贴图待下次部署前人工核对 |

## 遗留与下一步

1. **皮肤 Spine 骨骼未装**：战斗内模型仍为原皮，仅头像/立绘换肤。需要时运行 `node tools/install-skin-spines.mjs`（下载 + 解析并直接写入 `skin.spine`，见 docs/SKINS.md）。**已于 2026-10-11 补上。**
2. **`assets.json` 再生成会抹掉皮肤条目**：下次运行 `fetch-assets` 流水后必须重跑 `node tools/inject-skins-assets.mjs`（已写入本记录与 SKINS.md）。
3. **分 Tab 低配适配未迁**：如小组需要（低端安卓机），另立任务移植 `lo-dtabs` 重构，需与本仓语音/潜能/Garrison 节重新编排。
4. **`android` 分支同步**：后续 `git fetch android && git merge --ff-only android/master`；发现新功能时按本次流程评估 cherry-pick，不整体合并。
5. 上游 `loadoutModel.js` 的 `parseImport` 空 `ops` 语义差异：本仓版本仅收录非空集合（空 = 不动），上游一律携带——已按本仓既有「缺省不动」语义实现，导入行为与 v0.2.2 以来一致。
