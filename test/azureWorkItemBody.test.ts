import assert from 'node:assert/strict';
import test from 'node:test';
import { RestAzureDevOpsApi } from '../src/integrations/azure/restAzureDevOpsApi.js';
import { composeWorkItemBody, workItemBodyField } from '../src/integrations/azure/workItemBody.js';

test('a description alone is the body, unheaded', () => {
  assert.equal(composeWorkItemBody({ 'System.Description': '<p>the story</p>' }), '<p>the story</p>');
});

test('a bug whose content is in ReproSteps still has a body', () => {
  const body = composeWorkItemBody({
    'System.Description': '',
    'Microsoft.VSTS.TCM.ReproSteps': '<p>1. click it</p>',
  });
  assert.equal(body, '<h3>Repro steps</h3>\n<p>1. click it</p>');
});

test('every content field is carried, each under its own heading', () => {
  const body = composeWorkItemBody({
    'System.Description': '<p>why</p>',
    'Microsoft.VSTS.TCM.ReproSteps': '<p>how</p>',
    'Microsoft.VSTS.Common.AcceptanceCriteria': '<p>done when</p>',
  });
  assert.equal(
    body,
    '<h3>Description</h3>\n<p>why</p>\n<h3>Repro steps</h3>\n<p>how</p>\n<h3>Acceptance criteria</h3>\n<p>done when</p>',
  );
});

test('a custom rich-text field is carried under its own name', () => {
  const body = composeWorkItemBody({
    'System.Description': '<p>why</p>',
    'Custom.RootCauseAnalysis': '<p>a race</p>',
  });
  assert.equal(body, '<h3>Description</h3>\n<p>why</p>\n<h3>Root cause analysis</h3>\n<p>a race</p>');
});

test('scalar and metadata fields are not folded into the body', () => {
  const body = composeWorkItemBody({
    'System.Description': '<p>why</p>',
    'System.Title': 'a title',
    'System.Tags': 'watch; bug',
    'System.State': 'Active',
    'Microsoft.VSTS.Common.Priority': 2,
    'System.AssignedTo': { displayName: 'Someone' },
  });
  assert.equal(body, '<p>why</p>');
});

test('an item with nothing written on it has an empty body', () => {
  assert.equal(composeWorkItemBody({ 'System.Title': 'a title', 'System.State': 'New' }), '');
});

test('a Bug is written to ReproSteps, any other type to Description', () => {
  assert.equal(workItemBodyField('Bug'), 'Microsoft.VSTS.TCM.ReproSteps');
  assert.equal(workItemBodyField('bug'), 'Microsoft.VSTS.TCM.ReproSteps');
  assert.equal(workItemBodyField('User Story'), 'System.Description');
  assert.equal(workItemBodyField('Some Custom Type'), 'System.Description');
});

async function createdPatch(type: string): Promise<Array<{ path: string; value: string }>> {
  let sent = '';
  const fetchImpl: typeof fetch = async (_url, init) => {
    sent = typeof init?.body === 'string' ? init.body : '';
    return new Response(JSON.stringify({ id: 9 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const api = new RestAzureDevOpsApi('org', 'proj', 'repo', { header: async () => 'Bearer t' }, fetchImpl);
  await api.createWorkItem({ type, title: 't', description: '<p>body</p>', tags: [], assignedTo: null });
  return JSON.parse(sent) as Array<{ path: string; value: string }>;
}

test('a filed Bug carries its body in ReproSteps, where the Bug form shows it, and reads back', async () => {
  const patch = await createdPatch('Bug');
  const body = patch.find((op) => op.value === '<p>body</p>');
  assert.equal(body?.path, '/fields/Microsoft.VSTS.TCM.ReproSteps');
  assert.ok(!patch.some((op) => op.path === '/fields/System.Description'));
  assert.match(composeWorkItemBody({ 'Microsoft.VSTS.TCM.ReproSteps': body!.value }), /<p>body<\/p>/);
});

test('a filed User Story carries its body in Description', async () => {
  const patch = await createdPatch('User Story');
  assert.equal(patch.find((op) => op.value === '<p>body</p>')?.path, '/fields/System.Description');
});
