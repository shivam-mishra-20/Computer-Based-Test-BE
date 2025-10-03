import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import type { Types } from 'mongoose';
import type { Difficulty, IQuestion, QuestionType } from '../models/Question';
import Guidance from '../models/Guidance';

dotenv.config();

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Lazy singletons
let genAI: GoogleGenerativeAI | null = null;
let groqClient: Groq | null = null;

function getGemini() {
  if (!GOOGLE_API_KEY) return null;
  if (!genAI) genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
  return genAI;
}

function getGroq() {
  if (!GROQ_API_KEY) return null;
  if (!groqClient) groqClient = new Groq({ apiKey: GROQ_API_KEY });
  return groqClient;
}

export type GenerateOptions = {
  subject?: string;
  topic?: string;
  difficulty?: Difficulty;
  count?: number; // number of questions to generate
  types?: QuestionType[]; // preferred types
  createdBy?: Types.ObjectId;
};

export interface PaperBlueprintSection {
  title: string; // e.g., 'Section A'
  instructions?: string;
  marksPerQuestion?: number;
  questionCounts: Partial<Record<QuestionType, number>>; // counts per type
  difficultyDistribution?: { easy?: number; medium?: number; hard?: number }; // percentages summing ~100
}

export interface PaperBlueprint {
  subject?: string;
  examTitle: string;
  totalMarks?: number; // optional; can be computed
  generalInstructions?: string[];
  sections: PaperBlueprintSection[];
}

export interface GeneratedPaperSection extends PaperBlueprintSection {
  questions: Partial<IQuestion>[];
}

export interface GeneratedPaperResult {
  examTitle: string;
  subject?: string;
  totalMarks: number;
  generalInstructions: string[];
  sections: GeneratedPaperSection[];
}

export async function generateSolutionsForPaper(paper: GeneratedPaperResult): Promise<{
  sections: { title: string; solutions: { solutionText: string }[] }[];
}> {
  const g = getGemini();
  if (!g) throw new Error('Gemini API key not configured');
  const model = g.getGenerativeModel({ model: 'gemini-2.5-pro' });
  const sections: { title: string; solutions: { solutionText: string }[] }[] = [];
  for (const sec of paper.sections) {
    const questionsText = sec.questions
      .map((q, i) => {
        const base = `${i + 1}. ${q.text}`;
        if (q.type === 'mcq' && Array.isArray(q.options)) {
          const opts = q.options
            .map((o, idx) => `${String.fromCharCode(65 + idx)}. ${o.text}`)
            .join('\n');
          return `${base}\n${opts}`;
        }
        if (q.type === 'assertionreason') {
          return `${base}\nAssertion: ${q.assertion}\nReason: ${q.reason}`;
        }
        return base;
      })
      .join('\n\n');
    const prompt = `Provide concise, step-by-step model solutions for the following exam questions. Keep each solution focused, accurate, and avoid unnecessary verbosity. Where relevant, show key formulas or reasoning. Return STRICT JSON ONLY with schema: { "solutions": [{ "solutionText": string }] } and ensure the number of solutions equals the number of questions in order.
Exam: ${paper.examTitle} ${paper.subject ? `\nSubject: ${paper.subject}` : ''}
Section: ${sec.title}${sec.instructions ? `\nInstructions: ${sec.instructions}` : ''}

QUESTIONS:\n${questionsText}`;
    const result = await model.generateContent(prompt);
    const raw = result.response.text();
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('Failed to parse solutions JSON');
      parsed = JSON.parse(m[0]);
    }
    const sols = Array.isArray(parsed?.solutions)
      ? parsed.solutions.map((s: any) => ({ solutionText: String(s.solutionText || '').slice(0, 4000) }))
      : [];
    // if model returned wrong count, pad or trim
    const count = sec.questions.length;
    let adjusted = sols.slice(0, count);
    if (adjusted.length < count) {
      adjusted = adjusted.concat(Array.from({ length: count - adjusted.length }, () => ({ solutionText: 'Solution forthcoming.' })));
    }
    sections.push({ title: sec.title, solutions: adjusted });
  }
  return { sections };
}

export async function extractTextFromPdf(buffer: Buffer, useVision = false): Promise<string> {
  // Try advanced extraction with Gemini Vision if enabled
  if (useVision) {
    try {
      const g = getGemini();
      if (g) {
        const model = g.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
        const base64Pdf = buffer.toString('base64');
        
        const prompt = `Extract ALL text content from this PDF document with HIGH ACCURACY.
        
CRITICAL INSTRUCTIONS:
- Preserve exact formatting, line breaks, and structure
- Maintain question numbering and organization
- Keep mathematical expressions intact (preserve symbols, equations, formulas)
- Note locations of diagrams/figures with placeholders like [DIAGRAM: description]
- Preserve tables and their structure
- Do NOT paraphrase or summarize - extract verbatim
- Include section headers, instructions, and all metadata

Return ONLY the extracted text, nothing else.`;

        const result = await model.generateContent([
          {
            inlineData: {
              mimeType: 'application/pdf',
              data: base64Pdf,
            },
          },
          { text: prompt },
        ]);
        
        const extractedText = result.response.text();
        if (extractedText && extractedText.length > 100) {
          console.log('✓ Used Gemini Vision for PDF text extraction');
          return extractedText.slice(0, 200_000);
        }
      }
    } catch (visionErr) {
      console.warn('Gemini Vision extraction failed, falling back to pdf-parse:', visionErr);
    }
  }
  
  // Fallback to traditional pdf-parse
  try {
    const pdfParse = (await import('pdf-parse')).default as any;
    const data = await pdfParse(buffer);
    return String(data.text || '').slice(0, 200_000);
  } catch (err) {
    console.warn('pdf-parse not available or failed:', err);
    throw new Error('PDF parsing failed. Ensure pdf-parse is installed.');
  }
}

