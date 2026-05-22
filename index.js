require('dotenv').config();

const express    = require('express');
const { google } = require('googleapis');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT           = process.env.PORT || 8080;
const CALENDAR_ID    = process.env.GOOGLE_CALENDAR_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

let serviceAccountKey = null;
let configError = null;

if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  configError = 'GOOGLE_SERVICE_ACCOUNT_JSON is not set';
  console.error('[CONFIG ERROR]', configError);
} else if (!CALENDAR_ID) {
  configError = 'GOOGLE_CALENDAR_ID is not set';
  console.error('[CONFIG ERROR]', configError);
} else {
  try {
    serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    configError = 'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message;
    console.error('[CONFIG ERROR]', configError);
  }
}

// ─── Google Auth ──────────────────────────────────────────────────────────────

const auth = serviceAccountKey ? new google.auth.GoogleAuth({
  credentials: serviceAccountKey,
  scopes: ['https://www.googleapis.com/auth/calendar'],
}) : null;

const calendar = auth ? google.calendar({ version: 'v3', auth }) : null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Mark a single event as Free (transparency: transparent)
async function markEventFree(eventId) {
  const res = await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId:    eventId,
    requestBody: {
      transparency: 'transparent', // "Free" in the UI
    },
  });
  return res.data;
}

// Find events that overlap a given ISO datetime (±1 minute window to be safe)
async function findEventsByTime(isoDateTime) {
  const center  = new Date(isoDateTime);
  const timeMin = new Date(center.getTime() - 60 * 1000).toISOString();
  const timeMax = new Date(center.getTime() + 60 * 1000).toISOString();

  const res = await calendar.events.list({
    calendarId:   CALENDAR_ID,
    timeMin:      timeMin,
    timeMax:      timeMax,
    singleEvents: true,
    orderBy:      'startTime',
  });

  return res.data.items || [];
}

// Pull every recognisable field out of the iClosed Zapier payload.
// iClosed doesn't publish a fixed schema, so we cast a wide net.
function parsePayload(body) {
  // ── Event ID (direct) ────────────────────────────────────────────────────
  // iClosed sometimes passes the Google Calendar event ID through Zapier.
  // Common field names observed in the wild:
  const eventId =
    body.event_id          ||
    body.eventId           ||
    body.google_event_id   ||
    body.calendar_event_id ||
    body.calendarEventId   ||
    null;

  // ── Start date/time (fallback) ───────────────────────────────────────────
  // iClosed typically sends separate date + time fields. Combine them into
  // a single ISO string. Accept whichever combination is present.
  let startIso = null;

  // Option 1: already a full ISO / datetime string
  if (body.start_time && body.start_time.includes('T')) {
    startIso = body.start_time;
  } else if (body.startTime && String(body.startTime).includes('T')) {
    startIso = body.startTime;
  } else if (body.datetime) {
    startIso = body.datetime;
  } else if (body.scheduled_at) {
    startIso = body.scheduled_at;
  }
  // Option 2: separate date + time fields
  else if (body.date && body.time) {
    startIso = new Date(body.date + ' ' + body.time).toISOString();
  } else if (body.call_date && body.call_time) {
    startIso = new Date(body.call_date + ' ' + body.call_time).toISOString();
  } else if (body.start_date && body.start_time) {
    startIso = new Date(body.start_date + ' ' + body.start_time).toISOString();
  }

  return { eventId, startIso };
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: configError ? 'misconfigured' : 'ok', service: 'iclosed-calendar-free', error: configError || undefined });
});

