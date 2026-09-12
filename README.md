# dsh-mermaid-comm

Make the AI **default to Mermaid diagrams** in development conversations. Rendering is handled by [`dsh-mermaid`](https://github.com/MrmoLabs/dsh-mermaid); this plugin focuses on prompt guidance, syntax validation, and output safety.

[![npm](https://img.shields.io/npm/v/dsh-mermaid-comm)](https://www.npmjs.com/package/dsh-mermaid-comm)

## Features

| Capability | What it does |
|---|---|
| **A. Behavior guidance** | Injects a `systemPrompt.section`: architecture, data flow, sequence, state, and dependency topics default to Mermaid — diagram first, then a short explanation. |
| **B. Syntax validation** | Registers the `mermaid_validate` tool: dangerous-character scan first, then real parsing via the same-version `mermaid-runtime` shipped with dsh-mermaid. |
| **C. Output gate** | Listens for assistant message events; auto-fixes Unicode arrows / dangerous labels in Mermaid fences, and removes broken diagrams from the visible surface when they cannot be confirmed. |
| **D. Mermaid Vault** | Persists validated diagrams to `<workspace>/.dsh/mermaid/` as versioned assets: `<name>.mmd` (current version) + `<name>.history.md` (evolution history) + `INDEX.md`. The index is injected into the system prompt so later conversations evolve existing diagrams instead of redrawing from scratch. |

## Mermaid Vault (diagram persistence)

New in 0.2.0. Diagrams worth keeping — architecture, data models, core flows — are saved to the vault as a **same-topic versioned series**:

```
<workspace>/.dsh/mermaid/
├── INDEX.md                 # vault index (topic/type/version/updatedAt)
├── payment-flow.mmd         # current active version (always renderable)
└── payment-flow.history.md  # v1/v2/... with per-version change notes
```

Four model-visible tools:

- `mermaid_vault_list` — list the vault index (optional type filter)
- `mermaid_vault_read` — read a topic: current code + evolution history
- `mermaid_vault_save` — save/update a diagram (forced real-parser validation; syntax errors are rejected, so the vault only ever holds renderable diagrams)
- `mermaid_vault_delete` — delete a topic (main file + history + index entry)

The vault index is injected into the system prompt (lightweight table only — diagram contents are read on demand via `mermaid_vault_read`). When a topic already exists, the model is guided to read its history and evolve it with `save` (creating v2/v3/...) rather than redrawing from zero — that is how later conversations see the diagram's continuous change and stay consistent with earlier work.

Safety: topic names are sanitized to `[a-zA-Z0-9-_]` (no path traversal), writes are locked inside the vault directory, files are written atomically, and size/version limits prevent unbounded growth.

## Installation

```sh
dsh plugin --profile web add dsh-mermaid-comm
# also install dsh-mermaid (handles chat rendering)
dsh plugin --profile web add dsh-mermaid
```

Restart `dsh web`. If dsh-mermaid is not installed or its runtime is unavailable, `mermaid_validate` fails explicitly instead of reporting unvalidated diagrams as passing; the output gate never silently lets a broken diagram through.

## Usage

The model defaults to Mermaid output for:

- Architecture / module relationships → `flowchart` or `classDiagram`
- Call chains / request sequences → `sequenceDiagram`
- State / lifecycle → `stateDiagram-v2`
- Data models / table relationships → `erDiagram`
- Branching strategy / Git history → `gitGraph`
- Plans / schedules → `gantt`

## Validation rules

`mermaid_validate` returns:

- `ok`: whether the current code passes;
- `built`: the code after rule-based fixes;
- `fixes`: the fixes applied;
- `errors`: dangerous characters, missing runtime, or parse errors;
- `mode: "true-runtime"`: mode marker for backward compatibility with older callers.

The output gate supports both ` ```mermaid ` and ` ```mermaidd ` fences. Each broken block is independently re-evaluated; a fixed version that passes the same runtime parser replaces the original block, and blocks that still fail are replaced with a safe notice instead of being handed to the renderer.

## Safety boundary

- Unicode arrows, unpaired quotes, and subgraph special characters are scanned/fixed first;
- Real parsing uses dsh-mermaid's `lib/mermaid-runtime.js` directly — no reliance on the error-prone `.hash` field;
- Original events stay in the transcript; the fixed version overrides the visible message via a surface `replace`;
- The output gate only handles `assistant/message` append events and uses a `gateFixed` marker to prevent reprocessing.

## Development

```sh
pnpm install
pnpm --filter dsh-mermaid-comm build
pnpm --filter dsh-mermaid-comm typecheck
```

Install from a checkout:

```sh
dsh plugin --profile web add file:/path/to/packages/dsh-mermaid-comm
```

## License

MIT
