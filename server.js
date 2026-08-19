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
// OPENAI REALTIME STT
// =====================================================

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY;

const OPENAI_REALTIME_URL =
  process.env.OPENAI_REALTIME_URL ||
  "wss://api.openai.com/v1/realtime?intent=transcription";

const OPENAI_TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL ||
  "gpt-4o-transcribe";

// Kurdish ISO-639-1 language code.
const STT_LANGUAGE =
  process.env.STT_LANGUAGE ||
  "ku";

// Vapi normally sends 16kHz PCM.
// OpenAI Realtime PCM16 requires 24kHz mono.
const OPENAI_SAMPLE_RATE = 24000;

const MAX_PENDING_AUDIO_BYTES =
  15 * 1024 * 1024;

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
      urlConfigured: !!KURDISH_TTS_URL,
      keyConfigured: !!process.env.KURDISHTTS_TTS_KEY,
      speaker: SPEAKER_ID,
      model: MODEL_VERSION
    },

    stt: {
      enabled: true,
      provider: "OpenAI Realtime",
      keyConfigured: !!OPENAI_API_KEY,
      model: OPENAI_TRANSCRIPTION_MODEL,
      language: STT_LANGUAGE,
      inputFormat: "PCM16",
      openaiSampleRate: OPENAI_SAMPLE_RATE
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
// KURDISHTTS -> RAW PCM16 MONO FOR VAPI
// =====================================================

app.post("/api/synthesize", async (req, res) => {
  try {
    const message =
      req.body?.message ||
      req.body;

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

    console.log(
      "========================================"
    );

    console.log(
      "[TTS] REQUEST RECEIVED"
    );

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

    console.log(
      "========================================"
    );

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        30000
      );

    let ttsResponse;

    try {
      ttsResponse =
        await fetch(
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

    const audioBuffer =
      Buffer.from(
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
// KURDISHTTS AUDIO -> PCM16 MONO
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

      const ffmpeg =
        spawn(
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
// EXTRACT CUSTOMER CHANNEL
//
// Vapi normally sends:
// channel 0 = customer
// channel 1 = assistant
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
    channels *
    bytesPerSample;

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
    output[outputOffset] =
      input[inputOffset];

    output[
      outputOffset + 1
    ] =
      input[
        inputOffset + 1
      ];

    outputOffset +=
      bytesPerSample;
  }

  return output;
}

// =====================================================
// SEND TRANSCRIPT TO VAPI
// =====================================================

function sendTranscriptToVapi(
  clientWs,
  transcription,
  transcriptType
) {
  if (
    typeof transcription !== "string" ||
    !transcription.trim()
  ) {
    return;
  }

  const vapiMessage = {
    type: "transcriber-response",

    transcription:
      transcription.trim(),

    channel: "customer",

    transcriptType:
      transcriptType === "partial"
        ? "partial"
        : "final"
  };

  console.log(
    `[STT] -> Vapi ${vapiMessage.transcriptType}: ${vapiMessage.transcription}`
  );

  if (
    clientWs.readyState ===
    WebSocket.OPEN
  ) {
    try {
      clientWs.send(
        JSON.stringify(vapiMessage)
      );
    } catch (error) {
      console.error(
        "[STT] Failed to send transcript to Vapi:",
        error.message
      );
    }
  }
}

// =====================================================
// MAIN STT CONNECTION
// =====================================================

wss.on(
  "connection",
  (clientWs) => {

    console.log(
      "========================================"
    );

    console.log(
      "[STT] Vapi client connected"
    );

    console.log(
      "[STT] Provider: OpenAI Realtime"
    );

    console.log(
      `[STT] Model: ${OPENAI_TRANSCRIPTION_MODEL}`
    );

    console.log(
      `[STT] Language: ${STT_LANGUAGE}`
    );

    console.log(
      "========================================"
    );

    if (!OPENAI_API_KEY) {

      console.error(
        "[STT] ERROR: OPENAI_API_KEY missing"
      );

      try {
        clientWs.send(
          JSON.stringify({
            type: "error",
            error:
              "OPENAI_API_KEY is not configured"
          })
        );
      } catch {}

      clientWs.close();

      return;
    }

    let clientClosed = false;

    let vapiStarted = false;

    let vapiSampleRate = null;

    let vapiChannels = 1;

    let vapiEncoding = null;

    let openaiWs = null;

    let openaiReady = false;

    let pendingAudio = [];

    let pendingAudioBytes = 0;

    let transcoder = null;

    let transcoderStarted = false;

    let finalizing = false;

    let closeTimer = null;

    // Stores accumulated OpenAI delta text.
    // Vapi partial transcripts replace the previous partial,
    // so we must send the accumulated transcript.
    const partialTranscripts =
      new Map();

    // -------------------------------------------------
    // QUEUE OPENAI-READY AUDIO
    // -------------------------------------------------

    function queueAudio(
      buffer
    ) {

      if (
        !buffer ||
        !buffer.length
      ) {
        return;
      }

      if (
        pendingAudioBytes +
        buffer.length >
        MAX_PENDING_AUDIO_BYTES
      ) {
        console.error(
          "[STT] Audio queue exceeded maximum"
        );

        try {
          clientWs.close();
        } catch {}

        return;
      }

      pendingAudio.push(buffer);

      pendingAudioBytes +=
        buffer.length;
    }

    // -------------------------------------------------
    // SEND 24KHZ PCM AUDIO TO OPENAI
    // -------------------------------------------------

    function sendAudioToOpenAI(
      pcm24kBuffer
    ) {

      if (
        !pcm24kBuffer ||
        !pcm24kBuffer.length
      ) {
        return;
      }

      if (
        !openaiReady ||
        !openaiWs ||
        openaiWs.readyState !==
          WebSocket.OPEN
      ) {
        queueAudio(
          pcm24kBuffer
        );

        return;
      }

      try {

        openaiWs.send(
          JSON.stringify({
            type:
              "input_audio_buffer.append",

            audio:
              pcm24kBuffer.toString(
                "base64"
              )
          })
        );

      } catch (error) {

        console.error(
          "[STT] OpenAI audio send error:",
          error.message
        );

        queueAudio(
          pcm24kBuffer
        );
      }
    }

    // -------------------------------------------------
    // FLUSH AUDIO WAITING FOR OPENAI
    // -------------------------------------------------

    function flushPendingAudio() {

      if (
        !openaiReady ||
        !openaiWs ||
        openaiWs.readyState !==
          WebSocket.OPEN
      ) {
        return;
      }

      if (
        !pendingAudio.length
      ) {
        return;
      }

      const queued =
        pendingAudio;

      const queuedBytes =
        pendingAudioBytes;

      pendingAudio = [];
      pendingAudioBytes = 0;

      console.log(
        `[STT] Sending ${queued.length} queued audio chunks (${queuedBytes} bytes)`
      );

      for (
        const chunk of queued
      ) {
        sendAudioToOpenAI(
          chunk
        );
      }
    }

    // -------------------------------------------------
    // START STREAMING FFmpeg RESAMPLER
    //
    // Vapi -> PCM16 mono at its sample rate
    // FFmpeg -> PCM16 mono 24kHz
    //
    // OpenAI Realtime PCM16 requires 24kHz mono.
    // -------------------------------------------------

    function startTranscoder() {

      if (transcoderStarted) {
        return;
      }

      if (
        !vapiSampleRate ||
        !Number.isFinite(
          vapiSampleRate
        )
      ) {
        console.error(
          "[STT] Cannot start transcoder: invalid sample rate"
        );

        return;
      }

      if (
        vapiSampleRate ===
        OPENAI_SAMPLE_RATE
      ) {
        console.log(
          "[STT] Vapi already uses 24kHz - no resampling required"
        );

        transcoderStarted = true;

        return;
      }

      if (!ffmpegPath) {
        console.error(
          "[STT] ffmpeg-static binary is unavailable"
        );

        try {
          clientWs.close();
        } catch {}

        return;
      }

      console.log(
        `[STT] Starting streaming resampler: ${vapiSampleRate}Hz -> ${OPENAI_SAMPLE_RATE}Hz`
      );

      transcoder =
        spawn(
          ffmpegPath,
          [
            "-hide_banner",

            "-loglevel",
            "error",

            "-f",
            "s16le",

            "-ar",
            String(
              vapiSampleRate
            ),

            "-ac",
            "1",

            "-i",
            "pipe:0",

            "-ac",
            "1",

            "-ar",
            String(
              OPENAI_SAMPLE_RATE
            ),

            "-f",
            "s16le",

            "pipe:1"
          ]
        );

      transcoderStarted = true;

      transcoder.stdout.on(
        "data",
        (chunk) => {

          const pcm24k =
            Buffer.from(chunk);

          sendAudioToOpenAI(
            pcm24k
          );
        }
      );

      transcoder.stderr.on(
        "data",
        (chunk) => {

          const text =
            chunk.toString().trim();

          if (text) {
            console.error(
              "[STT] FFmpeg:",
              text
            );
          }
        }
      );

      transcoder.on(
        "error",
        (error) => {

          console.error(
            "[STT] FFmpeg error:",
            error.message
          );
        }
      );

      transcoder.on(
        "close",
        (code) => {

          console.log(
            `[STT] FFmpeg closed with code ${code}`
          );

          transcoder = null;
        }
      );
    }

    // -------------------------------------------------
    // PROCESS VAPI AUDIO
    // -------------------------------------------------

    function processVapiAudio(
      rawAudio
    ) {

      if (!vapiStarted) {
        console.log(
          "[STT] Audio before Vapi start - waiting"
        );

        return;
      }

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
        !vapiSampleRate ||
        !Number.isFinite(
          vapiSampleRate
        )
      ) {
        console.error(
          "[STT] Invalid Vapi sample rate"
        );

        return;
      }

      const customerAudio =
        extractCustomerChannelPcm16(
          rawAudio,
          vapiChannels
        );

      if (
        !customerAudio.length
      ) {
        return;
      }

      // If Vapi is already 24kHz,
      // send directly to OpenAI.
      if (
        vapiSampleRate ===
        OPENAI_SAMPLE_RATE
      ) {
        sendAudioToOpenAI(
          customerAudio
        );

        return;
      }

      startTranscoder();

      if (
        transcoder &&
        transcoder.stdin &&
        !transcoder.stdin.destroyed
      ) {
        try {

          const canContinue =
            transcoder.stdin.write(
              customerAudio
            );

          if (!canContinue) {
            console.log(
              "[STT] FFmpeg input backpressure"
            );
          }

        } catch (error) {

          console.error(
            "[STT] Failed to write audio to FFmpeg:",
            error.message
          );
        }
      }
    }

    // -------------------------------------------------
    // OPENAI EVENT HANDLER
    // -------------------------------------------------

    function handleOpenAIMessage(
      rawData
    ) {

      let event;

      try {
        event =
          JSON.parse(
            rawData.toString()
          );
      } catch {

        console.log(
          "[STT] Ignoring invalid OpenAI JSON"
        );

        return;
      }

      // Useful to see all important OpenAI errors.
      if (
        event.type === "error"
      ) {

        console.error(
          "[STT] OpenAI ERROR:",
          JSON.stringify(
            event.error ||
            event
          )
        );

        return;
      }

      // Session is configured and ready.
      if (
        event.type ===
          "transcription_session.updated" ||
        event.type ===
          "transcription_session.created"
      ) {

        openaiReady = true;

        console.log(
          "[STT] OpenAI transcription session ready"
        );

        flushPendingAudio();

        return;
      }

      // Speech started.
      if (
        event.type ===
        "input_audio_buffer.speech_started"
      ) {

        console.log(
          "[STT] OpenAI detected speech"
        );

        return;
      }

      // Speech stopped.
      if (
        event.type ===
        "input_audio_buffer.speech_stopped"
      ) {

        console.log(
          "[STT] OpenAI detected end of speech"
        );

        return;
      }

      // OpenAI automatically committed an utterance.
      if (
        event.type ===
        "input_audio_buffer.committed"
      ) {

        console.log(
          `[STT] OpenAI committed audio item: ${event.item_id || "unknown"}`
        );

        return;
      }

      // Incremental transcript.
      if (
        event.type ===
        "conversation.item.input_audio_transcription.delta"
      ) {

        const itemId =
          event.item_id ||
          "current";

        const delta =
          typeof event.delta === "string"
            ? event.delta
            : "";

        if (!delta) {
          return;
        }

        const previous =
          partialTranscripts.get(
            itemId
          ) ||
          "";

        const combined =
          previous +
          delta;

        partialTranscripts.set(
          itemId,
          combined
        );

        sendTranscriptToVapi(
          clientWs,
          combined,
          "partial"
        );

        return;
      }

      // Final transcript.
      if (
        event.type ===
        "conversation.item.input_audio_transcription.completed"
      ) {

        const itemId =
          event.item_id ||
          "current";

        const transcript =
          typeof event.transcript ===
          "string"
            ? event.transcript.trim()
            : (
              partialTranscripts.get(
                itemId
              ) ||
              ""
            ).trim();

        partialTranscripts.delete(
          itemId
        );

        if (transcript) {

          console.log(
            `[STT] OpenAI FINAL: ${transcript}`
          );

          sendTranscriptToVapi(
            clientWs,
            transcript,
            "final"
          );
        }

        return;
      }

      // Transcription failure.
      if (
        event.type ===
        "conversation.item.input_audio_transcription.failed"
      ) {

        console.error(
          "[STT] OpenAI transcription failed:",
          JSON.stringify(
            event.error ||
            event
          )
        );

        return;
      }
    }

    // -------------------------------------------------
    // CONNECT TO OPENAI
    // -------------------------------------------------

    try {

      console.log(
        "[STT] Connecting to OpenAI Realtime..."
      );

      openaiWs =
        new WebSocket(
          OPENAI_REALTIME_URL,
          {
            headers: {
              Authorization:
                `Bearer ${OPENAI_API_KEY}`,

              "OpenAI-Beta":
                "realtime=v1"
            }
          }
        );

      openaiWs.on(
        "open",
        () => {

          console.log(
            "[STT] Connected to OpenAI Realtime"
          );

          // Configure a dedicated transcription session.
          //
          // Sorani Kurdish guidance is included in the prompt.
          // This helps the transcription model expect Kurdish
          // words, names, and common appointment vocabulary.
          openaiWs.send(
            JSON.stringify({
              type:
                "transcription_session.update",

              input_audio_format:
                "pcm16",

              input_audio_transcription: {
                model:
                  OPENAI_TRANSCRIPTION_MODEL,

                language:
                  STT_LANGUAGE,

                prompt:
                  "The speaker may speak Sorani Kurdish (Central Kurdish). Transcribe spoken Sorani Kurdish accurately using Kurdish Arabic script. Preserve Kurdish words and names. Common words include: سڵاو، چۆنی، باشم، سوپاس، بەڵێ، نەخێر، چاوپێکەوتن، پزیشک، نەخۆشخانە، کات، بەیانی، ئێوارە، ئەمڕۆ، سبەی، دووەم، سێیەم."
              },

              turn_detection: {
                type:
                  "server_vad",

                threshold:
                  0.35,

                prefix_padding_ms:
                  500,

                silence_duration_ms:
                  800
              },

              input_audio_noise_reduction: {
                type:
                  "near_field"
              }
            })
          );

          console.log(
            "[STT] OpenAI transcription configuration sent"
          );
        }
      );

      openaiWs.on(
        "message",
        (data) => {
          handleOpenAIMessage(
            data
          );
        }
      );

      openaiWs.on(
        "error",
        (error) => {

          console.error(
            "[STT] OpenAI WebSocket error:",
            error.message
          );
        }
      );

      openaiWs.on(
        "close",
        (
          code,
          reason
        ) => {

          openaiReady = false;

          console.log(
            `[STT] OpenAI WebSocket closed: ${code} ${reason.toString()}`
          );

          if (
            !clientClosed &&
            clientWs.readyState ===
              WebSocket.OPEN
          ) {

            console.error(
              "[STT] OpenAI connection closed during active call"
            );
          }
        }
      );

    } catch (error) {

      console.error(
        "[STT] OPENAI STARTUP ERROR:",
        error
      );

      try {
        clientWs.close();
      } catch {}

      return;
    }

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

          if (!vapiStarted) {

            console.log(
              "[STT] Audio received before start - ignoring until format is known"
            );

            return;
          }

          processVapiAudio(
            rawAudio
          );

          return;
        }

        // ---------------------------------------------
        // JSON CONTROL
        // ---------------------------------------------

        let message;

        try {
          message =
            JSON.parse(
              data.toString()
            );
        } catch {

          console.log(
            "[STT] Ignoring invalid Vapi JSON"
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
            ) ||
            16000;

          vapiChannels =
            Number(
              message.channels
            ) ||
            1;

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
            `[STT] Container: ${message.container || "unknown"}`
          );

          console.log(
            `[STT] Customer channel: 0`
          );

          console.log(
            `[STT] OpenAI target: PCM16 mono ${OPENAI_SAMPLE_RATE}Hz`
          );

          console.log(
            "========================================"
          );

          if (
            vapiSampleRate !==
            OPENAI_SAMPLE_RATE
          ) {

            startTranscoder();
          }

          return;
        }

        // ---------------------------------------------
        // FINALIZE
        //
        // Force OpenAI to commit remaining audio.
        // ------------------------------------------------

        if (
          message.type ===
            "control" &&
          message.event ===
            "finalize"
        ) {

          console.log(
            "[STT] Vapi requested finalize"
          );

          finalizeOpenAIAudio();

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

          console.log(
            "[STT] Vapi requested stop/end"
          );

          finalizeOpenAIAudio();
        }
      }
    );

    // =================================================
    // FINALIZE OPENAI AUDIO
    // =================================================

    function finalizeOpenAIAudio() {

      if (finalizing) {
        return;
      }

      finalizing = true;

      // Stop FFmpeg input first so all remaining
      // converted audio reaches OpenAI.
      if (
        transcoder &&
        transcoder.stdin &&
        !transcoder.stdin.destroyed
      ) {
        try {
          transcoder.stdin.end();
        } catch {}
      }

      // Give FFmpeg a short moment to flush
      // its final PCM output.
      setTimeout(
        () => {

          if (
            openaiWs &&
            openaiWs.readyState ===
              WebSocket.OPEN
          ) {

            try {

              openaiWs.send(
                JSON.stringify({
                  type:
                    "input_audio_buffer.commit"
                })
              );

              console.log(
                "[STT] OpenAI commit requested"
              );

            } catch (error) {

              console.error(
                "[STT] OpenAI commit error:",
                error.message
              );
            }
          }

          // Allow time for the final transcript.
          if (!closeTimer) {

            closeTimer =
              setTimeout(
                () => {

                  if (
                    openaiWs &&
                    (
                      openaiWs.readyState ===
                        WebSocket.OPEN ||
                      openaiWs.readyState ===
                        WebSocket.CONNECTING
                    )
                  ) {
                    try {
                      openaiWs.close();
                    } catch {}
                  }

                },
                2500
              );
          }

        },
        150
      );
    }

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

        if (closeTimer) {
          clearTimeout(
            closeTimer
          );

          closeTimer = null;
        }

        if (
          transcoder &&
          transcoder.stdin &&
          !transcoder.stdin.destroyed
        ) {
          try {
            transcoder.stdin.end();
          } catch {}
        }

        // Allow OpenAI to finish the current utterance.
        if (
          openaiWs &&
          openaiWs.readyState ===
            WebSocket.OPEN
        ) {

          try {
            openaiWs.send(
              JSON.stringify({
                type:
                  "input_audio_buffer.commit"
              })
            );
          } catch {}

          setTimeout(
            () => {

              if (
                openaiWs &&
                (
                  openaiWs.readyState ===
                    WebSocket.OPEN ||
                  openaiWs.readyState ===
                    WebSocket.CONNECTING
                )
              ) {
                try {
                  openaiWs.close();
                } catch {}
              }

            },
            1500
          );
        }
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
      "========================================"
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
      `TTS speaker: ${SPEAKER_ID}`
    );

    console.log(
      `TTS model: ${MODEL_VERSION}`
    );

    console.log(
      "----------------------------------------"
    );

    console.log(
      `STT provider: OpenAI Realtime`
    );

    console.log(
      `OpenAI URL: ${OPENAI_REALTIME_URL}`
    );

    console.log(
      `OpenAI model: ${OPENAI_TRANSCRIPTION_MODEL}`
    );

    console.log(
      `STT language: ${STT_LANGUAGE}`
    );

    console.log(
      `OpenAI required audio: PCM16 mono ${OPENAI_SAMPLE_RATE}Hz`
    );

    console.log(
      `OpenAI key configured: ${!!OPENAI_API_KEY}`
    );

    console.log(
      `TTS key configured: ${!!process.env.KURDISHTTS_TTS_KEY}`
    );

    console.log(
      "========================================"
    );
  }
);