// Main webhook
app.post('/webhook/iclosed', async (req, res) => {
  const requestId = Date.now(); // simple correlation ID for log tracing
  console.log(`[${requestId}] Incoming webhook`);

  if (configError) {
    console.error(`[${requestId}] Rejecting request — server misconfigured: ${configError}`);
    return res.status(503).json({ ok: false, error: 'Server misconfigured: ' + configError });
  }

  // ── Optional auth check ──────────────────────────────────────────────────
  if (WEBHOOK_SECRET) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token !== WEBHOOK_SECRET) {
      console.warn(`[${requestId}] Unauthorized — bad or missing secret`);
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  // ── Validate body ────────────────────────────────────────────────────────
  if (!req.body || typeof req.body !== 'object') {
    console.error(`[${requestId}] Empty or non-JSON body`);
    return res.status(400).json({ ok: false, error: 'Expected a JSON body' });
  }

  console.log(`[${requestId}] Payload:`, JSON.stringify(req.body, null, 2));

  const { eventId, startIso } = parsePayload(req.body);

  if (!eventId && !startIso) {
    console.error(`[${requestId}] Cannot identify event — no event ID or start time found in payload`);
    return res.status(422).json({
      ok:    false,
      error: 'Payload contained no recognisable event ID or start date/time',
      hint:  'Add the Google Calendar event ID or start datetime to your Zapier step',
    });
  }

  const updated = [];
  const errors  = [];

  try {
    // ── Path 1: direct event ID ──────────────────────────────────────────
    if (eventId) {
      console.log(`[${requestId}] Updating event by ID: ${eventId}`);
      try {
        const event = await markEventFree(eventId);
        console.log(`[${requestId}] ✓ Marked free: "${event.summary}" (${eventId})`);
        updated.push({ eventId, summary: event.summary });
      } catch (err) {
        const msg = err.message || String(err);
        console.error(`[${requestId}] ✗ Failed to update ${eventId}: ${msg}`);
        errors.push({ eventId, error: msg });
      }
    }

    // ── Path 2: fallback — find by start time ────────────────────────────
    if (!eventId && startIso) {
      console.log(`[${requestId}] No event ID — searching by start time: ${startIso}`);
      let matches;
      try {
        matches = await findEventsByTime(startIso);
      } catch (err) {
        const msg = err.message || String(err);
        console.error(`[${requestId}] ✗ Calendar search failed: ${msg}`);
        return res.status(500).json({ ok: false, error: 'Calendar search failed: ' + msg });
      }

      if (matches.length === 0) {
        console.warn(`[${requestId}] No events found at ${startIso}`);
        return res.status(404).json({
          ok:    false,
          error: 'No calendar events found at the specified time',
          time:  startIso,
        });
      }

      console.log(`[${requestId}] Found ${matches.length} event(s) at ${startIso}`);

      for (const match of matches) {
        console.log(`[${requestId}] Updating event: "${match.summary}" (${match.id})`);
        try {
          const event = await markEventFree(match.id);
          console.log(`[${requestId}] ✓ Marked free: "${event.summary}" (${match.id})`);
          updated.push({ eventId: match.id, summary: event.summary });
        } catch (err) {
          const msg = err.message || String(err);
          console.error(`[${requestId}] ✗ Failed to update ${match.id}: ${msg}`);
          errors.push({ eventId: match.id, error: msg });
        }
      }
    }
  } catch (err) {
    const msg = err.message || String(err);
    console.error(`[${requestId}] Unexpected error: ${msg}`);
    return res.status(500).json({ ok: false, error: msg });
  }

  // ── Response ─────────────────────────────────────────────────────────────
  const allFailed = updated.length === 0 && errors.length > 0;
  const status    = allFailed ? 500 : 200;

  console.log(`[${requestId}] Done — ${updated.length} updated, ${errors.length} failed`);

  return res.status(status).json({
    ok:      !allFailed,
    updated: updated,
    errors:  errors.length > 0 ? errors : undefined,
  });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[START] iclosed-calendar-free running on port ${PORT}`);
  console.log(`[START] Calendar ID: ${CALENDAR_ID || '(not set)'}`);
  console.log(`[START] Service account: ${serviceAccountKey ? serviceAccountKey.client_email : '(not configured)'}`);
  console.log(`[START] Auth: ${WEBHOOK_SECRET ? 'Bearer token enabled' : 'No auth (set WEBHOOK_SECRET to enable)'}`);
});
