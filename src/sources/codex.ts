/**
 * Codex CLI history source.
 *
 * Reads OpenAI Codex CLI's local JSONL session transcripts under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (one JSON object
 * per line). Honors `CODEX_HOME`.
 *
 * Per-line schema (relevant types):
 *   { timestamp, type: "session_meta", payload: { id, cwd, timestamp, … } }
 *   { timestamp, type: "response_item", payload: { … } }      ← conversation
 *   { timestamp, type: "event_msg",     payload: { … } }      ← UI events (skipped;
 *                                                                duplicates messages)
 *   { timestamp, type: "turn_context",  payload: { … } }
 *
 * response_item.payload.type is one of:
 *   message              { role, content: [{type:"input_text"|"output_text", text}] }
 *   function_call        { name, arguments (JSON string), call_id }
 *   function_call_output { call_id, output }
 *   reasoning            { encrypted_content, … }  ← encrypted, skipped
 *
 * Codex has no session slug/title, so we derive a slug from the session id
 * and a title from the first user message.
 *
 * Subagents: Codex spawns subagents as their own rollout files whose
 * session_meta carries `parent_thread_id` (+ `thread_source: "subagent"` and
 * an `agent_nickname`). These are hidden from `listSessions` and folded into
 * their parent session's parts with a `[subagent <nickname>]` prefix, so a
 * parent session shows the full picture (matching the Claude Code source).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  HistorySource,
  Part,
  RawPart,
  Role,
  Session,
  Todo,
} from './types.js';

const NAME = 'codex';

function baseDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}
function sessionsDir(): string {
  return join(baseDir(), 'sessions');
}

function tsToMs(ts: string | undefined): number {
  if (!ts) return 0;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

interface RawLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface ContentItem {
  type?: string;
  text?: string;
}

/** True for prompt-injection roles that aren't real conversation. */
function isInternalRole(role: string | undefined): boolean {
  return role === 'developer' || role === 'system';
}

/** Join the text fragments of a message payload's content array. */
function messageText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentItem[])
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Codex injects context blocks (AGENTS.md, environment/permissions wrappers)
 * as the first user-role text fragments. Detect them so they don't get used
 * as a session title.
 */
function isInjectedContext(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('#') || // AGENTS.md / markdown doc
    /^<(environment_context|INSTRUCTIONS|permissions|user_instructions)/i.test(t) ||
    t.startsWith('<app-context') ||
    /AGENTS\.md instructions/i.test(t.slice(0, 60))
  );
}

/**
 * Pick the first genuine user prompt from a session's lines, skipping injected
 * context fragments, for use as the session title.
 */
function firstUserPrompt(lines: RawLine[]): string {
  for (const l of lines) {
    if (l.type !== 'response_item' || l.payload?.type !== 'message') continue;
    if (l.payload?.role !== 'user') continue;
    const content = l.payload.content;
    const frags: string[] =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? (content as ContentItem[]).map((c) => c.text || '').filter(Boolean)
          : [];
    for (const f of frags) {
      if (f.trim() && !isInjectedContext(f)) return f;
    }
  }
  return '';
}

/**
 * Extract a single searchable part from one `response_item` line, or null if
 * the line carries no conversation content (reasoning, internal roles, …).
 */
function extractPart(
  payload: Record<string, unknown>,
): { kind: 'text' | 'tool'; content: string; role: Role; toolName?: string } | null {
  const ptype = payload.type as string;

  if (ptype === 'message') {
    const role = payload.role as string;
    if (isInternalRole(role)) return null;
    const text = messageText(payload).trim();
    if (!text) return null;
    return { kind: 'text', content: text, role: (role as Role) || 'assistant' };
  }

  if (ptype === 'function_call') {
    const toolName = (payload.name as string) || 'tool';
    const args = typeof payload.arguments === 'string' ? payload.arguments : '';
    const content = `[Tool: ${toolName}] ${args}`.trim();
    return { kind: 'tool', content, role: 'assistant', toolName };
  }

  if (ptype === 'function_call_output') {
    const output = typeof payload.output === 'string' ? payload.output : '';
    if (!output.trim()) return null;
    return {
      kind: 'tool',
      content: `[Tool Result] ${output}`,
      role: 'assistant',
      toolName: 'tool_result',
    };
  }

  // reasoning / other → no readable content
  return null;
}

