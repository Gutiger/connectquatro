import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

function makeRoomCode(rooms) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = randomBytes(6);
    let code = "";
    for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error("Unable to allocate a room code");
}

function encodeFrame(opcode, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let header;
  if (payload.length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function sendFrame(client, opcode, payload) {
  if (!client.socket.destroyed) client.socket.write(encodeFrame(opcode, payload));
}

function sendJson(client, value) {
  sendFrame(client, 0x1, JSON.stringify(value));
}

function closeClient(client, code = 1000, reason = "") {
  if (client.closed) return;
  client.closed = true;
  const reasonBytes = Buffer.from(reason).subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  sendFrame(client, 0x8, payload);
  client.socket.end();
}

function removeFromRoom(client, rooms) {
  if (!client.room) return;
  const room = rooms.get(client.room);
  client.room = null;
  if (!room) return;
  const peer = room.host === client ? room.guest : room.host;
  rooms.delete(room.code);
  if (peer && !peer.closed) {
    peer.room = null;
    peer.peer = null;
    sendJson(peer, { relay: "peer_left" });
  }
}

function handleRelayControl(client, message, rooms) {
  if (message.relay === "ping") {
    sendJson(client, { relay: "pong" });
    return;
  }
  if (message.relay === "create") {
    removeFromRoom(client, rooms);
    const code = makeRoomCode(rooms);
    rooms.set(code, { code, host: client, guest: null });
    client.room = code;
    client.peer = null;
    sendJson(client, { relay: "created", room: code, player: 1 });
    return;
  }
  if (message.relay === "join") {
    const code = String(message.room ?? "").toUpperCase();
    const room = rooms.get(code);
    if (!room || room.guest || room.host.closed) {
      sendJson(client, { relay: "error", message: "Room not found or already full." });
      return;
    }
    removeFromRoom(client, rooms);
    room.guest = client;
    client.room = code;
    client.peer = room.host;
    room.host.peer = client;
    sendJson(client, { relay: "joined", room: code, player: 2 });
    sendJson(room.host, { relay: "peer_joined", room: code, player: 1 });
    return;
  }
  sendJson(client, { relay: "error", message: "Unknown relay request." });
}

function handleText(client, text, rooms) {
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) {
    closeClient(client, 1009, "Message too large");
    return;
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    closeClient(client, 1007, "Invalid JSON");
    return;
  }
  if (message && typeof message === "object" && typeof message.relay === "string") {
    handleRelayControl(client, message, rooms);
    return;
  }
  if (!client.peer || client.peer.closed) {
    sendJson(client, { relay: "error", message: "No peer is connected." });
    return;
  }
  sendFrame(client.peer, 0x1, text);
}

function consumeFrames(client, rooms) {
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (!masked) {
      closeClient(client, 1002, "Client frames must be masked");
      return;
    }
    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      const largeLength = client.buffer.readBigUInt64BE(2);
      if (largeLength > BigInt(MAX_MESSAGE_BYTES)) {
        closeClient(client, 1009, "Message too large");
        return;
      }
      length = Number(largeLength);
      offset = 10;
    }
    if (length > MAX_MESSAGE_BYTES) {
      closeClient(client, 1009, "Message too large");
      return;
    }
    if (client.buffer.length < offset + 4 + length) return;
    const mask = client.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
    client.buffer = client.buffer.subarray(offset + length);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

    if (opcode === 0x8) {
      closeClient(client);
      return;
    }
    if (opcode === 0x9) {
      sendFrame(client, 0xA, payload);
      continue;
    }
    if (opcode === 0xA) continue;
    if (opcode !== 0x0 && opcode !== 0x1) {
      closeClient(client, 1003, "Text messages only");
      return;
    }
    if (opcode === 0x1 && client.fragmentOpcode !== 0) {
      closeClient(client, 1002, "Unexpected data frame");
      return;
    }
    if (opcode === 0x0 && client.fragmentOpcode === 0) {
      closeClient(client, 1002, "Unexpected continuation frame");
      return;
    }
    if (opcode === 0x1) {
      client.fragmentOpcode = 0x1;
      client.fragments = [];
      client.fragmentBytes = 0;
    }
    client.fragments.push(payload);
    client.fragmentBytes += payload.length;
    if (client.fragmentBytes > MAX_MESSAGE_BYTES) {
      closeClient(client, 1009, "Message too large");
      return;
    }
    if (fin) {
      const complete = Buffer.concat(client.fragments).toString("utf8");
      client.fragmentOpcode = 0;
      client.fragments = [];
      client.fragmentBytes = 0;
      handleText(client, complete, rooms);
    }
  }
}

export function createRelayServer({ port = 8080, host = "127.0.0.1" } = {}) {
  const rooms = new Map();
  const clients = new Set();
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ service: "connect4-relay", rooms: rooms.size, clients: clients.size }));
  });

  server.on("upgrade", (request, socket) => {
    if (request.url !== "/connect4" || request.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(key + MAGIC).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"));

    const client = {
      socket,
      buffer: Buffer.alloc(0),
      room: null,
      peer: null,
      closed: false,
      fragmentOpcode: 0,
      fragments: [],
      fragmentBytes: 0,
    };
    clients.add(client);
    socket.on("data", chunk => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      consumeFrames(client, rooms);
    });
    const cleanup = () => {
      if (!clients.has(client)) return;
      client.closed = true;
      clients.delete(client);
      removeFromRoom(client, rooms);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  return {
    server,
    rooms,
    clients,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      for (const client of clients) client.socket.destroy();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080);
  // Render requires public web services to bind on every network interface.
  // Local tests pass an explicit 127.0.0.1 host and remain loopback-only.
  const host = process.env.HOST ?? "0.0.0.0";
  const relay = createRelayServer({ port, host });
  const address = await relay.listen();
  console.log(`Connect4 relay listening on ws://${address.address}:${address.port}/connect4`);
}
