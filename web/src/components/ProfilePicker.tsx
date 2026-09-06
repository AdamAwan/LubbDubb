import type { JSX } from 'react';
import { ControlSelect } from './controls.js';

// → docs/spec/17-cockpit.md

export function ProfilePicker({
  profiles,
  value,
  defaultProfile,
  inheritLabel,
  disabled,
  onPick,
}: {
  profiles: { name: string; description: string }[];
  value: string | null;
  defaultProfile: string | null;
  inheritLabel: string;
  disabled?: boolean;
  onPick: (profile: string | null) => void;
}): JSX.Element | null {
  if (profiles.length === 0) return null;
  const chosen = value !== null && profiles.some((p) => p.name === value);
  return (
    <ControlSelect icon="layers">
      <select
        className={`cn-profile ${chosen ? 'cn-profile-set' : ''}`}
        value={chosen ? value : ''}
        disabled={disabled === true}
        onChange={(e) => onPick(e.target.value === '' ? null : e.target.value)}
        title={
          chosen
            ? (profiles.find((p) => p.name === value)?.description ?? '')
            : `${inheritLabel}${defaultProfile === null ? '' : ` — runs on each rule's own profile, or "${defaultProfile}"`}`
        }
      >
        <option value="">
          {inheritLabel}
          {defaultProfile === null ? '' : ` (${defaultProfile})`}
        </option>
        {profiles.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
    </ControlSelect>
  );
}
