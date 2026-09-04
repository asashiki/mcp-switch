import { createHash } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type PriorDiscovery,
  type Transport
} from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

export interface UpstreamConnectionConfig {
  id: string;
  url: string;
  transport: "http" | "stdio";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  bearerToken?: string;
  bearerTokenEnv?: string;
  oauthClientId?: string;
  oauthClientInfo?: Record<string, unknown>;
  oauthTokens?: Record<string, unknown>;
}

type RuntimeEntry = {
  serverId: string;
  fingerprint: string;
  client?: Client;
  connecting?: Promise<Client>;
  active: number;
  retired: boolean;
  idleTimer?: NodeJS.Timeout;
  closing?: Promise<void>;
};

type PriorEntry = { value: PriorDiscovery; expiresAt: number };

export interface UpstreamRuntimeDiagnostics {
  serverId: string;
  connected: boolean;
  connecting: boolean;
  activeRequests: number;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortObject(item)])
  );
}

function looksLikeConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /connection|transport|socket|stream closed|econn|fetch failed|broken pipe|terminated|network/i.test(message);
}

/**
 * Owns long-lived upstream clients. Connections are single-flight per server,
 * scoped to a fingerprint of the transport + authorization context, and
 * retired after an idle period. Non-idempotent tool calls are never retried.
 */
export class UpstreamRuntimeManager {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly priors = new Map<string, PriorEntry>();
  private readonly idleTtlMs: number;
  private readonly priorTtlMs: number;
  private readonly catalogCacheTtlMs: number;
  private readonly connectTimeoutMs: number;

  constructor(private readonly options: {
    envSource: NodeJS.ProcessEnv;
    idleTtlMs?: number;
    priorTtlMs?: number;
    catalogCacheTtlMs?: number;
    connectTimeoutMs?: number;
    onCatalogChanged?: (serverId: string) => void;
    clientFactory?: (serverId: string) => Client;
    transportFactory?: (
      config: UpstreamConnectionConfig,
      authProvider?: OAuthClientProvider
    ) => Transport;
  }) {
    this.idleTtlMs = options.idleTtlMs ?? 5 * 60 * 1000;
    this.priorTtlMs = options.priorTtlMs ?? 30 * 60 * 1000;
    this.catalogCacheTtlMs = options.catalogCacheTtlMs ?? 2 * 60 * 1000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  }

