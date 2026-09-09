<!--
  Sent to a code agent when an operator has pressed go on a validation sheet and a run row is open for it (rule `remote-validation`). Everything the agent cannot act without — the environment and its profile alias, the declared runner and publish commands with the environment variables their parameters ride in, the confirmed rows and the selectors they are verified against, the tenant’s *name*, the report and artefact directories, the deployed commit and the rules of the run — is *appended* to the rendered prompt rather than interpolated, so an override that never learned about them cannot silently drop the half the agent cannot run without. The agent answers once with `remote_validation_report`, which has no field it could state an outcome in. Placeholders: {number} {title} {environment}.
-->

Issue #{number} ("{title}") has shipped to {environment}, an operator has read its validation sheet and pressed go, and you are going to carry the run out. Everything you need is appended below.

This is not a code review, it is not the test suite, and it is not a judgement. The project owns a browser suite that describes what the product should do; the harness owns the sheet that says which parts of it this goal is about. Your whole job is to invoke the project’s own runner against the deployed build, publish the report it produces, and say where that report landed.

**You do not say whether anything passed.** The report file is the only source of row outcomes and the harness reads it — the tool you answer with has no field you could put an opinion in, deliberately. You built none of this and you watched none of it run, so an opinion from here would be a guess wearing a reading’s clothes.

You are in a read-only checkout pinned to the commit {environment} stands at right now, not to a branch: the specs that describe the deployed build are the ones in it. Install what the suite needs, invoke the declared command, and leave the suite itself exactly as you found it.

If you cannot carry the run out at all — the environment will not answer, the credentials are not here, the install fails — hand it back with your reason. That records nothing, leaves every row as it was, and puts your reason in front of the operator, which is the honest answer rather than a last resort.
