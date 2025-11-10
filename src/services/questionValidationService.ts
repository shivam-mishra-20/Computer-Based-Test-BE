import { Types } from 'mongoose';
import type { QuestionType, Difficulty } from '../models/Question';
import { getClassQuestionModel, IClassQuestion } from '../models/ClassQuestion';

/**
 * Enhanced Question Schema for Create Paper Flow
 * Ensures questions include all metadata needed for paper creation filters
 */
export interface EnhancedQuestionData {
  // Core question content
  text: string;
  type: QuestionType;
  options?: Array<{ text: string; isCorrect?: boolean }>;
  correctAnswerText?: string;
  integerAnswer?: number;
  assertion?: string;
  reason?: string;
  assertionIsTrue?: boolean;
  reasonIsTrue?: boolean;
  reasonExplainsAssertion?: boolean;
  
  // Diagram/media
  diagramUrl?: string;
  diagramAlt?: string;
  
  // Enhanced metadata for paper creation
  class?: string;          // e.g., "Class 10", "Class 11"
  subject: string;          // REQUIRED: Mathematics, Physics, etc.
  board?: string;           // e.g., "CBSE", "GSEB", "JEE", "NEET"
  chapter?: string;         // Chapter name
  topic?: string;           // Topic/subtopic within chapter
  section?: string;         // e.g., "Objective", "Short Answer", "Long Answer"
  marks?: number;           // Default marks for this question
  difficulty: Difficulty;   // easy, medium, hard
  
  // Solution and explanation
  explanation?: string;
  solutionText?: string;
  
  // Metadata
  createdBy: Types.ObjectId;
  source?: 'AI' | 'Smart Import' | 'Manual' | 'Upload';
  isActive?: boolean;
}

/**
 * Sanitize and normalize question text and options
 */
export function sanitizeQuestionData(data: Partial<EnhancedQuestionData>): Partial<EnhancedQuestionData> {
  const sanitized: Partial<EnhancedQuestionData> = { ...data };
  
  // 1. Sanitize question text
  if (sanitized.text) {
    // Trim and normalize whitespace
    sanitized.text = sanitized.text.trim().replace(/\s+/g, ' ');
    
    // Remove stray HTML tags (except for allowed LaTeX-like markup)
    sanitized.text = sanitized.text.replace(/<(?!\/?(sup|sub|i|b|em|strong)>)[^>]*>/gi, '');
    
    // Capitalize first character if it's lowercase
    if (sanitized.text.length > 0 && /^[a-z]/.test(sanitized.text)) {
      sanitized.text = sanitized.text.charAt(0).toUpperCase() + sanitized.text.slice(1);
    }
    
    // Ensure proper sentence ending (add period if missing and not already punctuated)
    if (sanitized.text.length > 0 && !/[.!?:;]$/.test(sanitized.text)) {
      sanitized.text = sanitized.text + '.';
    }
  }
  
  // 2. Convert math/science equations to LaTeX syntax
  if (sanitized.text) {
    sanitized.text = convertToLatex(sanitized.text);
  }
  if (sanitized.explanation) {
    sanitized.explanation = convertToLatex(sanitized.explanation);
  }
  if (sanitized.solutionText) {
    sanitized.solutionText = convertToLatex(sanitized.solutionText);
  }
  
  // 3. Sanitize MCQ options
  if (sanitized.options && Array.isArray(sanitized.options)) {
    sanitized.options = sanitized.options
      .filter(opt => opt.text && opt.text.trim().length > 0) // Remove empty options
      .map(opt => ({
        ...opt,
        text: convertToLatex(opt.text.trim().replace(/\s+/g, ' '))
      }))
      // Remove duplicates
      .filter((opt, index, self) => 
        index === self.findIndex(o => o.text.toLowerCase() === opt.text.toLowerCase())
      );
  }
  
  // 4. Normalize metadata fields
  if (sanitized.subject) {
    sanitized.subject = normalizeField(sanitized.subject);
  }
  if (sanitized.chapter) {
    sanitized.chapter = normalizeField(sanitized.chapter);
  }
  if (sanitized.topic) {
    sanitized.topic = normalizeField(sanitized.topic);
  }
  if (sanitized.board) {
    sanitized.board = normalizeField(sanitized.board);
  }
  if (sanitized.class) {
    sanitized.class = normalizeField(sanitized.class);
  }
  if (sanitized.section) {
    sanitized.section = normalizeField(sanitized.section);
  }
  
  return sanitized;
}

