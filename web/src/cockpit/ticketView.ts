/**
 * Which layout the tickets tab opens on, remembered across sessions.
 *
 * ## Why the preference is in `localStorage`
 *
 * Beside the theme and the notification preference, and for their reason exactly:
 * it is a property of *this browser*, not of the harness. Two people on one
 * deployment want different answers, and a server-side setting would make one of
 * them wrong.
 *
 * ## Why it is not simply a {@link Place} field
 *
 * It is one — `?view=` — and that stays true: a view switched and stepped back out
 * of has to come back, and a link somebody sends has to open on the view they were
 * looking at. What is stored here is only the **default** the parser falls back to
 * when the URL says nothing, so a bare `?tab=tickets` means "the one I use". The
 * two are the same mechanism the theme uses to keep one spelling per place: the
 * remembered view is the omitted value, so an operator who prefers the table gets
 * `?view=table` written into links and the reader of a bare URL still gets cards.
 *
 * The remembered value is read **once, at mount** (`useNavigation`) and frozen for
 * the life of the page, never re-read after a switch. Re-reading would make the
 * switch itself produce the same query string as the place before it, and
 * `useNavigation` pushes nothing when the query is unchanged — the back button
 * would have no entry to undo the switch with.
 *
 * → docs/spec/17-cockpit.md#the-view-is-remembered
 */

/** The tickets tab's two layouts. */
export type TicketView = 'table' | 'card';

/**
 * The board, which is what an operator who has never touched the toggle gets: the
 * columns are the tracker's own states, so the tab opens saying where the work has
 * got to rather than asking the reader to read a date column for it (#714).
 */
export const DEFAULT_TICKET_VIEW: TicketView = 'card';

/** The stored key, namespaced like `lubbdubb.theme` beside it. */
const TICKET_VIEW_KEY = 'lubbdubb.ticketView';

/**
 * Parse a stored view, falling back to the default on anything unreadable.
 *
 * Split out from {@link loadTicketView} so it is testable in node, which has no
 * `localStorage`, and validated on the way in the way `readThemePrefs` is: a value
 * from a build that spelled the views differently is junk, and the answer to junk
 * is the default.
 */
export function readTicketView(raw: string | null): TicketView {
  return raw === 'table' || raw === 'card' ? raw : DEFAULT_TICKET_VIEW;
}

export function loadTicketView(): TicketView {
  try {
    return readTicketView(localStorage.getItem(TICKET_VIEW_KEY));
  } catch {
    return DEFAULT_TICKET_VIEW;
  }
}

export function saveTicketView(view: TicketView): void {
  try {
    localStorage.setItem(TICKET_VIEW_KEY, view);
  } catch {
    // A browser refusing storage (private mode, quota) costs the preference its
    // durability, not the session its view.
  }
}
