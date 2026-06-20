/**
 * Claude Code history source.
 *
 * Reads Claude Code's local JSONL transcripts under
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (one JSON object
 * per line). Honors `CLAUDE_CONFIG_DIR`.
 *
 * Per-line schema (relevant fields):
 *   { uuid, sessionId, type: "user"|"assistant", timestamp (ISO),
 *     cwd, message: { role, content } }
 *   message.content: string | Array<{type:"text"|"tool_use"|"tool_result", …}>
 *
 * Claude Code has no session slug/title, so we derive a slug from the
 * session id and a title from the first user message.
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

const NAME = 'claudecode';

function baseDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}
function projectsDir(): string {
  return join(baseDir(), 'projects');
}

/** Claude encodes the cwd by replacing path separators with '-'. */
function decodeCwd(encoded: string): string {
  return encoded.replace(/-/g, '/');
}

interface RawLine {
  uuid?: string;
  sessionId?: string;
  type?: string;
  timestamp?: string;
  cwd?: string;
  message?: { role?: string; content?: unknown };
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
}

function tsToMs(ts: string | undefined): number {
  if (!ts) return 0;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

/** Extract one or more searchable parts from a single JSONL message line. */
function extractParts(line: RawLine): Omit<Part, 'sessionSlug' | 'source'>[] {
  const role = (line.message?.role || line.type || 'assistant') as Role;
  const content = line.message?.content;
  const baseId = line.uuid || `${line.sessionId}-${line.timestamp}`;
  const time = tsToMs(line.timestamp);
  const sessionId = line.sessionId || 'unknown';
  const dir = line.cwd;

  const out: Omit<Part, 'sessionSlug' | 'source'>[] = [];

  if (typeof content === 'string') {
    if (content.trim()) {
      out.push({
        id: baseId,
        sessionId,
        role,
        kind: 'text',
        content,
        directory: dir,
        timeCreated: time,
      });
    }
    return out;
  }

  if (Array.isArray(content)) {
    content.forEach((block: ContentBlock, i) => {
      if (block.type === 'text' && block.text?.trim()) {
        out.push({
          id: `${baseId}:${i}`,
          sessionId,
          role,
          kind: 'text',
          content: block.text,
          directory: dir,
          timeCreated: time,
        });
      } else if (block.type === 'tool_use') {
        const toolName = block.name || 'tool';
        const parts: string[] = [`[Tool: ${toolName}]`];
        if (block.input) {
          for (const v of Object.values(block.input)) {
            if (typeof v === 'string') parts.push(v.slice(0, 500));
          }
        }
        out.push({
          id: `${baseId}:${i}`,
          sessionId,
          role,
          kind: 'tool',
          toolName,
          content: parts.join(' ').trim(),
          directory: dir,
          timeCreated: time,
        });
      } else if (block.type === 'tool_result') {
        let text = '';
        if (typeof block.content === 'string') text = block.content;
        else if (Array.isArray(block.content)) {
          text = block.content
            .map((b: ContentBlock) => (b.type === 'text' ? b.text ?? '' : ''))
            .join(' ');
        }
        if (text.trim()) {
          out.push({
            id: `${baseId}:${i}`,
            sessionId,
            role,
            kind: 'tool',
            toolName: 'tool_result',
            content: `[Tool Result] ${text.slice(0, 1500)}`,
            directory: dir,
            timeCreated: time,
          });
        }
      }
    });
  }
  return out;
}

export class ClaudeCodeSource implements HistorySource {
  readonly name = NAME;
  readonly label = 'Claude Code';

  isAvailable(): boolean {
    return existsSync(projectsDir());
  }

  location(): string {
    return projectsDir();
  }

  /**
   * Read the canonical (inner) sessionId from a JSONL file's first line that
   * carries one. Claude Code subagent files are named `agent-*.jsonl` but their
   * lines reference the PARENT session's id, so the inner id is what groups a
   * main session together with its subagents.
   */
  private innerSessionId(path: string, fallback: string): string {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return fallback;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line) as RawLine;
        if (d.sessionId) return d.sessionId;
      } catch {
        /* skip */
      }
    }
    return fallback;
  }

  /** True if a filename denotes a subagent ("sidechain") transcript. */
  private isSubagentFile(filename: string): boolean {
    return filename.startsWith('agent-');
  }

  /**
   * Enumerate every transcript file with its path, mtime, the filename id, and
   * the canonical (inner) sessionId used to group subagents with their parent.
   */
  private allFiles(): {
    file: string;
    canonicalId: string;
    path: string;
    mtime: number;
    subagent: boolean;
  }[] {
    const root = projectsDir();
    if (!existsSync(root)) return [];
    const out: {
      file: string;
      canonicalId: string;
      path: string;
      mtime: number;
      subagent: boolean;
    }[] = [];
    for (const proj of readdirSync(root)) {
      const dir = join(root, proj);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.endsWith('.jsonl')) continue;
        const p = join(dir, e);
        let mtime = 0;
        try {
          mtime = statSync(p).mtimeMs;
        } catch {
          /* ignore */
        }
        const file = e.replace(/\.jsonl$/, '');
        const subagent = this.isSubagentFile(file);
        // Main files: filename == inner id (cheap). Subagent files: read inner id.
        const canonicalId = subagent ? this.innerSessionId(p, file) : file;
        out.push({ file, canonicalId, path: p, mtime, subagent });
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /** All transcript files belonging to a canonical session id (main + subagents). */
  private filesForSession(sessionId: string): {
    file: string;
    path: string;
    subagent: boolean;
  }[] {
    return this.allFiles()
      .filter((f) => f.canonicalId === sessionId || f.file === sessionId)
      .map((f) => ({ file: f.file, path: f.path, subagent: f.subagent }));
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

  private sessionFromFile(
    sessionId: string,
    path: string,
    mtime: number,
  ): Session {
    const lines = this.readLines(path);
    let cwd = '';
    let firstUserText = '';
    let firstTs = 0;
    let lastTs = 0;
    for (const l of lines) {
      if (l.cwd && !cwd) cwd = l.cwd;
      const t = tsToMs(l.timestamp);
      if (t) {
        if (!firstTs || t < firstTs) firstTs = t;
        if (t > lastTs) lastTs = t;
      }
      if (!firstUserText && l.type === 'user') {
        const c = l.message?.content;
        if (typeof c === 'string') firstUserText = c;
        else if (Array.isArray(c)) {
          const tb = (c as ContentBlock[]).find((b) => b.type === 'text');
          if (tb?.text) firstUserText = tb.text;
        }
      }
    }
    const title =
      (firstUserText || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || '(untitled)';
    return {
      id: sessionId,
      slug: sessionId.slice(0, 8),
      title,
      directory: cwd || (path.includes('/projects/') ? decodeCwd(path.split('/projects/')[1].split('/')[0]) : ''),
      timeCreated: firstTs || mtime,
      timeUpdated: lastTs || mtime,
      source: NAME,
    };
  }

  listSessions(opts?: { limit?: number; directory?: string }): Session[] {
    const limit = opts?.limit ?? 30;
    const dir = opts?.directory;

    // Group files by canonical id; a session = its main file plus subagent files.
    const groups = new Map<string, { path: string; mtime: number; subagent: boolean }[]>();
    for (const f of this.allFiles()) {
      const arr = groups.get(f.canonicalId) || [];
      arr.push({ path: f.path, mtime: f.mtime, subagent: f.subagent });
      groups.set(f.canonicalId, arr);
    }

    const sessions: Session[] = [];
    for (const [canonicalId, gfiles] of groups) {
      // Prefer the main (non-subagent) file for title/metadata; fall back to any.
      const main = gfiles.find((g) => !g.subagent) || gfiles[0];
      const mtime = Math.max(...gfiles.map((g) => g.mtime));
      const s = this.sessionFromFile(canonicalId, main.path, mtime);
      if (dir && !s.directory.includes(dir)) continue;
      sessions.push(s);
    }
    sessions.sort((a, b) => b.timeUpdated - a.timeUpdated);
    return sessions.slice(0, limit);
  }

  loadParts(sessionId?: string): Part[] {
    // Targets: all files for one canonical session, or every file.
    const targets = sessionId
      ? this.filesForSession(sessionId)
      : this.allFiles().map((f) => ({ file: f.file, path: f.path, subagent: f.subagent }));

    const out: Part[] = [];
    for (const t of targets) {
      const lines = this.readLines(t.path);
      // Use the canonical inner id so all of a session's parts share one id.
      const canonical = t.subagent ? this.innerSessionId(t.path, t.file) : t.file;
      const slug = canonical.slice(0, 8);
      for (const l of lines) {
        if (l.type !== 'user' && l.type !== 'assistant') continue;
        for (const p of extractParts(l)) {
          out.push({
            ...p,
            // Mark subagent parts so they're visible as such, without losing them.
            toolName: t.subagent && p.kind === 'tool' ? p.toolName : p.toolName,
            content: t.subagent ? `[subagent ${t.file}] ${p.content}` : p.content,
            sessionId: canonical,
            sessionSlug: slug,
            source: NAME,
          });
        }
      }
    }
    out.sort((a, b) => a.timeCreated - b.timeCreated);
    return out;
  }

  loadPartRaw(partId: string): RawPart | null {
    // partId format: <uuid>[:<blockIndex>]; the uuid identifies the line.
    const lineId = partId.split(':')[0];
    for (const f of this.allFiles()) {
      const lines = this.readLines(f.path);
      for (const l of lines) {
        if (l.uuid !== lineId) continue;
        const canonical = f.subagent ? this.innerSessionId(f.path, f.file) : f.file;
        const slug = canonical.slice(0, 8);
        const parts = extractParts(l).map((p) => ({
          ...p,
          sessionId: canonical,
          sessionSlug: slug,
          source: NAME,
        }));
        const exact = parts.find((p) => p.id === partId);
        const chosen = exact || parts[0];
        if (!chosen) return null;
        const prefix = f.subagent ? `[subagent ${f.file}]\n` : '';
        return { ...chosen, content: prefix + (this.rawLineContent(l) || chosen.content) };
      }
    }
    return null;
  }

  /** Build full untruncated content for a single line (for `part`). */
  private rawLineContent(l: RawLine): string {
    const c = l.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const out: string[] = [];
      for (const b of c as ContentBlock[]) {
        if (b.type === 'text' && b.text) out.push(b.text);
        else if (b.type === 'tool_use') {
          out.push(`[Tool: ${b.name}]`);
          if (b.input) {
            for (const [k, v] of Object.entries(b.input)) {
              if (typeof v === 'string') out.push(`  ${k}: ${v}`);
            }
          }
        } else if (b.type === 'tool_result') {
          let t = '';
          if (typeof b.content === 'string') t = b.content;
          else if (Array.isArray(b.content))
            t = b.content.map((x: ContentBlock) => (x.type === 'text' ? x.text ?? '' : '')).join(' ');
          if (t) out.push(`--- tool result ---\n${t}`);
        }
      }
      return out.join('\n');
    }
    return '';
  }

  resolveSessionId(selector: string): string | null {
    // Resolve to a CANONICAL session id (groups subagents with their parent).
    const sessions = this.listSessions({ limit: 100000 });
    if (selector.toLowerCase() === 'latest') {
      return sessions.length ? sessions[0].id : null;
    }
    const exact = sessions.find((s) => s.id === selector);
    if (exact) return exact.id;
    const pref = sessions.find((s) => s.id.startsWith(selector));
    if (pref) return pref.id;
    // Last resort: a filename selector (e.g. an "agent-*" id) maps to its canonical.
    const file = this.allFiles().find((f) => f.file === selector || f.file.startsWith(selector));
    return file ? file.canonicalId : null;
  }

  loadTodos(): Todo[] {
    // Claude Code stores todos under ~/.claude/todos as separate files keyed
    // by session; not reliably mapped here, so report none.
    return [];
  }
}
