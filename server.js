const express = require("express");
const http = require("http");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

// =====================================================
// KURDISH TTS
// =====================================================

// Uses Railway variable if you set one.
// Otherwise uses the KurdishTTS endpoint directly.
const KURDISH_TTS_URL =
  process.env.KURDISH_TTS_URL ||
  "https://www.kurdishtts.com/api/tts-proxy";

const SPEAKER_ID =
  process.env.KURDISHTTS_SPEAKER_ID ||
  "sorani_986";

const MODEL_VERSION =
  process.env.KURDISHTTS_MODEL_VERSION ||
  "v4";

// =====================================================
// KURDISH STT
// =====================================================

const KURDISH_STT_CONNECT_URL =
  process.env.KURDISH_STT_CONNECT_URL ||
  "https://www.kurdishtts.com/api/stt-stream-connect";

const STT_DIALECT = "sorani";

const REQUIRED_STT_SAMPLE_RATE = 16000;
const REQUIRED_STT_CHANNELS = 1;

const MAX_PENDING_AUDIO_BYTES =
  10 * 1024 * 1024;

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Kurdish Sorani Vapi TTS + STT Bridge",

    tts: {
      enabled: true,
      urlConfigured: !!KURDISH_TTS_URL,
      keyConfigured: !!process.env.KURDISHTTS_TTS_KEY,
      speaker: SPEAKER_ID,
      model: MODEL_VERSION
    },

    stt: {
      enabled: true,
      urlConfigured: !!KURDISH_STT_CONNECT_URL,
      keyConfigured: !!process.env.KURDISHTTS_STT_KEY,
      dialect: STT_DIALECT,
      requiredFormat: "PCM16",
      requiredSampleRate: REQUIRED_STT_SAMPLE_RATE,
      requiredChannels: REQUIRED_STT_CHANNELS
    }
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy"
  });
});

// =====================================================
// TTS
// =====================================================

