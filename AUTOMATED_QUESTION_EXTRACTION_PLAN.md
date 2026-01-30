# 📚 Automated NCERT Question Extraction using n8n

## Executive Summary
Automate the extraction of questions from EPUB textbooks (NCERT, RD Sharma, etc.) using n8n workflow automation, matching the exact metadata structure and quality standards of the current Smart Import system.

---

## 🎯 Current Smart Import Analysis

### **Question Schema & Metadata**
Based on your actual database format, each question has the following **FLAT STRUCTURE** (all fields at root level):

#### **Complete Question Format:**
```typescript
{
  // Core Question Content
  text: string,                    // REQUIRED - Question text with LaTeX formatting
  type: string,                    // REQUIRED - "mcq" | "truefalse" | "fill" | "short" | "long" | "assertionreason" | "integer"
  
  // Answer Fields
  options?: Array<{                // For MCQ/True-False questions
    text: string,
    isCorrect: boolean
  }>,
  correctAnswerText?: string,      // For fill/short/long/integer answers
  integerAnswer?: number,          // For integer type (JEE style)
  
  // Assertion-Reason Fields
  assertion?: string,
  reason?: string,
  assertionIsTrue?: boolean,
  reasonIsTrue?: boolean,
  reasonExplainsAssertion?: boolean,
  
  // Metadata Fields (FLAT - at root level, not nested)
  subject: string,                 // REQUIRED - "Physics", "Chemistry", "Mathematics", etc.
  topic: string,                   // REQUIRED - Topic/subtopic within chapter
  chapter: string,                 // REQUIRED - Chapter name (e.g., "Dimensional Analysis And Vectors")
  board: string,                   // REQUIRED - "CBSE", "JEE", "NEET", "NCERT", etc.
  class?: string,                  // "Class 11", "Class 12", etc.
  section: string,                 // "Objective", "Exercise 1.1", "MCQs", etc.
  difficulty: string,              // "easy" | "medium" | "hard"
  marks: number,                   // Default marks (1, 2, 4, 5, etc.)
  source: string,                  // "Smart Import" | "AI" | "Manual" | "Upload"
  
  // Additional Fields
  explanation?: string,            // Solution/explanation text
  diagramUrl?: string,             // URL for diagrams/images
  diagramAlt?: string,             // Alt text for diagram
  
  // System Fields
  createdBy: ObjectId,             // REQUIRED - User who created/imported
  isActive: boolean,               // REQUIRED - Default: true
  createdAt: Date,                 // Auto-generated
  updatedAt: Date                  // Auto-generated
}
```

#### **Example from Your Database:**
```javascript
{
  text: "Which of the following is not equal to watt?",
  type: "mcq",
  options: [
    { text: "Joule/second", isCorrect: false },
    { text: "Ampere/volt", isCorrect: true },
    { text: "(Ampere)² × ohm", isCorrect: false },
    { text: "(Volt)²/ohm", isCorrect: false }
  ],
  subject: "Physics",
  board: "JEE",
  chapter: "Dimensional Analysis And Vectors",
  topic: "Physical Quantities And Dimensional Analysis",
  section: "Objective",
  marks: 1,
  difficulty: "medium",
  correctAnswerText: "Ampere/volt",
  explanation: "The question asks which of the given options is not equal to a Watt...",
  source: "Smart Import",
  isActive: true,
  createdBy: ObjectId('694106d3d9a0ed33ab23dba6')
}
```

---

## 🔄 Proposed n8n Workflow Architecture

### **Workflow: NCERT Question Extraction Pipeline**

