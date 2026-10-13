# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && rm -rf dist/__tests__ \
 && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    MINDGATE_HOST=0.0.0.0 \
    MINDGATE_PORT=3000 \
    MINDGATE_DB=/data/mindgate.db
WORKDIR /app
RUN useradd --system --uid 1001 --home-dir /app --shell /usr/sbin/nologin mindgate \
 && mkdir /data && chown mindgate /data && chmod 700 /data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER mindgate
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.MINDGATE_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
