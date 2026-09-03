import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { RunningConfigPayload } from '../types.js';
import { Panel } from './panel.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

/**
 * The file, edited as a file.
 *
 * This is the escape hatch that keeps the rest of the page a *layer* rather than
 * a replacement. Everything the form cannot draw — a key this build does not
 * declare, a comment, a block being restructured — is editable here, in the same
 * bytes the harness reads, and the harness cannot tell which of the two wrote
 * them.
 *
 * What it is not is a way to brick a deployment. The check is the loader's own:
 * `POST /api/config/preview` builds the config the text would produce and hands
 * back its refusal, so a removed key is named here exactly as it would be at
 * boot — before the write rather than after the restart that would not come.
 *
 * The file moving underneath an unsaved edit is a first-class state, not a lost
 * update: the page is told (the watcher broadcasts), and it says so rather than
 * quietly writing over whoever moved it.
 */
export function RawConfigTab({
  payload,
  onWrote,
}: {
  payload: RunningConfigPayload;
  onWrote: () => void;
}): React.JSX.Element {
  const [text, setText] = useState(payload.text);
  // The revision this editor was opened against. `payload.revision` moves under
  // it when the watcher sees a change; the two differing is exactly "somebody
  // else wrote the file while you were typing".
  const [baseline, setBaseline] = useState(payload.revision);
  const [verdict, setVerdict] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const dirty = text !== payload.text && text !== '';
  const moved = payload.revision !== baseline;

  // Re-check on a pause in typing rather than a keystroke: the check builds a
  // whole config on the server, and half-typed JSON is the state an editor spends
  // most of its time in.
  useEffect(() => {
    if (!dirty) {
      setVerdict(null);
      return;
    }
    const timer = setTimeout(() => {
      void api
        .previewConfig({ text, baseline })
        .then(() => setVerdict({ ok: true, message: 'This parses, and the harness would boot on it.' }))
        .catch((err: Error) => setVerdict({ ok: false, message: err.message }));
    }, 600);
    return () => clearTimeout(timer);
  }, [text, baseline, dirty]);

  const write = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.saveRawConfig({ text, baseline });
      onWrote();
    } catch (err) {
      setVerdict({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cfg-main">
      {moved && (
        <div className="cfg-banner">
          <b>The file changed on disk</b>
          <span>by something other than this page. Your edits here are unsaved.</span>
          <div className="cfg-bacts">
            <Button
              ghost
              size="small"
              onClick={() => {
                // Keep typing against the new baseline. The write will still be
                // refused if it moves again — this only says "I have seen it".
                setBaseline(payload.revision);
              }}
            >
              Keep mine
            </Button>
            <Button
              size="small"
              onClick={() => {
                setText(payload.text);
                setBaseline(payload.revision);
              }}
            >
              Reload
            </Button>
          </div>
        </div>
      )}

      <Panel density="flush" className="cfg-card">
        <div className="cfg-rawhead">
          <code>{payload.file}</code>
          <span className="cfg-rawacts">
            {verdict && (
              <Tag tone={verdict.ok ? 'green' : 'red'} fill>
                {verdict.ok ? 'valid' : 'refused'}
              </Tag>
            )}
            <Button ghost size="small" disabled={!dirty} onClick={() => setText(payload.text)}>
              Discard edits
            </Button>
            <Button
              tone="primary"
              size="small"
              disabled={!dirty || busy || verdict?.ok === false}
              onClick={() => void write()}
            >
              {busy ? 'Writing…' : 'Write'}
            </Button>
          </span>
        </div>
        <textarea
          className="cfg-raw"
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          rows={24}
        />
      </Panel>

      <Panel density="flush" className="cfg-card">
        <h3>
          What the loader says
          <span className="cfg-more">checked against src/config.ts, not by this page</span>
        </h3>
        {!dirty && (
          <p className="cfg-hint">
            This is the file the harness booted on. Edit it and the loader is asked, before anything is written, whether
            the harness could boot on what you have typed.
          </p>
        )}
        {dirty && !verdict && <p className="cfg-hint">Checking…</p>}
        {verdict && (
          <div className="cfg-mark">
            <Tag tone={verdict.ok ? 'green' : 'red'} fill>
              {verdict.ok ? 'valid' : 'refused'}
            </Tag>
            <span className="cfg-markwhat">{verdict.message}</span>
          </div>
        )}
      </Panel>
    </div>
  );
}
