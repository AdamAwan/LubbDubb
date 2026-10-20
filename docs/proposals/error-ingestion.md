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

Every fleet working this app reads the same two resources, but each knows only its **own** goals. So
the error that fleet A's goal caused may first be seen by fleet B, which has no candidate to link it to.
The cross-fleet pool ([28](../spec/28-cross-fleet-pool.md)) is the way fleets already see each other,
and it fits with care:

- **What would cross:** per environment and fingerprint, which of this fleet's goals it links the group
  to (and how), and the ticket filed for it, if any. Each fleet publishes only its own document — one
  writer per namespace, whole-document put, as today.
- **What it gives:** fleet B's cockpit shows "linked by fleet A to goal 412, bug #9031 filed" beside
  the group, so nobody files the same bug twice and the week-wide window is narrowed by whoever owns
  the change.
- **What it must not do:** the pool is read by a page and by nothing else. Nothing from it files,
  dispatches, or links on its own; it is drawn, and a person acts.

Two tensions with the pool's rules, to settle before building:

- **The pool carries numbers over closed vocabularies and no free text.** A fingerprint is close to a
  key; an exception title or a stack frame is not. The proposal is that the fingerprint (hashed if
  `problemId` reads as sensitive), a goal ref and a ticket ref cross — and the title, message and frames
  never do. Each fleet reads those itself from App Insights.
- **The digest is a daily rollup**; a "someone already filed this" note wants to be fresher than a day.
  Either error links get their own document kind with a shorter publish clock, or the pool is the
  wrong home and this is a tracker search instead (the filed bug carries the fingerprint, and a fleet
  looks for it before offering to file).

## In the cockpit

- **Errors per environment**: the moved groups, with first and last seen and a link to App Insights.
- **On the goal card**: "2 new errors on test since this arrived", with how each link was made.
- **File bug**: through `ticketFiler` as a Bug related to the goal's story, with frames and title only
  (messages often carry user data). The fingerprint goes in the ticket so other fleets can find it.
- **Promote to watch**: turn the group into a declared `signal` check (`tolerate: 0`) on the fixing
  goal, so the existing watch confirms it is gone after the fix arrives.

Filing is always a click. An automatic filer on a weekly live deploy of a week's changes would flood
the tracker.

## Phases

1. `errors` command, contract, grouping and states, per-environment panel. Read-only.
2. Linking by window, frames and test-before-live, on the goal card.
3. File bug (with fingerprint) and promote to watch.
4. Cross-fleet links through the pool, once the two tensions above are settled.

## Open questions

- Does the build version map to a commit (a tag, a build record)? If not, the window comes from the
  probe's deployed SHA and the deploy time, which is fine but needs `at` declared on both environments.
- Is `problemId` safe to cross between fleets as is, or hashed?
- Pool document or tracker search for "already filed"?