```
┌─────────────────────────────────────────────────────────────────┐
│                     STAGE 1: INITIALIZATION                      │
├─────────────────────────────────────────────────────────────────┤
│  1. CRON Trigger (Daily 2 PM) - Can be controlled via API       │
│     ↓                                                            │
│  2. Scan Class Folders (class_12/ for now, class_11/ later)     │
│     ↓                                                            │
│  3. Check Processing Status (MongoDB)                           │
│     - Skip already processed books                              │
│     - Identify new/updated EPUBs                                │
│  4. Check if automation is ENABLED (supervision control)        │
│     - If disabled, skip this run                                │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                  STAGE 2: EPUB PROCESSING                        │
├─────────────────────────────────────────────────────────────────┤
│  4. Unzip EPUB (EPUB is ZIP format)                            │
│     - Extract content.opf (metadata)                            │
│     - Extract all .xhtml/.html files                            │
│     - Extract images from OEBPS/Images/                         │
│     ↓                                                            │
│  5. Parse Book Metadata from content.opf                        │
│     - Book title, author, subject                               │
│     - Class level (from filename)                               │
│     - Board (NCERT/RD Sharma/etc.)                              │
│     ↓                                                            │
│  6. Build Chapter Structure                                     │
│     - Parse TOC (toc.ncx or nav.xhtml)                          │
│     - Map chapter names to HTML files                           │
│     - Identify chapter numbers and titles                       │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│              STAGE 3: CHAPTER TEXT EXTRACTION                    │
├─────────────────────────────────────────────────────────────────┤
│  7. For Each Chapter HTML File:                                 │
│     ↓                                                            │
│  8. Clean HTML → Plain Text                                     │
│     - Remove navigation, headers, footers                       │
│     - Preserve mathematical notation (MathML/LaTeX)             │
│     - Extract image references                                  │
│     ↓                                                            │
│  9. Detect Exercise/Question Sections                           │
│     - Pattern matching: "Exercise 1.1", "Practice Questions"    │
│     - "Miscellaneous Exercise", "Chapter Test"                  │
│     - "Very Short Answer", "Short Answer", "Long Answer"        │
│     - "MCQs", "True/False", "Fill in the blanks"                │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│           STAGE 4: QUESTION DETECTION & EXTRACTION               │
├─────────────────────────────────────────────────────────────────┤
│ 10. Pattern-Based Question Detection                            │
│     - Regex: "Q\\.?\\s*\\d+", "\\d+\\.", "Question \\d+"        │
│     - Numbered lists: "1.", "2.", etc.                          │
│     ↓                                                            │
│ 11. Extract Question Components                                 │
│     - Question text (preserve LaTeX)                            │
│     - Options for MCQs (a), (b), (c), (d)                       │
│     - Detect question type (MCQ, short, long, etc.)             │
│     - Extract linked diagrams/images                            │
│     ↓                                                            │
│ 12. Image Processing (if diagrams present)                      │
│     - Upload images to Firebase Storage                         │
│     - Get public URLs                                           │
│     - Link to questions                                         │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│              STAGE 5: AI ENHANCEMENT (OPTIONAL)                  │
├─────────────────────────────────────────────────────────────────┤
│ 13. AI Processing via Google Vertex AI Gemini                   │
│     - Enhance LaTeX formatting                                  │
│     - Validate question structure                               │
│     - Classify difficulty (easy/medium/hard)                    │
│     - Generate explanation hints                                │
│     - Detect correct answers from answer keys                   │
│     ↓                                                            │
│ 14. Batch AI Requests (10-20 questions per call)                │
│     - Use exact same prompt as Smart Import                     │
│     - Model: gemini-2.5-pro or gemini-2.5-flash                 │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│           STAGE 6: NORMALIZATION & VALIDATION                    │
├─────────────────────────────────────────────────────────────────┤
│ 15. Apply Metadata Schema (FLAT STRUCTURE - all at root level) │
│     - text: Sanitized question text with LaTeX                  │
│     - type: Detected question type                              │
│     - options: Array with isCorrect flags (for MCQ)             │
│     - subject: Mathematics/Physics/Chemistry (REQUIRED)         │
│     - topic: Chapter title or section (REQUIRED)                │
│     - chapter: From TOC (REQUIRED)                              │
│     - board: CBSE/NCERT/JEE/NEET (REQUIRED)                     │
│     - class: Extract from folder/filename (Class 11, 12)        │
│     - section: Exercise 1.1, MCQs, Objective, etc.              │
│     - difficulty: From AI or default "medium"                   │
│     - marks: Based on question type (1, 2, 4, 5)                │
│     - source: "Smart Import" (REQUIRED)                         │
│     - isActive: true (REQUIRED)                                 │
│     - createdBy: Admin user ObjectId (REQUIRED)                 │
│     ↓                                                            │
│ 16. Validation Rules (Same as questionValidationService.ts)     │
│     - Sanitize text (trim, normalize whitespace)                │
│     - Convert to LaTeX notation                                 │
│     - Validate MCQ options (3-6 options)                        │
│     - Ensure required fields present                            │
│     - Remove duplicates                                         │
│     - Validate question types                                   │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                  STAGE 7: MONGODB PERSISTENCE                    │
├─────────────────────────────────────────────────────────────────┤
│ 17. Create ImportBatch Record                                   │
│     - fileName, fileType: "epub"                                │
│     - status: "processing" → "completed"                        │
│     - totalQuestions, processedQuestions                        │
│     - ocrProvider: "epub-parser"                                │
│     - processingModel: "gemini-2.5-pro"                         │
│     ↓                                                            │
│ 18. Save to ImportedQuestion Collection                         │
│     - All extracted questions with metadata                     │
│     - status: "extracted"                                       │
│     - confidence: 0.95 (EPUB is structured)                     │
│     - needsReview: false (for NCERT official books)             │
│     ↓                                                            │
│ 19. Bulk Insert to Question Collection                          │
│     - Convert ImportedQuestion → Question                       │
│     - Apply all metadata fields                                 │
│     - Set isActive: true                                        │
│     - Link createdBy to system admin user                       │
│     ↓                                                            │
│ 20. Update Import Aggregates                                    │
│     - Group by subject/topic                                    │
│     - Update questionCount                                      │
│     - Add questionIds to array                                  │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                  STAGE 8: POST-PROCESSING & SUPERVISION          │
├─────────────────────────────────────────────────────────────────┤
│ 21. Save Processing Statistics                                  │
│     - Total questions extracted                                 │
│     - Questions with diagrams                                   │
│     - Questions with correct answers                            │
│     - Questions with options (MCQ)                              │
│     - Import success rate                                       │
│     - Processing time                                           │
│     ↓                                                            │
│ 22. Logging & Notifications                                     │
│     - Log to MongoDB: processing stats                          │
│     - Send notification to admin                                │
│     - Update dashboard metrics (viewable via API)               │
│     ↓                                                            │
│ 23. Cleanup                                                     │
│     - Remove temporary extracted files                          │
│     - Archive processed EPUBs (optional)                        │
│     - Update processing status                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🛠 Prerequisites & Setup

### **1. n8n Installation**
```bash
# Option A: Docker (Recommended)
docker run -it --rm \
  --name n8n \
  -p 5678:5678 \
  -e N8N_BASIC_AUTH_ACTIVE=true \
  -e N8N_BASIC_AUTH_USER=admin \
  -e N8N_BASIC_AUTH_PASSWORD=yourpassword \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n

