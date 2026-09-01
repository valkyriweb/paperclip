/**
 * esbuild configuration for building the paperclipai CLI for npm.
 *
 * Bundles all workspace packages (@paperclipai/*) into a single file.
 * External npm packages remain as regular dependencies.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledCliNpmDependencies } from "../scripts/cli-bundled-npm-dependencies.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Workspace packages whose code should be bundled into the CLI.
// Note: "server" is excluded — it's published separately and resolved at runtime.
const workspacePaths = [
  "cli",
  "packages/db",
  "packages/shared",
  "packages/adapter-utils",
  "packages/adapters/claude-local",
  "packages/adapters/codex-local",
  "packages/adapters/hermes-gateway",
  "packages/adapters/hermes",
  "packages/adapters/openclaw-gateway",
];

// Workspace packages that should NOT be bundled — they'll be published
// to npm and resolved at runtime (e.g. @paperclipai/server uses dynamic import).
const externalWorkspacePackages = new Set([
  "@paperclipai/server",
]);

// Collect all external (non-workspace) npm package names
const externals = new Set();
for (const p of workspacePaths) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, p, "package.json"), "utf8"));
  for (const name of Object.keys(pkg.dependencies || {})) {
    if (externalWorkspacePackages.has(name)) {
      externals.add(name);
    } else if (!name.startsWith("@paperclipai/") && !bundledCliNpmDependencies.has(name)) {
      externals.add(name);
    }
  }
  for (const name of Object.keys(pkg.optionalDependencies || {})) {
    externals.add(name);
  }
}
// Also add all published workspace packages as external
for (const name of externalWorkspacePackages) {
  externals.add(name);
}

if (bundledCliNpmDependencies.has("embedded-postgres")) {
  const requireFromDb = createRequire(resolve(repoRoot, "packages/db/package.json"));
  const embeddedPostgresRoot = dirname(requireFromDb.resolve("embedded-postgres"));
  const embeddedPostgresPackage = JSON.parse(
    readFileSync(resolve(embeddedPostgresRoot, "..", "package.json"), "utf8"),
  );
  for (const name of Object.keys(embeddedPostgresPackage.optionalDependencies ?? {})) {
    externals.add(name);
  }
}

// Only these can't be inlined: prebuilt platform binaries, and @paperclipai/server
// (dynamically imported, and pulling it in drags the whole OTel server graph).
// Everything else is bundled so the output runs straight from the repo checkout —
// pnpm's strict node_modules layout does not expose transitive deps (zod, ws,
// postgres, commander) to cli/, so leaving them external produced a dist that
// crashed with ERR_MODULE_NOT_FOUND.
const runtimeExternal = [...externals]
  .filter((name) => name.startsWith("@embedded-postgres/") || externalWorkspacePackages.has(name))
  .sort();

// Bundling CJS deps into an ESM output needs the CommonJS globals shimmed.
const banner = [
  "#!/usr/bin/env node",
  'import { createRequire as __pcCreateRequire } from "node:module";',
  'import { fileURLToPath as __pcFileURLToPath } from "node:url";',
  'import { dirname as __pcDirname } from "node:path";',
  "const require = __pcCreateRequire(import.meta.url);",
  "const __filename = __pcFileURLToPath(import.meta.url);",
  "const __dirname = __pcDirname(__filename);",
].join("\n");

/** @type {import('esbuild').BuildOptions} */
export default {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  banner: { js: banner },
  external: runtimeExternal,
  treeShaking: true,
  sourcemap: true,
};
