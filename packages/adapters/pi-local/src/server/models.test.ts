import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
} from "./models.js";

// Fake `pi --list-models` that prints a fixed columnar model list to stderr
// (real pi emits the list on stderr). Used to exercise the availability gate
// without depending on a real pi install.
let fakePiDir: string;
let fakePiCommand: string;

beforeAll(() => {
  fakePiDir = mkdtempSync(join(tmpdir(), "paperclip-fake-pi-"));
  fakePiCommand = join(fakePiDir, "fake-pi.sh");
  writeFileSync(
    fakePiCommand,
    "#!/bin/sh\n>&2 printf 'provider   model\\nxai   grok-4\\n'\n",
    { mode: 0o755 },
  );
});

afterAll(() => {
  rmSync(fakePiDir, { recursive: true, force: true });
});

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    resetPiModelsCacheForTests();
    vi.restoreAllMocks();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });

  it("accepts an unlisted but provider/model-shaped id with a warning", async () => {
    process.env.PAPERCLIP_PI_COMMAND = fakePiCommand;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const models = await ensurePiModelConfiguredAndAvailable({
      model: "claude-bridge/some-new-model",
    });
    expect(models.some((entry) => entry.id === "xai/grok-4")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("claude-bridge/some-new-model");
  });

  it("still throws for a bare model name with no provider prefix", async () => {
    process.env.PAPERCLIP_PI_COMMAND = fakePiCommand;
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "grok-4" }),
    ).rejects.toThrow("Configured Pi model is unavailable");
  });

  it("still throws the empty-model error before discovery runs", async () => {
    process.env.PAPERCLIP_PI_COMMAND = fakePiCommand;
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "   " }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });
});
