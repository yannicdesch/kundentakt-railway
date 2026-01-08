import express from "express";
import bodyParser from "body-parser";
import WebSocket, { WebSocketServer } from "ws";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "kundentakt-voice-agent" });
});

// Twilio incoming call webhook
app.post("/twilio/incoming", async (req, res) => {
  const callerNumber = req.body.From || "unbekannt";
  const toNumber = req.body.To || "";
  const callSid = req.body.CallSid || "";

  console.log(`📞 Eingehender Anruf von ${callerNumber} an ${toNumber}`);

  // Look up business by phone number
  let businessId = "";
  let businessName = "Kundentakt";

  try {
    const { data: business } = await supabase
      .from("businesses")
      .select("id, business_name")
      .eq("phone_number_assigned", toNumber)
      .single();

    if (business) {
      businessId = business.id;
      businessName = business.business_name;
    }
  } catch (err) {
    console.error("Fehler beim Business-Lookup:", err.message);
  }

  const response = `
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/media">
          <Parameter name="businessId" value="${businessId}" />
          <Parameter name="callerNumber" value="${callerNumber}" />
          <Parameter name="callSid" value="${callSid}" />
          <Parameter name="businessName" value="${businessName}" />
        </Stream>
      </Connect>
    </Response>
  `;

  res.type("text/xml");
  res.send(response);
});

const wsServer = new WebSocketServer({ noServer: true });

