/**
 * The one thing the server and its supervisor have to agree on: the exit code
 * that means "I went down deliberately, take the update and start me again".
 *
 * Its own module, imported by both `src/server/main.ts` and `scripts/serve.ts`,
 * because the failure mode of two copies is silent in the worst way — a server
 * that exits for an upgrade the supervisor reads as a crash comes back on the
 * *old* build with its agents restored, which looks exactly like a successful
 * upgrade until you wonder why the fix is not in.
 *
 * 75 is `EX_TEMPFAIL` from sysexits, which is as close as the conventional codes
 * come to "nothing is wrong, run me again", and is well clear of the range a
 * crashing Node process picks from.
 */
export const UPGRADE_EXIT_CODE = 75;
