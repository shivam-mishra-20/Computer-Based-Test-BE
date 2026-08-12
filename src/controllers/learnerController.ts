import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import User, { Board, LearnerOnboardingStep } from '../models/User';

/**
 * Public Learner (PUBLIC_LEARNER) account lifecycle.
 *
 * Deliberately kept in its own controller rather than added to authController:
 * the institute registration rules (admin approval, mandatory photo, class +
 * batch resolution, target exams) live there and must not be entangled with a
 * flow whose entire point is to have none of them.
 *
 * The account this creates:
 *   role        'student'            — so every existing permission check behaves
 *   accountType 'PUBLIC_LEARNER'     — so every institute AUDIENCE query excludes it
 *   status      'approved'           — no admin approval; usable immediately
 *   classLevel  NEVER SET            — the chosen class lives in learnerProfile
 *   batch       NEVER SET            — a learner has no institute batch
 *
 * That last pair is the structural guarantee: a learner cannot match an
 * institute class/batch query even if the audience filter were ever forgotten.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Public registration accepts only these mail providers.
 *
 * Enforced HERE, not just in the client: a client-side check is a UX
 * convenience, and anything that decides who may hold an account has to be
 * decided by the server. The comparison is on the lowercased, trimmed domain,
 * so "Student@GMAIL.com " is accepted and stored as "student@gmail.com".
 *
 * Deliberately does NOT apply to institute registration — /public-register is
 * untouched and keeps accepting any address, because school-issued domains are
 * normal there.
 */
const ALLOWED_EMAIL_DOMAINS = ['gmail.com', 'hotmail.com', 'live.in'];

const emailDomainAllowed = (email: string): boolean => {
  const domain = email.split('@')[1]?.trim().toLowerCase();
  return !!domain && ALLOWED_EMAIL_DOMAINS.includes(domain);
};

/** 10-digit Indian mobile, optionally with a +91 / 0 prefix that we strip. */
const normalizePhone = (input: unknown): string | null => {
  const raw = String(input ?? '').replace(/[\s\-()]/g, '');
  const stripped = raw.replace(/^(\+91|91|0)/, '');
  return /^[6-9]\d{9}$/.test(stripped) ? stripped : null;
};

const MAX_TEXT = 80;
const cleanText = (input: unknown): string | undefined => {
  const v = String(input ?? '').trim();
  return v ? v.slice(0, MAX_TEXT) : undefined;
};
const NAME_REGEX = /^[A-Za-z][A-Za-z .'-]{1,79}$/;
const MIN_PASSWORD_LENGTH = 8;

const VALID_BOARDS: Board[] = ['CBSE', 'ICSE', 'GSEB', 'IB', 'IGCSE', 'Other'];
/** Classes the public library carries content for. */
const VALID_CLASS_LEVELS = ['6', '7', '8', '9', '10', '11', '12'];
const MAX_SUBJECTS = 12;

const signToken = (user: { _id: unknown; role?: string }) =>
  jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET as string, {
    expiresIn: '3650d',
  });

/**
 * Public-safe learner payload. Deliberately omits institute fields (batch,
 * empCode, firebaseUid) so no client can mistake a learner for an enrolled
 * student, and omits `classLevel` entirely — a learner has none.
 */
export const serializeLearner = (user: any) => ({
  _id: user._id,
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  accountType: user.accountType,
  status: user.status,
  profileImage: user.profileImage,
  phone: user.phone,
  learnerProfile: {
    board: user.learnerProfile?.board,
    classLevel: user.learnerProfile?.classLevel,
    subjects: user.learnerProfile?.subjects || [],
    state: user.learnerProfile?.state,
    city: user.learnerProfile?.city,
    onboardingStep: user.learnerProfile?.onboardingStep || 'BOARD',
    onboardingCompletedAt: user.learnerProfile?.onboardingCompletedAt,
  },
});