// OCR: extract text from images using Gemini Vision (preferred) or Tesseract.js fallback
export async function extractTextFromImage(buffer: Buffer, useVision = true): Promise<string> {
  // Try Gemini Vision first for better accuracy with mathematical content and diagrams
  if (useVision) {
    try {
      const g = getGemini();
      if (g) {
        const model = g.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
        
        // Detect mime type
        const sharp = await import('sharp');
        const metadata = await sharp.default(buffer).metadata();
        const format = metadata.format || 'png';
        const mimeMap: Record<string, string> = {
          jpeg: 'image/jpeg',
          jpg: 'image/jpeg',
          png: 'image/png',
          webp: 'image/webp',
        };
        const mimeType = mimeMap[format] || 'image/png';
        
        const base64Image = buffer.toString('base64');
        
        const prompt = `Extract ALL text content from this image with MAXIMUM ACCURACY.

CRITICAL INSTRUCTIONS:
- Extract text EXACTLY as it appears (verbatim)
- Preserve question numbers, options (A, B, C, D), and structure
- Maintain mathematical expressions, equations, and formulas precisely
- Include special characters, symbols, and notations
- Note diagrams/figures with placeholders: [DIAGRAM: brief description]
- Preserve formatting, indentation, and line breaks
- Include headers, instructions, and all visible text
- Do NOT paraphrase, interpret, or summarize

Return ONLY the extracted text, nothing else.`;

        const result = await model.generateContent([
          {
            inlineData: {
              mimeType,
              data: base64Image,
            },
          },
          { text: prompt },
        ]);
        
        const extractedText = result.response.text();
        if (extractedText && extractedText.length > 50) {
          console.log('✓ Used Gemini Vision for image OCR');
          return extractedText.slice(0, 200_000);
        }
      }
    } catch (visionErr) {
      console.warn('Gemini Vision OCR failed, falling back to Tesseract:', visionErr);
    }
  }
  
  // Fallback to Tesseract.js
  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng');
    try {
      const { data } = await worker.recognize(buffer as any);
      await worker.terminate();
      return String(data?.text || '').slice(0, 200_000);
    } catch (e) {
      try { await worker.terminate(); } catch {}
      throw e;
    }
  } catch (err) {
    console.warn('tesseract.js OCR failed or not installed:', err);
    throw new Error('OCR failed. Ensure tesseract.js is installed.');
  }
}

export async function getGuidanceText(subject?: string, topic?: string): Promise<string | null> {
  const queries: any[] = [];
  if (subject && topic) queries.push({ subject, topic, isActive: true });
  if (subject) queries.push({ subject, isActive: true });
  queries.push({ isActive: true });
  for (const q of queries) {
    const g = await Guidance.findOne(q).sort({ updatedAt: -1 }).lean();
    if (g?.instructions) return String(g.instructions);
  }
  return null;
}

