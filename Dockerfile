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

# No apk packages on purpose: the image needs nothing the base does not already
# have, which keeps it small and means the build never depends on Alpine's
# mirrors being reachable. Signal handling comes from `init: true` in compose
# (Docker's own init), and the healthcheck below uses Node instead of curl.

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
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "packages/server/dist/index.js"]
