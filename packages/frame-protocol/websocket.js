// WebSocket Frame Utilities - Shared between server and client
// Zero dependencies - uses only Node.js built-in Buffer

/**
 * Parse WebSocket frame from raw bytes
 * @param {Buffer} buffer - Raw data from socket
 * @param {boolean} boundariesOnly - If true, only return frame size/opcode without unmasking
 * @returns {Object|null} Parsed frame or null if incomplete
 *   - boundariesOnly=false: {fin, opcode, payload, remaining}
 *   - boundariesOnly=true: {frameSize, opcode, remaining}
 */
function parseWebSocketFrame(buffer, boundariesOnly = false) {
  if (buffer.length < 2) return null;

  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;

  let offset = 2;

  // Extended payload length
  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    const high = buffer.readUInt32BE(2);
    const low = buffer.readUInt32BE(6);
    if (high !== 0) throw new Error('Payload too large (>4GB)');
    payloadLen = low;
    offset = 10;
  }

  // Account for mask key length if present
  if (masked) {
    offset += 4;
  }

  // Check if we have full payload
  const frameSize = offset + payloadLen;
  if (buffer.length < frameSize) return null;

  const remaining = buffer.subarray(frameSize);

  if (boundariesOnly) {
    return { frameSize, opcode, remaining };
  }

  // Full parsing with unmasking
  let payloadStart = offset - (masked ? 4 : 0);
  let payload = buffer.subarray(payloadStart, frameSize);

  if (masked) {
    const maskKey = buffer.subarray(offset - 4, offset);
    // Create a copy to avoid modifying the original buffer
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }

  return {
    fin,
    opcode,
    payload,
    remaining
  };
}

/**
 * Build WebSocket frame (server -> client, unmasked)
 * @param {number} opcode - WebSocket opcode (1=text, 2=binary, 8=close, 9=ping, 10=pong)
 * @param {Buffer} payload - Frame payload
 * @returns {Buffer} WebSocket frame
 */
function buildWebSocketFrame(opcode, payload) {
  const payloadLen = payload.length;
  let frame;

  if (payloadLen < 126) {
    // Small payload: 2 byte header + payload
    frame = Buffer.allocUnsafe(2 + payloadLen);
    frame[0] = 0x80 | opcode; // FIN=1, opcode
    frame[1] = payloadLen; // Unmasked (no MASK bit)
    payload.copy(frame, 2);
  } else if (payloadLen < 65536) {
    // Medium payload: 4 byte header + payload
    frame = Buffer.allocUnsafe(4 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 126; // Unmasked
    frame.writeUInt16BE(payloadLen, 2);
    payload.copy(frame, 4);
  } else {
    // Large payload: 10 byte header + payload (up to 4GB)
    frame = Buffer.allocUnsafe(10 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 127; // Unmasked
    frame.writeUInt32BE(0, 2); // High 32 bits = 0
    frame.writeUInt32BE(payloadLen, 6); // Low 32 bits
    payload.copy(frame, 10);
  }

  return frame;
}

/**
 * Build masked WebSocket frame (client -> server)
 * @param {number} opcode - WebSocket opcode
 * @param {Buffer} payload - Frame payload
 * @returns {Buffer} Masked WebSocket frame
 */
function buildMaskedWebSocketFrame(opcode, payload) {
  const payloadLen = payload.length;
  const maskKey = crypto.randomBytes(4);
  let frame;
  let offset;

  if (payloadLen < 126) {
    frame = Buffer.allocUnsafe(2 + 4 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | payloadLen; // MASK=1
    maskKey.copy(frame, 2);
    offset = 6;
  } else if (payloadLen < 65536) {
    frame = Buffer.allocUnsafe(4 + 4 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payloadLen, 2);
    maskKey.copy(frame, 4);
    offset = 8;
  } else {
    frame = Buffer.allocUnsafe(10 + 4 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | 127;
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(payloadLen, 6);
    maskKey.copy(frame, 10);
    offset = 14;
  }

  // Mask the payload
  for (let i = 0; i < payload.length; i++) {
    frame[offset + i] = payload[i] ^ maskKey[i % 4];
  }

  return frame;
}

// WebSocket opcodes
const WS_OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
};

module.exports = {
  parseWebSocketFrame,
  buildWebSocketFrame,
  buildMaskedWebSocketFrame,
  WS_OPCODE
};
