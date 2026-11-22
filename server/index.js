
import { DurableObject } from "cloudflare:workers";

// Worker اصلی
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // مسیر اتصال به اتاق
    const match = url.pathname.match(/^\/room\/([a-zA-Z0-9_-]{3,32})$/);

    if (!match) {
      return new Response(
        "Minecraft 2D Multiplayer Server is running!",
        { status: 200 }
      );
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket connection required", {
        status: 426
      });
    }

    const roomCode = match[1];

    // هر کد اتاق، یک فضای مستقل دارد
    const id = env.ROOMS.idFromName(roomCode);
    const room = env.ROOMS.get(id);

    return room.fetch(request);
  }
};


// سرور هر اتاق بازی
export class Room extends DurableObject {

  async fetch(request) {
    const url = new URL(request.url);

    const name = (url.searchParams.get("name") || "Player")
      .trim()
      .slice(0, 16);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const player = {
      id: crypto.randomUUID(),
      name,
      x: 100,
      y: 100,
      facing: 1
    };

    // اتصال قابل خوابیدن برای کاهش هزینهٔ زمان بیکاری
    this.ctx.acceptWebSocket(server);

    // ذخیره اطلاعات بازیکن روی اتصال
    server.serializeAttachment(player);

    // فرستادن اطلاعات بازیکنان حاضر به بازیکن جدید
    const players = this.ctx.getWebSockets()
      .filter(ws => ws !== server)
      .map(ws => ws.deserializeAttachment())
      .filter(Boolean);

    server.send(JSON.stringify({
      type: "welcome",
      player,
      players
    }));

    // اطلاع‌رسانی ورود بازیکن
    this.broadcast({
      type: "player_joined",
      player
    }, server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }


  // دریافت پیام از بازیکن
  webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 2048) {
      return;
    }

    let data;

    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const player = ws.deserializeAttachment();

    if (!player || data.type !== "move") {
      return;
    }

    // بررسی موقعیت بازیکن
    if (
      !Number.isFinite(data.x) ||
      !Number.isFinite(data.y) ||
      Math.abs(data.x) > 100000 ||
      Math.abs(data.y) > 100000
    ) {
      return;
    }

    player.x = data.x;
    player.y = data.y;

    if (data.facing === 1 || data.facing === -1) {
      player.facing = data.facing;
    }

    ws.serializeAttachment(player);

    // ارسال موقعیت جدید به بقیه بازیکنان
    this.broadcast({
      type: "player_moved",
      player
    }, ws);
  }


  // ارسال پیام به تمام بازیکنان اتاق
  broadcast(data, except = null) {
    const message = JSON.stringify(data);

    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;

      try {
        ws.send(message);
      } catch {
        // اتصال قطع‌شده را نادیده می‌گیریم
      }
    }
  }


  // خروج بازیکن
  webSocketClose(ws, code, reason) {
    const player = ws.deserializeAttachment();

    if (player) {
      this.broadcast({
        type: "player_left",
        playerId: player.id
      }, ws);
    }

    if (
      code >= 1000 &&
      code < 5000 &&
      ![1004, 1005, 1006, 1015].includes(code)
    ) {
      ws.close(code, reason);
    } else {
      ws.close();
    }
  }
}
