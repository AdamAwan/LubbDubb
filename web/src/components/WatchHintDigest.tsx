import type { WatchHint } from '../types.js';
import { renderMarkdown } from './markdown.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md#the-watch-digest

export function WatchHintDigest({ hint, refUrls }: { hint: WatchHint | null; refUrls: Record<string, string> }) {
  if (hint === null) return null;
  return (
    <>
      <span className="pm-section-label">How we&rsquo;ll know it worked</span>
      {'none' in hint ? (
        <div className="pm-wrow">
          <div>
            <div className="pm-vhead">
              <span className="pm-vtitle">Nothing to watch</span>
            </div>
            <div className="pm-prose">{renderMarkdown(hint.none, refUrls)}</div>
          </div>
        </div>
      ) : (
        hint.intents.map((intent, i) => (
          <div className="pm-wrow" key={i}>
            <div>
              <div className="pm-vhead">
                <Tag>{intent.kind}</Tag>
                <Tag lower title="Where the planner expects to read it — a guess, binding nothing">
                  {intent.source}
                </Tag>
                <span className="pm-vtitle">{intent.says}</span>
              </div>
              {intent.why !== null && <div className="pm-wwhy">{renderMarkdown(intent.why, refUrls)}</div>}
            </div>
          </div>
        ))
      )}
    </>
  );
}
