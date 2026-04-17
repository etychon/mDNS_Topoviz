package discovery

import (
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
	"mdns-topoviz/internal/model"
)

// Engine merges passive observations into the registry and fan-out events.
type Engine struct {
	reg        *model.Registry
	ring       *model.Ring
	publish    func(model.Event)
	staleRatio float64
	newWindow  time.Duration

	mu        sync.Mutex
	seenTypes map[string]time.Time
}

func NewEngine(reg *model.Registry, ring *model.Ring, publish func(model.Event), staleRatio float64, newWindow time.Duration) *Engine {
	return &Engine{
		reg:        reg,
		ring:       ring,
		publish:    publish,
		staleRatio: staleRatio,
		newWindow:  newWindow,
		seenTypes:  make(map[string]time.Time),
	}
}

// DiscoveredTypes returns browse domains observed via meta-PTR enumeration.
func (e *Engine) DiscoveredTypes() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]string, 0, len(e.seenTypes))
	for t := range e.seenTypes {
		out = append(out, t)
	}
	return out
}

// HandleDNS parses an mDNS payload and updates graph state.
func (e *Engine) HandleDNS(iface, src string, payload []byte) {
	msg := new(dns.Msg)
	if err := msg.Unpack(payload); err != nil {
		return
	}
	now := time.Now()
	var records []dns.RR
	records = append(records, msg.Answer...)
	records = append(records, msg.Ns...)
	records = append(records, msg.Extra...)
	if len(records) == 0 {
		return
	}

	hasPos, hasZero := false, false
	wires := make([]model.WireRecord, 0, len(records))
	for _, rr := range records {
		wires = append(wires, toWire(rr))
		h := rr.Header()
		if h.Ttl == 0 {
			hasZero = true
		} else {
			hasPos = true
		}
	}

	kind := model.EventUpdate
	switch {
	case hasZero && !hasPos:
		kind = model.EventGoodbye
	case hasPos && !hasZero:
		kind = model.EventAnnounce
	}

	for _, rr := range records {
		e.applyRR(iface, now, rr)
	}

	ev := model.Event{
		Time:    now,
		Kind:    kind,
		Iface:   iface,
		Src:     src,
		MsgID:   msg.Id,
		Records: wires,
	}
	e.ring.Add(ev)
	if e.publish != nil {
		e.publish(ev)
	}
}

func toWire(rr dns.RR) model.WireRecord {
	h := rr.Header()
	w := model.WireRecord{
		Name: h.Name,
		Type: rrTypeString(h.Rrtype),
		TTL:  h.Ttl,
	}
	switch v := rr.(type) {
	case *dns.PTR:
		w.RData = v.Ptr
	case *dns.SRV:
		w.RData = formatSRV(v)
	case *dns.TXT:
		w.RData = strings.Join(v.Txt, " | ")
	case *dns.A:
		w.RData = v.A.String()
	case *dns.AAAA:
		w.RData = v.AAAA.String()
	case *dns.NSEC:
		parts := make([]string, 0, len(v.TypeBitMap))
		for _, t := range v.TypeBitMap {
			parts = append(parts, rrTypeString(t))
		}
		w.RData = v.NextDomain + " types=" + strings.Join(parts, ",")
	default:
		w.RData = strings.TrimSpace(strings.TrimPrefix(rr.String(), rr.Header().Name))
	}
	return w
}

func rrTypeString(rt uint16) string {
	switch rt {
	case dns.TypeA:
		return "A"
	case dns.TypeAAAA:
		return "AAAA"
	case dns.TypePTR:
		return "PTR"
	case dns.TypeSRV:
		return "SRV"
	case dns.TypeTXT:
		return "TXT"
	case dns.TypeNSEC:
		return "NSEC"
	case dns.TypeANY:
		return "ANY"
	default:
		return "TYPE" + itoa(int(rt))
	}
}

func formatSRV(v *dns.SRV) string {
	return v.Target + ":" + itoa(int(v.Port)) + " p=" + itoa(int(v.Priority)) + " w=" + itoa(int(v.Weight))
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [16]byte
	n := len(b)
	for i > 0 {
		n--
		b[n] = byte('0' + i%10)
		i /= 10
	}
	return string(b[n:])
}

func (e *Engine) applyRR(iface string, now time.Time, rr dns.RR) {
	h := rr.Header()
	name := h.Name
	ttl := h.Ttl

	switch v := rr.(type) {
	case *dns.PTR:
		e.applyPTR(iface, now, ttl, name, v.Ptr)
	case *dns.SRV:
		e.applySRV(iface, now, ttl, name, v)
	case *dns.TXT:
		e.applyTXT(iface, now, ttl, name, v)
	case *dns.A:
		if ttl == 0 {
			return
		}
		e.reg.MarkHost(name, iface, []string{v.A.String()})
	case *dns.AAAA:
		if ttl == 0 {
			return
		}
		e.reg.MarkHost(name, iface, []string{v.AAAA.String()})
	case *dns.NSEC:
		// retained in event wire form for UI / export
	default:
		// ignore unsupported types for graph
	}
}

