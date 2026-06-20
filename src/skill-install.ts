/**
 * `ochist skill` — install the bundled agent-history skill into local agents.
 *
 * Version-locked alternative to `npx skills add`: copies or symlinks the
 * skill that ships with this package into the directories OpenCode and
 * Claude Code auto-discover. Both agents read `~/.claude/skills`, so a single
 * global drop there is seen by both; OpenCode also reads
 * `~/.config/opencode/skills`.
 */
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  cpSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'agent-history';

/** Resolve the bundled skill directory relative to this file (dist/ or src/). */
function bundledSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled file lives at <repo>/dist/skill-install.js → skill at <repo>/skills/...
  // Source file lives at <repo>/src/skill-install.ts  → same relative target.
  const candidate = join(here, '..', 'skills', SKILL_NAME);
  if (existsSync(join(candidate, 'SKILL.md'))) return candidate;
  throw new Error(`bundled skill not found near ${here}`);
}

interface Target {
  label: string;
  dir: string;
}

/** Skill destination dirs for the chosen scope. */
function targets(global: boolean): Target[] {
  if (global) {
    return [
      { label: 'Claude Code + OpenCode (~/.claude/skills)', dir: join(homedir(), '.claude', 'skills') },
      { label: 'OpenCode (~/.config/opencode/skills)', dir: join(homedir(), '.config', 'opencode', 'skills') },
    ];
  }
  return [
    { label: 'Claude Code (.claude/skills)', dir: join(process.cwd(), '.claude', 'skills') },
    { label: 'OpenCode/agents (.agents/skills)', dir: join(process.cwd(), '.agents', 'skills') },
  ];
}

function isOurs(dest: string, src: string): boolean {
  try {
    const st = lstatSync(dest);
    if (st.isSymbolicLink()) return readlinkSync(dest) === src;
    return false;
  } catch {
    return false;
  }
}

/** Install the skill into all target dirs. */
export function installSkill(opts: { global: boolean; copy: boolean }): void {
  const src = bundledSkillDir();
  const log = (s: string): void => { process.stdout.write(s + "\n"); };

  for (const t of targets(opts.global)) {
    mkdirSync(t.dir, { recursive: true });
    const dest = join(t.dir, SKILL_NAME);

    if (existsSync(dest) || isOurs(dest, src)) {
      rmSync(dest, { recursive: true, force: true });
    }

    if (opts.copy) {
      cpSync(src, dest, { recursive: true });
      log(`✓ copied  → ${dest}   [${t.label}]`);
    } else {
      try {
        symlinkSync(src, dest, 'dir');
        log(`✓ linked  → ${dest}   [${t.label}]`);
      } catch {
        cpSync(src, dest, { recursive: true });
        log(`✓ copied  → ${dest}   (symlink failed)   [${t.label}]`);
      }
    }
  }
  log('\nRestart your agent; it will discover the "agent-history" skill.');
}

/** Remove the skill from all target dirs. */
export function uninstallSkill(opts: { global: boolean }): void {
  const log = (s: string): void => { process.stdout.write(s + "\n"); };
  let removed = 0;
  for (const t of targets(opts.global)) {
    const dest = join(t.dir, SKILL_NAME);
    if (existsSync(dest) || (() => { try { lstatSync(dest); return true; } catch { return false; } })()) {
      rmSync(dest, { recursive: true, force: true });
      log(`✓ removed → ${dest}`);
      removed++;
    }
  }
  if (removed === 0) log('Nothing to remove.');
}

/** Print the bundled skill path (for manual linking / inspection). */
export function skillPath(): void {
  process.stdout.write(bundledSkillDir() + '\n');
}
