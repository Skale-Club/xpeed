// Stands in for https://deno.land/std/http/server.ts: instead of opening a port, serve() hands
// the handler to the registry, which the app's own server routes to.
import { register, type FunctionHandler } from '../registry';

export function serve(handler: FunctionHandler, _options?: unknown) {
  register(handler);
}
