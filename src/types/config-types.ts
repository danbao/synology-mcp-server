/**
 * Configuration type definitions for synology-office-mcp.
 * All interfaces correspond to spec §11 environment variables.
 */

/** Synology NAS connection and auth settings */
export interface SynologyConfig {
  /** NAS hostname or IP address */
  host: string;
  /** NAS port (5000=HTTP, 5001=HTTPS) */
  port: number;
  /** Use HTTPS when true */
  https: boolean;
  /** Skip TLS certificate validation (for self-signed certs) */
  ignoreCert: boolean;
  /** DSM account username */
  username: string;
  /** DSM account password */
  password: string;
  /** Optional OTP code for 2FA accounts */
  otpCode?: string;
  /** Optional Base32 TOTP secret used to generate DSM 2FA codes */
  otpSecret?: string;
  /** Session token TTL in milliseconds (default 23h = 82800000) */
  tokenTtlMs: number;
  /** HTTP request timeout in milliseconds (default 30000) */
  requestTimeoutMs: number;
  /** Spreadsheet API host (defaults to `host` when not overridden) */
  spreadsheetHost: string;
  /** Spreadsheet API Docker container port (v3.7+ REST API, default 3000) */
  spreadsheetPort: number;
  /** Use HTTPS for Spreadsheet API (usually false for local Docker container) */
  spreadsheetHttps: boolean;
  /** Optional DSM account used only by the Spreadsheet API container authorize flow. */
  spreadsheetUsername?: string;
  /** Password for spreadsheetUsername. Required when spreadsheetUsername is set. */
  spreadsheetPassword?: string;
  /**
   * DSM host the Spreadsheet container should back-call to validate
   * credentials (sent as `host` field in `/spreadsheets/authorize` body).
   * Defaults to `host` (DSM) when not overridden — useful when the
   * container cannot verify DSM's TLS cert and you must point it at
   * DSM's HTTP port instead.
   */
  spreadsheetDsmHost: string;
  /** DSM port for the Spreadsheet container's back-call (defaults to `port`) */
  spreadsheetDsmPort: number;
  /**
   * Use HTTPS for the Spreadsheet container's DSM back-call
   * (defaults to `https`). Set false when the container rejects DSM's
   * self-signed cert and you cannot install the CA inside it.
   */
  spreadsheetDsmHttps: boolean;
}

/** MCP server transport configuration */
export interface McpConfig {
  /** Transport mode: stdio for CLI, streamable-http for network clients */
  transport: 'stdio' | 'streamable-http';
  /** HTTP server port, only used when transport=streamable-http */
  httpPort: number;
  /** HTTP bind host, defaults to 127.0.0.1 */
  httpHost: string;
  /** MCP endpoint path, defaults to /mcp */
  httpPath: string;
  /** Required shared secret for Streamable HTTP mode */
  authToken?: string;
}

/** Feature flags controlling which Synology modules are active */
export interface FeatureFlags {
  /** Enable Synology Drive tools */
  drive: boolean;
  /** Enable Synology Spreadsheet tools */
  spreadsheet: boolean;
  /** Enable Synology MailPlus tools */
  mailplus: boolean;
  /** Enable Synology Calendar tools */
  calendar: boolean;
}

/** Root application configuration assembled from environment */
export interface AppConfig {
  /** Synology NAS connection settings */
  synology: SynologyConfig;
  /** MCP transport settings */
  mcp: McpConfig;
  /** Feature toggles per module */
  features: FeatureFlags;
  /** Log verbosity level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Optional log file path; logs to stderr only if absent */
  logFile?: string;
}
