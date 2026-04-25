require('dotenv/config');
const { Client, GatewayIntentBits, ChannelType, Partials } = require('discord.js');
const Pusher = require('pusher-js');

// ── Config ─────────────────────────────────────────────────────────────────────

const DISCORD_TOKEN  = process.env.DISCORD_TOKEN   || die('DISCORD_TOKEN is not set');
const GUILD_ID       = process.env.DISCORD_GUILD_ID  || die('DISCORD_GUILD_ID is not set');
const CATEGORY_ID    = process.env.DISCORD_CATEGORY_ID || die('DISCORD_CATEGORY_ID is not set');
const ADMIN_TOKEN    = process.env.ADMIN_TOKEN     || die('ADMIN_TOKEN is not set');
const AGENT_NAME     = process.env.AGENT_NAME      || 'Support Agent';
const PUSHER_KEY     = process.env.PUSHER_KEY      || 'fe0cc3e34b1803ffc304';
const PUSHER_CLUSTER = process.env.PUSHER_CLUSTER  || 'us2';
const WORKER         = 'https://xtero.zaggloob.workers.dev';

function die(msg) {
  console.error('❌  ' + msg);
  process.exit(1);
}

// ── Session store ──────────────────────────────────────────────────────────────
// Maps chatId → { channelId, username, lastMsgTs, typingMessage, typingTimeout }
// Also maps channelId → chatId for reverse lookup

const byChatId    = new Map();
const byChannelId = new Map();

function storeAdd(chatId, channelId, username) {
  byChatId.set(chatId, { channelId, username, lastMsgTs: 0, typingMessage: null, typingTimeout: null });
  byChannelId.set(channelId, chatId);
}

function storeGet(chatId)       { return byChatId.get(chatId); }
function storeHas(chatId)       { return byChatId.has(chatId); }

function storeGetByChannel(channelId) {
  const chatId = byChannelId.get(channelId);
  if (!chatId) return null;
  const entry = byChatId.get(chatId);
  if (!entry) return null;
  return { chatId, entry };
}

function storeRemove(chatId) {
  const e = byChatId.get(chatId);
  if (!e) return;
  if (e.typingTimeout) clearTimeout(e.typingTimeout);
  byChannelId.delete(e.channelId);
  byChatId.delete(chatId);
}

function resetTypingTimeout(chatId, newTimeout) {
  const e = byChatId.get(chatId);
  if (!e) return;
  if (e.typingTimeout) clearTimeout(e.typingTimeout);
  e.typingTimeout = newTimeout;
}

// ── API helpers ────────────────────────────────────────────────────────────────

function authHeader() {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

async function getSessions(status) {
  try {
    const res = await fetch(`${WORKER}/chat/sessions?status=${status}&limit=40`, { headers: authHeader() });
    if (!res.ok) return [];
    const data = await res.json();
    return data.sessions || [];
  } catch { return []; }
}

async function getQueue() {
  try {
    const res = await fetch(`${WORKER}/chat/queue`, { headers: authHeader() });
    if (!res.ok) return [];
    const data = await res.json();
    return data.queue || [];
  } catch { return []; }
}

async function getMessages(chatId, since) {
  try {
    const res = await fetch(`${WORKER}/chat/session/${chatId}/messages?since=${since}`, { headers: authHeader() });
    if (!res.ok) return [];
    const data = await res.json();
    return data.messages || [];
  } catch { return []; }
}

async function sendReply(chatId, body) {
  try {
    const res = await fetch(`${WORKER}/chat/session/${chatId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ body, agentName: AGENT_NAME }),
    });
    return res.ok;
  } catch { return false; }
}

async function sendTyping(chatId) {
  try {
    await fetch(`${WORKER}/chat/session/${chatId}/typing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
    });
  } catch { /* swallow */ }
}

