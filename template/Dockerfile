# Build context: the repository root.
#
#   docker build -t starter:local .
#
# Runs the Nitro server by default. The migrate entrypoint runs from the same
# image as the Deployment's init container, with args ["entrypoints/migrate.js"].

# --- build: install with the pinned Bun, then vite build + bundled entrypoints
FROM oven/bun:1.4.3 AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# --- runtime: distroless Bun, non-root, only the build output
FROM oven/bun:1.4.3-distroless
WORKDIR /app
# METRICS_PORT: /metrics on its own port, never routed by the ingress.
# NO_COLOR: srvx's shutdown lines without ANSI codes.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    METRICS_PORT=9090 \
    NO_COLOR=1 \
    MIGRATIONS_DIR=/app/drizzle
COPY --from=build /src/.output/ ./
COPY --from=build /src/drizzle/ ./drizzle/
USER 10001:10001
EXPOSE 3000 9090
CMD ["run", "server/index.mjs"]
