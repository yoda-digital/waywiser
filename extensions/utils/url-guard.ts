/**
 * URL guard: blocks fetch requests to private, link-local, and localhost
 * addresses. Prevents SSRF when web_extract fetches user/model-supplied URLs.
 */
import { URL } from "node:url";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
]);

const BLOCKED_RANGES: RegExp[] = [
  /^127\./,                           // 127.0.0.0/8
  /^10\./,                            // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./,      // 172.16.0.0/12
  /^192\.168\./,                      // 192.168.0.0/16
  /^169\.254\./,                      // 169.254.0.0/16
  /^0\./,                             // 0.0.0.0/8
  /^fc[0-9a-f]{2}:/i,                // fc00::/7
  /^fe80:/i,                          // fe80::/10
];

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export interface UrlCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkUrl(urlStr: string): UrlCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { allowed: false, reason: "unparseable URL" };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { allowed: false, reason: `blocked scheme: ${parsed.protocol}` };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (BLOCKED_HOSTS.has(host)) {
    return { allowed: false, reason: `blocked host: ${host}` };
  }

  for (const pattern of BLOCKED_RANGES) {
    if (pattern.test(host)) {
      return { allowed: false, reason: `blocked range: ${host}` };
    }
  }

  // Block pure-numeric hosts (potential decimal IP tricks like 2130706433)
  const num = parseInt(host, 10);
  if (!isNaN(num) && String(num) === host) {
    return { allowed: false, reason: `blocked numeric host: ${host}` };
  }

  return { allowed: true };
}
