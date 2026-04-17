package api

import (
	"bytes"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"net/http"
	"path"
	"time"

	"github.com/gorilla/websocket"
	"mdns-topoviz/internal/config"
	"mdns-topoviz/internal/discovery"
	"mdns-topoviz/internal/graphmerge"
	"mdns-topoviz/internal/hostenrich"
	"mdns-topoviz/internal/model"
	"mdns-topoviz/internal/webui"
)

// Server wires REST, WebSocket, and embedded static assets.
type Server struct {
	cfg   config.Config
	reg   *model.Registry
	ring  *model.Ring
	eng   *discovery.Engine
	hub   *Hub
	up    websocket.Upgrader
	asset fs.FS
}

func NewServer(cfg config.Config, reg *model.Registry, ring *model.Ring, eng *discovery.Engine, hub *Hub) *Server {
	sub, err := fs.Sub(webui.Assets, "assets")
	if err != nil {
		log.Fatalf("webui assets: %v", err)
	}
	return &Server{
		cfg:   cfg,
		reg:   reg,
		ring:  ring,
		eng:   eng,
		hub:   hub,
		asset: sub,
		up: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 4096,
			CheckOrigin: func(r *http.Request) bool {
				return true
			},
		},
	}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/health", s.handleHealth)
	mux.HandleFunc("/api/v1/graph", s.handleGraph)
	mux.HandleFunc("/api/v1/events", s.handleEvents)
	mux.HandleFunc("/api/v1/stream", s.handleStream)
	mux.Handle("/", spaFS(s.asset))
	return withCommonHeaders(mux)
}

func withCommonHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":   true,
		"time": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (s *Server) handleGraph(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	snap := s.reg.Snapshot(time.Now(), s.cfg.NewPulseWindow, s.cfg.StaleRatio)
	hostenrich.Apply(&snap, snap.Services)
	graphmerge.MergeDuplicateHosts(&snap)
	hostenrich.Apply(&snap, snap.Services)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(snap)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"events": s.ring.Snapshot(),
	})
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	c, err := s.up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	s.hub.Add(c)
	go func() {
		defer s.hub.Remove(c)
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				_ = c.Close()
				return
			}
		}
	}()
}

// spaFS serves the Vite build without redirect loops on "/".
// http.FileServer can issue redirects for directory canonicalization; rewriting
// only URL.Path while leaving other request fields intact is a common source
// of ERR_TOO_MANY_REDIRECTS behind reverse proxies and with some clients.
func spaFS(root fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := path.Clean("/" + r.URL.Path)
		if p == "/" || p == "/." {
			serveFSFile(w, r, root, "index.html")
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}

func serveFSFile(w http.ResponseWriter, r *http.Request, fsys fs.FS, name string) {
	f, err := fsys.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}

	var rs io.ReadSeeker
	switch v := f.(type) {
	case io.ReadSeeker:
		rs = v
	default:
		b, err := io.ReadAll(f)
		if err != nil {
			http.Error(w, "read error", http.StatusInternalServerError)
			return
		}
		rs = bytes.NewReader(b)
	}

	http.ServeContent(w, r, name, st.ModTime(), rs)
}
