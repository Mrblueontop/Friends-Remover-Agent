// src/index.ts
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  TextChannel,
  Partials,
} from 'discord.js';
// pusher-js works in Node.js 18+ via the built-in WebSocket / ws package
import Pusher from 'pusher-js';
import * as api from './api';
import { SessionStore } from './sessionStore';

// ── Config ─────────────────────────────────────────────────────────────────────

const DISCORD_TOKEN  = process.env.DISCORD_TOKEN  ?? die('DISCORD_TOKEN is not set');
const GUILD_ID       = process.env.DISCORD_GUILD_ID  ?? die('DISCORD_GUILD_ID is not set');
const CATEGORY_ID    = process.env.DISCORD_CATEGORY_ID ?? die('DISCORD_CATEGORY_ID is not set');
const ADMIN_TOKEN    = process.env.ADMIN_TOKEN    ?? die('ADMIN_TOKEN is not set');
const AGENT_NAME     = process.env.AGENT_NAME     || 'Support Agent';
const PUSHER_KEY     = process.env.PUSHER_KEY     || 'fe0cc3e34b1803ffc304';
const PUSHER_CLUSTER = process.env.PUSHER_CLUSTER || 'us2';

function die(msg: string): never {
  console.error(`❌  ${msg}`);
  process.exit(1);
}

// ── Shared state ───────────────────────────────────────────────────────────────

const store = new SessionStore();

// ── Discord client ─────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping,
  ],
  partials: [Partials.Channel],
});

// ── Channel helpers ────────────────────────────────────────────────────────────

/** Turn a username into a valid Discord channel name */
function channelName(username: string, chatId: string): string {
  const safe = username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 60);
  return `support-${safe}-${chatId.slice(0, 6)}`;
}

/**
 * Find or create the Discord channel for a session.
 * The channel's topic always contains `Session: <chatId>` so we can
 * re-discover it after a bot restart.
 */
async function getOrCreateChannel(
  chatId: string,
  username: string,
  pusher: Pusher,
): Promise<TextChannel | null> {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) { console.error('Guild not found:', GUILD_ID); return null; }

  // Look for an existing channel with this chatId in the topic
  const existing = guild.channels.cache.find(
    (ch): ch is TextChannel =>
      ch.type === ChannelType.GuildText &&
      (ch as TextChannel).parentId === CATEGORY_ID &&
      !!((ch as TextChannel).topic?.includes(`Session: ${chatId}`)),
  );

  if (existing) {
    if (!store.has(chatId)) {
      store.add(chatId, existing.id, username);
      subscribeToSession(pusher, chatId);
    }
    return existing;
  }

  // Create a fresh channel
  try {
    const ch = await guild.channels.create({
      name: channelName(username, chatId),
      type: ChannelType.GuildText,
      parent: CATEGORY_ID,
      topic: `Live support | User: ${username} | Session: ${chatId}`,
    });
    store.add(chatId, ch.id, username);
    subscribeToSession(pusher, chatId);
    console.log(`📢  Created channel #${ch.name} for session ${chatId}`);
    return ch as TextChannel;
  } catch (e) {
    console.error('Failed to create Discord channel:', e);
    return null;
  }
}

// ── Message helpers ────────────────────────────────────────────────────────────

/**
 * Post a user message in the support channel.
 * If there's a pending "typing…" placeholder, edit it instead of sending a new message.
 */
async function postUserMessage(chatId: string, msg: api.ChatMessage): Promise<void> {
  const entry = store.get(chatId);
  if (!entry) return;

  const ch = client.channels.cache.get(entry.channelId) as TextChannel | undefined;
  if (!ch) return;

  const sender  = msg.sender || entry.username || 'User';
  const content = `**${escapeMarkdown(sender)}:** ${msg.body}`;

  if (entry.typingMessage) {
    const placeholder = entry.typingMessage;
    // Clear the placeholder state BEFORE awaiting anything to avoid double-edits
    store.setTypingMessage(chatId, null);
    store.resetTypingTimeout(chatId, null);
    try {
      await placeholder.edit(content);
      return;
    } catch {
      // Placeholder may have been deleted; fall through and send a new message
    }
  }

  await ch.send(content).catch(console.error);
}

