// Frame Protocol - Shared encoder/decoder for tunnel communication
// Zero dependencies - uses only Node.js built-in Buffer

const MAX_FRAME_SIZE = 1048576; // 1MB default

// Frame Types
const FrameType = {
  HEADERS: 0x01,
  DATA: 0x02,
  FIN: 0x03,
  ERROR: 0x04,
  INIT: 0x05,
  PING: 0x06,
  PONG: 0x07
};

/**
 * Encode a frame into a Buffer
 * @param {number} streamId - Stream identifier (0 for connection-level frames)
 * @param {number} type - Frame type (see FrameType)
 * @param {Buffer|string} payload - Frame payload
 * @returns {Buffer} Encoded frame
 */
function encodeFrame(streamId, type, payload) {
  if (typeof payload === 'string') {
    payload = Buffer.from(payload);
  }
  if (!Buffer.isBuffer(payload)) {
    throw new Error('Payload must be a Buffer or string');
  }

  const header = Buffer.alloc(9);
  header.writeUInt32BE(streamId, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32BE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

/**
 * Create a frame decoder that handles partial TCP reads
 * Uses a chunk list to reduce GC pressure (only concat when needed)
 * @param {Function} onFrame - Callback(frame) where frame = {streamId, type, payload}
 * @param {Function} onError - Callback(error) for protocol errors
 * @param {number} maxFrameSize - Maximum allowed frame size
 * @returns {Function} Decoder function(chunk)
 */
function createFrameDecoder(onFrame, onError, maxFrameSize = MAX_FRAME_SIZE) {
  let buffer = Buffer.alloc(0);
  let destroyed = false;

  return function decoder(chunk) {
    if (destroyed) return;

    // Append new chunk efficiently - single concat per chunk
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

    while (buffer.length >= 9) {
      // Read header directly from buffer (no concat needed per iteration)
      const streamId = buffer.readUInt32BE(0);
      const type = buffer.readUInt8(4);
      const length = buffer.readUInt32BE(5);

      // Check for oversized frame
      if (length > maxFrameSize) {
        destroyed = true;
        buffer = Buffer.alloc(0);
        onError(new Error(`Frame too large: ${length} bytes (max: ${maxFrameSize})`));
        return;
      }

      // Wait for complete payload
      if (buffer.length < 9 + length) return;

      // Extract payload and remaining data using subarray (O(1), no copy)
      const payload = buffer.subarray(9, 9 + length);
      const remaining = buffer.subarray(9 + length);

      // Update state - use subarray result directly, only alloc if needed
      buffer = remaining.length > 0 ? remaining : Buffer.alloc(0);

      // Emit frame (payload is a view into original buffer, no copy)
      onFrame({ streamId, type, payload });
    }
  };
}

module.exports = {
  encodeFrame,
  createFrameDecoder,
  FrameType,
  MAX_FRAME_SIZE
};
