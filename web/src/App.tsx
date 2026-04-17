import type { Core, ElementDefinition, NodeSingular } from "cytoscape";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { friendlyServiceTypeName } from "./serviceTypeLabels";

type NodeState = "active" | "stale" | "offline" | "new";

type GraphNode = {
  id: string;
  kind: string;
  label: string;
  state: NodeState;
  ifaceHint?: string;
  meta?: Record<string, string>;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: string;
};

type ServiceSnapshot = {
  instance: string;
  serviceType: string;
  targetHost: string;
  port: number;
  txt?: Record<string, string>;
  ips?: string[];
  ttl: number;
  originalTtl: number;
  firstSeen: string;
  lastSeen: string;
  expiresAt: string;
  ifaceLast?: string;
  goodbye: boolean;
};

type HostAdvertised = {
  serviceType: string;
  instance: string;
  port?: number;
};

type HostSnapshot = {
  hostname: string;
  displayLabel?: string;
  aliases?: string[];
  ips?: string[];
  ifaceLast?: string;
  mac?: string;
  macVendor?: string;
  hints?: string[];
  advertisedServices?: HostAdvertised[];
};

type GraphSnapshot = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  services: Record<string, ServiceSnapshot>;
  hosts?: Record<string, HostSnapshot>;
  serverTime: string;
};

type DiscoveryEvent = {
  time: string;
  kind: string;
  iface: string;
  src: string;
  records?: Array<{ name: string; type: string; ttl: number; rdata: string }>;
};

type EleData = Record<string, unknown> & {
  id?: string;
  fullLabel?: string;
  kind?: string;
  iface?: string;
  meta?: Record<string, string>;
};

