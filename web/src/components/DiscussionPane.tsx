import { useEffect, useState, type JSX } from 'react';
import { api } from '../api.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { discussionPrompt } from '../cockpit/desktopLink.js';
import { DISCUSSION_KINDS, DISCUSSION_STATES } from '../cockpit/place.js';
import type { CockpitView } from '../view/viewModel.js';
import type {
  AppState,
  DiscussionEntry,
  DiscussionEntryState,
  DiscussionKind,
  DiscussionNeighbour,
  DiscussionReading,
} from '../types.js';
import { BareLink, Button } from './button.js';
import { DesktopLink } from './DesktopLink.js';
import { renderMarkdown } from './markdown.js';
import { Ref } from './refs.js';
import { Tag, type TagTone } from './tag.js';

// → docs/spec/40-discussions.md#in-the-cockpit

const KIND: Record<DiscussionKind, { label: string; tone: TagTone }> = {
  note: { label: 'Note', tone: 'grey' },
  idea: { label: 'Idea', tone: 'blue' },
  question: { label: 'Question', tone: 'amber' },
  decision: { label: 'Decision', tone: 'green' },
};

const STATE_TONE: Record<DiscussionEntryState, TagTone> = {
  open: 'amber',
  answered: 'green',
  accepted: 'green',
  parked: 'grey',
  dropped: 'grey',
};

