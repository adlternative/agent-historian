# Show HN draft

Manual submission only. Post at https://news.ycombinator.com/submit while
logged in, then add the comment below as the first reply and stay in the thread.

---

## Title (≤ 80 chars)

```
Show HN: agent-historian – search your past AI coding-agent sessions from the CLI
```

## URL

```
https://github.com/adlternative/agent-historian
```

## First comment (post it yourself right after submitting)

```
I kept noticing my coding agents (OpenCode, Claude Code, Qoder) redo research
they'd already done in an earlier session — re-reading the same files, re-running
the same commands — because each session starts stateless.

agent-historian is a small, read-only CLI (ochist) + an Agent Skill that lets the
agent search and re-read its own past sessions before doing fresh work.

Design choices that might be interesting:

- It does NOT build a memory. No embeddings, no vector DB, no index, no daemon.
  It just reads the transcripts the agents already persist locally (OpenCode's
  SQLite db; Claude Code / Qoder JSONL) and does lexical search on demand.
- It's a CLI + Skill, not an MCP server. The agent already has a shell, so it
  composes `ochist grep ... | head | grep -i error` itself instead of me
  hard-coding every option as MCP tool params. Zero resident process / token cost.
- Progressive disclosure to avoid blowing up context: locate -> orient -> scan ->
  read, pulling only the exact lines needed.
- Pluggable per-agent sources (one interface); subagent transcripts are folded
  into their parent session.
- Zero runtime deps (Node's built-in node:sqlite).

Honest take: this mostly exists to fill a gap. If the agents shipped a
first-class `opencode message get`-style read command + an official skill, you
wouldn't need it — and that'd be a good outcome.

Install: `npm i -g agent-historian` then `npx skills add adlternative/agent-historian -g`

Would love feedback, especially on the "read ground truth vs. build a memory"
tradeoff vs. RAG / memory-layer approaches.
```

---

## Tips
- Best traffic: a US weekday morning (~14:00–16:00 UTC).
- Do NOT ask anyone to upvote — HN penalizes voting rings (can [dead] the post).
- Reply to every comment in the first 1–2 hours; engagement is what gets a Show HN
  onto the front page.
- Keep the title plain; HN dislikes marketing tone.
