import { describe, it, expect } from 'vitest';
import { encodeFrame, FrameDecoder, OPCODE, splitHandshake } from '../../src/kernel/network/ws-frame.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A deterministic mask (all-zero key → masked payload equals plaintext). */
const zeroMask = (out: Uint8Array) => out.fill(0);
const fixedMask = (out: Uint8Array) => { out[0] = 0x12; out[1] = 0x34; out[2] = 0x56; out[3] = 0x78; };

describe('ws-frame codec', () => {
	it('round-trips a text frame through encode → decode', () => {
		const frame = encodeFrame(OPCODE.text, enc.encode('hello hmr'), fixedMask);
		const frames = new FrameDecoder().push(frame);
		expect(frames).toHaveLength(1);
		expect(frames[0].opcode).toBe(OPCODE.text);
		expect(frames[0].fin).toBe(true);
		expect(dec.decode(frames[0].payload)).toBe('hello hmr');
	});

	it('client frames are always masked (bit set, key applied)', () => {
		const frame = encodeFrame(OPCODE.text, enc.encode('x'), fixedMask);
		expect(frame[1] & 0x80).toBe(0x80); // MASK bit
		// payload byte = 'x'(0x78) ^ key[0](0x12)
		expect(frame[frame.length - 1]).toBe(0x78 ^ 0x12);
	});

	it('handles 16-bit extended length (126..65535)', () => {
		const payload = enc.encode('a'.repeat(1000));
		const frame = encodeFrame(OPCODE.binary, payload, zeroMask);
		expect(frame[1] & 0x7f).toBe(126);
		const frames = new FrameDecoder().push(frame);
		expect(frames[0].payload.length).toBe(1000);
	});

	it('handles 64-bit extended length (>= 65536)', () => {
		const payload = enc.encode('b'.repeat(70000));
		const frame = encodeFrame(OPCODE.binary, payload, zeroMask);
		expect(frame[1] & 0x7f).toBe(127);
		const frames = new FrameDecoder().push(frame);
		expect(frames[0].payload.length).toBe(70000);
	});

	it('reassembles frames split across chunk boundaries', () => {
		const frame = encodeFrame(OPCODE.text, enc.encode('split me'), fixedMask);
		const decoder = new FrameDecoder();
		expect(decoder.push(frame.subarray(0, 3))).toHaveLength(0);
		expect(decoder.push(frame.subarray(3, 6))).toHaveLength(0);
		const done = decoder.push(frame.subarray(6));
		expect(done).toHaveLength(1);
		expect(dec.decode(done[0].payload)).toBe('split me');
	});

	it('decodes multiple frames from one chunk', () => {
		const a = encodeFrame(OPCODE.text, enc.encode('one'), zeroMask);
		const b = encodeFrame(OPCODE.text, enc.encode('two'), zeroMask);
		const both = new Uint8Array(a.length + b.length);
		both.set(a); both.set(b, a.length);
		const frames = new FrameDecoder().push(both);
		expect(frames.map((f) => dec.decode(f.payload))).toEqual(['one', 'two']);
	});

	it('decodes unmasked server frames', () => {
		// Server frame: FIN+text, no mask bit, 3-byte payload
		const server = new Uint8Array([0x81, 0x03, 0x61, 0x62, 0x63]);
		const frames = new FrameDecoder().push(server);
		expect(dec.decode(frames[0].payload)).toBe('abc');
	});

	it('splitHandshake separates the 101 header from trailing frame bytes', () => {
		const header = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n';
		const trailing = encodeFrame(OPCODE.text, enc.encode('after'), zeroMask);
		const combined = new Uint8Array(enc.encode(header).length + trailing.length);
		combined.set(enc.encode(header));
		combined.set(trailing, enc.encode(header).length);
		const split = splitHandshake(combined);
		expect(split).not.toBeNull();
		expect(split!.header).toContain('101 Switching Protocols');
		expect(new FrameDecoder().push(split!.rest)[0]).toBeTruthy();
	});

	it('splitHandshake returns null until the terminator arrives', () => {
		expect(splitHandshake(enc.encode('HTTP/1.1 101 Switching Protocols\r\n'))).toBeNull();
	});
});
