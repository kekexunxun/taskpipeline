import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpProfile } from "@coding-agent/core";

type McpResponse = { id?: number; result?: any; error?: { message: string } };

export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve(value: McpResponse): void; timer: ReturnType<typeof setTimeout> }>();
  private initialized = false;
  private sessionId?: string;
  private sseEndpoint?: string;
  private sseAbort?: AbortController;

  constructor(private readonly profile: McpProfile, private readonly env: NodeJS.ProcessEnv = process.env, private readonly fetcher: typeof fetch = fetch) {}

  async connect(): Promise<void> {
    if (this.profile.transport === "stdio") {
      if (!this.profile.command) throw new Error("MCP stdio command is required");
      this.child = spawn(this.profile.command, this.profile.args ?? [], { stdio: "pipe", env: { ...this.env, ...(this.profile.env ?? {}) } });
      const lines = createInterface({ input: this.child.stdout });
      lines.on("line", (line) => { try { const response = JSON.parse(line) as McpResponse; if (response.id !== undefined) this.settle(response.id, response); } catch { /* Server logs are ignored; protocol lines remain parseable. */ } });
      this.child.stderr.on("data", () => undefined);
    } else if (!this.profile.url) {
      throw new Error("MCP HTTP URL is required");
    }
    if (this.profile.transport === "sse") await this.connectLegacySse();
    await this.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "internal-coding-agent", version: "0.1.0" } });
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  private notify(method: string, params: unknown): void {
    if (this.profile.transport === "stdio") this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    else if (this.profile.transport === "sse") void this.legacySseSend({ jsonrpc: "2.0", method, params });
    else void this.httpSend({ jsonrpc: "2.0", method, params });
  }
  private request(method: string, params: unknown): Promise<McpResponse> {
    const id = this.nextId++;
    if (this.profile.transport === "sse") {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`MCP request timeout: ${method}`)); }, 30_000);
        this.pending.set(id, { resolve, timer });
        void this.legacySseSend({ jsonrpc: "2.0", id, method, params }).catch((error) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          reject(error);
        });
      });
    }
    if (this.profile.transport !== "stdio") return this.httpSend({ jsonrpc: "2.0", id, method, params });
    if (!this.child) throw new Error("MCP client is not connected");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`MCP request timeout: ${method}`)); }, 30_000);
      this.pending.set(id, { resolve, timer });
      this.child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private settle(id: number, response: McpResponse): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(response);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    Object.assign(headers, this.profile.headers ?? {});
    const token = this.profile.tokenEnv ? this.env[this.profile.tokenEnv] : undefined;
    if (token) headers[this.profile.tokenHeader ?? "Authorization"] = (this.profile.tokenHeader ?? "Authorization").toLowerCase() === "authorization" ? `Bearer ${token}` : token;
    for (const [key, value] of Object.entries(this.profile.env ?? {})) {
      if (!key.toLowerCase().startsWith("header_")) continue;
      headers[key.slice(7)] = value.startsWith("env:") ? this.env[value.slice(4)] ?? "" : value;
    }
    return headers;
  }

  private async connectLegacySse(): Promise<void> {
    this.sseAbort = new AbortController();
    const response = await this.fetcher(this.profile.url!, { headers: { ...this.headers(), Accept: "text/event-stream" }, signal: this.sseAbort.signal });
    if (!response.ok || !response.body) throw new Error(`MCP SSE connection failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    void (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const event = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
          const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) continue;
          if (event === "endpoint") {
            this.sseEndpoint = new URL(data, this.profile.url).toString();
            readyResolve?.(); readyResolve = undefined;
            continue;
          }
          try {
            const message = JSON.parse(data) as McpResponse;
            if (message.id !== undefined) this.settle(message.id, message);
          } catch { /* Ignore non-protocol SSE diagnostics. */ }
        }
      }
    })().catch((error) => {
      if (!this.sseAbort?.signal.aborted) {
        const response = { error: { message: error instanceof Error ? error.message : String(error) } };
        for (const id of this.pending.keys()) this.settle(id, response);
      }
    });
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ready, new Promise<never>((_, reject) => { readyTimer = setTimeout(() => reject(new Error("MCP SSE endpoint timeout")), 30_000); })]);
    } finally {
      if (readyTimer) clearTimeout(readyTimer);
    }
  }

  private async legacySseSend(payload: Record<string, unknown>): Promise<void> {
    if (!this.sseEndpoint) throw new Error("MCP SSE endpoint is not ready");
    const response = await this.fetcher(this.sseEndpoint, { method: "POST", headers: this.headers(), body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`MCP SSE POST failed (${response.status}): ${await response.text()}`);
  }

  private async httpSend(payload: Record<string, unknown>): Promise<McpResponse> {
    const headers = this.headers();
    const response = await this.fetcher(this.profile.url!, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`MCP HTTP error ${response.status}: ${await response.text()}`);
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    const text = await response.text();
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")) .map((line) => line.slice(5).trim()).find(Boolean);
      return data ? JSON.parse(data) as McpResponse : {};
    }
    return text ? JSON.parse(text) as McpResponse : {};
  }

  async listTools(): Promise<unknown[]> { if (!this.initialized) await this.connect(); const response = await this.request("tools/list", {}); if (response.error) throw new Error(response.error.message); return response.result?.tools ?? []; }
  async callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> { if (!this.initialized) await this.connect(); const response = await this.request("tools/call", { name, arguments: arguments_ }); if (response.error) throw new Error(response.error.message); return response.result; }
  close(): void {
    this.child?.kill();
    this.child = undefined;
    this.sseAbort?.abort();
    this.sseAbort = undefined;
    this.sseEndpoint = undefined;
    for (const id of this.pending.keys()) this.settle(id, { error: { message: "MCP client closed" } });
    this.initialized = false;
  }
}