wsServer.on("connection", async (twilioWs, req) => {
  console.log("📞 Neue Twilio-Verbindung");

  let businessId = "";
  let callerNumber = "";
  let callSid = "";
  let businessName = "Kundentakt";
  let callStartTime = Date.now();
  let transcript = [];
  let openaiWs = null;
  let sessionConfigured = false;
  let streamSid = "";
  let openaiReady = false;
  let twilioStarted = false;

  // Build system prompt from business data
  const buildSystemPrompt = async (bizId, bizName) => {
    let prompt = `Du bist der freundliche Telefonassistent von ${bizName}. Sprich Deutsch und sei hilfsbereit.`;

    if (!bizId) {
      console.log("ℹ️ Keine Business-ID, verwende Standard-Prompt");
      prompt += `\n\nBegrüße den Anrufer freundlich und frage wie du helfen kannst.`;
    } else {
      try {
        const { data: business } = await supabase
          .from("businesses")
          .select("custom_greeting, category, opening_hours")
          .eq("id", bizId)
          .single();

        if (business?.custom_greeting) {
          prompt = business.custom_greeting;
        }

        const { data: faqs } = await supabase
          .from("faqs")
          .select("question, answer")
          .eq("business_id", bizId)
          .limit(10);

        if (faqs?.length > 0) {
          prompt += "\n\nHäufige Fragen und Antworten:";
          faqs.forEach((faq) => {
            prompt += `\n- Frage: ${faq.question}\n  Antwort: ${faq.answer}`;
          });
        }

        const { data: services } = await supabase
          .from("service_catalog")
          .select("service_name, description, price_range")
          .eq("business_id", bizId)
          .limit(10);

        if (services?.length > 0) {
          prompt += "\n\nAngebotene Dienstleistungen:";
          services.forEach((s) => {
            prompt += `\n- ${s.service_name}`;
            if (s.description) prompt += `: ${s.description}`;
            if (s.price_range) prompt += ` (${s.price_range})`;
          });
        }

        const { data: script } = await supabase
          .from("call_scripts")
          .select("greeting_text, fallback_message, tone")
          .eq("business_id", bizId)
          .single();

        if (script) {
          if (script.greeting_text) {
            prompt += `\n\nBegrüßung: ${script.greeting_text}`;
          }
          if (script.tone) {
            prompt += `\nTonalität: ${script.tone}`;
          }
        }
      } catch (err) {
        console.error("Fehler beim Laden der Business-Daten:", err.message);
      }
    }

    prompt += `\n\nWichtige Regeln:
- Erfasse Name, Telefonnummer und Anliegen des Anrufers
- Bei Notfällen (Wasserrohrbruch, Stromausfall, etc.) markiere dies als dringend
- Frage nach, ob ein Rückruf gewünscht wird
- Sei freundlich und professionell
- Halte die Antworten kurz und prägnant
- Beginne das Gespräch sofort mit einer freundlichen Begrüßung`;

    return prompt;
  };

  // Try to configure and start - only runs when BOTH are ready
  const tryConfigureAndStart = async () => {
    if (sessionConfigured) {
      console.log("⏭️ Session bereits konfiguriert");
      return;
    }
    
    if (!openaiReady) {
      console.log("⏳ Warte auf OpenAI Verbindung...");
      return;
    }
    
    if (!twilioStarted) {
      console.log("⏳ Warte auf Twilio Start...");
      return;
    }

    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
      console.log("⚠️ OpenAI WebSocket nicht offen");
      return;
    }

    sessionConfigured = true;
    console.log(`🔧 Konfiguriere OpenAI Session für: ${businessName} (${businessId || 'kein Business'})`);

    const systemPrompt = await buildSystemPrompt(businessId, businessName);
    console.log("📝 System Prompt erstellt, Länge:", systemPrompt.length);

    // Configure session
    const sessionConfig = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: systemPrompt,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: {
          model: "whisper-1",
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      },
    };
    
    openaiWs.send(JSON.stringify(sessionConfig));
    console.log("✅ Session.update gesendet");
  };

  // Trigger initial AI greeting
  const triggerGreeting = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
      console.log("⚠️ OpenAI nicht bereit für Greeting");
      return;
    }

    console.log("🎤 Triggere AI Begrüßung...");
    const greetingRequest = {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
      },
    };
    openaiWs.send(JSON.stringify(greetingRequest));
    console.log("✅ Greeting Request gesendet");
  };

  // Connect to OpenAI Realtime API
  console.log("🔌 Verbinde mit OpenAI Realtime API...");
  
  openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("🧠 Verbunden mit OpenAI Realtime API");
  });

  openaiWs.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === "session.created") {
        console.log("📝 OpenAI Session erstellt");
        openaiReady = true;
        // Try to configure now that OpenAI is ready
        await tryConfigureAndStart();
      }

      if (data.type === "session.updated") {
        console.log("✅ OpenAI Session konfiguriert erfolgreich");
        // Trigger greeting after session is configured
        setTimeout(triggerGreeting, 500);
      }

      if (data.type === "error") {
        console.error("❌ OpenAI Fehler:", JSON.stringify(data.error));
      }

      // Collect transcript
      if (data.type === "conversation.item.input_audio_transcription.completed") {
        console.log("👤 User:", data.transcript);
        transcript.push({ role: "user", text: data.transcript });
      }

      if (data.type === "response.audio_transcript.done") {
        console.log("🤖 Assistant:", data.transcript);
        transcript.push({ role: "assistant", text: data.transcript });
      }

      // Send audio to Twilio
      if (data.type === "response.audio.delta" && data.delta) {
        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid: streamSid,
              media: { payload: data.delta },
            })
          );
        }
      }

      if (data.type === "response.audio.done") {
        console.log("🔊 Audio Response abgeschlossen");
      }

      if (data.type === "response.done") {
        console.log("✅ Response komplett abgeschlossen");
      }

    } catch (err) {
      console.error("Fehler bei OpenAI-Antwort:", err.message);
    }
  });

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WebSocket Fehler:", err.message);
  });

  openaiWs.on("close", (code, reason) => {
    console.log(`🔌 OpenAI Verbindung geschlossen: ${code} - ${reason}`);
  });

  // Audio from Twilio
  twilioWs.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "start") {
        const params = data.start.customParameters || {};
        businessId = params.businessId || "";
        callerNumber = params.callerNumber || "";
        callSid = params.callSid || "";
        businessName = params.businessName || "Kundentakt";
        streamSid = data.start.streamSid || "";
        callStartTime = Date.now();
        twilioStarted = true;
        
        console.log(`📋 Twilio Stream gestartet:`);
        console.log(`   - Business: ${businessName} (${businessId || 'kein Match'})`);
        console.log(`   - Caller: ${callerNumber}`);
        console.log(`   - StreamSid: ${streamSid}`);

        // Try to configure now that Twilio is ready
        await tryConfigureAndStart();
      }

      if (data.event === "media" && openaiWs && openaiWs.readyState === WebSocket.OPEN && sessionConfigured) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      }

      if (data.event === "stop") {
        console.log("📴 Twilio Stream beendet");
        await saveCallLog();
      }
    } catch (err) {
      console.error("Fehler in Twilio-Stream:", err.message);
    }
  });

  // Save call log to Supabase
  const saveCallLog = async () => {
    const callDuration = Math.round((Date.now() - callStartTime) / 1000);
    const fullTranscript = transcript
      .map((t) => `${t.role === "user" ? "Anrufer" : "Assistent"}: ${t.text}`)
      .join("\n");

    console.log(`💾 Call beendet: ${callDuration}s, ${transcript.length} Nachrichten`);

    if (!businessId) {
      console.log("⚠️ Keine Business-ID, überspringe DB-Speicherung");
      return;
    }

    // Detect flags from transcript
    const transcriptLower = fullTranscript.toLowerCase();
    const isEmergency =
      transcriptLower.includes("notfall") ||
      transcriptLower.includes("dringend") ||
      transcriptLower.includes("rohrbruch") ||
      transcriptLower.includes("wasserrohrbruch") ||
      transcriptLower.includes("stromausfall");
    const needsCallback =
      transcriptLower.includes("rückruf") ||
      transcriptLower.includes("zurückrufen");
    const isQuoteRequest =
      transcriptLower.includes("angebot") ||
      transcriptLower.includes("kostenvoranschlag") ||
      transcriptLower.includes("preis");

    // Generate AI summary
    let aiSummary = "";
    if (fullTranscript.length > 10) {
      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content:
                  "Fasse das folgende Telefongespräch in 2-3 Sätzen zusammen. Nenne das Anliegen und wichtige Details.",
              },
              { role: "user", content: fullTranscript },
            ],
            max_tokens: 150,
          }),
        });

        const result = await response.json();
        aiSummary = result.choices?.[0]?.message?.content || "";
      } catch (err) {
        console.error("Fehler bei Summary:", err.message);
      }
    }

    try {
      await supabase.from("call_logs").insert({
        business_id: businessId,
        caller_number: callerNumber,
        call_duration: callDuration,
        full_transcript: fullTranscript,
        ai_summary: aiSummary,
        is_emergency: isEmergency,
        needs_callback: needsCallback,
        is_quote_request: isQuoteRequest,
      });
      console.log("✅ Call-Log gespeichert in Datenbank");
    } catch (err) {
      console.error("Fehler beim Speichern:", err.message);
    }
  };

  twilioWs.on("close", () => {
    console.log("📴 Twilio Verbindung beendet");
    if (openaiWs) openaiWs.close();
  });

  twilioWs.on("error", (err) => {
    console.error("❌ Twilio WebSocket Fehler:", err.message);
  });
});

const server = app.listen(process.env.PORT || 3000, () =>
  console.log(`🚀 Voice Agent läuft auf Port ${process.env.PORT || 3000}`)
);

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/media" || request.url?.startsWith("/media?")) {
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});
