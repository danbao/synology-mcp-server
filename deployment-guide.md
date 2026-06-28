# Deployment Guide

This guide covers four deployment topologies for **synology-office-mcp**. Pick the one that matches where you want the MCP server to run and whether you prefer Docker isolation.

| # | Where | Docker | Best for |
|---|---|---|---|
| [1](#1-local-machine--with-docker) | Local workstation | ✅ Yes | Quick try-out, isolated runtime, no Node install |
| [2](#2-local-machine--without-docker) | Local workstation | ❌ No | Active development, fastest iteration |
| [3](#3-on-nas--with-docker) | NAS (Container Manager) | ✅ Yes | Production self-hosting, no DSM Node install |
| [4](#4-on-nas--without-docker) | NAS (Task Scheduler / SSH) | ❌ No | Minimal footprint, direct loopback to DSM APIs |

> [!NOTE]
> Pre-1.0 status. All four modules (Drive, Spreadsheet, MailPlus, Calendar) and both transports (stdio + Streamable HTTP) are wired. Smoke validation against a real DSM NAS is recommended before production use.

---

## Prerequisites (all topologies)

- A Synology NAS reachable from where the MCP server will run, with:
  - DSM `7.2.2 nano3+`
  - Synology Drive `3.5.2+`, Office `3.6.0+`, MailPlus `3.3.1+`, Calendar `2.5.3+` (only the modules you enable)
  - A DSM user account with appropriate permissions on the modules you intend to expose
- A `.env` file based on [`.env.example`](./.env.example) — at minimum:

```bash
SYNO_HOST=192.168.1.100
SYNO_USERNAME=your_nas_user
SYNO_PASSWORD=your_nas_password
```

> [!IMPORTANT]
> If your NAS uses a self-signed TLS certificate, set `SYNO_IGNORE_CERT=true` only on trusted home networks. For unattended automation, prefer a dedicated low-privilege DSM service account without 2FA; DSM session login can use `SYNO_OTP_SECRET`, but Spreadsheet automation still cannot because the Spreadsheet API does not accept OTP.

### Choosing the transport

| Transport | When to use | Required env |
|---|---|---|
| `stdio` (default) | MCP client lives on the same host (Claude Desktop, Claude Code, GoClaw) | none |
| `streamable-http` | Remote MCP clients, Docker/LAN setups | `MCP_TRANSPORT=streamable-http`, `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `MCP_HTTP_PATH`, `MCP_AUTH_TOKEN` |

> The server **refuses to start** in Streamable HTTP mode without `MCP_AUTH_TOKEN`. Generate one with `openssl rand -hex 32`.

---

## 1. Local machine — with Docker

Run the MCP server in a container on your laptop / workstation. The container talks to the NAS over your LAN.

### 1.1 Requirements
- Docker `20.10+` (or Docker Desktop)
- LAN reachability to the NAS (`ping $SYNO_HOST` succeeds)

### 1.2 Build the image

The repo ships a multi-stage [`files/dockers/Dockerfile`](./files/dockers/Dockerfile). Build from repo root:

```bash
docker build -t synology-office-mcp:0.6.0 -f files/dockers/Dockerfile .
```

### 1.3 Run — stdio (for Claude Desktop / Claude Code)

stdio mode requires the client to spawn the process directly. Wire Docker as the launcher:

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "synology": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/absolute/path/to/.env",
        "ghcr.io/danbao/synology-office-mcp:0.6.0"
      ]
    }
  }
}
```

### 1.4 Run — Streamable HTTP (long-running daemon)

```bash
docker run -d \
  --name synology-mcp \
  --restart unless-stopped \
  --env-file ./.env \
  -e MCP_TRANSPORT=streamable-http \
  -e MCP_HTTP_HOST=0.0.0.0 \
  -e MCP_HTTP_PORT=3100 \
  -e MCP_HTTP_PATH=/mcp \
  -e MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  -p 127.0.0.1:3100:3100 \
  ghcr.io/danbao/synology-office-mcp:0.6.0
```

Verify:

```bash
docker logs -f synology-mcp
curl -i -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3100/mcp
```

### 1.5 docker-compose alternative

Use the bundled [`files/dockers/docker-compose.local.yml`](./files/dockers/docker-compose.local.yml):

```bash
docker compose -f files/dockers/docker-compose.local.yml up -d
docker compose -f files/dockers/docker-compose.local.yml logs -f
```

---

## 2. Local machine — without Docker

Run directly on your host with Node.js.

### 2.1 Requirements
- Node.js `>= 22.0.0` (use [nvm](https://github.com/nvm-sh/nvm): `nvm install 22 && nvm use 22`)
- pnpm `>= 9.0.0` (`corepack enable && corepack prepare pnpm@latest --activate`)
- LAN reachability to the NAS

### 2.2 Build

```bash
git clone https://github.com/danbao/synology-mcp-server.git
cd synology-office-mcp
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
# edit .env
```

### 2.3 Run — stdio

```bash
node dist/index.js
```

Wire into your client:

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "synology": {
      "command": "node",
      "args": ["/absolute/path/to/synology-office-mcp/dist/index.js"],
      "env": {
        "SYNO_HOST": "192.168.1.100",
        "SYNO_USERNAME": "your_user",
        "SYNO_PASSWORD": "your_pass"
      }
    }
  }
}
```

Or, for Claude Code:

```bash
claude mcp add synology -- node /absolute/path/to/synology-office-mcp/dist/index.js
```

### 2.4 Run — Streamable HTTP (background daemon)

```bash
MCP_TRANSPORT=streamable-http \
MCP_HTTP_HOST=127.0.0.1 \
MCP_HTTP_PORT=3100 \
MCP_HTTP_PATH=/mcp \
MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
node dist/index.js
```

Keep it alive across reboots with **launchd** (macOS) or **systemd** (Linux).

#### macOS — launchd

`~/Library/LaunchAgents/com.synology-office-mcp.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.synology-office-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/synology-office-mcp/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MCP_TRANSPORT</key><string>streamable-http</string>
    <key>MCP_HTTP_HOST</key><string>127.0.0.1</string>
    <key>MCP_HTTP_PORT</key><string>3100</string>
    <key>MCP_HTTP_PATH</key><string>/mcp</string>
    <key>MCP_AUTH_TOKEN</key><string>replace-with-openssl-rand-hex-32</string>
  </dict>
  <key>WorkingDirectory</key><string>/Users/you/synology-office-mcp</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/synology-mcp.err.log</string>
  <key>StandardOutPath</key><string>/tmp/synology-mcp.out.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.synology-office-mcp.plist
```

#### Linux — systemd (user unit)

`~/.config/systemd/user/synology-mcp.service`:

```ini
[Unit]
Description=Synology Office MCP server
After=network-online.target

[Service]
WorkingDirectory=%h/synology-office-mcp
EnvironmentFile=%h/synology-office-mcp/.env
Environment=MCP_TRANSPORT=streamable-http
Environment=MCP_HTTP_HOST=127.0.0.1
Environment=MCP_HTTP_PORT=3100
Environment=MCP_HTTP_PATH=/mcp
Environment=MCP_AUTH_TOKEN=replace-with-openssl-rand-hex-32
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now synology-mcp
journalctl --user -u synology-mcp -f
```

---

## 3. On NAS — with Docker

Run the MCP server inside **Container Manager** (formerly Docker) on the NAS itself. Loopback latency to DSM APIs is the lowest of any option.

### 3.1 Requirements
- DSM `7.2+` with **Container Manager** package installed
- A DSM user with permission to use Container Manager
- Shared folder for the project (e.g. `/volume1/docker/synology-office-mcp`)

### 3.2 Get the image onto the NAS

**Option A — build locally, save, transfer:**

```bash
docker build -t synology-office-mcp:0.6.0 .
docker save synology-office-mcp:0.6.0 | gzip > synology-office-mcp-0.6.0.tar.gz
scp synology-office-mcp-0.6.0.tar.gz admin@nas:/volume1/docker/
```

Then on the NAS (SSH or Container Manager → Image → Add → From file):

```bash
gunzip -c /volume1/docker/synology-office-mcp-0.6.0.tar.gz | sudo docker load
```

**Option B — build on NAS via SSH** (requires Node toolchain in the build stage; multi-stage `Dockerfile` above handles it):

```bash
ssh admin@nas
cd /volume1/docker/synology-office-mcp
sudo docker build -t synology-office-mcp:0.6.0 .
```

### 3.3 Create `.env` on the NAS

Place at `/volume1/docker/synology-office-mcp/.env`. Because the server runs **on** the NAS, point it at loopback:

```bash
SYNO_HOST=127.0.0.1
SYNO_PORT=5001
SYNO_HTTPS=true
SYNO_IGNORE_CERT=true   # DSM's loopback cert is self-signed
SYNO_USERNAME=mcp_service_user
SYNO_PASSWORD=...
MCP_TRANSPORT=streamable-http
MCP_HTTP_HOST=0.0.0.0
MCP_HTTP_PORT=3100
MCP_HTTP_PATH=/mcp
MCP_AUTH_TOKEN=...      # openssl rand -hex 32
```

> Use a **dedicated DSM user** with the minimum permissions required (read-only on shares the agent should not write to). Add it to the `administrators` group only if absolutely necessary.

### 3.4 Run via docker-compose (recommended)

Copy [`files/dockers/docker-compose.nas.yml`](./files/dockers/docker-compose.nas.yml) to `/volume1/docker/synology-office-mcp/docker-compose.yml` (host networking is preset so `127.0.0.1` inside the container maps to DSM loopback).

In **Container Manager → Project → Create**, point at this folder. Or via SSH:

```bash
sudo docker compose -f /volume1/docker/synology-office-mcp/docker-compose.yml up -d
sudo docker logs -f synology-office-mcp
```

### 3.5 Expose on the LAN safely

Recommended path: keep the container on `127.0.0.1` and front it with **DSM Reverse Proxy** (Control Panel → Login Portal → Advanced → Reverse Proxy):

| Field | Value |
|---|---|
| Source protocol | HTTPS |
| Source hostname | `mcp.your-nas.local` (or subpath of your DSM cert SAN) |
| Source port | `3443` |
| Destination protocol | HTTP |
| Destination hostname | `localhost` |
| Destination port | `3100` |

Add a custom header to forward `Authorization` if DSM strips it. Clients then connect to `https://mcp.your-nas.local:3443/mcp` with `Authorization: Bearer $MCP_AUTH_TOKEN`.

> [!IMPORTANT]
> `MCP_AUTH_TOKEN` is **mandatory** for Streamable HTTP even on trusted LAN deployments.

---

## 4. On NAS — without Docker

Run the Node binary directly on DSM. Smallest footprint, but you manage Node yourself.

### 4.1 Requirements
- DSM `7.2+`
- SSH enabled (Control Panel → Terminal & SNMP → Enable SSH service)
- **Node.js 22+** on the NAS — the easiest source is the [Synocommunity Node.js v22 SPK](https://synocommunity.com/) (or compile yourself; DSM's bundled Node is usually older). Verify with `node -v` over SSH.

> Some DSM models (ARMv7, older Atom) have no Node 22 build available. On those, prefer **option 3** (Docker) instead.

### 4.2 Install

```bash
ssh admin@nas
sudo mkdir -p /volume1/apps/synology-office-mcp
sudo chown $USER /volume1/apps/synology-office-mcp
cd /volume1/apps/synology-office-mcp

git clone https://github.com/danbao/synology-mcp-server.git .
# or upload a release tarball if git is unavailable

corepack enable
corepack prepare pnpm@latest --activate
pnpm install --frozen-lockfile --prod=false
pnpm build
cp .env.example .env
chmod 600 .env
vi .env   # see §3.3 above for NAS-loopback values
```

### 4.3 Run as a DSM service (Task Scheduler)

DSM's **Task Scheduler** can boot user services at startup without writing systemd units.

1. **Control Panel → Task Scheduler → Create → Triggered Task → User-defined script**
2. **General**
   - Task: `synology-office-mcp`
   - User: a non-`root` DSM user that owns the install dir
   - Event: `Boot-up`
   - Enabled: ✅
3. **Task Settings → Run command → User-defined script:**

```bash
cd /volume1/apps/synology-office-mcp
export PATH=/volume1/@appstore/Node.js_v24/usr/local/bin:$PATH
export $(grep -v '^#' .env | xargs)
exec node dist/index.js >> /volume1/apps/synology-office-mcp/server.log 2>&1
```

4. Save, then **Run** the task once to verify. Tail the log:

```bash
tail -f /volume1/apps/synology-office-mcp/server.log
```

### 4.4 Alternative: persistent SSH session via tmux

For ad-hoc / dev use without registering a scheduled task:

```bash
ssh admin@nas
tmux new -s mcp
cd /volume1/apps/synology-office-mcp
node dist/index.js
# Ctrl-b d to detach; tmux attach -t mcp to return
```

### 4.5 Reverse proxy

Same DSM Reverse Proxy setup as **§3.5** — point `localhost:3100` at `https://mcp.your-nas.local:3443/mcp`.

---

## Verifying the deployment

| Check | Command | Expected |
|---|---|---|
| Process is up | `ps aux \| grep synology-office-mcp` (or `docker ps`) | One running instance |
| Config validated | first stderr line | `synology-office-mcp starting...` followed by `Config loaded — transport: …` |
| NAS reachable | `curl -k https://$SYNO_HOST:$SYNO_PORT/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query` | JSON response |
| Streamable HTTP auth | `curl -i -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3100/mcp` | MCP JSON-RPC error or method-specific response, not `401` |
| Logs are clean of secrets | `grep -E "passwd|_sid|otp_code" *.log` | no matches |

If startup aborts with `Configuration validation failed:`, fix the listed env vars and restart. If you see `MCP_AUTH_TOKEN is required`, you enabled Streamable HTTP without setting a shared secret.

---

## Upgrading

```bash
# Docker
docker pull ghcr.io/danbao/synology-office-mcp:<new-version>   # or rebuild
docker compose up -d

# Bare metal
cd /path/to/synology-office-mcp
git pull
pnpm install --frozen-lockfile
pnpm build
# restart your service (launchctl / systemctl / Task Scheduler)
```

Always read [`CHANGELOG.md`](./CHANGELOG.md) before upgrading across a minor version — pre-1.0 minors may rename env vars.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Failed to reach Synology NAS` | Wrong `SYNO_HOST` / `SYNO_PORT` / firewall | `curl -k https://$SYNO_HOST:$SYNO_PORT` |
| `AUTH_FAILED` (synoCode `400`/`401`) | Wrong credentials, or 2FA/OTP mismatch | Check `SYNO_OTP_CODE` / `SYNO_OTP_SECRET`, or use a dedicated low-privilege DSM service account |
| `AUTH_FAILED` (synoCode `407`) | IP blocked by DSM auto-block | Control Panel → Security → Auto Block → unblock |
| TLS / cert errors | Self-signed NAS cert | `SYNO_IGNORE_CERT=true` (trusted networks only) |
| `MCP_AUTH_TOKEN is required` | Streamable HTTP enabled without token | Set `MCP_AUTH_TOKEN` |
| Container can't reach `127.0.0.1` on NAS | Bridge network instead of host | Use `network_mode: host` (see §3.4) |
| stdio client says "server exited" | Config validation failed at startup | Check stderr for `Configuration validation failed:` and fix the listed env var |

---

## Related documentation

- [README](./README.md) — feature overview, roadmap
- [`integration-guide.md`](./integration-guide.md) — wiring MCP clients (Claude, Cursor, Codex, LangChain, …)
- [`troubleshooting.md`](./troubleshooting.md) — Synology error codes + fixes
- [`security-model.md`](./security-model.md) — threat model
- [`SECURITY.md`](./SECURITY.md) — vulnerability disclosure
- [`CHANGELOG.md`](./CHANGELOG.md) — what shipped, what's next
