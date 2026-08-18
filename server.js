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

const SPEAKER_ID = "sorani_986";
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

// ================================================
// CONVERT KURDISHTTS STT RESPONSE TO VAPI FORMAT
// ================================================

function sendTranscriptToVapi(clientWs, rawData) {
  try {

    const rawText = rawData.toString();

    console.log(
      "KurdishTTS STT raw response:",
      rawText
    );

    let data;

    try {
      data = JSON.parse(rawText);
    } catch {
      console.log(
        "STT response was not JSON, ignoring:",
        rawText
      );
      return;
    }

    // Ignore empty responses
    if (data.error) {
      console.error(
        "KurdishTTS STT error:",
        data.error
      );
      return;
    }

    // Try multiple possible text fields
    const transcription =
      data.text ||
      data.transcript ||
      data.transcription ||
      data.result?.text ||
      data.result?.transcript ||
      data.result?.transcription ||
      "";

    if (
      !transcription ||
      typeof transcription !== "string" ||
      !transcription.trim()
    ) {
      console.log(
        "No transcript text found in STT response"
      );
      return;
    }

    // Detect whether KurdishTTS says this is final
    const isFinal =
      data.is_final === true ||
      data.isFinal === true ||
      data.final === true ||
      data.type === "final" ||
      data.type === "final_transcript" ||
      data.event === "final" ||
      data.result?.is_final === true ||
      data.result?.isFinal === true ||
      data.result?.final === true;

    const vapiMessage = {
      type: "transcriber-response",
      transcription: transcription.trim(),
      channel: "customer",
      transcriptType: isFinal
        ? "final"
        : "partial"
    };

    console.log(
      "Sending transcript to Vapi:",
      JSON.stringify(vapiMessage)
    );

    if (
      clientWs.readyState === WebSocket.OPEN
    ) {
      clientWs.send(
        JSON.stringify(vapiMessage)
      );
    }

  } catch (error) {
    console.error(
      "Error converting STT response for Vapi:",
      error.message
    );
  }
}

// ================================================
// STT WEBSOCKET CONNECTION
// ================================================

wss.on("connection", async (clientWs) => {

  console.log(
    "Vapi STT client connected"
  );

  const apiKey =
    process.env.KURDISHTTS_STT_KEY;

  if (!apiKey) {

    console.error(
      "KURDISHTTS_STT_KEY is not configured"
    );

    if (
      clientWs.readyState === WebSocket.OPEN
    ) {
      clientWs.send(
        JSON.stringify({
          error:
            "KURDISHTTS_STT_KEY is not configured"
        })
      );
    }

    clientWs.close();
    return;
  }

  let sttWs = null;
  let clientClosed = false;

  try {

    // ================================================
    // REQUEST TEMPORARY KURDISHTTS WEBSOCKET URL
    // ================================================

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

    console.log(
      "KurdishTTS STT connection response:",
      JSON.stringify(connectData)
    );

    const websocketUrl =
      connectData.websocket_url ||
      connectData.websocketUrl ||
      connectData.url;

    if (!websocketUrl) {
      throw new Error(
        "No websocket URL returned by KurdishTTS"
      );
    }

    // ================================================
    // CONNECT TO KURDISHTTS STT
    // ================================================

    console.log(
      "Connecting to KurdishTTS STT WebSocket..."
    );

    sttWs = new WebSocket(websocketUrl);

    sttWs.on("open", () => {

      console.log(
        "Connected to KurdishTTS STT"
      );

      // Tell Vapi our STT bridge is ready
      if (
        clientWs.readyState === WebSocket.OPEN
      ) {

        const readyMessage = {
          type: "ready",
          dialect: "sorani",
          sample_rate: 16000,
          format: "PCM16"
        };

        console.log(
          "STT bridge ready"
        );

        clientWs.send(
          JSON.stringify(readyMessage)
        );
      }
    });

    // ================================================
    // KURDISHTTS -> VAPI
    // ================================================

    sttWs.on("message", (data) => {

      sendTranscriptToVapi(
        clientWs,
        data
      );

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

    sttWs.on(
      "close",
      (code, reason) => {

        console.log(
          `KurdishTTS STT connection closed: ${code} ${reason.toString()}`
        );

        // Do not close twice
        if (
          !clientClosed &&
          clientWs.readyState === WebSocket.OPEN
        ) {
          clientWs.close();
        }
      }
    );

    // ================================================
    // VAPI -> KURDISHTTS
    // ================================================

    clientWs.on(
      "message",
      (data, isBinary) => {

        if (
          !sttWs ||
          sttWs.readyState !== WebSocket.OPEN
        ) {
          console.log(
            "STT audio received before KurdishTTS connection was ready"
          );
          return;
        }

        // ================================================
        // AUDIO DATA
        // ================================================

        if (isBinary) {

          console.log(
            `Forwarding PCM16 audio to KurdishTTS: ${data.length} bytes`
          );

          sttWs.send(
            data,
            { binary: true }
          );

          return;
        }

        // ================================================
        // CONTROL MESSAGE
        // ================================================

        try {

          const message =
            data.toString();

          console.log(
            "Vapi STT control message:",
            message
          );

          // Forward control messages unchanged
          sttWs.send(message);

        } catch (error) {

          console.error(
            "Error forwarding STT control message:",
            error.message
          );
        }
      }
    );

    // ================================================
    // CLIENT CLOSE
    // ================================================

    clientWs.on("close", () => {

      clientClosed = true;

      console.log(
        "Vapi STT client disconnected"
      );

      if (
        sttWs &&
        (
          sttWs.readyState === WebSocket.OPEN ||
          sttWs.readyState === WebSocket.CONNECTING
        )
      ) {

        try {
          sttWs.close();
        } catch (error) {
          console.error(
            "Error closing KurdishTTS STT socket:",
            error.message
          );
        }
      }
    });

    clientWs.on("error", (error) => {

      console.error(
        "Vapi STT client WebSocket error:",
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

server.on(
  "upgrade",
  (request, socket, head) => {

    const url = new URL(
      request.url,
      `http://${request.headers.host}`
    );

    if (
      url.pathname === "/api/stt"
    ) {

      console.log(
        "Incoming STT WebSocket connection"
      );

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

      console.log(
        `Rejected WebSocket path: ${url.pathname}`
      );

      socket.destroy();
    }
  }
);

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

  console.log(
    `TTS speaker: ${SPEAKER_ID}`
  );

  console.log(
    `TTS model: ${MODEL_VERSION}`
  );

  console.log(
    "STT dialect: sorani"
  );
});
