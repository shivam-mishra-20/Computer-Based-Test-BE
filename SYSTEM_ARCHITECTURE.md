# 🗺️ EPUB Automation System Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     EPUB AUTOMATION SYSTEM                       │
│                                                                   │
│  📚 Input: EPUB Books → 🤖 Automation → 💾 MongoDB → 📊 Dashboard │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1️⃣ Component Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           BACKEND (cbt-exam-be)                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────┐      ┌──────────────────┐                     │
│  │  Express Server  │◄────►│   MongoDB Atlas  │                     │
│  │   (Port 5000)    │      │   (Questions DB) │                     │
│  └────────┬─────────┘      └──────────────────┘                     │
│           │                                                           │
│           ├─► API Routes                                             │
│           │   ├─ /api/automation/status   (GET)                      │
│           │   ├─ /api/automation/toggle   (POST)                     │
│           │   ├─ /api/automation/trigger  (POST)                     │
│           │   └─ /api/automation/stats    (GET)                      │
│           │                                                           │
│           ├─► Controllers                                            │
│           │   └─ automationController.ts                             │
│           │      ├─ getAutomationStatus()                            │
│           │      ├─ toggleAutomation()                               │
│           │      ├─ triggerProcessing()                              │
│           │      ├─ getProcessingStats()                             │
│           │      └─ bulkImportQuestions()                            │
│           │                                                           │
│           └─► Services                                               │
│               └─ questionValidationService.ts                        │
│                  └─ saveBatchValidatedQuestions()                    │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        AUTOMATION SCRIPTS                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────┐      ┌──────────────────┐                     │
│  │  epub-parser.js  │      │ automation-      │                     │
│  │                  │◄────►│   runner.js      │                     │
│  └──────────────────┘      └──────────────────┘                     │
│         │                           │                                │
│         │ Extracts                  │ Orchestrates                   │
│         ▼                           ▼                                │
│  ┌──────────────────┐      ┌──────────────────┐                     │
│  │ EPUB Files       │      │ Schedule & Batch │                     │
│  │ (class_12/)      │      │ Processing       │                     │
│  └──────────────────┘      └──────────────────┘                     │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (cbt-exam)                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │  AutomationDashboard.tsx                                  │       │
│  │  ┌──────────────────────────────────────────────────┐     │       │
│  │  │  Status Card (Enable/Disable, Run Now)          │     │       │
│  │  └──────────────────────────────────────────────────┘     │       │
│  │  ┌──────────────────────────────────────────────────┐     │       │
│  │  │  Summary Stats (Books, Questions, Imported)      │     │       │
│  │  └──────────────────────────────────────────────────┘     │       │
│  │  ┌──────────────────────────────────────────────────┐     │       │
│  │  │  Quality Metrics (Diagrams, Answers, Options)    │     │       │
│  │  └──────────────────────────────────────────────────┘     │       │
│  │  ┌──────────────────────────────────────────────────┐     │       │
│  │  │  Processing History Table                        │     │       │
│  │  └──────────────────────────────────────────────────┘     │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                           SCHEDULER                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │  Windows Task Scheduler                                   │       │
│  │  Trigger: Daily at 2:00 PM                                │       │
│  │  Action: Run run-automation.bat                           │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 2️⃣ Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                         AUTOMATED FLOW                                │
└──────────────────────────────────────────────────────────────────────┘

    ⏰ 2:00 PM Daily
         │
         ▼
    ┌─────────────────────┐
    │ Task Scheduler      │
    │ Triggers Batch File │
    └──────────┬──────────┘
               │
               ▼
    ┌─────────────────────┐
    │ run-automation.bat  │
    │ Starts Node Script  │
    └──────────┬──────────┘
               │
               ▼
    ┌─────────────────────┐
    │ automation-runner.js│
    └──────────┬──────────┘
               │
               ├─► 1️⃣ Check Automation Status
               │   └─ API: GET /api/automation/status
               │      ├─ Enabled? ✅ Continue
               │      └─ Disabled? ⏹️ Exit
               │
               ├─► 2️⃣ Scan EPUB Files
               │   └─ Folder: class_12/
               │      └─ Found: ["NEET JEE Chemistry Practice Bank...epub"]
               │
               ├─► 3️⃣ For Each Book:
               │   │
               │   ├─► Parse EPUB
               │   │   └─ epub-parser.js
               │   │      ├─ Extract metadata (title, subject, author)
               │   │      ├─ Extract chapters (from TOC)
               │   │      ├─ Parse exercises
               │   │      ├─ Detect MCQ options
               │   │      ├─ Mark correct answers
               │   │      ├─ Detect diagrams
               │   │      └─ Return: Array of questions
               │   │
               │   ├─► Import in Batches (50 questions/batch)
               │   │   └─ API: POST /api/automation/bulk-import-questions
               │   │      ├─ Batch 1: Questions 1-50
               │   │      ├─ Batch 2: Questions 51-100
               │   │      ├─ ...
               │   │      └─ Batch N: Remaining questions
               │   │
               │   └─► Update Processing Stats
               │       └─ API: PUT /api/automation/record/:id
               │          ├─ Total questions
               │          ├─ Imported count
               │          ├─ Diagrams count
               │          ├─ Correct answers count
               │          └─ Status (completed/failed)
               │
               └─► 4️⃣ Generate Summary Report
                   └─ Log file: logs/automation-YYYYMMDD.log
                      ├─ Total books processed
                      ├─ Total questions imported
                      ├─ Total diagrams
                      ├─ Success/failure counts
                      └─ Duration