function buildQuestionGenPrompt(text: string, opts: GenerateOptions & { 
  isQuestionPaper?: boolean; 
  hasDiagrams?: boolean;
  diagramDescriptions?: string[];
}) {
  const count = Math.min(Math.max(opts.count ?? 10, 1), 50);
  const types = opts.types?.join(', ') || 'mcq, truefalse, fill, short, long, assertionreason, integer';
  const difficulty = opts.difficulty ?? 'medium';
  const subject = opts.subject ? `Subject: ${opts.subject}\n` : '';
  const topic = opts.topic ? `Topic: ${opts.topic}\n` : '';
  
  const recreationMode = opts.isQuestionPaper 
    ? `
⚠️ RECREATION MODE: This appears to be an existing question paper.
CRITICAL INSTRUCTIONS:
- RECREATE questions EXACTLY as they appear in the source
- Preserve original question numbering and structure
- Maintain exact wording and phrasing
- Keep all diagrams references intact (mention "See diagram" if referenced)
- Do NOT paraphrase or simplify - copy verbatim
- Match original difficulty level precisely`
    : `
GENERATION MODE: Create original questions based on the study material provided.
- Generate new, high-quality exam questions
- Ensure questions test key concepts comprehensively`;

  const diagramInstructions = opts.hasDiagrams 
    ? `
📊 DIAGRAM HANDLING:
- Questions may reference diagrams/figures/charts
- Include diagram references in question text (e.g., "Refer to the diagram above")
- Add "diagramRequired: true" flag in question JSON if diagram is essential
- Available diagram descriptions: ${opts.diagramDescriptions?.join('; ') || 'See extracted diagrams'}`
    : '';

  const mathInstructions = `
🔢 PROFESSIONAL MATHEMATICAL NOTATION - MANDATORY LaTeX FORMATTING:

⚠️ CRITICAL RULE: ALL mathematical expressions MUST be wrapped in LaTeX delimiters.
❌ WRONG: "x^2", "1/2", "sqrt(x)", "integral", "sin(x)", "e^x"
✅ CORRECT: "$x^2$", "$\\frac{1}{2}$", "$\\sqrt{x}$", "$\\int$", "$\\sin(x)$", "$e^x$"

📐 INLINE MATH (use single $...$ for expressions within sentences):
Examples:
- "Solve $x^2 + 5x + 6 = 0$" ✅
- "Find $\\int (1 - x)\\, dx$" ✅
- "If $\\cos^2(x) = \\frac{1}{2}$, find $x$" ✅
- "Evaluate $(2x - 3\\cos(x) + e^{\\wedge}x)$" ✅ (note: use e^x not e^\\wedge x)
- "Integrate $(\\log x)^2 / x$" → "$\\int \\frac{(\\ln x)^2}{x}\\, dx$" ✅

📊 DISPLAY MATH (use double $$...$$ for standalone equations):
Examples:
- "Solve: $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$" ✅
- "Evaluate: $$\\int_0^{\\pi} \\sin(x)\\, dx$$" ✅

📚 COMPREHENSIVE LATEX REFERENCE:

1. BASIC OPERATIONS:
   - Powers: $x^2$, $x^{10}$, $x^{2n}$ (use braces for multi-character exponents)
   - Subscripts: $x_1$, $x_{10}$, $a_{ij}$
   - Fractions: $\\frac{a}{b}$, $\\frac{x^2 + 1}{x - 1}$
   - Square roots: $\\sqrt{x}$, $\\sqrt{x^2 + y^2}$, $\\sqrt[3]{x}$ (cube root)
   - Absolute value: $|x|$, $|-3|$

2. GREEK LETTERS:
   Lowercase: $\\alpha$, $\\beta$, $\\gamma$, $\\delta$, $\\epsilon$, $\\theta$, $\\lambda$, $\\mu$, $\\pi$, $\\sigma$, $\\tau$, $\\phi$, $\\omega$
   Uppercase: $\\Gamma$, $\\Delta$, $\\Theta$, $\\Lambda$, $\\Sigma$, $\\Phi$, $\\Omega$

3. TRIGONOMETRIC FUNCTIONS:
   $\\sin(x)$, $\\cos(x)$, $\\tan(x)$, $\\cot(x)$, $\\sec(x)$, $\\csc(x)$
   $\\sin^2(x)$ (sin squared), $\\cos^{-1}(x)$ (inverse cosine)

4. LOGARITHMS & EXPONENTIALS:
   $\\log(x)$, $\\ln(x)$, $\\log_{10}(x)$, $e^x$, $e^{-x}$, $2^n$

5. CALCULUS:
   - Integrals: $\\int f(x)\\, dx$, $\\int_a^b f(x)\\, dx$, $\\iint$, $\\iiint$
   - Derivatives: $\\frac{dy}{dx}$, $\\frac{d^2y}{dx^2}$, $f'(x)$, $f''(x)$
   - Partial derivatives: $\\frac{\\partial f}{\\partial x}$
   - Limits: $\\lim_{x \\to 0} f(x)$, $\\lim_{x \\to \\infty}$

6. SUMMATIONS & PRODUCTS:
   $\\sum_{i=1}^{n} a_i$, $\\prod_{i=1}^{n} x_i$

7. INEQUALITIES & RELATIONS:
   $\\leq$ (≤), $\\geq$ (≥), $\\neq$ (≠), $\\approx$ (≈), $\\equiv$ (≡), $<$, $>$

8. SET THEORY & LOGIC:
   $\\in$ (∈), $\\notin$ (∉), $\\cup$ (∪), $\\cap$ (∩), $\\subset$ (⊂), $\\subseteq$ (⊆)
   $\\forall$ (∀), $\\exists$ (∃), $\\emptyset$ (∅)

9. SPECIAL SYMBOLS:
   $\\pm$ (±), $\\mp$ (∓), $\\times$ (×), $\\div$ (÷), $\\cdot$ (·)
   $\\infty$ (∞), $\\therefore$ (∴), $\\because$ (∵)

10. MATRICES & VECTORS:
    $$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$
    $\\vec{v}$, $\\mathbf{A}$ (bold for matrices)

11. PARENTHESES (auto-sizing):
    $\\left( \\frac{a}{b} \\right)$, $\\left[ x^2 \\right]$, $\\left\\{ y \\right\\}$

CRITICAL POWER NOTATION RULES:
⚠️ DO NOT wrap variables with powers in extra parentheses
❌ WRONG: "(log x)^2", "(x)^2", "(1+x)^2" when x is the only variable
✅ CORRECT: "(\\log x)^2" → "$(\ln x)^2$" OR better "$\ln^2(x)$"
✅ CORRECT: "x^2" → "$x^2$" (no parentheses around x)
✅ CORRECT: "(1+x)^2" → "$(1+x)^2$" (parentheses needed for expression)

SPECIFIC POWER EXAMPLES:
✅ "$x^2$" not "$(x)^2$"
✅ "$e^x$" not "$(e)^x$"
✅ "$\ln(x)$" not "log x"
✅ "$\sqrt{x^2+4x+10}$" (powers inside roots)
✅ "$\sin^2(x)$" not "$(\sin(x))^2$"
✅ "$\cos^3(x)$" not "$(\cos(x))^3$"
✅ "$(5x+3)$" (parentheses for expressions, not single variables)

CONVERSION EXAMPLES (Plain → LaTeX) - EXACT PATTERNS FROM USER QUESTIONS:
❌ "Find ∫ x (log x)^2 dx" → ✅ "Find $\\int x (\ln x)^2\\, dx$"
❌ "Find ∫ (s g^x) / (1+x)^2 dx" → ✅ "Find $\\int \\frac{e^x}{(1+x)^2}\\, dx$"
❌ "Integrate (3x+5) / (x^3 - x^2 - x + 1)" → ✅ "Integrate $\\frac{3x+5}{x^3 - x^2 - x + 1}$"
❌ "Integrate e^(3 log x) * (x^4 + 1)^(-1)" → ✅ "Integrate $\\frac{e^{3\ln x}}{x^4 + 1}$" OR "$\\frac{x^3}{x^4 + 1}$"
❌ "Evaluate ∫_0^π (x dx) / (1 + sin x)" → ✅ "Evaluate $\\int_0^{\\pi} \\frac{x\\, dx}{1 + \\sin x}$"
❌ "Evaluate ∫ dx / (cos(x-a)cos(x-b))" → ✅ "Evaluate $\\int \\frac{dx}{\\cos(x-a)\\cos(x-b)}$"
❌ "Integrate sin^3(x) cos^3(x)" → ✅ "Integrate $\\sin^3(x) \\cos^3(x)$"
❌ "Integrate tan^4(x)" → ✅ "Integrate $\\tan^4(x)$"
❌ "Integrate (sin^3(x) + cos^3(x)) / (sin^2(x) cos^2(x))" → ✅ "Integrate $\\frac{\\sin^3(x) + \\cos^3(x)}{\\sin^2(x) \\cos^2(x)}$"
❌ "Integrate cos(2x) / (cos x + sin x)^2" → ✅ "Integrate $\\frac{\\cos(2x)}{(\\cos x + \\sin x)^2}$"
❌ "Evaluate ∫_0^(a) (sqrt(x) dx) / (sqrt(x) + sqrt(a-x))" → ✅ "Evaluate $\\int_0^a \\frac{\\sqrt{x}\\, dx}{\\sqrt{x} + \\sqrt{a-x}}$"
❌ "Find ∫ (dx) / (x(x^n + 1))" → ✅ "Find $\\int \\frac{dx}{x(x^n + 1)}$"
❌ "Evaluate ∫_{-π/2}^{π/2} sin^7(x) dx" → ✅ "Evaluate $\\int_{-\\pi/2}^{\\pi/2} \\sin^7(x)\\, dx$"
❌ "Find the integral of (x^4 + 1) / (x^2 + 1)" → ✅ "Find the integral of $\\frac{x^4 + 1}{x^2 + 1}$"
❌ "Evaluate ∫_1^e (log x) / x dx" → ✅ "Evaluate $\\int_1^e \\frac{\\ln x}{x}\\, dx$"
❌ "Find ∫ dx / (e^x + e^(-x))" → ✅ "Find $\\int \\frac{dx}{e^x + e^{-x}}$"
❌ "Find ∫_0^4 |x-1| dx" → ✅ "Find $\\int_0^4 |x-1|\\, dx$"
❌ "Prove ∫_a^b f(x) dx = ∫_a^b f(a+b-x) dx" → ✅ "Prove $\\int_a^b f(x)\\, dx = \\int_a^b f(a+b-x)\\, dx$"

⚠️ MANDATORY RULES:
1. No extra parentheses around single variables with powers: $x^2$ not $(x)^2$
2. Use \\ln for natural log, not log
3. Use \\frac{}{} for ALL fractions, never /
4. Powers of trig functions: $\\sin^2(x)$ not $(\\sin(x))^2$
5. Proper spacing: \\, before dx in integrals
6. Clean, minimal notation - avoid unnecessary symbols

⚠️ FINAL CHECK: Review every question and ensure NO plain text math remains and NO extra parentheses!`;

  return `You are an expert exam setter specializing in creating professional, high-quality questions.
${recreationMode}
${subject}${topic}Difficulty: ${difficulty}
Allowed types: ${types}
Number of questions: ${count}

${mathInstructions}
${diagramInstructions}

Return STRICT JSON with this schema:
{
  "questions": [
    {
      "text": string (with LaTeX math formatting),
      "type": "mcq"|"truefalse"|"fill"|"short"|"long"|"assertionreason"|"integer",
      "options": [{ "text": string, "isCorrect": boolean }] | null,
      "correctAnswerText": string | null,
      "integerAnswer": number | null,
      "assertion": string | null,
      "reason": string | null,
      "assertionIsTrue": boolean | null,
      "reasonIsTrue": boolean | null,
      "reasonExplainsAssertion": boolean | null,
      "diagramRequired": boolean | null,
      "diagramReference": string | null (description of which diagram),
      "tags": { "subject"?: string, "topic"?: string, "difficulty"?: "easy"|"medium"|"hard" },
      "explanation": string | null (with LaTeX if needed)
    }
  ]
}

📝 PERFECT EXAMPLES (Copy this formatting exactly):

Example 1 - Calculus MCQ:
{
  "text": "Find $\\\\int (1 - x)\\\\, dx$",
  "type": "mcq",
  "options": [
    { "text": "$x - \\\\frac{x^2}{2} + C$", "isCorrect": true },
    { "text": "$1 - \\\\frac{x^2}{2} + C$", "isCorrect": false },
    { "text": "$-x + C$", "isCorrect": false },
    { "text": "$x^2 - x + C$", "isCorrect": false }
  ],
  "correctAnswerText": "$x - \\\\frac{x^2}{2} + C$",
  "explanation": "Using the power rule: $\\\\int (1 - x)\\\\, dx = \\\\int 1\\\\, dx - \\\\int x\\\\, dx = x - \\\\frac{x^2}{2} + C$"
}

Example 2 - Trigonometry Integral:
{
  "text": "Evaluate $\\\\int \\\\cos^2(x)\\\\, dx$ using a trigonometric identity.",
  "type": "short",
  "options": null,
  "correctAnswerText": "Using $\\\\cos^2(x) = \\\\frac{1 + \\\\cos(2x)}{2}$, we get $\\\\int \\\\cos^2(x)\\\\, dx = \\\\frac{x}{2} + \\\\frac{\\\\sin(2x)}{4} + C$",
  "explanation": "Apply the double angle identity: $\\\\cos(2x) = 2\\\\cos^2(x) - 1$, so $\\\\cos^2(x) = \\\\frac{1 + \\\\cos(2x)}{2}$"
}

Example 3 - Complex Expression:
{
  "text": "Evaluate $\\\\int (2x - 3\\\\cos(x) + e^x)\\\\, dx$",
  "type": "mcq",
  "options": [
    { "text": "$x^2 - 3\\\\sin(x) + e^x + C$", "isCorrect": true },
    { "text": "$x^2 + 3\\\\sin(x) + e^x + C$", "isCorrect": false },
    { "text": "$2x^2 - 3\\\\sin(x) + e^x + C$", "isCorrect": false },
    { "text": "$x^2 - 3\\\\cos(x) + e^x + C$", "isCorrect": false }
  ]
}

Example 4 - Logarithm Integration:
{
  "text": "Integrate $\\\\frac{(\\\\ln x)^2}{x}$",
  "type": "short",
  "correctAnswerText": "Let $u = \\\\ln x$, then $du = \\\\frac{1}{x}\\\\, dx$. Therefore $\\\\int \\\\frac{(\\\\ln x)^2}{x}\\\\, dx = \\\\int u^2\\\\, du = \\\\frac{u^3}{3} + C = \\\\frac{(\\\\ln x)^3}{3} + C$"
}

Example 5 - Inverse Trig:
{
  "text": "If $\\\\cos^{-1}(x) = \\\\frac{\\\\pi}{3}$, find the value of $x$.",
  "type": "mcq",
  "options": [
    { "text": "$\\\\frac{1}{2}$", "isCorrect": true },
    { "text": "$\\\\frac{\\\\sqrt{3}}{2}$", "isCorrect": false },
    { "text": "$\\\\frac{1}{\\\\sqrt{2}}$", "isCorrect": false },
    { "text": "$1$", "isCorrect": false }
  ]
}

QUESTION QUALITY REQUIREMENTS:
✓ MCQs: Include 4 options with exactly one correct
✓ True/False: Options can be omitted; correctAnswerText should be "true" or "false"
✓ Fill in blanks: Provide correctAnswerText with keywords
✓ Short/Long: Provide comprehensive reference answer in correctAnswerText
✓ Integer: Include integerAnswer (number) AND correctAnswerText (string representation)
✓ Assertion-Reason: Provide assertion, reason, and all three boolean flags
✓ All math MUST be in LaTeX format
✓ Preserve exact wording if recreating from question paper
✓ Do NOT include markdown code blocks, only raw JSON

ADMIN GUIDANCE (follow strictly):
${(opts as any).__guidance || 'N/A'}

SOURCE CONTENT:
"""
${text}
"""`;
}

