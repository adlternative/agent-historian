#!/usr/bin/env node

/**
 * ochist — agent-historian CLI.
 *
 * Search and read past AI coding-agent conversation history (OpenCode,
 * Claude Code, …) as plain, pipe-friendly text so an agent can use shell
 * tools (grep, head, wc, jq) to page and filter without flooding context.
 *
 * Multi-source: by default it auto-detects every agent whose data exists on
 * this machine and queries all of them; restrict with `--source NAME`.
 *
 * Subcommands:
 *   sources
 *   sessions [--source N] [--dir S] [--no-worktrees] [--limit N] [--json]
 *   meta <session> [--source N] [--json]
 *   show <session> [--source N] [--role R] [--type T] [--full] [--max N] [--json]
 *   part <part_id> [--source N] [--json]
 *   grep <pattern> [--source N] [--session S] [--dir S] [--no-worktrees] [--type T] [--limit N] [--json]
 *
 * <session>/<part_id> accept agent-native ids, slugs/prefixes, or "latest".
 */
import './quiet-warnings.js'; // must run before node:sqlite is loaded
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_SOURCES, selectSources } from './sources/registry.js';
import { HistorySource, Part, Session } from './sources/types.js';
import { installSkill, uninstallSkill, skillPath } from './skill-install.js';
import { recordUsage, printStats } from './usage.js';

// ── stdout / EPIPE ──────────────────────────────────────────────────

function out(s: string): void {
  process.stdout.write(s + '\n');
}
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

// ── arg parsing ─────────────────────────────────────────────────────

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}
function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const isFlag = (s: string): boolean => /^-{1,2}[A-Za-z]/.test(s);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Long flag: --name [value]   Short flag: -x [value]
    if (a.startsWith('--') || (a.startsWith('-') && a.length > 1 && /[A-Za-z]/.test(a[1]))) {
      const key = a.startsWith('--') ? a.slice(2) : a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !isFlag(next)) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}
const num = (v: string | boolean | undefined, def: number): number =>
  typeof v === 'string' && !Number.isNaN(parseInt(v, 10)) ? parseInt(v, 10) : def;
const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

// ── helpers ─────────────────────────────────────────────────────────

/** Read the package version from the bundled package.json (dist/ or src/). */
function pkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli.js → ../package.json ; src/cli.ts → ../package.json
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const fmtTime = (ms: number): string =>
  ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '?';
function oneLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}
const tag = (p: Part): string => (p.kind === 'tool' ? `tool:${p.toolName}` : p.role);

const stripSlash = (p: string): string => p.replace(/\/+$/, '');

/**
 * Resolve every working-tree root that belongs to the same git repository as
 * `base` — the main worktree plus all linked worktrees. Sessions recorded in a
 * sibling worktree share the same logical project, so project scope should
 * include them.
 *
 * Returns an empty array when `base` is not inside a git repo (or git is
 * unavailable); callers then fall back to plain `base` nesting.
 */
function gitWorktreeRoots(base: string): string[] {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: base,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const roots: string[] = [];
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) roots.push(stripSlash(line.slice('worktree '.length)));
    }
    return roots;
  } catch {
    return [];
  }
}

/**
 * Resolve the directory scope for project-vs-global filtering.
 *
 * Default = project scope: sessions whose directory is the base dir or a
 * descendant of it. The base dir is also expanded to cover every git worktree
 * of the same repository, so sessions run in a sibling worktree are included.
 * `--global`/`-g` disables filtering. `--dir <path>` sets an explicit base dir
 * (otherwise the current working directory is used). `--no-worktrees` keeps the
 * strict single-directory behavior.
 *
 * @returns A predicate over a session/part directory, or null for "no filter".
 */
function makeScopeFilter(args: Args): ((dir: string | undefined) => boolean) | null {
  const isGlobal = !!args.flags.global || !!args.flags.g;
  if (isGlobal) return null;

  const explicit = str(args.flags.dir);
  const base = stripSlash(explicit || process.cwd());

  const noWorktrees = args.flags['no-worktrees'] === true || args.flags['no-worktrees'] === 'true';
  const bases = noWorktrees ? [base] : worktreeBases(base);

  // Match any base root exactly, or any path nested under one of them.
  return (dir) => {
    if (!dir) return false;
    const d = stripSlash(dir);
    return bases.some((b) => d === b || d.startsWith(b + '/'));
  };
}

/** Base roots for project scope: `base` plus its sibling git worktrees. */
function worktreeBases(base: string): string[] {
  const roots = gitWorktreeRoots(base);
  const set = new Set<string>([base, ...roots]);
  return [...set];
}

