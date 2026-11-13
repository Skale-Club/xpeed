import { useEffect, useRef, useState } from 'react';
import type { VehicleVisual } from '@/lib/vehicle-visuals';

let modelViewerReady: Promise<void> | undefined;
function loadModelViewer() {
  modelViewerReady ??= import('@google/model-viewer').then(() => undefined).catch((error) => { modelViewerReady = undefined; throw error; });
  return modelViewerReady;
}

export function VehicleModelViewer({ visual, alt, className, onFailure }: { visual: VehicleVisual; alt: string; className?: string; onFailure?: () => void }) {
  const element = useRef<HTMLElement & { src?: string; poster?: string }>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setReady(false);
    setFailed(false);
    if (!visual.modelPath) return;
    void loadModelViewer().catch(() => { if (active) { setFailed(true); onFailure?.(); } });
    return () => { active = false; };
  }, [visual.modelPath, onFailure]);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const onLoad = () => { setReady(true); setFailed(false); };
    const onError = () => { setFailed(true); setReady(false); onFailure?.(); };
    node.addEventListener('load', onLoad);
    node.addEventListener('error', onError);
    return () => { node.removeEventListener('load', onLoad); node.removeEventListener('error', onError); };
  }, [visual.modelPath, onFailure]);

  if (!visual.modelPath || failed) return null;
  return (
    <model-viewer
      ref={element as never}
      src={visual.modelPath}
      alt={alt}
      camera-controls=""
      disable-pan=""
      camera-orbit="145deg 75deg 100%"
      shadow-intensity="0.7"
      touch-action="pan-y"
      loading="lazy"
      reveal="auto"
      interaction-prompt="auto"
      poster={visual.posterPath ?? undefined}
      className={`transition-opacity duration-200 motion-reduce:transition-none ${className ?? ''}`}
      style={{ width: '100%', height: '100%', backgroundColor: 'transparent', opacity: ready ? 1 : 0 }}
      data-testid="vehicle-model"
    />
  );
}
