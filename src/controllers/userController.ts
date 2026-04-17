import { Request, Response } from 'express';
import User, { IUser, UserRole } from '../models/User';
import { logAudit } from '../utils/logger';
import {
	normalizeClassValue,
	toClassLabel,
} from '../config/studentBatchConfig';
import {
	getStudentBatchConfigFromDatabase,
	matchBatchName,
} from '../services/batchConfigService';

async function resolveStudentClassAndBatch(classLevelInput?: string, batchInput?: string): Promise<{ classLevel: string; batch: string }> {
	const normalizedClass = normalizeClassValue(classLevelInput);
	if (!normalizedClass) {
		throw new Error('Student class must be between 7 and 12');
	}

	const config = await getStudentBatchConfigFromDatabase();
	const allowedBatches = config.batchRules[normalizedClass] || [];
	if (allowedBatches.length === 0) {
		return { classLevel: toClassLabel(normalizedClass), batch: '' };
	}

	const matchedBatch = matchBatchName(batchInput, allowedBatches);
	if (!matchedBatch) {
		throw new Error(`Invalid batch for Class ${normalizedClass}. Allowed: ${allowedBatches.join(', ')}`);
	}

	return {
		classLevel: toClassLabel(normalizedClass),
		batch: matchedBatch,
	};
}

// Admin-only: Get pending user registrations
export const adminGetPendingUsers = async (req: Request, res: Response) => {
	try {
		const pendingUsers = await User.find({ status: 'pending' }).select('-password').sort({ createdAt: -1 });
		res.json(pendingUsers);
	} catch (err) {
		res.status(500).json({ message: 'Server error' });
	}
};

// Admin-only: registration records across web/app for auditing and management
export const adminGetRegistrationRecords = async (req: Request, res: Response) => {
	try {
		const {
			role,
			status,
			registrationSource,
			search,
			from,
			to,
		} = req.query as Record<string, string | undefined>;

		const filter: any = {};

		if (role && ['teacher', 'student', 'admin'].includes(role)) {
			filter.role = role;
		}

		if (status && ['pending', 'approved', 'rejected'].includes(status)) {
			filter.status = status;
		}

		if (registrationSource && ['website', 'app', 'admin', 'unknown'].includes(registrationSource)) {
			filter.registrationSource = registrationSource;
		}

		if (search?.trim()) {
			const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
			filter.$or = [
				{ name: rx },
				{ email: rx },
				{ phone: rx },
				{ empCode: rx },
			];
		}

		if (from || to) {
			filter.createdAt = {};
			if (from) {
				const fromDate = new Date(from);
				if (!Number.isNaN(fromDate.getTime())) filter.createdAt.$gte = fromDate;
			}
			if (to) {
				const toDate = new Date(to);
				if (!Number.isNaN(toDate.getTime())) {
					toDate.setHours(23, 59, 59, 999);
					filter.createdAt.$lte = toDate;
				}
			}
			if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt;
		}

		const users = await User.find(filter)
			.select('-password')
			.sort({ createdAt: -1 });

		res.json(users);
	} catch {
		res.status(500).json({ message: 'Server error' });
	}
};

// Admin-only: Approve user registration
export const adminApproveUser = async (req: Request, res: Response) => {
	try {
		const { empCode } = req.body;
		
		// Validate empCode is provided
		if (!empCode || !empCode.trim()) {
			return res.status(400).json({ message: 'Employee/Student code (empCode) is required for approval' });
		}
		
		const sanitizedEmpCode = empCode.trim();
		
		// Check empCode uniqueness
		const existingEmp = await User.findOne({ empCode: sanitizedEmpCode });
		if (existingEmp) {
			return res.status(400).json({ message: `Code "${sanitizedEmpCode}" is already assigned to ${existingEmp.name}` });
		}
		
		const user = await User.findById(req.params.id);
		if (!user) return res.status(404).json({ message: 'User not found' });
		
		user.status = 'approved';
		user.empCode = sanitizedEmpCode;
		await user.save();
		
		await logAudit((req as any).user?.id, 'admin.user.approve', String(user._id), { email: user.email, name: user.name, empCode: sanitizedEmpCode });
		res.json({ message: 'User approved successfully', user: { id: user._id, name: user.name, email: user.email, status: user.status, empCode: user.empCode } });
	} catch (err) {
		res.status(500).json({ message: 'Server error' });
	}
};

