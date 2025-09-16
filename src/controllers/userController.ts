import { Request, Response } from 'express';
import User, { IUser, UserRole } from '../models/User';

// Admin-only: Create a user with role teacher or student
export const adminCreateUser = async (req: Request, res: Response) => {
	try {
		const { name, email, password, role } = req.body as { name: string; email: string; password: string; role: UserRole };
		if (!name || !email || !password || !role) {
			return res.status(400).json({ message: 'name, email, password and role are required' });
		}
		if (!['teacher', 'student', 'admin'].includes(role)) {
			return res.status(400).json({ message: 'Role must be one of admin, teacher, or student' });
		}
	const lcEmail = email.toLowerCase();
	const existing = await User.findOne({ email: lcEmail });
		if (existing) return res.status(400).json({ message: 'Email already in use' });
	const user = await User.create({ name, email: lcEmail, password, role });
		res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role });
	} catch (err) {
		res.status(500).json({ message: 'Server error' });
	}
};

// Admin-only: List users filtered by role
export const adminListUsers = async (req: Request, res: Response) => {
	try {
		const role = (req.query.role as string) || undefined;
		const filter: any = {};
		if (role && ['teacher', 'student', 'admin'].includes(role)) filter.role = role;
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

// Admin-only: Update user (name, email, role, password)
export const adminUpdateUser = async (req: Request, res: Response) => {
	try {
		const { name, email, role, password } = req.body as Partial<IUser> & { role?: UserRole };
		const user = await User.findById(req.params.id);
		if (!user) return res.status(404).json({ message: 'User not found' });
		if (name) user.name = name;
		if (email) user.email = email;
		if (role) user.role = role;
		if (password) user.password = password; // will be hashed by pre-save
		await user.save();
		const { _id, name: n, email: e, role: r } = user;
		res.json({ id: _id, name: n, email: e, role: r });
	} catch (err) {
		res.status(500).json({ message: 'Server error' });
	}
};

// Admin-only: Delete user
export const adminDeleteUser = async (req: Request, res: Response) => {
	try {
		const user = await User.findByIdAndDelete(req.params.id);
		if (!user) return res.status(404).json({ message: 'User not found' });
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
