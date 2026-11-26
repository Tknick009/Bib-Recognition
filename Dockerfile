# The Bib Timer hub: the small web service that serves the page the iPads
# capture a race with, takes in their results, and gives them to the scoring
# computer. See README.md.
#
# The native iPad app (the BibTimer.swiftpm folder) is not built here.

# What the capture page reads bib numbers with comes from npm. Installing the
# hub's packages copies it into public/vendor (see hub/scripts/vendor.mjs).
FROM node:22-alpine AS reader
WORKDIR /build
COPY hub/package.json hub/package-lock.json ./
COPY hub/scripts ./scripts
RUN npm ci --omit=dev --no-audit --no-fund \
 && test -s public/vendor/detection.onnx \
 && test -s public/vendor/recognition.onnx \
 && test -s public/vendor/ort-wasm-simd-threaded.wasm \
 && test -s public/vendor/plain/ort-wasm-simd.wasm

FROM node:22-alpine
WORKDIR /app
COPY hub/package.json hub/server.js ./
COPY hub/lib ./lib
COPY hub/public ./public
COPY --from=reader /build/public/vendor ./public/vendor

ENV NODE_ENV=production
# Attach a volume at /data to keep results across restarts and redeploys.
ENV DATA_DIR=/data
EXPOSE 8080

CMD ["node", "server.js"]
