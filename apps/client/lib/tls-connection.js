// Compatibility API, not a legacy wire protocol: use the same v2 transport and
// session fences as the primary client instead of a second unsafe send path.
const { VirtualSocket } = require('./virtual-socket');
function createTLSConnection(config, onFrame, onConnect, onDisconnect) {
  const vs = new VirtualSocket({ ...config, parallelSockets: 1 });
  vs.on('frame', frame => onFrame?.(frame));
  vs.on('socketConnected', () => onConnect?.());
  vs.on('sessionReset', () => onDisconnect?.());
  vs.on('error', () => {});
  Object.defineProperty(vs, 'socket', { get() { return [...vs.realSockets.values()][0]?.socket || null; } });
  vs.isInitialized = () => vs.isConnected();
  vs.start();
  return vs;
}
module.exports = { createTLSConnection };