function useDiscussion(number: number, state: AppState): { reading: DiscussionReading | null; failed: boolean } {
  const [reading, setReading] = useState<DiscussionReading | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void api
      .getDiscussion(number)
      .then((answer) => {
        if (!live) return;
        setReading(answer);
        setFailed(false);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [number, state]);
  return { reading: reading?.number === number ? reading : null, failed };
}

export function DiscussionPane({
  number,
  view,
  actions,
}: {
  number: number;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { reading, failed } = useDiscussion(number, view.state);
  if (reading === null) {
    return (
      <section className="cn-card cn-disc">
        <p className="muted">{failed ? 'The discussion could not be read.' : 'Reading the discussion…'}</p>
      </section>
    );
  }
  if (!reading.enabled) {
    return (
      <section className="cn-card cn-disc">
        <h3>Discussion</h3>
        <p className="muted">
          Discussions are off on this deployment. Set <code>discussionsDir</code> in <code>lubbdubb.config.json</code>{' '}
          to a folder — inside an Obsidian vault if you like — and this tab shows the notes, ideas, questions and
          decisions kept for each story and feature.
        </p>
      </section>
    );
  }
  const shown = reading.entries.filter(
    (e) =>
      (view.discussionKind === null || e.kind === view.discussionKind) &&
      (view.discussionState === null || e.state === view.discussionState),
  );
  const open = reading.entries.filter((e) => e.kind === 'question' && e.state === 'open').length;
  return (
    <section className="cn-card cn-disc">
      <h3>
        Discussion
        <i className="cn-n">
          {reading.entries.length === 0
            ? 'nothing written yet'
            : `${reading.entries.length} ${reading.entries.length === 1 ? 'entry' : 'entries'}`}
          {open > 0 && ` · ${open} open ${open === 1 ? 'question' : 'questions'}`}
        </i>
        <FileLink reading={reading} />
        <DesktopLink
          usage="discussion.open"
          folder={view.state.config.desktopFolder}
          prompt={discussionPrompt(number)}
          label="Discuss in Claude"
          ready="ready for what is on your mind"
          explain="which reads this discussion first, talks it through with you, and writes down only what you agree."
        />
      </h3>
      {reading.related.length > 0 && <Related related={reading.related} refUrls={view.state.refUrls} />}
      {reading.entries.length > 0 && <Filters view={view} actions={actions} />}
      {reading.entries.length === 0 ? (
        <p className="muted">
          No file for #{number} yet. Discussing it in Claude writes one; so does an agent that adds a note or a
          question.
        </p>
      ) : shown.length === 0 ? (
        <p className="muted">Nothing here matches the filters.</p>
      ) : (
        <ol className="cn-disc-list">
          {shown.map((entry, i) => (
            <Entry key={entry.id ?? `${i}:${entry.heading}`} entry={entry} refUrls={view.state.refUrls} />
          ))}
        </ol>
      )}
    </section>
  );
}

function FileLink({ reading }: { reading: DiscussionReading }): JSX.Element | null {
  if (reading.path === null) return null;
  if (reading.obsidianUrl !== null) {
    return (
      <BareLink usage="discussion.open" className="cn-linkish" href={reading.obsidianUrl} title={reading.path}>
        Open file in Obsidian ↗
      </BareLink>
    );
  }
  return (
    <code className="cn-disc-path" title="The discussion file — open it in any editor">
      {reading.path}
    </code>
  );
}

function Filters({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  return (
    <div className="cn-disc-filters">
      <span role="group" aria-label="Kind">
        <FilterButton
          pressed={view.discussionKind === null}
          onClick={() => actions.filterDiscussion({ discussionKind: null })}
        >
          Every kind
        </FilterButton>
        {DISCUSSION_KINDS.map((kind) => (
          <FilterButton
            key={kind}
            pressed={view.discussionKind === kind}
            onClick={() => actions.filterDiscussion({ discussionKind: kind })}
          >
            {KIND[kind].label}
          </FilterButton>
        ))}
      </span>
      <span role="group" aria-label="State">
        <FilterButton
          pressed={view.discussionState === null}
          onClick={() => actions.filterDiscussion({ discussionState: null })}
        >
          Any state
        </FilterButton>
        {DISCUSSION_STATES.map((state) => (
          <FilterButton
            key={state}
            pressed={view.discussionState === state}
            onClick={() => actions.filterDiscussion({ discussionState: state })}
          >
            {state}
          </FilterButton>
        ))}
      </span>
    </div>
  );
}

function FilterButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: string;
}): JSX.Element {
  return (
    <Button
      ghost={!pressed}
      size="small"
      usage="discussion.filter"
      logs={!pressed}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function Entry({ entry, refUrls }: { entry: DiscussionEntry; refUrls: Record<string, string> }): JSX.Element {
  const openQuestion = entry.kind === 'question' && entry.state === 'open';
  return (
    <li className={`cn-disc-entry${openQuestion ? ' cn-disc-open' : ''}`}>
      <div className="cn-disc-meta">
        <Tag tone={KIND[entry.kind].tone}>{KIND[entry.kind].label}</Tag>
        {entry.state !== null && (
          <Tag tone={STATE_TONE[entry.state]} fill={openQuestion}>
            {entry.state}
          </Tag>
        )}
        {entry.unreadable && (
          <Tag tone="red" dashed title={`The heading "${entry.heading}" could not be read, so it is shown as a note`}>
            couldn’t read
          </Tag>
        )}
        {entry.date !== null && <span>{entry.date}</span>}
        {entry.author !== null && <span>{entry.author}</span>}
        {entry.supersedes.length > 0 && <span>supersedes {entry.supersedes.map((id) => `^${id}`).join(', ')}</span>}
        {entry.id !== null && <code className="cn-disc-id">^{entry.id}</code>}
      </div>
      {entry.body.trim() !== '' && <div className="cn-disc-body">{renderMarkdown(entry.body, refUrls)}</div>}
      {entry.answer !== null && (
        <div className="cn-disc-answer">
          <b>Answer</b>
          {renderMarkdown(entry.answer, refUrls)}
        </div>
      )}
    </li>
  );
}

function Related({
  related,
  refUrls,
}: {
  related: readonly DiscussionNeighbour[];
  refUrls: Record<string, string>;
}): JSX.Element {
  return (
    <div className="cn-disc-related">
      {related.map((n) => (
        <div key={n.number} className="cn-disc-near">
          <h4>
            {n.kind === 'feature' ? 'From its Feature' : 'From a story under it'}
            <span className="cn-refs">
              <Ref to={`issue:${n.number}`} />
            </span>
            {n.title !== null && <span className="muted">{n.title}</span>}
          </h4>
          <ol className="cn-disc-list">
            {[...n.standingDecisions, ...n.openQuestions].map((entry, i) => (
              <Entry key={entry.id ?? `${i}:${entry.heading}`} entry={entry} refUrls={refUrls} />
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
