// Proxy - HTTP proxy to local target service
// Works with both single RealSocket and multipath VirtualSocket

const { request } = require('node:http');
const { encodeFrame, FrameType, MAX_FRAME_SIZE } = require('../../../packages/frame-protocol');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length'
]);

const X_FORWARDED_HEADERS = new Set([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-path',
  'forwarded'
]);

function filterRequestHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerKey) && !X_FORWARDED_HEADERS.has(lowerKey)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

const WS_HOP_BY_HOP_HEADERS = new Set([
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'content-length'
]);

function filterWebSocketHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (!WS_HOP_BY_HOP_HEADERS.has(lowerKey) && !X_FORWARDED_HEADERS.has(lowerKey)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

const MAX_WS_BUFFER_SIZE = 16 * 1024 * 1024;

function createProxy(connection, targetPort, targetHost = 'localhost', maxStreams = 100) {
  const activeStreams = new Map();
  const activeWebSockets = new Map();

  // Set max listeners if connection exposes a raw socket
  if (connection.socket) {
    connection.socket.setMaxListeners(maxStreams + 10);
  }

  function handleFrame(frame) {
    if (activeWebSockets.has(frame.streamId)) {
      handleWebSocketFrame(frame);
      return;
    }

    if (frame.type === FrameType.HEADERS) {
      startProxyRequest(frame.streamId, frame.payload);
    } else if (frame.type === FrameType.UPGRADE) {
      startWebSocketProxy(frame.streamId, frame.payload);
    } else if (frame.type === FrameType.DATA) {
      const proxyReq = activeStreams.get(frame.streamId);
      if (proxyReq && !proxyReq.destroyed) {
        proxyReq.write(frame.payload);
      }
    } else if (frame.type === FrameType.FIN) {
      const proxyReq = activeStreams.get(frame.streamId);
      if (proxyReq && !proxyReq.destroyed) {
        proxyReq.end();
      }
    } else if (frame.type === FrameType.ERROR) {
      const proxyReq = activeStreams.get(frame.streamId);
      if (proxyReq) {
        proxyReq.destroy();
        activeStreams.delete(frame.streamId);
      }
    }
  }

  function handleWebSocketFrame(frame) {
    const wsState = activeWebSockets.get(frame.streamId);
    if (!wsState) return;

    if (frame.type === FrameType.DATA) {
      wsState.reassemblyBuffer = Buffer.concat([wsState.reassemblyBuffer, frame.payload]);

      while (wsState.reassemblyBuffer.length >= 2 && !wsState.closeFramePending) {
        const result = parseWebSocketFrame(wsState.reassemblyBuffer, true);
        if (!result) break;

        const { frameSize, opcode, remaining } = result;

        const isCloseFrame = opcode === 0x08;
        if (isCloseFrame) {
          wsState.closeFramePending = true;
        }

        const completeFrame = wsState.reassemblyBuffer.subarray(0, frameSize);
        wsState.reassemblyBuffer = remaining;

        const canWrite = wsState.socket.write(completeFrame);
        if (!canWrite && !isCloseFrame) {
          wsState.socket.pause();
          wsState.socket.once('drain', () => { wsState.socket.resume(); });
        }

        if (isCloseFrame) {
          setTimeout(() => {
            if (!wsState.cleanupCalled) {
              wsState.cleanup();
            }
          }, 5000);
          break;
        }
      }

      if (wsState.reassemblyBuffer.length > MAX_WS_BUFFER_SIZE) {
        console.error('WebSocket reassembly buffer overflow - closing connection');
        wsState.cleanup();
        return;
      }
    } else if (frame.type === FrameType.FIN) {
      if (!wsState.closeFramePending) {
        wsState.cleanup();
      }
    } else if (frame.type === FrameType.ERROR) {
      wsState.cleanup();
    }
  }

  function startWebSocketProxy(streamId, payload) {
    try {
      const upgradeInfo = JSON.parse(payload.toString());
      
      if (upgradeInfo.protocol !== 'websocket') {
        connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Unsupported protocol')));
        return;
      }

      const proxyHeaders = filterWebSocketHeaders(upgradeInfo.headers);
      proxyHeaders.host = `${targetHost}:${targetPort}`;

      if (upgradeInfo.remoteAddress) {
        proxyHeaders['x-forwarded-for'] = upgradeInfo.remoteAddress;
      }

      const proxyReq = request({
        hostname: targetHost,
        port: targetPort,
        method: upgradeInfo.method,
        path: upgradeInfo.path,
        headers: proxyHeaders
      });

      let upgradeTimeoutTriggered = false;
      proxyReq.setTimeout(30000, () => {
        upgradeTimeoutTriggered = true;
        proxyReq.destroy();
        connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Upgrade timeout')));
      });

      let cleanupCalled = false;

      const wsState = {
        socket: null,
        cleanup: null,
        reassemblyBuffer: Buffer.alloc(0),
        closeFramePending: false,
        cleanupCalled: false
      };

      function cleanup() {
        if (cleanupCalled || wsState.cleanupCalled) return;
        cleanupCalled = true;
        wsState.cleanupCalled = true;

        activeWebSockets.delete(streamId);

        if (wsState.socket && !wsState.socket.destroyed) {
          wsState.socket.destroy();
        }

        connection.write(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
      }

      wsState.cleanup = cleanup;

      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        wsState.socket = proxySocket;
        activeWebSockets.set(streamId, wsState);

        const responseHeaders = {
          upgrade: proxyRes.headers.upgrade || 'websocket',
          connection: proxyRes.headers.connection || 'Upgrade',
          'sec-websocket-accept': proxyRes.headers['sec-websocket-accept']
        };

        const responseHeadersLower = Object.fromEntries(
          Object.entries(responseHeaders).map(([k, v]) => [k.toLowerCase(), v])
        );
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (!(key.toLowerCase() in responseHeadersLower)) {
            responseHeaders[key] = value;
          }
        }

        connection.write(encodeFrame(streamId, FrameType.UPGRADE, JSON.stringify({
          status: 101,
          headers: responseHeaders
        })));

        let buffer = proxyHead && proxyHead.length > 0 ? proxyHead : Buffer.alloc(0);
        let pendingLargeFrame = null;
        let pendingOffset = 0;

        function sendLargeFrameChunk() {
          while (pendingOffset < pendingLargeFrame.length) {
            const end = Math.min(pendingOffset + MAX_FRAME_SIZE, pendingLargeFrame.length);
            const chunk = pendingLargeFrame.subarray(pendingOffset, end);
            const canWrite = connection.write(encodeFrame(streamId, FrameType.DATA, chunk));
            if (!canWrite) {
              proxySocket.pause();
              pendingOffset = end;
              if (connection.socket) connection.socket.once('drain', sendLargeFrameChunk);
              else setTimeout(sendLargeFrameChunk, 50);
              return;
            }
            pendingOffset = end;
          }
          pendingLargeFrame = null;
          pendingOffset = 0;
          proxySocket.resume();
        }

        proxySocket.on('data', (chunk) => {
          if (buffer.length + chunk.length > MAX_WS_BUFFER_SIZE) {
            console.error('WebSocket buffer overflow - destroying connection');
            cleanup();
            return;
          }
          buffer = Buffer.concat([buffer, chunk]);

          while (buffer.length >= 2) {
            if (pendingLargeFrame) break;

            const frameInfo = parseWebSocketFrame(buffer, true);
            if (!frameInfo) break;

            const { frameSize, opcode, remaining } = frameInfo;

            const rawFrame = Buffer.from(buffer.subarray(0, frameSize));
            buffer = remaining;

            const isCloseFrame = opcode === 0x08;
            if (isCloseFrame) {
              wsState.closeFramePending = true;
            }

            if (rawFrame.length <= MAX_FRAME_SIZE) {
              const canWrite = connection.write(encodeFrame(streamId, FrameType.DATA, rawFrame));
              if (!canWrite) {
                proxySocket.pause();
                if (connection.socket) {
                  connection.socket.once('drain', () => { proxySocket.resume(); });
                } else {
                  setTimeout(() => { proxySocket.resume(); }, 50);
                }
              }
            } else {
              pendingLargeFrame = rawFrame;
              pendingOffset = 0;
              sendLargeFrameChunk();
              if (pendingLargeFrame) break;
            }

            if (isCloseFrame) {
              setImmediate(() => {
                if (!connection.write(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)))) {
                  if (connection.socket) connection.socket.once('drain', cleanup);
                  else setTimeout(cleanup, 50);
                } else {
                  cleanup();
                }
              });
              return;
            }
          }
        });

        proxySocket.on('close', () => {
          if (!cleanupCalled && !wsState.closeFramePending) {
            cleanup();
          }
        });

        proxySocket.on('error', (err) => {
          console.error(`[CLIENT WS ERROR] WebSocket target error:`, err.message, `(code: ${err.code || 'none'})`);
          cleanup();
        });
      });

      proxyReq.on('error', (err) => {
        if (upgradeTimeoutTriggered) return;
        console.error(`[CLIENT WS ERROR] WebSocket upgrade failed for ${upgradeInfo.path}:`, err.message, `(code: ${err.code || 'none'})`);
        const errorDetail = err.code ? `Upgrade failed: ${err.code}` : 'Upgrade failed';
        connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from(errorDetail)));
      });

      proxyReq.end();

    } catch (err) {
      console.error('Invalid UPGRADE payload:', err.message);
      connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Invalid upgrade request')));
    }
  }

  function startProxyRequest(streamId, payload) {
    try {
      const reqInfo = JSON.parse(payload.toString());

      const proxyHeaders = filterRequestHeaders(reqInfo.headers);
      proxyHeaders.host = `${targetHost}:${targetPort}`;

      delete proxyHeaders.origin;
      delete proxyHeaders.referer;

      if (reqInfo.remoteAddress) {
        proxyHeaders['x-forwarded-for'] = reqInfo.remoteAddress;
      }

      const proxyReq = request({
        hostname: targetHost,
        port: targetPort,
        method: reqInfo.method,
        path: reqInfo.path,
        headers: proxyHeaders
      }, (proxyRes) => {
        const filteredHeaders = filterRequestHeaders(proxyRes.headers);

        const canWrite = connection.write(encodeFrame(streamId, FrameType.HEADERS, JSON.stringify({
          status: proxyRes.statusCode,
          headers: filteredHeaders
        })));

        if (!canWrite) {
          proxyRes.pause();
          // Resume on next tick if multipath (multiple connections handle it)
          setTimeout(() => proxyRes.resume(), 50);
        }

        proxyRes.on('data', (chunk) => {
          let offset = 0;
          while (offset < chunk.length) {
            const end = Math.min(offset + MAX_FRAME_SIZE, chunk.length);
            const frameChunk = chunk.subarray(offset, end);
            connection.write(encodeFrame(streamId, FrameType.DATA, frameChunk));
            offset = end;
          }
        });

        proxyRes.on('end', () => {
          connection.write(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
          activeStreams.delete(streamId);
        });

        proxyRes.on('error', (err) => {
          console.error(`[CLIENT ERROR] Target response error for ${reqInfo.method} ${reqInfo.path}:`, err.message, `(code: ${err.code || 'none'})`);
          const errorDetail = err.code ? `Target error: ${err.code}` : 'Target error';
          connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from(errorDetail)));
          activeStreams.delete(streamId);
        });
      });

      activeStreams.set(streamId, proxyReq);

      proxyReq.on('error', (err) => {
        console.error(`[CLIENT ERROR] Target error for ${reqInfo.method} ${reqInfo.path}:`, err.message, `(code: ${err.code || 'none'})`);
        if (err.code === 'ECONNREFUSED') {
          connection.write(encodeFrame(streamId, FrameType.HEADERS, JSON.stringify({
            status: 502,
            headers: { 'content-type': 'text/plain' }
          })));
          connection.write(encodeFrame(streamId, FrameType.DATA, Buffer.from('Target service not available')));
        } else {
          const errorDetail = err.code ? `Target error: ${err.code}` : 'Target error';
          connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from(errorDetail)));
        }
        activeStreams.delete(streamId);
      });

      proxyReq.on('drain', () => {
        // Target ready for more data — server will resume sending
      });

    } catch (err) {
      connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Invalid request')));
    }
  }

  function parseWebSocketFrame(buffer, boundariesOnly = false) {
    if (buffer.length < 2) return null;
    
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let payloadLen = buffer[1] & 0x7f;
    
    let offset = 2;
    
    if (payloadLen === 126) {
      if (buffer.length < 4) return null;
      payloadLen = buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buffer.length < 10) return null;
      const high = buffer.readUInt32BE(2);
      if (high !== 0) return null;
      payloadLen = buffer.readUInt32BE(6);
      offset = 10;
    }
    
    if (masked) {
      offset += 4;
    }
    
    const frameSize = offset + payloadLen;
    if (buffer.length < frameSize) return null;
    
    const remaining = buffer.subarray(frameSize);
    
    if (boundariesOnly) {
      return { frameSize, opcode, remaining };
    }
    
    let payload = buffer.subarray(offset, frameSize);
    
    if (masked) {
      const maskKey = buffer.subarray(offset - 4, offset);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }
    
    return { fin, opcode, payload, remaining };
  }

  function buildWebSocketFrame(opcode, payload) {
    const payloadLen = payload.length;
    let frame;
    
    if (payloadLen < 126) {
      frame = Buffer.allocUnsafe(2 + payloadLen);
      frame[0] = 0x80 | opcode;
      frame[1] = payloadLen;
      payload.copy(frame, 2);
    } else if (payloadLen < 65536) {
      frame = Buffer.allocUnsafe(4 + payloadLen);
      frame[0] = 0x80 | opcode;
      frame[1] = 126;
      frame.writeUInt16BE(payloadLen, 2);
      payload.copy(frame, 4);
    } else {
      frame = Buffer.allocUnsafe(10 + payloadLen);
      frame[0] = 0x80 | opcode;
      frame[1] = 127;
      frame.writeUInt32BE(0, 2);
      frame.writeUInt32BE(payloadLen, 6);
      payload.copy(frame, 10);
    }
    
    return frame;
  }

  function destroy() {
    for (const [streamId, wsState] of activeWebSockets) {
      wsState.cleanup();
    }
    activeWebSockets.clear();

    for (const [streamId, proxyReq] of activeStreams) {
      proxyReq.destroy();
    }
    activeStreams.clear();
  }

  return {
    handleFrame,
    destroy
  };
}

module.exports = { createProxy };
