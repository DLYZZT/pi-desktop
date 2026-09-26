import type { ApiHandler } from "../../contract/rpc";
import type { ChannelManager } from "../channels/channel-manager";
import { safeChannelError } from "../channels/redaction";

export function initializeChannels(
  manager: Pick<ChannelManager, "initialize">,
  report: (message: string) => void = (message) => {
    try {
      process.parentPort?.postMessage({ type: "log", message: `[channels] initialization failed: ${message}` });
    } catch {
      /* ignore logging failure */
    }
  },
): void {
  void manager.initialize().catch((error) => report(safeChannelError(error)));
}

type ChannelHandlers = {
  list: NonNullable<ApiHandler["channels.list"]>;
  accountUpsert: NonNullable<ApiHandler["channels.accountUpsert"]>;
  accountConnect: NonNullable<ApiHandler["channels.accountConnect"]>;
  accountDelete: NonNullable<ApiHandler["channels.accountDelete"]>;
  start: NonNullable<ApiHandler["channels.start"]>;
  stop: NonNullable<ApiHandler["channels.stop"]>;
  restart: NonNullable<ApiHandler["channels.restart"]>;
  probe: NonNullable<ApiHandler["channels.probe"]>;
  loginStart: NonNullable<ApiHandler["channels.loginStart"]>;
  loginWait: NonNullable<ApiHandler["channels.loginWait"]>;
  loginSubmitCode: NonNullable<ApiHandler["channels.loginSubmitCode"]>;
  loginCancel: NonNullable<ApiHandler["channels.loginCancel"]>;
  pairingApprove: NonNullable<ApiHandler["channels.pairingApprove"]>;
  pairingReject: NonNullable<ApiHandler["channels.pairingReject"]>;
  bindingUpsert: NonNullable<ApiHandler["channels.bindingUpsert"]>;
  bindingDelete: NonNullable<ApiHandler["channels.bindingDelete"]>;
  testSend: NonNullable<ApiHandler["channels.testSend"]>;
};
export function createChannelHandlers(
  channelManager: Pick<
    ChannelManager,
    | "snapshot"
    | "upsertAccount"
    | "connectAccount"
    | "deleteAccount"
    | "startAccount"
    | "stopAccount"
    | "restartAccount"
    | "probe"
    | "startLogin"
    | "waitLogin"
    | "submitLoginCode"
    | "cancelLogin"
    | "approvePairing"
    | "rejectPairing"
    | "upsertBinding"
    | "deleteBinding"
    | "testSend"
  >,
) {
  return {
    list: async () => channelManager.snapshot(),

    accountUpsert: async (params) => channelManager.upsertAccount(params.account),

    accountConnect: async (params) => channelManager.connectAccount(params.account),

    accountDelete: async (params) => channelManager.deleteAccount(params.accountId),

    start: async (params) => {
      await channelManager.startAccount(params.accountId);
      return { ok: true as const };
    },

    stop: async (params) => {
      await channelManager.stopAccount(params.accountId);
      return { ok: true as const };
    },

    restart: async (params) => {
      await channelManager.restartAccount(params.accountId);
      return { ok: true as const };
    },

    probe: async (params) => channelManager.probe(params.accountId),

    loginStart: async (params) => channelManager.startLogin(params),

    loginWait: async (params) => channelManager.waitLogin(params.channel, params.sessionKey),

    loginSubmitCode: async (params) => {
      channelManager.submitLoginCode(params.channel, params.sessionKey, params.code);
      return { ok: true as const };
    },

    loginCancel: async (params) => {
      channelManager.cancelLogin(params.channel, params.sessionKey);
      return { ok: true as const };
    },

    pairingApprove: async (params) => channelManager.approvePairing(params.pairingId),

    pairingReject: async (params) => channelManager.rejectPairing(params.pairingId),

    bindingUpsert: async (params) => channelManager.upsertBinding(params.binding),

    bindingDelete: async (params) => channelManager.deleteBinding(params.bindingId),

    testSend: async (params) => channelManager.testSend(params.accountId, params.peerId, params.message),
  } satisfies ChannelHandlers;
}
