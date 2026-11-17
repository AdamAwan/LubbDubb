# CLAUDE.md — `src/extensions/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Slots

- **Changing a slot's input or answer bumps `EXTENSION_API_VERSION`.** Extensions live in other
  repositories and no typecheck here sees them, so an extension written against the old shape keeps
  loading and reads the new input wrongly. The bump turns that into a refusal at boot.
  → [42](../../docs/spec/42-extensions.md#adding-a-slot)
- **A slot's `check` is the only guard on what an extension returns.** It is untyped JavaScript at
  runtime; a `check` that accepts anything hands a wrong-shaped answer to the desk that asked.
  → [42](../../docs/spec/42-extensions.md#adding-a-slot)
