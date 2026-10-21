# syntax=docker/dockerfile:1
#
# One image, three roles: `docker run IMAGE api`, `worker` or `releaser` (the process that holds the
# key of the retention archive; see docs/runbooks/archive-release.md).
# Build from the repository root:  docker build -f infra/Dockerfile -t consultorio-api .

# ---- build: install the workspace and bundle the API ------------------------------------------
FROM node:24-slim AS build
# The pnpm version comes from "packageManager" in package.json (single source of truth).
RUN corepack enable
WORKDIR /repo

# Manifests first so the dependency layer is cached until a manifest or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile --filter "@consultorio/api..."

COPY apps/api apps/api
COPY packages packages
RUN pnpm --filter @consultorio/api build
# Production dependencies only. Workspace code is already bundled into dist/main.js.
RUN pnpm --filter @consultorio/api deploy --prod --legacy /prod

# ---- runtime: Node 24 slim, non-root, tini as init ---------------------------------------------
FROM node:24-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /prod/package.json ./package.json
COPY --from=build --chown=node:node /prod/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
# Data the API reads at startup (the common-password list). It stops if it cannot find it.
COPY --from=build --chown=node:node /repo/apps/api/assets ./assets

USER node
EXPOSE 3000

# Meaningful for the `api` role. The `worker` and `releaser` roles have no HTTP port: override this check there.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/main.js"]
CMD ["api"]
