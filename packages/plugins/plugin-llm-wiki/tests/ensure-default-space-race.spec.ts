import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ensureDefaultSpace } from "../src/wiki/core.js";

function spaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "space-1",
    company_id: "company-1",
    wiki_id: "wiki",
    slug: "default",
    display_name: "default",
    space_type: "local_folder",
    folder_mode: "managed_subfolder",
    root_folder_key: "wiki",
    path_prefix: null,
    configured_root_path: null,
    access_scope: "shared",
    owner_user_id: null,
    owner_agent_id: null,
    team_key: null,
    settings: "{}",
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCtx(input: { executeError?: unknown }): PluginContext {
  return {
    db: {
      namespace: "plugin_llm_wiki",
      execute: async () => {
        if (input.executeError) throw input.executeError;
        return { rowCount: 1 };
      },
      query: async <T,>() => [spaceRow()] as T[],
    },
  } as unknown as PluginContext;
}

describe("ensureDefaultSpace insert race", () => {
  it("treats a direct 23505 unique violation as an existing row", async () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint "wiki_spaces_pkey"'), {
      code: "23505",
    });
    const space = await ensureDefaultSpace(makeCtx({ executeError: err }), { companyId: "company-1" });
    expect(space.id).toBe("space-1");
    expect(space.slug).toBe("default");
  });

  it("treats a wrapped (cause chain) 23505 unique violation as an existing row", async () => {
    const cause = Object.assign(new Error('duplicate key value violates unique constraint "wiki_spaces_pkey"'), {
      code: "23505",
    });
    const err = Object.assign(new Error("Failed query"), { cause });
    const space = await ensureDefaultSpace(makeCtx({ executeError: err }), { companyId: "company-1" });
    expect(space.id).toBe("space-1");
  });

  it("rethrows non-unique-violation insert errors", async () => {
    const err = Object.assign(new Error("connection reset"), { code: "57P01" });
    await expect(ensureDefaultSpace(makeCtx({ executeError: err }), { companyId: "company-1" })).rejects.toThrow(
      "connection reset",
    );
  });
});
