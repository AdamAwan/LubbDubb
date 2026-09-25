import { useRef, useState, type JSX, type RefObject } from 'react';

interface Tip {
  x: number;
  y: number;
  lines: string[];
  at: string | null;
}

export type ShowTip = (e: { clientX: number; clientY: number }, lines: string[], at: string | null) => void;

export function useTip(): {
  tip: Tip | null;
  show: ShowTip;
  hide: () => void;
  wrap: RefObject<HTMLDivElement>;
} {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (e: { clientX: number; clientY: number }, lines: string[], at: string | null): void => {
    const box = wrap.current?.getBoundingClientRect();
    if (box === undefined) return;
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, lines, at });
  };
  return { tip, show, hide: () => setTip(null), wrap };
}

export function TipLayer({ tip }: { tip: Tip | null }): JSX.Element | null {
  if (tip === null) return null;
  return (
    <div className="al-tip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }} role="status">
      {tip.lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}

export function showOn(el: HTMLElement, lines: string[], show: ShowTip): void {
  const box = el.getBoundingClientRect();
  show({ clientX: box.left + box.width / 2, clientY: box.top }, lines, null);
}

export function fmtPoints(points: number): string {
  return `${points < 0.05 && points > 0 ? '<0.1' : points.toFixed(1)}%`;
}
