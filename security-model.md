# Security Model

## Threat Model

### Assumptions

- The server runs on a **trusted LAN** alongside the Synology NAS
- The MCP client (Claude Desktop, Claude Code, GoClaw) runs on the same machine or a trusted LAN host
- The NAS is **not exposed to the public internet** via this server
- The operator controls the NAS and its TLS certificate

### In-scope threats

| Threat | Mitigation |
|---|---|
| Credential theft from logs | Credentials and session IDs are redacted from all log output via `redactSensitive()` |
| Path traversal to escape Drive root | `pathGuard()` blocks `..` sequences and absolute escapes at tool boundary |
| Unauthenticated Streamable HTTP access from network | Bearer-token auth required for Streamable HTTP; server refuses to start without it |
| Cross-origin Streamable HTTP hijacking | `originGuard()` validates present `Origin` headers on `/mcp` requests |
| MITM between server and NAS | TLS verification enabled by default; `SYNO_IGNORE_CERT=true` is opt-in, logged at startup |
| Accidental destructive operations | All write/delete/send tools require explicit `"confirm": true` in tool input |
| Supply-chain compromise of published package | Tag-triggered release checks run before publishing to GitHub npm Packages and GHCR |

### Out-of-scope threats

- NAS compromise via DSM vulnerabilities (not this server's responsibility)
- Physical access to the NAS
- Compromise of the MCP client itself
- Public internet exposure (by design — not supported without explicit operator setup)

---

## Credential Handling

- Credentials (`SYNO_PASSWORD`, `SYNO_OTP_CODE`, `SYNO_OTP_SECRET`) are read from environment variables at startup and never written to disk by this server
- Login uses `POST` with an `application/x-www-form-urlencoded` body — credentials never appear in URLs or access logs
- The session ID (`sid`) is forwarded via `Cookie: id=<sid>` header, keeping it out of URL query strings and server access logs
- `redactSensitive()` strips `passwd`, `_sid`, `otp_code`, and bearer token values from any object before it is logged

---

## Transport Security

### stdio (default)

No network socket is opened. Communication is over stdin/stdout with the MCP client process. No auth required — the OS process model provides isolation.

### Streamable HTTP

- Endpoint defaults to `http://127.0.0.1:3100/mcp`
- Docker/LAN examples bind to `0.0.0.0:3100` and publish `/mcp`
- `MCP_AUTH_TOKEN` is **mandatory** whenever `MCP_TRANSPORT=streamable-http`
- `bearerAuth()` uses constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks
- `originGuard()` rejects requests with unexpected `Origin` headers to block cross-origin access
- Non-browser clients that omit `Origin` must still present a valid Bearer token

**Generating a strong token:**

```bash
openssl rand -hex 32
```

---

## Two-Factor Authentication

For unattended MCP use, create a dedicated low-privilege DSM service account.

If 2FA is enabled on the DSM account, DSM session login can use either a short-lived `SYNO_OTP_CODE` or `SYNO_OTP_SECRET` to generate TOTP codes automatically. `SYNO_OTP_SECRET` is equivalent to the authenticator seed, so store it as a secret and never commit it.

The Spreadsheet `/spreadsheets/authorize` endpoint does not accept OTP, so Spreadsheet automation should use a dedicated service account without 2FA enabled.

---

## TLS Certificate Verification

TLS verification is **on by default**. The `undici` HTTP agent enforces certificate validation for all NAS connections.

`SYNO_IGNORE_CERT=true` disables certificate verification. Use only:
- On a trusted home LAN
- With a self-signed certificate you generated and control
- When you understand the MITM risk

This setting is logged at `warn` level on every startup.

---

## Log Redaction Policy

The following values are automatically redacted (replaced with `[REDACTED]`) before any log output:

- `passwd` / `password` fields
- `_sid` / `sid` session identifiers
- `otp_code` / `otp_secret` values
- `Authorization` bearer token values
- `MCP_AUTH_TOKEN` value
- `SYNO_OTP_SECRET` value

Redaction is applied by `src/utils/redact.ts` and is called at every log site. If you find a log statement that leaks a sensitive value, please report it per the [vulnerability disclosure process](./SECURITY.md).

---

## Confirm-Required Operations

The following tools require `"confirm": true` in the input to prevent accidental destructive actions:

| Tool | Risk |
|---|---|
| `drive_delete_file` | Permanent deletion |
| `drive_move_file` | Overwrites destination if it exists |
| `spreadsheet_write_cells` | Overwrites cell content |
| `spreadsheet_append_rows` | Modifies spreadsheet data |
| `mailplus_send_message` | Sends an email |
| `mailplus_move_messages` | Moves messages (irreversible without moving back) |
| `calendar_create_event` | Creates calendar entry |
| `calendar_update_event` | Modifies calendar entry |
| `calendar_delete_event` | Deletes calendar entry |

When `confirm` is absent or `false`, the tool returns an error without performing the action.

---

## Vulnerability Disclosure

See [SECURITY.md](./SECURITY.md) for the private disclosure process. Do not open public GitHub issues for security vulnerabilities.
