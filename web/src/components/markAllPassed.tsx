import { useState } from 'react';
import type { ValidationCheckView } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { Button } from './button.js';

/**
 * One press for every check a person has already confirmed, asked twice so it is never a slip.
 * → docs/spec/20-validation.md#marking-them-all-passed
 */
export function MarkAllPassed({
  checks,
  onResult,
  onDone,
}: {
  checks: ValidationCheckView[];
  onResult: (checkId: string, result: 'passed', note: string) => Promise<unknown> | unknown;
  onDone: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (checks.length < 2) return null;
  if (!asking)
    return (
      <div className="vq-markall">
        <Button size="small" ghost usage="validation.edit" onClick={() => setAsking(true)}>
          Mark all passed
        </Button>
      </div>
    );
  return (
    <div className="vq-markall">
      <span className="cn-sub">Mark {checks.length} checks passed?</span>
      <AsyncButton
        usage={{ counted: 'validation.accept' }}
        tone="primary"
        size="small"
        onClick={async () => {
          for (const check of checks) await onResult(check.id, 'passed', '');
          setAsking(false);
          onDone();
        }}
      >
        Yes, all passed
      </AsyncButton>
      <Button size="small" ghost usage="validation.edit" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </div>
  );
}
