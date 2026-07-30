#!/usr/bin/env node
'use strict';

/**
 * PDF Question Parser — pdfjs-dist edition.
 *
 * Two-pass extraction strategy:
 *   1. Structure-aware: detect NCERT/CBSE document hierarchy (Examples, Exercises,
 *      numbered questions) and emit one semantic block per question/example.
 *   2. Fallback character chunking: used when a PDF has no recognizable structure
 *      (sparse, image-only, or non-standard layout).
 *
 * Each output chunk carries:
 *   { text, topic, chapter, exerciseLabel, blockType?, blockLabel?, parentLabel?,
 *     pageStart, pageEnd,
 *     diagram?: { type:'vector'|'image', svgInline?, objId? },
 *     tableData?: { headers, rows, html, caption },
 *     hasDiagram?, hasTable? }
 */

const fs    = require('fs').promises;
const path  = require('path');

const pdfjsLib = require('pdfjs-dist');
const { parsePageOperators }      = require('./pdf-operator-parser');
const { extractTables }           = require('./pdf-table-extractor');
const { detectDiagramRegions }    = require('./pdf-diagram-extractor');
const { analyzeDocumentStructure } = require('./pdf-structure-analyzer');

const MIN_CHARS_PER_PAGE = 50;

// ── Diagram/table reference signals ──────────────────────────────────────────

const DIAGRAM_REF_RE = /\b(fig(?:ure)?\.?\s*[\d.]*|diagram|graph|chart|illustration|given (?:figure|diagram|below|above))\b/i;
const TABLE_REF_RE   = /\b(table|following table|given table|data (?:in|from) (?:the|above|below))\b/i;

// ─────────────────────────────────────────────────────────────────────────────

class PDFParser {
  constructor() {
    this.minCharsPerPage = MIN_CHARS_PER_PAGE;
  }

  /**
   * Main entry point. Returns { metadata, questions: chunks[], stats }.
   */
  async parse(pdfPath) {
    console.log('[PDF Parser] Reading:', pdfPath);
    const buffer   = await fs.readFile(pdfPath);
    const metadata = await this.extractMetadata(pdfPath);
    console.log('[PDF Parser] Metadata:', metadata);

    // pdfjs-dist v4 requires Uint8Array, not a Node.js Buffer
    const loadTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    const pdfDoc   = await loadTask.promise;
    const numPages = pdfDoc.numPages;
    console.log(`[PDF Parser] ${numPages} page(s)`);

    // Per-page analysis
    const pageData = await this.analyzePages(pdfDoc, numPages);

    // Build full text for fallback
    const fullText = pageData
      .map(p => `\n=== PAGE ${p.pageNum} ===\n${p.text}`)
      .join('\n');
    console.log(`[PDF Parser] Total text: ${fullText.length} chars`);

    const avgChars = fullText.length / numPages;
    if (avgChars < this.minCharsPerPage) {
      console.warn(`[PDF Parser] Sparse PDF (avg ${Math.round(avgChars)} chars/page) — limited extraction`);
    }

    // ── Strategy selection ────────────────────────────────────────────────────
    let chunks;
    const structureBlocks = analyzeDocumentStructure(pageData);

    if (structureBlocks && structureBlocks.length >= 2) {
      console.log(`[PDF Parser] Structure detected: ${structureBlocks.length} semantic block(s)`);
      chunks = this.buildStructuredChunks(structureBlocks, metadata);
    } else {
      console.log('[PDF Parser] No structure detected — falling back to character chunking');
      chunks = this.splitIntoChunks(fullText, metadata, pageData);
    }

    console.log(`[PDF Parser] ${chunks.length} enriched chunk(s)`);
    const stats = this.analyzeChunks(chunks);
    // Additive signal for the OCR-fallback decision (scanned PDFs are sparse).
    // Does not affect chunking/extraction — purely descriptive.
    stats.numPages = numPages;
    stats.totalTextChars = fullText.length;
    return { metadata, questions: chunks, stats };
  }

  // ── Per-page analysis ───────────────────────────────────────────────────────

