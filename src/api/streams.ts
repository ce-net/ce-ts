/**
 * SSE streams: blocks / transactions / signals / mesh messages, each a typed
 * AsyncIterable with reconnect + Last-Event-ID. Signals + messages here alias the
 * `ce.signals.stream()` / `ce.mesh.streamMessages()` channels.
 */

import { sseEvents, type StreamOptions } from "../sse.js";
import {
  decodeAppMessage,
  decodeBlockEvent,
  decodeSignal,
  decodeTxEvent,
} from "./decode.js";
import type { Transport } from "../transport.js";
import type {
  AppMessage,
  BlockEvent,
  RawAppMessage,
  RawBlockEvent,
  RawSignal,
  RawTxEvent,
  Signal,
  TxEvent,
} from "../types.js";

export class StreamsApi {
  constructor(private readonly t: Transport) {}

  private source(path: string) {
    return {
      url: this.t.url(path),
      fetch: this.t.fetch(),
      authToken: () => this.t.authToken(),
      headers: this.t.baseHeaders(),
    };
  }

  /** `GET /blocks/stream` — every accepted block. */
  async *blocks(opts?: StreamOptions): AsyncIterable<BlockEvent> {
    for await (const ev of sseEvents(this.source("/blocks/stream"), opts)) {
      if (ev.data === "") continue;
      yield decodeBlockEvent(JSON.parse(ev.data) as RawBlockEvent);
    }
  }

  /** `GET /transactions/stream` — every verified transaction. */
  async *transactions(opts?: StreamOptions): AsyncIterable<TxEvent> {
    for await (const ev of sseEvents(this.source("/transactions/stream"), opts)) {
      if (ev.data === "") continue;
      yield decodeTxEvent(JSON.parse(ev.data) as RawTxEvent);
    }
  }

  /** `GET /signals/stream` — validated CEP-1 signals. */
  async *signals(opts?: StreamOptions): AsyncIterable<Signal> {
    for await (const ev of sseEvents(this.source("/signals/stream"), opts)) {
      if (ev.data === "") continue;
      yield decodeSignal(JSON.parse(ev.data) as RawSignal);
    }
  }

  /** `GET /mesh/messages/stream` — inbound app messages. */
  async *messages(opts?: StreamOptions): AsyncIterable<AppMessage> {
    for await (const ev of sseEvents(this.source("/mesh/messages/stream"), opts)) {
      if (ev.data === "") continue;
      yield decodeAppMessage(JSON.parse(ev.data) as RawAppMessage);
    }
  }
}
