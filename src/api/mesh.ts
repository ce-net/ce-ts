/**
 * Mesh messaging: send / messages / subscribe / publish / request / reply, plus the
 * inbound-message SSE stream. This is the canonical channel for new device-to-device app
 * features (over AppRequest + stream), per CE's architecture rule. Payloads are
 * `Uint8Array`; `payload_hex` encoding is handled internally.
 */

import { fromHex, toHex } from "../hex.js";
import { sseEvents, type StreamOptions } from "../sse.js";
import { decodeAppMessage } from "./decode.js";
import type { Transport } from "../transport.js";
import type { AppMessage, RawAppMessage } from "../types.js";

export class MeshApi {
  constructor(private readonly t: Transport) {}

  /** `POST /mesh/send` — directed signed message to a node. */
  async send(to: string, topic: string, payload: Uint8Array): Promise<void> {
    await this.t.request<void>("POST", "/mesh/send", "void", {
      body: { to, topic, payload_hex: toHex(payload) },
    });
  }

  /** `GET /mesh/messages` — inbox snapshot. */
  async messages(): Promise<AppMessage[]> {
    const r = await this.t.request<RawAppMessage[]>("GET", "/mesh/messages", "json", {
      auth: false,
    });
    return (r ?? []).map(decodeAppMessage);
  }

  /** `POST /mesh/subscribe` — subscribe to an app pub/sub topic. Idempotent. */
  async subscribe(topic: string): Promise<void> {
    await this.t.request<void>("POST", "/mesh/subscribe", "void", {
      body: { topic },
    });
  }

  /** `POST /mesh/publish` — publish a signed message to a topic. Auto-subscribes. */
  async publish(topic: string, payload: Uint8Array): Promise<void> {
    await this.t.request<void>("POST", "/mesh/publish", "void", {
      body: { topic, payload_hex: toHex(payload) },
    });
  }

  /** `POST /mesh/request` — sync request/response; resolves with the reply payload. */
  async request(
    to: string,
    topic: string,
    payload: Uint8Array,
    timeoutMs?: number,
  ): Promise<Uint8Array> {
    const body: Record<string, unknown> = { to, topic, payload_hex: toHex(payload) };
    if (timeoutMs !== undefined) body["timeout_ms"] = timeoutMs;
    const r = await this.t.request<{ payload_hex: string }>(
      "POST",
      "/mesh/request",
      "json",
      {
        body,
        // Give the HTTP call slack beyond the app's mesh timeout (node default 30s).
        ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs + 5000 } : {}),
      },
    );
    return fromHex(r.payload_hex);
  }

  /** `POST /mesh/reply` — answer an inbound request by its `replyToken`. */
  async reply(token: number, payload: Uint8Array): Promise<void> {
    await this.t.request<void>("POST", "/mesh/reply", "void", {
      body: { token, payload_hex: toHex(payload) },
    });
  }

  /** `GET /mesh/messages/stream` — SSE of inbound app messages, as an AsyncIterable. */
  async *streamMessages(opts?: StreamOptions): AsyncIterable<AppMessage> {
    const source = {
      url: this.t.url("/mesh/messages/stream"),
      fetch: this.t.fetch(),
      authToken: () => this.t.authToken(),
      headers: this.t.baseHeaders(),
    };
    for await (const ev of sseEvents(source, opts)) {
      if (ev.data === "") continue;
      const raw = JSON.parse(ev.data) as RawAppMessage;
      yield decodeAppMessage(raw);
    }
  }
}
