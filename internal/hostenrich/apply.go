package hostenrich

import (
	"sort"
	"strings"

	"mdns-topoviz/internal/model"
)

// Apply mutates a freshly-built snapshot: ARP→MAC/vendor, hostname hints, and
// which services advertise on each host (all passive / read-only).
func Apply(out *model.GraphSnapshot, services map[string]model.ServiceSnapshot) {
	if out == nil {
		return
	}
	for k, h := range out.Hosts {
		nh := h
		applyToHost(&nh, k, services)
		out.Hosts[k] = nh
	}
	for i := range out.Nodes {
		if out.Nodes[i].Kind != "host" {
			continue
		}
		raw := strings.TrimPrefix(out.Nodes[i].ID, "host:")
		key := model.NormName(raw)
		if key == "" {
			continue
		}
		if hs, ok := out.Hosts[key]; ok {
			out.Nodes[i].Meta = hostMeta(hs)
		}
	}
}

func applyToHost(h *model.HostSnapshot, hostKey string, services map[string]model.ServiceSnapshot) {
	for _, ip := range h.IPs {
		if mac := MACForIP(ip); mac != "" {
			h.MAC = mac
			if v := lookupVendor(mac); v != "" {
				h.MACVendor = v
			}
			break
		}
	}
	for _, hint := range HostnameHints(h.Hostname) {
		h.Hints = appendUniq(h.Hints, hint)
	}
	for _, hint := range HostnameHints(h.DisplayLabel) {
		h.Hints = appendUniq(h.Hints, hint)
	}
	var rows []model.HostAdvertised
	for _, s := range services {
		if model.NormName(s.TargetHost) != hostKey {
			continue
		}
		rows = append(rows, model.HostAdvertised{
			ServiceType: s.ServiceType,
			Instance:    s.Instance,
			Port:        s.Port,
		})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].ServiceType != rows[j].ServiceType {
			return rows[i].ServiceType < rows[j].ServiceType
		}
		return rows[i].Instance < rows[j].Instance
	})
	h.Advertised = rows
}

func appendUniq(slice []string, v string) []string {
	for _, x := range slice {
		if x == v {
			return slice
		}
	}
	return append(slice, v)
}

func hostMeta(h model.HostSnapshot) map[string]string {
	m := map[string]string{
		"ips": strings.Join(h.IPs, ","),
	}
	if h.MAC != "" {
		m["mac"] = h.MAC
	}
	if h.MACVendor != "" {
		m["macVendor"] = h.MACVendor
	}
	if len(h.Hints) > 0 {
		m["hints"] = strings.Join(h.Hints, " | ")
	}
	if len(h.Advertised) > 0 {
		var parts []string
		for _, a := range h.Advertised {
			parts = append(parts, a.ServiceType+" · "+a.Instance)
		}
		m["advertisedServices"] = strings.Join(parts, "; ")
	}
	if len(h.Aliases) > 0 {
		m["aliases"] = strings.Join(h.Aliases, ", ")
	}
	if h.DisplayLabel != "" && strings.TrimSpace(strings.ToLower(h.DisplayLabel)) != strings.TrimSpace(strings.ToLower(h.Hostname)) {
		m["displayLabel"] = h.DisplayLabel
	}
	return m
}
