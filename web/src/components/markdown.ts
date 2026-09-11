import { createElement, Fragment, type ReactNode } from 'react';
import { CodeBlock } from './CodeBlock.js';
import { linkify } from './util.js';

// → docs/spec/17-cockpit.md

export function renderMarkdown(source: string, refUrls: Record<string, string> = {}): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let para: string[] = [];
  let key = 0;
  const k = () => `md-${key++}`;

  const flushParagraph = () => {
    if (para.length === 0) return;
    out.push(createElement('p', { key: k() }, ...inline(para.join(' '), k, refUrls)));
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      // A fence that names a language draws through `CodeBlock`, which carries the
      // copy control. A bare fence keeps the plain `<pre>` it has always been:
      // several stylesheets reach one as a direct child, and a component on every
      // fence in the cockpit would unstyle them with nothing red.
      const lang = fence[1] ?? '';
      const code = body.join('\n');
      out.push(
        lang === ''
          ? createElement('pre', { key: k() }, createElement('code', null, code))
          : createElement(CodeBlock, { key: k(), code, lang }),
      );
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      out.push(createElement(`h${heading[1]!.length}`, { key: k() }, ...inline(heading[2]!, k, refUrls)));
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      i--;
      out.push(createElement('blockquote', { key: k() }, ...inline(body.join(' '), k, refUrls)));
      continue;
    }

    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      const matches = (l: string) => (ordered ? /^\s*\d+\.\s+/.test(l) : /^\s*[-*]\s+/.test(l));
      while (i < lines.length && matches(lines[i]!)) {
        items.push(lines[i]!.replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, ''));
        i++;
      }
      i--;
      out.push(
        createElement(
          ordered ? 'ol' : 'ul',
          { key: k() },
          ...items.map((item) => createElement('li', { key: k() }, ...inline(item, k, refUrls))),
        ),
      );
      continue;
    }

    if (line.trim() === '') flushParagraph();
    else para.push(line.trim());
  }
  flushParagraph();
  return out;
}

function inline(text: string, k: () => string, refUrls: Record<string, string>): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  const prose = (slice: string) =>
    out.push(
      Object.keys(refUrls).length === 0 ? slice : createElement(Fragment, { key: k() }, linkify(slice, refUrls)),
    );
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) prose(text.slice(last, m.index));
    if (m[1]) out.push(createElement('code', { key: k() }, m[1].slice(1, -1)));
    else if (m[2]) out.push(link(m[2], k));
    else if (m[3]) out.push(createElement('strong', { key: k() }, ...inline(m[3].slice(2, -2), k, refUrls)));
    else if (m[4]) out.push(createElement('em', { key: k() }, ...inline(m[4].slice(1, -1), k, refUrls)));
    last = m.index + m[0].length;
  }
  if (last < text.length) prose(text.slice(last));
  return out.length > 0 ? out : [createElement(Fragment, { key: k() })];
}

/**
 * `[text](url)`, and **http(s) only** — the pattern that reaches here refuses
 * every other scheme, so a `javascript:` that found its way into an operator's
 * config draws as the text it is rather than as a control.
 */
function link(source: string, k: () => string): ReactNode {
  const split = source.indexOf('](');
  return createElement(
    'a',
    { key: k(), href: source.slice(split + 2, -1), target: '_blank', rel: 'noreferrer', className: 'md-link' },
    source.slice(1, split),
  );
}