// Admin-only: Reject user registration
export const adminRejectUser = async (req: Request, res: Response) => {
	try {
		const user = await User.findById(req.params.id);
		if (!user) return res.status(404).json({ message: 'User not found' });
		
		user.status = 'rejected';
		await user.save();
		
		await logAudit((req as any).user?.id, 'admin.user.reject', String(user._id), { email: user.email, name: user.name });
		res.json({ message: 'User rejected successfully', user: { id: user._id, name: user.name, email: user.email, status: user.status } });
	} catch (err) {
		res.status(500).json({ message: 'Server error' });
	}
};

// Admin and Teacher: Create a user with role teacher or student
export const adminCreateUser = async (req: Request, res: Response) => {
	try {
		const currentUser = (req as any).user;
		const { name, email, password, role, classLevel, batch, empCode } = req.body as {
			name: string;
			email: string;
			password: string;
			role: UserRole;
			classLevel?: string;
			batch?: string;
			empCode?: string;
		};
		if (!name || !email || !password || !role) {
			return res.status(400).json({ message: 'name, email, password and role are required' });
		}
		if (!['teacher', 'student', 'admin'].includes(role)) {
			return res.status(400).json({ message: 'Role must be one of admin, teacher, or student' });
		}
		
		// Teachers cannot create admins
		if (currentUser.role === 'teacher' && role === 'admin') {
			return res.status(403).json({ message: 'Teacher cannot create admin accounts' });
		}
		
		// Enforce empCode for teachers and students
		if ((role === 'teacher' || role === 'student') && !empCode) {
			return res.status(400).json({ message: 'empCode is mandatory for teachers and students' });
		}

		let normalizedClassLevel = classLevel;
		let normalizedBatch = batch;
		if (role === 'student') {
			try {
				const resolved = await resolveStudentClassAndBatch(classLevel, batch);
				normalizedClassLevel = resolved.classLevel;
				normalizedBatch = resolved.batch;
			} catch (validationError: any) {
				return res.status(400).json({ message: validationError.message || 'Invalid student class or batch' });
			}
		}

	const lcEmail = email.toLowerCase();
	const sanitizedEmpCode = empCode ? empCode.trim() : undefined;

	const existingEmail = await User.findOne({ email: lcEmail });
		if (existingEmail) return res.status(400).json({ message: 'Email already in use' });

		// Check empCode uniqueness
		if (sanitizedEmpCode) {
			const existingEmp = await User.findOne({ empCode: sanitizedEmpCode });
			if (existingEmp) return res.status(400).json({ message: 'empCode already in use by another user' });
		}

	const user = await User.create({
		name,
		email: lcEmail,
		password,
		role,
		classLevel: role === 'student' ? normalizedClassLevel : undefined,
		batch: role === 'student' ? normalizedBatch : undefined,
		empCode: sanitizedEmpCode,
		registrationSource: 'admin',
	});
		await logAudit(currentUser.id, 'admin.user.create', String(user._id), { name, email: lcEmail, role, empCode: sanitizedEmpCode });
		res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role, empCode: user.empCode });
	} catch (err) {
		console.error('Create User Error:', err);
		res.status(500).json({ message: 'Server error' });
	}
};

export const getStudentBatchConfig = async (_req: Request, res: Response) => {
	const config = await getStudentBatchConfigFromDatabase();
	return res.json(config);
};

// Admin-only: List users filtered by role
export const adminListUsers = async (req: Request, res: Response) => {
	try {
		const role = (req.query.role as string) || undefined;
		const status = (req.query.status as string) || undefined;
		const registrationSource = (req.query.registrationSource as string) || undefined;
		const search = (req.query.search as string) || undefined;
		const classLevel = (req.query.classLevel as string) || undefined;
		const batch = (req.query.batch as string) || undefined;
		const filter: any = {};
		if (role && ['teacher', 'student', 'admin'].includes(role)) filter.role = role;
		if (status && ['pending', 'approved', 'rejected'].includes(status)) filter.status = status;
		if (registrationSource && ['website', 'app', 'admin', 'unknown'].includes(registrationSource)) {
			filter.registrationSource = registrationSource;
		}
		if (search && search.trim()) {
			const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
			filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { empCode: rx }];
		}
		if (classLevel) {
			const normalizedClass = normalizeClassValue(classLevel);
			if (normalizedClass) {
				filter.classLevel = { $regex: new RegExp(`^(Class\\s*)?${normalizedClass}$`, 'i') };
			} else {
				filter.classLevel = classLevel;
			}
		}
		if (batch) filter.batch = String(batch).trim();
		const users = await User.find(filter).select('-password');
		res.json(users);
	} catch (err) {
		res.status(500).json({ message: 'Server error' });
	}
};

