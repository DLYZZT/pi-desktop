import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { URLSearchParams } from "node:url";
import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";

const { FeishuAppRegistration, feishuScanAccountId } = await importTestBundle(
  "src/agent-host/channels/adapters/feishu/app-registration",
  {
    packages: "external",
    entryPoints: [path.join(import.meta.dirname, "app-registration.ts")],
  },
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(check, message = "condition was not reached") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function sdkResponse(config, data) {
  return {
    data,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    config,
    request: {},
  };
}

async function withSdkAdapter(adapter, run) {
  const previous = defaultHttpInstance.defaults.adapter;
  defaultHttpInstance.defaults.adapter = adapter;
  try {
    return await run();
  } finally {
    defaultHttpInstance.defaults.adapter = previous;
  }
}

test("official registerApp creates a new Feishu bot with the exact Pi channel capabilities", async () => {
  const completed = deferred();
  let options;
  const registration = new FeishuAppRegistration(async (received) => {
    options = received;
    received.onQRCodeReady({
      url: "https://open.feishu.cn/oauth/device?device_code=temporary-code",
      expireIn: 600,
    });
    return completed.promise;
  });

  const started = await registration.start({ channel: "feishu", domain: "feishu", force: true, localTokens: [] });
  assert.equal(started.phase, "qr");
  assert.equal(started.channel, "feishu");
  assert.match(started.qrContent, /^https:\/\/open\.feishu\.cn\//);
  assert.equal(options.domain, "accounts.feishu.cn");
  assert.equal(options.larkDomain, "accounts.larksuite.com");
  assert.equal(options.source, "pi-desktop");
  assert.equal(options.createOnly, true);
  assert.equal(options.addons.preset, false);
  assert.deepEqual(options.addons.scopes.tenant, [
    "im:message",
    "im:message.p2p_msg:readonly",
    "im:message.group_at_msg:readonly",
    "im:message:send_as_bot",
    "im:message.reactions:write_only",
    "im:resource",
    "cardkit:card:write",
  ]);
  assert.deepEqual(options.addons.events.items.tenant, ["im.message.receive_v1", "application.bot.menu_v6"]);

  completed.resolve({
    client_id: "cli_1234567890abcdef",
    client_secret: "super-secret-value",
    user_info: { open_id: "ou_owner", tenant_brand: "feishu" },
  });
  await flush();

  const result = registration.poll(started.sessionKey);
  assert.equal(result.event.phase, "confirmed");
  assert.equal(result.event.accountId, feishuScanAccountId("feishu", "cli_1234567890abcdef"));
  assert.deepEqual(result.account, {
    appId: "cli_1234567890abcdef",
    domain: "feishu",
    ownerUserId: "ou_owner",
  });
  assert.deepEqual(result.credential, {
    token: "super-secret-value",
    providerAccountId: "cli_1234567890abcdef",
    baseUrl: "https://open.feishu.cn",
  });
  assert.doesNotMatch(JSON.stringify(result.event), /super-secret-value/);
  result.finalize();
  assert.equal(registration.poll(started.sessionKey).event.phase, "error");
});

test("Lark domain switching is reflected in safe account metadata", async () => {
  const completed = deferred();
  let options;
  const registration = new FeishuAppRegistration(async (received) => {
    options = received;
    received.onQRCodeReady({ url: "https://open.feishu.cn/oauth/device", expireIn: 300 });
    return completed.promise;
  });
  const started = await registration.start({ channel: "feishu", domain: "feishu", localTokens: [] });
  options.onStatusChange({ status: "slow_down", interval: 10 });
  assert.equal(registration.poll(started.sessionKey).event.pollAfterMs, 10_000);
  options.onStatusChange({ status: "domain_switched" });
  assert.match(registration.poll(started.sessionKey).event.message, /Lark/);

  completed.resolve({
    client_id: "cli_lark123456789",
    client_secret: "lark-secret",
    user_info: { tenant_brand: "lark" },
  });
  await flush();
  const result = registration.poll(started.sessionKey);
  assert.equal(result.account.domain, "lark");
  assert.equal(result.credential.baseUrl, "https://open.larksuite.com");
});

test("an expired local session aborts and clears the QR state", async () => {
  let now = 1_000;
  const registration = new FeishuAppRegistration(
    async (options) => {
      options.onQRCodeReady({ url: "https://open.feishu.cn/oauth/device", expireIn: 60 });
      return new Promise(() => {});
    },
    () => now,
  );
  const started = await registration.start({ channel: "feishu", domain: "feishu", localTokens: [] });
  now += 61_000;
  const result = registration.poll(started.sessionKey);
  assert.equal(result.event.phase, "expired");
  assert.equal(result.event.qrContent, undefined);
});

test("provider expiry aborts the SDK even when the Renderer stops polling", async () => {
  let aborted = false;
  const registration = new FeishuAppRegistration(async (options) => {
    options.onQRCodeReady({ url: "https://open.feishu.cn/oauth/device", expireIn: 0.05 });
    await new Promise((resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject({ code: "abort" });
        },
        { once: true },
      );
    });
  });
  const started = await registration.start({ channel: "feishu", domain: "feishu", localTokens: [] });
  assert.equal(started.phase, "qr");
  await waitFor(() => aborted, "provider expiry did not abort the SDK");
  assert.equal(registration.poll(started.sessionKey).event.phase, "expired");
});

