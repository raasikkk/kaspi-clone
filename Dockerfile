FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package configuration
COPY package*.json ./

# Install dependencies (production-ready)
RUN npm ci --omit=dev

# Copy application files
COPY . .

# Expose port
EXPOSE 3000

# Start server
CMD ["npm", "start"]
