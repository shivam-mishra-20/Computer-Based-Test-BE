# Quick Testing Guide - Question Validation Integration

## Backend Testing

### 1. Test Smart Import with Metadata

**Using Postman/Thunder Client:**

```http
POST http://localhost:5000/api/import-paper
Authorization: Bearer <your_token>
Content-Type: multipart/form-data

Body (form-data):
- questionPaper: [Select a PDF/Image file]
- subject: Physics
- class: 10
- board: CBSE
- chapter: Force and Motion
- section: Objective
- marks: 1
- ocrProvider: tesseract
- mode: normal
```

**Expected Response:**

```json
{
  "success": true,
  "data": {
    "message": "Question paper processed successfully",
    "batchId": "...",
    "totalQuestions": 25,
    "processedQuestions": 23,
    "processingTime": 45000
  }
}
```

**Verify in Database:**

```javascript
// MongoDB query
db.questions
  .find({
    'metadata.class': '10',
    'metadata.board': 'CBSE',
    'metadata.chapter': 'Force and Motion',
  })
  .pretty();
```

---

### 2. Test Get Topics with Filters

```http
GET http://localhost:5000/api/exam/questions/topics?subject=Physics&class=10&board=CBSE
Authorization: Bearer <your_token>
```

**Expected Response:**

```json
{
  "topics": [
    {
      "_id": {
        "subject": "Physics",
        "topic": "Kinematics",
        "chapter": "Force and Motion",
        "class": "10",
        "board": "CBSE"
      },
      "count": 15
    }
  ]
}
```

---

### 3. Test Get Filtered Questions

```http
GET http://localhost:5000/api/exam/questions/for-paper?subject=Physics&class=10&board=CBSE&chapter=Force+and+Motion&difficulty=medium&type=mcq&page=1&limit=20
Authorization: Bearer <your_token>
```

**Expected Response:**

```json
{
  "questions": [
    {
      "_id": "...",
      "text": "What is the SI unit of force?",
      "type": "mcq",
      "options": [
        { "text": "Newton", "isCorrect": true },
        { "text": "Joule", "isCorrect": false }
      ],
      "tags": {
        "subject": "Physics",
        "topic": "Force and Motion",
        "difficulty": "medium"
      },
      "metadata": {
        "class": "10",
        "board": "CBSE",
        "chapter": "Force and Motion"
      }
    }
  ],
  "total": 45,
  "page": 1,
  "limit": 20
}
```

---

### 4. Verify LaTeX Conversion

**Check if equations were converted:**

```javascript
// MongoDB query
db.questions
  .find({
    text: /\$/, // Find questions with LaTeX delimiters
  })
  .pretty();

// Examples to look for:
// "What is $F = ma$?"  (should have $ delimiters)
// "Calculate $x^{2} + y^{2}$"
// "The formula for water is $H_{2}O$"
```

---

### 5. Test Deduplication

**Upload the same question paper twice:**

1. First upload: Should process all questions
2. Second upload: Should skip duplicate questions

**Check logs:**

```
Smart Import: Saved 23 questions via validation service, skipped 0 duplicates
Smart Import: Saved 0 questions via validation service, skipped 23 duplicates
```

---

## Frontend Testing

### 1. Test Paper Creation Flow

**Step 1: Basic Info**

- Class: `10`
- Subject: `Physics`
- Exam Title: `Mid-Term Exam`
- Total Marks: `100`
- Duration: `3 hours`
- Date: [Select date]

**Step 2: Board Selection**

- Select: `CBSE`

**Step 3: Chapter Selection**

1. Click "Next" - should show loading spinner
2. Verify chapters appear with question counts
3. Select multiple chapters (e.g., "Force and Motion", "Work and Energy")
4. Verify selected count updates

**Step 4: Question Selection**

1. Verify sections appear (Objective, Short Answer, Long Answer)
2. Expand each section
3. Verify questions appear filtered by:
   - Selected chapters
   - Section type (mcq for Objective, short for Short Answer)
4. Select questions from each section
5. Verify total marks calculated correctly

**Step 5: Preview**

- Verify all selected questions appear
- Export PDF

---

### 2. Test Chapter Selection Filtering

**Scenario: Change class or board**

1. Go to Step 1, select Class 11
2. Proceed to Step 3 (Chapter Selection)
3. Verify different chapters appear for Class 11
4. Go back to Step 1, change to Class 10
5. Return to Step 3
6. Verify Class 10 chapters appear

**Scenario: Multiple boards**

1. Select board: CBSE
2. Verify CBSE-specific chapters
3. Go back, select board: GSEB
4. Verify GSEB-specific chapters

---

### 3. Test Question Loading

**Open Browser DevTools → Network Tab:**

1. Go to Step 4 (Question Selection)
2. Look for API calls: `/api/exam/questions/for-paper`
3. Verify query parameters:
   ```
   subject=Physics
   class=10
   board=CBSE
   chapter=Force+and+Motion
   limit=50
   page=1
   ```
4. Check response contains questions array

**Check Console:**

- No errors should appear
- No "Loading chapters..." stuck indefinitely

---

### 4. Test Multi-Chapter Loading

**Scenario: 3 chapters selected**

