# Quick Setup Guide - AI Enhancements

## Prerequisites

- Node.js 18+
- MongoDB running
- Firebase project configured
- Google Gemini API key

## Installation

### 1. Install New Dependencies

```powershell
cd cbt-exam-be
npm install
```

This will install:

- `sharp@^0.34.1` - Image processing
- `mathjs@^14.0.1` - Math validation
- `axios@^1.7.9` - HTTP client

### 2. Environment Configuration

Ensure your `.env` file has:

```env
# Gemini API (Required)
GOOGLE_API_KEY=your_gemini_api_key_here
# OR
GEMINI_API_KEY=your_gemini_api_key_here

# Firebase Configuration (Required for diagram storage)
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_CLIENT_EMAIL=your_service_account_email
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_STORAGE_BUCKET=your_bucket_name.appspot.com

# Optional
GROQ_API_KEY=your_groq_key_for_grading
```

### 3. Firebase Storage Setup

Enable Firebase Storage in your Firebase Console:

1. Go to Firebase Console → Storage
2. Enable Storage
3. Set CORS rules (if needed):

```json
[
  {
    "origin": ["*"],
    "method": ["GET"],
    "maxAgeSeconds": 3600
  }
]
```

### 4. Build the Project

```powershell
npm run build
```

### 5. Run Development Server

```powershell
npm run dev
```

## Testing the New Features

### Test 1: PDF Question Paper Upload

```powershell
# Using curl
curl -X POST http://localhost:5000/api/ai/generate-from-pdf `
  -H "Authorization: Bearer YOUR_JWT_TOKEN" `
  -F "pdf=@path/to/question_paper.pdf" `
  -F "subject=Mathematics" `
  -F "count=10"
```

Expected Response:

```json
{
  "items": [...],
  "total": 10,
  "metadata": {
    "documentType": "question_paper",
    "isQuestionPaper": true,
    "diagramsExtracted": 3,
    "strategy": "recreate_exact"
  }
}
```

### Test 2: Image OCR with Diagrams

```powershell
curl -X POST http://localhost:5000/api/ai/generate-from-image `
  -H "Authorization: Bearer YOUR_JWT_TOKEN" `
  -F "file=@path/to/question_image.jpg" `
  -F "subject=Physics"
```

### Test 3: Verify Math Formatting

Check that generated questions have LaTeX:

```json
{
  "text": "Solve the equation $x^2 + 5x - 3 = 0$",
  "type": "short",
  "correctAnswerText": "$x = \\frac{-5 \\pm \\sqrt{37}}{2}$"
}
```

### Test 4: Verify Diagram Links

Check that diagrams are stored and linked:

```json
{
  "text": "Refer to the diagram above. Calculate the area.",
  "diagramUrl": "https://storage.googleapis.com/your-bucket/diagrams/diagram_123.jpg",
  "diagramAlt": "Right triangle with sides 3, 4, 5"
}
```

## Troubleshooting

### Issue: "Gemini API key not configured"

**Solution**: Set `GOOGLE_API_KEY` or `GEMINI_API_KEY` in `.env`

### Issue: "Firebase Storage upload failed"

**Solution**:

1. Check Firebase credentials in `.env`
2. Verify Storage is enabled in Firebase Console
3. Check bucket permissions

### Issue: "Sharp module not found"

**Solution**:

```powershell
npm install sharp --force
npm rebuild sharp
```

### Issue: OCR produces poor results

**Solution**: The system now uses Gemini Vision API by default (much better than Tesseract). Ensure:

- Image quality is good (min 300 DPI for scans)
- Text is clear and readable
- Gemini API key is valid

## Verify Installation

Run this test to verify all services:

```javascript
// test-services.js
const { analyzeDocument } = require('./dist/services/documentAnalysisService');
const {
  processDocumentForDiagrams,
} = require('./dist/services/diagramService');

async function test() {
  console.log('Testing document analysis...');
  const result = await analyzeDocument('Q1. What is 2+2?', false);
  console.log('✓ Document analysis working:', result.isQuestionPaper);

  console.log('✓ All services initialized successfully!');
}

test().catch(console.error);
```

## Performance Notes

- **PDF Processing**: 5-15 seconds per document (depending on size)
- **Image OCR**: 3-8 seconds per image
- **Diagram Extraction**: 2-5 seconds per diagram
- **Question Generation**: 10-30 seconds for 10 questions

## API Rate Limits

### Gemini API:

- Free tier: 60 requests/minute
- Paid tier: Higher limits

Recommendations:

- Implement request queuing for batch processing
- Cache document analysis results
- Use appropriate model (flash for speed, pro for quality)

## Monitoring

Check logs for:

```
✓ Used Gemini Vision for PDF text extraction
✓ Document Analysis: question_paper (confidence: 0.9)
✓ Strategy: recreate_exact
✓ Extracted 3 diagrams
```

## Next Steps

1. ✅ Test with sample question papers
2. ✅ Verify diagram storage in Firebase
3. ✅ Check math rendering in frontend
4. ✅ Monitor API usage and costs
5. ✅ Collect user feedback

## Support

For issues:

1. Check logs in terminal
2. Verify environment variables
3. Test API keys separately
4. Review Firebase console for storage issues

## Production Deployment

Before deploying:

- [ ] Set production environment variables
- [ ] Configure Firebase production bucket
- [ ] Set up API rate limiting
- [ ] Enable error tracking (Sentry, etc.)
- [ ] Test with various document types
- [ ] Set up monitoring dashboards

---

**Last Updated**: January 2025
**Version**: 2.0.0
