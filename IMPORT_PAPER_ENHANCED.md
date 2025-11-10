# Enhanced Import Paper System

## Overview

The import paper functionality has been completely rewritten with Gemini AI integration for maximum accuracy in text extraction and mathematical equation formatting.

## Key Improvements

### 1. **Gemini-Powered Text Extraction**

- **PDF Processing**: Converts each PDF page to high-resolution images (300 DPI) and processes with Gemini Vision API
- **Image Processing**: Direct processing with Gemini 2.0 Flash for accurate OCR
- **Enhanced Accuracy**: Gemini AI understands context and mathematical notation better than traditional OCR

### 2. **LaTeX Mathematical Formatting**

- **Automatic Detection**: Identifies all mathematical expressions in text
- **Comprehensive Coverage**: Supports algebra, calculus, trigonometry, matrices, Greek letters, and more
- **Proper Formatting**: Converts all math to standard LaTeX notation ($...$for inline, $$...$$ for display)
- **Preservation**: Maintains equation format throughout database storage, editing, preview, and display

### 3. **Intelligent Question Structuring**

- **AI-Powered Parsing**: Uses Gemini to intelligently parse questions from extracted text
- **Type Detection**: Automatically identifies MCQ, True/False, Fill-in-blank, Short, Long, Integer, and Assertion-Reason questions
- **Answer Extraction**: Identifies correct answers from answer keys when present
- **Metadata Extraction**: Captures question numbers, marks allocation, difficulty levels

### 4. **Multi-Format Support**

- **PDF Files**: Up to 50 pages with per-page processing
- **Image Files**: JPEG, PNG, GIF, BMP, WebP formats
- **Large Files**: Supports files up to 50MB

## Architecture

### Flow Diagram

```
Upload File
    ↓
Create Import Batch (MongoDB)
    ↓
Extract Text with Gemini Vision API
    ├── PDF: Convert pages → Image → Gemini OCR
    └── Image: Direct Gemini OCR
    ↓
Structure Questions with Gemini AI
    ├── Parse question text
    ├── Detect question type
    ├── Extract options/answers
    ├── Apply LaTeX formatting
    └── Set confidence scores
    ↓
Normalize Math Expressions
    ├── Scan for mathematical content
    ├── Convert to proper LaTeX
    └── Validate formatting
    ↓
Save to ImportedQuestion Collection
    ├── Store with metadata
    ├── Link to import batch
    └── Mark for review if needed
    ↓
Return Success Response
```

## API Endpoints

### Import Question Paper

```http
POST /api/import-paper
Content-Type: multipart/form-data

Fields:
- questionPaper: File (PDF or Image)
- subject: string (optional)
- topic: string (optional)
- ocrProvider: 'gemini' | 'groq' | 'tesseract' (default: 'gemini')
- mode: 'strict' | 'normal' (default: 'normal')
- class: string (optional)
- board: string (optional)
- chapter: string (optional)
- section: string (optional)
- marks: number (optional)

Response:
{
  "success": true,
  "data": {
    "message": "Question paper processed successfully",
    "batchId": "ObjectId",
    "totalQuestions": 25,
    "processedQuestions": 25,
    "processingTime": 45000
  }
}
```

### Get Import Batches

```http
GET /api/import-paper/batches?page=1&limit=10&status=completed

Response:
{
  "success": true,
  "data": {
    "batches": [...],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 50,
      "pages": 5
    }
  }
}
```

### Get Batch Details with Questions

```http
GET /api/import-paper/batch/:batchId

Response:
{
  "success": true,
  "data": {
    "batch": {
      "fileName": "physics-2024.pdf",
      "status": "completed",
      "totalQuestions": 25,
      ...
    },
    "questions": [
      {
        "text": "Calculate the value of $\\int_0^{\\pi} \\sin(x)\\, dx$",
        "type": "integer",
        "integerAnswer": 2,
        "confidence": 0.95,
        ...
      }
    ]
  }
}
```

### Get Questions with Filters

