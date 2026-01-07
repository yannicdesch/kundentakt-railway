import express from 'express';
import bodyParser from 'body-parser';
import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Environment
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${PORT}`;

// Supabase Client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Health Check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'kundentakt-voice-agent' });
});

// Agent Status (für Dashboard)
app.post('/agent-status', async (req, res) => {
  const { agent_id } = req.body;
  
  if (!agent_id) {
    return res.json({ status: 'unknown', message: 'No agent_id provided' });
  }

  try {
    const { data: business } = await supabase
      .from('businesses')
      .select('id, status, phone_number_assigned')
      .eq('elevenlabs_agent_id', agent_id)
      .single();

    if (business?.phone_number_assigned) {
      res.json({
        status: 'active',
        message: 'Agent ist aktiv',
        is_active: true,
        phone_number: business.phone_number_assigned
      });
    } else {
      res.json({ status: 'configuring', is_active: false });
    }
  } catch {
    res.json({ status: 'unknown', is_active: false });
  }
});

// Create Agent (für Onboarding)
app.post('/create-agent', async (req, res) => {
  const { firma, branche, email } = req.body;
  console.log('[Create Agent]', { firma, branche, email });

  const agent_id = `agent_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const twilio_number = process.env.TWILIO_PHONE_NUMBER || '+4962217393499';

  res.json({ success: true, agent_id, twilio_number });
});

// Twilio Incoming Call Webhook
app.post('/twilio/incoming', async (req, res) => {
  const { To, From, CallSid } = req.body;
  console.log(`📞 Eingehender Anruf von ${From} an ${To}`);

  // Business-Daten laden
  const { data: business } = await supabase
    .from('businesses')
    .select('id, business_name')
    .eq('phone_number_assigned', To)
    .single();

  if (!business) {
    console.log('⚠️ Kein Business gefunden für:', To);
    res.type('text/xml').send(`
      <Response>
        <Say language="de-DE" voice="Polly.Vicki">Diese Nummer ist nicht konfiguriert.</Say>
        <Hangup/>
      </Response>
    `);
    return;
  }

  // TwiML mit WebSocket Stream
  const response = `
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host || RAILWAY_URL}/media">
          <Parameter name="businessId" value="${business.id}" />
          <Parameter name="callerNumber" value="${From}" />
          <Parameter name="callSid" value="${CallSid}" />
          <Parameter name="businessName" value="${business.business_name}" />
        </Stream>
      </Connect>
    </Response>
  `;

  res.type('text/xml').send(response);
});

// HTTP Server
const server = createServer(app);

// WebSocket Server (noServer für manuelle Upgrade-Kontrolle)
const wsServer = new WebSocketServer({ noServer: true });

