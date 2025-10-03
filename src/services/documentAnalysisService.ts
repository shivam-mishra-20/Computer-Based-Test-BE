import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

let genAI: GoogleGenerativeAI | null = null;

function getGemini() {
  if (!GOOGLE_API_KEY) return null;
  if (!genAI) genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
  return genAI;
}

export interface DocumentAnalysisResult {
  isQuestionPaper: boolean;
  documentType: 'question_paper' | 'study_material' | 'mixed' | 'unknown';
  confidence: number; // 0-1
  hasQuestions: boolean;
  hasDiagrams: boolean;
  subject?: string;
  estimatedQuestionCount?: number;
  questionTypes: string[]; // mcq, subjective, numerical, etc.
  recommendations: {
    strategy: 'recreate_exact' | 'generate_similar' | 'extract_and_generate';
    reasoning: string;
  };
}

/**
 * Analyzes a document (PDF or image text) to determine if it's a question paper
 * or study material, and provides recommendations for question generation
 */
export async function analyzeDocument(
  textContent: string,
  hasImages: boolean = false
): Promise<DocumentAnalysisResult> {
  const g = getGemini();
  if (!g) {
    // Fallback heuristic analysis
    return heuristicDocumentAnalysis(textContent, hasImages);
  }

  try {
    const model = g.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const prompt = `Analyze this document content and determine its type and characteristics.

ANALYSIS CRITERIA:
1. Is this a question paper/exam/test/quiz/worksheet? (vs study material/textbook/notes)
2. Does it contain actual questions with:
   - Numbered questions (Q1, Q2, 1., 2., etc.)
   - Multiple choice options (A, B, C, D or i, ii, iii, iv)
   - Question instructions ("Choose the correct answer", "Answer the following", etc.)
   - Marks allocation ([2 marks], (5M), etc.)
   - Section divisions (Section A, Part I, etc.)
3. Document characteristics:
   - Subject/topic
   - Estimated number of questions
   - Types of questions present (MCQ, True/False, Fill in blanks, Short answer, Long answer, Numerical, Assertion-Reason, etc.)
   - Presence of diagrams/figures/charts (based on references like "see diagram", "figure 1", "graph shows")
4. Recommendation for AI generation strategy:
   - "recreate_exact": If it's a complete question paper that should be recreated exactly as-is
   - "generate_similar": If it's study material from which similar questions should be generated
   - "extract_and_generate": If it's mixed content or partial questions

Respond ONLY with valid JSON:
{
  "isQuestionPaper": boolean,
  "documentType": "question_paper" | "study_material" | "mixed" | "unknown",
  "confidence": number (0-1),
  "hasQuestions": boolean,
  "hasDiagrams": boolean,
  "subject": string | null,
  "estimatedQuestionCount": number | null,
  "questionTypes": string[],
  "recommendations": {
    "strategy": "recreate_exact" | "generate_similar" | "extract_and_generate",
    "reasoning": string
  }
}

DOCUMENT CONTENT (first 8000 characters):
"""
${textContent.slice(0, 8000)}
"""`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    
    let parsed: any;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      const match = responseText.match(/\{[\s\S]*\}/);
      if (!match) {
        console.warn('Failed to parse document analysis response');
        return heuristicDocumentAnalysis(textContent, hasImages);
      }
      parsed = JSON.parse(match[0]);
    }

    return {
      isQuestionPaper: !!parsed.isQuestionPaper,
      documentType: ['question_paper', 'study_material', 'mixed', 'unknown'].includes(parsed.documentType)
        ? parsed.documentType
        : 'unknown',
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      hasQuestions: !!parsed.hasQuestions,
      hasDiagrams: !!parsed.hasDiagrams || hasImages,
      subject: parsed.subject ? String(parsed.subject) : undefined,
      estimatedQuestionCount: parsed.estimatedQuestionCount ? Number(parsed.estimatedQuestionCount) : undefined,
      questionTypes: Array.isArray(parsed.questionTypes)
        ? parsed.questionTypes.map((t: any) => String(t))
        : [],
      recommendations: {
        strategy: ['recreate_exact', 'generate_similar', 'extract_and_generate'].includes(
          parsed.recommendations?.strategy
        )
          ? parsed.recommendations.strategy
          : 'generate_similar',
        reasoning: parsed.recommendations?.reasoning
          ? String(parsed.recommendations.reasoning)
          : 'Default generation strategy',
      },
    };
  } catch (error) {
    console.error('Error analyzing document:', error);
    return heuristicDocumentAnalysis(textContent, hasImages);
  }
}

