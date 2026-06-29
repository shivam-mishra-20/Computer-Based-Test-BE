import { Request, Response } from 'express';
import { buildPaperHtml } from '../utils/paperExport';
import { htmlToPdfBuffer } from '../utils/launchBrowser';

export const exportTempPdfCtrl = async (req: Request, res: Response) => {
  try {
    const { paper } = req.body;
    if (!paper) return res.status(400).json({ message: 'Paper data required' });

    const html = buildPaperHtml(paper as any, { includeSolutions: true });

    try {
      const pdf = await htmlToPdfBuffer(html);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${(paper.examTitle || 'paper').replace(/[^a-z0-9-_]+/gi, '_')}.pdf"`);
      return res.send(pdf);
    } catch (e: any) {
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
      const { mathJaxReady, convertLatex2Math } = await import('@hungknguyen/docx-math-converter');
      await mathJaxReady();

      const displayRe = /\$\$([\s\S]*?)\$\$/g;
      const inlineRe = /\$([^$]+?)\$/g;
      const paragraphChildrenFromText = (text: string, opts?: { bold?: boolean; italics?: boolean }) => {
        const children: any[] = [];
        const matches: Array<{ start: number; end: number; content: string; display: boolean }> = [];
        let m: RegExpExecArray | null;
        while ((m = displayRe.exec(text)) !== null) matches.push({ start: m.index, end: m.index + m[0].length, content: m[1], display: true });
        while ((m = inlineRe.exec(text)) !== null) if (!matches.some(dm => m!.index >= dm.start && m!.index < dm.end)) matches.push({ start: m.index, end: m.index + m[0].length, content: m[1], display: false });
        matches.sort((a, b) => a.start - b.start);
        let i = 0;
        for (const match of matches) {
          if (i < match.start) {
            const plain = text.slice(i, match.start);
            const parts = plain.split(/(\n)/);
            for (const p of parts) {
              if (p === '\n') children.push(new TextRun({ text: '', break: 1 }));
              else if (p) children.push(new TextRun({ text: p, bold: opts?.bold, italics: opts?.italics }));
            }
          }
          try {
            const mathObj = convertLatex2Math(match.content);
            children.push(mathObj as any);
          } catch {
            children.push(new TextRun({ text: match.content }));
          }
          i = match.end;
        }
        if (i < text.length) {
          const tail = text.slice(i);
          const parts = tail.split(/(\n)/);
          for (const p of parts) {
            if (p === '\n') children.push(new TextRun({ text: '', break: 1 }));
            else if (p) children.push(new TextRun({ text: p, bold: opts?.bold, italics: opts?.italics }));
          }
        }
        return children;
      };
      
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
              children: paragraphChildrenFromText(`${index + 1}. ${instruction}`),
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
              children: paragraphChildrenFromText(section.instructions, { italics: true }),
              spacing: { after: 100 },
            })
          );
        }
        
        // Questions
        section.questions.forEach((question: any, questionIndex: number) => {
          children.push(new Paragraph({ children: [new TextRun({ text: `${questionIndex + 1}. `, bold: true }), ...paragraphChildrenFromText(String(question.text ?? ''))], spacing: { before: 100, after: 50 } }));
          
          // Multiple choice options
          if (question.options && Array.isArray(question.options)) {
            question.options.forEach((option: any, optionIndex: number) => {
              const optionLabel = String.fromCharCode(97 + optionIndex); // a, b, c, d
              children.push(
                new Paragraph({
                  children: [new TextRun({ text: `   ${optionLabel}) ` }), ...paragraphChildrenFromText(String(option.text ?? ''))],
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