import type { PoolDocument } from '../types.js';

// → docs/spec/28-cross-fleet-pool.md

export interface PoolTransport {
  readonly id: string;
  readonly canRead: boolean;
  publish(document: PoolDocument): Promise<void>;
  fetch(): Promise<PoolFetchedDocument[]>;
}

export interface PoolFetchedDocument {
  addressedTo: string | null;
  text: string;
}
