# Xtero Support Bot

A Discord bot that bridges your Xtero live support system to a Discord server.
When a user starts a live support chat on your site, the bot automatically creates
a Discord channel for it. Everything you type in that channel gets delivered to the
user in real-time, and everything they type shows up in Discord.

---

## How it works

```
User opens live support  →  Pusher fires "new-session"
                         →  Bot creates #support-username-abc123 channel
                         →  Bot posts an intro message

User types               →  Pusher fires "user-typing"
                         →  Bot sends "✏️ username is typing…" placeholder

User sends message       →  Pusher fires "new-message"
                         →  Bot EDITS the placeholder to show the real message
                            (or posts a new message if there was no placeholder)

You type in Discord      →  Bot POSTs /chat/session/:id/reply → delivered to user
                            User sees your name + message in their chat widget

You type `!close`        →  Bot calls DELETE /chat/session/:id/close
                            User sees the session ended
```

---

## Setup

### 1. Create a Discord bot

1. Go to https://discord.com/developers/applications → **New Application**
2. Open **Bot** → **Add Bot**
3. Under **Privileged Gateway Intents** enable:
   - **Server Members Intent**
   - **Message Content Intent**
4. Copy the **Token** — this is your `DISCORD_TOKEN`
5. Under **OAuth2 → URL Generator** select scopes `bot` + permissions:
   - Manage Channels, Read Messages/View Channels, Send Messages,
     Read Message History, Manage Messages
6. Open the generated URL in a browser and invite the bot to your server

### 2. Prepare your Discord server

1. Enable **Developer Mode** (User Settings → Advanced)
2. Create a **Category** for support channels (e.g. "📋 Live Support")
3. Right-click the server → **Copy Server ID** → `DISCORD_GUILD_ID`
4. Right-click the category → **Copy Category ID** → `DISCORD_CATEGORY_ID`

### 3. Get your Xtero admin token

1. Open the Xtero admin panel in your browser
2. Open DevTools → **Application** → **Local Storage** → look for `adminToken`
   **or** open **Network** tab, look for a request to `xtero.zaggloob.workers.dev`
   and copy the `Authorization: Bearer <token>` value
3. This is your `ADMIN_TOKEN`

### 4. Configure environment variables

Copy `.env.example` to `.env` and fill in the values:

```
DISCORD_TOKEN=...
DISCORD_GUILD_ID=...
DISCORD_CATEGORY_ID=...
ADMIN_TOKEN=...
AGENT_NAME=YourName        # optional, shown to users when you reply
```

### 5. Deploy to Railway

1. Push this project to a GitHub repo
2. Go to https://railway.app → **New Project** → **Deploy from GitHub**
3. Select the repo
4. In **Variables** add all four required env vars (Railway reads them automatically)
5. Railway will build (`npm run build`) and start (`npm start`) automatically

That's it — the bot connects to Pusher and starts watching for new sessions instantly.

---

## Commands (in a support channel)

| Command  | What it does                           |
|----------|----------------------------------------|
| `!close` | Closes the live support session        |
| anything else | Delivered to the user as a message |

---

## Local development

```bash
npm install
cp .env.example .env   # fill in the values
npm run dev            # runs with ts-node, no build needed
```