┌──────────────────────────────────────────────────────────────────────┐
│                          MANUAL TRIGGER FLOW                          │
└──────────────────────────────────────────────────────────────────────┘

    🖱️ Admin clicks "Run Now"
         │
         ▼
    ┌─────────────────────┐
    │ Frontend Dashboard  │
    │ AutomationDashboard │
    └──────────┬──────────┘
               │
               ▼
    ┌─────────────────────┐
    │ API Call            │
    │ POST /api/automation│
    │     /trigger        │
    └──────────┬──────────┘
               │
               ▼
    ┌─────────────────────┐
    │ Backend Controller  │
    │ triggerProcessing() │
    └──────────┬──────────┘
               │
               ▼
    [Same flow as automated, steps 2-4 above]

┌──────────────────────────────────────────────────────────────────────┐
│                          MONITORING FLOW                              │
└──────────────────────────────────────────────────────────────────────┘

    🔄 Auto-refresh (Every 10 seconds)
         │
         ▼
    ┌─────────────────────┐
    │ Frontend Dashboard  │
    │ fetchData()         │
    └──────────┬──────────┘
               │
               ├─► GET /api/automation/status
               │   └─ Returns:
               │      ├─ isEnabled
               │      ├─ currentlyRunning
               │      ├─ totalRuns
               │      └─ successfulRuns
               │
               └─► GET /api/automation/stats
                   └─ Returns:
                      ├─ stats[] (per-book details)
                      └─ summary (aggregated totals)
                         ├─ totalBooks
                         ├─ totalQuestions
                         ├─ totalImported
                         ├─ withDiagrams
                         ├─ withCorrectAnswers
                         └─ withOptions
```

---

## 3️⃣ Question Extraction Pipeline

```
┌────────────────────────────────────────────────────────────────────┐
│                    EPUB → QUESTIONS PIPELINE                        │
└────────────────────────────────────────────────────────────────────┘