func (e *Engine) applyPTR(iface string, now time.Time, ttl uint32, owner, target string) {
	ownerN := model.NormName(owner)
	targetN := model.NormName(target)

	if ownerN == "_services._dns-sd._udp.local" {
		e.mu.Lock()
		e.seenTypes[targetN] = now
		e.mu.Unlock()
		return
	}

	if ttl == 0 {
		e.reg.UpsertService(targetN, func(s *model.ServiceSnapshot) {
			s.Goodbye = true
			s.LastSeen = now
			s.ExpiresAt = now
			s.IfaceLast = iface
			s.TTL = 0
		})
		return
	}

	friendly := friendlyInstance(owner, targetN)
	e.reg.UpsertService(targetN, func(s *model.ServiceSnapshot) {
		if s.FirstSeen.IsZero() {
			s.FirstSeen = now
		}
		s.Instance = friendly
		s.ServiceType = model.NormName(owner)
		s.TTL = ttl
		if s.OriginalTTL == 0 || ttl > s.OriginalTTL {
			s.OriginalTTL = ttl
		}
		s.LastSeen = now
		s.ExpiresAt = now.Add(time.Duration(ttl) * time.Second)
		s.Goodbye = false
		s.IfaceLast = iface
	})
}

func friendlyInstance(owner, targetN string) string {
	ownerN := model.NormName(owner)
	suffix := "." + ownerN
	if strings.HasSuffix(targetN, suffix) {
		return targetN[:len(targetN)-len(suffix)]
	}
	return strings.TrimSuffix(targetN, ".")
}

func (e *Engine) applySRV(iface string, now time.Time, ttl uint32, owner string, v *dns.SRV) {
	key := model.NormName(owner)
	target := strings.TrimSuffix(v.Target, ".")
	if ttl == 0 {
		e.reg.UpsertService(key, func(s *model.ServiceSnapshot) {
			s.Goodbye = true
			s.LastSeen = now
			s.ExpiresAt = now
			s.IfaceLast = iface
			s.TTL = 0
		})
		return
	}
	e.reg.UpsertService(key, func(s *model.ServiceSnapshot) {
		if s.FirstSeen.IsZero() {
			s.FirstSeen = now
		}
		if s.Instance == "" {
			s.Instance = friendlyFromInstanceKey(key)
		}
		if s.ServiceType == "" {
			s.ServiceType = inferServiceTypeFromInstance(key)
		}
		s.TargetHost = target
		s.Port = v.Port
		s.TTL = ttl
		if s.OriginalTTL == 0 || ttl > s.OriginalTTL {
			s.OriginalTTL = ttl
		}
		s.LastSeen = now
		s.ExpiresAt = now.Add(time.Duration(ttl) * time.Second)
		s.Goodbye = false
		s.IfaceLast = iface
	})
	e.reg.MarkHost(v.Target, iface, nil)
}

func friendlyFromInstanceKey(key string) string {
	// key like livingroom._airplay._tcp.local
	i := strings.Index(key, "._")
	if i < 0 {
		return key
	}
	return key[:i]
}

func inferServiceTypeFromInstance(key string) string {
	idx := strings.Index(key, "._")
	if idx < 0 || idx+1 >= len(key) || key[idx+1] != '_' {
		return ""
	}
	return key[idx+1:]
}

func (e *Engine) applyTXT(iface string, now time.Time, ttl uint32, owner string, v *dns.TXT) {
	key := model.NormName(owner)
	if ttl == 0 {
		e.reg.UpsertService(key, func(s *model.ServiceSnapshot) {
			s.LastSeen = now
			s.IfaceLast = iface
		})
		return
	}
	txt := map[string]string{}
	for _, p := range v.Txt {
		if p == "" {
			continue
		}
		if idx := strings.IndexByte(p, '='); idx > 0 {
			txt[p[:idx]] = p[idx+1:]
		} else {
			txt[p] = ""
		}
	}
	e.reg.UpsertService(key, func(s *model.ServiceSnapshot) {
		if s.FirstSeen.IsZero() {
			s.FirstSeen = now
		}
		if s.Instance == "" {
			s.Instance = friendlyFromInstanceKey(key)
		}
		if s.ServiceType == "" {
			s.ServiceType = inferServiceTypeFromInstance(key)
		}
		if len(txt) > 0 {
			if s.TXT == nil {
				s.TXT = map[string]string{}
			}
			for k, val := range txt {
				s.TXT[k] = val
			}
		}
		s.TTL = ttl
		if s.OriginalTTL == 0 || ttl > s.OriginalTTL {
			s.OriginalTTL = ttl
		}
		s.LastSeen = now
		s.ExpiresAt = now.Add(time.Duration(ttl) * time.Second)
		s.Goodbye = false
		s.IfaceLast = iface
	})
}
