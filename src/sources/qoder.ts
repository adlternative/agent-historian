/**
 * Qoder history source.
 *
 * Reads local per-session JSONL transcripts from the Qoder data directory
 * (default `~/.qoder/projects/`, override via `QODER_CONFIG_DIR`). Read-only.
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

const NAME = 'qoder';

function baseDir(): string {
  return process.env.QODER_CONFIG_DIR || join(homedir(), '.qoder');
}
function projectsDir(): string {
  return join(baseDir(), 'projects');
}

/** Best-effort decode of an encoded project-dir name back to a path. */
function decodeCwd(encoded: string): string {
  return encoded.replace(/-/g, '/');
}

interface RawLine {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string | number;
  cwd?: string;
  message?: { role?: string; content?: unknown };
  aiTitle?: string;
  lastPrompt?: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
}

function tsToMs(ts: string | number | undefined): number {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const t = Date.parse(ts);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

/** Extract searchable parts from a single user/assistant message line. */
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
      out.push({ id: baseId, sessionId, role, kind: 'text', content, directory: dir, timeCreated: time });
    }
    return out;
  }
  if (Array.isArray(content)) {
    content.forEach((block: ContentBlock, i) => {
      if (block.type === 'text' && block.text?.trim()) {
        out.push({ id: `${baseId}:${i}`, sessionId, role, kind: 'text', content: block.text, directory: dir, timeCreated: time });
      } else if (block.type === 'tool_use') {
        const toolName = block.name || 'tool';
        const parts: string[] = [`[Tool: ${toolName}]`];
        if (block.input) for (const v of Object.values(block.input)) if (typeof v === 'string') parts.push(v.slice(0, 500));
        out.push({ id: `${baseId}:${i}`, sessionId, role, kind: 'tool', toolName, content: parts.join(' ').trim(), directory: dir, timeCreated: time });
      } else if (block.type === 'tool_result') {
        let text = '';
        if (typeof block.content === 'string') text = block.content;
        else if (Array.isArray(block.content)) text = block.content.map((b: ContentBlock) => (b.type === 'text' ? b.text ?? '' : '')).join(' ');
        if (text.trim()) {
          out.push({ id: `${baseId}:${i}`, sessionId, role, kind: 'tool', toolName: 'tool_result', content: `[Tool Result] ${text.slice(0, 1500)}`, directory: dir, timeCreated: time });
        }
      }
    });
  }
  return out;
}

export class QoderSource implements HistorySource {
  readonly name = NAME;
  readonly label = 'Qoder';

  isAvailable(): boolean {
    return existsSync(projectsDir());
  }

