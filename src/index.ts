/**
 * @ce-net/sdk — runtime-agnostic TypeScript client for the CE node HTTP+SSE API.
 *
 * Mirrors ce-rs 1:1, adds the SSE streams + signals ce-rs skips. Web-standard APIs only
 * (fetch, ReadableStream, AbortController, TextDecoder, crypto) — runs unchanged on
 * Node 20+, Deno, Bun, browsers, and Cloudflare/Vercel edge Workers.
 *
 * @packageDocumentation
 */

// Core
export { CeClient } from "./client.js";
export type { CeClientOptions } from "./client.js";
export { Amount, CREDIT } from "./amount.js";

// Browser-node bridge (in-browser WASM node + same-origin transports under one strict CSP).
export {
  connectNode,
  bridgeFetch,
  getBridge,
  bridgeAvailable,
  BRIDGE_BASE_URL,
  SAME_ORIGIN_NODE_PATH,
  CE_STRICT_CSP,
} from "./browser-node.js";
export type {
  CeNodeBridge,
  BridgeRequestInit,
  BridgeResponse,
  ConnectNodeOptions,
} from "./browser-node.js";

// Errors
export {
  CeError,
  CeApiError,
  CeBadRequestError,
  CeAuthError,
  CeInsufficientFundsError,
  CeNotFoundError,
  CeRateLimitError,
  CePeerError,
  CeUnavailableError,
  CeTimeoutError,
  CeServerError,
  CeConnectionError,
  CeStreamError,
} from "./errors.js";

// Auth
export { discoverApiToken } from "./auth.js";
export type { TokenSource } from "./auth.js";

// SSE
export type { StreamOptions, SseEvent } from "./sse.js";

// Mesh-app framework: be a service (serve) + find one (locate/call). Ports ce-rs serve/locate.
export { serve, serveWhere } from "./serve.js";
export type { Handler, ServeRequest, ServeOptions } from "./serve.js";
export {
  locate,
  call,
  register,
  spread,
  faultDomain,
  beaconJitter,
} from "./locate.js";
export type { Instance, LocateOpts, CallOpts } from "./locate.js";

// Hex / bytes helpers
export { toHex, fromHex, utf8ToBytes, bytesToUtf8 } from "./hex.js";

// Data-layer pure helpers
export { cid, chunkObject, reassemble, DEFAULT_CHUNK_SIZE } from "./api/data.js";

// Namespace API classes (for advanced typing / DI)
export { StatusApi } from "./api/status.js";
export { JobsApi } from "./api/jobs.js";
export { EconomyApi, ChannelsApi } from "./api/economy.js";
export { DataApi } from "./api/data.js";
export { MeshApi } from "./api/mesh.js";
export { SignalsApi } from "./api/signals.js";
export { NamesApi, DiscoveryApi } from "./api/names.js";
export { CapabilitiesApi } from "./api/caps.js";
export { StreamsApi } from "./api/streams.js";
export { WalletApi } from "./api/wallet.js";
export { TagsApi } from "./api/tags.js";

// Domain types (public surface)
export type {
  NodeStatus,
  Balance,
  Beacon,
  AtlasEntry,
  Bootstrap,
  Job,
  BidSpec,
  WasmDeploy,
  Deployment,
  SettleSpec,
  NodeHistory,
  TxRecord,
  TxQuery,
  TxDirection,
  Channel,
  Receipt,
  Manifest,
  AppMessage,
  Signal,
  SendSignal,
  BlockEvent,
  TxEvent,
  TxKind,
  TunnelOpts,
  TunnelResult,
  RevokedEntry,
} from "./types.js";

// Free helpers mirroring ce-rs's NodeHistory methods (also available as methods).
import type { NodeHistory } from "./types.js";

/** True when a node has no recorded interaction history. */
export function isNewcomer(h: NodeHistory): boolean {
  return h.firstHeight === 0;
}

/** Heuristic: hosted jobs + hosted heartbeats. */
export function deliveredWork(h: NodeHistory): number {
  return h.jobsHosted + h.heartbeatsHosted;
}
