FROM node:22-alpine AS base

WORKDIR /home/node/app
RUN apk add --no-cache ffmpeg

FROM base AS deps
COPY package*.json ./
RUN npm ci

FROM deps AS builder
COPY . .
ENV DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
RUN npx prisma generate && npm run build && npm prune --omit=dev

FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /home/node/app/package*.json ./
COPY --from=builder /home/node/app/node_modules ./node_modules
COPY --from=builder /home/node/app/dist ./dist
COPY --from=builder /home/node/app/src/generated/prisma ./src/generated/prisma

EXPOSE 3000
CMD ["node", "dist/src/main.js"]