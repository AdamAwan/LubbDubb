import { nanoid } from 'nanoid';
import type { Job, JobAttachment } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `jobs` table: work an operator asked for, which — unlike a `Task` — persists
 * *ahead of* dispatch so it can sit in a queue while the fleet is at capacity.
 */
export class JobStore {
  constructor(private readonly ctx: StoreContext) {}

  /** Queue a new operator-launched job. Starts `queued`; the dispatcher drains it. */
  createJob(input: { title: string; prompt: string; kind: Job['kind']; branch?: string | null }): Job {
    const ts = this.ctx.now();
    const job: Job = {
      id: `job_${nanoid(10)}`,
      title: input.title,
      prompt: input.prompt,
      kind: input.kind,
      branch: input.branch ?? null,
      status: 'queued',
      taskId: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO jobs (id, title, prompt, kind, branch, status, task_id, created_at, updated_at)
         VALUES (@id, @title, @prompt, @kind, @branch, @status, @taskId, @createdAt, @updatedAt)`,
      )
      .run(job);
    return job;
  }

  getJob(id: string): Job | null {
    const row = this.ctx.db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  listJobs(limit = 100): Job[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit) as JobRow[];
    return rows.map(rowToJob);
  }

  /** Jobs still awaiting a slot, oldest first — the order the dispatcher drains them. */
  listQueuedJobs(): Job[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC`)
      .all() as JobRow[];
    return rows.map(rowToJob);
  }

  /** Mark a job dispatched, linking the task it became, so it leaves the queue. */
  markJobDispatched(id: string, taskId: string): void {
    const existing = this.getJob(id);
    if (!existing) throw new Error(`Job ${id} not found`);
    this.ctx.db
      .prepare(`UPDATE jobs SET status='dispatched', task_id=?, updated_at=? WHERE id=?`)
      .run(taskId, this.ctx.now(), id);
  }

  /** Drop a still-queued job. Returns the job if it was cancellable, else null. */
  cancelJob(id: string): Job | null {
    const existing = this.getJob(id);
    if (!existing || existing.status !== 'queued') return null;
    const updatedAt = this.ctx.now();
    this.ctx.db.prepare(`UPDATE jobs SET status='cancelled', updated_at=? WHERE id=?`).run(updatedAt, id);
    return { ...existing, status: 'cancelled', updatedAt };
  }

  /**
   * Record the images stored for `targetRef` (issue #249). The bytes are already
   * on disk — this is the record of what they are, written after the write so a
   * row never names a file that was never created.
   */
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

  /** What is attached to `targetRef`, in the order the operator attached it. */
  listAttachments(targetRef: string): JobAttachment[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM job_attachments WHERE target_ref=? ORDER BY idx ASC`)
      .all(targetRef) as AttachmentRow[];
    return rows.map(rowToAttachment);
  }

  /**
   * Forget what was attached to `targetRef` — a blueprint cancelled before it ran,
   * the one case nothing downstream can want. Rows go first and the files after,
   * so an interrupted deletion leaves orphaned bytes rather than a row pointing at
   * a path that no longer resolves.
   */
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
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
