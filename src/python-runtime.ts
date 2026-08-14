/** Resolve the interpreter selected by the service installer. */
export function synthesisPythonBin(
  configured = process.env.SYNTHESIS_PYTHON_BIN
): string {
  return configured?.trim() || "python3";
}