app.post("/api/synthesize", async (req, res) => {
  try {
    // Supports Vapi's normal nested message format.
    const message = req.body?.message || req.body;

    const messageType =
      message?.type ||
      req.body?.message?.type;

    if (
      messageType &&
      messageType !== "voice-request"
    ) {
      console.log(
        "[TTS] Received type:",
        messageType
      );
    }

    const text =
      typeof message?.text === "string"
        ? message.text.trim()
        : "";

    const requestedSampleRate =
      Number(message?.sampleRate) ||
      16000;

    if (!text) {
      console.error(
        "[TTS] ERROR: Missing text"
      );

      return res.status(400).json({
        error: "Missing text"
      });
    }

    const allowedSampleRates = [
      8000,
      16000,
      22050,
      24000,
      44100,
      48000
    ];

    if (
      !allowedSampleRates.includes(
        requestedSampleRate
      )
    ) {
      return res.status(400).json({
        error: "Unsupported sample rate",
        sampleRate: requestedSampleRate
      });
    }

    const apiKey =
      process.env.KURDISHTTS_TTS_KEY;

    if (!apiKey) {
      console.error(
        "[TTS] ERROR: KURDISHTTS_TTS_KEY missing"
      );

      return res.status(500).json({
        error:
          "KURDISHTTS_TTS_KEY is not configured"
      });
    }

    console.log("========================================");
    console.log("[TTS] REQUEST RECEIVED");
    console.log(
      `[TTS] Rate: ${requestedSampleRate}Hz`
    );
    console.log(
      `[TTS] Speaker: ${SPEAKER_ID}`
    );
    console.log(
      `[TTS] Model: ${MODEL_VERSION}`
    );
    console.log(
      `[TTS] Text: ${text}`
    );
    console.log("========================================");

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        30000
      );

    let ttsResponse;

    try {
      ttsResponse = await fetch(
        KURDISH_TTS_URL,
        {
          method: "POST",

          headers: {
            "x-api-key": apiKey,
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            text,
            speaker_id: SPEAKER_ID,
            model_version: MODEL_VERSION
          }),

          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    console.log(
      `[TTS] KurdishTTS HTTP status: ${ttsResponse.status}`
    );

    if (!ttsResponse.ok) {
      const errorText =
        await ttsResponse.text();

      console.error(
        "[TTS] UPSTREAM ERROR:",
        errorText
      );

      return res.status(502).json({
        error:
          "KurdishTTS request failed",
        upstreamStatus:
          ttsResponse.status,
        details:
          errorText.slice(0, 2000)
      });
    }

    const audioBuffer = Buffer.from(
      await ttsResponse.arrayBuffer()
    );

    if (!audioBuffer.length) {
      throw new Error(
        "KurdishTTS returned empty audio"
      );
    }

    console.log(
      `[TTS] Received audio: ${audioBuffer.length} bytes`
    );

    // KurdishTTS returns WAV/audio.
    // Convert it to exactly the PCM16 mono
    // format requested by Vapi.
    const pcmBuffer =
      await audioToPcm16Mono(
        audioBuffer,
        requestedSampleRate
      );

    if (!pcmBuffer.length) {
      throw new Error(
        "PCM conversion returned empty audio"
      );
    }

    console.log(
      `[TTS] PCM ready: ${pcmBuffer.length} bytes`
    );

    res.setHeader(
      "Content-Type",
      "application/octet-stream"
    );

    res.setHeader(
      "Content-Length",
      pcmBuffer.length
    );

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    return res
      .status(200)
      .send(pcmBuffer);

  } catch (error) {

    console.error(
      "[TTS] BRIDGE ERROR:",
      error
    );

    if (!res.headersSent) {
      return res.status(500).json({
        error: "TTS bridge failed",
        details:
          error.message ||
          String(error)
      });
    }
  }
});

// =====================================================
// AUDIO -> PCM16 MONO
// =====================================================

function audioToPcm16Mono(
  audioBuffer,
  sampleRate
) {
  return new Promise(
    (resolve, reject) => {

      if (!ffmpegPath) {
        return reject(
          new Error(
            "ffmpeg-static did not provide an FFmpeg binary"
          )
        );
      }

      const ffmpeg = spawn(
        ffmpegPath,
        [
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
        ]
      );

      const chunks = [];
      const errors = [];

      ffmpeg.stdout.on(
        "data",
        (chunk) => {
          chunks.push(chunk);
        }
      );

      ffmpeg.stderr.on(
        "data",
        (chunk) => {
          errors.push(chunk);
        }
      );

      ffmpeg.on(
        "error",
        (error) => {
          reject(error);
        }
      );

      ffmpeg.on(
        "close",
        (code) => {

          if (code !== 0) {
            return reject(
              new Error(
                Buffer
                  .concat(errors)
                  .toString() ||
                `FFmpeg exited with code ${code}`
              )
            );
          }

          resolve(
            Buffer.concat(chunks)
          );
        }
      );

      ffmpeg.stdin.end(
        audioBuffer
      );
    }
  );
}

// =====================================================
// HTTP SERVER
// =====================================================

const server =
  http.createServer(app);

// =====================================================
// VAPI CUSTOM TRANSCRIBER WEBSOCKET
// =====================================================

const wss =
  new WebSocketServer({
    noServer: true,

    maxPayload:
      20 * 1024 * 1024
  });

// =====================================================
// EXTRACT CUSTOMER AUDIO CHANNEL
// =====================================================

function extractCustomerChannelPcm16(
  audioData,
  channels
) {
  const input =
    Buffer.isBuffer(audioData)
      ? audioData
      : Buffer.from(audioData);

  // Already mono
  if (channels === 1) {
    return input;
  }

  const bytesPerSample = 2;

  const bytesPerFrame =
    channels * bytesPerSample;

  const validLength =
    input.length -
    (
      input.length %
      bytesPerFrame
    );

  if (validLength <= 0) {
    return Buffer.alloc(0);
  }

  const frameCount =
    validLength /
    bytesPerFrame;

  const output =
    Buffer.alloc(
      frameCount *
      bytesPerSample
    );

  let outputOffset = 0;

  for (
    let inputOffset = 0;
    inputOffset < validLength;
    inputOffset += bytesPerFrame
  ) {
    // Channel 0 = customer
    output[outputOffset] =
      input[inputOffset];

    output[outputOffset + 1] =
      input[inputOffset + 1];

    outputOffset +=
      bytesPerSample;
  }

  return output;
}

// =====================================================
// KURDISHTTS RESPONSE -> VAPI TRANSCRIPT
// =====================================================

function sendTranscriptToVapi(
  clientWs,
  rawData
) {
  try {
    const rawText =
      rawData.toString();

    console.log(
      "[STT] KurdishTTS response:",
      rawText
    );

    let data;

    try {
      data =
        JSON.parse(rawText);
    } catch {
      console.log(
        "[STT] Non-JSON response ignored"
      );
      return;
    }

    if (data.error) {
      console.error(
        "[STT] KurdishTTS error:",
        data.error
      );
      return;
    }

    if (
      data.type === "control" &&
      data.event === "done"
    ) {
      console.log(
        "[STT] KurdishTTS finalized"
      );
      return;
    }

    const transcription =
      data.text ||
      data.transcript ||
      data.transcription ||
      data.result?.text ||
      data.result?.transcript ||
      data.result?.transcription ||
      "";

    if (
      typeof transcription !==
        "string" ||
      !transcription.trim()
    ) {
      return;
    }

    const isFinal =
      data.is_final === true ||
      data.isFinal === true ||
      data.final === true ||
      data.type === "final" ||
      data.type ===
        "final_transcript" ||
      data.event === "final" ||
      data.result?.is_final === true ||
      data.result?.isFinal === true ||
      data.result?.final === true;

    const vapiMessage = {
      type: "transcriber-response",

      transcription:
        transcription.trim(),

      channel: "customer",

      transcriptType:
        isFinal
          ? "final"
          : "partial"
    };

    console.log(
      `[STT] -> Vapi ${vapiMessage.transcriptType}: ${vapiMessage.transcription}`
    );

    if (
      clientWs.readyState ===
      WebSocket.OPEN
    ) {
      clientWs.send(
        JSON.stringify(
          vapiMessage
        )
      );
    }

  } catch (error) {
    console.error(
      "[STT] Transcript forwarding error:",
      error.message
    );
  }
}

// =====================================================
// MAIN STT CONNECTION
// =====================================================

wss.on(
  "connection",
  async (clientWs) => {

    console.log(
      "========================================"
    );

    console.log(
      "[STT] Vapi client connected"
    );

    const apiKey =
      process.env.KURDISHTTS_STT_KEY;

    if (!apiKey) {
      console.error(
        "[STT] ERROR: KURDISHTTS_STT_KEY missing"
      );

      clientWs.close();
      return;
    }

    let sttWs = null;

    let clientClosed = false;

    let upstreamReady = false;

    let vapiStarted = false;

    let vapiSampleRate = null;

    let vapiChannels = 1;

    let vapiEncoding = null;

    // Raw audio waits here until BOTH:
    // 1. Vapi has sent start/audio config
    // 2. KurdishTTS WebSocket is ready
    let pendingAudio = [];

    let pendingAudioBytes = 0;

    // -------------------------------------------------
    // QUEUE AUDIO
    // -------------------------------------------------

    function queueAudio(buffer) {

      if (!buffer.length) {
        return;
      }

      if (
        pendingAudioBytes +
        buffer.length >
        MAX_PENDING_AUDIO_BYTES
      ) {
        console.error(
          "[STT] Audio buffer exceeded maximum"
        );

        clientWs.close();
        return;
      }

      pendingAudio.push(buffer);

      pendingAudioBytes +=
        buffer.length;
    }

    // -------------------------------------------------
    // SEND AUDIO TO KURDISHTTS
    // -------------------------------------------------

    function sendAudioToUpstream(
      buffer
    ) {

      if (!buffer.length) {
        return;
      }

      if (
        !upstreamReady ||
        !sttWs ||
        sttWs.readyState !==
          WebSocket.OPEN
      ) {
        queueAudio(buffer);
        return;
      }

      sttWs.send(
        buffer,
        {
          binary: true
        }
      );
    }

    // -------------------------------------------------
    // PROCESS ONE RAW VAPI AUDIO CHUNK
    //
    // IMPORTANT:
    // We only process audio AFTER the start message.
    // This prevents sending unknown stereo/raw audio
    // directly to KurdishTTS.
    // -------------------------------------------------

    function processVapiAudio(
      rawAudio
    ) {

      if (!vapiStarted) {
        queueAudio(rawAudio);
        return;
      }

      if (
        vapiEncoding &&
        vapiEncoding !==
          "linear16" &&
        vapiEncoding !==
          "pcm_s16le"
      ) {
        console.error(
          `[STT] Unsupported encoding: ${vapiEncoding}`
        );

        return;
      }

      if (
        vapiSampleRate !==
        REQUIRED_STT_SAMPLE_RATE
      ) {
        console.error(
          `[STT] Wrong sample rate: ${vapiSampleRate}. Expected ${REQUIRED_STT_SAMPLE_RATE}.`
        );

        return;
      }

      const customerAudio =
        extractCustomerChannelPcm16(
          rawAudio,
          vapiChannels
        );

      if (!customerAudio.length) {
        return;
      }

      sendAudioToUpstream(
        customerAudio
      );
    }

    // -------------------------------------------------
    // FLUSH PENDING AUDIO
    //
    // This is the critical fix.
    // Never flush until we know Vapi's audio config.
    // -------------------------------------------------

    function flushPendingAudio() {

      if (!vapiStarted) {
        console.log(
          "[STT] Waiting for Vapi start before flushing audio"
        );
        return;
      }

      if (!upstreamReady) {
        return;
      }

      if (
        !sttWs ||
        sttWs.readyState !==
          WebSocket.OPEN
      ) {
        return;
      }

      if (!pendingAudio.length) {
        return;
      }

      const oldQueue =
        pendingAudio;

      const oldBytes =
        pendingAudioBytes;

      pendingAudio = [];
      pendingAudioBytes = 0;

      console.log(
        `[STT] Processing ${oldQueue.length} buffered chunks (${oldBytes} bytes)`
      );

      for (
        const rawChunk of oldQueue
      ) {
        processVapiAudio(
          rawChunk
        );
      }
    }

    try {

      // =================================================
      // CREATE KURDISHTTS STT SESSION
      // =================================================

      console.log(
        "[STT] Creating KurdishTTS session..."
      );

      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () => controller.abort(),
          15000
        );

      let connectResponse;

      try {
        connectResponse =
          await fetch(
            KURDISH_STT_CONNECT_URL,
            {
              method: "POST",

              headers: {
                "x-api-key": apiKey,
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  dialect:
                    STT_DIALECT
                }),

              signal:
                controller.signal
            }
          );
      } finally {
        clearTimeout(
          timeout
        );
      }

      console.log(
        `[STT] Session HTTP status: ${connectResponse.status}`
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
        connectData.websocket_url ||
        connectData.websocketUrl ||
        connectData.url;

      if (!websocketUrl) {
        throw new Error(
          "KurdishTTS did not return a WebSocket URL"
        );
      }

      console.log(
        "[STT] KurdishTTS session created"
      );

      // =================================================
      // CONNECT UPSTREAM
      // =================================================

      sttWs =
        new WebSocket(
          websocketUrl
        );

      sttWs.on(
        "open",
        () => {

          if (clientClosed) {
            try {
              sttWs.close();
            } catch {}

            return;
          }

          upstreamReady = true;

          console.log(
            "[STT] Connected to KurdishTTS WebSocket"
          );

          // This will only flush if Vapi start
          // has already arrived.
          flushPendingAudio();
        }
      );

      // =================================================
      // KURDISHTTS -> VAPI
      // =================================================

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
            "[STT] KurdishTTS WebSocket error:",
            error.message
          );
        }
      );

      sttWs.on(
        "close",
        (
          code,
          reason
        ) => {

          upstreamReady = false;

          console.log(
            `[STT] KurdishTTS WebSocket closed: ${code} ${reason.toString()}`
          );

          if (
            !clientClosed &&
            clientWs.readyState ===
              WebSocket.OPEN
          ) {
            console.error(
              "[STT] Upstream closed during active call"
            );
          }
        }
      );

      // =================================================
      // VAPI -> BRIDGE
      // =================================================

      clientWs.on(
        "message",
        (
          data,
          isBinary
        ) => {

          // ---------------------------------------------
          // AUDIO
          // ---------------------------------------------

          if (isBinary) {

            const rawAudio =
              Buffer.from(data);

            // Don't process yet if we don't know
            // sample rate/channels.
            if (!vapiStarted) {

              console.log(
                "[STT] Audio received before start. Buffering safely."
              );

              queueAudio(
                rawAudio
              );

              return;
            }

            processVapiAudio(
              rawAudio
            );

            return;
          }

          // ---------------------------------------------
          // JSON CONTROL MESSAGE
          // ---------------------------------------------

          let message;

          try {
            message =
              JSON.parse(
                data.toString()
              );
          } catch {
            console.log(
              "[STT] Ignoring invalid JSON control"
            );

            return;
          }

          console.log(
            "[STT] Vapi control:",
            JSON.stringify(
              message
            )
          );

          // ---------------------------------------------
          // START
          // ---------------------------------------------

          if (
            message.type ===
            "start"
          ) {

            vapiStarted = true;

            vapiEncoding =
              message.encoding ||
              "linear16";

            vapiSampleRate =
              Number(
                message.sampleRate
              );

            vapiChannels =
              Number(
                message.channels
              ) || 1;

            console.log(
              "[STT] Vapi audio configuration:",
              JSON.stringify({
                encoding:
                  vapiEncoding,

                sampleRate:
                  vapiSampleRate,

                channels:
                  vapiChannels,

                container:
                  message.container
              })
            );

            if (
              vapiSampleRate !==
              REQUIRED_STT_SAMPLE_RATE
            ) {
              console.error(
                `[STT] CONFIG ERROR: Vapi is ${vapiSampleRate}Hz but KurdishTTS requires ${REQUIRED_STT_SAMPLE_RATE}Hz`
              );
            }

            // NOW we know the audio format.
            // Safely process anything buffered before start.
            flushPendingAudio();

            return;
          }

          // ---------------------------------------------
          // FINALIZE
          // ---------------------------------------------

          if (
            message.type ===
              "control" &&
            message.event ===
              "finalize"
          ) {

            if (
              sttWs &&
              sttWs.readyState ===
                WebSocket.OPEN
            ) {

              console.log(
                "[STT] Sending finalize"
              );

              sttWs.send(
                JSON.stringify({
                  type: "control",
                  event: "finalize"
                })
              );
            }

            return;
          }

          // ---------------------------------------------
          // STOP / END
          // ---------------------------------------------

          if (
            message.type ===
              "stop" ||
            message.type ===
              "end"
          ) {

            if (
              sttWs &&
              sttWs.readyState ===
                WebSocket.OPEN
            ) {
              try {
                sttWs.send(
                  JSON.stringify({
                    type: "control",
                    event:
                      "finalize"
                  })
                );
              } catch {}
            }
          }
        }
      );

      // =================================================
      // CLIENT CLOSED
      // =================================================

      clientWs.on(
        "close",
        () => {

          clientClosed = true;

          console.log(
            "[STT] Vapi client disconnected"
          );

          if (
            sttWs &&
            sttWs.readyState ===
              WebSocket.OPEN
          ) {
            try {
              sttWs.send(
                JSON.stringify({
                  type: "control",
                  event:
                    "finalize"
                })
              );
            } catch {}
          }

          setTimeout(
            () => {
              if (
                sttWs &&
                (
                  sttWs.readyState ===
                    WebSocket.OPEN ||
                  sttWs.readyState ===
                    WebSocket.CONNECTING
                )
              ) {
                try {
                  sttWs.close();
                } catch {}
              }
            },
            1000
          );
        }
      );

      clientWs.on(
        "error",
        (error) => {
          console.error(
            "[STT] Vapi client error:",
            error.message
          );
        }
      );

    } catch (error) {

      console.error(
        "[STT] STARTUP ERROR:",
        error
      );

      if (
        clientWs.readyState ===
        WebSocket.OPEN
      ) {
        clientWs.close();
      }
    }
  }
);

