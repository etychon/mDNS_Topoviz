package config

import (
	"flag"
	"os"
	"strconv"
	"time"
)

// Config holds runtime options for the observer.
type Config struct {
	HTTPAddr       string
	EventCap       int
	GraceOffline   time.Duration
	NewPulseWindow time.Duration
	StaleRatio     float64
	QueryInterval  time.Duration
	Interfaces     []string
}

func envString(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

// Parse loads flags and environment (env wins for quick overrides).
func Parse() Config {
	var (
		httpAddr       = flag.String("http", ":8765", "HTTP listen address")
		eventCap       = flag.Int("events", 50000, "max retained discovery events (ring buffer)")
		grace          = flag.Duration("grace-offline", 5*time.Minute, "keep offline nodes visible")
		newWindow      = flag.Duration("new-pulse", 30*time.Second, "window for 'new' node highlight")
		staleRatio     = flag.Float64("stale-ttl-ratio", 0.15, "fade when remaining TTL below this fraction of original")
		queryInterval  = flag.Duration("query-interval", 60*time.Second, "DNS-SD meta-query interval")
		ifaceCSV       = flag.String("ifaces", "", "comma-separated interface names (empty = all multicast-capable)")
	)
	flag.Parse()

	cfg := Config{
		HTTPAddr:       envString("MDNS_TOPOVIZ_HTTP", *httpAddr),
		EventCap:       envInt("MDNS_TOPOVIZ_EVENTS", *eventCap),
		GraceOffline:   envDuration("MDNS_TOPOVIZ_GRACE", *grace),
		NewPulseWindow: envDuration("MDNS_TOPOVIZ_NEW", *newWindow),
		StaleRatio:     *staleRatio,
		QueryInterval:  envDuration("MDNS_TOPOVIZ_QUERY_INTERVAL", *queryInterval),
	}
	if v := envString("MDNS_TOPOVIZ_IFACES", *ifaceCSV); v != "" {
		// simple split — full parser can come later
		for _, p := range splitComma(v) {
			if p != "" {
				cfg.Interfaces = append(cfg.Interfaces, p)
			}
		}
	}
	return cfg
}

func splitComma(s string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			seg := trimSpace(s[start:i])
			if seg != "" {
				out = append(out, seg)
			}
			start = i + 1
		}
	}
	return out
}

func trimSpace(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}