# Option B: npm
npm install -g n8n
n8n start

# Access n8n at http://localhost:5678
```

### **2. Required n8n Nodes/Integrations**
- **Core Nodes:**
  - Cron (Schedule trigger)
  - File System (Read EPUB files)
  - MongoDB (Database operations)
  - HTTP Request (API calls to backend)
  - Function/Code (JavaScript processing)
  - If/Switch (Conditional logic)
  - Loop Over Items (Batch processing)
  
- **Custom Nodes to Install:**
  - n8n-nodes-zip (EPUB unzipping)
  - n8n-nodes-xml (Parse XML/HTML)
  - n8n-nodes-google-cloud (Vertex AI integration)

### **3. Environment Variables (.env)**
```env
# MongoDB Connection
MONGODB_URI=mongodb://localhost:27017/cbt-exam

# Google Cloud (Vertex AI & Vision)
GOOGLE_CLOUD_PROJECT=cbt-vision-api
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_APPLICATION_CREDENTIALS=/path/to/vision-key.json

# Firebase Storage
FIREBASE_STORAGE_BUCKET=your-bucket.appspot.com

# Backend API
BACKEND_API_URL=http://localhost:5000
BACKEND_API_KEY=your-secure-api-key

# n8n Configuration
N8N_HOST=0.0.0.0
N8N_PORT=5678
N8N_PROTOCOL=http
WEBHOOK_URL=http://localhost:5678

