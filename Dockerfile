# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY bin ./bin
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/bin ./bin

RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /data

EXPOSE 8431
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8431/api/board > /dev/null || exit 1

CMD ["node", "/app/bin/cli.js", "start", "--port", "8431"]
