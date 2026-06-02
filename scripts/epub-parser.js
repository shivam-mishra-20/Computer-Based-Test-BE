#!/usr/bin/env node

/**
 * EPUB Question Parser — structure-aware edition.
 *
 * Walks each chapter's DOM in document order, classifies every text block via
 * the shared content-classifier, drops instructional/solution material, groups
 * sub-questions with their parent, and emits blockType-annotated semantic blocks
 * — the SAME shape pdf-parser produces — so EPUBs flow through ai-enhancer's
 * high-quality STRUCTURED path instead of the old generic fallback.
 *
 * Output: { metadata, chapters, questions: blocks[], stats }
 *   where each block = { text, blockType, blockLabel, parentLabel, chapter, topic }
 *
 * Graphics (images/tables) are intentionally NOT extracted — questions are
 * text-only; graphical content is added manually later.
 */

const JSZip = require('jszip');
const fs = require('fs').promises;
const xml2js = require('xml2js');
const cheerio = require('cheerio');
const path = require('path');

const { classifyContentType, IMPORT_BLACKLIST, isQuestionType } = require('./content-classifier');
const { groupSubQuestionBlocks } = require('./sub-question-grouper');

// Max characters packed into one multi-question block before the AI is called.
const PACK_SIZE = parseInt(process.env.EPUB_PACK_SIZE || '1500', 10);

// Leaf block-level tags we treat as text containers (tables excluded on purpose).
const BLOCK_TAGS = new Set(['p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div']);
const HEADER_TYPES = new Set(['chapter_header', 'exercise_header', 'section_header']);

class EPUBParser {
  constructor() {
    // Question text + metadata only. Diagram/image/table extraction is
    // intentionally excluded from the EPUB pipeline.
  }

  async parse(epubPath) {
    console.log('[EPUB Parser] Reading:', epubPath);
    const data = await fs.readFile(epubPath);
    const zip = await JSZip.loadAsync(data);

    const metadata = await this.extractMetadata(zip, epubPath);
    console.log('[EPUB Parser] Metadata:', metadata);

    const chapters = await this.extractChapters(zip);
    console.log(`[EPUB Parser] Found ${chapters.length} chapters`);

    // Classify every chapter into semantic blocks (instructional content dropped,
    // sub-questions grouped). Precision/recall + packing are decided GLOBALLY so
    // page-per-file ("reflowed") EPUBs don't explode into thousands of AI calls.
    const allBlocks = [];
    for (const chapter of chapters) {
      const chapterBlocks = await this.classifyChapter(zip, chapter);
      allBlocks.push(...chapterBlocks);
    }

    // First mark multi-question pages (several numbered Qs in one block) as
    // 'question_group' so the AI extracts ALL of them. Crucially this happens
    // BEFORE sub-part grouping, so a whole page is never mistaken for one
    // multi-part question. We over-detect deliberately: a single question marked
    // question_group still extracts fine, whereas a missed multi-Q page would be
    // mis-grouped into one giant "question".
    for (const b of allBlocks) {
      if (this.isMultiQuestion(b.text)) b.blockType = 'question_group';
    }

    // Group sub-parts only across SINGLE-question blocks (grouper ignores
    // question_group). Then finalize the remaining singles as 'question'.
    const grouped = groupSubQuestionBlocks(allBlocks);
    for (const b of grouped) {
      if (b.blockType === 'question_group' || b.blockType === 'example' || b.hasSubParts) continue;
      b.blockType = 'question';
    }

    // Paginated book? (many chapters, ~1 block each) → ignore chapter boundaries
    // when packing, since the "chapters" are just pages.
    const paginated = chapters.length > 50 && allBlocks.length / Math.max(chapters.length, 1) < 2.5;
    const blocks = this.packBlocks(grouped, PACK_SIZE, { flushOnChapter: !paginated });

    const stats = this.analyzeBlocks(blocks);
    console.log(`[EPUB Parser] ${allBlocks.length} kept blocks (${this.dropped || 0} instructional + ${this.droppedProse || 0} prose dropped) → ${blocks.length} block(s)${paginated ? ' [paginated]' : ''}`);
    console.log(`[EPUB Parser] By type: ${JSON.stringify(stats.byType)}`);

    return { metadata, chapters, questions: blocks, stats };
  }

  // ── Block classification (structure-aware) ──────────────────────────────────

