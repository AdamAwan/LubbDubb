import type { Obstacle, ObstacleKey } from '../types.js';
import { reachesAgents } from './lifecycle.js';

// → docs/spec/27-obstacles.md

export interface DeliverableObstacle {
  obstacle: Obstacle;
  keys: readonly ObstacleKey[];
}

const MAX_OBSTACLE_CHARS = 1_400;

export function obstaclesForDispatch(input: {
  rows: readonly DeliverableObstacle[];
  scopes: readonly string[];
  paths: readonly string[];
}): DeliverableObstacle[] {
  const scopes = new Set(input.scopes);
  const paths = new Set(input.paths.map((path) => path.toLowerCase()));
  return input.rows.filter(
    (row) => reachesAgents(row.obstacle.state) && row.keys.some((key) => keyMatches(key, scopes, paths)),
  );
}

function keyMatches(key: ObstacleKey, scopes: ReadonlySet<string>, paths: ReadonlySet<string>): boolean {
  if (key.kind === 'check') return scopes.has(`check:${key.value}`);
  if (key.kind === 'test' || key.kind === 'path') return paths.has(fileHalf(key.value).toLowerCase());
  return false;
}

function fileHalf(value: string): string {
  return value.split(/[\s>#]|::/)[0] ?? value;
}

export function renderObstacleNote(rows: readonly DeliverableObstacle[]): string {
  if (rows.length === 0) return '';
  const header =
    `\n\n---\n\nWhat the fleet has already hit on the checks and files in front of you. Each of these was ` +
    `seen by **two independent voices**, so it is not your doing and not your task: do not go fixing one. ` +
    `Work around it, and say so in what you conclude. If you hit something that is *not* here, report it ` +
    `with \`raise\` — one call, and it answers with what everyone else saw.\n\n`;

  const lines: string[] = [];
  let used = header.length;
  let cut = rows.length;
  for (const [i, row] of rows.entries()) {
    const line = renderObstacle(row);
    if (used + line.length > MAX_OBSTACLE_CHARS) {
      cut = i;
      break;
    }
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return '';
  const dropped = rows.length - cut;
  const tail =
    dropped > 0
      ? `\n${dropped} further obstacle${dropped === 1 ? '' : 's'} on these checks and files ${
          dropped === 1 ? 'is' : 'are'
        } not shown.\n`
      : '';
  return header + lines.join('') + tail;
}

function renderObstacle(row: DeliverableObstacle): string {
  const claim = row.obstacle.what.replace(/\s+/g, ' ').trim();
  const keys = row.keys
    .filter((key) => key.kind === 'check' || key.kind === 'test' || key.kind === 'path')
    .map((key) => `\`${key.value}\``)
    .join(', ');
  const owner =
    row.obstacle.state === 'owned' && row.obstacle.ownerRef !== null
      ? ` — ${row.obstacle.ownerRef} owns it`
      : ' — nothing owns it yet';
  return `- ${claim}${keys === '' ? '' : ` (${keys})`}${owner}\n`;
}
