import { describe, expect, it } from "vitest";
import { describeError } from "../lib/describe-error.js";

describe("describeError", () => {
  it("extracts message, name, stack and code from an Error", () => {
    const err = Object.assign(new Error("connection terminated unexpectedly"), { code: "57P01" });
    const described = describeError(err);
    expect(described.message).toBe("connection terminated unexpectedly");
    expect(described.name).toBe("Error");
    expect(described.code).toBe("57P01");
    expect(described.stack).toContain("connection terminated unexpectedly");
  });

  it("follows the cause chain", () => {
    const root = new Error("ECONNREFUSED");
    const wrapped = new Error("tickTimers failed", { cause: root });
    expect(describeError(wrapped).cause?.message).toBe("ECONNREFUSED");
  });

  it("still produces a message for non-Error throwables", () => {
    expect(describeError({ status: 409 }).message).toBe('{"status":409}');
    expect(describeError({ message: "budget hard-stop exceeded" }).message).toBe(
      "budget hard-stop exceeded",
    );
    expect(describeError("boom").message).toBe("boom");
    expect(describeError(undefined).message).toBe("undefined");
    expect(describeError(null).message).toBe("null");
  });

  it("never returns an empty payload", () => {
    for (const value of [new Error(""), {}, 0, false, [], Symbol("x")]) {
      const described = describeError(value);
      expect(typeof described.message).toBe("string");
      expect(Object.keys(described).length).toBeGreaterThan(0);
    }
  });
});
