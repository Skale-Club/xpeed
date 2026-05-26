import { useEffect, useState } from 'react';
import { getAppIconBaseUrl, buildIconUrl } from '@/lib/app-icon';

export interface AppIconUrls {
  baseUrl: string | null;
  icon192: string | null;
  icon512: string | null;
  appleIcon: string | null;
  isLoading: boolean;
}

export function useAppIcon(): AppIconUrls {
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getAppIconBaseUrl().then((url) => {
      setBaseUrl(url);
      setIsLoading(false);
    });
  }, []);

  return {
    baseUrl,
    icon192: baseUrl ? buildIconUrl(baseUrl, 'icon-192.png') : null,
    icon512: baseUrl ? buildIconUrl(baseUrl, 'icon-512.png') : null,
    appleIcon: baseUrl ? buildIconUrl(baseUrl, 'apple-touch-icon.png') : null,
    isLoading,
  };
}
