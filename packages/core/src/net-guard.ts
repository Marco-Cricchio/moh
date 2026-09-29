/**
 * SEC-05: the private-network predicate, in a module of its own.
 *
 * Two callers share one classification — the fetch tool's SSRF guard and
 * the browser session's navigation guard. The second must not reach the
 * tools assembly to get it: the browser session module is loaded *by* that
 * assembly, so importing back into it is a runtime module cycle, and a
 * cycle of that shape had been worked around with a variable-held
 * `require` of a relative path — which single-file compilation cannot
 * resolve, so an enabled browser crashed every compiled binary (#1068).
 * A leaf both callers may import keeps one implementation of the rule and
 * no cycle in either direction.
 */

/**
 * Private/loopback/link-local hostnames and address literals — blocked
 * for fetch unless `MOH_FETCH_ALLOW_PRIVATE` is set (explicit opt-in for
 * local endpoints), and for browser navigation unless the host is listed
 * in `browser.allowedHosts` (loopback is the documented dev case).
 */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "0.0.0.0") return true;
  // IPv4 literal (incl. IPv4-mapped IPv6 tail).
  const v4 = h.includes(":") ? (h.match(/(?<=:)(\d+\.\d+\.\d+\.\d+)$/) ?? [])[1] : h;
  if (v4) {
    const parts = v4.split(".").map(Number);
    if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
      const [a, b] = parts as [number, number, number, number];
      return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 255;
    }
  }
  // IPv6 literal: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10).
  if (h.includes(":")) {
    const first = Number.parseInt(h.split(":")[0] || "0", 16);
    if (h === "::" || h === "::1") return true;
    if (!Number.isNaN(first)) return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}
