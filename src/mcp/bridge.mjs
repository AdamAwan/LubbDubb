// LubbDubb MCP bridge.
//
// `claude` spawns this as a stdio MCP server. It implements none of MCP: it
// hands its stdin to the harness over a Unix domain socket (a named pipe on
// Windows) and writes whatever comes back to stdout. Every protocol decision —
// initialize, tools/list, tools/call, validation — lives in the harness, where
// it is unit-testable without a live `claude` and without any transport at all.
//
// Identity rides on the socket, not on the frames: the first line written is a
// handshake carrying the per-agent token from the env, and the harness resolves
// token -> agent -> task -> origin from that. The agent never names itself, so
// it cannot address another agent's work.
//
// Fail open: any problem here (no env, refused connection, socket dropped) exits
// quietly. `claude` then reports one unavailable MCP server and the agent runs
// exactly as it does today, on the sentinels alone.
//
// `--desktop` is the operator's own Claude Code rather than a spawned agent. It
// reads the socket and token from a 0600 credential file instead of the env, and
// that is the whole reason the file exists: the MCP registration an operator adds
// once is then a fixed command line with no secret in it, and a token minted
// fresh at every harness start needs no re-registration.
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const desktop = process.argv.includes('--desktop');
let socketPath = process.env.LUBBDUBB_MCP_SOCKET;
let token = process.env.LUBBDUBB_MCP_TOKEN;

if (desktop) {
  const path = process.env.LUBBDUBB_DESKTOP_CREDENTIAL || join(homedir(), '.lubbdubb', 'desktop.json');
  try {
    const credential = JSON.parse(readFileSync(path, 'utf8'));
    socketPath = credential.socket;
    token = credential.token;
  } catch {
    // No harness running, or no credential written. Fail open like everything
    // else here: `claude` reports one unavailable server and carries on.
    process.exit(0);
  }
}

if (!socketPath || !token) process.exit(0);

process.stdin.pause();

const socket = connect(socketPath, () => {
  socket.write(JSON.stringify({ lubbdubb: 1, token }) + '\n');
  // Raw piping in both directions: the harness splits frames on newlines and
  // everything it sends is already newline-terminated, so no buffering is needed
  // on this side. Keeping the bridge byte-transparent is what makes it untestable
  // in a way that doesn't matter — there is no logic here to get wrong.
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  process.stdin.resume();
});

// Never let a transport problem take the agent down with it.
socket.on('error', () => process.exit(0));
socket.on('close', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
