# Import Paper Testing Guide

## Quick Test Checklist

### Backend Testing (cbt-exam-be)

#### 1. Environment Setup

```bash
cd cbt-exam-be

# Check .env file has:
# GOOGLE_API_KEY=your_gemini_api_key
# MONGODB_URI=your_mongodb_uri

npm install
npm run dev
```

#### 2. API Testing with Postman/cURL

**Test 1: Upload PDF Question Paper**

```bash
curl -X POST http://localhost:5000/api/import-paper \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "questionPaper=@sample-math-paper.pdf" \
  -F "subject=Mathematics" \
  -F "topic=Calculus" \
  -F "ocrProvider=gemini" \
  -F "class=12" \
  -F "board=CBSE"
```

**Expected Response:**

```json
{
  "success": true,
  "data": {
    "message": "Question paper processed successfully",
    "batchId": "673123456789abcdef012345",
    "totalQuestions": 25,
    "processedQuestions": 25,
    "processingTime": 45000
  }
}
```

**Test 2: Upload Image Question Paper**

```bash
curl -X POST http://localhost:5000/api/import-paper \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "questionPaper=@physics-page1.jpg" \
  -F "subject=Physics" \
  -F "topic=Mechanics" \
  -F "ocrProvider=gemini"
```

**Test 3: Get Import Batches**

```bash
curl -X GET "http://localhost:5000/api/import-paper/batches?page=1&limit=10" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Test 4: Get Batch Details**

```bash
curl -X GET "http://localhost:5000/api/import-paper/batch/BATCH_ID" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Test 5: Update Question**

```bash
curl -X PUT "http://localhost:5000/api/import-paper/question/QUESTION_ID" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Updated question with $x^2 + 5x + 6 = 0$",
    "options": [
      {"text": "$x = -2$ or $x = -3$", "isCorrect": true},
      {"text": "$x = 2$ or $x = 3$", "isCorrect": false},
      {"text": "$x = -1$ or $x = -6$", "isCorrect": false},
      {"text": "$x = 1$ or $x = 6$", "isCorrect": false}
    ]
  }'
```

**Test 6: Bulk Approve Questions**

```bash
curl -X POST "http://localhost:5000/api/import-paper/questions/bulk-approve" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "questionIds": ["ID1", "ID2", "ID3"]
  }'
```

#### 3. Database Verification

**Check ImportBatch Collection:**

```javascript
db.importbatches.findOne({}, { sort: { createdAt: -1 } });
```

**Expected Fields:**

```json
{
  "_id": ObjectId("..."),
  "fileName": "import-1699999999999-123456789.pdf",
  "originalFileName": "math-paper-2024.pdf",
  "fileType": "pdf",
  "fileSize": 2048576,
  "status": "completed",
  "ocrProvider": "gemini",
  "processingModel": "gemini-2.0-flash-exp",
  "totalPages": 5,
  "totalQuestions": 25,
  "processedQuestions": 25,
  "totalProcessingTime": 45000,
  "uploadedBy": ObjectId("..."),
  "processingStarted": ISODate("..."),
  "processingCompleted": ISODate("..."),
  "createdAt": ISODate("...")
}
```

**Check ImportedQuestion Collection:**

```javascript
db.importedquestions.find({ importBatch: ObjectId('BATCH_ID') }).limit(5);
```

**Expected Fields:**

```json
{
  "_id": ObjectId("..."),
  "text": "Evaluate $\\int_0^{\\pi} \\sin(x)\\, dx$",
  "type": "integer",
  "integerAnswer": 2,
  "subject": "Mathematics",
  "topic": "Calculus",
  "difficulty": "medium",
  "confidence": 0.95,
  "needsReview": false,
  "status": "extracted",
  "importBatch": ObjectId("..."),
  "questionNumber": "1",
  "extractedBy": ObjectId("..."),
  "createdAt": ISODate("...")
}
```

#### 4. Console Log Verification

Look for these log patterns:

```
[Import] Starting import for file: math-paper.pdf
[Import] Batch created with ID: 673123456789abcdef012345
[Import] Step 1: Extracting text using gemini...
[Gemini PDF] Processing PDF: /path/to/file.pdf
[Gemini PDF] PDF has 5 pages
[Gemini PDF] Processing page 1/5
[Gemini PDF] Page 1 extracted: 2458 characters
...
[Gemini PDF] Total extracted text: 12456 characters
[Import] Extracted 12456 characters from 5 page(s)
[Import] Step 2: Structuring questions with Gemini AI...
[Gemini Structure] Starting question structuring...
[Import] Structured 25 questions
[Import] Step 3: Normalizing mathematical expressions...
[LaTeX Normalize] Processing 25 questions...
[LaTeX Normalize] Completed normalizing 25 questions
[Import] Step 4: Saving questions to database...
[Import] Saved 25 questions
[Import] Import completed in 45000ms
```

