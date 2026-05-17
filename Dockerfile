# Multi-stage Dockerfile. The deps stage installs production npm modules
# against a clean base image; the runtime stage copies only what the bot
# needs to execute, keeping the final image small.

FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./

# Production install only. Native modules (better-sqlite3 — not used —
# and @duckdb/node-api which ships prebuilt binaries) resolve here.
RUN npm ci --omit=dev


FROM node:22-bookworm-slim AS runtime

# Run as non-root. Discord and Anthropic do not require root privileges
# and the bot has no reason to ever escalate.
RUN groupadd --system bot && useradd --system --gid bot --create-home bot

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY LICENSE README.md ./

# Persist SQLite under /app/data. Compose mounts a host volume here.
RUN mkdir -p /app/data && chown -R bot:bot /app

USER bot

# Structured logger auto-selects JSON when stdout is not a TTY, which it
# is not under containerd / Docker. No override needed.

# Use --env-file-if-exists so containers passing env vars via Docker's
# native mechanisms (compose env_file at compose-eval time, docker run
# -e, k8s ConfigMap/Secret) don't fail at startup because /app/.env.local
# isn't a file. Local-dev startups that DO have a .env.local on disk get
# the same loading behavior as before.
CMD ["node", "--env-file-if-exists=.env.local", "src/index.js"]
