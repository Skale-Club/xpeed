import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { forget, loadSaved, setPinned, type SavedComparison } from '@/lib/sim/compare-recent';
import { useUserId } from '@/lib/sim/v1-client';
import { SavedChips } from '../compare/SavedChips';
import { Panel } from './parts';

/** The comparisons made lately and the saved ones (kept in this browser), so they open again from the overview. Nothing is drawn when there are none. */
export function ComparisonsPanel() {
  const { t } = useTranslation();
  const userId = useUserId();
  const [saved, setSaved] = useState<SavedComparison[]>(() => loadSaved(userId));
  useEffect(() => { setSaved(loadSaved(userId)); }, [userId]);
  if (saved.length === 0) return null;
  return (
    <Panel title={t('modes.overview.comparisons', 'Your comparisons')} testId="overview-comparisons">
      <SavedChips
        items={saved}
        a={null}
        b={null}
        hideTitle
        onPin={(item, pinned) => setSaved(setPinned(userId, saved, item, pinned))}
        onForget={(item) => setSaved(forget(userId, saved, item))}
      />
    </Panel>
  );
}
