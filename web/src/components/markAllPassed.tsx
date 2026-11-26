import type { ValidationCheckView } from '../types.js';
import { ConfirmButton } from './ConfirmButton.js';

/**
 * One press for every check a person has already confirmed, armed like every other control that is
 * awkward to undo. → docs/spec/20-validation.md#marking-them-all-passed
 */
export function MarkAllPassed({
  checks,
  onPassAll,
  onDone,
}: {
  checks: ValidationCheckView[];
  onPassAll: (checkIds: string[]) => Promise<unknown> | unknown;
  onDone: () => void;
}) {
  if (checks.length < 2) return null;
  return (
    <div className="vq-markall">
      <ConfirmButton
        usage={{ counted: 'validation.accept' }}
        tone="primary"
        size="small"
        ghost
        label="Mark all passed"
        confirmLabel={`Mark ${String(checks.length)} passed`}
        onConfirm={async () => {
          await onPassAll(checks.map((c) => c.id));
          onDone();
        }}
      />
    </div>
  );
}