// Admin-only: Get single user
export const adminGetUser = async (req: Request, res: Response) => {
	try {
		const user = await User.findById(req.params.id).select('-password');
		if (!user) return res.status(404).json({ message: 'User not found' });
		res.json(user);
	} catch (err) {
		res.status(500).json({ message: 'Server error' });
	}
};

import OfflineResult from '../models/OfflineResult';

// Admin and Teacher: Update user (name, email, role, password, empCode)
export const adminUpdateUser = async (req: Request, res: Response) => {
	try {
		const currentUser = (req as any).user;
		const { name, email, role, password, classLevel, batch, empCode } = req.body as Partial<IUser> & { role?: UserRole };
		const user = await User.findById(req.params.id);
		if (!user) return res.status(404).json({ message: 'User not found' });
		
		// Teachers cannot edit admin users, except for themselves
		if (currentUser.role === 'teacher' && user.role === 'admin') {
			return res.status(403).json({ message: 'Teacher cannot modify admin accounts' });
		}
		
		const oldName = user.name;
		const currentClass = (user as any).classLevel;

		if (name) user.name = name;
		if (email) user.email = email;
		if (role) {
			// Teachers cannot promote users to admin
			if (currentUser.role === 'teacher' && role === 'admin') {
				return res.status(403).json({ message: 'Teacher cannot grant admin roles' });
			}
			user.role = role;
		}

		const effectiveRole = role || user.role;
		if (effectiveRole === 'student') {
			const currentClassLevel = classLevel !== undefined ? classLevel : (user as any).classLevel;
			const currentBatch = batch !== undefined ? batch : (user as any).batch;

			try {
				const resolved = await resolveStudentClassAndBatch(String(currentClassLevel || ''), String(currentBatch || ''));
				(user as any).classLevel = resolved.classLevel;
				(user as any).batch = resolved.batch;
			} catch (validationError: any) {
				return res.status(400).json({ message: validationError.message || 'Invalid student class or batch' });
			}
		} else if (role && role !== 'student') {
			(user as any).classLevel = '';
			(user as any).batch = '';
		}

		if (password) user.password = password; // will be hashed by pre-save
		if (effectiveRole !== 'student') {
			if (classLevel !== undefined) (user as any).classLevel = classLevel;
			if (batch !== undefined) (user as any).batch = batch;
		}
		
		if (empCode && empCode.trim() !== user.empCode) {
			const sanitizedEmpCode = empCode.trim();
			const existing = await User.findOne({ empCode: sanitizedEmpCode });
			if (existing) return res.status(400).json({ message: `empCode ${sanitizedEmpCode} is already assigned to ${existing.name}` });
			user.empCode = sanitizedEmpCode;
		}

		await user.save();
		await logAudit(currentUser.id, 'admin.user.update', String(user._id), { name, email, role, classLevel, batch, empCode: user.empCode });
		
        // Sync name changes to offline results
		if (name && oldName && name !== oldName) {
			try {
				const result = await OfflineResult.updateMany(
					{ name: oldName, class: currentClass },
					{ $set: { name: name } }
				);
				console.log(`[Admin Update] Synced name change '${oldName}' -> '${name}' for ${result.modifiedCount} offline results`);
			} catch (syncErr) {
				console.error('[Admin Update] Error syncing offline results:', syncErr);
			}
		}

		const { _id, name: n, email: e, role: r, empCode: ec } = user;
		res.json({ id: _id, name: n, email: e, role: r, empCode: ec, classLevel: (user as any).classLevel, batch: (user as any).batch });
	} catch (err) {
		res.status(500).json({ message: 'Server error' });
	}
};