📕 EPUB File
    │
    ├─► 1️⃣ UNZIP
    │   └─ JSZip extracts:
    │      ├─ content.opf (metadata)
    │      ├─ toc.ncx (table of contents)
    │      └─ *.xhtml (chapters)
    │
    ├─► 2️⃣ PARSE METADATA
    │   └─ xml2js extracts:
    │      ├─ Title: "NEET JEE Chemistry Practice Bank Part 1"
    │      ├─ Creator: "ProToppers"
    │      ├─ Subject: "Chemistry"
    │      └─ Date: "2024"
    │
    ├─► 3️⃣ PARSE TOC
    │   └─ xml2js extracts:
    │      ├─ Chapter 1: "Atomic Structure"
    │      ├─ Chapter 2: "Chemical Bonding"
    │      └─ ...
    │
    ├─► 4️⃣ EXTRACT CHAPTERS
    │   └─ For each .xhtml file:
    │      ├─ Load HTML content
    │      ├─ Parse with cheerio
    │      └─ Identify sections:
    │         ├─ Theory (skip)
    │         ├─ Exercises ✅
    │         ├─ Practice Questions ✅
    │         └─ MCQs ✅
    │
    ├─► 5️⃣ SPLIT QUESTIONS
    │   └─ For each exercise section:
    │      ├─ Find question markers:
    │      │  ├─ "Q.1", "Q.2", ...
    │      │  ├─ "1.", "2.", ...
    │      │  └─ Numbered lists
    │      │
    │      └─ Extract question blocks:
    │         ├─ Question text
    │         ├─ Options (if MCQ)
    │         ├─ Answer (if provided)
    │         └─ Diagrams (if present)
    │
    ├─► 6️⃣ DETECT QUESTION TYPE
    │   └─ Analyze structure:
    │      ├─ Has options (A, B, C, D)? → MCQ
    │      ├─ Has fill-in-blank? → Fill in the Blank
    │      ├─ Has true/false? → True/False
    │      └─ Else → Short Answer
    │
    ├─► 7️⃣ PARSE OPTIONS
    │   └─ For MCQ questions:
    │      ├─ Extract option text:
    │      │  ├─ (A) Helium
    │      │  ├─ (B) Neon
    │      │  ├─ (C) Chlorine
    │      │  └─ (D) Argon
    │      │
    │      └─ Identify correct answer:
    │         ├─ Check answer key: "Ans: (C)"
    │         └─ Mark isCorrect: true for option C
    │
    ├─► 8️⃣ DETECT DIAGRAMS
    │   └─ Check for:
    │      ├─ <img> tags
    │      ├─ <svg> elements
    │      ├─ Figure references
    │      └─ Extract/upload to Firebase Storage
    │
    ├─► 9️⃣ ASSIGN METADATA
    │   └─ For each question:
    │      ├─ text: "Which of the following..."
    │      ├─ type: "MCQ"
    │      ├─ subject: "Chemistry" (from book metadata)
    │      ├─ topic: "Periodic Table" (from section heading)
    │      ├─ chapter: "Classification of Elements" (from TOC)
    │      ├─ board: "NEET/JEE" (from book title)
    │      ├─ class: 12 (from folder name)
    │      ├─ section: "Practice Bank" (from book title)
    │      ├─ difficulty: "medium" (auto-assigned based on marks)
    │      ├─ marks: 4 (default for NEET/JEE MCQ)
    │      ├─ options: [...] (with isCorrect flags)
    │      ├─ source: "NEET JEE Chemistry Practice Bank..."
    │      ├─ isActive: true
    │      └─ createdBy: "automation-system"
    │
    └─► 🔟 VALIDATE & OUTPUT
        └─ Return array of questions:
           [
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
               "source": "NEET JEE Chemistry Practice Bank Part 1...",
               "isActive": true,
               "createdBy": "automation-system"
             },
             ...5000+ more questions
           ]
```

---

## 4️⃣ Database Schema

```
┌────────────────────────────────────────────────────────────────────┐
│                         MongoDB Collections                         │
└────────────────────────────────────────────────────────────────────┘

