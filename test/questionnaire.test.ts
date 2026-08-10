import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAnswers } from '../src/escalation/questionnaire.js';
import type { AgentAskQuestion } from '../src/types.js';

const QUESTIONS: AgentAskQuestion[] = [
  { question: 'Split part one, or leave it as two parts?', options: ['Split into three', 'Keep two'] },
  { question: 'Keep the operator-parks-a-note path?' },
  { question: 'Rename the type?' },
];

test('formatAnswers numbers each question and quotes its answer', () => {
  const out = formatAnswers(QUESTIONS, ['Keep two', 'Cut it', 'Yes']);
  assert.match(out, /^1\. Split part one, or leave it as two parts\?\n> Keep two$/m);
  assert.match(out, /^2\. Keep the operator-parks-a-note path\?\n> Cut it$/m);
  assert.match(out, /^3\. Rename the type\?\n> Yes$/m);
});

test('formatAnswers marks a blank answer as unanswered rather than dropping the question', () => {
  const out = formatAnswers(QUESTIONS, ['Keep two', null, '   ']);
  const unanswered = out.match(/no answer/g) ?? [];
  assert.equal(unanswered.length, 2, out);
  // The question itself must still be there — the agent has to know what it is
  // being told nothing about.
  assert.match(out, /2\. Keep the operator-parks-a-note path\?/);
});

test('formatAnswers indents every line of a multi-line answer', () => {
  const out = formatAnswers(QUESTIONS.slice(0, 1), ['Keep two.\n\nBut land the gate first.']);
  assert.equal(out, '1. Split part one, or leave it as two parts?\n> Keep two.\n>\n> But land the gate first.');
});

test('formatAnswers tolerates fewer answers than questions', () => {
  const out = formatAnswers(QUESTIONS, ['Keep two']);
  assert.match(out, /3\. Rename the type\?/);
  assert.equal((out.match(/no answer/g) ?? []).length, 2);
});