// =====================================================
// WEBSOCKET UPGRADE
// =====================================================

server.on(
  "upgrade",
  (
    request,
    socket,
    head
  ) => {

    try {

      const url =
        new URL(
          request.url,
          `http://${request.headers.host}`
        );

      if (
        url.pathname ===
        "/api/stt"
      ) {

        console.log(
          "[STT] Incoming Vapi WebSocket"
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

        return;
      }

      socket.destroy();

    } catch (error) {

      console.error(
        "[STT] Upgrade error:",
        error.message
      );

      socket.destroy();
    }
  }
);

// =====================================================
// GLOBAL EXPRESS ERROR HANDLER
// =====================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "[HTTP] Unhandled error:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res.status(500).json({
      error:
        "Internal bridge error",
      details:
        error.message
    });
  }
);

// =====================================================
// START SERVER
// =====================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "========================================"
    );

    console.log(
      `Kurdish Vapi Bridge listening on port ${PORT}`
    );

    console.log(
      `TTS endpoint: /api/synthesize`
    );

    console.log(
      `STT WebSocket: /api/stt`
    );

    console.log(
      `TTS URL: ${KURDISH_TTS_URL}`
    );

    console.log(
      `STT URL: ${KURDISH_STT_CONNECT_URL}`
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

    console.log(
      `TTS key configured: ${!!process.env.KURDISHTTS_TTS_KEY}`
    );

    console.log(
      `STT key configured: ${!!process.env.KURDISHTTS_STT_KEY}`
    );

    console.log(
      "========================================"
    );
  }
);