```http
GET /api/import-paper/questions?batchId=...&status=extracted&needsReview=false

Response:
{
  "success": true,
  "data": {
    "questions": [...],
    "pagination": {...}
  }
}
```

### Update Question

```http
PUT /api/import-paper/question/:questionId

Body:
{
  "text": "Updated question text with $x^2 + 5x + 6 = 0$",
  "options": [...],
  "type": "mcq",
  "difficulty": "medium"
}
```

### Bulk Approve Questions

```http
POST /api/import-paper/questions/bulk-approve

Body:
{
  "questionIds": ["id1", "id2", "id3"]
}

Response:
{
  "success": true,
  "data": {
    "message": "Bulk approval completed",
    "approved": 3,
    "failed": 0
  }
}
```

## LaTeX Support

### Supported Mathematical Elements

#### Basic Operations

- Addition: `$a + b$` → $a + b$
- Subtraction: `$a - b$` → $a - b$
- Multiplication: `$a \times b$` → $a \times b$
- Division: `$\frac{a}{b}$` → $\frac{a}{b}$

#### Powers and Roots

- Square: `$x^2$` → $x^2$
- Power: `$x^n$` → $x^n$
- Square root: `$\sqrt{x}$` → $\sqrt{x}$
- Nth root: `$\sqrt[3]{x}$` → $\sqrt[3]{x}$

#### Greek Letters

- Lowercase: `$\alpha$, $\beta$, $\gamma$, $\theta$, $\pi$`
- Uppercase: `$\Gamma$, $\Delta$, $\Sigma$, $\Omega$`

#### Calculus

- Derivative: `$\frac{dy}{dx}$`
- Integral: `$\int f(x)\, dx$`
- Definite: `$\int_a^b f(x)\, dx$`
- Limit: `$\lim_{x \to a} f(x)$`
- Summation: `$\sum_{i=1}^{n} a_i$`

#### Trigonometry

- `$\sin(x)$, $\cos(x)$, $\tan(x)$`
- `$\sin^2(x)$, $\cos^{-1}(x)$`

#### Matrices

```latex
$\begin{pmatrix} a & b \\ c & d \end{pmatrix}$
```

## Configuration

### Environment Variables

```env
# Required
GOOGLE_API_KEY=your_gemini_api_key
MONGODB_URI=your_mongodb_connection_string

# Optional
GROQ_API_KEY=your_groq_api_key  # For alternative OCR provider
```

### Default Settings

- **OCR Provider**: Gemini (most accurate)
- **Model**: gemini-2.0-flash-exp (fast and accurate)
- **Temperature**: 0.1 (low for accuracy)
- **Max File Size**: 50MB
- **Max Pages**: 50 per PDF
- **Image DPI**: 300 (high quality)

## Database Schema

### ImportBatch

```typescript
{
  fileName: string;
  originalFileName: string;
  fileType: 'pdf' | 'image';
  fileSize: number;
  status: 'processing' | 'completed' | 'failed';
  ocrProvider: 'gemini' | 'groq' | 'tesseract';
  processingModel: string;
  totalPages: number;
  totalQuestions: number;
  processedQuestions: number;
  totalProcessingTime: number;
  uploadedBy: ObjectId;
  createdAt: Date;
}
```

### ImportedQuestion

```typescript
{
  text: string; // Question text with LaTeX
  type: 'mcq' |
    'truefalse' |
    'fill' |
    'short' |
    'long' |
    'integer' |
    'assertionreason';
  options: Array<{ text: string; isCorrect: boolean }>;
  correctAnswerText: string;
  integerAnswer: number;
  assertion: string;
  reason: string;
  assertionIsTrue: boolean;
  reasonIsTrue: boolean;
  reasonExplainsAssertion: boolean;
  subject: string;
  topic: string;
  difficulty: 'easy' | 'medium' | 'hard';
  confidence: number; // 0.0 - 1.0
  needsReview: boolean;
  status: 'extracted' | 'approved' | 'rejected';
  importBatch: ObjectId;
  questionNumber: string;
  extractedBy: ObjectId;
  reviewedBy: ObjectId;
  createdAt: Date;
}
```

