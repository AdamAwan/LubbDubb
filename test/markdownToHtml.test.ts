import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { markdownToHtml } from '../src/sink/markdownToHtml.js';
import { signOff } from '../src/sink/signOff.js';

test('a plan comment becomes block HTML rather than flattened punctuation', () => {
  const html = markdownToHtml(
    [
      '<!-- lubbdubb:plan -->',
      '_LubbDubb delivery plan_',
      '',
      '**Plan in progress** — 0/1 part done.',
      '',
      '- [~] **Retire the flag** (`retire-flag`) — in review · PR !32578',
      '- [ ] **Validation** — 0/1 settled',
      '',
      '<details>',
      '<summary>The plan, as the planner wrote it</summary>',
      '',
      "**What's wrong**",
      '',
      'The flag is on for every customer.',
      '',
      '</details>',
    ].join('\n'),
  );
  assert.match(html, /^<!-- lubbdubb:plan -->/);
  assert.match(html, /<p><em>LubbDubb delivery plan<\/em><\/p>/);
  assert.match(html, /<p><strong>Plan in progress<\/strong> — 0\/1 part done\.<\/p>/);
  assert.match(html, /<ul><li>\[~\] <strong>Retire the flag<\/strong> \(<code>retire-flag<\/code>\)/);
  assert.match(html, /<p><strong>The plan, as the planner wrote it<\/strong><\/p>/);
  assert.doesNotMatch(html, /<details>|<\/details>/);
  assert.equal(html.includes('**'), false);
});

test('code, links, rules and fences survive', () => {
  const html = markdownToHtml(
    [
      '# Heading',
      '',
      'See [the PR](https://example.com/a_b) and `a < b`.',
      '',
      '---',
      '',
      '```',
      '<script>',
      '```',
    ].join('\n'),
  );
  assert.match(html, /<h3>Heading<\/h3>/);
  assert.match(html, /<a href="https:\/\/example.com\/a_b">the PR<\/a>/);
  assert.match(html, /<code>a &lt; b<\/code>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<pre><code>&lt;script&gt;<\/code><\/pre>/);
});

test('nested and ordered lists keep their structure', () => {
  const html = markdownToHtml(['- one', '  - inner', '- two', '', '1. first', '2. second'].join('\n'));
  assert.match(html, /<ul><li>one<ul><li>inner<\/li><\/ul><\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
});

test('a signed HTML body re-sent gains no second footer and does not hang', () => {
  const once = signOff(markdownToHtml('**Hello**'), 'html');
  assert.equal(signOff(markdownToHtml(once), 'html'), markdownToHtml(once));
  assert.match(markdownToHtml(once), /<!-- lubbdubb:signoff -->/);
});
