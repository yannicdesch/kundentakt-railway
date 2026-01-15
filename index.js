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
  console.log(`📞 Twilio-Daten: CallSid=${callSid}, AccountSid=${req.body.AccountSid || 'unbekannt'}`);

  // Look up business by phone number via Edge Function
  let businessId = "";
  let businessName = "";

  const result = await callSupabaseAPI('lookup-business', { phoneNumber: toNumber });
  
  if (result?.business) {
    businessId = result.business.id;
    businessName = result.business.business_name;
    console.log(`✅ Business gefunden: ${businessName} (${businessId})`);
  } else {
    console.log(`❌ Kein Business gefunden für Nummer: ${toNumber}`);
    console.log(`⚠️ ACHTUNG: Agent wird ohne Firmenkontext gestartet!`);
    // Set empty name to force Hanne to use generic greeting
    businessName = "";
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
  let businessName = "";
  let callStartTime = Date.now();
  let transcript = [];
  let openaiWs = null;
  let sessionConfigured = false;
  let streamSid = "";
  let openaiReady = false;
  let twilioStarted = false;

// Build system prompt from business data - HANNE PERSONALITY
  const buildSystemPrompt = async (bizId, bizName) => {
    // Determine the display name - use the actual business name or fallback
    const displayName = bizName && bizName.trim() !== "" ? bizName : "diesem Handwerksbetrieb";
    
    // Hanne's core personality - experienced, calm, friendly office assistant
    let baseIdentity = `Du bist Hanne, die digitale Anrufassistentin von ${displayName}. 

PERSÖNLICHKEIT:
- Du bist eine erfahrene, ruhige und freundliche Büroassistenz mit 20 Jahren Erfahrung im Handwerk
- Du kennst alle Fachbegriffe (Rohrschelle, Dachsparren, Therme, Sicherungskasten, etc.)
- Du sprichst die Anrufer mit "Du" an - persönlich und nahbar
- Dein Ton ist warmherzig aber effizient, wie eine Kollegin die wirklich helfen will

SPRECHSTIL:
- Sprich natürlich und fließend, NICHT roboterhaft
- Nutze kurze, klare Sätze - maximal 2 Sätze pro Antwort
- Verwende natürliche Bestätigungen: "Okay, hab ich notiert.", "Alles klar.", "Verstanden, danke dir."
- Kleine Füllwörter sind okay: "Also", "Schau mal", "Moment"
- Antworte zügig und komm auf den Punkt
- WICHTIG: Wiederhole dich NIEMALS! Sage jeden Satz nur EINMAL. Wenn du etwas gesagt hast, gehe zum nächsten Punkt weiter.
- Warte nach deiner Antwort IMMER auf die Reaktion des Anrufers bevor du weitersprichst`;

    let businessInfoSection = "";
    let openingHoursSection = "";
    let availabilitySection = "";
    let faqSection = "";
    let servicesSection = "";
    let scriptSection = "";

    // Standard greeting in Hanne style - uses displayName
    const hanneGreeting = `Hallo, hier ist Hanne, der digitale Anrufassistent von ${displayName}. Aktuell ist gerade niemand persönlich erreichbar – aber ich bin gern für dich da. Worum geht's genau? Falls es dringend ist, sag mir das bitte direkt – zum Beispiel bei Heizung, Strom oder Wasserschaden. Ich leite dein Anliegen dann gezielt weiter.`;

    if (!bizId) {
      console.log("ℹ️ Keine Business-ID, verwende Standard-Prompt");
      businessInfoSection = `\n\nDEINE BEGRÜSSUNG (sprich diese EINMAL zu Beginn des Gesprächs, NICHT wiederholen):\n"${hanneGreeting}"`;
    } else {
      // Get business data via Edge Function
      const data = await callSupabaseAPI('get-business-data', { businessId: bizId });
      
      if (!data) {
        console.error("❌ Keine Business-Daten erhalten");
        businessInfoSection = `\n\nDEINE BEGRÜSSUNG (sprich diese EINMAL zu Beginn des Gesprächs, NICHT wiederholen):\n"${hanneGreeting}"`;
      } else {
        const { business, faqs, services, script } = data;

        if (business) {
          // Custom greeting oder Hanne-Standard
          if (business.custom_greeting) {
            businessInfoSection = `\n\nDEINE BEGRÜSSUNG (sprich diese EINMAL zu Beginn des Gesprächs, NICHT wiederholen):\n"${business.custom_greeting}"`;
          } else {
            businessInfoSection = `\n\nDEINE BEGRÜSSUNG (sprich diese EINMAL zu Beginn des Gesprächs, NICHT wiederholen):\n"${hanneGreeting}"`;
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
            businessInfoSection += `\n\nBRANCHE: ${categoryLabels[business.category] || business.category}`;
          }

          // Adresse
          if (business.address) {
            businessInfoSection += `\nFIRMENADRESSE: ${business.address}`;
          }

          // Weiterleitungsnummer
          if (business.forwarding_number) {
            businessInfoSection += `\nRÜCKRUFNUMMER: ${business.forwarding_number}`;
          }

          // Öffnungszeiten
          if (business.opening_hours && typeof business.opening_hours === 'object') {
            const hours = business.opening_hours;
            const dayLabels = {
              monday: 'Montag', tuesday: 'Dienstag', wednesday: 'Mittwoch',
              thursday: 'Donnerstag', friday: 'Freitag', saturday: 'Samstag', sunday: 'Sonntag'
            };
            
            openingHoursSection = "\n\nÖFFNUNGSZEITEN (DIESE KANNST DU AUF NACHFRAGE NENNEN):";
            for (const [day, dayData] of Object.entries(hours)) {
              if (dayLabels[day] && dayData && typeof dayData === 'object') {
                if (dayData.active && dayData.from && dayData.to) {
                  openingHoursSection += `\n- ${dayLabels[day]}: ${dayData.from} - ${dayData.to} Uhr`;
                } else if (dayData.active === false) {
                  openingHoursSection += `\n- ${dayLabels[day]}: Geschlossen`;
                }
              }
            }
            openingHoursSection += `\n\nWenn jemand nach den Öffnungszeiten fragt, nenne diese Zeiten konkret!`;
          }

          // Erreichbarkeitszeiten
          if (business.availability_mode) {
            const modeLabels = {
              'always': 'Ich bin rund um die Uhr erreichbar.',
              'scheduled': 'Ich bin nur zu bestimmten Zeiten aktiv.',
              'fallback': 'Ich springe ein, wenn der Betrieb nicht selbst abheben kann.'
            };
            availabilitySection = `\n\nERREICHBARKEIT: ${modeLabels[business.availability_mode] || business.availability_mode}`;
          }
        }

        // FAQs
        if (faqs?.length > 0) {
          faqSection = "\n\nHÄUFIGE FRAGEN:";
          faqs.forEach((faq) => {
            faqSection += `\n- ${faq.question} → ${faq.answer}`;
          });
        }

        // Services
        if (services?.length > 0) {
          servicesSection = "\n\nDIENSTLEISTUNGEN:";
          services.forEach((s) => {
            servicesSection += `\n- ${s.service_name}`;
            if (s.description) servicesSection += `: ${s.description}`;
            if (s.price_range) servicesSection += ` (${s.price_range})`;
            if (s.typical_duration) servicesSection += ` [${s.typical_duration}]`;
            if (s.is_emergency_service) servicesSection += ` ⚡ NOTDIENST`;
          });
        }

        // Call Script
        if (script) {
          if (script.tone) {
            scriptSection += `\n\nTONALITÄT: ${script.tone}`;
          }
          if (script.fallback_message) {
            scriptSection += `\nWENN DU NICHT WEITERHELFEN KANNST: "${script.fallback_message}"`;
          }
          if (script.booking_link) {
            scriptSection += `\nONLINE-TERMINBUCHUNG: ${script.booking_link}`;
          }
        }
      }
    }

    // Zusammengebautes Prompt
    let prompt = baseIdentity + businessInfoSection + openingHoursSection + availabilitySection + faqSection + servicesSection + scriptSection;

    prompt += `\n\nNOTFALL-ERKENNUNG:
Erkenne diese Schlüsselwörter als DRINGEND/NOTFALL:
- "Notfall", "dringend", "sofort"
- "kein Strom", "Stromausfall", "Sicherung raus"
- "Wasserrohrbruch", "Rohrbruch", "Überschwemmung", "Wasser läuft"
- "Heizung aus", "keine Heizung", "Heizungsausfall"
- "Gasgeruch", "Gas riecht"

Bei Notfällen: Zeige Verständnis, bleib ruhig und versichere: "Das klingt dringend. Ich gebe das sofort weiter, damit sich jemand schnellstmöglich bei dir meldet."

FEEDBACK-PHRASEN (nutze diese natürlich):
- "Okay, ich hab das notiert."
- "Danke dir. Ich gebe das so weiter."
- "Alles klar, ist angekommen."
- "Verstanden, kümmern wir uns drum."

NAMENSERKENNUNG:
- Höre genau hin wenn jemand seinen Namen nennt
- Akzeptiere verschiedene Schreibweisen und frag bei Unsicherheit nach: "Kannst du mir deinen Namen noch einmal buchstabieren?"
- Übliche Muster: "Mein Name ist...", "Ich bin der/die...", "Hier ist...", "...am Apparat"
- Bestätige den Namen wenn du ihn verstanden hast: "Okay [Name], ich hab das notiert."

NACHFRAGEN ZUM PROBLEM (WICHTIG!):
Stelle gezielte Rückfragen zum Anliegen, damit der Handwerker gut vorbereitet ist:
- "Seit wann besteht das Problem?"
- "Ist das zum ersten Mal passiert oder gab es das schon öfter?"
- "Kannst du mir beschreiben, was genau passiert ist?"
- "Weißt du, welches Gerät oder welcher Bereich betroffen ist?" (z.B. Marke der Heizung, welches Stockwerk)
- "Hast du schon etwas versucht, um das Problem zu beheben?"
- "Ist der Bereich noch zugänglich oder gibt es Einschränkungen?"
Frage 2-3 relevante Fragen je nach Situation - nicht alle auf einmal!

WICHTIGE REGELN:
- Erfasse: Name, Telefonnummer (falls nicht automatisch erkannt), Anliegen mit Details
- Frage nach, ob ein Rückruf gewünscht wird
- Bei Preisfragen ohne Info: "Die genauen Kosten hängen vom Aufwand ab. Am besten macht ihr einen Termin zur Begutachtung."
- KEINE medizinischen, finanziellen oder rechtlichen Ratschläge
- Sei effizient - komm zum Punkt, keine langen Monologe
- NIEMALS wiederholen was du gerade gesagt hast

GESPRÄCHSENDE:
"Super, ich hab alles aufgenommen. Wir melden uns schnellstmöglich bei dir. Tschüss und einen schönen Tag noch!"`;

    console.log(`📝 Hanne-Prompt für ${bizName} erstellt - ${prompt.length} Zeichen`);
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
        voice: "shimmer", // Shimmer: Warm, freundlich - perfekt für Hanne
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.6,           // Höher = weniger empfindlich, verhindert Unterbrechungen
          prefix_padding_ms: 400,   // Mehr Puffer am Anfang
          silence_duration_ms: 800, // Längere Stille bevor Antwort, verhindert Überlappung
        },
        temperature: 0.6,           // Weniger kreativ = konsistentere Antworten
      },
    };
    
    openaiWs.send(JSON.stringify(sessionConfig));
    console.log("✅ Hanne Session konfiguriert (Stimme: shimmer)");
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
        businessName = params.businessName || "";
        streamSid = data.start.streamSid || "";
        callStartTime = Date.now();
        twilioStarted = true;
        
        console.log(`📋 Twilio Stream gestartet:`);
        console.log(`   - Business: ${businessName || '(kein Name)'}`);
        console.log(`   - Business-ID: ${businessId || '(keine ID)'}`);
        console.log(`   - Anrufer: ${callerNumber}`);
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

    // Detect flags from transcript - EXTENDED for Hanne
    const transcriptLower = fullTranscript.toLowerCase();
    
    // Erweiterte Notfall-Erkennung
    const isEmergency =
      transcriptLower.includes("notfall") ||
      transcriptLower.includes("dringend") ||
      transcriptLower.includes("sofort") ||
      transcriptLower.includes("rohrbruch") ||
      transcriptLower.includes("wasserrohrbruch") ||
      transcriptLower.includes("wasser läuft") ||
      transcriptLower.includes("überschwemmung") ||
      transcriptLower.includes("stromausfall") ||
      transcriptLower.includes("kein strom") ||
      transcriptLower.includes("sicherung") ||
      transcriptLower.includes("heizung aus") ||
      transcriptLower.includes("heizungsausfall") ||
      transcriptLower.includes("keine heizung") ||
      transcriptLower.includes("gasgeruch") ||
      transcriptLower.includes("gas riecht");
      
    const needsCallback =
      transcriptLower.includes("rückruf") ||
      transcriptLower.includes("zurückrufen") ||
      transcriptLower.includes("melden");
      
    const isQuoteRequest =
      transcriptLower.includes("angebot") ||
      transcriptLower.includes("kostenvoranschlag") ||
      transcriptLower.includes("preis") ||
      transcriptLower.includes("was kostet");

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