## Error Handling

### Comprehensive Error Recovery

1. **File Read Errors**: Validates file type and size before processing
2. **OCR Failures**: Logs errors and marks questions for review
3. **JSON Parsing**: Multiple fallback strategies for malformed responses
4. **LaTeX Errors**: Preserves original text if normalization fails
5. **Database Errors**: Rolls back batch status on save failures

### Logging

```typescript
console.log('[Import] Starting import for file: exam.pdf');
console.log('[Gemini PDF] Processing page 1/10');
console.log('[Gemini Structure] Starting question structuring...');
console.log('[LaTeX Normalize] Processing 25 questions...');
console.log('[Import] Import completed in 45000ms');
```

## Performance Optimization

### Processing Times

- **Single Image**: ~5-10 seconds
- **5-page PDF**: ~30-60 seconds
- **20-page PDF**: ~2-4 minutes
- **50-page PDF**: ~5-10 minutes

### Optimization Strategies

1. **Parallel Processing**: Options normalized concurrently
2. **Caching**: Gemini client reused across requests
3. **Batch Operations**: Database insertMany for multiple questions
4. **Error Recovery**: Continues processing on individual failures
5. **Progress Tracking**: Real-time batch status updates

## Best Practices

### For Teachers/Admins

1. **File Quality**: Use high-resolution scans (300 DPI minimum)
2. **File Format**: PDF preferred for multi-page documents
3. **Clear Text**: Ensure text is not blurry or distorted
4. **Review Mode**: Always review imported questions before approval
5. **Batch Processing**: Upload one paper at a time for best results

### For Developers

1. **Error Monitoring**: Check console logs for detailed error traces
2. **Confidence Scores**: Review questions with confidence < 0.7
3. **LaTeX Validation**: Test math rendering before database save
4. **Memory Management**: Clear temp files after processing
5. **API Limits**: Monitor Gemini API usage and quotas

## Troubleshooting

### Common Issues

#### 1. Import Fails Immediately

- **Check**: Gemini API key is configured
- **Check**: File type is supported
- **Check**: File size is under 50MB

#### 2. No Questions Extracted

- **Check**: File contains actual text (not just images without text)
- **Check**: Question numbering is recognizable (1., Q1, etc.)
- **Solution**: Try different OCR provider

#### 3. Math Not Rendering

- **Check**: LaTeX syntax is valid
- **Check**: Dollar signs are properly balanced
- **Solution**: Manually edit question and fix LaTeX

#### 4. Low Confidence Scores

- **Reason**: Text quality is poor
- **Solution**: Use higher resolution scans
- **Solution**: Manually review and edit questions

#### 5. Processing Takes Too Long

- **Reason**: PDF has many pages
- **Solution**: Split into smaller PDFs
- **Solution**: Process during off-peak hours

## Future Enhancements

### Planned Features

- [ ] Diagram extraction and analysis
- [ ] Table detection and parsing
- [ ] Multi-language support
- [ ] Parallel page processing
- [ ] Real-time progress websockets
- [ ] Answer key auto-detection
- [ ] Question similarity detection
- [ ] Bulk edit interface
- [ ] Export to various formats
- [ ] Integration with question bank

## Testing

### Manual Testing Steps

1. Upload a sample question paper PDF
2. Wait for processing to complete
3. Check batch status in database
4. Verify questions are extracted correctly
5. Check LaTeX rendering in frontend
6. Test edit functionality
7. Approve questions
8. Verify questions appear in question bank

### Test Files Recommended

- Simple MCQ paper (5 questions)
- Math-heavy paper (calculus, algebra)
- Physics paper (equations, diagrams)
- Chemistry paper (formulas, reactions)
- Mixed format paper (MCQ + Long answer)

## Support

For issues or questions:

1. Check console logs for detailed errors
2. Verify environment variables are set
3. Test with simple files first
4. Review this documentation
5. Contact development team

---

**Last Updated**: November 10, 2025
**Version**: 2.0.0
**Author**: CBT Exam System Team
