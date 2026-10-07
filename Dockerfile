FROM ghcr.io/foundry-rs/foundry:latest AS foundry

FROM node:22-bookworm-slim
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/anvil /usr/local/bin/cast /usr/local/bin/
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile=false \
 && pnpm contracts:build && node scripts/sync-abi.mjs \
 && pnpm build
CMD ["pnpm", "demo"]
