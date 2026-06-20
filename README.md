# agent-historian

English | [简体中文](README.zh-CN.md)

Search and read your past **AI coding-agent conversation history** from the
command line — so your agent can recover earlier research, commands, errors,
and decisions instead of repeating work.

Ships a small CLI (`ochist`) and an **Agent Skill** so agents like
[OpenCode](https://opencode.ai) and [Claude Code](https://www.anthropic.com/claude-code)
can check history *before* doing fresh research.

- **Multi-agent.** Reads OpenCode (`opencode.db`) and Claude Code
  (`~/.claude/projects/*.jsonl`) out of the box, plus additional locally
  detected agents. Pluggable: add a new agent by implementing one interface.
- **Project- or global-scoped.** Searches default to the current project
  (current directory and below); `--global` widens to everything.
- **Read-only.** Never modifies any data store.
- **Context-friendly.** Plain, pipe-friendly output. Agents page with
  `grep`/`head`/`wc`/`jq` instead of dumping whole sessions into context.
- **Zero runtime dependencies.** Uses Node's built-in `node:sqlite`
  (Node ≥ 22.5). No native modules.

---

## Why this exists

AI coding agents are mostly **stateless across sessions**. Every new chat starts
from zero, so the agent happily redoes investigation it already finished
yesterday — re-reading the same files, re-running the same commands, re-deriving
the same conclusions. That wastes your time, your tokens, and your patience.

`agent-historian` gives the agent (and you) a cheap, local way to ask:

> *"Have I solved this before? What command did I run? Which file did we change?
> What did we decide, and why?"*

It deliberately **does not try to summarize** sessions with brittle heuristics
(regex-based "accomplishment extraction" breaks on non-English text and on any
phrasing it didn't anticipate). Instead it lets the agent **read the real text
on demand**, using a progressive-disclosure workflow (`locate → orient → scan →
read`) so only the relevant lines enter the context window.

## Who it's for

- **Developers** who switch between projects and sessions and want their agent to
  remember prior work instead of starting over.
- **AI coding agents** (OpenCode, Claude Code, Qoder, …) that should *check
  history before doing fresh research* — wired up via the bundled Agent Skill.
- **Tool builders** who want a small, dependency-free, read-only way to query
  local agent transcripts across multiple tools through one interface.

---

## Install

```bash
git clone https://github.com/adlternative/agent-historian.git
cd agent-historian
npm install
npm run build
npm link          # exposes the `ochist` command globally
```

Requires **Node ≥ 22.5** (for built-in `node:sqlite`).

---

## CLI usage

```bash
ochist sources                       # which agents are detected
ochist sessions --limit 10           # recent sessions across all agents
ochist grep "ssh" --limit 8          # search all history
ochist meta <session>                # reliable metadata card
ochist show <session>                # one-line-per-message outline
ochist part <part_id>                # full text of one message
```

By default **all detected agents** are queried. Restrict with `--source`:

```bash
ochist sessions --source claudecode
ochist grep "docker build" --source opencode
```

### Project vs global scope

`sessions` and `grep` default to the **current project** — sessions whose
working directory is the current dir or below. Widen as needed:

```bash
ochist sessions                 # current project (cwd and subdirs)
ochist sessions --global        # every project
ochist sessions --dir ~/code/x  # a specific directory
ochist grep "ssh" --global      # search all history
```

`<session>` / `<part_id>` accept an agent-native id, a slug/prefix, or `latest`.
Add `--json` to any command for machine-readable output (pipe to `jq`).

### Recommended workflow (page, don't dump)

```bash
ochist grep "authorized_keys" --limit 5            # find candidate + part_id
ochist meta silent-star                             # confirm the session
ochist show silent-star | grep -i ssh-copy-id       # locate exact part
ochist part prt_xxxxx                                # read full message
```

---

## Use as an Agent Skill

The repo includes a skill at [`skills/agent-history/SKILL.md`](skills/agent-history/SKILL.md)
that teaches agents *when* and *how* to use `ochist` — so they check history
before doing fresh research.

### Option A — `npx skills` (recommended, cross-agent)

The standard community installer. No clone needed; works for OpenCode, Claude
Code, Cursor, Codex, and more:

```bash
# Install into every detected agent, globally:
npx skills add adlternative/agent-historian -g

# Or target specific agents:
npx skills add adlternative/agent-historian -s agent-history -a opencode -a claude-code -g
```

### Option B — `ochist skill install` (version-locked to the CLI)

If you already installed the CLI (`npm i -g agent-historian` / `npm link`), it
can install its own bundled skill:

```bash
ochist skill install --global     # → ~/.claude/skills + ~/.config/opencode/skills
ochist skill install              # project-local: ./.claude/skills + ./.agents/skills
ochist skill uninstall --global   # remove
ochist skill path                 # print the bundled skill dir
```

### Option C — manual symlink

```bash
mkdir -p ~/.claude/skills        # read by BOTH Claude Code and OpenCode
ln -s "$(pwd)/skills/agent-history" ~/.claude/skills/agent-history
```

Restart the agent; it will discover the `agent-history` skill and load it on
demand when you reference earlier work ("我之前…", "what did we do before", …).

---

## How it works

```
ochist (CLI)
  └─ sources/registry.ts        selects active sources (auto-detect or --source)
       ├─ OpenCodeSource        reads opencode.db via node:sqlite
       ├─ ClaudeCodeSource      reads ~/.claude/projects/*.jsonl
       └─ <your agent here>     implement HistorySource
```

Each source normalizes its agent's data into common `Session` / `Part` shapes,
so the CLI is agent-agnostic. Search is lexical (regex/substring over message
content) — no embeddings, no index, no background process.

**Subagents are handled per agent.** OpenCode subagents are recorded as their
own sessions (the `agent` field is `explore`/`general`/…). Claude Code subagent
("sidechain") transcripts live in `agent-*.jsonl` files that reference their
parent session; `agent-historian` folds their content into the parent session
and prefixes it with `[subagent …]`, so nothing is lost or duplicated.

---

## Add a new agent

1. Create `src/sources/<agent>.ts` implementing the `HistorySource` interface
   from [`src/sources/types.ts`](src/sources/types.ts):

   ```ts
   export class MyAgentSource implements HistorySource {
     readonly name = 'myagent';
     readonly label = 'My Agent';
     isAvailable() { /* does its data store exist? */ }
     location() { /* where it reads from */ }
     listSessions(opts) { /* … */ }
     loadParts(sessionId?) { /* … */ }
     loadPartRaw(partId) { /* … */ }
     resolveSessionId(selector) { /* id | slug | prefix | "latest" */ }
     loadTodos(sessionId) { /* [] if unsupported */ }
   }
   ```

2. Register it in [`src/sources/registry.ts`](src/sources/registry.ts) by adding
   it to `ALL_SOURCES`.

3. `npm run build`. That's it — every subcommand now works for your agent.

---

## A note on data formats

`agent-historian` reads each agent's **local** session data: OpenCode's SQLite
database and the per-session JSONL transcripts that Claude Code, Qoder, and
similar CLIs persist on disk. These on-disk formats are largely **not officially
documented**, so the readers are best-effort and may need updates across agent
versions. Everything is strictly **read-only** — the tool never writes to any
agent's data store.

---

## Credits & acknowledgements

This project stands on the shoulders of others:

- **[claude-historian](https://github.com/Vvkmnn/claude-historian-mcp)** by
  [@Vvkmnn](https://github.com/Vvkmnn) — the original inspiration. The core idea
  ("let the agent search its own past conversations so it stops repeating
  research"), the *historian* framing, and the on-demand transcript-search
  approach all trace back to it. `agent-historian` reimagines that idea as a
  multi-agent, CLI-first, skill-driven tool.
- The progressive-disclosure / "page, don't dump" philosophy is shared with
  memory tools like **[claude-mem](https://github.com/thedotmack/claude-mem)**
  and **[mem0](https://github.com/mem0ai/mem0)**, which informed the design.
- The agents whose local history this reads — **[OpenCode](https://opencode.ai)**,
  **[Claude Code](https://www.anthropic.com/claude-code)**, and
  **[Qoder](https://qoder.com)** — for building tools worth remembering.

If your project belongs here and isn't credited, please open an issue.

---

## License

MIT — see [LICENSE](LICENSE).
