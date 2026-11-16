# Proposal — video proof for several goals at once

**Status: under discussion.** Recording is built on both channels: a local validation records itself
([32](../spec/32-local-validation.md#the-recording)), and so does a remote validation run
([36](../spec/36-remote-validation.md#the-runs-recording)). Videos seek
([16](../spec/16-http-api.md#byte-ranges)) and age out
([14](../spec/14-persistence.md#recording-retention)). What follows is not built.

## The problem

There is one dev environment per machine, so local recordings queue one goal at a time. A hosted
environment could take many goals at once, but one live run per `(environment, tenant)` is the lock
([36](../spec/36-remote-validation.md#uniqueness-is-environment-tenant-enforced-in-sql)), and a run is
one goal's sheet — so goals that arrived together still record one after another.

## Direction

**Batch goals into one run without loosening the lock.** Goals that arrived in the same environment
share one run — one agent, one video, chaptered by goal and then by check — and a second tenant, where
configured, is a second run in parallel.

## Known problems to settle first

- A batched run's failure must not be read as every goal's failure: readings stay per check, and the
  video is only evidence.
- A run row names one goal (`remote_runs.goal_ref`); a batch needs either a run per goal claimed by one
  agent, or a run that names several. The first keeps every reader of the row as it is.
- Whether the reviewer outside the cockpit sees it. Posting to the pull request reaches outside, so it
  needs an operator's say-so per post, and the provider has no simple way to attach a video.
