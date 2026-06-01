FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:20-alpine
WORKDIR /app

RUN addgroup -g 1001 -S mindgate && \
    adduser -S mindgate -u 1001

COPY --from=builder /app/node_modules ./node_modules
COPY src/ ./src/

USER mindgate

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