function buildPaperGenPrompt(source: string, blueprint: PaperBlueprint) {
  const subject = blueprint.subject ? `Subject: ${blueprint.subject}` : '';
  const instructionsList = (blueprint.generalInstructions || [
    'All questions are compulsory unless specified.',
    'Read each question carefully and allocate time wisely.',
  ]).slice(0, 12);
  const sections = blueprint.sections
    .map((s, idx) => {
      const diff = s.difficultyDistribution || {};
      const diffLine = diff ? `Difficulty% (approx): easy:${diff.easy ?? 0}, medium:${diff.medium ?? 0}, hard:${diff.hard ?? 0}` : '';
      return `Section ${idx + 1}: ${s.title}
Instructions: ${s.instructions || 'N/A'}
MarksPerQuestion: ${s.marksPerQuestion || 'variable'}
QuestionCounts: ${JSON.stringify(s.questionCounts)}
${diffLine}`;
    })
    .join('\n\n');
  return `You are an expert exam paper setter tasked with generating a professional, well-structured question paper similar in style to national competitive exams (e.g., JEE / NEET) based ONLY on the provided study material.

${subject}
Exam Title: ${blueprint.examTitle}

GLOBAL INSTRUCTIONS (include & refine, keep concise):
${instructionsList.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

SECTIONS BLUEPRINT:
${sections}

QUESTION TYPE DEFINITIONS:
mcq: Multiple Choice with 4 options exactly and one correct.
truefalse: Statement with answer true or false.
fill: Fill in the blank (provide answer keywords in correctAnswerText).
short: Short answer (2-4 lines reference answer in correctAnswerText).
long: Long/Descriptive (concise model answer in correctAnswerText; may include key points only).
assertionreason: Provide 'assertion' and 'reason'. Also boolean flags assertionIsTrue, reasonIsTrue, reasonExplainsAssertion. Provide combined explanation.
integer: Single correct integer value answer (store in integerAnswer AND also string in correctAnswerText for redundancy).

Return STRICT JSON ONLY with this schema (no extra commentary):
{
  "examTitle": string,
  "subject": string | null,
  "generalInstructions": string[],
  "sections": [
    {
      "title": string,
      "instructions": string | null,
      "marksPerQuestion": number | null,
      "questions": [
        {
          "text": string,
          "type": "mcq"|"truefalse"|"fill"|"short"|"long"|"assertionreason"|"integer",
          "options": [{"text": string, "isCorrect": boolean}] | null,
          "correctAnswerText": string | null,
          "integerAnswer": number | null,
          "assertion": string | null,
          "reason": string | null,
          "assertionIsTrue": boolean | null,
          "reasonIsTrue": boolean | null,
          "reasonExplainsAssertion": boolean | null,
          "tags": {"difficulty": "easy"|"medium"|"hard"},
          "explanation": string | null
        }
      ]
    }
  ]
}

ADMIN GUIDANCE (if any) to follow strictly:
${(blueprint as any).__guidance || 'N/A'}

Rules:
- Respect requested counts per type; if insufficient material, approximate & note in explanation.
- Maintain difficulty distribution per section within reasonable bounds.
- Keep each question concise and unambiguous.
- Do NOT fabricate figures or overly niche trivia absent from source.
- MCQ distractors must be plausible.
- Output valid JSON only (no backticks, no markdown).

SOURCE MATERIAL (truncate if huge):\n"""\n${source.slice(0, 120_000)}\n"""`;
}

