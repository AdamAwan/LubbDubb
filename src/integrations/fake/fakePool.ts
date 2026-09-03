import { poolCompanion } from '../../pool/companion.js';
import { poolDocumentAddress, poolDocumentPath, poolPackPath, serialisePoolDocument } from '../../pool/document.js';
import { reviewPackCompanionPath } from '../../reviewPacks/companion.js';
import type { PoolFetchedDocument, PoolPackRef, PoolTransport } from '../../pool/transport.js';
import type { PoolClockDocument, PoolDocument } from '../../types.js';

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

  /** The shared packs in this fleet's namespace, by address — never returned by {@link fetch}. */
  readonly packs = new Map<string, string>();

  /** Every pack removed from the namespace, in order: what pruning looks like from here. */
  readonly unpublished: PoolPackRef[] = [];

  /** Set when `publish` should fail, so a test can watch the document stay dirty. */
  publishError: Error | null = null;
  /** Set when `fetch` should fail, so a test can watch the last-known-good mirror survive. */
  fetchError: Error | null = null;

  private readonly documents = new Map<string, PoolFetchedDocument>();

  /**
   * Every companion written beside a document, by address — the markdown for the
   * two clock documents, the HTML for a shared pack.
   *
   * Held because the real transport writes them and a fake that did not would let
   * a change ship the JSON with no companion, or with one nothing renders. Never
   * read by {@link fetch}, exactly as no companion is ever read back anywhere.
   */
  readonly companions = new Map<string, string>();

  constructor(readonly canRead = true) {}

  /**
   * Declare another fleet's document. Serialised exactly as a real transport would
   * store it. A clock document only: a shared pack is never fetched, so seeding one
   * would declare a state the pool cannot be in.
   */
  seed(document: PoolClockDocument): this {
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

  async publish(document: PoolDocument): Promise<void> {
    if (this.publishError) throw this.publishError;
    this.published.push(document);
    const address = poolDocumentAddress(document);
    const companion = poolCompanion(document);
    this.companions.set(companion.path, companion.text);
    // A pack is stored where the real transport puts it and is **not** returned by
    // `fetch`: the git transport names `claims.json` and `digest.json` and never
    // walks, so a fake that handed packs back would make the poller answer for a
    // path nothing reads.
    if (document.kind === 'pack') {
      this.packs.set(address, serialisePoolDocument(document));
      return;
    }
    this.documents.set(address, { addressedTo: document.fleetId, text: serialisePoolDocument(document) });
  }

  async unpublish(ref: PoolPackRef): Promise<void> {
    if (this.publishError) throw this.publishError;
    const address = poolPackPath(ref.fleetId, ref.prNumber);
    this.packs.delete(address);
    this.companions.delete(reviewPackCompanionPath(ref.fleetId, ref.prNumber));
    this.unpublished.push(ref);
  }

  async fetch(): Promise<PoolFetchedDocument[]> {
    if (this.fetchError) throw this.fetchError;
    return [...this.documents.values()];
  }
}
