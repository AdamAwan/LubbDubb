import { z } from 'zod';
import type { JobAttachmentInput } from '../types.js';

/**
 * What a blueprint may carry, and how it is decided (issue #249).
 *
 * Pure: this module decodes, measures and *identifies* the bytes an operator
 * pasted, and nothing here touches the disk or the store. Every bound is stated
 * once, here, so the route, the cockpit's own pre-flight check and the specs are
 * reading the same numbers.
 *
 * Two decisions carry the security of the whole feature:
 *
 * - **The format is sniffed, never declared.** The client's `mime` is
 *   attacker-controlled and the stored mime is what an agent is told to trust, so
 *   the type comes from magic bytes on the *decoded* buffer. A `.png` that is not
 *   a PNG is refused rather than stored under a lie.
 * - **The filename is never the client's.** Each file is stored `<index>.<ext>`
 *   from the sniffed format, which removes path traversal as a category instead
 *   of sanitising it. The operator's name survives as a display label only.
 */

/** How many images one blueprint may carry. */
export const MAX_ATTACHMENTS = 4;

/** Decoded size cap, per file. A full-screen retina PNG is ~2–4 MB. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * The `bodyLimit` for a route accepting attachments. Base64 costs a third on the
 * wire, so the worst legal launch is `4 × 5 MB × 4/3` ≈ 28 MB; the rest is JSON
 * and the prompt. Fastify's own 413 fires before validation, which is the point —
 * it is the bound on what can be *buffered*, not on what is accepted.
 */
export const ATTACHMENT_BODY_LIMIT = 32 * 1024 * 1024;

/** The accepted formats: magic bytes → the mime and extension an agent is told. */
const SIGNATURES: { mime: string; ext: string; matches: (buf: Buffer) => boolean }[] = [
  {
    mime: 'image/png',
    ext: 'png',
    matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: 'image/jpeg', ext: 'jpg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', matches: (b) => b.subarray(0, 6).toString('latin1').startsWith('GIF8') },
  {
    mime: 'image/webp',
    ext: 'webp',
    matches: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/** The accepted formats, for a refusal message and for the cockpit's `accept`. */
export const ACCEPTED_IMAGE_MIMES = SIGNATURES.map((s) => s.mime);

/** The wire shape of one attachment, as the launch route accepts it. */
const AttachmentInputSchema: z.ZodType<JobAttachmentInput, z.ZodTypeDef, unknown> = z.object({
  name: z.string({ invalid_type_error: 'attachment name must be a string' }).trim().optional(),
  data: z
    .string({ required_error: 'attachment data required', invalid_type_error: 'attachment data must be base64' })
    .min(1, 'attachment data required'),
});

/** The optional `attachments` field, with the count bound stated in its refusal. */
export const AttachmentsField = z
  .array(AttachmentInputSchema, { invalid_type_error: 'attachments must be an array' })
  .max(MAX_ATTACHMENTS, `at most ${MAX_ATTACHMENTS} attachments per blueprint`)
  .optional();

/** One attachment that passed every bound: the bytes, and what to call them. */
export interface PreparedAttachment {
  /** Position in the operator's list — also the file's stem on disk. */
  index: number;
  /** The operator's filename, or a generated one when they pasted. Display only. */
  label: string;
  mime: string;
  ext: string;
  /** The decoded file. `bytes` is deliberately not this — that name is the *size*. */
  data: Buffer;
}

/** Either the files to store, or the one refusal the route returns as a 400. */
type Prepared = { ok: true; files: PreparedAttachment[] } | { ok: false; error: string };

/**
 * Decode, measure and identify what the operator attached — every bound, in the
 * order an operator can act on: too many, then per-file size, then format.
 *
 * A refusal names the file (by the operator's own label, since that is what they
 * see in the composer) and the bound it broke. The caller returns it as a 400 and
 * queues nothing: a blueprint whose image was dropped is worse than no blueprint,
 * because the prompt says "like this" and there is no "this".
 */
export function prepareAttachments(inputs: JobAttachmentInput[] | undefined): Prepared {
  if (!inputs?.length) return { ok: true, files: [] };
  if (inputs.length > MAX_ATTACHMENTS)
    return { ok: false, error: `at most ${MAX_ATTACHMENTS} attachments per blueprint` };
  const files: PreparedAttachment[] = [];
  for (const [index, input] of inputs.entries()) {
    const label = input.name?.trim() || `attachment ${index + 1}`;
    const bytes = Buffer.from(input.data, 'base64');
    if (bytes.length === 0) return { ok: false, error: `${label} is empty or not valid base64` };
    if (bytes.length > MAX_ATTACHMENT_BYTES)
      return {
        ok: false,
        error: `${label} is ${describeSize(bytes.length)}; the limit is ${describeSize(MAX_ATTACHMENT_BYTES)} per attachment`,
      };
    const signature = SIGNATURES.find((s) => s.matches(bytes));
    if (!signature)
      return {
        ok: false,
        error: `${label} is not one of the accepted image formats (${ACCEPTED_IMAGE_MIMES.join(', ')})`,
      };
    files.push({ index, label, mime: signature.mime, ext: signature.ext, data: bytes });
  }
  return { ok: true, files };
}

/**
 * What a dispatched agent is told about the images the operator attached.
 *
 * **Appended to the rendered prompt, never filled into it** — the rule every
 * other briefing in `materializeTask` follows, and for the same reason: templates
 * are operator-overridable and the loader rejects only *unknown* placeholders, so
 * an override that never learned about an `{attachments}` token would drop the
 * screenshot on exactly the deployments that customised most.
 *
 * The path is absolute and outside the agent's worktree; the launch grants read
 * access to the root it lives under, so the Read tool opens it directly. The
 * label is the operator's own filename, quoted as *theirs* — an agent must not
 * read a filename as an instruction.
 */
export function attachmentsNote(files: { label: string; mime: string; path: string }[]): string {
  if (files.length === 0) return '';
  const list = files
    .map((file) => `- \`${file.path}\` (${file.mime}) — the operator called it “${file.label}”`)
    .join('\n');
  return (
    `---\n\nThe operator attached ${files.length === 1 ? 'an image' : `${files.length} images`} to this request. ` +
    `Read ${files.length === 1 ? 'it' : 'them'} with the Read tool before you start — ${files.length === 1 ? 'it is' : 'they are'} ` +
    `part of what they asked for, not decoration:\n\n${list}\n\n` +
    `The files live outside your working directory and are read-only; do not copy them into the repository.`
  );
}

/** Sizes as an operator reads them, for a refusal that says how far over it was. */
function describeSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