export async function generatePaperFromTextGemini(source: string, blueprint: PaperBlueprint): Promise<GeneratedPaperResult> {
  const g = getGemini();
  if (!g) throw new Error('Gemini API key not configured');
  const model = g.getGenerativeModel({ model: 'gemini-2.5-pro' });
  const prompt = buildPaperGenPrompt(source, blueprint);
  const result = await model.generateContent(prompt);
  const raw = result.response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Failed to parse paper JSON');
    parsed = JSON.parse(match[0]);
  }
  if (!parsed.sections || !Array.isArray(parsed.sections)) throw new Error('Malformed paper JSON');
  const sections: GeneratedPaperSection[] = parsed.sections.map((s: any) => {
    const questions: Partial<IQuestion>[] = Array.isArray(s.questions)
      ? s.questions.map((q: any) => ({
          text: String(q.text || '').trim(),
          type: (['mcq','truefalse','fill','short','long','assertionreason','integer'].includes(q.type) ? q.type : 'mcq') as QuestionType,
          options: Array.isArray(q.options)
            ? q.options.slice(0, 6).map((o: any) => ({ text: String(o.text || ''), isCorrect: !!o.isCorrect }))
            : undefined,
          correctAnswerText: q.correctAnswerText ? String(q.correctAnswerText) : undefined,
          integerAnswer: q.integerAnswer !== undefined ? Number(q.integerAnswer) : undefined,
          assertion: q.assertion ? String(q.assertion) : undefined,
          reason: q.reason ? String(q.reason) : undefined,
            assertionIsTrue: typeof q.assertionIsTrue === 'boolean' ? q.assertionIsTrue : undefined,
            reasonIsTrue: typeof q.reasonIsTrue === 'boolean' ? q.reasonIsTrue : undefined,
            reasonExplainsAssertion: typeof q.reasonExplainsAssertion === 'boolean' ? q.reasonExplainsAssertion : undefined,
          tags: { difficulty: (q.tags?.difficulty as Difficulty) || 'medium' },
          explanation: q.explanation ? String(q.explanation) : undefined,
        }))
      : [];
    return {
      title: String(s.title || 'Section'),
      instructions: s.instructions ? String(s.instructions) : undefined,
      marksPerQuestion: s.marksPerQuestion ? Number(s.marksPerQuestion) : undefined,
      questionCounts: {},
      questions,
    } as GeneratedPaperSection;
  });
  const totalMarks = sections.reduce((sum, sec) => sum + sec.questions.length * (sec.marksPerQuestion || 1), 0);
  return {
    examTitle: parsed.examTitle || blueprint.examTitle,
    subject: parsed.subject || blueprint.subject,
    totalMarks,
    generalInstructions: Array.isArray(parsed.generalInstructions) ? parsed.generalInstructions.map((x: any) => String(x)).slice(0, 25) : [],
    sections,
  };
}