# Processing Settings
MAX_QUESTIONS_PER_BATCH=50
AI_MODEL=gemini-2.5-pro
ADMIN_USER_ID=your-admin-mongodb-objectid
```

### **4. Node.js Dependencies (for Custom Functions)**
Create a package.json in your n8n custom scripts folder:
```json
{
  "dependencies": {
    "jszip": "^3.10.1",
    "xml2js": "^0.6.2",
    "cheerio": "^1.0.0-rc.12",
    "axios": "^1.6.0",
    "mongodb": "^6.0.0",
    "katex": "^0.16.9",
    "mathml-to-latex": "^1.3.0"
  }
}
```

### **5. MongoDB Indexes (Already exist, but verify)**
```javascript
// Run in MongoDB shell
use cbt-exam;

// Questions collection
db.questions.createIndex({ "metadata.class": 1, "tags.subject": 1, "metadata.board": 1 });
db.questions.createIndex({ "metadata.chapter": 1, "tags.subject": 1 });
db.questions.createIndex({ text: "text" });

// ImportedQuestion collection
db.importedquestions.createIndex({ importBatch: 1, status: 1 });
db.importedquestions.createIndex({ subject: 1, topic: 1 });
```

### **6. Backend API Endpoint (Create this)**
Create a new endpoint to receive questions from n8n:
```typescript
// File: src/routes/api/automation.ts
import { Router } from 'express';
import { verifyApiKey } from '../../middlewares/authMiddleware';
import { bulkImportQuestions } from '../../controllers/automationController';

const router = Router();

// POST /api/automation/bulk-import-questions
router.post('/bulk-import-questions', verifyApiKey, bulkImportQuestions);

export default router;
```

### **7. Firebase Storage Setup**
```bash
# Ensure Firebase Storage CORS is configured
gsutil cors set firebase.storage.cors.json gs://your-bucket.appspot.com
```

---

## 📦 EPUB Structure Understanding

### **Typical NCERT EPUB Structure:**
```
Book.epub (ZIP file)
├── META-INF/
│   └── container.xml          # Points to content.opf
├── OEBPS/                     # Main content folder
│   ├── content.opf            # Book metadata & manifest
│   ├── toc.ncx                # Table of Contents
│   ├── Text/
│   │   ├── Chapter01.xhtml    # Chapter content
│   │   ├── Chapter02.xhtml
│   │   └── ...
│   ├── Images/                # Diagrams, figures
│   │   ├── img001.jpg
│   │   ├── img002.png
│   │   └── ...
│   └── Styles/
│       └── stylesheet.css
└── mimetype                   # "application/epub+zip"
```

### **Key Files to Parse:**

#### **content.opf (Book Metadata)**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata>
    <dc:title>Mathematics Class XI - R.D. Sharma</dc:title>
    <dc:creator>R.D. Sharma</dc:creator>
    <dc:subject>Mathematics</dc:subject>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="Text/Chapter01.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="Images/img001.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>
```

#### **toc.ncx (Chapter Navigation)**
```xml
<navMap>
  <navPoint id="ch1" playOrder="1">
    <navLabel><text>Chapter 1: Sets</text></navLabel>
    <content src="Text/Chapter01.xhtml"/>
  </navPoint>
  <navPoint id="ch1ex1" playOrder="2">
    <navLabel><text>Exercise 1.1</text></navLabel>
    <content src="Text/Chapter01.xhtml#ex1_1"/>
  </navPoint>
</navMap>
```

#### **Chapter01.xhtml (Content with Questions)**
```html
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <h1>Chapter 1: Sets</h1>
  <p>Introduction to sets...</p>
  
  <h2 id="ex1_1">Exercise 1.1</h2>
  
  <div class="question">
    <p><strong>Q1.</strong> Write the following sets in roster form:</p>
    <p>(a) A = {x : x is an integer and –3 ≤ x &lt; 7}</p>
  </div>
  
  <div class="question">
    <p><strong>Q2.</strong> Which of the following are sets?</p>
    <ol type="a">
      <li>The collection of all months of a year beginning with the letter J.</li>
      <li>The collection of ten most talented writers of India.</li>
    </ol>
  </div>
  
  <div class="mcq">
    <p><strong>Q3.</strong> If A = {1, 2, 3}, B = {3, 4}, then A ∪ B is:</p>
    <ol type="a">
      <li>{1, 2, 3, 4}</li>
      <li>{3}</li>
      <li>{1, 2, 4}</li>
      <li>None of these</li>
    </ol>
  </div>
</body>
</html>
```

---

## 🤖 AI Enhancement Strategy

