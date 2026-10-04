# OwnDatabase — backup-worker
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init postgresql16-client

FROM base AS deps
COPY package*.json ./
RUN npm install

FROM base AS development
ENV NODE_ENV=development
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3008
CMD ["dumb-init", "node", "--import", "tsx", "src/index.ts"]

FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

FROM base AS production
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 owndatabase
COPY --from=build --chown=owndatabase:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=owndatabase:nodejs /app/dist ./dist
COPY --from=build --chown=owndatabase:nodejs /app/package.json ./package.json
# the backups volume takes this directory's owner when Docker first creates it
RUN mkdir -p /backups && chown owndatabase:nodejs /backups
USER owndatabase
EXPOSE 3008
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3008/health || exit 1
CMD ["dumb-init", "node", "dist/index.js"]
