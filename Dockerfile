FROM node:20-slim

# better-sqlite3 needs build tools for native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json .npmrc ./
RUN npm ci --production

COPY dist/ ./dist/

VOLUME /app/data

CMD ["node", "dist/main.js"]
