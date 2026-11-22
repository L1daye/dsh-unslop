<img src="docs/banner-dark-ember.png" alt="dsh-unslop" width="100%">

# dsh-unslop

把 [heydamir/unslop](https://github.com/heydamir/unslop) 接进 DeepSeek Harness。unslop 是一个把「vibecoded、一眼 AI 味」的界面改造成有设计感的界面的技能：先审计 slop（紫色渐变、发光、emoji 标签、"New ✨" 徽章、乱间距），再从产品本身定方向，按九个 pass 逐层重排。本项目把它做成一个**独立、与宿主无关的 MCP server**，再用一层很薄的 dsh 插件把它桥进来。

> 内核是 prompt 方法（SKILL.md + 六篇 references），执行器只有两个确定性脚本（Playwright 截图 / ffmpeg 故事视频）。因此做成 MCP 的正确切法是「**resources 按需喂 + 两个脚本包成 tool**」，而不是把几千 token 一次性灌进上下文。

## 相对 dsh-rust-anything 的差异

参考案例 `dsh-rust-anything` 是「插件包着一个外部 CLI 二进制」：host 半启动 `rust-anything mcp`，自带 mcp-client，负责下载/校验/安装。unslop 没有二进制、没有 release、没有 MCP server——所以本项目：

| 维度 | dsh-rust-anything | dsh-unslop（本项目） |
|---|---|---|
| 被接入的东西 | 外部 CLI 的 `mcp` 子命令 | **本项目自带的 MCP server（`mcp/server.mjs`）** |
| 安装/下载 | GitHub release + SHA256 + cargo 回退 | **不需要**，全部随包分发，跑 Harness 自带的 Node |
| MCP 客户端 | 自写 stdio client（通用） | 复用同一模式（`host/mcp-client.js`） |
| 工具来源 | CLI 的 16 个 tools | server 的 4 个 tools + 2 个 host 直连工具 |
| 资源 | 无（只有 tools） | **6 个 references 作为 MCP resources**，另可 `unslop_read` |
| skill | 装 rust-anything 的 SKILL.md | 装 unslop 的 SKILL.md + references + scripts（整树） |
| 重型依赖 | cargo / MSVC / NDK… | Playwright（截图）、ffmpeg（视频），**可选、按需探测** |

一句话：**rust-anything 是「二进制桥」，unslop 是「自带 server 桥 + 资源库」。后者更轻，因为要接的东西本身就是文本。**

## 结构

```
dsh-unslop/
├─ dsh.plugin.json        插件清单（contributes.tools / mcp / skills）
├─ package.json           exports host/index.js + mcp/server.mjs；bundle→cordis.patch.yml
├─ cordis.patch.yml        插入一行 host 半（id: unslop-host）
├─ host/
│  ├─ index.js            apply(ctx,config)：起 MCP client、注册 mcp__unslop__*、装 skill
│  └─ mcp-client.js       零依赖 stdio MCP 客户端（initialize/tools/resources/prompts）
├─ mcp/
│  └─ server.mjs           ★ 独立 MCP server（任何 MCP 宿主都能直连）
├─ skills/unslop/
│  ├─ SKILL.md            vendored 上游技能（CC BY 4.0，装时前置 dsh 说明）
│  ├─ references/*.md      signs / tokens / visuals / refs / effects / rtl
│  └─ scripts/*.mjs        snapshot.mjs / story.mjs / story-path.mjs
└─ tests/                 smoke.mjs（server 协议）+ hosttest.mjs（桩 ctx 桥接）
```

## MCP 暴露面

`mcp/server.mjs` 是一个真正的 MCP 端点（newline-delimited JSON-RPC 2.0 / stdio）：

- **tools**
  - `unslop_references` — 列出六篇 references 的一句话摘要（只读）
  - `unslop_read {name}` — 读取其中一篇全文（signs 是审计清单，tokens 是精确数值）
  - `unslop_snapshot {url,out,...}` — 用 Playwright 抓 live 页面存自包含 HTML + 截图
  - `unslop_story {storyHtml,out?}` — 用 ffmpeg 渲染方形故事视频
- **resources**：`unslop://reference/<signs|tokens|visuals|refs|effects|rtl>`（懒加载）
- **prompts**：`unslop {target,mode}` — audit → direction → nine passes 的编排 prompt

在 dsh 里，四个 tool 注册为 `mcp__unslop__*`；resources 通过 `unslop_read` 也能读（dsh 的工具注册表只吃 tools）。另有三个 host 直连工具：`unslop_status`（探测）、`unslop_deps`（检查/安装 Playwright、ffmpeg）、`unslop_surface`（读取/切换工具面）。

## 输入框「工具面」chip

和 dsh-rust-anything 一样，输入框左侧有一个 chip：`● unslop 核心 2/4 ▾`。点开可在 `关闭 / 核心 / 全部` 之间切换这轮对话里 `mcp__unslop__*` 的工具面：

- `关闭`（off）——不注册任何 unslop MCP 工具；
- `核心`（core）——只留 `unslop_references / unslop_read`（只读研究，最省上下文）；
- `全部`（all）——加上 `unslop_snapshot / unslop_story`（默认）。

选择写入 `<DSH_HOME>/plugins-data/unslop/bridge.json`，**立即重注册工具、无需重启**。chip 通过 Host 半的 `/unslop/api/{token,surface}` 路由读写（每进程随机 Bearer + loopback 围栏）。也可以直接调 `unslop_surface {surface:"core"}`。

## 量化检测 `unslop_detect`（可选 impeccable）

一个**离线、确定性**的 slop 检测器，给界面打 **0–100 分**（越高越干净）并列出问题（`file:line` + 规则 + 说明），让"改前改后到底好多少"变成可量化：

```
unslop_detect {path:".", action:"baseline"}   # 改之前存基线
…  用 unslop 九个 pass 修  …
unslop_detect {path:".", action:"compare"}    # 出 Δ 分（例如 +44）
```

引擎**优先用 [impeccable](https://github.com/pbakaus/impeccable) 的 CLI**（若已安装，直接走它的 62 条规则），否则回退到**内置 ~22 条规则**——零依赖、不联网、不调模型。扫描路径限定在项目根内。内置规则覆盖：紫/蓝渐变、渐变文字、彩色发光、色晕 blob、霓虹边框、emoji 图标、大写宽字距、超重字重、玻璃拟态、呼吸动画、`transition-all`、`hover:scale`、徽章噪音、任意像素间距、营销大词、感叹号、假数据、问候标题、胶囊泛滥、过小字号、默认石墨灰等。

## 安装

手工等价（和你现有 profile 一致）：

1. 把本目录复制到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-unslop`；
2. 在 profile 的 `package.json` 里把 `dsh-unslop` 加进 `dsh.profile.bundles`；
3. 重启 Harness。

或：

```powershell
pwsh -File .\install.ps1 -DryRun     # 先看会改哪些文件
pwsh -File .\install.ps1             # 复制进 profile、登记 bundle
```

## 可选依赖

- `unslop_snapshot` 需要 Playwright + Chromium；`unslop_story` 需要 ffmpeg。
- 两者**不装也能用**核心审计流程；缺时 `unslop_status` 会标出来，`unslop_deps {install:true}` 会跑 `npm install -D playwright` + `npx playwright install chromium`。

## 兼容性

目标 DSH 客户端为 **0.2.2 系列**（`engines.dsh: >=0.2.2-rc.1`）：

| DSH 客户端 | 平台 | 状态 |
|---|---|---|
| `0.2.2-rc.1` | Windows | ✅ 本机实测：Host 半 / 3 个 `unslop_*` 工具 / `/unslop/api/*` 路由 / 输入框 chip 均与该版本已跑的 rust-anything 同一套内部接口 |
| `0.2.2-rc.3` | Windows | ✅ 端到端验证（Host + MCP + skill + chip） |

插件依赖若干净内部接口：`ctx.tools.register`、`ctx.inject(['webServer'])` / `webServer.register({kind:'exact'})`、`ctx.workingDirectory`、`ctx.slots.inject('conversation.input.left', …)`、`window.__ModuleLoader__.load`。DSH 升级可能改变它们——升级后先跑 `npm test` 再看 `unslop_status`。

## 测试

```powershell
cd dsh-unslop
npm test        # smoke.mjs + hosttest.mjs + routetest.mjs，不装 Harness，用桩 ctx
```

## 安全

- **管理路由**（`/unslop/api/*`）：每进程随机 Bearer + loopback 双重围栏——Host/Origin 校验之外还要求 `socket.remoteAddress` 为回环地址（防伪造 Host 头骗 token）；token 用 `timingSafeEqual` 比较、0600 落盘、不写日志。
- **路径收敛**：`unslop_snapshot` 的 `out` 与本地输入、`unslop_story` 的 `storyHtml`/`out` 必须落在项目根内（`..`/绝对路径越界一律拒绝）；`url` 允许 http(s)（抓 live 站点），本地 file 路径同样受限。
- **Playwright 解析**只从插件目录与 `UNSLOP_PLAYWRIGHT_HOME` 持久目录解析，子进程 cwd 固定为受信目录——项目里被投毒的 `node_modules/playwright` 不会被加载（防 require 劫持）。
- **MCP 协议**：畸形/`null` 行不再崩溃（回 `-32600`）、通知不回复、取消真正 kill 子进程、缓冲有上限。

## 许可

- 插件代码：MIT（`LICENSE`）。
- `skills/unslop/` 下 vendored 的 unslop 内容：**CC BY 4.0**，作者 Damir Sokolovsky（@heydamir），见 `LICENSE-unslop-CC-BY-4.0.txt` 与 `THIRD-PARTY-NOTICES.md`。任何再分发/改编须保留署名并链接回仓库。
