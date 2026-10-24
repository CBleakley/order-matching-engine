# Web image: the built static files served by Caddy, which also proxies /api
# and /ws to the gateway. Build from the repository root:
#   docker build -f web/Dockerfile .

# --- Build stage: type-check and bundle the React app with Vite. ---
FROM node:24-slim AS build

WORKDIR /src
# The lockfile covers every workspace, so npm needs all their manifests.
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY protocol/package.json protocol/
COPY shared/package.json shared/
COPY gateway/package.json gateway/
COPY web/package.json web/
COPY e2e/package.json e2e/
RUN npm ci --workspace=@ome/shared --workspace=@ome/web --include-workspace-root

COPY protocol protocol
COPY shared shared
COPY web web
RUN npm run build -w @ome/shared \
    && npm run build -w @ome/web

# --- Runtime stage: Caddy with the static files. ---
FROM caddy:2.10-alpine AS runtime

COPY web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/web/dist /srv

# Caddy keeps certificates and state in /data and /config. Hand them to an
# unprivileged user; it only binds ports above 1024 (8080 by default).
RUN addgroup -S caddy \
    && adduser -S -G caddy -H -s /sbin/nologin caddy \
    && mkdir -p /data/caddy /config/caddy \
    && chown -R caddy:caddy /data /config
USER caddy
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD ["wget", "-q", "--spider", "http://127.0.0.1:8080/"]
