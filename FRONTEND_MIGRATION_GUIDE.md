# Frontend Migration Guide - New Validation Endpoints

## Overview

This guide documents the migration from old direct question saving to new validation endpoints with metadata support.

---

## Changes Required

### 1. TeacherAITools Component

#### Old Endpoint (Direct Save):

```typescript
POST / api / exams / questions;
Body: {
  (text, type, tags, options, explanation, diagramUrl);
}
```

#### New Endpoint (With Validation):

```typescript
POST /api/ai/save-questions
Body: {
  questions: [{
    text, type, subject, topic, difficulty,
    class, board, chapter, section, marks,
    source: 'Manual',
    options, explanation, diagramUrl
  }]
}
```

#### Benefits:

- ✅ Automatic LaTeX conversion
- ✅ Text sanitization
- ✅ Deduplication
- ✅ Metadata support (class, board, chapter)
- ✅ Consistent validation across all sources

---

### 2. SmartQuestionImport Component

#### Changes Made:

- ✅ Added metadata fields: class, board, chapter, section, marks
- ✅ Updated UI with emerald green theme
- ✅ Passes metadata to `/api/import-paper` endpoint
- ✅ Backend now uses `saveBatchValidatedQuestions`

#### New Form Fields:

```tsx
<input value={className} onChange={(e) => setClassName(e.target.value)} />
<input value={board} onChange={(e) => setBoard(e.target.value)} />
<input value={chapter} onChange={(e) => setChapter(e.target.value)} />
<input value={section} onChange={(e) => setSection(e.target.value)} />
<input value={marks} onChange={(e) => setMarks(e.target.value)} type="number" />
```

---

### 3. PaperQuestionSelection Component

#### Changes Made:

- ✅ Updated to emerald green theme
- ✅ Uses `/api/exam/questions/for-paper` endpoint
- ✅ Multi-chapter fetching support
- ✅ Proper filtering by class, board, chapter

#### Theme Updates:

- Emerald-50/100/200/500/600 for greens
- Green-50/600 for accents
- Border-2 for stronger borders
- Rounded-xl for modern corners

---

## Implementation Steps

### Step 1: Create New Validation Save Endpoint

**Backend:** `src/routes/api/aiRoutes.ts`

```typescript
router.post('/save-questions', authMiddleware, async (req, res) => {
  const { questions } = req.body;
  const userId = (req as any).user.id;

  const enhancedQuestions = questions.map((q) => ({
    ...q,
    createdBy: userId,
    source: q.source || 'Manual',
  }));

  const saved = await saveBatchValidatedQuestions(enhancedQuestions);

  res.json({
    success: true,
    data: {
      saved: saved.length,
      questions: saved,
    },
  });
});
```

### Step 2: Update TeacherAITools

**File:** `src/components/teacher/TeacherAITools.tsx`

Replace `addToBank` function:

```typescript
async function addToBank(indices: number[]) {
  const toAdd = indices.map((i) => items[i]).filter(Boolean);
  if (!toAdd.length) return;

  try {
    // Upload diagrams first
    const questionsWithUrls = await Promise.all(
      toAdd.map(async (q) => {
        let diagramUrl = q.diagramUrl;

        if (q.diagramDataUrl && q.diagramDataUrl.startsWith('data:')) {
          const blob = await (await fetch(q.diagramDataUrl)).blob();
          const form = new FormData();
          form.append(
            'image',
            new File([blob], 'diagram.png', { type: blob.type || 'image/png' }),
          );

          const base =
            process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:5000';
          const resp = await fetch(base + '/api/upload/image', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${localStorage.getItem('accessToken') || ''}`,
            },
            body: form,
          });

          if (resp.ok) {
            const d = await resp.json();
            diagramUrl = d.url;
          }
        }

        return {
          text: q.text,
          type: q.type || 'mcq',
          subject: meta.subject || q.tags?.subject || '',
          topic: meta.topic || q.tags?.topic,
          difficulty: meta.difficulty || q.tags?.difficulty || 'medium',
          // Add metadata fields
          class: meta.class,
          board: meta.board,
          chapter: meta.chapter,
          section: meta.section,
          marks: meta.marks,
          source: 'Manual',
          options: q.options,
          correctAnswerText:
            q.integerAnswer !== undefined ? String(q.integerAnswer) : undefined,
          integerAnswer: q.integerAnswer,
          assertion: q.assertion,
          reason: q.reason,
          assertionIsTrue: q.assertionIsTrue,
          reasonIsTrue: q.reasonIsTrue,
          reasonExplainsAssertion: q.reasonExplainsAssertion,
          explanation: q.explanation,
          diagramUrl,
          diagramAlt: 'Diagram',
        };
      }),
    );

    // Use new validation endpoint
    const result = await apiFetch('/api/ai/save-questions', {
      method: 'POST',
      body: JSON.stringify({ questions: questionsWithUrls }),
    });

    alert(
      `Added ${result.saved}/${toAdd.length} questions to bank with validation`,
    );
  } catch (error) {
    alert(
      'Failed to add questions: ' +
        (error instanceof Error ? error.message : 'Unknown error'),
    );
  }
}
```

### Step 3: Add Metadata Fields to AI Tools

Add to `meta` state:

```typescript
const [meta, setMeta] = useState({
  subject: '',
  topic: '',
  difficulty: 'medium',
  count: 10,
  types: ['mcq', 'truefalse', 'fill', 'short', 'long'],
  // NEW fields
  class: '',
  board: '',
  chapter: '',
  section: '',
  marks: 1,
});
```

Add UI fields before question type selection:

```tsx
<div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
  <div>
    <label className="text-sm font-medium text-emerald-900">Class</label>
    <input
      type="text"
      value={meta.class}
      onChange={(e) => setMeta({ ...meta, class: e.target.value })}
      placeholder="e.g., 10"
      className="w-full px-3 py-2 border-2 border-emerald-200 rounded-xl focus:ring-2 focus:ring-emerald-500"
    />
  </div>

  <div>
    <label className="text-sm font-medium text-emerald-900">Board</label>
    <input
      type="text"
      value={meta.board}
      onChange={(e) => setMeta({ ...meta, board: e.target.value })}
      placeholder="e.g., CBSE"
      className="w-full px-3 py-2 border-2 border-emerald-200 rounded-xl focus:ring-2 focus:ring-emerald-500"
    />
  </div>

  <div>
    <label className="text-sm font-medium text-emerald-900">Chapter</label>
    <input
      type="text"
      value={meta.chapter}
      onChange={(e) => setMeta({ ...meta, chapter: e.target.value })}
      placeholder="e.g., Algebra"
      className="w-full px-3 py-2 border-2 border-emerald-200 rounded-xl focus:ring-2 focus:ring-emerald-500"
    />
  </div>

  <div>
    <label className="text-sm font-medium text-emerald-900">
      Default Marks
    </label>
    <input
      type="number"
      value={meta.marks}
      onChange={(e) =>
        setMeta({ ...meta, marks: parseInt(e.target.value) || 1 })
      }
      placeholder="1"
      className="w-full px-3 py-2 border-2 border-emerald-200 rounded-xl focus:ring-2 focus:ring-emerald-500"
    />
  </div>
