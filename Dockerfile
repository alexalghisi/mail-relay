# API, TypeScript delivery worker, webhook dispatcher and migrations.
# Runs the TypeScript sources directly with Node's built-in type stripping.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "src/cli.ts", "api"]
