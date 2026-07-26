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
import { connect } from 'node:net';

const socketPath = process.env.LUBBDUBB_MCP_SOCKET;
const token = process.env.LUBBDUBB_MCP_TOKEN;

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
