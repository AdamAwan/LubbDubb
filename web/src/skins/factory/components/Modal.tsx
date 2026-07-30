import { useEffect, type JSX, type ReactNode } from 'react';
import { Icon, type IconName } from './Sprite.js';

/**
 * Which panel is in front, if any.
 *
 * One value rather than a boolean per modal: four booleans admit sixteen states,
 * fifteen of which are wrong, and two panels in front at once is not something
 * this floor can draw.
 */
export type FactoryModal = 'production' | 'alerts' | 'faults' | 'blueprints' | 'findings';

/**
 * A panel opened over the floor.
 *
 * The floor's own panels are sized for a rail, which is the right size for the
 * reading an operator glances at and the wrong one for a picture they went
 * looking for. This is where the second kind goes, and it deliberately borrows
 * the card's chrome rather than inventing a second one — a modal on this floor
 * is a panel that happens to be in front, not a different surface.
 *
 * Closing is the backdrop, the button and Escape, because a thing that covers
 * the floor must not have exactly one exit.
 */
export function Modal({
  title,
  icon,
  note,
  onClose,
  children,
}: {
  title: string;
  icon: IconName;
  note?: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fx-modal-back" onClick={onClose}>
      <div
        className="fx-modal fx-card fx-bev"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fx-head">
          <div>
            <Icon name={icon} />
            <h2>{title}</h2>
          </div>
          <div className="fx-modal-top">
            {note && <p className="fx-note">{note}</p>}
            <button type="button" className="fx-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
