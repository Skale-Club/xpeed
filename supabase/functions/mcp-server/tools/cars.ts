import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ToolDefinition } from "../index.ts";
import { listCars, getCar } from "../services/cars.ts";

export const listCarsTool: ToolDefinition = {
  name: "list_cars",
  description: "List all car profiles for the authenticated user. Returns an array of cars with their name, make, model, year, and VIN. Use this to get a list of cars before calling other car-specific tools.",
  inputSchema: { type: "object", properties: {}, required: [] },
  handler: async (client: SupabaseClient, _args: Record<string, unknown>, userId?: string) => {
    const cars = await listCars(client, userId);
    return { content: [{ type: "text", text: JSON.stringify(cars, null, 2) }] };
  },
};

export const getCarTool: ToolDefinition = {
  name: "get_car",
  description: "Get detailed information about a specific car profile by its ID. Returns name, make, model, year, VIN, engine type, and notes. Use this AFTER list_cars to get full details on a specific vehicle.",
  inputSchema: {
    type: "object",
    properties: { car_id: { type: "string", description: "The ID of the car profile to retrieve" } },
    required: ["car_id"],
  },
  handler: async (client: SupabaseClient, args: Record<string, unknown>, userId?: string) => {
    const car = await getCar(client, args.car_id as string, userId);
    if (!car) {
      return { content: [{ type: "text", text: "Car not found. Check the car_id and ensure it belongs to your account." }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(car, null, 2) }] };
  },
};
