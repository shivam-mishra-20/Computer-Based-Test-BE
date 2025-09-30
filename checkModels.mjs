import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

if (!GOOGLE_API_KEY) {
  throw new Error("Gemini API key not configured");
}

const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);

async function listAvailableModels() {
  try {
    console.log("Fetching available models...");

    // The listModels() function returns an async iterator directly.
    const models = genAI.listModels();

    console.log("--- Available Models (that support generateContent) ---");
    for await (const m of models) {
      if (m.supportedGenerationMethods.includes('generateContent')) {
        console.log(m.name);
      }
    }
    console.log("---------------------------------------------------------");

  } catch (error) {
    console.error("Error listing models:", error);
  }
}

listAvailableModels();