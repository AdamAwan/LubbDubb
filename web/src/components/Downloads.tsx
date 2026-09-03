import type { JSX } from 'react';
import { Label } from './label.js';

/**
 * Taking a reading off the glass.
 *
 * The insight panels are the only surfaces in the cockpit that answer a question
 * nobody asks at the glass — what a month cost, split how, and whether the floor
 * is producing — and those answers are wanted in a spreadsheet, a ticket or a
 * budget review rather than in a browser tab that is gone on the next poll. So
 * every panel that draws one offers the same two files, and the pair is the whole
 * of the vocabulary:
 *
 * - **CSV is what the panel drew**, table by table, in the order it drew them.
 *   Sections rather than one grid, because a panel is several tables and flattening
 *   them into one loses which figure was a total and which was a row.
 * - **JSON is what the panel was handed**, unrounded and unformatted. The CSV is
 *   for a person; this is for the next program, and rounding a figure on the way
 *   out is how an export becomes a second, quieter opinion about the numbers.
 * - **PDF is the panel itself**, printed. Not a document built to resemble it: the
 *   browser lays out the same nodes under the same stylesheet, so the graph on
 *   paper is the graph on screen and cannot drift from it. A bundled PDF library
 *   would mean hand-placing every table and bar a second time — a second
 *   presentation of one reading, which is the drift this cockpit refuses
 *   everywhere else it derives something twice.
 *
 * All three are built **in the browser from the data already on screen** — there is
 * no export route, and adding one would be a second derivation of a reading the
 * server has already shipped. What you download is what you were looking at.
 */

type CsvCell = string | number | null;

/**
 * RFC 4180: quote a field that contains a delimiter, a quote or a newline, and
 * double the quotes inside it. Leading and trailing spaces are quoted too — a
 * reader that trims them silently changes a title.
 *
 * `null` is an empty field rather than the string `null`: these come from
 * genuinely absent readings (a goal the world no longer carries, a run with no
 * origin) and "not recorded" is what a blank cell already means.
 */
function csvField(cell: CsvCell): string {
  if (cell === null) return '';
  const s = String(cell);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Rows to a CSV body. An empty row is a blank line, which is how sections are parted. */
export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n');
}

type Format = 'csv' | 'json';

const MIME: Record<Format, string> = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json',
};

/** `20260813-1042`, in the reader's own timezone — this names a file, it does not date a record. */
function stamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
}

/**
 * Hand the browser a file it never fetched.
 *
 * The CSV carries a byte-order mark. Excel reads a BOM-less UTF-8 CSV as the
 * local codepage, so a goal title with an em dash or a name outside ASCII arrives
 * mangled — in the one program most of these files are opened in.
 */
const BOM = String.fromCharCode(0xfeff);

function save(filename: string, format: Format, text: string): void {
  const body = format === 'csv' ? BOM + text : text;
  const url = URL.createObjectURL(new Blob([body], { type: MIME[format] }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked on the next tick, not this one: Safari reads the URL after the click
  // handler returns, and freeing it here downloads an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Print one panel and nothing else.
 *
 * The panel is **cloned into a sheet of its own** rather than printed where it
 * stands. Both surfaces that carry a reading are overlays — a fixed backdrop over
 * a console that is itself a full-height grid — and hiding a page around an
 * element nested six levels inside it takes a rule per level, each one a guess
 * about a layout that will move. A clone appended to `body` is one rule: print
 * the sheet, hide its siblings.
 *
 * Cleanup hangs off `afterprint` rather than the line after `print()`. Chrome
 * blocks there and Safari does not, so removing the sheet on the next statement
 * prints a blank page on exactly one of them.
 */
function printSheet(node: HTMLElement, heading: string): void {
  const sheet = document.createElement('div');
  sheet.id = 'print-sheet';

  // The screen carries the panel's name in chrome that does not print (a modal
  // head, a panel bar), so the sheet states it again. A page of tables that does
  // not say what it is a page of is the one failure a print cannot recover from.
  const head = document.createElement('h1');
  head.textContent = heading;
  const when = document.createElement('p');
  when.className = 'print-when';
  when.textContent = new Date().toLocaleString();
  sheet.append(head, when, node.cloneNode(true));

  document.body.append(sheet);
  document.body.classList.add('printing');

  const done = () => {
    sheet.remove();
    document.body.classList.remove('printing');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

/**
 * The download control, one per insight panel. `name` is the file's stem; the
 * stamp and the extension are added here so two exports a week apart sort.
 *
 * `build` is a thunk rather than a string because the caller's data is live: a
 * panel that polls would otherwise ship whatever it held when the button
 * rendered. `sheet.node` is a thunk for the same reason, and because a ref is
 * null on the render that draws this.
 */
export function Downloads({
  name,
  files,
  sheet,
}: {
  name: string;
  files: readonly { format: Format; title: string; build: () => string }[];
  sheet?: { heading: string; title: string; node: () => HTMLElement | null };
}): JSX.Element {
  return (
    <div className="dl">
      <Label>Export</Label>
      {files.map((f) => (
        <button
          key={f.format}
          type="button"
          className="btn ghost small"
          title={f.title}
          onClick={() => save(`${name}-${stamp(new Date())}.${f.format}`, f.format, f.build())}
        >
          .{f.format}
        </button>
      ))}
      {sheet && (
        <button
          type="button"
          className="btn ghost small"
          title={sheet.title}
          onClick={() => {
            const node = sheet.node();
            if (node) printSheet(node, sheet.heading);
          }}
        >
          .pdf
        </button>
      )}
    </div>
  );
}
