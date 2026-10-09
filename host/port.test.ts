import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { firstFreePort } from "./port";

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(
    open.splice(0).map((server) => new Promise((done) => server.close(done))),
  );
});
const occupy = (port: number) =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      open.push(server);
      resolve((server.address() as { port: number }).port);
    });
  });
const freeBlock = async (size: number) => {
  // An OS-assigned port whose next neighbours are probed free by the test itself.
  for (;;) {
    const port = await occupy(0);
    await new Promise((done) => open.pop()!.close(done));
    try {
      const held = await Promise.all(
        Array.from({ length: size }, (_, i) => occupy(port + i)),
      );
      await Promise.all(open.splice(0).map((s) => new Promise((d) => s.close(d))));
      return held[0];
    } catch {
      await Promise.all(open.splice(0).map((s) => new Promise((d) => s.close(d))));
    }
  }
};

it("returns the first port when it is free", async () => {
  const start = await freeBlock(3);
  expect(await firstFreePort(start)).toBe(start);
});

it("skips ports another process already listens on", async () => {
  const start = await freeBlock(3);
  await occupy(start);
  await occupy(start + 1);
  expect(await firstFreePort(start)).toBe(start + 2);
});

it("gives up with a clear error when the whole range is busy", async () => {
  const start = await freeBlock(2);
  await occupy(start);
  await occupy(start + 1);
  await expect(firstFreePort(start, 2)).rejects.toThrow(
    new RegExp(`No free port.*${start}`),
  );
});
