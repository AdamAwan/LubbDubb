import type { JSX } from 'react';

// → docs/spec/17-cockpit.md#the-ident

const BEAT = '34,80 46,80 51,71 57,89 62,80 70,80 73,76 76,84 79,80 86,80';
const FLAT = '34,80 86,80';

export function Logo({ alive }: { alive: boolean }): JSX.Element {
  return (
    <svg
      className={alive ? 'cn-logo cn-logo-alive' : 'cn-logo'}
      viewBox="0 0 120 120"
      width={26}
      height={26}
      aria-hidden="true"
    >
      <rect className="cn-logo-mark" x="12" y="56" width="10" height="20" rx="4" />
      <rect className="cn-logo-mark" x="98" y="56" width="10" height="20" rx="4" />
      <line className="cn-logo-stalk" x1="60" y1="34" x2="60" y2="22" />
      <circle className="cn-logo-mark cn-logo-lamp" cx="60" cy="18" r="6" />
      <rect className="cn-logo-head" x="20" y="34" width="80" height="64" rx="18" />
      <circle className="cn-logo-eye" cx="44" cy="58" r="7" />
      <circle className="cn-logo-eye" cx="76" cy="58" r="7" />
      <polyline className="cn-logo-trace" points={alive ? BEAT : FLAT} />
      {alive && <polyline className="cn-logo-trace cn-logo-pulse" points={BEAT} />}
    </svg>
  );
}
