package hostenrich

import "strings"

// lookupVendor returns a short vendor name for common home / IoT OUIs (first 3 octets).
// Unknown OUIs return empty string (UI can still show the MAC). Curated offline list only.
func lookupVendor(mac string) string {
	mac = strings.ToLower(strings.TrimSpace(mac))
	parts := strings.Split(mac, ":")
	if len(parts) < 3 {
		return ""
	}
	prefix := strings.Join(parts[:3], ":")
	return ouiTable[prefix]
}

var ouiTable = map[string]string{
	"00:1e:c2": "Apple", "04:0c:ce": "Apple", "28:cf:e9": "Apple", "3c:06:30": "Apple",
	"40:33:1a": "Apple", "54:26:96": "Apple", "60:33:4b": "Apple", "74:e1:82": "Apple",
	"88:63:df": "Apple", "a4:83:e7": "Apple", "b8:09:8a": "Apple", "d8:30:62": "Apple",
	"f0:18:98": "Apple", "fc:25:3f": "Apple",
	"00:17:88": "Signify / Philips Hue",
	"34:7e:5c": "Sonos", "48:a6:b8": "Sonos", "b8:e9:37": "Sonos",
	"00:0e:58": "Netgear", "20:4e:7f": "Netgear", "c0:3f:0e": "Netgear",
	"00:1d:c0": "Ubiquiti", "24:5a:4c": "Ubiquiti", "74:83:c2": "Ubiquiti",
	"f4:92:bf": "Ubiquiti", "fc:ec:da": "Ubiquiti",
	"00:0c:29": "VMware", "00:50:56": "VMware", "00:1c:42": "Parallels",
	"00:16:3e": "Xen / virtual NIC", "52:54:00": "QEMU/KVM",
	"00:1a:2b": "Google", "54:60:09": "Google",
	"00:24:e8": "Espressif", "30:ae:a4": "Espressif", "4c:11:ae": "Espressif",
	"84:0d:8e": "Espressif", "a4:cf:12": "Espressif", "d8:a0:1d": "Espressif",
	"00:1b:21": "Samsung", "40:b0:34": "Samsung", "50:cc:f8": "Samsung",
	"8c:71:f8": "Samsung", "b8:57:d8": "Samsung",
	"00:1a:1e": "TP-Link", "50:bd:5f": "TP-Link", "60:e3:27": "TP-Link",
	"00:1d:86": "Amazon", "44:65:0d": "Amazon", "68:37:e9": "Amazon",
	"f0:d2:f1": "Amazon",
	"00:24:8c": "Sony", "28:ed:e0": "Sony",
	"ec:b5:fa": "Philips Hue / Signify",
}
