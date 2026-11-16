# Proposal — video proof on hosted environments

**Status: under discussion.** The first step is built: a local validation records itself
([32](../spec/32-local-validation.md#the-recording)). What follows is not.

## The problem

Judging a goal means looking at it working. A local validation now hands back a video with a chapter
per step, but there is one dev environment per machine, so local recordings queue one goal at a time.
A hosted environment can take many goals at once, and a remote validation run
([36](../spec/36-remote-validation.md)) already drives a browser there — on the same
`localValidation.browser` server, so the recording tools are already on offer. It just never records.

## Direction

- **Ask the remote run to record.** The same four steps the local briefing gives, appended to the run's
  briefing (`src/validation/remote/briefing.ts`), with a chapter per check by letter. The video lands
  in the run's `artefacts` directory beside its screens.
- **Serve and draw it on the sheet.** A route shaped like `/validation-captures/…` that names a run,
  not a file, and a player on the goal's validation sheet. The file name is read off a stored row, never
  taken from the request.
- **Several goals at once without loosening the lock.** One live run per `(environment, tenant)` stays
  ([36](../spec/36-remote-validation.md#uniqueness-is-environment-tenant-enforced-in-sql)). Instead,
  goals that arrived in the same environment are **batched into one run** — one video, chaptered by goal
  then check — and a second tenant, where configured, is a second run in parallel.
- **Range requests** on the file route, so a long recording can seek before it has loaded.
- **Retention.** Videos are large; delete them a fixed number of days after the run settles.

## Known problems to settle first

- A batched run's failure must not be read as every goal's failure: readings stay per check, and the
  video is only evidence.
- Whether the reviewer outside the cockpit sees it. Posting to the pull request reaches outside, so it
  needs an operator's say-so per post, and the provider has no simple way to attach a video.
