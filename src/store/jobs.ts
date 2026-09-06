import { nanoid } from 'nanoid';
import { ACTIVE_TASK_STATUS_SQL } from '../tasks.js';
import type { Job, JobAttachment } from '../types.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

// → docs/spec/14-persistence.md

export const JOB_COLUMNS: ColumnMigrations = {
  jobs: { origin_ref: 'TEXT' },
};

const STANDING_SQL = `SELECT j.* FROM jobs j LEFT JOIN tasks t ON t.id = j.task_id
   WHERE j.origin_ref IS NOT NULL
     AND (j.status='queued' OR t.status IN ${ACTIVE_TASK_STATUS_SQL})`;

export class JobStore {
  constructor(private readonly ctx: StoreContext) {}

  createJob(input: {
    title: string;
    prompt: string;
    kind: Job['kind'];
    branch?: string | null;
    originRef?: string | null;
  }): Job {
    const ts = this.ctx.now();
    const job: Job = {
      id: `job_${nanoid(10)}`,
      title: input.title,
      prompt: input.prompt,
      kind: input.kind,
      branch: input.branch ?? null,
      status: 'queued',
      originRef: input.originRef ?? null,
      taskId: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO jobs (id, title, prompt, kind, branch, status, origin_ref, task_id, created_at, updated_at)
         VALUES (@id, @title, @prompt, @kind, @branch, @status, @originRef, @taskId, @createdAt, @updatedAt)`,
      )
      .run(job);
    return job;
  }

  getJob(id: string): Job | null {
    const row = this.ctx.db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  jobLabels(ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const holes = ids.map(() => '?').join(',');
    const rows = this.ctx.db.prepare(`SELECT id, title FROM jobs WHERE id IN (${holes})`).all(...ids) as {
      id: string;
      title: string;
    }[];
    return new Map(rows.map((r) => [r.id, r.title]));
  }

  listJobs(limit = 100): Job[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit) as JobRow[];
    return rows.map(rowToJob);
  }

  listQueuedJobs(): Job[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC`)
      .all() as JobRow[];
    return rows.map(rowToJob);
  }

  listStandingJobs(): Job[] {
    return (this.ctx.db.prepare(STANDING_SQL).all() as JobRow[]).map(rowToJob);
  }

  findStandingJobByOrigin(originRef: string): Job | null {
    const row = this.ctx.db.prepare(`${STANDING_SQL} AND j.origin_ref=? LIMIT 1`).get(originRef) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  markJobDispatched(id: string, taskId: string): void {
    const existing = this.getJob(id);
    if (!existing) throw new Error(`Job ${id} not found`);
    this.ctx.db
      .prepare(`UPDATE jobs SET status='dispatched', task_id=?, updated_at=? WHERE id=?`)
      .run(taskId, this.ctx.now(), id);
  }

  cancelJob(id: string): Job | null {
    const existing = this.getJob(id);
    if (!existing || existing.status !== 'queued') return null;
    const updatedAt = this.ctx.now();
    this.ctx.db.prepare(`UPDATE jobs SET status='cancelled', updated_at=? WHERE id=?`).run(updatedAt, id);
    return { ...existing, status: 'cancelled', updatedAt };
  }

  addAttachments(
    targetRef: string,
    files: { index: number; label: string; mime: string; bytes: number; path: string }[],
  ): JobAttachment[] {
    const createdAt = this.ctx.now();
    const rows = files.map((file) => ({
      id: `att_${nanoid(10)}`,
      targetRef,
      index: file.index,
      label: file.label,
      mime: file.mime,
      bytes: file.bytes,
      path: file.path,
      createdAt,
    }));
    const insert = this.ctx.db.prepare(
      `INSERT INTO job_attachments (id, target_ref, idx, label, mime, bytes, path, created_at)
       VALUES (@id, @targetRef, @index, @label, @mime, @bytes, @path, @createdAt)`,
    );
    for (const row of rows) insert.run(row);
    return rows;
  }

  listAttachments(targetRef: string): JobAttachment[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM job_attachments WHERE target_ref=? ORDER BY idx ASC`)
      .all(targetRef) as AttachmentRow[];
    return rows.map(rowToAttachment);
  }

  getAttachment(id: string): JobAttachment | null {
    const row = this.ctx.db.prepare(`SELECT * FROM job_attachments WHERE id=?`).get(id) as AttachmentRow | undefined;
    return row ? rowToAttachment(row) : null;
  }

  listAllAttachments(): JobAttachment[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM job_attachments ORDER BY created_at ASC, idx ASC`)
      .all() as AttachmentRow[];
    return rows.map(rowToAttachment);
  }

  deleteAttachments(targetRef: string): void {
    this.ctx.db.prepare(`DELETE FROM job_attachments WHERE target_ref=?`).run(targetRef);
  }
}

interface JobRow {
  id: string;
  title: string;
  prompt: string;
  kind: string;
  branch: string | null;
  status: string;
  origin_ref: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AttachmentRow {
  id: string;
  target_ref: string;
  idx: number;
  label: string;
  mime: string;
  bytes: number;
  path: string;
  created_at: string;
}

function rowToAttachment(r: AttachmentRow): JobAttachment {
  return {
    id: r.id,
    targetRef: r.target_ref,
    index: r.idx,
    label: r.label,
    mime: r.mime,
    bytes: r.bytes,
    path: r.path,
    createdAt: r.created_at,
  };
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    title: r.title,
    prompt: r.prompt,
    kind: r.kind as Job['kind'],
    branch: r.branch,
    status: r.status as Job['status'],
    originRef: r.origin_ref,
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
