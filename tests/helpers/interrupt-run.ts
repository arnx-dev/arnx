// A review in its own process whose test run never answers, for tests that send it a real signal: it installs main's
// process handlers, prints RUNNING once the run has begun, and waits there.
import { join } from "node:path";
import { installProcessHandlers } from "../../src/interrupt";
import { runReview } from "../../src/reviewer";
import { defaultSettings } from "../../src/settings";
import { FakeJson, FakeSession, ScriptedAgent, text, tool } from "./fakes";

const repo = process.argv[2]!;
installProcessHandlers();
const GEN = "tests/arnx_generated/test_x.py";
setInterval(() => {}, 1000); // a promise that never settles does not keep the process alive
void runReview(repo, { settings: { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-12T00:00:00Z" },
  agentModel: new ScriptedAgent([
    [tool("write_file", { path: `svc/${GEN}`, content: "import calc\ndef test_bad(): assert 0\n" })],
    [text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }))]]),
  challenger: new FakeJson([]),
  // arnx's own probe test answers; the first run of the model's tests never does
  sessionFactory: async (_c, snap, _l, body) => {
    const fake = new FakeSession(snap, () => [null, "", false]);
    return body({ run: (command) => {
      if (command.includes("test_arnx_probe")) return fake.run(command);
      process.stdout.write("RUNNING\n");
      return new Promise(() => {});
    } });
  },
}).then(() => process.stdout.write(`DONE ${join(repo)}\n`), (e) => process.stdout.write(`FAILED ${String(e)}\n`));