test("registration errors and untrusted QR links fail closed without leaking provider details", async () => {
  const denied = new FeishuAppRegistration(async () => {
    throw { code: "access_denied", description: "user denied" };
  });
  const deniedEvent = await denied.start({ channel: "feishu", domain: "feishu", localTokens: [] });
  assert.equal(deniedEvent.phase, "cancelled");

  const invalid = new FeishuAppRegistration(async (options) => {
    options.onQRCodeReady({
      url: "https://evil.example/steal?device_code=private-device-code",
      expireIn: 600,
    });
    await new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject({ code: "abort" }), { once: true });
    });
  });
  const invalidEvent = await invalid.start({ channel: "feishu", domain: "feishu", localTokens: [] });
  assert.equal(invalidEvent.phase, "error");
  assert.doesNotMatch(JSON.stringify(invalidEvent), /evil\.example|private-device-code/);
});

test("cancelling an active session aborts the SDK and clears any future credential", async () => {
  const registration = new FeishuAppRegistration(async (options) => {
    options.onQRCodeReady({ url: "https://open.larksuite.com/oauth/device", expireIn: 600 });
    await new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject({ code: "abort" }), { once: true });
    });
  });
  const started = await registration.start({ channel: "feishu", domain: "lark", localTokens: [] });
  registration.cancel(started.sessionKey);
  await flush();
  const result = registration.poll(started.sessionKey);
  assert.equal(result.event.phase, "cancelled");
  assert.equal(result.credential, undefined);
  assert.equal(result.account, undefined);
});

test("scan-created account IDs are deterministic and domain-separated", () => {
  assert.equal(
    feishuScanAccountId("feishu", "cli_1234567890abcdef"),
    feishuScanAccountId("feishu", "cli_1234567890abcdef"),
  );
  assert.notEqual(
    feishuScanAccountId("feishu", "cli_1234567890abcdef"),
    feishuScanAccountId("lark", "cli_1234567890abcdef"),
  );
});

