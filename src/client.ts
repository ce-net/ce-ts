/**
 * `CeClient` — the facade. Composed of discoverable namespace objects (`ce.jobs`,
 * `ce.channels`, `ce.mesh`, `ce.data`, `ce.names`, `ce.discovery`, `ce.signals`,
 * `ce.capabilities`, `ce.streams`) plus flat aliases (`ce.getStatus()`, `ce.transfer()`,
 * `ce.bid()`, ...) that mirror ce-rs's flat shape for 1:1 familiarity.
 */

import { Amount } from "./amount.js";
import { discoverApiToken, type TokenSource } from "./auth.js";
import { Transport } from "./transport.js";
import { CapabilitiesApi } from "./api/caps.js";
import { DataApi } from "./api/data.js";
import { EconomyApi } from "./api/economy.js";
import { JobsApi } from "./api/jobs.js";
import { MeshApi } from "./api/mesh.js";
import { DiscoveryApi, NamesApi } from "./api/names.js";
import { SignalsApi } from "./api/signals.js";
import { StatusApi } from "./api/status.js";
import { StreamsApi } from "./api/streams.js";
import { TagsApi } from "./api/tags.js";
import { WalletApi } from "./api/wallet.js";
import type {
  AtlasEntry,
  Beacon,
  BidSpec,
  Bootstrap,
  Channel,
  Deployment,
  Job,
  NodeHistory,
  NodeStatus,
  RawTunnelResult,
  Receipt,
  SettleSpec,
  TunnelOpts,
  TunnelResult,
  TxQuery,
  TxRecord,
  WasmDeploy,
} from "./types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8844";

/** Construction options for {@link CeClient}. */
export interface CeClientOptions {
  /** Node API base URL. Default `http://127.0.0.1:8844`. */
  baseUrl?: string;
  /** API token, or a sync/async function resolving one per request. */
  token?: TokenSource;
  /** Injectable fetch (Workers / tests / proxy). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Max retries on retryable failures. Default 2 (money writes override to 0). */
  maxRetries?: number;
  /** Extra default headers on every request. */
  headers?: Record<string, string>;
}

/**
 * A typed, runtime-agnostic client for the CE node HTTP+SSE API.
 *
 * ```ts
 * const ce = CeClient.local();
 * const s = await ce.getStatus();
 * await ce.transfer(recipient, Amount.fromCredits("1.5"));
 * for await (const blk of ce.streams.blocks()) { ... }
 * ```
 */
export class CeClient {
  private readonly transport: Transport;

  readonly status: StatusApi;
  readonly jobs: JobsApi;
  readonly economy: EconomyApi;
  readonly channels: EconomyApi["channels"];
  readonly data: DataApi;
  readonly mesh: MeshApi;
  readonly signals: SignalsApi;
  readonly names: NamesApi;
  readonly discovery: DiscoveryApi;
  readonly capabilities: CapabilitiesApi;
  readonly streams: StreamsApi;
  /** Cohesive money view (balance breakdown, history, transfers, channels, tx stream). */
  readonly wallet: WalletApi;
  /** Atlas-style self-tagging over the discovery DHT (advertise/find peers by tag). */
  readonly tags: TagsApi;

