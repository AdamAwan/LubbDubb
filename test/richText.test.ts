import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

const { renderRichText } = await import('../web/src/components/richText.js');

const html = (src: string, refUrls: Record<string, string> = {}): string =>
  renderToStaticMarkup(createElement(React.Fragment, null, ...renderRichText(src, refUrls)));

test('an Azure DevOps description is drawn as HTML, not printed as tags', () => {
  const out = html('<div>Login is broken.<br>Reported twice.</div><ul><li>Chrome</li><li>Edge</li></ul>');
  assert.match(out, /<div>Login is broken\.<br\/>Reported twice\.<\/div>/);
  assert.equal(out.match(/<li>/g)?.length, 2);
  assert.doesNotMatch(out, /&lt;/);
});

test('markdown still reaches the markdown renderer, tags and all', () => {
  assert.match(html('# Title\n\n- one'), /<h1[^>]*>Title<\/h1>/);
  const quoted = html('the `<T>` in `Box<T>` and a `<script>` tag');
  assert.match(quoted, /&lt;script&gt;/);
  assert.doesNotMatch(quoted, /<script/);
});

test('script and style are dropped with their contents, never rendered as prose', () => {
  const out = html('<p>before</p><script>alert(1)</script><style>p{color:red}</style><p>after</p>');
  assert.doesNotMatch(out, /<script|alert\(1\)|color:red/);
  assert.match(out, /<p>before<\/p>/);
  assert.match(out, /<p>after<\/p>/);
});

test('no attribute survives but a scheme-checked href', () => {
  const out = html('<p onclick="steal()" style="x"><a href="https://example.test/t/1" onmouseover="x">docs</a></p>');
  assert.doesNotMatch(out, /onclick|onmouseover|style=/);
  assert.match(out, /<a href="https:\/\/example\.test\/t\/1"[^>]*>docs<\/a>/);

  const js = html('<a href="javascript:alert(1)">click</a>');
  assert.doesNotMatch(js, /href/);
  assert.match(js, /click/);
});

test('an unknown tag unwraps to its text rather than taking it away', () => {
  const out = html('<section><font color="red">still here</font></section><p>and this</p>');
  assert.doesNotMatch(out, /<section|<font/);
  assert.match(out, /still here/);
  assert.match(out, /<p>and this<\/p>/);
});

test('a body that never closes its tags keeps the rest of the ticket', () => {
  const out = html('<div>one<p>two</div>three');
  assert.match(out, /one/);
  assert.match(out, /two/);
  assert.match(out, /three/);
});

test('entities decode, so a body reads as its author wrote it', () => {
  assert.match(html('<p>A&nbsp;&amp;&nbsp;B &mdash; &lt;not a tag&gt; &#39;quoted&#39;</p>'), /A &amp; B — /);
  assert.match(html('<p>&lt;script&gt;</p>'), /&lt;script&gt;/);
});

test('a ref in HTML prose links, exactly as it does in markdown', () => {
  const out = html('<p>fixed by #42</p>', { '#42': 'https://example.test/pr/42' });
  assert.match(out, /href="https:\/\/example\.test\/pr\/42"/);
});

test('an inline image becomes a link, not a broken frame', () => {
  const out = html('<p><img src="https://dev.azure.test/att/1" alt="the crash"></p>');
  assert.match(out, /<a href="https:\/\/dev\.azure\.test\/att\/1"[^>]*>the crash ↗<\/a>/);
});
