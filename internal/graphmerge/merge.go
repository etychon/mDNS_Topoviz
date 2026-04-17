package graphmerge

import (
	"net"
	"regexp"
	"sort"
	"strings"

	"mdns-topoviz/internal/model"
)

var uuidShaped = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.local)?\.?$`)

// MergeDuplicateHosts collapses host entries that share an IP address and/or the
// same Ethernet MAC (from prior enrichment) into one canonical host node. Service
// PTR targets and graph edges are remapped to that canonical key.
func MergeDuplicateHosts(out *model.GraphSnapshot) {
	if out == nil || len(out.Hosts) < 2 {
		return
	}
	keys := make([]string, 0, len(out.Hosts))
	for k := range out.Hosts {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	uf := newUnionFind(keys)
	macGroups := map[string][]string{}
	ipGroups := map[string][]string{}
	for _, k := range keys {
		h := out.Hosts[k]
		if h.MAC != "" {
			m := strings.ToLower(h.MAC)
			macGroups[m] = append(macGroups[m], k)
		}
		for _, ip := range h.IPs {
			if ik := ipMergeKey(ip); ik != "" {
				ipGroups[ik] = append(ipGroups[ik], k)
			}
		}
	}
	for _, g := range macGroups {
		unionAll(uf, g)
	}
	for _, g := range ipGroups {
		unionAll(uf, g)
	}

	seenRoot := map[string]struct{}{}
	components := [][]string{}
	for _, k := range keys {
		r := uf.find(k)
		if _, ok := seenRoot[r]; ok {
			continue
		}
		seenRoot[r] = struct{}{}
		var grp []string
		for _, k2 := range keys {
			if uf.find(k2) == r {
				grp = append(grp, k2)
			}
		}
		if len(grp) > 0 {
			components = append(components, grp)
		}
	}

	redirect := make(map[string]string, len(keys))
	for _, grp := range components {
		canon := pickCanonicalKey(grp, out.Hosts)
		for _, m := range grp {
			redirect[m] = canon
		}
	}

	anyMerge := false
	for k, c := range redirect {
		if k != c {
			anyMerge = true
			break
		}
	}
	if !anyMerge {
		return
	}

	newHosts := make(map[string]model.HostSnapshot, len(out.Hosts))
	for _, grp := range components {
		canon := pickCanonicalKey(grp, out.Hosts)
		newHosts[canon] = mergeHostGroup(canon, grp, out.Hosts)
	}
	out.Hosts = newHosts

	for instKey, s := range out.Services {
		th := model.NormName(s.TargetHost)
		if th == "" {
			continue
		}
		if c, ok := redirect[th]; ok {
			s.TargetHost = c
			out.Services[instKey] = s
		}
	}

	remapHostID := func(id string) string {
		if !strings.HasPrefix(id, "host:") {
			return id
		}
		raw := strings.TrimPrefix(id, "host:")
		k := model.NormName(raw)
		if c, ok := redirect[k]; ok {
			return "host:" + c
		}
		return id
	}

	edgeSeen := map[string]struct{}{}
	newEdges := make([]model.GraphEdge, 0, len(out.Edges))
	for _, e := range out.Edges {
		src := remapHostID(e.Source)
		tgt := remapHostID(e.Target)
		ne := model.GraphEdge{ID: e.ID, Source: src, Target: tgt, Kind: e.Kind}
		if ne.Source == ne.Target {
			continue
		}
		if _, dup := edgeSeen[ne.ID]; dup {
			continue
		}
		edgeSeen[ne.ID] = struct{}{}
		newEdges = append(newEdges, ne)
	}
	sort.Slice(newEdges, func(i, j int) bool { return newEdges[i].ID < newEdges[j].ID })
	out.Edges = newEdges

	rebuildHostNodes(out)
}

func rebuildHostNodes(out *model.GraphSnapshot) {
	rest := make([]model.GraphNode, 0, len(out.Nodes))
	for _, n := range out.Nodes {
		if n.Kind != "host" {
			rest = append(rest, n)
		}
	}
	for k, h := range out.Hosts {
		hid := "host:" + k
		label := h.Hostname
		if h.DisplayLabel != "" {
			label = h.DisplayLabel
		}
		rest = append(rest, model.GraphNode{
			ID:    hid,
			Kind:  "host",
			Label: label,
			State: model.StateActive,
			Meta:  map[string]string{"ips": strings.Join(h.IPs, ",")},
		})
	}
	sort.Slice(rest, func(i, j int) bool { return rest[i].ID < rest[j].ID })
	out.Nodes = rest
}

func mergeHostGroup(canon string, grp []string, hosts map[string]model.HostSnapshot) model.HostSnapshot {
	var out model.HostSnapshot
	out.Hostname = canon

	ipSeen := map[string]struct{}{}
	aliasSeen := map[string]struct{}{}
	var ifaces []string

	display := pickBestHostname(grp, hosts)
	if display == "" {
		display = hosts[canon].Hostname
	}
	if display == "" {
		display = canon
	}
	out.DisplayLabel = display

	for _, k := range grp {
		h := hosts[k]
		if h.Iface != "" {
			ifaces = append(ifaces, h.Iface)
		}
		for _, ip := range h.IPs {
			if _, ok := ipSeen[ip]; !ok {
				ipSeen[ip] = struct{}{}
				out.IPs = append(out.IPs, ip)
			}
		}
		if h.MAC != "" {
			out.MAC = strings.ToLower(h.MAC)
		}
		if h.MACVendor != "" {
			out.MACVendor = h.MACVendor
		}
		for _, hint := range h.Hints {
			out.Hints = appendUniqStr(out.Hints, hint)
		}
		for _, cand := range []string{h.Hostname, k} {
			if cand == "" {
				continue
			}
			if model.NormName(cand) == model.NormName(canon) {
				continue
			}
			if model.NormName(cand) == model.NormName(display) {
				continue
			}
			if _, ok := aliasSeen[cand]; !ok {
				aliasSeen[cand] = struct{}{}
				out.Aliases = append(out.Aliases, cand)
			}
		}
	}
	sort.Strings(out.Aliases)
	if len(ifaces) > 0 {
		out.Iface = ifaces[len(ifaces)-1]
	}
	return out
}

func pickBestHostname(grp []string, hosts map[string]model.HostSnapshot) string {
	best := ""
	bestScore := -1
	for _, k := range grp {
		hn := hosts[k].Hostname
		if hn == "" {
			hn = k
		}
		if s := hostnameScoreVal(hn); s > bestScore {
			bestScore = s
			best = hn
		}
	}
	return best
}

func hostnameScoreVal(host string) int {
	h := strings.TrimSpace(strings.ToLower(host))
	score := len(h)
	if uuidShaped.MatchString(h) {
		score -= 80
	}
	return score
}

func pickCanonicalKey(grp []string, hosts map[string]model.HostSnapshot) string {
	best := grp[0]
	bestVal := hostnameScoreVal(hosts[best].Hostname)
	if hosts[best].Hostname == "" {
		bestVal = hostnameScoreVal(best)
	}
	for _, k := range grp[1:] {
		v := hostnameScoreVal(hosts[k].Hostname)
		if hosts[k].Hostname == "" {
			v = hostnameScoreVal(k)
		}
		if v > bestVal {
			bestVal = v
			best = k
		} else if v == bestVal && k < best {
			best = k
		}
	}
	return best
}

func appendUniqStr(slice []string, v string) []string {
	for _, x := range slice {
		if x == v {
			return slice
		}
	}
	return append(slice, v)
}

func ipMergeKey(ip string) string {
	s := strings.TrimSpace(strings.ToLower(ip))
	if i := strings.Index(s, "%"); i >= 0 {
		s = s[:i]
	}
	p := net.ParseIP(s)
	if p == nil {
		return ""
	}
	if p4 := p.To4(); p4 != nil {
		return p4.String()
	}
	return p.String()
}

type unionFind struct {
	parent map[string]string
}

func newUnionFind(keys []string) *unionFind {
	p := make(map[string]string, len(keys))
	for _, k := range keys {
		p[k] = k
	}
	return &unionFind{parent: p}
}

func (u *unionFind) find(x string) string {
	if u.parent[x] != x {
		u.parent[x] = u.find(u.parent[x])
	}
	return u.parent[x]
}

func (u *unionFind) union(a, b string) {
	if a == "" || b == "" {
		return
	}
	ra, rb := u.find(a), u.find(b)
	if ra != rb {
		u.parent[ra] = rb
	}
}

func unionAll(uf *unionFind, keys []string) {
	if len(keys) < 2 {
		return
	}
	k0 := keys[0]
	for _, k := range keys[1:] {
		uf.union(k0, k)
	}
}
