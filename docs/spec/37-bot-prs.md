# 37 — Bot pull requests

`src/botPrs/`. The pull requests a dependency bot — Renovate, Dependabot — raises against the
repository, read and shown so that the week somebody spends triaging them gets shorter.

Every other pull request the harness reads is one it can act on: the fleet's own, or one a person put
on the operator ([07](07-pull-requests.md#whose-pull-request-is-it)). A bot's is neither. On the
default `ownWorkOnly` a bot's pull requests never reach the world at all
([15](15-integrations.md#what-a-snapshot-is-scoped-to)), and a deployment that turns the filter off to
see them hands the fleet every other author's work besides. So this is a **second, separate read**,
scoped to the authors a project names and to nothing else.

**A reading, one write a person presses, and a paragraph of advice.** The one thing written to the
provider is [a claim](#taking-one-on), and only from the button. The one thing the fleet does is
[read them for risk](#the-risk-summary): one desk agent over a batch, whose verdict is drawn beside each
row and read by no rule. Nothing is approved, merged or posted to a pull request from it — unless a person
[tags it for watching](#working-one-as-the-fleets-own), which hands it to the fleet like its own. The three
states a row is meant to carry — _manual_ (leave it alone, the default), _merge_ (set autocomplete and
see it through) and _test_ (exercise the update locally before it goes in) — are **not yet built**.

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

`botPrs.riskSchedule` (`string`, default `''`): a five-field cron expression, in the harness's local
time, for when [the risk summary](#the-risk-summary) runs by itself. Empty leaves only the button.

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

Each row also carries its **head commit** (`headSha`) — GitHub's head SHA, Azure's
`lastMergeSourceCommit` — because a risk verdict is a verdict on one head.

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

## Working one as the fleet's own

**Tagging a bot pull request with the watch label hands it to the fleet**, exactly like one of its own: CI
fixes, base updates, review replies and the merge path all fire on it. Two things make that true:

- **The snapshot admits it.** Under `ownWorkOnly` the provider's author-or-assignee filter also lets
  through a pull request whose author matches `botPrs.authors` and that carries the watch label
  ([15](15-integrations.md#what-a-snapshot-is-scoped-to)). An unwatched bot pull request stays out of the
  world, as before.
- **It is not somebody else's.** The provider sets `PullRequest.botAuthored`, and `isSomeoneElsesPr`
  answers no for it, so `Harness.runCycle` does not hide it
  ([07](07-pull-requests.md#whose-pull-request-is-it)).

It is still **not** `isOurPr`: the harness does not rename it, reap its branch or link it to a work item,
because the bot owns those. The watch label is the only opt-in, and nothing seeds it — a person adds it.

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

## The risk summary

What a person triaging a dependency rota most wants is to be told which of these they can approve on a
green build without opening them. So one desk agent reads a **batch** of them and says, for each, how
risky it is to merge — `low`, `medium` or `high` — and a sentence on why. It is deliberately **one agent
per batch, not one per pull request**, and deliberately **not a review**: what each needs is a minute and
a paragraph, and twenty agents each re-reading the same instructions to write one line is the spend
this exists to avoid.

**Advice, and nothing else.** No rule reads a verdict. Nothing is approved, merged, labelled or posted to
the provider from it, and a verdict is never a reason the harness does anything. It is drawn beside the
row on the tab, and that is the whole of its effect — so the worst a wrong verdict can do is be read by a
person who then opens the pull request anyway. That is also why prompt injection through a release note
is contained rather than prevented: the agent's output reaches a person and no machine.

### What "unread" means

A verdict is keyed on **(pull request, head commit)** in `bot_pr_risks`. A head with a row has been read;
a bot that rebases or bumps again has produced a head that has not, and the row's verdict stops being
drawn — a verdict on the old diff is no verdict on the new one. What is eligible is every row whose
update is classified (`major`, `minor` or `patch` — [`unknown`](#reading-the-update) is left out, since
nobody can say what it is), that has a head, and whose head has no verdict. Majors are **included**:
they are the ones most worth a sentence.

A run takes at most **20**, majors first, then minors, then patches, lowest number first within each
(`RISK_BATCH_LIMIT`, `riskOrder`). What does not fit waits for the next run; since what was read is
never re-read, a backlog drains in order.

### When it runs

`BotPrRiskDesk` (`src/botPrs/riskDesk.ts`, on `System.botPrRisks`) opens a run two ways:

- **On a schedule.** It is a pulse pass beside `schedules` ([04](04-harness-cycle.md)), firing when
  `botPrs.riskSchedule` comes round. The next firing is held in memory, computed from the moment the
  harness first saw the expression, so a firing missed while the harness was down is **not made up** on
  boot — the next slot is. An expression that never fires is recorded through `errors.record` once and
  schedules nothing.
- **On a press.** `POST /api/bot-prs/risk` ([16](16-http-api.md)), the tab's **Summarise risk** button.

Either way the desk lists the bot pull requests **itself**, straight from the provider rather than through the reader's minute of reuse, because the heads a run pins are the ones its verdicts are written against, and it needs the bodies the reading does not ship. On the schedule the pulse does not wait for the assembly ([04](04-harness-cycle.md)); a press does, and answers with how many it took. Nothing is opened when nothing is unread. **One run is out at a time**, and that is the
store's: a partial unique index over `bot_pr_risk_runs` in `pending` or `dispatched` refuses a second, so
it holds across a restart rather than only within one. A press while one is out is a 409.

### What the agent is given

Everything the agent reads is fetched by the harness when the run opens and **appended** to the rendered
`bot-pr-risk` prompt as the run's `briefing` (`riskBriefing`, `src/botPrs/riskBrief.ts`) — never
interpolated, for the reason every appended brief is ([05](05-dispatcher.md#prompt-templates)), and never
fetched by the agent, which has no checkout and needs none. Per pull request:

- the package, its versions and the kind of jump, and CI on the head;
- **the release notes, where they can be found**: first the pull request's own body — Renovate's
  `### Release Notes` section, Dependabot's `<summary>Release notes</summary>` block — and failing that,
  on a GitHub deployment, the release in the dependency's own repository (the first `github.com` link
  in the body that is no bot's), tried at `v<to>`, `<to>` and `<package>@<to>`. Neither found reads
  _None found_, and the prompt tells the agent to say so rather than guess. A release read that fails is
  recorded and reads as none, rather than sinking the batch;
- **the changed files** (`BotPrDetailReadable.readBotPrDetail`). On GitHub, with the provider's
  patches. Azure DevOps serves no patch text, so the harness takes the diff itself: the latest
  iteration names the changed paths and the two commits it sits between — the merge base
  (`commonRefCommit`) and the head (`sourceRefCommit`) — and each changed file is read at both through
  the items API and diffed locally (`lineDiff`, `src/botPrs/lineDiff.ts`: a unified diff with three
  lines of context). That is two reads per file, so it is bounded at **ten files per pull request**
  and never spent on a lockfile; a file past that, or whose changed stretch — what is left once the shared head and tail are trimmed — runs past two thousand lines a side, keeps its path
  and loses its patch — as does one whose read fails, which is recorded rather than sinking the batch. A renamed or moved file is read at its old path on the base. Each pull request's files are read one after another, so a batch of twenty is twenty readers and not four hundred requests at once. The body is read whole there too, since the listing's is truncated. **A
  lockfile's contents are always left out**, with its path and
  line counts kept: it is most of a bot's diff and none of its meaning. Patches share a budget per pull
  request, and release notes are capped, so one enormous changelog cannot crowd out the rest of the
  batch.

The briefing is written onto the run row, so a restart re-dispatches the same text rather than
re-reading providers, and what the agent was shown is on file beside what it said.

### The dispatch — rule `bot-pr-risk`

The rule ([05](05-dispatcher.md#the-rule-book)) puts one desk agent on the pending run at origin
`bot-prs:risk:<run id>`. The dispatch claims the row (`pending` → `dispatched`) through the executor, as
a remote validation run is claimed. There is no cooldown budget and no escalation: a run is one
assembly, re-proposed each pulse until it dispatches, and it sits at the bottom of the book with the
Feature desks because it produces no work.

The agent answers with `bot_pr_risk` ([11](11-mcp-tools.md)) once per pull request. The tool resolves
the run from the task's origin, refuses a number outside the batch, and writes the verdict against the
head **the agent was shown**, not whatever the head is now — so a push that lands mid-run leaves the new
head unread. Calling it again for the same pull request replaces the verdict. It answers with the
numbers still to do.

The run **settles** when its agent's task is no longer active, however it ended — the desk's pulse pass
checks. A pull request the agent never answered for simply has no verdict and goes in the next run.

### On the tab

A row with a verdict on its current head draws the risk as a tag and the summary beside it. Above the
groups, the **Summarise risk** button, and a line saying either that a run is out, when the schedule
next fires, or that there is no schedule and which key sets one.
