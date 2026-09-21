import { describe, expect, test } from "bun:test";
import { runScript } from "./sync.js";

describe("runScript", () => {
  test("resolves a failed run instead of rejecting when the Python runtime cannot be resolved", async () => {
    const previous = process.env.SYNTHESIS_PYTHON_BIN;
    // A bogus override guarantees synthesisPythonBin() throws on every
    // machine: either the resolve step fails (unprepared runtime) or the
    // configured interpreter differs from the verified one.
    process.env.SYNTHESIS_PYTHON_BIN = "/nonexistent/synthesis-python-test";
    try {
      const result = await runScript("does-not-matter.py", [], 5_000);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.SYNTHESIS_PYTHON_BIN;
      else process.env.SYNTHESIS_PYTHON_BIN = previous;
    }
  });
});
