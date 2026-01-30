# 🚀 Quick Start Guide - EPUB Question Extraction Automation

## ⚠️ IMPORTANT: Question Format

**Your database uses a FLAT structure** - all fields are at the root level, NOT nested in `tags` or `metadata` objects.

```javascript
// ✅ CORRECT FORMAT (Flat Structure)
{
  text: "Question text",
  type: "mcq",
  subject: "Physics",      // At root level
  chapter: "Chapter Name",  // At root level
  board: "JEE",            // At root level
  topic: "Topic Name",     // At root level
  section: "Objective",    // At root level
  difficulty: "medium",    // At root level
  marks: 1,                // At root level
  source: "Smart Import",  // At root level
  isActive: true,
  createdBy: ObjectId("...")
}

// ❌ WRONG FORMAT (Nested Structure)
{
  text: "Question text",
  type: "mcq",
  tags: {                  // Don't nest in tags
    subject: "Physics",
    topic: "Topic",
    difficulty: "medium"
  },
  metadata: {              // Don't nest in metadata
    chapter: "Chapter",
    board: "JEE"
  }
}
```

---

## What You Need to Do First

### 1️⃣ Install n8n (5 minutes)
```bash
# Option A: Docker (Easiest)
docker run -d --restart unless-stopped \
  --name n8n \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n

# Option B: npm
npm install -g n8n
n8n start

# Access: http://localhost:5678
```

### 2️⃣ Install Required npm Packages
```bash
cd /path/to/your/scripts/folder
npm init -y
npm install jszip xml2js cheerio axios mongodb katex
```

### 3️⃣ Create Backend API Endpoint

**File:** `src/controllers/automationController.ts`
```typescript
import { Request, Response } from 'express';
import { saveBatchValidatedQuestions, EnhancedQuestionData } from '../services/questionValidationService';
import { Types } from 'mongoose';

export const bulkImportQuestions = async (req: Request, res: Response) => {
  try {
    const { questions, userId } = req.body;
    
    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({ message: 'Questions array is required' });
    }

    // Convert to EnhancedQuestionData format
    const enhancedQuestions: EnhancedQuestionData[] = questions.map(q => ({
      ...q,
      createdBy: new Types.ObjectId(userId || req.user?.id),
      source: 'Smart Import',
      isActive: true
    }));

    // Save using existing validation service
    const savedQuestions = await saveBatchValidatedQuestions(enhancedQuestions);

    res.status(201).json({
      success: true,
      count: savedQuestions.length,
      questionIds: savedQuestions.map(q => q._id)
    });

  } catch (error) {
    console.error('Bulk import error:', error);
    res.status(500).json({ 
      message: error instanceof Error ? error.message : 'Import failed' 
    });
  }
};
```

**File:** `src/routes/api/automation.ts`
```typescript
import { Router } from 'express';
import { authenticateToken } from '../../middlewares/authMiddleware';
import { bulkImportQuestions } from '../../controllers/automationController';

const router = Router();

// POST /api/automation/bulk-import-questions
router.post('/bulk-import-questions', authenticateToken, bulkImportQuestions);

export default router;
```

**Register in:** `src/app.ts`
```typescript
import automationRoutes from './routes/api/automation';
app.use('/api/automation', automationRoutes);
```

### 4️⃣ Create EPUB Parser Script

