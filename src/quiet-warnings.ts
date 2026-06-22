/**
 * Suppress Node's noisy `ExperimentalWarning` for `node:sqlite`.
 *
 * The OpenCode source reads its database via the built-in `node:sqlite`
 * module, which Node (>= 22) flags as experimental by emitting an
 * `ExperimentalWarning` to stderr. That warning is emitted from Node's
 * internals (not via a JS `process.emitWarning` we can intercept reliably
 * before the built-in module is linked), so the only robust fix is the
 * `--disable-warning=ExperimentalWarning` runtime flag. It scopes the
 * suppression to experimental warnings only — every other warning still
 * prints.
 *
 * We can't add that flag to the shebang portably, so on startup we check
 * whether it's active and, if not, re-exec the same process once with it.
 * The `OCHIST_NO_REEXEC` guard prevents an infinite loop.
 *
 * The `--disable-warning` flag only exists on Node >= 21.3, and older Node
 * doesn't ship `node:sqlite` (so there's no warning to suppress anyway), so
 * on those versions we skip the re-exec entirely instead of crashing with
 * "bad option".
 *
 * Importing this module for its side effect (before anything pulls in
 * `node:sqlite`) is enough; it either re-execs or returns silently.
 */
import { spawnSync } from 'node:child_process';

/** True if `node --disable-warning` is supported (Node >= 21.3). */
function supportsDisableWarning(): boolean {
  const [major, minor] = process.versions.node.split('.').map((n) => parseInt(n, 10));
  if (Number.isNaN(major)) return false;
  return major > 21 || (major === 21 && minor >= 3);
}

function alreadyQuiet(): boolean {
  if (process.env.OCHIST_NO_REEXEC === '1') return true;
  if (process.env.NODE_NO_WARNINGS === '1') return true;
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS?.split(/\s+/) ?? [])];
  return flags.some(
    (f) =>
      f === '--no-warnings' ||
      f === '--disable-warning=ExperimentalWarning' ||
      f === '--disable-warning', // followed by a separate value
  );
}

if (supportsDisableWarning() && !alreadyQuiet()) {
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, OCHIST_NO_REEXEC: '1' } },
  );
  process.exit(result.status ?? 0);
}
