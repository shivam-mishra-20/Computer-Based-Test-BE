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

/**
 * Converts mathematical expressions in text to proper LaTeX format
 * Ensures professional mathematical notation with correct symbols
 */
export async function normalizeMathematicalExpressions(text: string): Promise<string> {
  const g = getGemini();
  if (!g) {
    console.warn('Gemini API not configured for math normalization');
    return text;
  }

  try {
    const model = g.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const prompt = `You are a mathematical notation expert. Convert ALL mathematical expressions in the following text to proper LaTeX format wrapped in $ for inline math or $$ for display math.

CRITICAL RULES:
1. Use proper LaTeX commands for all mathematical symbols:
   - Fractions: \\frac{numerator}{denominator}
   - Square roots: \\sqrt{expression} or \\sqrt[n]{expression}
   - Integrals: \\int, \\iint, \\iiint with proper limits \\int_{a}^{b}
   - Summations: \\sum_{i=1}^{n}
   - Products: \\prod_{i=1}^{n}
   - Limits: \\lim_{x \\to a}
   - Greek letters: \\alpha, \\beta, \\gamma, \\Delta, \\Sigma, \\theta, \\pi, etc.
   - Superscripts: x^{2}, e^{-x}
   - Subscripts: x_{1}, a_{n}
   - Trigonometric: \\sin, \\cos, \\tan, \\sec, \\csc, \\cot
   - Logarithms: \\log, \\ln
   - Matrices: \\begin{matrix} ... \\end{matrix} or \\begin{pmatrix} ... \\end{pmatrix}
   - Vectors: \\vec{v}, \\mathbf{v}
   - Derivatives: \\frac{dy}{dx}, \\frac{d^2y}{dx^2}
   - Partial derivatives: \\frac{\\partial f}{\\partial x}
   - Inequalities: \\leq, \\geq, \\neq, \\approx
   - Set notation: \\in, \\subset, \\cup, \\cap, \\emptyset
   - Logic: \\forall, \\exists, \\implies, \\iff
   - Arrows: \\rightarrow, \\Rightarrow, \\leftrightarrow
   - Special: \\infty, \\pm, \\times, \\div, \\cdot

2. Simple inline expressions like "x + 5 = 10" become "$x + 5 = 10$"
3. Complex multi-line equations use $$...$$
4. Preserve ALL non-mathematical text exactly as is
5. Chemical formulas: H₂O becomes H_2O, CO₂ becomes CO_2 (or use \\ce{H2O} with mhchem)
6. Physics units: use \\text{} for units, e.g., "$5 \\text{ m/s}^2$"

Return the ENTIRE text with mathematical expressions properly formatted in LaTeX. Do NOT add explanations, ONLY return the processed text.

TEXT TO PROCESS:
"""
${text}
"""`;

    const result = await model.generateContent(prompt);
    const normalizedText = result.response.text();

    return normalizedText.trim();
  } catch (error) {
    console.error('Error normalizing mathematical expressions:', error);
    return text; // Return original if normalization fails
  }
}

/**
 * Validates if text contains mathematical content that needs LaTeX formatting
 */
export function containsMathematicalContent(text: string): boolean {
  // Common indicators of mathematical content
  const mathPatterns = [
    /\d+[\+\-\*\/×÷]\d+/, // Basic arithmetic
    /[a-zA-Z]\s*[\+\-\*\/×÷=]\s*[a-zA-Z0-9]/, // Algebraic expressions
    /\b(sin|cos|tan|log|ln|sqrt|integral|derivative|limit|sum|product)\b/i, // Math functions
    /[∫∑∏√π∞≤≥≠±×÷⋅∈∪∩⊂⊃∀∃→⇒↔⟺]/, // Math symbols
    /\^\d+|\^\{[^}]+\}/, // Exponents
    /_{d+|_\{[^}]+\}/, // Subscripts
    /\\frac|\\sqrt|\\int|\\sum|\\lim|\\alpha|\\beta|\\gamma/, // Already LaTeX
    /\([a-zA-Z0-9\+\-\*/]+\)\/\([a-zA-Z0-9\+\-\*/]+\)/, // Fractions
  ];

  return mathPatterns.some((pattern) => pattern.test(text));
}

/**
 * Processes question text and options to normalize mathematical expressions
 */
export async function normalizeQuestionMath(question: {
  text: string;
  options?: Array<{ text: string; isCorrect: boolean }>;
  correctAnswerText?: string;
  assertion?: string;
  reason?: string;
  explanation?: string;
}): Promise<typeof question> {
  const normalized = { ...question };

  // Normalize question text
  if (containsMathematicalContent(question.text)) {
    normalized.text = await normalizeMathematicalExpressions(question.text);
  }

  // Normalize options
  if (question.options && Array.isArray(question.options)) {
    normalized.options = await Promise.all(
      question.options.map(async (opt) => {
        if (containsMathematicalContent(opt.text)) {
          return {
            ...opt,
            text: await normalizeMathematicalExpressions(opt.text),
          };
        }
        return opt;
      })
    );
  }

  // Normalize correct answer text
  if (question.correctAnswerText && containsMathematicalContent(question.correctAnswerText)) {
    normalized.correctAnswerText = await normalizeMathematicalExpressions(question.correctAnswerText);
  }

  // Normalize assertion
  if (question.assertion && containsMathematicalContent(question.assertion)) {
    normalized.assertion = await normalizeMathematicalExpressions(question.assertion);
  }

  // Normalize reason
  if (question.reason && containsMathematicalContent(question.reason)) {
    normalized.reason = await normalizeMathematicalExpressions(question.reason);
  }

  // Normalize explanation
  if (question.explanation && containsMathematicalContent(question.explanation)) {
    normalized.explanation = await normalizeMathematicalExpressions(question.explanation);
  }

  return normalized;
}

/**
 * Batch normalizes multiple questions efficiently
 */
export async function normalizeQuestionsMath(
  questions: Array<{
    text: string;
    options?: Array<{ text: string; isCorrect: boolean }>;
    correctAnswerText?: string;
    assertion?: string;
    reason?: string;
    explanation?: string;
  }>
): Promise<typeof questions> {
  // Process in batches to avoid rate limits
  const BATCH_SIZE = 5;
  const results: typeof questions = [];

  for (let i = 0; i < questions.length; i += BATCH_SIZE) {
    const batch = questions.slice(i, i + BATCH_SIZE);
    const normalized = await Promise.all(batch.map((q) => normalizeQuestionMath(q)));
    results.push(...normalized);
  }

  return results;
}
