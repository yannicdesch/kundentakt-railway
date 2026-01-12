import express from "express";
import bodyParser from "body-parser";
import WebSocket, { WebSocketServer } from "ws";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ============================================
// LAZY SUPABASE CLIENT - Wird bei jeder Anfrage neu erstellt
// ============================================

// Diese Funktion erstellt bei JEDEM Aufruf einen frischen Client
// um Probleme mit Railway Container-Restarts zu vermeiden
const getSupabaseClient = async () => {
  // Lies Env-Vars JETZT (nicht beim Modul-Start)
  const url = process.env.SUPABASE_URL;
  let key = process.env.SUPABASE_SERVICE_KEY;
  
  if (!url || !key) {
    console.error("❌ Supabase URL oder Key fehlt!");
    console.error("   URL:", url ? "gesetzt" : "FEHLT");
    console.error("   Key:", key ? "gesetzt" : "FEHLT");
    return null;
  }
  
  // Aggressive Bereinigung des Keys
  const originalLength = key.length;
  key = key.replace(/[^\x20-\x7E]/g, ''); // Nur druckbare ASCII
  key = key.replace(/[\s\n\r\t]+/g, ''); // Whitespace entfernen
  key = key.trim();
  
  if (key.length !== originalLength) {
    console.log(`⚠️ Key bereinigt: ${originalLength} → ${key.length} Zeichen`);
  }
  
  // Validiere JWT-Format
  const parts = key.split('.');
  if (parts.length !== 3) {
    console.error("❌ Key ist kein gültiges JWT (nicht 3 Teile)!");
    return null;
  }
  
  try {
    const payload = JSON.parse(atob(parts[1]));
    if (payload.role !== 'service_role') {
      console.warn("⚠️ Key ist kein service_role Key:", payload.role);
    }
  } catch (e) {
    console.error("❌ Key konnte nicht dekodiert werden:", e.message);
    return null;
  }
  
  // DEBUG: Teste erst mit direktem HTTP-Request
  console.log("🔐 Teste Key mit direktem HTTP-Request...");
  
  // Test: Direkter API-Aufruf ohne supabase-js
  try {
    const testResponse = await fetch(`${url}/rest/v1/businesses?limit=1`, {
      method: 'GET',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (testResponse.ok) {
      console.log("✅ Direkter HTTP-Test ERFOLGREICH! Status:", testResponse.status);
    } else {
      const errorText = await testResponse.text();
      console.error("❌ Direkter HTTP-Test FEHLGESCHLAGEN! Status:", testResponse.status);
      console.error("   Response:", errorText);
      console.error("   Verwendeter Key (erste 50):", key.substring(0, 50));
      console.error("   Verwendete URL:", url);
    }
  } catch (httpErr) {
    console.error("❌ HTTP-Test Exception:", httpErr.message);
  }
  
  // Client erstellen
  const client = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    },
    global: {
      headers: {
        'apikey': key
      }
    }
  });
  
  console.log("✅ Supabase Client erfolgreich erstellt");
  return client;
};

// Mache getSupabaseClient async-kompatibel
const getSupabaseClientSync = () => {
  const url = process.env.SUPABASE_URL;
  let key = process.env.SUPABASE_SERVICE_KEY;
  
  if (!url || !key) return null;
  
  key = key.replace(/[^\x20-\x7E]/g, '').replace(/[\s\n\r\t]+/g, '').trim();
  
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { 'apikey': key } }
  });
};

