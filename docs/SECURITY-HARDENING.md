# Security checklist

**Threat model:** The balancer forwards requests to server-side origins. Its configuration is privileged; never accept route or upstream URLs from untrusted request input.

- Set upstream URLs only from operator-controlled configuration. Avoid resolving private, link-local or metadata endpoints on behalf of tenants (SSRF); the built-in HTTP(S) scheme validation alone is not an SSRF boundary.
- Use TLS upstream URLs for untrusted networks and manage certificate verification/rotation at the platform level.
- Keep `trustProxy: false` unless the gateway accepts traffic only through a trusted ingress which strips client-supplied forwarding headers. Configure ingress network ACLs separately.
- Add authentication/authorization, request size limits, rate limits, and audit logging at the edge or Nest host; this module is **not** an API security gateway.
- Restrict the maximum request duration/size at ingress and configure upstream timeouts for SSE and uploads.
- Do not allow arbitrary POST/PUT/PATCH retries. This project enforces GET/HEAD without bodies for replay.
- Prefer readonly routes and separate trusted credentials per upstream.
- Protect application secrets, disable verbose headers, and audit CORS policy at the application level.
- Test header smuggling protections and upstream behavior with your actual ingress load balancer before internet-facing deployment.

## Reporting

Follow `SECURITY.md` for private vulnerability disclosures; avoid publishing working exploit details in public issues.
