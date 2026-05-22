# iClosed → Google Calendar "Free" Webhook

When a call is booked in iClosed, this server receives a Zapier webhook and automatically marks the matching Google Calendar event as **Free** (transparent) so it doesn't block your availability.

---

## How it works

1. iClosed fires a **New Call Scheduled** trigger in Zapier
2. Zapier sends a POST to this server's `/webhook/iclosed` endpoint
3. The server finds the Google Calendar event (by ID or by start time)
4. It patches the event's `transparency` field to `transparent` ("Free")

---

## Step 1 — Create a Google Service Account

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. Enable the **Google Calendar API**:
   - APIs & Services → Enable APIs → search "Google Calendar API" → Enable
4. Create a service account:
   - APIs & Services → Credentials → Create Credentials → Service Account
   - Give it any name (e.g. `iclosed-calendar-bot`)
   - Skip optional steps, click Done
5. Open the service account → Keys tab → Add Key → JSON
6. Download the JSON file — this is your `service-account.json`
7. Note the service account's email address (looks like `name@project-id.iam.gserviceaccount.com`)

---

## Step 2 — Share your calendar with the service account

1. Open [Google Calendar](https://calendar.google.com)
2. Find the calendar you want to update → Settings (gear icon next to it)
3. Scroll to **Share with specific people** → Add people
4. Enter the service account email from Step 1
5. Set permission to **Make changes to events**
6. Save
7. On the same settings page, scroll to **Integrate calendar** and copy the **Calendar ID**

---

## Step 3 — Local setup

```bash
# Clone / download the project
cd iclosed-calendar-free

# Install dependencies
npm install

# Copy the env template
cp .env.example .env
```

Edit `.env`:

```
PORT=3000
GOOGLE_SERVICE_ACCOUNT_PATH=/absolute/path/to/service-account.json
GOOGLE_CALENDAR_ID=your-calendar-id@group.calendar.google.com
WEBHOOK_SECRET=pick-any-random-string
```

Run it:

```bash
npm start
```

Test it:

```bash
curl -X POST http://localhost:3000/webhook/iclosed \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pick-any-random-string" \
  -d '{"event_id": "YOUR_GOOGLE_CALENDAR_EVENT_ID"}'
```

---

## Step 4 — Deploy (Render — recommended free tier)

1. Push this project to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service → connect your repo
3. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Add environment variables under Settings → Environment:
   - `GOOGLE_CALENDAR_ID` — your calendar ID
   - `WEBHOOK_SECRET` — your chosen secret
   - `GOOGLE_SERVICE_ACCOUNT_PATH` — see note below
5. For the service account JSON on Render:
   - Go to Settings → Secret Files → Add Secret File
   - Filename: `/etc/secrets/service-account.json`
   - Paste the full contents of your service account JSON
   - Set `GOOGLE_SERVICE_ACCOUNT_PATH=/etc/secrets/service-account.json`
6. Deploy — note your public URL (e.g. `https://iclosed-calendar-free.onrender.com`)

### Deploy on Railway (alternative)

1. `railway init` in the project folder
2. `railway up`
3. Set env vars: `railway variables set KEY=value`
4. Upload the service account JSON as a file and set `GOOGLE_SERVICE_ACCOUNT_PATH` accordingly

---

## Step 5 — Wire up Zapier

1. Create a new Zap
2. **Trigger**: iClosed → New Call Scheduled
3. **Action**: Webhooks by Zapier → POST
   - URL: `https://your-deployment-url.onrender.com/webhook/iclosed`
   - Payload type: `json`
   - Data: map iClosed fields — include as many as possible:

     | Key | iClosed field |
     |-----|--------------|
     | `event_id` | Google Calendar Event ID (if iClosed provides it) |
     | `start_time` | Call start datetime (ISO or combined with `date`) |
     | `date` | Call date |
     | `time` | Call time |

   - Headers:
     - `Authorization`: `Bearer your-webhook-secret`
4. Test the Zap — check the server logs for confirmation

---

## Payload field reference

The server accepts any of these field names from iClosed (first match wins):

**Event ID fields** (checked first — most reliable):
- `event_id`, `eventId`, `google_event_id`, `calendar_event_id`, `calendarEventId`

**Start time fields** (fallback — searches calendar by time):
- Full ISO: `start_time`, `startTime`, `datetime`, `scheduled_at`
- Split date + time: `date`+`time`, `call_date`+`call_time`, `start_date`+`start_time`

If multiple events exist at the same time, **all of them** are marked Free.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/webhook/iclosed` | Main webhook — call from Zapier |

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `FATAL: file not found` | Wrong service account path | Check `GOOGLE_SERVICE_ACCOUNT_PATH` in `.env` |
| `401 Unauthorized` | Wrong or missing `WEBHOOK_SECRET` | Match the token in Zapier headers |
| `404 No events found` | Event not in calendar at that time | Check timezone — try sending an ISO datetime |
| `403 forbidden` from Google | Calendar not shared with service account | Re-do Step 2 |
| `422 no event ID or start time` | Zapier payload missing expected fields | Map more iClosed fields in the Zapier action |
