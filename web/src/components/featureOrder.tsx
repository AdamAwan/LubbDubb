import type { JSX } from 'react';
import { api } from '../api.js';
import type { CockpitView } from '../view/viewModel.js';
import { heldByAccepting, wavesOf } from '../view/sequence.js';
import type {
  FeatureChildRow,
  FeatureChildStanding,
  FeatureReportRow,
  FeatureRollup,
  FeatureSequence,
} from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { DesktopLink } from './DesktopLink.js';
import { HeadRow } from './panel.js';
import { Ref } from './refs.js';
import { Tag } from './tag.js';
import { relAge } from './util.js';

export function held(feature: FeatureRollup): FeatureSequence | null {
  return feature.sequence?.status === 'accepted' ? feature.sequence : null;
}

export function Sequence({
  feature,
  view,
  onAnswered,
}: {
  feature: FeatureRollup;
  view: CockpitView;
  onAnswered: () => void;
}): JSX.Element | null {
  const sequence = feature.sequence;
  if (sequence === null) return null;
  const open = feature.children.map((c) => c.number);
  const waves = wavesOf(open, sequence.edges);

  if (sequence.status !== 'proposed') {
    return <AnsweredSequence feature={feature} sequence={sequence} waves={waves} view={view} />;
  }

  const wouldHold = heldByAccepting(open, sequence.edges);
  return (
    <div className="cn-fb-seq">
      <h4>Proposed order</h4>
      <p className="cn-fb-seq-why">{sequence.reason}</p>
      {sequence.unsure !== null && (
        <p className="cn-fb-seq-unsure">
          <b>Least sure about</b> {sequence.unsure}
        </p>
      )}
      <div className="cn-fb-seq-waves">
        {waves.map((wave) => (
          <HeadRow key={wave.depth} align="baseline">
            <b>Wave {wave.depth + 1}</b>
            <span className="cn-refs">
              {wave.issues.map((n) => (
                <Ref key={n} to={`issue:${n}`} />
              ))}
            </span>
          </HeadRow>
        ))}
      </div>
      <Edges sequence={sequence} />
      {/* What accepting costs. Without it the operator is agreeing to a hold whose
          size is not on the card. */}
      <p className="cn-fb-quiet">
        {wouldHold === 0
          ? 'Accepting holds nothing right now — everything this order puts later is already settled or in flight.'
          : `Accepting holds ${wouldHold} of these ${open.length} stories until what they wait on has a branch.`}
      </p>
      <div className="cn-fb-seq-ctrls">
        <AsyncButton
          tone="primary"
          size="small"
          onClick={async () => {
            await api.answerFeatureSequence(feature.number, 'accepted', view.state.config.desktopFolder || 'you');
            onAnswered();
          }}
        >
          Accept
        </AsyncButton>
        <AsyncButton
          ghost
          size="small"
          onClick={async () => {
            await api.answerFeatureSequence(feature.number, 'declined', view.state.config.desktopFolder || 'you');
            onAnswered();
          }}
        >
          Run them all
        </AsyncButton>
        <Discuss feature={feature.number} folder={view.state.config.desktopFolder} />
      </div>
    </div>
  );
}

function AnsweredSequence({
  feature,
  sequence,
  waves,
  view,
}: {
  feature: FeatureRollup;
  sequence: FeatureSequence;
  waves: ReturnType<typeof wavesOf>;
  view: CockpitView;
}): JSX.Element {
  const folder = view.state.config.desktopFolder;
  const by = sequence.answeredBy === null || sequence.answeredBy === folder ? 'you' : sequence.answeredBy;
  const when = sequence.answeredAt === null ? '' : ` ${relAge(sequence.answeredAt, view.now)}`;
  return (
    <div className="cn-fb-seq-said">
      <p className="cn-fb-quiet">
        {sequence.status === 'accepted'
          ? `Order accepted by ${by}${when} — ${waves.length} wave${waves.length === 1 ? '' : 's'}.`
          : `${by === 'you' ? 'You' : by} said run them all${when} — the fleet will not propose an order again until this Feature gains or loses a story.`}
      </p>
      <Discuss feature={feature.number} folder={folder} />
      {sequence.status === 'accepted' && (
        <Order waves={waves} stories={feature.children} delivered={feature.briefing.delivered} now={view.now} />
      )}
    </div>
  );
}

const DONE: ReadonlySet<FeatureChildStanding> = new Set(['delivered', 'settled']);

function Order({
  waves,
  stories,
  delivered,
  now,
}: {
  waves: ReturnType<typeof wavesOf>;
  stories: readonly FeatureChildRow[];
  delivered: readonly FeatureReportRow[];
  now: number;
}): JSX.Element {
  return (
    <ol className="cn-fb-order">
      {waves.map((wave) => (
        <li key={wave.depth}>
          <span className="cn-fb-order-n">{wave.depth + 1}</span>
          <ul>
            {wave.issues.map((n) => {
              const story = stories.find((c) => c.number === n);
              const said = delivered.find((d) => d.number === n);
              return (
                <li key={n} className={story !== undefined && DONE.has(story.standing) ? 'cn-fb-order-done' : ''}>
                  <span className="cn-refs">
                    <Ref to={`issue:${n}`} />
                  </span>
                  <div className="cn-fb-order-body">
                    <span className="cn-fb-order-title">{story?.title ?? `#${n}`}</span>
                    {said !== undefined && (
                      <>
                        <span className="cn-fb-said">“{said.summary}”</span>
                        <span className="cn-fb-quiet">
                          — {said.by}, {relAge(said.at, now)}
                        </span>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function Discuss({ feature, folder }: { feature: number; folder: string }): JSX.Element | null {
  if (!folder) return null;
  return (
    <DesktopLink
      folder={folder}
      prompt={`Read the story order for feature #${feature} with sequence_read, then talk me through changing it.`}
      explain="so you can argue with the order and write it back with sequence_amend"
    />
  );
}

const EDGE_SOURCE: Record<FeatureSequence['edges'][number]['source'], string> = {
  link: 'tracker link',
  inferred: 'inferred',
  operator: 'yours',
};

function Edges({ sequence }: { sequence: FeatureSequence }): JSX.Element | null {
  if (sequence.edges.length === 0) {
    return <p className="cn-fb-quiet">No story waits on another — the sequencer found these independent.</p>;
  }
  return (
    <ul className="cn-fb-seq-edges">
      {sequence.edges.map((edge) => (
        <li key={`${edge.issue}>${edge.dependsOn}`}>
          <span className="cn-refs">
            <Ref to={`issue:${edge.issue}`} />
          </span>{' '}
          waits on{' '}
          <span className="cn-refs">
            <Ref to={`issue:${edge.dependsOn}`} />
          </span>
          <Tag>{EDGE_SOURCE[edge.source]}</Tag>
          {edge.reason !== null && <span className="cn-fb-seq-edge-why">{edge.reason}</span>}
        </li>
      ))}
    </ul>
  );
}
