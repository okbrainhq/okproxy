// Test 1: Frame Protocol Unit Tests (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { encodeFrame, createFrameDecoder, FrameType, MAX_FRAME_SIZE } = require('../../../packages/frame-protocol');

describe('Frame Protocol', () => {
  describe('encodeFrame', () => {
    it('should produce correct buffer for simple payload', () => {
      const frame = encodeFrame(1, FrameType.HEADERS, 'test');
      assert.strictEqual(frame.length, 9 + 4); // header + "test"
      assert.strictEqual(frame.readUInt32BE(0), 1); // streamId
      assert.strictEqual(frame.readUInt8(4), FrameType.HEADERS); // type
      assert.strictEqual(frame.readUInt32BE(5), 4); // payload length
      assert.strictEqual(frame.subarray(9).toString(), 'test');
    });

    it('should accept Buffer payload', () => {
      const payload = Buffer.from([0x01, 0x02, 0x03]);
      const frame = encodeFrame(42, FrameType.DATA, payload);
      assert.strictEqual(frame.readUInt32BE(0), 42);
      assert.strictEqual(frame.readUInt32BE(5), 3);
      assert.deepStrictEqual(frame.subarray(9), payload);
    });

    it('should accept empty payload', () => {
      const frame = encodeFrame(1, FrameType.FIN, Buffer.alloc(0));
      assert.strictEqual(frame.length, 9);
      assert.strictEqual(frame.readUInt32BE(5), 0);
    });
  });

  describe('createFrameDecoder', () => {
    it('should decode single complete frame', () => {
      const frames = [];
      const decoder = createFrameDecoder((frame) => frames.push(frame));
      
      const encoded = encodeFrame(123, FrameType.HEADERS, 'hello');
      decoder(encoded);
      
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].streamId, 123);
      assert.strictEqual(frames[0].type, FrameType.HEADERS);
      assert.strictEqual(frames[0].payload.toString(), 'hello');
    });

    it('should decode multiple frames in one chunk', () => {
      const frames = [];
      const decoder = createFrameDecoder((frame) => frames.push(frame));
      
      const encoded1 = encodeFrame(1, FrameType.HEADERS, 'first');
      const encoded2 = encodeFrame(2, FrameType.DATA, 'second');
      decoder(Buffer.concat([encoded1, encoded2]));
      
      assert.strictEqual(frames.length, 2);
      assert.strictEqual(frames[0].streamId, 1);
      assert.strictEqual(frames[1].streamId, 2);
    });

    it('should handle partial frame and wait for rest', () => {
      const frames = [];
      const decoder = createFrameDecoder((frame) => frames.push(frame));
      
      const encoded = encodeFrame(1, FrameType.HEADERS, 'complete');
      
      // Send first half
      decoder(encoded.subarray(0, 5));
      assert.strictEqual(frames.length, 0);
      
      // Send rest
      decoder(encoded.subarray(5));
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].payload.toString(), 'complete');
    });

    it('should handle frame split across multiple chunks', () => {
      const frames = [];
      const decoder = createFrameDecoder((frame) => frames.push(frame));
      
      const encoded = encodeFrame(1, FrameType.DATA, Buffer.alloc(100, 'x'));
      
      // Send byte by byte
      for (let i = 0; i < encoded.length; i++) {
        decoder(encoded.subarray(i, i + 1));
      }
      
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].payload.length, 100);
    });

    it('should reject oversized frame', () => {
      const errors = [];
      const decoder = createFrameDecoder(
        () => {},
        (err) => errors.push(err)
      );
      
      // Create a header claiming a huge payload
      const header = Buffer.alloc(9);
      header.writeUInt32BE(1, 0);
      header.writeUInt8(FrameType.DATA, 4);
      header.writeUInt32BE(MAX_FRAME_SIZE + 1, 5);
      
      decoder(header);
      
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0].message.includes('too large'));
    });

    it('should handle empty payload correctly', () => {
      const frames = [];
      const decoder = createFrameDecoder((frame) => frames.push(frame));
      
      const encoded = encodeFrame(0, FrameType.PING, Buffer.alloc(0));
      decoder(encoded);
      
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].streamId, 0);
      assert.strictEqual(frames[0].type, FrameType.PING);
      assert.strictEqual(frames[0].payload.length, 0);
    });

    it('should handle max allowed frame size', () => {
      const frames = [];
      const decoder = createFrameDecoder((frame) => frames.push(frame));
      
      const payload = Buffer.alloc(MAX_FRAME_SIZE, 'x');
      const encoded = encodeFrame(1, FrameType.DATA, payload);
      decoder(encoded);
      
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].payload.length, MAX_FRAME_SIZE);
    });
  });
});
