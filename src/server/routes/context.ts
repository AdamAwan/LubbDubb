import type { FastifyInstance } from 'fastify';
import type { System } from '../../system.js';
import type { Hub } from '../hub.js';

// → docs/spec/16-http-api.md

export interface RouteContext {
  system: System;
  hub: Hub;
  artifactSigner?: (flagId: string) => string;
  attachmentSigner?: (attachmentId: string) => string;
  localValidationFileSigner?: (id: string, name: string) => string;
  artifactKey: Buffer | null;
}

export type RouteModule = (app: FastifyInstance, ctx: RouteContext) => void;
