/**
 * Minimal RFC 6455 WebSocket frame codec.
 *
 * Used by the service-worker transport: the browser-side shim can't do real
 * WebSocket framing (there is no native socket), so the page bridge speaks
 * frames to the in-VM `ws` server (Vite's HMR server) on its behalf. Keeping
 * the codec here — in TypeScript — means it's unit-testable headlessly against
 * the real ws server, unlike code that would live in the injected shim.
 *
 * Scope: single-purpose HMR transport, so no permessage-deflate (the bridge
 * simply never negotiates it) and messages are assumed to fit in memory.
 */

export const OPCODE = {
	continuation: 0x0,
	text: 0x1,
	binary: 0x2,
	close: 0x8,
	ping: 0x9,
	pong: 0xa,
} as const;

/** Encode one client→server frame. Client frames MUST be masked (RFC 6455 §5.3). */
export function encodeFrame(opcode: number, payload: Uint8Array, mask: (out: Uint8Array) => void): Uint8Array {
	const len = payload.length;
	let headerLen = 2 + 4; // fin/opcode + mask/len + 4-byte masking key
	if (len >= 65536) headerLen += 8;
	else if (len >= 126) headerLen += 2;

	const frame = new Uint8Array(headerLen + len);
	frame[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
	let offset = 2;
	if (len < 126) {
		frame[1] = 0x80 | len;
	} else if (len < 65536) {
		frame[1] = 0x80 | 126;
		frame[2] = (len >> 8) & 0xff;
		frame[3] = len & 0xff;
		offset = 4;
	} else {
		frame[1] = 0x80 | 127;
		// 64-bit length; JS payloads never exceed 2^32, so high word is 0.
		new DataView(frame.buffer).setUint32(2, 0);
		new DataView(frame.buffer).setUint32(6, len >>> 0);
		offset = 10;
	}

	const key = frame.subarray(offset, offset + 4);
	mask(key);
	offset += 4;
	for (let i = 0; i < len; i++) frame[offset + i] = payload[i] ^ key[i & 3];
	return frame;
}

export interface DecodedFrame {
	opcode: number;
	payload: Uint8Array;
	fin: boolean;
}

/**
 * Streaming decoder for server→client frames. Feed arbitrary byte chunks;
 * get back complete frames. Server frames are normally unmasked, but the
 * decoder unmasks defensively if the mask bit is set.
 */
export class FrameDecoder {
	private buf = new Uint8Array(0);

	push(chunk: Uint8Array): DecodedFrame[] {
		const merged = new Uint8Array(this.buf.length + chunk.length);
		merged.set(this.buf);
		merged.set(chunk, this.buf.length);
		this.buf = merged;

		const out: DecodedFrame[] = [];
		while (true) {
			const frame = this.tryReadFrame();
			if (!frame) break;
			out.push(frame);
		}
		return out;
	}

	private tryReadFrame(): DecodedFrame | null {
		const b = this.buf;
		if (b.length < 2) return null;
		const fin = (b[0] & 0x80) !== 0;
		const opcode = b[0] & 0x0f;
		const masked = (b[1] & 0x80) !== 0;
		let len = b[1] & 0x7f;
		let offset = 2;

		if (len === 126) {
			if (b.length < 4) return null;
			len = (b[2] << 8) | b[3];
			offset = 4;
		} else if (len === 127) {
			if (b.length < 10) return null;
			const dv = new DataView(b.buffer, b.byteOffset);
			// Ignore the high 32 bits — payloads never exceed 2^32 here.
			len = dv.getUint32(6);
			offset = 10;
		}

		let maskKey: Uint8Array | null = null;
		if (masked) {
			if (b.length < offset + 4) return null;
			maskKey = b.subarray(offset, offset + 4);
			offset += 4;
		}

		if (b.length < offset + len) return null;

		let payload = b.slice(offset, offset + len);
		if (maskKey) {
			for (let i = 0; i < len; i++) payload[i] ^= maskKey[i & 3];
		}
		this.buf = b.slice(offset + len);
		return { opcode, payload, fin };
	}
}

/** Parse the "\r\n\r\n"-terminated HTTP upgrade response prefix from a byte stream. */
export function splitHandshake(bytes: Uint8Array): { header: string; rest: Uint8Array } | null {
	// Search for CRLF CRLF.
	for (let i = 3; i < bytes.length; i++) {
		if (bytes[i - 3] === 0x0d && bytes[i - 2] === 0x0a && bytes[i - 1] === 0x0d && bytes[i] === 0x0a) {
			const header = new TextDecoder().decode(bytes.subarray(0, i + 1));
			return { header, rest: bytes.subarray(i + 1) };
		}
	}
	return null;
}
