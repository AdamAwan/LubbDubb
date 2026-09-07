import { useState } from 'react';
import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { EnvironmentHealthReading } from '../types.js';
import type { CockpitActions, ConsoleTab } from '../cockpit/actions.js';
import { FleetControl } from '../components/FleetControl.js';
import { Icon } from '../components/icons.js';
import { ExtLink, fmtUsd, relTime } from '../components/util.js';
import { ControlButton } from '../components/controls.js';
import { RaiseIssueModal } from '../components/RaiseIssueModal.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { questionPrompt } from '../cockpit/desktopLink.js';
import { untriagedCount } from '../worldBuckets.js';
import { useThemeUnsaved } from '../hooks.js';
import { signalRows } from './WorldSignals.js';

// → docs/spec/17-cockpit.md

const TABS: readonly ConsoleTab[] = ['overview', 'tickets', 'obstacles', 'insights'];

const NEW_ISSUE_URL = 'https://github.com/AdamAwan/LubbDubb/issues/new';

export const TAB_LABEL: Record<ConsoleTab, string> = {
  overview: 'Overview',
  tickets: 'Tickets',
  obstacles: 'Obstacles',
  features: 'Features',
  insights: 'Insights',
  pets: 'Pets',
  config: 'Config',
};

function Nav({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const goal = view.goalPage;
  const go = (tab: ConsoleTab) => () => {
    actions.selectGoal(null);
    actions.openTab(tab);
  };

  const tabs: readonly ConsoleTab[] = view.state.config.featureBoard
    ? ['overview', 'tickets', 'features', 'obstacles', 'insights']
    : TABS;

  return (
    <nav className="cn-nav">
      {tabs.map((tab) => {
        const badge = navBadge(tab, view);
        return (
          <button
            key={tab}
            type="button"
            className={goal === null && view.tab === tab ? 'cn-on' : ''}
            onClick={go(tab)}
            {...(badge === null ? {} : { title: badge.title })}
          >
            {TAB_LABEL[tab]}
            {badge !== null && <i className="cn-badge">{badge.count}</i>}
          </button>
        );
      })}
    </nav>
  );
}

function navBadge(tab: ConsoleTab, view: CockpitView): { count: number; title: string } | null {
  if (tab === 'tickets') {
    const count = untriagedCount(view.state.world.issues, view.state.config.watchLabel);
    return count === 0 ? null : { count, title: `${count} untriaged — nothing has said whether the fleet works these` };
  }
  return null;
}

function Ident({ view }: { view: CockpitView }): JSX.Element {
  return (
    <div className="cn-ident">
      <i className="cn-dot" style={view.connected ? undefined : { background: 'var(--cn-red)' }} />
      LubbDubb
      {view.demo && <span style={{ color: 'var(--cn-fg-faint)', fontWeight: 400 }}>· demo</span>}
    </div>
  );
}

function Asks({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const [composing, setComposing] = useState(false);

  const canCompose = view.connected;

  return (
    <div className="cn-asks">
      {canCompose ? (
        <ControlButton
          icon="bug"
          title="Write an issue about LubbDubb and file it on its own tracker, without leaving the cockpit"
          onClick={() => setComposing(true)}
        >
          Issue!
        </ControlButton>
      ) : (
        <ExtLink href={NEW_ISSUE_URL} control title="Raise an issue on the LubbDubb repo">
          <Icon name="bug" />
          Issue! ↗
        </ExtLink>
      )}
      {/* The bar's second way out, and the one that answers rather than files.
          Most of what arrives as an issue about the fleet is not a fault in it —
          it is "why has this not moved", which the harness's own record answers in
          a sentence and which nobody asks because asking meant opening a client,
          finding the checkout and remembering the skill. This is that, as a
          control: a `DesktopLink` onto the repository the fleet works, with
          `/lubbdubb ` in the composer and the question left to the operator.

          The one deep link that says `Question?` rather than `Open in Claude
          Code`. The other five are drawn beside the thing they open and are named
          for the destination for that reason; this one addresses nothing, and the
          destination is not the offer — named for it, it read as a developer's
          control parked between `Issue!` and the usage meters rather than as the
          invitation to ask. The questions it is for are in the title, which is the
          only place a label of one word can put them.

          Unconditional, like every other deep link: it reaches only the machine
          the browser is on, and `DesktopLink` puts the command in the title for
          exactly the operator it cannot reach. */}
      <DesktopLink
        control
        folder={view.state.config.desktopFolder}
        prompt={questionPrompt()}
        label="Question?"
        ready="waiting for your question"
        explain="so you can ask why something has not been picked up, what a goal is doing or what any of this means — answered from the harness’s own record of the work, and said so when the record is silent."
      />
      {composing && (
        <RaiseIssueModal
          probe={actions.probeFilingTarget}
          fallbackUrl={NEW_ISSUE_URL}
          onSubmit={actions.raiseIssue}
          onClose={() => setComposing(false)}
        />
      )}
    </div>
  );
}

interface EnvironmentsReading {
  value: string;
  quiet: boolean;
  tone: 'ill' | 'watch' | null;
  title: string;
}

function healthRank(reading: EnvironmentHealthReading): number {
  if (reading.state === 'unhealthy') return reading.tier === 'orange' ? 1 : 0;
  if (reading.state === 'unknown') return 2;
  return 3;
}

function healthWord(reading: EnvironmentHealthReading): string {
  if (reading.tier !== null) return reading.tier;
  return reading.state === 'healthy' ? 'well' : reading.state === 'unknown' ? 'no answer' : 'not well';
}

export function environmentsReading(readings: readonly EnvironmentHealthReading[], now: number): EnvironmentsReading {
  const worst = [...readings].sort((a, b) => healthRank(a) - healthRank(b))[0]!;
  const word = healthWord(worst);
  const count = readings.filter((r) => healthWord(r) === word).length;
  const rank = healthRank(worst);
  const read = `read ${relTime(worst.observedAt, now)}`;
  const said = worst.reasons.length > 0 ? worst.reasons.join(' · ') : worst.detail;
  const title =
    rank === 3
      ? `Every environment answered well — ${read}.`
      : `${worst.environment} ${worst.state === 'unknown' ? 'did not answer' : 'is not well'} — ${word} since ${relTime(worst.changedAt, now).replace(' ago', '')}, ${read}.${said === null || said === '' ? '' : ` ${said}`}`;
  return {
    value: `${count} ${word}`,
    quiet: rank === 3,
    tone: rank === 2 ? 'watch' : rank === 3 ? null : 'ill',
    title,
  };
}

function Environments({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element | null {
  const readings = view.state.environmentHealth ?? [];
  if (readings.length === 0) return null;
  const reading = environmentsReading(readings, view.now);
  if (reading.quiet) return null;
  const title = `${reading.title} Open the readings.`;
  return (
    <button
      type="button"
      className={`cn-read cn-act cn-env-${reading.tone ?? 'watch'}`}
      onClick={() => actions.openPanel('environments')}
      title={title}
      aria-label={title}
    >
      <span>Env</span>
      <b>{reading.value}</b>
      <i className="cn-chev">›</i>
    </button>
  );
}

function Scan({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const stopped = view.pulseHeld || view.state.control.paused;
  const reading = view.pulseHeld ? 'held' : view.state.control.paused ? 'paused' : `${view.nextPulseIn}s`;
  const title = view.pulseHeld
    ? 'Scan held: agents from the previous run need a recovery decision — press to try one anyway'
    : view.state.control.paused
      ? 'Scan paused — press to run one now'
      : `Next scan in about ${view.nextPulseIn} seconds — press to run one now`;
  return (
    <button
      type="button"
      className={`cn-countdown ${stopped ? 'cn-quiet' : ''}`}
      onClick={() => void actions.pulse()}
      title={title}
      aria-label={title}
    >
      {reading}
    </button>
  );
}

function buildReading(view: CockpitView): MenuReading {
  const build = view.state.build;
  const due = build.state === 'behind' || build.state === 'ready';
  const title =
    build.state === 'behind'
      ? `LubbDubb is ${build.standing.behind} commit(s) behind upstream — open to see what changed`
      : build.state === 'draining'
        ? 'Upgrade pending: dispatch is paused while the fleet finishes — open to apply or cancel'
        : build.state === 'ready'
          ? 'Ready to upgrade — open to apply'
          : build.state === 'unknown'
            ? `This build could not be checked: ${build.standing.unavailable ?? 'no reason given'}`
            : 'This build is up to date with upstream — open for details';
  return {
    value: build.label,
    tone: due ? 'watch' : null,
    quiet: build.state === 'current' || build.state === 'unknown',
    title,
  };
}

function LocalRun({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const run = view.state.localRun;
  const live = run !== null && run.live;
  const number = run === null ? null : originIssueNumber(run.originRef);
  const stale = live && run.freshness !== null && run.freshness.behindTip !== null && run.freshness.behindTip > 0;
  const title = live
    ? `Goal #${String(number)} is running locally${run.url === null ? '' : ` on ${run.url}`}${stale ? ' · behind the branch tip' : ''} — open to stop it or swap goals`
    : run === null
      ? 'Nothing has been run locally — open to start a goal on this machine'
      : `Nothing is running locally; the last attempt ${run.status === 'failed' ? 'did not start' : 'was stopped'} — open for the reason`;
  return (
    <button
      type="button"
      className={`cn-sub cn-act ${live ? '' : 'cn-quiet'} ${stale ? 'cn-stale' : ''}`}
      onClick={() => actions.openPanel('localRun')}
      title={title}
      aria-label={title}
    >
      <span>Local</span>
      <b>{live && number !== null ? `#${String(number)}` : 'off'}</b>
    </button>
  );
}

const USAGE_STALE_MS = 10 * 60 * 1000;

interface UsageSlot {
  label: string;
  value: string;
  binds: boolean;
}

interface UsageReading {
  slots: UsageSlot[];
  cost: string | null;
  tone: 'quiet' | 'plain' | 'warn' | 'spent';
  title: string;
  age: string | null;
}

function resetIn(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / (24 * 60))}d`;
}

export function usageReading(usage: CockpitView['state']['usage'], now: number): UsageReading {
  const limits = usage.rateLimits;
  const five = limits?.fiveHour ?? null;
  const seven = limits?.sevenDay ?? null;

  if (limits === null || (five === null && seven === null)) {
    const { fiveHourCostUsd, sevenDayCostUsd } = usage.windows;
    return {
      slots: [],
      cost: fmtUsd(fiveHourCostUsd),
      tone: fiveHourCostUsd === 0 && sevenDayCostUsd === 0 ? 'quiet' : 'plain',
      title:
        'No subscriber usage windows have been reported — API-key auth, or no agent has taken a turn yet. ' +
        `Spent ${fmtUsd(fiveHourCostUsd)} in the last five hours, ${fmtUsd(sevenDayCostUsd)} over seven days.`,
      age: null,
    };
  }

  const weekBinds = five === null || (seven !== null && seven.usedPercentage > five.usedPercentage);
  const binding = weekBinds ? seven : five;
  const pct = (w: typeof five) => (w === null ? '—' : `${Math.round(w.usedPercentage)}%`);
  const bindingPct = binding === null ? 0 : Math.round(binding.usedPercentage);
  const other = weekBinds ? five : seven;

  return {
    slots: [
      { label: '5h', value: pct(five), binds: !weekBinds },
      { label: '7d', value: pct(seven), binds: weekBinds },
    ],
    cost: null,
    tone: bindingPct >= 90 ? 'spent' : bindingPct >= 75 ? 'warn' : bindingPct >= 25 ? 'plain' : 'quiet',
    title:
      `Claude account: ${weekBinds ? 'weekly' : 'five-hour'} window ${bindingPct}% used` +
      `${binding?.resetsAt == null ? '' : `, resets in ${resetIn(binding.resetsAt, now)}`}` +
      `${other === null ? '' : ` · ${weekBinds ? 'five-hour' : 'weekly'} ${Math.round(other.usedPercentage)}%`}. ` +
      `Read ${relTime(limits.capturedAt, now)} off an agent's turn — the windows keep moving while the fleet is idle.`,
    age: now - new Date(limits.capturedAt).getTime() >= USAGE_STALE_MS ? relTime(limits.capturedAt, now) : null,
  };
}

function Usage({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const reading = usageReading(view.state.usage, view.now);
  const tone = reading.tone === 'quiet' ? 'cn-quiet' : reading.tone === 'plain' ? '' : `cn-usage-${reading.tone}`;
  const stale = reading.age === null ? '' : 'cn-usage-old';
  const title = `${reading.title} Open for what spent it.`;
  return (
    <button
      type="button"
      className={`cn-sub cn-act ${tone} ${stale}`}
      onClick={() => actions.openInsights({ insightsView: 'economics', insightsWindow: 'session' })}
      title={title}
      aria-label={title}
    >
      {/* The chip's own name is gone — `62%` on this bar is the account, and nothing
          else here is a percentage — but each window keeps a two-character tag.
          Position alone was tried and is not enough: the pair is always five-hour
          then weekly, but an operator glancing at one number cannot tell which they
          landed on, and "which window is that" is the whole question the chip
          answers. The tag is the smallest thing that settles it — 9px, faint, and
          set as a superscript so it costs the strip no width. */}
      {reading.cost === null ? (
        <i className="cn-usage-pair">
          {reading.slots.map((slot, i) => (
            <i key={slot.label} className={`cn-usage-win ${slot.binds ? 'cn-binds' : ''}`}>
              {i > 0 && (
                <i className="cn-usage-sep" aria-hidden="true">
                  /
                </i>
              )}
              <b>{slot.value}</b>
              <em>{slot.label}</em>
            </i>
          ))}
        </i>
      ) : (
        <b>{reading.cost}</b>
      )}
      {/* A stale reading is said in the *weight*, not in a second figure beside the
          first. `11m ago` beside `62% / 30%` is three numbers where the chip has two
          measurements, and the one an operator does not want is the one that changes
          every minute. The sentence is still in the `title`. */}
    </button>
  );
}

function originIssueNumber(originRef: string): number | null {
  const m = /^issue:(\d+)$/.exec(originRef);
  return m ? Number(m[1]) : null;
}

interface MenuReading {
  value: string | null;
  tone: 'ill' | 'watch' | null;
  quiet: boolean;
  title: string;
}

interface MenuEntry extends MenuReading {
  key: string;
  icon: 'alert' | 'rocket' | 'download' | 'globe' | 'bolt' | 'book' | 'gear';
  label: string;
  pending?: boolean;
  onPick: () => void;
}

export function menuEntries(view: CockpitView, actions: CockpitActions, themeUnsaved = false): MenuEntry[] {
  const faults = view.state.errors.length;
  const queued = view.state.jobs.filter((job) => job.status === 'queued').length;
  const health = view.state.environmentHealth ?? [];
  const env = health.length === 0 ? null : environmentsReading(health, view.now);
  const build = buildReading(view);
  const signals = signalRows(view).length;
  return [
    {
      key: 'faults',
      icon: 'alert',
      label: 'Faults',
      value: `${faults}`,
      tone: faults === 0 ? null : 'ill',
      quiet: faults === 0,
      title: 'Recorded faults — open the fault log',
      onPick: () => actions.openPanel('faults'),
    },
    {
      key: 'launch',
      icon: 'rocket',
      label: 'Launch',
      value: `${queued}`,
      tone: null,
      quiet: queued === 0,
      title: 'Briefs waiting for a free slot — open the launch desk',
      onPick: () => actions.openPanel('launch'),
    },
    {
      key: 'build',
      icon: 'download',
      label: 'Build',
      value: build.value,
      tone: build.tone,
      quiet: build.quiet,
      title: build.title,
      onPick: () => actions.openPanel('build'),
    },
    ...(env === null
      ? []
      : [
          {
            key: 'env',
            icon: 'globe' as const,
            label: 'Env',
            value: env.value,
            tone: env.tone,
            quiet: env.quiet,
            title: env.title,
            onPick: () => actions.openPanel('environments'),
          },
        ]),
    {
      key: 'signals',
      icon: 'bolt',
      label: 'Signals',
      value: `${signals}`,
      tone: null,
      quiet: signals === 0,
      title: 'What the world did — the feed the queue is decided off',
      onPick: () => actions.openPanel('signals'),
    },
    {
      key: 'record',
      icon: 'book',
      label: 'Record',
      value: null,
      tone: null,
      quiet: false,
      title: 'What the harness did, after the world snapshot forgot it — operator jobs, and the goals it has worked',
      onPick: () => actions.openPanel('record'),
    },
    {
      key: 'config',
      icon: 'gear',
      label: 'Config',
      value: null,
      tone: null,
      quiet: false,
      pending: themeUnsaved,
      title: themeUnsaved
        ? 'Config — an unsaved theme edit is pending; a reload drops it'
        : 'Config — how this harness is configured',
      onPick: () => actions.openConfig({}),
    },
  ];
}

function BarMenu({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const [open, setOpen] = useState(false);
  const entries = menuEntries(view, actions, useThemeUnsaved());
  const flagged = entries.some((entry) => entry.tone !== null || entry.pending === true);
  const title = flagged
    ? 'More — something in here wants a look'
    : 'More — faults, launch, build, signals, record and config';
  return (
    <div
      className="cn-menu-wrap"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        className={`cn-read cn-act cn-icon ${flagged ? 'cn-menu-flag' : ''} ${open ? 'cn-on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        title={title}
        aria-label={title}
      >
        <Icon name="menu" size={15} />
      </button>
      {open && (
        <div className="cn-menu" role="menu">
          {entries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="menuitem"
              className={`cn-menu-row ${entry.quiet ? 'cn-quiet' : ''} ${entry.pending === true ? 'cn-pending' : ''} ${
                entry.tone === null ? '' : `cn-tone-${entry.tone}`
              }`}
              title={entry.title}
              onClick={() => {
                setOpen(false);
                entry.onPick();
              }}
            >
              <Icon name={entry.icon} size={14} />
              <span>{entry.label}</span>
              {entry.value !== null && <b>{entry.value}</b>}
              <i className="cn-chev">›</i>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopBar({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { state } = view;

  if (!view.connected) {
    return (
      <div className="cn-bar">
        <Ident view={view} />
        <div className="cn-read">
          <span>Link</span>
          <b>offline</b>
        </div>
        {/* The offline bar keeps them, and the socket being down is the moment they
            matter most: `Asks` falls back to the tracker's own form when it cannot
            compose, which is the whole reason that fallback exists. */}
        <div className="cn-reads">
          <Asks view={view} actions={actions} />
        </div>
      </div>
    );
  }

  return (
    <div className="cn-bar">
      <Ident view={view} />
      <div className="cn-sep" />

      <Nav view={view} actions={actions} />

      <div className="cn-sep" />

      {/* One gauge read left to right: what the fleet is allowed to do, and when it
          next gets to decide. The countdown is inside this reading rather than a chip
          of its own because Pause is the control that stops the thing it is counting
          down to — see {@link Scan}. */}
      <div className="cn-read cn-cap">
        <span>Fleet</span>
        <FleetControl live={view.live.length} cap={state.control.cap} paused={state.control.paused} />
        <Scan view={view} actions={actions} />
      </div>

      {/* Only when it has something to say — see {@link Environments}. */}
      <Environments view={view} actions={actions} />

      <div className="cn-reads">
        <Asks view={view} actions={actions} />
        {/* One pill, two readings. Both are gauges of *this machine and this
            account* rather than of the work — what the allowance has left, and
            whether anything is up locally — and each is two or three characters
            wide. Two boxes around six characters was more chrome than reading; one
            box with a rule down the middle is the same two ways-in at half the
            width. Each half still opens its own surface, which is why they are two
            buttons and not one. */}
        <div className="cn-read cn-pill">
          <Usage view={view} actions={actions} />
          <i className="cn-pill-sep" />
          <LocalRun view={view} actions={actions} />
        </div>
        {/* Everything that is not a gauge, behind one button. Usage and Local stay
            on the strip because each is a number that moves on its own and is
            glanced at; the six inside are counts that are usually zero and ways-in
            that are aimed at, and a strip carrying all eight wrapped to two rows on
            a laptop. See {@link menuEntries}. */}
        <BarMenu view={view} actions={actions} />
      </div>
    </div>
  );
}
