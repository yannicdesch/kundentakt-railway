import express from "express";
import bodyParser from "body-parser";
import WebSocket, { WebSocketServer } from "ws";
import { config } from "dotenv";

config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ============================================
// API Helper - Calls Supabase Edge Function instead of direct DB access
// ============================================

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://agcxkrpqxpjymxqdrnne.supabase.co';
const RAILWAY_API_SECRET = process.env.RAILWAY_API_SECRET || 'kundentakt-railway-2024';

const callSupabaseAPI = async (action, data) => {
  try {
    console.log(`🔗 API Call: ${action}`);
    const response = await fetch(`${SUPABASE_URL}/functions/v1/railway-api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-railway-secret': RAILWAY_API_SECRET
      },
      body: JSON.stringify({ action, data })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ API Error (${action}):`, response.status, errorText);
      return null;
    }

    const result = await response.json();
    console.log(`✅ API Success (${action})`);
    return result;
  } catch (err) {
    console.error(`❌ API Exception (${action}):`, err.message);
    return null;
  }
};

// Startup-Diagnose
console.log("🔧 Supabase URL:", SUPABASE_URL);
console.log("🔧 Railway API Secret:", RAILWAY_API_SECRET ? "gesetzt" : "FEHLT!");
console.log("🔧 OpenAI API Key:", process.env.OPENAI_API_KEY ? "gesetzt" : "FEHLT!");

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

  // Look up business by phone number via Edge Function
  let businessId = "";
  let businessName = "Kundentakt";

  const result = await callSupabaseAPI('lookup-business', { phoneNumber: toNumber });
  
  if (result?.business) {
    businessId = result.business.id;
    businessName = result.business.business_name;
    console.log(`✅ Business gefunden: ${businessName} (${businessId})`);
  } else {
    console.log(`⚠️ Kein Business gefunden für: ${toNumber}`);
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
    let baseIdentity = `Du bist der freundliche Telefonassistent von ${bizName}. Sprich Deutsch und sei hilfsbereit.`;
    let businessInfoSection = "";
    let openingHoursSection = "";
    let availabilitySection = "";
    let faqSection = "";
    let servicesSection = "";
    let scriptSection = "";

    if (!bizId) {
      console.log("ℹ️ Keine Business-ID, verwende Standard-Prompt");
      businessInfoSection = `\n\nBegrüße den Anrufer freundlich mit "Guten Tag, Sie sprechen mit dem Telefonassistenten von ${bizName}. Wie kann ich Ihnen helfen?"`;
    } else {
      // Get business data via Edge Function
      const data = await callSupabaseAPI('get-business-data', { businessId: bizId });
      
      if (!data) {
        console.error("❌ Keine Business-Daten erhalten");
        businessInfoSection = `\n\nBegrüße den Anrufer mit "Guten Tag, Sie sprechen mit dem Telefonassistenten von ${bizName}. Wie kann ich Ihnen helfen?"`;
      } else {
        const { business, faqs, services, script } = data;

        if (business) {
          // Custom greeting oder Standard
          if (business.custom_greeting) {
            businessInfoSection = `\n\nDeine personalisierte Begrüßung: "${business.custom_greeting}" - erwähne dabei immer den Firmennamen ${bizName}.`;
          } else {
            businessInfoSection = `\n\nBegrüße den Anrufer mit "Guten Tag, Sie sprechen mit dem Telefonassistenten von ${bizName}. Wie kann ich Ihnen helfen?"`;
          }

          // Branche
          if (business.category) {
            const categoryLabels = {
              'shk': 'SHK (Sanitär, Heizung, Klima)',
              'elektro': 'Elektro',
              'dachdecker': 'Dachdecker',
              'gebaeudeservice': 'Gebäudeservice',
              'rohrreinigung': 'Rohrreinigung',
              'sonstiges': 'Sonstiges Handwerk'
            };
            businessInfoSection += `\n\nBranche: ${categoryLabels[business.category] || business.category}`;
          }

          // Adresse
          if (business.address) {
            businessInfoSection += `\nFirmenadresse: ${business.address}`;
          }

          // Weiterleitungsnummer
          if (business.forwarding_number) {
            businessInfoSection += `\nRückrufnummer: ${business.forwarding_number}`;
          }

          // Öffnungszeiten
          if (business.opening_hours && typeof business.opening_hours === 'object') {
            const hours = business.opening_hours;
            const dayLabels = {
              monday: 'Montag', tuesday: 'Dienstag', wednesday: 'Mittwoch',
              thursday: 'Donnerstag', friday: 'Freitag', saturday: 'Samstag', sunday: 'Sonntag'
            };
            
            openingHoursSection = "\n\nÖffnungszeiten des Betriebs:";
            for (const [day, dayData] of Object.entries(hours)) {
              if (dayLabels[day] && dayData && typeof dayData === 'object') {
                if (dayData.active && dayData.from && dayData.to) {
                  openingHoursSection += `\n- ${dayLabels[day]}: ${dayData.from} - ${dayData.to} Uhr`;
                } else if (dayData.active === false) {
                  openingHoursSection += `\n- ${dayLabels[day]}: Geschlossen`;
                }
              }
            }
          }

          // Erreichbarkeitszeiten
          if (business.availability_mode) {
            const modeLabels = {
              'always': 'Der Telefonassistent ist rund um die Uhr erreichbar.',
              'scheduled': 'Der Telefonassistent ist nur zu bestimmten Zeiten aktiv.',
              'fallback': 'Der Telefonassistent springt ein, wenn der Betrieb nicht selbst abheben kann.'
            };
            availabilitySection = `\n\nErreichbarkeit: ${modeLabels[business.availability_mode] || business.availability_mode}`;
          }
        }

        // FAQs
        if (faqs?.length > 0) {
          faqSection = "\n\nHäufig gestellte Fragen und Antworten:";
          faqs.forEach((faq) => {
            faqSection += `\n- Frage: ${faq.question}\n  Antwort: ${faq.answer}`;
          });
        }

        // Services
        if (services?.length > 0) {
          servicesSection = "\n\nAngebotene Dienstleistungen:";
          services.forEach((s) => {
            servicesSection += `\n- ${s.service_name}`;
            if (s.description) servicesSection += `: ${s.description}`;
            if (s.price_range) servicesSection += ` (Preis: ${s.price_range})`;
            if (s.typical_duration) servicesSection += ` [Dauer: ${s.typical_duration}]`;
            if (s.is_emergency_service) servicesSection += ` ⚡ NOTDIENST`;
          });
        }

        // Call Script
        if (script) {
          if (script.greeting_text) {
            const personalizedGreeting = script.greeting_text.replace(/Telefonassistenten(?! von)/g, `Telefonassistenten von ${bizName}`);
            scriptSection += `\n\nEmpfohlener Begrüßungstext: ${personalizedGreeting}`;
          }
          if (script.tone) {
            scriptSection += `\nTonalität: ${script.tone}`;
          }
          if (script.fallback_message) {
            scriptSection += `\nWenn du nicht weiterhelfen kannst, sage: "${script.fallback_message}"`;
          }
          if (script.booking_link) {
            scriptSection += `\nTerminbuchung online möglich unter: ${script.booking_link}`;
          }
        }
      }
    }

    // Zusammengebautes Prompt
    let prompt = baseIdentity + businessInfoSection + openingHoursSection + availabilitySection + faqSection + servicesSection + scriptSection;

    prompt += `\n\nWichtige Verhaltensregeln:
- Du arbeitest für ${bizName} - erwähne den Firmennamen in der Begrüßung!
- Erfasse immer: Name, Telefonnummer und Anliegen des Anrufers
- Bei Notfällen (Wasserrohrbruch, Stromausfall, Heizungsausfall etc.) markiere dies als DRINGEND
- Frage nach, ob ein Rückruf gewünscht wird
- Nenne bei Fragen nach Öffnungszeiten die hinterlegten Zeiten
- Wenn nach Preisen gefragt wird, nenne die hinterlegten Preisspannen oder verweise auf ein Angebot
- Sei freundlich, professionell und halte Antworten kurz
- Beginne das Gespräch sofort mit der Begrüßung`;

    console.log(`📝 System-Prompt für ${bizName} erstellt - ${prompt.length} Zeichen`);
    return prompt;
  };

  // Try to configure and start
  const tryConfigureAndStart = async () => {
    if (sessionConfigured) return;
    if (!openaiReady || !twilioStarted) return;
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

    sessionConfigured = true;
    console.log(`🔧 Konfiguriere OpenAI Session für: ${businessName}`);

    const systemPrompt = await buildSystemPrompt(businessId, businessName);

    const sessionConfig = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: systemPrompt,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
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
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

    console.log("🎤 Triggere AI Begrüßung...");
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio", "text"] },
    }));
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
        await tryConfigureAndStart();
      }

      if (data.type === "session.updated") {
        console.log("✅ OpenAI Session konfiguriert");
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
          twilioWs.send(JSON.stringify({
            event: "media",
            streamSid: streamSid,
            media: { payload: data.delta },
          }));
        }
      }

    } catch (err) {
      console.error("Fehler bei OpenAI-Antwort:", err.message);
    }
  });

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WebSocket Fehler:", err.message);
  });

  openaiWs.on("close", (code, reason) => {
    console.log(`🔌 OpenAI Verbindung geschlossen: ${code}`);
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
        
        console.log(`📋 Twilio Stream: ${businessName} (${businessId || 'kein Match'})`);
        await tryConfigureAndStart();
      }

      if (data.event === "media" && openaiWs && openaiWs.readyState === WebSocket.OPEN && sessionConfigured) {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload,
        }));
      }

      if (data.event === "stop") {
        console.log("📴 Twilio Stream beendet");
        await saveCallLog();
      }
    } catch (err) {
      console.error("Fehler in Twilio-Stream:", err.message);
    }
  });

  // Save call log via Edge Function
  const saveCallLog = async () => {
    const callDuration = Math.round((Date.now() - callStartTime) / 1000);
    const fullTranscript = transcript
      .map((t) => `${t.role === "user" ? "Anrufer" : "Assistent"}: ${t.text}`)
      .join("\n");

    console.log(`💾 Call beendet: ${callDuration}s, ${transcript.length} Nachrichten`);

    if (!businessId) {
      console.log("⚠️ Keine Business-ID, überspringe Speicherung");
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
              { role: "system", content: "Fasse das folgende Telefongespräch in 2-3 Sätzen zusammen." },
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

    // Save via Edge Function
    await callSupabaseAPI('save-call-log', {
      callLog: {
        business_id: businessId,
        caller_number: callerNumber,
        call_duration: callDuration,
        full_transcript: fullTranscript,
        ai_summary: aiSummary,
        is_emergency: isEmergency,
        needs_callback: needsCallback,
        is_quote_request: isQuoteRequest,
      }
    });
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
