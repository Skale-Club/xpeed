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
  consume: (userId) => consumeQuota(userId, "fuel_receipts"),
  refund: (userId) => refundQuota(userId, "fuel_receipts"),
  fetch,
}));
