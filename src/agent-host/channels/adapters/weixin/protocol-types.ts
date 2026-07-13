export const WeixinMessageType = { USER: 1, BOT: 2 } as const;
export const WeixinMessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const WeixinItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const WeixinTypingStatus = { TYPING: 1, CANCEL: 2 } as const;

export interface WeixinMessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  file_item?: { file_name?: string };
  ref_msg?: { title?: string; message_item?: WeixinMessageItem };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

export interface WeixinUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export type WeixinQrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface WeixinQrStartResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface WeixinQrStatusResponse {
  status: WeixinQrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}
