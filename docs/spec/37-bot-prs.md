# 37 — Bot pull requests

`src/botPrs/`. The pull requests a dependency bot — Renovate, Dependabot — raises against the
repository, read and shown so that the week somebody spends triaging them gets shorter.

Every other pull request the harness reads is one it can act on: the fleet's own, or one a person put
on the operator ([07](07-pull-requests.md#whose-pull-request-is-it)). A bot's is neither. On the
default `ownWorkOnly` a bot's pull requests never reach the world at all
([15](15-integrations.md#what-a-snapshot-is-scoped-to)), and a deployment that turns the filter off to
see them hands the fleet every other author's work besides. So this is a **second, separate read**,
scoped to the authors a project names and to nothing else.

**A reading, and one write a person presses.** Nothing under `src/dispatcher/` reads it, no rule
dispatches for a bot pull request, and nothing is written to the store. The one thing written to the
provider is [a claim](#taking-one-on), and only from the button. The three states a row is meant to carry
— _manual_ (leave it alone, the default), _merge_ (set autocomplete and see it through) and _test_
(exercise the update locally before it goes in) — are **not yet built**; this document describes the
read and the tab they will sit on.

## Configuration

`botPrs.authors` (`string[]`, default `[]`): regular expressions over the author the provider reports
— the login on GitHub, the unique name **or** the display name on Azure DevOps, since a build-service
identity's unique name is rarely what anybody knows it by. One that will not compile is skipped
rather than thrown. An empty list, or one that compiles to nothing, turns the read off and the tab out
of the nav.

It belongs in `lubbdubb.project.json`: which bots raise pull requests is a fact about the repository,
and every clone should list the same ones. The read always targets the repository the harness is
configured for — there is no per-block repository list, because a second repository means a second set
of provider coordinates and credentials the rest of the harness does not have.

It is deliberately **not** `review.machineAuthors`. That list answers _is this commenter a person_ for
the review readings ([18](18-observability.md#telling-a-person-from-a-machine)) and defaults to
`\[bot\]$`, which on GitHub would sweep in every app that ever opened a pull request. Naming a bot here
is naming work to be tended; naming one there is classifying a voice.

## The read

`BotPrReadable.listBotPullRequests(authors)` (`src/integrations/integration.ts`) is an optional
capability, implemented by the GitHub, Azure DevOps and fake source-control integrations and routed by
`CompositeConnector`, which concatenates every capable integration's list. Each provider reuses its
own open-pull-request list call **unfiltered by `prAuthor`**, filters it by `authors`, and reads CI for
what survives — GitHub's combined status and check runs on the head, Azure's blocking build and status
policy evaluations. The body is the list endpoint's; on Azure that is truncated, which is enough,
because what is read from it is Renovate's table at the top.

`BotPrReader` (`src/botPrs/reader.ts`) sits in front of it on `System.botPrs`:

- A reading is **reused for 60 seconds**, and concurrent reads share one call, so a cockpit left open
  on the tab costs one provider sweep a minute rather than one per viewer.
- A failed read is recorded through `errors.record` and returns the **last good rows** with `error`
  set, so a provider blip reads as stale rather than as an empty repository.
- `configured: false` is returned without calling the provider when no pattern is usable.

## Taking one on

A dependency rota fails in one way above all: two people fix the same bump while a third sits
untouched. So each row carries **who has taken it on** — `reviewers`, Azure's _optional_,
individually named reviewers and GitHub's assignees — and whether that includes the credential the
harness reads with (`viewerReviewing`). A required reviewer is a branch policy's doing, not somebody
volunteering, and a group is nobody in particular, so neither is listed.

**The record of ownership is the provider's, never the harness's.** Claiming is
`BotPrClaimable.claimBotPr(prNumber)`, which puts the credential's own identity on the pull request —
`addPullReviewer` with the id `viewerId()` reads from Azure's `connectionData`, as an optional reviewer
with no vote; `addPullAssignee` with the viewer's login on GitHub. Nothing is stored locally, so a
teammate claiming from Azure's own page, from their own harness, or from this tab all read the same
way to everyone, and there is no second list to drift from the first.

`BotPrReader.claim` refuses a number that is **not in the current bot reading** (404) — the route is not
a general way to put yourself on any pull request — and one you are already on (409). A provider that
cannot name the viewer adds nobody and says so, rather than guessing an identity. A claim that lands
drops the cached reading, so the next read shows it.

## Reading the update

`readDependencyUpdate(title, body)` (`src/botPrs/dependencyUpdate.ts`) is pure, and turns a row into a
`DependencyUpdate`: the package, the version it goes from and to, and whether the jump is `major`,
`minor` or `patch`. In order:

1. A kind the pull request **states** — a `(major)` suffix on the title, or an `Update` column in the
   body's table — is taken as stated.
2. Otherwise the first `` `from` -> `to` `` (or `→`) pair in the body is compared on its leading
   numeric parts.
3. Otherwise a title naming a lone major (`to v17`) is `major`, because that is the only shape
   Renovate gives a major by default.
4. Anything else is **`unknown`**, drawn in its own group. A grouped update, lock-file maintenance or
   a title in a shape nobody taught it is never guessed into a bucket, because a guess of _patch_ is
   exactly the one that tells somebody they need not look.

## The tab

`web/src/components/BotPrsPage.tsx`, tab `bots`, labelled **Bot PRs**, off `GET /api/bot-prs`
([16](16-http-api.md)). It sits in the nav beside Insights when `CockpitConfig.botPrs` is true —
`botPrs.authors` is non-empty — and is reachable by address either way, where it explains the key it is
missing.

It draws, top to bottom: a strip saying how many are open, how many are failing CI, how many are
majors, and when the oldest was opened — or that nothing needs you — and then the rows grouped major,
minor, patch, unclassified, each with its package versions, age and CI state, its optional reviewers
— or _nobody yet_ — and **Add me**, which is the claim above; a row you are on says so instead. The
strip also counts the rows nobody has taken and the ones that are yours. Each row links to the pull
request on the provider. Links go **out**, not through `<Ref>`: a bot pull request is in no world
snapshot, so a harness page for one would open on nothing. It re-reads once a minute.
