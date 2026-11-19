# Stdio image for directories that start MCP servers to inspect them (Glama, Docker).
# It lists the tools but refuses every call: there is no OAuth over stdio.
# Production runs the remote HTTP server (dist/server.js); see README.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build
USER node
CMD ["node", "dist/stdio.js"]