wsServer.on('connection', async (twilioWs, req) => {
  console.log('📞 Neue Twilio WebSocket-Verbindung');

  let openAIWs: WebSocket | null = null;
  let streamSid: string | null = null;
  let businessId: string | null = null;
  let callerNumber: string | null = null;
  let businessName = 'Kundentakt';
  let callStartTime = Date.now();
  const transcript: { role: string; content: string }[] = [];

  // OpenAI Realtime verbinden
  const connectToOpenAI = async (systemPrompt: string) => {
    console.log('🧠 Verbinde mit OpenAI Realtime API...');

    openAIWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      }
    );

    openAIWs.on('open', () => {
      console.log('🧠 OpenAI Realtime verbunden');
    });

    openAIWs.on('message', (msg) => {
      try {
        const event = JSON.parse(msg.toString());

        switch (event.type) {
          case 'session.created':
            console.log('🎯 OpenAI Session erstellt, konfiguriere...');
            openAIWs?.send(JSON.stringify({
              type: 'session.update',
              session: {
                modalities: ['text', 'audio'],
                instructions: systemPrompt,
                voice: 'alloy',
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                input_audio_transcription: { model: 'whisper-1' },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                },
              },
            }));
            break;

          case 'session.updated':
            console.log('✅ OpenAI Session konfiguriert');
            break;

          case 'response.audio.delta':
            // Audio an Twilio senden
            if (event.delta && twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: event.delta },
              }));
            }
            break;

          case 'conversation.item.input_audio_transcription.completed':
            console.log('👤 Anrufer:', event.transcript);
            transcript.push({ role: 'user', content: event.transcript || '' });
            break;

          case 'response.audio_transcript.done':
            console.log('🤖 Assistent:', event.transcript);
            transcript.push({ role: 'assistant', content: event.transcript || '' });
            break;

          case 'error':
            console.error('❌ OpenAI Fehler:', event.error);
            break;
        }
      } catch (err) {
        console.error('Fehler beim Parsen der OpenAI-Nachricht:', err);
      }
    });

    openAIWs.on('error', (err) => console.error('OpenAI WS Fehler:', err));
    openAIWs.on('close', () => console.log('OpenAI WS geschlossen'));
  };

  // System-Prompt aus Supabase-Daten erstellen
  const buildSystemPrompt = async (bizId: string, bizName: string) => {
    let prompt = `Du bist der freundliche Telefonassistent für "${bizName}".

WICHTIGE REGELN:
- Sprich natürlich und freundlich auf Deutsch
- Halte Antworten kurz (max. 2-3 Sätze)
- Erfasse bei Bedarf: Name, Telefonnummer, Anliegen
- Bei Notfällen (Rohrbruch, Gasgeruch): Als DRINGEND markieren
- Gib KEINE verbindlichen Preise oder Termine`;

    try {
      // FAQs laden
      const { data: faqs } = await supabase
        .from('faqs')
        .select('question, answer')
        .eq('business_id', bizId)
        .limit(10);

      if (faqs?.length) {
        prompt += '\n\nHÄUFIGE FRAGEN:\n';
        faqs.forEach((f) => (prompt += `F: ${f.question}\nA: ${f.answer}\n\n`));
      }

      // Services laden
      const { data: services } = await supabase
        .from('service_catalog')
        .select('service_name, is_emergency_service')
        .eq('business_id', bizId)
        .limit(10);

      if (services?.length) {
        prompt += '\nDIENSTLEISTUNGEN:\n';
        services.forEach((s) => (prompt += `- ${s.service_name}${s.is_emergency_service ? ' (Notdienst)' : ''}\n`));
      }

      // Call Script
      const { data: script } = await supabase
        .from('call_scripts')
        .select('greeting_text, fallback_message')
        .eq('business_id', bizId)
        .single();

      if (script?.greeting_text) {
        prompt += `\nBEGRÜSSUNG: "${script.greeting_text}"`;
      }
      if (script?.fallback_message) {
        prompt += `\nFALLBACK: "${script.fallback_message}"`;
      }
    } catch (err) {
      console.error('Fehler beim Laden der Business-Daten:', err);
    }

    return prompt;
  };

  // Twilio-Nachrichten verarbeiten
  twilioWs.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      switch (data.event) {
        case 'start':
          streamSid = data.start?.streamSid;
          businessId = data.start?.customParameters?.businessId;
          callerNumber = data.start?.customParameters?.callerNumber;
          businessName = data.start?.customParameters?.businessName || 'Kundentakt';
          callStartTime = Date.now();

          console.log(`🎯 Stream gestartet: ${businessName}, Anrufer: ${callerNumber}`);

          if (businessId) {
            const systemPrompt = await buildSystemPrompt(businessId, businessName);
            await connectToOpenAI(systemPrompt);
          }
          break;

        case 'media':
          // Audio an OpenAI weiterleiten
          if (data.media?.payload && openAIWs?.readyState === WebSocket.OPEN) {
            openAIWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: data.media.payload,
            }));
          }
          break;

        case 'stop':
          console.log('📴 Stream beendet');

          // Call-Log speichern
          if (businessId) {
            const callDuration = Math.round((Date.now() - callStartTime) / 1000);
            const fullTranscript = transcript
              .map((t) => `${t.role === 'user' ? 'Anrufer' : 'Assistent'}: ${t.content}`)
              .join('\n');

            // KI-Zusammenfassung erstellen
            let aiSummary = 'Keine Zusammenfassung';
            if (transcript.length > 0) {
              try {
                const resp = await fetch('https://api.openai.com/v1/chat/completions', {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [
                      { role: 'system', content: 'Erstelle eine kurze Zusammenfassung (max. 2 Sätze) des Telefongesprächs auf Deutsch.' },
                      { role: 'user', content: fullTranscript },
                    ],
                  }),
                });
                const result = await resp.json();
                aiSummary = result.choices?.[0]?.message?.content || aiSummary;
              } catch (err) {
                console.error('Fehler bei Zusammenfassung:', err);
              }
            }

            // Flags analysieren
            const isEmergency = /notfall|dringend|rohrbruch|gas/i.test(fullTranscript);
            const needsCallback = /rückruf|zurückrufen/i.test(fullTranscript);
            const isQuoteRequest = /angebot|kosten|preis/i.test(fullTranscript);

            await supabase.from('call_logs').insert({
              business_id: businessId,
              caller_number: callerNumber,
              call_duration: callDuration,
              full_transcript: fullTranscript || 'Kein Transkript',
              ai_summary: aiSummary,
              is_emergency: isEmergency,
              needs_callback: needsCallback,
              is_quote_request: isQuoteRequest,
            });

            console.log('✅ Call-Log gespeichert');
          }

          openAIWs?.close();
          break;
      }
    } catch (err: any) {
      console.error('Fehler in Twilio-Stream:', err.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('📴 Twilio WS geschlossen');
    openAIWs?.close();
  });

  twilioWs.on('error', (err) => console.error('Twilio WS Fehler:', err));
});

// WebSocket Upgrade Handler - unterstützt /media UND /twilio/stream
server.on('upgrade', (request, socket, head) => {
  const pathname = request.url?.split('?')[0];
  
  if (pathname === '/media' || pathname === '/twilio/stream') {
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Server starten
server.listen(PORT, () => {
  console.log(`🚀 Voice Agent läuft auf Port ${PORT}`);
  console.log(`📞 Twilio Webhook: POST /twilio/incoming`);
  console.log(`🔌 WebSocket: wss://${RAILWAY_URL}/media`);
});
