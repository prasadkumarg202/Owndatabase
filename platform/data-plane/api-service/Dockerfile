FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init
FROM base AS deps
COPY package*.json ./
RUN npm install --ignore-scripts
FROM base AS development
ENV NODE_ENV=development
COPY package*.json ./
RUN npm install --ignore-scripts
COPY . .
EXPOSE 3003
CMD ["dumb-init", "node", "--import", "tsx", "src/index.ts"]
FROM deps AS build
COPY . .
RUN npm run build
FROM base AS production
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 owndatabase
COPY --from=deps --chown=owndatabase:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=owndatabase:nodejs /app/dist ./dist
COPY --from=build --chown=owndatabase:nodejs /app/package.json ./
USER owndatabase
EXPOSE 3003
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://localhost:3003/health || exit 1
CMD ["dumb-init", "node", "dist/index.js"]
