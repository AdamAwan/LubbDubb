import { createElement, Fragment, type ReactNode } from 'react';
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

    const fence = /^```/.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      out.push(createElement('pre', { key: k() }, createElement('code', null, body.join('\n'))));
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
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  const prose = (slice: string) =>
    out.push(
      Object.keys(refUrls).length === 0 ? slice : createElement(Fragment, { key: k() }, linkify(slice, refUrls)),
    );
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) prose(text.slice(last, m.index));
    if (m[1]) out.push(createElement('code', { key: k() }, m[1].slice(1, -1)));
    else if (m[2]) out.push(createElement('strong', { key: k() }, ...inline(m[2].slice(2, -2), k, refUrls)));
    else if (m[3]) out.push(createElement('em', { key: k() }, ...inline(m[3].slice(1, -1), k, refUrls)));
    last = m.index + m[0].length;
  }
  if (last < text.length) prose(text.slice(last));
  return out.length > 0 ? out : [createElement(Fragment, { key: k() })];
}
