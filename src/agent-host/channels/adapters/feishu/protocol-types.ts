export interface FeishuMessageMention {
  key: string;
  id: {
    union_id?: string;
    user_id?: string;
    open_id?: string;
  };
  mentioned_type?: string;
  name: string;
  tenant_key?: string;
}

export interface FeishuMessageEvent {
  event_id?: string;
  app_id?: string;
  create_time?: string;
  tenant_key?: string;
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: FeishuMessageMention[];
  };
}

export interface FeishuMenuEvent {
  event_id?: string;
  create_time?: string;
  event_type?: string;
  tenant_key?: string;
  operator?: {
    operator_name?: string;
    operator_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
  };
  event_key?: string;
  timestamp?: number;
}

export interface FeishuBotIdentity {
  openId: string;
  name: string;
}