/**
 * Convert common math/science notation to LaTeX
 * Preserves existing LaTeX syntax
 */
function convertToLatex(text: string): string {
  let result = text;
  
  // Skip if already has LaTeX delimiters
  if (result.includes('$') || result.includes('\\[') || result.includes('\\(')) {
    return result;
  }
  
  // Common patterns to convert:
  
  // 1. Superscripts: x^2 -> $x^2$
  result = result.replace(/([a-zA-Z0-9]+)\^([0-9]+)/g, '$$$1^{$2}$$');
  
  // 2. Subscripts: H_2O -> $H_2O$
  result = result.replace(/([a-zA-Z]+)_([0-9]+)/g, '$$$1_{$2}$$');
  
  // 3. Fractions: 1/2 -> $\frac{1}{2}$ (simple cases)
  result = result.replace(/\b(\d+)\/(\d+)\b/g, '$$\\frac{$1}{$2}$$');
  
  // 4. Greek letters (common ones)
  const greekMap: Record<string, string> = {
    'alpha': '\\alpha',
    'beta': '\\beta',
    'gamma': '\\gamma',
    'delta': '\\delta',
    'theta': '\\theta',
    'lambda': '\\lambda',
    'pi': '\\pi',
    'sigma': '\\sigma',
    'omega': '\\omega',
  };
  
  Object.entries(greekMap).forEach(([word, latex]) => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    result = result.replace(regex, `$${latex}$`);
  });
  
  // 5. Mathematical operators and symbols
  result = result.replace(/≤/g, '$\\leq$');
  result = result.replace(/≥/g, '$\\geq$');
  result = result.replace(/≠/g, '$\\neq$');
  result = result.replace(/×/g, '$\\times$');
  result = result.replace(/÷/g, '$\\div$');
  result = result.replace(/√/g, '$\\sqrt{}$');
  result = result.replace(/∞/g, '$\\infty$');
  
  // 6. Clean up multiple consecutive $ signs
  result = result.replace(/\$+/g, '$');
  result = result.replace(/\$\s*\$/g, '');
  
  return result;
}

/**
 * Normalize field values (trim, capitalize properly)
 */
