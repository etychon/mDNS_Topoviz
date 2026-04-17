package model

import (
	"sort"
	"strings"
	"sync"
	"time"
)

// NodeState drives styling in the UI.
type NodeState string

const (
	StateActive  NodeState = "active"
	StateStale   NodeState = "stale"
	StateOffline NodeState = "offline"
	StateNew     NodeState = "new"
)

// GraphNode is a host, service instance, or abstract service type.
type GraphNode struct {
	ID        string            `json:"id"`
	Kind      string            `json:"kind"` // host | service | service_type
	Label     string            `json:"label"`
	State     NodeState         `json:"state"`
	IfaceHint string            `json:"ifaceHint,omitempty"`
	Meta      map[string]string `json:"meta,omitempty"`
}

// GraphEdge connects graph entities.
type GraphEdge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
	Kind   string `json:"kind"` // advertises | type_parent
}

// ServiceSnapshot is the authoritative view of one instance.
type ServiceSnapshot struct {
	Instance    string            `json:"instance"`
	ServiceType string            `json:"serviceType"`
	TargetHost  string            `json:"targetHost"`
	Port        uint16            `json:"port"`
	TXT         map[string]string `json:"txt,omitempty"`
	IPs         []string          `json:"ips,omitempty"`
	TTL         uint32            `json:"ttl"`
	OriginalTTL uint32            `json:"originalTtl"`
	FirstSeen   time.Time         `json:"firstSeen"`
	LastSeen    time.Time         `json:"lastSeen"`
	ExpiresAt   time.Time         `json:"expiresAt"`
	IfaceLast   string            `json:"ifaceLast,omitempty"`
	Goodbye     bool              `json:"goodbye"`
	Records     []WireRecord      `json:"records,omitempty"`
}

// GraphSnapshot is returned over REST for initial hydration.
type GraphSnapshot struct {
	Nodes      []GraphNode                `json:"nodes"`
	Edges      []GraphEdge                `json:"edges"`
	Services   map[string]ServiceSnapshot `json:"services"`
	Hosts      map[string]HostSnapshot    `json:"hosts"`
	ServerTime time.Time                  `json:"serverTime"`
}

// HostAdvertised is a DNS-SD instance that points at this host (PTR target).
type HostAdvertised struct {
	ServiceType string `json:"serviceType"`
	Instance    string `json:"instance"`
	Port        uint16 `json:"port,omitempty"`
}

// HostSnapshot is a discovered hostname with observed addresses.
type HostSnapshot struct {
	Hostname     string           `json:"hostname"`
	DisplayLabel string           `json:"displayLabel,omitempty"` // after merge: friendly label while hostname stays canonical key form
	Aliases      []string         `json:"aliases,omitempty"`
	IPs          []string         `json:"ips,omitempty"`
	Iface        string           `json:"ifaceLast,omitempty"`
	MAC          string           `json:"mac,omitempty"`
	MACVendor    string           `json:"macVendor,omitempty"`
	Hints        []string         `json:"hints,omitempty"`
	Advertised   []HostAdvertised `json:"advertisedServices,omitempty"`
}

// Registry tracks live graph state from parsed packets.
type Registry struct {
	mu       sync.RWMutex
	services map[string]*ServiceSnapshot
	hosts    map[string]*HostSnapshot
}

func NewRegistry() *Registry {
	return &Registry{
		services: make(map[string]*ServiceSnapshot),
		hosts:    make(map[string]*HostSnapshot),
	}
}

func NormName(s string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(s)), ".")
}

func (r *Registry) UpsertService(key string, fn func(*ServiceSnapshot)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ls, ok := r.services[key]
	if !ok {
		ls = &ServiceSnapshot{}
		r.services[key] = ls
	}
	fn(ls)
}

func (r *Registry) MarkHost(name, iface string, ips []string) {
	k := NormName(name)
	if k == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	h, ok := r.hosts[k]
	if !ok {
		h = &HostSnapshot{Hostname: strings.TrimSuffix(name, ".")}
		r.hosts[k] = h
	}
	if iface != "" {
		h.Iface = iface
	}
	if len(ips) > 0 {
		seen := map[string]struct{}{}
		for _, x := range h.IPs {
			seen[x] = struct{}{}
		}
		for _, x := range ips {
			if _, ok := seen[x]; !ok {
				h.IPs = append(h.IPs, x)
				seen[x] = struct{}{}
			}
		}
	}
}

