/**
 * websocket.ts — minimal RFC 6455 WebSocket implementation
 *
 * Handles: text frames (0x1), close (0x8), ping/pong (0x9/0xA).
 * Only text frames — no binary support needed for terminal I/O.
 * Server→client frames are unmasked; client→server frames are masked (per spec).
 */

import * as crypto from 'node:crypto';
import type * as http from 'node:http';
import type * as net from 'node:net';

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-5AB9A085B11E';

/**
 * Performs the RFC 6455 opening handshake and returns the raw socket.
 * Returns null if the request is not a valid WebSocket upgrade.
 */
export function upgradeWebSocket(
  req: http.IncomingMessage,
  socket: net.Socket,
): net.Socket | null {
  const key = req.headers['sec-websocket-key'];
  if (!key) return null;

  const accept = crypto
    .createHash('sha1')
    .update(key + WS_MAGIC_GUID)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n',
  );

  return socket;
}

/**
 * Encodes a string as a WebSocket text frame (server→client, unmasked).
 */
export function encodeFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;

  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    // Write as two 32-bit values (BigInt not needed for text payloads)
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }

  return Buffer.concat([header, data]);
}

/**
 * Attaches a frame reader to the socket that decodes incoming WebSocket frames.
 * Handles text (0x1), close (0x8), and ping (0x9) opcodes.
 */
export function attachFrameReader(
  socket: net.Socket,
  onMessage: (data: string) => void,
  onClose: () => void,
): void {
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let payloadLen = buffer[1]! & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return; // need more data
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = buffer.readUInt32BE(6); // ignore high 32 bits
        offset = 10;
      }

      const maskSize = masked ? 4 : 0;
      const totalLen = offset + maskSize + payloadLen;
      if (buffer.length < totalLen) return; // need more data

      const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = buffer.subarray(offset + maskSize, totalLen);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i]! ^ maskKey[i % 4]!;
        }
      }

      buffer = buffer.subarray(totalLen);

      switch (opcode) {
        case 0x1: // text frame
          onMessage(payload.toString('utf8'));
          break;
        case 0x8: // close
          // Send close frame back
          socket.write(Buffer.from([0x88, 0x00]));
          socket.end();
          onClose();
          return;
        case 0x9: // ping → pong
          {
            const pong = Buffer.alloc(2 + payload.length);
            pong[0] = 0x8a; // FIN + pong
            pong[1] = payload.length;
            payload.copy(pong, 2);
            socket.write(pong);
          }
          break;
        case 0xa: // pong — ignore
          break;
      }
    }
  });

  socket.on('close', onClose);
  socket.on('error', onClose);
}
