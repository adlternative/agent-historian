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
- **项目级 / 全局级范围。** 搜索默认限定在当前项目（当前目录及其子目录）；`--global` 扩展到全部。
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

`sessions` 和 `grep` 默认限定在**当前项目**——即工作目录为当前目录或其子目录的会话。按需扩展：

```bash
ochist sessions                 # 当前项目（当前目录及子目录）
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
ochist skill install --global     # → ~/.claude/skills + ~/.config/opencode/skills
ochist skill install              # 项目级：./.claude/skills + ./.agents/skills
ochist skill uninstall --global   # 移除
ochist skill path                 # 打印内置 skill 目录
```

### 方式 C —— 手动软链

```bash
mkdir -p ~/.claude/skills        # Claude Code 和 OpenCode 都会读取这里
ln -s "$(pwd)/skills/agent-history" ~/.claude/skills/agent-history
```

重启 Agent；当你提到此前的工作时（“我之前……”“what did we do before”……），它会发现 `agent-history` 这个 skill 并按需加载。

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