async function markRead(chatId) {
  try {
    await fetch(`${WORKER}/chat/session/${chatId}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
    });
  } catch { /* swallow */ }
}

async function closeSession(chatId) {
  try {
    const res = await fetch(`${WORKER}/chat/session/${chatId}/close`, {
      method: 'DELETE',
      headers: authHeader(),
    });
    return res.ok;
  } catch { return false; }
}

function resolveId(session) {
  return session.chatId || session.sessionId || session.id || null;
}

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

function safeChannelName(username, chatId) {
  const safe = username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 60);
  return `support-${safe}-${chatId.slice(0, 6)}`;
}

function esc(text) {
  return String(text).replace(/[*_`~\\]/g, '\\$&');
}

async function getOrCreateChannel(chatId, username, pusher) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) { console.error('Guild not found:', GUILD_ID); return null; }

  // Try to find an existing channel from a previous run (topic contains the chatId)
  const existing = guild.channels.cache.find(
    ch => ch.type === ChannelType.GuildText &&
          ch.parentId === CATEGORY_ID &&
          ch.topic?.includes(`Session: ${chatId}`)
  );

  if (existing) {
    if (!storeHas(chatId)) {
      storeAdd(chatId, existing.id, username);
      subscribeToSession(pusher, chatId);
    }
    return existing;
  }

  // Create a new channel
  try {
    const ch = await guild.channels.create({
      name: safeChannelName(username, chatId),
      type: ChannelType.GuildText,
      parent: CATEGORY_ID,
      topic: `Live support | User: ${username} | Session: ${chatId}`,
    });
    storeAdd(chatId, ch.id, username);
    subscribeToSession(pusher, chatId);
    console.log(`📢  Created #${ch.name} for session ${chatId}`);
    return ch;
  } catch (e) {
    console.error('Failed to create channel:', e);
    return null;
  }
}

// ── Message helpers ────────────────────────────────────────────────────────────

async function postUserMessage(chatId, msg) {
  const entry = storeGet(chatId);
  if (!entry) return;

  const ch = client.channels.cache.get(entry.channelId);
  if (!ch) return;

  const sender  = msg.sender || entry.username || 'User';
  const content = `**${esc(sender)}:** ${msg.body}`;

  // If there's a "typing…" placeholder, edit it to show the real message
  if (entry.typingMessage) {
    const placeholder = entry.typingMessage;
    entry.typingMessage = null;
    resetTypingTimeout(chatId, null);
    try {
      await placeholder.edit(content);
      return;
    } catch { /* placeholder gone, fall through */ }
  }

  await ch.send(content).catch(console.error);
}

async function syncNewMessages(chatId) {
  const entry = storeGet(chatId);
  if (!entry) return;

  const messages = await getMessages(chatId, entry.lastMsgTs);
  for (const msg of messages) {
    if (msg.role === 'user') {
      await postUserMessage(chatId, msg);
    }
    if (msg.ts > entry.lastMsgTs) entry.lastMsgTs = msg.ts;
  }
}

// ── Per-session Pusher subscription ───────────────────────────────────────────

function subscribeToSession(pusher, chatId) {
  const ch = pusher.subscribe(`xtero-session-${chatId}`);

  ch.bind('new-message', () => {
    syncNewMessages(chatId).catch(console.error);
  });

  ch.bind('session-closed', async () => {
    const entry = storeGet(chatId);
    if (!entry) return;
    const channel = client.channels.cache.get(entry.channelId);
    if (channel) {
      await channel.send('🔴 **Session closed.** The user has left this support session.\nType `!close` to tidy up this channel, or leave it as a record.').catch(console.error);
    }
  });
}

// ── Global Pusher + admin channel ─────────────────────────────────────────────

