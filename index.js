import express from "express";
import bodyParser from "body-parser";
import WebSocket, { WebSocketServer } from "ws";
import { config } from "dotenv";
config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

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

const wsServer = new WebSocketServer({ noServer: true });

wsServer.on("connection", async (twilioWs, req) => {
  console.log("📞 Neue Twilio-Verbindung");

  // Verbindung zu OpenAI Realtime API
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Wenn OpenAI verbunden -> Realtime starten
  openaiWs.on("open", () => {
    console.log("🧠 Verbunden mit OpenAI Realtime");

    // Kurze Verzögerung, damit Twilio bereit ist
    setTimeout(() => {
      openaiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions:
              "Du bist der Telefonassistent von Kundentakt. Sprich sofort mit einer freundlichen deutschen Begrüßung. Sag z. B.: 'Hallo, hier ist der Kundentakt-Assistent. Wie kann ich Ihnen helfen?'",
            modalities: ["audio"],
            audio: { voice: "alloy" },
          },
        })
      );
    }, 250);
  });

  // Audio von Twilio → OpenAI
  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.event === "media") {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      } else if (data.event === "stop") {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      }
    } catch (err) {
      console.error("Fehler in Twilio-Stream:", err.message);
    }
  });

  // Audio von OpenAI → Twilio
  openaiWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "response.audio.delta" && data.delta) {
        // Sicherheitsabfrage: Nur senden, wenn Twilio-WS bereit ist
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              media: { payload: data.delta },
            })
          );
        }
      }
    } catch (err) {
      console.error("Fehler bei OpenAI-Antwort:", err.message);
    }
  });

  twilioWs.on("close", () => {
    console.log("📴 Twilio Verbindung beendet");
    openaiWs.close();
  });
});

const server = app.listen(process.env.PORT || 3000, () =>
  console.log(`🚀 Voice Agent läuft auf Port ${process.env.PORT || 3000}`)
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
