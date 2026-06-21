/** Signals (CEP-1): list, send, stream. */

import { toHex } from "../hex.js";
import { sseEvents, type StreamOptions } from "../sse.js";
import { decodeSignal } from "./decode.js";
import type { Transport } from "../transport.js";
import type { RawSignal, SendSignal, Signal } from "../types.js";

export class SignalsApi {
  constructor(private readonly t: Transport) {}

  /** `GET /signals` → last 100 validated CEP-1 signals (newest at end). */
  async list(): Promise<Signal[]> {
    const r = await this.t.request<RawSignal[]>("GET", "/signals", "json", {
      auth: false,
    });
    return (r ?? []).map(decodeSignal);
  }

  /** `POST /signals/send` → `{ id, nonce }`. */
  async send(opts: SendSignal): Promise<{ id: string; nonce: number }> {
    const body: Record<string, unknown> = {
      to: opts.to,
      capabilities: opts.capabilities,
    };
    if (opts.payload !== undefined) body["payload_hex"] = toHex(opts.payload);
    if (opts.burnTxIdHex !== undefined) body["burn_tx_id_hex"] = opts.burnTxIdHex;
    return this.t.request<{ id: string; nonce: number }>(
      "POST",
      "/signals/send",
      "json",
      { body },
    );
  }

  /** `GET /signals/stream` → SSE of validated CEP-1 signals, as an AsyncIterable. */
  async *stream(opts?: StreamOptions): AsyncIterable<Signal> {
    const source = {
      url: this.t.url("/signals/stream"),
      fetch: this.t.fetch(),
      authToken: () => this.t.authToken(),
      headers: this.t.baseHeaders(),
    };
    for await (const ev of sseEvents(source, opts)) {
      if (ev.data === "") continue;
      yield decodeSignal(JSON.parse(ev.data) as RawSignal);
    }
  }
}