function wsURL(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/v1/stream`;
}

function palette(kind: string, state: NodeState): string {
  if (state === "offline") return "#6b7280";
  if (state === "stale") return "#a78bfa";
  if (state === "new") return "#34d399";
  if (kind === "host") return "#60a5fa";
  if (kind === "service_type") return "#fbbf24";
  return "#f472b6";
}

/** Visual category for legend + filter; mirrors `palette()` branch order. */
type LegendKey = "offline" | "stale" | "new" | "host" | "service_type" | "service";

function nodeLegendKey(kind: string, state: NodeState): LegendKey {
  if (state === "offline") return "offline";
  if (state === "stale") return "stale";
  if (state === "new") return "new";
  if (kind === "host") return "host";
  if (kind === "service_type") return "service_type";
  return "service";
}

const LEGEND_ROWS: { key: LegendKey; label: string; color: string }[] = [
  { key: "host", label: "Host", color: "#60a5fa" },
  { key: "service", label: "Service instance", color: "#f472b6" },
  { key: "service_type", label: "Service type", color: "#fbbf24" },
  { key: "new", label: "New / pulse", color: "#34d399" },
  { key: "stale", label: "Stale (TTL low)", color: "#a78bfa" },
  { key: "offline", label: "Offline / goodbye", color: "#6b7280" },
];

/** Human-friendly caption for Cytoscape (library draws `data(fullLabel)`). */
function formatNodeCaption(s: string): string {
  return s.replace(/\\/g, " ").replace(/\s+/g, " ").trim();
}

/** Model-space width for service pills — kept smaller than host (30×30). */
function estimatePillWidth(label: string): number {
  const t = formatNodeCaption(label);
  return Math.round(Math.max(32, Math.min(108, 3.8 * t.length + 12)));
}

const PILL_MODEL_H = 14;
const PILL_STACK_GAP = 8;
const HOST_PILL_CLEAR = 10;

type BBox = { x1: number; y1: number; x2: number; y2: number };

function toBBox(bb: { x1: number; y1: number; x2: number; y2: number }): BBox {
  return { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 };
}

function bbOverlap(a: BBox, b: BBox, pad = 0): boolean {
  return !(a.x2 + pad < b.x1 || a.x1 - pad > b.x2 || a.y2 + pad < b.y1 || a.y1 - pad > b.y2);
}

/**
 * Place each host's service pills in a vertical stack immediately to the right of that host.
 * (Cose still runs for overall topology; this overwrites service model positions every time.)
 */
function positionServicePillsNearHosts(cy: Core): void {
  const stackStep = PILL_MODEL_H + PILL_STACK_GAP;
  cy.batch(() => {
    cy.nodes()
      .filter((n) => String(n.data("kind")) === "host")
      .forEach((host) => {
        const services = host
          .outgoers("edge")
          .filter((e) => String(e.data("kind")) === "advertises")
          .targets()
          .filter((n) => String(n.data("kind")) === "service");
        const list = services.sort((a, b) => a.id().localeCompare(b.id()));
        const n = list.length;
        if (n === 0) return;
        const hostBb = toBBox(host.boundingBox({ includeLabels: true, includeNodes: true }));
        const hy = host.position("y");
        const maxW = Math.max(
          32,
          ...list.map((s) => {
            const w = Number(s.data("pillW"));
            return Number.isFinite(w) && w > 0 ? w : 48;
          }),
        );
        const centerX = hostBb.x2 + HOST_PILL_CLEAR + maxW / 2;
        const totalH = n * PILL_MODEL_H + (n > 0 ? (n - 1) * PILL_STACK_GAP : 0);
        let y = hy - totalH / 2 + PILL_MODEL_H / 2;
        list.forEach((s) => {
          s.position({ x: centerX, y });
          y += stackStep;
        });
      });
  });
}

/**
 * Separate pills that belong to the *same* host only (tiny +X nudges).
 * Avoids the old global overlap pass that pushed services away from unrelated hosts.
 */
function resolveIntraHostPillOverlaps(cy: Core): void {
  cy.batch(() => {
    cy.nodes()
      .filter((h) => String(h.data("kind")) === "host")
      .forEach((host) => {
        const pills = host
          .outgoers("edge")
          .filter((e) => String(e.data("kind")) === "advertises")
          .targets()
          .filter((n) => String(n.data("kind")) === "service");
        const list: NodeSingular[] = [];
        pills.forEach((p) => {
          list.push(p);
        });
        list.sort((a, b) => a.id().localeCompare(b.id()));
        for (let iter = 0; iter < 12; iter++) {
          let moved = false;
          for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
              const s = list[i];
              const t = list[j];
              const sb = toBBox(s.boundingBox({ includeLabels: true, includeNodes: true }));
              const tb = toBBox(t.boundingBox({ includeLabels: true, includeNodes: true }));
              if (bbOverlap(sb, tb, 4)) {
                const p = t.position();
                t.position({ x: p.x + 10, y: p.y });
                moved = true;
              }
            }
          }
          if (!moved) break;
        }
      });
  });
}

function graphStructureKey(s: GraphSnapshot): string {
  const ns = s.nodes
    .map((n) => n.id)
    .filter(Boolean)
    .sort()
    .join("\0");
  const es = s.edges
    .map((e) => e.id)
    .filter(Boolean)
    .sort()
    .join("\0");
  return `${ns}\n${es}`;
}

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\.$/, "");
}

function normalizeGraph(raw: unknown): GraphSnapshot {
  const o = raw as Record<string, unknown>;
  const nodes = Array.isArray(o.nodes) ? (o.nodes as GraphNode[]) : [];
  const edges = Array.isArray(o.edges) ? (o.edges as GraphEdge[]) : [];
  const services =
    o.services && typeof o.services === "object" && !Array.isArray(o.services)
      ? (o.services as Record<string, ServiceSnapshot>)
      : {};
  const hostsRaw = o.hosts;
  const hosts =
    hostsRaw && typeof hostsRaw === "object" && !Array.isArray(hostsRaw)
      ? (hostsRaw as Record<string, HostSnapshot>)
      : undefined;
  const serverTime = typeof o.serverTime === "string" ? o.serverTime : "";
  return { nodes, edges, services, hosts, serverTime };
}

function hostKeyFromNodeId(id: string): string {
  if (!id.startsWith("host:")) return "";
  return normName(id.slice("host:".length));
}

/** Parse IP from mDNS packet source (IPv4:port, [v6]:port, or bare IP). */
function relativeTimeAgo(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function trunc(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function eventRowPresentation(ev: DiscoveryEvent): {
  icon: string;
  tag: string;
  tone: "announce" | "goodbye" | "update";
  detail: string;
  rr: number;
} {
  const k = ev.kind?.toLowerCase() ?? "";
  const rr = ev.records?.length ?? 0;
  let tone: "announce" | "goodbye" | "update" = "update";
  let icon = "🔄";
  let tag = (ev.kind || "event").toUpperCase();
  if (k === "announce" || k === "goodbye") {
    tone = k === "goodbye" ? "goodbye" : "announce";
    icon = k === "goodbye" ? "📴" : "📡";
    tag = k === "goodbye" ? "GOODBYE" : "ANNOUNCE";
  }
  const firstName = ev.records?.[0]?.name?.replace(/\.$/, "") ?? "";
  const detail = firstName || ev.src || ev.iface || "—";
  return { icon, tag, tone, detail: trunc(detail, 42), rr };
}

function parseEventSrcIP(src: string): string | null {
  const s = src.trim();
  if (!s) return null;
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end > 1) return s.slice(1, end).toLowerCase();
    return null;
  }
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1) {
    const head = s.slice(0, lastColon);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(head)) return head;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s;
  if (s.includes(":")) return s.split("%")[0].toLowerCase();
  return null;
}

function eventRelatesToHost(ev: DiscoveryEvent, needles: string[]): boolean {
  const n = [...new Set(needles.map((x) => normName(x)).filter((x) => x.length >= 4))];
  if (n.length === 0) return false;
  const chunks: string[] = [ev.src.toLowerCase(), ev.iface.toLowerCase()];
  for (const r of ev.records ?? []) {
    chunks.push(r.name.toLowerCase(), (r.rdata ?? "").toLowerCase());
  }
  const blob = chunks.join("\n");
  return n.some((needle) => blob.includes(needle));
}

/** Full discovery graph (no UI filters) — used for stable merge. */
function toElementsFull(snap: GraphSnapshot): ElementDefinition[] {
  return toElementsFiltered(snap, new Set(), "", "");
}

function toElementsFiltered(
  snap: GraphSnapshot,
  typeFilter: Set<string>,
  ifaceFilter: string,
  q: string,
): ElementDefinition[] {
  const needle = q.trim().toLowerCase();
  const nodes = snap.nodes.filter((n) => {
    if (typeFilter.size > 0 && n.kind === "service") {
      const t = (n.meta?.type ?? "").toLowerCase();
      if (!typeFilter.has(t)) return false;
    }
    if (ifaceFilter && n.kind === "service" && n.ifaceHint && n.ifaceHint !== ifaceFilter) {
      return false;
    }
    if (!needle) return true;
    const hay = `${n.label} ${n.id} ${JSON.stringify(n.meta ?? {})}`.toLowerCase();
    return hay.includes(needle);
  });
  const keep = new Set(nodes.map((n) => n.id));
  const edges = snap.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  const els: ElementDefinition[] = [];
  for (const n of nodes) {
    const pillW = n.kind === "service" ? estimatePillWidth(n.label) : 30;
    els.push({
      data: {
        id: n.id,
        fullLabel: formatNodeCaption(n.label),
        kind: n.kind,
        state: n.state,
        iface: n.ifaceHint ?? "",
        meta: n.meta ?? {},
        color: palette(n.kind, n.state),
        pillW,
      },
    });
  }
  for (const e of edges) {
    els.push({
      data: {
        id: e.id,
        source: e.source,
        target: e.target,
        kind: e.kind,
      },
    });
  }
  return els;
}

function nodeMatchesFilters(
  d: EleData,
  types: Set<string>,
  iface: string,
  query: string,
  legendPick: Set<LegendKey>,
): boolean {
  if (d.kind === "ripple") return true;
  if (legendPick.size > 0) {
    const st = (d.state as NodeState) ?? "active";
    const k = d.kind as string;
    if (!legendPick.has(nodeLegendKey(k, st))) return false;
  }
  if (d.kind === "service" && types.size > 0) {
    const t = ((d.meta as Record<string, string> | undefined)?.type ?? "").toLowerCase();
    if (!types.has(t)) return false;
  }
  if (iface && d.kind === "service" && d.iface && String(d.iface) !== iface) return false;
  const needle = query.trim().toLowerCase();
  if (needle) {
    const hay = `${d.fullLabel ?? ""} ${d.id ?? ""} ${JSON.stringify(d.meta ?? {})}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function applyFilterVisibility(
  cy: Core,
  types: Set<string>,
  iface: string,
  query: string,
  legendPick: Set<LegendKey>,
): void {
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      if (String(n.data("kind")) === "ripple") return;
      const ok = nodeMatchesFilters(n.data() as EleData, types, iface, query, legendPick);
      if (ok) n.removeClass("filter-hide");
      else n.addClass("filter-hide");
    });
    cy.edges().forEach((e) => {
      const s = e.source();
      const t = e.target();
      const ok =
        nodeMatchesFilters(s.data() as EleData, types, iface, query, legendPick) &&
        nodeMatchesFilters(t.data() as EleData, types, iface, query, legendPick);
      if (ok) e.removeClass("filter-hide");
      else e.addClass("filter-hide");
    });
  });
}

