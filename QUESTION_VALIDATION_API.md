# Question Validation & Filtering API Documentation

## Overview

Enhanced question saving logic with validation, sanitization, LaTeX conversion, and deduplication to support paper creation filtering by class, board, chapter, topic, difficulty, and type.

---

## Enhanced Question Schema

### Metadata Fields Added

```typescript
metadata?: {
  class?: string;        // e.g., "10", "12"
  board?: string;        // e.g., "CBSE", "ICSE", "State Board"
  chapter?: string;      // e.g., "Force and Motion", "Algebra"
  section?: string;      // e.g., "Section A", "Objective"
  marks?: number;        // e.g., 1, 2, 5
  source?: string;       // "AI" | "Smart Import" | "Manual" | "Upload"
}
```

### Database Indexes

- Compound index: `{ 'metadata.class': 1, 'tags.subject': 1, 'metadata.board': 1 }`
- Compound index: `{ 'metadata.chapter': 1, 'tags.subject': 1 }`
- Compound index: `{ 'tags.subject': 1, 'tags.topic': 1, 'tags.difficulty': 1 }`

---

## Validation Service Features

### 1. Sanitization

- Trims whitespace from all text fields
- Removes stray HTML tags (`<p>`, `<br>`, etc.)
- Normalizes punctuation (removes extra spaces before punctuation)
- Capitalizes first letter of sentences
- Deduplicates options in MCQ/True-False questions

### 2. LaTeX Conversion

Automatically converts common math notation to LaTeX:

- Superscripts: `x^2` → `$x^{2}$`
- Subscripts: `H_2O` → `$H_{2}O$`
- Fractions: `1/2` → `$\frac{1}{2}$`
- Greek letters: `alpha`, `beta`, `theta` → `$\alpha$`, `$\beta$`, `$\theta$`
- Symbols: `infinity`, `sqrt`, `sum`, `integral` → `$\infty$`, `$\sqrt{}$`, etc.

**Preserves existing LaTeX:** Won't double-wrap already formatted equations

### 3. Validation Rules

- **Required fields:** `question_type`, `question_text`, `subject`
- **MCQ/True-False:** At least 2 options required
- **Integer/Fill in Blanks:** `correct_answer` required
- **All types:** `subject` must be non-empty

### 4. Deduplication

Checks for existing questions with:

- Identical `question_text` (case-insensitive, normalized)
- Same `subject`
- Same `chapter` OR `topic`
- Same `board`

**Returns:** `{ isDuplicate: boolean, existingQuestion?: IQuestion }`

---

## API Endpoints

### 1. Get Topics with Chapters (Enhanced)

**GET** `/api/exam/questions/topics`

**Query Parameters:**

```typescript
{
  subject: string;       // Required
  class?: string;        // Optional: Filter by class
  board?: string;        // Optional: Filter by board
}
```

**Response:**

```typescript
{
  topics: Array<{
    _id: {
      subject: string;
      topic: string;
      chapter: string;
      class: string;
      board: string;
    };
    count: number;
  }>;
}
```

**Example:**

```bash
GET /api/exam/questions/topics?subject=Physics&class=10&board=CBSE
```

---

### 2. Get Questions for Paper Creation (NEW)

**GET** `/api/exam/questions/for-paper`

**Query Parameters:**

```typescript
{
  subject: string;          // Required
  class?: string;           // Optional
  board?: string;           // Optional
  chapter?: string;         // Optional
  topic?: string;           // Optional
  type?: string;            // Optional: mcq, truefalse, fill, short, long, etc.
  difficulty?: string;      // Optional: easy, medium, hard
  page?: number;            // Optional: Default 1
  limit?: number;           // Optional: Default 20
}
```

**Response:**

```typescript
{
  questions: IQuestion[];   // Array of question objects
  total: number;            // Total count matching filters
  page: number;             // Current page
  limit: number;            // Items per page
}
```

**Example:**

```bash
GET /api/exam/questions/for-paper?subject=Physics&class=10&board=CBSE&chapter=Force%20and%20Motion&difficulty=medium&page=1&limit=20
```

---

## AI Generation Updates

All AI generation endpoints now use the validation pipeline:

### 1. Generate from PDF

**POST** `/api/ai/generate-from-pdf`

**Body (multipart/form-data):**

```typescript
{
  file: File;              // PDF file
  subject: string;
  class?: string;          // NEW
  board?: string;          // NEW
  chapter?: string;        // NEW
  section?: string;        // NEW
  marks?: number;          // NEW
  topic?: string;
  difficulty?: string;
}
```

**Response:**

```typescript
{
  items: IQuestion[];      // Saved questions
  total: number;           // Successfully saved count
  skipped: number;         // Duplicates skipped
  metadata: { subject, class, board, chapter, section, marks }
}
```

---

### 2. Generate from Image

**POST** `/api/ai/generate-from-image`

**Body (multipart/form-data):**

```typescript
{
  file: File;              // Image file
  subject: string;
  class?: string;          // NEW
  board?: string;          // NEW
  chapter?: string;        // NEW
  section?: string;        // NEW
  marks?: number;          // NEW
  topic?: string;
  difficulty?: string;
}
```

**Response:** Same as PDF generation

---

### 3. Generate from Text

**POST** `/api/ai/generate-from-text`

**Body (JSON):**

```typescript
{
  text: string;
  subject: string;
  class?: string;          // NEW
  board?: string;          // NEW
  chapter?: string;        // NEW
  section?: string;        // NEW
  marks?: number;          // NEW
  topic?: string;
  difficulty?: string;
}
```