  async classifyChapter(zip, chapter) {
    const htmlFile = zip.file(chapter.src);
    if (!htmlFile) {
      console.warn(`[EPUB Parser] Missing HTML for chapter "${chapter.title}" at ${chapter.src}`);
      return [];
    }

    const html = await htmlFile.async('text');
    const $ = cheerio.load(html);
    const chapterTitle = chapter.title || 'General';

    // 1. Collect leaf text blocks in document order
    const rawTexts = this.collectLeafBlocks($, $('body')[0] || null);
    if (rawTexts.length === 0) {
      const bodyText = $('body').text().replace(/\r/g, '');
      bodyText.split(/\n{2,}/).forEach((p) => {
        const t = p.replace(/\s+/g, ' ').trim();
        if (t.length > 2) rawTexts.push(t);
      });
    }

    // 2. Classify each block + track the governing exercise/section header
    let parentLabel = null;
    const classified = [];
    for (const text of rawTexts) {
      if (text.length < 3) continue;
      const blockType = classifyContentType(text);

      if (HEADER_TYPES.has(blockType)) {
        parentLabel = text.split('\n')[0].trim().slice(0, 80);
        continue; // headers give context only — not imported themselves
      }
      if (IMPORT_BLACKLIST.has(blockType)) {
        this.dropped = (this.dropped || 0) + 1;
        continue; // activity / note / definition / theorem / proof / solution / …
      }

      // Keep questions and any block that carries a question signal; drop pure
      // prose/theory. (Reflowed books bury questions mid-page, so we trust the
      // signal, not just the first line.)
      if (!isQuestionType(blockType) && !this.hasQuestionSignal(text)) {
        this.droppedProse = (this.droppedProse || 0) + 1;
        continue;
      }

      classified.push({
        text,
        blockType,
        blockLabel: text.split('\n')[0].trim().slice(0, 80),
        parentLabel,
        chapter: chapterTitle,
        topic: chapterTitle,
      });
    }

    return classified; // sub-part grouping happens globally in parse()
  }

  // ── Question-signal heuristics ──────────────────────────────────────────────

