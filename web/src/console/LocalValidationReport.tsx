import { AgentOnIt } from '../components/AgentOnIt.js';
import { ConfirmButton } from '../components/ConfirmButton.js';
import { CONTROL_CLASS } from '../components/controls.js';
import { renderMarkdown } from '../components/markdown.js';
import { Tag, type TagTone } from '../components/tag.js';
import { ExtLink, relTime } from '../components/util.js';
import {
  inFlight,
  localValidationSaid,
  localValidationTone,
  STATUS_WORD,
  type LocalValidationTone,
} from '../view/localValidation.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { LocalValidationFinding, LocalValidationView } from '../types.js';

// → docs/spec/17-cockpit.md

const LAMP: Record<LocalValidationTone, string> = {
  up: 'cn-run',
  busy: 'cn-wait',
  bad: 'cn-lamp-ask',
  off: 'cn-off',
};

const SEVERITY: Record<LocalValidationFinding['severity'], TagTone | undefined> = {
  blocker: 'red',
  defect: 'amber',
  nit: undefined,
};

export function LocalValidationReport({
  validation,
  why,
  issueNumber,
  liveAgents,
  refUrls,
  now,
  actions,
}: {
  validation: LocalValidationView | null;
  why: string | null;
  issueNumber: number;
  liveAgents: ReadonlySet<string>;
  refUrls: Record<string, string>;
  now: number;
  actions: CockpitActions;
}): JSX.Element {
  if (validation === null)
    return (
      <p className="cn-empty">
        No agent has driven this goal on your machine yet.
        {why === null ? '' : ` ${why}`}
      </p>
    );

  const tone = localValidationTone(validation.status);
  const running = inFlight(validation);
  const door = (id: string | null, label: string) => {
    if (id === null) return null;
    return liveAgents.has(id) ? (
      <AgentOnIt agentId={id} actions={actions} note={`${label} — open its transcript`} />
    ) : (
      <button type="button" className="cn-openagent" title={`Open ${label}`} onClick={() => actions.select(id)}>
        {label} ↗
      </button>
    );
  };

  return (
    <div className={`cn-lv${validation.status === 'passed' ? ' cn-lv-passed' : ''}`}>
      <div className="cn-row">
        <i className={`cn-lamp ${LAMP[tone]}`} />
        <span className="cn-grow">
          <b className="cn-name">{running ? localValidationSaid(validation) : STATUS_WORD[validation.status]}</b>
          <span className="cn-sub">
            {`asked ${relTime(validation.requestedAt, now)}`}
            {validation.endedAt === null ? '' : ` · ended ${relTime(validation.endedAt, now)}`}
            {' · '}
            <code>{validation.ref}</code>
            {validation.commit === null ? '' : ' @ '}
            {validation.commit === null ? '' : <code title={validation.commit}>{validation.commit.slice(0, 7)}</code>}
          </span>
        </span>
        <span className="cn-refs">
          {door(validation.agent?.id ?? null, 'the validator')}
          {door(validation.fixAgent?.id ?? null, 'the fix agent')}
        </span>
        {running && (
          <ConfirmButton
            className={CONTROL_CLASS}
            label="Call it off"
            confirmLabel="Call it off — really"
            title="Settle this validation without a reading. The environment is left exactly as it is."
            onConfirm={() => actions.cancelLocalValidation(issueNumber)}
          />
        )}
      </div>

      {/* Why the control is not on the header, drawn on the card whether or not
          there is a row — an operator asking "why can I not press it again" asks it
          most often *after* a run, which is exactly when there is one. Suppressed
          while one is in flight: the line above already says so, at more length. */}
      {why !== null && !running && <p className="cn-sub cn-wrap">{why}</p>}

      {validation.summary !== null && <div className="cn-tick">{renderMarkdown(validation.summary, refUrls)}</div>}
      {/* The note is the row's own account of a non-answer — why it was called off,
          or what a blocked run could not reach. Drawn only when it is not already
          the summary, which is what a `blocked` report writes into both. */}
      {validation.note !== null && validation.note !== validation.summary && (
        <p className="cn-sub cn-wrap">{validation.note}</p>
      )}

      {validation.findings.length > 0 && (
        <div className="cn-rows">
          {validation.findings.map((finding, index) => (
            <div className="cn-row" key={`${finding.title}-${String(index)}`}>
              <Tag tone={SEVERITY[finding.severity]} fill>
                {finding.severity}
              </Tag>
              <span className="cn-grow">
                <b className="cn-name">{finding.title}</b>
                <span className="cn-sub cn-wrap">{finding.detail}</span>
              </span>
              {finding.url !== null && (
                <ExtLink href={finding.url} title={finding.url}>
                  the page
                </ExtLink>
              )}
              {shotFor(validation, finding)}
            </div>
          ))}
        </div>
      )}

      {validation.visited.length > 0 && (
        <p className="cn-sub">
          {'Visited · '}
          {validation.visited.map((url, index) => (
            <span key={url}>
              {index === 0 ? '' : ', '}
              <ExtLink href={url} title={url}>
                {url}
              </ExtLink>
            </span>
          ))}
        </p>
      )}

      {/* Everything it saved, including the shots no finding pointed at: a picture
          of the page that worked is how somebody tells "it passed" from "it was
          never opened". */}
      {validation.files.length > 0 && (
        <div className="cn-lv-shots">
          {validation.files.map((file) => (
            <a key={file.name} href={file.url} target="_blank" rel="noreferrer" title={file.name}>
              <img className="cn-lv-shot" src={file.url} alt={file.name} />
            </a>
          ))}
        </div>
      )}

      {validation.plan !== null && (
        <details className="cn-lv-plan">
          <summary>The test plan it wrote</summary>
          <div className="cn-tick">{renderMarkdown(validation.plan, refUrls)}</div>
        </details>
      )}
    </div>
  );
}

function shotFor(validation: LocalValidationView, finding: LocalValidationFinding): JSX.Element | null {
  if (finding.screenshot === null) return null;
  const file = validation.files.find((f) => f.name === finding.screenshot);
  if (file === undefined) return null;
  return (
    <a href={file.url} target="_blank" rel="noreferrer" title={file.name}>
      <img className="cn-lv-shot" src={file.url} alt={finding.title} />
    </a>
  );
}
