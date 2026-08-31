# ---------------------------------------------------------------------------
# Two-stage build.
#
# Stage 1 installs dependencies and builds both the React app and the small
# Node server. Stage 2 copies only the built output, so the final image has no
# node_modules, no source, and no build tools in it.
# ---------------------------------------------------------------------------

# ---- Stage 1: build -------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Copy manifests first. Docker caches this layer, so dependencies are only
# reinstalled when package.json / package-lock.json actually change.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Builds dist/ (the React app) and server-dist/server.mjs (the Node server,
# with api/recognize.ts bundled into it).
RUN npm run build && npm run build:server

# ---- Stage 2: runtime -----------------------------------------------------
FROM node:22-alpine AS runtime

# Run as a non-root user. The node image already provides one.
USER node
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/server-dist ./server-dist

EXPOSE 8080

# The server has zero runtime dependencies, so this is all that is needed.
CMD ["node", "server-dist/server.mjs"]
