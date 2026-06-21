/**
 * Wallet — a cohesive money view composed from existing endpoints.
 *
 * No new node surface: `balance()` reads the `/status` breakdown, `transactions()` pages
 * `GET /transactions/:node_id`, `transfer()`/channel ops hit the economy endpoints, and
 * `streamTransactions()` tails `/transactions/stream`, enriching each event with a direction
 * relative to the wallet's own node. Holds **no key material** — channel co-signatures are
 * passed through as opaque hex (matching CE's no-key rule).
 */

import { Amount } from "../amount.js";
import { Transport } from "../transport.js";
import { toNodeStatus } from "./status.js";
import { toTxRecord } from "./economy.js";
import { sseEvents, type StreamOptions } from "../sse.js";
import { decodeTxEvent } from "./decode.js";
import type {
  Balance,
  Channel,
  NodeStatus,
  RawNodeStatus,
  RawTxRecord,
  Receipt,
  TxQuery,
  TxRecord,
} from "../types.js";
import type { ChannelsApi } from "./economy.js";

/**
 * Wallet over a single node's HTTP+SSE API. Construct via `ce.wallet`. Cheap — wraps the
 * shared transport and the channels namespace.
 */
export class WalletApi {
  constructor(
    private readonly t: Transport,
    private readonly channelsApi: ChannelsApi,
  ) {}

  /** Open payment channels (delegates to `ce.channels`). */
  get channels(): ChannelsApi {
    return this.channelsApi;
  }

  /**
   * Balance breakdown from `GET /status`: total / free / locked-in-channels / locked-in-bond
   * / bond. On older nodes that only return `balance`, the locked buckets are zero and
   * `free === total`.
   */
  async balance(): Promise<Balance> {
    const r = await this.t.request<RawNodeStatus>("GET", "/status", "json", {
      auth: false,
    });
    const s: NodeStatus = toNodeStatus(r);
    // On older nodes that only return `balance`, derive `free` as total minus locks (clamped
    // at zero) — mirrors ce-rs's `Wallet::balance`. When the node sends `free`, use it verbatim.
    let free = s.free;
    if (r.free == null) {
      const derived = s.balance.sub(s.lockedChannels).sub(s.lockedBond);
      free = derived.isNegative() ? Amount.ZERO : derived;
    }
    return {
      total: s.balance,
      free,
      lockedChannels: s.lockedChannels,
      lockedBond: s.lockedBond,
      bond: s.bond,
    };
  }

  /**
   * Itemized transaction history for `nodeId`, newest first
   * (`GET /transactions/:node_id`). Page older with `{ before: <oldest.height> }`. On a light
   * node only post-checkpoint history is available.
   */
  async transactions(nodeId: string, q: TxQuery = {}): Promise<TxRecord[]> {
    const params = new URLSearchParams();
    if (q.limit != null) params.set("limit", String(q.limit));
    if (q.before != null) params.set("before", String(q.before));
    const qs = params.toString();
    const path = `/transactions/${encodeURIComponent(nodeId)}${qs ? `?${qs}` : ""}`;
    const r = await this.t.request<RawTxRecord[]>("GET", path, "json", { auth: false });
    return (r ?? []).map(toTxRecord);
  }

  /**
   * Live tail of confirmed transactions over `GET /transactions/stream`, each mapped to a
   * {@link TxRecord} relative to `selfNodeId` (so `direction`/`counterparty` are filled in
   * client-side — the stream frame only carries `{ id, origin, kind, amount }`). `height` is
   * unknown for the live tail (0).
   */
  async *streamTransactions(
    selfNodeId: string,
    opts?: StreamOptions,
  ): AsyncIterable<TxRecord> {
    const source = {
      url: this.t.url("/transactions/stream"),
      fetch: this.t.fetch(),
      authToken: () => this.t.authToken(),
      headers: this.t.baseHeaders(),
    };
    for await (const ev of sseEvents(source, opts)) {
      if (ev.data === "") continue;
      const tx = decodeTxEvent(JSON.parse(ev.data));
      const out: TxRecord = {
        txId: tx.id,
        height: 0,
        kind: tx.kind,
        amount: tx.amount,
        counterparty: tx.origin === selfNodeId ? null : tx.origin,
        direction: tx.origin === selfNodeId ? "out" : "in",
      };
      yield out;
    }
  }

  // ----- spend (pass-through to existing endpoints) -----

  /** `POST /transfer` → tx id. Idempotency-keyed; retries off. */
  async transfer(to: string, amount: Amount): Promise<string> {
    const r = await this.t.request<{ tx_id: string }>("POST", "/transfer", "json", {
      body: { to, amount: amount.toBaseUnits() },
      idempotent: true,
      maxRetries: 0,
    });
    return r.tx_id;
  }

  /** `POST /channels/open` → channel id. Locks capacity. */
  openChannel(host: string, capacity: Amount, expiryHeight = 0): Promise<string> {
    return this.channelsApi.open(host, capacity, expiryHeight);
  }

  /** `POST /channels/receipt` → node-signed off-chain receipt. */
  signReceipt(channelId: string, host: string, cumulative: Amount): Promise<Receipt> {
    return this.channelsApi.signReceipt(channelId, host, cumulative);
  }

  /**
   * `POST /channels/:id/close` — host redeems the highest receipt. `payerSig` is the payer's
   * co-signature, passed through as opaque hex (the wallet never produces key material).
   */
  closeChannel(channelId: string, cumulative: Amount, payerSig: string): Promise<void> {
    return this.channelsApi.close(channelId, cumulative, payerSig);
  }

  /** `POST /channels/:id/expire` — payer reclaims after expiry. */
  expireChannel(channelId: string): Promise<void> {
    return this.channelsApi.expire(channelId);
  }

  /** `GET /channels` → open channels. */
  listChannels(): Promise<Channel[]> {
    return this.channelsApi.list();
  }
}
