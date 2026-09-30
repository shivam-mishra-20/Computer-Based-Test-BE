import User from '../models/User';
import { adminBootstrap } from '../config/adminBootstrap';

export async function ensureDefaultAdmin() {
	// Only from ADMIN_EMAIL / ADMIN_PASSWORD — never a default (config/adminBootstrap.ts).
	// An existing account is never changed.
	const bootstrap = adminBootstrap();
	if (bootstrap.action !== 'create') return { created: false, email: null, reason: bootstrap.reason };
	const existingAdmin = await User.findOne({ email: bootstrap.email, role: 'admin' });
	if (!existingAdmin) {
		await User.create({ name: bootstrap.name, email: bootstrap.email, password: bootstrap.password, role: 'admin' });
		return { created: true, email: bootstrap.email };
	}
	return { created: false, email: bootstrap.email };
}
