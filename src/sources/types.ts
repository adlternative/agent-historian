/**
 * Common types and the {@link HistorySource} extension interface.
 *
 * A "source" knows how to read one AI coding agent's local conversation
 * history (OpenCode, Claude Code, …) and expose it as a uniform set of
 * sessions / parts. Add support for a new agent by implementing this
 * interface and registering it in `registry.ts`.
 */

/** Role of a message author. */
export type Role = 'user' | 'assistant' | 'system';

/** Identifier for a built-in source. New sources extend this union. */
export type SourceName = string;

/** Session-level metadata, normalized across agents. */
export interface Session {
  /** Stable unique id (agent-native). */
  id: string;
  /** Human-memorable slug; falls back to a short id if the agent has none. */
  slug: string;
  /** Best available title/summary of the session. */
  title: string;
  /** Working directory the session ran in (if known). */
  directory: string;
  /** Agent persona/mode (if known), e.g. "build", "general". */
  agent?: string;
  /** Model id (if known). */
  model?: string;
  /** Creation time (ms epoch). */
  timeCreated: number;
  /** Last-updated time (ms epoch). */
  timeUpdated: number;
  /** Optional cost in USD (0 if unknown). */
  cost?: number;
  /** Optional token counts. */
  tokensInput?: number;
  tokensOutput?: number;
  /** Which source produced this session. */
  source: SourceName;
}

/** A single searchable unit of conversation (a message or message part). */
export interface Part {
  /** Stable unique id (agent-native, or synthesized). */
  id: string;
  /** Owning session id. */
  sessionId: string;
  /** Session slug for display. */
  sessionSlug: string;
  /** Author role. */
  role: Role;
  /** Logical kind: free text, a tool call, or a file patch/diff. */
  kind: 'text' | 'tool' | 'patch';
  /** Tool name when kind === 'tool'. */
  toolName?: string;
  /** Extracted (possibly truncated) searchable text. */
  content: string;
  /** Working directory of the owning session. */
  directory?: string;
  /** Creation time (ms epoch). */
  timeCreated: number;
  /** Which source produced this part. */
  source: SourceName;
}

/** Full, untruncated content of one part (for `part <id>`). */
export interface RawPart extends Part {
  /** Full content, never truncated. */
  content: string;
}

/** A todo/task item attached to a session, if the agent records them. */
export interface Todo {
  content: string;
  status: string;
}

/**
 * Read-only adapter for one agent's local conversation history.
 *
 * Implementations MUST NOT modify the underlying data store.
 */
export interface HistorySource {
  /** Stable lowercase id, e.g. "opencode", "claudecode". */
  readonly name: SourceName;

  /** Human-readable label, e.g. "OpenCode". */
  readonly label: string;

  /** True if this agent's data store exists on this machine. */
  isAvailable(): boolean;

  /** A short human description of where data is read from (for diagnostics). */
  location(): string;

  /** List sessions, most recently updated first. */
  listSessions(opts?: { limit?: number; directory?: string }): Session[];

  /** Load all conversation parts (optionally for a single session). */
  loadParts(sessionId?: string): Part[];

  /** Load full untruncated content of a single part, or null. */
  loadPartRaw(partId: string): RawPart | null;

  /** Resolve a session by id, slug, prefix, or "latest". Returns id or null. */
  resolveSessionId(selector: string): string | null;

  /** Load todos for a session (empty if unsupported). */
  loadTodos(sessionId: string): Todo[];
}
