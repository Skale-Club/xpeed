import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  getDefaultModel,
  getOpenRouterApiKey,
} from "../_shared/admin-config.ts";
import {
  consumeQuota,
  getServiceClient,
  getUserIdFromAuth,
  refundQuota,
} from "../_shared/quota.ts";
import { createReceiptHandler } from "../_shared/fuel-receipt-handler.ts";
import { AiProviderError, personalProviderFailure, resolveAiProvider } from "../_shared/ai-provider.ts";

serve(createReceiptHandler({
  authenticate: getUserIdFromAuth,
  async ownsCar(userId, carId) {
    const { data, error } = await getServiceClient().from("car_profiles")
      .select("id").eq("id", carId).eq("user_id", userId).maybeSingle();
    if (error) throw error;
    return !!data;
  },
  apiKey: getOpenRouterApiKey,
  model: getDefaultModel,
  async provider(userId) {
    const provider = await resolveAiProvider(getServiceClient(), userId);
    if (provider.source === 'personal' && Deno.env.get('NODE_ENV') !== 'production') throw new AiProviderError('development_disabled');
    return provider;
  },
  providerFailure: personalProviderFailure,
  consume: (userId) => consumeQuota(userId, "fuel_receipts"),
  refund: (userId) => refundQuota(userId, "fuel_receipts"),
  fetch,
}));
