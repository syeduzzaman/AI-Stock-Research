FROM node:24-bookworm-slim

WORKDIR /app
COPY src ./src
COPY public ./public
RUN install -d -o node -g node -m 0700 /app/data \
    && install -o node -g node -m 0600 /dev/null /app/data/.keep

ENV NODE_ENV=production
ENV HOST=0.0.0.0 PORT=8082 LOCAL_CONTAINER_ORIGIN=http://127.0.0.1:8082
USER node
EXPOSE 8082

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const origin = new URL(process.env.PUBLIC_ORIGIN || process.env.LOCAL_CONTAINER_ORIGIN); const req = require('node:http').get({ hostname: '127.0.0.1', port: process.env.PORT, path: '/healthz', headers: { host: origin.host }, signal: AbortSignal.timeout(4000) }, res => { res.resume(); process.exitCode = res.statusCode === 200 ? 0 : 1; }); req.on('error', () => { process.exitCode = 1; });"]

CMD ["node", "src/server.mjs"]