/**
 * Fallback heuristic analysis when Gemini is not available
 */
function heuristicDocumentAnalysis(
  textContent: string,
  hasImages: boolean
): DocumentAnalysisResult {
  const text = textContent.toLowerCase();
  
  // Question paper indicators
  const questionIndicators = [
    /\bq\.?\s*\d+[.:)]/i, // Q1, Q.1, Q1:, Q1)
    /\bquestion\s+\d+/i,
    /\d+\.\s*[A-Z]/i, // Numbered questions followed by capital letter
    /choose\s+the\s+correct/i,
    /answer\s+the\s+following/i,
    /\[\s*\d+\s*marks?\s*\]/i, // [2 marks]
    /\(\s*\d+\s*m\s*\)/i, // (5M)
    /section\s+[A-Z]/i,
    /part\s+[IVX]/i,
    /\btrue\s+or\s+false\b/i,
    /fill\s+in\s+the\s+blanks?/i,
  ];

  const questionCount = questionIndicators.reduce(
    (count, pattern) => count + (text.match(pattern)?.length || 0),
    0
  );

  const hasMCQPattern = /\([A-D]\)|[A-D]\)|\([a-d]\)|[a-d]\)/.test(text);
  const hasNumberedQuestions = /\b\d+\.\s+[A-Z]/.test(textContent);
  const hasMarksAllocation = /\[\s*\d+\s*marks?\s*\]|\(\s*\d+\s*m\s*\)/i.test(text);
  
  const isQuestionPaper = questionCount >= 3 || (hasNumberedQuestions && hasMarksAllocation);
  
  // Diagram indicators
  const diagramIndicators = [
    /see\s+(diagram|figure|graph|chart|image)/i,
    /refer\s+to\s+(diagram|figure|graph)/i,
    /as\s+shown\s+in\s+(the\s+)?(diagram|figure|graph)/i,
    /figure\s+\d+/i,
    /diagram\s+\d+/i,
  ];
  
  const hasDiagrams = hasImages || diagramIndicators.some((pattern) => pattern.test(text));

  // Question type detection
  const questionTypes: string[] = [];
  if (hasMCQPattern) questionTypes.push('mcq');
  if (/\btrue\s+or\s+false\b/i.test(text)) questionTypes.push('truefalse');
  if (/fill\s+in\s+the\s+blanks?/i.test(text)) questionTypes.push('fill');
  if (/short\s+answer/i.test(text)) questionTypes.push('short');
  if (/long\s+answer|essay/i.test(text)) questionTypes.push('long');
  if (/assertion.*reason/i.test(text)) questionTypes.push('assertionreason');

  // Estimate question count
  const numberedMatches = textContent.match(/\bq\.?\s*\d+[.:)]/gi);
  const estimatedCount = numberedMatches ? numberedMatches.length : Math.floor(questionCount / 2);

  return {
    isQuestionPaper,
    documentType: isQuestionPaper ? 'question_paper' : 'study_material',
    confidence: isQuestionPaper ? 0.7 : 0.6,
    hasQuestions: questionCount > 0,
    hasDiagrams,
    subject: undefined,
    estimatedQuestionCount: estimatedCount > 0 ? estimatedCount : undefined,
    questionTypes,
    recommendations: {
      strategy: isQuestionPaper ? 'recreate_exact' : 'generate_similar',
      reasoning: isQuestionPaper
        ? 'Document appears to be a question paper with structured questions'
        : 'Document appears to be study material; generate questions from content',
    },
  };
}
