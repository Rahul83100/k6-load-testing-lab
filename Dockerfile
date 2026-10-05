# Universal Christ University k6 Enterprise Load Testing Container
FROM grafana/k6:latest AS k6-bin

FROM node:20-alpine
WORKDIR /app

# Install bash and curl
RUN apk add --no-cache bash curl

# Copy k6 binary from official image
COPY --from=k6-bin /usr/bin/k6 /usr/bin/k6

# Install node dependencies
COPY package*.json ./
RUN npm install --production

# Copy application files
COPY . .

# Expose Web Control Center (3001) and Grafana Live Dashboard (5665)
EXPOSE 3001 5665

# Start Telemetry & Control Center
CMD ["node", "tests/christ_university/reports/report_server.js"]
