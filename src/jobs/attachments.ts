import { z } from 'zod';
import type { JobAttachmentInput } from '../types.js';

// → docs/spec/13-jobs-and-tickets.md

export const MAX_ATTACHMENTS = 4;

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const ATTACHMENT_BODY_LIMIT = 32 * 1024 * 1024;

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

export const ACCEPTED_IMAGE_MIMES = SIGNATURES.map((s) => s.mime);

const AttachmentInputSchema: z.ZodType<JobAttachmentInput, z.ZodTypeDef, unknown> = z.object({
  name: z.string({ invalid_type_error: 'attachment name must be a string' }).trim().optional(),
  data: z
    .string({ required_error: 'attachment data required', invalid_type_error: 'attachment data must be base64' })
    .min(1, 'attachment data required'),
});

export const AttachmentsField = z
  .array(AttachmentInputSchema, { invalid_type_error: 'attachments must be an array' })
  .max(MAX_ATTACHMENTS, `at most ${MAX_ATTACHMENTS} attachments per brief`)
  .optional();

export interface PreparedAttachment {
  index: number;
  label: string;
  mime: string;
  ext: string;
  data: Buffer;
}

type Prepared = { ok: true; files: PreparedAttachment[] } | { ok: false; error: string };

export function prepareAttachments(inputs: JobAttachmentInput[] | undefined): Prepared {
  if (!inputs?.length) return { ok: true, files: [] };
  if (inputs.length > MAX_ATTACHMENTS) return { ok: false, error: `at most ${MAX_ATTACHMENTS} attachments per brief` };
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

function describeSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
