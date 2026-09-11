import type { JSX, ReactNode } from 'react';
import { useState } from 'react';

// → docs/spec/17-cockpit.md

/**
 * A fenced block that names a language, with the one control a query needs: a
 * copy that hands over the **fence's own text**, never the wrapped display.
 *
 * The wrapping is a display transform and the copy is the source, which is the
 * whole point of the split — a query an operator pastes somewhere must be the one
 * the harness put to the environment, character for character, however this draws it.
 *
 * @public rendered by `renderMarkdown` for a fence carrying an info string
 */
export function CodeBlock({ code, lang }: { code: string; lang: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <pre className={`md-code md-code-${lang}`}>
      <button
        type="button"
        className="md-copy"
        title="Copy this exactly as the harness put it, however it is drawn here"
        onClick={() => {
          void copyText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <code>{lang === 'kql' ? kqlLines(code) : code}</code>
    </pre>
  );
}

/**
 * One operator per line, with the pipe drawn as the operator it is. No parser and
 * no keyword list: the pipe is the only structure a query has that can be found
 * without one, and a highlighter that guesses at the rest is confidently wrong on
 * the dialect nobody tested it against.
 */
function kqlLines(code: string): ReactNode[] {
  const parts = splitPipes(code);
  if (parts.length < 2) return [code];
  return parts.map((part, i) => (
    <span key={String(i)}>
      {i > 0 && (
        <>
          {'\n'}
          <span className="md-kql-op">|</span>{' '}
        </>
      )}
      {part}
    </span>
  ));
}

/** Pipes outside quotes, so a `has "a | b"` stays one line. */
function splitPipes(code: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of code) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '|') {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out.filter((p) => p !== '');
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('aria-hidden', 'true');
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } finally {
      area.remove();
    }
  }
}
