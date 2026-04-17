package discovery

import (
	"log"
	"strings"
	"time"

	"github.com/miekg/dns"
)

// Querier issues standard DNS-SD discovery queries on the multicast address.
// This is the only intentional write path besides optional operational ICMP.
type Querier struct {
	client   *dns.Client
	addr     string
	engine   *Engine
	interval time.Duration
}

func NewQuerier(engine *Engine, interval time.Duration) *Querier {
	return &Querier{
		client:   &dns.Client{Net: "udp", Timeout: 2 * time.Second},
		addr:     "224.0.0.251:5353",
		engine:   engine,
		interval: interval,
	}
}

func (q *Querier) Run(stop <-chan struct{}) {
	t := time.NewTicker(q.interval)
	defer t.Stop()
	q.metaQuery()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			q.metaQuery()
			q.browseDiscovered()
		}
	}
}

func (q *Querier) metaQuery() {
	m := new(dns.Msg)
	m.SetQuestion("_services._dns-sd._udp.local.", dns.TypePTR)
	m.RecursionDesired = false
	if _, _, err := q.client.Exchange(m, q.addr); err != nil {
		log.Printf("dns-sd meta-query: %v", err)
	}
}

func (q *Querier) browseDiscovered() {
	types := q.engine.DiscoveredTypes()
	for _, dom := range types {
		if dom == "" {
			continue
		}
		name := dom
		if !strings.HasSuffix(name, ".") {
			name += "."
		}
		m := new(dns.Msg)
		m.SetQuestion(name, dns.TypePTR)
		m.RecursionDesired = false
		if _, _, err := q.client.Exchange(m, q.addr); err != nil {
			log.Printf("browse %s: %v", name, err)
		}
	}
}
