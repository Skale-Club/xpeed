// GET /api/companion/download: the one stable link to the newest Windows installer. It answers a redirect to the file in
// the rolling release; which file that is comes from latest.json, so a new version or a new file name changes nothing here.
import { currentManifest, installerUrl, notAllowed, releaseBase, unavailable } from './_release';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return notAllowed();
  const manifest = await currentManifest();
  const target = manifest ? installerUrl(releaseBase(), manifest) : null;
  if (!target) return unavailable();
  return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'public, max-age=300' } });
}