// Enforce the blueprint by topping up missing questions per section and type.
async function enforceBlueprintOnSections(
  source: string,
  blueprint: PaperBlueprint,
  initial: GeneratedPaperSection[],
  guidance?: string | null,
): Promise<GeneratedPaperSection[]> {
  const sections: GeneratedPaperSection[] = [];
  // Support English-specific pseudo types
  const englishMap = (key: string): { baseType: QuestionType; formatHint?: string } => {
    switch (key) {
      case 'english:letter-formal':
        return { baseType: 'long', formatHint: 'Formal letter format: sender address, date, receiver address, subject, salutation, body (3-4 paragraphs), complimentary close, signature.' };
      case 'english:letter-informal':
        return { baseType: 'long', formatHint: 'Informal letter format: date, salutation, conversational body (2-3 paragraphs), closing and name.' };
      case 'english:story':
        return { baseType: 'long', formatHint: 'Story writing: clear plot with beginning, conflict, resolution; maintain tense consistency; include title.' };
      case 'english:essay':
        return { baseType: 'long', formatHint: 'Essay writing: introduction, 2-3 body paragraphs, conclusion; maintain coherence and word limit guidance if provided.' };
      case 'english:diary':
        return { baseType: 'short', formatHint: 'Diary entry: date/day, salutation (optional), body in first person reflecting feelings/events, closing/signature.' };
      case 'english:advertisement':
        return { baseType: 'short', formatHint: 'Advertisement: catchy headline, body with key details (what, where, when, contact), concise; use persuasive language.' };
      case 'english:notice':
        return { baseType: 'short', formatHint: 'Notice writing: heading NOTICE, date, subject, body with essential information (what, when, where), signature/name/designation.' };
      case 'english:unseen-passage':
        return { baseType: 'short', formatHint: 'Unseen passage comprehension: include a short passage (4-6 lines) within the question text and ask a question requiring a brief answer.' };
      case 'english:unseen-poem':
        return { baseType: 'short', formatHint: 'Unseen poem comprehension: include a short 3-5 line poem within the question text and ask a question on theme or literary device requiring a brief answer.' };
      default:
        return { baseType: 'long' } as any;
    }
  };

  for (let sIdx = 0; sIdx < blueprint.sections.length; sIdx++) {
    const bp = blueprint.sections[sIdx];
    const current = initial[sIdx] || ({ title: bp.title, instructions: bp.instructions, marksPerQuestion: bp.marksPerQuestion, questionCounts: {}, difficultyDistribution: bp.difficultyDistribution, questions: [] } as GeneratedPaperSection);

    const requestedKeys = Object.keys(bp.questionCounts || {});
    let kept = (current.questions || []).slice();
    const haveByKey: Record<string, number> = {};
    for (const key of requestedKeys) {
      if (key.startsWith('english:')) haveByKey[key] = 0; else haveByKey[key] = kept.filter((q) => String(q.type) === key).length;
    }

    const diff = bp.difficultyDistribution || { easy: 0, medium: 100, hard: 0 };
    const diffParts: Array<{ key: Difficulty; pct: number }> = [
      { key: 'easy', pct: Math.max(0, Number(diff.easy ?? 0)) },
      { key: 'medium', pct: Math.max(0, Number(diff.medium ?? 0)) },
      { key: 'hard', pct: Math.max(0, Number(diff.hard ?? 0)) },
    ];
    const pctSum = diffParts.reduce((a, b) => a + b.pct, 0) || 1;

    const groupedByKey: Record<string, Partial<IQuestion>[]> = {};
    for (const key of requestedKeys) groupedByKey[key] = [];
    // Seed with existing for standard types
    for (const key of requestedKeys) {
      if (!key.startsWith('english:')) groupedByKey[key] = kept.filter((q) => String(q.type) === key);
    }

    for (const key of requestedKeys) {
      const desired = Math.max(0, Number((bp.questionCounts as any)[key] || 0));
      const have = haveByKey[key] || 0;
      let missing = desired - have;
      if (missing <= 0) continue;
      const alloc: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0 };
      let acc = 0;
      for (let i = 0; i < diffParts.length; i++) {
        const p = diffParts[i];
        let count = Math.floor((p.pct / pctSum) * missing);
        if (i === diffParts.length - 1) count = missing - acc;
        alloc[p.key] = count as any;
        acc += count;
      }
      for (const d of ['easy', 'medium', 'hard'] as Difficulty[]) {
        const need = alloc[d];
        if (need <= 0) continue;
        const { baseType, formatHint } = key.startsWith('english:') ? englishMap(key) : ({ baseType: key } as any);
        const extraGuidance = formatHint ? `\nENGLISH FORMAT: ${formatHint}` : '';
        const gen = await generateQuestionsFromTextGemini(source || `${blueprint.subject || ''} ${bp.title || ''}`.trim(), {
          subject: blueprint.subject,
          topic: bp.title,
          difficulty: d,
          count: need,
          types: [baseType],
          createdBy: undefined as any,
          __guidance: ((guidance || '') + extraGuidance) as any,
        } as any);
        const normalized = gen.map((q) => {
          if (q.type === 'mcq' && Array.isArray(q.options)) {
            const firstCorrectIdx = q.options.findIndex((o) => o.isCorrect);
            let opts = q.options.map((o) => ({ text: String(o.text || ''), isCorrect: !!o.isCorrect })).slice(0, 4);
            const correctCount = opts.filter((o) => o.isCorrect).length;
            while (opts.length < 4) opts.push({ text: 'None of the above', isCorrect: false });
            if (correctCount !== 1) opts = opts.map((o, idx) => ({ ...o, isCorrect: idx === (firstCorrectIdx >= 0 ? Math.min(firstCorrectIdx, 3) : 0) }));
            return { ...q, type: baseType, options: opts as any };
          }
          return { ...q, type: baseType };
        });
        groupedByKey[key] = groupedByKey[key].concat(normalized as any);
      }
    }

    const balanced: Partial<IQuestion>[] = [];
    for (const key of requestedKeys) {
      const desired = Math.max(0, Number((bp.questionCounts as any)[key] || 0));
      balanced.push(...(groupedByKey[key] || []).slice(0, desired));
    }

    sections.push({
      title: bp.title,
      instructions: bp.instructions,
      marksPerQuestion: bp.marksPerQuestion,
      questionCounts: bp.questionCounts,
      difficultyDistribution: bp.difficultyDistribution,
      questions: balanced,
    });
  }
  return sections;
}

