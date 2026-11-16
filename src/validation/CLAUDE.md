# CLAUDE.md — `src/validation/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Persistence

- **A validation check's `area` comes from a `suite` step and from nothing else, and a second home for it is a silent
  undo.** It was inherited from the `coverage` of a covered part, repaired from SQL at boot and held in a column; all
  three are gone, because a boot pass that recomputes it overwrites what the step named on _every_ boot — the join quietly unpicking
  the author, with nothing red. → [36](../../docs/spec/36-remote-validation.md#how-a-check-comes-to-have-an-area)
- **`fleetCanStart` is three-valued and `null` must never fold into `false`.** Null is _this check has no steps_ —
  `fleetCandidate` and the operator's press still decide, which is every check written before test plans. False is a
  plan whose first step is a person's, which can never execute. Fold them and every prose check on the deployment stops
  being dispatchable, with a full "Up next" queue and nothing red. → [20](../../docs/spec/20-validation.md#who-carries-a-step)
- **A failed validation check must never be recorded as a shortfall.** A shortfall clears the goal's **delivery** row,
  and the delivery is what parks the goal: writing one un-parks it, settles the close-out obligation and declines the
  validation bench row — the reading deleting the rows it was reported into, with delivered work handed back to the
  fleet. Rule `validation-failed` is the consumer, on its own origin. →
  [20](../../docs/spec/20-validation.md#when-a-check-fails)

## Tenants

- **The harness never generates or infers a tenant identifier, anywhere.** Environments reap tenants
  matching a name pattern past a short age, so an invented name survives about an hour and its
  disappearance presents as mysterious mass failure. No tenant configured is a `blocked` row **naming
  the command or variable that would provide one** — and a `tenantEnv`'s _value_ goes into the spawn
  env and nowhere else: the lock, the cockpit and every prompt carry the **variable's own name**.
  → [36](../../docs/spec/36-remote-validation.md#tenants)
