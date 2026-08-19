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
COPY apps/admin-ui/package.json apps/admin-ui/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/e2e/package.json packages/e2e/package.json
RUN npx npm-cli-login \
  -u "$NPM_PUBLISHER_USR" \
  -p "$NPM_PUBLISHER_PSW" \
  -e devops@moego.pet \
  -r "https://nexus.devops.moego.pet/repository/npm-local/" \
  && pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
# Environment-specific MCP endpoints are mounted at runtime. Never bake a
# developer's local MCP catalogue into the production image.
RUN mkdir -p .qasey && printf '{"servers":{}}\n' > .qasey/mcp.json
RUN pnpm build

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.mastra/output ./.mastra/output
COPY --from=build /app/.mastra/worker ./.mastra/worker
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/admin-ui/dist ./apps/admin-ui/dist
COPY --from=build /app/.qasey/mcp.json ./.qasey/mcp.json
COPY .env .env.testing .env.devops ./
COPY ci ./ci
RUN corepack enable && git --version
RUN chown pwuser:pwuser /app
USER pwuser
EXPOSE 4111
CMD ["sh", "ci/start.sh", "api"]
