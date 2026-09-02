FROM golang:1.22-alpine AS builder

WORKDIR /app
# Copy the go mod files and download dependencies
COPY api/go.mod api/go.sum ./api/
RUN cd api && go mod download

# Copy all project files
COPY . .

# Build the binary
WORKDIR /app/api
RUN go build -o server server.go

# Start fresh runtime container
FROM alpine:latest
RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app

# Copy the frontend files to the root
COPY --from=builder /app/index.html .
COPY --from=builder /app/style.css .
COPY --from=builder /app/app.js .

# Copy the built binary and env file (if present)
COPY --from=builder /app/api/server ./api/server
# We don't strictly need .env copied since we'll use Koyeb Secrets, but just in case:
# COPY --from=builder /app/api/.env ./api/.env || true

# Set working directory to api so the relative static paths ("../index.html") work properly
WORKDIR /app/api
EXPOSE 8080

CMD ["./server"]
