import { z } from "npm:zod@3.23.8";

const AnalysisSchema = z.object({
  summary: z.string().trim().min(1).max(6000),
  key_findings: z.array(z.string().max(1500)).max(8),
  recommended_action: z.string().max(3000),
});

export function parseAnalysisResponse(text: string) {
  try {
    const raw: unknown = JSON.parse(text);
    const parsed = AnalysisSchema.safeParse(raw);
    return parsed.success ? { ...parsed.data, rawWarnings: (raw as Record<string, unknown>).warnings } : null;
  } catch { return null; }
}