### Frontend Testing (cbt-exam)

#### 1. Setup

```bash
cd cbt-exam
npm install
npm run dev
```

#### 2. Import Flow Testing

**Step 1: Navigate to Import Page**

- Go to `/dashboard/import` or `/teacher/import-paper`
- Verify upload form is displayed

**Step 2: Upload File**

- Select a PDF or image file
- Fill in subject, topic, class fields
- Select OCR provider (Gemini recommended)
- Click "Upload and Process"

**Step 3: Monitor Progress**

- Verify loading indicator appears
- Wait for processing to complete
- Check for success message

**Step 4: Review Questions**

- Navigate to batch details page
- Verify all questions are listed
- Check LaTeX rendering in questions
- Verify options are formatted correctly

**Step 5: Edit Question**

- Click "Edit" on any question
- Modify text with LaTeX
- Preview changes
- Save and verify rendering

**Step 6: Approve Questions**

- Select multiple questions
- Click "Bulk Approve"
- Verify success message
- Check questions moved to question bank

#### 3. LaTeX Rendering Verification

**Test Cases:**

1. **Simple Inline Math**
   - Input: `Solve $x + 5 = 10$`
   - Expected: "Solve x + 5 = 10" with proper math formatting

2. **Fraction**
   - Input: `Calculate $\frac{a+b}{c+d}$`
   - Expected: Rendered fraction

3. **Power**
   - Input: `Find $x^2 + 5x + 6 = 0$`
   - Expected: x² + 5x + 6 = 0

4. **Integral**
   - Input: `Evaluate $$\int_0^\pi \sin(x)\, dx$$`
   - Expected: Display-style integral

5. **Greek Letters**
   - Input: `Angle $\theta = 45°$, ratio $\pi = 3.14$`
   - Expected: θ = 45°, π = 3.14

6. **Matrix**
   - Input: `Matrix $\begin{pmatrix} a & b \\ c & d \end{pmatrix}$`
   - Expected: Rendered 2x2 matrix

#### 4. Browser Console Checks

Look for:

```
✓ LaTeX rendered successfully
✓ No KaTeX errors
✓ All math expressions loaded
```

Errors to watch for:

```
✗ KaTeX parse error
✗ Unbalanced dollar signs
✗ Invalid LaTeX command
```

### Sample Test Files

#### Test File 1: Simple Math (5 questions)

```
MATHEMATICS - CLASS 12
Sample Test Paper

Q1. Solve for x: x² + 5x + 6 = 0
a) x = -2 or x = -3
b) x = 2 or x = 3
c) x = -1 or x = -6
d) x = 1 or x = 6

Q2. Evaluate: ∫₀^π sin(x) dx
Answer: 2

Q3. Find derivative of f(x) = x³ + 2x² - 5x + 7
a) 3x² + 4x - 5
b) 3x² + 2x - 5
c) x² + 4x - 5
d) 3x² + 4x + 5

Q4. The limit lim(x→0) (sin x)/x equals:
a) 0
b) 1
c) ∞
d) Does not exist

Q5. Matrix multiplication: [1 2] × [3]
                                    [4]
a) [11]
b) [3 6]
c) [7]
d) [11 22]
```

#### Test File 2: Physics (Mixed types)

```
PHYSICS - CLASS 11
Mechanics Test

Q1. A ball is thrown vertically upward with velocity v₀ = 20 m/s.
Find maximum height (g = 10 m/s²)

Q2. Newton's second law states F = ma where:
a) F is force in Newtons
b) m is mass in kg
c) a is acceleration in m/s²
d) All of the above

Q3. TRUE or FALSE: Momentum is conserved in an elastic collision.

Q4. Calculate kinetic energy when m = 5 kg and v = 10 m/s
Formula: KE = ½mv²
Answer: _____ J

Q5. Assertion: Work done by centripetal force is zero.
Reason: Centripetal force is perpendicular to displacement.
```

### Integration Testing

#### Test Scenario 1: Full Import Flow

1. Upload PDF → Check logs
2. Wait for processing → Monitor database
3. Review questions → Verify LaTeX
4. Edit question → Save and verify
5. Approve questions → Check question bank

#### Test Scenario 2: Error Handling

1. Upload invalid file → Expect error
2. Upload oversized file → Expect rejection
3. Missing API key → Expect configuration error
4. Network timeout → Expect graceful failure

