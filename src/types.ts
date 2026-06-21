/**
 * Hand-written wire + domain types.
 *
 * Two layers:
 *  - `Raw*` wire types — exactly the JSON the node emits/accepts: amount fields as
 *    `string`, hex as `string`, snake_case keys. Used only inside `api/*` decoders.
 *  - Domain types — camelCase, `Amount` for money, `Uint8Array` for payloads (decoded
 *    from hex), `number | null` for optionals. This is the public surface.
 */

import type { Amount } from "./amount.js";

// ============================================================================
// Status / discovery
// ============================================================================

export interface RawNodeStatus {
  node_id: string;
  height: number;
  difficulty: number;
  balance: string;
  // Richer /status shape (superset of ce-rs NodeStatus). Optional for forward-compat.
  circulating_supply?: string;
  burned_total?: string;
  bond?: string;
  weight?: number;
  // Balance breakdown (Wave-0): spendable + locked buckets, base-unit strings.
  free?: string;
  locked_channels?: string;
  locked_bond?: string;
}

/** Full `/status` body. Mirrors the http-api map's richer shape. */
export interface NodeStatus {
  nodeId: string;
  height: number;
  difficulty: number;
  /** Total balance (can be negative on a fresh node before sync). */
  balance: Amount;
  circulatingSupply: Amount;
  burnedTotal: Amount;
  /** This node's active host bond. */
  bond: Amount;
  /** Consensus weight = min(bond, earned-work-score), base units. */
  weight: number;
  /** Spendable balance: `balance` minus all locks, clamped at 0. */
  free: Amount;
  /** Credits locked in this node's open payment channels. */
  lockedChannels: Amount;
  /** Credits locked in this node's active bond (equals `bond`). */
  lockedBond: Amount;
}

/**
 * Balance breakdown derived from `/status`. Invariant on a synced node:
 * `free + lockedChannels + lockedBond === total`.
 */
export interface Balance {
  /** Total balance (may be negative on a fresh node before sync). */
  total: Amount;
  /** Spendable balance: `total` minus all locks, node-clamped at zero. */
  free: Amount;
  /** Credits locked in this node's open payment channels. */
  lockedChannels: Amount;
  /** Credits locked in this node's active host bond. */
  lockedBond: Amount;
  /** This node's active host bond (equals `lockedBond`). */
  bond: Amount;
}

export interface RawBeacon {
  height: number;
  hash: string;
}
export interface Beacon {
  height: number;
  hash: string;
}

export interface RawAtlasEntry {
  node_id: string;
  cpu_cores: number;
  mem_mb: number;
  running_jobs: number;
  last_seen_secs: number;
  tags: string[];
}
export interface AtlasEntry {
  nodeId: string;
  cpuCores: number;
  memMb: number;
  runningJobs: number;
  lastSeenSecs: number;
  tags: string[];
}

export interface RawBootstrap {
  peers: string[];
}
export interface Bootstrap {
  peers: string[];
}

// ============================================================================
// Jobs
// ============================================================================

export interface RawJob {
  job_id: string;
  status: string;
  payer?: string | null;
  container_id?: string | null;
  cost?: string | null;
  bid?: string | null;
}

/** A job tracked by this node (as payer or host). */
export interface Job {
  jobId: string;
  /** `"pending" | "running" | "awaiting_settlement" | "settled" | "failed: <reason>"`. */
  status: string;
  payer: string | null;
  containerId: string | null;
  cost: Amount | null;
  bid: Amount | null;
}

/** A bid spec for `POST /jobs/bid` and Docker `mesh-deploy`. `bid` is an Amount. */
export interface BidSpec {
  image: string;
  cmd?: string[];
  /** `[[key, value], ...]` env pairs, matching the node's `env[][]`. */
  env?: [string, string][];
  cpuCores: number;
  memMb: number;
  durationSecs: number;
  bid: Amount;
}

/** WASM deploy variant of `mesh-deploy`. */
export interface WasmDeploy {
  nodeId: string;
  /** 64-hex module hash. */
  wasmModule: string;
  wasmEntry: string;
  cpuCores: number;
  memMb: number;
  durationSecs: number;
  bid: Amount;
  /** CID-addressed input dependencies. */
  inputs?: string[];
  grant?: string;
  hintMultiaddr?: string;
}

export interface RawDeployment {
  job_id: string;
  output?: string | null;
}
export interface Deployment {
  jobId: string;
  output: string | null;
}

/** Settlement co-sign payload for `POST /jobs/:id/settle`. */
export interface SettleSpec {
  cost: Amount;
  /** 128-hex Ed25519 payer signature, built by the caller (the SDK never signs). */
  payerSig: string;
}

// ============================================================================
// Economy
// ============================================================================

export interface RawNodeHistory {
  node_id: string;
  jobs_hosted: number;
  jobs_paid: number;
  heartbeats_hosted: number;
  heartbeats_paid: number;
  expiries: number;
  earned: string;
  spent: string;
  first_height: number;
  last_height: number;
}

export interface NodeHistory {
  nodeId: string;
  jobsHosted: number;
  jobsPaid: number;
  heartbeatsHosted: number;
  heartbeatsPaid: number;
  expiries: number;
  earned: Amount;
  spent: Amount;
  firstHeight: number;
  lastHeight: number;
  /** True when `firstHeight === 0` (no recorded history). */
  isNewcomer(): boolean;
  /** Heuristic: `jobsHosted + heartbeatsHosted`. */
  deliveredWork(): number;
}

