# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
WORKDIR /app
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
FROM deps AS builder
COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_GOOGLE_CLIENT_ID
RUN npm run build
FROM base AS runner
ENV NODE_ENV=production PORT=8888 TRUST_PROXY=true
USER node
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/build/server ./build/server
# Applied by the server at start (RUN_MIGRATIONS=false turns it off).
COPY --from=builder --chown=node:node /app/db/compat.sql ./db/compat.sql
COPY --from=builder --chown=node:node /app/supabase/migrations ./supabase/migrations
EXPOSE 8888
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:8888/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","build/server/index.mjs"]
