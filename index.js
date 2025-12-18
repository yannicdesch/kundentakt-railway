import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilioPkg from "twilio";

dotenv.config();
const { twiml } = twilioPkg;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// --- TESTROUTE (zum Prüfen, ob Railway läuft) ---
app.get("/", (req, res) => {
  res.send("✅ Kundentakt API läuft erfolgreich auf Railway!");
});

// --- TWILIO-WEBHOOK ---
app.post("/twilio/incoming", async (req, res) => {
  try {
    const response = new twiml.VoiceResponse();
    response.say(
      { voice: "Polly.Vicki", language: "de-DE" },
      "Hallo, hier ist Kundentakt. Ihr digitaler Telefonassistent funktioniert einwandfrei."
    );
    res.type("text/xml");
    res.send(response.toString());
  } catch (err) {
    console.error("Fehler im Twilio-Webhook:", err);
    res.status(500).send("Internal Server Error");
  }
});

app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
