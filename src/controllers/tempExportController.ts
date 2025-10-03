import { Request, Response } from 'express';
import { buildPaperHtml } from '../utils/paperExport';

export const exportTempPdfCtrl = async (req: Request, res: Response) => {
  try {
    const { paper } = req.body;
    if (!paper) return res.status(400).json({ message: 'Paper data required' });
    
    const html = buildPaperHtml(paper as any, { includeSolutions: true });
    
    let browser: any;
    try {
      // Try serverless-friendly Chromium first
      try {
        const chromium = await import('@sparticuz/chromium');
        const puppeteerCore = await import('puppeteer-core');
        const executablePath = await chromium.default.executablePath();
        if (executablePath) {
          browser = await puppeteerCore.default.launch({
            args: [...(chromium.default.args || []), '--no-sandbox', '--disable-setuid-sandbox'],
            executablePath,
            headless: true,
          });
        }
      } catch {}

      if (!browser) {
        const puppeteer = await import('puppeteer');
        browser = await puppeteer.default.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
      }

      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({ 
        format: 'A4', 
        printBackground: true, 
        margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' } 
      });
      await browser.close();
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${(paper.examTitle || 'paper').replace(/[^a-z0-9-_]+/gi, '_')}.pdf"`);
      return res.send(pdf);
    } catch (e: any) {
      if (browser) {
        try {
          await browser.close();
        } catch {}
      }
      console.error('exportTempPdfCtrl: PDF generation failed', e);
      return res.status(500).json({ message: 'PDF generation failed. Please try again.' });
    }
  } catch (e: any) {
    res.status(400).json({ message: e.message || 'Failed to export PDF' });
  }
};

export const exportTempDocCtrl = async (req: Request, res: Response) => {
  try {
    const { paper } = req.body;
    if (!paper) return res.status(400).json({ message: 'Paper data required' });
    
    try {
      const { Document, Paragraph, TextRun, Packer, HeadingLevel, AlignmentType, UnderlineType } = await import('docx');
      
      // Create document structure
      const children: any[] = [];
      
      // Title
      children.push(
        new Paragraph({
          children: [new TextRun({ text: paper.examTitle, bold: true, size: 32 })],
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
        })
      );
      
      // Subject
      if (paper.subject) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: `Subject: ${paper.subject}`, bold: true })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 100 },
          })
        );
      }
      
      // Meta information
      const metaInfo: string[] = [];
      if (paper.totalMarks) {
        metaInfo.push(`Total Marks: ${paper.totalMarks}`);
      }
      if (paper.meta?.durationMins) {
        metaInfo.push(`Time: ${paper.meta.durationMins} mins`);
      }
      if (metaInfo.length > 0) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: metaInfo.join(' | '), italics: true })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
          })
        );
      }
      
      // General Instructions
      if (Array.isArray(paper.generalInstructions) && paper.generalInstructions.length > 0) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: 'General Instructions:', bold: true, underline: { type: UnderlineType.SINGLE } })],
            spacing: { after: 100 },
          })
        );
        
        paper.generalInstructions.forEach((instruction: string, index: number) => {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: `${index + 1}. ${instruction}` })],
              spacing: { after: 50 },
            })
          );
        });
        
        children.push(
          new Paragraph({
            children: [new TextRun({ text: '' })],
            spacing: { after: 200 },
          })
        );
      }
      
      // Sections and Questions
      paper.sections.forEach((section: any, sectionIndex: number) => {
        // Section title
        const sectionTitle = section.title + (section.marksPerQuestion ? ` (Marks per Question: ${section.marksPerQuestion})` : '');
        children.push(
          new Paragraph({
            children: [new TextRun({ text: sectionTitle, bold: true, size: 24 })],
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 },
          })
        );
        
        // Section instructions
        if (section.instructions) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: section.instructions, italics: true })],
              spacing: { after: 100 },
            })
          );
        }
        
        // Questions
        section.questions.forEach((question: any, questionIndex: number) => {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: `${questionIndex + 1}. ${question.text}`, bold: true })],
              spacing: { before: 100, after: 50 },
            })
          );
          
          // Multiple choice options
          if (question.options && Array.isArray(question.options)) {
            question.options.forEach((option: any, optionIndex: number) => {
              const optionLabel = String.fromCharCode(97 + optionIndex); // a, b, c, d
              children.push(
                new Paragraph({
                  children: [new TextRun({ text: `   ${optionLabel}) ${option.text}` })],
                  spacing: { after: 25 },
                })
              );
            });
          }
        });
      });
      
      const docx = new Document({
        sections: [
          {
            properties: {},
            children: children,
          },
        ],
      });
      
      const buffer = await Packer.toBuffer(docx);
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${(paper.examTitle || 'paper').replace(/[^a-z0-9-_]+/gi, '_')}.docx"`);
      return res.send(buffer);
      
    } catch (e: any) {
      console.error('exportTempDocCtrl: Word generation failed', e);
      return res.status(500).json({ message: 'Word document generation failed. Please try again.' });
    }
  } catch (e: any) {
    res.status(400).json({ message: e.message || 'Failed to export Word document' });
  }
};