# Stage 1: Build
FROM oven/bun:1 AS builder
WORKDIR /app

# vp uses a Rust component that initialises an HTTPS client on every invocation.
# Debian slim (oven/bun base) ships without ca-certificates, which makes
# rustls-native-certs find zero certs and abort immediately.
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Install deps with lockfile for reproducibility.
# --ignore-scripts skips `prepare` (vp config + svelte-kit sync) which needs
# source files that aren't copied yet; the || echo '' fallback already handles
# this, but skipping is cleaner and faster.
COPY package.json bun.lock ./
RUN bun install

# Expose local vp binary on PATH
ENV PATH="/app/node_modules/.bin:$PATH"

# Copy source and build with Vite+
COPY . .
RUN vp build

# Stage 2: Production (build output is self-contained, no node_modules needed)
FROM node:22-alpine AS runner
WORKDIR /app

COPY --from=builder /app/build ./build

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

CMD ["node", "build/index.js"]
