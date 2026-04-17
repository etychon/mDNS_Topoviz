# syntax=docker/dockerfile:1.6

FROM node:22-bookworm AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM golang:1.22 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY . .
COPY --from=web /web/dist ./internal/webui/assets
RUN --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/mdns-topoviz ./cmd/mdns-topoviz

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/mdns-topoviz /mdns-topoviz
USER nonroot:nonroot
EXPOSE 8765
ENTRYPOINT ["/mdns-topoviz"]
