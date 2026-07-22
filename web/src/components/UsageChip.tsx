import type { UsageSnapshot } from '../types.js';
import { fmtUsd, relTime } from './util.js';

/**
 * Topbar Claude-usage chip (issue #60). Prefers the real subscriber limits when
 * the PTY status-line capture has seen any ("5h 62% · wk 30%", reset times in
 * the tooltip); otherwise falls back to the self-computed rolling cost windows
 * from stream-mode turn reports. Renders nothing until there is data.
 */
export function UsageChip({ usage, now }: { usage: UsageSnapshot; now: number }) {
  const rl = usage.rateLimits;
  if (rl && (rl.fiveHour || rl.sevenDay)) {
    const worst = Math.max(rl.fiveHour?.usedPercentage ?? 0, rl.sevenDay?.usedPercentage ?? 0);
    const tone = worst >= 95 ? ' bad' : worst >= 80 ? ' warn' : '';
    const parts = [
      rl.fiveHour && `5h ${Math.round(rl.fiveHour.usedPercentage)}%`,
      rl.sevenDay && `wk ${Math.round(rl.sevenDay.usedPercentage)}%`,
    ].filter(Boolean);
    const title = [
      rl.fiveHour?.resetsAt && `5h window resets ${clock(rl.fiveHour.resetsAt)}`,
      rl.sevenDay?.resetsAt && `weekly window resets ${clock(rl.sevenDay.resetsAt)}`,
      `captured ${relTime(rl.capturedAt, now)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <span className={`chip${tone}`} title={title}>
        claude {parts.join(' · ')}
      </span>
    );
  }
  const { fiveHourCostUsd, sevenDayCostUsd } = usage.windows;
  if (fiveHourCostUsd <= 0 && sevenDayCostUsd <= 0) return null;
  return (
    <span className="chip" title="Agent spend summed over the rolling window (from per-turn usage reports)">
      claude {fmtUsd(fiveHourCostUsd)} 5h · {fmtUsd(sevenDayCostUsd)} 7d
    </span>
  );
}

/** Local wall-clock time for a reset instant, e.g. "14:20". */
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
