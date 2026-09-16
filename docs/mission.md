# Mission

LubbDubb exists to change what a software engineer spends their day on.

The old job was producing the change. The new job is **stating the goal, and judging the evidence** —
everything between those two belongs to the harness.

## The two ends the engineer keeps

**The goal.** An agent does what it is asked. That is the thing to trust, and it is not the same as
trusting its judgement: a ticket with a hole in it does not come back with a question, it comes back
with the hole filled in — plausibly, confidently, and wrong. Every gap left open is a decision handed
to something that was never told what you wanted. So the ticket is the bargain, and it does not move:
nothing here infers intent. Stating a goal for a reader who has the code but not your last three weeks
is the highest-leverage thing anybody does all day, which is why the appraisal gate refuses one that
is not, out loud, on the ticket.

**The verdict.** Work is not done because an agent says so. It is done when there is something to look
at: tests still green, logs clean over a window, a screenshot, a query result, a check somebody ran.
The harness's obligation is not to complete work but to **show that it did** — and silence never reads
as success.

## Review is triaged, not skipped

Companies require a human to read the code, and engineers are right to want to. That is not the cost.
**Undirected** review is the cost.

Most of a pull request will not be wrong — the interfaces, the data-access layer, the tests around
them. The risk is concentrated: a join, a branch of business logic, an authorisation change. A reviewer
who spreads an hour evenly over the diff spends most of it where nothing was going to be found, and
reaches the dangerous part tired.

So the harness's job at review time is to **say where to look**. A change is restated as ideas, each
labelled for how hard to look at it and why, by a party that did not write it — how much scrutiny a
change deserves is exactly the judgement not to take from its author. The reviewer still reads. They
read the two things that mattered, properly, instead of forty that did not, badly.
→ [31 — Review packs](spec/31-review-packs.md)

## What this is not

**Not unsupervised automation.** Every act that reaches the outside world is authorized by a person,
and nothing closes your ticket.

**Not a faster way to use an agent.** Opening one, describing a change and taking the diff is a tool.
This holds the loop — it watches the tracker, the pull requests and CI on a heartbeat, decides what to
do next, and hands back the decisions that are genuinely yours.

**Not faith in the model.** Neither a model nor a person is reliable. Reliability comes from the
arrangement around both: gates, tests, evidence, an audit trail, and a bounded set of things an agent
is permitted to do. What is trusted is that arrangement — never the agent's own account of its work.

**Not a claim that the engineer is the slow part.** They are the constraint, and the harness measures
that honestly: throughput is bounded by how fast the asks are answered, not by how many agents run.
The answer to that is fewer and better asks, not more of them. → [25 — Supply and the runway](spec/25-supply.md)

## The test of it

A goal that goes ticket → plan → parts → merge on two clicks and one focused read is the point. A goal
that took nine escalations was a goal that was never stated.
