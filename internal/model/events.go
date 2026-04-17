package model

import (
	"sync"
	"time"
)

// EventKind classifies discovery activity for the UI and export.
type EventKind string

const (
	EventAnnounce EventKind = "announce"
	EventGoodbye  EventKind = "goodbye"
	EventUpdate   EventKind = "update"
)

// WireRecord is a compact, JSON-friendly view of an RR.
type WireRecord struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Class string `json:"class,omitempty"`
	TTL   uint32 `json:"ttl"`
	RData string `json:"rdata"`
}

// Event is one timestamped observation pushed to clients and export.
type Event struct {
	Time    time.Time   `json:"time"`
	Kind    EventKind   `json:"kind"`
	Iface   string      `json:"iface"`
	Src     string      `json:"src"`
	MsgID   uint16      `json:"msgId,omitempty"`
	Records []WireRecord `json:"records,omitempty"`
}

// Ring is a fixed-capacity FIFO of events for replay and export.
type Ring struct {
	mu   sync.RWMutex
	cap  int
	buf  []Event
	head int
	full bool
}

func NewRing(capacity int) *Ring {
	if capacity < 1 {
		capacity = 1
	}
	return &Ring{cap: capacity, buf: make([]Event, capacity)}
}

func (r *Ring) Add(e Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf[r.head] = e
	r.head++
	if r.head >= r.cap {
		r.head = 0
		r.full = true
	}
}

func (r *Ring) Snapshot() []Event {
	r.mu.RLock()
	defer r.mu.RUnlock()
	n := r.len()
	out := make([]Event, 0, n)
	start := 0
	if r.full {
		start = r.head
	}
	for i := 0; i < n; i++ {
		idx := (start + i) % r.cap
		out = append(out, r.buf[idx])
	}
	return out
}

func (r *Ring) len() int {
	if r.full {
		return r.cap
	}
	return r.head
}