  async analyzePages(pdfDoc, numPages) {
    const pageData = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page     = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });

      // Text with bounding boxes
      const textContent = await page.getTextContent();
      const textItems   = textContent.items.map(item => ({
        str: item.str,
        x:   item.transform[4],
        y:   viewport.height - item.transform[5], // flip to top-down
        w:   item.width  || 0,
        h:   item.height || 12,
      }));
      const pageText = textItems.map(t => t.str).join(' ');

      // Geometry extraction
      let tables   = [];
      let diagrams = [];
      try {
        const primitives  = await parsePageOperators(page);
        tables            = extractTables(primitives.lines, textItems, viewport.height);
        const tableBboxes = tables.map(t => t.bbox);
        diagrams          = detectDiagramRegions(primitives, tableBboxes);

        if (tables.length)   console.log(`[PDF Parser] Page ${pageNum}: ${tables.length} table(s)`);
        if (diagrams.length) console.log(`[PDF Parser] Page ${pageNum}: ${diagrams.length} diagram(s) (${diagrams.map(d => d.type).join(', ')})`);
      } catch (err) {
        console.warn(`[PDF Parser] Page ${pageNum} geometry error:`, err.message);
      }

      pageData.push({ pageNum, text: pageText, textItems, tables, diagrams });
    }

    return pageData;
  }

  // ── Structure-aware chunk builder ───────────────────────────────────────────

  buildStructuredChunks(blocks, metadata) {
    const chapterName = metadata.chapter || 'General';
    const chunks      = [];

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];

      // Skip pure header blocks — they contribute context via parentLabel
      if (block.blockType === 'chapter_header' || block.blockType === 'exercise_header') {
        // Only emit if they have substantial body text beyond the label
        const bodyText = block.text.replace(block.blockLabel, '').trim();
        if (bodyText.length < 40) continue;
      }

      const chunk = {
        text:          block.text,
        topic:         chapterName,
        chapter:       chapterName,
        exerciseLabel: block.blockLabel,
        blockType:     block.blockType,
        blockLabel:    block.blockLabel,
        parentLabel:   block.parentLabel || null,
        pageStart:     block.pageStart,
        pageEnd:       block.pageEnd,
      };

      // Attach first table from the block's pages
      if (block.tables && block.tables.length > 0) {
        const t = block.tables[0];
        chunk.tableData = {
          headers: t.headers,
          rows:    t.rows,
          html:    t.html,
          caption: t.caption || '',
        };
      }

      // Attach first diagram from the block's pages
      if (block.diagrams && block.diagrams.length > 0) {
        const d = block.diagrams[0];
        chunk.diagram = d.type === 'vector'
          ? { type: 'vector', svgInline: d.svgInline }
          : { type: 'image', objId: d.objId };
      }

      if (DIAGRAM_REF_RE.test(block.text) || chunk.diagram)   chunk.hasDiagram = true;
      if (TABLE_REF_RE.test(block.text)   || chunk.tableData) chunk.hasTable   = true;

      console.log(
        `[PDF Parser] Block ${i + 1} [${block.blockType}]: "${block.blockLabel.slice(0, 60)}"` +
        ` (pg ${block.pageStart}–${block.pageEnd})` +
        `${chunk.tableData ? ' [TABLE]' : ''}${chunk.diagram ? ' [DIAGRAM]' : ''}`
      );
      chunks.push(chunk);
    }

    // If all blocks were skipped headers, fall through handled by caller
    return chunks;
  }

  // ── Fallback character-based chunk splitting ─────────────────────────────────

  splitIntoChunks(fullText, metadata, pageData) {
    const CHUNK_SIZE    = Number(process.env.PDF_CHUNK_SIZE    || 4000);
    const CHUNK_OVERLAP = Number(process.env.PDF_CHUNK_OVERLAP || 300);
    const chapterName   = metadata.chapter || 'General';
    const chunks        = [];

    const pageOffsets = this._buildPageOffsets(fullText, pageData);

    let start    = 0;
    let chunkIdx = 0;

    while (start < fullText.length) {
      let end = Math.min(start + CHUNK_SIZE, fullText.length);
      if (end < fullText.length) {
        const lastDbl = fullText.lastIndexOf('\n\n', end);
        const lastNl  = fullText.lastIndexOf('\n',   end);
        if (lastDbl > start + CHUNK_SIZE / 2) end = lastDbl;
        else if (lastNl > start + CHUNK_SIZE / 2) end = lastNl;
      }

      const slice = fullText.slice(start, end).trim();
      if (slice.length > 80) {
        const { pageStart, pageEnd } = this._getChunkPages(start, end, pageOffsets);

        const chunkTables   = [];
        const chunkDiagrams = [];
        for (const pd of pageData) {
          if (pd.pageNum >= pageStart && pd.pageNum <= pageEnd) {
            chunkTables.push(...pd.tables);
            chunkDiagrams.push(...pd.diagrams);
          }
        }

        const label = chunkIdx === 0 ? 'Introduction' : `Part ${chunkIdx + 1}`;

        const chunk = {
          text:          slice,
          topic:         chapterName,
          chapter:       chapterName,
          exerciseLabel: label,
          pageStart,
          pageEnd,
        };

        if (chunkTables.length > 0) {
          const t = chunkTables[0];
          chunk.tableData = { headers: t.headers, rows: t.rows, html: t.html, caption: t.caption || '' };
        }

        if (chunkDiagrams.length > 0) {
          const d = chunkDiagrams[0];
          chunk.diagram = d.type === 'vector'
            ? { type: 'vector', svgInline: d.svgInline }
            : { type: 'image', objId: d.objId };
        }

        if (DIAGRAM_REF_RE.test(slice) || chunk.diagram)   chunk.hasDiagram = true;
        if (TABLE_REF_RE.test(slice)   || chunk.tableData) chunk.hasTable   = true;

        console.log(
          `[PDF Parser] Chunk ${chunkIdx + 1}: ${slice.length} chars — "${label}"` +
          `${chunk.tableData ? ' [TABLE]' : ''}${chunk.diagram ? ' [DIAGRAM]' : ''}`
        );
        chunks.push(chunk);
        chunkIdx++;
      }

      if (end >= fullText.length) break;
      const overlap   = Math.max(0, Math.min(CHUNK_OVERLAP, CHUNK_SIZE - 500));
      const nextStart = Math.max(end - overlap, start + 500);
      start = nextStart > start ? nextStart : end + 1;
    }

    if (chunks.length === 0 && fullText.trim().length > 100) {
      chunks.push({ text: fullText.trim(), topic: chapterName, chapter: chapterName, exerciseLabel: 'Full Text' });
    }

    return chunks;
  }

  _buildPageOffsets(fullText, pageData) {
    const offsets = [];
    let search = 0;
    for (const pd of pageData) {
      const marker = `\n=== PAGE ${pd.pageNum} ===\n`;
      const pos    = fullText.indexOf(marker, search);
      if (pos === -1) continue;
      offsets.push({ pageNum: pd.pageNum, start: pos + marker.length });
      search = pos + marker.length;
    }
    return offsets;
  }

  _getChunkPages(chunkStart, chunkEnd, pageOffsets) {
    let pageStart = 1, pageEnd = 1;
    for (const o of pageOffsets) {
      if (o.start <= chunkStart) pageStart = o.pageNum;
      if (o.start <= chunkEnd)   pageEnd   = o.pageNum;
    }
    return { pageStart, pageEnd };
  }

  analyzeChunks(chunks) {
    return {
      total:              chunks.length,
      withDiagrams:       chunks.filter(c => c.diagram).length,
      withTables:         chunks.filter(c => c.tableData).length,
      structured:         chunks.filter(c => c.blockType).length,
      withCorrectAnswers: 0,
      withOptions:        0,
    };
  }

  // ── Metadata extraction ─────────────────────────────────────────────────────

  async extractMetadata(pdfPath) {
    const filename     = path.basename(pdfPath, '.pdf');
    const parentFolder = path.basename(path.dirname(pdfPath));
    const folderMatch  = parentFolder.match(/^class[_\s-]?(\d+)[_\s-]?(.*)?$/i);
    let classLabel = 'Unknown';
    let subject    = 'Unknown';

    if (folderMatch) {
      classLabel = `Class ${folderMatch[1]}`;
      const rawSubject = (folderMatch[2] || '').replace(/_/g, ' ').trim();
      if (rawSubject) subject = this.normalizeSubject(rawSubject);
    }
    if (subject === 'Unknown') subject = this.identifySubjectFromTitle(filename);

    return {
      title:    filename,
      chapter:  filename,
      author:   'Unknown',
      subject,
      language: 'en',
      class:    classLabel,
      board:    'CBSE',
    };
  }

  normalizeSubject(raw) {
    const map = {
      mathematics: 'Mathematics', maths: 'Mathematics', math: 'Mathematics',
      physics: 'Physics', chemistry: 'Chemistry', biology: 'Biology',
      english: 'English', science: 'Science',
      'social science': 'Social Science', 'social studies': 'Social Science',
      history: 'History', geography: 'Geography', economics: 'Economics',
      'computer science': 'Computer Science', computers: 'Computer Science',
      hindi: 'Hindi', sanskrit: 'Sanskrit',
      accountancy: 'Accountancy', 'business studies': 'Business Studies',
    };
    return map[raw.toLowerCase()] || raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  }

  identifySubjectFromTitle(title) {
    if (/(physics|mechanics|thermodynamics|optics|waves|electricity|magnetism)/i.test(title)) return 'Physics';
    if (/(chemistry|organic|inorganic|chemical|acids|alkali|mole|bond)/i.test(title))         return 'Chemistry';
    if (/(math|algebra|calculus|polynomial|triangle|circle|quadrilateral|coordinate|statistics|probability|number system|surface area|volume)/i.test(title)) return 'Mathematics';
    if (/(biology|botany|zoology|cell|tissue|organ|ecosystem|genetics)/i.test(title))          return 'Biology';
    if (/(english|literature|grammar|prose|poetry)/i.test(title))                              return 'English';
    if (/(computer|programming|algorithm)/i.test(title))                                        return 'Computer Science';
    if (/(history|geography|civics|economics|political|democratic|resource|disaster)/i.test(title)) return 'Social Science';
    return 'Unknown';
  }
}

// ── CLI interface ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const pdfPath = process.argv[2];
  if (!pdfPath) { console.error('Usage: node pdf-parser.js <path-to-pdf>'); process.exit(1); }

  const parser = new PDFParser();
  parser.parse(pdfPath).then(async result => {
    const out = path.join(__dirname, 'extracted_pdf_questions.json');
    await fs.writeFile(out, JSON.stringify(result, null, 2));
    console.log('\n✅ Done!');
    console.log(`   Chunks:     ${result.stats.total}`);
    console.log(`   Structured: ${result.stats.structured}`);
    console.log(`   Diagrams:   ${result.stats.withDiagrams}`);
    console.log(`   Tables:     ${result.stats.withTables}`);
    console.log(`   Saved to:   ${out}`);
    process.exit(0);
  }).catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
}

module.exports = PDFParser;
