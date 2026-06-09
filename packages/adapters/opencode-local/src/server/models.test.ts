import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

// Fake `opencode models` that prints a fixed model list to stdout. Used to
// exercise the availability gate without depending on a real opencode install.
let fakeDir: string;
let fakeCommand: string;

beforeAll(() => {
  fakeDir = mkdtempSync(join(tmpdir(), "paperclip-fake-opencode-"));
  fakeCommand = join(fakeDir, "fake-opencode.sh");
  writeFileSync(
    fakeCommand,
    "#!/bin/sh\nprintf 'xai/grok-4\\n'\n",
    { mode: 0o755 },
  );
});

afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
});

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetOpenCodeModelsCacheForTests();
    vi.restoreAllMocks();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a provider/model id without running discovery", () => {
    expect(requireOpenCodeModelId("openai/gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
  });

  it("rejects malformed provider/model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("gpt-5.2-codex")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
    expect(() => requireOpenCodeModelId("openai/")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("accepts an unlisted but provider/model-shaped id with a warning", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = fakeCommand;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const models = await ensureOpenCodeModelConfiguredAndAvailable({
      model: "claude-bridge/some-new-model",
    });
    expect(models.some((entry) => entry.id === "xai/grok-4")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("claude-bridge/some-new-model");
  });
});
