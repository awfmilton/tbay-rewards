# syntax=docker/dockerfile:1

# ── Build ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
RUN npm ci

COPY packages/server ./packages/server
RUN npm run build --workspace @tbay/rewards-server

# Drop dev dependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# dumb-init gives us correct signal handling, so SIGTERM reaches Node and the
# app closes its database pool instead of being killed mid-query.
RUN apk add --no-cache dumb-init curl

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/node_modules ./packages/server/node_modules

# Not compiled, but read at runtime: SQL migrations, the dashboard and the
# tracker script the API serves to storefronts.
COPY packages/server/migrations ./packages/server/migrations
COPY packages/server/public ./packages/server/public
COPY packages/tracker ./packages/tracker

# Run unprivileged. The node image already ships a `node` user.
RUN chown -R node:node /app
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "packages/server/dist/index.js"]