/** Full untruncated content for one response_item line (for `part`). */
function rawLineContent(payload: Record<string, unknown>): string {
  const ptype = payload.type as string;
  if (ptype === 'message') return messageText(payload);
  if (ptype === 'function_call') {
    const name = (payload.name as string) || 'tool';
    const args = typeof payload.arguments === 'string' ? payload.arguments : '';
    return `[Tool: ${name}]\n${args}`;
  }
  if (ptype === 'function_call_output') {
    const output = typeof payload.output === 'string' ? payload.output : '';
    return `--- tool result ---\n${output}`;
  }
  return '';
}

export class CodexSource implements HistorySource {
  readonly name = NAME;
  readonly label = 'Codex CLI';

  isAvailable(): boolean {
    return existsSync(sessionsDir());
  }

  location(): string {
    return sessionsDir();
  }

  /**
   * Read just the session_meta of a file: id, cwd, parent thread (set for
   * subagents) and the subagent nickname/role. Cheap-ish (parses lines until
   * session_meta is found, which is the first line).
   */
  private fileMeta(
    path: string,
  ): { id: string; cwd?: string; parentId?: string; nickname?: string; role?: string } | null {
    const lines = this.readLines(path);
    const meta = lines.find((l) => l.type === 'session_meta');
    const p = meta?.payload;
    if (!p || typeof p.id !== 'string') return null;
    return {
      id: p.id,
      cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
      parentId: typeof p.parent_thread_id === 'string' ? p.parent_thread_id : undefined,
      nickname: typeof p.agent_nickname === 'string' ? p.agent_nickname : undefined,
      role: typeof p.agent_role === 'string' ? p.agent_role : undefined,
    };
  }

  /** Enumerate every file with its parsed meta (id/parent/nickname) and mtime. */
  private allFileMeta(): {
    path: string;
    mtime: number;
    id: string;
    cwd?: string;
    parentId?: string;
    nickname?: string;
    role?: string;
  }[] {
    const out: {
      path: string;
      mtime: number;
      id: string;
      cwd?: string;
      parentId?: string;
      nickname?: string;
      role?: string;
    }[] = [];
    for (const f of this.allFiles()) {
      const m = this.fileMeta(f.path);
      if (!m) continue;
      out.push({ path: f.path, mtime: f.mtime, ...m });
    }
    return out;
  }

  /** Subagent files whose parent_thread_id points at the given session id. */
  private subagentFiles(parentId: string): {
    path: string;
    nickname?: string;
  }[] {
    return this.allFileMeta()
      .filter((f) => f.parentId === parentId)
      .map((f) => ({ path: f.path, nickname: f.nickname }));
  }

