/** Names & discovery: claim, resolve, advertise, find. */

import type { Transport } from "../transport.js";

export class NamesApi {
  constructor(private readonly t: Transport) {}

  /** `POST /names/claim` — claim a human-readable name (mined async). */
  async claim(name: string): Promise<void> {
    await this.t.request<void>("POST", "/names/claim", "void", { body: { name } });
  }

  /** `GET /names/:name` → owning NodeId hex, or `null` if unclaimed. */
  async resolve(name: string): Promise<string | null> {
    try {
      const r = await this.t.request<{ name: string; node_id: string }>(
        "GET",
        `/names/${encodeURIComponent(name)}`,
        "json",
        { auth: false },
      );
      return r.node_id ?? null;
    } catch (err) {
      // 404 => unclaimed.
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}

export class DiscoveryApi {
  constructor(private readonly t: Transport) {}

  /** `POST /discovery/advertise` — advertise a named service (re-call periodically). */
  async advertise(service: string): Promise<void> {
    await this.t.request<void>("POST", "/discovery/advertise", "void", {
      body: { service },
    });
  }

  /** `GET /discovery/find/:service` → NodeId hexes advertising the service. */
  async find(service: string): Promise<string[]> {
    const r = await this.t.request<{ service: string; providers: string[] }>(
      "GET",
      `/discovery/find/${encodeURIComponent(service)}`,
      "json",
      { auth: false },
    );
    return r.providers ?? [];
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: number }).status === 404
  );
}
