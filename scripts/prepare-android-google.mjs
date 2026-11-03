import { readFileSync, writeFileSync } from 'node:fs';

// Google distributes a different config per Android package. Reusing Xpot's
// package config would compile an APK whose native sign-in cannot work.
const path = 'android/app/google-services.json';
const encoded = process.env.GOOGLE_SERVICES_JSON_BASE64;
const source = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : readFileSync(path, 'utf8');
const config = JSON.parse(source);
if (config.project_info?.project_id !== process.env.VITE_FIREBASE_PROJECT_ID) {
  throw new Error('Android Google config belongs to a different Google Cloud project');
}
const client = config.client?.find((item) => item.client_info?.android_client_info?.package_name === 'club.skale.xpeed');
if (!client || !client.oauth_client?.some((item) => item.client_type === 3 && item.client_id === process.env.VITE_GOOGLE_CLIENT_ID)) {
  throw new Error('Register club.skale.xpeed with Google sign-in and download its google-services.json');
}
if (encoded) writeFileSync(path, source, { mode: 0o600 });
console.log('Google Android configuration validated for club.skale.xpeed');
