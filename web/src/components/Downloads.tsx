import type { JSX } from 'react';
import { Label } from './label.js';
import { Button } from './button.js';

// → docs/spec/17-cockpit.md

type CsvCell = string | number | null;

function csvField(cell: CsvCell): string {
  if (cell === null) return '';
  const s = String(cell);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n');
}

type Format = 'csv' | 'json';

const MIME: Record<Format, string> = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json',
};

function stamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
}

const BOM = String.fromCharCode(0xfeff);

function save(filename: string, format: Format, text: string): void {
  const body = format === 'csv' ? BOM + text : text;
  const url = URL.createObjectURL(new Blob([body], { type: MIME[format] }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function printSheet(node: HTMLElement, heading: string): void {
  const sheet = document.createElement('div');
  sheet.id = 'print-sheet';

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
        <Button
          key={f.format}
          ghost
          size="small"
          title={f.title}
          onClick={() => save(`${name}-${stamp(new Date())}.${f.format}`, f.format, f.build())}
        >
          .{f.format}
        </Button>
      ))}
      {sheet && (
        <Button
          ghost
          size="small"
          title={sheet.title}
          onClick={() => {
            const node = sheet.node();
            if (node) printSheet(node, sheet.heading);
          }}
        >
          .pdf
        </Button>
      )}
    </div>
  );
}
