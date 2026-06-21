/** Economy: transfer, history, payment channels, relay/pay. */

import { Amount } from "../amount.js";
import type { Transport } from "../transport.js";
import type {
  Channel,
  NodeHistory,
  RawChannel,
  RawNodeHistory,
  RawReceipt,
  RawTxRecord,
  Receipt,
  TxDirection,
  TxQuery,
  TxRecord,
} from "../types.js";

function amt(s: string): Amount {
  return Amount.fromBaseUnits(s);
}

export function toChannel(r: RawChannel): Channel {
  return {
    channelId: r.channel_id,
    payer: r.payer,
    host: r.host,
    capacity: amt(r.capacity),
    expiryHeight: r.expiry_height,
  };
}

export function toReceipt(r: RawReceipt): Receipt {
  return {
    channelId: r.channel_id,
    cumulative: amt(r.cumulative),
    payerSig: r.payer_sig,
  };
}

export function toNodeHistory(r: RawNodeHistory): NodeHistory {
  const h: NodeHistory = {
    nodeId: r.node_id,
    jobsHosted: r.jobs_hosted,
    jobsPaid: r.jobs_paid,
    heartbeatsHosted: r.heartbeats_hosted,
    heartbeatsPaid: r.heartbeats_paid,
    expiries: r.expiries,
    earned: amt(r.earned),
    spent: amt(r.spent),
    firstHeight: r.first_height,
    lastHeight: r.last_height,
    isNewcomer(): boolean {
      return h.firstHeight === 0;
    },
    deliveredWork(): number {
      return h.jobsHosted + h.heartbeatsHosted;
    },
  };
  return h;
}

export function toTxRecord(r: RawTxRecord): TxRecord {
  return {
    txId: r.tx_id,
    height: r.height,
    kind: r.kind,
    amount: amt(r.amount),
    counterparty: r.counterparty ?? null,
    direction: r.direction as TxDirection,
  };
}

/** Payment-channel sub-namespace. Also callable as `ce.channels()` (list). */
export class ChannelsApi {
  constructor(private readonly t: Transport) {}

  /** `GET /channels` → open channels. */
  async list(): Promise<Channel[]> {
    const r = await this.t.request<RawChannel[]>("GET", "/channels", "json", {
      auth: false,
    });
    return (r ?? []).map(toChannel);
  }

  /** `POST /channels/open` → channel id. Locks capacity; idempotency-keyed. */
  async open(host: string, capacity: Amount, expiryHeight = 0): Promise<string> {
    const r = await this.t.request<{ channel_id: string }>(
      "POST",
      "/channels/open",
      "json",
      {
        body: {
          host,
          capacity: capacity.toBaseUnits(),
          expiry_height: expiryHeight,
        },
        idempotent: true,
        maxRetries: 0,
      },
    );
    return r.channel_id;
  }

  /** `POST /channels/receipt` → the node signs an off-chain receipt (no tx). */
  async signReceipt(
    channelId: string,
    host: string,
    cumulative: Amount,
  ): Promise<Receipt> {
    const r = await this.t.request<RawReceipt>("POST", "/channels/receipt", "json", {
      body: {
        channel_id: channelId,
        host,
        cumulative: cumulative.toBaseUnits(),
      },
    });
    return toReceipt(r);
  }

  /** `POST /channels/:id/close` — host redeems the highest receipt. */
  async close(channelId: string, cumulative: Amount, payerSig: string): Promise<void> {
    await this.t.request<void>(
      "POST",
      `/channels/${encodeURIComponent(channelId)}/close`,
      "void",
      { body: { cumulative: cumulative.toBaseUnits(), payer_sig: payerSig } },
    );
  }

  /** `POST /channels/:id/expire` — payer reclaims after expiry. */
  async expire(channelId: string): Promise<void> {
    await this.t.request<void>(
      "POST",
      `/channels/${encodeURIComponent(channelId)}/expire`,
      "void",
      {},
    );
  }
}

export class EconomyApi {
  readonly channels: ChannelsApi;

  constructor(private readonly t: Transport) {
    this.channels = new ChannelsApi(t);
  }

  /** `POST /transfer` → tx id. Idempotency-keyed; retries off (double-spend safety). */
  async transfer(to: string, amount: Amount): Promise<string> {
    const r = await this.t.request<{ tx_id: string }>("POST", "/transfer", "json", {
      body: { to, amount: amount.toBaseUnits() },
      idempotent: true,
      maxRetries: 0,
    });
    return r.tx_id;
  }

  /** `GET /history/:node_id` → immutable interaction history. */
  async history(nodeId: string): Promise<NodeHistory> {
    const r = await this.t.request<RawNodeHistory>(
      "GET",
      `/history/${encodeURIComponent(nodeId)}`,
      "json",
      { auth: false },
    );
    return toNodeHistory(r);
  }

  /**
   * `GET /transactions/:node_id` → confirmed transactions touching a node,
   * newest first. Page older with `{ before: <oldest.height> }`.
   */
  async transactions(nodeId: string, q: TxQuery = {}): Promise<TxRecord[]> {
    const params = new URLSearchParams();
    if (q.limit != null) params.set("limit", String(q.limit));
    if (q.before != null) params.set("before", String(q.before));
    const qs = params.toString();
    const path = `/transactions/${encodeURIComponent(nodeId)}${qs ? `?${qs}` : ""}`;
    const r = await this.t.request<RawTxRecord[]>("GET", path, "json", {
      auth: false,
    });
    return (r ?? []).map(toTxRecord);
  }

  /** `POST /relay/pay` — pay a relay over a payment channel. */
  async payRelay(relay: string, channelId: string, cumulative: Amount): Promise<void> {
    await this.t.request<void>("POST", "/relay/pay", "void", {
      body: {
        relay,
        channel_id: channelId,
        cumulative: cumulative.toBaseUnits(),
      },
    });
  }
}