test("the official SDK transport is bounded, domain-fixed, and supports pending plus Lark switching", async () => {
  const authorize = deferred();
  const reachedLark = deferred();
  const requests = [];
  let feishuPolls = 0;

  await withSdkAdapter(
    async (config) => {
      requests.push(config);
      const params = new URLSearchParams(config.data);
      if (params.get("action") === "begin") {
        return sdkResponse(config, {
          verification_uri_complete: "https://open.feishu.cn/open-apis/authen/v1/index?device_code=temporary",
          device_code: "temporary-device-code",
          expires_in: 60,
          interval: 0,
        });
      }
      if (config.url.startsWith("https://accounts.feishu.cn/")) {
        feishuPolls += 1;
        if (feishuPolls === 1) {
          return sdkResponse(config, { error: "authorization_pending" });
        }
        return sdkResponse(config, { user_info: { tenant_brand: "lark" } });
      }
      reachedLark.resolve();
      await authorize.promise;
      return sdkResponse(config, {
        client_id: "cli_officialtransport123",
        client_secret: "transport-secret",
        user_info: { open_id: "ou_transport_owner", tenant_brand: "lark" },
      });
    },
    async () => {
      const registration = new FeishuAppRegistration();
      const started = await registration.start({ channel: "feishu", domain: "feishu", localTokens: [] });
      assert.match(started.qrContent, /^https:\/\/open\.feishu\.cn\//);
      await reachedLark.promise;
      const switching = registration.poll(started.sessionKey);
      assert.equal(switching.event.phase, "waiting");
      assert.match(switching.event.message, /Lark/);

      authorize.resolve();
      const result = await waitFor(() => {
        const polled = registration.poll(started.sessionKey);
        return polled.event.phase === "confirmed" ? polled : undefined;
      }, "official SDK registration did not complete");
      assert.deepEqual(result.account, {
        appId: "cli_officialtransport123",
        domain: "lark",
        ownerUserId: "ou_transport_owner",
      });
      assert.doesNotMatch(JSON.stringify(result.event), /transport-secret|temporary-device-code/);
      result.finalize();
    },
  );

  assert.ok(requests.length >= 4);
  assert.equal(requests[0].url, "https://accounts.feishu.cn/oauth/v1/app/registration");
  assert.ok(requests.some((request) => request.url === "https://accounts.larksuite.com/oauth/v1/app/registration"));
  for (const request of requests) {
    assert.equal(request.timeout, 10_000);
    assert.equal(request.maxContentLength, 64 * 1_024);
    assert.equal(request.maxBodyLength, 16 * 1_024);
    assert.equal(request.maxRedirects, 0);
    assert.ok(request.signal instanceof globalThis.AbortSignal);
  }
});

test("the official SDK transport propagates slow_down and aborts an in-flight poll", async () => {
  let pollSignal;
  let pollCalls = 0;
  const pollEntered = deferred();
  await withSdkAdapter(
    async (config) => {
      const params = new URLSearchParams(config.data);
      if (params.get("action") === "begin") {
        return sdkResponse(config, {
          verification_uri_complete: "https://open.feishu.cn/oauth/device?device_code=temporary",
          device_code: "temporary-device-code",
          expires_in: 60,
          interval: 0,
        });
      }
      pollCalls += 1;
      if (pollCalls === 1) return sdkResponse(config, { error: "slow_down" });
      pollSignal = config.signal;
      pollEntered.resolve();
      return new Promise((resolve, reject) => {
        config.signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("cancelled"), { code: "ERR_CANCELED" })),
          {
            once: true,
          },
        );
      });
    },
    async () => {
      const registration = new FeishuAppRegistration();
      const started = await registration.start({ channel: "feishu", domain: "feishu", localTokens: [] });
      await waitFor(() => registration.poll(started.sessionKey).event.pollAfterMs === 5_000);
      assert.equal(registration.poll(started.sessionKey).event.pollAfterMs, 5_000);

      // The SDK schedules the next slow_down poll after five seconds. Starting a
      // fresh forced session proves the current in-flight begin/poll signal is
      // also carried by the hardened transport without waiting for that timer.
      registration.cancel(started.sessionKey);

      const second = new FeishuAppRegistration();
      pollCalls = 1;
      const secondStarted = await second.start({ channel: "feishu", domain: "feishu", localTokens: [] });
      await pollEntered.promise;
      second.cancel(secondStarted.sessionKey);
      await flush();
      assert.equal(pollSignal.aborted, true);
      assert.equal(second.poll(secondStarted.sessionKey).event.phase, "cancelled");
    },
  );
});

