import { Fragment, useState, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { AppliedFix, NeedGroup, NeedKind, NeedRow } from '../view/needsYou.js';
import type { SetupCheck, SetupFix } from '../types.js';
import { relTime } from '../components/util.js';
import { Ref, refLabel } from '../components/refs.js';

/** One word per kind, shared with the goal page so a row and the band it opens name the ask the same. */
export const KIND_LABEL: Record<NeedKind, string> = {
  config: 'Config',
  config_gap: 'Config gap',
  recovery: 'Recovery',
  escalation: 'Escalation',
  permission: 'Permission',
  plan: 'Plan',
  reply: 'Reply',
  merge: 'Merge',
  shortfall: 'Shortfall',
  intake: 'Intake',
  profile: 'Profile',
  placement: 'Backlog',
  bench: 'Bench',
  close_out: 'Close-out',
  validate: 'Validate',
  burn: 'Spend',
  limit: 'Usage limit',
  supply: 'Runway',
  dispatch: 'Refused',
  assigned: 'Assigned',
};

/**
 * The hue a kind wears, and it answers *what the ask is* — not who is stopped.
 *
 * Red is something wrong: a restart that orphaned runs, an agent that hit a
 * question it cannot get past. Amber is a gate rather than a fault — nothing
 * broke, something is simply waiting on a yes, an allowance window or a look at
 * the spend. Blue is informative: a plan, a profile, a piece of work only a
 * person can do, all of which want reading rather than repair. Green is the step
 * *after* a delivery — a goal landed and this is what follows it.
 *
 * **Who is stopped is weight, not hue** (see {@link Row}). The rail used to spend
 * its whole palette on that one bit, which left every ask on the bench reading as
 * an alarm; it is now carried by the solid/soft split within each hue, by the
 * `Blocking` sub-heading and by the sort order — three statements of it, none of
 * them costing the operator the ability to tell a delivered goal from a fault at
 * a glance.
 *
 * Total over {@link NeedKind}, like {@link KIND_LABEL}, so a new kind fails the
 * typecheck here rather than drawing in whatever the last rule in the sheet said.
 *
 * @public shared with the needs band, which dresses the same ask in the same tone
 */
export const KIND_TONE: Record<NeedKind, 'red' | 'amber' | 'blue' | 'green'> = {
  // Red for a harness that cannot work or is spending money it should not; amber
  // for one that works while something of the operator's own hides work from it.
  // Two kinds rather than a per-row tone, so this stays total — see `NeedKind`.
  config: 'red',
  config_gap: 'amber',
  recovery: 'red',
  escalation: 'red',
  permission: 'amber',
  // A plan and a shortfall are read: one proposes work, the other says work that
  // was done did not reach the goal, and both want judgement rather than a hand on
  // a switch. A drafted reply and a merge are the two that *send* something — a
  // gate on `permission`'s terms, where nothing is wrong and an act is waiting on a
  // yes — so they wear its hue rather than the plan's.
  plan: 'blue',
  reply: 'amber',
  merge: 'amber',
  shortfall: 'blue',
  // Blue on the profile gate's terms: the appraisal refused to say this goal is
  // workable, and what is waiting is a reading — the goal's own text against the
  // appraiser's sentence — rather than a repair. Red would file a goal whose brief
  // is unclear beside a restart that orphaned six runs, which is the one thing it
  // is not: nothing broke, and nothing is lost while it stands.
  intake: 'blue',
  profile: 'blue',
  // Amber on `config_gap`'s terms rather than blue on the profile gate's: nothing
  // is held and nothing failed, and what is wrong is that work the fleet is doing
  // correctly is hidden from whoever plans the backlog. Blue here would file it
  // with the questions that stop a dispatch, which is the one thing it never does.
  placement: 'amber',
  bench: 'blue',
  close_out: 'green',
  validate: 'green',
  burn: 'amber',
  limit: 'amber',
  // A gate rather than a fault, on `permission`'s terms: nothing broke, and an
  // empty queue is a fleet waiting on a decision only a person makes. Red here
  // would put "you have not queued anything up" beside "a restart orphaned four
  // runs", which is the reading the hue exists to keep apart.
  supply: 'amber',
  // Red on `config`'s terms and not `permission`'s: nothing here is waiting on a
  // yes. The harness has proposed this dispatch on every pulse and refused it on
  // every pulse, and it will go on doing that until somebody moves what is in the
  // way. That is something wrong, which is the only thing this hue says.
  dispatch: 'red',
  // Blue on the bench task's terms: nothing broke and nothing is waiting on a
  // yes — this is simply work only a person can do, and the only reason it is on
  // the rail is that no rule in the harness will ever pick it up. Amber would
  // file a colleague's request beside a gate the fleet is stopped at, which is
  // the one reading the hue keeps apart.
  assigned: 'blue',
};

/**
 * The glyph drawn before the word, a second reading of the same thing rather
 * than a replacement for it — the tag still spells the kind out, so a symbol
 * nobody has learnt yet costs nothing and needs no legend.
 *
 * Text-presentation BMP glyphs only. A character with an emoji variant (`✔`,
 * `☑`, `🏳`) is rendered by the platform's colour font on some machines and the
 * text font on others, which puts a full-colour sticker in a monospace tag on
 * exactly the operator's machine nobody tested on.
 *
 * @public shared with the needs band and the ask panel, which name the ask the same
 */
export const KIND_SYMBOL: Record<NeedKind, string> = {
  config: '\u2699',
  // A gear with a bite out of it rather than a second gear: the two kinds are one
  // subject at two severities, and the glyph is the one channel that has to tell
  // a fault this harness cannot work through from a gate it merely works around.
  config_gap: '\u2296',
  recovery: '\u21ba',
  escalation: '?',
  permission: '\u2298',
  plan: '\u25c7',
  // A return arrow for the reply and a circled plus for the merge: the two acts
  // that leave the harness, said as what they do to the pull request.
  reply: '\u21b5',
  merge: '\u2295',
  // The ballot X against `validate`'s tick, which is exactly the pair: one is a
  // goal's checks passing, the other is an assessment saying the goal was not
  // reached.
  shortfall: '\u2717',
  // A dotted circle against the profile gate's ringed dot: the two asks the same
  // appraisal leaves behind, one a proposal it made and the other a verdict it could
  // not reach.
  intake: '\u25cc',
  profile: '\u2299',
  // A box: where the item is filed, against the profile gate's ringed dot.
  placement: '\u25a3',
  bench: '\u25c6',
  close_out: '\u2691',
  validate: '\u2713',
  burn: '\u25b2',
  limit: '\u2016',
  // Against the burn notice's upward triangle deliberately: one is spend
  // climbing, the other is work draining, and they are the two readings a fleet
  // takes about itself rather than about a piece of work.
  supply: '\u25bd',
  // A crossed box: the squared family is where the harness's own plumbing sits
  // (`placement`'s filled box), and the cross is the refusal. Deliberately not
  // `permission`'s circled slash — that one is a gate somebody may open, and this
  // is a door the harness has already tried on every pulse.
  dispatch: '\u22a0',
  // An inbox tray: the one row that came from outside the harness entirely, and
  // the glyph says where from. Text-presentation, like every other entry here.
  assigned: '\u2913',
};

// The mockup's two railsub headings, in the order they're drawn — 'blocking'
// above 'yours' per the brief. Since the palette went to `NeedKind`, these two
// words are one of the three places the group is still stated; the others are
// the sort order and each row's own weight.
const GROUP_LABEL: Record<NeedGroup, string> = {
  blocking: 'Blocking',
  yours: 'Yours to do',
};
const GROUP_ORDER: NeedGroup[] = ['blocking', 'yours'];

/**
 * What a row is about, in one token: its goal (`#12`) when it has one, else the
 * pull request it was raised on (`PR #142`). Null only for an ask with neither,
 * which is the one case a surface has nothing true to name.
 *
 * Through `refLabel`, the one function that shortens a ref: this was written
 * three times over, and the fourth surface that wrote it printed a label with no
 * link attached to it.
 *
 * @public shared with the ask panel, which states the same subject in its header
 */
export function subjectLabel(row: NeedRow): string | null {
  if (row.goalRef !== null) return refLabel(row.goalRef);
  const pr = /^pr:(\d+)/.exec(row.originRef ?? '');
  return pr ? `PR #${pr[1]}` : null;
}

/**
 * The subject as the *rail* draws it, which is the subject only when the row's
 * own line has not already said it. `askLine` (`web/src/view/needsYou.ts`) names
 * the goal wherever the world still carries it, and a row that then repeated
 * `#395` under a line ending in `#395 · Snapshot downloads 401…` would spend a
 * second line on the one thing already read.
 *
 * It stays for the rows the line cannot name — a pull request no ticket owns, a
 * goal-shaped ref the world has dropped — because an ask whose subject a surface
 * cannot name is one the operator answers blind.
 */
function subjectBeside(row: NeedRow): string | null {
  const subject = subjectLabel(row);
  return subject !== null && row.title.includes(subject) ? null : subject;
}

/**
 * What the rail says about a run whose task the snapshot no longer carries.
 *
 * The row still has an agent — that is what makes it blocking — so the metadata
 * line has to say *something*, and the id is what it used to say: `agent_ab4sc`
 * is minted, means nothing to anybody, and reads as a name the operator ought to
 * recognise. A phrase is the honest reading of the same fact, and the drawer,
 * which is where an id is the subject, is still one click away through the row.
 */
const UNNAMED_RUN = 'a run with no task on record';

/**
 * What an ask is holding, worded once. The rail row and the band the row opens
 * both state it, and a count read twice in two sentences is a count the reader
 * has to check against itself.
 *
 * @public shared with GoalPage's needs band
 */
export function holdingLabel(holding: number): string {
  return `holding ${holding} ${holding === 1 ? 'part' : 'parts'}`;
}

/**
 * One row, wearing two readings at once: **hue is the kind** ({@link KIND_TONE}),
 * **weight is the group**. `group === 'blocking'` means an agent is parked on
 * this rather than merely queued for the operator, and it draws as `cn-parked` —
 * a full-strength stripe and a filled tag, against the softened stripe and
 * outlined tag of a row that is only the operator's to get to.
 *
 * The two are deliberately separate channels. Spending the whole palette on the
 * group is what made every ask on the bench read as an alarm, and a delivered
 * goal's close-out is not an alarm; spending it on the kind alone would drop the
 * one bit the rail is sorted by. Weight carries the second without taking the
 * first.
 *
 * `focus` is the goal the situation area is currently drawing, when it is drawing
 * one. A row about that goal is marked `aria-current` and every other row is
 * dimmed, so the rail says which of its asks are the ones on screen — the rest
 * stay legible and clickable, because muting is a reading aid and a rail that
 * hid rows would hide the fleet's other blockers.
 *
 * **Where a click goes is `row.opens`, never `row.goalRef`** — the derivation
 * decides it, because it is the only place that can tell a goal with a page from
 * a ref that merely looks like one. Only the recovery hold opens nothing, and it
 * renders as a `div` rather than a `button` so that every button on this rail
 * leads somewhere.
 */
function Row({
  row,
  now,
  focus,
  actions,
}: {
  row: NeedRow;
  now: number;
  focus: string | null;
  actions: CockpitActions;
}): JSX.Element {
  const parked = row.group === 'blocking';
  const current = focus !== null && row.goalRef === focus;
  // The recovery hold is never dimmed: while it stands no pulse runs at all, so
  // it is not another goal's business — it is everyone's, including this one's.
  const dim = focus !== null && !current && row.kind !== 'recovery';
  const cls = ['cn-q', `cn-t-${KIND_TONE[row.kind]}`, parked ? 'cn-parked' : '', dim ? 'cn-dim' : '']
    .filter((c) => c !== '')
    .join(' ');
  const goal = subjectBeside(row);
  // The row's own contents, split out from the card so the two shapes below can
  // share them: a plain row is one button, and a row carrying a reference is a
  // container whose *body* is the button.
  const body = (
    <>
      <div className="cn-qkind">
        <i className="cn-tag">
          {/* Hidden from the reading order on purpose: the word beside it is
                the label, and a screen reader announcing "black diamond bench"
                is worse than one announcing "bench". */}
          <span className="cn-sym" aria-hidden="true">
            {KIND_SYMBOL[row.kind]}
          </span>
          {KIND_LABEL[row.kind]}
        </i>
        {row.raisedAt !== '' && <i className="cn-qage">{relTime(row.raisedAt, now)}</i>}
      </div>
      <p className="cn-qtitle">{row.title}</p>
      <div className="cn-qmeta">
        {row.note !== undefined && <span>{row.note}</span>}
        {row.note !== undefined && (row.agentId !== null || goal !== null) && <span>·</span>}
        {row.agentId !== null && <span>{row.agentLabel ?? UNNAMED_RUN}</span>}
        {row.agentId !== null && goal !== null && <span>·</span>}
        {goal !== null && <span>{goal}</span>}
        {row.holding > 0 && <span className="cn-hold">{holdingLabel(row.holding)}</span>}
      </div>
    </>
  );
  const inner = (
    <>
      <i className="cn-stripe" />
      <div className="cn-qin">{body}</div>
    </>
  );

  if (row.opens === null) {
    return <div className={cls}>{inner}</div>;
  }

  // A config row carries a fix, and a control may not nest inside a control: one
  // click cannot have two destinations. So the card becomes a container, its body
  // stays the button that opens the key on the config page, and the fix sits in a
  // strip of its own beneath it — the same shape a row carrying both a name and
  // refs already takes.
  if (row.check !== undefined) {
    const fix = row.check.fix;
    const group = fix?.kind === 'config' ? fix.group : fix?.kind === 'goto' ? fix.group : undefined;
    return (
      <div className={cls}>
        <i className="cn-stripe" />
        <button
          type="button"
          className="cn-qbody"
          onClick={() => actions.openConfig({ configTab: 'values', configGroup: group ?? null })}
        >
          <div className="cn-qin">
            <div className="cn-qkind">
              <i className="cn-tag">
                <span className="cn-sym" aria-hidden="true">
                  {KIND_SYMBOL[row.kind]}
                </span>
                {KIND_LABEL[row.kind]}
              </i>
            </div>
            <p className="cn-qtitle">{row.title}</p>
            {row.check.remedy !== undefined && <div className="cn-qmeta">{row.check.remedy}</div>}
          </div>
        </button>
        <i className="cn-stripe" />
        {row.applied === undefined ? (
          <ConfigFix check={row.check} actions={actions} />
        ) : (
          <SettledFix applied={row.applied} actions={actions} />
        )}
      </div>
    );
  }

  const ref = row.goalRef;
  const open =
    row.opens === 'goal' && ref !== null ? () => actions.selectGoal(ref) : () => actions.openPanel({ ask: row.id });

  // A pull request a person put on you is the one ask whose subject lives outside
  // the cockpit entirely — there is no PR page here, so a row that only *named*
  // the pull request left the operator to go and find it in the provider, which
  // is the surface this queue exists to replace. So the card carries the way
  // there, and it sits **beside** the body rather than in it: one click cannot
  // have two destinations, so the body stays the control that opens the ask and
  // the reference is its own target. Same shape as a config row's fix strip.
  const prRef = row.kind === 'assigned' ? row.originRef : null;
  if (prRef !== null) {
    return (
      <div className={`${cls} cn-qref`}>
        <i className="cn-stripe" />
        <button type="button" className="cn-qbody" onClick={open} aria-current={current ? 'true' : undefined}>
          <div className="cn-qin">{body}</div>
        </button>
        <span className="cn-refs">
          <Ref to={prRef} label={`PR ${refLabel(prRef)}`} />
        </span>
      </div>
    );
  }

  return (
    <button type="button" className={cls} onClick={open} aria-current={current ? 'true' : undefined}>
      {inner}
    </button>
  );
}

/**
 * The control strip under a config row — the whole of "offer to fix it for me".
 *
 * Which control is drawn is the check's own `fix`, and the three kinds are three
 * honest positions ({@link SetupFix}): the harness writes it, the operator decides
 * it somewhere that already exists, or it is outside the harness entirely and gets
 * copied. **A `shell` command is never run**: these are the credential and billing
 * checks, and a button here that executed a shell string would put arbitrary
 * execution behind the most sensitive reading the cockpit draws.
 *
 * A `config` fix whose value is `assumed` rather than `confirmed` draws the value
 * in an editable field first. That is the answer to "what if the suggestion is
 * wrong": the values that could be wrong never get the one-click button, and the
 * one that can be wrong most expensively — `userId`, which gates pickup — is
 * resolved against the credential before anything offers to write it.
 */
function ConfigFix({ check, actions }: { check: SetupCheck; actions: CockpitActions }): JSX.Element | null {
  const fix: SetupFix | undefined = check.fix;
  const [value, setValue] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  if (fix === undefined) return null;

  if (fix.kind === 'shell') {
    return (
      <div className="cn-fix">
        <div className="cn-shell">
          <span aria-hidden="true">$</span>
          <code>{fix.command}</code>
          <button
            type="button"
            className={copied ? 'cn-copy cn-copied' : 'cn-copy'}
            onClick={() => {
              void navigator.clipboard?.writeText(fix.command).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : fix.label}
          </button>
        </div>
        <span className="cn-fixwhy">{fix.why}</span>
      </div>
    );
  }

  if (fix.kind === 'sheet') {
    return (
      <div className="cn-fix">
        <button type="button" className="cn-btn cn-primary" onClick={() => actions.openPanel('setup')}>
          {fix.label}
        </button>
        {check.remedy !== undefined && <span className="cn-fixwhy">{check.remedy}</span>}
      </div>
    );
  }

  if (fix.kind === 'goto') {
    return (
      <div className="cn-fix">
        <button
          type="button"
          className="cn-btn cn-primary"
          onClick={() =>
            fix.to === 'tickets'
              ? actions.openTab('tickets')
              : // The Prompts tab for an override question, the values page for
                // everything else: a fix that opened the wrong screen is the
                // failure this rail was rebuilt around.
                actions.openConfig({
                  configTab: fix.to === 'prompts' ? 'prompts' : 'values',
                  configGroup: fix.group ?? null,
                })
          }
        >
          {fix.label}
        </button>
      </div>
    );
  }

  const paths = Object.keys(fix.set);
  const only = paths[0];
  // Editable only where there is one value to edit and it is a guess. A fix
  // writing several keys is the confirm sheet's business, not a text box's.
  const editable = fix.confidence === 'assumed' && paths.length === 1 && only !== undefined;
  const typed = value ?? (editable ? String(fix.set[only as string]) : '');
  const write = (): void => {
    setBusy(true);
    const set = editable ? { [only as string]: coerce(typed, fix.set[only as string]) } : fix.set;
    void actions.applyConfigFix(check.id, set).finally(() => setBusy(false));
  };

  return (
    <div className="cn-fix">
      {editable ? (
        <div className="cn-fixline">
          <label className="cn-fixedit">
            Set <code>{only}</code> to
            <input className="cn-inline" value={typed} onChange={(e) => setValue(e.target.value)} aria-label={only} />
          </label>
          <button type="button" className="cn-btn" disabled={busy} onClick={write}>
            Write it
          </button>
        </div>
      ) : (
        <button type="button" className="cn-btn cn-primary" disabled={busy} onClick={write}>
          {fix.label}
        </button>
      )}
      {check.remedy !== undefined && !editable && <span className="cn-fixwhy">{check.remedy}</span>}
    </div>
  );
}

/**
 * The typed value behind an edited field. The field is text, the key is not: a
 * boolean written as `"false"` is a truthy string, and the config loader would
 * take it — so the shape of the value the check proposed decides how the operator's
 * edit is read back.
 */
function coerce(text: string, like: unknown): unknown {
  if (typeof like === 'boolean') return text === 'true';
  if (typeof like === 'number') return Number(text);
  return text;
}

/** The strip a fixed row wears until it is dismissed — what was written, and the way back. */
function SettledFix({ applied, actions }: { applied: AppliedFix; actions: CockpitActions }): JSX.Element {
  return (
    <div className="cn-fix cn-settled">
      <span className="cn-settled-what">
        <b>{applied.summary}</b>
        <i className="cn-settled-file">→ {applied.file}</i>
      </span>
      <button type="button" className="cn-btn" onClick={() => void actions.undoConfigFix(applied.checkId)}>
        Undo
      </button>
      <button type="button" className="cn-btn" onClick={() => actions.dismissConfigFix(applied.checkId)}>
        Dismiss
      </button>
    </div>
  );
}

/**
 * The merged rail: every kind `needsYou` carries, in the order the view model
 * already sorted them — recovery first, blocking before yours, most-holding
 * first, oldest first. This component only groups by `NeedGroup` for the
 * sub-headings; it never re-sorts, so the rail and the derivation stay one
 * reading.
 *
 * Renders even at zero rows (`cn-rail-empty`) — a rail that vanishes when
 * quiet is indistinguishable from one that broke.
 *
 * The focus is `goalPage`'s ref rather than `selectedGoal`, because a selected
 * ref the world does not carry draws no page: highlighting against it would mute
 * the whole rail in favour of a goal that is not on screen.
 */
export function QueueRail({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const rows = view.needsYou;
  const focus = view.goalPage === null ? null : `issue:${view.goalPage.issue.number}`;
  const sections = GROUP_ORDER.map((group) => ({ group, rows: rows.filter((r) => r.group === group) })).filter(
    (s) => s.rows.length > 0,
  );

  return (
    <>
      <div className="cn-rail-head">
        <h2>Needs you</h2>
        {rows.length > 0 && <i className="cn-count">{rows.length}</i>}
      </div>
      <div className="cn-rail-list">
        {rows.length === 0 ? (
          <p className="cn-rail-empty">Nothing is waiting on you</p>
        ) : (
          sections.map((section) => (
            <Fragment key={section.group}>
              <div className="cn-railsub">{GROUP_LABEL[section.group]}</div>
              {section.rows.map((row) => (
                <Row key={row.id} row={row} now={view.now} focus={focus} actions={actions} />
              ))}
            </Fragment>
          ))
        )}
      </div>
    </>
  );
}
