import type { FastifyInstance } from 'fastify';
import type { System } from '../../system/system.js';
import type { Hub } from '../hub.js';
import type { SetupReading } from '../../setup/reading.js';

// → docs/spec/16-http-api.md

export interface RouteContext {
  system: System;
  hub: Hub;
  artifactSigner?: (flagId: string) => string;
  attachmentSigner?: (attachmentId: string) => string;
  localValidationFileSigner?: (id: string, name: string) => string;
  validationCaptureSigner?: (originRef: string, checkId: string) => string;
  remoteCaptureSigner?: (runId: string, rowId: string) => string;
  artifactKey: Buffer | null;
  /** The last reading `/api/setup` took, which the ask queue's config rows are read off. */
  setup: { latest: SetupReading | null };
}

export type RouteModule = (app: FastifyInstance, ctx: RouteContext) => void;
