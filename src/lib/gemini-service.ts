import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Interface for session data to be analyzed by Gemini
 */
export interface SessionAnalysisData {
    filename: string;
    rowCount: number;
    durationSeconds?: number;
    summaries: Record<string, {
        count: number;
        min: number;
        max: number;
        avg: number;
    }>;
    flags: Array<{
        severity: string;
        message: string;
        canonical_key: string;
    }>;
}

/**
 * Interface for Gemini analysis result
 */
export interface GeminiAnalysis {
    summary: string;
    insights: string[];
    recommendations: string[];
    timestamp: string;
}

/**
 * Analyzes OBD2 session data using Google Gemini API
 */
export async function analyzeSession(
    apiKey: string,
    sessionData: SessionAnalysisData,
    modelName: string = 'gemini-2.5-flash'
): Promise<GeminiAnalysis> {
    if (!apiKey) {
        throw new Error('Gemini API key is required');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    // Build analysis prompt
    const prompt = buildAnalysisPrompt(sessionData);

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        // Parse the structured response
        return parseGeminiResponse(text);
    } catch (error) {
        console.error('Gemini API error:', error);
        throw new Error(`Failed to analyze session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Sends a chat message to Gemini with vehicle context
 */
export async function chatWithVehicleData(
    apiKey: string,
    history: { role: 'user' | 'model'; parts: string }[],
    message: string,
    context: Record<string, unknown>,
    modelName: string = 'gemini-2.5-flash'
): Promise<string> {
    if (!apiKey) {
        throw new Error('Gemini API key is required');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const systemPrompt = `You are Car Insights AI, an expert automotive assistant.
You have access to the following vehicle data context:
${JSON.stringify(context, null, 2)}

Answer the user's questions based on this data. Be concise, helpful, and friendly.
If the answer isn't in the data, use your general automotive knowledge but clarify that it's general advice.
Always prioritize safety and recommend professional inspection for serious issues.`;

    const chat = model.startChat({
        history: [
            {
                role: 'user',
                parts: [{ text: systemPrompt }]
            },
            {
                role: 'model',
                parts: [{ text: 'Understood. I am ready to answer questions about the vehicle based on the provided data.' }]
            },
            ...history.map(h => ({
                role: h.role,
                parts: [{ text: h.parts }]
            }))
        ]
    });

    try {
        const result = await chat.sendMessage(message);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error('Gemini Chat error:', error);
        throw new Error('Failed to send message');
    }
}

/**
 * Validates if a Gemini API key is functional
 */
export async function validateApiKey(apiKey: string, modelName: string = 'gemini-2.0-flash'): Promise<boolean> {
    if (!apiKey || apiKey.trim().length === 0) {
        return false;
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: modelName });

        // Simple test prompt
        const result = await model.generateContent('Respond with OK');
        const response = await result.response;
        const text = response.text();

        return text.length > 0;
    } catch (error) {
        console.error('API key validation failed:', error);
        return false;
    }
}

/**
 * Builds the analysis prompt for Gemini
 */
function buildAnalysisPrompt(data: SessionAnalysisData): string {
    const flagsList = data.flags.length > 0
        ? data.flags.map(f => `- [${f.severity.toUpperCase()}] ${f.message}`).join('\n')
        : 'No flags detected';

    const parametersList = Object.entries(data.summaries)
        .slice(0, 10) // Top 10 parameters
        .map(([key, summary]) =>
            `- ${key}: min=${summary.min.toFixed(2)}, max=${summary.max.toFixed(2)}, avg=${summary.avg.toFixed(2)}`
        )
        .join('\n');

    return `You are an expert automotive diagnostician analyzing OBD2 data.
Your goal is to identify anomalies without relying solely on pre-defined flags, as the user relies on your expertise to interpret the raw parameter data.

SESSION INFORMATION:
- File: ${data.filename}
- Data Points: ${data.rowCount}
- Duration: ${data.durationSeconds ? `${data.durationSeconds} seconds` : 'Unknown'}

KEY PARAMETERS (Min/Max/Avg):
${parametersList}

SYSTEM DETECTED FLAGS (Automated checks):
${flagsList}

Please provide a comprehensive diagnostic report in the following JSON format:
{
  "summary": "Executive summary of the vehicle's health (2-3 sentences). be direct.",
  "insights": [
    "Insight 1: Explain WHAT is happening",
    "Insight 2: Explain WHY it matters",
    "Insight 3: Connect multiple parameters if relevant"
  ],
  "recommendations": [
    "Actionable step 1",
    "Actionable step 2"
  ]
}

ANALYSIS GUIDELINES:
1. **Evaluate Raw Data**: Look at the Min/Max/Avg values in "KEY PARAMETERS". Even if no flag was raised, are these values within healthy ranges for a typical modern vehicle (or hybrid if applicable)?
2. **Contextualize Flags**: If flags are present, explain them in plain language.
3. **Hybrid Awareness**: If you see parameters like "State of Charge" or "Inverter Temp", apply hybrid-specific knowledge (e.g., Toyota Prius context).
4. **Be Proactive**: If a value is borderline (e.g., Coolant at 100°C), mention it even if it's not "Critical" yet.

Respond ONLY with valid JSON.`;
}

/**
 * Parses Gemini's response into structured data
 */
function parseGeminiResponse(text: string): GeminiAnalysis {
    try {
        // Remove markdown code blocks if present
        let cleanText = text.trim();
        if (cleanText.startsWith('```json')) {
            cleanText = cleanText.replace(/```json\n?/g, '').replace(/```\n?$/g, '');
        } else if (cleanText.startsWith('```')) {
            cleanText = cleanText.replace(/```\n?/g, '');
        }

        const parsed = JSON.parse(cleanText);

        return {
            summary: parsed.summary || 'No summary available',
            insights: Array.isArray(parsed.insights) ? parsed.insights : [],
            recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
            timestamp: new Date().toISOString(),
        };
    } catch (error) {
        console.error('Failed to parse Gemini response:', error);
        console.error('Raw response:', text);

        // Fallback: return raw text as summary
        return {
            summary: text.substring(0, 500),
            insights: [],
            recommendations: [],
            timestamp: new Date().toISOString(),
        };
    }
}
