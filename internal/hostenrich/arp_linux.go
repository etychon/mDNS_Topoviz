package hostenrich

import (
	"bufio"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

// arpEntry maps normalized IPv4 strings (no zone) to lowercase MAC "aa:bb:cc:dd:ee:ff".
var (
	arpMu      sync.Mutex
	arpCache   map[string]string
	arpCacheAt time.Time
	arpTTL     = 4 * time.Second
)

func ipv4Key(ip string) string {
	s := strings.TrimSpace(strings.ToLower(ip))
	if strings.Contains(s, "%") {
		s = s[:strings.Index(s, "%")]
	}
	p := net.ParseIP(s)
	if p == nil || p.To4() == nil {
		return ""
	}
	return p.To4().String()
}

// MACForIP returns the Ethernet MAC from the kernel ARP cache for this IPv4, if known.
// Read-only: opens /proc/net/arp (no shell). Best-effort; empty on non-Linux or no match.
func MACForIP(ip string) string {
	key := ipv4Key(ip)
	if key == "" {
		return ""
	}
	arpMu.Lock()
	defer arpMu.Unlock()
	if time.Since(arpCacheAt) > arpTTL || arpCache == nil {
		arpCache = loadProcNetArp()
		arpCacheAt = time.Now()
	}
	return arpCache[key]
}

func loadProcNetArp() map[string]string {
	out := make(map[string]string)
	f, err := os.Open("/proc/net/arp")
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return out
	}
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 4 {
			continue
		}
		ip := strings.ToLower(fields[0])
		mac := strings.ToLower(fields[3])
		if mac == "00:00:00:00:00:00" || strings.Contains(mac, "incomplete") {
			continue
		}
		out[ip] = mac
	}
	return out
}