export async function generatePaperFromTextEnforced(source: string, blueprint: PaperBlueprint): Promise<GeneratedPaperResult> {
  // Initial attempt using structured paper generation
  const g = getGemini();
  if (!g) throw new Error('Gemini API key not configured');
  const guidance = await getGuidanceText(blueprint.subject, undefined);
  let initial: GeneratedPaperResult;
  try {
    initial = await generatePaperFromTextGemini(source, { ...(blueprint as any), __guidance: guidance } as any);
  } catch {
    // If the structured generation fails, seed with empty sections and we will top up strictly
    initial = {
      examTitle: blueprint.examTitle,
      subject: blueprint.subject,
      totalMarks: 0,
      generalInstructions: blueprint.generalInstructions || [],
      sections: blueprint.sections.map((s) => ({
        title: s.title,
        instructions: s.instructions,
        marksPerQuestion: s.marksPerQuestion,
        questionCounts: s.questionCounts,
        difficultyDistribution: s.difficultyDistribution,
        questions: [],
      })),
    };
  }

  // Strictly enforce counts/types by topping up
  const enforcedSections = await enforceBlueprintOnSections(source, blueprint, initial.sections, guidance);
  const totalMarks = enforcedSections.reduce((sum, sec) => sum + (sec.marksPerQuestion || 0) * (sec.questions?.length || 0), 0);
  return {
    examTitle: initial.examTitle || blueprint.examTitle,
    subject: initial.subject || blueprint.subject,
    totalMarks,
    generalInstructions: initial.generalInstructions?.length ? initial.generalInstructions : (blueprint.generalInstructions || []),
    sections: enforcedSections,
  };
}

export async function refineQuestionGemini(original: Partial<IQuestion> & { notes?: string; desiredDifficulty?: Difficulty; constraints?: string }): Promise<Partial<IQuestion>> {
  const g = getGemini();
  if (!g) throw new Error('Gemini API key not configured');
  const model = g.getGenerativeModel({ model: 'gemini-2.5-pro' });
  const prompt = `Refine the following question maintaining its core concept. Apply improvements: clarity, difficulty targeting, remove ambiguity. If MCQ ensure exactly 4 options & one correct. If assertionreason, maintain structure & booleans. Return ONLY JSON with schema { "text": string, "type": string, "options": [{"text":string,"isCorrect":boolean}]|null, "correctAnswerText": string|null, "integerAnswer": number|null, "assertion": string|null, "reason": string|null, "assertionIsTrue": boolean|null, "reasonIsTrue": boolean|null, "reasonExplainsAssertion": boolean|null, "explanation": string|null }.
Original JSON:
${JSON.stringify(original)}
DesiredDifficulty: ${original.desiredDifficulty || 'unchanged'}
ExtraConstraints: ${original.constraints || 'none'}
Notes: ${original.notes || 'none'}
`; 
  const result = await model.generateContent(prompt);
  const raw = result.response.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); if (!m) throw new Error('Failed to parse refined question'); parsed = JSON.parse(m[0]); }
  return {
    text: String(parsed.text || original.text || '').trim(),
    type: (['mcq','truefalse','fill','short','long','assertionreason','integer'].includes(parsed.type) ? parsed.type : original.type) as QuestionType,
    options: Array.isArray(parsed.options) ? parsed.options.slice(0, 6).map((o: any) => ({ text: String(o.text||''), isCorrect: !!o.isCorrect })) : undefined,
    correctAnswerText: parsed.correctAnswerText ? String(parsed.correctAnswerText) : original.correctAnswerText,
    integerAnswer: parsed.integerAnswer !== undefined ? Number(parsed.integerAnswer) : original.integerAnswer,
    assertion: parsed.assertion ? String(parsed.assertion) : original.assertion,
    reason: parsed.reason ? String(parsed.reason) : original.reason,
    assertionIsTrue: typeof parsed.assertionIsTrue === 'boolean' ? parsed.assertionIsTrue : original.assertionIsTrue,
    reasonIsTrue: typeof parsed.reasonIsTrue === 'boolean' ? parsed.reasonIsTrue : original.reasonIsTrue,
    reasonExplainsAssertion: typeof parsed.reasonExplainsAssertion === 'boolean' ? parsed.reasonExplainsAssertion : original.reasonExplainsAssertion,
    explanation: parsed.explanation ? String(parsed.explanation) : original.explanation,
  };
}

