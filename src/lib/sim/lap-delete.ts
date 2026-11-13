// Deleting laps from the account: the server forgets them (and recomputes the session, the personal best and the totals), the
// cached copy is dropped and every list derived from them is read again.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { forgetLaps } from '@/lib/sim/library';
import { lapFileKey } from '@/lib/sim/use-lap-file';
import { V1Error, invalidateAfterDelete, lapPath, v1Delete } from '@/lib/sim/v1-client';

/** How many deletions run at once: a session can have a few hundred laps, and the server answers each in turn. */
const AT_ONCE = 4;

export interface DeleteResult {
  deleted: string[];
  /** The laps that could not be deleted, with why. */
  failed: Array<{ id: string; error: V1Error }>;
}

/** Deletes laps (a lap already gone counts as deleted). Never throws: what failed is in the result. */
export async function deleteLaps(userId: string, ids: readonly string[]): Promise<DeleteResult> {
  const result: DeleteResult = { deleted: [], failed: [] };
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        await v1Delete(lapPath(id));
        result.deleted.push(id);
      } catch (error) {
        if (error instanceof V1Error && error.code === 'lap_not_found') result.deleted.push(id);
        else result.failed.push({ id, error: error instanceof V1Error ? error : new V1Error(0, 'network', true) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, ids.length) }, worker));
  await forgetLaps(userId, result.deleted);
  return result;
}

/** Deletes laps and refreshes everything that was computed from them. Resolves with what was deleted and what failed. */
export function useDeleteLaps() {
  const client = useQueryClient();
  const userId = useAuth().user?.id ?? null;
  return useMutation({
    mutationFn: async (ids: readonly string[]): Promise<DeleteResult> =>
      userId ? deleteLaps(userId, ids) : { deleted: [], failed: ids.map((id) => ({ id, error: new V1Error(401, 'unauthorized', false) })) },
    onSettled: (_result, _error, ids) => {
      // The loaded samples of a deleted lap go too, or a screen that still holds the lap would keep showing it.
      for (const id of ids) client.removeQueries({ queryKey: lapFileKey(userId, id) });
      return invalidateAfterDelete(client, userId);
    },
  });
}
