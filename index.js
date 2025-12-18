import express from "express";
import bodyParser from "body-parser";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import { config } from "dotenv";
config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio ruft diesen Endpoint auf, wenn ein Anruf reinkommt
app.post("/twilio/incoming", (req, res) => {
  const response = `
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/media" />
      </Connect>
    </Response>
  `;
  res.type("text/xml");
  res.send(response);
});

// WebSocket für Twilio Media Streams
const wsServer = new WebSocketServer({ noServer: true });

// Lokaler Speicher pro Anruf
const activeCalls = new Map();

wsServer.on("connection", async (twilioWs, req) => {
  console.log("📞 Neue Twilio-Verbindung");

  // OpenAI Realtime-Session erstellen
  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openaiWs.on("open", () => {
    console.log("🧠 Verbunden mit OpenAI Realtime");
  });

  // Audio von Twilio → OpenAI
  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.event === "media") {
        const audio = data.media.payload;
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio,
        }));
      } else if (data.event === "stop") {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWs.send(JSON.stringify({
          type: "response.create",
          response: {
            instructions: "Antworte freundlich und hilfsbereit auf Deutsch.",
            modalities: ["audio"],
            audio: { voice: "alloy" },
          },
        }));
      }
    } catch (err) {
      console.error("Fehler in Twilio-Stream:", err.message);
    }
  });

  // Antwort von OpenAI → Twilio zurücksenden
  openaiWs.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.type === "response.audio.delta" && data.delta) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          media: { payload: data.delta },
        })
      );
    }
  });

  twilioWs.on("close", () => {
    console.log("📴 Twilio-Stream beendet");
    openaiWs.close();
  });
});

// HTTP + WebSocket kombinieren
const server = app.listen(process.env.PORT || 3000, () =>
  console.log(`🚀 Kundentakt Voice Agent läuft auf Port ${process.env.PORT || 3000}`)
);

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/media") {
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});
