// src/api.ts
// Thin wrapper around the Xtero Cloudflare Worker API.

const WORKER = 'https://xtero.zaggloob.workers.dev';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ChatSession {
  chatId?: string;
  sessionId?: string;
  id?: string;
  username: string;
  status: 'queued' | 'open' | 'closed';
  adminRead: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  ts: number;
  role: 'user' | 'agent';
  body: string;
  sender?: string;
  agentName?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Normalise the session ID across the different shapes the API can return */
export function resolveId(s: ChatSession): string | null {
  return s.chatId || s.sessionId || s.id || null;
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

/** GET /chat/sessions?status=open|queued|closed|all */
export async function getSessions(
  status: 'open' | 'queued' | 'closed' | 'all',
  token: string,
): Promise<ChatSession[]> {
  try {
    const res = await fetch(`${WORKER}/chat/sessions?status=${status}&limit=40`, {
      headers: authHeader(token),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { sessions?: ChatSession[] };
    return data.sessions || [];
  } catch {
    return [];
  }
}

/** GET /chat/queue  — pending / unclaimed sessions */
export async function getQueue(token: string): Promise<ChatSession[]> {
  try {
    const res = await fetch(`${WORKER}/chat/queue`, { headers: authHeader(token) });
    if (!res.ok) return [];
    const data = (await res.json()) as { queue?: ChatSession[] };
    return data.queue || [];
  } catch {
    return [];
  }
}

/** GET /chat/session/:id/messages?since=:ts */
export async function getMessages(
  chatId: string,
  since: number,
  token: string,
): Promise<ChatMessage[]> {
  try {
    const res = await fetch(`${WORKER}/chat/session/${chatId}/messages?since=${since}`, {
      headers: authHeader(token),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { messages?: ChatMessage[] };
    return data.messages || [];
  } catch {
    return [];
  }
}

/** POST /chat/session/:id/reply  — send agent reply to the user */
export async function sendReply(
  chatId: string,
  body: string,
  agentName: string,
  token: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${WORKER}/chat/session/${chatId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ body, agentName }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** POST /chat/session/:id/typing  — send "agent is typing" to the user */
export async function sendTyping(chatId: string, token: string): Promise<void> {
  try {
    await fetch(`${WORKER}/chat/session/${chatId}/typing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
    });
  } catch { /* swallow */ }
}

/** POST /chat/session/:id/read  — mark session as read by admin */
export async function markRead(chatId: string, token: string): Promise<void> {
  try {
    await fetch(`${WORKER}/chat/session/${chatId}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
    });
  } catch { /* swallow */ }
}

/** DELETE /chat/session/:id/close  — close the session */
export async function closeSession(chatId: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${WORKER}/chat/session/${chatId}/close`, {
      method: 'DELETE',
      headers: authHeader(token),
    });
    return res.ok;
  } catch {
    return false;
  }
}
