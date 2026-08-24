import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { buildIntegrations } from '../src/integrations/registry.js';
import { CompositeConnector } from '../src/integrations/compositeConnector.js';
import { loadConfig } from '../src/config.js';
import { isRefResolvable, type IntegrationSelection } from '../src/integrations/integration.js';

const FIXED = () => '2026-01-01T00:00:00.000Z';

function selection(over: Partial<IntegrationSelection>): IntegrationSelection {
  return { sourceControl: 'fake', issues: 'fake', ...over, pool: 'fake' };
}

const TARGET = { organization: 'org', project: 'proj', repository: 'repo' };

test('loadConfig carries an azureDevOps block (org/project/repo/tag) from overrides', () => {
  const config = loadConfig({
    azureDevOps: { ...TARGET, filters: { workItemTag: 'agent-ready' } },
    userId: 'bot@acme.com',
  });
  assert.equal(config.azureDevOps?.organization, 'org');
  assert.equal(config.azureDevOps?.project, 'proj');
  assert.equal(config.azureDevOps?.repository, 'repo');
  // `workItemTag` stays a filter because it is about the tracker's shape. Identity
  // does not: PR authorship and work-item assignment both read `userId`.
  assert.equal(config.azureDevOps?.filters?.workItemTag, 'agent-ready');
  assert.equal(config.userId, 'bot@acme.com');
});

test('registry builds real azure providers when selected with a target', () => {
  const store = new Store(':memory:');
  const config = loadConfig({ azureDevOps: TARGET });
  const integrations = buildIntegrations(selection({ sourceControl: 'azure', issues: 'azure', pool: 'fake' }), {
    store,
    config,
    now: FIXED,
  });
  const byCap = Object.fromEntries(integrations.map((i) => [i.capability, i.id]));
  assert.equal(byCap.sourceControl, 'sourceControl:azure');
  assert.equal(byCap.issues, 'issues:azure');
  store.close();
});

test('an azure-selected connector resolves refs to Azure web URLs', () => {
  // The regression this guards: the cockpit's every link comes from
  // `connector.resolveRefUrl`, so an Azure deployment whose integrations aren't
  // `RefResolvable` renders every ref as plain text — silently, since an
  // unresolvable ref is *meant* to be omitted (that's the fake provider's case).
  const store = new Store(':memory:');
  const config = loadConfig({ azureDevOps: TARGET });
  const integrations = buildIntegrations(selection({ sourceControl: 'azure', issues: 'azure', pool: 'fake' }), {
    store,
    config,
    now: FIXED,
  });
  const connector = new CompositeConnector(integrations);
  assert.equal(connector.resolveRefUrl('issue:13'), 'https://dev.azure.com/org/proj/_workitems/edit/13');
  assert.equal(connector.resolveRefUrl('issue:13:plan'), 'https://dev.azure.com/org/proj/_workitems/edit/13');
  assert.equal(connector.resolveRefUrl('pr:42'), 'https://dev.azure.com/org/proj/_git/repo/pullrequest/42');
  assert.equal(connector.resolveRefUrl('issue/13'), 'https://dev.azure.com/org/proj/_git/repo?version=GBissue%2F13');
  store.close();
});

test('each azure integration resolves refs on its own, whichever the composite picks first', () => {
  // The composite routes to the *first* resolvable integration, not to the one
  // whose capability matches the ref — so both must answer every shape.
  const store = new Store(':memory:');
  const config = loadConfig({ azureDevOps: TARGET });
  for (const integration of buildIntegrations(selection({ sourceControl: 'azure', issues: 'azure', pool: 'fake' }), {
    store,
    config,
    now: FIXED,
  })) {
    assert.ok(isRefResolvable(integration), `${integration.id} is not RefResolvable`);
    assert.equal(integration.resolveRefUrl('issue:13'), 'https://dev.azure.com/org/proj/_workitems/edit/13');
    assert.equal(integration.resolveRefUrl('pr:42'), 'https://dev.azure.com/org/proj/_git/repo/pullrequest/42');
  }
  store.close();
});

test('registry throws a clear error when azure is selected without a target', () => {
  const store = new Store(':memory:');
  const config = loadConfig(); // no azureDevOps block
  assert.throws(
    () => buildIntegrations(selection({ sourceControl: 'azure' }), { store, config, now: FIXED }),
    /azureDevOps.*(organization|project|repository)/is,
  );
  store.close();
});

test('azure appears in the valid-providers list for an unknown provider error', () => {
  const store = new Store(':memory:');
  assert.throws(
    () => buildIntegrations(selection({ sourceControl: 'nope' }), { store, config: loadConfig(), now: FIXED }),
    /Valid providers:.*azure/s,
  );
  store.close();
});
