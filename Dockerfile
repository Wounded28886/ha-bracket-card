# Standalone bracket server — the same cards, without Home Assistant.
# Works anywhere Docker does (a Synology NAS, x86_64 or ARM): pure Node, no
# native dependencies, no database.
FROM node:22-alpine

WORKDIR /app

COPY package.json build.mjs ./
COPY src ./src
COPY server ./server

# Build the card from source here, so the image can never ship a stale bundle
# someone forgot to rebuild, and serve it next to the page.
RUN mkdir -p dist \
 && node build.mjs \
 && cp dist/ha-bracket-card.js server/public/board.js \
 && rm -rf dist

ENV NODE_ENV=production \
    PORT=8099 \
    DATA_DIR=/data \
    TITLE="Game Night" \
    BOARD=default

# `node` is an unprivileged user in the base image; the data volume is its own.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8099)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.mjs"]
