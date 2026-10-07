FROM node:24-bookworm-slim AS build

ARG PINDOU_BUILD_REVISION=unknown
ARG PINDOU_SOURCE_DIGEST=unknown

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

WORKDIR /workspace
COPY .dockerignore package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
RUN pnpm install --frozen-lockfile --filter @pindou/backend...

COPY backend backend
RUN actual_source_digest="$(node backend/scripts/compute-release-source-digest.mjs)" \
  && if [ "$PINDOU_SOURCE_DIGEST" != "unknown" ] \
    && [ "$actual_source_digest" != "$PINDOU_SOURCE_DIGEST" ]; then \
      echo "PINDOU_SOURCE_DIGEST does not match the copied Docker build inputs" >&2; \
      exit 1; \
    fi
RUN pnpm --filter @pindou/backend exec tsc -p tsconfig.build.json
RUN pnpm config set inject-workspace-packages true --location project \
  && pnpm --filter @pindou/backend deploy --prod /opt/pindou

FROM node:24-bookworm-slim AS runtime

ARG PINDOU_BUILD_REVISION=unknown
ARG PINDOU_SOURCE_DIGEST=unknown

LABEL org.opencontainers.image.revision=$PINDOU_BUILD_REVISION \
  io.pindou.source-digest=$PINDOU_SOURCE_DIGEST

ENV NODE_ENV=production
ENV PINDOU_BUILD_REVISION=$PINDOU_BUILD_REVISION
ENV PINDOU_SOURCE_DIGEST=$PINDOU_SOURCE_DIGEST
WORKDIR /app
RUN groupadd --system --gid 10001 pindou \
  && useradd --system --uid 10001 --gid pindou --home-dir /app pindou \
  && mkdir -p /app/.data/private-assets \
  && chown -R pindou:pindou /app
COPY --from=build --chown=pindou:pindou /opt/pindou/package.json ./package.json
COPY --from=build --chown=pindou:pindou /opt/pindou/node_modules ./node_modules
COPY --from=build --chown=pindou:pindou /workspace/backend/dist ./dist
COPY --from=build --chown=pindou:pindou /workspace/backend/migrations ./migrations
USER pindou

EXPOSE 8787
CMD ["node", "dist/src/index.js"]
