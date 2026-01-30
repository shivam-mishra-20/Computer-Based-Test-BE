# ✅ Complete Testing Checklist

## Phase 1: Backend Setup ✓

### 1.1 Install Dependencies
```bash
cd c:\Users\Shivam\cbt-exam-be
npm install jszip xml2js cheerio axios
```

**Verify**: `package.json` should now include these packages

---

### 1.2 Test EPUB Parser (Standalone)
```bash
node scripts/epub-parser.js "class_12/NEET JEE Chemistry Practice Bank Part 1 (5000+ Questions).epub"
```

**Expected Output**:
- ✅ Console shows: "Starting EPUB parsing..."
- ✅ Extracts metadata (title, subject, author)
- ✅ Shows progress: "Processing chapter X of Y"
- ✅ Creates `extracted_questions.json` file
- ✅ Shows statistics:
  ```
  Extraction Complete!
  Total questions: 5000+
  With options: X
  With correct answers: Y
  With diagrams: Z
  ```

**Success Criteria**:
- [ ] No errors in console
- [ ] `extracted_questions.json` exists
- [ ] File size > 1 MB (indicates questions extracted)
- [ ] JSON is valid (open in VS Code, check syntax)

---

### 1.3 Verify Question Structure
```bash
# Open extracted_questions.json in VS Code
code extracted_questions.json
```

**Check Sample Question** (should look like):
```json
{
  "text": "Which of the following is NOT a noble gas?",
  "type": "MCQ",
  "subject": "Chemistry",
  "topic": "Periodic Table",
  "chapter": "Classification of Elements",
  "board": "NEET/JEE",
  "class": 12,
  "section": "Practice Bank",
  "difficulty": "medium",
  "marks": 4,
  "options": [
    { "text": "Helium", "isCorrect": false },
    { "text": "Neon", "isCorrect": false },
    { "text": "Chlorine", "isCorrect": true },
    { "text": "Argon", "isCorrect": false }
  ],
  "source": "NEET JEE Chemistry Practice Bank Part 1 (5000+ Questions).epub",
  "isActive": true,
  "createdBy": "automation-system"
}
```

**Success Criteria**:
- [ ] All fields present (text, type, subject, topic, chapter, board, class, section, difficulty, marks, source, isActive, createdBy)
- [ ] Options array has 4 items for MCQ
- [ ] Exactly one option has `isCorrect: true`
- [ ] No nested `tags` or `metadata` objects (FLAT structure)

---

## Phase 2: Backend API Testing ✓

### 2.1 Start Backend Server
```bash
cd c:\Users\Shivam\cbt-exam-be
npm start
```

**Expected Output**:
```
Server running on port 5000
MongoDB connected successfully
```

**Success Criteria**:
- [ ] No errors on startup
- [ ] Can access http://localhost:5000 in browser
- [ ] MongoDB connection message appears

---

### 2.2 Get Admin Token

**Option A: Login API**
```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"your-password"}'
```

**Option B: Use Existing Token**
- Open DevTools in browser while logged in as admin
- Go to Application → Local Storage → Find `token`
- Copy the value

**Save Token**:
```bash
# Save to environment variable (Windows PowerShell)
$env:TOKEN = "your-jwt-token-here"
```

**Success Criteria**:
- [ ] Token received (starts with "ey...")
- [ ] Token saved to environment variable

---

### 2.3 Check Automation Status
```bash
curl http://localhost:5000/api/automation/status \
  -H "Authorization: Bearer $env:TOKEN"
```

**Expected Response**:
```json
{
  "success": true,
  "status": {
    "isEnabled": false,
    "currentlyRunning": false,
    "totalRuns": 0,
    "successfulRuns": 0,
    "failedRuns": 0
  }
}
```

**Success Criteria**:
- [ ] 200 status code
- [ ] `success: true`
- [ ] Status object returned

---

### 2.4 Enable Automation
```bash
curl -X POST http://localhost:5000/api/automation/toggle \
  -H "Authorization: Bearer $env:TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}'
```

**Expected Response**:
```json
{
  "success": true,
  "message": "Automation enabled successfully",
  "status": {
    "isEnabled": true,
    "currentlyRunning": false
  }
}
```

**Success Criteria**:
- [ ] 200 status code
- [ ] `isEnabled: true`

---

### 2.5 Manual Trigger (First Run)
```bash
curl -X POST http://localhost:5000/api/automation/trigger \
  -H "Authorization: Bearer $env:TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"folder":"class_12"}'
```

**Expected Response**:
```json
{
  "success": true,
  "message": "Automation triggered successfully"
}
```

**What Happens Next**:
1. Backend starts scanning `class_12/` folder
2. Finds EPUB files
3. Parses each book
4. Imports questions in batches (50 per batch)
5. Updates processing stats

