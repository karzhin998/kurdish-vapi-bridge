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

const STT_DIALECT = "sorani";
const REQUIRED_STT_SAMPLE_RATE = 16000;
const REQUIRED_STT_CHANNELS = 1;

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
      dialect: STT_DIALECT,
      sampleRate: REQUIRED_STT_SAMPLE_RATE,
      format: "PCM16",
      channels: REQUIRED_STT_CHANNELS
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
// EXTRACT CUSTOMER CHANNEL
//
// VAPI can send stereo PCM:
//
// Channel 0 = customer
// Channel 1 = assistant
//
// KurdishTTS requires mono audio.
//
// This extracts channel 0 only.
// ================================================

function extractCustomerChannelPcm16(
  audioData,
  channels
) {
  const input = Buffer.from(audioData);

  // Already mono
  if (channels === 1) {
    return input;
  }

  // PCM16 = 2 bytes per sample
  const bytesPerSample = 2;
  const bytesPerFrame =
    channels * bytesPerSample;

  // Remove incomplete frame if necessary
  const validLength =
    input.length -
    (input.length % bytesPerFrame);

  if (validLength <= 0) {
    return Buffer.alloc(0);
  }

  const frameCount =
    validLength / bytesPerFrame;

  // Output is mono:
  // 2 bytes for every frame
  const output = Buffer.alloc(
    frameCount * bytesPerSample
  );

  let outputOffset = 0;

  for (
    let inputOffset = 0;
    inputOffset < validLength;
    inputOffset += bytesPerFrame
  ) {
    // Copy customer channel = channel 0
    output[outputOffset] =
      input[inputOffset];

    output[outputOffset + 1] =
      input[inputOffset + 1];

    outputOffset += bytesPerSample;
  }

  return output;
}

// ================================================
// CONVERT KURDISHTTS STT RESPONSE
// TO VAPI FORMAT
// ================================================

function sendTranscriptToVapi(
  clientWs,
  rawData
) {
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

    // KurdishTTS control response
    if (
      data.type === "control" &&
      data.event === "done"
    ) {
      console.log(
        "KurdishTTS STT finalized"
      );
      return;
    }

    // Error response
    if (data.error) {
      console.error(
        "KurdishTTS STT error:",
        data.error
      );
      return;
    }

    // KurdishTTS normally sends:
    // {
    //   text: "...",
    //   is_final: true/false
    // }

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
      return;
    }

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

