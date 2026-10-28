import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileUp, Loader2, AlertCircle, Car } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { useCarsContext } from '@/contexts/CarsContext';
import { useCSVUpload } from '@/hooks/use-csv-upload';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type FileError = 'noCache' | 'noFile' | 'readFailed';

export default function ShareImportPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { cars, loading: carsLoading, selectedCarId: contextCarId } = useCarsContext();

  const [selectedCarId, setSelectedCarId] = useState<string>('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [loadingFile, setLoadingFile] = useState(true);
  const [fileError, setFileError] = useState<FileError | null>(null);

  const { upload, uploading, progressLabel, progressValue } = useCSVUpload(
    (sessionId) => navigate(`/session/${sessionId}`),
    selectedCarId || undefined,
  );

  // Pre-select the context car
  useEffect(() => {
    if (contextCarId && !selectedCarId) {
      setSelectedCarId(contextCarId);
    }
  }, [contextCarId, selectedCarId]);

  // Read the pending CSV from the SW cache
  useEffect(() => {
    if (searchParams.get('source') !== 'share') {
      setLoadingFile(false);
      return;
    }

    (async () => {
      try {
        if (!('caches' in window)) {
          setFileError('noCache');
          return;
        }
        const cache = await caches.open('share-target-v1');
        const response = await cache.match('/pending-csv');
        if (!response) {
          setFileError('noFile');
          return;
        }
        const fileName = decodeURIComponent(
          response.headers.get('X-File-Name') || 'shared.csv',
        );
        const blob = await response.blob();
        const file = new File([blob], fileName, { type: 'text/csv' });
        setPendingFile(file);
        await cache.delete('/pending-csv');
      } catch (err) {
        setFileError('readFailed');
      } finally {
        setLoadingFile(false);
      }
    })();
  }, [searchParams]);

  const handleUpload = useCallback(() => {
    if (pendingFile) upload(pendingFile);
  }, [pendingFile, upload]);

  const isReady = !loadingFile && !carsLoading && !!pendingFile && !!selectedCarId;

  const fileErrorText: Record<FileError, string> = {
    noCache: t('importPage.errorNoCache', "This browser can't receive shared files. Please open the app and import the file from there."),
    noFile: t('importPage.errorNoFile', "We didn't receive a file. Please share it from the Car Scanner app again."),
    readFailed: t('importPage.errorReadFailed', "We couldn't open the shared file. Please try again."),
  };

  return (
    <AppLayout>
      <div className="max-w-lg mx-auto pt-8">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileUp className="w-5 h-5 text-primary" />
              {t('importPage.title', 'Import a trip from Car Scanner')}
            </CardTitle>
          </CardHeader>

          <CardContent className="space-y-5">
            {/* File status */}
            {loadingFile ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('importPage.readingFile', 'Opening the file you shared…')}
              </div>
            ) : fileError ? (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="w-4 h-4" />
                {fileErrorText[fileError]}
              </div>
            ) : pendingFile ? (
              <div className="rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
                <p className="font-medium text-foreground truncate">{pendingFile.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {(pendingFile.size / 1024).toFixed(1)} KB
                </p>
              </div>
            ) : null}

            {/* Car selector */}
            {!fileError && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">{t('importPage.carLabel', 'Which car was it?')}</label>
                {carsLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('importPage.loadingCars', 'Loading your cars…')}
                  </div>
                ) : cars.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('importPage.noCars', "You haven't added a car yet.")}{' '}
                    <button
                      className="underline text-primary"
                      onClick={() => navigate('/cars')}
                    >
                      {t('importPage.addCar', 'Add a car')}
                    </button>
                  </p>
                ) : (
                  <Select value={selectedCarId} onValueChange={setSelectedCarId}>
                    <SelectTrigger aria-label={t('importPage.carLabel', 'Which car was it?')}>
                      <SelectValue placeholder={t('importPage.chooseCar', 'Choose a car')} />
                    </SelectTrigger>
                    <SelectContent>
                      {cars.map((car) => (
                        <SelectItem key={car.id} value={car.id}>
                          <span className="flex items-center gap-2">
                            <Car className="w-3.5 h-3.5" />
                            {car.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {/* Progress */}
            {uploading && (
              <div className="space-y-1.5">
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-[width] duration-300 ease-out"
                    style={{ width: `${progressValue}%` }}
                  />
                </div>
                <p className="text-xs font-mono text-primary">{progressLabel}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              {!fileError && (
                <Button
                  className="flex-1"
                  onClick={handleUpload}
                  disabled={!isReady || uploading}
                >
                  {uploading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t('importPage.importing', 'Importing… {{percent}}%', { percent: progressValue })}
                    </>
                  ) : (
                    <>
                      <FileUp className="w-4 h-4 mr-2" />
                      {t('importPage.importButton', 'Import trip')}
                    </>
                  )}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => navigate('/')}
                disabled={uploading}
              >
                {fileError ? t('importPage.goHome', 'Go to Home') : t('common.cancel', 'Cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