╔═══════════════════════════════════════════════════════════════════╗
║  Collection: questions                                             ║
╠═══════════════════════════════════════════════════════════════════╣
║  {                                                                 ║
║    _id: ObjectId("..."),                                           ║
║    text: "Which of the following is NOT a noble gas?",            ║
║    type: "MCQ",                                                    ║
║    subject: "Chemistry",                                           ║
║    topic: "Periodic Table",                                        ║
║    chapter: "Classification of Elements",                          ║
║    board: "NEET/JEE",                                              ║
║    class: 12,                                                      ║
║    section: "Practice Bank",                                       ║
║    difficulty: "medium",                                           ║
║    marks: 4,                                                       ║
║    options: [                                                      ║
║      { text: "Helium", isCorrect: false },                         ║
║      { text: "Neon", isCorrect: false },                           ║
║      { text: "Chlorine", isCorrect: true },                        ║
║      { text: "Argon", isCorrect: false }                           ║
║    ],                                                              ║
║    source: "NEET JEE Chemistry Practice Bank Part 1...",          ║
║    isActive: true,                                                 ║
║    createdBy: "automation-system",                                 ║
║    createdAt: ISODate("2025-01-13T14:05:30.000Z"),                ║
║    updatedAt: ISODate("2025-01-13T14:05:30.000Z")                 ║
║  }                                                                 ║
╚═══════════════════════════════════════════════════════════════════╝

╔═══════════════════════════════════════════════════════════════════╗
║  Collection: automationStatus                                      ║
╠═══════════════════════════════════════════════════════════════════╣
║  {                                                                 ║
║    _id: ObjectId("..."),                                           ║
║    isEnabled: true,                                                ║
║    currentlyRunning: false,                                        ║
║    lastRun: ISODate("2025-01-13T14:00:00.000Z"),                  ║
║    nextScheduledRun: ISODate("2025-01-14T14:00:00.000Z"),         ║
║    totalRuns: 15,                                                  ║
║    successfulRuns: 14,                                             ║
║    failedRuns: 1,                                                  ║
║    createdAt: ISODate("2025-01-10T10:00:00.000Z"),                ║
║    updatedAt: ISODate("2025-01-13T14:05:45.000Z")                 ║
║  }                                                                 ║
╚═══════════════════════════════════════════════════════════════════╝

╔═══════════════════════════════════════════════════════════════════╗
║  Collection: processingStats                                       ║
╠═══════════════════════════════════════════════════════════════════╣
║  {                                                                 ║
║    _id: ObjectId("..."),                                           ║
║    fileName: "NEET JEE Chemistry Practice Bank Part 1.epub",      ║
║    status: "completed",                                            ║
║    totalQuestions: 5342,                                           ║
║    questionsImported: 5342,                                        ║
║    questionsWithDiagrams: 450,                                     ║
║    questionsWithCorrectAnswers: 5342,                              ║
║    questionsWithOptions: 5342,                                     ║
║    startTime: ISODate("2025-01-13T14:00:05.000Z"),                ║
║    endTime: ISODate("2025-01-13T14:02:20.000Z"),                  ║
║    duration: 135,  // seconds                                      ║
║    bookMetadata: {                                                 ║
║      title: "NEET JEE Chemistry Practice Bank",                    ║
║      subject: "Chemistry",                                         ║
║      class: "12",                                                  ║
║      board: "NEET/JEE"                                             ║
║    },                                                              ║
║    errorDetails: null,                                             ║
║    createdAt: ISODate("2025-01-13T14:00:05.000Z"),                ║
║    updatedAt: ISODate("2025-01-13T14:02:20.000Z")                 ║
║  }                                                                 ║
╚═══════════════════════════════════════════════════════════════════╝
```

---

## 5️⃣ API Endpoints Map

```
┌────────────────────────────────────────────────────────────────────┐
│                          API ROUTES                                 │
└────────────────────────────────────────────────────────────────────┘

BASE URL: http://localhost:5000

╔═══════════════════════════════════════════════════════════════════╗
║  GET /api/automation/status                                        ║
╠═══════════════════════════════════════════════════════════════════╣
║  Auth: Bearer Token (Admin)                                        ║
║  Purpose: Get current automation status                            ║
║  Response: {                                                       ║
║    success: true,                                                  ║
║    status: {                                                       ║
║      isEnabled: true,                                              ║
║      currentlyRunning: false,                                      ║
║      lastRun: "2025-01-13T14:00:00.000Z",                         ║
║      nextScheduledRun: "2025-01-14T14:00:00.000Z",                ║
║      totalRuns: 15,                                                ║
║      successfulRuns: 14,                                           ║
║      failedRuns: 1                                                 ║
║    }                                                               ║
║  }                                                                 ║
╚═══════════════════════════════════════════════════════════════════╝

