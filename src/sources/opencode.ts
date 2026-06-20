/**
 * OpenCode history source.
 *
 * Reads OpenCode's local SQLite database (`opencode.db`, default
 * `~/.local/share/opencode/opencode.db`) using Node's built-in
 * `node:sqlite` (Node >= 22.5) — zero native dependencies.
 *
 * Schema (relevant tables):
 *   session(id, slug, title, directory, agent, model, cost,
 *           tokens_input, tokens_output, time_created, time_updated, …)
 *   message(id, session_id, data)          -- data: {role, …}
 *   part(id, message_id, session_id, time_created, data)
 *        -- data.type: text | tool | patch | step-start | step-finish
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import {
  HistorySource,
  Part,
  RawPart,
  Role,
  Session,
  Todo,
} from './types.js';

const NAME = 'opencode';

function dbPath(): string {
  if (process.env.OPENCODE_DB_PATH) return process.env.OPENCODE_DB_PATH;
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'opencode.db');
}

function extractPart(data: Record<string, unknown>):
  | { kind: 'text' | 'tool' | 'patch'; content: string; toolName?: string }
  | null {
  const type = data.type as string;

  if (type === 'text') {
    const text = typeof data.text === 'string' ? data.text : '';
    if (!text.trim()) return null;
    return { kind: 'text', content: text };
  }
  if (type === 'tool') {
    const toolName = typeof data.tool === 'string' ? data.tool : 'tool';
    const state = (data.state as Record<string, unknown>) || {};
    const input = (state.input as Record<string, unknown>) || {};
    const output = typeof state.output === 'string' ? state.output : '';
    const parts: string[] = [`[Tool: ${toolName}]`];
    for (const v of Object.values(input)) {
      if (typeof v === 'string') parts.push(v.slice(0, 500));
    }
    if (output) parts.push(output.slice(0, 1500));
    const content = parts.join(' ').trim();
    if (!content) return null;
    return { kind: 'tool', content, toolName };
  }
  if (type === 'patch') {
    const files = data.files;
    const content =
      typeof files === 'string' ? files : JSON.stringify(files ?? data).slice(0, 1500);
    if (!content.trim()) return null;
    return { kind: 'patch', content };
  }
  return null; // step-start / step-finish carry no conversation content
}

function parseModel(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const m = JSON.parse(raw) as { id?: string; modelID?: string };
    return m.id || m.modelID || raw;
  } catch {
    return raw;
  }
}

export class OpenCodeSource implements HistorySource {
  readonly name = NAME;
  readonly label = 'OpenCode';

  private db: DatabaseSync | null = null;

  isAvailable(): boolean {
    return existsSync(dbPath());
  }

  location(): string {
    return dbPath();
  }

  private getDb(): DatabaseSync {
    if (this.db) return this.db;
    const path = dbPath();
    if (!existsSync(path)) {
      throw new Error(`OpenCode database not found at ${path}. Set OPENCODE_DB_PATH to override.`);
    }
    this.db = new DatabaseSync(path, { readOnly: true });
    return this.db;
  }

  private toSession(r: Record<string, unknown>): Session {
    return {
      id: r.id as string,
      slug: (r.slug as string) || (r.id as string).slice(0, 12),
      title: (r.title as string) || '(untitled)',
      directory: (r.directory as string) || '',
      agent: (r.agent as string) || undefined,
      model: parseModel(r.model),
      cost: (r.cost as number) || 0,
      tokensInput: (r.tokens_input as number) || 0,
      tokensOutput: (r.tokens_output as number) || 0,
      timeCreated: r.time_created as number,
      timeUpdated: r.time_updated as number,
      source: NAME,
    };
  }

  listSessions(opts?: { limit?: number; directory?: string }): Session[] {
    const limit = opts?.limit ?? 30;
    const dir = opts?.directory;
    const sql = `
      SELECT id, slug, title, directory, agent, model, cost,
             tokens_input, tokens_output, time_created, time_updated
      FROM session
      ${dir ? 'WHERE directory LIKE ?' : ''}
      ORDER BY time_updated DESC
      LIMIT ?`;
    const stmt = this.getDb().prepare(sql);
    const rows = (dir ? stmt.all(`%${dir}%`, limit) : stmt.all(limit)) as unknown as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.toSession(r));
  }

  loadParts(sessionId?: string): Part[] {
    const sql = `
      SELECT p.id, p.session_id, p.time_created, p.data,
             json_extract(m.data, '$.role') AS role,
             s.slug, s.directory
      FROM part p
      JOIN message m ON m.id = p.message_id
      JOIN session s ON s.id = p.session_id
      ${sessionId ? 'WHERE p.session_id = ?' : ''}
      ORDER BY p.time_created ASC`;
    const stmt = this.getDb().prepare(sql);
    const rows = (sessionId ? stmt.all(sessionId) : stmt.all()) as unknown as Record<
      string,
      unknown
    >[];

    const out: Part[] = [];
    for (const row of rows) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(row.data as string);
      } catch {
        continue;
      }
      const ex = extractPart(data);
      if (!ex) continue;
      out.push({
        id: row.id as string,
        sessionId: row.session_id as string,
        sessionSlug: (row.slug as string) || (row.session_id as string).slice(0, 12),
        role: ((row.role as string) || 'assistant') as Role,
        kind: ex.kind,
        toolName: ex.toolName,
        content: ex.content,
        directory: (row.directory as string) || undefined,
        timeCreated: row.time_created as number,
        source: NAME,
      });
    }
    return out;
  }

  loadPartRaw(partId: string): RawPart | null {
    const stmt = this.getDb().prepare(`
      SELECT p.id, p.session_id, p.time_created, p.data,
             json_extract(m.data, '$.role') AS role,
             s.slug, s.directory
      FROM part p
      JOIN message m ON m.id = p.message_id
      JOIN session s ON s.id = p.session_id
      WHERE p.id = ? LIMIT 1`);
    const row = stmt.get(partId) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.data as string);
    } catch {
      return null;
    }
    const type = data.type as string;
    let content = '';
    let toolName: string | undefined;
    let kind: 'text' | 'tool' | 'patch' = 'text';

    if (type === 'text') {
      content = typeof data.text === 'string' ? data.text : '';
      kind = 'text';
    } else if (type === 'tool') {
      kind = 'tool';
      toolName = typeof data.tool === 'string' ? data.tool : 'tool';
      const state = (data.state as Record<string, unknown>) || {};
      const input = (state.input as Record<string, unknown>) || {};
      const output = typeof state.output === 'string' ? state.output : '';
      const lines: string[] = [`[Tool: ${toolName}]`];
      for (const [k, v] of Object.entries(input)) {
        if (typeof v === 'string') lines.push(`  ${k}: ${v}`);
      }
      if (output) lines.push(`--- output ---\n${output}`);
      content = lines.join('\n');
    } else {
      kind = 'patch';
      content = JSON.stringify(data, null, 2);
    }

    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      sessionSlug: (row.slug as string) || (row.session_id as string).slice(0, 12),
      role: ((row.role as string) || 'assistant') as Role,
      kind,
      toolName,
      content,
      directory: (row.directory as string) || undefined,
      timeCreated: row.time_created as number,
      source: NAME,
    };
  }

  resolveSessionId(selector: string): string | null {
    if (selector.toLowerCase() === 'latest') {
      const r = this.listSessions({ limit: 1 });
      return r.length ? r[0].id : null;
    }
    const stmt = this.getDb().prepare(`
      SELECT id FROM session
      WHERE id = ? OR slug = ? OR id LIKE ? OR slug LIKE ?
      ORDER BY time_updated DESC LIMIT 1`);
    const r = stmt.get(selector, selector, `${selector}%`, `${selector}%`) as
      | { id: string }
      | undefined;
    return r ? r.id : null;
  }

  loadTodos(sessionId: string): Todo[] {
    const stmt = this.getDb().prepare(
      `SELECT content, status FROM todo WHERE session_id = ? ORDER BY position ASC`,
    );
    return stmt.all(sessionId) as unknown as Todo[];
  }
}