  private requestHeaders(config: UpstreamConnectionConfig): Record<string, string> {
    const headers = { ...(config.headers ?? {}) };
    if (config.bearerToken) {
      headers.Authorization = `Bearer ${config.bearerToken}`;
    } else if (config.bearerTokenEnv) {
      const token = this.options.envSource[config.bearerTokenEnv];
      if (!token) throw new Error(`Missing bearer token env: ${config.bearerTokenEnv}`);
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private fingerprint(config: UpstreamConnectionConfig): string {
    const connectionIdentity = {
      url: config.url,
      transport: config.transport,
      command: config.command,
      args: config.args,
      env: config.env,
      headers: this.requestHeaders(config),
      oauthClientId: config.oauthClientId,
      oauthClientInfo: config.oauthClientInfo,
      oauthTokens: config.oauthTokens
    };
    return createHash("sha256")
      .update(JSON.stringify(sortObject(connectionIdentity)))
      .digest("hex");
  }

  private createClient(serverId: string): Client {
    if (this.options.clientFactory) return this.options.clientFactory(serverId);
    return new Client(
      { name: "mcp-switch-upstream-runtime", version: "0.2.0" },
      {
        versionNegotiation: { mode: "auto" },
        defaultCacheTtlMs: this.catalogCacheTtlMs,
        cachePartition: serverId,
        listChanged: {
          tools: { onChanged: () => this.options.onCatalogChanged?.(serverId) },
          resources: { onChanged: () => this.options.onCatalogChanged?.(serverId) }
        }
      }
    );
  }

  private createTransport(
    config: UpstreamConnectionConfig,
    authProvider?: OAuthClientProvider
  ): Transport {
    if (this.options.transportFactory) {
      return this.options.transportFactory(config, authProvider);
    }
    if (config.transport === "stdio") {
      if (!config.command) throw new Error(`stdio server "${config.id}" has no command.`);
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
        stderr: "ignore"
      });
    }
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: this.requestHeaders(config) },
      ...(authProvider ? { authProvider } : {})
    });
  }

  private async connectAttempt(
    config: UpstreamConnectionConfig,
    fingerprint: string,
    authProvider: OAuthClientProvider | undefined,
    prior: PriorDiscovery | undefined
  ): Promise<Client> {
    const client = this.createClient(config.id);
    try {
      await client.connect(this.createTransport(config, authProvider), {
        timeout: this.connectTimeoutMs,
        ...(prior ? { prior } : {})
      });
      const discover = client.getDiscoverResult();
      const value: PriorDiscovery = client.getProtocolEra() === "modern" && discover
        ? { kind: "modern", discover }
        : { kind: "legacy" };
      this.priors.set(fingerprint, { value, expiresAt: Date.now() + this.priorTtlMs });
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async connect(
    entry: RuntimeEntry,
    config: UpstreamConnectionConfig,
    authProvider?: OAuthClientProvider
  ): Promise<Client> {
    if (entry.client) return entry.client;
    if (entry.connecting) return entry.connecting;

    entry.connecting = (async () => {
      const cached = this.priors.get(entry.fingerprint);
      const prior = cached && cached.expiresAt > Date.now() ? cached.value : undefined;
      if (cached && !prior) this.priors.delete(entry.fingerprint);
      try {
        return await this.connectAttempt(config, entry.fingerprint, authProvider, prior);
      } catch (error) {
        // A stale era verdict must not strand the server forever. Probe once
        // without it; this is connect-time only and never repeats a tool call.
        if (!prior) throw error;
        this.priors.delete(entry.fingerprint);
        return this.connectAttempt(config, entry.fingerprint, authProvider, undefined);
      }
    })();

    try {
      const client = await entry.connecting;
      entry.client = client;
      return client;
    } finally {
      entry.connecting = undefined;
    }
  }

  private scheduleIdleClose(entry: RuntimeEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.retired || entry.active > 0) return;
    entry.idleTimer = setTimeout(() => {
      void this.retire(entry);
    }, this.idleTtlMs);
    entry.idleTimer.unref?.();
  }

  private async retire(entry: RuntimeEntry): Promise<void> {
    entry.retired = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (this.entries.get(entry.serverId) === entry) this.entries.delete(entry.serverId);
    if (entry.active > 0 || entry.closing) return entry.closing;
    entry.closing = (async () => {
      const client = entry.client ?? (await entry.connecting?.catch(() => undefined));
      if (client) await client.close().catch(() => undefined);
      entry.client = undefined;
    })();
    return entry.closing;
  }

  async withClient<T>(
    config: UpstreamConnectionConfig,
    authProvider: OAuthClientProvider | undefined,
    callback: (client: Client) => Promise<T>
  ): Promise<T> {
    const fingerprint = this.fingerprint(config);
    let entry = this.entries.get(config.id);
    if (entry && entry.fingerprint !== fingerprint) {
      await this.retire(entry);
      entry = undefined;
    }
    if (!entry) {
      entry = { serverId: config.id, fingerprint, active: 0, retired: false };
      this.entries.set(config.id, entry);
    }
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.active += 1;
    try {
      const client = await this.connect(entry, config, authProvider);
      return await callback(client);
    } catch (error) {
      if (looksLikeConnectionFailure(error)) entry.retired = true;
      throw error;
    } finally {
      entry.active -= 1;
      if (entry.retired) await this.retire(entry);
      else this.scheduleIdleClose(entry);
    }
  }

  async invalidate(serverId: string): Promise<void> {
    const entry = this.entries.get(serverId);
    if (entry) await this.retire(entry);
  }

  diagnostics(): UpstreamRuntimeDiagnostics[] {
    return [...this.entries.values()].map((entry) => ({
      serverId: entry.serverId,
      connected: Boolean(entry.client),
      connecting: Boolean(entry.connecting),
      activeRequests: entry.active
    }));
  }

  async close(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.retire(entry)));
  }
}
