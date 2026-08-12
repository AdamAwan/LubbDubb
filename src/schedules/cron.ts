/**
 * The five-field cron expression, parsed and stepped — the whole of what a
 * recurrence is, as two pure functions over a string and a clock.
 *
 * **Written rather than depended on.** The syntax below is fixed by 40 years of
 * crontab and is a hundred lines to implement; a dependency for it would be a
 * supply-chain surface and a version to keep on the harness's one runtime for
 * something no upstream is going to change. What a library would buy — names
 * (`MON`), `@daily` aliases, seconds, timezone databases — is either refused here
 * on purpose or stated as the operator's own machine's clock.
 *
 * **Fields are read in the harness process's local timezone**, because that is
 * what an operator means by "every weekday at 09:00" — the machine the fleet runs
 * on is the one they are sitting at. The consequence is stated where it bites: a
 * daily 02:30 fires twice on the day a DST fallback repeats 02:30 only if the
 * schedule is otherwise due, and not at all on a spring-forward day that has no
 * 02:30 — the same behaviour the operator's own crontab has, and the reason
 * {@link nextCronRun} steps a real `Date` rather than doing arithmetic on epoch
 * milliseconds.
 */

/** A field's bounds and the word a refusal names it by, in expression order. */
const FIELDS = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day-of-month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12 },
  { label: 'day-of-week', min: 0, max: 7 },
] as const;

/** How far ahead {@link nextCronRun} will look before calling an expression unschedulable. */
const HORIZON_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/** A parsed expression: the values each field admits, plus which of the two day fields were restricted. */
interface CronExpression {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  /**
   * Whether each day field was narrowed from `*`. The two are OR'd when **both**
   * are restricted and AND'd otherwise — vixie cron's rule, which is what makes
   * `0 9 1 * 1` mean "the 1st, and every Monday" rather than "Mondays that are
   * the 1st". Recorded here because a set cannot say it came from a `*`: `*` for
   * day-of-week is `{0..6}`, which no longer looks unrestricted.
   */
  restrictedDom: boolean;
  restrictedDow: boolean;
}

/** What {@link parseCron} answers: the expression, or the one sentence saying what is wrong with it. */
type CronParse = { ok: true; cron: CronExpression } | { ok: false; error: string };

/**
 * Parse a five-field expression — `minute hour day-of-month month day-of-week`,
 * each field a star, a number, an `a-b` range, a `/n` step on either of those, or
 * a comma-separated list of them.
 *
 * A refusal is one sentence naming the field and what it accepts, because it is
 * shown verbatim to whoever typed the expression — the route hands it straight
 * back as its 400 and the cockpit prints it under the input. Names (`MON`, `JAN`),
 * `@daily` aliases and a seconds field are refused rather than half-supported: an
 * expression that parses to something other than what its author reads is worse
 * than one that will not parse at all.
 */
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
  // 7 and 0 are both Sunday, so the set the matcher asks is normalised once here
  // rather than at every lookup.
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

/**
 * The first minute strictly after `after` that the expression matches, or null
 * when it matches nothing within {@link HORIZON_MS} — `0 0 30 2 *`, the 30th of
 * February, is the shape that has no answer, and a null is how a schedule says so
 * rather than looping.
 *
 * Strictly after, so a schedule fired at exactly its due minute never picks the
 * same minute again and fires twice.
 *
 * The search steps a real `Date` in local time, skipping the largest unit that
 * cannot match — a whole month, a whole day, a whole hour — so an expression that
 * fires once a year costs a few hundred iterations rather than half a million.
 */
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
      // The 1st of the next month at 00:00. `setMonth(m + 1, 1)` before the time
      // is cleared, so a 31st never rolls into the month after the one we want.
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

/**
 * Vixie cron's day rule: with both day fields restricted the match is the
 * **union** of them, and with at most one restricted it is whichever one that is.
 * Stated once here because it is the one part of the syntax that surprises
 * everybody, and the surprise is silent — `0 9 1 * 1` firing four extra times a
 * month looks like a bug in the harness rather than a property of cron.
 */
function matchesDay(cron: CronExpression, at: Date): boolean {
  const dom = cron.daysOfMonth.has(at.getDate());
  const dow = cron.daysOfWeek.has(at.getDay());
  if (cron.restrictedDom && cron.restrictedDow) return dom || dow;
  if (cron.restrictedDom) return dom;
  if (cron.restrictedDow) return dow;
  return true;
}

/** Digits and nothing else — `Number('')` and `Number(' ')` are both 0, which is how `1,,2` parses as midnight. */
function isCount(text: string | undefined): text is string {
  return text !== undefined && /^\d+$/.test(text);
}

/** One field's admitted values, or the refusal naming it. */
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
    // `*` and `a-b` both denote a range; a bare number denotes itself, and pairing
    // it with a step (`5/2`) is refused rather than guessed at.
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

/** The one wording for a malformed field, so five fields cannot describe themselves five ways. */
function refusal(raw: string, field: (typeof FIELDS)[number]): string {
  return (
    `cron ${field.label} "${raw}" is not a number, a range, a step or a list — ` +
    `use ${field.min}-${field.max}, "*", "*/n", "a-b" or "a,b,c" (names like MON are not supported)`
  );
}
