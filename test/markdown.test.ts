import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

const { renderMarkdown } = await import('../web/src/components/markdown.js');

const html = (src: string): string => renderToStaticMarkup(createElement(React.Fragment, null, ...renderMarkdown(src)));

test('headings, paragraphs and lists', () => {
  assert.match(html('# Title'), /<h1[^>]*>Title<\/h1>/);
  assert.match(html('## Why'), /<h2[^>]*>Why<\/h2>/);
  assert.match(html('a paragraph'), /<p[^>]*>a paragraph<\/p>/);
  const list = html('- one\n- two');
  assert.match(list, /<ul[^>]*>/);
  assert.equal(list.match(/<li/g)?.length, 2);
  assert.match(html('1. first\n2. second'), /<ol[^>]*>/);
});

test('code, emphasis and blockquotes', () => {
  assert.match(html('```\nnpm run check\n```'), /<pre[^>]*><code[^>]*>npm run check/);
  assert.match(html('use `runGit` here'), /<code[^>]*>runGit<\/code>/);
  assert.match(html('**bold**'), /<strong[^>]*>bold<\/strong>/);
  assert.match(html('*soft*'), /<em[^>]*>soft<\/em>/);
  assert.match(html('> quoted'), /<blockquote[^>]*>/);
});

test('agent-authored HTML is text, never markup', () => {
  // The whole reason this is hand-written rather than a dependency: the source is
  // agent-authored, so a renderer that never interprets HTML has no injection
  // surface to reason about. React escapes text children, and nothing here ever
  // reaches `dangerouslySetInnerHTML`.
  const out = html('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /<script/);
  assert.match(out, /&lt;img/);
});

test('a fenced block is never parsed as markdown', () => {
  // A write-up that shows a markdown example would otherwise render it.
  const out = html('```\n# not a heading\n- not a list\n```');
  assert.doesNotMatch(out, /<h1/);
  assert.doesNotMatch(out, /<ul/);
});

test('empty and whitespace-only input render nothing', () => {
  assert.equal(html(''), '');
  assert.equal(html('   \n\n  '), '');
});

/**
 * The links, and why they are the renderer's job at all.
 *
 * `linkify` handles plain text and this handles markdown, and until they were
 * joined a ref kept its link only while it stayed in a plain-text field. Moving
 * an escalation's body out of the linkified prompt and into `detail` — which is
 * exactly what made the stamp desk readable — would otherwise have silently
 * unlinked every `#142` in it. That is the regression these assert against.
 */
// Keyed by the token as it appears in the prose, which is what `refUrls` is: the
// server resolves `#142` and the cockpit never builds a URL itself.
const REF_URLS = { '#142': 'https://example.test/pull/142' };
const linked = (src: string): string =>
  renderToStaticMarkup(createElement(React.Fragment, null, ...renderMarkdown(src, REF_URLS)));

test('a ref in prose is a link, in every block that holds prose', () => {
  assert.match(linked('landed in #142 last week'), /<a [^>]*href="https:\/\/example\.test\/pull\/142"/);
  assert.match(linked('## about #142'), /<a [^>]*href="https:\/\/example\.test\/pull\/142"/);
  assert.match(linked('- fixed by #142'), /<a [^>]*href="https:\/\/example\.test\/pull\/142"/);
  assert.match(linked('> per #142'), /<a [^>]*href="https:\/\/example\.test\/pull\/142"/);
  // Inside an emphasis span too — the headline of a quoted assessment is bold,
  // and that is exactly where its refs are.
  assert.match(linked('**landed in #142**'), /<strong[^>]*>.*<a [^>]*href="https:\/\/example\.test\/pull\/142"/);
});

test('a ref inside code is shown, not offered', () => {
  // Backticks and fences mean "this is the text": a ref in either is being
  // quoted at you, and turning it into a control would misread the author.
  assert.doesNotMatch(linked('grep for `#142` in the log'), /<a /);
  assert.doesNotMatch(linked('```\ngit log #142\n```'), /<a /);
});

test('without refUrls nothing links, and the markup is unchanged', () => {
  // The default keeps every existing caller — a finding's detail, an agent's
  // write-up — rendering exactly what it did before refs were understood.
  assert.doesNotMatch(html('landed in #142 last week'), /<a /);
  assert.match(html('landed in #142 last week'), /<p[^>]*>landed in #142 last week<\/p>/);
});
