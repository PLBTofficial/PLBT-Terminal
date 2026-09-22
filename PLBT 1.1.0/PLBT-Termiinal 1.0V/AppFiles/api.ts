import express from 'express';
import { GoogleGenAI } from '@google/genai';

export const apiRouter = express.Router();

// Lazy initialization of the Gemini client to avoid crashes if API key is not yet set
let aiInstance: GoogleGenAI | null = null;

function getAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured. Please add it to your secrets via the Settings menu.');
  }

  if (!aiInstance) {
    aiInstance = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiInstance;
}

// Endpoint to check if the Gemini API key is configured
apiRouter.get('/secrets-check', (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const isConfigured = !!apiKey && apiKey !== 'MY_GEMINI_API_KEY';
  res.json({ configured: isConfigured });
});

// Endpoint to handle prompt execution with custom configurations
apiRouter.post('/generate', async (req, res) => {
  const startTime = Date.now();
  try {
    const {
      prompt,
      systemInstruction,
      temperature,
      topP,
      maxOutputTokens,
      model = 'gemini-3.5-flash',
    } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'Prompt is required and must be a string.' });
      return;
    }

    const ai = getAIClient();

    // Prepare configuration object
    const config: any = {};

    if (systemInstruction) {
      config.systemInstruction = systemInstruction;
    }
    if (typeof temperature === 'number') {
      config.temperature = temperature;
    }
    if (typeof topP === 'number') {
      config.topP = topP;
    }
    if (typeof maxOutputTokens === 'number' && maxOutputTokens > 0) {
      config.maxOutputTokens = maxOutputTokens;
    }

    // Call Gemini API using recommended format
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config,
    });

    const duration = Date.now() - startTime;

    res.json({
      text: response.text || '(No response text generated)',
      duration,
      modelUsed: model,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Gemini API Error:', error);
    res.status(500).json({
      error: error.message || 'An error occurred while generating content from Gemini.',
      details: error.stack || undefined,
    });
  }
});

// Express middleware for dev server integration
export const expressMiddleware = express.json();
apiRouter.use(expressMiddleware);
