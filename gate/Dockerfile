# syntax=docker/dockerfile:1
# The build context is the repository root, because the image holds the hub and the admin panel it serves:
#   docker build -f gate/Dockerfile -t mindgate-hub .
FROM node:22-bookworm-slim AS panel
WORKDIR /panel
COPY panel/package.json panel/package-lock.json ./
RUN npm ci
COPY panel/tsconfig.json panel/vite.config.ts panel/index.html ./
COPY panel/public ./public
COPY panel/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY gate/package.json gate/package-lock.json ./
# better-sqlite3 is a native module: a prebuilt binary is used when there is one for this platform, otherwise it is
# compiled here (this stage only; the runtime stage gets the result without the toolchain).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm ci
COPY gate/tsconfig.json ./
COPY gate/src ./src
RUN npm run build \
 && rm -rf dist/__tests__ \
 && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    MINDGATE_HOST=0.0.0.0 \
    MINDGATE_PORT=3000 \
    MINDGATE_DB=/data/mindgate.db \
    MINDGATE_PANEL_DIR=/app/panel
WORKDIR /app
RUN useradd --system --uid 1001 --home-dir /app --shell /usr/sbin/nologin mindgate \
 && mkdir /data && chown mindgate /data && chmod 700 /data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=panel /panel/dist ./panel
COPY gate/package.json ./
USER mindgate
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.MINDGATE_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
