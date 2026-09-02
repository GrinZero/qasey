FROM node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS dependencies
ARG DEBIAN_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
ENV CI=true
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN sed -i \
    -e "s|URIs: http://deb.debian.org/debian$|URIs: ${DEBIAN_MIRROR}|" \
    -e "s|URIs: http://deb.debian.org/debian-security$|URIs: ${DEBIAN_SECURITY_MIRROR}|" \
    /etc/apt/sources.list.d/debian.sources \
  && attempt=0; \
  until apt-get -o Acquire::http::Timeout=30 update; do \
    attempt=$((attempt + 1)); \
    if [ "$attempt" -ge 10 ]; then exit 1; fi; \
    sleep 2; \
  done \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    git \
    make \
    openssh-client \
    python3 \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
COPY apps/admin-ui/package.json apps/admin-ui/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/code-task/package.json packages/code-task/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/e2e/package.json packages/e2e/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS development
ENV NODE_ENV=development
ENV CI=
ENV PNPM_CONFIG_STORE_DIR=/pnpm/store
ENV pnpm_config_verify_deps_before_run=false
RUN corepack enable pnpm \
  && corepack install --global pnpm@11.21.0 \
  && test "$(pnpm --version)" = "11.21.0" \
  && install -d -o node -g node /home/node/.cache /home/node/.cache/node /home/node/.cache/mastra \
  && cp -a /root/.cache/node/corepack /home/node/.cache/node/corepack
RUN install -d -o node -g node -m 0750 /app/.qasey \
  && chown -R node:node /app /pnpm /home/node/.cache/node/corepack
USER node
CMD ["sleep", "infinity"]

FROM dependencies AS build
ARG QASEY_BUILD_PROFILE=release
COPY . .
# MCP endpoint metadata is business-owned and versioned with the application.
# Credentials remain runtime-injected environment variables.
RUN pnpm exec tsx scripts/write-build-metadata.ts \
  && if [ "$QASEY_BUILD_PROFILE" = "compose" ]; then \
      pnpm db:generate \
      && pnpm admin-ui:build \
      && pnpm exec tsup \
      && pnpm exec mastra build --dir src/mastra --studio \
      && install -d .mastra/worker \
      && node scripts/copy-mastra-skills.mjs; \
    elif [ "$QASEY_BUILD_PROFILE" = "release" ]; then \
      pnpm build; \
    else \
      echo "Unknown QASEY_BUILD_PROFILE: $QASEY_BUILD_PROFILE" >&2; \
      exit 64; \
    fi

# Install a service-only dependency closure. Browser/CUA packages are omitted;
# Prisma is retained because migrate is an explicit service image role.
FROM dependencies AS service-dependencies
COPY ci/create-service-runtime-manifest.mjs /tmp/create-service-runtime-manifest.mjs
RUN install -d /service/patches
COPY patches/@mastra__core@1.59.0.patch /service/patches/@mastra__core@1.59.0.patch
RUN node /tmp/create-service-runtime-manifest.mjs \
      /app/package.json /app/pnpm-lock.yaml \
      /service/package.json /service/pnpm-lock.yaml \
      --profile service \
      --source-workspace /app/pnpm-workspace.yaml \
      --destination-workspace /service/pnpm-workspace.yaml
WORKDIR /service
RUN pnpm install --prod --frozen-lockfile

# Install only the packages imported by the four sandbox bundles. The generated
# manifest and workspace inherit exact lockfile resolutions and security
# overrides, while excluding database, Slack, repository, and API connectors.
FROM dependencies AS sandbox-dependencies
COPY ci/create-service-runtime-manifest.mjs /tmp/create-service-runtime-manifest.mjs
RUN install -d /sandbox/patches
COPY patches/@mastra__core@1.59.0.patch /sandbox/patches/@mastra__core@1.59.0.patch
RUN node /tmp/create-service-runtime-manifest.mjs \
      /app/package.json /app/pnpm-lock.yaml \
      /sandbox/package.json /sandbox/pnpm-lock.yaml \
      --profile sandbox \
      --source-workspace /app/pnpm-workspace.yaml \
      --destination-workspace /sandbox/pnpm-workspace.yaml
WORKDIR /sandbox
RUN pnpm install --prod --frozen-lockfile

# The untrusted execution plane keeps the browser, desktop, repository, and
# bubblewrap toolchain. It deliberately contains no API, Worker, or migration
# entrypoint/artifacts.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS sandbox-runtime
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"
RUN attempt=0; \
  until apt-get -o Acquire::http::Timeout=30 update; do \
    attempt=$((attempt + 1)); \
    if [ "$attempt" -ge 10 ]; then exit 1; fi; \
    sleep 2; \
  done \
  && apt-get install -y --no-install-recommends \
    at-spi2-core \
    bubblewrap \
    build-essential \
    ca-certificates \
    curl \
    dbus-x11 \
    ffmpeg \
    fonts-dejavu-core \
    fonts-noto-color-emoji \
    git \
    gh \
    jq \
    libxi6 \
    mousepad \
    openbox \
    openssh-client \
    pcmanfm \
    pkg-config \
    python3 \
    python3-pip \
    python3-venv \
    tini \
    unzip \
    wget \
    x11-utils \
    x11-xserver-utils \
    xterm \
    xvfb \
    zip \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm \
  && corepack install --global pnpm@11.21.0 \
  && test "$(pnpm --version)" = "11.21.0"
