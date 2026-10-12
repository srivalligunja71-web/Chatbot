import { Router, type IRouter } from "express";
import { SendChatMessageBody } from "@workspace/api-zod";

const router: IRouter = Router();
const GEMINI_STREAM_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse";

type GeminiPart = {
  text?: string;
};

type GeminiStreamEvent = {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
};

router.post("/chat", async (req, res): Promise<void> => {
  const parsed = SendChatMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please send a valid chat message." });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error: "Gemini is not configured. Add GEMINI_API_KEY in Replit Secrets.",
    });
    return;
  }

  try {
    const upstream = await fetch(GEMINI_STREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: "You are a helpful, thoughtful assistant. Answer clearly and accurately. If you are unsure, say so.",
            },
          ],
        },
        contents: parsed.data.messages.map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }],
        })),
        generationConfig: { maxOutputTokens: 8192 },
      }),
    });

    if (!upstream.ok || !upstream.body) {
      req.log.error(
        { upstreamStatus: upstream.status },
        "Gemini chat request failed",
      );
      res.status(502).json({
        error:
          upstream.status === 429
            ? "Gemini is busy right now. Please try again shortly."
            : "The assistant could not respond. Please try again.",
      });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let clientDisconnected = false;
    res.on("close", () => {
      clientDisconnected = true;
      void reader.cancel().catch(() => undefined);
    });

    const sendEvent = (data: string) => {
      if (!data || clientDisconnected || res.writableEnded) return;

      let event: GeminiStreamEvent;
      try {
        event = JSON.parse(data) as GeminiStreamEvent;
      } catch {
        return;
      }

      for (const part of event.candidates?.[0]?.content?.parts ?? []) {
        if (part.text) {
          res.write(`data: ${JSON.stringify({ content: part.text })}\n\n`);
        }
      }
    };

    try {
      while (!clientDisconnected) {
        const { value, done } = await reader.read();
        if (done) break;

        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            sendEvent(line.slice(5).trim());
          }
        }
      }

      const remaining = `${pending}${decoder.decode()}`.trim();
      if (remaining.startsWith("data:")) {
        sendEvent(remaining.slice(5).trim());
      }

      if (!clientDisconnected && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    req.log.error({ err: error }, "Gemini chat request failed");
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ error: "The response was interrupted." })}\n\n`,
        );
        res.end();
      }
      return;
    }

    res.status(502).json({
      error: "The assistant could not respond. Please try again.",
    });
  }
});

export default router;
