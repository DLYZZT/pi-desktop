import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultBrowserSettings } from "./browser-settings.ts";
import {
  BrowserNetworkPolicy,
  isBenchmarkingIpAddress,
  isPrivateHostname,
  isPrivateIpAddress,
} from "./browser-network-policy.ts";

test("private address classification covers local, RFC1918, link-local, CGNAT, IPv6 local, and metadata names", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "198.18.0.1",
    "198.19.255.254",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateIpAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateIpAddress(address), false, address);
  }
  assert.equal(isBenchmarkingIpAddress("198.18.0.1"), true);
  assert.equal(isBenchmarkingIpAddress("198.19.255.254"), true);
  assert.equal(isBenchmarkingIpAddress("198.20.0.1"), false);
  for (const hostname of ["localhost", "api.localhost", "printer.local", "metadata.google.internal"]) {
    assert.equal(isPrivateHostname(hostname), true, hostname);
  }
});

test("confirmed proxy virtual DNS mappings do not look like private-network destinations", async () => {
  const settings = createDefaultBrowserSettings().navigation;
  let reverseLookups = 0;
  const policy = new BrowserNetworkPolicy({
    resolveHost: async () => [{ address: "198.18.85.138" }],
    getDnsServers: () => ["198.18.0.2"],
    reverseHost: async (address) => {
      reverseLookups += 1;
      assert.equal(address, "198.18.85.138");
      return ["cdn.example.com."];
    },
  });

  const allowed = await policy.check("https://cdn.example.com/image.webp", { settings });
  assert.equal(allowed.privateNetwork, false);
  assert.deepEqual(allowed.virtualDnsAddresses, ["198.18.85.138"]);

  await policy.check("https://cdn.example.com/another.webp", { settings });
  assert.equal(reverseLookups, 1, "confirmed mappings should be cached briefly for subresources");
});

test("virtual DNS compatibility stays fail-closed for literals, untrusted resolvers, PTR mismatches, and mixed results", async () => {
  const settings = createDefaultBrowserSettings().navigation;
  const cases = [
    new BrowserNetworkPolicy({
      resolveHost: async () => [{ address: "198.18.85.138" }],
      getDnsServers: () => ["1.1.1.1"],
      reverseHost: async () => ["cdn.example.com"],
    }),
    new BrowserNetworkPolicy({
      resolveHost: async () => [{ address: "198.18.85.138" }],
      getDnsServers: () => ["198.18.0.2"],
      reverseHost: async () => ["different.example.com"],
    }),
    new BrowserNetworkPolicy({
      resolveHost: async () => [{ address: "198.18.85.138" }, { address: "127.0.0.1" }],
      getDnsServers: () => ["198.18.0.2"],
      reverseHost: async () => ["cdn.example.com"],
    }),
  ];

  for (const policy of cases) {
    await assert.rejects(
      policy.check("https://cdn.example.com/image.webp", { settings }),
      (error) => error.code === "PRIVATE_NETWORK_BLOCKED",
    );
  }

  const literal = new BrowserNetworkPolicy({
    getDnsServers: () => ["198.18.0.2"],
    reverseHost: async () => ["198.18.85.138"],
  });
  await assert.rejects(
    literal.check("https://198.18.85.138/image.webp", { settings }),
    (error) => error.code === "PRIVATE_NETWORK_BLOCKED",
  );
});

test("URL policy blocks unsafe protocols, credentials, HTTP, literal private targets, and DNS rebinding results", async () => {
  const settings = createDefaultBrowserSettings().navigation;
  const policy = new BrowserNetworkPolicy({
    resolveHost: async (hostname) => [{ address: hostname === "rebind.example" ? "127.0.0.1" : "203.0.113.8" }],
  });

  await assert.rejects(policy.check("file:///tmp/a", { settings }), (error) => error.code === "UNSUPPORTED_PROTOCOL");
  await assert.rejects(
    policy.check("https://user:pass@example.com", { settings }),
    (error) => error.code === "NAVIGATION_BLOCKED",
  );
  await assert.rejects(
    policy.check("http://example.com", { settings }),
    (error) => error.code === "NAVIGATION_BLOCKED",
  );
  await assert.rejects(
    policy.check("https://127.0.0.1", { settings }),
    (error) => error.code === "PRIVATE_NETWORK_BLOCKED",
  );
  await assert.rejects(
    policy.check("https://rebind.example", { settings }),
    (error) => error.code === "PRIVATE_NETWORK_BLOCKED",
  );

  const allowed = await policy.check("https://example.com/a", { settings });
  assert.equal(allowed.url, "https://example.com/a");
  assert.deepEqual(allowed.resolvedAddresses, ["203.0.113.8"]);
});

test("explicit local approval is scoped to a request and strict mode fails without an enforcing sandbox", async () => {
  const settings = createDefaultBrowserSettings().navigation;
  const policy = new BrowserNetworkPolicy({ resolveHost: async () => [{ address: "127.0.0.1" }] });
  const allowed = await policy.check("http://localhost:3000", {
    settings,
    userApprovedHttp: true,
    userApprovedPrivateNetwork: true,
  });
  assert.equal(allowed.privateNetwork, true);

  await assert.rejects(
    policy.check("https://example.com", { settings: { ...settings, networkIsolation: "strict" } }),
    (error) => error.code === "NETWORK_ISOLATION_UNAVAILABLE",
  );

  const strict = new BrowserNetworkPolicy({
    strictNetworkAvailable: true,
    resolveHost: async () => [{ address: "203.0.113.9" }],
  });
  assert.equal(
    (await strict.check("https://example.com", { settings: { ...settings, networkIsolation: "strict" } })).isolation,
    "strict",
  );
});
