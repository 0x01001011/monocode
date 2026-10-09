import { createServer } from "node:net";

const canListen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

/**
 * First loopback port from `start` that nothing listens on. Hosts are loopback
 * services, so every account on a shared machine competes for the same range.
 */
export async function firstFreePort(
  start: number,
  attempts = 100,
): Promise<number> {
  const last = Math.min(start + attempts - 1, 65535);
  for (let port = start; port <= last; port += 1)
    if (await canListen(port)) return port;
  throw new Error(
    `No free port from ${start} to ${last}; pass --port to choose one.`,
  );
}
