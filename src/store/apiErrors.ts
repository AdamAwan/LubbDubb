import { nanoid } from 'nanoid';
import type { ApiErrorEvent, ApiErrorKind } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class ApiErrorStore {
  constructor(private readonly ctx: StoreContext) {}

  recordApiError(input: Omit<ApiErrorEvent, 'id' | 'createdAt'>): ApiErrorEvent {
    const event: ApiErrorEvent = { ...input, id: `apierr_${nanoid(10)}`, createdAt: this.ctx.now() };
    this.ctx
      .prep(
        `INSERT INTO api_errors (id, agent_id, task_id, origin_ref, model, kind, code, message, created_at)
         VALUES (@id, @agentId, @taskId, @originRef, @model, @kind, @code, @message, @createdAt)`,
      )
      .run(event);
    return event;
  }

  listApiErrorsSince(since: string): ApiErrorEvent[] {
    const rows = this.ctx
      .prep(`SELECT * FROM api_errors WHERE created_at >= ? ORDER BY created_at ASC, rowid ASC`)
      .all(since) as ApiErrorRow[];
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      taskId: r.task_id,
      originRef: r.origin_ref,
      model: r.model,
      kind: r.kind,
      code: r.code,
      message: r.message,
      createdAt: r.created_at,
    }));
  }
}

interface ApiErrorRow {
  id: string;
  agent_id: string;
  task_id: string;
  origin_ref: string | null;
  model: string | null;
  kind: ApiErrorKind;
  code: string | null;
  message: string;
  created_at: string;
}
