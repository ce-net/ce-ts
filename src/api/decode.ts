/** Shared Raw→domain decoders for hex-payload-bearing types (mesh messages, signals). */

import { fromHex } from "../hex.js";
import { Amount } from "../amount.js";
import type {
  AppMessage,
  BlockEvent,
  RawAppMessage,
  RawBlockEvent,
  RawSignal,
  RawTxEvent,
  Signal,
  TxEvent,
  TxKind,
} from "../types.js";

export function decodeAppMessage(r: RawAppMessage): AppMessage {
  const payloadHex = r.payload_hex ?? "";
  return {
    from: r.from,
    topic: r.topic,
    payloadHex,
    receivedAt: r.received_at ?? null,
    replyToken: r.reply_token ?? null,
    payload(): Uint8Array {
      return fromHex(payloadHex);
    },
  };
}

export function decodeSignal(r: RawSignal): Signal {
  const payloadHex = r.payload_hex ?? "";
  return {
    from: r.from,
    to: r.to,
    capabilities: r.capabilities ?? [],
    payloadHex,
    burnProof: r.burn_proof ?? null,
    nonce: r.nonce,
    id: r.id,
    payload(): Uint8Array {
      return fromHex(payloadHex);
    },
  };
}

export function decodeBlockEvent(r: RawBlockEvent): BlockEvent {
  return {
    index: r.index,
    hash: r.hash,
    prevHash: r.prev_hash,
    timestamp: r.timestamp,
    miner: r.miner,
    txCount: r.tx_count,
    nonce: r.nonce,
  };
}

const TX_KINDS: ReadonlySet<string> = new Set<TxKind>([
  "Transfer",
  "UptimeReward",
  "JobBid",
  "JobSettle",
  "JobExpire",
  "Heartbeat",
  "ChannelOpen",
  "ChannelClose",
  "ChannelExpire",
  "NameClaim",
  "RevokeCapability",
  "HostBond",
  "HostUnbond",
  "SlashEquivocation",
]);

export function decodeTxEvent(r: RawTxEvent): TxEvent {
  // Pass the node's kind through verbatim; `TX_KINDS` documents the known set but
  // forward-compat means an unrecognized kind is still surfaced rather than dropped.
  void TX_KINDS;
  const kind = r.kind as TxKind;
  return {
    id: r.id,
    origin: r.origin,
    kind,
    amount: r.amount ? Amount.fromBaseUnits(r.amount) : Amount.ZERO,
  };
}
