import { createElement, Fragment, type ReactNode } from 'react';
import { linkify } from './util.js';
import { renderMarkdown } from './markdown.js';

// → docs/spec/17-cockpit.md

export function renderRichText(source: string, refUrls: Record<string, string> = {}): ReactNode[] {
  return looksLikeHtml(source) ? renderHtml(source, refUrls) : renderMarkdown(source, refUrls);
}

function looksLikeHtml(source: string): boolean {
  return /<(?:br|p|div|ul|ol|li|h[1-6]|table|tr|td|blockquote|pre|img|a|span|strong|em|b|i)\b[^>]*>/i.test(source);
}

const TAGS: Record<string, string> = {
  p: 'p',
  div: 'div',
  br: 'br',
  hr: 'hr',
  ul: 'ul',
  ol: 'ol',
  li: 'li',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  pre: 'pre',
  code: 'code',
  blockquote: 'blockquote',
  table: 'table',
  thead: 'thead',
  tbody: 'tbody',
  tr: 'tr',
  td: 'td',
  th: 'th',
  a: 'a',
  strong: 'strong',
  b: 'strong',
  em: 'em',
  i: 'em',
  u: 'u',
  del: 'del',
  s: 'del',
  strike: 'del',
  sup: 'sup',
  sub: 'sub',
};

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'source']);

const DROPPED = new Set(['script', 'style', 'head', 'title']);

interface Frame {
  tag: string;
  attrs: string;
  kids: ReactNode[];
}

const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)\/?>/g;

function renderHtml(source: string, refUrls: Record<string, string>): ReactNode[] {
  const root: Frame = { tag: '', attrs: '', kids: [] };
  const stack: Frame[] = [root];
  let key = 0;
  const k = () => `ht-${key++}`;
  const top = () => stack[stack.length - 1]!;

  const text = (raw: string) => {
    const value = decodeEntities(raw).replace(/\s+/g, ' ');
    if (value === '') return;
    top().kids.push(
      Object.keys(refUrls).length === 0 ? value : createElement(Fragment, { key: k() }, linkify(value, refUrls)),
    );
  };

  let last = 0;
  for (let m = TAG_RE.exec(source); m !== null; m = TAG_RE.exec(source)) {
    if (m.index > last) text(source.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const name = m[2]!.toLowerCase();

    if (DROPPED.has(name)) {
      if (closing) continue;
      const end = new RegExp(`</${name}\\s*>`, 'i').exec(source.slice(last));
      if (end) {
        TAG_RE.lastIndex = last + end.index + end[0].length;
        last = TAG_RE.lastIndex;
      }
      continue;
    }

    if (closing) {
      const at = stack.findIndex((f) => f.tag === name);
      if (at <= 0) continue;
      while (stack.length > at) {
        const frame = stack.pop()!;
        top().kids.push(emit(frame, k));
      }
      continue;
    }

    const frame: Frame = { tag: name, attrs: m[3] ?? '', kids: [] };
    if (VOID.has(name)) top().kids.push(emit(frame, k));
    else stack.push(frame);
  }
  if (last < source.length) text(source.slice(last));

  while (stack.length > 1) {
    const frame = stack.pop()!;
    top().kids.push(emit(frame, k));
  }
  return root.kids;
}

function emit(frame: Frame, k: () => string): ReactNode {
  const { tag, kids } = frame;

  if (tag === 'img') {
    const src = href(attr(frame.attrs, 'src'));
    const alt = attr(frame.attrs, 'alt') ?? 'image';
    if (src === null) return null;
    return createElement('a', { key: k(), href: src, target: '_blank', rel: 'noopener noreferrer' }, `${alt} ↗`);
  }

  if (tag === 'a') {
    const url = href(attr(frame.attrs, 'href'));
    if (url === null) return createElement(Fragment, { key: k() }, ...kids);
    return createElement('a', { key: k(), href: url, target: '_blank', rel: 'noopener noreferrer' }, ...kids);
  }

  const out = TAGS[tag];
  if (out === undefined) return createElement(Fragment, { key: k() }, ...kids);
  return VOID.has(out) ? createElement(out, { key: k() }) : createElement(out, { key: k() }, ...kids);
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

function href(value: string | null): string | null {
  if (value === null) return null;
  const url = value.trim();
  return /^(?:https?:\/\/|mailto:|\/)/i.test(url) ? url : null;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}