1. Select chapters: "Kinematics", "Dynamics", "Work and Energy"
2. Go to Step 4
3. Open Network tab
4. Verify 3 API calls made (one per chapter)
5. Verify questions from all 3 chapters appear
6. Search for a question - should work across all chapters

---

### 5. Test LaTeX Rendering

**In Question Selection (Step 4):**

Look for questions with math equations:

- Should see properly formatted equations
- Examples:
  - `F = ma` rendered with proper spacing
  - `x²` as superscript
  - `H₂O` as subscript
  - Fractions displayed properly

**If LaTeX not rendering:**

- Check if KaTeX or MathJax is loaded
- Check browser console for errors

---

## Edge Cases to Test

### Backend Edge Cases

1. **Empty file upload:**
   - Should return error: "No file uploaded"

2. **Invalid file type:**
   - Upload .txt or .docx
   - Should return error: "Invalid file type"

3. **Missing subject:**
   - Don't provide subject parameter
   - Should still process but questions might not be filterable

4. **Very large PDF:**
   - Upload 50+ page PDF
   - Should process but might take time
   - Check timeout settings

5. **No questions found:**
   - Upload blank PDF
   - Should return: `totalQuestions: 0`

### Frontend Edge Cases

1. **No chapters available:**
   - Select a subject with no questions in DB
   - Should show "No chapters found for [subject]"

2. **No questions available:**
   - Select chapters but no questions exist
   - Each section should show "No questions available for this section"

3. **Back navigation:**
   - Complete all steps
   - Click "Back" multiple times
   - Verify form data persists

4. **Form validation:**
   - Try to proceed without selecting class
   - Should prevent navigation

5. **Rapid clicking:**
   - Click "Next" multiple times rapidly
   - Should not create duplicate API calls

---

## Performance Testing

### Backend Performance

**Load Test:**

```bash
# Using Apache Bench
ab -n 100 -c 10 -H "Authorization: Bearer <token>" \
  "http://localhost:5000/api/exam/questions/for-paper?subject=Physics&class=10&board=CBSE"
```

**Expected:**

- Response time: < 200ms
- No failures
- Consistent response times

### Frontend Performance

**Check React DevTools:**

1. Install React DevTools extension
2. Enable "Highlight updates"
3. Navigate through steps
4. Verify only changed components re-render

**Check Network Performance:**

- Chapter loading: < 500ms
- Question loading per chapter: < 300ms
- Total load time for 3 chapters: < 1 second

---

## Verification Checklist

### Backend ✅

- [ ] Import with metadata succeeds
- [ ] Questions saved with metadata fields
- [ ] LaTeX conversion working
- [ ] Deduplication prevents duplicates
- [ ] Topics API returns filtered results
- [ ] Questions API supports all filters
- [ ] Pagination works correctly
- [ ] Authorization required for all endpoints

### Frontend ✅

- [ ] Class and board captured in Step 1 & 2
- [ ] Chapter selection shows filtered chapters
- [ ] Question selection loads all chapters
- [ ] Section types filter questions correctly
- [ ] Total marks calculated accurately
- [ ] Back/Next navigation works
- [ ] Form data persists across steps
- [ ] LaTeX renders properly
- [ ] No console errors
- [ ] Loading states display correctly

---

## Troubleshooting

### Issue: Chapters not loading

**Check:**

1. Network tab - is API call made?
2. Response - does it contain data?
3. Console - any errors?
4. Database - do questions exist with metadata?

**Fix:**

```typescript
// Verify questions have metadata
db.questions
  .find({
    'tags.subject': 'Physics',
    'metadata.class': { $exists: true },
  })
  .count();
```

---

### Issue: Questions not appearing

**Check:**

1. Are chapters selected?
2. Network tab - API calls made?
3. Filters - class/board/chapter match questions in DB?

**Debug:**

```typescript
// Check if questions exist with filters
db.questions
  .find({
    'tags.subject': 'Physics',
    'metadata.class': '10',
    'metadata.board': 'CBSE',
    'metadata.chapter': 'Force and Motion',
  })
  .count();
```

---

### Issue: LaTeX not rendering

**Check:**

1. Question text contains $ delimiters
2. LaTeX library loaded (KaTeX/MathJax)
3. Browser console for errors

**Test:**

```javascript
// Check if LaTeX delimiters exist
db.questions
  .find({
    text: /\$/,
  })
  .limit(5)
  .pretty();
```

---

## Success Criteria

✅ **Backend:**

- Import saves questions with all metadata fields
- LaTeX conversion happens automatically
- Duplicates are skipped
- All filters work correctly
- Response times < 300ms

✅ **Frontend:**

- Paper creation flow completes without errors
- Filtered chapters and questions display
- Multi-chapter selection works
- LaTeX renders properly
- Navigation is smooth

✅ **Integration:**

- End-to-end flow: Import → Filter → Select → Preview works
- No data loss across steps
- Questions filterable by class, board, chapter
- Total marks calculation accurate

---

## Next Steps After Testing

1. **Fix any bugs found**
2. **Optimize slow queries** (add indexes if needed)
3. **Add loading skeletons** for better UX
4. **Implement pagination** for large question sets
5. **Add difficulty/type filters** to question selection UI
6. **Create user documentation**
7. **Deploy to staging** environment
8. **Run UAT** (User Acceptance Testing)

---

**Happy Testing! 🧪**
