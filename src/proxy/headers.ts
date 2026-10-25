import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
]);
export function sanitizeHeaders(
  input: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  const forbidden = new Set(HOP);
  for (const header of String(input.connection ?? "").split(",")) {
    if (header.trim()) forbidden.add(header.trim().toLowerCase());
  }
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(input)) {
    if (!forbidden.has(name.toLowerCase()) && value !== undefined)
      result[name] = value;
  }
  return result;
}
