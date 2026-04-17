package api

import (
	"encoding/json"
	"sync"

	"github.com/gorilla/websocket"
	"mdns-topoviz/internal/model"
)

// Hub fans out discovery events to WebSocket subscribers.
type Hub struct {
	mu   sync.Mutex
	subs map[*websocket.Conn]struct{}
}

func NewHub() *Hub {
	return &Hub{subs: make(map[*websocket.Conn]struct{})}
}

func (h *Hub) Add(c *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.subs[c] = struct{}{}
}

func (h *Hub) Remove(c *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subs, c)
}

func (h *Hub) Publish(ev model.Event) {
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.subs {
		if err := c.WriteMessage(websocket.TextMessage, b); err != nil {
			_ = c.Close()
			delete(h.subs, c)
		}
	}
}