function placeNewNodesNearNeighbors(cy: Core): void {
  cy.nodes()
    .filter((n) => String(n.data("kind")) !== "ripple")
    .forEach((n) => {
    const p = n.position();
    const deg = n.degree(false);
    if (deg === 0) {
      if (Math.hypot(p.x, p.y) < 1e-3) {
        n.position({ x: 40 + Math.random() * 120, y: 40 + Math.random() * 120 });
      }
      return;
    }
    const nb = n
      .neighborhood("node")
      .filter((m) => {
        const q = m.position();
        return m.id() !== n.id() && (Math.abs(q.x) > 1e-3 || Math.abs(q.y) > 1e-3);
      })
      .first();
    if (nb.empty()) return;
    const q = nb.position();
    if (Math.hypot(p.x, p.y) < 1e-3 || (Math.abs(p.x) < 1 && Math.abs(p.y) < 1)) {
      const ang = Math.random() * Math.PI * 2;
      const r = 36 + Math.random() * 24;
      n.position({ x: q.x + Math.cos(ang) * r, y: q.y + Math.sin(ang) * r });
    }
  });
}

function mergeGraphElements(cy: Core, next: ElementDefinition[]): void {
  const nextIds = new Set(next.map((e) => String(e.data?.id ?? "")));
  cy.batch(() => {
    cy.elements()
      .filter((ele) => !nextIds.has(ele.id()) && !(ele.isNode() && String(ele.data("kind")) === "ripple"))
      .remove();

    for (const def of next) {
      const id = String(def.data?.id ?? "");
      if (!id) continue;
      const ex = cy.getElementById(id);
      if (ex.empty()) {
        cy.add(def);
      } else {
        ex.data(def.data ?? {});
      }
    }
  });
}

/** Compare incoming snapshot nodes to current graph data (call before `mergeGraphElements`). */
function collectDataTouchPulseIds(cy: Core, next: ElementDefinition[]): string[] {
  const ids: string[] = [];
  for (const def of next) {
    const d = def.data;
    if (!d || typeof d !== "object" || "source" in d) continue;
    const id = String((d as { id?: string }).id ?? "");
    if (!id) continue;
    const ex = cy.getElementById(id);
    if (ex.empty()) continue;
    const prev = stableDataJson(ex.data() as Record<string, unknown>);
    const nxt = stableDataJson(d as Record<string, unknown>);
    if (prev !== nxt) ids.push(id);
  }
  return ids;
}

function stableDataJson(d: Record<string, unknown>): string {
  const keys = Object.keys(d).sort();
  const o: Record<string, unknown> = {};
  for (const k of keys) o[k] = d[k];
  return JSON.stringify(o);
}

let rippleSeq = 0;
const rippleCooldown = new Map<string, number>();
const RIPPLE_COOLDOWN_MS = 140;

function spawnRippleThrottled(cy: Core, nodeId: string): void {
  const t = Date.now();
  const prev = rippleCooldown.get(nodeId) ?? 0;
  if (t - prev < RIPPLE_COOLDOWN_MS) return;
  rippleCooldown.set(nodeId, t);
  spawnRippleAtNode(cy, nodeId);
}

function spawnRippleAtNode(cy: Core, nodeId: string): void {
  const source = cy.getElementById(nodeId);
  if (source.empty()) return;
  if (String(source.data("kind")) === "ripple") return;
  const pos = source.position();
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
  const color = String(source.data("color") ?? "#60a5fa");
  const rid = `__ripple_${++rippleSeq}_${Date.now()}`;
  cy.batch(() => {
    cy.add({
      group: "nodes",
      data: { id: rid, kind: "ripple", ringColor: color },
      classes: "ripple-node",
      position: { x: pos.x, y: pos.y },
    });
  });
  const r = cy.getElementById(rid);
  if (r.empty()) return;
  r.style({ width: 10, height: 10, "border-opacity": 0.88 });
  r.animate({
    style: { width: 132, height: 132, "border-opacity": 0 },
    duration: 980,
    easing: "ease-out-cubic",
    complete: () => {
      try {
        r.remove();
      } catch {
        /* already removed */
      }
    },
  });
}

