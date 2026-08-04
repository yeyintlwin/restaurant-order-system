FROM node:20-alpine

WORKDIR /app

# NO `COPY packages/epaper-hub-sdk` and no SDK install. Spec 11.7 moved
# @restaurant/epaper-hub-sdk to apps/core-api, which is now its only permitted caller
# (apps/core-api/test/source-structure.test.js rule C16 asserts that repository-wide), and
# this app's manifest declares no runtime dependencies at all. Those two lines are not
# missing here -- they are in apps/core-api/Dockerfile, which is where the require now is.
#
# Still built from the REPOSITORY ROOT with an explicit -f, unchanged: .dockerignore's
# `apps/*/.env` rule keeps a developer's .env out of the image and is written against a
# root context, and .github/workflows/deploy.yml passes `-f apps/customer-order/Dockerfile .`
COPY apps/customer-order ./apps/customer-order

# `install`, not `ci`, kept as it was. Against an empty dependency tree the two are the
# same operation, and changing it would be an unrelated edit in a commit about a boundary.
RUN npm --prefix apps/customer-order install --omit=dev --workspaces=false

ENV NODE_ENV=production PORT=3100

EXPOSE 3100

CMD ["node", "apps/customer-order/server.js"]
