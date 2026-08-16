const express = require("express");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();

app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;

const KURDISH_TTS_URL =
  "https://www.kurdishtts.com/api/tts-proxy";

const SPEAKER_ID = "sorani_1070";
const MODEL_VERSION = "v4";

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Kurdish Sorani Vapi TTS Bridge",
    voice: SPEAKER_ID,
    model: MODEL_VERSION
  });
});

app.post("/api/synthesize", async (req, res) => {
  try {
    const message = req.body?.message;

    if (!message) {
      return res.status(400).json({
        error: "Missing message object"
      });
    }

    if (message.type !== "voice-request") {
      return res.status(400).json({
        error: "Invalid message type"
      });
    }

    const text = message.text;
    const sampleRate = Number(message.sampleRate);

    if (!text || typeof text !== "string") {
      return res.status(400).json({
        error: "Missing text"
      });
    }

    if (![8000, 16000, 22050, 24000].includes(sampleRate)) {
      return res.status(400).json({
        error: "Unsupported sample rate",
        sampleRate
      });
    }

    const apiKey = process.env.KURDISHTTS_TTS_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "KURDISHTTS_TTS_KEY is not configured"
      });
    }

    console.log(
      `Generating Sorani speech: "${text}" at ${sampleRate}Hz`
    );

    const ttsResponse = await fetch(KURDISH_TTS_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        speaker_id: SPEAKER_ID,
        model_version: MODEL_VERSION
      })
    });

    if (!ttsResponse.ok) {
      const errorText = await ttsResponse.text();

      console.error("KurdishTTS error:", errorText);

      return res.status(502).json({
        error: "KurdishTTS request failed",
        details: errorText
      });
    }

    const wavBuffer = Buffer.from(
      await ttsResponse.arrayBuffer()
    );

    const pcmBuffer = await wavToPcm(
      wavBuffer,
      sampleRate
    );

    res.setHeader(
      "Content-Type",
      "application/octet-stream"
    );

    res.setHeader(
      "Content-Length",
      pcmBuffer.length
    );

    res.status(200).send(pcmBuffer);

  } catch (error) {
    console.error("TTS bridge error:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: "TTS bridge failed",
        details: error.message
      });
    }
  }
});

function wavToPcm(wavBuffer, sampleRate) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",

      "-i",
      "pipe:0",

      "-ac",
      "1",

      "-ar",
      String(sampleRate),

      "-f",
      "s16le",

      "pipe:1"
    ]);

    const chunks = [];
    const errors = [];

    ffmpeg.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    ffmpeg.stderr.on("data", (chunk) => {
      errors.push(chunk);
    });

    ffmpeg.on("error", reject);

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            Buffer.concat(errors).toString() ||
            `FFmpeg exited with code ${code}`
          )
        );
      }

      resolve(Buffer.concat(chunks));
    });

    ffmpeg.stdin.end(wavBuffer);
  });
}

app.listen(PORT, () => {
  console.log(
    `Kurdish Vapi TTS bridge listening on port ${PORT}`
  );
});