// Admin and Teacher: Delete user
export const adminDeleteUser = async (req: Request, res: Response) => {
	try {
		const currentUser = (req as any).user;
		const user = await User.findById(req.params.id);
		if (!user) return res.status(404).json({ message: 'User not found' });
		
		// Teachers cannot delete admin users
		if (currentUser.role === 'teacher' && user.role === 'admin') {
			return res.status(403).json({ message: 'Teacher cannot delete admin accounts' });
		}
		
		await User.findByIdAndDelete(req.params.id);
		await logAudit(currentUser.id, 'admin.user.delete', String(user._id));
		res.json({ message: 'User deleted' });
	} catch (err) {
		res.status(500).json({ message: 'Server error' });
	}
};

// Admin-only dashboard sample
export const adminDashboard = async (_req: Request, res: Response) => {
	try {
		const [admins, teachers, students] = await Promise.all([
			User.countDocuments({ role: 'admin' }),
			User.countDocuments({ role: 'teacher' }),
			User.countDocuments({ role: 'student' }),
		]);
		res.json({ stats: { admins, teachers, students } });
	} catch (err) {
		res.status(500).json({ message: 'Server error' });
	}
};

// User settings management (for authenticated users)
export const getUserSettings = async (req: Request, res: Response) => {
	try {
		const userId = (req as any).user?.id;
		const user = await User.findById(userId).select('settings');
		if (!user) return res.status(404).json({ message: 'User not found' });
		
		// Default settings if not set
		const settings = (user as any).settings || {
			pushNotifications: true,
			emailNotifications: true,
			examReminders: true,
			doubtAlerts: true,
			autoSave: true,
			language: 'English',
		};
		
		res.json(settings);
	} catch (err) {
		res.status(500).json({ message: 'Server error' });
	}
};

export const updateUserSettings = async (req: Request, res: Response) => {
	try {
		const userId = (req as any).user?.id;
		const settings = req.body;
		
		const user = await User.findById(userId);
		if (!user) return res.status(404).json({ message: 'User not found' });
		
		(user as any).settings = settings;
		await user.save();
		
		await logAudit(userId, 'user.settings.update', userId, { settings });
		res.json({ message: 'Settings updated successfully', settings });
	} catch (err) {
		res.status(500).json({ message: 'Server error' });
	}
};

// Change password (for authenticated users)
export const changePassword = async (req: Request, res: Response) => {
	try {
		const userId = (req as any).user?.id;
		const { currentPassword, newPassword } = req.body;
		
		if (!currentPassword || !newPassword) {
			return res.status(400).json({ message: 'Current password and new password are required' });
		}
		
		const user = await User.findById(userId);
		if (!user) return res.status(404).json({ message: 'User not found' });
		
		// Verify current password
		const isMatch = await user.comparePassword(currentPassword);
		if (!isMatch) {
			return res.status(400).json({ message: 'Current password is incorrect' });
		}
		
		// Update password
		user.password = newPassword;
		await user.save();
		
		await logAudit(userId, 'user.password.change', userId);
		res.json({ message: 'Password changed successfully' });
	} catch (err) {
		res.status(500).json({ message: 'Server error' });
	}
};
// Update user profile (name, phone, profileImage, bio, etc.)
export const updateProfile = async (req: Request, res: Response) => {
	try {
		const userId = (req as any).user?.id;
		const { name, phone, profileImage, bio, subjects } = req.body;
		
		const user = await User.findById(userId);
		if (!user) return res.status(404).json({ message: 'User not found' });
		
		if (name) user.name = name;
		if (phone) (user as any).phone = phone; // Assuming phone exists on schema or mixed
		if (profileImage) user.profileImage = profileImage;
    if (bio) (user as any).bio = bio;
    if (subjects) (user as any).subjects = subjects;

		await user.save();
		
		await logAudit(userId, 'user.profile.update', userId, { name, phone });
		
    // Return updated user object without password
		const updatedUser = await User.findById(userId).select('-password');
		res.json(updatedUser);
	} catch (err) {
    console.error('Update Profile Error:', err);
		res.status(500).json({ message: 'Server error' });
	}
};