// Snapshot builds API-friendly graph data with derived node states.
func (r *Registry) Snapshot(now time.Time, newWin time.Duration, staleRatio float64) GraphSnapshot {
	r.mu.RLock()
	defer r.mu.RUnlock()

	out := GraphSnapshot{
		Services:   make(map[string]ServiceSnapshot),
		Hosts:      make(map[string]HostSnapshot),
		ServerTime: now,
	}
	nodeSet := map[string]GraphNode{}
	edgeSet := map[string]GraphEdge{}

	for k, h := range r.hosts {
		out.Hosts[k] = *h
		hid := "host:" + k
		nodeSet[hid] = GraphNode{
			ID:    hid,
			Kind:  "host",
			Label: h.Hostname,
			State: StateActive,
			Meta:  map[string]string{"ips": strings.Join(h.IPs, ",")},
		}
	}

	for instKey, sp := range r.services {
		if sp == nil {
			continue
		}
		s := *sp
		skey := "svc:" + instKey
		tgt := NormName(s.TargetHost)
		hid := "host:" + tgt

		st := deriveServiceState(now, s, newWin, staleRatio)

		out.Services[instKey] = s
		nodeSet[skey] = GraphNode{
			ID:        skey,
			Kind:      "service",
			Label:     s.Instance,
			State:     st,
			IfaceHint: s.IfaceLast,
			Meta: map[string]string{
				"type": s.ServiceType,
				"port": formatPort(s.Port),
			},
		}
		if tgt != "" {
			if _, ok := nodeSet[hid]; !ok {
				nodeSet[hid] = GraphNode{
					ID:    hid,
					Kind:  "host",
					Label: s.TargetHost,
					State: StateActive,
				}
			}
			edgeSet["adv:"+instKey] = GraphEdge{
				ID:     "adv:" + instKey,
				Source: hid,
				Target: skey,
				Kind:   "advertises",
			}
		}
		if parent := ParentServiceType(s.ServiceType); parent != "" {
			pn := NormName(parent)
			tid := "type:" + pn
			nodeSet[tid] = GraphNode{
				ID:    tid,
				Kind:  "service_type",
				Label: strings.TrimSuffix(parent, "."),
				State: StateActive,
			}
			edgeSet["sub:"+instKey] = GraphEdge{
				ID:     "sub:" + instKey,
				Source: skey,
				Target: tid,
				Kind:   "type_parent",
			}
		}
	}

	for _, n := range nodeSet {
		out.Nodes = append(out.Nodes, n)
	}
	sort.Slice(out.Nodes, func(i, j int) bool { return out.Nodes[i].ID < out.Nodes[j].ID })
	for _, e := range edgeSet {
		out.Edges = append(out.Edges, e)
	}
	sort.Slice(out.Edges, func(i, j int) bool { return out.Edges[i].ID < out.Edges[j].ID })
	// encoding/json marshals nil slices as null; keep JSON arrays for all clients.
	if out.Nodes == nil {
		out.Nodes = []GraphNode{}
	}
	if out.Edges == nil {
		out.Edges = []GraphEdge{}
	}
	return out
}

func deriveServiceState(now time.Time, s ServiceSnapshot, newWin time.Duration, staleRatio float64) NodeState {
	if s.Goodbye || (!s.ExpiresAt.IsZero() && now.After(s.ExpiresAt)) {
		return StateOffline
	}
	if !s.FirstSeen.IsZero() && now.Sub(s.FirstSeen) <= newWin {
		return StateNew
	}
	if !s.ExpiresAt.IsZero() && s.OriginalTTL > 0 {
		orig := time.Duration(s.OriginalTTL) * time.Second
		rem := s.ExpiresAt.Sub(now)
		if rem > 0 && orig > 0 && rem < orig*time.Duration(staleRatio) {
			return StateStale
		}
	}
	return StateActive
}

func formatPort(p uint16) string {
	const digits = "0123456789"
	if p == 0 {
		return "0"
	}
	var buf [5]byte
	i := len(buf)
	for p > 0 {
		i--
		buf[i] = digits[p%10]
		p /= 10
	}
	return string(buf[i:])
}

// ParentServiceType returns the base type for subtype PTR names.
func ParentServiceType(full string) string {
	f := strings.ToLower(full)
	if idx := strings.Index(f, "._sub."); idx >= 0 {
		return f[idx+len("._sub."):]
	}
	return ""
}
