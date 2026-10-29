FROM rust:1.99-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --locked --release --bin tgfx

FROM debian:bookworm-slim
ARG TARGETARCH
ARG FX_VERSION=v0.0.15
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libgcc-s1 && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in arm64) fx_arch=aarch64;; amd64) fx_arch=x86_64;; *) exit 1;; esac \
    && curl -fsSL "https://releases.fx.sh/${FX_VERSION}/fx-linux-${fx_arch}.tar.gz" -o /tmp/fx.tar.gz \
    && tar -xzf /tmp/fx.tar.gz -C /usr/local/bin fx && rm /tmp/fx.tar.gz \
    && useradd --create-home --uid 1000 --shell /bin/sh tgfx
COPY --from=build /src/target/release/tgfx /usr/local/bin/tgfx
USER tgfx
WORKDIR /workspace
ENTRYPOINT ["tgfx"]
CMD ["--no-tui", "--json"]