/** Escape Discord markdown characters in user-supplied names */
function escapeMarkdown(text: string): string {
  return text.replace(/[*_`~\\]/g, '\\$&');
}

/**
 * Pull all messages we haven't seen yet and post them to Discord.
 */
async function syncNewMessages(chatId: string): Promise<void> {
  const entry = store.get(chatId);
  if (!entry) return;

  const messages = await api.getMessages(chatId, entry.lastMsgTs, ADMIN_TOKEN);
  for (const msg of messages) {
    // Only forward user messages — agent messages are what WE sent
    if (msg.role === 'user') {
      await postUserMessage(chatId, msg);
    }
    if (msg.ts > entry.lastMsgTs) {
      store.setLastMsgTs(chatId, msg.ts);
    }
  }
}

// ── Per-session Pusher subscription ───────────────────────────────────────────

function subscribeToSession(pusher: Pusher, chatId: string): void {
  const ch = pusher.subscribe(`xtero-session-${chatId}`);

  ch.bind('new-message', () => {
    syncNewMessages(chatId).catch(console.error);
  });

  ch.bind('session-closed', async () => {
    const entry = store.get(chatId);
    if (!entry) return;
    const channel = client.channels.cache.get(entry.channelId) as TextChannel | undefined;
    if (channel) {
      await channel
        .send(
          '🔴 **Session closed.** The user has left this support session.\n' +
          'You can type `!close` to archive this channel or just leave it as a record.',
        )
        .catch(console.error);
    }
  });
}

// ── Global Pusher subscription ─────────────────────────────────────────────────

function initPusher(): Pusher {
  // Suppress Pusher's verbose logging
  Pusher.logToConsole = false;

  const pusher = new Pusher(PUSHER_KEY, { cluster: PUSHER_CLUSTER });

  const adminChannel = pusher.subscribe('xtero-admin');

  // A new live support session was created or the queue changed
  adminChannel.bind('new-session',     () => refreshSessions(pusher));
  adminChannel.bind('session-updated', () => refreshSessions(pusher));
  adminChannel.bind('queue-updated',   () => refreshSessions(pusher));

  // User started typing — show a placeholder in the Discord channel
  adminChannel.bind('user-typing', async (data: { sessionId?: string }) => {
    const chatId = data?.sessionId;
    if (!chatId) return;

    const entry = store.get(chatId);
    if (!entry) return;

    const channel = client.channels.cache.get(entry.channelId) as TextChannel | undefined;
    if (!channel) return;

    // Reset the auto-delete timeout every time a typing event arrives
    store.resetTypingTimeout(
      chatId,
      setTimeout(async () => {
        // User stopped typing without sending — remove the placeholder
        const e = store.get(chatId);
        if (e?.typingMessage) {
          try { await e.typingMessage.delete(); } catch { /* already gone */ }
          store.setTypingMessage(chatId, null);
        }
      }, 5_000),
    );

    // If a placeholder is already showing, don't send another
    if (entry.typingMessage) return;

    try {
      const placeholder = await channel.send(
        `✏️ **${escapeMarkdown(entry.username)}** is typing…`,
      );
      store.setTypingMessage(chatId, placeholder);
    } catch (e) {
      console.error('Failed to send typing placeholder:', e);
    }
  });

  pusher.connection.bind('error',      (err: unknown) => console.error('Pusher error:', err));
  pusher.connection.bind('disconnected', () => console.warn('⚠️  Pusher disconnected'));
  pusher.connection.bind('connected',    () => console.log('✅  Pusher connected'));

  return pusher;
}

/**
 * Fetch the current queue + open sessions.
 * For any session we haven't seen yet, create a Discord channel and announce it.
 */
async function refreshSessions(pusher: Pusher): Promise<void> {
  const [queued, open] = await Promise.all([
    api.getQueue(ADMIN_TOKEN),
    api.getSessions('open', ADMIN_TOKEN),
  ]);

  const all = [...queued, ...open];

  for (const session of all) {
    const chatId = api.resolveId(session);
    if (!chatId) continue;
    if (store.has(chatId)) continue; // already tracking

    const channel = await getOrCreateChannel(chatId, session.username || 'Unknown', pusher);
    if (!channel) continue;

    const statusEmoji = session.status === 'queued' ? '🟡' : '🟢';

    // Announce the session and explain how to use the channel
    await channel
      .send(
        `${statusEmoji} **New live support session** from **${escapeMarkdown(session.username || 'Unknown')}**\n` +
        `Status: \`${session.status}\`  |  Session ID: \`${chatId}\`\n\n` +
        `**How to use this channel:**\n` +
        `• Type a message here → it gets sent directly to the user\n` +
        `• When the user types, you'll see a "typing…" placeholder that auto-edits to their message\n` +
        `• Type \`!close\` to close the session\n`,
      )
      .catch(console.error);

    // Load any messages that arrived before the bot was watching
    await syncNewMessages(chatId);
    await api.markRead(chatId, ADMIN_TOKEN);
  }
}

