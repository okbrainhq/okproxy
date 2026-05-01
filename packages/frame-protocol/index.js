// Frame Protocol - Shared encoder/decoder for tunnel communication
// Zero dependencies - uses only Node.js built-in Buffer
//
// Frame format (13-byte header):
// ┌──────────────┬─────────┬──────────────┬──────────┬─────────────┐
// │ Stream ID    │ Type    │ Seq Number   │ Length   │ Payload     │
// │ 4 bytes BE   │ 1 byte  │ 4 bytes BE   │ 4 bytes  │ N bytes     │
// └──────────────┴─────────┴──────────────┴──────────┴─────────────┘

const MAX_FRAME_SIZE = 1048576; // 1MB default
const HEADER_SIZE = 13;

// Frame Types
const FrameType = {
  HEADERS: 0x01,
  DATA: 0x02,
  FIN: 0x03,
  ERROR: 0x04,
  INIT: 0x05,
  PING: 0x06,
  PONG: 0x07,
  UPGRADE: 0x08,
  RESET_SEQ: 0x09   // Sequence counter reset for long-lived streams
};

// Control frame types (connection-local, not duplicated)
const CONTROL_FRAME_TYPES = new Set([
  FrameType.INIT,
  FrameType.PING,
  FrameType.PONG,
  FrameType.RESET_SEQ
]);

/**
 * Encode a frame into a Buffer
 * @param {number} streamId - Stream identifier (0 for connection-level frames)
 * @param {number} type - Frame type (see FrameType)
 * @param {Buffer|string} payload - Frame payload
 * @param {number} seqNo - Per-stream sequence number (0 for control frames)
 * @returns {Buffer} Encoded frame
 */
function encodeFrame(streamId, type, payload, seqNo = 0) {
  if (typeof payload === 'string') {
    payload = Buffer.from(payload);
  }
  if (!Buffer.isBuffer(payload)) {
    throw new Error('Payload must be a Buffer or string');
  }

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32BE(streamId, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32BE(seqNo, 5);
  header.writeUInt32BE(payload.length, 9);
  return Buffer.concat([header, payload]);
}

/**
 * Create a frame decoder that handles partial TCP reads
 * @param {Function} onFrame - Callback(frame) where frame = {streamId, type, seqNo, payload}
 * @param {Function} onError - Callback(error) for protocol errors
 * @param {number} maxFrameSize - Maximum allowed frame size
 * @returns {Function} Decoder function(chunk)
 */
function createFrameDecoder(onFrame, onError, maxFrameSize = MAX_FRAME_SIZE) {
  let buffer = Buffer.alloc(0);
  let destroyed = false;

  return function decoder(chunk) {
    if (destroyed) return;

    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

    while (buffer.length >= HEADER_SIZE) {
      const streamId = buffer.readUInt32BE(0);
      const type = buffer.readUInt8(4);
      const seqNo = buffer.readUInt32BE(5);
      const length = buffer.readUInt32BE(9);

      if (length > maxFrameSize) {
        destroyed = true;
        buffer = Buffer.alloc(0);
        onError(new Error(`Frame too large: ${length} bytes (max: ${maxFrameSize})`));
        return;
      }

      if (buffer.length < HEADER_SIZE + length) return;

      const payload = Buffer.from(buffer.subarray(HEADER_SIZE, HEADER_SIZE + length));
      const remaining = buffer.subarray(HEADER_SIZE + length);

      buffer = remaining.length > 0 ? remaining : Buffer.alloc(0);

      onFrame({ streamId, type, seqNo, payload });
    }
  };
}

const { DedupWindow } = require('./dedup-window');

module.exports = {
  encodeFrame,
  createFrameDecoder,
  FrameType,
  MAX_FRAME_SIZE,
  HEADER_SIZE,
  CONTROL_FRAME_TYPES,
  DedupWindow
};
