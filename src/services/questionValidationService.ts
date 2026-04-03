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

  // 4b. Normalize difficulty aliases coming from UI flows
  if (sanitized.difficulty) {
    const difficulty = String(sanitized.difficulty).toLowerCase().trim();
    if (difficulty === 'mixed') {
      sanitized.difficulty = 'medium';
    } else if (difficulty === 'moderate') {
      sanitized.difficulty = 'medium';
    } else if (difficulty === 'beginner') {
      sanitized.difficulty = 'easy';
    } else if (difficulty === 'advanced') {
      sanitized.difficulty = 'hard';
    }
  }
  
  // 5. Normalize question type
  if (sanitized.type) {
    sanitized.type = normalizeQuestionType(sanitized.type) as any;
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

/**
 * Normalize question type to match QuestionType enum
 * Handles common variations and aliases
 */
function normalizeQuestionType(type: string): QuestionType {
  if (!type) return 'mcq'; // default
  
  const normalized = type.toLowerCase().replace(/[_\s-]/g, '');
  
  // Map common variations to standard types
  const typeMap: Record<string, QuestionType> = {
    // MCQ variations
    'mcq': 'mcq',
    'multiplechoice': 'mcq',
    'multiple': 'mcq',
    'choice': 'mcq',
    'objective': 'mcq',
    'singlecorrect': 'mcq',
    
    // True/False variations
    'truefalse': 'truefalse',
    'true/false': 'truefalse',
    'tf': 'truefalse',
    'boolean': 'truefalse',
    
    // Fill in the blank variations
    'fill': 'fill',
    'fillblank': 'fill',
    'fillintheblank': 'fill',
    'fillup': 'fill',
    'blank': 'fill',
    
    // Short answer variations
    'short': 'short',
    'shortanswer': 'short',
    'sa': 'short',
    'brief': 'short',
    
    // Long answer variations
    'long': 'long',
    'longanswer': 'long',
    'la': 'long',
    'essay': 'long',
    'descriptive': 'long',
    
    // Assertion-Reason variations
    'assertionreason': 'assertionreason',
    'assertion': 'assertionreason',
    'ar': 'assertionreason',
    'assertionreasontype': 'assertionreason',
    
    // Integer variations
    'integer': 'integer',
    'integertype': 'integer',
    'numerical': 'integer',
    'numeric': 'integer',
  };
  
  return typeMap[normalized] || 'mcq'; // default to mcq if unknown
}

// Escape regex special characters in a string
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\s*(?:q\.?\s*)?\d+[\).:\-]\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s$]/gu, '')
    .trim();
}

/**
 * Check for duplicate questions in database
 * Returns true if duplicate exists
 * 
 * IMPORTANT: Deduplication is scoped to the SAME class collection.
 * If the same normalized question text already exists in a class question bank,
 * the new question will be skipped even if chapter labels differ.
 */
export async function isDuplicate(
  questionText: string,
  subject: string,
  chapter?: string,
  board?: string,
  className?: string
): Promise<boolean> {
  try {
    const normalizedText = questionText
      .trim()
      .replace(/^\s*(?:q\.?\s*)?\d+[\).:\-]\s*/, '')
      .replace(/\s+/g, ' ');
    const normalizedForRegex = escapeRegex(normalizedText).replace(/\s+/g, '\\s+');
    const canonicalIncoming = canonicalizeForComparison(normalizedText);
    const normalizedSubject = subject?.trim();
    const normalizedBoard = board?.trim();

    // Class determines the collection where we check for duplicates.
    if (!className) {
      console.warn('[Duplicate Check] Skipping: no class provided');
      return false;
    }

    const ClassQuestion = getClassQuestionModel(className);

    // Primary check: exact normalized text match in class collection.
    const primaryQuery: any = {
      isActive: true,
      text: { $regex: new RegExp(`^${normalizedForRegex}$`, 'i') },
    };

    if (normalizedSubject) {
      primaryQuery.subject = { $regex: new RegExp(`^${escapeRegex(normalizedSubject)}$`, 'i') };
    }

    if (normalizedBoard) {
      primaryQuery.board = { $regex: new RegExp(`^${escapeRegex(normalizedBoard)}$`, 'i') };
    }

    let existing = await ClassQuestion.findOne(primaryQuery)
      .select('_id')
      .lean();

    // Secondary check: punctuation-insensitive canonical comparison.
    if (!existing) {
      const narrowedQuery: any = { isActive: true };

      if (normalizedSubject) {
        narrowedQuery.subject = { $regex: new RegExp(`^${escapeRegex(normalizedSubject)}$`, 'i') };
      }

      if (normalizedBoard) {
        narrowedQuery.board = { $regex: new RegExp(`^${escapeRegex(normalizedBoard)}$`, 'i') };
      }

      const candidates = await ClassQuestion.find(narrowedQuery)
        .select('_id text')
        .limit(200)
        .lean();

      existing = candidates.find((candidate: any) => {
        const canonicalExisting = canonicalizeForComparison(candidate.text || '');
        return canonicalExisting.length > 0 && canonicalExisting === canonicalIncoming;
      }) as any;
    }

    if (existing) {
      const chapterLabel = chapter || 'unknown-chapter';
      console.log(`[Duplicate Found] Skipping question in ${className}/${chapterLabel}: "${normalizedText.substring(0, 60)}..."`);
    }

    return !!existing;
  } catch (error) {
    console.error('Error checking for duplicates:', error);
    return false; // On error, allow insertion (fail open)
  }
}

