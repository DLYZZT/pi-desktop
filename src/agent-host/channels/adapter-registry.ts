import type { ChannelId } from "../../shared/channel-types";
import type { ChannelAdapter } from "./types";
import { WeixinAdapter } from "./adapters/weixin/adapter";
import { TelegramAdapter } from "./adapters/telegram/adapter";

export class AdapterRegistry {
  private readonly adapters = new Map<ChannelId, ChannelAdapter>();

  constructor() {
    this.register(new WeixinAdapter());
    this.register(new TelegramAdapter());
  }

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ChannelId): ChannelAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Channel adapter is unavailable: ${id}`);
    return adapter;
  }
}