// Startup-Diagnose (einmalig)
const startupUrl = process.env.SUPABASE_URL;
const startupKey = process.env.SUPABASE_SERVICE_KEY;
console.log("🔧 Supabase URL:", startupUrl ? startupUrl.substring(0, 40) + "..." : "FEHLT!");
console.log("🔧 Supabase Key:", startupKey ? `gesetzt (${startupKey.length} Zeichen)` : "FEHLT!");
if (startupKey) {
  console.log("🔧 Key Anfang:", startupKey.substring(0, 20) + "...");
  console.log("🔧 Key Ende:", "..." + startupKey.slice(-10));
  const parts = startupKey.split('.');
  console.log("🔧 Key Teile:", parts.length);
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1]));
      console.log("🔧 Key Role:", payload.role);
      console.log("🔧 Key Project:", payload.ref);
    } catch (e) {
      console.error("⚠️ Key Dekodierung fehlgeschlagen:", e.message);
    }
  }
}

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
  console.log(`📞 Raw request body:`, JSON.stringify(req.body));

  // Look up business by phone number - try multiple formats
  let businessId = "";
  let businessName = "Kundentakt";

  try {
    // Normalize the phone number - remove all non-digit characters except +
    let normalizedNumber = toNumber.replace(/[\s\-\(\)]/g, '');
    console.log(`🔍 Suche Business für Nummer: ${normalizedNumber}`);
    
    // Build all possible number formats to try
    const numbersToTry = [normalizedNumber];
    
    // Without + prefix
    if (normalizedNumber.startsWith('+')) {
      numbersToTry.push(normalizedNumber.substring(1));
    }
    
    // With + prefix
    if (!normalizedNumber.startsWith('+')) {
      numbersToTry.push('+' + normalizedNumber);
    }
    
    // Handle 0049 format (convert to +49)
    if (normalizedNumber.startsWith('0049')) {
      numbersToTry.push('+49' + normalizedNumber.substring(4));
    }
    
    // Handle 00 prefix format (convert to +)
    if (normalizedNumber.startsWith('00')) {
      numbersToTry.push('+' + normalizedNumber.substring(2));
    }
    
    console.log(`🔍 Versuche Formate:`, numbersToTry);
    
    let business = null;
    
    // Frischen Supabase Client erstellen (Lazy Initialization)
    const supabase = await getSupabaseClient();
    
    if (!supabase) {
      console.error("❌ Supabase Client konnte nicht erstellt werden - überspringe Business-Lookup");
    } else {
      console.log("✅ Supabase Client erfolgreich erstellt");
      
      for (const numFormat of numbersToTry) {
        console.log(`🔍 Prüfe: ${numFormat}`);
        const { data, error } = await supabase
          .from("businesses")
          .select("id, business_name")
          .eq("phone_number_assigned", numFormat)
          .maybeSingle();
        
        if (error) {
          console.error(`❌ Supabase Fehler bei Abfrage:`, error.message, error.code);
          console.error(`❌ Supabase Details:`, JSON.stringify(error));
        }
        
        if (data) {
          business = data;
          console.log(`✅ Match gefunden mit Format: ${numFormat}`);
          break;
        }
      }
      
      // Last resort: LIKE query for partial match
      if (!business) {
        console.log(`🔍 Versuche LIKE-Suche...`);
        const digitsOnly = normalizedNumber.replace(/\D/g, '');
        const lastDigits = digitsOnly.slice(-10);
        console.log(`🔍 Suche nach letzten 10 Ziffern: ${lastDigits}`);
        
        const { data, error: likeError } = await supabase
          .from("businesses")
          .select("id, business_name, phone_number_assigned")
          .like("phone_number_assigned", `%${lastDigits}`);
        
        if (likeError) {
          console.error(`❌ LIKE-Suche Fehler:`, likeError.message);
        }
        
        if (data && data.length === 1) {
          business = data[0];
          console.log(`✅ LIKE-Match gefunden: ${business.phone_number_assigned}`);
        } else if (data && data.length > 1) {
          console.log(`⚠️ Mehrere LIKE-Matches gefunden:`, data.map(b => b.phone_number_assigned));
        }
      }
    }

    if (business) {
      businessId = business.id;
      businessName = business.business_name;
      console.log(`✅ Business gefunden: ${businessName} (${businessId})`);
    } else {
      // Log all businesses for debugging
      if (supabase) {
        const { data: allBiz } = await supabase
          .from("businesses")
          .select("business_name, phone_number_assigned")
          .neq("phone_number_assigned", "pending")
          .limit(10);
        console.log(`⚠️ Kein Business gefunden für: ${normalizedNumber}`);
        console.log(`📋 Vorhandene Nummern:`, allBiz?.map(b => `${b.business_name}: ${b.phone_number_assigned}`));
      } else {
        console.log(`⚠️ Kein Business gefunden für: ${normalizedNumber}`);
        console.log(`📋 Vorhandene Nummern: [Supabase nicht verfügbar]`);
      }
    }
  } catch (err) {
    console.error("❌ Fehler beim Business-Lookup:", err.message);
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
    // WICHTIG: Business-Name immer in der Basis-Identität verwenden
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
      // Frischen Supabase Client erstellen
      const supabase = await getSupabaseClient();
      if (!supabase) {
        console.error("❌ Supabase Client nicht verfügbar für Business-Daten");
        businessInfoSection = `\n\nBegrüße den Anrufer mit "Guten Tag, Sie sprechen mit dem Telefonassistenten von ${bizName}. Wie kann ich Ihnen helfen?"`;
      } else {
        try {
          // Lade ALLE Business-Daten
          const { data: business } = await supabase
            .from("businesses")
            .select("custom_greeting, category, opening_hours, availability_mode, availability_hours, voice_preference, address, forwarding_number")
            .eq("id", bizId)
            .single();

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

          // Weiterleitungsnummer (für Infos an Anrufer)
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
            for (const [day, data] of Object.entries(hours)) {
              if (dayLabels[day] && data && typeof data === 'object') {
                if (data.active && data.from && data.to) {
                  openingHoursSection += `\n- ${dayLabels[day]}: ${data.from} - ${data.to} Uhr`;
                } else if (data.active === false) {
                  openingHoursSection += `\n- ${dayLabels[day]}: Geschlossen`;
                }
              }
            }
          }

          // Erreichbarkeitszeiten (wann der Agent aktiv sein soll)
          if (business.availability_mode) {
            const modeLabels = {
              'always': 'Der Telefonassistent ist rund um die Uhr erreichbar.',
              'scheduled': 'Der Telefonassistent ist nur zu bestimmten Zeiten aktiv.',
              'fallback': 'Der Telefonassistent springt ein, wenn der Betrieb nicht selbst abheben kann.'
            };
            availabilitySection = `\n\nErreichbarkeit: ${modeLabels[business.availability_mode] || business.availability_mode}`;
            
            // Bei geplanten Zeiten auch den Wochenplan zeigen
            if (business.availability_mode === 'scheduled' && business.availability_hours) {
              const schedule = business.availability_hours;
              const dayLabels = {
                monday: 'Mo', tuesday: 'Di', wednesday: 'Mi',
                thursday: 'Do', friday: 'Fr', saturday: 'Sa', sunday: 'So'
              };
              
              let activedays = [];
              for (const [day, data] of Object.entries(schedule)) {
                if (dayLabels[day] && data && data.active) {
                  activedays.push(`${dayLabels[day]} ${data.from}-${data.to}`);
                }
              }
              if (activedays.length > 0) {
                availabilitySection += ` Aktiv: ${activedays.join(', ')}`;
              }
            }
          }
        }

        // FAQs laden
        const { data: faqs } = await supabase
          .from("faqs")
          .select("question, answer")
          .eq("business_id", bizId)
          .limit(15);

        if (faqs?.length > 0) {
          faqSection = "\n\nHäufig gestellte Fragen und Antworten (nutze diese bei passenden Fragen):";
          faqs.forEach((faq) => {
            faqSection += `\n- Frage: ${faq.question}\n  Antwort: ${faq.answer}`;
          });
        }

        // Services laden
        const { data: services } = await supabase
          .from("service_catalog")
          .select("service_name, description, price_range, typical_duration, is_emergency_service")
          .eq("business_id", bizId)
          .limit(15);

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

        // Call Script laden
        const { data: script } = await supabase
          .from("call_scripts")
          .select("greeting_text, fallback_message, tone, booking_link")
          .eq("business_id", bizId)
          .maybeSingle();

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
        } catch (err) {
          console.error("Fehler beim Laden der Business-Daten:", err.message);
        }
      }
    }

    // Zusammengebautes Prompt - alle Daten kombinieren
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

    console.log(`📝 System-Prompt für ${bizName} (${bizId?.substring(0, 8) || 'N/A'}) erstellt - ${prompt.length} Zeichen`);
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

    // Frischen Supabase Client erstellen für das Speichern
    const supabase = await getSupabaseClient();
    if (!supabase) {
      console.error("❌ Supabase Client nicht verfügbar - Call-Log konnte nicht gespeichert werden");
      return;
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
