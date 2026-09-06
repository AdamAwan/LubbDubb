// → docs/spec/17-cockpit.md

function pickerHex(value: string): string {
  const hex = value.startsWith('#') ? value.slice(1) : '';
  if (hex.length === 3 || hex.length === 4) return `#${[...hex.slice(0, 3)].map((c) => c + c).join('')}`;
  if (hex.length >= 6) return `#${hex.slice(0, 6)}`;
  return '#000000';
}

function withAlphaOf(previous: string, picked: string): string {
  const hex = previous.startsWith('#') ? previous.slice(1) : '';
  if (hex.length === 8) return picked + hex.slice(6);
  if (hex.length === 4) return picked + hex[3]! + hex[3]!;
  return picked;
}

export function ColourField({
  value,
  label,
  valid,
  onChange,
}: {
  value: string;
  label: string;
  valid?: boolean;
  onChange: (next: string) => void;
}): React.JSX.Element {
  return (
    <span className="cf">
      <input
        type="color"
        className="cf-col"
        aria-label={label}
        value={pickerHex(value)}
        onInput={(e) => onChange(withAlphaOf(value, e.currentTarget.value))}
      />
      <input
        type="text"
        className={`cf-hex${valid === false ? ' bad' : ''}`}
        aria-label={`${label}, as hex`}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </span>
  );
}
