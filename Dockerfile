FROM node:18-alpine

WORKDIR /app

# Install build dependencies for sqlite3 native bindings
RUN apk add --no-cache \
    python3 \
    make \
    g++

# Copy package files
COPY package*.json ./

# Install dependencies (rebuild native modules for Alpine)
RUN npm ci --only=production

# Copy application files
COPY . .

# Create volume mount point for database persistence
VOLUME ["/app/data"]

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]