import type { StoreContext } from './context.js';

const FLUSH_BYTES = 16384;

/**
 * The `agent_transcripts` table — **the one stateful module**.
 *
 * Output arrives as many tiny deltas, so they are accumulated per agent in memory
 * and written as one INSERT per ~16KB rather than a DB write (plus a `MAX(seq)`
 * SELECT) per chunk. That buffer is the only mutable state anywhere under
 * `src/store/`, which is why it lives here and why {@link flushAll} exists: the
 * facade's `close()` must call it before the handle goes away, or buffered output
 * is silently lost.
 */
export class TranscriptStore {
  private readonly buffers = new Map<string, { chunks: string[]; bytes: number }>();

  constructor(private readonly ctx: StoreContext) {}

  appendTranscript(agentId: string, chunk: string): void {
    let buf = this.buffers.get(agentId);
    if (!buf) {
      buf = { chunks: [], bytes: 0 };
      this.buffers.set(agentId, buf);
    }
    buf.chunks.push(chunk);
    buf.bytes += Buffer.byteLength(chunk);
    if (buf.bytes >= FLUSH_BYTES) this.flushTranscript(agentId);
  }

  /** Persist one agent's buffered transcript as a single row, preserving order. */
  flushTranscript(agentId: string): void {
    const buf = this.buffers.get(agentId);
    if (!buf || buf.chunks.length === 0) return;
    this.buffers.delete(agentId);
    const chunk = buf.chunks.join('');
    const seq = (
      this.ctx.db
        .prepare(`SELECT COALESCE(MAX(seq),-1)+1 AS n FROM agent_transcripts WHERE agent_id=?`)
        .get(agentId) as {
        n: number;
      }
    ).n;
    this.ctx.db
      .prepare(`INSERT INTO agent_transcripts (agent_id, seq, chunk, at) VALUES (?,?,?,?)`)
      .run(agentId, seq, chunk, this.ctx.now());
  }

  /** Everything still buffered, for the one caller that is about to close the database. */
  flushAll(): void {
    for (const agentId of [...this.buffers.keys()]) this.flushTranscript(agentId);
  }

  getTranscript(agentId: string): string {
    // Flush first so a read always reflects every appended chunk.
    this.flushTranscript(agentId);
    const rows = this.ctx.db
      .prepare(`SELECT chunk FROM agent_transcripts WHERE agent_id=? ORDER BY seq`)
      .all(agentId) as {
      chunk: string;
    }[];
    return rows.map((r) => r.chunk).join('');
  }
}
