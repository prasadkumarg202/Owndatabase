# OwnDatabase functions runtime — see server.mjs / entrypoint.sh.
# Node 22: the permission model (--permission) is stable there.
FROM node:22-alpine
RUN apk add --no-cache dumb-init iptables ip6tables setpriv
WORKDIR /app
COPY package.json server.mjs runner.mjs entrypoint.sh ./
RUN chmod 0644 server.mjs runner.mjs package.json && chmod 0755 entrypoint.sh
ENV NODE_ENV=production PORT=3010 WORK_DIR=/work
EXPOSE 3010
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3010/health || exit 1
ENTRYPOINT ["dumb-init", "/app/entrypoint.sh"]
