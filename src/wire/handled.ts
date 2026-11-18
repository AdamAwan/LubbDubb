import type { HandledAction } from '../types.js';

// → docs/spec/16-http-api.md, docs/spec/43-handled-for-you.md

export interface HandledPayload {
  actions: HandledAction[];
}