  // Counts top-level numbered-question starts: "1. " "12) " "10, " "Q.3" …
  // (OCR books use varied delimiters, so we're liberal here.)
  questionMarkerCount(text) {
    const m = String(text || '').match(/(?:^|\s)(?:Q\.?\s*\d{1,3}\b|\d{1,3}[.),](?=\s+\S))/g);
    return m ? m.length : 0;
  }

  /**
   * Does this block hold MULTIPLE questions (so the AI should extract all)?
   * Biased to over-detect: a question bank page packs ~10 MCQs, each ending in
   * an "(d)" option, so ≥2 "(d)" markers is a strong multi-question signal.
   */
  isMultiQuestion(text) {
    if (this.questionMarkerCount(text) >= 2) return true;
    const dOptions = (String(text || '').match(/\(\s*[dD]\s*\)/g) || []).length;
    if (dOptions >= 2) return true;                       // ≥2 MCQ option-sets
    return false;
  }

  // True when a block plausibly contains a question (vs. pure theory/prose).
  hasQuestionSignal(text) {
    const t = String(text || '');
    if (/\?/.test(t)) return true;
    if (this.questionMarkerCount(t) >= 1) return true;
    if (/^\s*(?:solve|find|prove|show|calculate|determine|evaluate|simplify|factori[sz]e|expand|rationali[sz]e|state|define|explain|describe|name|choose|fill|write|express|convert|draw|construct|verify|identify|match|compute|differentiate|integrate)\b/i.test(t)) return true;
    if (/\(\s*a\s*\)[\s\S]*\(\s*b\s*\)/i.test(t)) return true; // (a)…(b) option pair
    if (/_{3,}/.test(t)) return true;                          // fill-in-the-blank
    return false;
  }

  /**
   * Depth-first collection of leaf block-level elements' text, in document order.
   * A "leaf block" is a block tag containing no nested block tags. Tables are
   * skipped (their text is never emitted).
   */
  collectLeafBlocks($, root) {
    const blocks = [];
    if (!root) return blocks;

    const walk = (node) => {
      $(node).contents().each((_, child) => {
        if (child.type !== 'tag') return;
        const tag = (child.name || '').toLowerCase();
        if (tag === 'table' || tag === 'style' || tag === 'script') return; // ignore
        const $child = $(child);
        const hasBlockChildren = $child
          .children()
          .toArray()
          .some((c) => BLOCK_TAGS.has((c.name || '').toLowerCase()) || (c.name || '').toLowerCase() === 'table');

        if (BLOCK_TAGS.has(tag) && !hasBlockChildren) {
          const text = $child.text().replace(/\s+/g, ' ').trim();
          if (text) blocks.push(text);
        } else {
          walk(child);
        }
      });
    };

    walk(root);
    return blocks;
  }

  /**
   * Pack consecutive simple questions into ≤maxChars multi-question blocks
   * (blockType 'question_group'), while keeping examples and multi-part
   * questions as their own single-question blocks to preserve boundaries.
   */
  packBlocks(blocks, maxChars, opts = {}) {
    const { flushOnChapter = true } = opts;
    const out = [];
    let buf = [];
    let bufLen = 0;
    let bufParent = null;

    const flush = () => {
      if (buf.length === 0) return;
      if (buf.length === 1) {
        out.push(buf[0]); // single → keep its own type (one-question extraction)
      } else {
        out.push({
          text: buf.map((b) => b.text).join('\n\n'),
          blockType: 'question_group',
          blockLabel: bufParent || 'Questions',
          parentLabel: bufParent,
          chapter: buf[0].chapter,
          topic: buf[0].topic,
        });
      }
      buf = [];
      bufLen = 0;
    };

    for (const b of blocks) {
      // Standalone: examples, multi-part questions, and multi-question pages
      // (question_group) — each is its own AI call to preserve boundaries / fit
      // the output token budget.
      if (b.blockType === 'example' || b.blockType === 'question_group' || b.hasSubParts) {
        flush();
        out.push(b);
        continue;
      }
      const parentChanged = buf.length > 0 && b.parentLabel !== bufParent;
      const chapterChanged = flushOnChapter && buf.length > 0 && b.chapter !== buf[0].chapter;
      const tooBig = bufLen + b.text.length > maxChars && buf.length > 0;
      if (parentChanged || chapterChanged || tooBig) flush();
      if (buf.length === 0) bufParent = b.parentLabel || null;
      buf.push(b);
      bufLen += b.text.length;
    }
    flush();
    return out;
  }

  analyzeBlocks(blocks) {
    return {
      total: blocks.length,
      byType: blocks.reduce((acc, b) => {
        acc[b.blockType] = (acc[b.blockType] || 0) + 1;
        return acc;
      }, {}),
      // Determined after AI extraction — kept for processing-record compatibility.
      withOptions: 0,
      withCorrectAnswers: 0,
      withDiagrams: 0,
      dropped: this.dropped || 0,
      droppedProse: this.droppedProse || 0,
    };
  }

  // ── Metadata ──────────────────────────────────────────────────────────────

  async extractMetadata(zip, epubPath) {
    try {
      const containerXML = await zip.file('META-INF/container.xml').async('text');
      const container = await xml2js.parseStringPromise(containerXML);
      const contentPath = container.container.rootfiles[0].rootfile[0].$['full-path'];

      const contentOPF = await zip.file(contentPath).async('text');
      const content = await xml2js.parseStringPromise(contentOPF);
      const metadata = content.package.metadata[0];

      const title = metadata['dc:title']?.[0] || path.basename(epubPath, '.epub');
      const metadataSubject = metadata['dc:subject']?.[0];

      return {
        title,
        author: metadata['dc:creator']?.[0] || 'Unknown',
        subject: this.identifySubjectFromTitle(title, metadataSubject),
        language: metadata['dc:language']?.[0] || 'en',
        class: this.extractClassFromTitle(title),
        board: this.extractBoardFromTitle(title),
      };
    } catch (error) {
      console.warn('[EPUB Parser] Failed to extract metadata:', error.message);
      const filename = path.basename(epubPath, '.epub');
      return {
        title: filename,
        author: 'Unknown',
        subject: this.identifySubjectFromTitle(filename, 'Unknown'),
        language: 'en',
        class: this.extractClassFromTitle(filename),
        board: this.extractBoardFromTitle(filename),
      };
    }
  }

  identifySubjectFromTitle(title, metadataSubject) {
    if (metadataSubject && metadataSubject !== 'Unknown' && metadataSubject.length > 2) {
      return metadataSubject;
    }

    const titleLower = title.toLowerCase();
    if (/(physics|mechanics|thermodynamics|electromagnetism|optics|waves)/i.test(titleLower)) return 'Physics';
    if (/(chemistry|organic|inorganic|physical chemistry|chemical)/i.test(titleLower)) return 'Chemistry';
    if (/(mathematics|math|algebra|geometry|calculus|trigonometry|statistics)/i.test(titleLower)) return 'Mathematics';
    if (/(biology|bio|botany|zoology|life science|ecology|genetics)/i.test(titleLower)) return 'Biology';
    if (/(english|literature|grammar|composition)/i.test(titleLower)) return 'English';
    if (/(computer|programming|informatics|coding)/i.test(titleLower)) return 'Computer Science';
    if (/(history|geography|civics|economics|social)/i.test(titleLower)) return 'Social Science';

    console.warn(`[EPUB Parser] Could not identify subject from title: "${title}"`);
    return 'Unknown';
  }

  /**
   * Chapters = the OPF spine (canonical reading order of every content file).
   * The TOC only labels a subset and is often nested, so we read the spine and
   * borrow human-readable titles from toc.ncx where available.
   */
  async extractChapters(zip) {
    try {
      const containerXML = await zip.file('META-INF/container.xml').async('text');
      const container = await xml2js.parseStringPromise(containerXML);
      const opfPath = container.container.rootfiles[0].rootfile[0].$['full-path'];
      const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

      const opf = await xml2js.parseStringPromise(await zip.file(opfPath).async('text'));
      const pkg = opf.package;

      const manifest = {};
      for (const item of pkg.manifest[0].item || []) manifest[item.$.id] = item.$.href;

      const labels = await this.buildTocLabels(zip).catch(() => ({}));

      const chapters = [];
      for (const ref of pkg.spine[0].itemref || []) {
        const href = manifest[ref.$.idref];
        if (!href) continue;
        const src = this.resolvePath(opfDir, href.split('#')[0]);
        if (!/\.(x?html?|xml)$/i.test(src)) continue;
        const base = src.split('/').pop();
        chapters.push({
          title: labels[base] || base.replace(/\.(x?html?|xml)$/i, ''),
          src,
          id: ref.$.idref,
        });
      }
      if (chapters.length > 0) return chapters;
    } catch (error) {
      console.warn('[EPUB Parser] Spine parse failed, scanning all HTML:', error.message);
    }

    // Fallback: scan all HTML files
    const chapters = [];
    zip.forEach((relativePath, file) => {
      if (/\.(x?html?|xml)$/i.test(relativePath) &&
          !relativePath.includes('toc.') &&
          !relativePath.includes('nav.') &&
          !file.dir) {
        chapters.push({
          title: relativePath.split('/').pop().replace(/\.(x?html?|xml)$/i, ''),
          src: relativePath,
          id: relativePath,
        });
      }
    });
    return chapters;
  }

  /** Map content-file basename → navLabel text from toc.ncx (best effort). */
  async buildTocLabels(zip) {
    const tocFile = zip.file(/toc\.ncx$/i)[0];
    if (!tocFile) return {};
    const toc = await xml2js.parseStringPromise(await tocFile.async('text'));
    const labels = {};
    const walk = (points) => {
      for (const p of points || []) {
        try {
          const label = p.navLabel[0].text[0];
          const src = (p.content[0].$.src || '').split('#')[0];
          if (src && label) labels[src.split('/').pop()] = label.trim();
        } catch { /* skip malformed navPoint */ }
        if (p.navPoint) walk(p.navPoint);
      }
    };
    walk(toc.ncx.navMap[0].navPoint);
    return labels;
  }

  /** Resolve an OPF-relative href to an in-zip path, collapsing ./ and ../ */
  resolvePath(dir, href) {
    const stack = [];
    for (const part of (dir + href).split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return stack.join('/');
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
    const lower = title.toLowerCase();
    if (/ncert/i.test(lower)) return 'NCERT';
    if (/cbse/i.test(lower)) return 'CBSE';
    if (/jee/i.test(lower)) return 'JEE';
    if (/neet/i.test(lower)) return 'NEET';
    return 'CBSE';
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const parser = new EPUBParser();
  const epubPath = process.argv[2];
  if (!epubPath) {
    console.error('Usage: node epub-parser.js <path-to-epub-file>');
    process.exit(1);
  }

  try {
    const result = await parser.parse(epubPath);
    const outputPath = path.join(__dirname, 'extracted_questions.json');
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2));

    console.log('\n✅ Extraction Complete!');
    console.log('═══════════════════════════════════════');
    console.log(`📚 Book: ${result.metadata.title}`);
    console.log(`✍️  Author: ${result.metadata.author}`);
    console.log(`📖 Subject: ${result.metadata.subject}`);
    console.log(`📝 Chapters: ${result.chapters.length}`);
    console.log(`🧱 Blocks: ${result.stats.total}`);
    console.log(`   By type: ${JSON.stringify(result.stats.byType)}`);
    console.log(`   Dropped (instructional/solution): ${result.stats.dropped}`);
    console.log(`💾 Saved to: ${outputPath}`);
    console.log('═══════════════════════════════════════\n');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = EPUBParser;
