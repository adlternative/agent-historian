# agent-historian

Search and read your past **AI coding-agent conversation history** from the
command line — so your agent can recover earlier research, commands, errors,
and decisions instead of repeating work.

Ships a small CLI (`ochist`) and an **Agent Skill** so agents like
[OpenCode](https://opencode.ai) and [Claude Code](https://www.anthropic.com/claude-code)
can check history *before* doing fresh research.

- **Multi-agent.** Reads OpenCode (`opencode.db`) and Claude Code
  (`~/.claude/projects/*.jsonl`) out of the box. Pluggable: add a new agent by
  implementing one interface.
- **Project- or global-scoped.** Searches default to the current project
  (current directory and below); `--global` widens to everything.
- **Read-only.** Never modifies any data store.
- **Context-friendly.** Plain, pipe-friendly output. Agents page with
  `grep`/`head`/`wc`/`jq` instead of dumping whole sessions into context.
- **Zero runtime dependencies.** Uses Node's built-in `node:sqlite`
  (Node ≥ 22.5). No native modules.

---

## Why

Agents often redo research they already did in an earlier session, because each
session starts fresh. `agent-historian` gives them a cheap way to recall:
"have I solved this before? what command did I run? what did we decide?"

Unlike approaches that try to *summarize* sessions with brittle regex (which
breaks on non-English text and varied phrasing), `agent-historian` lets the
agent **read the real text on demand**, using a progressive-disclosure
workflow so it only pulls what it needs.

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
that teaches agents *when* and *how* to use `ochist`.

**OpenCode** — copy or symlink it into a skills directory:

```bash
mkdir -p ~/.config/opencode/skills
ln -s "$(pwd)/skills/agent-history" ~/.config/opencode/skills/agent-history
```

**Claude Code** — likewise:

```bash
mkdir -p ~/.claude/skills
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

## License

MIT — see [LICENSE](LICENSE).
