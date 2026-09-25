export const WORK_ITEM_LINKS_SCHEMA = `
-- Pull requests the harness has already linked to their work item (see
-- WorkItemLinkStore). Stored because neither the world nor the other rows here
-- answer it: an operator may delete a link they judged wrong, and re-deriving from
-- the world would write it straight back every pulse; and linkedPrNumber names only
-- the *last* pull request to cross-reference an item, so on a plan whose parts each
-- open one, the earlier parts read as unlinked however many links really exist.
CREATE TABLE IF NOT EXISTS pr_work_item_links (
  pr_number INTEGER PRIMARY KEY,
  work_item INTEGER NOT NULL,   -- what it was linked to, for the audit trail
  at        TEXT NOT NULL
);
`;
