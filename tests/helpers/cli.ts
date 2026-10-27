import { type CliDeps, main } from "../../src/cli";

/** Runs the CLI in-process with captured output. */
export class Cli {
  out: string[] = [];
  err: string[] = [];
  constructor(public deps: Partial<CliDeps>) {}

  run(...argv: string[]): Promise<number> {
    // Telemetry stays closed unless a test opens it, so no test ever posts to the real endpoint; no test asks the real
    // Docker for its images.
    return main(argv, { env: {}, dockerOk: () => [true, "running"], oldImages: () => [], ask: async () => null,
      check: false, telemetryOpen: false, ...this.deps,
      out: (l) => this.out.push(l), err: (l) => this.err.push(l) });
  }

  get stdout(): string {
    return this.out.join("\n");
  }

  get stderr(): string {
    return this.err.join("\n");
  }
}
