/**
 * Source registry: holds all known {@link HistorySource} implementations
 * and selects which are active for a given run.
 *
 * To add a new agent: implement HistorySource in a new file and add an
 * instance to ALL_SOURCES below. No other code needs to change.
 */
import { HistorySource } from './types.js';
import { OpenCodeSource } from './opencode.js';
import { ClaudeCodeSource } from './claudecode.js';
import { QoderSource } from './qoder.js';
import { CodexSource } from './codex.js';

/** Every known source, in priority order. */
export const ALL_SOURCES: HistorySource[] = [
  new OpenCodeSource(),
  new ClaudeCodeSource(),
  new QoderSource(),
  new CodexSource(),
];

/** Look up a source by its `name`. */
export function getSource(name: string): HistorySource | undefined {
  return ALL_SOURCES.find((s) => s.name === name.toLowerCase());
}

/**
 * Resolve the active sources for a run.
 *
 * @param requested - Optional explicit source name (from `--source`).
 *   If given, only that source is returned (error if unknown).
 *   If omitted, all *available* sources are returned (auto-detect).
 */
export function selectSources(requested?: string): HistorySource[] {
  if (requested) {
    const s = getSource(requested);
    if (!s) {
      const known = ALL_SOURCES.map((x) => x.name).join(', ');
      throw new Error(`unknown source "${requested}". Known sources: ${known}`);
    }
    return [s];
  }
  const available = ALL_SOURCES.filter((s) => s.isAvailable());
  // If nothing is available, return all so callers can emit a helpful error.
  return available.length ? available : ALL_SOURCES;
}
