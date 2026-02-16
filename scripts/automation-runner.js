const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const EPUBParser = require('./epub-parser');
const PDFParser = require('./pdf-parser');
const AIEnhancer = require('./ai-enhancer');

const CONFIG = {
  backendUrl: process.env.BACKEND_API_URL || 'http://localhost:5000',
  apiToken: process.env.BACKEND_API_KEY || process.env.ADMIN_TOKEN,
  adminUserId: process.env.ADMIN_USER_ID,
  baseFolder: process.env.EPUB_BASE_PATH || path.join(__dirname, '..'),
  targetFolder: process.env.TARGET_FOLDER || 'class_12', // Start with class_12
  batchSize: parseInt(process.env.BATCH_SIZE || '50'),
};

class AutomationRunner {
  constructor() {
    this.epubParser = new EPUBParser();
    this.pdfParser = new PDFParser();
    this.aiEnhancer = new AIEnhancer();
    this.stats = {
      booksProcessed: 0,
      booksSucceeded: 0,
      booksFailed: 0,
      totalQuestions: 0,
      totalImported: 0
    };
  }

  async run() {
    console.log('\n🤖 Automation Runner Started');
    console.log('═══════════════════════════════════════');
    console.log(`⏰ Time: ${new Date().toLocaleString()}`);
    console.log(`📁 Target Folder: ${CONFIG.targetFolder}`);
    console.log('═══════════════════════════════════════\n');

    try {
      // Step 1: Check if automation is enabled
      const isEnabled = await this.checkAutomationStatus();
      if (!isEnabled) {
        console.log('⏸️  Automation is DISABLED. Exiting...');
        return;
      }

      // Step 2: Scan for EPUB and PDF files
      const files = await this.scanFiles();
      console.log(`📚 Found ${files.length} file(s) to process\n`);

      if (files.length === 0) {
        console.log('✅ No new books to process. Exiting...');
        return;
      }

      // Step 3: Process each book
      for (const file of files) {
        await this.processBook(file);
      }

      // Step 4: Report summary
      this.reportSummary();

    } catch (error) {
      console.error('\n❌ Automation Runner Failed:', error.message);
      console.error(error.stack);
      await this.resetRunningStatus();
      process.exit(1);
    } finally {
      // Always reset status on exit
      await this.resetRunningStatus();
    }
  }

