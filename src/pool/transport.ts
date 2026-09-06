import type { PoolDocument } from '../types.js';

// → docs/spec/28-cross-fleet-pool.md

export interface PoolTransport {
  readonly id: string;
  readonly canRead: boolean;
  publish(document: PoolDocument): Promise<void>;
  unpublish(pack: PoolPackRef): Promise<void>;
  fetch(): Promise<PoolFetchedDocument[]>;
}

export interface PoolPackRef {
  fleetId: string;
  prNumber: number;
}

export interface PoolFetchedDocument {
  addressedTo: string | null;
  text: string;
}