/** Human label describing the active scope (for headers/diagnostics). */
function scopeLabel(args: Args): string {
  if (args.flags.global || args.flags.g) return 'global';
  const base = stripSlash(str(args.flags.dir) || process.cwd());
  const noWorktrees = args.flags['no-worktrees'] === true || args.flags['no-worktrees'] === 'true';
  const bases = noWorktrees ? [base] : worktreeBases(base);
  if (bases.length > 1) return `project:${base} (+${bases.length - 1} worktree${bases.length - 1 > 1 ? 's' : ''})`;
  return `project:${base}`;
}

/** Resolve a session across the active sources. Returns {source, id} or null. */
function resolveAcross(
  sources: HistorySource[],
  selector: string,
): { source: HistorySource; id: string } | null {
  for (const s of sources) {
    if (!s.isAvailable()) continue;
    const id = s.resolveSessionId(selector);
    if (id) return { source: s, id };
  }
  return null;
}

// ── subcommands ─────────────────────────────────────────────────────

function cmdSources(): void {
  for (const s of ALL_SOURCES) {
    out(`${s.isAvailable() ? '✓' : '·'} ${s.name}\t${s.label}\t${s.location()}`);
  }
}

function cmdSessions(sources: HistorySource[], args: Args): void {
  const limit = num(args.flags.limit, 30);
  const scope = makeScopeFilter(args);
  // When scoping, pull a wide list per source then filter, so we don't miss
  // matches that fall outside the first `limit` rows.
  const fetch = scope ? 1000 : limit;

  const all: Session[] = [];
  for (const s of sources) {
    if (!s.isAvailable()) continue;
    for (const sess of s.listSessions({ limit: fetch })) {
      if (scope && !scope(sess.directory)) continue;
      all.push(sess);
    }
  }
  all.sort((a, b) => b.timeUpdated - a.timeUpdated);
  const sliced = all.slice(0, limit);

  if (args.flags.json) {
    out(JSON.stringify(sliced, null, 2));
    return;
  }
  if (sliced.length === 0) {
    process.stderr.write(
      `no sessions in scope (${scopeLabel(args)}). Try --global / -g to search all.\n`,
    );
  }
  for (const s of sliced) {
    out([fmtTime(s.timeUpdated), s.source, s.slug, s.id, s.directory, oneLine(s.title, 60)].join('\t'));
  }
}

function cmdMeta(sources: HistorySource[], args: Args): void {
  const sel = args._[0];
  if (!sel) throw new Error('usage: ochist meta <session> [--source N]');
  const r = resolveAcross(sources, sel);
  if (!r) throw new Error(`no session matching "${sel}"`);
  const { source, id } = r;

  const session = source.listSessions({ limit: 9999 }).find((s) => s.id === id);
  const parts = source.loadParts(id);
  const todos = source.loadTodos(id);

  const tools = new Set<string>();
  let userMsgs = 0;
  let asstMsgs = 0;
  for (const p of parts) {
    if (p.kind === 'tool' && p.toolName) tools.add(p.toolName);
    if (p.role === 'user') userMsgs++;
    else asstMsgs++;
  }
  const start = parts[0]?.timeCreated ?? session?.timeCreated ?? 0;
  const end = parts[parts.length - 1]?.timeCreated ?? session?.timeUpdated ?? 0;

  if (args.flags.json) {
    out(
      JSON.stringify(
        {
          source: source.name,
          id,
          slug: session?.slug,
          title: session?.title,
          directory: session?.directory,
          agent: session?.agent,
          model: session?.model,
          start,
          end,
          durationMinutes: Math.round((end - start) / 60000),
          parts: parts.length,
          userMessages: userMsgs,
          assistantMessages: asstMsgs,
          cost: session?.cost,
          tokensInput: session?.tokensInput,
          tokensOutput: session?.tokensOutput,
          toolsUsed: [...tools],
          todos,
        },
        null,
        2,
      ),
    );
    return;
  }

  out(`source:     ${source.label} (${source.name})`);
  out(`title:      ${session?.title ?? '(unknown)'}`);
  out(`slug/id:    ${session?.slug ?? '?'}  /  ${id}`);
  out(`directory:  ${session?.directory ?? '?'}`);
  if (session?.agent || session?.model) out(`agent/model:${session?.agent ?? '?'} / ${session?.model ?? '?'}`);
  out(`time:       ${fmtTime(start)} → ${fmtTime(end)} (${Math.round((end - start) / 60000)}m)`);
  out(`parts:      ${parts.length}  (user ${userMsgs} / assistant ${asstMsgs})`);
  if (session?.cost || session?.tokensInput)
    out(`cost/tokens:$${(session?.cost ?? 0).toFixed(4)}  ·  ${session?.tokensInput ?? 0} in / ${session?.tokensOutput ?? 0} out`);
  out(`tools:      ${[...tools].join(', ') || '(none)'}`);
  if (todos.length) {
    out('todos:');
    for (const t of todos) out(`  [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`);
  }
  out('');
  out(`# Use \`ochist show ${session?.slug ?? id} --source ${source.name}\` for the outline, then \`ochist part <id>\`.`);
}

