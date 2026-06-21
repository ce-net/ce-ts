import { defineConfig } from "tsdown";

// Build → ESM + CJS + d.ts/d.cts. Target ES2022.
// The core is Web-API-only (fetch, ReadableStream, AbortController, TextDecoder,
// crypto.subtle), so the same bundle runs on Node 20+, Deno, Bun, browsers, and
// Cloudflare/Vercel edge Workers. node:fs is only ever reached via a guarded
// dynamic import in auth.ts, so it is never statically linked into the edge build.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  target: "es2022",
  platform: "neutral",
  outputOptions(options, format) {
    const ext = format === "cjs" ? "cjs" : "js";
    // rolldown-plugin-dts emits the single declaration file as a *chunk* named
    // "index.d", so the default chunkFileNames pattern stamps it with a content
    // hash (dist/index-XXXX.d.ts). That breaks the package.json `exports` map,
    // which points at the stable ./dist/index.d.ts and ./dist/index.d.cts. Pin
    // the declaration chunk name; everything else keeps tsdown's defaults. The
    // plugin rewrites the trailing .js/.cjs to .ts/.cts for declaration output,
    // so "[name].js" lands as dist/index.d.ts (ESM) / dist/index.d.cts (CJS).
    options.chunkFileNames = (chunk) =>
      chunk.name === "index.d" ? `[name].${ext}` : `[name]-[hash].${ext}`;

    // The dts plugin appends a `//# sourceMappingURL=index.d.ts.map` comment but
    // never emits the corresponding declaration map file, leaving a dangling
    // reference that crashes `attw` (and confuses editors). Strip it from the
    // declaration output. JS source maps are unaffected.
    options.plugins = [
      ...(Array.isArray(options.plugins) ? options.plugins : []),
      {
        name: "strip-dangling-dts-sourcemap",
        generateBundle(_outputOptions, bundle) {
          for (const file of Object.values(bundle)) {
            if (
              file.type === "chunk" &&
              (file.fileName.endsWith(".d.ts") || file.fileName.endsWith(".d.cts"))
            ) {
              file.code = file.code.replace(
                /\n?\/\/# sourceMappingURL=.*\.d\.c?ts\.map\s*$/,
                "\n",
              );
            }
          }
        },
      },
    ];

    return options;
  },
});
