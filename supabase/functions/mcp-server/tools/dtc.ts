import type { ToolDefinition } from "../index.ts";
import { lookupDtc, searchDtcs } from "../services/dtc.ts";

export const getDtcInfoTool: ToolDefinition = {
  name: "get_dtc_info",
  description: "Look up a Diagnostic Trouble Code (DTC) by its code (e.g. P0420, P0301). Returns code description, severity (minor/moderate/severe), category, likely causes, and repair difficulty. Use this when session flags reference a DTC code that needs explanation. Supports all standard P-codes, B-codes, C-codes, and U-codes.",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "The DTC code to look up (e.g. P0420, P0301, P0171). Case-insensitive." },
    },
    required: ["code"],
  },
  handler: async (_client: unknown, args: Record<string, unknown>, _userId?: string) => {
    const result = lookupDtc(args.code as string);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
};

export const searchDtcsTool: ToolDefinition = {
  name: "search_dtcs",
  description: "Search the DTC database by code, name, or description keyword. Returns matching codes with their details. Use this when you don't know the exact code but want to find codes related to a symptom or component.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query — matches against code, name, and description" },
    },
    required: ["query"],
  },
  handler: async (_client: unknown, args: Record<string, unknown>, _userId?: string) => {
    const results = searchDtcs(args.query as string);
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  },
};