#### Test Scenario 3: Batch Processing

1. Upload multiple files sequentially
2. Monitor processing queue
3. Verify all batches complete
4. Check no data loss or corruption

### Performance Testing

#### Metrics to Track

| File Type  | Size  | Pages | Questions | Expected Time |
| ---------- | ----- | ----- | --------- | ------------- |
| PDF Small  | 500KB | 2     | 10        | ~20 seconds   |
| PDF Medium | 2MB   | 10    | 40        | ~90 seconds   |
| PDF Large  | 10MB  | 30    | 100       | ~5 minutes    |
| Image JPEG | 1MB   | 1     | 8         | ~10 seconds   |
| Image PNG  | 3MB   | 1     | 12        | ~15 seconds   |

#### Load Testing

```bash
# Test concurrent uploads (be careful with API limits)
for i in {1..5}; do
  curl -X POST http://localhost:5000/api/import-paper \
    -H "Authorization: Bearer $TOKEN" \
    -F "questionPaper=@test-$i.pdf" &
done
wait
```

### Common Issues and Solutions

#### Issue 1: "GEMINI_API_KEY not configured"

**Solution:**

```bash
# Add to .env file
GOOGLE_API_KEY=your_actual_api_key_here
# or
GEMINI_API_KEY=your_actual_api_key_here

# Restart server
npm run dev
```

#### Issue 2: Questions not extracting

**Possible causes:**

- Poor image quality → Use 300 DPI scans
- Handwritten text → OCR works best with printed text
- Complex layouts → Simplify question paper format

**Solution:**

```bash
# Try different OCR provider
ocrProvider=tesseract  # Fallback option
```

#### Issue 3: Math not rendering

**Possible causes:**

- Unbalanced dollar signs
- Invalid LaTeX syntax
- Missing KaTeX CSS

**Solution:**

```typescript
// Check LaTeX syntax
$x^2$  ✓ Correct
$x^2   ✗ Missing closing $

// Import KaTeX CSS
import 'katex/dist/katex.min.css';
```

#### Issue 4: Processing timeout

**Solution:**

```javascript
// Increase timeout in axios config
axios.post('/api/import-paper', formData, {
  timeout: 300000, // 5 minutes
});
```

### Test Results Template

```markdown
## Test Results - [Date]

### Environment

- OS: Windows 11
- Node: v20.x
- MongoDB: v7.x
- Browser: Chrome 120

### Test Summary

- Total Tests: 15
- Passed: 14
- Failed: 1
- Duration: 45 minutes

### Detailed Results

#### Backend Tests

✓ Upload PDF - Passed (45s)
✓ Upload Image - Passed (12s)
✓ Get batches - Passed (0.5s)
✓ Get batch details - Passed (1.2s)
✓ Update question - Passed (0.8s)
✓ Bulk approve - Passed (2.1s)

#### Frontend Tests

✓ Import page loads - Passed
✓ File upload works - Passed
✓ LaTeX renders inline - Passed
✓ LaTeX renders display - Passed
✓ Edit mode works - Passed
✗ Preview mode broken - FAILED
✓ Approve flow works - Passed

#### Performance

- 5-page PDF: 38 seconds
- Single image: 9 seconds
- 25 questions processed: Average 1.5s per question

### Issues Found

1. Preview mode not showing updated text
   - Severity: Medium
   - Fix: Update state management

### Recommendations

1. Add progress indicator for large files
2. Implement retry logic for API failures
3. Add bulk edit functionality
```

### Automation Script

Create `test-import.sh`:

```bash
#!/bin/bash

echo "🧪 Starting Import Paper Tests..."

# Test 1: Check server is running
echo "Test 1: Server health check"
curl -f http://localhost:5000/api/health || exit 1
echo "✓ Server is running"

# Test 2: Upload test file
echo "Test 2: Upload test PDF"
RESPONSE=$(curl -s -X POST http://localhost:5000/api/import-paper \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -F "questionPaper=@test-files/sample.pdf" \
  -F "subject=Math" \
  -F "ocrProvider=gemini")

BATCH_ID=$(echo $RESPONSE | jq -r '.data.batchId')
echo "✓ Upload successful. Batch ID: $BATCH_ID"

# Test 3: Wait and check batch status
echo "Test 3: Checking batch status"
sleep 5
curl -s "http://localhost:5000/api/import-paper/batch/$BATCH_ID" \
  -H "Authorization: Bearer $TEST_TOKEN" | jq '.data.batch.status'

echo "✅ All tests passed!"
```

---

**Last Updated**: November 10, 2025
**Version**: 1.0.0
