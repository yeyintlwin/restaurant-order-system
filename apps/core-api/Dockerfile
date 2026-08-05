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

# FIRST, and it is an ordering constraint rather than a preference: core-api's manifest
# now carries "@restaurant/epaper-hub-sdk": "file:../../packages/epaper-hub-sdk" (spec
# 11.7 -- core-api is the SDK's one permitted caller), and npm resolves a file: link by
# READING the target's package.json at install time. With this COPY below the RUN, the
# install fails with ENOENT on a path that exists in the repository, which reads as a
# broken lockfile rather than a missing COPY.
COPY packages/epaper-hub-sdk ./packages/epaper-hub-sdk

# One COPY, deliberately: it carries scripts/ as well as the source, and the operator
# levers run through `docker compose exec` against this image rather than off the host.
#
# create-platform-admin.js SHIPPED in Plan 2b and is in the image today -- it is the
# first thing the runbook tells an operator to run inside the container, and it refuses
# a pipe, so `exec` without -T is the only way to reach it.
#
# unlock-account.js and set-password.js are named here because they are Plan 2d's and
# this COPY is what will carry them: nothing in this file changes when they land. Do not
# read them as missing from the image -- they are not written yet, and identity-slice
# §11.1 records what their absence costs an operator in the meantime.
#
# Attribution repaired 2026-08-05: this comment said "(Plan 2)" for all three, which
# was written before Plan 2 was split into 2a/2b/2c/2d and left one shipped script and
# two unwritten ones indistinguishable. deploy-config.test.js reads this COPY line and
# carries the same three names with the same split, so the two stay in step.
COPY apps/core-api ./apps/core-api

# The SDK's OWN dependency tree, installed separately. `npm ci` in apps/core-api creates
# the symlink and stops there -- it does not install a linked package's dependencies -- so
# without this line the image boots and then dies at the first display update with
# MODULE_NOT_FOUND on qrcode-generator, which nothing in the test suite can see.
# apps/customer-order/Dockerfile carried the same pair of lines until this change moved
# the SDK here.
#
# `ci`, not `install`. customer-order used `install` despite having a lockfile; core-api
# is the app with a real dependency tree, so failing loudly on a stale lockfile is the
# behaviour a release build should have. --workspaces=false because the root package.json
# is not in this image and npm must not go looking for it. pg-native is never installed:
# it needs libpq and a C toolchain.
RUN npm --prefix packages/epaper-hub-sdk ci --omit=dev \
 && npm --prefix apps/core-api ci --omit=dev --workspaces=false

# HOST=0.0.0.0 is correct INSIDE a container -- 127.0.0.1 there is unreachable from
# docker-proxy and the compose network. Confinement to loopback is the Compose port
# mapping's job (127.0.0.1:3200:3200), not this process's.
ENV NODE_ENV=production PORT=3200 HOST=0.0.0.0 TZ=UTC

EXPOSE 3200

CMD ["node", "apps/core-api/server.js"]
