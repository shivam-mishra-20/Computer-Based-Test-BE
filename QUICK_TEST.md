# 🎯 Quick Testing Guide - Dynamic Scheduling

## ⚡ Quick Start Test (5 minutes)

### Step 1: Start Backend
```bash
cd C:\Users\Shivam\cbt-exam-be
npm start
```

✅ Look for: `✓ Automation scheduler initialized`

### Step 2: Test Schedule API

Get token first (login as admin), then:

```bash
# View current schedule
curl http://localhost:5000/api/automation/schedule -H "Authorization: Bearer YOUR_TOKEN"

# Update to run daily at 3 PM
curl -X PUT http://localhost:5000/api/automation/schedule ^
  -H "Authorization: Bearer YOUR_TOKEN" ^
  -H "Content-Type: application/json" ^
  -d "{\"time\":\"15:00\",\"days\":[0,1,2,3,4,5,6],\"enabled\":true}"
```

### Step 3: Test Frontend UI

1. Start frontend: `cd C:\Users\Shivam\cbt-exam && npm run dev`
2. Login as admin at `http://localhost:3000`
3. Go to Automation Dashboard
4. Click "⚙️ Schedule" button
5. Change time to `16:00` and select Mon/Wed/Fri
6. Click "Save Schedule"
7. Verify dashboard shows: "Mon, Wed, Fri at 16:00"

---

## ✅ Verification Points

- [ ] Backend starts without errors
- [ ] GET /api/automation/schedule returns schedule
- [ ] PUT /api/automation/schedule updates schedule
- [ ] Server logs show: "Schedule updated: [cron expression]"
- [ ] Frontend modal opens and closes
- [ ] Dashboard displays current schedule
- [ ] Schedule persists after server restart

---

## 🔥 Test Scheduled Execution

**Set schedule to run in 2 minutes:**

1. Check current time (e.g., 2:30 PM)
2. Set schedule to 2:32 PM:
   ```bash
   curl -X PUT http://localhost:5000/api/automation/schedule ^
     -H "Authorization: Bearer YOUR_TOKEN" ^
     -H "Content-Type: application/json" ^
     -d "{\"time\":\"14:32\",\"days\":[0,1,2,3,4,5,6],\"enabled\":true}"
   ```
3. Watch backend logs at 2:32 PM
4. Should see: "Running scheduled automation..."

---

## 🐛 Common Issues

### Schedule not loading on startup?
- Check MongoDB is running
- Verify AutomationStatus collection exists
- Check server logs for initialization errors

### Can't update schedule?
- Ensure using admin token (not teacher)
- Check request body format (JSON valid?)
- Verify endpoint: `/api/automation/schedule` (no typo)

### Automation not running at scheduled time?
- Check schedule is enabled: `enabled: true`
- Verify cron expression in logs
- Ensure server time zone matches your local time

---

## 📝 Quick Reference

**Day Numbers:**
- 0 = Sunday
- 1 = Monday  
- 2 = Tuesday
- 3 = Wednesday
- 4 = Thursday
- 5 = Friday
- 6 = Saturday

**Time Format:** 24-hour (00:00 - 23:59)

**Example Schedules:**
- Weekdays 9 AM: `{"time":"09:00","days":[1,2,3,4,5]}`
- Daily 2 PM: `{"time":"14:00","days":[0,1,2,3,4,5,6]}`
- Mon/Wed/Fri 6 PM: `{"time":"18:00","days":[1,3,5]}`

---

**For detailed testing, see:** [DYNAMIC_SCHEDULING.md](./DYNAMIC_SCHEDULING.md)
