import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { FaultReport, FaultReports } from '../types.js';
import { Modal } from './Modal.js';
import { Button, ButtonRow } from './button.js';
import { ExtLink } from './util.js';
import { Tag } from './tag.js';
import { copyText } from './CodeBlock.js';

// → docs/spec/17-cockpit.md

export function FaultReportModal({
  load,
  onClose,
}: {
  load: () => Promise<FaultReports>;
  onClose: () => void;
}): JSX.Element {
  const [reading, setReading] = useState<FaultReports | null>(null);

  useEffect(() => {
    let live = true;
    void load().then(
      (answer) => {
        if (live) setReading(answer);
      },
      (err: Error) => {
        if (live) setReading({ reports: [], unavailable: err.message });
      },
    );
    return () => {
      live = false;
    };
  }, [load]);

  return (
    <Modal face="modal" title="Report faults to LubbDubb" closeUsage="fault.close" onClose={onClose}>
      <p className="rb-intro">
        Each fault below has been stripped to words that appear in LubbDubb’s own source. Your project, repo, paths,
        names and hosts are removed, and a report that still mentions any of them is withheld. Read it before you send
        it.
      </p>
      {reading === null && <p className="cn-empty">Composing reports…</p>}
      {reading?.unavailable != null && (
        <p className="launch-error" role="alert">
          {reading.unavailable}
        </p>
      )}
      {reading !== null && reading.unavailable === null && reading.reports.length === 0 && (
        <p className="cn-empty">No fault to report.</p>
      )}
      {reading?.reports.map((report) => (
        <FaultReportCard key={report.fingerprint} report={report} />
      ))}
    </Modal>
  );
}

function FaultReportCard({ report }: { report: FaultReport }): JSX.Element {
  const [copied, setCopied] = useState(false);
  if (report.withheld !== null)
    return (
      <div className="cn-row">
        <span className="cn-grow">
          <b className="cn-name">{report.source}</b>
          <span className="cn-sub cn-wrap">Withheld: {report.withheld}.</span>
        </span>
        <Tag>×{report.count}</Tag>
      </div>
    );
  const copy = (): void => {
    void copyText(`${report.title}\n\n${report.body}`).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div className="cn-row">
      <span className="cn-grow">
        <b className="cn-name">{report.title}</b>
        <pre className="cn-sub cn-wrap">{report.body}</pre>
        <ButtonRow>
          {report.issueUrl !== null && (
            <ExtLink href={report.issueUrl} look={{ size: 'small' }} usage="fault.open">
              Open as a GitHub issue
            </ExtLink>
          )}
          <Button size="small" ghost usage="fault.copy" onClick={copy}>
            {copied ? 'Copied' : 'Copy to send to the owner'}
          </Button>
        </ButtonRow>
      </span>
      <Tag>×{report.count}</Tag>
    </div>
  );
}
