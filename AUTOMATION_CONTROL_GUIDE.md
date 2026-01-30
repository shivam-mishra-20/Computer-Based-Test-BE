# Automation Control & Supervision Guide

## 🎛️ Control Panel APIs

### Base URL
```
http://localhost:5000/api/automation
```

### Authentication
All endpoints require Admin authentication:
```
Authorization: Bearer <your-admin-token>
```

---

## 📡 API Endpoints

### 1. Get Automation Status
```http
GET /api/automation/status
```

**Response:**
```json
{
  "success": true,
  "status": {
    "isEnabled": true,
    "currentlyRunning": false,
    "lastRun": "2026-01-28T14:00:00.000Z",
    "nextScheduledRun": "2026-01-29T14:00:00.000Z",
    "totalRuns": 5,
    "successfulRuns": 4,
    "failedRuns": 1
  }
}
```

---

### 2. Toggle Automation ON/OFF
```http
POST /api/automation/toggle
Content-Type: application/json

{
  "enabled": true  // or false to disable
}
```

**Response:**
```json
{
  "success": true,
  "message": "Automation enabled",
  "status": { ... }
}
```

---

### 3. Manual Trigger (Start Now)
```http
POST /api/automation/trigger
Content-Type: application/json

{
  "folder": "class_12"  // optional, default: "class_12"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Processing started",
  "folder": "class_12"
}
```

---

### 4. Get Processing Statistics
```http
GET /api/automation/stats?limit=20&status=completed
```

**Query Parameters:**
- `limit` - Number of records (default: 20)
- `status` - Filter by status: pending, processing, completed, failed
- `fileName` - Filter by book name

**Response:**
```json
{
  "success": true,
  "stats": [
    {
      "_id": "...",
      "fileName": "NEET JEE Chemistry Practice Bank.epub",
      "status": "completed",
      "totalQuestions": 1250,
      "questionsImported": 1230,
      "questionsWithDiagrams": 450,
      "questionsWithCorrectAnswers": 980,
      "questionsWithOptions": 1230,
      "startTime": "2026-01-28T14:00:00Z",
      "endTime": "2026-01-28T14:15:30Z",
      "bookMetadata": {
        "title": "NEET JEE Chemistry Practice Bank",
        "subject": "Chemistry",
        "class": "Class 12",
        "board": "NEET"
      }
    }
  ],
  "summary": {
    "totalBooks": 5,
    "totalQuestions": 6500,
    "totalImported": 6300,
    "withDiagrams": 2100,
    "withCorrectAnswers": 5200,
    "withOptions": 6000,
    "completed": 4,
    "failed": 1
  }
}
```

---

### 5. Get Detailed Book Processing Info
```http
GET /api/automation/stats/:id
```

**Response:**
```json
{
  "success": true,
  "details": {
    "_id": "...",
    "fileName": "NEET JEE Chemistry Practice Bank.epub",
    "filePath": "/app/class_12/NEET JEE Chemistry Practice Bank.epub",
    "status": "completed",
    "totalQuestions": 1250,
    "questionsImported": 1230,
    "questionsWithDiagrams": 450,
    "questionsWithCorrectAnswers": 980,
    "questionsWithOptions": 1230,
    "errors": [],
    "bookMetadata": {
      "title": "NEET JEE Chemistry Practice Bank Part 1",
      "author": "Various",
      "subject": "Chemistry",
      "class": "Class 12",
      "board": "NEET"
    },
    "startTime": "2026-01-28T14:00:00Z",
    "endTime": "2026-01-28T14:15:30Z",
    "createdAt": "2026-01-28T14:00:00Z",
    "updatedAt": "2026-01-28T14:15:30Z"
  }
}
```

---

## 🖥️ Using the Control Panel

### Test the Parser First
```bash
cd cbt-exam-be
node scripts/epub-parser.js "class_12/NEET JEE Chemistry Practice Bank Part 1 (5000+ Questions).epub"

# Review the output in extracted_questions.json
```

