// → docs/spec/08-planning.md

const FIELDS = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day-of-month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12 },
  { label: 'day-of-week', min: 0, max: 7 },
] as const;

const HORIZON_MS = 5 * 365 * 24 * 60 * 60 * 1000;

interface CronExpression {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  restrictedDom: boolean;
  restrictedDow: boolean;
}

type CronParse = { ok: true; cron: CronExpression } | { ok: false; error: string };

export function parseCron(expr: string): CronParse {
  const parts = expr.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5)
    return {
      ok: false,
      error: `a cron expression has five fields — minute hour day-of-month month day-of-week (got ${parts.length})`,
    };
  const sets: Set<number>[] = [];
  for (const [i, field] of FIELDS.entries()) {
    const parsed = parseField(parts[i]!, field);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    sets.push(parsed.values);
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (daysOfWeek.delete(7)) daysOfWeek.add(0);
  return {
    ok: true,
    cron: {
      minutes,
      hours,
      daysOfMonth,
      months,
      daysOfWeek,
      restrictedDom: parts[2] !== '*',
      restrictedDow: parts[4] !== '*',
    },
  };
}

export function nextCronRun(expr: string, after: Date): Date | null {
  const parsed = parseCron(expr);
  if (!parsed.ok) return null;
  const cron = parsed.cron;
  const at = new Date(after.getTime());
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  const horizon = after.getTime() + HORIZON_MS;
  while (at.getTime() <= horizon) {
    if (!cron.months.has(at.getMonth() + 1)) {
      at.setMonth(at.getMonth() + 1, 1);
      at.setHours(0, 0, 0, 0);
      continue;
    }
    if (!matchesDay(cron, at)) {
      at.setDate(at.getDate() + 1);
      at.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.has(at.getHours())) {
      at.setHours(at.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.has(at.getMinutes())) {
      at.setMinutes(at.getMinutes() + 1, 0, 0);
      continue;
    }
    return at;
  }
  return null;
}

function matchesDay(cron: CronExpression, at: Date): boolean {
  const dom = cron.daysOfMonth.has(at.getDate());
  const dow = cron.daysOfWeek.has(at.getDay());
  if (cron.restrictedDom && cron.restrictedDow) return dom || dow;
  if (cron.restrictedDom) return dom;
  if (cron.restrictedDow) return dow;
  return true;
}

function isCount(text: string | undefined): text is string {
  return text !== undefined && /^\d+$/.test(text);
}

function parseField(raw: string, field: (typeof FIELDS)[number]): { values: Set<number> } | { error: string } {
  const bad = { error: refusal(raw, field) };
  const values = new Set<number>();
  for (const item of raw.split(',')) {
    const [spec, stepText, ...rest] = item.split('/');
    if (rest.length > 0 || !spec) return bad;
    let step = 1;
    if (stepText !== undefined) {
      if (!isCount(stepText) || Number(stepText) < 1) return bad;
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (spec === '*') {
      from = field.min;
      to = field.max;
    } else {
      const [lowText, highText, ...extra] = spec.split('-');
      if (extra.length > 0 || !isCount(lowText)) return bad;
      if (highText === undefined ? stepText !== undefined : !isCount(highText)) return bad;
      from = Number(lowText);
      to = highText === undefined ? from : Number(highText);
      if (from < field.min || to > field.max || from > to)
        return { error: `cron ${field.label} must be between ${field.min} and ${field.max} (got "${raw}")` };
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values };
}

function refusal(raw: string, field: (typeof FIELDS)[number]): string {
  return (
    `cron ${field.label} "${raw}" is not a number, a range, a step or a list — ` +
    `use ${field.min}-${field.max}, "*", "*/n", "a-b" or "a,b,c" (names like MON are not supported)`
  );
}
