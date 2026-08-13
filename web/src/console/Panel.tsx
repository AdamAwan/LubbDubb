import { useEffect } from 'react';

/**
 * A full-surface panel with three ways out — the backdrop, the button and
 * Escape. A thing that covers the console must not have exactly one exit.
 */
export function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="cn-backdrop" onClick={onClose}>
      <section className="cn-panel" onClick={(e) => e.stopPropagation()}>
        <header className="cn-panel-head">
          <h2>{title}</h2>
          <button className="cn-btn" onClick={onClose}>
            Close
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
