import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3001;

/* Optional: allow a basic healthcheck on / */
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Focus Race Relay OK\n");
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server });

// roomCode -> Set<ws>
const rooms = new Map();
// connection state
const meta = new WeakMap();

// simple broadcast helper
function broadcastToRoom(room, data, except) {
  const set = rooms.get(room);
  if (!set) return;
  const msg = typeof data === "string" ? data : JSON.stringify(data);
  for (const ws of set) {
    if (ws !== except && ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  }
}

// cleanup helper
function leaveRoom(ws) {
  const m = meta.get(ws);
  if (!m || !m.room) return;
  const set = rooms.get(m.room);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(m.room);
  }
  m.room = null;
}

wss.on("connection", (ws, req) => {
  // attach metadata + heartbeat
  meta.set(ws, { room: null, isAlive: true, lastMsgAt: Date.now() });

  ws.on("pong", () => {
    const m = meta.get(ws);
    if (m) m.isAlive = true;
  });

  ws.on("message", (buf) => {
    // basic rate limit (50 msgs / 10s window)
    const m = meta.get(ws);
    const now = Date.now();
    if (!m.windowStart || now - m.windowStart > 10_000) {
      m.windowStart = now; m.count = 0;
    }
    if (++m.count > 50) return; // drop message silently

    let data;
    try { data = JSON.parse(buf.toString()); } catch { return; }

    // join a room
    if (data.type === "join_room" && typeof data.room === "string") {
      leaveRoom(ws);
      const code = data.room.trim().toUpperCase();
      if (!rooms.has(code)) rooms.set(code, new Set());
      rooms.get(code).add(ws);
      meta.set(ws, { ...m, room: code, isAlive: true });
      // optional ack
      ws.send(JSON.stringify({ type: "joined", room: code }));
      return;
    }

    // forward only if in a room
    if (!m.room) return;

    // attach room for recipients (clients already expect this)
    if (!data.room) data.room = m.room;
    broadcastToRoom(m.room, data, ws);
  });

  ws.on("close", () => {
    leaveRoom(ws);
  });

  ws.on("error", () => {
    leaveRoom(ws);
    try { ws.close(); } catch {}
  });
});

// heartbeat to terminate dead sockets
const interval = setInterval(() => {
  for (const ws of wss.clients) {
    const m = meta.get(ws);
    if (!m) continue;
    if (!m.isAlive) {
      leaveRoom(ws);
      try { ws.terminate(); } catch {}
      continue;
    }
    m.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30_000);

wss.on("close", () => clearInterval(interval));

server.listen(PORT, () => {
  console.log(`WS relay on :${PORT}`);
});
