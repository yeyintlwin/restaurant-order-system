# Built from the REPOSITORY ROOT with an explicit -f, the same as
# apps/customer-order/Dockerfile:
#
#   docker build -f apps/core-api/Dockerfile -t core-api:$SHA .
#
# A root context is also what makes .dockerignore's `apps/*/.env` line load-bearing:
# without it a developer's apps/core-api/.env -- which now holds DATABASE_URL -- is
# baked into the production image.
FROM node:20-alpine

WORKDIR /app

# One COPY, deliberately: it carries scripts/ as well as the source, and
# create-platform-admin.js (Plan 2), unlock-account.js and set-password.js all run
# through `docker compose exec` against this image.
COPY apps/core-api ./apps/core-api

# `ci`, not `install`. customer-order uses `install` despite having a lockfile;
# core-api is the first app here with a real dependency tree, so failing loudly on a
# stale lockfile is the behaviour a release build should have. --workspaces=false
# because the root package.json is not in this image and npm must not go looking for
# it. pg-native is never installed: it needs libpq and a C toolchain.
RUN npm --prefix apps/core-api ci --omit=dev --workspaces=false

# HOST=0.0.0.0 is correct INSIDE a container -- 127.0.0.1 there is unreachable from
# docker-proxy and the compose network. Confinement to loopback is the Compose port
# mapping's job (127.0.0.1:3200:3200), not this process's.
ENV NODE_ENV=production PORT=3200 HOST=0.0.0.0 TZ=UTC

EXPOSE 3200

CMD ["node", "apps/core-api/server.js"]
