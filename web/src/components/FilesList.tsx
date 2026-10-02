import type { JSX } from 'react';
import type { AgentFile } from '../types.js';
import { Collapsible } from './collapsible.js';

// → docs/spec/17-cockpit.md

export function FilesList({ files }: { files: AgentFile[] | undefined }): JSX.Element | null {
  if (!files || files.length === 0) return null;
  return (
    <Collapsible
      subject="agent"
      className="drawer-files"
      logClose={false}
      title={`${files.length} file${files.length === 1 ? '' : 's'} changed`}
    >
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.id} className={`file-row${f.promoted ? ' promoted' : ''}`} title={f.tool ?? undefined}>
            {f.path}
          </li>
        ))}
      </ul>
    </Collapsible>
  );
}