### **When to Use AI (Vertex AI Gemini):**
1. **LaTeX Conversion** - Convert mathematical notation to LaTeX
2. **Question Type Detection** - Classify question types accurately
3. **Difficulty Assessment** - Assign easy/medium/hard based on complexity
4. **Answer Extraction** - Parse answer keys when available
5. **Explanation Generation** - Generate hints (optional)

### **When NOT to Use AI:**
1. **Basic Text Extraction** - EPUB HTML is already structured
2. **Metadata** - Class, chapter, section are in file structure
3. **Question Numbering** - Already present in HTML
4. **MCQ Options** - Clearly marked in HTML

### **Optimization: Hybrid Approach**
```
Rule-Based (Fast) → AI Enhancement (Accurate)

Step 1: Extract 90% using EPUB structure parsing (no AI cost)
Step 2: Enhance 10% (LaTeX, difficulty) using AI (minimal cost)
```

---

## ⚡ Performance Optimizations

### **1. Parallel Processing**
```javascript
// In n8n Function Node
const books = $input.all();
const batchSize = 3; // Process 3 books in parallel

const batches = [];
for (let i = 0; i < books.length; i += batchSize) {
  batches.push(books.slice(i, i + batchSize));
}

return batches.map(batch => ({ json: { books: batch } }));
```

### **2. Question Batching**
```javascript
// Process 50 questions at a time
const BATCH_SIZE = 50;
const questionBatches = [];

for (let i = 0; i < allQuestions.length; i += BATCH_SIZE) {
  questionBatches.push(allQuestions.slice(i, i + BATCH_SIZE));
}
```

### **3. Caching Strategy**
```javascript
// Cache processed books in MongoDB
const ProcessedBooks = {
  fileName: string,
  checksum: string, // MD5 hash of EPUB
  processedAt: Date,
  questionCount: number,
  status: 'completed' | 'failed'
}

// Skip if already processed and checksum matches
```

### **4. Incremental Processing**
```javascript
// Only process new chapters or updated exercises
const existingQuestions = await Question.find({
  'metadata.class': 'Class 11',
  'tags.subject': 'Mathematics',
  'metadata.chapter': 'Sets'
});

// Skip chapter if questions already exist
if (existingQuestions.length > 0) {
  console.log('Chapter already processed, skipping...');
  return;
}
```

---

## 🎨 Smart Features & Intelligence

### **1. Auto-Detect Question Type**
```javascript
function detectQuestionType(questionText, hasOptions) {
  // MCQ Detection
  if (hasOptions && options.length >= 3) {
    return 'mcq';
  }
  
  // True/False Detection
  if (questionText.match(/true|false|correct|incorrect/i) && hasOptions && options.length === 2) {
    return 'truefalse';
  }
  
  // Fill in the blanks
  if (questionText.includes('_____') || questionText.match(/fill.*blank/i)) {
    return 'fill';
  }
  
  // Integer type (JEE/NEET)
  if (questionText.match(/integer|numerical.*value/i)) {
    return 'integer';
  }
  
  // Assertion-Reason
  if (questionText.match(/assertion.*reason|statement.*[12]/i)) {
    return 'assertionreason';
  }
  
  // Short vs Long Answer (based on marks or keywords)
  if (questionText.match(/brief|one.*word|short/i) || marks <= 2) {
    return 'short';
  }
  
  if (questionText.match(/explain|describe|derive|prove|discuss/i) || marks >= 5) {
    return 'long';
  }
  
  return 'short'; // Default
}
```

### **2. Auto-Assign Difficulty**
```javascript
function assessDifficulty(question) {
  let score = 0;
  
  // Length-based
  if (question.text.length > 200) score += 1;
  if (question.text.length > 400) score += 1;
  
  // Keyword-based
  const hardKeywords = ['prove', 'derive', 'justify', 'analyze', 'evaluate'];
  const mediumKeywords = ['explain', 'describe', 'calculate', 'find'];
  
  if (hardKeywords.some(kw => question.text.toLowerCase().includes(kw))) {
    score += 2;
  } else if (mediumKeywords.some(kw => question.text.toLowerCase().includes(kw))) {
    score += 1;
  }
  
  // LaTeX complexity
  const latexCount = (question.text.match(/\$/g) || []).length / 2;
  if (latexCount > 5) score += 1;
  
  // MCQ with many options
  if (question.type === 'mcq' && question.options.length > 4) {
    score += 1;
  }
  
  if (score >= 3) return 'hard';
  if (score >= 1) return 'medium';
  return 'easy';
}
```

