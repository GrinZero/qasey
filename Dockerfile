FROM node:24-bookworm-slim AS dependencies
ARG NPM_PUBLISHER_USR
ARG NPM_PUBLISHER_PSW
ENV CI=true
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
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
RUN npx npm-cli-login \
  -u "$NPM_PUBLISHER_USR" \
  -p "$NPM_PUBLISHER_PSW" \
  -e devops@moego.pet \
  -r "https://nexus.devops.moego.pet/repository/npm-local" \
  && pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
# MCP endpoint metadata is business-owned and versioned with the application.
# Credentials remain runtime-injected environment variables.
RUN pnpm build

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"
RUN apt-get update \
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
    unzip \
    wget \
    x11-utils \
    x11-xserver-utils \
    xterm \
    xvfb \
    zip \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.mastra/output ./.mastra/output
COPY --from=build /app/.mastra/worker ./.mastra/worker
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/admin-ui/dist ./apps/admin-ui/dist
COPY --from=build /app/package.json /app/prisma.config.ts ./
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/prisma ./prisma
# MCP endpoint metadata is owned and versioned by this application.
COPY --from=build /app/config/mcp.json ./config/mcp.json
COPY .env .env.testing .env.devops ./
COPY ci ./ci
RUN corepack enable \
  && git --version \
  && gh --version \
  && python3 --version \
  && ffmpeg -version >/dev/null \
  && Xvfb -help >/dev/null 2>&1
RUN chown pwuser:pwuser /app \
  && install -d -o pwuser -g pwuser -m 0750 /app/.mastra/output/workspace \
  && chmod 0755 /app/dist/gh-wrapper.mjs \
  && chmod 0755 /app/dist/code-task-worker.mjs \
  && ln -s /app/dist/gh-wrapper.mjs /usr/local/bin/gh
USER 1001
EXPOSE 8080
CMD ["sh", "ci/start.sh", "api"]