function initPusher() {
  Pusher.logToConsole = false;

  const pusher = new Pusher(PUSHER_KEY, { cluster: PUSHER_CLUSTER });

  const adminCh = pusher.subscribe('xtero-admin');

  adminCh.bind('new-session',     () => refreshSessions(pusher));
  adminCh.bind('session-updated', () => refreshSessions(pusher));
  adminCh.bind('queue-updated',   () => refreshSessions(pusher));

  // User started typing → show a placeholder in the Discord channel
  adminCh.bind('user-typing', async (data) => {
    const chatId = data?.sessionId;
    if (!chatId) return;

    const entry = storeGet(chatId);
    if (!entry) return;

    const channel = client.channels.cache.get(entry.channelId);
    if (!channel) return;

    // Reset the 5-second auto-delete timer each time a typing event arrives
    resetTypingTimeout(chatId, setTimeout(async () => {
      const e = storeGet(chatId);
      if (e?.typingMessage) {
        try { await e.typingMessage.delete(); } catch { /* already gone */ }
        e.typingMessage = null;
      }
    }, 5000));

    // Don't stack multiple placeholders
    if (entry.typingMessage) return;

    try {
      const msg = await channel.send(`✏️ **${esc(entry.username)}** is typing…`);
      entry.typingMessage = msg;
    } catch (e) {
      console.error('Failed to send typing placeholder:', e);
    }
  });

  pusher.connection.bind('connected',    () => console.log('✅  Pusher connected'));
  pusher.connection.bind('disconnected', () => console.warn('⚠️  Pusher disconnected'));
  pusher.connection.bind('error',        (e) => console.error('Pusher error:', e));

  return pusher;
}

// ── Refresh sessions ───────────────────────────────────────────────────────────

async function refreshSessions(pusher) {
  const [queued, open] = await Promise.all([getQueue(), getSessions('open')]);
  const all = [...queued, ...open];

  for (const session of all) {
    const chatId = resolveId(session);
    if (!chatId || storeHas(chatId)) continue;

    const channel = await getOrCreateChannel(chatId, session.username || 'Unknown', pusher);
    if (!channel) continue;

    const statusEmoji = session.status === 'queued' ? '🟡' : '🟢';
    await channel.send(
      `${statusEmoji} **New live support session** from **${esc(session.username || 'Unknown')}**\n` +
      `Status: \`${session.status}\`  |  Session ID: \`${chatId}\`\n\n` +
      `**How to use:**\n` +
      `• Type here → message is sent to the user\n` +
      `• User typing → you'll see a placeholder that edits to their message\n` +
      `• Type \`!close\` to close the session`
    ).catch(console.error);

    await syncNewMessages(chatId);
    await markRead(chatId);
  }
}

// ── Recover channels from a previous bot run ───────────────────────────────────

async function recoverExistingChannels(pusher) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  for (const [, ch] of guild.channels.cache) {
    if (ch.type !== ChannelType.GuildText || ch.parentId !== CATEGORY_ID) continue;
    const topic = ch.topic || '';
    const match = topic.match(/Session: ([a-zA-Z0-9_-]+)/);
    if (!match) continue;
    const chatId = match[1];
    if (storeHas(chatId)) continue;
    const usernameMatch = topic.match(/User: ([^|]+)/);
    const username = usernameMatch ? usernameMatch[1].trim() : 'Unknown';
    storeAdd(chatId, ch.id, username);
    subscribeToSession(pusher, chatId);
    console.log(`♻️   Recovered session ${chatId} → #${ch.name}`);
  }
}

// ── Discord events ─────────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const session = storeGetByChannel(message.channelId);
  if (!session) return;

  const { chatId } = session;

  if (message.content.trim() === '!close') {
    const ok = await closeSession(chatId);
    if (ok) {
      await message.reply('✅ Session closed.').catch(console.error);
      storeRemove(chatId);
    } else {
      await message.reply('❌ Failed to close session — it may already be closed.').catch(console.error);
    }
    return;
  }

  const ok = await sendReply(chatId, message.content);
  if (!ok) {
    await message.reply('❌ Failed to deliver — the session may have ended.').catch(console.error);
  }
});

client.on('typingStart', async (typing) => {
  if (typing.user.bot) return;
  const session = storeGetByChannel(typing.channel.id);
  if (!session) return;
  await sendTyping(session.chatId);
});

// ── Ready ──────────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`✅  Logged in as ${client.user?.tag}`);
  const pusher = initPusher();
  await recoverExistingChannels(pusher);
  await refreshSessions(pusher);
  console.log('🚀  Bot ready!');
});

client.login(DISCORD_TOKEN).catch((e) => {
  console.error('❌  Discord login failed:', e);
  process.exit(1);
});
