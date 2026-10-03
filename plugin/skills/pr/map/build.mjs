#!/usr/bin/env node
// Usage: node build.mjs <map.json> [out.html]
// Validates a PR map and renders it into template.html. Exits 1 with every problem listed.
import console from 'node:console';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [, , input, outArg] = process.argv;
if (!input) {
  console.error('Usage: node build.mjs <map.json> [out.html]');
  process.exit(2);
}

const data = JSON.parse(readFileSync(input, 'utf8'));
const errors = [];
const warnings = [];
const err = (m) => errors.push(m);

const STATUSES = ['changed', 'new', 'removed', 'path', 'outside', 'test', 'doc'];
const EDGE_STATES = ['normal', 'changed', 'blocked', 'ghost', 'absent'];
const EVENT_KINDS = ['item', 'event', 'focus', 'now'];
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const count = (name, arr, min, max) => {
  if (arr.length < min || arr.length > max) err(`${name}: want ${min} to ${max}, got ${arr.length}`);
};
const ids = (name, arr) => {
  const seen = new Set();
  for (const x of arr) {
    if (!isStr(x.id)) err(`${name} needs an id: ${JSON.stringify(x)}`);
    if (seen.has(x.id)) err(`duplicate ${name} id ${x.id}`);
    seen.add(x.id);
  }
  return seen;
};

if (!data.pr || !isStr(data.pr.repo) || !isStr(data.pr.title) || data.pr.number == null)
  err('pr needs repo, number and title');
if (!isStr(data.summary)) err('summary is required: one sentence on what the PR changes');

const cols = data.columns ?? [];
count('columns', cols, 2, 6);
const colIds = ids('column', cols);
for (const c of cols) if (!isStr(c.label)) err(`column ${c.id} needs a label`);

const nodes = data.nodes ?? [];
count('nodes', nodes, 2, 14);
const nodeIds = ids('node', nodes);
for (const n of nodes) {
  if (!isStr(n.title)) err(`node ${n.id} needs a title`);
  if (!colIds.has(n.column)) err(`node ${n.id}: unknown column ${n.column}`);
  if (!STATUSES.includes(n.status)) err(`node ${n.id}: status must be one of ${STATUSES.join(', ')}`);
}
for (const c of cols) if (!nodes.some((n) => n.column === c.id)) err(`column ${c.id} has no nodes`);

for (const [i, e] of (data.edges ?? []).entries()) {
  if (!nodeIds.has(e.from)) err(`edge ${i}: unknown from ${e.from}`);
  if (!nodeIds.has(e.to)) err(`edge ${i}: unknown to ${e.to}`);
  for (const k of ['before', 'after'])
    if (e[k] != null && !EDGE_STATES.includes(e[k])) err(`edge ${i}: ${k} must be one of ${EDGE_STATES.join(', ')}`);
}

const steps = data.steps ?? [];
count('steps', steps, 2, 8);
const inSteps = new Set();
steps.forEach((s, i) => {
  const at = `step ${i + 1}`;
  if (!isStr(s.title)) err(`${at}: title required`);
  if (!Array.isArray(s.nodes) || s.nodes.length === 0) err(`${at}: must name at least one node`);
  for (const id of s.nodes ?? []) {
    if (!nodeIds.has(id)) err(`${at}: unknown node ${id}`);
    inSteps.add(id);
  }
  if (!s.text && !s.before && !s.after) err(`${at}: needs text, or before/after`);
  if (!s.timeline) return;
  const t = s.timeline;
  const n = t.events?.length ?? 0;
  if (n < 2 || n > 10) err(`${at}: timeline wants 2 to 10 events, got ${n}`);
  for (const e of t.events ?? [])
    if (!EVENT_KINDS.includes(e.kind)) err(`${at}: event kind must be one of ${EVENT_KINDS.join(', ')}`);
  for (const k of ['before', 'after']) {
    const w = t.windows?.[k];
    if (!w) continue;
    if (!(w.from >= 0 && w.from < n)) err(`${at}: windows.${k}.from must be an event index`);
    if (w.to != null && !(w.to >= w.from && w.to < n)) err(`${at}: windows.${k}.to out of range`);
    if (!isStr(w.label)) err(`${at}: windows.${k}.label required`);
  }
  if (t.meter && !(Number.isInteger(t.meter.max) && t.meter.max > 0))
    err(`${at}: meter.max must be a positive integer`);
});
if (!steps.some((s) => s.before || s.after)) err('no step has before/after: say what this PR changes');
for (const n of nodes) {
  if (['changed', 'new', 'removed'].includes(n.status) && !inSteps.has(n.id))
    err(`node ${n.id} is ${n.status} but no step names it`);
  else if (!inSteps.has(n.id) && !['test', 'doc'].includes(n.status)) warnings.push(`node ${n.id} is in no step`);
}
if (
  data.focusStep != null &&
  !(Number.isInteger(data.focusStep) && data.focusStep >= 1 && data.focusStep <= steps.length)
)
  err('focusStep must be a step number (1-based)');

for (const w of warnings) console.warn('warn:', w);
if (errors.length) {
  for (const e of errors) console.error('error:', e);
  process.exit(1);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const html = readFileSync(join(here, 'template.html'), 'utf8')
  .replace('__TITLE__', () => esc(`PR #${data.pr.number} Map`))
  .replace('__PR_DATA__', () => json);
const out = resolve(outArg ?? join(dirname(input), `pr-${data.pr.number}-map.html`));
writeFileSync(out, html);
console.log(out);
