import type { JSX } from 'react';
import type { CiCheck, PullRequest } from '../types.js';
import { Icon } from './icons.js';
import { Tip, useTip } from './tip.js';

// → docs/spec/17-cockpit.md

type CiTone = 't-green' | 't-red' | 't-amber' | 't-blue' | 't-grey';

interface CiReading {
  tone: CiTone;
  badge: string | null;
  said: string;
}

function counted(pr: PullRequest): CiCheck[] {
  return (pr.ciChecks ?? []).filter((check) => check.advisory !== true);
}

function reading(pr: PullRequest): CiReading | null {
  const verdict = pr.ciVerdict;
  const dispatch = verdict?.dispatch.length ?? 0;
  const escalate = verdict?.escalate.length ?? 0;
  const ignored = verdict?.ignored.length ?? 0;
  const checks = counted(pr);
  const total = checks.length;

  if (dispatch > 0) {
    return { tone: 't-red', badge: String(dispatch), said: said(dispatch, total, 'failed') };
  }
  if (escalate > 0) {
    return { tone: 't-amber', badge: String(escalate), said: said(escalate, total, 'failed, for you to fix') };
  }
  if (ignored > 0 && pr.ciStatus === 'failing') {
    return {
      tone: 't-grey',
      badge: String(ignored),
      said: said(ignored, total, 'failed, and muted by the CI policy'),
    };
  }

  switch (pr.ciStatus) {
    case 'passing':
      return {
        tone: 't-green',
        badge: null,
        said: total > 0 ? `All ${total} checks passed` : 'The checks passed',
      };
    case 'failing':
      return { tone: 't-red', badge: null, said: 'A check failed, and the provider named none of them' };
    case 'pending': {
      const waiting = checks.filter((check) => check.status === 'pending');
      if (waiting.length > 0 && waiting.every((check) => check.expired === true)) {
        return {
          tone: 't-amber',
          badge: String(waiting.length),
          said: `${waiting.length} check${waiting.length === 1 ? '' : 's'} waiting on a run nobody has started`,
        };
      }
      return {
        tone: 't-blue',
        badge: null,
        said:
          waiting.length > 0 ? `${waiting.length} of ${total} checks still running` : 'The checks are still running',
      };
    }
    case 'unknown':
      return null;
  }
}

function said(n: number, total: number, what: string): string {
  const count = total > 0 ? total : n;
  const checks = `check${count === 1 ? '' : 's'}`;
  return total > 0 ? `${n} of ${total} ${checks} ${what}` : `${n} ${checks} ${what}`;
}

function verdictWords(pr: PullRequest): Map<string, string> {
  const words = new Map<string, string>();
  for (const match of pr.ciVerdict?.dispatch ?? []) words.set(match.name, 'the fleet will fix it');
  for (const match of pr.ciVerdict?.escalate ?? []) words.set(match.name, 'yours — the policy says the fleet must not');
  for (const match of pr.ciVerdict?.ignored ?? []) words.set(match.name, 'muted by the CI policy');
  return words;
}

const TIP_CHECKS = 6;

function checkWord(check: CiCheck, words: Map<string, string>): string {
  return words.get(check.name) ?? check.status;
}

export function CiSlot(): JSX.Element {
  return <span className="ck-slot" aria-hidden="true" />;
}

export function CiMark({
  pr,
  reserve,
  onOpen,
}: {
  pr: PullRequest;
  reserve?: boolean;
  onOpen?: () => void;
}): JSX.Element | null {
  const tip = useTip();
  const read = reading(pr);
  if (read === null) return reserve === true ? <CiSlot /> : null;

  const checks = counted(pr);
  const words = verdictWords(pr);
  const shown = checks.slice(0, TIP_CHECKS);
  const rest = checks.length - shown.length;
  const Tag = onOpen === undefined ? 'span' : 'button';
  return (
    <Tag
      ref={tip.anchor as never}
      className={`ck ${read.tone}${onOpen === undefined ? '' : ' ck-open'}`}
      {...(onOpen === undefined ? { tabIndex: 0 } : { type: 'button' as const, onClick: onOpen })}
      aria-label={`Checks: ${read.said}${onOpen === undefined ? '' : ' — open the pull request'}`}
      onMouseEnter={tip.open}
      onFocus={tip.open}
      onMouseLeave={tip.close}
      onBlur={tip.close}
    >
      <Icon name="flask" size={14} />
      {read.badge !== null && <span className="ck-badge">{read.badge}</span>}
      {tip.at !== null && (
        <Tip at={tip.at}>
          <b>{read.said}</b>
          {shown.length > 0 && (
            <ul className="ck-list">
              {shown.map((check) => (
                <li key={check.name}>
                  <i className={`ck-dot ck-${check.status}`} />
                  <span>{check.name}</span>
                  <em>{checkWord(check, words)}</em>
                </li>
              ))}
            </ul>
          )}
          {rest > 0 && <span className="ck-more">{`and ${rest} more`}</span>}
          {checks.length === 0 && (
            <span className="ck-more">
              {pr.ciChecksWithheld === true
                ? 'The provider had the per-check detail and the policy withheld it.'
                : 'The provider reported no per-check detail, so this is the aggregate.'}
            </span>
          )}
          <span className="ck-foot">
            {pr.headSha !== undefined && `at ${pr.headSha.slice(0, 7)}`}
            {pr.headSha !== undefined && onOpen !== undefined && ' · '}
            {onOpen !== undefined && 'click for the whole reading'}
          </span>
        </Tip>
      )}
    </Tag>
  );
}
