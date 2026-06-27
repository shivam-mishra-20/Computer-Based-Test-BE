import { ai } from '../ai';

/**
 * Converts mathematical expressions in text to proper LaTeX format
 * Ensures professional mathematical notation with correct symbols
 */
export async function normalizeMathematicalExpressions(text: string): Promise<string> {
  try {
    const prompt = `You are a mathematical notation expert. Convert ALL mathematical expressions in the following text to proper LaTeX format wrapped in $ for inline math or $$ for display math.

CRITICAL RULES:
1. CONVERT UNICODE MATHEMATICAL SYMBOLS TO LATEX:
   - Superscripts: ² → ^2, ³ → ^3, ⁴ → ^4, etc.
   - Infinity: ∞ → \\infty
   - Multiplication: × → \\times
   - Division: ÷ → \\div
   - Inequalities: ≤ → \\leq, ≥ → \\geq, ≠ → \\neq, ≈ → \\approx
   - Greek: α → \\alpha, β → \\beta, π → \\pi, θ → \\theta, etc.
   - Subscripts: ₁ → _1, ₂ → _2, etc.

2. Use proper LaTeX commands for all mathematical symbols:
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
   - Ellipsis: ... can stay as is or use \\ldots, \\cdots

3. PRESERVE ALL SPACING:
   - Maintain spaces before and after $ delimiters
   - Keep spaces between words and equations
   - Example: "If $A = 1 + r + r^2$ then" (spaces preserved)

4. Simple inline expressions like "x + 5 = 10" become "$x + 5 = 10$"
5. Complex multi-line equations use $$...$$
6. Preserve ALL non-mathematical text exactly as is
7. Chemical formulas: H₂O becomes $H_2O$, CO₂ becomes $CO_2$
8. Physics units: use \\text{} for units, e.g., "$5 \\text{ m/s}^2$"

EXAMPLES:
Input: "If A = 1 + r + r² + ............∞, then the value of r will be"
Output: "If $A = 1 + r + r^2 + ... + \\infty$, then the value of r will be"

Input: "The limit is lim(x→∞) f(x) = 0"
Output: "The limit is $\\lim_{x \\to \\infty} f(x) = 0$"

Return the ENTIRE text with mathematical expressions properly formatted in LaTeX. Do NOT add explanations, ONLY return the processed text.

TEXT TO PROCESS:
"""
${text}
"""`;

    const normalizedText = await ai.text(prompt, { label: 'math-normalize', temperature: 0 });

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
