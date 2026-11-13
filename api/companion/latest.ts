// GET /api/companion/latest: which Xpeed Companion is the newest, for the public page and for the program itself.
// No sign-in. `downloadUrl` is always this server's own stable /api/companion/download.
import { currentManifest, notAllowed, unavailable } from './_release';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return notAllowed();
  const manifest = await currentManifest();
  if (!manifest) return unavailable();
  // The public address comes from the request URL, which the server builds from its configured origin (PUBLIC_APP_URL),
  // and never from a Host header a visitor sent.
  const origin = new URL(request.url).origin;
  return new Response(
    JSON.stringify({
      version: manifest.version,
      build: manifest.build,
      downloadUrl: `${origin}/api/companion/download`,
      sha256: manifest.sha256,
      size: manifest.size,
      releasedAt: manifest.releasedAt,
      minVersion: manifest.minVersion,
      signed: manifest.signed,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' } },
  );
}
