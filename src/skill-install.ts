/**
 * `ochist skill` — install the bundled agent-history skill into local agents.
 *
 * Version-locked alternative to `npx skills add`: copies or symlinks the
 * skill that ships with this package into the directories agents auto-discover.
 *
 * Install strategy favours the unified, cross-agent location over scattering
 * copies everywhere:
 *
 *   - `~/.agents/skills/` is the modern shared location read by OpenCode (and
 *     other `.agents`-aware tools). A single drop there is enough for OpenCode.
 *   - `~/.claude/skills/` is read only by Claude Code, which does not yet read
 *     `~/.agents/skills`.
 *   - `~/.config/opencode/skills/` and the Qoder / QoderWork dirs are legacy /
 *     product-specific locations.
 *
 * Default global install (`--global`) targets only `~/.agents/skills` — the one
 * unified location — to avoid leaving duplicate copies across the machine.
 * Use `--all` to fan out to every known location (Claude Code, OpenCode config,
 * Qoder, QoderWork) when you really need broad coverage.
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

interface Scope {
  /** Global (home-dir) install rather than project-local. */
  global: boolean;
  /** Fan out to every known location instead of just the unified one. */
  all: boolean;
}

/**
 * Skill destination dirs for the chosen scope.
 *
 * The default favours the single unified `.agents/skills` location. `--all`
 * expands to every known location: Claude Code (`.claude/skills`), the OpenCode
 * config dir (`~/.config/opencode/skills`), and — globally — the Qoder /
 * QoderWork dirs when those products are installed.
 */
function targets(scope: Scope): Target[] {
  const home = homedir();

  if (scope.global) {
    // Unified, cross-agent location — always the primary target.
    const t: Target[] = [
      { label: 'Unified agents (~/.agents/skills)', dir: join(home, '.agents', 'skills') },
    ];
    if (!scope.all) return t;

    // --all: add every other known global location.
    t.push(
      { label: 'Claude Code (~/.claude/skills)', dir: join(home, '.claude', 'skills') },
      { label: 'OpenCode config (~/.config/opencode/skills)', dir: join(home, '.config', 'opencode', 'skills') },
    );
    // Product-specific dirs — include only if installed.
    const optional: { base: string; label: string; dir: string }[] = [
      { base: join(home, '.qoderwork'), label: 'QoderWork (~/.qoderwork/skills)', dir: join(home, '.qoderwork', 'skills') },
      { base: join(home, '.qoder'), label: 'Qoder (~/.qoder/skills)', dir: join(home, '.qoder', 'skills') },
    ];
    for (const o of optional) {
      if (existsSync(o.base)) t.push({ label: o.label, dir: o.dir });
    }
    return t;
  }

  // Project-local: unified `.agents/skills` by default; `--all` adds `.claude`.
  const cwd = process.cwd();
  const t: Target[] = [
    { label: 'Unified agents (.agents/skills)', dir: join(cwd, '.agents', 'skills') },
  ];
  if (scope.all) {
    t.push({ label: 'Claude Code (.claude/skills)', dir: join(cwd, '.claude', 'skills') });
  }
  return t;
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
export function installSkill(opts: { global: boolean; all: boolean; copy: boolean }): void {
  const src = bundledSkillDir();
  const log = (s: string): void => { process.stdout.write(s + "\n"); };

  for (const t of targets({ global: opts.global, all: opts.all })) {
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
export function uninstallSkill(opts: { global: boolean; all: boolean }): void {
  const log = (s: string): void => { process.stdout.write(s + "\n"); };
  let removed = 0;
  for (const t of targets({ global: opts.global, all: opts.all })) {
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
