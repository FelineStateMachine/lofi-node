# Container image for lofi-node. The build stage compiles the self-contained
# binary on the target platform (the committed prebuilt iroh addons make this
# possible without a Rust toolchain); the runtime stage is a minimal glibc
# base. The addons are gnu builds, so the base must be glibc — do not switch
# to musl/alpine.
#
# linux/amd64 only: jazz-napi publishes no linux-arm64-gnu binary, so an
# arm64 image cannot boot the Jazz server. The guard below fails the build
# rather than producing an image that dies at runtime. arm64 hosts can run
# the amd64 image under emulation (Docker Desktop Rosetta / qemu).
#
# Build:  docker build -t lofi-node .
# Run:    see compose.yaml and https://lofi.host/node/docs/beyond-the-lan

FROM denoland/deno:latest AS build
ARG TARGETARCH
RUN if [ "$TARGETARCH" != "amd64" ]; then \
      echo "lofi-node images are linux/amd64 only: jazz-napi ships no" \
           "linux-arm64-gnu binary (upstream gap). Run the amd64 image" \
           "under emulation instead." >&2; \
      exit 1; \
    fi
WORKDIR /src
COPY deno.json deno.lock cli.ts mod.ts ./
COPY src ./src
COPY testing ./testing
COPY native/iroh-js/prebuilt ./native/iroh-js/prebuilt
# Materialize node_modules (jazz-napi's platform package) before compiling;
# deno compile embeds it into the binary's vfs.
RUN deno install
RUN deno task compile:linux-x64 \
    && mv dist/lofi-node-x86_64-unknown-linux-gnu dist/lofi-node

FROM debian:bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/FelineStateMachine/lofi-node" \
      org.opencontainers.image.description="Self-hostable sync node for lofi apps" \
      org.opencontainers.image.licenses="MIT"
# ca-certificates: TLS to iroh relays and upstream URLs. curl: HEALTHCHECK.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home lofi \
    && mkdir /data && chown lofi:lofi /data
COPY --from=build /src/dist/lofi-node /usr/local/bin/lofi-node
USER lofi
VOLUME /data
# The documented container port convention; init with --port 4802 (see docs).
EXPOSE 4802
# Probes the gate; unauthenticated in both access modes. Override the port in
# compose if the node was initialized with a different one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD curl -fsS http://127.0.0.1:4802/health || exit 1
ENTRYPOINT ["lofi-node"]
CMD ["start", "--dir", "/data"]
