import { afterAll, beforeAll } from "bun:test";

/** Fixes the Docker capacity arnx reads, so a test with an injected runner never shells out to `docker info`. */
export function pinDockerCapacity(): void {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.ARNX_DOCKER_CAPACITY;
    process.env.ARNX_DOCKER_CAPACITY = "8 17179869184";
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.ARNX_DOCKER_CAPACITY;
    else process.env.ARNX_DOCKER_CAPACITY = saved;
  });
}
