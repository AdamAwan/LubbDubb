import type { RecordingStatus } from '../../types.js';

const RECORDING_STATUSES: RecordingStatus[] = ['kept', 'not_offered', 'missing'];

export function toRecordingStatus(raw: string | null | undefined): RecordingStatus | null {
  return RECORDING_STATUSES.find((status) => status === raw) ?? null;
}
