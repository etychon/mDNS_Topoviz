package hostenrich

import (
	"regexp"
	"strings"
)

// UUID-shaped mDNS names (often privacy / randomized hostnames).
var uuidLikeHostname = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.local)?\.?$`)

// HostnameHints returns passive, best-effort clues about an mDNS hostname.
func HostnameHints(hostname string) []string {
	h := strings.TrimSpace(strings.ToLower(hostname))
	var out []string
	if uuidLikeHostname.MatchString(h) {
		out = append(out, "UUID-shaped .local name — often a randomized privacy hostname (Android, Linux systemd-resolved, Windows private Wi‑Fi / randomized MAC, or some IoT stacks).")
	}
	if strings.HasPrefix(h, "android-") {
		out = append(out, "Prefix \"android-\" commonly indicates an Android device using a derived hostname.")
	}
	if strings.Contains(h, "ipad") || strings.Contains(h, "iphone") || strings.Contains(h, "ipod") {
		out = append(out, "Hostname suggests an Apple mobile device naming pattern.")
	}
	if strings.HasPrefix(h, "desktop-") || strings.HasPrefix(h, "laptop-") || strings.HasPrefix(h, "win-") {
		out = append(out, "Hostname pattern may indicate a Windows PC.")
	}
	return out
}
