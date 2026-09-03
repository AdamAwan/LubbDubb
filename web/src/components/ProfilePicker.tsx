import type { JSX } from 'react';
import { ControlSelect } from './controls.js';

/**
 * Which model profile a goal or a plan part runs on, as a control (issue #342).
 *
 * One component for both grains because they are the same decision asked about
 * different objects, and two would be two answers to "what does not-the-default
 * look like". The rules it keeps:
 *
 * - **Loud when it is not the default.** A pin is a departure from the fleet's
 *   policy and costs or saves real money; drawn like every other select, it is a
 *   decision nobody can see they made. The class carries that, never a colour
 *   chosen here.
 * - **The empty option is not a profile.** "Inherit" and "not pinned" are states,
 *   not choices between profiles: a cleared part follows its goal, so re-pinning
 *   the goal later moves it, while a part *named* the goal's current profile
 *   stays where it was put.
 * - **It is dressed by the control kit, not by itself.** `ControlSelect`
 *   ([`controls.tsx`](./controls.tsx)) draws the glyph, the caret and the height,
 *   the same three a `<select>` otherwise takes from the platform — so the pin
 *   matches the controls beside it on the goal header, in the plan sheet and in
 *   Up next, and matches them again the next time the kit changes. What this
 *   component keeps is the *options*.
 * - **The options come from the server.** `config.profiles` arrives ordered by
 *   the operator's own `rank`, cheapest first, and the cockpit never re-sorts it
 *   — a second opinion about which profile is deeper is exactly what `rank`
 *   exists to prevent.
 */
export function ProfilePicker({
  profiles,
  value,
  defaultProfile,
  inheritLabel,
  disabled,
  onPick,
}: {
  profiles: { name: string; description: string }[];
  /** The profile named on this object, or null for inherit/unpinned. */
  value: string | null;
  /** What an unpinned dispatch falls back to, named in the empty option so the fallback is legible. */
  defaultProfile: string | null;
  /** What choosing nothing means here — "Not pinned" on a goal, "Inherit" on a part. */
  inheritLabel: string;
  disabled?: boolean;
  onPick: (profile: string | null) => void;
}): JSX.Element | null {
  // Nothing to choose between is not a choice with no options: a deployment with
  // no `agentModels` draws no control at all rather than an empty one.
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
