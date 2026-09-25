import { expect, test } from "bun:test";
import { boundedCommand, MAX_OUTPUT_BYTES, READ_TIMEOUT_MS } from "./autopilot.js";

test("runtime verification failure is distinct from reader timeout", async () => {
  await expect(boundedCommand(process.execPath, ["-e", "console.error('fixture verification refused');process.exit(23)"], 8000, "Runtime verification"))
    .rejects.toThrow("Runtime verification exited with code 23: fixture verification refused");
});
test("reader timeout identifies finite boundary without calling it a runtime failure", async () => {
  await expect(boundedCommand(process.execPath, ["-e", "setTimeout(()=>{},5000)"], 30, "Operator reader"))
    .rejects.toThrow("Operator reader exceeded its 30 ms time bound");
});
test("stdout flood and stderr flood identify the output boundary", async () => {
  for (const stream of ["stdout", "stderr"]) {
    await expect(boundedCommand(process.execPath, ["-e", `process.${stream}.write('x'.repeat(2*1024*1024))`], 8000, "Operator reader"))
      .rejects.toThrow("Operator reader exceeded its output bound");
  }
});
test("launch failure and legitimate nonzero reader result remain failures", async () => {
  await expect(boundedCommand("/nonexistent/operator-reader-fixture", [], 8000, "Operator reader"))
    .rejects.toThrow("Operator reader could not start");
  await expect(boundedCommand(process.execPath, ["-e", "console.error('fixture corruption');process.exit(2)"], 8000, "Operator reader"))
    .rejects.toThrow("Operator reader exited with code 2: fixture corruption");
});
test("a process signal is not mislabeled as timeout", async () => {
  await expect(boundedCommand(process.execPath, ["-e", "process.kill(process.pid,'SIGKILL')"], 8000, "Operator reader"))
    .rejects.toThrow("Operator reader terminated by signal SIGKILL");
});
test("positive read and configured limits remain exact", async () => {
  expect(READ_TIMEOUT_MS).toBe(8000);
  expect(MAX_OUTPUT_BYTES).toBe(1024*1024);
  expect(await boundedCommand(process.execPath, ["-e", "process.stdout.write('verified fixture')"], 8000, "Operator reader")).toBe("verified fixture");
});