  constructor(opts: CeClientOptions = {}) {
    let token = opts.token;
    // `local()` defers token discovery to the first authed call.
    this.transport = new Transport({
      baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
      ...(token !== undefined ? { token } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxRetries: opts.maxRetries ?? 2,
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
    });

    this.status = new StatusApi(this.transport);
    this.jobs = new JobsApi(this.transport);
    this.economy = new EconomyApi(this.transport);
    this.channels = this.economy.channels;
    this.data = new DataApi(this.transport);
    this.mesh = new MeshApi(this.transport);
    this.signals = new SignalsApi(this.transport);
    this.names = new NamesApi(this.transport);
    this.discovery = new DiscoveryApi(this.transport);
    this.capabilities = new CapabilitiesApi(this.transport);
    this.streams = new StreamsApi(this.transport);
    this.wallet = new WalletApi(this.transport, this.economy.channels);
    this.tags = new TagsApi(this.discovery);
  }

  /** Client for `http://127.0.0.1:8844`, lazily auto-discovering `api.token` (Node). */
  static local(): CeClient {
    // Lazy discovery: cache the discovery promise, run only on first authed request.
    let cached: Promise<string | undefined> | undefined;
    const lazyToken: TokenSource = () => {
      if (cached === undefined) cached = discoverApiToken();
      return cached;
    };
    return new CeClient({ baseUrl: DEFAULT_BASE_URL, token: lazyToken });
  }

  /** Client for an explicit base URL + token (or read-only when token omitted). */
  static withToken(baseUrl: string, token?: string): CeClient {
    return new CeClient(token !== undefined ? { baseUrl, token } : { baseUrl });
  }

  // ---- flat aliases (mirror ce-rs's flat surface) ----

  /** `GET /health`. */
  health(): Promise<boolean> {
    return this.status.health();
  }
  /** `GET /status`. */
  getStatus(): Promise<NodeStatus> {
    return this.status.status();
  }
  /** `GET /bootstrap`. */
  bootstrap(): Promise<Bootstrap> {
    return this.status.bootstrap();
  }
  /** `GET /beacon`. */
  beacon(): Promise<Beacon> {
    return this.status.beacon();
  }
  /** `GET /atlas`. */
  atlas(): Promise<AtlasEntry[]> {
    return this.status.atlas();
  }

  /** `GET /jobs`. */
  listJobs(): Promise<Job[]> {
    return this.jobs.list();
  }
  /** `GET /jobs/:id`. */
  job(id: string): Promise<Job> {
    return this.jobs.get(id);
  }
  /** `POST /jobs/bid`. */
  bid(spec: BidSpec): Promise<string> {
    return this.jobs.bid(spec);
  }
  /** `POST /jobs/:id/settle`. */
  settle(id: string, spec: SettleSpec): Promise<void> {
    return this.jobs.settle(id, spec);
  }
  /** `DELETE /jobs/:id`. */
  kill(id: string): Promise<void> {
    return this.jobs.kill(id);
  }

  /** `POST /transfer`. */
  transfer(to: string, amount: Amount): Promise<string> {
    return this.economy.transfer(to, amount);
  }
  /** `GET /history/:node_id`. */
  history(nodeId: string): Promise<NodeHistory> {
    return this.economy.history(nodeId);
  }
  /** `GET /transactions/:node_id` — confirmed txs touching a node, newest first. */
  transactions(nodeId: string, q?: TxQuery): Promise<TxRecord[]> {
    return this.economy.transactions(nodeId, q);
  }
  /** `POST /relay/pay`. */
  payRelay(relay: string, channelId: string, cumulative: Amount): Promise<void> {
    return this.economy.payRelay(relay, channelId, cumulative);
  }

  /** `GET /channels`. */
  listChannels(): Promise<Channel[]> {
    return this.channels.list();
  }
  /** `POST /channels/open`. */
  channelOpen(host: string, capacity: Amount, expiryHeight?: number): Promise<string> {
    return this.channels.open(host, capacity, expiryHeight);
  }
  /** `POST /channels/receipt`. */
  signReceipt(channelId: string, host: string, cumulative: Amount): Promise<Receipt> {
    return this.channels.signReceipt(channelId, host, cumulative);
  }

  /** Directed Docker deploy (`POST /mesh-deploy`). */
  meshDeploy(nodeId: string, spec: BidSpec, grant?: string): Promise<string> {
    return this.jobs.meshDeploy(nodeId, spec, grant);
  }
  /** Directed WASM deploy (`POST /mesh-deploy`). */
  meshDeployWasm(opts: WasmDeploy): Promise<Deployment> {
    return this.jobs.meshDeployWasm(opts);
  }
  /** `POST /mesh-kill`. */
  meshKill(nodeId: string, jobId: string, grant?: string): Promise<void> {
    return this.jobs.meshKill(nodeId, jobId, grant);
  }

  // ---- coordination / control ----

  /** `POST /chain/save` → `{ saved: <path> }`. */
  async chainSave(): Promise<{ saved: string }> {
    return this.transport.request<{ saved: string }>("POST", "/chain/save", "json", {});
  }

  /**
   * `POST /tunnel` — open a TCP tunnel to a remote port over the mesh. Node-host-side
   * (binds 127.0.0.1 on the node host); not meaningful from a browser.
   */
  async tunnel(opts: TunnelOpts): Promise<TunnelResult> {
    const body: Record<string, unknown> = {
      node_id: opts.nodeId,
      local_port: opts.localPort,
      remote_port: opts.remotePort,
    };
    if (opts.caps !== undefined) body["caps"] = opts.caps;
    if (opts.hint !== undefined) body["hint"] = opts.hint;
    const r = await this.transport.request<RawTunnelResult>("POST", "/tunnel", "json", {
      body,
    });
    return {
      localPort: r.local_port,
      remotePort: r.remote_port,
      nodeId: r.node_id,
    };
  }
}
