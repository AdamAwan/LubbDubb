import assert from 'node:assert/strict';
import test from 'node:test';
import { composeWorkItemBody } from '../src/integrations/azure/workItemBody.js';

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
