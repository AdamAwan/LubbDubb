import type { FastifyInstance } from 'fastify';
import type { System } from '../../system.js';
import type { Hub } from '../hub.js';

/**
 * What every module under `routes/` is handed (issue #237).
 *
 * `system` is the composition root and carries the store, the connector, the
 * harness and every manager, so it is the only wiring a route module needs; the
 * two artifact fields are the exception because they are derived from the *auth*
 * decision `buildApp` makes and exist nowhere else.
 */
export interface RouteContext {
  system: System;
  hub: Hub;
  /**
   * Mints a per-flag artifact capability into the URLs `/api/state` ships.
   * Undefined when auth is off — the surface is then loopback-only by the
   * operator's choice and `/artifacts/:id` verifies nothing.
   */
  artifactSigner?: (flagId: string) => string;
  /**
   * The same, per blueprint attachment (issue #249) — an `<img>` load cannot carry
   * the bearer token any more than a navigation can. Undefined when auth is off.
   */
  attachmentSigner?: (attachmentId: string) => string;
  /**
   * The per-run key `/artifacts/:id` and `/attachments/:id` verify those
   * capabilities against; null when auth is off.
   */
  artifactKey: Buffer | null;
}

/**
 * The one shape every route module exports. `buildApp` holds these in a list and
 * calls them in order, so it is wiring and nothing else — the same facade
 * `Store` has over `src/store/`.
 */
export type RouteModule = (app: FastifyInstance, ctx: RouteContext) => void;
