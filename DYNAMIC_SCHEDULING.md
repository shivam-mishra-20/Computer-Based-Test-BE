# Dynamic Scheduling System - Complete Setup

## What Changed?

### ❌ OLD: Fixed 2 PM Schedule
- Hardcoded time in Windows Task Scheduler
- Needed code changes or manual reconfiguration

### ✅ NEW: Admin-Controlled Dynamic Schedule
- Configure time and days from admin dashboard
- No code changes or server restarts needed
- Schedule persists in MongoDB

---

## How It Works

### Backend Components

1. **AutomationScheduler Service** (`src/services/automationScheduler.ts`)
   - Uses `node-cron` for flexible scheduling
   - Loads schedule from MongoDB on server startup
   - Can be updated anytime via API

2. **API Endpoints** (`src/routes/api/automation.ts`)
   - `GET /api/automation/schedule` - Get current schedule
   - `PUT /api/automation/schedule` - Update schedule
   - Protected with admin authentication

3. **MongoDB Model** (`src/models/AutomationStatus.ts`)
   - Added `schedule` field with:
     - `cronExpression`: Generated from time/days
     - `enabled`: Schedule on/off toggle
     - `lastModified`: Track changes

4. **Server Integration** (`src/server.ts`)
   - Scheduler auto-initializes after database connection
   - Loads saved schedule on startup

### Frontend Components

5. **Admin Dashboard** (`cbt-exam/src/components/admin/AutomationDashboard.tsx`)
   - Added "⚙️ Schedule" button
   - Modal with time picker and day checkboxes
   - Displays current schedule status

---

## Usage Guide

### Step 1: Start All Services

**Open 3 terminals:**

```bash
# Terminal 1 - Backend
cd C:\Users\Shivam\cbt-exam-be
npm start

# Terminal 2 - Frontend
cd C:\Users\Shivam\cbt-exam
npm run dev

# Terminal 3 - n8n (Optional, if using workflows)
cd C:\n8n
n8n start
```

### Step 2: Configure Schedule via Dashboard

1. Login as admin at `http://localhost:3000`
2. Navigate to Automation Dashboard
3. Click "⚙️ Schedule" button
4. Select:
   - **Time**: Any time in 24-hour format (e.g., `14:00` for 2 PM)
   - **Days**: Check desired days (Sun-Sat)
5. Click "Save Schedule"

### Step 3: Verify Schedule

Check the dashboard - it will show:
- Current schedule (e.g., "Mon, Tue, Wed at 14:00")
- Schedule persists across server restarts

---

## API Examples

### Get Current Schedule
```bash
curl http://localhost:5000/api/automation/schedule \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "schedule": {
    "cronExpression": "0 14 * * 1,2,3,4,5",
    "enabled": true,
    "description": "Mon, Tue, Wed, Thu, Fri at 14:00",
    "lastModified": "2024-01-15T10:30:00Z"
  },
  "time": "14:00",
  "days": [1, 2, 3, 4, 5]
}
```

### Update Schedule
```bash
curl -X PUT http://localhost:5000/api/automation/schedule \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "time": "09:00",
    "days": [1, 3, 5],
    "enabled": true
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "Schedule updated successfully",
  "schedule": {
    "cronExpression": "0 9 * * 1,3,5",
    "enabled": true,
    "description": "Mon, Wed, Fri at 09:00"
  }
}
```

---

## Schedule Examples

| Schedule | Time | Days | Cron Expression |
|----------|------|------|----------------|
| Daily at 2 PM | `14:00` | `[0,1,2,3,4,5,6]` | `0 14 * * 0,1,2,3,4,5,6` |
| Weekdays at 9 AM | `09:00` | `[1,2,3,4,5]` | `0 9 * * 1,2,3,4,5` |
| Mon/Wed/Fri at 6 PM | `18:00` | `[1,3,5]` | `0 18 * * 1,3,5` |
| Weekend at 10 AM | `10:00` | `[0,6]` | `0 10 * * 0,6` |

**Day Numbers:**
- 0 = Sunday
- 1 = Monday
- 2 = Tuesday
- 3 = Wednesday
- 4 = Thursday
- 5 = Friday
- 6 = Saturday

---

## Benefits

✅ **No Code Changes**: Admin controls everything via dashboard  
✅ **Persistent**: Schedule survives server restarts  
✅ **Flexible**: Any time, any day combination  
✅ **Toggle**: Enable/disable without losing configuration  
✅ **Audit Trail**: lastModified timestamp tracks changes  
✅ **Visual Feedback**: Dashboard shows current schedule  

---

## Troubleshooting

### Schedule Not Running?

1. **Check Server Logs**:
   ```bash
   npm start
   # Look for: "✓ Automation scheduler initialized"
   # And: "Scheduled automation for: Mon, Tue, Wed at 14:00"
   ```

2. **Verify Schedule is Enabled**:
   ```bash
   curl http://localhost:5000/api/automation/schedule \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```
   - Check `enabled: true`

3. **Test Manual Trigger**:
   - Click "▶️ Run Now" in dashboard
   - Verifies automation script works independently

### Schedule Disappeared After Restart?

- MongoDB must be running
- Check database connection in server logs
- Verify AutomationStatus collection exists

### Can't Update Schedule?

- Ensure logged in as admin (not teacher)
- Check browser console for API errors
- Verify token is valid

---

## Advanced: Direct MongoDB Updates

If needed, update schedule directly in MongoDB:

```javascript
db.automationstatus.updateOne(
  {},
  {
    $set: {
      "schedule.cronExpression": "0 14 * * 1,2,3,4,5",
      "schedule.enabled": true,
      "schedule.lastModified": new Date()
    }
  }
)
```

Then restart server to load new schedule.

---

## Files Modified

### Backend
- ✅ `src/services/automationScheduler.ts` (NEW) - Scheduling engine
- ✅ `src/controllers/automationController.ts` - Added schedule endpoints
- ✅ `src/routes/api/automation.ts` - Added schedule routes
- ✅ `src/models/AutomationStatus.ts` - Added schedule field
- ✅ `src/server.ts` - Initialize scheduler on startup
- ✅ `package.json` - Added node-cron dependency

### Frontend
- ✅ `src/components/admin/AutomationDashboard.tsx` - Added schedule UI

### Documentation
- ✅ `START_SERVICES.md` - Complete startup guide
- ✅ `QUICKSTART.md` - Quick reference
- ✅ `DYNAMIC_SCHEDULING.md` - This file

---

## Migration from Old System

If you had Windows Task Scheduler setup:

1. **Disable old task**:
   - Open Task Scheduler
   - Find "EPUB Automation" task
   - Right-click → Disable

2. **Start using new system**:
   - Start backend: `npm start`
   - Configure schedule in admin dashboard
   - Schedule now runs via node-cron

---

## Next Steps

1. ✅ Start backend and verify scheduler initializes
2. ✅ Configure your desired schedule via dashboard
3. ✅ Monitor first automated run
4. ✅ Adjust schedule as needed (no restart required)

**That's it! Your automation is now fully dynamic and admin-controlled.**
