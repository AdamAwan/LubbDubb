// → docs/spec/15-integrations.md

const HTML_COMMENT = /^<!--.*-->$/;

export function markdownToHtml(body: string): string {
  const out: string[] = [];
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (trimmed === '') {
      i += 1;
      continue;
    }
    if (HTML_COMMENT.test(trimmed)) {
      out.push(trimmed);
      i += 1;
      continue;
    }
    if (trimmed === '<details>' || trimmed === '</details>') {
      i += 1;
      continue;
    }
    const summary = /^<summary>(.*)<\/summary>$/.exec(trimmed);
    if (summary) {
      out.push(`<p><strong>${inline(summary[1] as string)}</strong></p>`);
      i += 1;
      continue;
    }
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      out.push('<hr>');
      i += 1;
      continue;
    }
    if (trimmed.startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] as string).trim().startsWith('```')) {
        code.push(escapeHtml(lines[i] as string));
        i += 1;
      }
      i += 1;
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = Math.min((heading[1] as string).length + 2, 6);
      out.push(`<h${level}>${inline(heading[2] as string)}</h${level}>`);
      i += 1;
      continue;
    }
    if (isItem(line)) {
      const [html, next] = list(lines, i, indentOf(line));
      out.push(html);
      i = next;
      continue;
    }
    if (trimmed.startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && (lines[i] as string).trim().startsWith('>')) {
        quoted.push((lines[i] as string).trim().replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote><p>${quoted.map(inline).join('<br>')}</p></blockquote>`);
      continue;
    }
    if (trimmed.startsWith('<')) {
      out.push(trimmed);
      i += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length) {
      const at = lines[i] as string;
      if (at.trim() === '' || isItem(at) || at.trim().startsWith('<') || at.trim().startsWith('```')) break;
      paragraph.push(at.trim());
      i += 1;
    }
    out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

function isItem(line: string): boolean {
  return /^\s*([-*+]|\d+[.)])\s+/.test(line);
}

function isOrdered(line: string): boolean {
  return /^\s*\d+[.)]\s+/.test(line);
}

function indentOf(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? '').length;
}

function list(lines: string[], start: number, indent: number): [string, number] {
  const ordered = isOrdered(lines[start] as string);
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === '') {
      const next = lines[i + 1];
      if (next === undefined || !isItem(next) || indentOf(next) < indent || isOrdered(next) !== ordered) break;
      i += 1;
      continue;
    }
    if (!isItem(line) || indentOf(line) < indent) break;
    if (indentOf(line) === indent && isOrdered(line) !== ordered) break;
    if (indentOf(line) > indent) {
      const [nested, next] = list(lines, i, indentOf(line));
      items[items.length - 1] = `${items[items.length - 1] ?? ''}${nested}`;
      i = next;
      continue;
    }
    items.push(inline(line.trim().replace(/^([-*+]|\d+[.)])\s+/, '')));
    i += 1;
  }
  const tag = ordered ? 'ol' : 'ul';
  return [`<${tag}>${items.map((it) => `<li>${it}</li>`).join('')}</${tag}>`, i];
}

function inline(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 1
        ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
        : emphasis(escapeHtml(part)),
    )
    .join('');
}

function emphasis(text: string): string {
  return text
    .split(/(\[[^\]]+\]\((?:https?:|#)[^)\s]*\))/)
    .map((part) => {
      const link = /^\[([^\]]+)\]\(((?:https?:|#)[^)\s]*)\)$/.exec(part);
      return link ? `<a href="${link[2] as string}">${style(link[1] as string)}</a>` : style(part);
    })
    .join('');
}

function style(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=$|[\s.,;:)])/g, '$1<em>$2</em>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
