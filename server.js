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

const KURDISH_TTS_URL = process.env.KURDISH_TTS_URL;
const SPEAKER_ID = "sorani_986";
const MODEL_VERSION = "v4";

// =====================================================
// KURDISH STT
// =====================================================

const KURDISH_STT_CONNECT_URL =
  process.env.KURDISH_STT_CONNECT_URL;

const STT_DIALECT = "sorani";

const REQUIRED_STT_SAMPLE_RATE = 16000;
const REQUIRED_STT_CHANNELS = 1;

// Maximum audio waiting while KurdishTTS STT connects.
// 10 MB is much more than needed for the short startup delay.
const MAX_PENDING_AUDIO_BYTES = 10 * 1024 * 1024;

// =====================================================
// HEALTH
// =====================================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Kurdish Sorani Vapi Bridge",

    tts: {
      speaker: SPEAKER_ID,
      model: MODEL_VERSION
    },

    stt: {
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
    const message = req.body?.message;

    if (!message) {
      return res.status(400).json({
        error: "Missing message object"
      });
    }

    if (message.type !== "voice-request") {
      return res.status(400).json({
        error: "Invalid message type",
        receivedType: message.type
      });
    }

    const text =
      typeof message.text === "string"
        ? message.text.trim()
        : "";

    const requestedSampleRate =
      Number(message.sampleRate) || 16000;

    if (!text) {
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
      return res.status(500).json({
        error:
          "KURDISHTTS_TTS_KEY is not configured"
      });
    }

    if (!KURDISH_TTS_URL) {
      return res.status(500).json({
        error:
          "KURDISH_TTS_URL is not configured"
      });
    }

    console.log(
      `[TTS] Generating Sorani speech | speaker=${SPEAKER_ID} | model=${MODEL_VERSION} | rate=${requestedSampleRate}`
    );

    console.log(`[TTS] Text: ${text}`);

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 30000);

    let ttsResponse;

    try {
      ttsResponse = await fetch(
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
          }),

          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeout);
    }

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

    const wavBuffer = Buffer.from(
      await ttsResponse.arrayBuffer()
    );

    if (!wavBuffer.length) {
      throw new Error(
        "KurdishTTS returned empty audio"
      );
    }

    console.log(
      `[TTS] Received WAV: ${wavBuffer.length} bytes`
    );

    const pcmBuffer =
      await wavToPcm16Mono(
        wavBuffer,
        requestedSampleRate
      );

    if (!pcmBuffer.length) {
      throw new Error(
        "PCM conversion returned empty audio"
      );
    }

    console.log(
      `[TTS] Sending PCM: ${pcmBuffer.length} bytes`
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

    return res.status(200).send(
      pcmBuffer
    );

  } catch (error) {

    console.error(
      "[TTS] Bridge error:",
      error
    );

    if (!res.headersSent) {
      return res.status(500).json({
        error: "TTS bridge failed",
        details: error.message
      });
    }
  }
});

// =====================================================
// WAV -> PCM16 MONO
// =====================================================

function wavToPcm16Mono(
  wavBuffer,
  sampleRate
) {
  return new Promise(
    (resolve, reject) => {

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

      ffmpeg.stdin.end(wavBuffer);
    }
  );
}

// =====================================================
// HTTP SERVER
// =====================================================

const server = http.createServer(app);

// =====================================================
// VAPI CUSTOM TRANSCRIBER WEBSOCKET
// =====================================================

const wss = new WebSocketServer({
  noServer: true,

  maxPayload: 20 * 1024 * 1024
});

// =====================================================
// EXTRACT CUSTOMER CHANNEL
//
// Vapi sends stereo audio:
//
// channel 0 = customer
// channel 1 = assistant
//
// KurdishTTS requires mono.
//
// We only send channel 0 to KurdishTTS.
// =====================================================