### **3. Auto-Extract Marks**
```javascript
function extractMarks(sectionName, questionType) {
  // From section name: "5 Marks Questions", "Very Short Answer (1 mark)"
  const markMatch = sectionName.match(/(\d+)\s*mark/i);
  if (markMatch) {
    return parseInt(markMatch[1]);
  }
  
  // Default marks by type and section
  const markDefaults = {
    'mcq': 1,
    'truefalse': 1,
    'fill': 1,
    'short': 2,
    'long': 5,
    'integer': 4,
    'assertionreason': 1
  };
  
  return markDefaults[questionType] || 1;
}
```

### **4. Duplicate Detection**
```javascript
async function checkDuplicate(question) {
  // Generate fingerprint
  const fingerprint = question.text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 100);
  
  // Check in database
  const existing = await Question.findOne({
    'tags.subject': question.subject,
    'metadata.chapter': question.chapter,
    text: { $regex: new RegExp(fingerprint.slice(0, 50), 'i') }
  });
  
  return !!existing;
}
```

### **5. Image Reference Mapping**
```javascript
function mapImageReferences(questionHTML, imageManifest) {
  const imgRegex = /<img[^>]+src="([^"]+)"/g;
  const matches = [...questionHTML.matchAll(imgRegex)];
  
  return matches.map(match => {
    const relativePath = match[1];
    const imagePath = imageManifest[relativePath];
    
    return {
      originalSrc: relativePath,
      localPath: imagePath,
      uploadUrl: null, // Will be populated after Firebase upload
      alt: extractAltText(match[0])
    };
  });
}
```

---

## 📊 Monitoring & Quality Assurance

### **Dashboard Metrics to Track:**
1. **Processing Stats:**
   - Books processed today/week/month
   - Total questions extracted
   - Processing time per book
   - Success/failure rate

2. **Quality Metrics:**
   - Questions needing review (%)
   - AI confidence scores (avg)
   - Duplicate detection rate
   - LaTeX formatting errors

3. **Coverage:**
   - Classes covered (11, 12)
   - Subjects covered
   - Chapters per subject
   - Questions per chapter

### **Alerts & Notifications:**
```javascript
// n8n Email/Slack notification
const notification = {
  title: "✅ EPUB Processing Complete",
  message: `
    Book: ${bookName}
    Questions Extracted: ${totalQuestions}
    Success Rate: ${successRate}%
    Processing Time: ${processingTime}s
    
    View Questions: ${dashboardUrl}
  `,
  priority: totalQuestions === 0 ? 'high' : 'normal'
};
```

---

## 🚀 Deployment & Scaling

### **Phase 1: Proof of Concept (Week 1-2)**
- Set up n8n locally
- Test with 1-2 EPUBs
- Validate question extraction accuracy
- Test MongoDB insertion

### **Phase 2: Production Setup (Week 3-4)**
- Deploy n8n on VPS/cloud (Digital Ocean, AWS, etc.)
- Set up persistent storage
- Configure CRON schedules
- Implement error handling

### **Phase 3: Optimization (Week 5-6)**
- Add parallel processing
- Implement caching
- Fine-tune AI prompts
- Add quality checks

### **Phase 4: Expansion (Ongoing)**
- Add more book sources
- Support more formats (PDF, DOCX)
- Multi-language support
- Advanced AI features

---

## 💰 Cost Estimation

### **Google Cloud AI (Vertex AI Gemini)**
- **Model:** Gemini 2.5 Flash (cheaper) or Gemini 2.5 Pro (better)
- **Cost per 1M input tokens:** ~$0.30 (Flash) / ~$1.25 (Pro)
- **Cost per 1M output tokens:** ~$1.20 (Flash) / ~$5.00 (Pro)

**Estimated per book (500 pages, 2000 questions):**
- Input: ~500K tokens → $0.15 (Flash) / $0.63 (Pro)
- Output: ~200K tokens → $0.24 (Flash) / $1.00 (Pro)
- **Total: ~$0.40 to $1.63 per book**

