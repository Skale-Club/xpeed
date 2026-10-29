import { supabase } from '@/integrations/supabase/client';
import { publicAppUrl } from './trips';
import type { VehicleCareRecord } from './vehicle-care';
export async function vehicleCareRequest(carId: string, record?: VehicleCareRecord): Promise<VehicleCareRecord> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw Error('Sign in to manage maintenance');
  const response = await fetch(`${publicAppUrl()}/api/vehicle-care?carId=${encodeURIComponent(carId)}`, {
    method: record ? 'PUT' : 'GET', cache: 'no-store', headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
    ...(record ? { body: JSON.stringify({ state: record.state, revision: record.revision }) } : {}),
  });
  if (!response.ok) throw Error(response.status === 409 ? 'changed_reload' : 'care_request_failed');
  return response.json();
}
