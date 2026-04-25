// src/sessionStore.ts
// Keeps track of the live support sessions and their associated Discord channels.

import type { Message } from 'discord.js';

export interface SessionEntry {
  channelId: string;
  username: string;
  /** Timestamp of the last message we've already posted in Discord */
  lastMsgTs: number;
  /**
   * The Discord message that shows "User is typing…".
   * When the real message arrives we edit this instead of posting a new one.
   */
  typingMessage: Message | null;
  /** Auto-delete timeout for the typing indicator */
  typingTimeout: ReturnType<typeof setTimeout> | null;
}

export class SessionStore {
  private byChatId   = new Map<string, SessionEntry>();
  private byChannelId = new Map<string, string>(); // channelId → chatId

  add(chatId: string, channelId: string, username: string): void {
    this.byChatId.set(chatId, {
      channelId,
      username,
      lastMsgTs: 0,
      typingMessage: null,
      typingTimeout: null,
    });
    this.byChannelId.set(channelId, chatId);
  }

  get(chatId: string): SessionEntry | undefined {
    return this.byChatId.get(chatId);
  }

  getByChannelId(channelId: string): { chatId: string; entry: SessionEntry } | undefined {
    const chatId = this.byChannelId.get(channelId);
    if (!chatId) return undefined;
    const entry = this.byChatId.get(chatId);
    if (!entry) return undefined;
    return { chatId, entry };
  }

  has(chatId: string): boolean {
    return this.byChatId.has(chatId);
  }

  setLastMsgTs(chatId: string, ts: number): void {
    const e = this.byChatId.get(chatId);
    if (e) e.lastMsgTs = ts;
  }

  setTypingMessage(chatId: string, msg: Message | null): void {
    const e = this.byChatId.get(chatId);
    if (e) e.typingMessage = msg;
  }

  /** Replace (and clear) the typing timeout for a session */
  resetTypingTimeout(
    chatId: string,
    newTimeout: ReturnType<typeof setTimeout> | null,
  ): void {
    const e = this.byChatId.get(chatId);
    if (!e) return;
    if (e.typingTimeout) clearTimeout(e.typingTimeout);
    e.typingTimeout = newTimeout;
  }

  remove(chatId: string): void {
    const e = this.byChatId.get(chatId);
    if (!e) return;
    if (e.typingTimeout) clearTimeout(e.typingTimeout);
    this.byChannelId.delete(e.channelId);
    this.byChatId.delete(chatId);
  }

  all(): Map<string, SessionEntry> {
    return this.byChatId;
  }
}
