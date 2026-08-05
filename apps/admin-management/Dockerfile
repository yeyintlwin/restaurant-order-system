# Zero dependencies, so there is no install step and no lockfile to copy.
FROM node:20-alpine

WORKDIR /app

# The build context is the repository root, matching customer-order and core-api, so
# the path below is repo-relative.
COPY apps/admin-management ./apps/admin-management

USER node
EXPOSE 3400
CMD ["node", "apps/admin-management/server.js"]
