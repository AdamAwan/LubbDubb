# Proposal — errors nobody declared

**Status: under discussion.** Nothing here is built. It sits between environment health
([24](../spec/24-environments.md#is-the-environment-well)) and the post-deploy watch
([29](../spec/29-post-deploy-watch.md)): the watch reads checks a plan **declared**; this reads the
errors **nobody declared**, groups them, watches them change, and links them to the work that
probably caused them.

The first user is an app on Azure with App Insights. The harness stays generic: it knows a command and
an output contract, never Kusto.

## The deployment it is shaped by

- **Two App Insights resources**: one for the whole live environment, one for test. Each is one
  environment's `errors` command; live's several regions stay one band through `group`
  ([24](../spec/24-environments.md#groups)), so a live error is read once, not per region.
- **Both are monitored.** Test is the early warning; live is the loud one. An error group seen on test
  and later on live is one group on two environments, not two findings.
- **The telemetry carries a build version, and one build is up to a week of changes.** So version
  narrows an error to a deploy, not to a goal. Attribution cannot stop there — see
  [Linking](#linking-an-error-to-work).
- **Several LubbDubb instances work on this app**, and every one of them can read the same two
  resources. See [The pool](#several-fleets-one-app).

## The `errors` command

Same pattern as `health` and `observe`: the environment declares a command; the harness reads only a
fixed JSON shape from it.

```jsonc
{
  "name": "live",
  "at": "./scripts/deployed-sha.sh live",
  "group": "prod",
  "errors": { "list": "./scripts/ai-errors.sh live {since}" },
}
```

```jsonc
[
  {
    "fingerprint": "…",
    "title": "NullReferenceException in OrderService.Submit",
    "count": 42,
    "firstSeen": "…",
    "lastSeen": "…",
    "version": "2026.10.14.3",
    "operation": "POST /orders",
    "frames": ["src/Orders/OrderService.cs:118"],
    "link": "https://portal.azure.com/…",
  },
]
```

- App Insights is one script: `exceptions | where timestamp > datetime({since}) | summarize … by
problemId`. `problemId` is the fingerprint; `az monitor app-insights query` under a managed identity
  keeps the secret out of config.
- Three-valued like health: a failed query is `unknown`, never "no errors".
- Every query is bounded by `{since}`; an unbounded query counts old errors as new.

## Grouping and watching for change

A group is a fingerprint on an environment. The harness keeps a short history per group and gives it
one state, recomputed on each read:

| State      | Means                                                          |
| ---------- | -------------------------------------------------------------- |
| `new`      | first seen after the environment's latest deploy               |
| `returned` | absent for a quiet period, then seen again                     |
| `spiking`  | rate well above its own baseline from before the latest deploy |
| `steady`   | still happening at roughly its baseline — known noise          |
| `gone`     | not seen for a quiet period after being seen                   |

The cockpit draws `new`, `returned` and `spiking` and folds `steady` away. That is the "watch for
changes or new things": what an operator reads is what moved, not the error list. A minimum count and
an ignore list keep one-off noise out of `new`.

An error reading is **never a `WorldEvent`**: `deliveryHold` expires a delivery verdict on any world
event matching the goal, so readings filed as events would un-park delivered goals. Own table, like
arrivals.

## Linking an error to work

Because one build is a week, the build version gives a **window**, not an answer:

1. **The window.** The probe already knows the commit an environment ran before the deploy and the one
   it runs now. Every goal whose landing is in that range is a candidate — often a dozen.
2. **Frames against diffs (the narrowing step).** Match the top in-app frames to the files each
   candidate's landed diff touched. A frame in a file only one candidate touched is a strong link.
3. **Test before live.** A group that went `new` on test when goal X arrived there, and then on live in
   the weekly deploy, is X's — test deploys more often than live, so it narrows what live's week cannot.
4. **Operation to feature.** `POST /orders` → orders work. A hint only.
5. **Model triage, on a press.** The bug-investigation flow
   ([38](../spec/38-bug-investigation.md)) with the trace attached, for what 1–4 leave open.

A link is shown with how it was made ("frame match", "test arrival", "hint"), never as a bare claim.

## Several fleets, one app

Every fleet working this app reads the same two resources. Reading is cheap and stays per fleet. What
costs is a model investigation and a filed bug, and two fleets doing either for one error is the waste
to stop. **The tracker is the lock**: it is live, every fleet already reads it, and a filed bug is the
record of "someone has this".

### The key

`err:<project>:<hash>` — a short hash of the error's **fingerprint**, scoped by the project name the
pool already uses ([28](../spec/28-cross-fleet-pool.md#the-project-name)).

- **The fingerprint is the script's job**, and the contract says what it must be: stable across
  deploys, versions and environments, and free of line numbers, ids and user data. For App Insights
  that is `problemId` — exception type plus failing method — which is computed from the code, so the
  same fault reads the same on test and on live even though they are two resources.
- **Hashed** so the key is short, exact-match searchable, and carries no code or message text into the
  tracker's tag list.
- **Carried by the ticket, never by a prompt.** It is a field of `IssueCreateInput`, resolved by
  `ticketFiler` ([13](../spec/13-jobs-and-tickets.md#filing-a-ticket)): an Azure DevOps **tag**
  (`Tags CONTAINS` is exact) or, on GitHub, a marker line in the body (`"err:…" in:body`). Told to an
  agent instead, a bug filed without it is invisible to every other fleet, with nothing red.

### The search

Before a group's row offers **File bug** or **Investigate**, the fleet searches the tracker for its key:

| Found                    | The row shows                                                     |
| ------------------------ | ----------------------------------------------------------------- |
| an open bug              | "Filed: Bug #9031" — no File bug, no Investigate                  |
| a bug closed, error back | "Returned after Bug #9031 was fixed" — **Reopen** instead of File |
| nothing                  | File bug and Investigate                                          |
| the search failed        | `unknown`, and the buttons stay — never read as "nothing found"   |

- **Searched again at the press**, right before the create, so the window two fleets can both file in
  is seconds, not a poll interval. A duplicate that slips through is two bugs with one tag, which the
  next search shows side by side.
- **An investigation is claimed by its bug.** Investigate files the bug first (or uses the one found)
  and runs against it, so a second fleet sees "Filed" and does not start a second investigation.
- **Searches are batched**: one query per read for every group's key, not one per row.

### Where the key can miss

- **A refactor renames the failing method** → new `problemId`, new key, the group reads `new`. The
  frame match usually links it back to the change that moved it, and the row says so.
- **A bug filed by hand** carries no key. It is found only if someone adds the tag; the row cannot know.
- **Two faults one `problemId`** (one method, two causes) share a bug. Acceptable: the bug is about the
  method.

### The pool, later

The pool ([28](../spec/28-cross-fleet-pool.md)) is the wrong lock — its clock is a day — but it can
later show which fleet **linked** a group to which of its goals, which narrows the week-long window for
fleets that do not own the change. Only the key, a goal ref and a ticket ref would cross; titles,
messages and frames never do, since the pool carries no free text.

## In the cockpit

- **Errors per environment**: the moved groups, with first and last seen and a link to App Insights.
- **On the goal card**: "2 new errors on test since this arrived", with how each link was made.
- **File bug**: through `ticketFiler` as a Bug related to the goal's story, with frames and title only
  (messages often carry user data), tagged with [the key](#the-key).
- **Promote to watch**: turn the group into a declared `signal` check (`tolerate: 0`) on the fixing
  goal, so the existing watch confirms it is gone after the fix arrives.

Filing is always a click. An automatic filer on a weekly live deploy of a week's changes would flood
the tracker.

## Phases

1. `errors` command, contract, grouping and states, per-environment panel. Read-only.
2. Linking by window, frames and test-before-live, on the goal card.
3. The key on `IssueCreateInput`, the tracker search, File bug / Reopen / Investigate, promote to
   watch.
4. Cross-fleet links through the pool.

## Open questions

- Does the build version map to a commit (a tag, a build record)? If not, the window comes from the
  probe's deployed SHA and the deploy time, which is fine but needs `at` declared on both environments.
- Does the GitHub provider's search reach a body marker reliably enough, or does it need a label per
  key (labels are capped and clutter the repo)?