╔═══════════════════════════════════════════════════════════════════╗
║  POST /api/automation/toggle                                       ║
╠═══════════════════════════════════════════════════════════════════╣
║  Auth: Bearer Token (Admin)                                        ║
║  Purpose: Enable or disable automation                             ║
║  Body: { enabled: true }                                           ║
║  Response: {                                                       ║
║    success: true,                                                  ║
║    message: "Automation enabled successfully",                     ║
║    status: { isEnabled: true, currentlyRunning: false }           ║
║  }                                                                 ║
╚═══════════════════════════════════════════════════════════════════╝

╔═══════════════════════════════════════════════════════════════════╗
║  POST /api/automation/trigger                                      ║
╠═══════════════════════════════════════════════════════════════════╣
║  Auth: Bearer Token (Admin)                                        ║
║  Purpose: Manually trigger automation                              ║
║  Body: { folder: "class_12" }                                      ║
║  Response: {                                                       ║
║    success: true,                                                  ║
║    message: "Automation triggered successfully"                    ║
║  }                                                                 ║
╚═══════════════════════════════════════════════════════════════════╝

╔═══════════════════════════════════════════════════════════════════╗
║  GET /api/automation/stats?limit=10&status=completed              ║
╠═══════════════════════════════════════════════════════════════════╣
║  Auth: Bearer Token (Admin)                                        ║
║  Purpose: Get processing statistics with filtering                 ║
║  Query Params:                                                     ║
║    - limit: Number of records (default: 10)                        ║
║    - status: Filter by status (completed/failed/processing)        ║
║  Response: {                                                       ║
║    success: true,                                                  ║
║    stats: [...],                                                   ║
║    summary: {                                                      ║
║      totalBooks: 1,                                                ║
║      totalQuestions: 5342,                                         ║
║      totalImported: 5342,                                          ║
║      withDiagrams: 450,                                            ║
║      withCorrectAnswers: 5342,                                     ║
║      withOptions: 5342,                                            ║
║      completed: 1,                                                 ║
║      failed: 0                                                     ║
║    }                                                               ║
║  }                                                                 ║
╚═══════════════════════════════════════════════════════════════════╝

╔═══════════════════════════════════════════════════════════════════╗
║  GET /api/automation/stats/:id                                     ║
╠═══════════════════════════════════════════════════════════════════╣
║  Auth: Bearer Token (Admin)                                        ║
║  Purpose: Get specific processing record details                   ║
║  Response: {                                                       ║
║    success: true,                                                  ║
║    stat: { ...full processing record... }                         ║
║  }                                                                 ║
╚═══════════════════════════════════════════════════════════════════╝

╔═══════════════════════════════════════════════════════════════════╗
║  POST /api/automation/bulk-import-questions                        ║
╠═══════════════════════════════════════════════════════════════════╣
║  Auth: Bearer Token                                                ║
║  Purpose: Import batch of questions                                ║
║  Body: {                                                           ║
║    questions: [...array of 50 questions...],                       ║
║    processingRecordId: "mongodbid"                                 ║
║  }                                                                 ║
║  Response: {                                                       ║
║    success: true,                                                  ║
║    savedCount: 50,                                                 ║
║    skippedCount: 0                                                 ║
║  }                                                                 ║
╚═══════════════════════════════════════════════════════════════════╝
```

---

## 6️⃣ Timeline Visualization

```
┌────────────────────────────────────────────────────────────────────┐
│               DAILY AUTOMATION TIMELINE (2 PM Run)                  │
└────────────────────────────────────────────────────────────────────┘

14:00:00  ⏰ Task Scheduler triggers
          │
14:00:01  ├─► Batch file executes
          │
14:00:02  ├─► Node script starts
          │   └─ automation-runner.js
          │
14:00:03  ├─► Check automation status
          │   └─ GET /api/automation/status
          │      └─ ✅ Enabled
          │
14:00:04  ├─► Scan class_12/ folder
          │   └─ Found: 1 EPUB file
          │
