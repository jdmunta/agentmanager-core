// A plugin for the tests: inert unless a test sets globalThis.__agentmgrDeny.
export const name = 'testing';

export default function register(api) {
  globalThis.__agentmgrEvents = [];
  api.policy((action, details) => globalThis.__agentmgrDeny?.(action, details));
  api.on((event, payload) => globalThis.__agentmgrEvents.push({ event, payload }));
  api.routes((router) => router.get('/ping', (req, res) => res.json({ pong: true, plugin: api.name })));
}
