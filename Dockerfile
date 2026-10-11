# syntax=docker/dockerfile:1
#
# The whole product is one Node process: server-rendered Vietnamese HTML, node:sqlite for
# storage, no dependencies and no build step. So this image is the source tree plus a
# writable /data for the database — nothing is compiled, nothing is fetched at build time
# beyond the base image.
FROM node:22-alpine

ENV NODE_ENV=production \
    XUONG_HOST=0.0.0.0 \
    XUONG_PORT=8090 \
    XUONG_DATA_DIR=/data \
    XUONG_DB=/data/xuong.db

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY seed ./seed
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh

# Run as the unprivileged node user, but /data has to be writable because the database and the
# generated admin token live there. A named volume inherits this ownership; a bind mount does
# not — see the note in the README.
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /data \
 && chown -R node:node /app /data

USER node
EXPOSE 8090
VOLUME ["/data"]

# /healthz is the one path the front gate leaves open, so this probe works whether the gate is
# configured or not.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.XUONG_PORT||8090)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.mjs"]
