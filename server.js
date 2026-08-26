const express = require("express");
const http = require("http");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 8080;

// =====================================================
// KURDISH TTS SETTINGS
// =====================================================

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
// KURDISH REAL-TIME STT SETTINGS
// =====================================================

const KURDISH_STT_CONNECT_URL =
  process.env.KURDISH_STT_CONNECT_URL ||
  "https://www.kurdishtts.com/api/stt-stream-connect";

const STT_DIALECT =
  process.env.STT_DIALECT ||
  "sorani";

const REQUIRED_STT_SAMPLE_RATE = 16000;
const REQUIRED_STT_CHANNELS = 1;

// Prevent unlimited buffering if STT is still connecting
const MAX_PENDING_AUDIO_BYTES =
  10 * 1024 * 1024;

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Kurdish Sorani Vapi Bridge",

    tts: {
      enabled: true,
      provider: "KurdishTTS",
      speaker: SPEAKER_ID,
      model: MODEL_VERSION,
      keyConfigured: !!process.env.KURDISHTTS_TTS_KEY
    },

    stt: {
      enabled: true,
      provider: "KurdishTTS Realtime Streaming",
      dialect: STT_DIALECT,
      keyConfigured: !!process.env.KURDISHTTS_STT_KEY,
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
// VAPI -> BRIDGE -> KURDISHTTS
// =====================================================

app.post("/api/synthesize", async (req, res) => {
  try {
    const message =
      req.body?.message ||
      req.body;

    const messageType =
      message?.type;

    if (
      messageType &&
      messageType !== "voice-request"
    ) {
      console.log(
        "[TTS] Received message type:",
        messageType
      );
    }

    const text =
      typeof message?.text === "string"
        ? message.text.trim()
        : "";

    console.log(
      `[${new Date().toISOString()}] [TTS] Text received from Vapi:`,
      text
    );

    const requestedSampleRate =
      Number(message?.sampleRate) || 16000;

    if (!text) {
      return res.status(400).json({
        error: "Missing text"
      });
    }

    if (
      ![8000, 16000, 22050, 24000, 44100, 48000]
        .includes(requestedSampleRate)
    ) {
      return res.status(400).json({
        error: "Unsupported sample rate",
        sampleRate: requestedSampleRate
      });
    }

    const apiKey =
      process.env.KURDISHTTS_TTS_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error:
          "KURDISHTTS_TTS_KEY is not configured"
      });
    }

    console.log(
      `[TTS] Generating speech at ${requestedSampleRate}Hz`
    );

    const ttsResponse = await fetch(
      KURDISH_TTS_URL,
      {
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
      }
    );

    if (!ttsResponse.ok) {
      const errorText =
        await ttsResponse.text();

      console.error(
        "[TTS] KurdishTTS error:",
        errorText
      );

      return res.status(502).json({
        error: "KurdishTTS request failed",
        details: errorText
      });
    }

    const audioBuffer = Buffer.from(
      await ttsResponse.arrayBuffer()
    );

    const pcmBuffer = await convertToPcm16(
      audioBuffer,
      requestedSampleRate
    );

    res.setHeader(
      "Content-Type",
      "application/octet-stream"
    );

    res.setHeader(
      "Content-Length",
      pcmBuffer.length
    );

    console.log(
      `[${new Date().toISOString()}] [TTS] Audio ready: ${pcmBuffer.length} bytes`
    );

    res.status(200).send(pcmBuffer);

  } catch (error) {
    console.error(
      "[TTS] Bridge error:",
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

// =====================================================
// CONVERT TTS AUDIO TO RAW PCM16 MONO
// =====================================================

function convertToPcm16(
  inputBuffer,
  sampleRate
) {
  return new Promise((resolve, reject) => {

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

    const outputChunks = [];
    const errorChunks = [];

    ffmpeg.stdout.on(
      "data",
      (chunk) => {
        outputChunks.push(chunk);
      }
    );

    ffmpeg.stderr.on(
      "data",
      (chunk) => {
        errorChunks.push(chunk);
      }
    );

    ffmpeg.on(
      "error",
      reject
    );

    ffmpeg.on(
      "close",
      (code) => {

        if (code !== 0) {
          return reject(
            new Error(
              Buffer.concat(errorChunks)
                .toString() ||
              `FFmpeg exited with code ${code}`
            )
          );
        }

        resolve(
          Buffer.concat(outputChunks)
        );
      }
    );

    ffmpeg.stdin.end(inputBuffer);
  });
}

// =====================================================
// CREATE HTTP SERVER
// =====================================================

const server = http.createServer(app);

// =====================================================
// VAPI CUSTOM TRANSCRIBER WEBSOCKET SERVER
// =====================================================

const wss = new WebSocketServer({
  noServer: true
});

// =====================================================
// EXTRACT CUSTOMER CHANNEL
//
// If Vapi sends:
// Channel 0 = customer
// Channel 1 = assistant
//
// KurdishTTS needs mono customer audio.
// =====================================================

function extractCustomerChannelPcm16(
  audioData,
  channels
) {
  const input = Buffer.from(audioData);

  if (channels === 1) {
    return input;
  }

  const bytesPerSample = 2;
  const bytesPerFrame =
    channels * bytesPerSample;

  const validLength =
    input.length -
    (input.length % bytesPerFrame);

  if (validLength <= 0) {
    return Buffer.alloc(0);
  }

  const frameCount =
    validLength / bytesPerFrame;

  const output = Buffer.alloc(
    frameCount * bytesPerSample
  );

  let outputOffset = 0;

  for (
    let inputOffset = 0;
    inputOffset < validLength;
    inputOffset += bytesPerFrame
  ) {
    // Customer = channel 0
    output[outputOffset] =
      input[inputOffset];

    output[outputOffset + 1] =
      input[inputOffset + 1];

    outputOffset += bytesPerSample;
  }

  return output;
}

// =====================================================
// DETECT ASSISTANT AUDIO ON VAPI CHANNEL 1
//
// Vapi custom-transcriber audio uses stereo PCM16 when
// channels=2. Channel 0 is customer and channel 1 is
// assistant. This guard suppresses finals caused by
// assistant echo/feedback without blocking customer audio.
// =====================================================

function pcm16ChannelHasEnergy(
  audioData,
  channels,
  channelIndex
) {
  if (
    channels <= channelIndex ||
    channels < 2
  ) {
    return false;
  }

  const input = Buffer.from(audioData);
  const bytesPerSample = 2;
  const bytesPerFrame =
    channels * bytesPerSample;

  const validLength =
    input.length -
    (input.length % bytesPerFrame);

  if (validLength <= 0) {
    return false;
  }

  const frameStride = 4;
  const sampledFrames =
    Math.floor(
      validLength /
      bytesPerFrame /
      frameStride
    );

  if (sampledFrames <= 0) {
    return false;
  }

  let activeFrames = 0;

  for (
    let frame = 0;
    frame < sampledFrames;
    frame++
  ) {
    const offset =
      frame *
      frameStride *
      bytesPerFrame +
      channelIndex *
      bytesPerSample;

    const sample =
      input.readInt16LE(offset);

    if (Math.abs(sample) >= 700) {
      activeFrames++;
    }
  }

  return activeFrames >=
    Math.max(
      3,
      Math.floor(sampledFrames * 0.02)
    );
}
// =====================================================
// STT FINAL TRANSCRIPT DEBOUNCE
// =====================================================

const transcriptDebounceState =
  new WeakMap();

const TRANSCRIPT_DEBOUNCE_MS = 800;
// =====================================================
// KURDISHTTS RESPONSE -> VAPI RESPONSE
// =====================================================

function sendTranscriptToVapi(
  clientWs,
  rawData,
  isAssistantAudioSuppressed = false
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
      data = JSON.parse(rawText);
    } catch {
      console.log(
        "[STT] Non-JSON response ignored"
      );
      return;
    }

    // ---------------------------------------------
    // KURDISHTTS STREAM DONE
    // ---------------------------------------------

    if (
      data.type === "control" &&
      data.event === "done"
    ) {
      console.log(
        "[STT] KurdishTTS finalized"
      );
      return;
    }

    // ---------------------------------------------
    // KURDISHTTS ERROR
    // ---------------------------------------------

    if (data.error) {
      console.error(
        "[STT] KurdishTTS error:",
        data.error
      );
      return;
    }

    // ---------------------------------------------
    // GET TRANSCRIPT TEXT
    // ---------------------------------------------

    const transcription =
      data.text ||
      data.transcript ||
      data.transcription ||
      data.result?.text ||
      data.result?.transcript ||
      data.result?.transcription ||
      "";

    if (
      typeof transcription !== "string" ||
      !transcription.trim()
    ) {
      return;
    }

    // ---------------------------------------------
    // FINAL DETECTION
    // ---------------------------------------------

    const isFinal =
      data.is_final === true ||
      data.isFinal === true ||
      data.final === true ||
      data.result?.is_final === true ||
      data.result?.isFinal === true ||
      data.result?.final === true;

    if (!isFinal) {
      console.log(
        "[STT] Partial transcript ignored"
      );
      return;
    }

    const text =
      transcription.trim();

    // ---------------------------------------------
    // IGNORE FINALS DURING ASSISTANT AUDIO
    // ---------------------------------------------

    if (isAssistantAudioSuppressed) {
      console.log(
        "[STT] Final transcript ignored during assistant audio suppression:",
        text
      );
      return;
    }

    // ---------------------------------------------
    // GET DEBOUNCE STATE FOR THIS CALL
    // ---------------------------------------------

    let state =
      transcriptDebounceState.get(
        clientWs
      );

    if (!state) {
      state = {
        pendingText: "",
        timer: null
      };

      transcriptDebounceState.set(
        clientWs,
        state
      );
    }

    // ---------------------------------------------
    // BUFFER FINAL TRANSCRIPT
    // ---------------------------------------------

    if (state.pendingText) {
      state.pendingText +=
        " " + text;
    } else {
      state.pendingText = text;
    }

    console.log(
      "[STT] Final transcript buffered:",
      state.pendingText
    );

    // ---------------------------------------------
    // RESET DEBOUNCE TIMER
    // ---------------------------------------------

    if (state.timer) {
      clearTimeout(
        state.timer
      );
    }

    state.timer = setTimeout(
      () => {

        const finalText =
          state.pendingText.trim();

        state.pendingText = "";
        state.timer = null;

        if (!finalText) {
          return;
        }

        const vapiMessage = {
          type: "transcriber-response",
          transcription: finalText,
          channel: "customer",
          transcriptType: "final"
        };

        console.log(
          `[${new Date().toISOString()}] [STT] -> Vapi:`,
          JSON.stringify(vapiMessage)
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

      },
      TRANSCRIPT_DEBOUNCE_MS
    );

  } catch (error) {
    console.error(
      "[STT] Error processing transcript:",
      error.message
    );
  }
}
// =====================================================
// STT WEBSOCKET CONNECTION
// =====================================================

wss.on(
  "connection",
  async (clientWs) => {

    console.log(
      "========================================"
    );

    console.log(
      "[STT] Vapi connected to Kurdish bridge"
    );

    const apiKey =
      process.env.KURDISHTTS_STT_KEY;

    if (!apiKey) {
      console.error(
        "[STT] KURDISHTTS_STT_KEY is missing"
      );

      if (
        clientWs.readyState ===
        WebSocket.OPEN
      ) {
        clientWs.send(
          JSON.stringify({
            type: "error",
            error:
              "KURDISHTTS_STT_KEY is not configured"
          })
        );
      }

      clientWs.close();
      return;
    }

    let sttWs = null;
    let sttReady = false;
    let clientClosed = false;
    let finalized = false;
    let firstAudioChunkLogged = false;

    // Suppress STT finals briefly after assistant audio is detected
    // on channel 1. Customer audio is still forwarded normally.
    const ASSISTANT_AUDIO_SUPPRESSION_MS = 4000;
    let assistantAudioSuppressionUntil = 0;

    let vapiStarted = false;
    let vapiEncoding = null;
    let vapiSampleRate = null;
    let vapiChannels = 1;

    // Buffer audio while KurdishTTS
    // WebSocket is still connecting.
    const pendingAudio = [];
    let pendingAudioBytes = 0;

    // -------------------------------------------------
    // SEND AUDIO TO KURDISHTTS
    // -------------------------------------------------

    function sendAudioToStt(audio) {

      if (
        !sttWs ||
        !sttReady ||
        sttWs.readyState !== WebSocket.OPEN
      ) {

        const audioBuffer =
          Buffer.from(audio);

        if (
          pendingAudioBytes +
          audioBuffer.length >
          MAX_PENDING_AUDIO_BYTES
        ) {
          console.error(
            "[STT] Pending audio buffer is full"
          );
          return;
        }

        pendingAudio.push(audioBuffer);
        pendingAudioBytes +=
          audioBuffer.length;

        return;
      }

      try {
        sttWs.send(
          audio,
          { binary: true }
        );
      } catch (error) {
        console.error(
          "[STT] Audio forwarding error:",
          error.message
        );
      }
    }

    // -------------------------------------------------
    // FLUSH AUDIO BUFFER
    // -------------------------------------------------

    function flushPendingAudio() {

      if (
        !sttWs ||
        !sttReady ||
        sttWs.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      if (pendingAudio.length === 0) {
        return;
      }

      console.log(
        `[STT] Flushing ${pendingAudio.length} buffered audio chunks`
      );

      while (pendingAudio.length > 0) {

        const audio =
          pendingAudio.shift();

        pendingAudioBytes -=
          audio.length;

        try {
          sttWs.send(
            audio,
            { binary: true }
          );
        } catch (error) {
          console.error(
            "[STT] Buffered audio send error:",
            error.message
          );
          break;
        }
      }

      pendingAudioBytes = 0;
    }

    // -------------------------------------------------
    // FINALIZE KURDISHTTS
    // -------------------------------------------------

    function finalizeKurdishStt() {

      if (finalized) {
        return;
      }

      finalized = true;

      console.log(
        "[STT] Finalizing KurdishTTS stream"
      );

      if (
        sttWs &&
        sttWs.readyState === WebSocket.OPEN
      ) {
        try {
          sttWs.send(
            JSON.stringify({
              type: "control",
              event: "finalize"
            })
          );
        } catch (error) {
          console.error(
            "[STT] Finalize error:",
            error.message
          );
        }
      }
    }

    // =================================================
    // VAPI -> BRIDGE
    // =================================================

    clientWs.on(
      "message",
      (data, isBinary) => {

        // ---------------------------------------------
        // AUDIO
        // ---------------------------------------------

        if (isBinary) {

          if (!firstAudioChunkLogged) {
            console.log(
              `[${new Date().toISOString()}] [STT] First audio chunk received from Vapi`
            );

            firstAudioChunkLogged = true;
          }

          if (!vapiStarted) {
            console.warn(
              "[STT] Audio arrived before Vapi start message; using temporary default audio configuration"
            );

            vapiStarted = true;
            vapiEncoding = "linear16";
            vapiSampleRate = 16000;
            vapiChannels = 2;
          }

          if (
            vapiSampleRate !==
            REQUIRED_STT_SAMPLE_RATE
          ) {
            console.error(
              `[STT] Vapi sample rate ${vapiSampleRate}Hz. Expected ${REQUIRED_STT_SAMPLE_RATE}Hz`
            );
            return;
          }

          const rawAudio =
            Buffer.from(data);

          if (
            pcm16ChannelHasEnergy(
              rawAudio,
              vapiChannels,
              1
            )
          ) {
            assistantAudioSuppressionUntil =
              Date.now() +
              ASSISTANT_AUDIO_SUPPRESSION_MS;
          }

          const monoAudio =
            extractCustomerChannelPcm16(
              rawAudio,
              vapiChannels
            );

          if (monoAudio.length === 0) {
            return;
          }

          sendAudioToStt(
            monoAudio
          );

          return;
        }

        // ---------------------------------------------
        // VAPI CONTROL MESSAGE
        // ---------------------------------------------

        let message;

        try {
          message = JSON.parse(
            data.toString()
          );
        } catch {

          console.log(
            "[STT] Ignoring non-JSON Vapi message"
          );

          return;
        }

        console.log(
          "[STT] Vapi control:",
          JSON.stringify(message)
        );

        // ---------------------------------------------
        // START
        // ---------------------------------------------

        if (
          message.type === "start"
        ) {

          vapiStarted = true;

          vapiEncoding =
            message.encoding ||
            "linear16";

          vapiSampleRate =
            Number(
              message.sampleRate
            ) || 16000;

          vapiChannels =
            Number(
              message.channels
            ) || 1;

          console.log(
            "========================================"
          );

          console.log(
            "[STT] VAPI AUDIO CONFIGURATION"
          );

          console.log(
            `[STT] Encoding: ${vapiEncoding}`
          );

          console.log(
            `[STT] Sample rate: ${vapiSampleRate}Hz`
          );

          console.log(
            `[STT] Channels: ${vapiChannels}`
          );

          console.log(
            `[STT] Required: PCM16 mono ${REQUIRED_STT_SAMPLE_RATE}Hz`
          );

          console.log(
            "========================================"
          );

          const validEncoding =
            vapiEncoding === "linear16" ||
            vapiEncoding === "pcm_s16le";

          if (!validEncoding) {

            console.error(
              `[STT] Unsupported encoding: ${vapiEncoding}`
            );

            clientWs.send(
              JSON.stringify({
                type: "error",
                error:
                  `Unsupported audio encoding: ${vapiEncoding}`
              })
            );
          }

          if (
            vapiSampleRate !==
            REQUIRED_STT_SAMPLE_RATE
          ) {

            console.error(
              `[STT] Sample rate must be ${REQUIRED_STT_SAMPLE_RATE}Hz`
            );
          }

          return;
        }

        // ---------------------------------------------
        // FINALIZE
        // ---------------------------------------------

        if (
          message.type === "control" &&
          message.event === "finalize"
        ) {

          finalizeKurdishStt();
          return;
        }

        // ---------------------------------------------
        // STOP / END
        // ---------------------------------------------

        if (
          message.type === "stop" ||
          message.type === "end"
        ) {

          finalizeKurdishStt();
          return;
        }
      }
    );

    try {

      // =================================================
      // GET TEMPORARY KURDISHTTS WEBSOCKET URL
      // =================================================

      console.log(
        "[STT] Requesting KurdishTTS streaming URL..."
      );

      const connectResponse =
        await fetch(
          KURDISH_STT_CONNECT_URL,
          {
            method: "POST",

            headers: {
              "x-api-key": apiKey,
              "Content-Type":
                "application/json"
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
          `KurdishTTS STT connection failed: ${errorText}`
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
          "KurdishTTS did not return a websocket_url"
        );
      }

      console.log(
        "[STT] Streaming URL received"
      );

      // =================================================
      // CONNECT TO KURDISHTTS REALTIME STT
      // =================================================

      sttWs = new WebSocket(
        websocketUrl
      );

      sttWs.on(
        "open",
        () => {

          sttReady = true;

          console.log(
            "[STT] Connected to KurdishTTS realtime"
          );

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
            data,
            Date.now() < assistantAudioSuppressionUntil
          );
        }
      );

      sttWs.on(
        "error",
        (error) => {

          sttReady = false;

          console.error(
            "[STT] KurdishTTS WebSocket error:",
            error.message
          );
        }
      );

      sttWs.on(
        "close",
        (code, reason) => {

          sttReady = false;

          console.log(
            `[STT] KurdishTTS disconnected: ${code} ${reason.toString()}`
          );
        }
      );

      // =================================================
      // VAPI DISCONNECTED
      // =================================================

      clientWs.on(
        "close",
        () => {

          clientClosed = true;

          console.log(
            "[STT] Vapi disconnected"
          );

          finalizeKurdishStt();

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
            "[STT] Vapi WebSocket error:",
            error.message
          );
        }
      );

    } catch (error) {

      console.error(
        "[STT] Bridge startup error:",
        error.message
      );

      if (
        clientWs.readyState ===
        WebSocket.OPEN
      ) {

        clientWs.send(
          JSON.stringify({
            type: "error",
            error:
              "STT bridge failed",
            details:
              error.message
          })
        );

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

      const url = new URL(
        request.url,
        `http://${request.headers.host}`
      );

      if (
        url.pathname === "/api/stt"
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
      "========================================"
    );

    console.log(
      "TTS endpoint: /api/synthesize"
    );

    console.log(
      "STT WebSocket: /api/stt"
    );

    console.log(
      `STT provider: KurdishTTS Realtime`
    );

    console.log(
      `STT dialect: ${STT_DIALECT}`
    );

    console.log(
      `STT required audio: PCM16 mono ${REQUIRED_STT_SAMPLE_RATE}Hz`
    );

    console.log(
      `TTS speaker: ${SPEAKER_ID}`
    );

    console.log(
      `TTS model: ${MODEL_VERSION}`
    );

    console.log(
      `TTS key configured: ${!!process.env.KURDISHTTS_TTS_KEY}`
    );

    console.log(
      `STT key configured: ${!!process.env.KURDISHTTS_STT_KEY}`
    );
  }
);
