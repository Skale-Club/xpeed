import { supabase } from '@/integrations/supabase/client';
import { updateCarProfile } from '@/lib/db';

// The owner's own photo of their car, in a private bucket under
// <user id>/<car id>.<ext>; shown through short-lived signed links.

const BUCKET = 'car-photos';
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const LINK_SECONDS = 60 * 60;

export type CarPhotoProblem = 'not-image' | 'too-large';

/** Why a file can't be the car's photo, or null when it can. */
export function carPhotoProblem(file: File): CarPhotoProblem | null {
  if (!TYPES.includes(file.type)) return 'not-image';
  if (file.size > MAX_BYTES) return 'too-large';
  return null;
}

/** Saves the photo (replacing any earlier one) and points the car at it. */
export async function uploadCarPhoto(carId: string, file: File, previousPath?: string | null): Promise<string> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  // A new name each time, so no cached copy of the old photo shows up.
  const path = `${user.id}/${carId}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(`Failed to upload the car photo: ${error.message}`);
  await updateCarProfile(carId, { photo_path: path });
  if (previousPath && previousPath !== path) {
    await supabase.storage.from(BUCKET).remove([previousPath]);
  }
  forgetLink(previousPath);
  return path;
}

/** Back to the drawing: removes the photo file and the link to it. */
export async function removeCarPhoto(carId: string, path: string): Promise<void> {
  await updateCarProfile(carId, { photo_path: null });
  await supabase.storage.from(BUCKET).remove([path]);
  forgetLink(path);
}

// Signed links are reused while still valid, so lists don't ask for one per render.
const links = new Map<string, { url: string; until: number }>();

function forgetLink(path: string | null | undefined) {
  if (path) links.delete(path);
}

export async function carPhotoUrl(path: string): Promise<string | null> {
  const cached = links.get(path);
  if (cached && cached.until > Date.now() + 60_000) return cached.url;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, LINK_SECONDS);
  if (error || !data?.signedUrl) return null;
  links.set(path, { url: data.signedUrl, until: Date.now() + LINK_SECONDS * 1000 });
  return data.signedUrl;
}