/**
 * Validate question data before saving
 * Throws error if validation fails
 * Returns false if question should be skipped (e.g., empty answers)
 */
export function validateQuestionData(data: Partial<EnhancedQuestionData>): boolean {
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
    // Note: We no longer validate if answers are present - questions can be saved without answers
  }
  
  if (data.type === 'assertionreason') {
    if (!data.assertion || !data.reason) {
      throw new Error('Assertion-Reason questions must have both assertion and reason');
    }
  }
  
  // Difficulty must be valid
  if (data.difficulty && !['easy', 'medium', 'hard'].includes(data.difficulty)) {
    throw new Error('Difficulty must be easy, medium, or hard');
  }
  
  // Passed all validations
  return true;
}

/**
 * Save question with full validation, sanitization, and deduplication
 * Returns saved question or null if duplicate or validation failed
 */
export async function saveValidatedQuestion(
  data: Partial<EnhancedQuestionData>
): Promise<IClassQuestion | null> {
  // 1. Sanitize data
  const sanitized = sanitizeQuestionData(data);
  
  // 2. Validate (returns false if should skip, throws on hard errors)
  const isValid = validateQuestionData(sanitized);
  if (!isValid) {
    // Question should be skipped (e.g., no answer provided)
    return null;
  }
  
  // 3. Check for duplicates within same class + chapter
  const isDupe = await isDuplicate(
    sanitized.text!,
    sanitized.subject!,
    sanitized.chapter || sanitized.topic,
    sanitized.board,
    sanitized.class
  );
  
  if (isDupe) {
    console.log(`[Duplicate] Skipping question in ${sanitized.class}/${sanitized.chapter}: ${sanitized.text!.substring(0, 50)}...`);
    return null;
  }
  
  // 4. Map enhanced fields to ClassQuestion model schema
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
    // Normalize source to match enum values (handle legacy 'Import' value)
    source: (sanitized.source as any) === 'Import' ? 'Smart Import' : (sanitized.source || 'Smart Import'),
  };
  
  // 5. Save to class-wise collection (e.g., class_10, class_11, class_12)
  try {
    if (!sanitized.class) throw new Error('Class is required to save question');
    const ClassQuestion = getClassQuestionModel(sanitized.class);
    const saved = await ClassQuestion.create(questionData);
    console.log(`✓ Saved to ${sanitized.class}: ${saved._id} (${saved.subject}/${saved.chapter})`);
    return saved;
  } catch (error) {
    console.error(`[Save Error] Failed to save question in ${sanitized.class}:`, error);
    throw error;
  }
}

/**
 * Batch save questions with validation
 * Returns array of saved questions (skips duplicates and invalid questions)
 */
export async function saveBatchValidatedQuestions(
  questions: Partial<EnhancedQuestionData>[]
): Promise<IClassQuestion[]> {
  const saved: IClassQuestion[] = [];
  const stats = {
    total: questions.length,
    saved: 0,
    skippedDuplicate: 0,
    skippedInvalid: 0,
    errors: 0
  };
  
  for (const q of questions) {
    try {
      const result = await saveValidatedQuestion(q);
      if (result) {
        saved.push(result);
        stats.saved++;
      } else {
        // null returned means duplicate or invalid (empty answer, etc.)
        // Check if it's likely a duplicate or validation skip
        if (q.text) {
          const isDupe = await isDuplicate(
            q.text,
            q.subject || 'Unknown',
            q.chapter || q.topic,
            q.board,
            q.class
          );
          if (isDupe) {
            stats.skippedDuplicate++;
          } else {
            stats.skippedInvalid++;
          }
        } else {
          stats.skippedInvalid++;
        }
      }
    } catch (error) {
      console.error('[Batch Save Error]:', error);
      stats.errors++;
      // Continue with next question
    }
  }
  
  console.log(`✅ Batch Save Complete:
  - Total: ${stats.total}
  - Saved: ${stats.saved}
  - Skipped (duplicate): ${stats.skippedDuplicate}
  - Skipped (invalid/no answer): ${stats.skippedInvalid}
  - Errors: ${stats.errors}`);
  
  return saved;
}
