# Gateway image. Build from the repository root:
#   docker build -f gateway/Dockerfile .

# --- Build stage: compile @ome/shared and @ome/gateway to JavaScript. ---
FROM node:24-slim AS build

WORKDIR /src
# The lockfile covers every workspace, so npm needs all their manifests.
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY protocol/package.json protocol/
COPY shared/package.json shared/
COPY gateway/package.json gateway/
COPY web/package.json web/
COPY e2e/package.json e2e/
RUN npm ci --workspace=@ome/shared --workspace=@ome/gateway --include-workspace-root

COPY protocol protocol
COPY shared shared
COPY gateway gateway
RUN npm run build -w @ome/shared \
    && npm run build -w @ome/gateway

# --- Runtime stage: compiled output and production dependencies only. ---
FROM node:24-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY protocol/package.json protocol/
COPY shared/package.json shared/
COPY gateway/package.json gateway/
COPY web/package.json web/
COPY e2e/package.json e2e/
RUN npm ci --omit=dev --workspace=@ome/shared --workspace=@ome/gateway \
        --ignore-scripts \
    && npm cache clean --force

# @ome/shared reads the instrument from @ome/protocol at runtime.
COPY protocol/instrument.json protocol/
COPY --from=build /src/shared/dist shared/dist
COPY --from=build /src/gateway/dist gateway/dist

# The official image's unprivileged user.
USER node
EXPOSE 8080

CMD ["node", "gateway/dist/main.js"]

# Healthy while the gateway is serving and connected to the engine service.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