</div>
```

---

## Testing Checklist

### Smart Import

- [ ] Upload PDF with all metadata fields filled
- [ ] Verify questions saved with metadata in database
- [ ] Check LaTeX conversion happened
- [ ] Verify deduplication works (upload same file twice)
- [ ] Test with class, board, chapter filters in paper creation

### AI Tools

- [ ] Generate questions from text/PDF/image
- [ ] Add metadata fields (class, board, chapter)
- [ ] Save to question bank
- [ ] Verify validation happened (check database)
- [ ] Verify LaTeX conversion
- [ ] Check deduplication

### Paper Creation

- [ ] Select class and board in steps 1-2
- [ ] Verify filtered chapters appear in step 3
- [ ] Verify questions filtered by metadata in step 4
- [ ] Select questions and create paper

---

## Color Palette - Emerald Green Theme

### Primary Colors:

```css
emerald-50: #f0fdf4   /* Light background */
emerald-100: #dcfce7  /* Hover states */
emerald-200: #bbf7d0  /* Borders */
emerald-300: #86efac  /* Secondary borders */
emerald-400: #4ade80  /* Icons */
emerald-500: #22c55e  /* Primary buttons */
emerald-600: #16a34a  /* Text, hover buttons */
emerald-700: #15803d  /* Dark text */
emerald-800: #166534  /* Darker text */
emerald-900: #14532d  /* Headings */
```

### Accent Colors:

```css
green-50: #f0fdf4    /* Light accents */
green-600: #16a34a   /* Accent buttons */
green-700: #15803d   /* Accent text */
```

### Application:

- **Borders:** `border-2 border-emerald-200`
- **Focus:** `focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500`
- **Buttons:** `bg-gradient-to-r from-emerald-500 to-green-600`
- **Text:** `text-emerald-900` (headings), `text-emerald-700` (body)
- **Backgrounds:** `bg-emerald-50` (light), `bg-emerald-100` (hover)

---

## Benefits Summary

### Consistency ✅

All question sources now use same validation:

- AI Generation (PDF, Image, Text)
- Smart Import
- Manual Entry (AI Tools)

### Data Quality ✅

- Automatic LaTeX conversion
- Text sanitization and normalization
- Duplicate prevention
- Proper metadata structure

### User Experience ✅

- Modern emerald green theme
- Clear visual hierarchy
- Consistent styling across components
- Better form organization

### Functionality ✅

- Rich filtering by class, board, chapter
- Multi-chapter question selection
- Metadata-aware paper creation
- Source tracking (AI vs Manual vs Import)

---

## Migration Completion

### Status:

- ✅ Backend validation service created
- ✅ Smart Import updated
- ✅ PaperQuestionSelection updated
- ⏳ TeacherAITools needs update (in progress)
- ⏳ New save endpoint needs creation

### Next Steps:

1. Create `/api/ai/save-questions` endpoint
2. Update TeacherAITools `addToBank` function
3. Add metadata fields to AI Tools UI
4. Test complete flow end-to-end
5. Update documentation

---

**Last Updated:** Based on current implementation
**Status:** 70% Complete - Backend done, Frontend UI updates in progress
