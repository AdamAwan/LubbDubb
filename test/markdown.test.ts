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
