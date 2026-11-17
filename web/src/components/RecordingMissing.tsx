import type { JSX } from 'react';
import type { LocalValidationView } from '../types.js';

// → docs/spec/32-local-validation.md#the-recording

export function RecordingMissing({ status }: { status: LocalValidationView['recordingStatus'] }): JSX.Element | null {
  if (status !== 'missing') return null;
  return (
    <p className="cn-sub cn-wrap">
      Not recorded: the browser offered the recorder but no video was written — usually Playwright’s ffmpeg is missing.
      The harness error log names the install command.
    </p>
  );
}
