FROM node:20-bookworm

# Install Chromium and required fonts
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Application directory
WORKDIR /app

# Install Node.js dependencies
COPY package.json .
RUN npm install

# Copy application files
COPY index.js .
COPY sample.jpg .
COPY sample.docx .

# Create WhatsApp Web.js authentication directory
RUN mkdir -p /app/.wwebjs_auth

# API port
EXPOSE 3000

# Remove only stale Chromium lock files before starting.
# The WhatsApp authentication/session data is preserved.
CMD ["sh", "-c", "find /app/.wwebjs_auth -name 'SingletonLock' -o -name 'SingletonCookie' -o -name 'SingletonSocket' | xargs -r rm -f; npm start"]
