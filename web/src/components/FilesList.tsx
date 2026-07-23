import type { JSX } from 'react';
import type { AgentFile } from '../types.js';

/**
 * The full set of files an agent wrote, captured by the file-events hook and
 * collapsed by default (it's the complete record, not the curated view). The
 * report-like files also appear above as artifact chips; here they're just
 * marked. Renders nothing when there are none.
 */
export function FilesList({ files }: { files: AgentFile[] | undefined }): JSX.Element | null {
  if (!files || files.length === 0) return null;
  return (
    <details className="drawer-files">
      <summary className="drawer-files-summary">
        {files.length} file{files.length === 1 ? '' : 's'} changed
      </summary>
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.id} className={`file-row${f.promoted ? ' promoted' : ''}`} title={f.tool ?? undefined}>
            {f.path}
          </li>
        ))}
      </ul>
    </details>
  );
}
