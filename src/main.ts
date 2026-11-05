// Entry point for the compiled binary and the Node bundle.
import { main } from "./cli";
import { internalError } from "./errors";
import { exitCodeAfter, installProcessHandlers } from "./interrupt";

// main() reports what it did not expect itself; this covers what escapes it (a callback, a stray promise), so a user
// never sees the bundled source a runtime prints for an uncaught error.
const crash = (e: unknown) => {
  for (const line of internalError(e, process.env)) process.stderr.write(line + "\n");
  process.exit(2);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

installProcessHandlers();

const code = await exitCodeAfter(await main(process.argv.slice(2)));
process.stdout.write("", () => process.exit(code));