wss.on(
  "connection",
  async (clientWs) => {

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
    let finalized = false;

    // VAPI audio information
    let vapiSampleRate = null;
    let vapiChannels = 1;
    let vapiEncoding = null;
    let vapiStarted = false;

    // ================================================
    // FINALIZE KURDISHTTS STT
    // ================================================

    function finalizeKurdishStt() {

      if (finalized) {
        return;
      }

      finalized = true;

      if (
        sttWs &&
        sttWs.readyState === WebSocket.OPEN
      ) {

        console.log(
          "Sending finalize to KurdishTTS"
        );

        try {
          sttWs.send(
            JSON.stringify({
              type: "control",
              event: "finalize"
            })
          );
        } catch (error) {
          console.error(
            "Error finalizing KurdishTTS:",
            error.message
          );
        }
      }
    }

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
            dialect: STT_DIALECT
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
        "KurdishTTS STT connection established"
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

      sttWs = new WebSocket(
        websocketUrl
      );

      sttWs.on(
        "open",
        () => {

          console.log(
            "Connected to KurdishTTS STT"
          );

          // We do NOT send a fake VAPI-ready
          // control message to KurdishTTS.
          //
          // We wait for VAPI's real "start" message
          // so we know the actual audio format.
        }
      );

      // ================================================
      // KURDISHTTS -> VAPI
      // ================================================

      sttWs.on(
        "message",
        (data) => {

          sendTranscriptToVapi(
            clientWs,
            data
          );
        }
      );

      sttWs.on(
        "error",
        (error) => {

          console.error(
            "KurdishTTS STT WebSocket error:",
            error.message
          );

          if (
            clientWs.readyState === WebSocket.OPEN
          ) {
            clientWs.send(
              JSON.stringify({
                type: "error",
                error:
                  "KurdishTTS STT connection error"
              })
            );
          }
        }
      );

      sttWs.on(
        "close",
        (code, reason) => {

          console.log(
            `KurdishTTS STT connection closed: ${code} ${reason.toString()}`
          );

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

          // --------------------------------------------
          // BINARY AUDIO
          // --------------------------------------------

          if (isBinary) {

            if (
              !sttWs ||
              sttWs.readyState !== WebSocket.OPEN
            ) {
              console.log(
                "Audio received before KurdishTTS was ready"
              );
              return;
            }

            if (!vapiStarted) {
              console.log(
                "Audio received before VAPI start message"
              );
              return;
            }

            // KurdishTTS requires:
            // PCM16 / mono / 16000 Hz

            if (
              vapiSampleRate !==
              REQUIRED_STT_SAMPLE_RATE
            ) {
              console.error(
                `Unsupported VAPI sample rate for KurdishTTS: ${vapiSampleRate}. Expected ${REQUIRED_STT_SAMPLE_RATE}`
              );
              return;
            }

            const monoAudio =
              extractCustomerChannelPcm16(
                data,
                vapiChannels
              );

            if (monoAudio.length === 0) {
              return;
            }

            console.log(
              `Forwarding customer audio only: ${data.length} bytes -> ${monoAudio.length} bytes, input channels: ${vapiChannels}`
            );

            try {
              sttWs.send(
                monoAudio,
                { binary: true }
              );
            } catch (error) {
              console.error(
                "Error forwarding audio:",
                error.message
              );
            }

            return;
          }

          // --------------------------------------------
          // JSON / CONTROL MESSAGE FROM VAPI
          // --------------------------------------------

          let message;

          try {
            message = JSON.parse(
              data.toString()
            );
          } catch {
            console.log(
              "Non-JSON text message from VAPI, ignoring:",
              data.toString()
            );
            return;
          }

          console.log(
            "Vapi STT message:",
            JSON.stringify(message)
          );

          // ============================================
          // VAPI START
          // ============================================

          if (message.type === "start") {

            vapiEncoding =
              message.encoding;

            vapiSampleRate =
              Number(message.sampleRate);

            vapiChannels =
              Number(message.channels) || 1;

            vapiStarted = true;

            console.log(
              "VAPI audio configuration:",
              JSON.stringify({
                encoding: vapiEncoding,
                sampleRate: vapiSampleRate,
                channels: vapiChannels,
                container:
                  message.container
              })
            );

            // Validate format

            const validEncoding =
              !vapiEncoding ||
              vapiEncoding === "linear16" ||
              vapiEncoding === "pcm_s16le";

            if (!validEncoding) {
              console.error(
                `Unsupported VAPI encoding: ${vapiEncoding}`
              );
            }

            if (
              vapiSampleRate !==
              REQUIRED_STT_SAMPLE_RATE
            ) {
              console.error(
                `VAPI sample rate is ${vapiSampleRate}. KurdishTTS requires ${REQUIRED_STT_SAMPLE_RATE}.`
              );
            }

            // IMPORTANT:
            // Do NOT forward VAPI's "start" message
            // to KurdishTTS.
            //
            // KurdishTTS expects raw PCM audio
            // and its own finalize control message.

            return;
          }

          // ============================================
          // FINALIZE
          // ============================================

          if (
            message.type === "control" &&
            message.event === "finalize"
          ) {

            finalizeKurdishStt();
            return;
          }

          // Some systems may send stop/end messages.
          // Finalize KurdishTTS so it flushes the final
          // transcript.

          if (
            message.type === "stop" ||
            message.type === "end"
          ) {

            finalizeKurdishStt();
            return;
          }

          // Do not blindly forward other VAPI messages
          // to KurdishTTS.
        }
      );

      // ================================================
      // CLIENT CLOSE
      // ================================================

      clientWs.on(
        "close",
        () => {

          clientClosed = true;

          console.log(
            "Vapi STT client disconnected"
          );

          // Ask KurdishTTS to flush the final
          // transcript before closing.
          finalizeKurdishStt();

          // Give finalize a short time to complete.
          setTimeout(
            () => {

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

            },
            500
          );
        }
      );

      clientWs.on(
        "error",
        (error) => {

          console.error(
            "Vapi STT client WebSocket error:",
            error.message
          );
        }
      );

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
            type: "error",
            error: "STT bridge failed",
            details: error.message
          })
        );

        clientWs.close();
      }
    }
  }
);

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

server.listen(
  PORT,
  () => {

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
      `STT dialect: ${STT_DIALECT}`
    );

    console.log(
      `STT required audio: PCM16 mono ${REQUIRED_STT_SAMPLE_RATE}Hz`
    );
  }
);
