import type { RemoteCapturePost, RemoteReading, RemoteSheetRow } from '../types.js';

// → docs/spec/36-remote-validation.md#posting-the-screen-to-the-ticket

const MARKER = '<!-- lubbdubb:validation-capture -->\n_LubbDubb remote validation_';

/**
 * How a posted link is built, or null where this deployment has not said what address it is
 * reachable at. It is a function rather than a base string because minting the capability is the
 * server's job — `remoteCaptureLinkSignerFor` — and the desk has no key.
 *
 * @public the seam `buildApp` installs the ticket's capture link through
 */
export type CaptureLink = (runId: string, rowId: string) => string | null;

/**
 * One screen a run handed back, ready to be posted. A reading is postable exactly once: the
 * `remote_capture_posts` record is the idempotence, because nothing about a tracker comment can be
 * read back to find out whether it went, and a screen posted twice on a re-read is worse than one
 * never posted.
 *
 * Only a reading a **run** took can carry a screen — a deterministic row is a query — so a null
 * `runId` is filtered here rather than asserted downstream.
 */
interface PostableCapture {
  goalRef: string;
  environment: string;
  runId: string;
  rowId: string;
  capture: string;
  /** The row's own title, which is what a person reading the ticket recognises. */
  title: string | null;
}

export function postableCaptures(input: {
  readings: readonly RemoteReading[];
  rows: readonly RemoteSheetRow[];
  posted: readonly RemoteCapturePost[];
}): PostableCapture[] {
  const already = new Set(input.posted.map((p) => `${p.runId} ${p.rowId}`));
  const titles = new Map(input.rows.map((row) => [`${row.goalRef} ${row.environment} ${row.rowId}`, row.title]));
  const out: PostableCapture[] = [];
  for (const reading of input.readings) {
    if (reading.capture === null || reading.runId === null) continue;
    if (already.has(`${reading.runId} ${reading.rowId}`)) continue;
    already.add(`${reading.runId} ${reading.rowId}`);
    out.push({
      goalRef: reading.goalRef,
      environment: reading.environment,
      runId: reading.runId,
      rowId: reading.rowId,
      capture: reading.capture,
      title: titles.get(`${reading.goalRef} ${reading.environment} ${reading.rowId}`) ?? null,
    });
  }
  return out;
}

/**
 * What the ticket is told. The **prose** is what this comment really carries, and the link is a
 * shortcut on top of it: the artifact key is minted per boot, so a posted URL stops verifying at the
 * next restart, and a deployment that has declared no address for itself gets no link at all. A
 * reader who cannot follow it still learns that a screen exists, which check it belongs to, which
 * environment took it and what it is called — which is enough to ask for it.
 *
 * It says plainly that nothing here judges the screen. A `captured` row is waiting on a person, and
 * a comment that read as a result would be the one thing this whole design refuses: a result derived
 * rather than declared. → docs/spec/20-validation.md#states
 */
export function captureComment(input: PostableCapture & { url: string | null }): string {
  const what = input.title === null ? `row \`${input.rowId}\`` : `**${input.title}** (\`${input.rowId}\`)`;
  const link =
    input.url === null
      ? `It is held with this goal on the harness as \`${input.capture}\`, and the goal's validation sheet in the cockpit shows it on the row.`
      : `[Open the screen](${input.url}) — or find it on the goal's validation sheet in the cockpit. It is held with this goal on the harness as \`${input.capture}\`.`;
  return (
    `${MARKER}\n\n**A screen was captured on \`${input.environment}\` and nobody has looked at it yet.**\n\n` +
    `It was taken for ${what} during run \`${input.runId}\`.\n\n` +
    `${link}\n\n` +
    'Nothing here says the screen is right — a person judges that, and their reading is recorded on ' +
    "the goal's own validation row."
  );
}