**Success Criteria**:
- [ ] 200 status code
- [ ] No immediate errors

---

### 2.6 Monitor Progress
```bash
# Check every 30 seconds
curl http://localhost:5000/api/automation/stats \
  -H "Authorization: Bearer $env:TOKEN"
```

**Expected Response**:
```json
{
  "success": true,
  "stats": [
    {
      "_id": "...",
      "fileName": "NEET JEE Chemistry Practice Bank Part 1 (5000+ Questions).epub",
      "status": "processing",
      "totalQuestions": 5342,
      "questionsImported": 2500,
      "questionsWithDiagrams": 450,
      "questionsWithCorrectAnswers": 5342,
      "questionsWithOptions": 5342,
      "startTime": "2025-01-13T14:00:00.000Z",
      "bookMetadata": {
        "title": "NEET JEE Chemistry Practice Bank",
        "subject": "Chemistry",
        "class": "12",
        "board": "NEET/JEE"
      }
    }
  ],
  "summary": {
    "totalBooks": 1,
    "totalQuestions": 5342,
    "totalImported": 2500,
    "withDiagrams": 450,
    "withCorrectAnswers": 5342,
    "withOptions": 5342,
    "completed": 0,
    "failed": 0
  }
}
```

**Success Criteria**:
- [ ] Status shows "processing" or "completed"
- [ ] `questionsImported` count is increasing
- [ ] `totalQuestions` matches expected count (5000+)

---

### 2.7 Verify Questions in Database

**Option A: Using MongoDB Compass**
1. Open MongoDB Compass
2. Connect to your database
3. Open `questions` collection
4. Filter: `{ "source": { "$regex": "NEET JEE Chemistry" } }`
5. Check count and sample documents

**Option B: Using API**
```bash
curl http://localhost:5000/api/questions?source=NEET%20JEE%20Chemistry&limit=10 \
  -H "Authorization: Bearer $env:TOKEN"
```

**Success Criteria**:
- [ ] Questions exist in database
- [ ] Count matches `questionsImported` from stats
- [ ] Fields are correctly populated (text, type, subject, etc.)
- [ ] Options array present for MCQ type
- [ ] Exactly one correct answer per question

---

## Phase 3: Automation Runner Testing ✓

### 3.1 Test Standalone Runner
```bash
node scripts/automation-runner.js
```

**Expected Console Output**:
```
======================================
  EPUB Automation Runner Started
  Time: [timestamp]
======================================

Checking automation status...
✓ Automation is enabled

Scanning for EPUB files in: class_12
Found 1 EPUB file(s)

Processing book 1/1: NEET JEE Chemistry Practice Bank Part 1 (5000+ Questions).epub
--------------------
Parsing EPUB...
✓ Parsed successfully
  Total questions: 5342
  With options: 5342
  With correct answers: 5342
  With diagrams: 450

Importing questions in batches...
  Batch 1/108: Imported 50 questions
  Batch 2/108: Imported 50 questions
  ...
  Batch 108/108: Imported 42 questions

✓ Book processed successfully
  Imported: 5342
  Skipped: 0
  Duration: 2m 15s

======================================
  Automation Run Summary
======================================
  Total Books: 1
  Successfully Processed: 1
  Failed: 0
  Total Questions Imported: 5342
  Total Duration: 2m 15s
======================================
```

**Success Criteria**:
- [ ] No errors during execution
- [ ] All questions imported successfully
- [ ] Processing stats saved to database
- [ ] Script completes without crashes

---

### 3.2 Verify Idempotency (Run Again)
```bash
node scripts/automation-runner.js
```

**Expected Behavior**:
- Should detect questions already exist
- Should skip duplicates
- Should complete quickly (seconds, not minutes)

**Success Criteria**:
- [ ] No duplicate questions created
- [ ] Database count remains same
- [ ] Script logs "Question already exists, skipping"

---

## Phase 4: Scheduling Setup ✓

### 4.1 Create Batch Script

**Create**: `run-automation.bat` in project root
```batch
@echo off
cd C:\Users\Shivam\cbt-exam-be
node scripts/automation-runner.js > logs/automation-%date:~-4,4%%date:~-10,2%%date:~-7,2%.log 2>&1
```

**Test**:
```bash
.\run-automation.bat
```

**Success Criteria**:
- [ ] Script runs without errors
- [ ] Log file created in `logs/` folder
- [ ] Questions imported successfully

---

### 4.2 Windows Task Scheduler

**Steps**:
1. Open Task Scheduler (`taskschd.msc`)
2. Create Task → Name: "EPUB Question Extraction"
3. Triggers → New → Daily at 2:00 PM
4. Actions → Start a program:
   - Program: `C:\Users\Shivam\cbt-exam-be\run-automation.bat`
   - Start in: `C:\Users\Shivam\cbt-exam-be`