  /** Recursively enumerate rollout-*.jsonl files with their mtime. */
  private allFiles(): { path: string; mtime: number }[] {
    const root = sessionsDir();
    if (!existsSync(root)) return [];
    const out: { path: string; mtime: number }[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e);
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(p);
        } else if (e.startsWith('rollout-') && e.endsWith('.jsonl')) {
          out.push({ path: p, mtime: st.mtimeMs });
        }
      }
    };
    walk(root);
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  private readLines(path: string): RawLine[] {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const out: RawLine[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as RawLine);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  private sessionFromFile(path: string, mtime: number): Session | null {
    const lines = this.readLines(path);
    if (!lines.length) return null;

    let id = '';
    let cwd = '';
    let firstTs = 0;
    let lastTs = 0;

    for (const l of lines) {
      const t = tsToMs(l.timestamp);
      if (t) {
        if (!firstTs || t < firstTs) firstTs = t;
        if (t > lastTs) lastTs = t;
      }
      if (l.type === 'session_meta' && l.payload) {
        if (!id && typeof l.payload.id === 'string') id = l.payload.id;
        if (!cwd && typeof l.payload.cwd === 'string') cwd = l.payload.cwd;
      }
    }

    if (!id) return null;

    const title =
      firstUserPrompt(lines)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || '(untitled)';

    return {
      id,
      slug: id.slice(0, 8),
      title,
      directory: cwd,
      timeCreated: firstTs || mtime,
      timeUpdated: lastTs || mtime,
      source: NAME,
    };
  }

  /** Map a session id to its file path (cached per call). */
  private fileForSession(sessionId: string): string | null {
    for (const f of this.allFiles()) {
      const s = this.sessionFromFile(f.path, f.mtime);
      if (s && (s.id === sessionId || s.id.startsWith(sessionId))) return f.path;
    }
    return null;
  }

  listSessions(opts?: { limit?: number; directory?: string }): Session[] {
    const limit = opts?.limit ?? 30;
    const dir = opts?.directory;
    const sessions: Session[] = [];
    for (const f of this.allFileMeta()) {
      // Skip subagent transcripts — they're folded into their parent session.
      if (f.parentId) continue;
      const s = this.sessionFromFile(f.path, f.mtime);
      if (!s) continue;
      if (dir && !s.directory.includes(dir)) continue;
      sessions.push(s);
    }
    sessions.sort((a, b) => b.timeUpdated - a.timeUpdated);
    return sessions.slice(0, limit);
  }

  /**
   * Turn one file's response_item lines into Parts, attributed to `ownerId`.
   * Subagent parts get a `[subagent <nickname>]` content prefix and keep their
   * own file id in the part id so they remain individually addressable.
   */
  private partsFromFile(
    path: string,
    ownerId: string,
    isSubagent = false,
    subagentNickname?: string,
  ): Part[] {
    const lines = this.readLines(path);
    const meta = lines.find((l) => l.type === 'session_meta');
    const fileId = (meta?.payload?.id as string) || ownerId;
    const cwd = (meta?.payload?.cwd as string) || undefined;
    const slug = ownerId.slice(0, 8);
    const label = isSubagent
      ? `[subagent ${subagentNickname || fileId.slice(0, 8)}] `
      : '';

    const out: Part[] = [];
    lines.forEach((l, i) => {
      if (l.type !== 'response_item' || !l.payload) return;
      const ex = extractPart(l.payload);
      if (!ex) return;
      out.push({
        id: `${fileId}:${i}`,
        sessionId: ownerId,
        sessionSlug: slug,
        role: ex.role,
        kind: ex.kind,
        toolName: ex.toolName,
        content: label + ex.content,
        directory: cwd,
        timeCreated: tsToMs(l.timestamp),
        source: NAME,
      });
    });
    return out;
  }

  loadParts(sessionId?: string): Part[] {
    const out: Part[] = [];

    if (sessionId) {
      const parentPath = this.fileForSession(sessionId);
      if (parentPath) out.push(...this.partsFromFile(parentPath, sessionId));
      // Fold in any subagents spawned by this session.
      for (const sub of this.subagentFiles(sessionId)) {
        out.push(...this.partsFromFile(sub.path, sessionId, true, sub.nickname));
      }
    } else {
      // No session filter: every parent file plus its subagents, each part
      // attributed to its parent session id.
      for (const f of this.allFileMeta()) {
        if (f.parentId) continue; // subagents handled under their parent
        out.push(...this.partsFromFile(f.path, f.id));
        for (const sub of this.subagentFiles(f.id)) {
          out.push(...this.partsFromFile(sub.path, f.id, true, sub.nickname));
        }
      }
    }

    out.sort((a, b) => a.timeCreated - b.timeCreated);
    return out;
  }

  loadPartRaw(partId: string): RawPart | null {
    // partId format: <sessionId>:<lineIndex>
    const sep = partId.lastIndexOf(':');
    if (sep < 0) return null;
    const sessionId = partId.slice(0, sep);
    const idx = parseInt(partId.slice(sep + 1), 10);
    if (Number.isNaN(idx)) return null;

    const path = this.fileForSession(sessionId);
    if (!path) return null;
    const lines = this.readLines(path);
    const l = lines[idx];
    if (!l || l.type !== 'response_item' || !l.payload) return null;

    const ex = extractPart(l.payload);
    const meta = lines.find((x) => x.type === 'session_meta');
    const id = (meta?.payload?.id as string) || sessionId;
    const cwd = (meta?.payload?.cwd as string) || undefined;

    return {
      id: partId,
      sessionId: id,
      sessionSlug: id.slice(0, 8),
      role: ex?.role || 'assistant',
      kind: ex?.kind || 'text',
      toolName: ex?.toolName,
      content: rawLineContent(l.payload) || ex?.content || '',
      directory: cwd,
      timeCreated: tsToMs(l.timestamp),
      source: NAME,
    };
  }

  resolveSessionId(selector: string): string | null {
    const sessions = this.listSessions({ limit: 100000 });
    if (selector.toLowerCase() === 'latest') {
      return sessions.length ? sessions[0].id : null;
    }
    const exact = sessions.find((s) => s.id === selector);
    if (exact) return exact.id;
    const pref = sessions.find((s) => s.id.startsWith(selector) || s.slug === selector);
    if (pref) return pref.id;
    // A subagent id/prefix resolves to its parent session.
    const sub = this.allFileMeta().find(
      (f) => f.parentId && (f.id === selector || f.id.startsWith(selector)),
    );
    return sub?.parentId ?? null;
  }

  loadTodos(): Todo[] {
    // Codex does not expose a stable per-session todo store here.
    return [];
  }
}
