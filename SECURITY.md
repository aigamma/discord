# Security Policy

## Reporting a vulnerability

Email **eric@aigamma.com** with a clear description of the issue, steps to
reproduce, and any proof-of-concept code or transcripts. Please do not file
a public GitHub issue for security-sensitive findings.

We acknowledge reports within five business days and aim to ship a fix or
mitigation within thirty days for critical issues. Coordinated disclosure
is welcome; we will credit the reporter unless asked otherwise.

## Supported versions

This is an early-stage, single-maintainer project. Only the `main` branch
receives security patches. There are no long-lived release branches yet.

## Secrets posture

- The bot reads secrets only from environment variables, never from files
  it discovers at runtime. `.env.local` is read once at startup via
  `node --env-file-if-exists=.env.local` (so the container starts when
  secrets come from the orchestrator instead of a mounted file), and
  never reloaded.
- The required secrets are listed in `.env.example` with comments naming
  what each one signs into.
- The `.gitignore` excludes `.env`, `.env.local`, `.env.*.local`, and the
  SQLite store (which contains chat content). Do not commit these files.
- Discord bot tokens, Anthropic API keys, Supabase keys, and Voyage API
  keys are all credential material; treat any leak as a rotation event,
  not just a code change.

## Threat model

The bot accepts free-form text from Discord users and routes it through:

1. Anthropic API (model output + server-side tools).
2. Local tools that read Supabase, DuckDB shards, and the local SQLite
   store. None of these tools accept user-supplied SQL except
   `query_duckdb`, which enforces a single-statement SELECT-only guard
   with a keyword blocklist (see `src/duckdb.js`).
3. Read-only attachments to the backtester DuckDB shards.

The model is not given write access to any data store. The bot writes
only to its own SQLite (audit log, embeddings) and to the
`discord_chat_memory` table in Supabase (its own table; no shared writes).

## Out of scope

- Denial of service from a Discord user. The per-user rate limit caps
  individual abuse but a coordinated DDoS against Discord itself is the
  platform's problem.
- Anthropic, Supabase, Voyage, and Discord vulnerabilities. Report those
  upstream.
- Vulnerabilities in development dependencies that are not present in
  the production runtime (devDependencies-only issues).
