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
export interface PostableCapture {
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
 * What the ticket is told, in one of two shapes.
 *
 * **Where the provider can hold the image, the image is the comment.** `attached` is the URL the
 * tracker gave back for its own copy, and the body embeds it as markdown — so an Azure DevOps reader
 * sees the screen in the discussion, stored with the work item and gated by the same project access
 * the ticket is. Nobody has to reach the harness at all.
 *
 * **Where it cannot, the prose is what the comment really carries** and the link is a shortcut on top
 * of it: the artifact key is minted per boot, so a posted URL stops verifying at the next restart,
 * and a deployment that has declared no address for itself gets no link either. A reader with neither
 * still learns that a screen exists, which check it belongs to, which environment took it and what it
 * is called — which is enough to ask for it.
 *
 * Both shapes say plainly that nothing here judges the screen. A `captured` row is waiting on a
 * person, and a comment that read as a result would be the one thing this whole design refuses: a
 * result derived rather than declared. → docs/spec/20-validation.md#states
 */
export function captureComment(input: PostableCapture & { url: string | null; attached: string | null }): string {
  const what = input.title === null ? `row \`${input.rowId}\`` : `**${input.title}** (\`${input.rowId}\`)`;
  const held = `It is held with this goal on the harness as \`${input.capture}\`.`;
  const where =
    input.attached !== null
      ? `![${imageAlt(input)}](${input.attached})`
      : input.url === null
        ? `${held} The goal's validation sheet in the cockpit shows it on the row.`
        : `[Open the screen](${input.url}) — or find it on the goal's validation sheet in the cockpit. ${held}`;
  return (
    // The environment is named without a code span deliberately: `markdownToHtml` applies emphasis
    // per code-span-delimited part, so a `**bold**` run straddling one is left as literal asterisks —
    // on an HTML provider, which is the one this sentence matters most on.
    `${MARKER}\n\n**A screen was captured on ${input.environment} and nobody has looked at it yet.**\n\n` +
    `It was taken for ${what} during run \`${input.runId}\`.\n\n` +
    `${where}\n\n` +
    'Nothing here says the screen is right — a person judges that, and their reading is recorded on ' +
    "the goal's own validation row."
  );
}

/**
 * The alt text, which is not decoration here: it is what a reader on a screen reader, or looking at a
 * broken image, is left with — so it names the check rather than saying "screenshot".
 *
 * It carries no bracket or parenthesis, because the body is markdown and an alt that closed the image
 * early would put a raw URL in the comment. The title is a person's own sentence, so that is not
 * hypothetical.
 */
function imageAlt(input: PostableCapture): string {
  const named = input.title ?? input.rowId;
  return `The screen captured on ${input.environment} for ${named}`
    .replace(/[[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
