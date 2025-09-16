import User from '../models/User';

export async function ensureDefaultAdmin() {
	const adminEmail = process.env.ADMIN_EMAIL || 'admin@cbt.local';
	const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';
	const adminName = process.env.ADMIN_NAME || 'System Admin';
	const existingAdmin = await User.findOne({ email: adminEmail, role: 'admin' });
	if (!existingAdmin) {
		await User.create({ name: adminName, email: adminEmail, password: adminPassword, role: 'admin' });
		return { created: true, email: adminEmail };
	}
	return { created: false, email: adminEmail };
}