**File:** `scripts/epub-parser.js`
```javascript
const JSZip = require('jszip');
const fs = require('fs').promises;
const xml2js = require('xml2js');
const cheerio = require('cheerio');

class EPUBParser {
  async parse(epubPath) {
    console.log('Reading EPUB:', epubPath);
    const data = await fs.readFile(epubPath);
    const zip = await JSZip.loadAsync(data);
    
    // Step 1: Get metadata
    const metadata = await this.extractMetadata(zip);
    console.log('Metadata:', metadata);
    
    // Step 2: Get chapter structure
    const chapters = await this.extractChapters(zip);
    console.log(`Found ${chapters.length} chapters`);
    
    // Step 3: Extract questions from each chapter
    const questions = [];
    for (const chapter of chapters) {
      const chapterQuestions = await this.extractQuestionsFromChapter(
        zip, 
        chapter, 
        metadata
      );
      questions.push(...chapterQuestions);
    }
    
    console.log(`Total questions extracted: ${questions.length}`);
    return { metadata, chapters, questions };
  }
  
  async extractMetadata(zip) {
    // Read container.xml to find content.opf location
    const containerXML = await zip.file('META-INF/container.xml').async('text');
    const container = await xml2js.parseStringPromise(containerXML);
    const contentPath = container.container.rootfiles[0].rootfile[0].$['full-path'];
    
    // Read content.opf
    const contentOPF = await zip.file(contentPath).async('text');
    const content = await xml2js.parseStringPromise(contentOPF);
    
    const metadata = content.package.metadata[0];
    
    return {
      title: metadata['dc:title']?.[0] || 'Unknown',
      author: metadata['dc:creator']?.[0] || 'Unknown',
      subject: metadata['dc:subject']?.[0] || 'Unknown',
      language: metadata['dc:language']?.[0] || 'en'
    };
  }
  
  async extractChapters(zip) {
    // Try toc.ncx first
    const tocFile = zip.file(/toc\.ncx$/i)[0];
    if (!tocFile) return [];
    
    const tocXML = await tocFile.async('text');
    const toc = await xml2js.parseStringPromise(tocXML);
    
    const chapters = [];
    const navPoints = toc.ncx.navMap[0].navPoint || [];
    
    for (const point of navPoints) {
      chapters.push({
        title: point.navLabel[0].text[0],
        src: point.content[0].$.src,
        id: point.$.id
      });
    }
    
    return chapters;
  }
  
  async extractQuestionsFromChapter(zip, chapter, metadata) {
    const questions = [];
    
    // Get chapter HTML file
    const basePath = 'OEBPS/Text/'; // Common path, may vary
    let htmlPath = chapter.src;
    
    // Try common paths
    const possiblePaths = [
      chapter.src,
      `OEBPS/${chapter.src}`,
      `OEBPS/Text/${chapter.src.split('/').pop()}`
    ];
    
    let htmlFile = null;
    for (const path of possiblePaths) {
      htmlFile = zip.file(path);
      if (htmlFile) {
        htmlPath = path;
        break;
      }
    }
    
    if (!htmlFile) {
      console.warn(`Could not find HTML file for chapter: ${chapter.title}`);
      return questions;
    }
    
    const html = await htmlFile.async('text');
    const $ = cheerio.load(html);
    
    // Detect exercise sections
    const exercises = this.detectExerciseSections($);
    
    for (const exercise of exercises) {
      const exerciseQuestions = this.extractQuestionsFromExercise($, exercise, chapter, metadata);
      questions.push(...exerciseQuestions);
    }
    
    return questions;
  }
  
  detectExerciseSections($) {
    const exercises = [];
    const exerciseHeaders = [
      /exercise\s+\d+\.?\d*/i,
      /practice\s+questions/i,
      /miscellaneous\s+exercise/i,
      /chapter.*test/i,
      /mcqs/i,
      /very\s+short\s+answer/i,
      /short\s+answer/i,
      /long\s+answer/i
    ];
    
    $('h1, h2, h3, h4').each((i, elem) => {
      const text = $(elem).text().trim();
      
      for (const pattern of exerciseHeaders) {
        if (pattern.test(text)) {
          exercises.push({
            title: text,
            element: elem,
            type: this.classifyExerciseType(text)
          });
          break;
        }
      }
    });
    
    return exercises;
  }
  
  classifyExerciseType(title) {
    if (/mcq/i.test(title)) return 'mcq';
    if (/true.*false/i.test(title)) return 'truefalse';
    if (/fill.*blank/i.test(title)) return 'fill';
    if (/very\s+short/i.test(title)) return 'short';
    if (/long\s+answer/i.test(title)) return 'long';
    return 'mixed';
  }
  
  extractQuestionsFromExercise($, exercise, chapter, metadata) {
    const questions = [];
    
    // Get all content after exercise header until next exercise
    let currentElement = $(exercise.element).next();
    let questionNumber = 1;
    
    while (currentElement.length && !this.isExerciseHeader(currentElement)) {
      const text = currentElement.text().trim();
      
      // Check if this element starts with a question number
      const questionMatch = text.match(/^(?:Q\.?\s*)?(\d+)\.?\s+/);
      
      if (questionMatch) {
        const questionText = text.replace(/^(?:Q\.?\s*)?\d+\.?\s+/, '').trim();
        
        // Check for MCQ options in next elements
        const options = this.extractOptions($, currentElement);
        
        // IMPORTANT: Use FLAT structure - all fields at root level
        const question = {
          // Core fields
          text: questionText,
          type: options.length > 0 ? 'mcq' : (exercise.type || 'short'),
          options: options.length > 0 ? options : undefined,
          
          // Metadata fields (FLAT - at root level, NOT nested)
          subject: metadata.subject || 'Unknown',           // REQUIRED
          topic: chapter.title || 'General',                // REQUIRED
          chapter: chapter.title || 'Unknown',              // REQUIRED
          board: this.extractBoardFromTitle(metadata.title), // REQUIRED
          class: this.extractClassFromTitle(metadata.title),
          section: exercise.title,
          difficulty: 'medium',
          marks: this.estimateMarks(exercise.type, options.length > 0),
          
          // Additional fields
          source: 'Smart Import',                           // REQUIRED
          isActive: true,                                   // REQUIRED
          
          // For tracking during extraction
          questionNumber: questionNumber.toString()
        };
        
        questions.push(question);
        questionNumber++;
      }
      
      currentElement = currentElement.next();
    }
    
    return questions;
  }
  
  extractOptions($, questionElement) {
    const options = [];
    let nextElement = questionElement.next();
    const optionPattern = /^[\(\[]?([a-d])[\)\]\.]\s*/i;
    
    // Check next 6 elements for options
    for (let i = 0; i < 6 && nextElement.length; i++) {
      const text = nextElement.text().trim();
      
      if (optionPattern.test(text)) {
        const optionText = text.replace(optionPattern, '').trim();
        options.push({
          text: optionText,
          isCorrect: false // Will be determined later or manually
        });
        nextElement = nextElement.next();
      } else {
        break;
      }
    }
    
    return options;
  }
  
  isExerciseHeader(element) {
    const text = element.text().toLowerCase();
    return /^(exercise|practice|mcq|chapter|test)/i.test(text);
  }
  
  extractClassFromTitle(title) {
    const match = title.match(/class\s+(\d+|xi|xii|11|12)/i);
    if (!match) return 'Unknown';
    
    const classNum = match[1].toLowerCase();
    if (classNum === 'xi' || classNum === '11') return 'Class 11';
    if (classNum === 'xii' || classNum === '12') return 'Class 12';
    return `Class ${classNum}`;
  }
  
  extractBoardFromTitle(title) {
    if (/ncert/i.test(title)) return 'NCERT';
    if (/cbse/i.test(title)) return 'CBSE';
    if (/jee/i.test(title)) return 'JEE';
    if (/neet/i.test(title)) return 'NEET';
    return 'CBSE'; // Default
  }
  
  estimateMarks(exerciseType, isMCQ) {
    if (isMCQ) return 1;
    if (exerciseType === 'short') return 2;
    if (exerciseType === 'long') return 5;
    return 1;
  }
}

// Test script
async function testParser() {
  const parser = new EPUBParser();
  
  // Test with one of your books
  const epubPath = process.argv[2] || '../class_11/Mathematics Class XI  - R.D. Sharma.epub';
  
  try {
    const result = await parser.parse(epubPath);
    
    // Save to JSON for inspection
    await fs.writeFile(
      'extracted_questions.json',
      JSON.stringify(result, null, 2)
    );
    
    console.log('\n✅ Extraction complete!');
    console.log(`📚 Book: ${result.metadata.title}`);
    console.log(`📝 Chapters: ${result.chapters.length}`);
    console.log(`❓ Questions: ${result.questions.length}`);
    console.log(`💾 Saved to: extracted_questions.json`);
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

if (require.main === module) {
  testParser();
}

module.exports = EPUBParser;
```

