import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "./devices.ts";
import { bypassed, configureOutbound, installOutboundGuard, outboundFetch, outboundStatus, OutboundRefusedError, proxyOnlyStartRefusal, readOutboundPolicy, relayFetch, relayRefusal, relayWebSocket } from "./outbound.ts";
import { loadRelayIdentity } from "./relay/identity.ts";
import { RelayLink } from "./relay/link.ts";
import { RelayPairCodes } from "./relay/pair-code.ts";
import { RelayPassKeeper } from "./relay/pass.ts";
import { probeRelay } from "./relay/service.ts";
import { relayFixture, TestClock } from "./relay/test-helpers.ts";
import { runCommand } from "./updater.ts";

/**
 * A fake HTTP CONNECT proxy on an ephemeral loopback port: it records each request line and refuses the tunnel, so
 * nothing these tests open ever reaches a real host (no real proxy of this machine is ever used).
 */
function fakeProxy() {
  const requests: string[] = [];
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    data(socket, chunk) {
      requests.push(Buffer.from(chunk).toString("latin1").split("\r\n")[0]!);
      socket.write("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
      socket.end();
    },
  } });
  return { url: `http://127.0.0.1:${listener.port}`, address: `127.0.0.1:${listener.port}`, requests, stop: () => listener.stop(true) };
}

/** A relay that counts every connection made straight to it: proxy-only mode must leave it at zero. */
function fakeRelay() {
  let connections = 0;
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { connections++; }, data() {} } });
  return { port: listener.port, get connections() { return connections; }, stop: () => listener.stop(true) };
}

