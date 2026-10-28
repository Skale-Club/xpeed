import type { CapacitorConfig } from '@capacitor/cli';

// Android app shell. By default the APK bundles the built web app (dist/).
// Set CAP_SERVER_URL at build time (e.g. the production URL) to make the app
// load the deployed site instead, so web updates reach phones without a new
// APK — only native changes (plugins, permissions) then need a rebuild.
const remoteUrl = process.env.CAP_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'club.skale.xpeed',
  appName: 'Xpeed',
  webDir: 'dist',
  server: remoteUrl
    ? { url: remoteUrl, androidScheme: 'https' }
    : { androidScheme: 'https' },
  plugins: {
    BluetoothLe: {
      displayStrings: {
        scanning: 'Procurando o adaptador…',
        cancel: 'Cancelar',
        availableDevices: 'Adaptadores encontrados',
        noDeviceFound: 'Nenhum adaptador encontrado',
      },
    },
  },
};

export default config;
