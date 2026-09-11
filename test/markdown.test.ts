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
  const out = html('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /<script/);
  assert.match(out, /&lt;img/);
});

test('a fenced block is never parsed as markdown', () => {
  const out = html('```\n# not a heading\n- not a list\n```');
  assert.doesNotMatch(out, /<h1/);
  assert.doesNotMatch(out, /<ul/);
});

test('empty and whitespace-only input render nothing', () => {
  assert.equal(html(''), '');
  assert.equal(html('   \n\n  '), '');
});

const REF_URLS = { '#142': 'https://example.test/pull/142' };
const linked = (src: string): string =>
  renderToStaticMarkup(createElement(React.Fragment, null, ...renderMarkdown(src, REF_URLS)));

test('a ref in prose is a link, in every block that holds prose', () => {
  assert.match(linked('landed in #142 last week'), /<a [^>]*href="https:\/\/example\.test\/pull\/142"/);
  assert.match(linked('## about #142'), /<a [^>]*href="https:\/\/example\.test\/pull\/142"/);
  assert.match(linked('- fixed by #142'), /<a [^>]*href="https:\/\/example\.test\/pull\/142"/);
  assert.match(linked('> per #142'), /<a [^>]*href="https:\/\/example\.test\/pull\/142"/);
  assert.match(linked('**landed in #142**'), /<strong[^>]*>.*<a [^>]*href="https:\/\/example\.test\/pull\/142"/);
});

test('a ref inside code is shown, not offered', () => {
  assert.doesNotMatch(linked('grep for `#142` in the log'), /<a /);
  assert.doesNotMatch(linked('```\ngit log #142\n```'), /<a /);
});

test('without refUrls nothing links, and the markup is unchanged', () => {
  assert.doesNotMatch(html('landed in #142 last week'), /<a /);
  assert.match(html('landed in #142 last week'), /<p[^>]*>landed in #142 last week<\/p>/);
});

test('a fence that names a language carries a copy control; a bare one stays a plain <pre>', () => {
  const named = html('```kql\ntraces | where a == 1 | count\n```');
  assert.match(named, /<button[^>]*class="md-copy"[^>]*>Copy<\/button>/);
  assert.match(named, /class="md-code md-code-kql"/);
  assert.match(named, /<span class="md-kql-op">\|<\/span>/, 'the pipe is the structure, and the only thing coloured');
  const bare = html('```\nnpm run check\n```');
  assert.doesNotMatch(bare, /md-copy/, 'a wrapper on every fence would unstyle the ones reached as a direct child');
  assert.match(bare, /<pre[^>]*><code[^>]*>npm run check/);
});

test('a pipe inside a quoted string does not start a new line', () => {
  const out = html('```kql\ntraces | where m has "a | b"\n```');
  assert.equal(out.match(/md-kql-op/g)?.length, 1);
});

test('a link is drawn only for http(s)', () => {
  assert.match(html('[Run it ↗](https://portal.example/logs?q=x)'), /<a[^>]*href="https:\/\/portal\.example/);
  const bad = html('[Run it](javascript:alert(1))');
  assert.doesNotMatch(bad, /<a /);
  assert.match(bad, /\[Run it\]/, 'and the refused one draws as the text it is');
});
