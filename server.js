const express = require("express");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();

app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;

// ================================================
// KURDISH TTS SETTINGS
// ================================================

const KURDISH_TTS_URL =
  "https://www.kurdishtts.com/api/tts-proxy";

const SPEAKER_ID = "986";
const MODEL_VERSION = "v4";

// ================================================
// KURDISH STT SETTINGS
// ================================================

const KURDISH_STT_CONNECT_URL =
  "https://www.kurdishtts.com/api/stt-stream-connect";

// ================================================
// HEALTH CHECK
// ================================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Kurdish Sorani Vapi TTS + STT Bridge",
    tts: {
      speaker: SPEAKER_ID,
      model: MODEL_VERSION
    },
    stt: {
      dialect: "sorani",
      sampleRate: 16000,
      format: "PCM16",
      channels: 1
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy"
  });
});

// ================================================
// TTS ENDPOINT
// ================================================

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
      `Generating Sorani speech at ${sampleRate}Hz: ${text}`
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

      console.error(
        "KurdishTTS error:",
        errorText
      );

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
    console.error(
      "TTS bridge error:",
      error
    );

    if (!res.headersSent) {
      res.status(500).json({
        error: "TTS bridge failed",
        details: error.message
      });
    }
  }
});

// ================================================
// CONVERT WAV TO PCM16
// ================================================

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

    ffmpeg.on("error", (error) => {
      reject(error);
    });

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

// ================================================
// CREATE HTTP SERVER
// ================================================

const server = http.createServer(app);

// ================================================
// WEBSOCKET SERVER FOR SORANI STT
// ================================================

const wss = new WebSocketServer({
  noServer: true
});

wss.on("connection", async (clientWs) => {
  console.log("STT client connected");

  const apiKey = process.env.KURDISHTTS_STT_KEY;

  if (!apiKey) {
    console.error(
      "KURDISHTTS_STT_KEY is not configured"
    );

    clientWs.send(
      JSON.stringify({
        error: "KURDISHTTS_STT_KEY is not configured"
      })
    );

    clientWs.close();
    return;
  }

  let sttWs;

  try {
    console.log(
      "Requesting KurdishTTS STT WebSocket URL..."
    );

    const connectResponse = await fetch(
      KURDISH_STT_CONNECT_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          dialect: "sorani"
        })
      }
    );

    if (!connectResponse.ok) {
      const errorText =
        await connectResponse.text();

      throw new Error(
        `STT connection request failed: ${errorText}`
      );
    }

    const connectData =
      await connectResponse.json();

    const websocketUrl =
      connectData.websocket_url;

    if (!websocketUrl) {
      throw new Error(
        "No websocket_url returned by KurdishTTS"
      );
    }

    console.log(
      "Connecting to KurdishTTS STT WebSocket..."
    );

    sttWs = new WebSocket(websocketUrl);

    sttWs.on("open", () => {
      console.log(
        "Connected to KurdishTTS STT"
      );

      if (
        clientWs.readyState === WebSocket.OPEN
      ) {
        clientWs.send(
          JSON.stringify({
            type: "ready",
            dialect: "sorani",
            sample_rate: 16000,
            format: "PCM16"
          })
        );
      }
    });

    // KurdishTTS -> Our client
    sttWs.on("message", (data) => {
      if (
        clientWs.readyState === WebSocket.OPEN
      ) {
        clientWs.send(data.toString());
      }
    });

    sttWs.on("error", (error) => {
      console.error(
        "KurdishTTS STT WebSocket error:",
        error.message
      );

      if (
        clientWs.readyState === WebSocket.OPEN
      ) {
        clientWs.send(
          JSON.stringify({
            error: error.message
          })
        );
      }
    });

    sttWs.on("close", (code, reason) => {
      console.log(
        `KurdishTTS STT connection closed: ${code} ${reason}`
      );

      if (
        clientWs.readyState === WebSocket.OPEN
      ) {
        clientWs.close();
      }
    });

    // Our client -> KurdishTTS
    clientWs.on("message", (data, isBinary) => {
      if (
        !sttWs ||
        sttWs.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      // Binary audio PCM16
      if (isBinary) {
        sttWs.send(data);
        return;
      }

      // Control messages
      try {
        const message = data.toString();

        sttWs.send(message);

        console.log(
          "Forwarded STT control message:",
          message
        );
      } catch (error) {
        console.error(
          "Error forwarding STT message:",
          error.message
        );
      }
    });

    clientWs.on("close", () => {
      console.log(
        "STT client disconnected"
      );

      if (
        sttWs &&
        sttWs.readyState === WebSocket.OPEN
      ) {
        sttWs.close();
      }
    });

    clientWs.on("error", (error) => {
      console.error(
        "STT client WebSocket error:",
        error.message
      );
    });

  } catch (error) {
    console.error(
      "STT bridge connection error:",
      error.message
    );

    if (
      clientWs.readyState === WebSocket.OPEN
    ) {
      clientWs.send(
        JSON.stringify({
          error: "STT bridge failed",
          details: error.message
        })
      );

      clientWs.close();
    }
  }
});

// ================================================
// WEBSOCKET UPGRADE
// ================================================

server.on("upgrade", (request, socket, head) => {
  const url = new URL(
    request.url,
    `http://${request.headers.host}`
  );

  if (url.pathname === "/api/stt") {
    wss.handleUpgrade(
      request,
      socket,
      head,
      (ws) => {
        wss.emit(
          "connection",
          ws,
          request
        );
      }
    );
  } else {
    socket.destroy();
  }
});

// ================================================
// START SERVER
// ================================================

server.listen(PORT, () => {
  console.log(
    `Kurdish Vapi TTS + STT bridge listening on port ${PORT}`
  );

  console.log(
    "HTTP health check: /"
  );

  console.log(
    "TTS endpoint: /api/synthesize"
  );

  console.log(
    "STT WebSocket: /api/stt"
  );
});