function cmdShow(sources: HistorySource[], args: Args): void {
  const sel = args._[0];
  if (!sel) throw new Error('usage: ochist show <session> [--role R] [--type T] [--full] [--max N]');
  const r = resolveAcross(sources, sel);
  if (!r) throw new Error(`no session matching "${sel}"`);
  const { source, id } = r;

  const role = str(args.flags.role);
  const type = str(args.flags.type);
  const full = !!args.flags.full;
  const max = num(args.flags.max, full ? 4000 : 120);

  let parts = source.loadParts(id);
  if (role) parts = parts.filter((p) => p.role === role);
  if (type) parts = parts.filter((p) => p.kind === type);

  if (args.flags.json) {
    out(
      JSON.stringify(
        parts.map((p, i) => ({
          n: i + 1,
          id: p.id,
          source: p.source,
          role: p.role,
          kind: p.kind,
          tool: p.toolName,
          time: p.timeCreated,
          chars: p.content.length,
          content: full ? p.content : oneLine(p.content, max),
        })),
        null,
        2,
      ),
    );
    return;
  }

  parts.forEach((p, i) => {
    const head = `#${i + 1}\t${p.id}\t${tag(p)}\t${p.content.length}c`;
    if (full) {
      out(head);
      out(
        p.content.length > max
          ? p.content.slice(0, max) + `\n…[truncated, use \`ochist part ${p.id}\`]`
          : p.content,
      );
      out('');
    } else {
      out(`${head}\t${oneLine(p.content, max)}`);
    }
  });
}

function cmdPart(sources: HistorySource[], args: Args): void {
  const id = args._[0];
  if (!id) throw new Error('usage: ochist part <part_id> [--source N]');
  let found = null;
  for (const s of sources) {
    if (!s.isAvailable()) continue;
    const p = s.loadPartRaw(id);
    if (p) {
      found = p;
      break;
    }
  }
  if (!found) throw new Error(`no part with id "${id}"`);

  if (args.flags.json) {
    out(JSON.stringify(found, null, 2));
    return;
  }
  out(`# part ${found.id}  [${found.source}]  (${found.kind}${found.toolName ? ':' + found.toolName : ''}, role=${found.role}, ${fmtTime(found.timeCreated)})`);
  out(`# session ${found.sessionSlug} (${found.sessionId})`);
  out('');
  out(found.content);
}

function cmdGrep(sources: HistorySource[], args: Args): void {
  const pattern = args._[0];
  if (!pattern) throw new Error('usage: ochist grep <pattern> [--global] [--dir PATH] [--session S] [--type T] [--limit N]');
  const type = str(args.flags.type);
  const limit = num(args.flags.limit, 30);
  const sessionSel = str(args.flags.session);
  // Project scope applies unless a specific session is targeted or --global set.
  const scope = sessionSel ? null : makeScopeFilter(args);

  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const hits: { p: Part; line: string }[] = [];
  outer: for (const s of sources) {
    if (!s.isAvailable()) continue;
    let sid: string | undefined;
    if (sessionSel) {
      const resolved = s.resolveSessionId(sessionSel);
      if (!resolved) continue; // this source doesn't have it
      sid = resolved;
    }
    let parts = s.loadParts(sid);
    if (scope) parts = parts.filter((p) => scope(p.directory));
    if (type) parts = parts.filter((p) => p.kind === type);
    for (const p of parts) {
      for (const line of p.content.split('\n')) {
        if (re.test(line)) {
          hits.push({ p, line: line.trim() });
          break;
        }
      }
      if (hits.length >= limit) break outer;
    }
  }

  if (args.flags.json) {
    out(
      JSON.stringify(
        hits.map((h) => ({
          id: h.p.id,
          source: h.p.source,
          session: h.p.sessionSlug,
          sessionId: h.p.sessionId,
          kind: h.p.kind,
          tool: h.p.toolName,
          time: h.p.timeCreated,
          match: h.line,
        })),
        null,
        2,
      ),
    );
    return;
  }
  for (const h of hits) {
    out([h.p.id, h.p.source, h.p.sessionSlug, tag(h.p), oneLine(h.line, 90)].join('\t'));
  }
}