### 5️⃣ Test the Parser

```bash
cd cbt-exam-be
node scripts/epub-parser.js "class_11/Mathematics Class XI  - R.D. Sharma.epub"

# This will create extracted_questions.json
# Review the output to verify extraction quality
```

### 6️⃣ Create n8n Workflow (Import this JSON)

I'll create a starter workflow in the next file...

---

## 📊 Expected Results

After running the parser on **"Mathematics Class XI - R.D. Sharma.epub"**:

- ✅ 20-30 chapters detected
- ✅ 50-100 exercises found
- ✅ 1000-2000 questions extracted
- ✅ All with proper metadata (class, board, chapter, section)
- ✅ MCQ options captured automatically
- ✅ Ready to import to MongoDB

---

## 🎯 Next Actions

1. **Test the EPUB parser** with your books
2. **Review extracted_questions.json** to validate quality
3. **Adjust the parser** if needed (different EPUB structures)
4. **Import to n8n** (I'll provide the workflow JSON next)
5. **Schedule daily runs** via CRON

---

## 🐛 Common Issues & Solutions

### Issue: "Cannot find HTML files"
**Solution:** EPUBs have different structures. Check the EPUB manually:
```bash
unzip "your-book.epub" -d temp
ls -la temp/OEBPS/Text/  # or temp/OPS/ or temp/content/
```

### Issue: "No questions detected"
**Solution:** The question pattern might be different. Check the HTML:
```bash
cat temp/OEBPS/Text/Chapter01.xhtml | grep -E "^\s*\d+\."
```

### Issue: "Options not captured"
**Solution:** The option format might vary. Common formats:
- `(a)`, `(b)`, `(c)`, `(d)`
- `a)`, `b)`, `c)`, `d)`
- `a.`, `b.`, `c.`, `d.`
- `A.`, `B.`, `C.`, `D.`

Adjust the regex in `extractOptions()` method.

---

## 💡 Pro Tips

1. **Start with 1 chapter**: Test thoroughly before processing entire books
2. **Inspect the JSON**: Always review extracted_questions.json before bulk import
3. **Use Git**: Commit after each successful test
4. **Monitor costs**: Vertex AI costs money, test with Flash model first
5. **Backup database**: Before bulk imports, backup your MongoDB

---

## 📞 Need Help?

If you encounter issues:
1. Check the extracted_questions.json output
2. Verify EPUB structure (unzip and inspect manually)
3. Test with a single chapter first
4. Adjust regex patterns for your specific book format

Ready for the n8n workflow? Let me know!
