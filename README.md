# agent-historian

English | [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/agent-historian?style=flat-square)](https://www.npmjs.com/package/agent-historian)
[![skills.sh](https://skills.sh/b/adlternative/agent-historian)](https://skills.sh/adlternative/agent-historian)
[![license](https://img.shields.io/npm/l/agent-historian?style=flat-square)](LICENSE)

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

## A real example: resolving a recurring merge conflict

Some merge conflicts aren't meant to be hand-edited. A `go.sum` conflict, a
lockfile, a generated file — the right fix is usually a command
(`go mod tidy`, regenerate, take-theirs-then-rebuild), not manual editing.

In an earlier session I'd told the agent the exact command to resolve a
particular repo's `go.sum` conflicts. A new session later, the agent **forgot**,
tried to hand-merge it, and got it wrong. I asked it to check `agent-history` for
how we did it last time — it found the previous session, saw the command, and
immediately did the right thing.

Why a memory layer wouldn't have caught this: **the agent only remembers what it
decided to write down.** Unless I had consciously told it "remember this fix" the
last time, that detail never makes it into a memory store. The local session
transcript, on the other hand, **always has it** — every command and its output
is there whether or not anyone thought it was worth saving. `agent-historian`
just reads that ground truth back.

---

## How it differs from memory / RAG / other approaches

There are several ways to give an agent "memory." `agent-historian` is
deliberately the simplest one — it doesn't build a memory, it **reads the
ground truth you already have on disk**.

| Approach | What it stores | Retrieval | Cost / setup | Faithfulness |
| --- | --- | --- | --- | --- |
| **agent-historian** | nothing — reads existing transcripts | lexical (grep/substring), on demand | zero index, zero deps, read-only | exact original text |
| **Memory layers** (mem0, OpenMemory, MemGPT, "memory tools") | LLM-distilled facts/summaries it decides to save | semantic recall of *summaries* | needs a store + write step; can drift/hallucinate | lossy — a model's paraphrase |
| **RAG / embeddings** (vector DB over chat logs) | chunked text + embedding vectors | semantic (vector similarity) | embedding model + vector DB + reindex pipeline | exact chunks, but needs infra & re-indexing |
| **Built-in `--resume` / `--continue`** | the agent's own session files | reload one whole session into context | free, but no search | exact, but all-or-nothing |
| **Auto-summary recall** (regex/heuristic "what did I accomplish") | extracted bullet points | keyword over summaries | cheap | brittle; breaks on non-English / unusual phrasing |

### When to use which

- **Use `agent-historian`** when you want to *find and re-read what actually
  happened* — the exact command, error, diff, or decision — across past sessions
  and across multiple agents, with no infra and no risk of a model rewriting
  history. It's a **search tool over real transcripts**, not a memory.
- **Add a memory layer (mem0, etc.)** when you want the agent to carry forward
  *distilled preferences and durable facts* ("the user prefers pnpm", "deploys go
  through staging") that should persist as structured knowledge.
- **Use RAG/embeddings** when you need *semantic* recall over a large corpus and
  can afford an embedding model + vector store + re-indexing.

They're complementary: `agent-historian` answers *"show me the real thing I did,"*
memory/RAG answer *"recall the gist of what I know."* Many setups use both —
historian for exact recall, a memory layer for distilled facts.

### Design choices that follow from this

- **No embeddings, no index, no background process** — search is plain lexical
  matching that runs on demand, so there's nothing to build, sync, or keep warm.
- **Read-only** — it never writes a "memory," so it can't drift from or corrupt
  the source of truth.
- **Progressive disclosure** — instead of stuffing summaries into context, the
  agent pages through results (`locate → orient → scan → read`) and pulls only
  the exact lines it needs.

---

## Why CLI + Skill instead of an MCP server

This started as an MCP server, then deliberately moved to a **CLI (`ochist`)
plus an Agent Skill**. Reasons:

- **The agent already has a shell.** With a CLI, the agent composes
  `ochist grep … | head`, `| wc -l`, `| grep -i error`, `| jq` itself. An MCP
  server would have to anticipate and hard-code every such option as tool
  parameters. The shell *is* the query language.
- **Context control belongs to the agent.** Paging/filtering with `head`/`grep`
  lets the agent pull only what it needs. An MCP tool tends to return a fixed
  blob; you re-implement pagination server-side and still over- or under-fetch.
- **Zero resident cost.** An MCP server is a long-lived process attached to the
  session (and its tool schemas occupy context every turn). The CLI runs only
  when invoked — no daemon, no idle token overhead.
- **A Skill teaches *when* and *how*.** MCP exposes *capabilities*; it doesn't
  tell the agent the workflow. The bundled skill encodes "check history before
  re-researching" and the `locate → orient → scan → read` recipe — guidance MCP
  can't carry.
- **Portable & inspectable.** One binary works in any agent that can run shell
  commands, plus humans can run the exact same commands and see the exact output.
  No transport, no protocol, no per-client wiring.
- **Easy to extend.** Adding an agent or a flag is a normal code change; there's
  no tool-schema/permission round-trip.

MCP is a great fit for *capabilities an agent can't otherwise reach* (remote
APIs, privileged actions). Here the data is **local files the agent can already
read with a shell**, so a CLI + Skill is simpler, cheaper, and more flexible.

---

## When this project becomes unnecessary (and that's fine)

`agent-historian` mostly exists to fill a gap: agents persist rich session data
locally, but **don't expose a first-class way to search and read it back**.
OpenCode has `session list` (no message/part reader); Claude Code only has
interactive `--resume`; Qoder's SDK can resume/continue but not read history.

The cleanest end state is for the agents themselves to ship this:

- A read command, e.g. `opencode message get <session>` / `opencode session show`
  (and equivalents for Claude Code / Qoder) that prints messages and tool I/O as
  plain, pipe-friendly text.
- An **official skill** that teaches the agent to check its own history before
  re-researching.

If that happens, you won't need this project — and that would be a *good*
outcome. Until then, `agent-historian` provides a uniform, read-only, cross-agent
way to do it today. (And if it stays useful as the *cross-agent* layer — one tool
that reads OpenCode + Claude Code + Qoder + … through one interface and one
skill — that's a fine reason for it to stick around too.)

---

## Install

```bash
npm install -g agent-historian      # exposes the `ochist` command
```

Or run without installing:

```bash
npx agent-historian sources
```

<details>
<summary>From source (for development)</summary>

```bash
git clone https://github.com/adlternative/agent-historian.git
cd agent-historian
npm install
npm run build
npm link          # symlink `ochist` globally
```
</details>

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
