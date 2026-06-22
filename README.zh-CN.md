# agent-historian

[English](README.md) | 简体中文

[![npm](https://img.shields.io/npm/v/agent-historian?style=flat-square)](https://www.npmjs.com/package/agent-historian)
[![skills.sh](https://skills.sh/b/adlternative/agent-historian)](https://skills.sh/adlternative/agent-historian)
[![license](https://img.shields.io/npm/l/agent-historian?style=flat-square)](LICENSE)

在命令行里**搜索并阅读你过去的 AI 编码 Agent 会话历史**——让 Agent 能找回此前的调研、命令、报错与决策，而不是每次从头再来。

项目提供一个小巧的 CLI（`ochist`）和一个 **Agent Skill**，让
[OpenCode](https://opencode.ai)、[Claude Code](https://www.anthropic.com/claude-code)
等 Agent 在做新调研*之前*先查历史。

- **多 Agent 支持。** 开箱即读 OpenCode（`opencode.db`）和 Claude Code
  （`~/.claude/projects/*.jsonl`），以及其他本地探测到的 Agent。可插拔：实现一个接口即可新增 Agent。
- **项目级 / 全局级范围。** 搜索默认限定在当前项目（当前目录及其子目录，以及同仓库的其它 git worktree）；`--global` 扩展到全部，`--no-worktrees` 收窄到单一目录。
- **只读。** 绝不修改任何数据存储。
- **对上下文友好。** 纯文本、管道友好的输出。Agent 用
  `grep`/`head`/`wc`/`jq` 分页取用，而不是把整个会话灌进上下文。
- **零运行时依赖。** 使用 Node 内置的 `node:sqlite`（Node ≥ 22.5），无原生模块。

---

## 为什么要做这个

AI 编码 Agent **大多在会话之间是无状态的**。每开一个新会话都从零开始，于是它会兴致勃勃地重做昨天已经完成的调研——重新读同样的文件、重新跑同样的命令、重新推导同样的结论。这浪费你的时间、你的 token，也磨你的耐心。

`agent-historian` 给 Agent（以及你）一个廉价的、本地的方式来发问：

> *“这个我之前解决过吗？我当时跑的是什么命令？我们改的是哪个文件？我们当时决定了什么、为什么？”*

它刻意**不去用脆弱的启发式来“总结”会话**（基于正则的“成果提取”在非英文文本和任何它没预料到的措辞上都会失效）。取而代之，它让 Agent **按需阅读真实文本**，采用渐进式披露的工作流（`定位 → 概览 → 扫描 → 阅读`），从而只把相关的行放进上下文窗口。

## 适合谁用

- **开发者**：在多个项目和会话间切换，希望 Agent 记得之前做过的事，而不是重头再来。
- **AI 编码 Agent**（OpenCode、Claude Code、Qoder……）：应当*在做新调研之前先查历史*——通过内置的 Agent Skill 接入。
- **工具开发者**：想要一个小巧、无依赖、只读的方式，通过统一接口跨多个工具查询本地 Agent 会话记录。

---

## 一个真实例子：解决反复出现的合并冲突

有些合并冲突本来就不该手解。`go.sum` 冲突、lockfile、各种生成文件——正确的修法通常是一条命令（`go mod tidy`、重新生成、先取对方版本再重建），而不是手动编辑。

在之前的某次会话里，我告诉过 Agent 解决某个仓库 `go.sum` 冲突的确切命令。后来开了个新会话，Agent **忘了**，跑去手动 merge，还解错了。我让它用 `agent-history` 查一下上次是怎么解的——它找到了之前那次会话，看到了那条命令，立刻就做对了。

为什么记忆层（memory）逮不住这种情况：**Agent 只会记住它自己决定写下来的东西。** 除非我上次有意识地跟它说“把这个修法记住”，否则这个细节根本不会进入记忆库。而本地的会话记录则**永远有它**——每条命令和它的输出都在那儿，不管当时有没有人觉得它值得保存。`agent-historian` 只是把这份真实记录读回来而已。

---

## 与 memory / RAG 等其他方案有何不同

给 Agent 加“记忆”有很多路子。`agent-historian` 刻意选了最简单的一种——它**不构建记忆，而是直接读取你磁盘上已有的真实记录（ground truth）**。

| 方案 | 存什么 | 检索方式 | 成本 / 搭建 | 保真度 |
| --- | --- | --- | --- | --- |
| **agent-historian** | 不存——读已有 transcript | 词法（grep/子串），按需 | 零索引、零依赖、只读 | 原文精确 |
| **记忆层**（mem0、OpenMemory、MemGPT 等） | LLM 提炼后决定保存的事实/摘要 | 对*摘要*做语义召回 | 需要存储 + 写入步骤；可能漂移/幻觉 | 有损——模型的转述 |
| **RAG / 向量**（对聊天记录建向量库） | 切块文本 + 向量 | 语义（向量相似度） | 嵌入模型 + 向量库 + 重建索引流水线 | 块精确，但需基础设施与重索引 |
| **内置 `--resume` / `--continue`** | Agent 自己的会话文件 | 把整个会话重新载入上下文 | 免费，但无法搜索 | 精确，但全有或全无 |
| **自动摘要召回**（正则/启发式“我做了什么”） | 抽取出的要点 | 对摘要做关键词 | 便宜 | 脆弱；非英文/特殊措辞会失效 |

### 什么时候用哪个

- **用 `agent-historian`**：当你想*找到并重读真实发生过的内容*——确切的命令、报错、diff 或决策——跨过去的会话、跨多个 Agent，无需任何基础设施，也不担心模型篡改历史。它是**对真实 transcript 的搜索工具**，不是记忆。
- **叠加记忆层（mem0 等）**：当你想让 Agent 长期携带*提炼后的偏好与稳定事实*（“用户偏好 pnpm”“部署都走 staging”），这些应作为结构化知识持久化。
- **用 RAG/向量**：当你需要对大语料做*语义*召回，且愿意承担嵌入模型 + 向量库 + 重索引的成本。

它们是互补的：`agent-historian` 回答*“把我真正做过的东西给我看”*，memory/RAG 回答*“回忆我所知道的大意”*。很多场景两者并用——historian 做精确召回，记忆层做事实提炼。

### 由此而来的设计取舍

- **无向量、无索引、无后台进程**——搜索就是按需运行的纯词法匹配，没有任何东西需要构建、同步或常驻。
- **只读**——它从不写“记忆”，因此不会偏离或污染真实来源。
- **渐进式披露**——不是把摘要塞进上下文，而是让 Agent 分页浏览结果（`定位 → 概览 → 扫描 → 阅读`），只取它需要的确切行。

---

## 为什么用 CLI + Skill 而不是 MCP server

这个项目最初是个 MCP server，后来刻意改成了 **CLI（`ochist`）+ Agent Skill**。原因：

- **Agent 本来就有 shell。** 有了 CLI，Agent 自己就能拼 `ochist grep … | head`、`| wc -l`、`| grep -i error`、`| jq`。而 MCP server 得预先把每一个这样的选项硬编码成工具参数。Shell 本身*就是*查询语言。
- **上下文控制权归 Agent。** 用 `head`/`grep` 分页过滤，Agent 只取所需。MCP 工具往往返回一个固定块；你得在服务端重造分页逻辑，还是会取多或取少。
- **零常驻成本。** MCP server 是挂在会话上的长驻进程（其工具 schema 每轮都占上下文）。CLI 只在被调用时运行——无守护进程、无空闲 token 开销。
- **Skill 教的是*何时*与*如何*。** MCP 暴露的是*能力*，不告诉 Agent 工作流。内置 skill 编码了“做新调研前先查历史”以及 `定位 → 概览 → 扫描 → 阅读` 这套方法——这是 MCP 承载不了的指导。
- **可移植、可审视。** 一个二进制就能在任何能跑 shell 的 Agent 里用，人类也能跑同样的命令、看同样的输出。无传输层、无协议、无逐客户端接线。
- **易扩展。** 加一个 Agent 或一个 flag 就是普通的代码改动，没有工具 schema / 权限的来回。

MCP 很适合*Agent 本来够不到的能力*（远程 API、特权操作）。而这里的数据是**Agent 用 shell 本就能读的本地文件**，所以 CLI + Skill 更简单、更省、更灵活。

---

## 这个项目什么时候会变得多余（那也挺好 :)）

`agent-historian` 之所以存在，主要是为了填补一个空白：Agent 在本地持久化了丰富的会话数据，**却没有提供一个一等公民式的方式去搜索和读回它**。OpenCode 有 `session list`（但没有读取 message/part 的命令）；Claude Code 只有交互式 `--resume`；Qoder 的 SDK 能 resume/continue 但读不了历史。

最理想的终局，是 Agent 官方自己把这件事做了：

- 一个读取命令，比如 `opencode message get <session>` / `opencode session show`（以及 Claude Code / Qoder 的对应命令），把消息和工具的输入输出以纯文本、管道友好的形式打印出来。
- 一个**官方 skill**，教 Agent 在重复调研之前先查自己的历史。

如果那一天到来，你就不再需要这个项目了——而那会是个*好*结果。在此之前，`agent-historian` 提供了一个统一、只读、跨 Agent 的现成方案。（而且，如果它作为*跨 Agent*这一层依然有用——用一个工具、一个 skill 同时读 OpenCode + Claude Code + Qoder + …——那它继续存在也挺合理。）

---

## 安装

```bash
npm install -g agent-historian      # 暴露 `ochist` 命令
```

或免安装直接运行：

```bash
npx agent-historian sources
```

<details>
<summary>从源码安装（用于开发）</summary>

```bash
git clone https://github.com/adlternative/agent-historian.git
cd agent-historian
npm install
npm run build
npm link          # 将 `ochist` 软链到全局
```
</details>

需要 **Node ≥ 22.5**（用于内置的 `node:sqlite`）。

---

## CLI 用法

```bash
ochist sources                       # 探测到了哪些 Agent
ochist sessions --limit 10           # 所有 Agent 的最近会话
ochist grep "ssh" --limit 8          # 搜索全部历史
ochist meta <session>                # 可靠的元数据卡片
ochist show <session>                # 每条消息一行的大纲
ochist part <part_id>                # 某条消息的完整正文
```

默认会查询**所有探测到的 Agent**。用 `--source` 限定：

```bash
ochist sessions --source claudecode
ochist grep "docker build" --source opencode
```

### 项目级 vs 全局级范围

`sessions` 和 `grep` 默认限定在**当前项目**——即工作目录为当前目录或其子目录的会话。
同一仓库的其它 **git worktree（工作树）** 会被自动纳入，因此在主仓库目录下也能看到在
关联 worktree 中产生的会话，反之亦然。按需调整：

```bash
ochist sessions                 # 当前项目（当前目录、子目录及同仓库 worktree）
ochist sessions --no-worktrees  # 严格模式：仅限当前目录
ochist sessions --global        # 所有项目
ochist sessions --dir ~/code/x  # 指定目录
ochist grep "ssh" --global      # 搜索全部历史
```

`<session>` / `<part_id>` 接受 Agent 原生 id、slug/前缀，或 `latest`。
任意命令加 `--json` 可得到机器可读输出（管道给 `jq`）。

### 推荐工作流（分页取用，别一次倒出全部）

```bash
ochist grep "authorized_keys" --limit 5            # 找到候选 + part_id
ochist meta silent-star                             # 确认是这个会话
ochist show silent-star | grep -i ssh-copy-id       # 定位到具体那一条
ochist part prt_xxxxx                                # 读完整消息
```

---

## 作为 Agent Skill 使用

仓库内置了一个 skill：[`skills/agent-history/SKILL.md`](skills/agent-history/SKILL.md)，
用于教 Agent *何时*以及*如何*使用 `ochist`——好让它在做新调研前先查历史。

### 方式 A —— `npx skills`（推荐，跨 Agent）

社区标准安装器，无需 clone，支持 OpenCode、Claude Code、Cursor、Codex 等：

```bash
# 全局安装到所有探测到的 Agent：
npx skills add adlternative/agent-historian -g

# 或指定 Agent：
npx skills add adlternative/agent-historian -s agent-history -a opencode -a claude-code -g
```

### 方式 B —— `ochist skill install`（与 CLI 版本锁定）

如果你已经安装了 CLI（`npm i -g agent-historian` / `npm link`），它能安装自带的 skill：

```bash
ochist skill install --global       # → ~/.agents/skills（统一的跨-agent 位置，
                                    #   OpenCode 会自动发现）
ochist skill install --global --all # 扩散到所有已知位置：Claude Code、
                                    #   ~/.config/opencode/skills、Qoder/QoderWork
ochist skill install                # 项目级：./.agents/skills
ochist skill uninstall --global     # 移除（加 --all 清理所有位置）
ochist skill path                   # 打印内置 skill 目录
```

默认的全局安装只会往 `~/.agents/skills` 放一份——这是 OpenCode（以及其他识别
`.agents` 的工具）会发现的统一共享位置，避免在机器上散落多个副本。如果还需要
覆盖 Claude Code（它目前只读 `~/.claude/skills`）或其他 agent，再加 `--all`。

### 方式 C —— 手动软链

```bash
mkdir -p ~/.agents/skills        # 统一的跨-agent skill 位置
ln -s "$(pwd)/skills/agent-history" ~/.agents/skills/agent-history
# Claude Code 目前不读 ~/.agents/skills —— 如需覆盖它,再加一份:
# ln -s "$(pwd)/skills/agent-history" ~/.claude/skills/agent-history
```

重启 Agent；当你提到此前的工作时（“我之前……”“what did we do before”……），它会发现 `agent-history` 这个 skill 并按需加载。

---

## 使用统计

想知道 Agent 到底多频繁地去查历史（也就是 skill 多少次真正变成了一次调用）？每次运行 `ochist` 都会往 `~/.agent-historian/usage.log` 追加一行**仅含元数据**的记录——时间戳、子命令、是否带 query、范围。它**不记录 query 文本、不记录结果、不记录路径**，也绝不联网。

```bash
ochist stats            # 人类可读的汇总（总数、按命令、按天）
ochist stats --json     # 机器可读
```

完全关闭：设 `AGENT_HISTORIAN_NO_TELEMETRY=1`（或 `DO_NOT_TRACK=1`）。

---

## 工作原理

```
ochist (CLI)
  └─ sources/registry.ts        选择活跃的数据源（自动探测或 --source）
       ├─ OpenCodeSource        通过 node:sqlite 读取 opencode.db
       ├─ ClaudeCodeSource      读取 ~/.claude/projects/*.jsonl
       └─ <你的 Agent>          实现 HistorySource 接口
```

每个数据源把各自 Agent 的数据归一化为统一的 `Session` / `Part` 结构，因此 CLI 与具体 Agent 无关。搜索是词法匹配（对消息内容做正则/子串匹配）——没有向量、没有索引、没有后台进程。

**Subagent 按各 Agent 的方式分别处理。** OpenCode 的 subagent 记录为各自独立的会话（`agent` 字段为 `explore`/`general`/……）。Claude Code 的 subagent 记录在引用其父会话的 `agent-*.jsonl` 文件中；`agent-historian` 会把它们的内容并入父会话，并以 `[subagent …]` 前缀标注，从而既不丢失也不重复。

---

## 新增一个 Agent

1. 在 `src/sources/<agent>.ts` 中实现来自
   [`src/sources/types.ts`](src/sources/types.ts) 的 `HistorySource` 接口：

   ```ts
   export class MyAgentSource implements HistorySource {
     readonly name = 'myagent';
     readonly label = 'My Agent';
     isAvailable() { /* 它的数据存储是否存在？ */ }
     location() { /* 从哪里读取 */ }
     listSessions(opts) { /* … */ }
     loadParts(sessionId?) { /* … */ }
     loadPartRaw(partId) { /* … */ }
     resolveSessionId(selector) { /* id | slug | 前缀 | "latest" */ }
     loadTodos(sessionId) { /* 不支持则返回 [] */ }
   }
   ```

2. 在 [`src/sources/registry.ts`](src/sources/registry.ts) 中把它加入 `ALL_SOURCES` 完成注册。

3. `npm run build`。完成——所有子命令都会自动支持你的 Agent。

---

## 关于数据格式的说明

`agent-historian` 读取的是每个 Agent 的**本地**会话数据：OpenCode 的 SQLite 数据库，以及 Claude Code、Qoder 等 CLI 在本地持久化的逐会话 JSONL transcript。这些落盘格式大多**未经官方公开文档说明**，因此读取实现是尽力而为的，可能需要随 Agent 版本更新而调整。一切操作严格**只读**——本工具绝不写入任何 Agent 的数据存储。

---

## 致谢

本项目站在前人的肩膀上：

- **[claude-historian](https://github.com/Vvkmnn/claude-historian-mcp)**，作者
  [@Vvkmnn](https://github.com/Vvkmnn) —— 最初的灵感来源。核心理念（“让 Agent
  搜索自己过去的会话，从而不再重复调研”）、“historian（史官）”这一命名，以及按需检索 transcript
  的思路，都源自它。`agent-historian` 把这个想法重新构想为一个多 Agent、CLI 优先、由 skill 驱动的工具。
- 渐进式披露 / “分页取用，别一次倒出全部”的理念，与
  **[claude-mem](https://github.com/thedotmack/claude-mem)** 和
  **[mem0](https://github.com/mem0ai/mem0)** 等记忆类工具一脉相承，它们启发了本项目的设计。
- 被读取本地历史的这些 Agent —— **[OpenCode](https://opencode.ai)**、
  **[Claude Code](https://www.anthropic.com/claude-code)** 和
  **[Qoder](https://qoder.com)** —— 感谢它们做出了值得被记住的工具。

如果你的项目应当列入此处却被遗漏了，欢迎提个 issue。

---

## 许可证

MIT —— 详见 [LICENSE](LICENSE)。