/**
 * On startup, scan the support category for channels that were created in a
 * previous run so we don't duplicate them after a bot restart.
 */
async function recoverExistingChannels(pusher: Pusher): Promise<void> {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  for (const [, ch] of guild.channels.cache) {
    if (ch.type !== ChannelType.GuildText) continue;
    const textCh = ch as TextChannel;
    if (textCh.parentId !== CATEGORY_ID) continue;

    const topic = textCh.topic ?? '';
    const match = topic.match(/Session: ([a-zA-Z0-9_-]+)/);
    if (!match) continue;

    const chatId = match[1];
    if (store.has(chatId)) continue;

    const usernameMatch = topic.match(/User: ([^|]+)/);
    const username = usernameMatch ? usernameMatch[1].trim() : 'Unknown';

    store.add(chatId, ch.id, username);
    subscribeToSession(pusher, chatId);
    console.log(`♻️   Recovered session ${chatId} → #${textCh.name}`);
  }
}

// ── Discord events ─────────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  // Ignore bot messages (including our own)
  if (message.author.bot) return;
  if (!message.guild) return;

  const session = store.getByChannelId(message.channelId);
  if (!session) return; // Not a support channel

  const { chatId, entry } = session;

  // ── Special commands ──────────────────────────────────────────
  if (message.content.trim() === '!close') {
    const ok = await api.closeSession(chatId, ADMIN_TOKEN);
    if (ok) {
      await message.reply('✅ Session closed. User has been notified.').catch(console.error);
      store.remove(chatId);
    } else {
      await message.reply('❌ Failed to close session via API.').catch(console.error);
    }
    return;
  }

  // ── Forward message to user ───────────────────────────────────
  const ok = await api.sendReply(chatId, message.content, AGENT_NAME, ADMIN_TOKEN);
  if (!ok) {
    await message
      .reply('❌ Failed to deliver your message. The session may have already been closed.')
      .catch(console.error);
  }
});

client.on('typingStart', async (typing) => {
  // Ignore bots (typing.user may be a partial; bot property is always present)
  if (typing.user.bot) return;

  const session = store.getByChannelId(typing.channel.id);
  if (!session) return;

  // Tell the Xtero API that the agent is typing so the user sees the indicator
  await api.sendTyping(session.chatId, ADMIN_TOKEN);
});

// ── Ready ──────────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`✅  Logged in as ${client.user?.tag}`);

  const pusher = initPusher();

  // Re-register channels from a previous run first
  await recoverExistingChannels(pusher);

  // Then pull any currently open/queued sessions
  await refreshSessions(pusher);

  console.log('🚀  Bot is ready and listening for support sessions!');
});

// ── Start ──────────────────────────────────────────────────────────────────────

client.login(DISCORD_TOKEN).catch((e) => {
  console.error('❌  Could not log in to Discord:', e);
  process.exit(1);
});
