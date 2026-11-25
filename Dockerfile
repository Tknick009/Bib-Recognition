# The Bib Timer results hub: the small web service the iPads upload to and the
# scoring computer reads from. See "Live results" in README.md.
#
# The iPad app itself is not built here; it is the BibTimer.swiftpm folder.

FROM node:22-alpine

WORKDIR /app
COPY hub/package.json hub/server.js ./
COPY hub/lib ./lib
COPY hub/public ./public

ENV NODE_ENV=production
# Attach a volume at /data to keep results across restarts and redeploys.
ENV DATA_DIR=/data
EXPOSE 8080

CMD ["node", "server.js"]
