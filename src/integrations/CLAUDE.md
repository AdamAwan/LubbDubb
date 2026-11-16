# CLAUDE.md — `src/integrations/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Identity

- **`userId` gates pickup, so a provider that cannot report label authorship stops the fleet silently.** With it set,
  `issuePickup.ts` reads `labelsAddedByViewer` instead of `labels`; a provider that never populates that field resolves
  every issue's labels to `[]` and **nothing is ever picked up**, with nothing red. `FakeIssuesIntegration` mirrors
  `labels` into it for that reason. → [02](../../docs/spec/02-configuration.md#userid), [06](../../docs/spec/06-issue-pickup.md)

## Review threads

- **Whether a review reply is the fleet's is a _record_, never the reply's author.** `ours` and `answered` read
  `pr_replies_sent` (`src/store/prReplies.ts`) — one row per reply that actually left through `sink.postPrReply` — and
  `config.userId` is the credential the harness posts under, which on a single-operator deployment is the operator's own
  account. Compare against it and the operator's follow-up on their own thread reads as the harness's: `answered` folds
  to `PrComment.handled`, the only bit rule `pr-review-comment` reads, so their comment is marked as work already done
  and never dispatched for. Both providers must read the same record through `src/pr/prThreads.ts`, and every
  uncertainty — no comment ref, a reply from before the table — leaves the thread **unanswered**. →
  [07](../../docs/spec/07-pull-requests.md#attribution-is-a-record-never-an-identity)

## Provider seams

- **Extending a provider means adding to the `*Api` interface _and_ its scripted fake in the same
  change.** All provider HTTP is behind that seam; the tests touch no network.
