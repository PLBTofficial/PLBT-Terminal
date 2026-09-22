import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "10mb" }));

// API endpoint for AI Trader Error Analysis
app.post("/api/ai-analyze-errors", async (req, res) => {
  try {
    const { payload, systemPrompt } = req.body;
    if (!payload || !systemPrompt) {
      return res.status(400).json({ error: "Необходимы параметры payload и systemPrompt" });
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Переменная окружения GEMINI_API_KEY не задана. Укажите ключ в настройках." });
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
    const modelName = req.body.model || "gemini-3.6-pro";
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [
        {
          role: "user",
          parts: [{ text: `Данные сделок и эмоционального журнала пользователя для анализа:\n${payload}` }]
        }
      ],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        temperature: 0.35,
        maxOutputTokens: 3000
      }
    });

    const text = response.text || "";
    const usageMetadata = response.usageMetadata || {};

    return res.json({
      text,
      usage: {
        input_tokens: usageMetadata.promptTokenCount || 0,
        output_tokens: usageMetadata.candidatesTokenCount || 0,
        total_tokens: usageMetadata.totalTokenCount || 0
      }
    });
  } catch (err: any) {
    console.error("[Server Error] Gemini API analyze errors failed:", err);
    return res.status(500).json({ error: err?.message || "Внутренняя ошибка при обращении к AI сервису." });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