// ── help / dispatch ─────────────────────────────────────────────────

const HELP = `ochist — agent-historian: search past AI coding-agent conversation history

Sources: OpenCode (opencode.db), Claude Code (~/.claude/projects/*.jsonl), …
By default ALL detected sources are queried. Restrict with --source NAME.

Scope: 'sessions' and 'grep' default to the CURRENT PROJECT (sessions whose
directory is the current working dir or below it). Sibling git worktrees of the
same repo are included automatically; pass --no-worktrees to disable that. Use
--global / -g to search everything, or --dir PATH to scope to a specific dir.

Usage:
  ochist sources
      List known sources and whether each is available on this machine.

  ochist sessions [--source N] [--global|-g] [--dir PATH] [--no-worktrees] [--limit N] [--json]
      List recent sessions (current project by default).
      Columns: time<TAB>source<TAB>slug<TAB>id<TAB>dir<TAB>title

  ochist grep <pattern> [--source N] [--global|-g] [--dir PATH] [--no-worktrees] [--session S] [--type text|tool|patch] [--limit N] [--json]
      Regex/substring search across part content (current project by default).
      Output: part_id<TAB>source<TAB>slug<TAB>tag<TAB>matched_line

  ochist meta <session> [--source N] [--json]
      Reliable metadata card: tools, cost, tokens, todos, counts, time.

  ochist show <session> [--source N] [--role user|assistant] [--type text|tool|patch] [--full] [--max N] [--json]
      Outline (default): one line per part -> #n<TAB>part_id<TAB>tag<TAB>chars<TAB>preview
      --full prints content (truncated at --max chars/part).

  ochist part <part_id> [--source N] [--json]
      Full untruncated content of a single part.

  ochist skill install [--global|-g] [--all] [--copy]
      Install the bundled agent-history skill into local agents.
      Default global target is the unified ~/.agents/skills (one location,
      discovered by OpenCode). Add --all to also install into Claude Code,
      ~/.config/opencode/skills, and Qoder/QoderWork.
      (Standard alternative: npx skills add adlternative/agent-historian)
  ochist skill uninstall [--global|-g] [--all]
  ochist skill path

  ochist stats [--json]
      Local usage summary: how often ochist was invoked (metadata only,
      no query text). Opt out with AGENT_HISTORIAN_NO_TELEMETRY=1.

  ochist --version | -v
  ochist --help

<session>/<part_id> accept: agent id, slug/prefix, or "latest".

Tip (avoid context bloat): pipe through shell tools, e.g.
  ochist sessions | head                 # current project
  ochist sessions --global | head        # everything
  ochist grep "ssh" --global --limit 5
  ochist show latest | grep -i error
  ochist part <id> | head -40
`;

function cmdSkill(args: Args): void {
  const sub = args._[0];
  const global = !!args.flags.global || !!args.flags.g;
  const all = !!args.flags.all;
  switch (sub) {
    case 'install':
      return installSkill({ global, all, copy: !!args.flags.copy });
    case 'uninstall':
    case 'remove':
      return uninstallSkill({ global, all });
    case 'path':
      return skillPath();
    default:
      throw new Error(
        'usage: ochist skill <install|uninstall|path> [--global|-g] [--all] [--copy]\n' +
          '  install    install the agent-history skill into local agents\n' +
          '             (default global target: unified ~/.agents/skills)\n' +
          '  uninstall  remove it\n' +
          '  path       print the bundled skill directory\n' +
          '  --all      fan out to every known location (Claude Code,\n' +
          '             ~/.config/opencode/skills, Qoder, QoderWork)\n' +
          'Tip: the standard cross-agent installer is `npx skills add adlternative/agent-historian`.',
      );
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(pkgVersion() + '\n');
    return;
  }
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  // Record this invocation (metadata only; never query text/results).
  // `stats` is excluded so checking the numbers doesn't inflate them.
  if (cmd !== 'stats') {
    recordUsage({
      cmd,
      hasQuery: args._.length > 0,
      source: str(args.flags.source),
      scope: args.flags.global || args.flags.g ? 'global' : undefined,
    });
  }

  try {
    if (cmd === 'stats') return printStats(!!args.flags.json);
    if (cmd === 'sources') return cmdSources();
    if (cmd === 'skill') return cmdSkill(args);

    const sources = selectSources(str(args.flags.source));

    switch (cmd) {
      case 'sessions':
        return cmdSessions(sources, args);
      case 'meta':
        return cmdMeta(sources, args);
      case 'show':
        return cmdShow(sources, args);
      case 'part':
        return cmdPart(sources, args);
      case 'grep':
        return cmdGrep(sources, args);
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n` + HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

main();
