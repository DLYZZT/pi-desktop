import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { encode, isSilk } from "silk-wasm";

const output = path.join(
  import.meta.dirname,
  "../../../../../.artifacts/test-modules",
  `weixin-media-${process.pid}.mjs`,
);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: 'export { downloadWeixinAttachments, sendWeixinAttachment } from "./media.ts";',
    resolveDir: import.meta.dirname,
    sourcefile: "weixin-media-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { downloadWeixinAttachments, sendWeixinAttachment } = await import(
  `${pathToFileURL(output).href}?v=${Date.now()}`
);

function encrypt(data, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

test("Weixin CDN image and file payloads are downloaded and AES-128-ECB decrypted", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const file = Buffer.from("safe file");
  const imageKey = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const fileKey = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
  globalThis.fetch = async (url) => {
    const body = String(url).includes("image") ? encrypt(image, imageKey) : encrypt(file, fileKey);
    return new globalThis.Response(body, {
      status: 200,
      headers: { "Content-Length": String(body.length) },
    });
  };
  const result = await downloadWeixinAttachments({
    item_list: [
      {
        type: 2,
        image_item: {
          aeskey: imageKey.toString("hex"),
          media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/image" },
        },
      },
      {
        type: 4,
        file_item: {
          file_name: "notes.txt",
          media: {
            full_url: "https://novac2c.cdn.weixin.qq.com/c2c/file",
            aes_key: Buffer.from(fileKey.toString("hex")).toString("base64"),
          },
        },
      },
    ],
  });
  assert.deepEqual(result, [
    { kind: "image", data: image },
    { kind: "file", data: file, name: "notes.txt", mime: "text/plain" },
  ]);
});

test("Weixin media refuses provider-controlled non-Tencent download origins", async () => {
  await assert.rejects(
    downloadWeixinAttachments({
      item_list: [{ type: 2, image_item: { media: { full_url: "https://127.0.0.1/private" } } }],
    }),
    /不受信任/,
  );
});

test("Weixin voice detects and decodes SILK bytes even when encode_type is unexpected", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const pcm = new Int16Array(2_400);
  for (let index = 0; index < pcm.length; index += 1) pcm[index] = Math.round(1_000 * Math.sin(index / 20));
  const silk = Buffer.from((await encode(pcm, 24_000)).data);
  assert.equal(isSilk(silk), true);
  globalThis.fetch = async () =>
    new globalThis.Response(silk, {
      status: 200,
      headers: { "Content-Length": String(silk.length) },
    });

  const result = await downloadWeixinAttachments({
    item_list: [
      {
        type: 3,
        voice_item: {
          encode_type: 99,
          media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/voice" },
        },
      },
    ],
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "voice");
  assert.equal(result[0].name, "voice.wav");
  assert.equal(result[0].mime, "audio/wav");
  assert.equal(result[0].data.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(result[0].data.subarray(8, 12).toString("ascii"), "WAVE");
});

test("Weixin voice with a platform transcript does not duplicate the audio attachment", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("voice with transcript must not be downloaded");
  };

  const result = await downloadWeixinAttachments({
    item_list: [
      {
        type: 3,
        voice_item: {
          text: "写什么",
          media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/voice" },
        },
      },
    ],
  });

  assert.deepEqual(result, []);
  assert.equal(fetched, false);
});

test("Weixin image upload encrypts CDN bytes and sends a provider media item", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const directory = mkdtempSync(path.join(tmpdir(), "pi-weixin-upload-"));
  const filePath = path.join(directory, "result.png");
  const plain = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  await writeFile(filePath, plain);
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("getuploadurl")) {
      return new globalThis.Response(JSON.stringify({ upload_param: "upload-signed" }), { status: 200 });
    }
    if (String(url).includes("/upload?")) {
      return new globalThis.Response("", { status: 200, headers: { "x-encrypted-param": "download-signed" } });
    }
    return new globalThis.Response(JSON.stringify({ ret: 0 }), { status: 200 });
  };
  await sendWeixinAttachment({
    baseUrl: "https://ilinkai.weixin.qq.com",
    token: "secret",
    to: "user-one",
    attachment: { kind: "image", path: filePath, name: "result.png", mime: "image/png" },
    contextToken: "context-one",
    runId: "run-one",
    clientId: "client-one",
  });
  assert.match(requests[0].url, /getuploadurl$/);
  assert.match(requests[1].url, /novac2c\.cdn\.weixin\.qq\.com\/c2c\/upload\?/);
  assert.notDeepEqual(Buffer.from(requests[1].init.body), plain);
  const sent = JSON.parse(requests[2].init.body);
  assert.equal(sent.msg.context_token, "context-one");
  assert.equal(sent.msg.item_list[0].type, 2);
  assert.equal(sent.msg.item_list[0].image_item.media.encrypt_query_param, "download-signed");
});
