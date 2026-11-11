# Battleground: a portable, Ludus-compatible cyber range simulator.
#
#   docker build -t battleground .
#   docker run -p 8080:8080 -v battleground-data:/data battleground
#
# The first start prints the admin password and API key (or set BATTLEGROUND_ADMIN_PASSWORD).

FROM node:22-alpine AS build
WORKDIR /src
# Dependencies first, so source changes don't invalidate the npm cache layer.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# The build is one bundled server file plus the web UI; nothing else is needed at run time.
FROM node:22-alpine
ENV NODE_ENV=production \
    BATTLEGROUND_HOST=0.0.0.0 \
    BATTLEGROUND_PORT=8080 \
    BATTLEGROUND_DATA_DIR=/data
WORKDIR /app
COPY --from=build /src/dist/ ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${BATTLEGROUND_PORT}/healthz" >/dev/null || exit 1
ENTRYPOINT ["node", "/app/battleground.mjs"]