function normalizeField(value: string): string {
  if (!value) return value;
  
  // Trim and normalize whitespace
  let normalized = value.trim().replace(/\s+/g, ' ');
  
  // Capitalize each word (proper case)
  normalized = normalized
    .split(' ')
    .map(word => {
      // Keep acronyms uppercase (e.g., CBSE, JEE, NEET)
      if (word === word.toUpperCase() && word.length <= 5) {
        return word;
      }
      // Capitalize first letter
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
  
  return normalized;
}

// Escape regex special characters in a string
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check for duplicate questions in database
 * Returns true if duplicate exists
 */
export async function isDuplicate(
  questionText: string,
  subject: string,
  chapter?: string,
  board?: string,
  className?: string
): Promise<boolean> {
  try {
    // Normalize for comparison
    const normalizedText = questionText.trim();

    // Direct query: identical text (case-insensitive) AND same subject + chapter + board
    if (!className) return false; // without class, cannot decide collection
    const ClassQuestion = getClassQuestionModel(className);
    const existing = await ClassQuestion.findOne({
      isActive: true,
      text: { $regex: new RegExp(`^${escapeRegex(normalizedText)}$`, 'i') },
      subject: subject,
      chapter: chapter,
      board: board,
    })
      .select('_id')
      .lean();

    return !!existing;
  } catch (error) {
    console.error('Error checking for duplicates:', error);
    return false; // On error, allow insertion (fail open)
  }
}

/**
 * Validate question data before saving
 * Throws error if validation fails
 */
export function validateQuestionData(data: Partial<EnhancedQuestionData>): void {
  // Required fields
  if (!data.text || data.text.trim().length < 5) {
    throw new Error('Question text must be at least 5 characters');
  }
  
  if (!data.type) {
    throw new Error('Question type is required');
  }
  
  if (!data.subject || data.subject.trim().length === 0) {
    throw new Error('Subject is required for paper creation filters');
  }
  
  if (!data.createdBy) {
    throw new Error('createdBy is required');
  }
  
  // Type-specific validation
  if (data.type === 'mcq' || data.type === 'truefalse') {
    if (!data.options || !Array.isArray(data.options) || data.options.length < 2) {
      throw new Error(`${data.type} questions must have at least 2 options`);
    }
    
    // Check for at least one correct answer
    const hasCorrect = data.options.some(opt => opt.isCorrect === true);
    if (!hasCorrect) {
      throw new Error('At least one option must be marked as correct');
    }
  }
  
  if (data.type === 'integer' && data.integerAnswer === undefined) {
    throw new Error('Integer type questions must have integerAnswer');
  }
  
  if (data.type === 'assertionreason') {
    if (!data.assertion || !data.reason) {
      throw new Error('Assertion-reason questions must have both assertion and reason');
    }
  }
  
  // Difficulty must be valid
  if (data.difficulty && !['easy', 'medium', 'hard'].includes(data.difficulty)) {
    throw new Error('Difficulty must be easy, medium, or hard');
  }
}

/**
 * Save question with full validation, sanitization, and deduplication
 * Returns saved question or null if duplicate
 */
export async function saveValidatedQuestion(
  data: Partial<EnhancedQuestionData>
): Promise<IClassQuestion | null> {
  // 1. Sanitize data
  const sanitized = sanitizeQuestionData(data);
  
  // 2. Validate
  validateQuestionData(sanitized);
  
  // 3. Check for duplicates
  const isDupe = await isDuplicate(
    sanitized.text!,
    sanitized.subject!,
    sanitized.chapter || sanitized.topic,
    sanitized.board,
    sanitized.class
  );
  
  if (isDupe) {
    console.log(`Skipping duplicate question: ${sanitized.text!.substring(0, 50)}...`);
    return null;
  }
  
  // 4. Map enhanced fields to Question model schema
  const questionData: any = {
    text: sanitized.text,
    type: sanitized.type,
    options: sanitized.options,
    correctAnswerText: sanitized.correctAnswerText,
    integerAnswer: sanitized.integerAnswer,
    assertion: sanitized.assertion,
    reason: sanitized.reason,
    assertionIsTrue: sanitized.assertionIsTrue,
    reasonIsTrue: sanitized.reasonIsTrue,
    reasonExplainsAssertion: sanitized.reasonExplainsAssertion,
    diagramUrl: sanitized.diagramUrl,
    diagramAlt: sanitized.diagramAlt,
    explanation: sanitized.explanation || sanitized.solutionText,
    createdBy: sanitized.createdBy!,
    isActive: sanitized.isActive !== false,
    subject: sanitized.subject!,
    topic: sanitized.topic || sanitized.chapter,
    board: sanitized.board,
    chapter: sanitized.chapter || sanitized.topic,
    section: sanitized.section,
    marks: sanitized.marks,
    difficulty: sanitized.difficulty || 'medium',
    source: sanitized.source || 'Manual',
  };
  
  // Store enhanced metadata in a custom field (extend model if needed)
  // For now, we'll store additional metadata in tags or a new field
  // You may need to update the Question model to include these fields
  
  // 5. Save to database
  try {
    if (!sanitized.class) throw new Error('Class is required to save question');
    const ClassQuestion = getClassQuestionModel(sanitized.class);
    const saved = await ClassQuestion.create(questionData);
    console.log(`\u2713 Saved question: ${saved._id} (${saved.subject} - ${saved.chapter}) in ${sanitized.class}`);
    return saved;
  } catch (error) {
    console.error('Error saving question:', error);
    throw error;
  }
}

/**
 * Batch save questions with validation
 * Returns array of saved questions (skips duplicates)
 */
export async function saveBatchValidatedQuestions(
  questions: Partial<EnhancedQuestionData>[]
): Promise<IClassQuestion[]> {
  const saved: IClassQuestion[] = [];
  
  for (const q of questions) {
    try {
      const result = await saveValidatedQuestion(q);
      if (result) {
        saved.push(result);
      }
    } catch (error) {
      console.error('Error saving question in batch:', error);
      // Continue with next question
    }
  }
  
  console.log(`✓ Saved ${saved.length}/${questions.length} questions (skipped ${questions.length - saved.length} duplicates/errors)`);
  return saved;
}
