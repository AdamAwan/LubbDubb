<!--
  Sent to a code agent to address the unhandled review comments on a PR — all of them, in one dispatch, since comments from a single review are related and answering them one at a time produces contradictory fixes. The threads themselves are appended after this text rather than interpolated, so an override cannot silently drop them, and after those the instruction to re-read them with world_read before finishing — a reviewer can add a thread or reword one while the agent works. {author} is the comma-joined list of thread authors and {comment} the first thread's body; both are kept filled so an override written against the older single-comment prompt still renders something true. Placeholders: {number} {branch} {author} {comment}.
-->

There is unaddressed review feedback on PR #{number} (branch {branch}), from {author}. Every unresolved thread is listed below.

Read all of them before you change anything. They usually come from one review pass, so they are related: a fix for one may already resolve another, or contradict it. Work out what the reviewer is asking for as a whole, then make one coherent set of changes.

For each thread, decide whether to fix the code or defend the current approach, and say which you did. If defending, prepare a concise reply naming the thread.
