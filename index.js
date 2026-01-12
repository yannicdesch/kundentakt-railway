import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-railway-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Secret for Railway authentication
const RAILWAY_SECRET = Deno.env.get('RAILWAY_API_SECRET') || 'kundentakt-railway-2024';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Validate Railway secret
  const railwaySecret = req.headers.get('x-railway-secret');
  if (railwaySecret !== RAILWAY_SECRET) {
    console.error('Invalid Railway secret');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { action, data } = await req.json();
    console.log(`[Railway API] Action: ${action}`);

    switch (action) {
      case 'lookup-business': {
        // Look up business by phone number
        const { phoneNumber } = data;
        console.log(`[Railway API] Looking up business for: ${phoneNumber}`);
        
        // Normalize phone number
        const normalizedNumber = phoneNumber.replace(/[\s\-\(\)]/g, '');
        const numbersToTry = [normalizedNumber];
        
        if (normalizedNumber.startsWith('+')) {
          numbersToTry.push(normalizedNumber.substring(1));
        }
        if (!normalizedNumber.startsWith('+')) {
          numbersToTry.push('+' + normalizedNumber);
        }
        if (normalizedNumber.startsWith('0049')) {
          numbersToTry.push('+49' + normalizedNumber.substring(4));
        }
        if (normalizedNumber.startsWith('00')) {
          numbersToTry.push('+' + normalizedNumber.substring(2));
        }

        let business = null;
        for (const numFormat of numbersToTry) {
          const { data: biz, error } = await supabase
            .from('businesses')
            .select('id, business_name')
            .eq('phone_number_assigned', numFormat)
            .maybeSingle();
          
          if (biz) {
            business = biz;
            console.log(`[Railway API] Found business: ${biz.business_name}`);
            break;
          }
        }

        // Last resort: LIKE query
        if (!business) {
          const digitsOnly = normalizedNumber.replace(/\D/g, '');
          const lastDigits = digitsOnly.slice(-10);
          
          const { data: likeResults } = await supabase
            .from('businesses')
            .select('id, business_name, phone_number_assigned')
            .like('phone_number_assigned', `%${lastDigits}`);
          
          if (likeResults?.length === 1) {
            business = likeResults[0];
          }
        }

        return new Response(JSON.stringify({ business }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'get-business-data': {
        // Get full business data for prompt building
        const { businessId } = data;
        console.log(`[Railway API] Getting data for business: ${businessId}`);

        const [businessResult, faqsResult, servicesResult, scriptResult] = await Promise.all([
          supabase
            .from('businesses')
            .select('*')
            .eq('id', businessId)
            .single(),
          supabase
            .from('faqs')
            .select('question, answer')
            .eq('business_id', businessId)
            .limit(15),
          supabase
            .from('service_catalog')
            .select('service_name, description, price_range, typical_duration, is_emergency_service')
            .eq('business_id', businessId)
            .limit(15),
          supabase
            .from('call_scripts')
            .select('greeting_text, fallback_message, tone, booking_link')
            .eq('business_id', businessId)
            .maybeSingle()
        ]);

        return new Response(JSON.stringify({
          business: businessResult.data,
          faqs: faqsResult.data || [],
          services: servicesResult.data || [],
          script: scriptResult.data
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'save-call-log': {
        // Save call log after call ends
        const { callLog } = data;
        console.log(`[Railway API] Saving call log for business: ${callLog.business_id}`);

        const { data: result, error } = await supabase
          .from('call_logs')
          .insert(callLog)
          .select()
          .single();

        if (error) {
          console.error('[Railway API] Error saving call log:', error);
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        return new Response(JSON.stringify({ success: true, id: result.id }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      default:
        return new Response(JSON.stringify({ error: 'Unknown action' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Railway API] Error:', errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
