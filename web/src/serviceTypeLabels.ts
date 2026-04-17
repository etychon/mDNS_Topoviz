/**
 * Curated DNS-SD / Bonjour service type (_foo._tcp) → short English label for the UI.
 * Keys are normalized with {@link normalizeServiceTypeKey}; add variants without `.local`.
 */

export function normalizeServiceTypeKey(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/\.+$/g, "");
  if (s.endsWith(".local")) {
    s = s.slice(0, -".local".length).replace(/\.+$/g, "");
  }
  return s;
}

/** Lowercase keys: normalized service type strings (one entry per key). */
const DNS_SD_SERVICE_LABELS: Record<string, string> = {
  // Apple / consumer
  "_airplay._tcp": "AirPlay",
  "_raop._tcp": "AirTunes (RAOP)",
  "_companion-link._tcp": "Companion Link",
  "_rp-tunnel._tcp": "Remote Pairing Tunnel",
  "_sleep-proxy._udp": "Sleep Proxy",
  "_apple-mobdev2._tcp": "Apple Mobile Device",
  "_apple-pairable._tcp": "Apple Pairable",
  "_remotepairing-tunnel._tcp": "Remote Pairing",
  "_asquic._udp": "Apple QUIC",
  "_homekit._tcp": "HomeKit",
  "_hap._tcp": "HomeKit Accessory (HAP)",
  "_hap._udp": "HomeKit (UDP)",
  "_meshcop._udp": "Thread (MeshCoP / border router)",
  "_matter._tcp": "Matter",
  "_matterc._udp": "Matter (commissioning)",

  // Audio / media
  "_spotify-connect._tcp": "Spotify Connect",
  "_sonos._tcp": "Sonos",
  "_soundtouch._tcp": "Bose SoundTouch",
  "_googlecast._tcp": "Google Cast",
  "_roku._tcp": "Roku",
  "_deezer._tcp": "Deezer",
  "_tidalconnect._tcp": "TIDAL Connect",

  // Smart home / IoT
  "_hue._tcp": "Philips Hue",
  "_philipshue._tcp": "Philips Hue",
  "_mqtt._tcp": "MQTT",
  "_esphomelib._tcp": "ESPHome",
  "_homeassistant._tcp": "Home Assistant",
  "_tuya._tcp": "Tuya",
  "_smartthings._tcp": "SmartThings",
  "_wled._tcp": "WLED",

  // Printing / office (incl. common subtype PTR)
  "_ipp._tcp": "Internet Printing (IPP)",
  "_ipps._tcp": "IPP over TLS",
  "_printer._tcp": "Printer",
  "_printer._sub._ipp._tcp": "Printer (IPP)",
  "_pdl-datastream._tcp": "PDL printing",
  "_uscans._tcp": "Scanner (eSCL)",
  "_scanner._tcp": "Scanner",
  "_fax._tcp": "Fax",
  "_ippusb._tcp": "IPP USB",

  // Network / discovery helpers
  "_services._dns-sd._udp": "DNS-SD meta-query",
  "_lb._tcp": "Load balancing",
  "_device-info._tcp": "Device info",

  // Microsoft / Windows
  "_netbios-ns._udp": "NetBIOS name",
  "_netbios-dgm._udp": "NetBIOS datagram",
  "_netbios-ss._tcp": "NetBIOS session",
  "_microsoft-dc._tcp": "Active Directory DC",
  "_ldap._tcp": "LDAP",
  "_kerberos._tcp": "Kerberos",
  "_krb5._tcp": "Kerberos 5",
  "_gc._tcp": "AD global catalog",
  "_msrpc._tcp": "MS RPC",
  "_wsd._tcp": "Web Services for Devices",

  // Files / NAS
  "_afpovertcp._tcp": "AFP (Apple Filing)",
  "_smb._tcp": "SMB / Windows share",
  "_adisk._tcp": "Time Machine disk",
  "_nfs._tcp": "NFS",
  "_ftp._tcp": "FTP",
  "_sftp-ssh._tcp": "SFTP",

  // Dev / infra
  "_http._tcp": "HTTP",
  "_https._tcp": "HTTPS",
  "_ssh._tcp": "SSH",
  "_git._tcp": "Git",
  "_vscode._tcp": "VS Code",
  "_docker._tcp": "Docker",
  "_mongodb._tcp": "MongoDB",
  "_postgresql._tcp": "PostgreSQL",
  "_mysql._tcp": "MySQL",
  "_redis._tcp": "Redis",
  "_prometheus._tcp": "Prometheus",
  "_grafana._tcp": "Grafana",

  // Google / Android
  "_androidtvremote2._tcp": "Android TV Remote",
  "_googlezone._tcp": "Google Zone",

  // Games / social
  "_steam._udp": "Steam",
  "_discord._tcp": "Discord",

  // TV / video
  "_androidtvremote._tcp": "Android TV",
  "_viziocast._tcp": "Vizio Cast",
  "_roku-ecp._tcp": "Roku ECP",

  // Cameras / security
  "_onvif._tcp": "ONVIF",
  "_axis-video._tcp": "Axis camera",

  // VoIP / comms
  "_sip._udp": "SIP",
  "_sip._tcp": "SIP",
  "_presence._tcp": "XMPP presence",
  "_xmpp-client._tcp": "XMPP client",
  "_xmpp-server._tcp": "XMPP server",

  // Misc common LAN
  "_workstation._tcp": "Workstation",
  "_rdlink._tcp": "Remote Desktop",
  "_rfb._tcp": "VNC",
  "_telnet._tcp": "Telnet",
  "_daap._tcp": "DAAP (iTunes sharing)",
  "_dacp._tcp": "DACP (remote)",
  "_touch-able._tcp": "Remote pairing",
  "_touch-remote._tcp": "Remote",
  "_privet._tcp": "Google Privet",
  "_ptp._tcp": "Picture Transfer",
  "_esdk._tcp": "E SDK",
  "_esdp._tcp": "E SDP",
  "_esfile._tcp": "E File",
  "_smartview._tcp": "Samsung SmartView",
  "_nvstream._tcp": "NVIDIA GameStream",
  "_nvshim._tcp": "NVIDIA Shim",
  "_lg-smart-device._tcp": "LG Smart TV",
  "_samsung-tv-remote._tcp": "Samsung TV",
  "_amzn-wplay._tcp": "Amazon Wi-Fi Play",
  "_amzn-alexa._tcp": "Amazon Alexa",
  "_google-nest._tcp": "Google Nest",
  "_lutron._tcp": "Lutron",
  "_fbx-api._tcp": "Freebox API",
  "_fbx-disk._tcp": "Freebox disk",
  "_fbx-sys._tcp": "Freebox system",
  "_synology-disk._tcp": "Synology NAS",
  "_synology-dsm._tcp": "Synology DSM",
  "_qdiscover._tcp": "QNAP discovery",
  "_qmobile._tcp": "QNAP mobile",
  "_unifi._tcp": "UniFi",
  "_ubiquiti._tcp": "Ubiquiti",
};

function dedupeMap(m: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    out[normalizeServiceTypeKey(k)] = v;
  }
  return out;
}

const LABEL_LOOKUP = dedupeMap(DNS_SD_SERVICE_LABELS);

function titleCaseFromUnderscores(st: string): string {
  let s = normalizeServiceTypeKey(st);
  for (const suf of ["._tcp", "._udp", "._dccp", "._sctp"]) {
    if (s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  const core = s.replace(/^_+/, "");
  if (!core) return st.trim() || "Unknown service";
  return core
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Human-readable service name for sidebar copy. Uses curated map, then a light heuristic.
 */
export function friendlyServiceTypeName(serviceTypeRaw: string): string {
  const k = normalizeServiceTypeKey(serviceTypeRaw);
  if (!k) return "Unknown service";
  const hit = LABEL_LOOKUP[k];
  if (hit) return hit;
  const sub = "._sub.";
  const i = k.indexOf(sub);
  if (i >= 0) {
    const parent = k.slice(i + sub.length);
    const pHit = LABEL_LOOKUP[parent];
    if (pHit) return `${pHit} (subtype)`;
    return `${titleCaseFromUnderscores(parent)} (subtype)`;
  }
  return titleCaseFromUnderscores(k);
}
