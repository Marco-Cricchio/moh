/**
 * Masks the CI env flags for fake-tty test processes (#1052 chain, T6 fix).
 *
 * Ink takes its CI path when `CI`/`CONTINUOUS_INTEGRATION` is set: frames
 * are stored, never written to stdout, and the resize listener is never
 * subscribed. The fake tty IS the terminal these tests read — the byte
 * stream would be empty on every runner. The PTY harness does the same
 * strip for its child processes (harness.py:430).
 *
 * This must run BEFORE the first `ink` import in the process: `is-in-ci`
 * snapshots the env at module load. Import this module first in any test
 * file that touches ink directly; render.ts imports it before ink too.
 */
const CI_KEYS = ["CI", "CONTINUOUS_INTEGRATION"] as const;
for (const k of CI_KEYS) delete process.env[k];