export async function generateQuestionsFromTextGemini(
  text: string, 
  opts: GenerateOptions & { 
    diagrams?: Array<{ url?: string; description: string; altText: string }>;
    isQuestionPaper?: boolean;
  }
): Promise<Partial<IQuestion>[]> {
  const g = getGemini();
  if (!g) throw new Error('Gemini API key not configured');
  const model = g.getGenerativeModel({ model: 'gemini-2.5-pro' });
  
  const hasDiagrams = opts.diagrams && opts.diagrams.length > 0;
  const diagramDescriptions = opts.diagrams?.map(d => d.description) || [];
  
  const prompt = buildQuestionGenPrompt(text, {
    ...opts,
    hasDiagrams,
    diagramDescriptions,
  });
  
  const result = await model.generateContent(prompt);
  const raw = result.response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try to salvage JSON from code fences if present
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Failed to parse model output as JSON');
    parsed = JSON.parse(match[0]);
  }
  const items = Array.isArray(parsed?.questions) ? parsed.questions : [];
  
  // Create a map of diagrams for easy matching
  const diagramMap = new Map<string, { url?: string; description: string; altText: string }>();
  opts.diagrams?.forEach((diag, idx) => {
    diagramMap.set(diag.description.toLowerCase().slice(0, 50), diag);
    diagramMap.set(`diagram_${idx}`, diag);
  });
  
  const normalized: Partial<IQuestion>[] = items.map((q: any, idx: number) => {
    // Try to match diagram to question if diagram is required
    let diagramUrl: string | undefined;
    let diagramAlt: string | undefined;
    
    if (q.diagramRequired || q.diagramReference) {
      // Try to find matching diagram
      if (q.diagramReference) {
        const refKey = String(q.diagramReference).toLowerCase().slice(0, 50);
        const matchedDiag = diagramMap.get(refKey);
        if (matchedDiag) {
          diagramUrl = matchedDiag.url;
          diagramAlt = matchedDiag.altText;
        }
      }
      
      // Fallback: assign diagrams sequentially if available
      if (!diagramUrl && opts.diagrams && opts.diagrams[idx]) {
        diagramUrl = opts.diagrams[idx].url;
        diagramAlt = opts.diagrams[idx].altText;
      }
    }
    
    return {
      text: String(q.text || '').trim(),
      type: ['mcq', 'truefalse', 'fill', 'short', 'long', 'assertionreason', 'integer'].includes(q.type) ? q.type : 'mcq',
      options: Array.isArray(q.options)
        ? q.options.map((o: any) => ({ text: String(o.text || ''), isCorrect: !!o.isCorrect }))
        : undefined,
      correctAnswerText: q.correctAnswerText ? String(q.correctAnswerText) : undefined,
      integerAnswer: q.integerAnswer !== undefined ? Number(q.integerAnswer) : undefined,
      assertion: q.assertion ? String(q.assertion) : undefined,
      reason: q.reason ? String(q.reason) : undefined,
      assertionIsTrue: typeof q.assertionIsTrue === 'boolean' ? q.assertionIsTrue : undefined,
      reasonIsTrue: typeof q.reasonIsTrue === 'boolean' ? q.reasonIsTrue : undefined,
      reasonExplainsAssertion: typeof q.reasonExplainsAssertion === 'boolean' ? q.reasonExplainsAssertion : undefined,
      diagramUrl,
      diagramAlt,
      tags: {
        subject: opts.subject || q.tags?.subject,
        topic: opts.topic || q.tags?.topic,
        difficulty: (q.tags?.difficulty as Difficulty) || opts.difficulty || 'medium',
      },
      explanation: q.explanation ? String(q.explanation) : undefined,
    };
  });
  
  // Basic sanity filter
  return normalized.filter((q) => q.text && q.type);
}

export async function gradeSubjectiveAnswerGroq(params: {
  questionText: string;
  studentAnswer: string;
  rubric?: string; // optional teacher rubric
}): Promise<{ rubricScore: number; feedback: string }> {
  const client = getGroq();
  if (!client) throw new Error('Groq API key not configured');
  const system = `You are a strict but fair grader. Score the student's answer between 0 and 1 with up to two decimals. Provide brief, actionable feedback. Return STRICT JSON: { "rubricScore": number, "feedback": string }`;
  const user = `Question: ${params.questionText}\n\nStudent Answer: ${params.studentAnswer}\n\nRubric (optional): ${params.rubric || 'N/A'}\n\nRespond with JSON only.`;
  const resp = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' } as any,
  });
  const raw = resp.choices?.[0]?.message?.content || '';
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Failed to parse Groq grading response'); }
  const score = Math.max(0, Math.min(1, Number(parsed.rubricScore)));
  const feedback = String(parsed.feedback || '').slice(0, 2000);
  return { rubricScore: isNaN(score) ? 0 : score, feedback };
}

export async function summarizeWithGroq(text: string): Promise<string | null> {
  const client = getGroq();
  if (!client) return null;
  const resp = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    temperature: 0.3,
    messages: [
      { role: 'system', content: 'Summarize the key insights in 3-5 bullets. Keep it concise.' },
      { role: 'user', content: text.slice(0, 12000) },
    ],
  });
  return resp.choices?.[0]?.message?.content || null;
}
