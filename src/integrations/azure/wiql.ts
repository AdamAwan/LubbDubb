// → docs/spec/15-integrations.md

export function buildOpenWorkItemQuery(tag?: string, assignedTo?: string): string {
  return workItemQuery(["[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved')"], tag, assignedTo);
}

export function buildWorkItemHistoryQuery(since: string, tag?: string, assignedTo?: string): string {
  return workItemQuery([`[System.ChangedDate] >= '${wiqlDate(since)}'`], tag, assignedTo);
}

/** Open and closed alike: a closed bug under an error key is what the tracker lock reads as "fixed, and back". */
export function buildTagsQuery(tags: readonly string[]): string {
  const any = tags.map((t) => `[System.Tags] CONTAINS '${t.replace(/'/g, "''")}'`).join(' OR ');
  return `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND (${any}) ORDER BY [System.Id] ASC`;
}

function workItemQuery(extra: string[], tag?: string, assignedTo?: string): string {
  const clauses = ['[System.TeamProject] = @project', ...extra];
  if (tag) clauses.push(`[System.Tags] CONTAINS '${tag.replace(/'/g, "''")}'`);
  if (assignedTo) clauses.push(`[System.AssignedTo] = '${assignedTo.replace(/'/g, "''")}'`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.Id] ASC`;
}

function wiqlDate(iso: string): string {
  return iso.replace(/'/g, '').replace('T', ' ').replace(/\.\d+/, '').replace(/Z?$/, 'Z');
}