  location(): string {
    return projectsDir();
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

  private mtimeOf(path: string): number {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Enumerate transcript files with canonical ids and mtimes (newest first).
   *
   * A project directory holds top-level `<sessionId>.jsonl` files for main
   * sessions. Subagent transcripts for a session live in a nested
   * `<sessionId>/subagents/*.jsonl` directory, so their canonical id is taken
   * from the owning session directory name (no file read needed).
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
      const projDir = join(root, proj);
      let entries: string[];
      try {
        entries = readdirSync(projDir, { withFileTypes: true }).map((d) =>
          d.isDirectory() ? `${d.name}/` : d.name,
        );
      } catch {
        continue;
      }
      for (const e of entries) {
        // Top-level main-session transcript.
        if (e.endsWith('.jsonl')) {
          const p = join(projDir, e);
          const file = e.replace(/\.jsonl$/, '');
          out.push({ file, canonicalId: file, path: p, mtime: this.mtimeOf(p), subagent: false });
          continue;
        }
        // A session directory may contain a nested "subagents" folder.
        if (e.endsWith('/')) {
          const sessionId = e.slice(0, -1);
          const subDir = join(projDir, sessionId, 'subagents');
          if (!existsSync(subDir)) continue;
          let subFiles: string[];
          try {
            subFiles = readdirSync(subDir);
          } catch {
            continue;
          }
          for (const sf of subFiles) {
            if (!sf.endsWith('.jsonl')) continue;
            const p = join(subDir, sf);
            out.push({
              file: sf.replace(/\.jsonl$/, ''),
              canonicalId: sessionId,
              path: p,
              mtime: this.mtimeOf(p),
              subagent: true,
            });
          }
        }
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  private filesForSession(
    sessionId: string,
  ): { file: string; canonicalId: string; path: string; subagent: boolean }[] {
    return this.allFiles()
      .filter((f) => f.canonicalId === sessionId || f.file === sessionId)
      .map((f) => ({ file: f.file, canonicalId: f.canonicalId, path: f.path, subagent: f.subagent }));
  }

  private sessionFromFiles(canonicalId: string, mainPath: string, mtime: number): Session {
    const lines = this.readLines(mainPath);
    let cwd = '';
    let aiTitle = '';
    let lastPrompt = '';
    let firstUserText = '';
    let firstTs = 0;
    let lastTs = 0;
    for (const l of lines) {
      if (l.cwd && !cwd) cwd = l.cwd;
      if (l.type === 'ai-title' && l.aiTitle) aiTitle = l.aiTitle;
      if (l.type === 'last-prompt' && l.lastPrompt) lastPrompt = l.lastPrompt;
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
      (aiTitle || lastPrompt || firstUserText || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || '(untitled)';
    return {
      id: canonicalId,
      slug: canonicalId.slice(0, 8),
      title,
      directory: cwd || (mainPath.includes('/projects/') ? decodeCwd(mainPath.split('/projects/')[1].split('/')[0]) : ''),
      timeCreated: firstTs || mtime,
      timeUpdated: lastTs || mtime,
      source: NAME,
    };
  }

  listSessions(opts?: { limit?: number; directory?: string }): Session[] {
    const limit = opts?.limit ?? 30;
    const dir = opts?.directory;
    const groups = new Map<string, { path: string; mtime: number; subagent: boolean }[]>();
    for (const f of this.allFiles()) {
      const arr = groups.get(f.canonicalId) || [];
      arr.push({ path: f.path, mtime: f.mtime, subagent: f.subagent });
      groups.set(f.canonicalId, arr);
    }
    const sessions: Session[] = [];
    for (const [canonicalId, gfiles] of groups) {
      const main = gfiles.find((g) => !g.subagent) || gfiles[0];
      const mtime = Math.max(...gfiles.map((g) => g.mtime));
      const s = this.sessionFromFiles(canonicalId, main.path, mtime);
      if (dir && !s.directory.includes(dir)) continue;
      sessions.push(s);
    }
    sessions.sort((a, b) => b.timeUpdated - a.timeUpdated);
    return sessions.slice(0, limit);
  }

  loadParts(sessionId?: string): Part[] {
    const targets = sessionId
      ? this.filesForSession(sessionId)
      : this.allFiles().map((f) => ({
          file: f.file,
          canonicalId: f.canonicalId,
          path: f.path,
          subagent: f.subagent,
        }));

    const out: Part[] = [];
    for (const t of targets) {
      const lines = this.readLines(t.path);
      const canonical = t.canonicalId;
      const slug = canonical.slice(0, 8);
      for (const l of lines) {
        if (l.type !== 'user' && l.type !== 'assistant') continue;
        for (const p of extractParts(l)) {
          out.push({
            ...p,
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
    const lineId = partId.split(':')[0];
    for (const f of this.allFiles()) {
      for (const l of this.readLines(f.path)) {
        if (l.uuid !== lineId) continue;
        const canonical = f.canonicalId;
        const slug = canonical.slice(0, 8);
        const parts = extractParts(l).map((p) => ({ ...p, sessionId: canonical, sessionSlug: slug, source: NAME }));
        const exact = parts.find((p) => p.id === partId);
        const chosen = exact || parts[0];
        if (!chosen) return null;
        const prefix = f.subagent ? `[subagent ${f.file}]\n` : '';
        return { ...chosen, content: prefix + (this.rawLineContent(l) || chosen.content) };
      }
    }
    return null;
  }

  private rawLineContent(l: RawLine): string {
    const c = l.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const out: string[] = [];
      for (const b of c as ContentBlock[]) {
        if (b.type === 'text' && b.text) out.push(b.text);
        else if (b.type === 'tool_use') {
          out.push(`[Tool: ${b.name}]`);
          if (b.input) for (const [k, v] of Object.entries(b.input)) if (typeof v === 'string') out.push(`  ${k}: ${v}`);
        } else if (b.type === 'tool_result') {
          let t = '';
          if (typeof b.content === 'string') t = b.content;
          else if (Array.isArray(b.content)) t = b.content.map((x: ContentBlock) => (x.type === 'text' ? x.text ?? '' : '')).join(' ');
          if (t) out.push(`--- tool result ---\n${t}`);
        }
      }
      return out.join('\n');
    }
    return '';
  }

  resolveSessionId(selector: string): string | null {
    const sessions = this.listSessions({ limit: 100000 });
    if (selector.toLowerCase() === 'latest') {
      return sessions.length ? sessions[0].id : null;
    }
    const exact = sessions.find((s) => s.id === selector);
    if (exact) return exact.id;
    const pref = sessions.find((s) => s.id.startsWith(selector));
    if (pref) return pref.id;
    const file = this.allFiles().find((f) => f.file === selector || f.file.startsWith(selector));
    return file ? file.canonicalId : null;
  }

  loadTodos(): Todo[] {
    return [];
  }
}
