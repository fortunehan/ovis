import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutboundHealth, RelayStatus } from "../shared/protocol.ts";
import { createServer } from "./index.ts";
import { configureOutbound, localFetch, ProxyOnlyStartError } from "./outbound.ts";
import { RelayService } from "./relay/service.ts";
import { relayFixture } from "./relay/test-helpers.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  configureOutbound({});
});

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-proxy-only-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function listening(port: number): Promise<boolean> {
  try { (await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } })).end(); return true; }
  catch { return false; }
}

async function waitFor(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

/** A PC whose relay would take direct connections on 127.0.0.1 at a port of the test's, with the relay on. */
function relayServer(outboundEnv: Record<string, string>) {
  const dir = stateDir();
  const port = freePort();
  const service = new RelayService({ stateDir: dir, relay: "wss://relay.example.test", direct: { addresses: () => ["127.0.0.1"], peerAllowed: () => true, preferredPort: port } });
  const fixture = relayFixture(false, { stateDir: dir, relay: service, outboundEnv });
  cleanups.push(() => fixture.close(), () => service.shutdown());
  service.start();
  return { fixture, service, port, base: `http://127.0.0.1:${fixture.app.port}` };
}

describe("a server started in proxy-only mode", () => {
  it("does not start without a usable proxy or beyond loopback, and says why", () => {
    const start = (hostname: string, env: Record<string, string>) => () => createServer({ port: 0, hostname, token: "", tailscaleOwner: null, sidecar: false, stateDir: stateDir(), outboundEnv: env });
    expect(start("127.0.0.1", { OVIS_OUTBOUND_PROXY_ONLY: "1" })).toThrow(ProxyOnlyStartError);
    expect(start("127.0.0.1", { OVIS_OUTBOUND_PROXY_ONLY: "1" })).toThrow("HTTPS_PROXY is not set");
    expect(start("127.0.0.1", { OVIS_OUTBOUND_PROXY_ONLY: "1", HTTPS_PROXY: "socks5://127.0.0.1:1080" })).toThrow("HTTPS_PROXY is not an http://host:port address");
    expect(start("0.0.0.0", { OVIS_OUTBOUND_PROXY_ONLY: "1", HTTPS_PROXY: "http://127.0.0.1:10060" })).toThrow("it listens on loopback only, and HOST=0.0.0.0 is not");
  });

  it("reports the policy and the latest refusal, offers no direct carrier, and refuses SSH, Tailnet and address PCs", async () => {
    const proxy = freePort();
    const { service, port, base } = relayServer({ OVIS_OUTBOUND_PROXY_ONLY: "1", HTTPS_PROXY: `http://user:secret@127.0.0.1:${proxy}` });
    await waitFor(() => service.status().outbound?.refusal != null, "the relay's refusal");

    const health = await (await localFetch(`${base}/api/health`)).json() as { outbound: OutboundHealth; relay: RelayStatus; direct_exposure?: unknown };
    expect(health.outbound).toMatchObject({ proxy_only: true, proxy: `127.0.0.1:${proxy}`, invalid: null });
    expect(health.outbound.latest_refusal).toMatchObject({ kind: "relay", target: "relay.example.test:443", reason: `proxy 127.0.0.1:${proxy} can't be reached` });
    expect(JSON.stringify(health)).not.toContain("secret");
    expect(health.relay.outbound).toEqual({ proxy_only: true, proxy: `127.0.0.1:${proxy}`, refusal: `proxy 127.0.0.1:${proxy} can't be reached` });
    // no direct listener, so nothing advertised to phones, and nothing said to be open on the network
    expect(health.relay).not.toHaveProperty("direct");
    expect(health).not.toHaveProperty("direct_exposure");
    expect(await listening(port)).toBe(false);
    await expect(service.setDirect(true)).rejects.toThrow("not available");

    const owner = { "content-type": "application/json", "x-herdr-update": "1", "x-herdr-machine": "1" };
    const post = (path: string, body: unknown) => localFetch(`${base}/api/machines/${path}`, { method: "POST", headers: owner, body: JSON.stringify(body) });
    for (const [path, body, feature] of [
      ["setup", { destination: "pc.example.test" }, "SSH PCs"],
      ["tailnet", { url: "https://pc.tail1e211e.ts.net" }, "Tailnet PCs"],
      ["address", { address: "https://192.168.1.20", code: "123456" }, "PCs added by their address"],
    ] as const) {
      const response = await post(path, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "proxy_only", message: `${feature} are turned off by proxy-only mode (OVIS_OUTBOUND_PROXY_ONLY=1).` } });
    }
    for (const path of ["ssh-candidates", "tailnet"]) {
      expect(await (await localFetch(`${base}/api/machines/${path}`, { headers: owner })).json()).toEqual({ pcs: [] });
    }
  });

  // where it listens and what it advertises with the switch off: server/relay/direct.contract.test.ts
  it("keeps direct connections available with the switch off", async () => {
    const { service } = relayServer({});
    expect(service.directAvailable).toBe(true);
    expect((await service.setDirect(true)).direct?.on).toBe(true);
    expect(service.status()).not.toHaveProperty("outbound");
  });
});