/** Value direction of a tx relative to the queried node. */
export type TxDirection = "in" | "out" | "self";

export interface RawTxRecord {
  tx_id: string;
  height: number;
  kind: string;
  amount: string;
  counterparty?: string | null;
  direction: string;
}

/** One confirmed transaction touching a node, from `GET /transactions/:node_id`. */
export interface TxRecord {
  /** Content-addressed transaction id (64 hex). */
  txId: string;
  /** Block height the tx was confirmed at. */
  height: number;
  /** Tx kind label, e.g. `"Transfer" | "JobSettle" | "UptimeReward" | "ChannelOpen" | ...`. */
  kind: string;
  /** Amount moved relative to this tx; `Amount.ZERO` for amount-less kinds. */
  amount: Amount;
  /** The other party (64 hex) when there is one, else null. */
  counterparty: string | null;
  /** Value direction relative to the queried node. */
  direction: TxDirection;
}

/** Pagination args for `GET /transactions/:node_id`. */
export interface TxQuery {
  /** Max items to return (default 100, node caps at 500). */
  limit?: number;
  /** Exclude txs at block height `>= before` — cursor for the next (older) page. */
  before?: number;
}

export interface RawChannel {
  channel_id: string;
  payer: string;
  host: string;
  capacity: string;
  expiry_height: number;
}
export interface Channel {
  channelId: string;
  payer: string;
  host: string;
  capacity: Amount;
  expiryHeight: number;
}

export interface RawReceipt {
  channel_id: string;
  cumulative: string;
  payer_sig: string;
}
export interface Receipt {
  channelId: string;
  cumulative: Amount;
  /** 128-hex Ed25519 payer signature returned by the node. */
  payerSig: string;
}

// ============================================================================
// Data layer
// ============================================================================

/** Object manifest (`ce-object-v1`). camelCase domain form. */
export interface Manifest {
  kind: "ce-object-v1";
  chunkSize: number;
  totalSize: number;
  chunks: string[];
}

/** Wire form of the manifest, stored as a JSON blob; its hash is the object CID. */
export interface RawManifest {
  kind: string;
  chunk_size: number;
  total_size: number;
  chunks: string[];
}

// ============================================================================
// Mesh messaging
// ============================================================================

export interface RawAppMessage {
  from: string;
  topic: string;
  payload_hex: string;
  received_at?: number;
  reply_token?: number | null;
}

/** An inbound app message. `payload()` decodes `payloadHex` to bytes. */
export interface AppMessage {
  from: string;
  topic: string;
  /** Raw hex payload as delivered by the node. */
  payloadHex: string;
  receivedAt: number | null;
  /** Token to pass to `ce.mesh.reply()` if this is a request. */
  replyToken: number | null;
  /** Decode the hex payload to bytes. */
  payload(): Uint8Array;
}

// ============================================================================
// Signals (CEP-1)
// ============================================================================

export interface RawSignal {
  from: string;
  to: string;
  capabilities: string[];
  payload_hex: string;
  burn_proof?: unknown;
  nonce: number;
  id: string;
}

/** A validated CEP-1 signal. `payload()` decodes `payloadHex`. */
export interface Signal {
  from: string;
  to: string;
  capabilities: string[];
  payloadHex: string;
  burnProof: unknown;
  nonce: number;
  id: string;
  payload(): Uint8Array;
}

/** Args for `POST /signals/send`. */
export interface SendSignal {
  to: string | "broadcast";
  capabilities: string[];
  payload?: Uint8Array;
  /** Required by the node when `payload` is non-empty. */
  burnTxIdHex?: string;
}

// ============================================================================
// SSE stream events
// ============================================================================

export interface RawBlockEvent {
  index: number;
  hash: string;
  prev_hash: string;
  timestamp: number;
  miner: string;
  tx_count: number;
  nonce: number;
}
export interface BlockEvent {
  index: number;
  hash: string;
  prevHash: string;
  timestamp: number;
  miner: string;
  txCount: number;
  nonce: number;
}

/**
 * Transaction kinds emitted on `/transactions/stream` (the node's `TxKind` set).
 * This is the full ledger vocabulary, kept in sync with `ce-chain::TxKind`.
 */
export type TxKind =
  | "Transfer"
  | "UptimeReward"
  | "JobBid"
  | "JobSettle"
  | "JobExpire"
  | "Heartbeat"
  | "ChannelOpen"
  | "ChannelClose"
  | "ChannelExpire"
  | "NameClaim"
  | "RevokeCapability"
  | "HostBond"
  | "HostUnbond"
  | "SlashEquivocation";

export interface RawTxEvent {
  id: string;
  origin: string;
  kind: string;
  amount: string;
}
export interface TxEvent {
  id: string;
  origin: string;
  kind: TxKind;
  /** Base-unit amount; `Amount.ZERO` for kinds without an amount. */
  amount: Amount;
}

// ============================================================================
// Coordination / control
// ============================================================================

export interface TunnelOpts {
  nodeId: string;
  localPort: number;
  remotePort: number;
  /** Optional capability/grant chain (base64). */
  caps?: string;
  hint?: string;
}
export interface RawTunnelResult {
  local_port: number;
  remote_port: number;
  node_id: string;
}
export interface TunnelResult {
  localPort: number;
  remotePort: number;
  nodeId: string;
}

/** A revoked `(issuer, nonce)` capability pair. */
export interface RevokedEntry {
  issuer: string;
  nonce: number;
}