function discoveryEventRelatedNodeIds(ev: DiscoveryEvent, snap: GraphSnapshot | null): string[] {
  if (!snap) return [];
  const ids = new Set<string>();
  const blob = (ev.records ?? [])
    .map((r) => `${r.name} ${r.rdata}`)
    .join(" ")
    .toLowerCase();
  const srcIp = parseEventSrcIP(ev.src);

  for (const n of snap.nodes) {
    if (n.kind === "host") {
      const metaIps = (n.meta?.ips ?? "")
        .split(",")
        .map((x) => x.trim().split("%")[0])
        .filter(Boolean);
      if (srcIp && metaIps.some((ip) => normName(ip) === normName(srcIp))) {
        ids.add(n.id);
        continue;
      }
      const hk = hostKeyFromNodeId(n.id);
      if (hk.length >= 2 && blob.includes(hk)) ids.add(n.id);
      const lab = normName(n.label);
      if (lab.length >= 3 && blob.includes(lab)) ids.add(n.id);
    } else if (n.kind === "service") {
      const inst = normName((n.meta?.instance ?? n.label ?? "").toString());
      if (inst.length >= 2 && blob.includes(inst)) ids.add(n.id);
    }
  }
  return Array.from(ids).slice(0, 8);
}

export function App() {
  const cyHost = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const [snap, setSnap] = useState<GraphSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<DiscoveryEvent[]>([]);
  const [query, setQuery] = useState("");
  const [iface, setIface] = useState("");
  const [types, setTypes] = useState<Set<string>>(() => new Set());
  const [legendPick, setLegendPick] = useState<Set<LegendKey>>(() => new Set());
  const [status, setStatus] = useState("connecting");
  const [cyReady, setCyReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [eventsFloatOpen, setEventsFloatOpen] = useState(true);
  const [eventsFloatTall, setEventsFloatTall] = useState(true);
  const [eventsShowRaw, setEventsShowRaw] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const hasInitialLayoutRef = useRef(false);
  const structureSigRef = useRef("");
  const snapRef = useRef<GraphSnapshot | null>(null);

  const ifaceChoices = useMemo(() => {
    const s = new Set<string>();
    if (!snap) return s;
    for (const n of snap.nodes) {
      if (n.ifaceHint) s.add(n.ifaceHint);
    }
    return s;
  }, [snap]);

  const typeChoices = useMemo(() => {
    const s = new Set<string>();
    if (!snap) return [];
    for (const n of snap.nodes) {
      if (n.kind === "service" && n.meta?.type) s.add(n.meta.type.toLowerCase());
    }
    return Array.from(s).sort();
  }, [snap]);

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      try {
        const mod = await import("cytoscape");
        const cytoscape = mod.default;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        if (cancelled) return;
        const el = cyHost.current;
        if (!el) {
          throw new Error("Graph container missing");
        }

        const cy = cytoscape({
          container: el,
          minZoom: 0.08,
          maxZoom: 5,
          wheelSensitivity: 0.18,
          motionBlur: false,
          style: [
            {
              selector: "node",
              style: {
                label: "data(fullLabel)",
                "font-size": "9px",
                "font-weight": 500,
                "min-zoomed-font-size": 4,
                color: "#f8fafc",
                "background-color": "data(color)",
                "text-halign": "center",
                "text-valign": "bottom",
                "text-margin-y": 10,
                "text-wrap": "wrap",
                "text-max-width": "160px",
                "text-justification": "center",
                "text-outline-width": 2,
                "text-outline-color": "#020617",
                "text-outline-opacity": 1,
                "text-background-color": "#020617",
                "text-background-opacity": 0.92,
                "text-background-padding": "5px",
                "text-background-shape": "roundrectangle",
                "text-border-width": 1,
                "text-border-color": "#475569",
                "text-border-opacity": 1,
                width: 30,
                height: 30,
                "border-width": 1,
                "border-color": "#0f172a",
              },
            },
            {
              selector: 'node[kind = "host"]',
              style: {
                width: 30,
                height: 30,
                "font-size": "9px",
              },
            },
            {
              selector: 'node[kind = "service_type"]',
              style: {
                width: 24,
                height: 24,
              },
            },
            {
              selector: 'node[kind = "service"]',
              style: {
                shape: "round-rectangle",
                width: (ele: NodeSingular) => {
                  const w = Number(ele.data("pillW"));
                  return Number.isFinite(w) && w > 0 ? w : 48;
                },
                height: PILL_MODEL_H,
                "font-size": "7px",
                "font-weight": 600,
                "min-zoomed-font-size": 3,
                "text-valign": "center",
                "text-halign": "center",
                "text-margin-y": 0,
                "text-margin-x": 0,
                "text-wrap": "ellipsis",
                "text-max-width": 100,
                "text-justification": "center",
                "text-background-opacity": 0,
                "text-background-color": "transparent",
                "text-background-padding": "0px",
                "text-background-shape": "rectangle",
                "text-border-width": 0,
                "text-border-opacity": 0,
                "text-outline-width": 0,
                "text-outline-opacity": 0,
                "border-width": 1,
                "border-color": "#be185d",
                "border-opacity": 1,
              },
            },
            {
              selector: 'node[kind = "service"].filter-hide',
              style: {
                "border-opacity": 0.15,
              },
            },
            {
              selector: 'node[kind = "ripple"]',
              style: {
                shape: "ellipse",
                label: "",
                width: 12,
                height: 12,
                "background-opacity": 0,
                "background-color": "#000000",
                "border-width": 2,
                "border-color": "data(ringColor)",
                "border-opacity": 0.85,
                "text-opacity": 0,
                "text-background-opacity": 0,
                "border-style": "solid",
                events: "no",
                "z-index": -1,
              },
            },
            {
              selector: "node.filter-hide",
              style: {
                opacity: 0.12,
                "text-opacity": 0.08,
                "text-background-opacity": 0.08,
              },
            },
            {
              selector: "edge",
              style: {
                width: 1.2,
                "line-color": "#475569",
                "target-arrow-color": "#475569",
                "target-arrow-shape": "triangle",
                "curve-style": "bezier",
                opacity: 0.75,
              },
            },
            {
              selector: 'edge[kind = "advertises"]',
              style: {
                "curve-style": "straight",
                "line-style": "solid",
                "target-arrow-shape": "none",
                "source-arrow-shape": "none",
                width: 1,
                "line-color": "#64748b",
                opacity: 0.65,
              },
            },
            {
              selector: "edge.filter-hide",
              style: {
                opacity: 0.04,
              },
            },
          ],
        });
        if (cancelled) {
          cy.destroy();
          return;
        }
        cy.on("tap", "node", (evt) => {
          if (String(evt.target.data("kind")) === "ripple") return;
          setSelected(evt.target.id());
        });
        cy.on("tap", (evt) => {
          if (evt.target === cy) setSelected(null);
        });

        cy.on("dblclick", "core", (evt) => {
          const z = cy.zoom();
          const next = Math.min(z * 1.22, cy.maxZoom());
          const rp = evt.renderedPosition;
          if (rp) {
            cy.animate({
              zoom: { level: next, renderedPosition: { x: rp.x, y: rp.y } },
              duration: 240,
              easing: "ease-out-cubic",
            });
          }
        });

        cyRef.current = cy;
        setCyReady(true);
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setBootError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    void setup();

    return () => {
      cancelled = true;
      hasInitialLayoutRef.current = false;
      structureSigRef.current = "";
      setCyReady(false);
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, []);

  const loadGraph = useCallback(async () => {
    try {
      const r = await fetch("/api/v1/graph");
      if (!r.ok) return;
      const j = normalizeGraph(await r.json());
      setSnap(j);
    } catch (e) {
      console.error("graph fetch:", e);
    }
  }, []);

  useEffect(() => {
    void loadGraph();
    const id = window.setInterval(() => void loadGraph(), 12000);
    return () => window.clearInterval(id);
  }, [loadGraph]);

  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);

  useEffect(() => {
    if (!snap || !selected) return;
    if (!snap.nodes.some((n) => n.id === selected)) setSelected(null);
  }, [snap, selected]);

  useEffect(() => {
    const ws = new WebSocket(wsURL());
    let debounce: number | undefined;
    ws.onopen = () => setStatus("live");
    ws.onclose = () => setStatus("disconnected");
    ws.onerror = () => setStatus("error");
    ws.onmessage = (m) => {
      let ev: DiscoveryEvent | null = null;
      try {
        ev = JSON.parse(String(m.data)) as DiscoveryEvent;
        setEvents((prev) => {
          const next = [ev!, ...prev];
          return next.slice(0, 500);
        });
      } catch {
        // ignore malformed frames
      }
      if (ev) {
        const cy = cyRef.current;
        if (cy) {
          for (const id of discoveryEventRelatedNodeIds(ev, snapRef.current)) {
            spawnRippleThrottled(cy, id);
          }
        }
      }
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void loadGraph(), 1800);
    };
    return () => {
      window.clearTimeout(debounce);
      ws.close();
    };
  }, [loadGraph]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !snap || !cyReady) return;

    const full = toElementsFull(snap);
    const structKey = graphStructureKey(snap);
    const structureChanged = structKey !== structureSigRef.current;

    const touchPulse =
      hasInitialLayoutRef.current && !structureChanged && full.length > 0
        ? collectDataTouchPulseIds(cy, full)
        : [];

    mergeGraphElements(cy, full);
    applyFilterVisibility(cy, types, iface, query, legendPick);

    for (const id of touchPulse) {
      spawnRippleThrottled(cy, id);
    }

    if (full.length === 0) {
      structureSigRef.current = structKey;
      cy.elements()
        .filter((e) => e.isNode() && String(e.data("kind")) === "ripple")
        .remove();
      cy.resize();
      return;
    }

    const runLayout = (first: boolean) => {
      structureSigRef.current = structKey;
      cy.elements()
        .filter((e) => e.isNode() && String(e.data("kind")) === "ripple")
        .remove();
      placeNewNodesNearNeighbors(cy);
      const layout = cy.layout({
        name: "cose",
        animate: false,
        animationDuration: 0,
        animationEasing: "ease-out-cubic",
        randomize: first,
        padding: 28,
        componentSpacing: 72,
        nodeRepulsion: 5600,
        gravity: 0.18,
        idealEdgeLength: 72,
        nodeDimensionsIncludeLabels: true,
        fit: false,
      });
      layout.one("layoutstop", () => {
        positionServicePillsNearHosts(cy);
        resolveIntraHostPillOverlaps(cy);
        if (first) {
          cy.animate({
            fit: { eles: cy.elements(), padding: 40 },
            duration: 260,
            easing: "ease-out-cubic",
            complete: () => {
              cy.resize();
            },
          });
        } else {
          cy.resize();
        }
      });
      layout.run();
    };

    if (!hasInitialLayoutRef.current) {
      hasInitialLayoutRef.current = true;
      runLayout(true);
    } else if (structureChanged) {
      runLayout(false);
    } else {
      positionServicePillsNearHosts(cy);
      resolveIntraHostPillOverlaps(cy);
      cy.resize();
    }
  }, [snap, types, iface, query, legendPick, cyReady]);

  useEffect(() => {
    if (!cyReady) return;
    const el = cyHost.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const cy = cyRef.current;
    if (!cy) return;
    const ro = new ResizeObserver(() => {
      cy.resize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [cyReady]);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => cyRef.current?.resize());
    return () => window.cancelAnimationFrame(id);
  }, [eventsFloatOpen, eventsFloatTall, cyReady]);

  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const packetTimeline = useMemo(() => {
    const buckets = 72;
    const windowMs = 120_000;
    const now = clock;
    const start = now - windowMs;
    const counts = new Array<number>(buckets).fill(0);
    let total = 0;
    for (const ev of events) {
      const t = Date.parse(ev.time);
      if (!Number.isFinite(t) || t < start) continue;
      if (t > now + 10_000) continue;
      total++;
      const slot = Math.min(
        buckets - 1,
        Math.max(0, Math.floor(((t - start) / windowMs) * buckets)),
      );
      counts[slot]++;
    }
    const max = Math.max(1, ...counts);
    return { counts, max, total };
  }, [events, clock]);

  const clockLabel = useMemo(
    () =>
      new Date(clock).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    [clock],
  );

  const filteredEvents = useMemo(() => {
    if (!selected?.startsWith("host:") || !snap) return events;
    const hk = hostKeyFromNodeId(selected);
    const node = snap.nodes.find((n) => n.id === selected);
    const h = snap.hosts?.[hk];
    const needles: string[] = [hk];
    if (h?.hostname) needles.push(h.hostname);
    if (h?.displayLabel) needles.push(h.displayLabel);
    if (h?.aliases?.length) needles.push(...h.aliases);
    const ips = (h?.ips ?? (node?.meta?.ips ? node.meta.ips.split(",").map((x) => x.trim()) : [])).map((ip) =>
      ip.split("%")[0].trim(),
    );
    return events.filter((ev) => {
      const srcIP = parseEventSrcIP(ev.src);
      if (srcIP && ips.some((ip) => ip && normName(ip) === normName(srcIP))) return true;
      return eventRelatesToHost(ev, needles);
    });
  }, [events, selected, snap]);

  const [showRaw, setShowRaw] = useState(false);
  useEffect(() => {
    setShowRaw(false);
  }, [selected]);

  const selectionRawJson = useMemo(() => {
    if (!snap || !selected) return "";
    if (selected.startsWith("svc:")) {
      const key = selected.slice("svc:".length);
      return JSON.stringify(snap.services[key] ?? null, null, 2);
    }
    if (selected.startsWith("host:")) {
      const hk = hostKeyFromNodeId(selected);
      const h = snap.hosts?.[hk];
      const node = snap.nodes.find((n) => n.id === selected);
      return JSON.stringify({ node, host: h ?? null }, null, 2);
    }
    const node = snap.nodes.find((n) => n.id === selected);
    return JSON.stringify(node ?? null, null, 2);
  }, [snap, selected]);

  const selectionCurated = useMemo(() => {
    if (!snap || !selected) return null;
    if (selected.startsWith("svc:")) {
      const key = selected.slice("svc:".length);
      const s = snap.services[key];
      if (!s) {
        return <p className="selection-empty">Service not found in snapshot.</p>;
      }
      const ttlPct =
        s.originalTtl > 0 ? Math.min(100, Math.round((100 * s.ttl) / Math.max(1, s.originalTtl))) : 0;
      return (
        <div className="svc-panel">
          <div className="svc-hero">
            <div className="svc-hero-top">
              <span className="svc-badge">DNS-SD</span>
              <span className={`svc-live-dot${s.goodbye ? " svc-live-dot--off" : ""}`} title={s.goodbye ? "Goodbye" : "Active"} />
            </div>
            <h3 className="svc-title">{formatNodeCaption(s.instance)}</h3>
            <p className="svc-type-friendly">{friendlyServiceTypeName(s.serviceType)}</p>
            <div className="svc-hero-meta">
              <span className="svc-type-pill" title={s.serviceType}>
                {s.serviceType}
              </span>
              <span className="svc-port-pill">:{s.port}</span>
            </div>
          </div>
          <div className="svc-metrics">
            <div className="svc-metric">
              <span className="svc-metric-label">Target</span>
              <span className="svc-metric-value">{s.targetHost || "—"}</span>
            </div>
            <div className="svc-metric">
              <span className="svc-metric-label">Interface</span>
              <span className="svc-metric-value">{s.ifaceLast || "—"}</span>
            </div>
            <div className="svc-metric">
              <span className="svc-metric-label">Last seen</span>
              <span className="svc-metric-value">{s.lastSeen ? new Date(s.lastSeen).toLocaleString() : "—"}</span>
            </div>
            <div className="svc-metric">
              <span className="svc-metric-label">Expires</span>
              <span className="svc-metric-value">{s.expiresAt ? new Date(s.expiresAt).toLocaleString() : "—"}</span>
            </div>
          </div>
          <div className="svc-ttl-block">
            <div className="svc-ttl-head">
              <span>TTL</span>
              <span className="svc-ttl-nums">
                {s.ttl}s <span className="svc-ttl-muted">/ {s.originalTtl}s</span>
              </span>
            </div>
            <div className="svc-ttl-bar" role="presentation">
              <div className="svc-ttl-fill" style={{ width: `${ttlPct}%` }} />
            </div>
          </div>
          {s.txt && Object.keys(s.txt).length > 0 ? (
            <div className="svc-txt-block">
              <div className="svc-txt-label">TXT</div>
              <div className="svc-txt-chips">
                {Object.entries(s.txt).map(([k, v]) => (
                  <span key={k} className="svc-txt-chip" title={`${k}=${v}`}>
                    <strong>{k}</strong>
                    <span className="svc-txt-chip-val">{v || "∅"}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      );
    }
    if (selected.startsWith("host:")) {
      const hk = hostKeyFromNodeId(selected);
      const h = snap.hosts?.[hk];
      const node = snap.nodes.find((n) => n.id === selected);
      const svcRows = Object.entries(snap.services)
        .filter(([, s]) => normName(s.targetHost) === hk)
        .sort(([a], [b]) => a.localeCompare(b));
      const title = h?.displayLabel || h?.hostname || node?.label || hk;
      return (
        <div className="selection-card">
          <div className="selection-card-head">
            <div>
              <div className="selection-kind">Device</div>
              <h3 className="selection-title">{title}</h3>
            </div>
          </div>
          <dl className="selection-dl">
            <dt>Hostname</dt>
            <dd>{h?.hostname ?? node?.label ?? hk}</dd>
            {h?.aliases && h.aliases.length > 0 ? (
              <>
                <dt>Also known as</dt>
                <dd>{h.aliases.join(", ")}</dd>
              </>
            ) : null}
            <dt>IPs</dt>
            <dd>{h?.ips?.join(", ") || node?.meta?.ips || "—"}</dd>
            <dt>MAC</dt>
            <dd>
              {h?.mac || node?.meta?.mac || "—"}
              {h?.macVendor || node?.meta?.macVendor ? ` (${h?.macVendor ?? node?.meta?.macVendor})` : ""}
            </dd>
            {h?.hints && h.hints.length > 0 ? (
              <>
                <dt>Hints</dt>
                <dd>{h.hints.join(" · ")}</dd>
              </>
            ) : null}
            <dt>Graph state</dt>
            <dd>{node?.state ?? "—"}</dd>
          </dl>
          <div className="selection-kind" style={{ marginTop: "0.45rem" }}>
            Services ({svcRows.length})
          </div>
          {svcRows.length === 0 ? (
            <p className="selection-empty" style={{ margin: "0.25rem 0 0" }}>
              No service rows point at this host in the current snapshot.
            </p>
          ) : (
            <ul className="selection-svc-list">
              {svcRows.map(([instKey, s]) => (
                <li key={instKey}>
                  <strong>{formatNodeCaption(s.instance)}</strong>
                  <span className="selection-svc-friend">{friendlyServiceTypeName(s.serviceType)}</span>
                  <span className="selection-svc-type" title={s.serviceType}>
                    {s.serviceType} · port {s.port}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    const node = snap.nodes.find((n) => n.id === selected);
    if (!node) return <p className="selection-empty">Node not found.</p>;
    if (node.kind === "service_type") {
      const typeStr = node.label || node.id.slice("type:".length);
      return (
        <div className="selection-card">
          <div className="selection-kind">Service type</div>
          <h3 className="selection-title">{friendlyServiceTypeName(typeStr)}</h3>
          <p className="selection-type-raw" title="DNS-SD service type">
            {node.label || typeStr}
          </p>
          <dl className="selection-dl">
            <dt>State</dt>
            <dd>{node.state}</dd>
            <dt>Id</dt>
            <dd>{node.id}</dd>
          </dl>
        </div>
      );
    }
    return (
      <div className="selection-card">
        <div className="selection-kind">Node</div>
        <h3 className="selection-title">{node.label}</h3>
        <dl className="selection-dl">
          <dt>Kind</dt>
          <dd>{node.kind}</dd>
          {node.kind === "service" && node.meta?.type ? (
            <>
              <dt>Service</dt>
              <dd>
                <span className="selection-svc-friend">{friendlyServiceTypeName(node.meta.type)}</span>
                <span className="selection-type-raw" title={node.meta.type}>
                  {node.meta.type}
                </span>
              </dd>
            </>
          ) : null}
          <dt>State</dt>
          <dd>{node.state}</dd>
          <dt>Id</dt>
          <dd>{node.id}</dd>
        </dl>
      </div>
    );
  }, [snap, selected]);

  const toggleType = (t: string) => {
    const k = t.toLowerCase();
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const toggleLegendKey = (key: LegendKey) => {
    setLegendPick((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="app">
      {bootError ? <div className="boot-error">Graph engine failed to start: {bootError}</div> : null}
      <header className="app-header">
        <div className="app-header-brand">
          <span className="brand-dot" aria-hidden />
          <h1>mDNS live topology</h1>
        </div>
        <div className="controls">
          <input
            type="search"
            placeholder="Search instances, TXT, ids…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select value={iface} onChange={(e) => setIface(e.target.value)}>
            <option value="">All interfaces</option>
            {Array.from(ifaceChoices)
              .sort()
              .map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
          </select>
          <span className="pill">stream: {status}</span>
          {!cyReady && !bootError ? <span className="pill">graph: starting…</span> : null}
          <span className="pill" title="Double-click background to zoom in smoothly">
            dbl-click: zoom
          </span>
          {!eventsFloatOpen ? (
            <button
              type="button"
              className="pill pill--click"
              onClick={() => setEventsFloatOpen(true)}
              title="Open discovery events"
            >
              Events
              {events.length > 0 ? <span className="pill-count">{Math.min(999, events.length)}</span> : null}
            </button>
          ) : null}
        </div>
      </header>
      <main className="main-row">
        <div className="cy-wrap">
          <div id="cy" ref={cyHost} />
          <div className="cy-legend" role="toolbar" aria-label="Node appearance">
            <div className="cy-legend-title">Show on graph</div>
            {LEGEND_ROWS.map((row) => {
              const on = legendPick.has(row.key);
              return (
                <button
                  key={row.key}
                  type="button"
                  aria-pressed={on}
                  className={`cy-legend-row${on ? " cy-legend-row--on" : ""}`}
                  title={
                    legendPick.size === 0
                      ? "Click to show only this category. Combine several rows."
                      : on
                        ? "Click to remove from filter"
                        : "Click to add this category"
                  }
                  onClick={() => toggleLegendKey(row.key)}
                >
                  <span className="cy-legend-swatch" style={{ backgroundColor: row.color }} aria-hidden />
                  <span className="cy-legend-label">{row.label}</span>
                </button>
              );
            })}
            <p className="cy-legend-hint">
              {legendPick.size === 0
                ? "All categories visible. Click rows to restrict."
                : `${legendPick.size} selected — only those nodes are shown.`}
            </p>
          </div>
        </div>
        <aside className="app-aside">
          <h2 className="aside-title">Service types</h2>
          <div className="type-chip-list">
            {typeChoices.map((t) => (
              <label key={t} className={`type-chip${types.has(t.toLowerCase()) ? " type-chip--on" : ""}`}>
                <input type="checkbox" checked={types.has(t.toLowerCase())} onChange={() => toggleType(t)} />
                <span>{t}</span>
              </label>
            ))}
          </div>
          <h2 className="aside-title">Selection</h2>
          <div className="selection-panel">
            {!selected ? <p className="selection-empty">Tap a node for details.</p> : null}
            {selected ? (
              <>
                <div className="raw-bar">
                  <button
                    type="button"
                    className={`raw-toggle${showRaw ? " raw-toggle--on" : ""}`}
                    onClick={() => setShowRaw((v) => !v)}
                  >
                    RAW
                  </button>
                </div>
                {showRaw ? (
                  <pre className="raw-json">{selectionRawJson || "{}"}</pre>
                ) : (
                  selectionCurated
                )}
              </>
            ) : null}
          </div>
        </aside>
      </main>
      {eventsFloatOpen ? (
        <aside
          className={`events-float${eventsFloatTall ? " events-float--tall" : " events-float--compact"}`}
          aria-label="Discovery events"
          role="dialog"
        >
          <header className="events-float-header">
            <button
              type="button"
              className="events-float-header-btn"
              title={eventsFloatTall ? "Use compact height" : "Expand height"}
              onClick={() => setEventsFloatTall((v) => !v)}
              aria-pressed={eventsFloatTall}
            >
              <svg className="events-float-header-icon" viewBox="0 0 12 12" aria-hidden>
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.5 9.5 9.5 2.5M9.5 2.5H5.5M9.5 2.5V6.5"
                />
              </svg>
            </button>
            <div className="events-float-title-block">
              <span className="events-float-title">Events</span>
              <span className="events-float-subtitle">
                {selected?.startsWith("host:") ? "filtered to device · " : ""}newest first
              </span>
            </div>
            <div className="events-float-header-right">
              <button
                type="button"
                className={`raw-toggle raw-toggle--float${eventsShowRaw ? " raw-toggle--on" : ""}`}
                onClick={() => setEventsShowRaw((v) => !v)}
              >
                RAW
              </button>
              <button
                type="button"
                className="events-float-close"
                title="Close"
                aria-label="Close events"
                onClick={() => setEventsFloatOpen(false)}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M4.22 4.22a.75.75 0 0 1 1.06 0L8 6.94l2.72-2.72a.75.75 0 1 1 1.06 1.06L9.06 8l2.72 2.72a.75.75 0 1 1-1.06 1.06L8 9.06l-2.72 2.72a.75.75 0 0 1-1.06-1.06L6.94 8 4.22 5.28a.75.75 0 0 1 0-1.06z"
                  />
                </svg>
              </button>
            </div>
          </header>
          <div className="events-float-body">
            {eventsShowRaw ? (
              <pre className="events-float-raw raw-json">{JSON.stringify(filteredEvents.slice(0, 300), null, 2)}</pre>
            ) : (
              <div className="events-float-list">
                {filteredEvents.slice(0, 300).map((ev, i) => {
                  const row = eventRowPresentation(ev);
                  return (
                    <div key={`${ev.time}-${i}`} className="events-float-row">
                      <span className="events-float-ico" title={ev.kind}>
                        {row.icon}
                      </span>
                      <span className={`events-float-tag events-float-tag--${row.tone}`}>{row.tag}</span>
                      <span className="events-float-hops" title="Resource records in frame">
                        {row.rr > 0 ? `${row.rr}→` : "—"}
                      </span>
                      {row.rr > 0 ? (
                        <span className="events-float-eye-pill" title="Records in packet">
                          <span aria-hidden>👁</span>
                          <span>{row.rr}</span>
                        </span>
                      ) : (
                        <span className="events-float-eye-pill events-float-eye-pill--muted" aria-hidden>
                          ·
                        </span>
                      )}
                      <span className="events-float-detail" title={`${ev.src} · ${ev.iface}`}>
                        {row.detail}
                      </span>
                      <span className="events-float-ago">{relativeTimeAgo(ev.time, clock)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      ) : null}
      <div className="live-hud-bar" aria-label="Live packet activity">
        <div className="live-hud-histo" title="Packet counts by time slot (last 2 minutes, newest at right)">
          {packetTimeline.counts.map((c, i) => (
            <span
              key={i}
              className="live-hud-bar-col"
              style={{ height: `${Math.max(5, Math.round((c / packetTimeline.max) * 100))}%` }}
            />
          ))}
        </div>
        <div className="live-hud-side">
          <span className="live-hud-count">
            {packetTimeline.total.toLocaleString()} <span className="live-hud-count-label">packets</span>
            <span className="live-hud-window"> · 2 min window</span>
          </span>
          <time className="live-hud-time" dateTime={new Date(clock).toISOString()}>
            {clockLabel}
          </time>
          <span className={status === "live" ? "live-pill live-pill--on" : "live-pill"}>
            <span className="live-pill-dot" aria-hidden />
            LIVE
          </span>
        </div>
      </div>
      <footer>
        Passive observer on UDP 5353 · DNS-SD queries only ·{" "}
        {snap ? `server time ${snap.serverTime}` : "loading graph…"}
      </footer>
    </div>
  );
}
