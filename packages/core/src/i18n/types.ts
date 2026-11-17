import type zhCN from './zh-CN.ts';

export type MessageKey = keyof typeof zhCN;
export type Messages = Record<MessageKey, string>;
export type MessageParams = Record<string, string | number>;
