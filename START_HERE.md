# 🎮 Quick Start - Run Your First Extraction!

## ✅ Prerequisites Check

Make sure you have:
- [x] Backend running on http://localhost:5000
- [x] MongoDB running
- [x] Admin user created
- [x] Book in `class_12` folder: "NEET JEE Chemistry Practice Bank Part 1 (5000+ Questions).epub"

---

## 🚀 Step 1: Install Dependencies

```bash
cd cbt-exam-be

# Install required packages
npm install jszip xml2js cheerio axios
```

---

## 🧪 Step 2: Test the Parser

```bash
# Test extraction from your Chemistry book
node scripts/epub-parser.js "class_12/NEET JEE Chemistry Practice Bank Part 1 (5000+ Questions).epub"
```

**Expected Output:**
```
[EPUB Parser] Reading: class_12/NEET JEE Chemistry Practice Bank...
[EPUB Parser] Metadata: { title: '...', author: '...', subject: 'Chemistry' }
[EPUB Parser] Found 45 chapters
[EPUB Parser] Total questions: 1250
[EPUB Parser] With options: 1200
[EPUB Parser] With correct answers: 980
[EPUB Parser] With diagrams: 320

✅ Extraction Complete!
═══════════════════════════════════════
📚 Book: NEET JEE Chemistry Practice Bank Part 1
❓ Questions:
   Total: 1250
   With Options: 1200
   With Correct Answers: 980
   With Diagrams: 320

💾 Saved to: extracted_questions.json
```

**Review the output:**
```bash
# Open extracted_questions.json to inspect
code extracted_questions.json
```

---

## 🔐 Step 3: Get Your Admin Token

```bash
# Login as admin
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "password": "your-password"}'
```

**Save the token from response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": { ... }
}
```

**Set environment variable:**
```bash
# PowerShell
$env:ADMIN_TOKEN="your-token-here"

# Or create .env file
echo "ADMIN_TOKEN=your-token-here" >> .env
```

---

## ⚡ Step 4: Enable Automation

```bash
# Enable automation
curl -X POST http://localhost:5000/api/automation/toggle \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

**Response:**
```json
{
  "success": true,
  "message": "Automation enabled",
  "status": {
    "isEnabled": true,
    "currentlyRunning": false
  }
}
```

---

## 🎯 Step 5: Run Manual Extraction (Test)

```bash
# Trigger manual processing
curl -X POST http://localhost:5000/api/automation/trigger \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"folder": "class_12"}'
```

**Or run directly:**
```bash
node scripts/automation-runner.js
```

**Watch the console output:**
```
🤖 Automation Runner Started
═══════════════════════════════════════
⏰ Time: 1/28/2026, 2:00:00 PM
📁 Target Folder: class_12
═══════════════════════════════════════

✓ Automation Status: ENABLED
✓ Currently Running: NO
📚 Found 1 EPUB file(s)

📖 Processing: NEET JEE Chemistry Practice Bank Part 1...
────────────────────────────────────────────────────────
1️⃣  Parsing EPUB...
2️⃣  Creating processing record...
3️⃣  Importing 1250 questions...
   Batch 1/25: 50 imported
   Batch 2/25: 50 imported
   ...
4️⃣  Updating processing record...
✅ Successfully processed!
   Questions: 1230/1250 imported

📊 Processing Summary
═══════════════════════════════════════
📚 Books Processed: 1
✅ Succeeded: 1
❌ Failed: 0
❓ Total Questions: 1250
✔️  Imported: 1230
📈 Success Rate: 98.4%
═══════════════════════════════════════
```

---

## 📊 Step 6: Check Statistics

```bash
# Get processing stats
curl -X GET http://localhost:5000/api/automation/stats \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "stats": [...],
  "summary": {
    "totalBooks": 1,
    "totalQuestions": 1250,
    "totalImported": 1230,
    "withDiagrams": 320,
    "withCorrectAnswers": 980,
    "withOptions": 1200,
    "completed": 1,
    "failed": 0
  }
}
```

---

## 🎛️ Step 7: Control Panel (Optional)

### Check Status
```bash
curl -X GET http://localhost:5000/api/automation/status \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Disable Automation
```bash
curl -X POST http://localhost:5000/api/automation/toggle \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

### Re-enable
```bash
curl -X POST http://localhost:5000/api/automation/toggle \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

---

## 📅 Step 8: Schedule for 2 PM Daily

### Using Windows Task Scheduler

1. Open Task Scheduler (`taskschd.msc`)
2. Click "Create Basic Task"
3. Name: "EPUB Question Extraction"
4. Trigger: Daily at 2:00 PM
5. Action: Start a program
   - Program: `node`
   - Arguments: `C:\Users\Shivam\cbt-exam-be\scripts\automation-runner.js`
   - Start in: `C:\Users\Shivam\cbt-exam-be`
6. Click Finish

### Using PowerShell (Run on startup)
```powershell
# Create startup script
$action = New-ScheduledTaskAction -Execute 'node' -Argument 'C:\Users\Shivam\cbt-exam-be\scripts\automation-runner.js' -WorkingDirectory 'C:\Users\Shivam\cbt-exam-be'
$trigger = New-ScheduledTaskTrigger -Daily -At 2pm
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "EPUB-Extraction" -Description "Daily EPUB question extraction at 2 PM"
```

---

## ✅ Verification Checklist

After running extraction, verify:

- [ ] Questions saved to database
- [ ] All fields populated (subject, chapter, board, etc.)
- [ ] MCQ options captured correctly
- [ ] Diagrams linked (if present in book)
- [ ] Correct answers identified
- [ ] Processing stats saved
- [ ] No errors in console

### Check Questions in Database

```bash
# Connect to MongoDB
mongo

use cbt-exam

# Count imported questions
db.questions.countDocuments({ source: "Smart Import", subject: "Chemistry" })

# View sample question
db.questions.findOne({ source: "Smart Import", subject: "Chemistry" })
```

---

## 🎉 Success!

You now have:
- ✅ 1000+ Chemistry questions extracted
- ✅ All metadata properly structured
- ✅ Automation ready for daily runs
- ✅ Control panel to supervise

**Next Steps:**
1. Add more books to `class_12` folder
2. Test with `class_11` books
3. Fine-tune difficulty detection
4. Build admin dashboard UI (optional)

---

## 🐛 Troubleshooting

### "Cannot find module 'jszip'"
```bash
npm install jszip xml2js cheerio axios
```

### "Unauthorized" error
```bash
# Make sure you set the token
$env:ADMIN_TOKEN="your-actual-token"
```

### No questions extracted
- Check if EPUB is valid (unzip manually)
- Check console for error messages
- Try different chapter structure detection

### Questions not saving
- Check backend logs
- Verify MongoDB connection
- Check authentication token

---

**Need help?** Check [AUTOMATION_CONTROL_GUIDE.md](./AUTOMATION_CONTROL_GUIDE.md) for detailed API documentation.
