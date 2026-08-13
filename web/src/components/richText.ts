import { createElement, Fragment, type ReactNode } from 'react';
import { linkify } from './util.js';
import { renderMarkdown } from './markdown.js';

/**
 * A **tracker-authored** body, drawn as what it is.
 *
 * Azure DevOps stores `System.Description` as HTML — `<div>`, `<p>`, `<br>`,
 * `<li>` — and GitHub stores markdown, and the field is one field on the wire
 * that never says which. So the source is sniffed and handed to the renderer
 * that understands it; markdown falls through to {@link renderMarkdown}
 * unchanged, tags and all, which is why a body that merely *mentions* `<p>` in
 * prose still reads as prose.
 *
 * {@link renderMarkdown} deliberately never interprets HTML, and that stays true:
 * what it draws is **agent-authored**, where a renderer with no HTML surface is
 * the whole safety argument. This is the other trust context — the tracker's own
 * field, drawn beside a link to the very page it came from — and it gets the same
 * guarantee by construction rather than by sanitising: React elements only, an
 * allow-list of tags, no attribute carried over but a scheme-checked `href`, and
 * no `dangerouslySetInnerHTML` anywhere in the path. A tag not on the list
 * unwraps to its children, so an unknown one costs a wrapper and never the text.
 */
export function renderRichText(source: string, refUrls: Record<string, string> = {}): ReactNode[] {
  return looksLikeHtml(source) ? renderHtml(source, refUrls) : renderMarkdown(source, refUrls);
}

/**
 * Whether this body is HTML. Keyed on a *structural* tag, not on any `<` — a
 * markdown write-up quoting `<script>` or `<T>` is prose, and reading it as
 * markup is how the safe path gets left for text that was never HTML.
 */
function looksLikeHtml(source: string): boolean {
  return /<(?:br|p|div|ul|ol|li|h[1-6]|table|tr|td|blockquote|pre|img|a|span|strong|em|b|i)\b[^>]*>/i.test(source);
}

/** Tags kept as themselves or renamed; everything else unwraps to its children. */
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

/** Tags that never close, so a stack that waited for one would swallow the rest of the body. */
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'source']);

/** Tags whose *content* is dropped with them — the text inside is not prose. */
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
    // HTML collapses runs of whitespace, and the source is pretty-printed by the
    // tracker's own editor — kept verbatim, every nested `<div>` would draw its
    // indentation as a leading space.
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
      // Skip to the matching close, content and all. The tag is gone either way;
      // what this stops is its *text* surviving as prose.
      const end = new RegExp(`</${name}\\s*>`, 'i').exec(source.slice(last));
      if (end) {
        TAG_RE.lastIndex = last + end.index + end[0].length;
        last = TAG_RE.lastIndex;
      }
      continue;
    }

    if (closing) {
      // Only unwind to a frame that is actually open: a stray `</b>` (Azure's
      // editor emits them) would otherwise pop the paragraph it sits in.
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

  // Whatever the body left open closes here rather than being dropped — an
  // unclosed `<div>` is the common malformation, and losing the rest of the
  // ticket to it would be the worst possible reading.
  while (stack.length > 1) {
    const frame = stack.pop()!;
    top().kids.push(emit(frame, k));
  }
  return root.kids;
}

/**
 * One element. An `<a>` keeps a scheme-checked `href` and nothing else, and an
 * `<img>` becomes a link rather than an image: a tracker's inline attachment
 * needs the credentials the cockpit does not have, so it would draw as a broken
 * frame — a link says what it is and still reaches it.
 */
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
  // Unknown, and therefore unwrapped: `<font>`, `<section>`, an editor's own
  // wrapper. The text is the point; the box around it was never load-bearing.
  if (out === undefined) return createElement(Fragment, { key: k() }, ...kids);
  return VOID.has(out) ? createElement(out, { key: k() }) : createElement(out, { key: k() }, ...kids);
}

/** One attribute's value, quoted or bare. */
function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

/**
 * A URL the console will link to, or null. The allow-list is the whole point:
 * `javascript:` and `data:` are the two schemes an `href` can carry that do
 * something rather than go somewhere.
 */
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
