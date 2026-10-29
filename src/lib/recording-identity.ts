export async function csvChecksum(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

/** Millisecond recording identity, namespaced by its owner and car, across retries/devices. */
export async function recordedSessionId(userId: string, carId: string, tripId: string): Promise<string> {
  const hash = await csvChecksum(JSON.stringify(['xpeed-recording-v1', userId, carId, tripId]));
  // UUIDv8 reserves custom derivations (this one uses SHA-256).
  const hex = hash.slice(0, 12) + '8' + hash.slice(13, 16) + ((parseInt(hash[16], 16) & 3) | 8).toString(16) + hash.slice(17, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