**For 100 books:**
- Using Flash: ~$40
- Using Pro: ~$163

**Optimization:** Use Rule-Based for 80% → AI for 20% = **$8-$32 per 100 books**

### **Infrastructure**
- n8n Cloud: $50/month (managed)
- n8n Self-Hosted: $10-20/month (VPS)
- MongoDB Atlas: Free tier or $57/month (M10)
- Firebase Storage: First 5GB free

**Total Monthly Cost: $60-130/month**

---

## 🎯 Success Criteria

### **Accuracy Targets:**
- ✅ Question extraction: 95%+ accuracy
- ✅ LaTeX formatting: 90%+ correct
- ✅ Metadata mapping: 98%+ correct
- ✅ Duplicate detection: 99%+ accuracy

### **Performance Targets:**
- ✅ Process 1 EPUB (500 pages): < 10 minutes
- ✅ Extract 100 questions: < 2 minutes
- ✅ Zero manual intervention for NCERT books
- ✅ 95% questions usable without review

---

## 📝 Next Steps

### **Immediate Actions:**
1. ✅ Review and approve this implementation plan
2. ⬜ Set up n8n (Docker or npm)
3. ⬜ Create sample EPUB extraction script
4. ⬜ Test with 1 chapter from RD Sharma
5. ⬜ Validate output against existing Smart Import

### **Week 1 Tasks:**
1. Install n8n and required dependencies
2. Create EPUB unzip and parse workflow
3. Implement basic question detection (regex)
4. Test MongoDB insertion
5. Create backend API endpoint for bulk import

### **Week 2 Tasks:**
1. Integrate Vertex AI Gemini for LaTeX
2. Implement metadata extraction
3. Add image upload to Firebase
4. Test end-to-end with 1 complete book
5. Set up error handling and logging

### **Week 3 Tasks:**
1. Add CRON scheduling
2. Implement duplicate detection
3. Add quality checks and validation
4. Create admin dashboard for monitoring
5. Deploy to production

---

## 📚 Additional Resources

### **EPUB Parsing Libraries:**
- **JavaScript:** `epub-parser`, `epub.js`
- **Python:** `ebooklib`, `epubcheck`
- **Online Tools:** Calibre (EPUB editor)

### **n8n Resources:**
- Documentation: https://docs.n8n.io
- Community: https://community.n8n.io
- Templates: https://n8n.io/workflows

### **Testing EPUB Structure:**
```bash
# Unzip EPUB manually to inspect
unzip "Mathematics Class XI - R.D. Sharma.epub" -d rd_sharma_extracted
cd rd_sharma_extracted/OEBPS
ls -la Text/  # View chapter files
cat content.opf  # View metadata
cat toc.ncx  # View table of contents
```

---

## ⚠️ Important Considerations

1. **Copyright & Legal:**
   - Ensure you have rights to process these books
   - NCERT books are typically freely available for educational use
   - RD Sharma and other private publishers may have restrictions

2. **Data Quality:**
   - EPUB quality varies by publisher
   - Some books may have poor HTML structure
   - Images may be low resolution
   - Mathematical notation may be in MathML or images

3. **Maintenance:**
   - Book formats may change
   - Need to update parsers periodically
   - Monitor AI model performance
   - Keep n8n updated

4. **Scalability:**
   - Start with 10-20 books
   - Monitor performance and costs
   - Scale gradually based on results

---

## 🎉 Expected Outcomes

After full implementation, you will have:

✅ **Automated system** that processes EPUB books daily without manual intervention

✅ **10,000+ questions** extracted from NCERT/RD Sharma books in Class 11 & 12

✅ **Rich metadata** for every question (class, board, chapter, section, difficulty, marks)

✅ **LaTeX-formatted** questions ready for PDF generation

✅ **Searchable database** with proper indexing for paper creation

✅ **95%+ accuracy** matching or exceeding current Smart Import quality

✅ **Cost-effective** operation at <$100/month for processing 100+ books

✅ **Scalable foundation** for adding more books, subjects, and formats

---

**Ready to proceed?** Let me know and I can help you with:
1. Setting up the n8n workflow (JSON configuration)
2. Creating the EPUB parser functions
3. Building the backend API endpoint
4. Testing with your first book

---

*Last Updated: January 28, 2026*
*Version: 1.0*
