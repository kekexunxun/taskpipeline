FROM node:24-bookworm-slim

ARG PI_VERSION=0.82.1
ARG OCR_VERSION=1.8.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
  && npm install -g "@alibaba-group/open-code-review@${OCR_VERSION}"

# Qoder's official installer is used in the managed image. Override the URL with an internal mirror at build time.
ARG QODER_INSTALL_URL=https://qoder.com/install
RUN curl -fsSL "$QODER_INSTALL_URL" -o /tmp/qoder-install.sh \
  && bash /tmp/qoder-install.sh \
  && rm /tmp/qoder-install.sh

WORKDIR /workspace
ENTRYPOINT ["pi"]
