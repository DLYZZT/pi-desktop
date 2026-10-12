import type { ChannelId } from "../../shared/channel-types";
import type { ChannelAdapter } from "./types";

const adapterLoaders = {
  weixin: async () => new (await import("./adapters/weixin/adapter")).WeixinAdapter(),
  telegram: async () => new (await import("./adapters/telegram/adapter")).TelegramAdapter(),
  feishu: async () => new (await import("./adapters/feishu/adapter")).FeishuAdapter(),
} satisfies Record<ChannelId, () => Promise<ChannelAdapter>>;

export class AdapterRegistry {
  private readonly adapters = new Map<ChannelId, ChannelAdapter>();

  private readonly pending = new Map<ChannelId, Promise<ChannelAdapter>>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  async get(id: ChannelId): Promise<ChannelAdapter> {
    const adapter = this.adapters.get(id);
    if (adapter) return adapter;
    const pending = this.pending.get(id);
    if (pending) return pending;
    const load = Object.hasOwn(adapterLoaders, id) ? adapterLoaders[id] : undefined;
    if (!load) throw new Error(`Channel adapter is unavailable: ${id}`);
    const task = load().then((loaded) => {
      // A caller may register an override while the default adapter is loading.
      const resolved = this.adapters.get(id) ?? loaded;
      this.register(resolved);
      return resolved;
    });
    this.pending.set(id, task);
    try {
      return await task;
    } finally {
      this.pending.delete(id);
    }
  }
}