function deadPort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function waitFor(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  configureOutbound({});
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-outbound-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Every kind of relay traffic the PC opens, each through its module's own default dial. */
async function relayTraffic(relayWs: string, relayHttps: string, stateDir: string, services: Parameters<typeof relayFixture>[1] = {}): Promise<void> {
  const fixture = relayFixture(false, { ...services, stateDir: join(stateDir, "pc") });
  cleanups.push(() => fixture.close());
  const identity = loadRelayIdentity(fixture.stateDir);
  const link = new RelayLink({ relay: relayWs, identity, services: fixture.app.context.services, port: fixture.app.port, clock: new TestClock(), random: () => 0.5, onState: () => {} });
  link.start();
  cleanups.push(() => link.stop());
  const codes = new RelayPairCodes({ relay: relayWs, devices: new DeviceStore(join(stateDir, "codes")), identity: () => identity,
    offer: (code) => ({ v: 1, server_id: identity.server_id, server_public_key: identity.public_key, relay: relayWs, code }) });
  cleanups.push(() => codes.cancel());
  const minted = codes.mint().catch((error: unknown) => error);
  expect(await probeRelay(relayWs, new AbortController().signal)).toBeNull();
  const keeper = new RelayPassKeeper({ stateDir: join(stateDir, "pass"), identity: () => identity, account: () => "acct_1", service: relayHttps, clock: new TestClock(), onPass: () => {} });
  keeper.start();
  await keeper.refresh();
  keeper.stop();
  expect(await minted).toBeInstanceOf(Error);
}

describe("the policy", () => {
  it("reads the switch and the address from the environment, and never shows the proxy's credentials", () => {
    expect(readOutboundPolicy({})).toMatchObject({ proxyOnly: false, proxy: null, invalid: null });
    expect(readOutboundPolicy({ OVIS_OUTBOUND_PROXY_ONLY: "1" }).invalid).toBe("proxy-only mode is on, but HTTPS_PROXY is not set");
    for (const malformed of ["socks5://127.0.0.1:1080", "https://127.0.0.1:8443", "127.0.0.1:10060", "http://127.0.0.1:10060/path", "not a url"]) {
      expect(readOutboundPolicy({ OVIS_OUTBOUND_PROXY_ONLY: "1", HTTPS_PROXY: malformed })).toMatchObject({ proxy: null, invalid: "HTTPS_PROXY is not an http://host:port address" });
    }
    const named = readOutboundPolicy({ OVIS_OUTBOUND_PROXY_ONLY: "1", https_proxy: "http://user:secret@127.0.0.1:10060" });
    expect(named).toMatchObject({ proxyOnly: true, proxy: "http://user:secret@127.0.0.1:10060", display: "127.0.0.1:10060", invalid: null });
    expect(readOutboundPolicy({ HTTPS_PROXY: "http://a:1", https_proxy: "http://b:2" }).display).toBe("a:1");
  });

  it("fails closed at startup and says why: no address, a malformed one, or a HOST beyond loopback", () => {
    const missing = proxyOnlyStartRefusal(readOutboundPolicy({ OVIS_OUTBOUND_PROXY_ONLY: "1" }), "127.0.0.1");
    expect(missing).toContain("HTTPS_PROXY is not set");
    expect(proxyOnlyStartRefusal(readOutboundPolicy({ OVIS_OUTBOUND_PROXY_ONLY: "1", HTTPS_PROXY: "socks5://h:1" }), "127.0.0.1")).toContain("not an http://host:port address");
    const policy = readOutboundPolicy({ OVIS_OUTBOUND_PROXY_ONLY: "1", HTTPS_PROXY: "http://127.0.0.1:10060" });
    for (const host of ["0.0.0.0", "100.101.102.103", "192.168.1.20", "::"]) expect(proxyOnlyStartRefusal(policy, host)).toContain(`HOST=${host} is not`);
    for (const host of ["127.0.0.1", "localhost", "::1"]) expect(proxyOnlyStartRefusal(policy, host)).toBeNull();
    expect(proxyOnlyStartRefusal(readOutboundPolicy({}), "0.0.0.0")).toBeNull();
  });

  it("reads the bypass list as curl does", () => {
    const url = (address: string) => new URL(address);
    const list = ["internal.example", ".corp.example", "10.0.0.0/8", "proxyless.example:8443", "[fd00::1]"];
    expect(bypassed(url("https://internal.example/x"), list)).toBe(true);
    expect(bypassed(url("https://api.internal.example/x"), list)).toBe(true);
    expect(bypassed(url("https://notinternal.example/x"), list)).toBe(false);
    expect(bypassed(url("https://git.corp.example/x"), list)).toBe(true);
    expect(bypassed(url("https://10.2.3.4/x"), list)).toBe(true);
    expect(bypassed(url("https://11.2.3.4/x"), list)).toBe(false);
    expect(bypassed(url("https://proxyless.example:8443/x"), list)).toBe(true);
    expect(bypassed(url("https://proxyless.example/x"), list)).toBe(false);
    expect(bypassed(url("https://[fd00::1]/x"), list)).toBe(true);
    expect(bypassed(url("https://anything.example/x"), ["*"])).toBe(true);
  });
});

describe("proxy-only mode", () => {
  it("sends every kind of relay traffic through the proxy, even when NO_PROXY names the relay", async () => {
    const proxy = fakeProxy();
    cleanups.push(proxy.stop);
    const env = { OVIS_OUTBOUND_PROXY_ONLY: "1", HTTPS_PROXY: proxy.url, NO_PROXY: "relay.example.test,account.example.test,.example.test,localhost,127.0.0.0/8" };
    configureOutbound(env);
    await relayTraffic("wss://relay.example.test", "https://account.example.test", tempDir(), { outboundEnv: env });
    // the relay socket, the pairing code socket and the three health probes, each a tunnel to the relay's port 443
    await waitFor(() => proxy.requests.filter((line) => line === "CONNECT relay.example.test:443 HTTP/1.1").length >= 3, "the relay's CONNECTs");
    expect(proxy.requests).toContain("CONNECT account.example.test:443 HTTP/1.1");
    expect(proxy.requests.every((line) => line.startsWith("CONNECT ") && line.endsWith(":443 HTTP/1.1"))).toBe(true);
  });

  for (const [name, proxyEnv] of [
    ["no proxy address", () => ({})],
    ["a malformed proxy address", () => ({ HTTPS_PROXY: "socks5://127.0.0.1:1080" })],
    ["an unreachable proxy", () => ({ HTTPS_PROXY: `http://127.0.0.1:${deadPort()}` })],
  ] as const) {
    it(`refuses relay traffic with ${name}, and never dials the relay directly`, async () => {
      const relay = fakeRelay();
      cleanups.push(relay.stop);
      const dir = tempDir();
      // the PC's own server needs a startable policy: it is started first, and the policy under test set after it
      const fixture = relayFixture(false, { stateDir: join(dir, "server") });
      cleanups.push(() => fixture.close());
      // this process's own NO_PROXY names the relay too, as this Mac's covers every private range: Bun would honour it
      // even for a socket given the proxy, so proxy-only mode must take it out of the process
      const ownBypass = process.env["NO_PROXY"];
      process.env["NO_PROXY"] = "127.0.0.1,localhost,10.0.0.0/8";
      cleanups.push(() => { configureOutbound({}); if (ownBypass === undefined) delete process.env["NO_PROXY"]; else process.env["NO_PROXY"] = ownBypass; });
      // picked last, so no listener of this test takes the dead port
      configureOutbound({ OVIS_OUTBOUND_PROXY_ONLY: "1", NO_PROXY: "127.0.0.1,localhost", ...proxyEnv() });
      expect(process.env["NO_PROXY"]).toBeUndefined();
      const identity = loadRelayIdentity(fixture.stateDir);
      const relayWs = `wss://127.0.0.1:${relay.port}`;
      const states: string[] = [];
      const link = new RelayLink({ relay: relayWs, identity, services: fixture.app.context.services, port: fixture.app.port, clock: new TestClock(), random: () => 0.5, onState: (phase) => states.push(phase) });
      link.start();
      cleanups.push(() => link.stop());
      const codes = new RelayPairCodes({ relay: relayWs, devices: new DeviceStore(join(dir, "codes")), identity: () => identity,
        offer: (code) => ({ v: 1, server_id: identity.server_id, server_public_key: identity.public_key, relay: relayWs, code }) });
      cleanups.push(() => codes.cancel());
      expect(await codes.mint().catch((error: unknown) => error)).toBeInstanceOf(Error);
      expect(await probeRelay(relayWs, new AbortController().signal)).toBeNull();
      const keeper = new RelayPassKeeper({ stateDir: join(dir, "pass"), identity: () => identity, account: () => "acct_1", service: `https://127.0.0.1:${relay.port}`, clock: new TestClock(), onPass: () => {} });
      keeper.start();
      await keeper.refresh();
      keeper.stop();
      await waitFor(() => states.includes("error"), "the relay link to report the refusal");
      await waitFor(() => relayRefusal() !== null, "the refusal to be recorded");
      expect(relay.connections).toBe(0);
      const refusal = outboundStatus().latest_refusal!;
      expect(refusal.kind).toBe("relay");
      expect(refusal.reason).toMatch(name === "an unreachable proxy" ? /^proxy 127\.0\.0\.1:\d+ can't be reached$/ : /HTTPS_PROXY/);
    });
  }

  it("sends other connections through the proxy, honours NO_PROXY for them, and never proxies this machine", async () => {
    const proxy = fakeProxy();
    cleanups.push(proxy.stop);
    const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("local") });
    cleanups.push(() => local.stop(true));
    configureOutbound({ OVIS_OUTBOUND_PROXY_ONLY: "1", HTTPS_PROXY: proxy.url, NO_PROXY: "bypassed.example.test" });
    await outboundFetch("https://telemetry.example.test/v1/events", { method: "POST", body: "{}" }).catch(() => null);
    await outboundFetch("http://plain.example.test/updates").catch(() => null);
    expect(proxy.requests).toContain("CONNECT telemetry.example.test:443 HTTP/1.1");
    // one proxy carries every destination in proxy-only mode, plain http too
    expect(proxy.requests).toContain("GET http://plain.example.test/updates HTTP/1.1");
    const before = proxy.requests.length;
    await outboundFetch("https://bypassed.example.test/", { signal: AbortSignal.timeout(3000) }).catch(() => null);
    expect(await (await outboundFetch(`http://127.0.0.1:${local.port}/`)).text()).toBe("local");
    expect(proxy.requests.length).toBe(before);
    // relay traffic ignores the bypass list
    await relayFetch("https://bypassed.example.test/health").catch(() => null);
    expect(proxy.requests.at(-1)).toBe("CONNECT bypassed.example.test:443 HTTP/1.1");
  });

  it("gives every child that reaches the network the proxy variables", async () => {
    configureOutbound({ OVIS_OUTBOUND_PROXY_ONLY: "1", HTTPS_PROXY: "http://127.0.0.1:9" });
    const env = await runCommand(tempDir(), ["/usr/bin/env"]);
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) expect(env).toContain(`${name}=http://127.0.0.1:9\n`);
  });

  it("replaces the global fetch and WebSocket so a direct dial that slipped through is refused and logged", async () => {
    const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("local") });
    cleanups.push(() => local.stop(true));
    configureOutbound({ OVIS_OUTBOUND_PROXY_ONLY: "1", HTTPS_PROXY: `http://127.0.0.1:${deadPort()}` });
    const restore = installOutboundGuard();
    cleanups.push(restore);
    expect(await fetch("https://slipped.example.test/").catch((error: unknown) => error)).toBeInstanceOf(OutboundRefusedError);
    expect(() => new WebSocket("wss://slipped.example.test/v1/ws")).toThrow(OutboundRefusedError);
    expect(outboundStatus().latest_refusal?.target).toBe("slipped.example.test:443");
    expect(await (await fetch(`http://127.0.0.1:${local.port}/`)).text()).toBe("local");
  });
});

