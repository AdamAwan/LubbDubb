import type { FastifyInstance } from 'fastify';
import type { System } from '../../system/system.js';
import type { Hub } from '../hub.js';

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
}

export type RouteModule = (app: FastifyInstance, ctx: RouteContext) => void;