**Response:** Same as PDF generation

---

## Integration Guide for Frontend

### Step 1: Update Paper Creation Flow

#### PaperBasicInfo Component

Collect and store:

```typescript
const [basicInfo, setBasicInfo] = useState({
  title: '',
  subject: '',
  class: '', // Required for filtering
  totalMarks: 0,
  duration: 0,
});
```

#### PaperBoardSelection Component

Add board selection:

```typescript
const [selectedBoard, setSelectedBoard] = useState('');
```

#### PaperChapterSelection Component

Update API call to include class and board:

```typescript
const fetchTopics = async () => {
  const params = new URLSearchParams({
    subject: basicInfo.subject,
    class: basicInfo.class,
    board: selectedBoard,
  });

  const response = await fetch(`/api/exam/questions/topics?${params}`);
  const data = await response.json();

  // Group by chapter
  const chapterMap = data.topics.reduce((acc, item) => {
    const chapter = item._id.chapter || 'Uncategorized';
    if (!acc[chapter]) {
      acc[chapter] = { chapter, topics: [], count: 0 };
    }
    acc[chapter].topics.push(item._id.topic);
    acc[chapter].count += item.count;
    return acc;
  }, {});

  setChapters(Object.values(chapterMap));
};
```

#### PaperQuestionSelection Component

Fetch filtered questions:

```typescript
const fetchQuestions = async (filters: {
  chapter?: string;
  topic?: string;
  difficulty?: string;
  type?: string;
}) => {
  const params = new URLSearchParams({
    subject: basicInfo.subject,
    class: basicInfo.class,
    board: selectedBoard,
    ...filters,
    page: currentPage.toString(),
    limit: '20',
  });

  const response = await fetch(`/api/exam/questions/for-paper?${params}`);
  const data = await response.json();

  setQuestions(data.questions);
  setTotalQuestions(data.total);
};
```

---

## Validation Pipeline Flow

```
User Input (AI/Import/Manual)
        ↓
[1. Sanitize Text]
  - Trim whitespace
  - Remove HTML tags
  - Normalize punctuation
  - Capitalize sentences
        ↓
[2. Convert to LaTeX]
  - Detect math patterns
  - Wrap in $ delimiters
  - Preserve existing LaTeX
        ↓
[3. Validate Schema]
  - Check required fields
  - Type-specific validation
  - Ensure data integrity
        ↓
[4. Check Duplicates]
  - Query: text + subject + chapter/topic + board
  - Skip if exact match found
        ↓
[5. Save to Database]
  - Store with metadata
  - Return saved question
```

---

## Testing Checklist

### Backend Tests

- [ ] Generate questions via AI (PDF, image, text)
- [ ] Verify metadata fields saved correctly
- [ ] Test LaTeX conversion (check equations in question_text)
- [ ] Verify deduplication (try uploading same question twice)
- [ ] Test `/questions/topics` with class/board filters
- [ ] Test `/questions/for-paper` with all filter combinations
- [ ] Verify pagination works correctly

### Frontend Tests

- [ ] Create paper flow captures class and board
- [ ] Chapter selection shows filtered topics
- [ ] Question selection shows filtered questions
- [ ] LaTeX equations render properly
- [ ] Pagination controls work
- [ ] Filter dropdowns update question list

---

## Migration Notes

### Existing Questions

Old questions without metadata will still work but won't appear in filtered queries until updated.

**To update existing questions:**

```typescript
// Option 1: Bulk update via script
await Question.updateMany(
  { 'metadata.class': { $exists: false } },
  { $set: { metadata: { source: 'Legacy' } } },
);

// Option 2: Update individually when editing
```

### Smart Import Service

**TODO:** Update `questionImportService.ts` to use validation pipeline:

```typescript
import {
  saveBatchValidatedQuestions,
  EnhancedQuestionData,
} from '../services/questionValidationService';

// In saveQuestions method (line 581):
const enhancedQuestions: EnhancedQuestionData[] = extractedQuestions.map(
  (q) => ({
    ...q,
    class: metadata.class,
    board: metadata.board,
    chapter: metadata.chapter,
    section: metadata.section,
    marks: metadata.marks,
    source: 'Smart Import',
  }),
);

const result = await saveBatchValidatedQuestions(enhancedQuestions);
// Returns: { saved: IQuestion[], skipped: number }
```

---

## Performance Considerations

### Indexes

Three compound indexes ensure fast filtering:

1. Class + Subject + Board (primary filter)
2. Chapter + Subject (topic grouping)
3. Subject + Topic + Difficulty (question selection)

### Pagination

Always use pagination for question fetching:

- Default: 20 items per page
- Max recommended: 50 items per page
- Total count provided for UI pagination

### LaTeX Conversion

- Runs on each question during save (one-time cost)
- Cached in database after conversion
- No runtime conversion needed

---

## Error Handling

### Validation Errors

```typescript
{
  error: 'Validation failed',
  details: {
    field: 'options',
    message: 'MCQ questions must have at least 2 options'
  }
}
```

### Duplicate Detection

```typescript
{
  isDuplicate: true,
  existingQuestion: { _id, question_text, subject, chapter }
}
```

### Missing Parameters

```typescript
{
  error: 'Missing required parameter: subject';
}
```

---

## Support

For issues or questions:

1. Check validation service logs: `questionValidationService.ts`
2. Verify metadata fields in database
3. Test API endpoints with Postman
4. Review frontend API calls in Network tab

**Last Updated:** Based on IMPLEMENTATION_SUMMARY.md context