describe("with the switch off", () => {
  it("uses HTTPS_PROXY for relay sockets as a best effort, and honours NO_PROXY", async () => {
    const proxy = fakeProxy();
    cleanups.push(proxy.stop);
    configureOutbound({ HTTPS_PROXY: proxy.url, NO_PROXY: "bypassed.example.test" });
    const socket = relayWebSocket("wss://relay.example.test/v1/ws");
    await new Promise((resolve) => socket.addEventListener("close", resolve));
    expect(proxy.requests).toEqual(["CONNECT relay.example.test:443 HTTP/1.1"]);
    const bypassedSocket = relayWebSocket("wss://bypassed.example.test/v1/ws");
    await new Promise((resolve) => bypassedSocket.addEventListener("close", resolve));
    expect(proxy.requests).toHaveLength(1);
    // an unreachable proxy is no refusal here: nothing is recorded, and the relay simply retries as it always has
    expect(outboundStatus()).toEqual({ proxy_only: false, proxy: proxy.address, invalid: null, latest_refusal: null });
  });

  it("with neither set, dials as it did before", async () => {
    configureOutbound({});
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request, bun) => bun.upgrade(request) ? undefined : new Response("plain"), websocket: { open(socket) { socket.send("hello"); }, message() {} } });
    cleanups.push(() => server.stop(true));
    const socket = relayWebSocket(`ws://127.0.0.1:${server.port}/v1/ws`);
    expect(await new Promise<unknown>((resolve) => socket.addEventListener("message", (event) => resolve(event.data)))).toBe("hello");
    socket.close();
    const plain = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("plain") });
    cleanups.push(() => plain.stop(true));
    expect(await (await outboundFetch(`http://127.0.0.1:${plain.port}/`)).text()).toBe("plain");
    expect(outboundStatus()).toEqual({ proxy_only: false, proxy: null, invalid: null, latest_refusal: null });
  });
});
