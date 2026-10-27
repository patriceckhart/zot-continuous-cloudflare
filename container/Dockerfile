# Cloudflare Containers run linux/amd64 images.
FROM --platform=linux/amd64 node:24-bookworm-slim

ARG ZOT_VERSION=0.4.51
ARG ZOT_ARCHIVE_SHA256=6e594a43b4449b4e22b5eff5655887ce0dc9279a14ebcf518594f9edf25e18db

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

# Pin the release archive by checksum. .github/workflows/update-zot.yml opens a
# pull request when a new release is available. Change both arguments together.
RUN set -eu; \
  archive="zot_${ZOT_VERSION}_linux_amd64.tar.gz"; \
  curl -fsSL --proto '=https' -o "/tmp/${archive}" \
    "https://github.com/patriceckhart/zot/releases/download/v${ZOT_VERSION}/${archive}"; \
  echo "${ZOT_ARCHIVE_SHA256}  /tmp/${archive}" | sha256sum -c -; \
  tar -xzf "/tmp/${archive}" -C /usr/local/bin zot; \
  chmod 0755 /usr/local/bin/zot; \
  rm "/tmp/${archive}"

RUN useradd --create-home --uid 10001 zot
COPY runner.mjs /opt/zot/runner.mjs
USER zot
WORKDIR /home/zot
EXPOSE 7787

CMD ["node", "/opt/zot/runner.mjs"]
