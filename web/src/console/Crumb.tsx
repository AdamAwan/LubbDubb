import type { JSX } from 'react';

export interface CrumbStep {
  label: string;
  go: () => void;
}

export function Crumb({ trail, here }: { trail: readonly CrumbStep[]; here: string }): JSX.Element {
  return (
    <nav className="cn-crumb" aria-label="Breadcrumb">
      {/* The mark that says *out*, once, at the head — not on each rung. On every
          one it reads as a separator competing with the slash; on the last rung it
          would point out of the page you are on. */}
      <span className="cn-crumbback" aria-hidden="true">
        ‹
      </span>
      {trail.map((step) => (
        <span key={step.label} className="cn-crumbstep">
          <button type="button" onClick={step.go}>
            {step.label}
          </button>
          <span className="cn-crumbsep">/</span>
        </span>
      ))}
      <span className="cn-crumbnow">{here}</span>
    </nav>
  );
}
