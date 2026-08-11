import { createElement, Fragment, type ReactNode } from 'react';
import { linkify } from './util.js';

/**
 * A markdown subset, rendered to React nodes.
 *
 * Hand-written rather than a dependency, for the reason `ansi.ts` is: the
 * surface actually needed is small, and the text is **agent-authored**. A
 * renderer that produces React children never interprets HTML — React escapes
 * text — so there is no sanitiser to get wrong and no `dangerouslySetInnerHTML`
 * anywhere in the path. Anything it does not understand renders as its own
 * literal text, which is the right failure for a write-up: legible, never
 * executable.
 *
 * Supported: ATX headings (#..###), unordered and ordered lists, fenced code,
 * blockquotes, paragraphs, and inline `code`, **strong** and *emphasis*.
 *
 * `refUrls` turns `#142` and `issue:12` in prose into links, exactly as
 * {@link linkify} does for plain text. Passing it is what stops moving text *into*
 * a markdown block from silently unlinking it — the failure mode when an
 * escalation's body moved out of the linkified prompt and into `detail`. Code
 * spans and fenced blocks are reached by neither, which is the point: a ref
 * inside backticks is being shown to you, not offered to click.
 */
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

    // Fenced code first: everything inside is literal, including markdown that
    // would otherwise be parsed (a write-up explaining markdown is not rare).
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

/**
 * Inline spans, in one pass over a single alternation so the segments cannot
 * overlap — `code` wins, because a backticked `**x**` is showing you the
 * asterisks, not asking for bold.
 */
function inline(text: string, k: () => string, refUrls: Record<string, string>): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  // Only the runs *between* spans: what falls to `code` is being shown, and
  // strong/em carry their own text through here again on the next pass down.
  //
  // An empty map short-circuits to the bare string rather than running `linkify`
  // for nothing: it wraps every ref token it finds in a `<span>` whether or not a
  // URL resolved, so a caller that passes no refs would silently gain markup it
  // never had. Every existing caller is in exactly that position.
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
