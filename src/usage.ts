/**
 * Local, privacy-preserving usage logging.
 *
 * Every `ochist` invocation appends one JSON line to
 * `~/.agent-historian/usage.log` recording ONLY metadata — timestamp, the
 * subcommand, whether a query/source filter was used, and the resolved scope.
 * It never records query text, results, file paths, or session content, and it
 * never touches the network. This lets you see how often the agent actually
 * reaches for history (i.e. how often the skill leads to a real call).
 *
 * Opt out with `AGENT_HISTORIAN_NO_TELEMETRY=1` (alias: `DO_NOT_TRACK=1`).
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function dir(): string {
  return join(homedir(), '.agent-historian');
}
function logPath(): string {
  return join(dir(), 'usage.log');
}

function disabled(): boolean {
  return (
    process.env.AGENT_HISTORIAN_NO_TELEMETRY === '1' ||
    process.env.DO_NOT_TRACK === '1'
  );
}

/** One recorded invocation (metadata only). */
export interface UsageEvent {
  ts: string; // ISO timestamp
  cmd: string; // subcommand: sources/sessions/meta/show/part/grep/skill/stats
  hasQuery?: boolean; // whether a query/pattern was supplied
  source?: string; // explicit --source filter, if any
  scope?: string; // "global" | "project" | undefined
}

/** Append one usage event. Best-effort; never throws to the caller. */
export function recordUsage(ev: Omit<UsageEvent, 'ts'>): void {
  if (disabled()) return;
  try {
    mkdirSync(dir(), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n';
    appendFileSync(logPath(), line);
  } catch {
    /* logging must never break the actual command */
  }
}

/** Read and parse all recorded events (best-effort). */
export function readUsage(): UsageEvent[] {
  try {
    if (!existsSync(logPath())) return [];
    return readFileSync(logPath(), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as UsageEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is UsageEvent => e !== null);
  } catch {
    return [];
  }
}

/** Print a usage summary to stdout. */
export function printStats(json: boolean): void {
  const events = readUsage();
  const total = events.length;

  const byCmd: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  let queries = 0;
  for (const e of events) {
    byCmd[e.cmd] = (byCmd[e.cmd] || 0) + 1;
    const day = (e.ts || '').slice(0, 10);
    if (day) byDay[day] = (byDay[day] || 0) + 1;
    if (e.hasQuery) queries++;
  }
  const first = events[0]?.ts;
  const last = events[events.length - 1]?.ts;

  if (json) {
    process.stdout.write(
      JSON.stringify(
        { total, queries, byCmd, byDay, first, last, logPath: logPath() },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const out = (s: string): void => {
    process.stdout.write(s + '\n');
  };
  if (disabled()) {
    out('usage logging is disabled (AGENT_HISTORIAN_NO_TELEMETRY / DO_NOT_TRACK).');
  }
  if (total === 0) {
    out('No usage recorded yet.');
    out(`(log: ${logPath()})`);
    return;
  }
  out(`Total invocations: ${total}   (with a query/pattern: ${queries})`);
  if (first && last) out(`Span: ${first.slice(0, 10)} → ${last.slice(0, 10)}`);
  out('');
  out('By command:');
  for (const [cmd, n] of Object.entries(byCmd).sort((a, b) => b[1] - a[1])) {
    out(`  ${cmd.padEnd(10)} ${n}`);
  }
  const days = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]));
  if (days.length) {
    out('');
    out('By day (last 14):');
    for (const [day, n] of days.slice(-14)) out(`  ${day}  ${n}`);
  }
  out('');
  out(`log: ${logPath()}`);
}
