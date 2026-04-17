# Guide for AI agents and contributors

This document orients anyone (human or automated) working on **mDNS Topoviz**: layout, invariants, build steps, and safe change patterns.

## Product intent

- **Read-only LAN observer** for mDNS / DNS-SD (`UDP 5353`). The service listens, parses announcements, and visualizes hosts and service instances. It does **not** configure devices, run port scans, or exfiltrate data to the cloud.
- **Writes on the wire** are limited to **standard DNS-SD browse / PTR-style discovery queries** on multicast, as needed to populate the graph.
- Treat exported JSON, WebSocket payloads, and UI copy as **potentially sensitive metadata** (hostnames, instance names, TXT records).

## Repository layout

| Path | Role |
| --- | --- |
| `cmd/mdns-topoviz/` | `main` entrypoint: wiring config, listeners, discovery engine, HTTP server |
| `internal/api/` | REST + WebSocket + static SPA handler (`server.go`, `hub.go`) |
| `internal/config/` | Flags and `MDNS_TOPOVIZ_*` environment overrides |
| `internal/discovery/` | Packet parsing, DNS-SD query cadence (`engine.go`, `querier.go`) |
| `internal/listener/` | Per-interface multicast UDP listeners |
| `internal/model/` | Graph registry, TTL logic, event ring buffer (`graph.go`, `events.go`) |
| `internal/graphmerge/` | Post-snapshot merge of duplicate host nodes |
| `internal/hostenrich/` | Optional enrichment (e.g. hints, Linux ARP where available); must stay **read-only** |
| `internal/webui/` | `embed.go` embeds `assets/` subtree; **built files** come from `make web` |
| `web/` | Vite + React + Cytoscape.js SPA (`src/App.tsx`, `src/styles.css`, …) |
| `Makefile` | `web` (npm install + build + copy to `internal/webui/assets/`), `build`, `run`, `docker` |
| `Dockerfile` | Multi-stage: Node builds `web/`, Go embeds output into binary |

## Build and test

```bash
# Full binary (runs npm; copies web/dist → internal/webui/assets/)
make build

# Web only (needed before a raw `go build` if assets are missing/outdated)
make web

# From repo root after `make web`
go build -o bin/mdns-topoviz ./cmd/mdns-topoviz
```

- **Fresh clone:** run `make web` (or `make build`) before expecting `go build` to succeed: `//go:embed all:assets` requires a populated `internal/webui/assets/` tree (see `.gitignore`; generated bundles under `assets/` are usually not committed).
- **Node:** use **Node 20+** (Dockerfile uses 22) for the `web/` package.
- **Go:** **1.22+** per `go.mod`.

```bash
go test ./...
```

## HTTP API (stable-ish surface)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/health` | JSON `{ ok, time }` |
| `GET` | `/api/v1/graph` | Snapshot: nodes, edges, services, hosts; enrichment + merge applied in handler |
| `GET` | `/api/v1/events` | Recent discovery events from ring buffer |
| `GET` (WS) | `/api/v1/stream` | JSON frames for live events |

Static UI is served from `/` (SPA fallback). WebSocket `CheckOrigin` is permissive (`true`) — acceptable for a **local admin tool**; tighten if exposing beyond localhost.

## Configuration

Defined in `internal/config/config.go`: flags plus env overrides `MDNS_TOPOVIZ_HTTP`, `MDNS_TOPOVIZ_EVENTS`, `MDNS_TOPOVIZ_IFACES`, `MDNS_TOPOVIZ_GRACE`, `MDNS_TOPOVIZ_NEW`, `MDNS_TOPOVIZ_QUERY_INTERVAL`. Prefer documenting new tunables in **README** and here.

## Frontend conventions (`web/`)

- **Stack:** React 18, TypeScript, Vite, Cytoscape (dynamic import in `App.tsx`).
- **Main UI:** `web/src/App.tsx` (graph, selection panel, filters, floating events window, live HUD bar).
- **Styling:** `web/src/styles.css` (global; no CSS-in-JS framework).
- **Layout choices (do not “fix” without intent):** graph legend is **top-left** of the graph pane; discovery events live in a **fixed floating panel** **bottom-left** so it does not cover the right-hand selection column.

When changing graph behavior, prefer **debounced** or **layout-stop** hooks so Cytoscape is not hammered. After container size changes, call `cy.resize()` (patterns already exist in `App.tsx`).

## Backend change guidelines

- **Discovery and model layers** should remain deterministic and bounded (ring buffers, caps, TTL-derived state).
- **Enrichment** (`hostenrich`) must not introduce network **writes** beyond what the product already allows (mDNS queries). ARP read paths are Linux-specific and optional.
- **API responses** stay JSON; keep field names consistent with the React types in `App.tsx` or add a shared schema later—avoid silent renames.

## Security and supply chain

- **No secrets in the repo** (tokens, keys, `.env` with real values). `.gitignore` includes `.env`.
- **Dependencies:** Go modules + npm lockfile; prefer minimal upgrades with a quick `go test ./...` and `npm run build` in `web/`.
- **Docker:** non-root final image; use pinned bases as already in the Dockerfile.

## Git / GitHub hygiene

- Do not commit `web/node_modules/`, `web/dist/`, `bin/`, or generated `internal/webui/assets/` bundles unless the project policy changes—`.gitignore` reflects the intended hygiene.
- Prefer small, focused commits with messages that state **what** and **why**.

## Where to extend next (out of scope hints)

Longer-term ideas (e.g. pcap export, SQLite persistence, more protocols) belong behind clear docs and operator consent. Preserve the **read-only observer** contract unless the README and UX explicitly say otherwise.
