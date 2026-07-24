// LubbDubb status-line capture helper.
//
// Reads a Claude Code status-line payload on stdin and atomically writes it to
// $LUBBDUBB_STATUS_FILE (write `.tmp`, then rename), or discards it when the env
// var is unset (an operator running the settings by hand).
//
// Why a shipped .mjs invoked as `node <path>` instead of an inline command:
// the `statusLine` setting is a *shell-string only* — it has no exec/args form
// like a hook does — and on Windows Claude Code runs that string through Git
// Bash if installed, else PowerShell. A POSIX `if [ -n "$X" ]; then ...` body is
// a PowerShell parse error (`Missing '(' after 'if'`), so the old command was a
// silent no-op on Windows and rate-limit capture never happened. `node <path>`
// carries no shell syntax, so it runs identically under both shells. The path is
// forward-slashed by the caller so it needs no escaping in either shell.
import { renameSync, writeFileSync } from 'node:fs';

const target = process.env.LUBBDUBB_STATUS_FILE;

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  data += chunk;
});
process.stdin.on('end', () => {
  if (!target) return; // no-op when unset, mirroring the old `cat > /dev/null`
  try {
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, target); // atomic swap so a reader never sees a half-written payload
  } catch {
    // Best-effort: a failed capture just means the cockpit falls back to cost windows.
  }
});
