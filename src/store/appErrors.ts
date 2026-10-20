import type { AppErrorDay, AppErrorGroup, AppErrorRead, AppErrorReadStatus } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md, docs/spec/39-app-errors.md

interface GroupInput {
  group: Omit<AppErrorGroup, 'daily'>;
  days: AppErrorDay[];
}

interface ReadInput {
  environment: string;
  at: string;
  status: AppErrorReadStatus;
  detail: string | null;
  deployedSha: string | null;
  previousSha: string | null;
  deployedAt: string | null;
}

export class AppErrorStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * One read, written whole: the reading row, every group it named and their day counts, and the
   * prune. `okAt` moves only on an `ok` read, because it is what the next read's `{since}` is bounded by.
   */
  recordRead(read: ReadInput, groups: GroupInput[], prune: { dayBefore: string; seenBefore: string }): void {
    this.ctx.db.transaction(() => {
      this.ctx
        .prep(
          `INSERT INTO app_error_reads
             (environment, status, detail, read_at, ok_at, deployed_sha, previous_sha, deployed_at)
           VALUES (@environment, @status, @detail, @at, @okAt, @deployedSha, @previousSha, @deployedAt)
           ON CONFLICT(environment) DO UPDATE SET
             status=excluded.status, detail=excluded.detail, read_at=excluded.read_at,
             ok_at=ifnull(excluded.ok_at, app_error_reads.ok_at),
             deployed_sha=excluded.deployed_sha, previous_sha=excluded.previous_sha, deployed_at=excluded.deployed_at`,
        )
        .run({ ...read, okAt: read.status === 'ok' ? read.at : null });
      for (const { group, days } of groups) {
        this.ctx
          .prep(
            `INSERT OR REPLACE INTO app_error_groups
               (environment, fingerprint, title, operation, version, frames, url,
                first_seen, last_seen, returned_at, recorded_at)
             VALUES (@environment, @fingerprint, @title, @operation, @version, @frames, @url,
                @firstSeen, @lastSeen, @returnedAt, @recordedAt)`,
          )
          .run({ ...group, frames: JSON.stringify(group.frames) });
        for (const { day, count } of days)
          this.ctx
            .prep(
              `INSERT INTO app_error_days (environment, fingerprint, day, count)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(environment, fingerprint, day) DO UPDATE SET count = count + excluded.count`,
            )
            .run(group.environment, group.fingerprint, day, count);
      }
      this.ctx.prep(`DELETE FROM app_error_days WHERE day < ?`).run(prune.dayBefore);
      this.ctx.prep(`DELETE FROM app_error_groups WHERE last_seen < ?`).run(prune.seenBefore);
      this.ctx
        .prep(
          `DELETE FROM app_error_days WHERE NOT EXISTS (
             SELECT 1 FROM app_error_groups g
             WHERE g.environment = app_error_days.environment AND g.fingerprint = app_error_days.fingerprint)`,
        )
        .run();
    })();
  }

  listReads(): AppErrorRead[] {
    const rows = this.ctx.prep(`SELECT * FROM app_error_reads ORDER BY environment`).all() as ReadRow[];
    return rows.map((r) => ({
      environment: r.environment,
      status: r.status as AppErrorReadStatus,
      detail: r.detail,
      readAt: r.read_at,
      okAt: r.ok_at,
      deployedSha: r.deployed_sha,
      previousSha: r.previous_sha,
      deployedAt: r.deployed_at,
    }));
  }

  listGroups(environment?: string): AppErrorGroup[] {
    const groups = (
      environment === undefined
        ? this.ctx.prep(`SELECT * FROM app_error_groups ORDER BY environment, last_seen DESC`).all()
        : this.ctx.prep(`SELECT * FROM app_error_groups WHERE environment = ? ORDER BY last_seen DESC`).all(environment)
    ) as GroupRow[];
    const days = (
      environment === undefined
        ? this.ctx.prep(`SELECT * FROM app_error_days ORDER BY day`).all()
        : this.ctx.prep(`SELECT * FROM app_error_days WHERE environment = ? ORDER BY day`).all(environment)
    ) as DayRow[];
    const daily = new Map<string, AppErrorDay[]>();
    for (const d of days) {
      const key = `${d.environment}\n${d.fingerprint}`;
      const list = daily.get(key) ?? [];
      list.push({ day: d.day, count: d.count });
      daily.set(key, list);
    }
    return groups.map((g) => ({
      environment: g.environment,
      fingerprint: g.fingerprint,
      title: g.title,
      operation: g.operation,
      version: g.version,
      frames: readFrames(g.frames),
      url: g.url,
      firstSeen: g.first_seen,
      lastSeen: g.last_seen,
      returnedAt: g.returned_at,
      recordedAt: g.recorded_at,
      daily: daily.get(`${g.environment}\n${g.fingerprint}`) ?? [],
    }));
  }
}

interface ReadRow {
  environment: string;
  status: string;
  detail: string | null;
  read_at: string;
  ok_at: string | null;
  deployed_sha: string | null;
  previous_sha: string | null;
  deployed_at: string | null;
}

interface GroupRow {
  environment: string;
  fingerprint: string;
  title: string;
  operation: string | null;
  version: string | null;
  frames: string;
  url: string | null;
  first_seen: string;
  last_seen: string;
  returned_at: string | null;
  recorded_at: string;
}

interface DayRow {
  environment: string;
  fingerprint: string;
  day: string;
  count: number;
}

function readFrames(text: string): string[] {
  const json: unknown = JSON.parse(text);
  return Array.isArray(json) ? json.filter((f): f is string => typeof f === 'string') : [];
}
