import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { ConfigChange, RunningConfigPayload } from '../types.js';
import type { Staged } from './ConfigValues.js';
import { Panel } from './panel.js';
import { Button } from './button.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

export function ReviewWrite({
  payload,
  staged,
  onCancel,
  onWrote,
}: {
  payload: RunningConfigPayload;
  staged: Staged;
  onCancel: () => void;
  onWrote: (changes: readonly ConfigChange[]) => void;
}): React.JSX.Element {
  const [preview, setPreview] = useState<{ text: string; changes: readonly ConfigChange[] } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .previewConfig({ set: staged.set, clear: staged.clear, baseline: payload.revision })
      .then((next) => setPreview({ text: next.text, changes: next.changes }))
      .catch((err: Error) => setRefusal(err.message));
  }, [staged, payload.revision]);

  const write = async (): Promise<void> => {
    setBusy(true);
    setRefusal(null);
    try {
      logUsage('config.edit');
      const result = await api.saveConfig({ set: staged.set, clear: staged.clear, baseline: payload.revision });
      onWrote(result.changes);
    } catch (err) {
      setRefusal((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cfg-main cfg-review">
      <div className="cfg-head" style={{ padding: 0 }}>
        <div>
          <h2 className="cfg-title">Review changes</h2>
          <span className="cfg-where">
            what will be written to <b>{payload.file}</b> · nothing has been written yet
          </span>
        </div>
        <div className="cfg-headacts">
          <Button ghost size="small" onClick={onCancel}>
            Back to values
          </Button>
        </div>
      </div>

      {refusal && <p className="cfg-refusal">{refusal}</p>}

      {preview && (
        <div className="cfg-diff">
          <Panel density="flush" className="cfg-card">
            <h3>
              {payload.file}
              <span className="cfg-more">{countChanged(payload.text, preview.text)} lines changed</span>
            </h3>
            <div className="cfg-code">
              {diffLines(payload.text, preview.text).map((line, i) => (
                <div className={`cfg-ln ${line.kind}`} key={i}>
                  <span className="cfg-gut">{line.n ?? ''}</span>
                  {line.text}
                </div>
              ))}
            </div>
            <p className="cfg-foot">
              Rewritten in place: key order and the <code>&quot;//&quot;</code> doc keys the file already carries are
              kept, and no key this page did not touch is re-serialised.
            </p>
          </Panel>

          <Panel density="flush" className="cfg-card">
            <h3>What it does</h3>
            {preview.changes.map((change) => (
              <div className="cfg-eff" key={change.path}>
                <div>
                  <span className="cfg-effk">
                    {change.path} {render(change.from)} → {render(change.to)}
                  </span>
                  <span className="cfg-effv">
                    {change.applied
                      ? 'An arm re-seats whoever holds this, so it takes effect on save.'
                      : 'The config is read once, at boot — this waits for a restart.'}
                  </span>
                </div>
                <span className={`cfg-src ${change.applied ? 'now' : 'restart'}`}>
                  {change.applied ? 'now' : 'at restart'}
                </span>
              </div>
            ))}
            {preview.changes.length === 0 && (
              <p className="cfg-hint">
                Nothing the running harness would notice — the file changes, and every value it resolves to is what it
                already had.
              </p>
            )}
            <div className="cfg-eff">
              <div>
                <span className="cfg-effk">Everything else</span>
                <span className="cfg-effv">
                  Untouched. A key this page never edited is never written, so hand-made edits between boots survive.
                </span>
              </div>
              <span className="cfg-src ok">kept</span>
            </div>
            <div className="cfg-foot cfg-footacts">
              <Button ghost size="small" onClick={onCancel}>
                Cancel
              </Button>
              <Button tone="primary" size="small" disabled={busy} onClick={() => void write()}>
                {busy ? 'Writing…' : 'Write'}
              </Button>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

interface DiffLine {
  kind: 'ctx' | 'add' | 'del';
  n: number | null;
  text: string;
}

function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const out: DiffLine[] = [];
  const context = 3;
  const from = Math.max(0, head - context);
  for (let i = from; i < head; i++) out.push({ kind: 'ctx', n: i + 1, text: ` ${a[i] ?? ''}` });
  for (let i = head; i < a.length - tail; i++) out.push({ kind: 'del', n: i + 1, text: `-${a[i] ?? ''}` });
  for (let i = head; i < b.length - tail; i++) out.push({ kind: 'add', n: i + 1, text: `+${b[i] ?? ''}` });
  const until = Math.min(a.length, a.length - tail + context);
  for (let i = a.length - tail; i < until; i++) out.push({ kind: 'ctx', n: i + 1, text: ` ${a[i] ?? ''}` });
  return out;
}

function countChanged(before: string, after: string): number {
  return diffLines(before, after).filter((line) => line.kind !== 'ctx').length;
}

function render(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}
