import { useState } from 'react';
import { SKINS, readStoredSkinId, storeSkinId, resolveSkin } from './registry.js';

/**
 * The skin switch. Shared rather than skin-owned, so a half-built skin can never
 * be the one you cannot escape from — every skin embeds this, wherever it likes.
 *
 * Applying is a full reload rather than a re-render. A skin owns its whole tree,
 * so switching unmounts everything and drops the websocket subscription and the
 * accumulated transcript buffer anyway; a reload does the same thing honestly, in
 * one line, and re-runs the pre-paint script that stamps `data-skin` so there is
 * no window where the DOM and the stylesheet disagree.
 */
export function SkinPicker() {
  const [current] = useState(() => resolveSkin(readStoredSkinId()).id);

  if (SKINS.length < 2) return null; // nothing to choose between

  return (
    <label className="skin-picker" title="Change how the cockpit looks">
      <span className="visually-hidden">Skin</span>
      <select
        className="chip"
        value={current}
        onChange={(e) => {
          storeSkinId(e.target.value);
          window.location.reload();
        }}
      >
        {SKINS.map((s) => (
          <option key={s.id} value={s.id} title={s.description}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}
