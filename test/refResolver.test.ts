import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { CompositeConnector } from '../src/integrations/compositeConnector.js';
import {
  isRefResolvable,
  type Capability,
  type Integration,
  type RefResolvable,
} from '../src/integrations/integration.js';

class StubResolver implements Integration, RefResolvable {
  readonly id = 'sourceControl:stub';
  readonly capability: Capability = 'sourceControl';
  async snapshot() {
    return {};
  }
  resolveRefUrl(ref: string): string | null {
    return ref === 'pr:1' ? 'https://x/pull/1' : null;
  }
}

class PlainIntegration implements Integration {
  readonly id = 'issues:plain';
  readonly capability: Capability = 'issues';
  async snapshot() {
    return {};
  }
}

test('isRefResolvable detects the capability', () => {
  assert.equal(isRefResolvable(new StubResolver()), true);
  assert.equal(isRefResolvable(new PlainIntegration()), false);
});

test('CompositeConnector.resolveRefUrl delegates to the first resolvable integration', () => {
  const store = new Store(':memory:');
  const composite = new CompositeConnector([new PlainIntegration(), new StubResolver()], store);
  assert.equal(composite.resolveRefUrl('pr:1'), 'https://x/pull/1');
  assert.equal(composite.resolveRefUrl('pr:999'), null);
  store.close();
});

test('CompositeConnector.resolveRefUrl returns null when no integration can resolve', () => {
  const store = new Store(':memory:');
  const composite = new CompositeConnector([new PlainIntegration()], store);
  assert.equal(composite.resolveRefUrl('pr:1'), null);
  store.close();
});
