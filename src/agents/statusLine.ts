import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccountRateLimits, RateLimitWindow } from '../types.js';

/**
 * Account-level Claude usage limits (5h / weekly), captured via the status line.
 *
 * Claude Code's `statusLine` hook is the one documented programmatic surface
 * that carries the subscriber rate limits (`rate_limits.five_hour/seven_day`,
 * Pro/Max only) — there is no CLI subcommand or public API for them. The hook
 * only fires in the interactive TUI, so this is a PTY-mode capture: the spawned
 * `claude` gets a `--settings` status command that atomically dumps each stdin
 * payload to a per-session file (`$LUBBDUBB_STATUS_FILE`, set in the spawn env
 * by `AgentManager`), and {@link StatusFileRateLimits} reads the freshest file
 * back on demand. Stream mode never renders a status line; its fallback is the
 * self-computed rolling cost window summed from `usage_events`.
 */

/**
 * Absolute path to the shipped {@link file://./statusCapture.mjs} helper, with
 * `\` normalised to `/` so it embeds in the command string without escaping.
 *
 * The `statusLine` setting is a shell-string only (no exec/args form), and on
 * Windows Claude Code runs it through Git Bash if installed, else PowerShell. A
 * POSIX `if [ -n "$X" ]` body is a PowerShell parse error, so the previous
 * inline command was a silent no-op on Windows. `node <helper>` carries no shell
 * syntax and runs identically under both shells; the helper does the atomic
 * write-then-rename (and the unset no-op) that used to live in the command.
 */
export const STATUS_CAPTURE_HELPER = fileURLToPath(new URL('./statusCapture.mjs', import.meta.url)).replace(/\\/g, '/');

// Quoted so a path containing spaces (e.g. `C:/Users/My Name/...`) stays one
// argument; a plain forward-slashed path in double quotes is portable across
// both Git Bash and PowerShell.
const STATUS_LINE_COMMAND = `node "${STATUS_CAPTURE_HELPER}"`;

/**
 * The `--settings` fragment wiring the capture command into a PTY `claude` launch.
 * An object (not a string) so {@link buildClaudeArgs} can merge it with other
 * settings fragments (e.g. the file-events hook) into a single `--settings`.
 */
export const STATUS_LINE_SETTINGS = {
  statusLine: { type: 'command', command: STATUS_LINE_COMMAND, padding: 0 },
};

interface RawWindow {
  used_percentage?: unknown;
  resets_at?: unknown;
}

/**
 * Parse a status-line payload into the rate limits it carries, or null when it
 * has none (API-key auth, or the first payload before any API response). Each
 * window can be independently absent. Pure — unit-tested without any file IO.
 */
export function parseStatusLinePayload(raw: string, capturedAt: string): AccountRateLimits | null {
  let payload: { rate_limits?: { five_hour?: RawWindow; seven_day?: RawWindow } };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    return null;
  }
  const limits = payload?.rate_limits;
  if (!limits || typeof limits !== 'object') return null;
  const fiveHour = parseWindow(limits.five_hour);
  const sevenDay = parseWindow(limits.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, capturedAt };
}

function parseWindow(w: RawWindow | undefined): RateLimitWindow | null {
  if (!w || typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) return null;
  return { usedPercentage: w.used_percentage, resetsAt: parseResetsAt(w.resets_at) };
}

/** `resets_at` arrives as epoch seconds or an ISO string; normalise to ISO. */
function parseResetsAt(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

/**
 * The read side: one capture file per Claude session under `dir`, freshest
 * mtime wins. Files persist across restarts, so the last known limits survive
 * a reboot (staleness is visible via `capturedAt`). All best-effort — a
 * missing dir or unparsable file just yields null.
 */
export class StatusFileRateLimits {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** Where a session's payloads land; exported as LUBBDUBB_STATUS_FILE at spawn. */
  fileFor(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  /** The freshest parseable rate limits across all captured sessions, or null. */
  readLatest(): AccountRateLimits | null {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return null;
    }
    const byMtime = files
      .map((f) => {
        const path = join(this.dir, f);
        try {
          return { path, mtime: statSync(path).mtime };
        } catch {
          return null; // raced with an atomic replace; skip
        }
      })
      .filter((e) => e !== null)
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    for (const { path, mtime } of byMtime) {
      try {
        const parsed = parseStatusLinePayload(readFileSync(path, 'utf8'), mtime.toISOString());
        if (parsed) return parsed;
      } catch {
        /* unreadable; try the next-freshest */
      }
    }
    return null;
  }
}
