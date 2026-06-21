/** Capabilities: revoke, revoked. */

import type { Transport } from "../transport.js";
import type { RevokedEntry } from "../types.js";

/** Wire form: `[issuer_hex, nonce]` tuples or `{ issuer, nonce }` objects. */
type RawRevoked = [string, number] | { issuer: string; nonce: number };

export class CapabilitiesApi {
  constructor(private readonly t: Transport) {}

  /** `POST /capabilities/revoke` → tx id. Revokes a capability this node issued. */
  async revoke(nonce: number): Promise<string> {
    const r = await this.t.request<{ tx_id: string }>(
      "POST",
      "/capabilities/revoke",
      "json",
      { body: { nonce } },
    );
    return r.tx_id;
  }

  /** `GET /capabilities/revoked` → on-chain revoked `(issuer, nonce)` set. */
  async revoked(): Promise<RevokedEntry[]> {
    const r = await this.t.request<RawRevoked[]>(
      "GET",
      "/capabilities/revoked",
      "json",
      { auth: false },
    );
    return (r ?? []).map((e) =>
      Array.isArray(e) ? { issuer: e[0], nonce: e[1] } : { issuer: e.issuer, nonce: e.nonce },
    );
  }
}