function extractCustomerChannelPcm16(
  audioData,
  channels
) {
  const input =
    Buffer.isBuffer(audioData)
      ? audioData
      : Buffer.from(audioData);

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
    // channel 0 = customer
    output[outputOffset] =
      input[inputOffset];

    output[outputOffset + 1] =
      input[inputOffset + 1];

    outputOffset += bytesPerSample;
  }

  return output;
}

// =====================================================
// SEND TRANSCRIPT TO VAPI
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
      data = JSON.parse(rawText);
    } catch {
      console.log(
        "[STT] Ignoring non-JSON response"
      );

      return;
    }

    // KurdishTTS final completion control event
    if (
      data.type === "control" &&
      data.event === "done"
    ) {
      console.log(
        "[STT] KurdishTTS session completed"
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
        JSON.stringify(vapiMessage)
      );
    }

  } catch (error) {

    console.error(
      "[STT] Error sending transcript to Vapi:",
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
      "[STT] Vapi client connected"
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

    if (!KURDISH_STT_CONNECT_URL) {

      console.error(
        "[STT] KURDISH_STT_CONNECT_URL is missing"
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

    // IMPORTANT:
    //
    // Audio can arrive before KurdishTTS
    // finishes connecting.
    //
    // OLD CODE DROPPED THAT AUDIO.
    //
    // THIS VERSION BUFFERS IT.
    let pendingAudio = [];

    let pendingAudioBytes = 0;

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
          "[STT] Pending audio buffer full. Closing connection to avoid losing sync."
        );

        clientWs.close();

        return;
      }

      pendingAudio.push(buffer);

      pendingAudioBytes +=
        buffer.length;
    }

    function flushPendingAudio() {

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

      console.log(
        `[STT] Flushing ${pendingAudio.length} queued audio chunks (${pendingAudioBytes} bytes)`
      );

      for (
        const audioChunk of pendingAudio
      ) {
        try {
          sttWs.send(
            audioChunk,
            {
              binary: true
            }
          );
        } catch (error) {
          console.error(
            "[STT] Error flushing audio:",
            error.message
          );

          break;
        }
      }

      pendingAudio = [];

      pendingAudioBytes = 0;
    }

    function sendAudioToUpstream(
      audioBuffer
    ) {

      if (!audioBuffer.length) {
        return;
      }

      if (
        !upstreamReady ||
        !sttWs ||
        sttWs.readyState !==
        WebSocket.OPEN
      ) {
        queueAudio(audioBuffer);

        return;
      }

      try {
        sttWs.send(
          audioBuffer,
          {
            binary: true
          }
        );
      } catch (error) {

        console.error(
          "[STT] Audio send failed. Re-queueing:",
          error.message
        );

        queueAudio(audioBuffer);
      }
    }

    try {

      console.log(
        "[STT] Requesting KurdishTTS streaming session..."
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

              body: JSON.stringify({
                dialect: STT_DIALECT
              }),

              signal:
                controller.signal
            }
          );

      } finally {

        clearTimeout(timeout);
      }

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
          "KurdishTTS did not return websocket_url"
        );
      }

      console.log(
        "[STT] KurdishTTS session created"
      );

      // =================================================
      // CONNECT TO KURDISHTTS
      // =================================================

      sttWs =
        new WebSocket(websocketUrl);

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

          // If Vapi already started sending audio,
          // send the buffered beginning now.
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
        (code, reason) => {

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
              "[STT] Upstream closed while Vapi call is still active"
            );

            clientWs.close();
          }
        }
      );

      // =================================================
      // VAPI -> BRIDGE
      // =================================================

      clientWs.on(
        "message",
        (data, isBinary) => {

          // =============================================
          // BINARY PCM AUDIO
          // =============================================

          if (isBinary) {

            if (!vapiStarted) {

              console.log(
                "[STT] Audio received before start message. Temporarily buffering."
              );

              queueAudio(
                Buffer.from(data)
              );

              return;
            }

            const input =
              Buffer.from(data);

            // Vapi should send linear16 PCM.
            // Do not corrupt audio by trying to interpret
            // another format as PCM.
            if (
              vapiEncoding &&
              vapiEncoding !== "linear16" &&
              vapiEncoding !== "pcm_s16le"
            ) {

              console.error(
                `[STT] Unsupported Vapi encoding: ${vapiEncoding}`
              );

              return;
            }

            if (
              vapiSampleRate !==
              REQUIRED_STT_SAMPLE_RATE
            ) {

              console.error(
                `[STT] Wrong Vapi sample rate: ${vapiSampleRate}. Expected ${REQUIRED_STT_SAMPLE_RATE}.`
              );

              return;
            }

            const customerAudio =
              extractCustomerChannelPcm16(
                input,
                vapiChannels
              );

            if (!customerAudio.length) {
              return;
            }

            sendAudioToUpstream(
              customerAudio
            );

            return;
          }

          // =============================================
          // JSON CONTROL
          // =============================================

          let message;

          try {

            message = JSON.parse(
              data.toString()
            );

          } catch {

            console.log(
              "[STT] Ignoring non-JSON control message"
            );

            return;
          }

          console.log(
            "[STT] Vapi control:",
            JSON.stringify(message)
          );

          // =============================================
          // START
          // =============================================

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
              );

            vapiChannels =
              Number(
                message.channels
              ) || 1;

            console.log(
              "[STT] Vapi audio config:",
              JSON.stringify({
                encoding:
                  vapiEncoding,

                container:
                  message.container,

                sampleRate:
                  vapiSampleRate,

                channels:
                  vapiChannels
              })
            );

            if (
              vapiSampleRate !==
              REQUIRED_STT_SAMPLE_RATE
            ) {

              console.error(
                `[STT] CONFIGURATION ERROR: Vapi is sending ${vapiSampleRate}Hz. This bridge requires ${REQUIRED_STT_SAMPLE_RATE}Hz.`
              );
            }

            // Audio may have arrived before the start
            // message. It cannot safely be channel-extracted
            // until we know the channel count.
            //
            // If upstream is already ready, flush it only
            // after converting/extracting based on start info.

            if (
              pendingAudio.length &&
              upstreamReady
            ) {

              const oldQueue =
                pendingAudio;

              pendingAudio = [];
              pendingAudioBytes = 0;

              for (
                const chunk of oldQueue
              ) {

                if (
                  vapiSampleRate !==
                  REQUIRED_STT_SAMPLE_RATE
                ) {
                  continue;
                }

                const customerAudio =
                  extractCustomerChannelPcm16(
                    chunk,
                    vapiChannels
                  );

                if (
                  customerAudio.length
                ) {
                  sendAudioToUpstream(
                    customerAudio
                  );
                }
              }
            }

            return;
          }

          // =============================================
          // OPTIONAL FINALIZE
          // =============================================
          //
          // We do NOT finalize automatically after silence.
          // That would permanently end the KurdishTTS
          // streaming session in the middle of a call.
          //
          // Only finalize when Vapi explicitly ends it.
          // =============================================

          if (
            message.type === "control" &&
            message.event === "finalize"
          ) {

            if (
              sttWs &&
              sttWs.readyState ===
              WebSocket.OPEN
            ) {

              console.log(
                "[STT] Sending explicit finalize to KurdishTTS"
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

          if (
            message.type === "stop" ||
            message.type === "end"
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
                    event: "finalize"
                  })
                );

              } catch {}
            }
          }
        }
      );

      // =================================================
      // CLIENT CLOSE
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

              console.log(
                "[STT] Finalizing KurdishTTS session"
              );

              sttWs.send(
                JSON.stringify({
                  type: "control",
                  event: "finalize"
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
        "[STT] Bridge startup error:",
        error
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

    const url = new URL(
      request.url,
      `http://${request.headers.host}`
    );

    if (
      url.pathname === "/api/stt"
    ) {

      console.log(
        "[STT] Incoming WebSocket connection"
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
  }
);

// =====================================================
// START
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

    console.log(
      "========================================"
    );
  }
);
