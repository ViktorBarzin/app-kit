# Build context: the repository root.
#
#   docker build -t starter:local .
#
# Runs the Nitro server by default. The migrate entrypoint runs from the same
# image with args ["entrypoints/migrate.js"]: on Cloud as a Job once per
# Deploy, on the infra path as the Deployment's init container.

# --- build: install with the pinned Bun, then vite build + bundled entrypoints
FROM oven/bun:1.4.3 AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
# Plain env reaches the build; secrets never do. On Cloud the builder passes
# the App's plain `env` from the Project File as CLOUD_BUILD_ENV, base64 of
# `export NAME='value'` lines, so `vite build` sees VITE_* names and inlines
# them into the page's JS. Empty outside Cloud.
ARG CLOUD_BUILD_ENV=
RUN eval "$(printf '%s' "$CLOUD_BUILD_ENV" | base64 -d)" && bun run build

# --- runtime: distroless Bun, non-root, only the build output
FROM oven/bun:1.4.3-distroless
WORKDIR /app
# SERVICE_VERSION: the commit the image is built from (build.yml passes it;
# on Cloud, Cloud sets it on the pod to the Deploy's commit); logs carry it
# as service.version and telemetry as the release.
ARG SERVICE_VERSION=dev
# METRICS_PORT: /metrics on its own port, never routed by the ingress.
# NO_COLOR: srvx's shutdown lines without ANSI codes.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    METRICS_PORT=9090 \
    NO_COLOR=1 \
    MIGRATIONS_DIR=/app/drizzle \
    SERVICE_VERSION=${SERVICE_VERSION}
COPY --from=build /src/.output/ ./
COPY --from=build /src/drizzle/ ./drizzle/
# The distroless image has no shell and no sleep. On Cloud a stopping
# instance runs the preStop hook `sleep <5 + shutdownDelaySeconds>` so
# requests in flight finish before SIGTERM; without a sleep binary the hook
# fails and SIGTERM comes at once. `cloud run <p> <app> -- sh -c '...'`
# needs a shell, and so does `cloud shell <p> <app>`, where `env`, `ls`,
# `cat`, `grep`, `ps`, `cut`, `head` and `tail` help look around. Static
# busybox (pinned by digest) answers as the applet its link is named after.
COPY --from=docker.io/library/busybox:1.37.0-musl@sha256:f6a95d611e0a8780fabdb2aec43e31275b2720dfefa3e41b16835bfc42454478 /bin/busybox /usr/local/bin/busybox
RUN ["/usr/local/bin/busybox", "ln", "-s", "busybox", "/usr/local/bin/sleep"]
RUN ["/usr/local/bin/busybox", "ln", "-s", "busybox", "/usr/local/bin/sh"]
RUN ["/usr/local/bin/sh", "-c", "set -e; for a in env ls cat grep ps cut head tail; do /usr/local/bin/busybox ln -s busybox /usr/local/bin/$a; done"]
USER 10001:10001
EXPOSE 3000 9090
CMD ["run", "server/index.mjs"]
