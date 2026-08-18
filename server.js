const express = require("express");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;

const KURDISH_TTS_URL =
  "https://www.kurdishtts.com/api/tts-proxy";

const KURDISH_STT_CONNECT_URL =
  "https://www.kurdishtts.com/api/stt-stream-connect";

const SPEAKER_ID = "sorani_1070";
const MODEL_VERSION = "v4";


/* =====================================================
   HEALTH CHECK
===================================================== */

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Kurdish Sorani Vapi TTS + STT Bridge",
    voice: SPEAKER_ID,
    model: MODEL_VERSION
  });
});


/* =====================================================
   TTS
   Vapi -> Railway -> KurdishTTS -> Railway -> Vapi
===================================================== */

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


/* =====================================================
   AUDIO CONVERSION FOR TTS
===================================================== */

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


/* =====================================================
   CREATE HTTP SERVER
===================================================== */

const server = http.createServer(app);


/* =====================================================
   CUSTOM VAPI TRANSCRIBER WEBSOCKET
===================================================== */

const wss = new WebSocket.Server({
  server,
  path: "/api/custom-transcriber"
});

wss.on("connection", async (vapiWs) => {

  console.log("Vapi connected to Kurdish STT bridge");

  let kurdishSttWs = null;
  let channels = 1;
  let sampleRate = 16000;
  let started = false;


  async function connectKurdishSTT() {

    const apiKey = process.env.KURDISHTTS_STT_KEY;

    if (!apiKey) {
      throw new Error(
        "KURDISHTTS_STT_KEY is not configured"
      );
    }

    console.log("Getting KurdishSTT temporary WebSocket URL...");

    const response = await fetch(
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

    if (!response.ok) {
      const errorText = await response.text();

      throw new Error(
        `Failed to get KurdishSTT WebSocket URL: ${errorText}`
      );
    }

    const data = await response.json();

    if (!data.websocket_url) {
      throw new Error(
        "KurdishSTT did not return websocket_url"
      );
    }

    console.log(
      `Connecting to KurdishSTT. Credits remaining: ${data.credits_remaining}`
    );

    kurdishSttWs = new WebSocket(data.websocket_url);


    kurdishSttWs.on("open", () => {
      console.log("Connected to KurdishSTT streaming WebSocket");
    });


    kurdishSttWs.on("message", (data) => {
      try {

        const result = JSON.parse(data.toString());

        if (result.error) {
          console.error(
            "KurdishSTT error:",
            result.error
          );
          return;
        }


        // Ignore "done" control messages
        if (
          result.type === "control" &&
          result.event === "done"
        ) {
          console.log("KurdishSTT finished processing");
          return;
        }


        if (!result.text) {
          return;
        }


        const transcriptType =
          result.is_final === true
            ? "final"
            : "partial";


        console.log(
          `[Kurdish STT ${transcriptType}] ${result.text}`
        );


        if (
          vapiWs.readyState === WebSocket.OPEN
        ) {

          vapiWs.send(
            JSON.stringify({
              type: "transcriber-response",
              transcription: result.text,
              channel: "customer",
              transcriptType
            })
          );

        }

      } catch (error) {

        console.error(
          "Error processing KurdishSTT response:",
          error
        );

      }
    });


    kurdishSttWs.on("error", (error) => {
      console.error(
        "KurdishSTT WebSocket error:",
        error.message
      );
    });


    kurdishSttWs.on("close", () => {
      console.log(
        "KurdishSTT WebSocket closed"
      );
    });

  }


  vapiWs.on(
    "message",
    async (data, isBinary) => {

      try {

        /* ---------------------------------------------
           VAPI START MESSAGE
        --------------------------------------------- */

        if (!isBinary) {

          const message = JSON.parse(
            data.toString()
          );

          console.log(
            "Vapi message:",
            message
          );


          if (
            message.type === "start" &&
            !started
          ) {

            started = true;

            sampleRate =
              Number(message.sampleRate) || 16000;

            channels =
              Number(message.channels) || 1;


            console.log(
              `Vapi audio started: ${sampleRate}Hz, ${channels} channel(s)`
            );


            if (sampleRate !== 16000) {
              throw new Error(
                `KurdishSTT requires 16000Hz but Vapi sent ${sampleRate}Hz`
              );
            }


            await connectKurdishSTT();

          }


          return;
        }


        /* ---------------------------------------------
           AUDIO FROM VAPI
        --------------------------------------------- */

        if (
          !kurdishSttWs ||
          kurdishSttWs.readyState !== WebSocket.OPEN
        ) {
          return;
        }


        let audioBuffer = Buffer.from(data);


        /*
          Vapi custom transcriber can send stereo audio:
          channel 0 = customer
          channel 1 = assistant

          KurdishSTT needs mono.

          Extract channel 0 (customer).
        */

        if (channels === 2) {

          const monoBuffer = Buffer.alloc(
            Math.floor(audioBuffer.length / 2)
          );

          let outputOffset = 0;

          for (
            let i = 0;
            i + 3 < audioBuffer.length;
            i += 4
          ) {

            // First 16-bit sample = customer channel
            monoBuffer[outputOffset++] =
              audioBuffer[i];

            monoBuffer[outputOffset++] =
              audioBuffer[i + 1];

          }

          audioBuffer =
            monoBuffer.subarray(0, outputOffset);

        }


        if (audioBuffer.length > 0) {

          kurdishSttWs.send(
            audioBuffer
          );

        }

      } catch (error) {

        console.error(
          "Vapi STT bridge error:",
          error
        );


        if (
          vapiWs.readyState === WebSocket.OPEN
        ) {

          vapiWs.send(
            JSON.stringify({
              type: "error",
              error: error.message
            })
          );

        }

      }

    }
  );


  /* =====================================================
     CLOSE / FINALIZE
  ===================================================== */

  vapiWs.on("close", () => {

    console.log(
      "Vapi transcriber WebSocket closed"
    );


    if (
      kurdishSttWs &&
      kurdishSttWs.readyState === WebSocket.OPEN
    ) {

      try {

        kurdishSttWs.send(
          JSON.stringify({
            type: "control",
            event: "finalize"
          })
        );

      } catch (error) {
        console.error(
          "Error finalizing KurdishSTT:",
          error.message
        );
      }


      setTimeout(() => {

        if (
          kurdishSttWs &&
          kurdishSttWs.readyState === WebSocket.OPEN
        ) {
          kurdishSttWs.close();
        }

      }, 1000);

    }

  });


  vapiWs.on("error", (error) => {
    console.error(
      "Vapi WebSocket error:",
      error.message
    );
  });

});


/* =====================================================
   START SERVER
===================================================== */

server.listen(PORT, () => {
  console.log(
    `Kurdish Vapi TTS + STT bridge listening on port ${PORT}`
  );
});
