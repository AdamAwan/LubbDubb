import { poolCompanion } from '../../pool/companion.js';
import { poolDocumentAddress, poolDocumentPath, serialisePoolDocument } from '../../pool/document.js';
import type { PoolFetchedDocument, PoolTransport } from '../../pool/transport.js';
import type { PoolClockDocument, PoolDocument } from '../../types.js';

// → docs/spec/15-integrations.md

export class FakePoolTransport implements PoolTransport {
  readonly id = 'pool:fake';

  readonly published: PoolDocument[] = [];

  publishError: Error | null = null;
  fetchError: Error | null = null;

  private readonly documents = new Map<string, PoolFetchedDocument>();

  readonly companions = new Map<string, string>();

  constructor(readonly canRead = true) {}

  seed(document: PoolClockDocument): this {
    return this.seedText(document.fleetId, poolDocumentPath(document.fleetId, document.kind), {
      addressedTo: document.fleetId,
      text: serialisePoolDocument(document),
    });
  }

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
    this.documents.set(address, { addressedTo: document.fleetId, text: serialisePoolDocument(document) });
  }

  async fetch(): Promise<PoolFetchedDocument[]> {
    if (this.fetchError) throw this.fetchError;
    return [...this.documents.values()];
  }
}