/** Digits-only class, e.g. "Class 10" / "10th" / 10 → "10". */
const normalizeLearnerClass = (input: unknown): string | null => {
  if (input === undefined || input === null) return null;
  const match = String(input).match(/(\d{1,2})/);
  if (!match) return null;
  const value = String(Number(match[1]));
  return VALID_CLASS_LEVELS.includes(value) ? value : null;
};

/**
 * POST /api/auth/learner-register
 *
 * Name + email + password only. No approval, no photo, no phone, no class,
 * no batch, no target exams. Returns a usable session immediately so the
 * client can go straight into Board → Class → Subjects personalization.
 */
export const learnerRegister = async (req: Request, res: Response) => {
  const { name, email, password, phone, board, classLevel, subjects, state, city } =
    req.body || {};
  const lcEmail = typeof email === 'string' ? email.toLowerCase().trim() : '';
  const trimmedName = typeof name === 'string' ? name.trim() : '';

  try {
    if (!trimmedName || !lcEmail || !password) {
      return res.status(400).json({ message: 'Name, email and password are required.' });
    }
    if (!NAME_REGEX.test(trimmedName)) {
      return res.status(400).json({ message: 'Please enter a valid full name.' });
    }
    if (!EMAIL_REGEX.test(lcEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }
    if (!emailDomainAllowed(lcEmail)) {
      return res.status(400).json({
        message: 'Please use a Gmail, Hotmail or Live.in email address.',
        field: 'email',
      });
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return res
        .status(400)
        .json({ message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }

    const existing = await User.findOne({ email: lcEmail }).select('_id accountType').lean();
    if (existing) {
      // Never reveal which kind of account holds the address.
      return res
        .status(409)
        .json({ message: 'An account with this email already exists. Please sign in.' });
    }

    // Optional academic + location payload. The multi-step onboarding sends all
    // of it, so the account is complete on creation; a minimal client that sends
    // only name/email/password still works and lands in the setup flow.
    const normalizedPhone = phone === undefined ? undefined : normalizePhone(phone);
    if (phone !== undefined && !normalizedPhone) {
      return res
        .status(400)
        .json({ message: 'Please enter a valid 10-digit mobile number.', field: 'phone' });
    }

    const profile: Record<string, unknown> = { subjects: [], onboardingStep: 'BOARD' };

    if (board !== undefined) {
      if (!VALID_BOARDS.includes(board)) {
        return res.status(400).json({ message: 'Unsupported board.', field: 'board' });
      }
      profile.board = board;
    }

    if (classLevel !== undefined) {
      const normalizedClass = normalizeLearnerClass(classLevel);
      if (!normalizedClass) {
        return res.status(400).json({ message: 'Unsupported class.', field: 'classLevel' });
      }
      profile.classLevel = normalizedClass;
    }

    if (Array.isArray(subjects)) {
      profile.subjects = Array.from(
        new Set(
          subjects
            .map((x: unknown) => String(x ?? '').trim())
            .filter(Boolean)
            .slice(0, MAX_SUBJECTS),
        ),
      );
    }

    const cleanState = cleanText(state);
    const cleanCity = cleanText(city);
    if (cleanState) profile.state = cleanState;
    if (cleanCity) profile.city = cleanCity;

    // Board + class are what personalization actually needs; with both present
    // the learner is complete and skips the setup flow entirely.
    if (profile.board && profile.classLevel) {
      profile.onboardingStep = 'DONE';
      profile.onboardingCompletedAt = new Date();
    } else if (profile.board) {
      profile.onboardingStep = 'CLASS';
    }

    const user = new User({
      name: trimmedName,
      email: lcEmail,
      password,
      // Root `phone` is an ordinary contact field shared by all account types —
      // unlike classLevel/batch it carries no institute audience meaning.
      ...(normalizedPhone ? { phone: normalizedPhone } : {}),
      role: 'student',
      accountType: 'PUBLIC_LEARNER',
      status: 'approved', // no admin approval — usable immediately
      authProvider: 'local',
      registrationSource: 'app',
      learnerProfile: profile,
      // classLevel / batch / board intentionally left unset. See file header.
    });
    await user.save();

    return res.status(201).json({
      token: signToken(user),
      user: serializeLearner(user),
    });
  } catch (err) {
    console.error('Learner registration error:', err);
    return res.status(500).json({ message: 'Server error during registration' });
  }
};

/** GET /api/learner/me — current learner profile (authenticated). */
export const getLearnerMe = async (req: Request, res: Response) => {
  try {
    const current = (req as any).user as { id: string } | undefined;
    if (!current) return res.status(401).json({ message: 'Unauthorized' });

    const user = await User.findById(current.id)
      .select('name email phone role accountType status profileImage learnerProfile')
      .lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.accountType !== 'PUBLIC_LEARNER') {
      return res.status(403).json({ message: 'Not a public learner account' });
    }

    return res.json(serializeLearner(user));
  } catch (err) {
    console.error('Get learner error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * PATCH /api/learner/preferences
 *
 * Persists one onboarding step at a time so an interrupted setup resumes
 * exactly where it stopped — every field is optional and only what is sent is
 * written. `onboardingStep` is stored as the step the learner should see NEXT.
 *
 * Writes are confined to `learnerProfile`; this endpoint can never touch root
 * classLevel/batch, and it refuses non-learner accounts outright so an
 * institute student's enrollment can never be edited through it.
 */
export const updateLearnerPreferences = async (req: Request, res: Response) => {
  try {
    const current = (req as any).user as { id: string } | undefined;
    if (!current) return res.status(401).json({ message: 'Unauthorized' });

    const user = await User.findById(current.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.accountType !== 'PUBLIC_LEARNER') {
      return res.status(403).json({ message: 'Not a public learner account' });
    }

    const { board, classLevel, subjects, state, city, onboardingStep } = req.body || {};
    const profile = user.learnerProfile || ({} as any);

    if (board !== undefined) {
      if (!VALID_BOARDS.includes(board)) {
        return res.status(400).json({ message: 'Unsupported board.' });
      }
      profile.board = board;
    }

    if (classLevel !== undefined) {
      const normalized = normalizeLearnerClass(classLevel);
      if (!normalized) {
        return res.status(400).json({ message: 'Unsupported class.' });
      }
      profile.classLevel = normalized;
    }

    if (subjects !== undefined) {
      if (!Array.isArray(subjects)) {
        return res.status(400).json({ message: 'Subjects must be a list.' });
      }
      const cleaned = Array.from(
        new Set(
          subjects
            .map((s: unknown) => String(s || '').trim())
            .filter(Boolean)
            .slice(0, MAX_SUBJECTS),
        ),
      );
      profile.subjects = cleaned;
    }

    if (state !== undefined) profile.state = cleanText(state);
    if (city !== undefined) profile.city = cleanText(city);

    if (onboardingStep !== undefined) {
      const steps: LearnerOnboardingStep[] = ['BOARD', 'CLASS', 'SUBJECTS', 'DONE'];
      if (!steps.includes(onboardingStep)) {
        return res.status(400).json({ message: 'Invalid onboarding step.' });
      }
      profile.onboardingStep = onboardingStep;
      if (onboardingStep === 'DONE' && !profile.onboardingCompletedAt) {
        profile.onboardingCompletedAt = new Date();
      }
    }

    // Guard against a client marking setup complete without the selections the
    // personalized experience depends on — the app would then render an empty
    // home with no way back into setup.
    if (profile.onboardingStep === 'DONE' && (!profile.board || !profile.classLevel)) {
      return res
        .status(400)
        .json({ message: 'Board and class must be selected before completing setup.' });
    }

    user.learnerProfile = profile;
    user.markModified('learnerProfile');
    await user.save();

    return res.json(serializeLearner(user));
  } catch (err) {
    console.error('Update learner preferences error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};