test("simulated registration responses fail closed on terminal and malformed protocol cases", async (t) => {
  const begin = {
    verification_uri_complete: "https://open.feishu.cn/oauth/device?device_code=temporary",
    device_code: "temporary-device-code",
    expires_in: 60,
    interval: 0,
  };

  async function runScenario(pollData) {
    return withSdkAdapter(
      async (config) => {
        const params = new URLSearchParams(config.data);
        return sdkResponse(config, params.get("action") === "begin" ? begin : pollData);
      },
      async () => {
        const registration = new FeishuAppRegistration();
        const started = await registration.start({ channel: "feishu", domain: "feishu", localTokens: [] });
        return waitFor(() => {
          const event = registration.poll(started.sessionKey).event;
          return ["cancelled", "expired", "error", "confirmed"].includes(event.phase) ? event : undefined;
        });
      },
    );
  }

  await t.test("access denied", async () => {
    const event = await runScenario({ error: "access_denied", error_description: "device_code=do-not-leak" });
    assert.equal(event.phase, "cancelled");
    assert.doesNotMatch(JSON.stringify(event), /do-not-leak/);
  });

  await t.test("provider expiry", async () => {
    const event = await runScenario({ error: "expired_token" });
    assert.equal(event.phase, "expired");
  });

  await t.test("malformed JSON body", async () => {
    const event = await withSdkAdapter(
      async (config) => sdkResponse(config, "{"),
      async () => {
        const registration = new FeishuAppRegistration();
        return registration.start({ channel: "feishu", domain: "feishu", localTokens: [] });
      },
    );
    assert.equal(event.phase, "error");
    assert.doesNotMatch(JSON.stringify(event), /undefined|SyntaxError/);
  });

  await t.test("missing begin fields", async () => {
    const event = await withSdkAdapter(
      async (config) => sdkResponse(config, { expires_in: 60 }),
      async () => {
        const registration = new FeishuAppRegistration();
        return registration.start({ channel: "feishu", domain: "feishu", localTokens: [] });
      },
    );
    assert.equal(event.phase, "error");
    assert.doesNotMatch(JSON.stringify(event), /undefined|verification_uri/);
  });

  await t.test("oversized QR response field", async () => {
    const event = await withSdkAdapter(
      async (config) =>
        sdkResponse(config, {
          ...begin,
          verification_uri_complete: `https://open.feishu.cn/oauth/device?padding=${"x".repeat(9_000)}`,
        }),
      async () => {
        const registration = new FeishuAppRegistration();
        return registration.start({ channel: "feishu", domain: "feishu", localTokens: [] });
      },
    );
    assert.equal(event.phase, "error");
    assert.doesNotMatch(JSON.stringify(event), /padding|x{20}/);
  });

  await t.test("untrusted QR domain", async () => {
    const event = await withSdkAdapter(
      async (config) =>
        sdkResponse(config, {
          ...begin,
          verification_uri_complete: "https://evil.example/device?device_code=do-not-leak",
        }),
      async () => {
        const registration = new FeishuAppRegistration();
        return registration.start({ channel: "feishu", domain: "feishu", localTokens: [] });
      },
    );
    assert.equal(event.phase, "error");
    assert.doesNotMatch(JSON.stringify(event), /evil\.example|do-not-leak/);
  });
});

test("transport timeout, oversized response, redirect, and wrong registration hosts are rejected", async (t) => {
  async function transportFailure(code) {
    return withSdkAdapter(
      async () => {
        throw Object.assign(new Error("provider details must not be shown"), { code });
      },
      async () => {
        const registration = new FeishuAppRegistration();
        return registration.start({ channel: "feishu", domain: "feishu", localTokens: [] });
      },
    );
  }

  await t.test("timeout", async () => {
    const event = await transportFailure("ECONNABORTED");
    assert.match(event.message, /超时/);
    assert.doesNotMatch(event.message, /provider details/);
  });

  await t.test("oversized body", async () => {
    const event = await transportFailure("ERR_BAD_RESPONSE");
    assert.match(event.message, /服务返回异常/);
  });

  await t.test("redirect", async () => {
    const event = await transportFailure("ERR_FR_TOO_MANY_REDIRECTS");
    assert.match(event.message, /服务返回异常/);
  });

  await t.test("wrong endpoint host", async () => {
    let adapterCalled = false;
    await withSdkAdapter(
      async (config) => {
        adapterCalled = true;
        return sdkResponse(config, {});
      },
      async () => {
        await assert.rejects(
          defaultHttpInstance.post("https://evil.example/oauth/v1/app/registration", "action=begin"),
          /untrusted Feishu\/Lark app registration endpoint/,
        );
      },
    );
    assert.equal(adapterCalled, false);
  });
});