WORKDIR /app
COPY --from=sandbox-dependencies /sandbox/node_modules ./node_modules
COPY --from=sandbox-dependencies /sandbox/package.json ./package.json
COPY --from=build /app/dist/sandbox-runtime.mjs /app/dist/sandbox-runtime.mjs.map ./dist/
COPY --from=build /app/dist/code-task-worker.mjs /app/dist/code-task-worker.mjs.map ./dist/
COPY --from=build /app/dist/cua-driver-worker.mjs /app/dist/cua-driver-worker.mjs.map ./dist/
COPY --from=build /app/dist/gh-wrapper.mjs /app/dist/gh-wrapper.mjs.map ./dist/
COPY ci/sandbox-runtime.sh ./ci/sandbox-runtime.sh
RUN git --version \
  && gh --version \
  && python3 --version \
  && test "$(pnpm --version)" = "11.21.0" \
  && bwrap --version \
  && tini --version \
  && ffmpeg -version >/dev/null \
  && Xvfb -help >/dev/null 2>&1 \
  && test ! -e /app/node_modules/@prisma \
  && test ! -e /app/node_modules/prisma \
  && test ! -e /app/node_modules/pg \
  && test ! -e /app/node_modules/ioredis \
  && test ! -e /app/node_modules/@slack \
  && test ! -e /app/node_modules/@aws-sdk \
  && test ! -e /app/node_modules/@octokit \
  && test ! -e /app/node_modules/dd-trace
RUN chown pwuser:pwuser /app \
  && install -d -o pwuser -g pwuser -m 0750 /app/.qasey/data \
  && chmod 0755 /app/dist/gh-wrapper.mjs \
  && chmod 0755 /app/dist/code-task-worker.mjs \
  && ln -s /app/dist/gh-wrapper.mjs /usr/local/bin/gh
USER 1001
EXPOSE 4120
ENTRYPOINT ["tini", "--", "sh", "ci/sandbox-runtime.sh"]
CMD ["sandbox"]

# The trusted control plane is the default build target. It uses a minimal Node
# base and ships only API, Worker supervisor, migration, and Admin UI artifacts.
FROM node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS service-runtime
ARG DEBIAN_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"
RUN sed -i \
    -e "s|URIs: http://deb.debian.org/debian$|URIs: ${DEBIAN_MIRROR}|" \
    -e "s|URIs: http://deb.debian.org/debian-security$|URIs: ${DEBIAN_SECURITY_MIRROR}|" \
    /etc/apt/sources.list.d/debian.sources \
  && attempt=0; \
  until apt-get -o Acquire::http::Timeout=30 update; do \
    attempt=$((attempt + 1)); \
    if [ "$attempt" -ge 10 ]; then exit 1; fi; \
    sleep 2; \
  done \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=service-dependencies /service/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/.mastra/output ./.mastra/output
COPY --from=build /app/.mastra/worker ./.mastra/worker
COPY --chown=node:node --from=build /app/.qasey/build-metadata.json ./.qasey/build-metadata.json
COPY --from=build /app/dist/worker-supervisor.mjs /app/dist/worker-supervisor.mjs.map ./dist/
COPY --from=build /app/apps/admin-ui/dist ./apps/admin-ui/dist
COPY --from=service-dependencies /service/package.json ./package.json
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/src/load-env.ts ./src/load-env.ts
COPY --from=build /app/prisma ./prisma
# MCP endpoint metadata is owned and versioned by this application.
COPY --from=build /app/config ./config
COPY ci/start.sh ci/runtime.sh ci/migrate-database.sh ci/verify-baseline-adoption.mjs ./ci/
RUN for binary in bwrap git gh ssh python3 make gcc g++ Xvfb playwright; do \
      if command -v "$binary" >/dev/null 2>&1; then \
        echo "service-runtime unexpectedly contains $binary" >&2; \
        exit 1; \
      fi; \
    done \
  && test ! -e /app/.git \
  && test ! -e /ms-playwright \
  && test ! -e /app/dist/sandbox-runtime.mjs \
  && for modules in /app/node_modules /app/.mastra/output/node_modules /app/.mastra/worker/node_modules; do \
       test ! -e "$modules/@playwright"; \
       test ! -e "$modules/playwright"; \
       test ! -e "$modules/playwright-core"; \
       if [ -d "$modules/.pnpm" ] \
         && find "$modules/.pnpm" -maxdepth 1 \
           \( -name '@playwright+*' -o -name 'playwright@*' -o -name 'playwright-core@*' \) \
           -print -quit | grep -q .; then \
         echo "service-runtime unexpectedly contains a Playwright package" >&2; \
         exit 1; \
       fi; \
     done \
  && chown node:node /app \
  && install -d -o node -g node -m 0750 /app/.qasey \
  && install -d -o node -g node -m 0750 /app/.mastra/output/workspace
USER node
EXPOSE 8080
CMD ["sh", "ci/start.sh", "api"]