### Enable Automation
```bash
curl -X POST http://localhost:5000/api/automation/toggle \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

### Trigger Manual Run
```bash
curl -X POST http://localhost:5000/api/automation/trigger \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"folder": "class_12"}'
```

### Check Status
```bash
curl -X GET http://localhost:5000/api/automation/status \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### View Statistics
```bash
curl -X GET "http://localhost:5000/api/automation/stats?limit=10" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

---

## 📊 Monitoring Dashboard (Frontend)

You can create a simple admin dashboard page at `/dashboard/automation` with:

### Key Metrics to Display:
1. **Automation Status**
   - ✅ Enabled/Disabled toggle
   - 🔄 Currently Running indicator
   - 📅 Last run time
   - ⏰ Next scheduled run

2. **Processing Statistics**
   - 📚 Total books processed
   - ❓ Total questions extracted
   - ✔️ Successfully imported
   - 🖼️ Questions with diagrams
   - ✅ Questions with correct answers

3. **Recent Processing History**
   - Table showing last 20 books
   - Status (completed/failed)
   - Questions extracted vs imported
   - Processing time
   - View details button

4. **Manual Controls**
   - ▶️ Start Now button
   - ⏸️ Pause/Stop button
   - 🔄 Re-process failed books

---

## 🕐 Scheduled Run (2 PM Daily)

### Using n8n (Recommended)
Update the CRON trigger in n8n workflow:
```json
{
  "cronExpression": "0 14 * * *"  // 2 PM daily
}
```

### Using System Cron (Linux/Mac)
```bash
# Open crontab
crontab -e

# Add this line for 2 PM daily
0 14 * * * cd /path/to/cbt-exam-be && node scripts/automation-runner.js
```

### Using Windows Task Scheduler
1. Open Task Scheduler
2. Create Basic Task
3. Trigger: Daily at 2:00 PM
4. Action: Start a program
   - Program: `node`
   - Arguments: `C:\Users\Shivam\cbt-exam-be\scripts\automation-runner.js`
   - Start in: `C:\Users\Shivam\cbt-exam-be`

---

## 🔍 Supervision Features

### Real-time Progress Tracking
```javascript
// Poll status every 10 seconds while running
const checkProgress = async () => {
  const response = await fetch('/api/automation/stats', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await response.json();
  
  // Update UI with latest stats
  updateDashboard(data);
};

setInterval(checkProgress, 10000);
```

### Question Quality Metrics
```javascript
// Calculate quality score
const qualityScore = (stats) => {
  const withAnswers = stats.questionsWithCorrectAnswers / stats.totalQuestions;
  const withDiagrams = stats.questionsWithDiagrams / stats.totalQuestions;
  const importSuccess = stats.questionsImported / stats.totalQuestions;
  
  return {
    answerCoverage: (withAnswers * 100).toFixed(1) + '%',
    diagramCoverage: (withDiagrams * 100).toFixed(1) + '%',
    importSuccess: (importSuccess * 100).toFixed(1) + '%'
  };
};
```

### Alerts & Notifications
- 🔔 When automation starts
- ✅ When extraction completes successfully
- ❌ When extraction fails
- ⚠️ When quality metrics are low (< 80% success rate)

---

## 🐛 Troubleshooting

### Automation Not Running?
```bash
# Check status
curl http://localhost:5000/api/automation/status

# Check if enabled
# Check if currently running (might be stuck)
```

### Questions Not Being Saved?
```bash
# Check processing stats
curl http://localhost:5000/api/automation/stats

# Look for errors in the stats
# Check backend logs
```

### Parser Failing?
```bash
# Test parser directly
node scripts/epub-parser.js "class_12/YourBook.epub"

# Check extracted_questions.json
# Look for error messages
```

---

## 📝 Next Steps

1. ✅ Test the parser with your Chemistry book
2. ✅ Review extracted questions
3. ✅ Enable automation via API
4. ✅ Schedule for 2 PM daily
5. ✅ Build frontend dashboard (optional)
6. ✅ Monitor first few runs
7. ✅ Add more books to class_12 folder

---

**Ready to start?** Run the test first:

```bash
cd cbt-exam-be
node scripts/epub-parser.js "class_12/NEET JEE Chemistry Practice Bank Part 1 (5000+ Questions).epub"
```