  async resetRunningStatus() {
    try {
      const response = await axios.post(
        `${CONFIG.backendUrl}/api/automation/status/reset`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.apiToken}`
          }
        }
      );
      if (response.data.success) {
        console.log('✓ Automation status reset');
      }
    } catch (error) {
      // Silently fail - status will be reset by controller exit handler
    }
  }

  async checkAutomationStatus() {
    try {
      const response = await axios.get(`${CONFIG.backendUrl}/api/automation/status`, {
        headers: {
          'Authorization': `Bearer ${CONFIG.apiToken}`
        }
      });

      const status = response.data.status;
      console.log(`✓ Automation Status: ${status.isEnabled ? 'ENABLED' : 'DISABLED'}`);
      console.log(`✓ Last Run: ${status.lastRun ? new Date(status.lastRun).toLocaleString() : 'Never'}\n`);

      return status.isEnabled;

    } catch (error) {
      console.warn('⚠️  Could not check automation status:', error.message);
      console.warn('   Proceeding anyway...\n');
      return true;
    }
  }

  async scanFiles() {
    const folderPath = path.join(CONFIG.baseFolder, CONFIG.targetFolder);
    
    try {
      const files = await fs.readdir(folderPath);
      const bookFiles = files
        .filter(file => file.endsWith('.epub') || file.endsWith('.pdf'))
        .map(file => ({
          fileName: file,
          filePath: path.join(folderPath, file),
          fileType: file.endsWith('.epub') ? 'epub' : 'pdf'
        }));

      return bookFiles;

    } catch (error) {
      console.error(`❌ Failed to scan folder ${folderPath}:`, error.message);
      return [];
    }
  }

  async processBook(bookFile) {
    console.log(`\n📖 Processing: ${bookFile.fileName} (${bookFile.fileType.toUpperCase()})`);
    console.log('─'.repeat(60));

    let recordId = null;

    try {
      // Step 1: Parse file based on type
      console.log(`1️⃣  Parsing ${bookFile.fileType.toUpperCase()}...`);
      const parser = bookFile.fileType === 'epub' ? this.epubParser : this.pdfParser;
      const parsed = await parser.parse(bookFile.filePath);

      if (!parsed.questions || parsed.questions.length === 0) {
        console.log('⚠️  No questions found in this book. Skipping...');
        return;
      }

      // Step 2: Enhance questions with AI (split, structure, add LaTeX)
      console.log('2️⃣  Enhancing questions with AI...');
      const enhancedQuestions = await this.aiEnhancer.enhanceQuestions(
        parsed.questions,
        {
          title: parsed.metadata.title,
          subject: parsed.metadata.subject,
          board: this.extractBoard(parsed.metadata.title),
          class: this.extractClass(bookFile.fileName),
          chapter: 'General', // Will be inferred by AI
          topic: 'General'
        }
      );

      if (enhancedQuestions.length === 0) {
        console.log('⚠️  AI enhancement produced no valid questions. Skipping...');
        return;
      }

      console.log(`   ✓ AI produced ${enhancedQuestions.length} questions from ${parsed.questions.length} raw extractions`);

      // Step 3: Create processing record
      console.log('3️⃣  Creating processing record...');
      recordId = await this.createProcessingRecord(bookFile, parsed);

      // Step 4: Import enhanced questions in batches
      console.log(`4️⃣  Importing ${enhancedQuestions.length} questions...`);
      const imported = await this.importQuestions(enhancedQuestions);

      // Step 5: Update processing record with success
      console.log('5️⃣  Updating processing record...');
      await this.updateProcessingRecord(recordId, {
        status: 'completed',
        totalQuestions: enhancedQuestions.length,
        questionsImported: imported.count,
        questionsWithDiagrams: parsed.stats.withDiagrams,
        questionsWithCorrectAnswers: parsed.stats.withCorrectAnswers,
        questionsWithOptions: parsed.stats.withOptions
      });

      // Update stats
      this.stats.booksProcessed++;
      this.stats.booksSucceeded++;
      this.stats.totalQuestions += enhancedQuestions.length;
      this.stats.totalImported += imported.count;

      console.log(`✅ Successfully processed: ${bookFile.fileName}`);
      console.log(`   Questions: ${imported.count}/${enhancedQuestions.length} imported`);

    } catch (error) {
      console.error(`❌ Failed to process ${bookFile.fileName}:`, error.message);

      // Update processing record with failure
      if (recordId) {
        await this.updateProcessingRecord(recordId, {
          status: 'failed',
          errors: [error.message]
        });
      }

      this.stats.booksProcessed++;
      this.stats.booksFailed++;
    }
  }

  async createProcessingRecord(bookFile, parsed) {
    try {
      const response = await axios.post(
        `${CONFIG.backendUrl}/api/automation/record`,
        {
          fileName: bookFile.fileName,
          filePath: bookFile.filePath,
          bookMetadata: {
            title: parsed.metadata.title,
            author: parsed.metadata.author,
            subject: parsed.metadata.subject,
            class: this.extractClass(bookFile.fileName),
            board: this.extractBoard(parsed.metadata.title)
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.apiToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data.recordId;

    } catch (error) {
      console.warn('⚠️  Could not create processing record:', error.message);
      return null;
    }
  }

  async importQuestions(questions) {
    const batches = [];
    for (let i = 0; i < questions.length; i += CONFIG.batchSize) {
      batches.push(questions.slice(i, i + CONFIG.batchSize));
    }

    let totalImported = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      
      try {
        const response = await axios.post(
          `${CONFIG.backendUrl}/api/automation/bulk-import-questions`,
          {
            questions: batch,
            userId: CONFIG.adminUserId,
            targetCollection: CONFIG.targetFolder
          },
          {
            headers: {
              'Authorization': `Bearer ${CONFIG.apiToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        totalImported += response.data.count;
        console.log(`   Batch ${i + 1}/${batches.length}: ${response.data.count} imported`);

      } catch (error) {
        console.error(`   ❌ Batch ${i + 1}/${batches.length} failed:`, error.message);
      }
    }

    return { count: totalImported };
  }

  async updateProcessingRecord(recordId, updates) {
    if (!recordId) return;

    try {
      await axios.put(
        `${CONFIG.backendUrl}/api/automation/record/${recordId}`,
        updates,
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.apiToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

    } catch (error) {
      console.warn('⚠️  Could not update processing record:', error.message);
    }
  }

  extractClass(fileName) {
    if (/class.?12|xii/i.test(fileName)) return 'Class 12';
    if (/class.?11|xi/i.test(fileName)) return 'Class 11';
    return 'Unknown';
  }

  extractBoard(title) {
    if (/neet/i.test(title)) return 'NEET';
    if (/jee/i.test(title)) return 'JEE';
    if (/ncert/i.test(title)) return 'NCERT';
    if (/cbse/i.test(title)) return 'CBSE';
    return 'CBSE';
  }

  reportSummary() {
    console.log('\n\n📊 Processing Summary');
    console.log('═══════════════════════════════════════');
    console.log(`📚 Books Processed: ${this.stats.booksProcessed}`);
    console.log(`✅ Succeeded: ${this.stats.booksSucceeded}`);
    console.log(`❌ Failed: ${this.stats.booksFailed}`);
    console.log(`❓ Total Questions: ${this.stats.totalQuestions}`);
    console.log(`✔️  Imported: ${this.stats.totalImported}`);
    console.log(`📈 Success Rate: ${((this.stats.totalImported / this.stats.totalQuestions) * 100).toFixed(1)}%`);
    console.log('═══════════════════════════════════════\n');
  }
}

// Run
if (require.main === module) {
  const runner = new AutomationRunner();
  runner.run()
    .then(() => {
      console.log('✅ Automation completed successfully\n');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Automation failed:', error);
      process.exit(1);
    });
}

module.exports = AutomationRunner;
