/**
 * API-token resolution + discovery.
 *
 * Resolution order (runtime-aware), mirroring ce-rs `discover_api_token`:
 *   1. Explicit `options.token` (handled by the transport, not here).
 *   2. `CE_API_TOKEN` env — Node / Bun / Deno.
 *   3. `<data_dir>/api.token` file — Node / Bun / Deno only, behind a guarded dynamic
 *      `import('node:fs')` so the browser / Workers bundle never statically references it.
 *   4. Browser: no disk/env discovery — supply a `token` callback (e.g. hub sidecar).
 */

/** A token source as accepted by `CeClientOptions.token`. */
export type TokenSource =
  | string
  | (() => string | undefined)
  | (() => Promise<string | undefined>);

/** Resolve a {@link TokenSource} to a concrete token (or `undefined`). */
export async function resolveToken(
  src: TokenSource | undefined,
): Promise<string | undefined> {
  if (src === undefined) return undefined;
  if (typeof src === "string") return src;
  const out = src();
  return out instanceof Promise ? await out : out;
}

/** Read `CE_API_TOKEN` from whichever runtime env mechanism exists. */
function envToken(): string | undefined {
  // Node / Bun.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  if (proc?.env?.CE_API_TOKEN) return proc.env.CE_API_TOKEN;
  // Deno.
  const deno = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } })
    .Deno;
  if (deno?.env) {
    try {
      const v = deno.env.get("CE_API_TOKEN");
      if (v) return v;
    } catch {
      // env permission denied in Deno — ignore.
    }
  }
  return undefined;
}

/** True when running under a Node-like runtime with `process.versions.node`. */
function isNodeLike(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return Boolean(proc?.versions?.node);
}

/** Default CE data dir, mirroring the node's `~/.local/share/ce` (XDG) layout. */
function defaultDataDir(): string | undefined {
  const proc = (
    globalThis as { process?: { env?: Record<string, string | undefined>; platform?: string } }
  ).process;
  const env = proc?.env;
  if (!env) return undefined;
  if (env.CE_DATA_DIR) return env.CE_DATA_DIR;
  if (env.XDG_DATA_HOME) return `${env.XDG_DATA_HOME}/ce`;
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) return undefined;
  if (proc?.platform === "win32" && env.APPDATA) return `${env.APPDATA}/ce`;
  if (proc?.platform === "darwin") return `${home}/Library/Application Support/ce`;
  return `${home}/.local/share/ce`;
}

/**
 * Discover the node API token. Browser-safe: the `node:fs` read is reached only via a
 * guarded dynamic import that edge bundlers tree-shake out. Returns `undefined` when no
 * token can be found (read-only access).
 */
export async function discoverApiToken(): Promise<string | undefined> {
  const fromEnv = envToken();
  if (fromEnv) return fromEnv;

  if (!isNodeLike()) return undefined;

  const dir = defaultDataDir();
  if (!dir) return undefined;

  try {
    // Dynamic, guarded — never statically linked into browser/Workers builds.
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(`${dir}/api.token`, "utf8");
    const tok = raw.trim();
    return tok.length > 0 ? tok : undefined;
  } catch {
    return undefined;
  }
}
