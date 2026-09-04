import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A fresh Node process is necessary: NODE_PATH is read when the process starts,
// and Vitest's own resolver would hide the production ESM resolution boundary.
describe("optional peers installed outside the application", () => {
  it("loads an operator NODE_PATH peer that a bare ESM import cannot resolve", () => {
    const root = mkdtempSync(join(tmpdir(), "paperclip peer #"));
    try {
      const peer = join(root, "@paperclip-test", "external-peer");
      mkdirSync(peer, { recursive: true });
      writeFileSync(join(peer, "package.json"), JSON.stringify({ main: "index.cjs" }));
      writeFileSync(join(peer, "index.cjs"), "exports.marker = 'EXTERNAL_PEER_OK';");
      const loader = new URL("../optional-peer-import.ts", import.meta.url).href;
      const script = `
        const { importOptionalPeer } = await import(${JSON.stringify(loader)});
        let bareCode;
        try { await import('@paperclip-test/external-peer'); }
        catch (error) { bareCode = error.code; }
        const peer = await importOptionalPeer('@paperclip-test/external-peer');
        let missingCode;
        try { await importOptionalPeer('@paperclip-test/nonexistent-peer'); }
        catch (error) { missingCode = error.code; }
        console.log(JSON.stringify({ bareCode, marker: peer.marker, missingCode }));
      `;
      const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: root, NODE_OPTIONS: "" },
        timeout: 10_000,
      });
      expect(JSON.parse(result)).toEqual({
        bareCode: "ERR_MODULE_NOT_FOUND",
        marker: "EXTERNAL_PEER_OK",
        missingCode: "MODULE_NOT_FOUND",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
