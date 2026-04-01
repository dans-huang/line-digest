FROM node:20-slim

# better-sqlite3 needs build tools for native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json .npmrc ./
RUN npm ci --production

COPY dist/ ./dist/
COPY config.yaml ./

VOLUME /app/data
EXPOSE 3000

CMD ["node", "dist/app.js"]