5. Conditions:
   - ✅ Start only if computer is on AC power (uncheck if laptop)
   - ✅ Wake computer to run this task
6. Settings:
   - ✅ Allow task to be run on demand
   - ✅ Run task as soon as possible after scheduled start is missed

**Test Scheduled Task**:
1. Right-click task → Run
2. Check logs folder for new log file
3. Verify questions imported

**Success Criteria**:
- [ ] Task appears in Task Scheduler
- [ ] Manual run works
- [ ] Task runs at 2 PM automatically
- [ ] Logs are created

---

## Phase 5: Frontend Integration ✓

### 5.1 Install shadcn/ui Components
```bash
cd c:\Users\Shivam\cbt-exam
npx shadcn-ui@latest add card button badge
```

**Success Criteria**:
- [ ] Components installed in `src/components/ui/`

---

### 5.2 Create Dashboard Page

**Create**: `src/app/dashboard/automation/page.tsx`
```tsx
import AutomationDashboard from '@/components/admin/AutomationDashboard';

export default function AutomationPage() {
  return <AutomationDashboard />;
}
```

**Success Criteria**:
- [ ] File created
- [ ] No TypeScript errors

---

### 5.3 Add Navigation Link

**Update**: Your admin sidebar component
```tsx
<Link href="/dashboard/automation">
  📚 EPUB Automation
</Link>
```

**Success Criteria**:
- [ ] Link appears in admin sidebar
- [ ] Clicking navigates to dashboard

---

### 5.4 Test Frontend Dashboard

**Steps**:
1. Login as admin
2. Navigate to `/dashboard/automation`
3. Check all sections load:
   - Status card (ENABLED/DISABLED)
   - Summary stats (Total Books, Questions, etc.)
   - Quality metrics (progress bars)
   - Processing history table

**Test Controls**:
1. Click "Disable" → Status should change
2. Click "Enable" → Status should change back
3. Click "Run Now" → Processing should start
4. Wait 10 seconds → Stats should auto-refresh
5. Click "Refresh" → Manual refresh works

**Success Criteria**:
- [ ] Dashboard loads without errors
- [ ] All data displays correctly
- [ ] Toggle works (enable/disable)
- [ ] Run Now button triggers processing
- [ ] Auto-refresh updates every 10 seconds
- [ ] Manual refresh works
- [ ] Table shows processing history
- [ ] Stats match backend data

---

## Phase 6: End-to-End Validation ✓

### 6.1 Full Automation Flow Test

**Timeline**: Run complete workflow and verify

**T+0:00 (2:00 PM)** - Task Scheduler triggers
- [ ] `run-automation.bat` executes
- [ ] Script checks if automation enabled (should be true)

**T+0:05** - Scanning and Parsing
- [ ] Script scans `class_12/` folder
- [ ] Finds EPUB files
- [ ] Starts parsing first book

**T+0:30** - Importing Questions
- [ ] Questions import in batches
- [ ] Progress visible in logs
- [ ] No errors in log file

**T+2:00** - Completion
- [ ] All questions imported
- [ ] Processing stats saved to database
- [ ] Log file shows summary

**T+2:01** - Verification
- [ ] Check frontend dashboard → Stats updated
- [ ] Check MongoDB → New questions exist
- [ ] Check log file → No errors

**Success Criteria**:
- [ ] Complete flow executes without manual intervention
- [ ] All questions imported successfully
- [ ] Stats reflect in dashboard
- [ ] No errors in logs

---

### 6.2 Quality Validation

**Check Questions**:
```bash
# Get sample questions from database
curl http://localhost:5000/api/questions?source=NEET%20JEE%20Chemistry&limit=10 \
  -H "Authorization: Bearer $env:TOKEN"
```

**Manual Review Checklist**:
- [ ] Question text is readable (no encoding issues)
- [ ] Options are correctly formatted
- [ ] Correct answer is marked (`isCorrect: true`)
- [ ] Subject/Topic/Chapter are populated
- [ ] Class is correct (12)
- [ ] Board is correct (NEET/JEE)
- [ ] Source matches book name
- [ ] Difficulty level assigned
- [ ] Marks are reasonable (1-4)

**Check Diagrams**:
- [ ] Questions with diagrams have image URLs
- [ ] Images are accessible (open in browser)
- [ ] Images are stored in Firebase Storage

---

### 6.3 Performance Validation

**Metrics to Check**:

| Metric | Target | Actual |
|--------|--------|--------|
| Parse Time (per book) | < 30 seconds | ___ seconds |
| Import Time (5000 questions) | < 5 minutes | ___ minutes |
| Memory Usage | < 500 MB | ___ MB |
| Duplicate Questions | 0 | ___ |
| Failed Imports | < 1% | ___% |
| Questions with Answers | > 95% | ___% |
| Questions with Options (MCQ) | > 95% | ___% |

