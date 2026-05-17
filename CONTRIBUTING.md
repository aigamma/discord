# Contributing

Thanks for the interest. This is a small, focused project. Contributions
that are tight, tested, and respect the existing voice are welcome.

## Workflow

1. Fork or branch.
2. Run the suite before you start: `npm test && npm run lint`.
3. Make the change. Keep commits in logical groupings — one commit per
   coherent unit of work, not one commit per file.
4. Run the suite again. If you added a tool, add a `node:test` case in
   `test/` that does not depend on a live API.
5. Open a PR with a description that explains the **why**, not just the
   **what**. The diff already shows the what.

## Voice

The bot's system prompt is enforced by `test/prompt.test.js`. If you
change `src/prompt.js`, the assertions there make sure the bans
(no preambles, no flattery, no em-dashes, no closing hooks) stay
intact. Do not remove or weaken those assertions.

Commit messages follow the same posture: verbose past-tense bodies that
capture rationale, not bullet lists of file paths. Read recent commits
for examples.

## Adding a tool

Drop a new file in `src/tools/` exporting `{ spec, execute }`:

```js
export const spec = {
  name: 'get_thing',
  description: 'What it returns and when the model should call it. Be specific — this is the only prose the model sees.',
  input_schema: { type: 'object', properties: { ... }, required: [...] },
};

export async function execute(input) { /* ... */ }
```

Register it in `src/tools/index.js` under the appropriate gating
(`SUPABASE_MODULES`, `MEMORY_MODULES`, `DUCKDB_MODULES`). Set a cache
TTL in the `TOOL_TTLS` map keyed on the tool name. The tool will
automatically appear in the model's tool surface when its backend is
configured.

## Data licensing

Inherited from the aigamma.com vendor agreement: the bot redistributes
only **computed** metrics. Do not add a tool that returns raw
per-strike IV grids, per-contract Greeks, or raw bid/ask. See
`SECURITY.md` for the threat model.

## Style

- ESM modules, two-space indent (enforced by `.editorconfig`).
- No new dependencies without a strong reason. The current dep list
  is intentionally small.
- Prefer `node:` built-ins over npm packages when comparable.
- Logger over `console.log` for anything that matters.
- Avoid em-dashes in comments and commit messages. They're banned in
  the bot's voice; matching the codebase is consistent.
