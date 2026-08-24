import { poolDocumentPath, serialisePoolDocument } from '../../pool/document.js';
import type { PoolFetchedDocument, PoolTransport } from '../../pool/transport.js';
import type { PoolDocument } from '../../types.js';

/**
 * The pool substrate every test uses, and the default provider.
 *
 * Mandatory rather than convenient: all provider I/O in this codebase sits behind a
 * scripted fake and the suite touches no network, and a harness whose default pool
 * reached one on a fresh clone would be a harness nobody could run a test against.
 * It is the reason `integrations.pool` defaults to `fake` — the same reason
 * `sourceControl` and `issues` do.
 *
 * It is an in-memory map from address to bytes, which is exactly the contract's own
 * shape: one writer per address, a whole-document put, and an opaque payload.
 * Declare the other fleets' documents with {@link seed}, then assert on
 * {@link published}.
 */
export class FakePoolTransport implements PoolTransport {
  readonly id = 'pool:fake';

  /**
   * Every document this fleet has published, in order — including the repeats.
   *
   * A list rather than a map, because what most of these tests are about is *how
   * often* a publish happened: the hourly cadence, the dirty flag collapsing five
   * rulings into one put, and the backstop writing nothing when nothing changed are
   * all assertions about the length of this.
   */
  readonly published: PoolDocument[] = [];

  /** Set when `publish` should fail, so a test can watch the document stay dirty. */
  publishError: Error | null = null;
  /** Set when `fetch` should fail, so a test can watch the last-known-good mirror survive. */
  fetchError: Error | null = null;

  private readonly documents = new Map<string, PoolFetchedDocument>();

  constructor(readonly canRead = true) {}

  /** Declare another fleet's document. Serialised exactly as a real transport would store it. */
  seed(document: PoolDocument): this {
    return this.seedText(document.fleetId, poolDocumentPath(document.fleetId, document.kind), {
      addressedTo: document.fleetId,
      text: serialisePoolDocument(document),
    });
  }

  /**
   * Declare raw bytes at an address — what a malformed document, a document from a
   * newer harness, or one whose body names another fleet looks like on the wire.
   */
  seedText(_fleetId: string, path: string, entry: PoolFetchedDocument): this {
    this.documents.set(path, entry);
    return this;
  }

  /** Drop a document, which is what a withdrawal at origin looks like from here. */
  withdraw(fleetId: string, kind: PoolDocument['kind']): this {
    this.documents.delete(poolDocumentPath(fleetId, kind));
    return this;
  }

  async publish(document: PoolDocument): Promise<void> {
    if (this.publishError) throw this.publishError;
    this.published.push(document);
    this.documents.set(poolDocumentPath(document.fleetId, document.kind), {
      addressedTo: document.fleetId,
      text: serialisePoolDocument(document),
    });
  }

  async fetch(): Promise<PoolFetchedDocument[]> {
    if (this.fetchError) throw this.fetchError;
    return [...this.documents.values()];
  }
}