14:00:05  ├─► Start parsing book
          │   └─ epub-parser.js
          │
14:00:10  ├─► Metadata extracted
          │   ├─ Title: NEET JEE Chemistry Practice Bank
          │   ├─ Subject: Chemistry
          │   └─ 25 chapters found
          │
14:00:20  ├─► Chapter 1 processed
          │   └─ 200 questions extracted
          │
14:00:35  ├─► Chapter 2 processed
          │   └─ 187 questions extracted
          │
... (continue for all chapters)
          │
14:01:45  ├─► All chapters parsed
          │   └─ Total: 5342 questions
          │
14:01:46  ├─► Start batch import
          │   └─ POST /api/automation/bulk-import-questions
          │
14:01:47  ├─► Batch 1/108 imported (50 questions)
14:01:48  ├─► Batch 2/108 imported (50 questions)
14:01:49  ├─► Batch 3/108 imported (50 questions)
          │
... (continue for all batches)
          │
14:02:15  ├─► Batch 108/108 imported (42 questions)
          │   └─ Total imported: 5342
          │
14:02:16  ├─► Update processing stats
          │   └─ PUT /api/automation/record/:id
          │      ├─ Status: completed
          │      ├─ Total: 5342
          │      ├─ Imported: 5342
          │      ├─ With Diagrams: 450
          │      └─ With Answers: 5342
          │
14:02:17  ├─► Generate summary report
          │   └─ Write to: logs/automation-20250113.log
          │
14:02:18  └─► ✅ Automation complete
              └─ Duration: 2 minutes 18 seconds

┌────────────────────────────────────────────────────────────────────┐
│                     FRONTEND AUTO-REFRESH                           │
└────────────────────────────────────────────────────────────────────┘

14:00:00  📊 Dashboard showing old data
14:00:10  🔄 Auto-refresh #1 (status: running)
14:00:20  🔄 Auto-refresh #2 (status: running, imported: 387)
14:00:30  🔄 Auto-refresh #3 (status: running, imported: 950)
14:00:40  🔄 Auto-refresh #4 (status: running, imported: 1500)
14:00:50  🔄 Auto-refresh #5 (status: running, imported: 2100)
14:01:00  🔄 Auto-refresh #6 (status: running, imported: 2650)
14:01:10  🔄 Auto-refresh #7 (status: running, imported: 3200)
14:01:20  🔄 Auto-refresh #8 (status: running, imported: 3750)
14:01:30  🔄 Auto-refresh #9 (status: running, imported: 4300)
14:01:40  🔄 Auto-refresh #10 (status: running, imported: 4850)
14:01:50  🔄 Auto-refresh #11 (status: running, imported: 5200)
14:02:00  🔄 Auto-refresh #12 (status: running, imported: 5342)
14:02:10  🔄 Auto-refresh #13 (status: running, imported: 5342)
14:02:20  🔄 Auto-refresh #14 (status: idle, imported: 5342) ✅
```

---

## 7️⃣ Error Handling Flow

```
┌────────────────────────────────────────────────────────────────────┐
│                      ERROR SCENARIOS & HANDLING                     │
└────────────────────────────────────────────────────────────────────┘

❌ Scenario 1: Automation Disabled
    ├─ Detection: automation-runner.js checks status at start
    ├─ Action: Exit gracefully with log message
    └─ Impact: No processing, no errors

❌ Scenario 2: No EPUB Files Found
    ├─ Detection: fs.readdir returns empty array
    ├─ Action: Log warning and exit
    └─ Impact: No processing, no errors

❌ Scenario 3: EPUB Parsing Failed
    ├─ Detection: epub-parser.js throws error
    ├─ Action: Catch error, log details, skip file
    ├─ Update: ProcessingStats with status: "failed"
    └─ Impact: Continue with next file

❌ Scenario 4: Database Connection Lost
    ├─ Detection: MongoDB connection error
    ├─ Action: Retry 3 times with exponential backoff
    ├─ Fallback: Save questions to local JSON file
    └─ Impact: Partial processing, manual intervention needed

