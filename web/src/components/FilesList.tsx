import type { JSX } from 'react';
import type { AgentFile } from '../types.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

export function FilesList({ files }: { files: AgentFile[] | undefined }): JSX.Element | null {
  if (!files || files.length === 0) return null;
  return (
    <details className="drawer-files" onToggle={(e) => e.currentTarget.open && logUsage('agent.expand')}>
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
