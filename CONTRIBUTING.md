# Contributing

Thanks for the interest. This is a small, focused project. Contributions
that are tight, tested, and respect the existing voice are welcome.

## Workflow

1. Fork or branch.
2. Run the suite before you start: `npm test && npm run lint`.
3. Make the change. Keep commits in logical groupings — one commit per
   coherent unit of work, not one commit per file.
4. Run the suite again. The PR template walks through the lockstep
   updates (new env var → `docs/CONFIG.md`; new slash command →
   `docs/COMMANDS.md` + `scripts/register-commands.js`; new tool →
   `docs/TOOLS.md` + `src/tools/index.js`; new migration →
   `docs/MIGRATIONS.md` + the migration list).
5. Open a PR. The template asks for the **why**, what source-of-truth
   docs you touched, and the test plan. The diff already shows the **what**.

## Where to read first

Before touching anything substantial, read `AGENTS.md` (orientation for
agents and humans) and the per-surface source-of-truth doc that covers
the area you're changing:

- `docs/CONFIG.md` — every env var.
- `docs/COMMANDS.md` — every slash command.
- `docs/TOOLS.md` — every model-callable tool.
- `docs/MIGRATIONS.md` — schema evolution semantics.
- `docs/TESTING.md` — testing conventions.
- `docs/OPERATIONS.md` — operator runbook.
- `docs/DATA_SETUP.md` — step-by-step data hookup.
- `docs/FORKING.md` — three fork postures + checklist.

Long-form references for deeper context:

- `ARCHITECTURE.md` — module map, turn lifecycle, memory model.
- `DATA_CONTRACTS.md` — external schemas the bot reads / writes.
- `SECURITY.md` — threat model + the three-layer DuckDB defense.

## Voice

The bot's system prompt is enforced by `test/prompt.test.js`. If you
change `src/prompt.js`, the assertions there make sure the bans
(no preambles, no flattery, no em-dashes, no closing hooks) stay
intact. Do not remove or weaken those assertions unless you're
intentionally re-authoring the voice for a fork — in which case
update the assertions in the same commit. See
`docs/FORKING.md > Different audience, different voice`.

Commit messages follow the same posture: verbose past-tense bodies that
capture rationale, not bullet lists of file paths. Read recent commits
for examples. No em-dashes in commit messages either.

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

Lockstep updates:

- `docs/TOOLS.md` — add an entry with the input schema, output shape,
  TTL, and any privacy clamp.
- `ARCHITECTURE.md > Tool catalog` — add a row to the summary table.
- `test/<your_tool>.test.js` — at least one happy-path test plus the
  documented error cases. See `test/vixFamily.test.js` for the shape.

If your tool handles privacy-sensitive scope (user, channel, guild),
also add it to the agent-layer clamp in
`src/agent.js`'s `if (block.name === ...)` block — see
`SECURITY.md > Prompt-injection-aware tool clamping`.

## Adding a slash command

Three files must agree:

1. `scripts/register-commands.js` — Discord-side schema (options,
   choices, ranges, max length). Discord enforces these before the
   handler ever runs.
2. `src/bot.js` — handler function plus a `case` in
   `handleSlashCommand`.
3. `docs/COMMANDS.md` — the SoT entry.

If the command does anything expensive (DB aggregation, multi-second
wait), call `interaction.deferReply()` up front. Discord's
initial-response deadline is 3 seconds; `deferReply` gives 15 minutes.
Set `flags: MessageFlags.Ephemeral` on personal or large responses.

Commands are not visible to users until `npm run register` is run
against the target guild/global scope. Guild-scoped is instant; global
takes ~1h.

## Adding an env var

1. `src/config.js` — parser + validation. Use `safeInt` or `safeFloat`
   for ranges; require non-empty for required keys.
2. `.env.example` — annotated section explaining what the var does.
3. `docs/CONFIG.md` — the SoT entry with type, default, range,
   downstream effect.

If the env enables an optional integration, gate the dependent feature
on the configured-ness of the key (the pattern: `config.x.enabled =
Boolean(rawKey)`), and make sure the bot still starts cleanly without
it. The bot's posture is fail-fast on missing required vars,
silent-disable on missing optional ones.

## Adding a migration

See `docs/MIGRATIONS.md`. Short version: append to `migrations[]` in
`src/db.js` (for SQLite) or add a numbered SQL file in `migrations/`
(for pgvector). Idempotent SQL only. Never rename or reorder existing
migrations.

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
- No trailing summaries in code (the diff is the summary) and no
  comments that paraphrase the line below. Comments earn their keep
  by explaining a non-obvious WHY.

## Reporting bugs

See `.github/ISSUE_TEMPLATE/bug_report.md`. Capture `/health`, the
model in use, and what you expected vs what you saw.

## Security disclosure

Email **eric@aigamma.com** rather than opening a public issue for
security-sensitive findings. See `SECURITY.md`.
