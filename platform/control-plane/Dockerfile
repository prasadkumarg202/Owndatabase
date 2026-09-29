# OwnDatabase — Control Plane Dockerfile
#
# Multi-stage build:
# - development: Hot-reload with tsx watch
# - build:       TypeScript compilation
# - production:  Minimal runtime image

# ─── Base ─────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init python3 make g++ postgresql16-client

# ─── Dependencies ─────────────────────────────────────────────────────────────
FROM base AS deps
COPY package*.json ./
RUN npm install

# ─── Development ──────────────────────────────────────────────────────────────
FROM base AS development
ENV NODE_ENV=development
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["dumb-init", "node", "--import", "tsx", "src/index.ts"]

# ─── Build ────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN npm run build

# ─── Production ───────────────────────────────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 owndatabase

# Copy only production artifacts
COPY --from=deps --chown=owndatabase:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=owndatabase:nodejs /app/dist ./dist
COPY --from=build --chown=owndatabase:nodejs /app/package.json ./package.json

USER owndatabase
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["dumb-init", "node", "dist/index.js"]
