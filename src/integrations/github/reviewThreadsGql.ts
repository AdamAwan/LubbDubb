// → docs/spec/15-integrations.md

export const RESOLVE_THREAD_MUTATION = `
  mutation ($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { isResolved }
    }
  }
`;

export const REVIEW_THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            comments(first: 1) { nodes { databaseId } }
          }
        }
      }
    }
  }
`;

export interface GqlThread {
  nodeId: string;
  rootCommentId: number;
  isResolved: boolean;
}

interface GqlThreadNode {
  id?: string | null;
  isResolved?: boolean;
  comments?: { nodes?: Array<{ databaseId?: number | null }> };
}

export interface GqlReviewThreadPage {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<GqlThreadNode | null>;
      };
    };
  };
}

export function threadsOnPage(nodes: Array<GqlThreadNode | null>): GqlThread[] {
  const threads: GqlThread[] = [];
  for (const node of nodes) {
    if (!node) continue;
    const rootCommentId = node.comments?.nodes?.[0]?.databaseId;
    if (typeof rootCommentId !== 'number' || typeof node.id !== 'string') continue;
    threads.push({ nodeId: node.id, rootCommentId, isResolved: node.isResolved === true });
  }
  return threads;
}
