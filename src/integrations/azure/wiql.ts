// → docs/spec/15-integrations.md

export function buildOpenWorkItemQuery(tag?: string, assignedTo?: string): string {
  return workItemQuery(["[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved')"], tag, assignedTo);
}

export function buildWorkItemHistoryQuery(since: string, tag?: string, assignedTo?: string): string {
  return workItemQuery([`[System.ChangedDate] >= '${wiqlDate(since)}'`], tag, assignedTo);
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
