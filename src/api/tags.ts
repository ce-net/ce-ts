/**
 * Atlas-style self-tagging over the node's existing discovery DHT — **no node change required**.
 *
 * The node exposes generic discovery: `POST /discovery/advertise { service }` and
 * `GET /discovery/find/:service → { providers }`. Treating a tag as a service string
 * (`"infer"`, `"gpu"`, `"tier:hi"`, `"model:llama-3-8b"`) lets apps self-advertise capability/
 * capacity tags and find peers by tag today.
 *
 * ## Relationship to `/atlas`
 *
 * This **complements** `ce.atlas()`. The atlas carries **node-published** capability self-tags
 * (`linux`, `docker`, `gpu`, ...) derived and broadcast by the node via CEP-1 capacity signals —
 * authoritative, but a fixed vocabulary the node controls. Discovery tags here are
 * **app-published**: any app advertises an arbitrary tag and discovers peers by it without a node
 * release. Use the atlas for hardware truth; use discovery tags for app-level routing.
 *
 * ## Future node-side improvement
 *
 * A future node-side `set-tags` (push app tags into the node's own atlas entry so they appear in
 * `/atlas` and propagate via capacity signals) would make tags first-class and mesh-replicated
 * rather than DHT-provider-record-scoped. Until then, re-advertise periodically (records expire).
 */

import type { DiscoveryApi } from "./names.js";

/** Namespace prefix keeping app tags from colliding with bare service names in the DHT. */
const TAG_PREFIX = "tag:";

/** Map a bare tag to its discovery service string. */
function tagService(tag: string): string {
  return `${TAG_PREFIX}${tag}`;
}

export class TagsApi {
  constructor(private readonly discovery: DiscoveryApi) {}

  /**
   * Advertise that this node carries `tag` (`"infer"`, `"gpu"`, `"tier:hi"`,
   * `"model:llama-3-8b"`), discoverable by {@link find}. Provider records expire — re-advertise
   * periodically (see {@link refresh}). Complements `/atlas` (see module docs).
   */
  advertise(tag: string): Promise<void> {
    return this.discovery.advertise(tagService(tag));
  }

  /** Advertise several tags. Resolves once all succeed; rejects on the first failure. */
  async advertiseAll(tags: string[]): Promise<void> {
    for (const t of tags) await this.advertise(t);
  }

  /** Find the NodeId hexes of peers advertising `tag` (`GET /discovery/find/:service`). */
  find(tag: string): Promise<string[]> {
    return this.discovery.find(tagService(tag));
  }

  /**
   * Find peers advertising **all** of `tags` (set intersection of each tag's providers).
   * Empty `tags` yields `[]`.
   */
  async findAll(tags: string[]): Promise<string[]> {
    if (tags.length === 0) return [];
    let acc: string[] | undefined;
    for (const t of tags) {
      const providers = await this.find(t);
      acc = acc === undefined ? providers : acc.filter((p) => providers.includes(p));
    }
    return acc ?? [];
  }

  /** Find peers advertising **any** of `tags` (de-duplicated union). */
  async findAny(tags: string[]): Promise<string[]> {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of tags) {
      for (const p of await this.find(t)) {
        if (!seen.has(p)) {
          seen.add(p);
          out.push(p);
        }
      }
    }
    return out;
  }

  /** Re-advertise `tags` once. Call on an interval to keep DHT records from expiring. */
  async refresh(tags: string[]): Promise<void> {
    for (const t of tags) await this.advertise(t);
  }
}
