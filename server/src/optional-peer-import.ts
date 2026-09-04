import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Resolve optional peers like the version gate, including operator NODE_PATH installs. */
export async function importOptionalPeer(packageName: string) {
  const require = createRequire(import.meta.url);
  return import(pathToFileURL(require.resolve(packageName)).href);
}