**Success Criteria**:
- [ ] All metrics meet targets
- [ ] No memory leaks (check Task Manager)
- [ ] No database connection issues

---

## Phase 7: Production Readiness ✓

### 7.1 Error Handling Test

**Test Scenarios**:

**Scenario 1: Missing EPUB File**
```bash
# Rename EPUB file temporarily
mv "class_12/NEET JEE Chemistry Practice Bank Part 1 (5000+ Questions).epub" "class_12/temp.epub"
node scripts/automation-runner.js
```
**Expected**: Script should log "No EPUB files found" and exit gracefully

**Scenario 2: Corrupted EPUB**
```bash
# Create a fake EPUB file
echo "invalid" > class_12/fake.epub
node scripts/automation-runner.js
```
**Expected**: Script should log error and skip file

**Scenario 3: Database Connection Lost**
```bash
# Stop MongoDB service
# Run automation script
node scripts/automation-runner.js
```
**Expected**: Script should retry connection and log error

**Scenario 4: API Rate Limit (Firebase)**
```bash
# Process very large book (test with 10,000+ questions)
node scripts/automation-runner.js
```
**Expected**: Batch processing should handle rate limits

**Success Criteria**:
- [ ] All error scenarios handled gracefully
- [ ] No crashes or unhandled exceptions
- [ ] Errors logged to file
- [ ] Processing continues after recoverable errors

---

### 7.2 Monitoring Setup

**Create Monitoring Script**: `scripts/check-automation-health.js`
```javascript
// Check if automation is running as expected
// Send alerts if failures detected
```

**Success Criteria**:
- [ ] Health check script created
- [ ] Alerts configured (email/Slack)

---

### 7.3 Backup and Recovery

**Backup Strategy**:
1. Database backup before each run
2. Log rotation (keep last 30 days)
3. Processed books tracking

**Test Backup**:
```bash
# MongoDB backup
mongodump --db=cbt-exam --out=backup/$(date +%Y%m%d)
```

**Success Criteria**:
- [ ] Backup script works
- [ ] Can restore from backup
- [ ] Logs are archived

---

## 🎯 Final Checklist

### Backend
- [ ] Dependencies installed
- [ ] EPUB parser tested
- [ ] Questions structure validated (FLAT, not nested)
- [ ] API endpoints working
- [ ] Authentication working
- [ ] Automation can be toggled
- [ ] Manual trigger works
- [ ] Stats API returns data

### Automation
- [ ] Standalone runner works
- [ ] Batch processing successful
- [ ] Idempotency verified (no duplicates)
- [ ] Error handling tested
- [ ] Logs being created
- [ ] Processing stats saved

### Scheduling
- [ ] Batch script created
- [ ] Task Scheduler configured
- [ ] Runs at 2 PM daily
- [ ] Logs are generated
- [ ] Questions imported automatically

### Frontend
- [ ] Dashboard component created
- [ ] shadcn/ui components installed
- [ ] Dashboard page created
- [ ] Navigation added
- [ ] All features working:
  - [ ] Status display
  - [ ] Toggle enable/disable
  - [ ] Run now button
  - [ ] Auto-refresh (10 sec)
  - [ ] Manual refresh
  - [ ] Summary stats
  - [ ] Quality metrics
  - [ ] Processing history table

### Quality
- [ ] Questions are readable
- [ ] Correct answers marked
- [ ] Options properly formatted
- [ ] Metadata populated correctly
- [ ] Diagrams extracted (if present)
- [ ] No duplicates
- [ ] > 95% import success rate

### Production
- [ ] Error scenarios tested
- [ ] Performance validated
- [ ] Monitoring setup
- [ ] Backup strategy implemented
- [ ] Documentation complete

---

## 🎉 Completion Criteria

**✅ System is ready for production when**:
1. All checklist items marked complete
2. At least 3 successful automated runs at 2 PM
3. Frontend dashboard showing accurate data
4. No critical errors in logs
5. Questions quality validated by admin
6. Performance metrics meet targets

---

## 📞 Support

If you encounter issues:

1. **Check Logs**:
   ```bash
   # Automation logs
   ls -la logs/
   tail -n 100 logs/automation-latest.log
   
   # Backend logs
   npm start  # Check console output
   ```

2. **Check Status**:
   ```bash
   curl http://localhost:5000/api/automation/status -H "Authorization: Bearer $TOKEN"
   ```

3. **Restart Services**:
   ```bash
   # Restart backend
   pm2 restart cbt-exam-be
   
   # Restart frontend
   pm2 restart cbt-exam
   ```

4. **Database Check**:
   ```bash
   # Check question count
   mongo cbt-exam --eval "db.questions.countDocuments()"
   ```

---

**Start Testing**: Begin with Phase 1, Step 1.1 ✓
