# Debian-slim, not Alpine: @xenova/transformers depends on onnxruntime-node,
# which ships glibc-linked native bindings and won't load on musl/Alpine.
FROM node:20-slim

WORKDIR /app

# Install deps first to leverage Docker layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./

# Cache directory for the @xenova/transformers MiniLM model.
# Mount a named volume here to avoid re-downloading on container restart.
ENV TRANSFORMERS_CACHE=/app/.cache/transformers
RUN mkdir -p /app/.cache/transformers

# Default to HTTP transport so the container is useful as a long-lived service.
# Override with MCP_TRANSPORT=stdio + `docker exec -i` if you prefer stdio.
ENV MCP_TRANSPORT=http
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=3333
EXPOSE 3333

CMD ["node", "index.js"]
