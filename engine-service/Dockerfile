# Engine service image. Build from the repository root:
#   docker build -f engine-service/Dockerfile .

# --- Build stage: CMake + Ninja + GCC, as in CI's Ubuntu job. ---
FROM ubuntu:24.04 AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates cmake g++ ninja-build \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY CMakeLists.txt CMakePresets.json ./
COPY engine engine
COPY engine-service engine-service
COPY cli cli
COPY bench bench
COPY tests tests

# Only the engine_service target is built; the tests run in CI.
RUN cmake --preset release \
    && cmake --build --preset release --target engine_service

# --- Runtime stage: the binary, the instrument config and a non-root user. ---
FROM ubuntu:24.04 AS runtime

RUN useradd --system --no-create-home --shell /usr/sbin/nologin engine

WORKDIR /app
COPY --from=build /src/build/release/engine-service/engine_service /app/engine_service
COPY protocol/instrument.json /app/protocol/instrument.json

USER engine
EXPOSE 7001

# Listens on every interface inside the container. docker-compose keeps the
# port on a private network; it is never published to the host.
ENTRYPOINT ["/app/engine_service", "--bind", "0.0.0.0", "--port", "7001", \
            "--instrument", "/app/protocol/instrument.json"]

# Healthy once the port is listening (it only listens after the warm-up). It
# reads the socket table instead of connecting, since a probe connection would
# be logged and turned away as a second gateway. 1B59 is port 7001, 0A LISTEN.
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=3 \
    CMD ["sh", "-c", "grep -qs ':1B59 [0-9A-F:]* 0A ' /proc/net/tcp /proc/net/tcp6"]
