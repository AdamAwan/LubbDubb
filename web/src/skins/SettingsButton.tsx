/**
 * The cog. Shared and skin-embedded for {@link SkinPicker}'s reason — it is now
 * the way *to* the skin picker, so a skin that failed to draw it would be one you
 * could not leave.
 *
 * Presentational and nothing else: the modal it opens reads `/api/config`, which
 * a skin may not do (`test/cockpitSkins.test.ts` asserts no skin imports the api
 * client), so the modal hangs off the shell and this only flips a flag through
 * `CockpitActions` — exactly the arrangement `viewPlan` uses for `PlanModal`.
 */
export function SettingsButton({ open, onOpen }: { open: boolean; onOpen: (open: boolean) => void }) {
  return (
    <button
      className="chip settings-cog"
      title="Settings — the running config and how the cockpit looks"
      aria-label="Settings"
      aria-expanded={open}
      onClick={() => onOpen(!open)}
    >
      ⚙
    </button>
  );
}
