import { parseAnalysisResponse } from "./analysis-response.ts";
const valid = { summary: "Trip checked.", key_findings: ["Engine running hot"], recommended_action: "Stop somewhere safe." };
Deno.test("accepts the current trip analysis contract", () => {
  const result = parseAnalysisResponse(JSON.stringify(valid));
  if (result?.summary !== valid.summary || result.key_findings[0] !== valid.key_findings[0]) throw new Error("Lost analysis fields");
});
Deno.test("rejects malformed, empty and partial answers", () => {
  for (const input of ["bad JSON", "null", "{}", JSON.stringify({ ...valid, summary: " " }), JSON.stringify({ ...valid, key_findings: [null] })]) {
    if (parseAnalysisResponse(input) !== null) throw new Error(`Accepted invalid answer: ${input}`);
  }
});
Deno.test("bounds provider output before it is accepted", () => {
  for (const input of [{...valid,summary:"x".repeat(6001)}, {...valid,key_findings:Array(9).fill("x")}, {...valid,recommended_action:"x".repeat(3001)}]) {
    if (parseAnalysisResponse(JSON.stringify(input)) !== null) throw new Error("Accepted oversized answer");
  }
});
