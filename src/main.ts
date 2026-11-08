// Entry point for the compiled binary and the Node bundle.
import { main } from "./cli";
import { fatal } from "./errors";
import { exitCodeAfter, installProcessHandlers } from "./interrupt";

// main() reports what it did not expect itself; this covers what escapes it (a callback, a stray promise), so a user
// never sees the bundled source a runtime prints for an uncaught error. An arnx error (a key with no credits) still
// says its own line.
const crash = (e: unknown) => {
  const { lines, code } = fatal(e, process.env);
  for (const line of lines) process.stderr.write(line + "\n");
  process.exit(code);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

installProcessHandlers();

const code = await exitCodeAfter(await main(process.argv.slice(2)));
process.stdout.write("", () => process.exit(code));
