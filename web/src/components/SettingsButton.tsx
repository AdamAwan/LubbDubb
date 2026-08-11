/**
 * The cog, embedded by the status bar.
 *
 * Presentational and nothing else: the modal it opens reads `/api/config`, which
 * `factory/` may not do (`test/factoryFloor.test.ts` asserts nothing there imports
 * the api client), so the modal hangs off the shell and this only flips a flag
 * through `CockpitActions` — exactly the arrangement `viewPlan` uses for
 * `PlanModal`.
 */
export function SettingsButton({ open, onOpen }: { open: boolean; onOpen: (open: boolean) => void }) {
  return (
    <button
      className="chip settings-cog"
      title="Settings — the running config, the CI policy and the prompt book"
      aria-label="Settings"
      aria-expanded={open}
      onClick={() => onOpen(!open)}
    >
      ⚙
    </button>
  );
}