❌ Scenario 5: API Rate Limit (Firebase)
    ├─ Detection: HTTP 429 response
    ├─ Action: Wait and retry with exponential backoff
    ├─ Fallback: Continue without diagram upload
    └─ Impact: Questions saved without diagrams

❌ Scenario 6: Batch Import Failed
    ├─ Detection: API returns error for batch
    ├─ Action: Retry batch once
    ├─ Fallback: Log failed questions to file
    └─ Impact: Continue with next batch

❌ Scenario 7: Duplicate Questions
    ├─ Detection: Unique index violation on text+source
    ├─ Action: Skip duplicate, increment skipped count
    └─ Impact: No duplicate data, all duplicates skipped

❌ Scenario 8: Invalid Question Structure
    ├─ Detection: Validation fails in questionValidationService
    ├─ Action: Log validation error, skip question
    └─ Impact: Only valid questions imported
```

---

## 8️⃣ Performance Metrics

```
┌────────────────────────────────────────────────────────────────────┐
│                      EXPECTED PERFORMANCE                           │
└────────────────────────────────────────────────────────────────────┘

📊 Processing Speed
    ├─ EPUB Parsing: 15-30 seconds per book
    ├─ Question Extraction: ~1 second per 100 questions
    ├─ Batch Import: ~0.5 seconds per batch (50 questions)
    └─ Total (5000 questions): 2-5 minutes

💾 Memory Usage
    ├─ Parser: ~100 MB RAM
    ├─ Import: ~150 MB RAM
    └─ Peak: ~250 MB RAM

📦 Storage
    ├─ Questions (5000): ~10 MB MongoDB
    ├─ Diagrams (450): ~50 MB Firebase Storage
    ├─ Logs: ~2 MB per day
    └─ Total per book: ~62 MB

🎯 Success Rates
    ├─ Parsing Success: > 99%
    ├─ Import Success: > 98%
    ├─ Duplicate Detection: 100%
    └─ Overall Success: > 97%

⏱️ Schedule Performance
    ├─ Daily Run: 2:00 PM (± 5 seconds)
    ├─ Average Duration: 2 minutes 30 seconds
    ├─ Max Duration: 5 minutes
    └─ Failure Rate: < 2%
```

---

## 🎯 Quick Reference

### For Developers
- **Backend Code**: `cbt-exam-be/src/controllers/automationController.ts`
- **Parser**: `cbt-exam-be/scripts/epub-parser.js`
- **Runner**: `cbt-exam-be/scripts/automation-runner.js`
- **Frontend**: `cbt-exam/src/components/admin/AutomationDashboard.tsx`

### For Testing
- **Start Backend**: `cd cbt-exam-be && npm start`
- **Test Parser**: `node scripts/epub-parser.js "class_12/book.epub"`
- **Manual Trigger**: `node scripts/automation-runner.js`
- **Check Status**: `curl http://localhost:5000/api/automation/status`

### For Monitoring
- **Dashboard**: `http://localhost:3000/dashboard/automation`
- **Logs**: `cbt-exam-be/logs/automation-YYYYMMDD.log`
- **Database**: MongoDB Compass → `questions` collection

### For Scheduling
- **Task Scheduler**: Open `taskschd.msc`
- **Task Name**: "EPUB Question Extraction"
- **Trigger**: Daily at 2:00 PM
- **Action**: `C:\Users\Shivam\cbt-exam-be\run-automation.bat`

---

**📖 See also**:
- [AUTOMATED_QUESTION_EXTRACTION_PLAN.md](AUTOMATED_QUESTION_EXTRACTION_PLAN.md) - Full implementation plan
- [START_HERE.md](START_HERE.md) - Quick start guide
- [TESTING_CHECKLIST.md](TESTING_CHECKLIST.md) - Complete testing steps
- [AUTOMATION_CONTROL_GUIDE.md](AUTOMATION_CONTROL_GUIDE.md) - API documentation
- [FRONTEND_INTEGRATION.md](FRONTEND_INTEGRATION.md) - Dashboard integration
